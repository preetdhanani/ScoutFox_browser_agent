/**
 * The context meter as the panel wires it (sidepanel/sidepanel.js), driven through its own
 * listeners over the fake DOM.
 *
 * What these tests hold on to:
 *   1. Every state from the runner redraws the ring and its label, and an open card follows it.
 *   2. Clicking the ring opens the card; the card's Compact sends COMPACT_CHAT once, and a refused
 *      Compact is shown as an error toast with the runner's reason.
 *   3. A saved chat opened from Recent tasks is read-only for the meter: the ring is off and does
 *      not count it, and the next live state gives the meter back.
 *   4. The Settings field saves a window for the chosen model, refuses what is not a count, and an
 *      emptied field removes the user's value.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { install, settle } from './fakePanelDom.js';

const { getEl, storage, sent } = install();
const { receiveState, initEventListeners, loadSettings, loadSelectedSession } = await import('../../sidepanel/sidepanel.js');
initEventListeners();
await loadSettings();

let version = 100;
const stateWith = (context, status = 'idle') => ({
  status,
  task: 'Count them',
  history: [
    { type: 'user_goal', turn: 1, prompt: 'Count them', timestamp: '10:00', isNewRun: true },
    { type: 'finish', answer: 'There are 10.', outcome: 'done' }
  ],
  planSteps: [],
  stepCount: 0,
  stateVersion: ++version,
  bootId: 'boot-ctx',
  context: { used: 31_200, window: 262144, windowSource: 'default', estimated: true, summarizedTurns: 0, hasEarlierTurn: true, compacting: false, ...context }
});

/** A click whose target is the card button `what` (the fake DOM has no closest()). */
const cardClick = (what, disabled = false) => ({
  type: 'click',
  target: { closest: () => ({ getAttribute: () => what, disabled }) }
});

test('every state redraws the ring and its label', async () => {
  receiveState(stateWith({ used: 31_200 }));
  await settle();
  assert.equal(getEl('btnContext').getAttribute('aria-label'), 'Context: 12% of 256K used');
  assert.match(getEl('contextRing').innerHTML, /ctx-ring ctx-ok/);
  receiveState(stateWith({ used: 240_000 }));
  await settle();
  assert.equal(getEl('btnContext').getAttribute('aria-label'), 'Context: 92% of 256K used');
  assert.match(getEl('contextRing').innerHTML, /ctx-high/);
});

test('the ring opens the card, and Compact sends COMPACT_CHAT once', async () => {
  receiveState(stateWith({ used: 31_200 }));
  getEl('contextMenu').hidden = true;
  await getEl('btnContext').dispatchEvent('click');
  assert.equal(getEl('contextMenu').hidden, false, 'the card is open');
  assert.equal(getEl('btnContext').getAttribute('aria-expanded'), 'true');
  assert.match(getEl('contextMenu').innerHTML, /31\.2K of 256K · 12%/);

  // The card follows the next state while it is open.
  receiveState(stateWith({ used: 62_400 }));
  assert.match(getEl('contextMenu').innerHTML, /62\.4K of 256K · 24%/);

  const before = sent.filter((m) => m.action === 'COMPACT_CHAT').length;
  await getEl('contextMenu').dispatchEvent(cardClick('compact'));
  assert.equal(sent.filter((m) => m.action === 'COMPACT_CHAT').length, before + 1);
  await getEl('contextMenu').dispatchEvent(cardClick('compact', true));
  assert.equal(sent.filter((m) => m.action === 'COMPACT_CHAT').length, before + 1, 'a disabled Compact sends nothing');
});

test('a refused Compact is an error toast with the reason', async () => {
  const realSend = globalThis.chrome.runtime.sendMessage;
  globalThis.chrome.runtime.sendMessage = (msg, cb) => {
    sent.push(msg);
    cb?.(msg.action === 'COMPACT_CHAT' ? { success: false, error: 'The chat could not be compacted: HTTP 503' } : { success: true });
  };
  try {
    getEl('toastContainer').children.length = 0;
    receiveState(stateWith({}));
    await getEl('contextMenu').dispatchEvent(cardClick('compact'));
    const toast = getEl('toastContainer').children.at(-1);
    assert.ok(toast, 'a toast was shown');
    assert.equal(toast.className, 'toast error');
    assert.match(toast.textContent, /HTTP 503/);
  } finally {
    globalThis.chrome.runtime.sendMessage = realSend;
  }
});

test('a saved chat from Recent tasks is read-only for the meter, and a live state gives it back', async () => {
  storage.data.saved_sessions = [{ id: 'session_saved', task: 'Old', history: [{ type: 'user_goal', turn: 1, prompt: 'Old', timestamp: '', isNewRun: true }, { type: 'finish', answer: 'x' }], planSteps: [] }];
  await loadSelectedSession('session_saved');
  assert.equal(getEl('btnContext').disabled, true, 'the ring is off');
  assert.equal(getEl('btnContext').getAttribute('aria-label'), 'Context: not counted for a saved chat');
  receiveState(stateWith({ used: 31_200 }));
  assert.equal(getEl('btnContext').disabled, false);
  assert.equal(getEl('btnContext').getAttribute('aria-label'), 'Context: 12% of 256K used');
});

test('the Settings field saves a window for the chosen model, refuses a non-count, and an empty field removes it', async () => {
  const key = `${getEl('providerSelect').value}|${getEl('modelSelectedLabel').textContent}`;
  const input = getEl('contextWindowInput');
  input.value = '200K';
  await input.dispatchEvent('change');
  await settle(5);
  assert.equal(storage.data.agent_settings.contextWindow[key], 200000);
  assert.equal(input.value, '200000', 'the field shows the stored number');

  input.value = 'lots';
  await input.dispatchEvent('change');
  await settle(5);
  assert.equal(storage.data.agent_settings.contextWindow[key], 200000, 'a non-count is not saved');
  assert.match(getEl('contextWindowHint').textContent, /not a token count/);
  assert.equal(getEl('contextWindowHint').classList.contains('is-error'), true);

  input.value = '';
  await input.dispatchEvent('change');
  await settle(5);
  assert.equal(key in storage.data.agent_settings.contextWindow, false, 'the user value is gone');
  assert.ok(sent.some((m) => m.action === 'GET_CONTEXT_WINDOW' && m.payload && m.payload.provider), 'the line under the field asks the background for the window');
});
