import test from 'node:test';
import assert from 'node:assert/strict';

// Mock global chrome object before loading storage module
const mockStorageData: Record<string, unknown> = {};
// Only storage.local get and set exist here, so the mock is not a full chrome namespace.
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

const { Storage, DEFAULT_SETTINGS, DEFAULT_PROVIDER_CONFIGS } = await import('../../src/shared/storage.ts');

test('Storage - DEFAULT_SETTINGS sanity check', () => {
  assert.equal(DEFAULT_SETTINGS.provider, 'openrouter');
  assert.equal(DEFAULT_SETTINGS.maxSteps, 250);
  assert.equal(DEFAULT_SETTINGS.effortDefault, 'medium');
  assert.ok(DEFAULT_SETTINGS.providerConfigs);
  assert.equal(DEFAULT_PROVIDER_CONFIGS.nvidia.baseUrl, 'https://integrate.api.nvidia.com/v1');
  assert.equal(DEFAULT_PROVIDER_CONFIGS.nvidia.model, 'meta/llama-3.3-70b-instruct');
  assert.equal(DEFAULT_PROVIDER_CONFIGS.nvidia.llmTimeoutMs, 300000);
});

test('Storage - getSettings & saveSettings roundtrip', async () => {
  const initial = await Storage.getSettings();
  assert.equal(initial.maxSteps, 250);
  assert.equal(initial.effortDefault, 'medium');

  await Storage.saveSettings({ maxSteps: 300, effortDefault: 'high' });
  const updated = await Storage.getSettings();
  assert.equal(updated.maxSteps, 300);
  assert.equal(updated.effortDefault, 'high');
});

test('Storage - one-time migration from maxSteps 25 to 250', async () => {
  // Simulate legacy stored settings with maxSteps: 25
  mockStorageData['agent_settings'] = { maxSteps: 25, provider: 'openrouter' };
  const settings = await Storage.getSettings();
  assert.equal(settings.maxSteps, 250);
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

  // Switch to NVIDIA and set NVIDIA Key
  await Storage.saveSettings({
    provider: 'nvidia',
    apiKey: 'nvapi-nvidia-test-key-54321',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    model: 'meta/llama-3.3-70b-instruct'
  });

  const settings = await Storage.getSettings();
  assert.equal(settings.providerConfigs.openrouter.apiKey, 'sk-or-v1-openrouter-test-key-12345');
  assert.equal(settings.providerConfigs.gemini.apiKey, 'AIzaSyGeminiTestKey67890');
  assert.equal(settings.providerConfigs.nvidia.apiKey, 'nvapi-nvidia-test-key-54321');
  assert.equal(settings.providerConfigs.openrouter.model, 'anthropic/claude-3.5-sonnet');
  assert.equal(settings.providerConfigs.gemini.model, 'gemini-1.5-flash');
  assert.equal(settings.providerConfigs.nvidia.model, 'meta/llama-3.3-70b-instruct');
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

test('Storage - one-time migration for nvidia default timeout', async () => {
  mockStorageData['agent_settings'] = {
    provider: 'nvidia',
    providerConfigs: {
      nvidia: { baseUrl: 'https://integrate.api.nvidia.com/v1', apiKey: '', model: 'meta/llama-3.3-70b-instruct' }
    }
  };
  const settings = await Storage.getSettings();
  assert.equal(settings.providerConfigs.nvidia.llmTimeoutMs, 300000);
});

test('Storage - saveSettings does not leak per-provider llmTimeoutMs to non-nvidia providers (BUG-06)', async () => {
  // Saving global llmTimeoutMs under openai should NOT write llmTimeoutMs into openai providerConfig
  await Storage.saveSettings({ provider: 'openai', llmTimeoutMs: 65000 });
  const settings = await Storage.getSettings();
  assert.equal(settings.llmTimeoutMs, 65000);
  assert.equal(settings.providerConfigs.openai.llmTimeoutMs, undefined);

  // Saving for nvidia updates nvidia providerConfig, but does NOT pollute top-level global llmTimeoutMs
  await Storage.saveSettings({ provider: 'nvidia', llmTimeoutMs: 250000 });
  const nvidiaSettings = await Storage.getSettings();
  assert.equal(nvidiaSettings.providerConfigs.nvidia.llmTimeoutMs, 250000);
  assert.equal(nvidiaSettings.llmTimeoutMs, 65000, 'saving nvidia provider timeout must not overwrite global timeout');

  // Switching back to openai preserves the 65000 global timeout
  await Storage.saveSettings({ provider: 'openai' });
  const restoredSettings = await Storage.getSettings();
  assert.equal(restoredSettings.llmTimeoutMs, 65000, 'global timeout is preserved when switching back');
});
