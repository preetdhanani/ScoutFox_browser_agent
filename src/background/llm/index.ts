/**
 * llm/index.ts - the LLM client and model surface.
 *
 *   generateCompletion(settings, messages, systemPrompt, { signal, json, schema }) -> string
 *   fetchAvailableModels(settings, forceRefresh)                                   -> string[]
 *
 * generateCompletion handles completion calls: one log line on dispatch, a deadline
 * (settings.llmTimeoutMs, 120 s by default) plus the task's abort signal, one log line when a call fails.
 * What is new is what happens under it. The provider call is a LangChain chat model built for that call
 * (factory.ts, ollama.ts, agentRouter.ts), and the deadline and the signal really cancel its request (deadline.ts).
 */
import { Logger } from '../../shared/logger.ts';
import { callAgentRouter } from './agentRouter.ts';
import { withDeadline } from './deadline.ts';
import { GEMINI_EMPTY_TEXT, ProviderError, assertApiKey, classifyProviderFailure, describeCustomFailure, describeFailure, retryAfterOf, wrapCustomFailure, wrapFailure } from './errors.ts';
import { createCustomProviderCall, createProviderCall, toLangChainMessages } from './factory.ts';
import type { ProviderCall } from './factory.ts';
import { callOllama } from './ollama.ts';
import { NVIDIA_BASE_URL, baseUrlOf, getApiKey, normalizeCustomOpenaiBase, normalizeNvidiaBaseUrl, providerOf, timeoutMsOf, timeoutSourceOf, withV1 } from './settings.ts';
import { getEffectiveContextWindow } from './models.ts';
import { applyEffortPatch, effortPatch, effortSupportOf, geminiThinkingConfig, learnValuesFromError, nearestSupportedLevel, ollamaThink, openaiReasoningBody, refusedEffortField, registryDialect, rememberRefused, resolveEffortSupport } from './effort.ts';
import type { EffortLevel, EffortPatch, EffortSupport } from './effort.ts';
import { isChatProvider } from './types.ts';
import type { ChatProvider, ChatTurn, CompletionOptions, LlmSettings } from './types.ts';

export { fetchAvailableModels, getFallbackModels } from './models.ts';
export { ProviderTimeoutError, isUserAbort, userAbortReason } from './deadline.ts';
export type { ChatTurn, CompletionOptions, LlmSettings } from './types.ts';

// Tool calling support
export interface ToolCall {
  id: string;
  function: { name: string; arguments: string };
}

export interface ProviderOptions {
  tools?: any[];
  toolChoice?: 'auto' | 'none';
  /** The run's abort signal: a Pause or a Stop cancels the request in flight. */
  signal?: AbortSignal;
  /** How hard the model thinks (llm/effort.ts). Absent or 'auto': no reasoning field is sent. */
  effort?: EffortLevel;
}

/** One reply of the tool loop. `reasoning` is the model's thinking text when the provider returns it (for the log only). */
export interface ToolReply {
  text?: string;
  tool_calls?: ToolCall[];
  reasoning?: string;
  /** OpenRouter's reasoning_details, to be sent back with this assistant turn. */
  reasoningDetails?: unknown[];
  /** The effort that went out on the wire, for the log: the dialect, the level and the fields, or null when nothing was sent. */
  effortSent?: { dialect: string; level: EffortLevel; source: string; fields: Record<string, unknown> } | null;
}

/** Built-in providers that speak OpenAI's /chat/completions with native tool calls. */
const OPENAI_TOOL_PROVIDERS = ['openai', 'openai_compatible', 'openrouter', 'groq', 'nvidia', 'agent_router', 'anthropic'];

