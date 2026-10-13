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
import { GEMINI_EMPTY_TEXT, assertApiKey, describeCustomFailure, describeFailure, wrapCustomFailure, wrapFailure } from './errors.ts';
import { createCustomProviderCall, createProviderCall, toLangChainMessages } from './factory.ts';
import type { ProviderCall } from './factory.ts';
import { callOllama } from './ollama.ts';
import { getApiKey, providerOf, timeoutMsOf, timeoutSourceOf } from './settings.ts';
import { isChatProvider } from './types.ts';
import type { ChatProvider, ChatTurn, CompletionOptions, LlmSettings } from './types.ts';

export { fetchAvailableModels, getFallbackModels } from './models.ts';
export { ProviderTimeoutError, isUserAbort, userAbortReason } from './deadline.ts';
export type { ChatTurn, CompletionOptions, LlmSettings } from './types.ts';

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
    call = createProviderCall(chatProvider, settings, apiKey);
  }

  const startTime = Date.now();
  try {
    const reply = await call.invoke(toLangChainMessages(messages, systemPrompt), { signal: options.signal ?? undefined, callbacks: options.callbacks });
    const text = reply.text;
    if (chatProvider === 'gemini' && !text && !custom) throw new Error(GEMINI_EMPTY_TEXT);
    Logger.info('ApiClients', `[NETWORK] 200 OK (${Date.now() - startTime}ms) - Output length: ${text.length} chars`);
    return text;
  } catch (error) {
    const context = { baseUrl: call.baseUrl, apiKey, rawBody: call.lastBody() };
    const inner = custom
      ? describeCustomFailure(error, { ...context, providerLabel: custom.displayName || provider, protocol: custom.protocol })
      : describeFailure(chatProvider, error, context);
    // A Pause, a Stop or the deadline is reported once, as [NETWORK_ABORTED] by generateCompletion, not as a failed request.
    if (!options.signal?.aborted) Logger.error(call.logTag, `[NETWORK] Failed request to ${call.logTarget}`, inner);
    throw new Error(custom
      ? wrapCustomFailure(inner, { ...context, providerLabel: custom.displayName || provider, protocol: custom.protocol })
      : wrapFailure(chatProvider, inner, context));
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

  Logger.info('ApiClients', `[NETWORK] Dispatching completion request to provider [${provider}] with model [${settings.model}] (timeout ${Math.round(timeoutMs / 1000)}s)`);

  const startedAt = Date.now();
  try {
    return await withDeadline({ provider, timeoutMs, signal: options.signal, source: timeoutSourceOf(settings) }, (callSignal) =>
      callProvider(provider, settings, messages, systemPrompt, { ...options, signal: callSignal }));
  } catch (error) {
    Logger.warn('ApiClients', `[NETWORK_ABORTED] Completion via [${provider}] ended after ${Date.now() - startedAt}ms: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}
