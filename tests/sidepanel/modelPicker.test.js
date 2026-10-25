/**
 * The model pickers and the run's model chip, driven through the panel's own listeners.
 *
 * What these tests hold on to:
 *   1. A model id typed in the composer menu is shown as itself (composer, Settings label,
 *      header badge), saved as itself, and checked in the composer list. The internal marker
 *      "__custom__" never reaches the screen or the storage.
 *   2. "Enter custom model name..." in Settings only opens the field: nothing is saved until a
 *      non-empty id is typed, and then the typed id is saved, never "__custom__".
 *   3. Changing the default effort in Settings updates the composer's effort button too.
 *   4. The run's model chip shows the model the run started with, not a later edit in Settings,
 *      and the composer's model button is disabled while the run is live.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { install, settle } from './fakePanelDom.js';

const { getEl, storage } = install({ models: ['test-model-1', 'test-model-2'] });

const {
  loadSettings,
  autoSaveCurrentForm,
  initEventListeners,
  pickComboboxModel,
  renderState
} = await import('../../sidepanel/sidepanel.js');

initEventListeners();

const CUSTOM = '__custom__';

async function freshSettings(model = 'test-model-1') {
  storage.data = {
    agent_settings: {
      provider: 'openai',
      baseUrl: 'https://api.openai.com',
      apiKey: 'sk-test-0000000000',
      model,
      providerConfigs: { openai: { baseUrl: 'https://api.openai.com', apiKey: 'sk-test-0000000000', model } }
    }
  };
  await loadSettings();
}

function savedModel() {
  const s = storage.data.agent_settings;
  return { top: s.model, provider: s.providerConfigs?.openai?.model };
}

test('a model typed in the composer menu is shown, saved and checked as itself', async () => {
  await freshSettings();
  getEl('modelMenuCustom').value = 'acme/my-model-7b';
  await getEl('modelMenuCustomApply').dispatchEvent('click');
  await settle();

  assert.equal(getEl('composerModel').textContent, 'acme/my-model-7b');
  assert.equal(getEl('modelSelectedLabel').textContent, 'acme/my-model-7b');
  assert.equal(getEl('currentModelBadge').textContent, 'acme/my-model-7b');
  assert.deepEqual(savedModel(), { top: 'acme/my-model-7b', provider: 'acme/my-model-7b' });

  // Open the composer menu: the typed id is in the list, and it is the checked one.
  getEl('modelMenu').hidden = true;
  await getEl('composerModel').dispatchEvent('click');
  await settle();
  const list = getEl('modelMenuList').innerHTML;
  assert.match(list, /aria-checked="true" data-model="acme\/my-model-7b"/);
  assert.equal(list.includes(CUSTOM), false);
});

test('"Enter custom model name..." in Settings saves nothing until an id is typed', async () => {
  await freshSettings('test-model-2');
  const before = structuredClone(storage.data.agent_settings);

  await pickComboboxModel(CUSTOM);
  await settle();
  assert.equal(getEl('modelCustomInput').style.display, 'block', 'the field opens');
  assert.deepEqual(storage.data.agent_settings, before, 'opening the field saves nothing');
  assert.equal(getEl('modelSelectedLabel').textContent.includes(CUSTOM), false);

  // Any other autosave while the field is open and empty keeps the saved model.
  await autoSaveCurrentForm();
  assert.deepEqual(savedModel(), { top: 'test-model-2', provider: 'test-model-2' });

  // An empty or blank entry saves nothing either.
  const input = getEl('modelCustomInput');
  input.value = '   ';
  await input.dispatchEvent('change');
  await settle();
  assert.deepEqual(savedModel(), { top: 'test-model-2', provider: 'test-model-2' });

  // A typed id is saved after the debounce, as itself.
  input.value = 'acme/typed-model';
  await input.dispatchEvent('input');
  await settle(450);
  assert.deepEqual(savedModel(), { top: 'acme/typed-model', provider: 'acme/typed-model' });
  assert.equal(getEl('modelSelectedLabel').textContent, 'acme/typed-model');
  assert.equal(getEl('composerModel').textContent, 'acme/typed-model');
  assert.equal(input.style.display, 'block', 'the field stays open while typing');

  // change (Enter or leaving the field) saves at once.
  input.value = 'acme/final-model';
  await input.dispatchEvent('change');
  await settle();
  assert.deepEqual(savedModel(), { top: 'acme/final-model', provider: 'acme/final-model' });
});

test('"__custom__" is never written, even when it is handed to the model setter', async () => {
  await freshSettings('test-model-1');
  await pickComboboxModel(CUSTOM);
  getEl('modelCustomInput').value = '';
  await autoSaveCurrentForm();
  assert.notEqual(storage.data.agent_settings.model, CUSTOM);
  assert.notEqual(storage.data.agent_settings.providerConfigs.openai.model, CUSTOM);
});

test('picking a listed model closes the custom field and saves the pick', async () => {
  await freshSettings('test-model-1');
  await pickComboboxModel(CUSTOM);
  await pickComboboxModel('test-model-2');
  await settle();
  assert.equal(getEl('modelCustomInput').style.display, 'none');
  assert.deepEqual(savedModel(), { top: 'test-model-2', provider: 'test-model-2' });
});

test('changing the default effort in Settings updates the composer', async () => {
  await freshSettings();
  const select = getEl('effortDefaultSelect');
  select.value = 'high';
  await select.dispatchEvent('change');
  await settle();
  assert.equal(getEl('btnEffort').textContent, 'High');
  assert.equal(storage.data.agent_settings.effortDefault, 'high');
});

test('the run chip keeps the model the run started with, and the model button is locked', async () => {
  await freshSettings('test-model-1');
  const base = { task: 'Find a price', history: [{ type: 'user_goal', turn: 1, prompt: 'Find a price', timestamp: '10:00:00', isNewRun: true }], bootId: 'boot-chip' };

  renderState({ ...base, status: 'running', stepCount: 1, stateVersion: 1 });
  assert.match(getEl('processingModelChip').textContent, /test-model-1$/);
  assert.equal(getEl('composerModel').disabled, true, 'model button locked during a run');

  // The user changes the model in Settings while the run goes on.
  await pickComboboxModel('test-model-2');
  await settle();
  renderState({ ...base, status: 'running', stepCount: 2, stateVersion: 2 });
  assert.match(getEl('processingModelChip').textContent, /test-model-1$/, 'the chip still names the run model');

  renderState({ ...base, status: 'idle', stepCount: 2, stateVersion: 3 });
  assert.equal(getEl('composerModel').disabled, false, 'model button free again');

  // The next run uses the new model.
  renderState({ ...base, status: 'running', stepCount: 1, stateVersion: 4 });
  assert.match(getEl('processingModelChip').textContent, /test-model-2$/);
});
