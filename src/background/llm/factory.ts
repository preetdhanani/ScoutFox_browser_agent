/**
 * llm/factory.ts - native HTTP provider calls for providers that talk to a plain HTTP API.
 *
 * A model call object is built for every request and dropped after it: nothing about a call (its key,
 * its base URL, its abort signal) can leak into the next one, and settings are read again each time.
 *
 * Rules for every provider call:
 *   - No external SDKs (LangChain packages removed): all requests are direct, native fetch calls.
 *   - Temperature is settings.temperature ?? 0.1.
 *   - Stream false by default (Gemini streams SSE for proper abortability).
 *   - The caller's abort signal and deadline are directly passed to fetch.
 *   - Wire formats, headers, and error contexts match what the tests and remote endpoints expect.
 */
import { GEMINI_EMPTY_TEXT, UnreadableReplyError, scrubKey, statusOf } from './errors.ts';
import { Logger } from '../../shared/logger.ts';
import {
  baseUrlOf,
  endpointHostOf,
  endpointOriginOf,
  maxTokensOf,
  modelOf,
  normalizeCustomAnthropicBase,
  normalizeCustomOpenaiBase,
  normalizeNvidiaBaseUrl,
  withV1
} from './settings.ts';
import { usageOfOpenAI } from './usage.ts';
import type { CustomProvider } from '../../shared/storage.ts';
import type { ChatProvider, ChatTurn, CompletionOptions, LlmSettings, TokenUsage } from './types.ts';

const OPENAI_BASE_URL = 'https://api.openai.com';
const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const OPENROUTER_HEADERS = { 'HTTP-Referer': 'https://github.com/preetdhanani/Tarka_browser_agent', 'X-Title': 'Tarka AI Agent' };

export const NULLED_HEADERS = [
  'accept', 'user-agent',
  'x-stainless-lang', 'x-stainless-package-version', 'x-stainless-os', 'x-stainless-arch', 'x-stainless-runtime',
  'x-stainless-runtime-version', 'x-stainless-retry-count', 'x-stainless-timeout', 'x-stainless-helper-method'
];
export const NULL_HEADERS: Record<string, null> = Object.fromEntries(NULLED_HEADERS.map((name) => [name, null]));

export function openaiRequestHeaders(apiKey: string): Record<string, null> {
  return apiKey ? NULL_HEADERS : { ...NULL_HEADERS, authorization: null };
}

/** Lightweight message classes for backwards compatibility with tests and callers. */
export class SystemMessage {
  readonly role = 'system';
  content: string;
  constructor(content: string) {
    this.content = content;
  }
  get text(): string {
    return this.content;
  }
}

export class HumanMessage {
  readonly role = 'user';
  content: string;
  constructor(content: string) {
    this.content = content;
  }
  get text(): string {
    return this.content;
  }
}

export class AIMessage {
  readonly role = 'assistant';
  content: string;
  public usage?: TokenUsage;
  public usage_metadata?: { input_tokens: number; output_tokens: number };
  constructor(content: string, options?: { usage?: TokenUsage }) {
    this.content = content;
    if (options?.usage) this.usage = options.usage;
  }
  get text(): string {
    return this.content;
  }
}

export type BaseMessage = (SystemMessage | HumanMessage | AIMessage) & { text: string; usage?: TokenUsage };

/** Turns as chat messages: system prompt first, then turns. */
export function toLangChainMessages(turns: ChatTurn[], systemPrompt: string): BaseMessage[] {
  return [
    new SystemMessage(systemPrompt),
    ...turns.map((turn) => (turn.role === 'assistant' ? new AIMessage(turn.content) : new HumanMessage(turn.content)))
  ];
}

export interface InvokeOptions {
  signal?: AbortSignal;
  callbacks?: unknown;
}

export interface ProviderCall {
  baseUrl?: string;
  logTag: string;
  logTarget: string;
  invoke(messages: BaseMessage[] | ChatTurn[], options?: InvokeOptions): Promise<BaseMessage>;
  lastBody(): string | undefined;
}

const SDK_HEADER = /^(?:accept|user-agent|x-stainless-.+)$/;

export interface FetchWatchOptions {
  apiKey?: string;
  headers?: Record<string, string>;
  stripSdkHeaders?: boolean;
  removeHeaders?: string[];
  keepReply?: boolean;
  refuseForeignRedirects?: string;
}

