/**
 * llm/agentRouter.ts - AgentRouter (https://agentrouter.org): two endpoints, tried in turn, joined by hand.
 *
 * AgentRouter fronts several model families and only lets requests through that look like the Claude CLI, so every
 * request carries the CLI's wire image (agentRouterHeaders in models.ts). It is called in two steps, as it always was:
 *
 *   1. ChatAnthropic on <base>/v1/messages (the Anthropic format).
 *   2. ChatOpenAICompletions on <base>/v1/chat/completions (the OpenAI format), when step 1 failed in a way another
 *      endpoint might not, or answered 200 with no text.
 *
 * What ends the call without step 2, because a second request cannot help: a 401 or a body that says
 * unauthorized_client_error (the key is refused), an aborted signal, and a network error (the server is not there).
 * Any other HTTP error, and a 200 with no text (logged as [PAYLOAD_WARN]), go on to step 2. So does a 200 that
 * ChatAnthropic cannot read as an Anthropic reply (an {"error": ...} object, {}, HTML): the server did answer, so
 * it is not a network error. One that is a chat reply in the OpenAI shape is simply read, as the old client did.
 * The first failure is logged before step 2, and step 2 throws its own error.
 *
 * .withFallbacks() is not used: it also falls back on a 401, does not fall back on an empty 200, and rethrows the
 * first error (checked, see "Early check results" in docs/langgraph-design.md).
 *
 * Headers: the wire image (agentRouterHeaders in models.ts) is put on both requests by the model's fetch
 * (watchFetch in factory.ts), together with the removal of what the SDKs add (accept, x-stainless-*). It is NOT in
 * the client's defaultHeaders or in the call options, because LangChain hands those to the callbacks (tracing),
 * and the wire image carries the key. Chromium replaces the User-Agent of every fetch, whatever is set here, so
 * the declarativeNetRequest session rule 8888 in background.js is what really sets it (and x-app) for agentrouter.org.
 */
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAICompletions } from '@langchain/openai';
import type { BaseMessage } from '@langchain/core/messages';
import { Logger } from '../../shared/logger.ts';
import {
  UnreadableReplyError,
  agentRouterAuthText,
  agentRouterEmptyText,
  assertApiKey,
  describeAgentRouterFailure,
  isAgentRouterAuthFailure,
  statusOf,
  wrapAgentRouterFailure
} from './errors.ts';
import { textOfChoices, toLangChainMessages, watchFetch } from './factory.ts';
import { agentRouterHeaders } from './models.ts';
import { SDK_TIMEOUT_MS, baseUrlOf, getApiKey, maxTokensOf, modelOf, withV1 } from './settings.ts';
import type { ChatTurn, CompletionOptions, LlmSettings } from './types.ts';

const DEFAULT_BASE_URL = 'https://agentrouter.org/v1';
const DEFAULT_MODEL = 'claude-3-5-sonnet';

/** What the model answered, for the [PAYLOAD_WARN] line and the empty-content error (the raw payload is not kept by the SDKs). */
function payloadOf(reply: BaseMessage): { content: unknown; stop_reason: unknown } {
  const meta = reply.response_metadata as { stop_reason?: unknown; finish_reason?: unknown } | undefined;
  return { content: reply.content, stop_reason: meta?.stop_reason ?? meta?.finish_reason ?? null };
}

/**
 * One AgentRouter completion. Errors have the old texts, all behind "AgentRouter API connection error: ", as the old
 * client threw them. A missing key fails first, before anything is built.
 */
