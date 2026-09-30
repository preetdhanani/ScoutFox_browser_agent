/**
 * llm/factory.ts - one LangChain chat model per call, for the providers that talk to a plain HTTP API.
 *
 * A model is built for every call and dropped after it: nothing about a call (its key, its base URL, its
 * abort signal) can leak into the next one, and the settings are read again each time, as they always were.
 *
 * Rules for every model:
 *   - maxRetries 0. LangChain retries 6 times by default, and callWithRetry (agent/recovery.ts) stays the
 *     only retry layer, so one call is one request.
 *   - temperature is settings.temperature ?? 0.1.
 *   - no response_format, no streaming (except Gemini), no max tokens (except Anthropic): today's request
 *     bodies had none of them.
 *   - the SDK's own request timeout is put out of the way (SDK_TIMEOUT_MS), so the deadline is the only timer.
 *   - the fetch of the model is a watchFetch: it keeps the text of a response for the error texts, takes the key
 *     out of an error response before the SDK reads it, and tells an answer the client could not read from no answer.
 *
 * The OpenAI family (openai, openai_compatible with Groq and keyless local servers, openrouter) uses
 * ChatOpenAICompletions and not ChatOpenAI, which posts some model ids (gpt-5.6, codex, -pro) to
 * /v1/responses, an endpoint compatible servers do not have. The header check that decided this is in
 * "Early check results" of docs/langgraph-design.md, and tests/llm/openaiHeaders.test.ts pins it.
 */
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { Callbacks } from '@langchain/core/callbacks/manager';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatOpenAICompletions } from '@langchain/openai';
import { GEMINI_EMPTY_TEXT, UnreadableReplyError, scrubKey, statusOf } from './errors.ts';
import { SDK_TIMEOUT_MS, baseUrlOf, maxTokensOf, modelOf, withV1 } from './settings.ts';
import type { ChatProvider, ChatTurn, LlmSettings } from './types.ts';

const OPENAI_BASE_URL = 'https://api.openai.com';
const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const OPENROUTER_HEADERS = { 'HTTP-Referer': 'https://github.com/preetdhanani/ScoutFox_browser_agent', 'X-Title': 'ScoutFox AI Agent' };

/**
 * Everything LangChain and the openai SDK add that today's hand-written request does not send: accept, a
 * User-Agent and the x-stainless headers. A null in the PER-CALL `options.headers` removes each of them. A
 * null in `configuration.defaultHeaders` does not (LangChain drops it before the SDK sees it), and a
 * User-Agent there is overwritten, so this must be passed with every invoke.
 */
const NULLED_HEADERS = [
  'accept', 'user-agent',
  'x-stainless-lang', 'x-stainless-package-version', 'x-stainless-os', 'x-stainless-arch', 'x-stainless-runtime',
  'x-stainless-runtime-version', 'x-stainless-retry-count', 'x-stainless-timeout', 'x-stainless-helper-method'
];
export const NULL_HEADERS: Record<string, null> = Object.fromEntries(NULLED_HEADERS.map((name) => [name, null]));

/**
 * The per-call headers of an OpenAI-family request. With no key the model still needs one (the client throws
 * "Missing credentials" without), so it gets a placeholder, and Authorization is removed here, which is what
 * today's keyless request does.
 */
export function openaiRequestHeaders(apiKey: string): Record<string, null> {
  return apiKey ? NULL_HEADERS : { ...NULL_HEADERS, authorization: null };
}

/** The turns as chat messages: the system prompt first, then every turn, assistant turns as such and all others as the user's. */
export function toLangChainMessages(turns: ChatTurn[], systemPrompt: string): BaseMessage[] {
  return [
    new SystemMessage(systemPrompt),
    ...turns.map((turn) => (turn.role === 'assistant' ? new AIMessage(turn.content) : new HumanMessage(turn.content)))
  ];
}

export interface InvokeOptions {
  /** The signal the request is cancelled with (the deadline's). */
  signal?: AbortSignal;
  callbacks?: Callbacks;
}

/** One call, ready to run. It is built for that call and thrown away after. */
export interface ProviderCall {
  /** The OpenAI-style base URL (with /v1), for the error text. Only the OpenAI family has one. */
  baseUrl?: string;
  /** The module name and the target of the "[NETWORK] Failed request to ..." log line. */
  logTag: string;
  logTarget: string;
  invoke(messages: BaseMessage[], options?: InvokeOptions): Promise<BaseMessage>;
  /**
   * The raw text of the last error response, or of the last reply the client could not read. The SDKs do not keep
   * it for every kind of body.
   */
  lastBody(): string | undefined;
}

/** What the SDKs add to a request that today's hand-written one did not send. */
const SDK_HEADER = /^(?:accept|user-agent|x-stainless-.+)$/;

