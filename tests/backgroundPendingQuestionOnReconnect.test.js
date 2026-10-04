/**
 * Regression test: a side panel that reconnects while the agent is waiting on ask_user must be
 * given the question it is waiting on.
 *
 * pendingQuestion is broadcast on every live STATE_UPDATE (notifyStateChange), but neither
 * RECONNECT path carried it: not the initial state the onConnect handler posts, nor the
 * GET_AGENT_STATE resync. A live panel was therefore fine, and a reopened one was not - it
 * rendered a run stuck at 'paused' with no question and no answer box, which the user cannot
 * clear or answer. Only Stop got them out.
 *
 * That combination is not exotic, it is the common case for this bug report: Chrome closes the
 * panel when the automation tab is activated, so by the time the agent asks anything, the panel
 * the user reopens is always a reconnected one.
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakePort, lastStateUpdate, sendMessage } from './helpers/fakePort.js';

const { ApiClients } = await import('../background/apiClients.js');

const QUESTION = 'Which of your two accounts should I sign in with?';

function makeMock() {
  const tabs = new Map([[100, { id: 100, url: 'https://example.com/a', groupId: -1, windowId: 1, active: true }]]);
  const storage = { agent_settings: { engine: 'legacy' } };
  const noop = () => {};
  const listeners = {};
  let groupCounter = 5000;

  return {
    __tabs: tabs,
    __listeners: listeners,
    chrome: {
      runtime: {
        lastError: null,
        onConnect: { addListener: (fn) => { listeners.onConnect = fn; } },
        onMessage: { addListener: (fn) => { listeners.onMessage = fn; } }
      },
      storage: {
        local: {
          get: (keys, cb) => {
            const result = {};
            (Array.isArray(keys) ? keys : [keys]).forEach((k) => { result[k] = storage[k]; });
            cb(result);
          },
          set: (data, cb) => { Object.assign(storage, data); if (cb) cb(); },
          remove: (k, cb) => cb && cb()
        }
      },
      tabs: {
        onRemoved: { addListener: noop },
        onActivated: { addListener: noop },
        onCreated: { addListener: noop },
        onUpdated: { addListener: noop },
        query: async () => [tabs.get(100)],
        get: (id, cb) => {
          const tab = tabs.get(id);
          if (cb) { cb(tab); return; }
          return Promise.resolve(tab);
        },
        update: (id, props, cb) => { if (cb) cb(tabs.get(id)); return Promise.resolve(tabs.get(id)); },
        sendMessage: (tabId, msg, cb) => cb({
          success: true,
          data: {
            title: 'Test Page', url: 'https://example.com/a',
            scrollState: { scrollY: 0, pageHeight: 800, viewportHeight: 800 },
            elements: [], elementsText: '', elementCount: 0, pageText: ''
          }
        }),
        group: (opts, cb) => {
          const gid = groupCounter++;
          const ids = Array.isArray(opts.tabIds) ? opts.tabIds : [opts.tabIds];
          ids.forEach((id) => { const t = tabs.get(id); if (t) t.groupId = gid; });
          cb(gid);
        },
        ungroup: (ids, cb) => cb && cb()
      },
      tabGroups: { onRemoved: { addListener: noop }, get: (id, cb) => cb({ id, title: 'ScoutFox' }), update: (id, opts, cb) => cb && cb() },
      alarms: { create: noop, clear: noop, get: (n, cb) => cb(null), onAlarm: { addListener: noop } },
      action: { onClicked: { addListener: (fn) => { listeners.onClicked = fn; } } },
      declarativeNetRequest: { updateSessionRules: () => Promise.resolve() },
      sidePanel: {
        setPanelBehavior: () => Promise.resolve(),
        setOptions: (opts, cb) => cb && cb(),
        open: () => Promise.resolve()
      },
      windows: { onRemoved: { addListener: noop } }
    }
  };
}

global.self = { addEventListener: () => {} };
const mock = makeMock();
global.chrome = mock.chrome;

await import('../background/background.js');
await new Promise((r) => setTimeout(r, 20));

// Drive a real run straight into ask_user, so the engine is genuinely paused on a question
// rather than hand-set into that state.
const realGenerateCompletion = ApiClients.generateCompletion;
ApiClients.generateCompletion = async (settings, messages, systemPrompt) => {
  if (systemPrompt === 'You are a web task planner.') return JSON.stringify(['Do the one thing']);
  return JSON.stringify({ action: 'ask_user', question: QUESTION, reason: 'Two accounts are signed in' });
};
after(() => { ApiClients.generateCompletion = realGenerateCompletion; });

const firstPanel = makeFakePort('scoutfox_sidepanel:100');
mock.__listeners.onConnect(firstPanel);
await new Promise((r) => setTimeout(r, 20));

await sendMessage(mock.__listeners, {
  action: 'START_TASK', tabId: 100, payload: { prompt: 'sign me in' }
});
await new Promise((r) => setTimeout(r, 120));

test('the live panel sees the question (setup sanity check)', () => {
  const live = lastStateUpdate(firstPanel);
  assert.equal(live.payload.status, 'paused', 'the agent must genuinely be waiting on an answer');
  assert.equal(live.payload.pendingQuestion, QUESTION,
    'the live broadcast path already carried the question - that is why the gap went unnoticed');
});

test('a panel reconnecting mid-question is given the question', async () => {
  // Chrome tore the first panel down when the automation tab was activated. This is the user
  // reopening it: a brand-new panel document, connecting from scratch to a session that is
  // already paused on a question.
  const reopened = makeFakePort('scoutfox_sidepanel:100');
  mock.__listeners.onConnect(reopened);
  await new Promise((r) => setTimeout(r, 30));

  const initial = lastStateUpdate(reopened);
  assert.equal(initial.payload.status, 'paused', 'the reopened panel must see the paused run');
  assert.equal(initial.payload.pendingQuestion, QUESTION,
    'without the question, the reopened panel renders a paused run with no answer box - a dead end the user cannot clear');
});

test('the GET_AGENT_STATE resync carries the question too', async () => {
  // The panel runs this independently of the port, to repair anything the live stream missed.
  // It overwrites what the panel is showing, so a missing question here would blank out a
  // question the onConnect path had just delivered correctly.
  const state = await sendMessage(mock.__listeners, { action: 'GET_AGENT_STATE', tabId: 100 });

  assert.equal(state.status, 'paused', 'the resync must agree that the run is paused');
  assert.equal(state.pendingQuestion, QUESTION,
    'the resync overwrites the panel\'s view, so it must carry the question as well as the port path does');
});

test('answering it clears the question everywhere', async () => {
  const res = await sendMessage(mock.__listeners, {
    action: 'ANSWER_QUESTION', tabId: 100, payload: { answer: 'the work one' }
  });
  assert.equal(res.success, true, 'the answer must be accepted');

  const state = await sendMessage(mock.__listeners, { action: 'GET_AGENT_STATE', tabId: 100 });
  assert.equal(state.pendingQuestion, null,
    'once answered, the resync must stop reporting a question - a stale one would re-render the answer box');

  await sendMessage(mock.__listeners, { action: 'STOP_TASK', tabId: 100 });
});