function withWireHeaders(init: RequestInit | undefined, { headers, stripSdkHeaders, removeHeaders }: FetchWatchOptions): RequestInit | undefined {
  if (!headers && !stripSdkHeaders && !(removeHeaders && removeHeaders.length)) return init;
  const merged = new Headers(init?.headers);
  if (stripSdkHeaders) for (const name of [...merged.keys()]) if (SDK_HEADER.test(name)) merged.delete(name);
  for (const [name, value] of Object.entries(headers ?? {})) merged.set(name, value);
  for (const name of removeHeaders ?? []) merged.delete(name);
  return { ...init, headers: merged };
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function hostForErrorText(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
  } catch {
    return 'an unreadable location';
  }
}

async function foreignRedirectOf(
  response: Response,
  requestUrl: string,
  requestInit: RequestInit | undefined,
  endpointOrigin: string
): Promise<Response> {
  const redirected = response.type === 'opaqueredirect' || isRedirectStatus(response.status);
  if (!redirected) return response;

  let destination: string | null = null;
  if (response.type === 'opaqueredirect') {
    try {
      const probe = await fetch(requestUrl, { method: 'GET', redirect: 'follow' });
      destination = probe.url || null;
    } catch {
      throw new Error('The endpoint redirected to another location. ScoutFox did not follow it and could not verify the destination.');
    }
  } else {
    const location = response.headers.get('location');
    if (location) {
      try {
        destination = new URL(location, requestUrl).href;
      } catch {
        destination = null;
      }
    }
  }
  if (!destination) {
    throw new Error('The endpoint redirected to another location. ScoutFox did not follow it.');
  }
  let destinationOrigin: string;
  try {
    destinationOrigin = new URL(destination).origin;
  } catch {
    throw new Error('The endpoint redirected to an unreadable location. ScoutFox did not follow it.');
  }
  if (destinationOrigin !== endpointOrigin) {
    throw new Error(`The endpoint redirected to ${hostForErrorText(destination)}, which is not ${hostForErrorText(endpointOrigin)}. ScoutFox did not follow it.`);
  }
  return fetch(requestUrl, { ...requestInit, redirect: 'follow' });
}

export function watchFetch(options: FetchWatchOptions = {}) {
  let body: string | undefined;
  let answered: number | undefined;
  let rejected = false;
  return {
    body: () => body,
    asAnswered(error: unknown, signal?: AbortSignal | null): unknown {
      if (statusOf(error) !== undefined || rejected || answered === undefined || signal?.aborted) return error;
      return new UnreadableReplyError(answered, error);
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      let response: Response;
      try {
        const requestInit = withWireHeaders(init, options);
        response = await fetch(input, options.refuseForeignRedirects
          ? { ...requestInit, redirect: 'manual' }
          : requestInit);
        if (options.refuseForeignRedirects) {
          const requestUrl = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
          response = await foreignRedirectOf(response, requestUrl, requestInit, options.refuseForeignRedirects);
        }
      } catch (error) {
        rejected = true;
        throw error;
      }
      if (response.ok && !options.keepReply) return response;
      let text: string;
      try {
        text = await response.clone().text();
      } catch {
        if (response.ok) {
          rejected = true;
          return response;
        }
        text = '';
      }
      if (response.ok) {
        body = text;
        answered = response.status;
        return response;
      }
      const clean = scrubKey(text, options.apiKey);
      body = clean;
      if (clean === text) return response;
      const headers = new Headers(response.headers);
      for (const name of ['content-length', 'content-encoding', 'transfer-encoding']) headers.delete(name);
      return new Response(clean, { status: response.status, statusText: response.statusText, headers });
    }) as typeof fetch
  };
}

export function textOfChoices(raw: string | undefined): string {
  try {
    const choice = (JSON.parse(raw ?? '') as { choices?: Array<{ message?: { content?: unknown }; text?: unknown }> } | null)?.choices?.[0];
    const content = choice?.message?.content ?? choice?.text;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((part: { text?: unknown } | null) => (typeof part?.text === 'string' ? part.text : '')).join('');
  } catch {}
  return '';
}

export function notifyCallbacks(callbacks: unknown, providerName: string, error?: unknown): void {
  if (!callbacks) return;
  const list = Array.isArray(callbacks) ? callbacks : [callbacks];
  for (const cb of list) {
    if (error) {
      if (typeof cb?.handleLLMError === 'function') {
        try { cb.handleLLMError(error); } catch {}
      }
    } else {
      if (typeof cb?.handleChatModelStart === 'function') {
        try { cb.handleChatModelStart({ id: ['test', providerName] }); } catch {}
      }
    }
  }
}