export interface FetchWatchOptions {
  /** The key of the call. It is taken out of an error response before the SDK reads it (a server can echo it back). */
  apiKey?: string;
  /**
   * Headers to put on every request, over what the SDK set. They live here and not in the client's own options,
   * because LangChain hands those options to the callbacks (tracing) as they are, and a key must not be in them.
   */
  headers?: Record<string, string>;
  /** Take out `accept`, `user-agent` and the `x-stainless-*` headers that the SDK adds. */
  stripSdkHeaders?: boolean;
  /** Also keep the text of a successful reply, for a reply the client cannot read. Only for replies that are not streamed. */
  keepReply?: boolean;
}

/** The request as the SDK made it, with the headers of `options` applied. */
function withWireHeaders(init: RequestInit | undefined, { headers, stripSdkHeaders }: FetchWatchOptions): RequestInit | undefined {
  if (!headers && !stripSdkHeaders) return init;
  const merged = new Headers(init?.headers);
  if (stripSdkHeaders) for (const name of [...merged.keys()]) if (SDK_HEADER.test(name)) merged.delete(name);
  for (const [name, value] of Object.entries(headers ?? {})) merged.set(name, value);
  return { ...init, headers: merged };
}

/**
 * The fetch of one chat model, and what it saw. One watcher is for one request (a model is built per call).
 *
 * The OpenAI SDK keeps only the parsed `error` member of a JSON body, so a server that answers {"detail": "..."}
 * or {"message": "..."} (vLLM, LM Studio, FastAPI proxies) would end up as "status code (no body)", and the old texts
 * always carried the raw body. So the text of an error response is kept, and errors.ts prints it after the status.
 * Ollama's client and AgentRouter's calls (llm/ollama.ts, llm/agentRouter.ts) use the same watcher.
 *
 * It also settles a question that the SDK's errors cannot answer. An error with no `status` is either "nobody
 * answered" (a network error, an abort) or "somebody answered and the client choked on the body" (an {"error": ...}
 * in a 200, "choices": [], HTML). `asAnswered()` tells them apart: fetch rejecting is the first, and a response
 * whose body was read is the second.
 */
export function watchFetch(options: FetchWatchOptions = {}) {
  let body: string | undefined;
  let answered: number | undefined;
  let rejected = false;
  return {
    /** The raw text of the last response that was read: an error's always, a successful reply's with `keepReply`. */
    body: () => body,
    /**
     * `error`, as the SDK threw it, unless it has no status although an answer came in: then an UnreadableReplyError
     * that carries the status of that answer. A cancelled call is left alone (its error means "cancelled").
     */
    asAnswered(error: unknown, signal?: AbortSignal | null): unknown {
      if (statusOf(error) !== undefined || rejected || answered === undefined || signal?.aborted) return error;
      return new UnreadableReplyError(answered, error);
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      let response: Response;
      try {
        response = await fetch(input, withWireHeaders(init, options));
      } catch (error) {
        rejected = true;
        throw error;
      }
      if (response.ok && !options.keepReply) return response;
      let text: string;
      try {
        text = await response.clone().text();
      } catch {
        // The body did not arrive (the connection dropped). For a reply that is a failed request, nobody answered;
        // for an error the status is all there is, and the SDK raises it.
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
      // The SDK reads the body of what it is handed, so hand it one without the key. Its message and its error object are then clean too.
      const headers = new Headers(response.headers);
      for (const name of ['content-length', 'content-encoding', 'transfer-encoding']) headers.delete(name);
      return new Response(clean, { status: response.status, statusText: response.statusText, headers });
    }) as typeof fetch
  };
}

/**
 * The text of a chat reply in the OpenAI shapes, read as the old universal extractor read it: choices[0].message.content
 * (a string, or parts with a text), or the legacy completion field choices[0].text. '' when the body is none of them.
 * LangChain reads only the first, and only when message is there.
 */
export function textOfChoices(raw: string | undefined): string {
  try {
    const choice = (JSON.parse(raw ?? '') as { choices?: Array<{ message?: { content?: unknown }; text?: unknown }> } | null)?.choices?.[0];
    const content = choice?.message?.content ?? choice?.text;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((part: { text?: unknown } | null) => (typeof part?.text === 'string' ? part.text : '')).join('');
  } catch {
    // not JSON: nothing to read
  }
  return '';
}

