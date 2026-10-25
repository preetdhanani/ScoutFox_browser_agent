/**
 * The LLM Timeout field must change the timeout the engine really uses.
 *
 * The engine reads the timeout with timeoutMsOf (src/background/llm/settings.ts): the provider's
 * own value (providerConfigs[id].llmTimeoutMs, then a custom provider's descriptor) wins over the
 * global llmTimeoutMs. A custom provider that has its own timeout used to get only the global value
 * written by the panel, so the field snapped back to the old number and the edit did nothing.
 *
 * What these tests hold on to:
 *   1. For a provider with its own timeout, an edit is saved where timeoutMsOf reads it, the
 *      field shows the new value, and the global timeout of the other providers is untouched.
 *   2. A provider without its own timeout still saves the global value (unchanged behaviour).
 *   3. The field shows what timeoutMsOf uses, also when only the descriptor holds the value.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { install, settle } from './fakePanelDom.js';
import { timeoutMsOf } from '../../src/background/llm/settings.ts';

const { getEl, storage } = install();

const { loadSettings, initEventListeners } = await import('../../sidepanel/sidepanel.js');

initEventListeners();

function customSettings({ configTimeout, descriptorTimeout }) {
  return {
    agent_settings: {
      provider: 'acme',
      baseUrl: 'https://gateway.acme.test/v1',
      apiKey: 'test-key-123456',
      model: 'acme-1',
      llmTimeoutMs: 120000,
      customProviders: {
        acme: {
          id: 'acme',
          displayName: 'Acme',
          protocol: 'openai',
          baseUrl: 'https://gateway.acme.test/v1',
          models: ['acme-1'],
          keyMode: 'apiKey',
          ...(descriptorTimeout ? { llmTimeoutMs: descriptorTimeout } : {}),
          createdAt: 1,
          updatedAt: 1
        }
      },
      providerConfigs: {
        acme: {
          baseUrl: 'https://gateway.acme.test/v1',
          apiKey: 'test-key-123456',
          model: 'acme-1',
          ...(configTimeout ? { llmTimeoutMs: configTimeout } : {})
        }
      }
    }
  };
}

async function editTimeout(value) {
  const input = getEl('llmTimeoutInput');
  input.value = String(value);
  await input.dispatchEvent('change');
  await settle();
}

test('a custom provider with its own timeout saves the edit where the engine reads it', async () => {
  storage.data = customSettings({ configTimeout: 90000, descriptorTimeout: 90000 });
  await loadSettings();
  assert.equal(Number(getEl('llmTimeoutInput').value), 90000);

  await editTimeout(45000);
  const saved = storage.data.agent_settings;
  assert.equal(timeoutMsOf(saved), 45000, 'the engine uses the new value');
  assert.equal(Number(getEl('llmTimeoutInput').value), 45000, 'the field does not snap back');
  assert.equal(saved.llmTimeoutMs, 120000, 'the global timeout of other providers is untouched');
  assert.equal(saved.customProviders.acme.llmTimeoutMs, 45000, 'the dialog shows the same value next time');

  // And it survives a reload of the panel.
  await loadSettings();
  assert.equal(Number(getEl('llmTimeoutInput').value), 45000);
});

test('a timeout held only in the descriptor is shown and edited too', async () => {
  storage.data = customSettings({ configTimeout: 0, descriptorTimeout: 200000 });
  await loadSettings();
  assert.equal(Number(getEl('llmTimeoutInput').value), 200000, 'the field shows what the engine uses');

  await editTimeout(60000);
  assert.equal(timeoutMsOf(storage.data.agent_settings), 60000);
  assert.equal(Number(getEl('llmTimeoutInput').value), 60000);
});

test('a provider without its own timeout still saves the global one', async () => {
  storage.data = customSettings({ configTimeout: 0, descriptorTimeout: 0 });
  await loadSettings();
  await editTimeout(70000);
  const saved = storage.data.agent_settings;
  assert.equal(saved.llmTimeoutMs, 70000);
  assert.equal(timeoutMsOf(saved), 70000);
  assert.equal(Number(getEl('llmTimeoutInput').value), 70000);
});