function toPlainMessages(messages: Array<any>): Array<{ role: string; content: string }> {
  return messages.map((m) => {
    let role = m.role;
    if (!role) {
      if (m instanceof AIMessage) role = 'assistant';
      else if (m instanceof SystemMessage) role = 'system';
      else role = 'user';
    }
    const content = typeof m.content === 'string' ? m.content : (typeof m.text === 'string' ? m.text : String(m.content ?? ''));
    return { role, content };
  });
}

function isDeveloperRoleModel(model: string): boolean {
  return /^(?:o[1-9]|gpt-[56](?!.*-chat))/.test(model || '');
}

function openaiFamilyCall(provider: 'openrouter' | 'openai' | 'openai_compatible' | 'nvidia', settings: LlmSettings, apiKey: string): ProviderCall {
  const openrouter = provider === 'openrouter';
  const rawBaseUrl = baseUrlOf(settings);
  let baseURL: string;
  if (openrouter) {
    baseURL = OPENROUTER_BASE_URL;
  } else if (provider === 'nvidia') {
    baseURL = normalizeNvidiaBaseUrl(rawBaseUrl);
  } else {
    const defaultBaseUrl = provider === 'openai_compatible' ? GROQ_BASE_URL : OPENAI_BASE_URL;
    let base = rawBaseUrl || defaultBaseUrl;
    base = base.replace(/\/+(?:chat\/completions|models)\/?$/i, '');
    baseURL = withV1(base);
  }

  const defaultModel = openrouter
    ? 'anthropic/claude-3.5-sonnet'
    : (provider === 'nvidia' ? 'meta/llama-3.3-70b-instruct' : 'gpt-4o-mini');
  const model = modelOf(settings) || defaultModel;
  const isDev = isDeveloperRoleModel(model);

  const headers: Record<string, string> = {
    'content-type': 'application/json'
  };
  if (apiKey) {
    headers['authorization'] = `Bearer ${apiKey}`;
  }
  if (openrouter) {
    headers['http-referer'] = OPENROUTER_HEADERS['HTTP-Referer'];
    headers['x-title'] = OPENROUTER_HEADERS['X-Title'];
  }

  const logTag = provider === 'nvidia'
    ? 'NvidiaClient'
    : (openrouter ? 'OpenRouterClient' : 'OpenAIClient');

  let lastBodyText: string | undefined;

  return {
    baseUrl: baseURL,
    logTag,
    logTarget: openrouter ? 'OpenRouter' : `${baseURL}/chat/completions`,
    invoke: async (messages, options = {}) => {
      notifyCallbacks(options.callbacks, logTag);
      try {
        const plainMessages = toPlainMessages(messages).map((m) => {
          if (isDev && m.role === 'system') return { ...m, role: 'developer' };
          return m;
        });
        const body = {
          model,
          messages: plainMessages,
          temperature: settings.temperature ?? 0.1,
          stream: false
        };
        const url = `${baseURL}/chat/completions`;
        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: options.signal
        });

        const rawText = await response.text();
        lastBodyText = scrubKey(rawText, apiKey);

        if (!response.ok) {
          const error = new Error(lastBodyText);
          Object.assign(error, { status: response.status, headers: response.headers, rawBody: lastBodyText });
          throw error;
        }

        let data: any;
        try {
          data = JSON.parse(rawText);
        } catch {
          throw new UnreadableReplyError(response.status, new Error('Invalid JSON'));
        }

        if (!data || typeof data !== 'object' || data.error || !Array.isArray(data.choices) || data.choices.length === 0) {
          throw new UnreadableReplyError(response.status, new Error('Not a chat reply'));
        }

        const text = textOfChoices(rawText);
        const usage = usageOfOpenAI(data);
        const reply = new AIMessage(text);
        if (usage) reply.usage = usage;
        return reply;
      } catch (err) {
        notifyCallbacks(options.callbacks, logTag, err);
        throw err;
      }
    },
    lastBody: () => lastBodyText
  };
}

