/**
 * The context window of a model (src/background/llm/models.ts getEffectiveContextWindow), and the
 * user's own value in Settings (src/shared/storage.ts).
 *
 * What these tests hold on to:
 *   1. The order: the user's value, then the provider (Ollama's /api/show, or the window the model
 *      list named), then Ollama's family table, then the default. Each answer says where it comes from.
 *   2. num_ctx of Settings is a fallback for Ollama only: a cloud or custom model falls back to 256K.
 *   3. The model list keeps the windows it names (context_length and the other field names) in
 *      models_ctx_cache, next to the ids, and the window is read from there, never per call.
 *   4. saveSettings merges contextWindow from the new settings, and an emptied field drops its key.
 */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONTEXT_WINDOW, clearShownWindows, fetchAvailableModels, getEffectiveContextWindow } from '../../src/background/llm/models.ts';
import { Storage, mergeContextWindow } from '../../src/shared/storage.ts';
import { jsonResponse, spyFetch } from '../helpers/llmWire.ts';

let store: Record<string, any>;
(globalThis as Record<string, unknown>).chrome = {
  storage: {
    local: {
      get: (keys: string[] | string, callback: (result: Record<string, unknown>) => void) => {
        const out: Record<string, unknown> = {};
        for (const k of Array.isArray(keys) ? keys : [keys]) if (store[k] !== undefined) out[k] = structuredClone(store[k]);
        callback(out);
      },
      set: (items: Record<string, unknown>, callback?: () => void) => { Object.assign(store, structuredClone(items)); callback?.(); }
    }
  }
};
beforeEach(() => {
  store = {};
  clearShownWindows();
});

const showReply = (ctx: number | null) => jsonResponse({ model_info: { 'general.architecture': 'qwen35', ...(ctx ? { 'qwen35.context_length': ctx } : {}) } });

test('the user\'s value comes first, and says it was set by the user', async (t) => {
  const sent = spyFetch(t, () => showReply(32768));
  const w = await getEffectiveContextWindow({ provider: 'ollama', model: 'qwen3:8b', baseUrl: 'http://o.test', contextWindow: { 'ollama|qwen3:8b': 50000 } });
  assert.deepEqual(w, { tokens: 50000, source: 'user' });
  assert.equal(sent.length, 0, 'the server is not asked when the user named the window');
  const other = await getEffectiveContextWindow({ provider: 'openrouter', model: 'a/b', contextWindow: { 'openrouter|a/b': 1_000_000 } });
  assert.deepEqual(other, { tokens: 1_000_000, source: 'user' });
});

test('Ollama: /api/show, then the family table, then num_ctx of Settings', async (t) => {
  let ctx: number | null = 40960;
  const sent = spyFetch(t, () => showReply(ctx));
  assert.deepEqual(await getEffectiveContextWindow({ provider: 'ollama', model: 'custom-a', baseUrl: 'http://o.test' }), { tokens: 40960, source: 'provider' });
  assert.deepEqual(await getEffectiveContextWindow({ provider: 'ollama', model: 'custom-a', baseUrl: 'http://o.test' }), { tokens: 40960, source: 'provider' });
  assert.equal(sent.length, 1, 'a reported window is remembered: /api/show is not asked every call');
  ctx = null;
  assert.deepEqual(await getEffectiveContextWindow({ provider: 'ollama', model: 'llama3.1:8b', baseUrl: 'http://o.test' }), { tokens: 131072, source: 'estimate' });
  assert.deepEqual(await getEffectiveContextWindow({ provider: 'ollama', model: 'mystery', baseUrl: 'http://o.test', ollamaNumCtx: 8192 }), { tokens: 8192, source: 'default' });
});

