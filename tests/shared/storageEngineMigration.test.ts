import test from 'node:test';
import assert from 'node:assert/strict';

// Mock global chrome object before loading storage module
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

const { Storage, DEFAULT_SETTINGS } = await import('../../src/shared/storage.ts');

test('Storage - DEFAULT_SETTINGS does not contain engine property', () => {
  assert.equal('engine' in DEFAULT_SETTINGS, false);
  assert.equal((DEFAULT_SETTINGS as any).engine, undefined);
});

test('Storage - getSettings strips stored legacy engine property', async () => {
  mockStorageData['agent_settings'] = {
    engine: 'legacy',
    provider: 'openrouter',
    maxSteps: 120
  };
  const settingsLegacy = await Storage.getSettings();
  assert.equal('engine' in settingsLegacy, false);
  assert.equal((settingsLegacy as any).engine, undefined);
  assert.equal(settingsLegacy.maxSteps, 120);

  mockStorageData['agent_settings'] = {
    engine: 'graph',
    provider: 'openrouter',
    maxSteps: 130
  };
  const settingsGraph = await Storage.getSettings();
  assert.equal('engine' in settingsGraph, false);
  assert.equal((settingsGraph as any).engine, undefined);
  assert.equal(settingsGraph.maxSteps, 130);
});

test('Storage - saveSettings ignores engine property on save and does not persist to chrome.storage', async () => {
  mockStorageData['agent_settings'] = {};
  const saved = await Storage.saveSettings({
    engine: 'legacy',
    maxSteps: 150
  } as unknown as Record<string, unknown>);

  assert.equal('engine' in saved, false);
  assert.equal((saved as any).engine, undefined);
  assert.equal(saved.maxSteps, 150);

  const rawPersisted = mockStorageData['agent_settings'] as Record<string, unknown>;
  assert.equal('engine' in rawPersisted, false);
  assert.equal(rawPersisted.engine, undefined);

  const reloaded = await Storage.getSettings();
  assert.equal('engine' in reloaded, false);
  assert.equal((reloaded as any).engine, undefined);
  assert.equal(reloaded.maxSteps, 150);
});
