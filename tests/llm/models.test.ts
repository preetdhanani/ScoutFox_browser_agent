/**
 * The model lists of the settings screen (llm/models.ts), moved from apiClients.js unchanged.
 *
 * What is pinned: the lists come from the provider's own endpoint, they are cached for an hour in `models_cache`
 * under `<provider>_<baseUrl>_<last 6 chars of the key>`, a refresh skips the cache, and the function NEVER throws:
 * any failure gives the provider's fallback list.
 */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAvailableModels, getFallbackModels } from '../../src/background/llm/models.ts';
import { jsonResponse, spyFetch } from '../helpers/llmWire.ts';

interface CacheEntry { timestamp: number; models: string[] }
let store: { models_cache?: Record<string, CacheEntry> };

// Storage reads chrome.storage.local with callbacks, and only this key matters here.
(globalThis as Record<string, unknown>).chrome = {
  storage: {
    local: {
      get: (_keys: string[], callback: (result: typeof store) => void) => callback(structuredClone(store)),
      set: (items: typeof store, callback?: () => void) => { Object.assign(store, structuredClone(items)); callback?.(); }
    }
  }
};
beforeEach(() => { store = {}; });

const HOUR = 3600000;

test('a list from the provider is sorted, cached under provider_baseUrl_last6key, and served from the cache after that', async (t) => {
  const sent = spyFetch(t, () => jsonResponse({ data: [{ id: 'z-model' }, { id: 'a-model' }] }));
  const settings = { provider: 'openrouter', apiKey: 'sk-or-abcdefghij123456' };

  assert.deepEqual(await fetchAvailableModels(settings), ['a-model', 'z-model']);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://openrouter.ai/api/v1/models');
  assert.equal(sent[0].headers.authorization, 'Bearer sk-or-abcdefghij123456');
  assert.deepEqual(Object.keys(store.models_cache ?? {}), ['openrouter_default_123456']);

  assert.deepEqual(await fetchAvailableModels(settings), ['a-model', 'z-model']);
  assert.equal(sent.length, 1, 'the second call came from the cache');

  await fetchAvailableModels(settings, true);
  assert.equal(sent.length, 2, 'forceRefresh skips the cache');
});

test('the cache key holds the base URL, and "none" when there is no key', async (t) => {
  spyFetch(t, () => jsonResponse({ data: [{ id: 'm' }] }));
  await fetchAvailableModels({ provider: 'openai_compatible', baseUrl: 'http://localhost:1234/v1' });
  assert.deepEqual(Object.keys(store.models_cache ?? {}), ['openai_compatible_http://localhost:1234/v1_none']);
});

test('an entry older than an hour is not used', async (t) => {
  const sent = spyFetch(t, () => jsonResponse({ data: [{ id: 'fresh' }] }));
  const settings = { provider: 'openrouter', apiKey: 'abcdef' };
  store.models_cache = { openrouter_default_abcdef: { timestamp: Date.now() - HOUR - 1000, models: ['stale'] } };
  assert.deepEqual(await fetchAvailableModels(settings), ['fresh']);
  assert.equal(sent.length, 1);

  store.models_cache = { openrouter_default_abcdef: { timestamp: Date.now() - HOUR + 60000, models: ['cached'] } };
  assert.deepEqual(await fetchAvailableModels(settings), ['cached'], 'a fresh entry is used');
  assert.equal(sent.length, 1);
});

test('it never throws: an HTTP error, a network error and an empty list all give the fallback list', async (t) => {
  for (const provider of ['openrouter', 'openai', 'openai_compatible', 'ollama', 'nvidia']) {
    spyFetch(t, () => new Response('nope', { status: 500 }));
    assert.deepEqual(await fetchAvailableModels({ provider, apiKey: 'k' }, true), getFallbackModels(provider), `${provider}: HTTP 500`);

    spyFetch(t, () => { throw new TypeError('Failed to fetch'); });
    assert.deepEqual(await fetchAvailableModels({ provider, apiKey: 'k' }, true), getFallbackModels(provider), `${provider}: network error`);

    spyFetch(t, () => jsonResponse(provider === 'ollama' ? { models: [] } : { data: [] }));
    assert.deepEqual(await fetchAvailableModels({ provider, apiKey: 'k' }, true), getFallbackModels(provider), `${provider}: empty list`);
  }
  assert.deepEqual(store.models_cache?.['openrouter_default_k']?.models, getFallbackModels('openrouter'), 'an empty list is replaced by the fallback list, and that list is cached');
});

