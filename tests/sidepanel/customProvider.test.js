/**
 * The settings-side helpers and the Add/Edit dialog of a user-added endpoint (featere/
 * custom-endpoint), against a fake DOM like form.test.js uses. The pure helpers are the contract
 * the whole settings form leans on (providerMeta resolves built-ins and custom descriptors alike);
 * the dialog flows prove that nothing is stored until Add/Save, that a host change clears the key,
 * and that a fetch keeps the ids the user added by hand.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const mockStorageData = {};
globalThis.chrome = {
  storage: {
    local: {
      get: (keys, cb) => {
        const result = {};
        keys.forEach(k => { result[k] = mockStorageData[k]; });
        cb(result);
      },
      set: (items, cb) => { Object.assign(mockStorageData, items); if (cb) cb(); }
    }
  }
};

class FakeElement {
  constructor(id) {
    this.id = id;
    this.value = '';
    this.textContent = '';
    this.innerHTML = '';
    this.disabled = false;
    this.style = {};
    this.listeners = {};
    this.type = 'text';
    this.title = '';
    const classes = new Set();
    this.classList = {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, force) => {
        if (force === undefined) { if (classes.has(c)) classes.delete(c); else classes.add(c); }
        else if (force) classes.add(c);
        else classes.delete(c);
      }
    };
  }
  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
  async dispatchEvent(event) {
    for (const fn of this.listeners[event] || []) await fn(event);
  }
  appendChild(child) {
    this.children = this.children || [];
    this.children.push(child);
  }
  setAttribute(_n, _v) {}
  getAttribute() { return null; }
  focus() {}
  querySelectorAll() { return []; }
}

const elements = new Map();
function getEl(id) {
  if (!elements.has(id)) elements.set(id, new FakeElement(id));
  return elements.get(id);
}
globalThis.document = {
  getElementById: getEl,
  createElement: () => new FakeElement('created')
};

const {
  initCustomProviderDialog,
  providerMeta,
  buildProviderOptions,
  isCustomProviderId,
  previewUrls,
  describePrivateHttpHost,
  validateProviderIdInput,
  CUSTOM_TRIGGER_VALUE,
  CUSTOM_EMPTY_MODELS_TEXT
} = await import('../../sidepanel/customProvider.js');
const { DEFAULT_PROVIDER_CONFIGS } = await import('../../src/shared/storage.ts');

test('providerMeta: a built-in resolves exactly as before, from its registry entry and saved config', () => {
  const settings = {
    providerConfigs: { openrouter: { baseUrl: 'https://saved.example/v1', apiKey: 'sk-1', model: 'saved-model' } }
  };
  const meta = providerMeta('openrouter', settings);
  assert.equal(meta.isCustom, false);
  assert.equal(meta.baseUrl, 'https://saved.example/v1');
  assert.equal(meta.apiKey, 'sk-1');
  assert.equal(meta.savedModel, 'saved-model');
  assert.equal(meta.baseUrlPlaceholder, DEFAULT_PROVIDER_CONFIGS.openrouter.baseUrl);

  // Nothing saved: the registry default stands in, and nvidia keeps its curated long timeout.
  const fresh = providerMeta('nvidia', {});
  assert.equal(fresh.baseUrl, DEFAULT_PROVIDER_CONFIGS.nvidia.baseUrl);
  assert.equal(fresh.defaultModel, DEFAULT_PROVIDER_CONFIGS.nvidia.model);
  assert.equal(fresh.defaultTimeout, DEFAULT_PROVIDER_CONFIGS.nvidia.llmTimeoutMs);

  const plain = providerMeta('openrouter', {});
  assert.equal(plain.defaultTimeout, 120000, 'a provider without a curated timeout falls back to the global default');
});

test('providerMeta: a custom provider resolves from its descriptor, and the secret is never in it', () => {
  const settings = {
    customProviders: {
      acme: { id: 'acme', displayName: 'Acme Gateway', protocol: 'openai', baseUrl: 'https://gw.example/v1', models: ['m1', 'm2'], keyMode: 'apiKey', llmTimeoutMs: 45000 }
    },
    providerConfigs: { acme: { baseUrl: 'https://gw.example/v1', apiKey: 'sk-live', model: 'm1' } }
  };
  const meta = providerMeta('acme', settings);
  assert.equal(meta.isCustom, true);
  assert.equal(meta.exists, true);
  assert.equal(meta.displayName, 'Acme Gateway');
  assert.equal(meta.baseUrl, 'https://gw.example/v1');
  assert.equal(meta.apiKey, 'sk-live');
  assert.equal(meta.savedModel, 'm1');
  assert.deepEqual(meta.savedModels, ['m1', 'm2']);
  assert.equal(meta.defaultModel, '', 'a custom endpoint has no curated default model');
  assert.equal(meta.defaultTimeout, 45000, 'its own timeout wins over the global one');
  assert.equal(JSON.stringify(settings.customProviders.acme).includes('sk-live'), false);
});

test('isCustomProviderId: only an id with a descriptor, and never a built-in id', () => {
  const settings = { customProviders: { acme: { id: 'acme' }, openrouter: { id: 'openrouter' } } };
  assert.equal(isCustomProviderId('acme', settings), true);
  assert.equal(isCustomProviderId('openrouter', settings), false, 'a built-in id is never a custom provider, even with a stale entry');
  assert.equal(isCustomProviderId('nope', settings), false);
  assert.equal(isCustomProviderId('', settings), false);
  assert.equal(isCustomProviderId(undefined, settings), false);
});

test('buildProviderOptions: custom entries before the trigger, the trigger always present and last, no duplicates on refresh', () => {
  const options = [
    { value: 'openrouter', textContent: 'OpenRouter API', remove: null },
    { value: 'nvidia', textContent: 'NVIDIA', remove: null }
  ];
  for (const o of options) o.remove = () => {
    const i = options.indexOf(o);
    if (i >= 0) options.splice(i, 1);
  };
  const select = { options, appendChild: (o) => { o.remove = () => { const i = options.indexOf(o); if (i >= 0) options.splice(i, 1); }; options.push(o); } };

  const providers = {
    zeta: { id: 'zeta', displayName: 'Zeta Relay' },
    acme: { id: 'acme', displayName: 'Acme Gateway' }
  };
  buildProviderOptions(select, providers);
  assert.deepEqual(options.map(o => o.value), ['openrouter', 'nvidia', 'acme', 'zeta', CUSTOM_TRIGGER_VALUE], 'sorted by display name, trigger last');
  assert.equal(options[4].textContent, 'Custom endpoint…');

  // A refresh removes what the previous call appended and appends again: still exactly one trigger.
  buildProviderOptions(select, { acme: providers.acme });
  assert.deepEqual(options.map(o => o.value), ['openrouter', 'nvidia', 'acme', CUSTOM_TRIGGER_VALUE]);
});

test('previewUrls and describePrivateHttpHost: the preview is what the sender will send, and the http warning is only for public http', () => {
  assert.deepEqual(previewUrls('openai', 'https://gw.example/v1'), {
    chat: 'https://gw.example/v1/chat/completions',
    models: 'https://gw.example/v1/models'
  });
  assert.deepEqual(previewUrls('anthropic', 'https://relay.example'), {
    chat: 'https://relay.example/v1/messages',
    models: 'https://relay.example/v1/models'
  });

  assert.match(describePrivateHttpHost('http://api.example.com/v1'), /unencrypted/i);
  assert.equal(describePrivateHttpHost('http://192.168.1.20:8000/v1'), null, 'a private LAN address needs no warning');
  assert.equal(describePrivateHttpHost('http://localhost:11434/v1'), null);
  assert.equal(describePrivateHttpHost('https://api.example.com/v1'), null, 'https is never warned about');
  assert.equal(describePrivateHttpHost('not a url'), null);
});

test('validateProviderIdInput: the id rules with their named errors, and built-ins refused', () => {
  assert.equal(validateProviderIdInput('acme-gateway', []), null);
  assert.match(validateProviderIdInput('', []), /required/i);
  assert.match(validateProviderIdInput('Acme_Gateway', []), /lowercase/i);
  assert.match(validateProviderIdInput('openrouter', []), /built-in/i);
  assert.match(validateProviderIdInput('acme', ['acme']), /already exists/i);
});

test('dialog, Add flow: nothing is stored until Save, a fetch merges with hand-added ids, and Save stores the cleaned key', async () => {
  elements.clear();
  mockStorageData['agent_settings'] = { provider: 'openrouter' };
  let settings = { provider: 'openrouter', providerConfigs: {} };
  const toasts = [];
  let selectedId = null;
  let fetchPayload = null;

  const dialog = initCustomProviderDialog({
    getSettings: () => settings,
    applySettings: (s) => { settings = s; },
    sendBgMessage: (msg, cb) => {
      fetchPayload = msg.payload;
      cb({ success: true, models: ['fetched-a', 'fetched-b'] });
    },
    showToast: (text) => toasts.push(text),
    providerSelected: async (id) => { selectedId = id; }
  });

  dialog.open('add');
  assert.equal(getEl('cpOverlay').style.display, 'flex');
  assert.ok(getEl('cpModelsList').innerHTML.includes('No models will be shown in the selector'), 'the honest empty state of the model list');

  getEl('cpIdInput').value = 'acme';
  getEl('cpNameInput').value = 'Acme Gateway';
  getEl('cpBaseUrlInput').value = 'https://gw.example/v1';
  getEl('cpApiKeyInput').value = 'Bearer sk-live-1';
  getEl('cpModelAddInput').value = 'hand-added';
  await getEl('btnCpAddModel').dispatchEvent('click');
  assert.ok(getEl('cpModelsList').innerHTML.includes('hand-added'));

  await getEl('btnCpFetchModels').dispatchEvent('click');
  assert.equal(fetchPayload.customProviders['acme'].protocol, 'openai', 'the draft rides to the background as its own descriptor');
  assert.deepEqual(dialog.draft().models, ['fetched-a', 'fetched-b', 'hand-added'], 'the fetch replaces the listed ids and keeps the hand-added one');

  await getEl('btnCpSave').dispatchEvent('click');
  const stored = await import('../../src/shared/storage.ts');
  const saved = await stored.Storage.getSettings();
  assert.ok(saved.customProviders.acme, 'the provider is stored');
  assert.deepEqual(saved.customProviders.acme.models, ['fetched-a', 'fetched-b', 'hand-added']);
  assert.equal(saved.providerConfigs.acme.apiKey, 'sk-live-1', 'the key is cleaned of its Bearer prefix');
  assert.equal(selectedId, 'acme', 'the panel switched to the new provider');
  assert.match(toasts[0], /added/);
  assert.equal(getEl('cpOverlay').style.display, 'none', 'the dialog is closed');
});

test('dialog, Edit flow: changing the host clears the key on save and says so', async () => {
  elements.clear();
  mockStorageData['agent_settings'] = {
    provider: 'acme',
    customProviders: { acme: { id: 'acme', displayName: 'Acme Gateway', protocol: 'openai', baseUrl: 'https://gw.example/v1', models: ['m1'], keyMode: 'apiKey' } },
    providerConfigs: { acme: { baseUrl: 'https://gw.example/v1', apiKey: 'sk-live-1', model: 'm1' } }
  };
  let settings = null;
  const toasts = [];
  let selectedId = null;
  const dialog = initCustomProviderDialog({
    getSettings: () => settings,
    applySettings: (s) => { settings = s; },
    sendBgMessage: (_msg, cb) => cb({ success: false, error: 'offline' }),
    showToast: (text) => toasts.push(text),
    providerSelected: async (id) => { selectedId = id; }
  });
  const storage = await import('../../src/shared/storage.ts');
  settings = await storage.Storage.getSettings();

  dialog.open('edit', 'acme');
  assert.equal(getEl('cpIdInput').value, 'acme');
  assert.equal(getEl('cpIdInput').disabled, true, 'the id is the storage key and the credential name; it does not change');
  assert.equal(getEl('btnCpSave').textContent, 'Save changes');

  getEl('cpBaseUrlInput').value = 'https://other.example/v1';
  dialog.syncPreview();
  assert.ok(getEl('cpKeyClearedNote').textContent.includes('key will be removed'), 'the dialog warns before the save, where the user can react');

  await getEl('btnCpSave').dispatchEvent('click');
  const after = await storage.Storage.getSettings();
  assert.equal(after.providerConfigs.acme.apiKey, '', 'the key is gone: nothing stored is sent to a new host');
  assert.equal(after.customProviders.acme.baseUrl, 'https://other.example/v1');
  assert.match(toasts[0], /key was removed/);
  assert.equal(selectedId, 'acme');
});

test('dialog, refusal: a bad URL is named in the dialog and nothing is stored', async () => {
  elements.clear();
  mockStorageData['agent_settings'] = { provider: 'openrouter' };
  let settings = { provider: 'openrouter', providerConfigs: {} };
  let applied = false;
  const dialog = initCustomProviderDialog({
    getSettings: () => settings,
    applySettings: () => { applied = true; },
    sendBgMessage: (_msg, cb) => cb({ success: false }),
    showToast: () => {},
    providerSelected: async () => {}
  });

  dialog.open('add');
  getEl('cpIdInput').value = 'acme';
  getEl('cpBaseUrlInput').value = 'not a url';
  await getEl('btnCpSave').dispatchEvent('click');
  assert.ok(getEl('cpError').textContent.length > 0, 'the dialog says what is wrong');
  assert.equal(applied, false, 'nothing was applied');
  const stored = await import('../../src/shared/storage.ts');
  const after = await stored.Storage.getSettings();
  assert.equal(after.customProviders?.acme, undefined, 'nothing was stored');
});

test('dialog, refusal: a model id with a line break is refused in the dialog', async () => {
  elements.clear();
  mockStorageData['agent_settings'] = { provider: 'openrouter' };
  const dialog = initCustomProviderDialog({
    getSettings: () => ({ provider: 'openrouter', providerConfigs: {} }),
    applySettings: () => {},
    sendBgMessage: (_msg, cb) => cb({ success: false }),
    showToast: () => {},
    providerSelected: async () => {}
  });
  dialog.open('add');
  getEl('cpModelAddInput').value = 'bad\nid';
  await getEl('btnCpAddModel').dispatchEvent('click');
  assert.match(getEl('cpError').textContent, /line break/);
});

test('dialog, name auto-fill: an untouched display name follows the host; a typed name is never overwritten (A3)', async () => {
  elements.clear();
  mockStorageData['agent_settings'] = { provider: 'openrouter' };
  const dialog = initCustomProviderDialog({
    getSettings: () => ({ provider: 'openrouter', providerConfigs: {} }),
    applySettings: () => {},
    sendBgMessage: (_msg, cb) => cb({ success: true, models: [] }),
    showToast: () => {},
    providerSelected: async () => {}
  });

  dialog.open('add');
  getEl('cpBaseUrlInput').value = 'https://gw.example/v1';
  await getEl('cpBaseUrlInput').dispatchEvent('input');
  assert.equal(getEl('cpNameInput').value, 'gw.example', 'the empty name follows the host');

  getEl('cpNameInput').value = 'My Relay';
  await getEl('cpNameInput').dispatchEvent('input');
  getEl('cpBaseUrlInput').value = 'https://other.example/v1';
  await getEl('cpBaseUrlInput').dispatchEvent('input');
  assert.equal(getEl('cpNameInput').value, 'My Relay', 'an edited name survives a URL change');

  // Clearing the name returns to the auto behavior for the next URL keystroke.
  getEl('cpNameInput').value = '';
  await getEl('cpNameInput').dispatchEvent('input');
  getEl('cpBaseUrlInput').value = 'https://third.example';
  await getEl('cpBaseUrlInput').dispatchEvent('input');
  assert.equal(getEl('cpNameInput').value, 'third.example');
});

test('dialog, id clash: the refusal carries the one-click "Use <id>-2" suggestion (A2.3)', async () => {
  elements.clear();
  mockStorageData['agent_settings'] = { provider: 'openrouter' };
  let settings = { provider: 'openrouter', providerConfigs: {} };
  let selectedId = null;
  const dialog = initCustomProviderDialog({
    getSettings: () => settings,
    applySettings: (s) => { settings = s; },
    sendBgMessage: (_msg, cb) => cb({ success: true, models: [] }),
    showToast: () => {},
    providerSelected: async (id) => { selectedId = id; }
  });

  // First session stores acme.
  dialog.open('add');
  getEl('cpIdInput').value = 'acme';
  getEl('cpNameInput').value = 'Acme';
  getEl('cpBaseUrlInput').value = 'https://gw.example';
  await getEl('btnCpSave').dispatchEvent('click');

  // Second session with the same id is refused, with the suggestion offered.
  dialog.open('add');
  getEl('cpIdInput').value = 'acme';
  getEl('cpNameInput').value = 'Acme Two';
  getEl('cpBaseUrlInput').value = 'https://gw2.example';
  await getEl('btnCpSave').dispatchEvent('click');
  const action = (getEl('cpError').children || [])[0];
  assert.ok(action, 'the suggestion button is offered');
  assert.match(action.textContent, /Use "acme-2"/);

  await action.dispatchEvent('click');
  assert.equal(getEl('cpIdInput').value, 'acme-2', 'one click adopts the free id');
  await getEl('btnCpSave').dispatchEvent('click');
  const stored = await import('../../src/shared/storage.ts');
  const saved = await stored.Storage.getSettings();
  assert.ok(saved.customProviders['acme-2'], 'the suggested id saved cleanly');
  assert.equal(selectedId, 'acme-2');
});

test('dialog, Edit flow fetch: the fetched ids merge with the saved list, and the status says how much was new (D4)', async () => {
  elements.clear();
  mockStorageData['agent_settings'] = {
    provider: 'acme',
    providerConfigs: {},
    customProviders: { acme: { id: 'acme', displayName: 'Acme', protocol: 'openai', baseUrl: 'https://gw.example', models: ['saved-1', 'saved-2'], keyMode: 'apiKey', createdAt: 1, updatedAt: 1 } }
  };
  const dialog = initCustomProviderDialog({
    getSettings: () => mockStorageData['agent_settings'],
    applySettings: () => {},
    sendBgMessage: (_msg, cb) => cb({ success: true, models: ['endpoint-1', 'saved-2'] }),
    showToast: () => {},
    providerSelected: async () => {}
  });

  dialog.open('edit', 'acme');
  await getEl('btnCpFetchModels').dispatchEvent('click');
  assert.deepEqual(dialog.draft().models, ['endpoint-1', 'saved-2', 'saved-1'], 'fetched first, then what only the user had');
  assert.match(getEl('cpFetchStatus').textContent, /1 new id\(s\).*merged/);
});