export async function callAgentRouter(settings: LlmSettings, messages: ChatTurn[], systemPrompt: string, options: CompletionOptions = {}): Promise<string> {
  const apiKey = getApiKey(settings, 'agent_router');
  assertApiKey('agent_router', apiKey);

  const baseUrl = withV1(baseUrlOf(settings) || DEFAULT_BASE_URL);
  const model = modelOf(settings) || DEFAULT_MODEL;
  const temperature = settings.temperature ?? 0.1;
  const signal = options.signal ?? undefined;
  const turns = toLangChainMessages(messages, systemPrompt);
  const headers = agentRouterHeaders(apiKey);
  const startTime = Date.now();

  const fail = (inner: string): never => {
    // A Pause, a Stop or the deadline is reported once, as [NETWORK_ABORTED] by generateCompletion, not as a failed request.
    if (!signal?.aborted) Logger.error('AgentRouterClient', '[NETWORK] Failed request to AgentRouter', inner);
    throw new Error(wrapAgentRouterFailure(inner));
  };

  // Attempt 1: the Anthropic Messages endpoint. The SDK adds /v1/messages to the URL it is given.
  const messagesCall = watchFetch({ apiKey, headers, stripSdkHeaders: true, keepReply: true });
  const anthropic = new ChatAnthropic({
    model,
    apiKey,
    anthropicApiUrl: baseUrl.replace(/\/v1$/, ''),
    maxTokens: maxTokensOf(settings),
    temperature,
    maxRetries: 0,
    clientOptions: { fetch: messagesCall.fetch, timeout: SDK_TIMEOUT_MS }
  });
  try {
    const reply = await anthropic.invoke(turns, { signal, callbacks: options.callbacks });
    const text = reply.text;
    if (text) {
      Logger.info('ApiClients', `[NETWORK] 200 OK (${Date.now() - startTime}ms) - Retrieved output from AgentRouter (${model}), length: ${text.length} chars`);
      return text;
    }
    Logger.warn('ApiClients', `[PAYLOAD_WARN] Messages endpoint returned 200 OK but text content was empty. Payload: ${JSON.stringify(payloadOf(reply))}`);
  } catch (error) {
    const failure = messagesCall.asAnswered(error, signal);
    const rawBody = messagesCall.body();
    // No HTTP answer (a network error, or an abort that reached the SDK): a second request would meet the same wall.
    if (signal?.aborted || statusOf(failure) === undefined) return fail(describeAgentRouterFailure(failure, { apiKey }));
    // A model that AgentRouter serves in the OpenAI format may answer this endpoint in that format too.
    const foreign = failure instanceof UnreadableReplyError ? textOfChoices(rawBody) : '';
    if (foreign) {
      Logger.info('ApiClients', `[NETWORK] 200 OK (${Date.now() - startTime}ms) - Retrieved output from AgentRouter (${model}), length: ${foreign.length} chars`);
      return foreign;
    }
    if (isAgentRouterAuthFailure(failure, rawBody)) return fail(agentRouterAuthText(failure, { rawBody, apiKey }));
    Logger.warn('AgentRouterClient', '[NETWORK] Messages endpoint failed, trying the chat completions endpoint', describeAgentRouterFailure(failure, { rawBody, apiKey }));
  }

  // Attempt 2: the Chat Completions endpoint, with no max tokens, as before.
  const completionsCall = watchFetch({ apiKey, headers, stripSdkHeaders: true, keepReply: true });
  const openai = new ChatOpenAICompletions({
    model,
    apiKey,
    temperature,
    maxRetries: 0,
    timeout: SDK_TIMEOUT_MS,
    configuration: { baseURL: baseUrl, fetch: completionsCall.fetch }
  });
  let reply: BaseMessage;
  try {
    reply = await openai.invoke(turns, { signal, callbacks: options.callbacks });
  } catch (error) {
    return fail(describeAgentRouterFailure(completionsCall.asAnswered(error, signal), { rawBody: completionsCall.body(), apiKey }));
  }
  const text = reply.text || textOfChoices(completionsCall.body());
  if (!text) return fail(agentRouterEmptyText(payloadOf(reply), apiKey));

  Logger.info('ApiClients', `[NETWORK] 200 OK (${Date.now() - startTime}ms) - Retrieved output via completions fallback, length: ${text.length} chars`);
  return text;
}