test('a failure is not cached', async (t) => {
  spyFetch(t, () => new Response('nope', { status: 500 }));
  await fetchAvailableModels({ provider: 'openai', apiKey: 'abcdef' }, true);
  await fetchAvailableModels({ provider: 'nvidia', apiKey: 'abcdef' }, true);
  assert.equal(store.models_cache, undefined);
});

test('ollama lists the installed models of its own server', async (t) => {
  const sent = spyFetch(t, () => jsonResponse({ models: [{ name: 'qwen3.5:9b' }, { name: 'gemma4:12b' }] }));
  assert.deepEqual(await fetchAvailableModels({ provider: 'ollama', baseUrl: 'http://localhost:11434/' }, true), ['qwen3.5:9b', 'gemma4:12b']);
  assert.equal(sent[0].url, 'http://localhost:11434/api/tags');
});

test('openai and compatible servers list <base>/v1/models', async (t) => {
  const sent = spyFetch(t, () => jsonResponse({ data: [{ id: 'b' }, { id: 'a' }] }));
  assert.deepEqual(await fetchAvailableModels({ provider: 'openai', apiKey: 'k' }, true), ['a', 'b']);
  assert.equal(sent[0].url, 'https://api.openai.com/v1/models');
  await fetchAvailableModels({ provider: 'openai_compatible', baseUrl: 'https://api.groq.com/openai/v1/', apiKey: 'k' }, true);
  assert.equal(sent[1].url, 'https://api.groq.com/openai/v1/models');
  await fetchAvailableModels({ provider: 'openai_compatible', baseUrl: 'http://localhost:1234' }, true);
  assert.equal(sent[2].url, 'http://localhost:1234/v1/models');
  assert.equal(sent[2].headers.authorization, undefined, 'no key, no Authorization header');
});

test('agent_router lists <base>/v1/models with its own headers, and falls back on any failure', async (t) => {
  const sent = spyFetch(t, () => jsonResponse({ data: [{ id: 'claude-x' }, 'plain-name'] }));
  assert.deepEqual(await fetchAvailableModels({ provider: 'agent_router', apiKey: 'k' }, true), ['claude-x', 'plain-name'].sort());
  assert.equal(sent[0].url, 'https://agentrouter.org/v1/models');
  assert.equal(sent[0].headers['x-app'], 'cli');
  assert.equal(sent[0].headers.authorization, 'Bearer k');

  spyFetch(t, () => new Response('nope', { status: 403 }));
  assert.deepEqual(await fetchAvailableModels({ provider: 'agent_router', apiKey: 'k' }, true), getFallbackModels('agent_router'));
});

test('gemini lists the models that can generateContent, without the models/ prefix, and needs a key for a live list', async (t) => {
  const sent = spyFetch(t, () => jsonResponse({
    models: [
      { name: 'models/gemini-2.0-flash', supportedGenerationMethods: ['generateContent', 'countTokens'] },
      { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
      { name: 'models/gemini-1.5-pro', supportedGenerationMethods: ['generateContent'] }
    ]
  }));
  assert.deepEqual(await fetchAvailableModels({ provider: 'gemini', apiKey: 'AIza-test' }, true), ['gemini-1.5-pro', 'gemini-2.0-flash']);
  assert.equal(sent[0].url, 'https://generativelanguage.googleapis.com/v1beta/models', 'the key is not in the URL, which ends up in DevTools and in logs');
  assert.equal(sent[0].headers['x-goog-api-key'], 'AIza-test', 'it is in the same header as the chat calls');

  sent.length = 0;
  assert.deepEqual(await fetchAvailableModels({ provider: 'gemini' }, true), getFallbackModels('gemini'), 'no key: the fallback list, no request');
  assert.equal(sent.length, 0);

  spyFetch(t, () => new Response('nope', { status: 400 }));
  assert.deepEqual(await fetchAvailableModels({ provider: 'gemini', apiKey: 'bad' }, true), getFallbackModels('gemini'));
});

test('anthropic has no list endpoint here: its fallback list is the list', async (t) => {
  const sent = spyFetch(t);
  assert.deepEqual(await fetchAvailableModels({ provider: 'anthropic', apiKey: 'k' }, true), ['claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022']);
  assert.equal(sent.length, 0);
});

test('nvidia lists models with Bearer auth when key is set, and fetches public catalog without auth when key is missing', async (t) => {
  const sent = spyFetch(t, () => jsonResponse({ data: [{ id: 'meta/llama-3.3-70b-instruct' }, { id: 'deepseek-ai/deepseek-r1' }] }));
  const settings = { provider: 'nvidia', apiKey: 'nvapi-test123456' };

  assert.deepEqual(await fetchAvailableModels(settings, true), ['deepseek-ai/deepseek-r1', 'meta/llama-3.3-70b-instruct']);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://integrate.api.nvidia.com/v1/models');
  assert.equal(sent[0].headers.authorization, 'Bearer nvapi-test123456');
  assert.deepEqual(Object.keys(store.models_cache ?? {}), ['nvidia_default_123456']);

  // Explicit baseUrl is captured in cache key
  const settingsWithBase = { provider: 'nvidia', apiKey: 'nvapi-test123456', baseUrl: 'https://integrate.api.nvidia.com/v1' };
  assert.deepEqual(await fetchAvailableModels(settingsWithBase, true), ['deepseek-ai/deepseek-r1', 'meta/llama-3.3-70b-instruct']);
  assert.ok(store.models_cache?.['nvidia_https://integrate.api.nvidia.com/v1_123456']);

  // Missing API key: still queries public models endpoint without Authorization header
  sent.length = 0;
  const noKey = await fetchAvailableModels({ provider: 'nvidia' }, true);
  assert.deepEqual(noKey, ['deepseek-ai/deepseek-r1', 'meta/llama-3.3-70b-instruct']);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].headers.authorization, undefined, 'no Authorization header when key is missing');

  // Error case: returns fallbacks
  spyFetch(t, () => new Response('error', { status: 500 }));
  assert.deepEqual(await fetchAvailableModels({ provider: 'nvidia', apiKey: 'nvapi-test' }, true), getFallbackModels('nvidia'));
});

