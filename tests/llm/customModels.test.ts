/**
 * The model list of a user-added endpoint, through fetchAvailableModels with the descriptor in the
 * snapshot (featere/custom-endpoint). The descriptor decides the dialect, the URL, the headers and
 * the saved list that stands in when the endpoint cannot be asked; the response of the panel is
 * never another provider's curated ids.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchAvailableModels } from '../../src/background/llm/models.ts';
import type { LlmSettings } from '../../src/background/llm/types.ts';
import { jsonResponse, spyFetch } from '../helpers/llmWire.ts';

// The model cache lives in chrome.storage; without a stub the cache is a no-op and every call
// would hit the network again.
const mockStorageData: Record<string, unknown> = {};
globalThis.chrome = {
  storage: {
    local: {
      get: (keys: string[], cb: (items: Record<string, unknown>) => void) => {
        const result: Record<string, unknown> = {};
        keys.forEach(k => { result[k] = mockStorageData[k]; });
        cb(result);
      },
      set: (items: Record<string, unknown>, cb?: () => void) => {
        Object.assign(mockStorageData, items);
        if (cb) cb();
      }
    }
  }
} as unknown as typeof chrome;

const DESCRIPTOR = {
  id: 'acme-gateway',
  displayName: 'Acme Gateway',
  protocol: 'openai' as const,
  baseUrl: 'https://gateway.example/v1',
  models: ['hand-added-model'],
  keyMode: 'apiKey' as const,
  createdAt: 1,
  updatedAt: 1
};

const openaiSettings = (over: Partial<LlmSettings> = {}): LlmSettings => ({
  provider: 'acme-gateway',
  baseUrl: 'https://gateway.example/v1',
  model: 'hand-added-model',
  apiKey: 'sk-list-1',
  customProviders: { 'acme-gateway': { ...DESCRIPTOR } },
  ...over
} as LlmSettings);

test('an openai-style gateway: GET {base}/models with the key, chat ids only, sorted and unique', async (t) => {
  const sent = spyFetch(t, () => jsonResponse({ data: [{ id: 'b-model' }, { id: 'a-model' }, { id: 'a-model' }, { id: 'x-embed-v1' }, { id: 'guard-eval' }] }));
  const models = await fetchAvailableModels(openaiSettings(), true);
  assert.deepEqual(models, ['a-model', 'b-model'], 'sorted, unique, and without the embedders and guards');
  assert.equal(sent[0].method, 'GET');
  assert.equal(sent[0].url, 'https://gateway.example/v1/models');
  assert.equal(sent[0].headers.authorization, 'Bearer sk-list-1');
});

test('an anthropic-style relay: GET {base}/v1/models with the Anthropic headers, and no Authorization header', async (t) => {
  const anthropic = { ...DESCRIPTOR, id: 'claude-relay', protocol: 'anthropic' as const, baseUrl: 'https://relay.example' };
  const sent = spyFetch(t, () => jsonResponse({ data: [{ id: 'relay-model' }] }));
  const models = await fetchAvailableModels({ provider: 'claude-relay', model: 'relay-model', customProviders: { 'claude-relay': anthropic } } as LlmSettings, true);
  assert.deepEqual(models, ['relay-model']);
  assert.equal(sent[0].method, 'GET', 'the Anthropic model list is a GET, like the real Anthropic API');
  assert.equal(sent[0].url, 'https://relay.example/v1/models');
  assert.equal(sent[0].headers['x-api-key'], undefined, 'the descriptor saved no key');
  assert.ok(sent[0].headers['anthropic-version']);
  assert.equal(sent[0].headers.authorization, undefined);
});

test('a keyless endpoint sends no credential header at all, on either dialect', async (t) => {
  const sent = spyFetch(t, () => jsonResponse({ data: [{ id: 'local-model' }] }));
  await fetchAvailableModels(openaiSettings({ apiKey: '' }), true);
  assert.equal(sent[0].headers.authorization, undefined);
});

test('a 404 or 405 escapes as its own answer: the caller can say "no model list", not "unreachable"', async (t) => {
  // The error carries the status, so the FETCH_MODELS route can answer the panel with it and the
  // saved list as fallback (pinned in customProviderRoutes.test.ts).
  spyFetch(t, () => jsonResponse({ error: 'not found' }, 404));
  const err404 = await fetchAvailableModels(openaiSettings(), true).then(() => null, (e: Error & { status?: number }) => e);
  assert.ok(err404, 'a 404 is an answer, not a silent fallback');
  assert.match(err404!.message, /no model list/);
  assert.equal((err404 as { status?: number }).status, 404);
  assert.match(err404!.message, /Add the model ids by hand/);

  spyFetch(t, () => jsonResponse({}, 405));
  const err405 = await fetchAvailableModels(openaiSettings(), true).then(() => null, (e: Error & { status?: number }) => e);
  assert.ok(err405);
  assert.equal((err405 as { status?: number }).status, 405);
});

test('a failure falls back to the saved list, which may be empty - never to another provider\u2019s ids', async (t) => {
  const empty = { ...DESCRIPTOR, models: [] };
  spyFetch(t, () => { throw new Error('ECONNREFUSED'); });
  const models = await fetchAvailableModels({ provider: 'acme-gateway', model: 'm', customProviders: { 'acme-gateway': empty } } as LlmSettings, true);
  assert.deepEqual(models, [], 'an empty saved list stays empty; nothing is invented');

  const rich = { ...DESCRIPTOR, models: ['saved-1', 'saved-2'] };
  spyFetch(t, () => jsonResponse({ error: { message: 'bad key' } }, 401));
  const models401 = await fetchAvailableModels({ provider: 'acme-gateway', model: 'm', customProviders: { 'acme-gateway': rich } } as LlmSettings, true);
  assert.deepEqual(models401, ['saved-1', 'saved-2'], 'a rejected key still leaves the user their saved list');
});

test('a non-JSON answer has its own message, pointing at the URL, not at the key', async (t) => {
  spyFetch(t, () => new Response('<html>gateway error</html>', { status: 200, headers: { 'content-type': 'text/html' } }));
  const models = await fetchAvailableModels(openaiSettings(), true);
  assert.deepEqual(models, ['hand-added-model'], 'the saved list stands in');
});

test('an endpoint that answers 200 with no chat ids falls back to the saved list, without an error', async (t) => {
  spyFetch(t, () => jsonResponse({ data: [{ id: 'only-embeddings' }] }));
  const models = await fetchAvailableModels(openaiSettings(), true);
  assert.deepEqual(models, ['hand-added-model']);
});

test('the saved list is cached like every provider\u2019s list, and served instantly on the next open', async (t) => {
  // forceRefresh false with an empty cache fetches once; the next call with forceRefresh false
  // reads the cache (no second request), so switching providers does not re-ask the endpoint.
  let calls = 0;
  const sent = spyFetch(t, () => { calls++; return jsonResponse({ data: [{ id: 'm1' }, { id: 'm2' }] }); });
  const first = await fetchAvailableModels({ provider: 'acme-gateway', model: 'm1', apiKey: 'sk-c', customProviders: { 'acme-gateway': DESCRIPTOR } } as LlmSettings, false);
  assert.deepEqual(first, ['m1', 'm2']);
  const second = await fetchAvailableModels({ provider: 'acme-gateway', model: 'm1', apiKey: 'sk-c', customProviders: { 'acme-gateway': DESCRIPTOR } } as LlmSettings, false);
  assert.deepEqual(second, ['m1', 'm2']);
  assert.equal(calls, 1, 'the second call is served from the cache');
  assert.equal(sent.length, 1);
});

test('the model list refuses a redirect that leaves the endpoint origin, like the chat call does (C2.3)', async (t) => {
  for (const key of Object.keys(mockStorageData)) delete mockStorageData[key];
  let hops = 0;
  const sent = spyFetch(t, () => {
    hops++;
    return new Response(null, { status: 302, headers: { location: 'https://evil.example/v1/models' } });
  });
  // The refusal lands in fetchAvailableModels' catch: the endpoint could not be asked honestly,
  // so the saved list stands in (the route logs why). What must never happen is the follow.
  const models = await fetchAvailableModels({ provider: 'acme-gateway', model: 'm1', apiKey: 'sk-c', customProviders: { 'acme-gateway': DESCRIPTOR } } as LlmSettings, false);
  assert.deepEqual(models, ['hand-added-model'], 'the saved list stands in');
  assert.equal(hops, 1, 'the redirect was not followed');
  assert.equal(sent.length, 1);
});

test('the model list follows a redirect that stays on the endpoint origin, and reports what was filtered (D1.3)', async (t) => {
  for (const key of Object.keys(mockStorageData)) delete mockStorageData[key];
  let hops = 0;
  spyFetch(t, (request) => {
    hops++;
    if (hops === 1) return new Response(null, { status: 302, headers: { location: 'https://gateway.example/v1/models?hop=2' } });
    return jsonResponse({ data: [{ id: 'm1' }, { id: 'text-embedder' }, { id: 'm2' }] });
  });
  const meta: { filteredCount?: number } = {};
  const models = await fetchAvailableModels({ provider: 'acme-gateway', model: 'm1', apiKey: 'sk-c', customProviders: { 'acme-gateway': DESCRIPTOR } } as LlmSettings, false, meta);
  assert.equal(hops, 2, 'the same-origin hop was followed');
  assert.deepEqual(models, ['m1', 'm2'], 'the non-chat id is hidden from the list');
  assert.equal(meta.filteredCount, 1, 'the count of hidden ids rides along for the panel');
});
