/**
 * Status propagation (ticket p1-error-recovery-llm-retry-blind-and-short): the provider boundary throws a
 * ProviderError that carries the HTTP status, the failure kind and the retry-after hint, so the retry wrapper
 * (agent/recovery.ts) can tell "worth retrying" from "will never work" without guessing from message text.
 *
 * Every provider is driven through the real LangChain clients against a fetch spy, exactly like errors.test.ts
 * pins the texts: the thrown error must be a ProviderError whose status and kind match the answer, its message
 * stays today's text, and a retry-after header the server sent survives the trip.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderError, classifyProviderFailure } from '../../src/background/llm/errors.ts';
import { generateCompletion } from '../../src/background/llm/index.ts';
import { callAgentRouter } from '../../src/background/llm/agentRouter.ts';
import { callOllama } from '../../src/background/llm/ollama.ts';
import type { LlmSettings } from '../../src/background/llm/types.ts';
import { jsonResponse, spyFetch, textReply } from '../helpers/llmWire.ts';
import type { CustomProvider } from '../../src/shared/storage.ts';

const MESSAGES = [{ role: 'user', content: 'hi' }];
const KEY = 'sk-test-1234567890';

const SETTINGS: Record<string, LlmSettings> = {
  openrouter: { provider: 'openrouter', apiKey: KEY, model: 'anthropic/claude-3.5-sonnet' },
  openai: { provider: 'openai', apiKey: KEY, model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com' },
  anthropic: { provider: 'anthropic', apiKey: KEY, model: 'claude-3-5-sonnet-20241022' },
  gemini: { provider: 'gemini', apiKey: KEY, model: 'gemini-1.5-flash' },
  nvidia: { provider: 'nvidia', apiKey: KEY, model: 'meta/llama-3.3-70b-instruct', baseUrl: 'https://integrate.api.nvidia.com/v1' },
  ollama: { provider: 'ollama', model: 'qwen2.5:7b', baseUrl: 'http://localhost:11434' },
  agent_router: { provider: 'agent_router', apiKey: KEY, model: 'claude-3-5-sonnet', baseUrl: 'https://agentrouter.org/v1' }
};

const CUSTOM_DESCRIPTOR: CustomProvider = {
  id: 'acme-gateway',
  displayName: 'Acme Gateway',
  protocol: 'openai',
  baseUrl: 'https://gateway.example/v1',
  models: ['acme-large'],
  keyMode: 'apiKey',
  createdAt: 1,
  updatedAt: 1
};
const CUSTOM_SETTINGS: LlmSettings = {
  provider: 'acme-gateway',
  model: 'acme-large',
  customProviders: { 'acme-gateway': { ...CUSTOM_DESCRIPTOR } }
} as LlmSettings;

type T = { after: (fn: () => void) => void };

const failureOf = (promise: Promise<unknown>) => promise.then(() => assert.fail('the call was expected to fail'), (error: Error) => error);

async function statusOfCall(t: T, settings: LlmSettings, reply: () => Response) {
  spyFetch(t, reply);
  const error = await failureOf(generateCompletion(settings, MESSAGES, 'system'));
  assert.ok(error instanceof ProviderError, `${settings.provider}: the boundary throws a ProviderError, got ${error?.constructor?.name}`);
  return error as ProviderError;
}

test('the classification table: status decides, text matches only fill the gaps', () => {
  const cases: Array<[unknown, string]> = [
    [{ status: 401, message: 'boom' }, 'auth'],
    [{ status: 403, message: 'boom' }, 'auth'],
    [{ status: 429, message: 'boom' }, 'rate_limit'],
    [{ status: 400, message: 'boom' }, 'bad_request'],
    [{ status: 404, message: 'boom' }, 'bad_request'],
    [{ status: 422, message: 'boom' }, 'bad_request'],
    [{ status: 500, message: 'boom' }, 'transient'],
    [{ status: 503, message: 'boom' }, 'transient'],
    [{ status: 408, message: 'boom' }, 'transient'],
    [{ message: 'connection reset by peer' }, 'transient'],
    [{ message: 'Failed to fetch' }, 'transient'],
    [{ message: 'upstream overloaded error' }, 'transient'],
    [{ message: 'Rate limit exceeded 429' }, 'rate_limit'],
    [{ message: 'This model\'s maximum context length is 8192 tokens' }, 'context'],
    [{ message: 'something entirely unexpected' }, 'unknown']
  ];
  for (const [error, kind] of cases) {
    assert.equal(classifyProviderFailure(error).kind, kind, `kind of ${(error as { message?: string }).message}`);
  }
});

test('openrouter: a 401 comes out as an auth ProviderError with today\'s text', async (t) => {
  const error = await statusOfCall(t, SETTINGS.openrouter, () => jsonResponse({ error: { message: 'No auth credentials found' } }, 401));
  assert.equal(error.status, 401);
  assert.equal(error.kind, 'auth');
  assert.match(error.message, /^OpenRouter API connection error: OpenRouter API Authentication Error \(401\)/);
});

test('openai: a 503 comes out as a transient ProviderError, and the retry-after header survives', async (t) => {
  const error = await statusOfCall(t, SETTINGS.openai, () => new Response('upstream gone', {
    status: 503,
    headers: { 'content-type': 'text/plain', 'retry-after': '2' }
  }));
  assert.equal(error.status, 503);
  assert.equal(error.kind, 'transient');
  assert.equal(error.retryAfterMs, 2000, 'retry-after: 2 seconds becomes 2000 ms');
  assert.match(error.message, /API connection error/);
});

test('anthropic: a 400 comes out as a bad_request ProviderError', async (t) => {
  const error = await statusOfCall(t, SETTINGS.anthropic, () => jsonResponse({ type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens is required' } }, 400));
  assert.equal(error.status, 400);
  assert.equal(error.kind, 'bad_request');
  assert.match(error.message, /Anthropic API Error: Anthropic API error \(400\)/);
});

test('gemini: a 429 comes out as a rate_limit ProviderError', async (t) => {
  const error = await statusOfCall(t, SETTINGS.gemini, () => jsonResponse({ error: { code: 429, message: 'Resource has been exhausted' } }, 429));
  assert.equal(error.kind, 'rate_limit');
  if (error.status !== undefined) assert.equal(error.status, 429);
});

test('nvidia: a 401 comes out as an auth ProviderError with the key hint', async (t) => {
  const error = await statusOfCall(t, SETTINGS.nvidia, () => jsonResponse({ error: 'bad key' }, 401));
  assert.equal(error.status, 401);
  assert.equal(error.kind, 'auth');
  assert.match(error.message, /NVIDIA API Authentication Error \(401\)/);
});

test('a network failure (nobody answered) comes out as a transient ProviderError with no status', async (t) => {
  spyFetch(t, () => { throw new TypeError('Failed to fetch'); });
  const error = await failureOf(generateCompletion(SETTINGS.openai, MESSAGES, 'system'));
  assert.ok(error instanceof ProviderError);
  assert.equal((error as ProviderError).status, undefined);
  assert.equal((error as ProviderError).kind, 'transient');
});

test('a custom endpoint: a 503 comes out as a transient ProviderError', async (t) => {
  const error = await statusOfCall(t, CUSTOM_SETTINGS, () => jsonResponse({ detail: 'gateway overloaded' }, 503));
  assert.equal(error.status, 503);
  assert.equal(error.kind, 'transient');
  assert.match(error.message, /Acme Gateway connection error/);
});

test('ollama: a 500 comes out as a transient ProviderError, and its retry-after header survives', async (t) => {
  spyFetch(t, () => new Response('runner died', { status: 500, headers: { 'retry-after': '3' } }));
  const error = await failureOf(callOllama(SETTINGS.ollama, MESSAGES, 'SYS'));
  assert.ok(error instanceof ProviderError, `ollama throws a ProviderError, got ${error?.constructor?.name}`);
  const providerError = error as ProviderError;
  assert.equal(providerError.status, 500);
  assert.equal(providerError.kind, 'transient');
  assert.equal(providerError.retryAfterMs, 3000);
  assert.match(providerError.message, /Ollama API error \(500\)/);
});

test('agent_router: a 401 on the first endpoint ends the call as an auth ProviderError', async (t) => {
  spyFetch(t, (request) => {
    const path = new URL(request.url).pathname;
    if (path.endsWith('/messages')) return jsonResponse({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401);
    return textReply(request.url);
  });
  const error = await failureOf(callAgentRouter(SETTINGS.agent_router, MESSAGES, 'SYS'));
  assert.ok(error instanceof ProviderError, `agent_router throws a ProviderError, got ${error?.constructor?.name}`);
  const providerError = error as ProviderError;
  assert.equal(providerError.status, 401);
  assert.equal(providerError.kind, 'auth');
  assert.match(providerError.message, /^AgentRouter API connection error: AgentRouter Authentication Error \(401\)/);
});