function anthropicCall(settings: LlmSettings, apiKey: string): ProviderCall {
  const model = modelOf(settings) || 'claude-3-5-sonnet-20241022';
  const headers: Record<string, string> = {
    'anthropic-dangerous-direct-browser-access': 'true',
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
    'x-api-key': apiKey
  };
  let lastBodyText: string | undefined;

  return {
    logTag: 'AnthropicClient',
    logTarget: 'Anthropic',
    invoke: async (messages, options = {}) => {
      notifyCallbacks(options.callbacks, 'AnthropicClient');
      try {
        const plain = toPlainMessages(messages);
        const systemMessage = plain.find((m) => m.role === 'system');
        const turns = plain.filter((m) => m.role !== 'system').map((m) => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: m.content
        }));
        const body = {
          model,
          system: systemMessage?.content || 'SYS',
          messages: turns,
          max_tokens: maxTokensOf(settings) || 8192,
          temperature: settings.temperature ?? 0.1,
          stream: false
        };

        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: options.signal
        });

        const rawText = await response.text();
        lastBodyText = scrubKey(rawText, apiKey);

        if (!response.ok) {
          const error = new Error(lastBodyText);
          Object.assign(error, { status: response.status, headers: response.headers, rawBody: lastBodyText });
          throw error;
        }

        let data: any;
        try {
          data = JSON.parse(rawText);
        } catch {
          throw new UnreadableReplyError(response.status, new Error('Invalid JSON'));
        }

        if (!data || typeof data !== 'object' || data.error || data.type === 'error' || !Array.isArray(data.content) || data.content.length === 0) {
          throw new UnreadableReplyError(response.status, new Error('Not a chat reply'));
        }

        const text = data.content?.[0]?.text || '';
        const usage = data.usage ? { promptTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens } : undefined;
        const reply = new AIMessage(text);
        if (usage) reply.usage = usage;
        return reply;
      } catch (err) {
        notifyCallbacks(options.callbacks, 'AnthropicClient', err);
        throw err;
      }
    },
    lastBody: () => lastBodyText
  };
}

