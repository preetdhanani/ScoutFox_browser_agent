import test from 'node:test';
import assert from 'node:assert/strict';

class FakeElement {
  constructor(id) {
    this.id = id;
    this.value = '';
    this.textContent = '';
    this.innerHTML = '';
    this.checked = false;
    this.disabled = false;
    this.style = {};
    const classes = new Set();
    this.classList = {
      _classes: classes,
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, force) => {
        if (force === undefined) {
          if (classes.has(c)) classes.delete(c);
          else classes.add(c);
        } else if (force) {
          classes.add(c);
        } else {
          classes.delete(c);
        }
      }
    };
    this.listeners = {};
    this.children = [];
    this.options = [];
  }

  addEventListener(type, fn) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(fn);
  }

  async dispatchEvent(event) {
    const type = typeof event === 'string' ? event : event.type;
    const fns = this.listeners[type] || [];
    for (const fn of fns) await fn(event);
  }

  getAttribute(_name) { return null; }
  setAttribute(_name, _val) {}
  removeAttribute(_name) {}

  querySelectorAll(_sel) { return []; }

  getBoundingClientRect() {
    return { top: 100, bottom: 130, left: 0, right: 200, height: 30, width: 200 };
  }

  focus() {}
  appendChild(child) {
    this.children.push(child);
    this.options.push(child);
  }
}

const elements = new Map();
function getEl(id) {
  if (!elements.has(id)) {
    elements.set(id, new FakeElement(id));
  }
  return elements.get(id);
}

// Setup fake DOM globals before importing sidepanel.js
let mockStorage = {};
const sentBgMessages = [];

globalThis.window = {
  innerHeight: 800,
  addEventListener() {}
};

globalThis.document = {
  readyState: 'loading',
  documentElement: {
    setAttribute() {},
    removeAttribute() {}
  },
  createElement: (tag) => new FakeElement(tag),
  addEventListener() {},
  getElementById: (id) => getEl(id),
  querySelectorAll: () => []
};

globalThis.chrome = {
  storage: {
    local: {
      get: (keys, cb) => {
        const out = {};
        const keyList = Array.isArray(keys) ? keys : [keys];
        for (const k of keyList) {
          if (mockStorage[k] !== undefined) out[k] = mockStorage[k];
        }
        cb(out);
      },
      set: (data, cb) => {
        Object.assign(mockStorage, structuredClone(data));
        cb?.();
      }
    },
    onChanged: { addListener() {} }
  },
  runtime: {
    sendMessage: (msg, cb) => {
      sentBgMessages.push(msg);
      cb?.({ success: true, models: ['test-model-1', 'test-model-2'] });
    }
  }
};

const {
  loadSettings,
  autoSaveCurrentForm,
  openComboboxMenu,
  closeComboboxMenu,
  initEventListeners
} = await import('../../sidepanel/sidepanel.js');

// Register all form listeners onto the fake DOM elements
initEventListeners();

test('BUG-01: loadSettings preserves ollamaNumPredict and autoSaveCurrentForm does not overwrite it', async () => {
  mockStorage = {
    agent_settings: {
      provider: 'ollama',
      ollamaNumPredict: 2048,
      baseUrl: 'http://localhost:11434',
      apiKey: '',
      model: 'qwen2.5:14b',
      maxSteps: 250,
      actionDelayMs: 1000,
      llmTimeoutMs: 120000
    }
  };

  await loadSettings();

  const inputEl = getEl('ollamaNumPredictInput');
  assert.equal(inputEl.value, 2048, 'ollamaNumPredictInput must load the saved 2048 value');

  await autoSaveCurrentForm();

  const saved = mockStorage.agent_settings;
  assert.equal(saved.ollamaNumPredict, 2048, 'autoSaveCurrentForm must keep 2048 in saved settings');
});

test('BUG-02: openComboboxMenu adds "open" class and closeComboboxMenu removes it', () => {
  const combobox = getEl('modelCombobox');
  combobox.classList.remove('open');
  assert.equal(combobox.classList.contains('open'), false);

  openComboboxMenu();
  assert.equal(combobox.classList.contains('open'), true, 'openComboboxMenu must add the "open" class');

  closeComboboxMenu();
  assert.equal(combobox.classList.contains('open'), false, 'closeComboboxMenu must remove the "open" class');
});