test('num_ctx is a fallback for Ollama only: a cloud or custom model falls back to 256K', async (t) => {
  spyFetch(t, () => { throw new Error('no request expected'); });
  assert.deepEqual(await getEffectiveContextWindow({ provider: 'openrouter', model: 'x/y', ollamaNumCtx: 8192 }), { tokens: DEFAULT_CONTEXT_WINDOW, source: 'default' });
  assert.deepEqual(await getEffectiveContextWindow({ provider: 'lisa', model: 'lisa-pro', ollamaNumCtx: 8192, customProviders: {} as any }), { tokens: 262144, source: 'default' });
});

test('the model list keeps the windows it names, and the window is read from there', async (t) => {
  spyFetch(t, () => jsonResponse({
    data: [
      { id: 'big', context_length: 200000 },
      { id: 'vllm', max_model_len: 32768 },
      { id: 'groq', context_window: 131072 },
      { id: 'lms', max_context_length: 8192 },
      { id: 'routed', top_provider: { context_length: 1000000 } },
      { id: 'plain' }
    ]
  }));
  await fetchAvailableModels({ provider: 'openai_compatible', baseUrl: 'http://gw.test/v1' }, true);
  assert.deepEqual(store.models_ctx_cache.openai_compatible, { big: 200000, vllm: 32768, groq: 131072, lms: 8192, routed: 1000000 });
  assert.deepEqual(store.models_cache['openai_compatible_http://gw.test/v1_none'].models, ['big', 'groq', 'lms', 'plain', 'routed', 'vllm'], 'the ids stay as they are');
  assert.deepEqual(await getEffectiveContextWindow({ provider: 'openai_compatible', model: 'vllm' }), { tokens: 32768, source: 'provider' });
  assert.deepEqual(await getEffectiveContextWindow({ provider: 'openai_compatible', model: 'plain' }), { tokens: DEFAULT_CONTEXT_WINDOW, source: 'default' });
});

test('a custom endpoint\'s model list keeps its windows too', async (t) => {
  spyFetch(t, () => jsonResponse({ data: [{ id: 'lisa-pro', context_length: 128000 }] }));
  const customProviders = { lisa: { id: 'lisa', displayName: 'LISA', protocol: 'openai', baseUrl: 'https://lisa.test/api', models: [], keyMode: 'apiKey', createdAt: 0, updatedAt: 0 } } as any;
  await fetchAvailableModels({ provider: 'lisa', customProviders }, true);
  assert.deepEqual(await getEffectiveContextWindow({ provider: 'lisa', model: 'lisa-pro', customProviders }), { tokens: 128000, source: 'provider' });
});

test('saveSettings merges contextWindow, and an emptied field drops its key', async () => {
  assert.deepEqual(mergeContextWindow({ 'a|1': 100 }, { 'b|2': 200 }), { 'a|1': 100, 'b|2': 200 });
  assert.deepEqual(mergeContextWindow({ 'a|1': 100, 'b|2': 200 }, { 'a|1': null }), { 'b|2': 200 });
  assert.deepEqual(mergeContextWindow({ 'a|1': 100 }, { 'a|1': 0 }), {});
  assert.deepEqual(mergeContextWindow({ 'a|1': 100 }, undefined), { 'a|1': 100 });

  await Storage.saveSettings({ provider: 'openrouter', contextWindow: { 'openrouter|m1': 200000 } });
  await Storage.saveSettings({ contextWindow: { 'openrouter|m2': 1000000 } });
  assert.deepEqual((await Storage.getSettings()).contextWindow, { 'openrouter|m1': 200000, 'openrouter|m2': 1000000 });
  await Storage.saveSettings({ theme: 'dark' });
  assert.deepEqual((await Storage.getSettings()).contextWindow, { 'openrouter|m1': 200000, 'openrouter|m2': 1000000 }, 'a save without the field keeps it');
  await Storage.saveSettings({ contextWindow: { 'openrouter|m1': null as unknown as number } });
  assert.deepEqual((await Storage.getSettings()).contextWindow, { 'openrouter|m2': 1000000 });
});