export async function callProviderWithTools(
  providerId: string,
  settings: LlmSettings,
  messages: any[],
  systemPrompt: string,
  options: ProviderOptions = {}
): Promise<ToolReply> {
  // The caller's messages may already carry their own system message (the MCP client keeps one in
  // its history); the systemPrompt argument is an additional prefix, prepended only when given.
  const formattedMessages = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, ...messages]
    : messages;
  const toolChoice = options.toolChoice ?? 'auto';
  const custom = settings.customProviders?.[providerId];
  // What this model takes is resolved before the deadline starts: for Ollama it may be one
  // /api/show the first time (with its own short timeout, and the run's signal). A custom endpoint
  // never gets an effort. The level sent is always one the model supports (the panel's nearest).
  const effortSettings = { ...settings, provider: providerId };
  const asked = options.effort ?? 'auto';
  const effort: EffortSupport | null = asked === 'auto' || custom ? null : await resolveEffortSupport(effortSettings, options.signal);
  const level = effort ? nearestSupportedLevel(asked, effort.levels) : 'auto';
  const thinks = effort !== null && effort.dialect !== 'none' && level !== 'auto';

  // The same deadline as generateCompletion (per-provider timeout, NVIDIA default included), and
  // the run's signal, so a Pause or Stop really cancels the request instead of waiting it out.
  return withDeadline({ provider: providerId, timeoutMs: timeoutMsOf(settings), signal: options.signal, source: timeoutSourceOf(settings) }, async (callSignal): Promise<ToolReply> => {
    if (providerId === 'ollama') {
      return callOllamaWithTools(settings, formattedMessages, options.tools, toolChoice, callSignal, thinks ? { support: effort!, level } : null);
    }
    if (OPENAI_TOOL_PROVIDERS.includes(providerId) || custom?.protocol === 'openai') {
      return callOpenAICompatibleWithTools(settings, formattedMessages, options.tools, toolChoice, providerId, callSignal, thinks ? { support: effort!, level } : null);
    }
    // Gemini and Anthropic-protocol custom endpoints: tool calling is simulated through the prompt.
    const thinkingConfig = thinks ? geminiThinkingConfig(effort!.dialect, level, effort!.values) : undefined;
    try {
      const reply = await callWithPromptEngineering(settings, formattedMessages, options.tools, callSignal, thinkingConfig);
      return { ...reply, effortSent: thinkingConfig ? { dialect: effort!.dialect, level, source: effort!.source, fields: { thinkingConfig } } : null };
    } catch (error: any) {
      // A model that refuses the thinkingConfig (a budget it cannot take, a level it does not
      // know) gets the round again without it, and never gets it again.
      if (!thinkingConfig || callSignal.aborted || !refusedEffortField(error?.status, String(error?.message || ''), { thinkingConfig, thinkingBudget: 1, thinkingLevel: 1, thinking_config: 1, thinking_budget: 1, thinking_level: 1, thinking: 1 })) throw error;
      rememberRefused(effortSettings);
      return { ...await callWithPromptEngineering(settings, formattedMessages, options.tools, callSignal, undefined), effortSent: null };
    }
  });
}

/** The effort of one call: what the model takes, and the level asked for. Null: nothing is sent. */
interface CallEffort {
  support: EffortSupport;
  level: EffortLevel;
}

/**
 * One call to one provider, with no deadline of its own. The abort signal in `options` goes straight to
 * the request. Errors have today's texts (errors.ts), and a missing key fails before any model is built.
 * Ollama and AgentRouter have their own modules (ollama.ts, agentRouter.ts): each has fallbacks and error rules
 * that the plain chat-model call below does not.
 * A provider id saved under settings.customProviders is a user-added endpoint: it resolves to its descriptor
 * and is built by protocol (factory.ts), with its own error texts that name the provider, the protocol and the URL.
 */
