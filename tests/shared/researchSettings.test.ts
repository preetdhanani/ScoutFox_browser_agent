import test from 'node:test';
import assert from 'node:assert/strict';

// The storage module reads chrome.storage.local; a plain object stands in for it.
const stored: Record<string, unknown> = {};
globalThis.chrome = {
  storage: {
    local: {
      get: (keys: string[], cb: (items: Record<string, unknown>) => void) => {
        const out: Record<string, unknown> = {};
        keys.forEach((k) => { out[k] = stored[k]; });
        cb(JSON.parse(JSON.stringify(out)));
      },
      set: (items: Record<string, unknown>, cb?: () => void) => {
        Object.assign(stored, JSON.parse(JSON.stringify(items)));
        cb?.();
      }
    }
  }
} as unknown as typeof chrome;

const { Storage, DEFAULT_RESEARCH, DEFAULT_SETTINGS, normalizeResearch } = await import('../../src/shared/storage.ts');

test('research defaults: on, the keyless DuckDuckGo backend, no SearXNG URL', () => {
  assert.deepEqual(DEFAULT_RESEARCH, { enabled: true, backend: 'duckduckgo', searxngUrl: '' });
  assert.deepEqual(DEFAULT_SETTINGS.research, DEFAULT_RESEARCH);
});

test('migration: settings stored by an older build (no research) read with the research defaults', async () => {
  stored.agent_settings = { provider: 'ollama', maxSteps: 120 };
  const s = await Storage.getSettings();
  assert.deepEqual(s.research, DEFAULT_RESEARCH);
  assert.equal(s.maxSteps, 120);
});

test('getSettings deep-merges research: a partial or damaged stored object keeps its valid fields', async () => {
  stored.agent_settings = { provider: 'ollama', research: { backend: 'searxng' } };
  assert.deepEqual((await Storage.getSettings()).research, { enabled: true, backend: 'searxng', searxngUrl: '' });
  stored.agent_settings = { provider: 'ollama', research: { enabled: false, backend: 'bing', searxngUrl: 42 } };
  assert.deepEqual((await Storage.getSettings()).research, { enabled: false, backend: 'duckduckgo', searxngUrl: '' });
  stored.agent_settings = { provider: 'ollama', research: 'on' };
  assert.deepEqual((await Storage.getSettings()).research, DEFAULT_RESEARCH);
});

test('saveSettings with part of research changes only those fields', async () => {
  stored.agent_settings = { provider: 'ollama', research: { enabled: true, backend: 'searxng', searxngUrl: 'https://searx.example' } };
  const saved = await Storage.saveSettings({ research: { enabled: false } as any });
  assert.deepEqual(saved.research, { enabled: false, backend: 'searxng', searxngUrl: 'https://searx.example' });
  assert.deepEqual((stored.agent_settings as any).research, saved.research);
  // Another setting saved later keeps research as it is.
  const again = await Storage.saveSettings({ maxSteps: 90 });
  assert.deepEqual(again.research, saved.research);
});

test('normalizeResearch trims the SearXNG URL', () => {
  assert.equal(normalizeResearch({ searxngUrl: '  https://s.example/  ' }).searxngUrl, 'https://s.example/');
});