test('BUG-08: typing 20 characters into baseUrlInput debounces autoSaveCurrentForm', async () => {
  const baseInput = getEl('baseUrlInput');
  assert.ok(baseInput.listeners['input']?.length > 0, 'baseUrlInput must have input listener');

  // Track saves
  let saveCount = 0;
  const originalSet = globalThis.chrome.storage.local.set;
  globalThis.chrome.storage.local.set = (data, cb) => {
    saveCount++;
    originalSet(data, cb);
  };

  try {
    // Type 20 characters quickly
    for (let i = 1; i <= 20; i++) {
      baseInput.value = `http://localhost:11434/test${i}`;
      baseInput.dispatchEvent({ type: 'input' });
    }

    // Immediately after typing, 0 saves should have occurred due to debouncing
    assert.equal(saveCount, 0, 'no save should fire synchronously during rapid typing');

    // Wait for the 400ms debounce to fire
    await new Promise((resolve) => setTimeout(resolve, 450));

    // Exactly 1 save should have completed
    assert.equal(saveCount, 1, 'exactly one autoSave should fire after debounce expires');
  } finally {
    globalThis.chrome.storage.local.set = originalSet;
  }
});

test('BUG-07: typing API key debounces model fetching and requires at least 8 characters', async () => {
  const apiKeyInput = getEl('apiKeyInput');
  assert.ok(apiKeyInput.listeners['input']?.length > 0, 'apiKeyInput must have input listener');

  sentBgMessages.length = 0;

  // Type fewer than 8 characters
  apiKeyInput.value = 'nvapi-1';
  apiKeyInput.dispatchEvent({ type: 'input' });
  await new Promise((resolve) => setTimeout(resolve, 450));

  const modelFetchesShort = sentBgMessages.filter((m) => m.action === 'FETCH_MODELS');
  assert.equal(modelFetchesShort.length, 0, 'should not fetch models when key has fewer than 8 characters');

  // Type 20 characters quickly
  sentBgMessages.length = 0;
  for (let i = 1; i <= 20; i++) {
    apiKeyInput.value = `nvapi-1234567890abcdef${i}`;
    apiKeyInput.dispatchEvent({ type: 'input' });
  }

  // Immediately after rapid typing, no fetch should have fired yet
  const fetchesImmediate = sentBgMessages.filter((m) => m.action === 'FETCH_MODELS');
  assert.equal(fetchesImmediate.length, 0, 'no model fetch during rapid typing');

  // Wait for 400ms debounce to expire
  await new Promise((resolve) => setTimeout(resolve, 450));

  const fetchesAfter = sentBgMessages.filter((m) => m.action === 'FETCH_MODELS');
  assert.equal(fetchesAfter.length, 1, 'at most one model fetch fires after debounce expires');
});

test('BUG-07: pasting API key does not trigger duplicate model fetches', async () => {
  const apiKeyInput = getEl('apiKeyInput');
  assert.ok(apiKeyInput.listeners['paste']?.length > 0, 'apiKeyInput must have paste listener');

  sentBgMessages.length = 0;
  apiKeyInput.value = 'nvapi-paste-test-12345';
  apiKeyInput.dispatchEvent({ type: 'paste' });
  apiKeyInput.dispatchEvent({ type: 'input' });

  // Wait past both the 200ms paste timer and 400ms input debounce
  await new Promise((resolve) => setTimeout(resolve, 500));

  const modelFetches = sentBgMessages.filter((m) => m.action === 'FETCH_MODELS');
  assert.equal(modelFetches.length, 1, 'pasting key must result in exactly 1 model fetch, not duplicates');
});

test('provider switching preserves custom timeout and updates base URL placeholder', async () => {
  const providerSelect = getEl('providerSelect');
  const timeoutInput = getEl('llmTimeoutInput');
  const baseUrlInput = getEl('baseUrlInput');

  // Set global timeout under openai
  providerSelect.value = 'openai';
  timeoutInput.value = '65000';
  await autoSaveCurrentForm();

  // Switch to nvidia: timeout should become nvidia's default (300000)
  providerSelect.value = 'nvidia';
  await providerSelect.dispatchEvent({ type: 'change' });
  assert.equal(timeoutInput.value, 300000, 'nvidia should use its default 300000ms timeout');
  assert.equal(baseUrlInput.placeholder, 'https://integrate.api.nvidia.com/v1', 'placeholder updates for nvidia');

  // Switch back to openai: custom global timeout (65000) should be restored
  providerSelect.value = 'openai';
  await providerSelect.dispatchEvent({ type: 'change' });
  assert.equal(timeoutInput.value, 65000, 'openai should restore the 65000ms custom timeout');
  assert.equal(baseUrlInput.placeholder, 'https://api.openai.com', 'placeholder updates for openai');
});