export async function callProvider(provider: string, settings: LlmSettings, messages: ChatTurn[], systemPrompt: string, options: CompletionOptions = {}): Promise<string> {
  if (provider === 'ollama') return callOllama(settings, messages, systemPrompt, options);
  if (provider === 'agent_router') return callAgentRouter(settings, messages, systemPrompt, options);
  const custom = settings.customProviders?.[provider];
  const apiKey = getApiKey(settings, provider);
  let call: ProviderCall;
  let chatProvider: ChatProvider;
  if (custom) {
    // A custom endpoint has no curated defaults: an unusable URL or a missing model fails here, before any request.
    call = createCustomProviderCall(custom, settings, apiKey);
    chatProvider = custom.protocol;
  } else {
    if (!isChatProvider(provider)) throw new Error(`Unsupported LLM provider: ${provider}`);
    chatProvider = provider;
    assertApiKey(chatProvider, apiKey);
    call = createProviderCall(chatProvider, settings, apiKey, options.thinkingConfig);
  }

  const startTime = Date.now();
  try {
    const reply = await call.invoke(toLangChainMessages(messages, systemPrompt), { signal: options.signal ?? undefined, callbacks: options.callbacks });
    const text = reply.text;
    if (chatProvider === 'gemini' && !text && !custom) throw new Error(GEMINI_EMPTY_TEXT);
    Logger.debug('ApiClients', `[NETWORK] 200 OK (${Date.now() - startTime}ms) - Output length: ${text.length} chars`);
    return text;
  } catch (error) {
    const context = { baseUrl: call.baseUrl, apiKey, rawBody: call.lastBody() };
    const inner = custom
      ? describeCustomFailure(error, { ...context, providerLabel: custom.displayName || provider, protocol: custom.protocol })
      : describeFailure(chatProvider, error, context);
    // A Pause, a Stop or the deadline is reported once, as [NETWORK_ABORTED] by generateCompletion, not as a failed request.
    if (!options.signal?.aborted) Logger.error(call.logTag, `[NETWORK] Failed request to ${call.logTarget}`, inner);
    // The classification comes from the error the SDK threw (its status, its retry-after header), the text
    // from the failure functions: the caller gets today's message plus the kind the retry wrapper needs.
    const failure = classifyProviderFailure(error);
    throw new ProviderError(custom
      ? wrapCustomFailure(inner, { ...context, providerLabel: custom.displayName || provider, protocol: custom.protocol })
      : wrapFailure(chatProvider, inner, context), { status: failure.status, kind: failure.kind, retryAfterMs: failure.retryAfterMs });
  }
}