function openaiFamilyCall(provider: 'openrouter' | 'openai' | 'openai_compatible', settings: LlmSettings, apiKey: string): ProviderCall {
  const openrouter = provider === 'openrouter';
  const baseURL = openrouter
    ? OPENROUTER_BASE_URL
    : withV1(baseUrlOf(settings) || (provider === 'openai_compatible' ? GROQ_BASE_URL : OPENAI_BASE_URL));
  const watch = watchFetch({ apiKey, keepReply: true });
  const model = new ChatOpenAICompletions({
    model: modelOf(settings) || (openrouter ? 'anthropic/claude-3.5-sonnet' : 'gpt-4o-mini'),
    apiKey: apiKey || 'unused',
    temperature: settings.temperature ?? 0.1,
    maxRetries: 0,
    timeout: SDK_TIMEOUT_MS,
    configuration: { baseURL, fetch: watch.fetch, ...(openrouter ? { defaultHeaders: OPENROUTER_HEADERS } : {}) }
  });
  const headers = openaiRequestHeaders(apiKey);
  return {
    baseUrl: baseURL,
    logTag: openrouter ? 'OpenRouterClient' : 'OpenAIClient',
    logTarget: openrouter ? 'OpenRouter' : `${baseURL}/chat/completions`,
    invoke: async (messages, options = {}) => {
      try {
        const reply = await model.invoke(messages, { ...options, options: { headers } });
        // A server that answers in the legacy completion shape (choices[0].text) leaves LangChain with an empty reply.
        const legacy = reply.text ? '' : textOfChoices(watch.body());
        return legacy ? new AIMessage(legacy) : reply;
      } catch (error) {
        throw watch.asAnswered(error, options.signal);
      }
    },
    lastBody: watch.body
  };
}

function anthropicCall(settings: LlmSettings, apiKey: string): ProviderCall {
  // stripSdkHeaders: the SDK adds accept, a User-Agent and eight x-stainless-* headers, and today's request has none of them.
  const watch = watchFetch({ apiKey, stripSdkHeaders: true, keepReply: true });
  const model = new ChatAnthropic({
    model: modelOf(settings) || 'claude-3-5-sonnet-20241022',
    apiKey,
    maxTokens: maxTokensOf(settings),
    temperature: settings.temperature ?? 0.1,
    maxRetries: 0,
    clientOptions: { fetch: watch.fetch, timeout: SDK_TIMEOUT_MS }
  });
  return {
    logTag: 'AnthropicClient',
    logTarget: 'Anthropic',
    invoke: async (messages, options) => {
      try {
        return await model.invoke(messages, options);
      } catch (error) {
        throw watch.asAnswered(error, options?.signal);
      }
    },
    lastBody: watch.body
  };
}

/** Takes the key out of an error's message and stack, in place: the error object is the one LangChain hands to the callbacks. */
function scrubError(error: unknown, apiKey: string): unknown {
  if (error instanceof Error) {
    error.message = scrubKey(error.message, apiKey);
    if (error.stack) error.stack = scrubKey(error.stack, apiKey);
  }
  return error;
}

function geminiCall(settings: LlmSettings, apiKey: string): ProviderCall {
  const modelName = modelOf(settings) || 'gemini-1.5-flash';
  const model = new ChatGoogleGenerativeAI({
    model: modelName,
    apiKey,
    temperature: settings.temperature ?? 0.1,
    maxRetries: 0,
    // Not optional: in non-streaming mode the client drops the abort signal, so neither Pause nor the deadline
    // could cancel the request. The key travels in the x-goog-api-key header, no longer in the URL.
    streaming: true
  });
  // The Google SDK calls the global fetch, so there is no fetch of ours to wrap. What it throws carries whatever the
  // server wrote into its message, and LangChain hands that error to every callback before it reaches this file.
  // So the key is taken out of it where the request is made: LangChain keeps the SDK's model in a private `client`
  // field and calls generateContentStream on it for every streamed call (tests/llm/keys.test.ts pins that this works).
  const client = (model as unknown as { client: { generateContentStream(...args: unknown[]): Promise<unknown> } }).client;
  const generate = client.generateContentStream.bind(client);
  client.generateContentStream = async (...args: unknown[]) => {
    try {
      return await generate(...args);
    } catch (error) {
      throw scrubError(error, apiKey);
    }
  };
  return {
    logTag: 'GeminiClient',
    logTarget: `Gemini (${modelName})`,
    invoke: async (messages, options) => {
      try {
        return await model.invoke(messages, options);
      } catch (error) {
        // When Gemini blocks a reply (finishReason SAFETY, or no candidate at all), LangChain fails with
        // "Cannot read properties of undefined (reading 'message')". The old code read such a reply as an empty text.
        if (error instanceof TypeError) throw new Error(GEMINI_EMPTY_TEXT);
        throw error;
      }
    },
    lastBody: () => undefined
  };
}

/** Builds the model for one call. `apiKey` is the trimmed key from getApiKey ('' for a keyless OpenAI-style server). */
export function createProviderCall(provider: ChatProvider, settings: LlmSettings, apiKey: string): ProviderCall {
  switch (provider) {
    case 'anthropic': return anthropicCall(settings, apiKey);
    case 'gemini': return geminiCall(settings, apiKey);
    default: return openaiFamilyCall(provider, settings, apiKey);
  }
}