test('nvidia normalizes build.nvidia.com and trailing endpoints', async (t) => {
  const sent = spyFetch(t, () => jsonResponse({ data: [{ id: 'nvidia/llama-3.1-nemotron-70b-instruct' }] }));
  await fetchAvailableModels({ provider: 'nvidia', baseUrl: 'https://build.nvidia.com' }, true);
  assert.equal(sent[0].url, 'https://integrate.api.nvidia.com/v1/models');

  await fetchAvailableModels({ provider: 'nvidia', baseUrl: 'https://build.nvidia.com/v1' }, true);
  assert.equal(sent[1].url, 'https://integrate.api.nvidia.com/v1/models');

  await fetchAvailableModels({ provider: 'nvidia', baseUrl: 'https://integrate.api.nvidia.com/v1/chat/completions' }, true);
  assert.equal(sent[2].url, 'https://integrate.api.nvidia.com/v1/models');
});

test('nvidia fallback list contains curated models', () => {
  const models = getFallbackModels('nvidia');
  assert.ok(models.includes('meta/llama-3.3-70b-instruct'));
  assert.ok(models.includes('deepseek-ai/deepseek-r1'));
  assert.ok(models.includes('nvidia/llama-3.1-nemotron-70b-instruct'));
  assert.ok(models.includes('meta/llama-3.1-405b-instruct'));
  assert.ok(models.includes('mistralai/mixtral-8x22b-instruct'));
  assert.ok(models.includes('qwen/qwen2.5-72b-instruct'));
  assert.ok(models.includes('nvidia/nemotron-4-340b-instruct'));
  assert.equal(models.length, 7);
});

test('nvidia filters non-chat models (embedding, reranker, guard, safety, clip)', async (t) => {
  const mixedData = [
    { id: 'meta/llama-3.3-70b-instruct' },
    { id: 'nvidia/nv-embedqa-e5-v5' },
    { id: 'nvidia/reranking-mistral-4b' },
    { id: 'meta/llama-guard-3-8b' },
    { id: 'meta/llama-3.2-11b-vision-instruct' },
    { id: 'nvidia/clip-benchmark' },
    { id: 'meta/llama-safety-eval' }
  ];
  spyFetch(t, () => jsonResponse({ data: mixedData }));
  const models = await fetchAvailableModels({ provider: 'nvidia', apiKey: 'nvapi-test' }, true);
  assert.deepEqual(models, ['meta/llama-3.2-11b-vision-instruct', 'meta/llama-3.3-70b-instruct']);

  // If filtering leaves nothing, fallback list is returned
  spyFetch(t, () => jsonResponse({ data: [{ id: 'nvidia/embed-only' }] }));
  const fallbacks = await fetchAvailableModels({ provider: 'nvidia', apiKey: 'nvapi-test' }, true);
  assert.deepEqual(fallbacks, getFallbackModels('nvidia'));
});

test('an unknown provider gets an empty list, and the default list when it fails', async () => {
  assert.deepEqual(await fetchAvailableModels({ provider: 'nope' }, true), []);
  assert.deepEqual(getFallbackModels('nope'), ['gemini-2.0-flash', 'gemini-1.5-flash', 'qwen2.5:14b', 'gpt-4o-mini']);
});