/** Main completion method dispatching to the selected provider. */
export async function generateCompletion(
  settings: LlmSettings,
  messages: ChatTurn[],
  systemPrompt: string,
  options: CompletionOptions = {}
): Promise<string> {
  const provider = providerOf(settings);
  const timeoutMs = timeoutMsOf(settings);

  Logger.debug('ApiClients', `[NETWORK] Dispatching completion request to provider [${provider}] with model [${settings.model}] (timeout ${Math.round(timeoutMs / 1000)}s)`);

  const startedAt = Date.now();
  try {
    return await withDeadline({ provider, timeoutMs, signal: options.signal, source: timeoutSourceOf(settings) }, (callSignal) =>
      callProvider(provider, settings, messages, systemPrompt, { ...options, signal: callSignal }));
  } catch (error) {
    Logger.warn('ApiClients', `[NETWORK_ABORTED] Completion via [${provider}] ended after ${Date.now() - startedAt}ms: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

// ============================================================================
// Tool Calling Support
// ============================================================================

/**
 * The conversation in the shape Ollama's /api/chat accepts it.
 *
 * Ollama wants `tool_calls[].function.arguments` as an OBJECT and answers 400 for a string, with the
 * message "Value looks like object, but can't find closing '}' symbol" (verified against Ollama
 * 0.40.6; it is what killed a real multi-step run, on the second call, when the first call's tool
 * call came back in the history). The tool loop keeps arguments as a JSON string, which is OpenAI's
 * convention and what its own code parses, so the strings are turned back into objects here, at the
 * one place that speaks Ollama's format.
 *
 * A string that does not parse goes out as an empty object. That call was already rejected and the
 * model already told, so the shape matters less than the run going on.
 */
function withObjectToolArguments(messages: any[]): any[] {
  return (messages || []).map((message) => {
    if (!Array.isArray(message?.tool_calls)) return message;
    return {
      ...message,
      tool_calls: message.tool_calls.map((call: any) => (
        typeof call?.function?.arguments === 'string'
          ? { ...call, function: { ...call.function, arguments: argumentsOf(call.function.arguments) } }
          : call
      ))
    };
  });
}

/** One tool call's arguments, from the loop's JSON string to the object Ollama expects. */
function argumentsOf(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** The data: prefix of a base64 data URL. */
const DATA_URL_PREFIX = /^data:[^;,]*;base64,/i;

/** The base64 of a data URL, or the string itself when it has no prefix. */
export function stripDataUrl(url: string): string {
  return String(url || '').replace(DATA_URL_PREFIX, '');
}

/**
 * One message in the shape Ollama's /api/chat accepts.
 *
 * Ollama has no content array: the text stays in `content`, and the pictures become a SIBLING
 * `images` array of bare base64 strings on the same `role:'user'` message. That shape only exists
 * for a user message, which is why the tool loop puts the picture in one.
 *
 * A message that is not a content array is returned untouched, so a plain text turn is exactly
 * what it was.
 */
export function toOllamaMessage(message: any): any {
  if (!message || !Array.isArray(message.content)) return message;
  const texts: string[] = [];
  const images: string[] = [];
  for (const block of message.content) {
    if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    else if (block?.type === 'image_url' && typeof block.image_url?.url === 'string') images.push(stripDataUrl(block.image_url.url));
  }
  return {
    ...message,
    content: texts.join('\n\n'),
    ...(images.length > 0 ? { images } : {})
  };
}

/**
 * The messages with every content array turned into Ollama's shape, and the tool arguments turned
 * into the objects Ollama expects. The one place both conversions happen.
 */
export function toOllamaMessages(messages: any[]): any[] {
  return withObjectToolArguments(messages).map(withoutReasoningDetails).map(toOllamaMessage);
}

/**
 * Fail-fast check of one tool's `inputSchema` before it is sent to a provider as OpenAI `parameters`.
 * Providers reject a schema where a field that must be an array (`required`, `enum`, `allOf`,
 * `anyOf`, `oneOf`) or an object (`properties`, `items`) is `null` - answering with an opaque HTTP
 * 400 that kills the whole run before the model is ever asked. Catch it here instead, with a
 * message that names the tool and the offending field, so the run ends with a clear local error
 * and no network call is made.
 */
export function assertToolSchema(tool: { name: string; inputSchema: any }): void {
  const { name, inputSchema: s } = tool;
  const at = (field: string) => `Tool "${name}": inputSchema.${field}`;
  if (s === null || typeof s !== 'object' || Array.isArray(s)) throw new Error(`${at('')} must be an object`);
  if (s.type !== 'object') throw new Error(`${at('type')} must be "object"`);
  if (s.properties !== undefined && (s.properties === null || typeof s.properties !== 'object' || Array.isArray(s.properties))) {
    throw new Error(`${at('properties')} must be an object`);
  }
  if (s.required !== undefined && !Array.isArray(s.required)) throw new Error(`${at('required')} must be an array of strings`);
  if (Array.isArray(s.required) && s.required.some((item: any) => typeof item !== 'string')) {
    throw new Error(`${at('required')} must be an array of strings`);
  }
  if (s.enum !== undefined && !Array.isArray(s.enum)) throw new Error(`${at('enum')} must be an array`);
  for (const field of ['allOf', 'anyOf', 'oneOf']) {
    const value = s[field];
    if (value !== undefined && (!Array.isArray(value) || value.some((item: any) => item === null || typeof item !== 'object'))) {
      throw new Error(`${at(field)} must be an array of schema objects`);
    }
  }
  for (const [key, prop] of (Object.entries(s.properties || {}) as [string, any][])) {
    if (!prop || typeof prop !== 'object') continue;
    if (prop.type === 'array' && (prop.items === null || typeof prop.items !== 'object' || Array.isArray(prop.items))) {
      throw new Error(`${at(`properties.${key}.items`)} must be a schema object`);
    }
  }
}

async function callOllamaWithTools(
  settings: LlmSettings,
  messages: any[],
  tools: any[] | undefined,
  toolChoice: 'auto' | 'none',
  signal: AbortSignal,
  effort: CallEffort | null
): Promise<ToolReply> {
  ;(tools || []).forEach(assertToolSchema);
  const baseUrl = (baseUrlOf(settings) || 'http://localhost:11434').replace(/\/+$/, '');
  const url = `${baseUrl}/api/chat`;

  const ollamaTools = (tools || []).map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema
    }
  })) || [];

  // Use dynamic context window: fetch from endpoint, fallback to stored setting, then to model-specific default
  const numCtx = await getEffectiveContextWindow(settings);

  const payload = {
    model: settings.model,
    messages: toOllamaMessages(messages),
    tools: ollamaTools,
    tool_choice: toolChoice === 'none' ? 'none' : 'auto',
    stream: false,
    options: { temperature: 0.1, num_ctx: numCtx }
  };
  const think = effort ? ollamaThink(effort.support.dialect, effort.level, effort.support.values) : undefined;
  const post = (body: object) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
  });

  let sent: ToolReply['effortSent'] = think === undefined ? null : { dialect: effort!.support.dialect, level: effort!.level, source: effort!.support.source, fields: { think } };
  let response = await post(think === undefined ? payload : { ...payload, think });
  if (!response.ok && sent) {
    // A model or an older server that refuses `think` ("does not support thinking") gets the round
    // again without it, and never gets the field again.
    const text = await response.clone().text();
    if (refusedEffortField(response.status, text, { think })) {
      rememberRefused(settings);
      sent = null;
      response = await post(payload);
    }
  }

  if (!response.ok) {
    // The status travels with the error, so the loop can tell a passing server error from a refusal.
    throw Object.assign(new Error(`Ollama error: ${response.status} ${await response.text()}`), { status: response.status });
  }

  const data = await response.json();
  const message = data.message || {};
  const reasoning = typeof message.thinking === 'string' && message.thinking ? message.thinking : undefined;

  if (message.tool_calls && message.tool_calls.length > 0) {
    return {
      tool_calls: message.tool_calls.map((tc: any, i: number) => ({
        id: tc.id || `call_${i}`,
        function: {
          name: tc.function.name,
          arguments: JSON.stringify(tc.function.arguments)
        }
      })),
      reasoning,
      effortSent: sent
    };
  }

  return { text: message.content || '', reasoning, effortSent: sent };
}

/** The one effort value among the fields sent (reasoning_effort, reasoning.effort, output_config.effort), or ''. */
function sentValueOf(fields: Record<string, any>): string {
  return String(fields.reasoning_effort ?? fields.reasoning?.effort ?? fields.output_config?.effort ?? '');
}

/** A history message without OpenRouter's reasoning_details. */
function withoutReasoningDetails(message: any): any {
  if (!message || !('reasoning_details' in message)) return message;
  const { reasoning_details: _dropped, ...rest } = message;
  return rest;
}

/** The reasoning fields of one OpenAI-shaped call, from the model's support and the level. */
function openaiEffortPatch(providerId: string, effort: CallEffort): EffortPatch {
  const patch = effortPatch(effort.support.dialect, effort.level, effort.support.values);
  // OpenAI's own reasoning models refuse a temperature and take max_completion_tokens.
  return providerId === 'openai' ? openaiReasoningBody(patch) : patch;
}

async function callOpenAICompatibleWithTools(
  settings: LlmSettings,
  messages: any[],
  tools: any[] | undefined,
  toolChoice: 'auto' | 'none',
  providerId: string,
  signal: AbortSignal,
  effort: CallEffort | null
): Promise<ToolReply> {
  ;(tools || []).forEach(assertToolSchema);
  const baseUrl = toolBaseUrlOf(settings, providerId);
  const url = `${baseUrl}/chat/completions`;

  const openaiTools = (tools || []).map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema
    }
  })) || [];

  // OpenAI's own reasoning models (o-series, GPT-5) refuse a temperature and max_tokens whatever
  // the effort, so they never get them, not even on Auto or after a refused effort.
  const openaiReasoner = providerId === 'openai' && registryDialect('openai', String(settings.model || '')) === 'openai';
  const payload: Record<string, unknown> = {
    model: settings.model,
    // OpenRouter's reasoning_details go back to OpenRouter only; another server would refuse the field.
    messages: providerId === 'openrouter' ? withTypedToolCalls(messages) : withTypedToolCalls(messages).map(withoutReasoningDetails),
    tools: openaiTools,
    tool_choice: toolChoice === 'none' ? 'none' : 'auto',
    ...(openaiReasoner ? { max_completion_tokens: 8192 } : { temperature: 0.1, max_tokens: 8192 })
  };

  const apiKey = getApiKey(settings, providerId);
  const custom = settings.customProviders?.[providerId];
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  // A custom endpoint saved with keyMode 'none' takes no key, so no Authorization header at all.
  if (custom?.keyMode !== 'none') headers.Authorization = `Bearer ${apiKey}`;
  const post = (body: object) => fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal
  });

  // A custom endpoint never gets a reasoning field (the caller passes no effort for one).
  const effortSettings = { ...settings, provider: providerId };
  let current: CallEffort | null = custom ? null : effort;
  let response: Response;
  let sent: ToolReply['effortSent'] = null;
  for (let attempt = 0; ; attempt++) {
    const patch = current ? openaiEffortPatch(providerId, current) : null;
    const fields = patch ? patch.set : {};
    sent = current && Object.keys(fields).length ? { dialect: current.support.dialect, level: current.level, source: current.support.source, fields } : null;
    response = await post(patch ? applyEffortPatch(payload, patch) : payload);
    if (response.ok || !sent || attempt >= 2) break;
    const text = await response.clone().text();
    if (!refusedEffortField(response.status, text, fields, Boolean(patch!.minMaxTokens || patch!.maxTokensField))) break;
    // The provider refused a reasoning value or field. A 400 that lists the accepted values
    // ("expected one of ...") is learned and the round is sent again with one of them; any other
    // refusal sends the round again with no reasoning field, and the model never gets one again.
    if (attempt === 0 && learnValuesFromError(effortSettings, current!.support.dialect, text, sentValueOf(fields))) {
      current = { support: effortSupportOf(effortSettings), level: current!.level };
      if (current.support.dialect !== 'none') continue;
    }
    rememberRefused(effortSettings);
    current = null;
  }

  if (!response.ok) {
    // The status travels with the error, so the loop can tell a passing server error from a refusal.
    throw Object.assign(new Error(`API error: ${response.status} ${await response.text()}`), { status: response.status });
  }

  const data = await response.json();
  const choice = data.choices?.[0];
  const message = choice?.message || {};
  // NIM, Groq and DeepSeek put the thinking in reasoning_content or reasoning; OpenAI returns none.
  const thought = message.reasoning_content ?? message.reasoning;
  const reasoning = typeof thought === 'string' && thought ? thought : undefined;
  // OpenRouter's reasoning_details must go back with the assistant turn in a tool loop (Claude and
  // encrypted reasoning need it); the client keeps it on the turn it records.
  const reasoningDetails = Array.isArray(message.reasoning_details) && message.reasoning_details.length ? message.reasoning_details : undefined;

  if (message.tool_calls && message.tool_calls.length > 0) {
    return {
      tool_calls: message.tool_calls.map((tc: any) => ({
        id: tc.id,
        function: {
          name: tc.function.name,
          arguments: typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments)
        }
      })),
      reasoning,
      reasoningDetails,
      effortSent: sent
    };
  }

  return { text: message.content || '', reasoning, reasoningDetails, effortSent: sent };
}

/** Default /v1 bases of the built-in OpenAI-style providers. */
const DEFAULT_TOOL_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  groq: 'https://api.groq.com/openai/v1',
  nvidia: NVIDIA_BASE_URL,
  agent_router: 'https://agentrouter.org/v1',
  anthropic: 'https://api.anthropic.com/v1'
};

/**
 * The /v1 base a tool call posts to. The base URL the user configured wins (top-level first, then
 * the provider's saved config), with the same normalization the completion path applies; the
 * built-in default is the last resort.
 */
export function toolBaseUrlOf(settings: LlmSettings, provider: string): string {
  const custom = settings.customProviders?.[provider];
  if (custom) return normalizeCustomOpenaiBase(custom.baseUrl);
  const configured = baseUrlOf(settings) || (settings.providerConfigs?.[provider]?.baseUrl || '').trim();
  if (provider === 'nvidia') return normalizeNvidiaBaseUrl(configured);
  if (configured) return withV1(configured);
  return DEFAULT_TOOL_BASE_URLS[provider] || DEFAULT_TOOL_BASE_URLS.openai;
}

/**
 * The history with every replayed tool call in OpenAI's full shape: `type: 'function'` and the
 * arguments as a JSON string. OpenAI answers 400 ("Missing required parameter tool_calls[0].type")
 * without the type, from the second round on.
 */
export function withTypedToolCalls(messages: any[]): any[] {
  return (messages || []).map((message) => {
    if (!Array.isArray(message?.tool_calls)) return message;
    return {
      ...message,
      tool_calls: message.tool_calls.map((call: any) => ({
        id: call.id,
        type: 'function',
        function: {
          name: call.function?.name,
          arguments: typeof call.function?.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function?.arguments ?? {})
        }
      }))
    };
  });
}

/**
 * The tool loop's history as plain chat turns, for a provider without native tool calls.
 *
 * The chat path only knows user and assistant text, so: system messages become the system prompt,
 * an assistant tool call is said in words, a tool result becomes a user turn that names the tool,
 * and a picture is replaced by a line of text (this path sends no images).
 */
export function toPromptTurns(messages: any[]): { systemPrompt: string; turns: ChatTurn[] } {
  const system: string[] = [];
  const turns: ChatTurn[] = [];
  const names = new Map<string, string>();
  const textOf = (content: any): string => Array.isArray(content)
    ? content.map((block: any) => (block?.type === 'text' ? block.text : '[a picture of the page, not shown to this model]')).join('\n\n')
    : String(content ?? '');
  for (const message of messages || []) {
    if (message?.role === 'system') {
      system.push(textOf(message.content));
    } else if (message?.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      const said = message.tool_calls.map((call: any) => {
        names.set(call.id, call.function?.name);
        const args = typeof call.function?.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function?.arguments ?? {});
        return `\`\`\`json\n{"name": ${JSON.stringify(call.function?.name)}, "arguments": ${args || '{}'}}\n\`\`\``;
      });
      turns.push({ role: 'assistant', content: said.join('\n') });
    } else if (message?.role === 'tool') {
      turns.push({ role: 'user', content: `Result of ${names.get(message.tool_call_id) || 'the tool'}:\n${textOf(message.content)}` });
    } else if (message?.role === 'assistant') {
      turns.push({ role: 'assistant', content: textOf(message.content) });
    } else {
      turns.push({ role: 'user', content: textOf(message?.content) });
    }
  }
  return { systemPrompt: system.join('\n\n'), turns };
}