function geminiCall(settings: LlmSettings, apiKey: string, thinkingConfig?: CompletionOptions['thinkingConfig']): ProviderCall {
  const modelName = modelOf(settings) || 'gemini-1.5-flash';
  let lastBodyText: string | undefined;

  return {
    logTag: 'GeminiClient',
    logTarget: `Gemini (${modelName})`,
    invoke: async (messages, options = {}) => {
      notifyCallbacks(options.callbacks, 'GeminiClient');
      try {
        const plain = toPlainMessages(messages);
        const systemMessage = plain.find((m) => m.role === 'system');
        const turns = plain.filter((m) => m.role !== 'system').map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }]
        }));

        const body: Record<string, unknown> = {
          systemInstruction: { parts: [{ text: systemMessage?.content || 'SYS' }] },
          contents: turns,
          generationConfig: {
            temperature: settings.temperature ?? 0.1,
            ...(thinkingConfig ? { thinkingConfig } : {})
          }
        };

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:streamGenerateContent?alt=sse`;
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-goog-api-key': apiKey
          },
          body: JSON.stringify(body),
          signal: options.signal
        });

        if (!response.ok) {
          const rawText = await response.text();
          lastBodyText = scrubKey(rawText, apiKey);
          let message = lastBodyText;
          try {
            const parsed = JSON.parse(rawText);
            if (parsed.error?.message) {
              message = scrubKey(parsed.error.message, apiKey);
            }
          } catch {}
          const error = new Error(message);
          Object.assign(error, { status: response.status, headers: response.headers, rawBody: lastBodyText });
          throw error;
        }

        const streamText = await response.text();
        lastBodyText = streamText;

        let fullText = '';
        let usage: TokenUsage | undefined;
        let hadData = false;

        const lines = streamText.split(/\r?\n/);
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          hadData = true;
          const jsonStr = line.slice(6).trim();
          if (!jsonStr || jsonStr === '[DONE]') continue;
          try {
            const chunk = JSON.parse(jsonStr);
            const candidate = chunk.candidates?.[0];
            const partText = candidate?.content?.parts?.[0]?.text;
            if (partText) fullText += partText;
            if (chunk.usageMetadata) {
              usage = {
                promptTokens: chunk.usageMetadata.promptTokenCount ?? 0,
                outputTokens: chunk.usageMetadata.candidatesTokenCount ?? 0
              };
            }
          } catch {}
        }

        if (!fullText) {
          if (!hadData) {
            throw new Error('[GoogleGenerativeAI Error]: Failed to parse stream');
          }
          throw new Error(GEMINI_EMPTY_TEXT);
        }

        const reply = new AIMessage(fullText);
        if (usage) {
          reply.usage = usage;
          reply.usage_metadata = { input_tokens: usage.promptTokens, output_tokens: usage.outputTokens };
        }
        return reply;
      } catch (err) {
        notifyCallbacks(options.callbacks, 'GeminiClient', err);
        throw err;
      }
    },
    lastBody: () => lastBodyText
  };
}

export function createProviderCall(provider: ChatProvider, settings: LlmSettings, apiKey: string, thinkingConfig?: CompletionOptions['thinkingConfig']): ProviderCall {
  switch (provider) {
    case 'anthropic': return anthropicCall(settings, apiKey);
    case 'gemini': return geminiCall(settings, apiKey, thinkingConfig);
    default: return openaiFamilyCall(provider, settings, apiKey);
  }
}

// ---------------------------------------------------------------------------------------------
// Custom providers (user-added endpoints)
// ---------------------------------------------------------------------------------------------

const CUSTOM_LOG_TAG = 'CustomClient';
const HTTP_NOTE_LOGGED = new Set<string>();
const ENDPOINT_STRATEGY_LOG = new Map<string, 'chat/completions' | 'responses'>();

function isPrivateHost(host: string): boolean {
  return /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\]|::1)/.test(host)
    || host === 'host.docker.internal'
    || host.endsWith('.local')
    || host.endsWith('.lan');
}

function isResponsesApiError(message: string): boolean {
  const m = message || '';
  return /\/v1\/responses/i.test(m) && (/\/v1\/chat\/completions/i.test(m) || /not support.*chat\/completions/i.test(m));
}

function customOpenaiCall(descriptor: CustomProvider, settings: LlmSettings, apiKey: string, origin: string, model: string, strategy: 'chat/completions' | 'responses' = 'chat/completions'): ProviderCall {
  const baseURL = normalizeCustomOpenaiBase(descriptor.baseUrl);
  const watch = watchFetch({ apiKey, keepReply: true, refuseForeignRedirects: origin });

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;

  return {
    baseUrl: baseURL,
    logTag: CUSTOM_LOG_TAG,
    logTarget: strategy === 'responses' ? `${baseURL}/responses` : `${baseURL}/chat/completions`,
    invoke: async (messages, options = {}) => {
      notifyCallbacks(options.callbacks, 'GeminiClient');
      const plain = toPlainMessages(messages);
      const isDev = isDeveloperRoleModel(model);
      const plainMessages = plain.map((m) => (isDev && m.role === 'system' ? { ...m, role: 'developer' } : m));

      const sendRequest = async (useResponses: boolean) => {
        const url = useResponses ? `${baseURL}/responses` : `${baseURL}/chat/completions`;
        const body = useResponses
          ? { model, input: plainMessages, temperature: settings.temperature ?? 0.1 }
          : { model, messages: plainMessages, temperature: settings.temperature ?? 0.1, stream: false };

        const response = await watch.fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: options.signal
        });

        const rawText = await response.text();
        if (!response.ok) {
          const err = new Error(rawText);
          Object.assign(err, { status: response.status, headers: response.headers, rawBody: rawText });
          throw err;
        }

        let data: any;
        try {
          data = JSON.parse(rawText);
        } catch {
          throw new UnreadableReplyError(response.status, new Error('Invalid JSON'));
        }

        if (!data || typeof data !== 'object' || data.error || (!Array.isArray(data.choices) && !data.output)) {
          throw new UnreadableReplyError(response.status, new Error('Not a chat reply'));
        }

        let text = textOfChoices(rawText);
        if (!text && useResponses) {
          try {
            const parsed = JSON.parse(rawText);
            text = parsed.output?.[0]?.content?.[0]?.text || '';
          } catch {}
        }
        return new AIMessage(text);
      };

      try {
        return await sendRequest(strategy === 'responses');
      } catch (error: any) {
        const rawBody = watch.body() || String(error?.rawBody || error?.message || '');
        if (strategy !== 'responses' && isResponsesApiError(rawBody)) {
          recordResponsesApiStrategy(origin);
          try {
            return await sendRequest(true);
          } catch (retryError) {
            throw watch.asAnswered(retryError, options.signal);
          }
        }
        throw watch.asAnswered(error, options.signal);
      }
    },
    lastBody: watch.body
  };
}

function customAnthropicCall(descriptor: CustomProvider, settings: LlmSettings, apiKey: string, origin: string, model: string): ProviderCall {
  const base = normalizeCustomAnthropicBase(descriptor.baseUrl);
  const watch = watchFetch({
    apiKey,
    stripSdkHeaders: true,
    keepReply: true,
    refuseForeignRedirects: origin,
    headers: { 'anthropic-dangerous-direct-browser-access': 'true' },
    removeHeaders: apiKey ? [] : ['x-api-key']
  });

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true'
  };
  if (apiKey) headers['x-api-key'] = apiKey;

  return {
    baseUrl: `${base}/v1`,
    logTag: CUSTOM_LOG_TAG,
    logTarget: `${base}/v1/messages`,
    invoke: async (messages, options = {}) => {
      notifyCallbacks(options.callbacks, 'GeminiClient');
      const plain = toPlainMessages(messages);
      const systemMessage = plain.find((m) => m.role === 'system');
      const turns = plain.filter((m) => m.role !== 'system').map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content
      }));

      const body = {
        model,
        system: systemMessage?.content || 'SYS',
        messages: turns,
        max_tokens: maxTokensOf(settings) || 8192,
        temperature: settings.temperature ?? 0.1,
        stream: false
      };

      try {
        const response = await watch.fetch(`${base}/v1/messages`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: options.signal
        });

        const rawText = await response.text();
        if (!response.ok) {
          const err = new Error(rawText);
          Object.assign(err, { status: response.status, headers: response.headers, rawBody: rawText });
          throw err;
        }

        let data: any;
        try {
          data = JSON.parse(rawText);
        } catch {
          throw new UnreadableReplyError(response.status, new Error('Invalid JSON'));
        }

        if (!data || typeof data !== 'object' || data.error || data.type === 'error' || !Array.isArray(data.content) || data.content.length === 0) {
          throw new UnreadableReplyError(response.status, new Error('Not a chat reply'));
        }

        const text = data.content?.[0]?.text || '';
        return new AIMessage(text);
      } catch (error) {
        throw watch.asAnswered(error, options.signal);
      }
    },
    lastBody: watch.body
  };
}

export function createCustomProviderCall(descriptor: CustomProvider, settings: LlmSettings, apiKey: string): ProviderCall {
  const origin = endpointOriginOf(descriptor.baseUrl);
  if (!origin) {
    throw new Error(`${descriptor.displayName || descriptor.id} has an unusable base URL (${descriptor.baseUrl || 'empty'}). Open Settings and correct it.`);
  }

  if (origin.startsWith('http:')) {
    const host = endpointHostOf(descriptor.baseUrl) || '';
    if (host && !isPrivateHost(host) && !HTTP_NOTE_LOGGED.has(origin)) {
      HTTP_NOTE_LOGGED.add(origin);
      Logger.info('Llm', `[CUSTOM] ${descriptor.displayName || descriptor.id} is called over plain HTTP (http://${host}). The key travels unencrypted; prefer https when the server offers it.`);
    }
  }

  if (descriptor.protocol !== 'openai' && descriptor.protocol !== 'anthropic') {
    throw new Error(`${descriptor.displayName || descriptor.id} has an unknown API protocol (${String(descriptor.protocol) || 'empty'}). Open Settings, press Edit provider, and pick OpenAI Chat Completions or Anthropic Messages.`);
  }

  const model = modelOf(settings);
  if (!model) {
    throw new Error(`No model is selected for ${descriptor.displayName || descriptor.id}. Pick one in Settings, or type the model id under Custom model name.`);
  }

  if (descriptor.protocol === 'anthropic') {
    return customAnthropicCall(descriptor, settings, apiKey, origin, model);
  }

  const resolvedStrategy = ENDPOINT_STRATEGY_LOG.get(origin) ?? 'chat/completions';
  return customOpenaiCall(descriptor, settings, apiKey, origin, model, resolvedStrategy);
}

export function recordResponsesApiStrategy(origin: string): void {
  ENDPOINT_STRATEGY_LOG.set(origin, 'responses');
  Logger.debug('CustomClient', `[ENDPOINT_DETECT] ${origin} uses OpenAI Responses API (/v1/responses) instead of /v1/chat/completions`);
}
