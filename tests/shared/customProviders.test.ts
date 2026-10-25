/**
 * customProviders.test.ts - the storage layer of user-added providers (featere/custom-endpoint).
 *
 * The gate rules live in saveCustomProvider, so the panel cannot be kinder than storage: the id
 * shape and uniqueness, the reserved built-ins, the protocol and URL checks, the model-id line
 * rule, the cap, and the origin rule that clears a stored key when the endpoint host changes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

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

const {
  Storage,
  saveCustomProvider,
  sanitizeCustomProviders,
  BUILTIN_PROVIDER_IDS,
  CUSTOM_PROVIDER_ID_PATTERN,
  MAX_CUSTOM_PROVIDERS,
  DEFAULT_PROVIDER_CONFIGS
} = await import('../../src/shared/storage.ts');

const VALID = { id: 'acme-gateway', protocol: 'openai', baseUrl: 'https://gateway.example/v1' } as const;

test('the built-in id list is the key set of DEFAULT_PROVIDER_CONFIGS, kept as a literal', () => {
  assert.deepEqual([...BUILTIN_PROVIDER_IDS].sort(), Object.keys(DEFAULT_PROVIDER_CONFIGS).sort());
});

test('the id pattern accepts acme-gateway and rejects case, underscore, leading digit, one-char and overflow', () => {
  assert.ok(CUSTOM_PROVIDER_ID_PATTERN.test('acme-gateway'));
  assert.ok(CUSTOM_PROVIDER_ID_PATTERN.test('ab'), 'two characters is the minimum');
  assert.ok(CUSTOM_PROVIDER_ID_PATTERN.test('relay-2'));
  assert.ok(!CUSTOM_PROVIDER_ID_PATTERN.test('Acme-Gateway'));
  assert.ok(!CUSTOM_PROVIDER_ID_PATTERN.test('acme_gateway'));
  assert.ok(!CUSTOM_PROVIDER_ID_PATTERN.test('1acme'));
  assert.ok(!CUSTOM_PROVIDER_ID_PATTERN.test('-acme'));
  assert.ok(!CUSTOM_PROVIDER_ID_PATTERN.test('a'), 'a one-character id is below the two-character minimum');
  assert.ok(!CUSTOM_PROVIDER_ID_PATTERN.test('a'.repeat(33)));
  assert.ok(CUSTOM_PROVIDER_ID_PATTERN.test('a'.repeat(32)));
});

test('a valid provider is saved with its credential in providerConfigs, not in the descriptor', async () => {
  const result = await saveCustomProvider({ ...VALID, displayName: 'Acme Gateway', models: ['m1', 'm1', ' m2 '], apiKey: 'sk-test' });
  assert.ok(result.ok, result.ok ? '' : result.error);
  const settings = await Storage.getSettings();
  const descriptor = settings.customProviders?.['acme-gateway'];
  assert.ok(descriptor);
  assert.equal(descriptor.protocol, 'openai');
  assert.equal(descriptor.displayName, 'Acme Gateway');
  assert.equal(descriptor.baseUrl, 'https://gateway.example/v1');
  assert.deepEqual(descriptor.models, ['m1', 'm2'], 'models are trimmed and de-duplicated in order');
  assert.equal('apiKey' in descriptor, false, 'the descriptor holds no secret');
  assert.equal(settings.providerConfigs?.['acme-gateway'].apiKey, 'sk-test');
  assert.ok(descriptor.createdAt > 0);
});

test('the display name defaults to the host when it is left empty', async () => {
  const result = await saveCustomProvider({ ...VALID, id: 'host-default' });
  assert.ok(result.ok, result.ok ? '' : result.error);
  assert.equal(result.ok ? result.provider.displayName : '', 'gateway.example');
});

test('an unusable id, a reserved built-in id, a bad protocol and a bad URL are all refused with a named error', async () => {
  const refused = await saveCustomProvider({ ...VALID, id: 'Acme_Gateway' });
  assert.ok(!refused.ok);
  if (!refused.ok) assert.match(refused.error, /lowercase/i);
  assert.match((await saveCustomProvider({ ...VALID, id: 'openrouter' }) as { error: string }).error, /built-in/i);
  assert.match((await saveCustomProvider({ ...VALID, id: 'bad-proto', protocol: 'ollama' }) as { error: string }).error, /protocol/i);
  assert.match((await saveCustomProvider({ ...VALID, id: 'bad-url', baseUrl: 'not a url' }) as { error: string }).error, /URL/i);
  assert.match((await saveCustomProvider({ ...VALID, id: 'ftp-url', baseUrl: 'ftp://gateway.example/v1' }) as { error: string }).error, /http/i);
  // A valid id whose URL is empty: the URL error, not the id error, is what the user sees.
  assert.match((await saveCustomProvider({ ...VALID, id: 'no-url', baseUrl: '' }) as { error: string }).error, /URL/i);
});

test('a model id with a line break is refused, because it would corrupt the picker and the logs', async () => {
  const result = await saveCustomProvider({ ...VALID, id: 'newline-model', models: ['ok-model', 'bad\nmodel'] });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /line break/);
});

test('an edit keeps the key when only the path changes, and clears it when the origin changes', async () => {
  const created = await saveCustomProvider({ ...VALID, id: 'origin-rule', apiKey: 'sk-live-key' });
  assert.ok(created.ok);
  assert.equal((await Storage.getSettings()).providerConfigs?.['origin-rule'].apiKey, 'sk-live-key');

  // Path-only change: a correction, not a new server.
  const pathEdit = await saveCustomProvider({ ...VALID, id: 'origin-rule', baseUrl: 'https://gateway.example/api/v1', apiKey: 'sk-live-key' });
  assert.ok(pathEdit.ok);
  assert.equal(pathEdit.ok && pathEdit.keyCleared, false);
  assert.equal((await Storage.getSettings()).providerConfigs?.['origin-rule'].apiKey, 'sk-live-key');

  // Origin change: the stored key is gone, so nothing live is sent to a host the user did not choose.
  const hostEdit = await saveCustomProvider({ ...VALID, id: 'origin-rule', baseUrl: 'https://other.example/v1', apiKey: 'sk-live-key' });
  assert.ok(hostEdit.ok);
  assert.equal(hostEdit.ok && hostEdit.keyCleared, true);
  assert.equal((await Storage.getSettings()).providerConfigs?.['origin-rule'].apiKey, '');

  // Same input saved twice is an update, not a duplicate, and createdAt survives it.
  const second = await saveCustomProvider({ ...VALID, id: 'origin-rule' });
  assert.ok(second.ok);
  const descriptor = (await Storage.getSettings()).customProviders?.['origin-rule'];
  assert.ok(descriptor);
  assert.equal(descriptor.createdAt, created.ok ? created.provider.createdAt : 0);
});

test('delete removes the descriptor, the credentials and the model cache, and heals an active selection', async () => {
  await saveCustomProvider({ ...VALID, id: 'doomed', apiKey: 'sk-doomed', models: ['m1'] });
  const cacheKey = `doomed_https://gateway.example/v1_12ab34`;
  await Storage.saveCachedModels(cacheKey, ['m1']);
  await Storage.saveSettings({ provider: 'doomed', baseUrl: 'https://gateway.example/v1', model: 'm1' });

  const after = await Storage.deleteCustomProvider('doomed');
  assert.ok(after);
  assert.equal(after.customProviders?.['doomed'], undefined);
  assert.equal(after.providerConfigs?.['doomed'], undefined);
  assert.equal(after.provider, 'ollama', 'the active selection falls back to the built-in default');
  const cache = await Storage.getCachedModels(cacheKey);
  assert.equal(cache, null, 'the stale model list of a gone endpoint is not served (null means no cache)');

  assert.equal(await Storage.deleteCustomProvider('doomed'), null, 'deleting a gone id says so');
});

test('the cap refuses one more provider past the limit, naming the number', async () => {
  // A fresh settings object: earlier tests in this file saved their own providers into the same mock.
  mockStorageData['agent_settings'] = { provider: 'ollama' };
  for (let i = 0; i < MAX_CUSTOM_PROVIDERS; i++) {
    const result = await saveCustomProvider({ ...VALID, id: `cap-${i}` });
    assert.ok(result.ok, `provider ${i} should save: ${result.ok ? '' : result.error}`);
  }
  const over = await saveCustomProvider({ ...VALID, id: 'cap-over' });
  assert.equal(over.ok, false);
  if (!over.ok) assert.ok(over.error.includes(String(MAX_CUSTOM_PROVIDERS)), over.error);
  delete mockStorageData['agent_settings'];
});

test('sanitize drops entries this build cannot use and keeps the rest, and getSettings defaults to {}', async () => {
  assert.deepEqual(sanitizeCustomProviders(undefined), {});
  assert.deepEqual(sanitizeCustomProviders('garbage'), {});
  const kept = sanitizeCustomProviders({
    good: { id: 'good', protocol: 'openai', baseUrl: 'https://g.example', models: ['m'], keyMode: 'none' },
    badId: { id: 'BAD', protocol: 'openai', baseUrl: 'x' },
    builtinId: { id: 'ollama', protocol: 'openai', baseUrl: 'x' },
    badProtocol: { id: 'ok-id', protocol: 'websocket', baseUrl: 'x' },
    notAnObject: 'nope'
  });
  assert.deepEqual(Object.keys(kept), ['good']);
  assert.equal(kept.good.keyMode, 'none');

  const settings = await Storage.getSettings();
  assert.ok(settings.customProviders, 'customProviders is present after a load');
  assert.equal(typeof settings.customProviders, 'object');
});

test('a provider id from a newer build that this build dropped does not wedge the active selection', async () => {
  mockStorageData['agent_settings'] = {
    provider: 'vanished-provider',
    customProviders: { 'vanished-provider': { id: 'vanished-provider', protocol: 'openai', baseUrl: 'https://x.example', models: [] } }
  };
  const settings = await Storage.getSettings();
  // The entry survives sanitization (it is well-formed), so it stays selectable.
  assert.equal(settings.provider, 'vanished-provider');

  // When the entry is gone (deleted by another panel), the selection heals to the default.
  mockStorageData['agent_settings'] = { provider: 'vanished-provider', customProviders: {} };
  const healed = await Storage.getSettings();
  assert.equal(healed.provider, 'ollama');
  delete mockStorageData['agent_settings'];
});