async function callWithPromptEngineering(
  settings: LlmSettings,
  messages: any[],
  tools: any[] | undefined,
  signal: AbortSignal,
  thinkingConfig?: CompletionOptions['thinkingConfig']
): Promise<ToolReply> {
  const toolDescriptions = (tools || []).map(t =>
    `${t.name}: ${t.description}\nArgs: ${JSON.stringify(t.inputSchema)}`
  ).join('\n\n') || '';

  const { systemPrompt, turns } = toPromptTurns(messages);
  turns.push({
    role: 'user',
    content: `Available tools:\n${toolDescriptions}\n\nReply with a tool call in this format:\n\`\`\`json\n{"name": "tool_name", "arguments": {...}}\n\`\`\``
  });

  const text = await callProvider(providerOf(settings), settings, turns, systemPrompt, { signal, thinkingConfig });

  const toolCall = parseToolCallFromText(text);
  if (toolCall) {
    // The loop keeps arguments as a JSON string (OpenAI's convention), like every other path.
    return { tool_calls: [{ id: `call_${Date.now()}`, function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments ?? {}) } }] };
  }

  return { text };
}

/** The first fenced json tool call in a reply, or null. A call with no arguments is still a call. */
export function parseToolCallFromText(text: string): { name: string; arguments: Record<string, unknown> } | null {
  const jsonMatch = String(text || '').match(/```json\s*(\{[\s\S]*?\})\s*```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      if (parsed && typeof parsed.name === 'string' && parsed.name) {
        const args = parsed.arguments && typeof parsed.arguments === 'object' && !Array.isArray(parsed.arguments) ? parsed.arguments : {};
        return { name: parsed.name, arguments: args };
      }
    } catch {}
  }
  return null;
}
