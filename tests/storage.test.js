import test from 'node:test';
import assert from 'node:assert/strict';

// Mock global chrome object before loading storage module
const mockStorageData = {};
global.chrome = {
  storage: {
    local: {
      get: (keys, cb) => {
        const result = {};
        keys.forEach(k => { result[k] = mockStorageData[k]; });
        cb(result);
      },
      set: (items, cb) => {
        Object.assign(mockStorageData, items);
        if (cb) cb();
      }
    }
  }
};

const { Storage, DEFAULT_SETTINGS, DEFAULT_PROVIDER_CONFIGS } = await import('../utils/storage.js');

test('Storage - DEFAULT_SETTINGS sanity check', () => {
  assert.equal(DEFAULT_SETTINGS.provider, 'openrouter');
  assert.equal(DEFAULT_SETTINGS.maxSteps, 25);
  assert.ok(DEFAULT_SETTINGS.providerConfigs);
});

test('Storage - getSettings & saveSettings roundtrip', async () => {
  const initial = await Storage.getSettings();
  assert.equal(initial.maxSteps, 25);

  await Storage.saveSettings({ maxSteps: 30 });
  const updated = await Storage.getSettings();
  assert.equal(updated.maxSteps, 30);
});

test('Storage - Per-Provider API Key Isolation', async () => {
  // Configure OpenRouter Key
  await Storage.saveSettings({
    provider: 'openrouter',
    apiKey: 'sk-or-v1-openrouter-test-key-12345',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'anthropic/claude-3.5-sonnet'
  });

  // Switch to Gemini and set Gemini Key
  await Storage.saveSettings({
    provider: 'gemini',
    apiKey: 'AIzaSyGeminiTestKey67890',
    baseUrl: '',
    model: 'gemini-1.5-flash'
  });

  const settings = await Storage.getSettings();
  assert.equal(settings.providerConfigs.openrouter.apiKey, 'sk-or-v1-openrouter-test-key-12345');
  assert.equal(settings.providerConfigs.gemini.apiKey, 'AIzaSyGeminiTestKey67890');
  assert.equal(settings.providerConfigs.openrouter.model, 'anthropic/claude-3.5-sonnet');
  assert.equal(settings.providerConfigs.gemini.model, 'gemini-1.5-flash');
});

test('Storage - Model Caching per provider cacheKey', async () => {
  const cacheKey = 'openrouter_https://openrouter.ai/api/v1_key123';
  const modelsList = ['anthropic/claude-3.5-sonnet', 'deepseek/deepseek-r1', 'meta-llama/llama-3.3-70b-instruct'];

  await Storage.saveCachedModels(cacheKey, modelsList);
  const retrieved = await Storage.getCachedModels(cacheKey);

  assert.deepEqual(retrieved, modelsList);
});

test('Storage - Multi-Session History Management', async () => {
  const session1 = { id: 's1', task: 'Task 1', timestamp: '10:00 AM', history: [{ type: 'user_goal', prompt: 'Task 1' }] };
  const session2 = { id: 's2', task: 'Task 2', timestamp: '10:05 AM', history: [{ type: 'user_goal', prompt: 'Task 2' }] };

  await Storage.saveSession(session1);
  await Storage.saveSession(session2);

  let sessions = await Storage.getSessions();
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].id, 's2'); // Unshifted newest first

  await Storage.deleteSession('s1');
  sessions = await Storage.getSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, 's2');
});
