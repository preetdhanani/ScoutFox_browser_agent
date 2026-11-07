/**
 * llm/agentRouter.ts - AgentRouter (https://agentrouter.org): two endpoints, tried in turn, joined by hand.
 *
 * AgentRouter fronts several model families and only lets requests through that look like the Claude CLI, so every
 * request carries the CLI's wire image (agentRouterHeaders in models.ts). It is called in two steps:
 *
 *   1. /v1/messages (the Anthropic format).
 *   2. /v1/chat/completions (the OpenAI format), when step 1 failed in a way another endpoint might not,
 *      or answered 200 with no text.
 *
 * What ends the call without step 2:
 *   A 401 or a body that says unauthorized_client_error (the key is refused), an aborted signal, and a network
 *   error (the server is not there). Any other HTTP error, and a 200 with no text, go on to step 2.
 */
import { Logger } from '../../shared/logger.ts';
import {
  ProviderError,
  UnreadableReplyError,
  agentRouterAuthText,
  agentRouterEmptyText,
  assertApiKey,
  classifyProviderFailure,
  describeAgentRouterFailure,
  isAgentRouterAuthFailure,
  statusOf,
  wrapAgentRouterFailure
} from './errors.ts';
import { notifyCallbacks, textOfChoices } from './factory.ts';
import { agentRouterHeaders } from './models.ts';
import { baseUrlOf, getApiKey, maxTokensOf, modelOf, withV1 } from './settings.ts';
import type { ChatTurn, CompletionOptions, LlmSettings } from './types.ts';

const DEFAULT_BASE_URL = 'https://agentrouter.org/v1';
const DEFAULT_MODEL = 'claude-3-5-sonnet';

export async function callAgentRouter(
  settings: LlmSettings,
  messages: ChatTurn[],
  systemPrompt: string,
  options: CompletionOptions = {}
): Promise<string> {
  const apiKey = getApiKey(settings, 'agent_router');
  assertApiKey('agent_router', apiKey);

  const baseUrl = withV1(baseUrlOf(settings) || DEFAULT_BASE_URL);
  const model = modelOf(settings) || DEFAULT_MODEL;
  const temperature = settings.temperature ?? 0.1;
  const signal = options.signal ?? undefined;
  const startTime = Date.now();

  const headers = {
    ...agentRouterHeaders(apiKey),
    'content-type': 'application/json'
  };

  notifyCallbacks(options.callbacks, 'AgentRouterClient');

  const fail = (inner: string, cause?: unknown): never => {
    const errorForCallback = new Error(inner);
    notifyCallbacks(options.callbacks, 'AgentRouterClient', errorForCallback);
    if (!signal?.aborted) Logger.error('AgentRouterClient', '[NETWORK] Failed request to AgentRouter', inner);
    const failure = classifyProviderFailure(cause);
    throw new ProviderError(wrapAgentRouterFailure(inner), {
      status: failure.status,
      kind: failure.kind,
      retryAfterMs: failure.retryAfterMs
    });
  };

  // Attempt 1: the Anthropic Messages endpoint (<base>/messages)
  const messagesUrl = `${baseUrl.replace(/\/v1$/, '')}/v1/messages`;
  const messagesBody = {
    model,
    system: systemPrompt,
    messages: messages.map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content
    })),
    max_tokens: maxTokensOf(settings) || 8192,
    temperature,
    stream: false
  };

  let messagesSucceeded = false;
  let rawBody: string | undefined;

  try {
    const response = await fetch(messagesUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(messagesBody),
      signal
    });

    rawBody = await response.text();
    if (response.ok) {
      let data: any;
      try {
        data = JSON.parse(rawBody);
      } catch {
        throw new UnreadableReplyError(response.status, new Error('Invalid JSON'));
      }

      if (!data || typeof data !== 'object' || data.error || data.type === 'error' || !Array.isArray(data.content)) {
        const foreign = textOfChoices(rawBody);
        if (foreign) {
          Logger.debug('ApiClients', `[NETWORK] 200 OK (${Date.now() - startTime}ms) - Retrieved output from AgentRouter (${model}), length: ${foreign.length} chars`);
          return foreign;
        }
        throw new UnreadableReplyError(response.status, new Error('Not a chat reply'));
      }

      const text = data.content[0]?.text;
      if (text) {
        Logger.debug('ApiClients', `[NETWORK] 200 OK (${Date.now() - startTime}ms) - Retrieved output from AgentRouter (${model}), length: ${text.length} chars`);
        return text;
      }
      const payload = { content: data.content ?? [], stop_reason: data.stop_reason ?? null };
      Logger.warn('ApiClients', `[PAYLOAD_WARN] Messages endpoint returned 200 OK but text content was empty. Payload: ${JSON.stringify(payload)}`);
    } else {
      const err = new Error(rawBody || `HTTP ${response.status}`);
      Object.assign(err, { status: response.status, headers: response.headers, rawBody });
      throw err;
    }
  } catch (error: any) {
    if (signal?.aborted) return fail(String((signal.reason as any)?.message || signal.reason || 'aborted'), error);
    // If network error (fetch threw TypeError or nobody answered)
    const status = statusOf(error);
    if (status === undefined) {
      return fail(describeAgentRouterFailure(error, { apiKey }), error);
    }
    if (status === 401 || isAgentRouterAuthFailure(error, rawBody)) {
      return fail(agentRouterAuthText(error, { rawBody, apiKey }), error);
    }
    Logger.warn('AgentRouterClient', '[NETWORK] Messages endpoint failed, trying the chat completions endpoint', describeAgentRouterFailure(error, { rawBody, apiKey }));
  }

  // Attempt 2: the Chat Completions endpoint (<base>/chat/completions)
  const completionsUrl = `${baseUrl}/chat/completions`;
  const completionsBody = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages
    ],
    temperature,
    stream: false
  };

  try {
    const response = await fetch(completionsUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(completionsBody),
      signal
    });

    const bodyText = await response.text();
    if (!response.ok) {
      const err = new Error(bodyText || `HTTP ${response.status}`);
      Object.assign(err, { status: response.status, headers: response.headers, rawBody: bodyText });
      return fail(describeAgentRouterFailure(err, { rawBody: bodyText, apiKey }), err);
    }

    let data: any;
    try {
      data = JSON.parse(bodyText);
    } catch {
      const err = new UnreadableReplyError(response.status, new Error('Invalid JSON'));
      return fail(describeAgentRouterFailure(err, { rawBody: bodyText, apiKey }), err);
    }

    if (!data || typeof data !== 'object' || data.error || !Array.isArray(data.choices) || data.choices.length === 0) {
      const unreadable = new UnreadableReplyError(response.status, new Error('Not a chat reply'));
      return fail(describeAgentRouterFailure(unreadable, { rawBody: bodyText, apiKey }), unreadable);
    }

    const choice = data.choices[0];
    const text = textOfChoices(bodyText);
    if (!text) {
      const payload = { content: choice?.message?.content ?? choice?.text ?? '', stop_reason: choice?.finish_reason ?? choice?.stop_reason ?? null };
      return fail(agentRouterEmptyText(payload, apiKey));
    }

    Logger.debug('ApiClients', `[NETWORK] 200 OK (${Date.now() - startTime}ms) - Retrieved output via completions fallback, length: ${text.length} chars`);
    return text;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    return fail(describeAgentRouterFailure(error, { apiKey }), error);
  }
}
