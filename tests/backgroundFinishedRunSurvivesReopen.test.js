/**
 * Regression test for the data-loss half of the "the side panel disappeared" report.
 *
 * Chrome closes the side panel whenever the active tab changes to one the panel is not enabled
 * for, and no extension can reopen it without a fresh user gesture. So the only way back is to
 * click the toolbar icon again. That click ran clearHistory() on any session that was not
 * running or paused - which is every session whose run has just FINISHED. Recovering the panel
 * therefore destroyed the very result the user was trying to get back to.
 *
 * "Stale" was always meant to mean a conversation restored from storage that the user has moved
 * on from - see backgroundFreshOnOpen.test.js, which this file is the counterpart to. It was
 * never meant to mean a run that finished thirty seconds ago. Both read as status 'idle', which
 * is why a status-only test could not tell them apart.
 *
 * engine.dirty separates them exactly: the constructor sets it false, restoreState never sets
 * it, and every method that mutates this worker's own engine sets it true. So !dirty means
 * "everything on screen came out of storage and nothing has happened in this worker's lifetime".
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakePort, lastStateUpdate, sendMessage } from './helpers/fakePort.js';

const { ApiClients } = await import('../background/apiClients.js');

const FINAL_ANSWER = 'The answer the user asked for and has not read yet.';

function makeMock() {
  const tabs = new Map([[100, { id: 100, url: 'https://example.com/a', groupId: -1, windowId: 1, active: true }]]);
  const storage = {};
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

// A run that actually COMPLETES - the whole point of this file. The engine sets status back to
// 'idle' on a finish action, which is exactly the status the old clear-on-click test matched.
const realGenerateCompletion = ApiClients.generateCompletion;
ApiClients.generateCompletion = async (settings, messages, systemPrompt) => {
  if (systemPrompt === 'You are a web task planner.') return JSON.stringify(['Do the one thing']);
  return JSON.stringify({ action: 'finish', answer: FINAL_ANSWER, reason: 'Found what was asked for' });
};
after(() => { ApiClients.generateCompletion = realGenerateCompletion; });

test('a run that finished in this worker survives the click that reopens the panel', async () => {
  const port = makeFakePort('scoutfox_sidepanel:100');
  mock.__listeners.onConnect(port);
  await new Promise((r) => setTimeout(r, 20));

  await sendMessage(mock.__listeners, {
    action: 'START_TASK', tabId: 100, payload: { prompt: 'the task whose answer matters' }
  });
  await new Promise((r) => setTimeout(r, 120));

  const finished = lastStateUpdate(port);
  assert.equal(finished.payload.status, 'idle', 'sanity check: a finished run reports idle, same as a stale restored one');
  const answerEntry = finished.payload.history.find((h) => h.type === 'finish');
  assert.ok(answerEntry, 'sanity check: the run really did produce a finish entry before the click');

  // The user's panel was closed by Chrome when the automation tab was activated, so clicking the
  // icon is the ONLY way they can get it back. That gesture must not cost them the result.
  mock.__listeners.onClicked(mock.__tabs.get(100));
  await new Promise((r) => setTimeout(r, 40));

  const afterClick = lastStateUpdate(port);
  assert.equal(afterClick.payload.status, 'idle', 'the session is still idle, as before');
  const survivingAnswer = afterClick.payload.history.find((h) => h.type === 'finish');
  assert.ok(survivingAnswer,
    'clicking the icon to get the panel back must not destroy the run the user is trying to read - ' +
    'that click is a recovery gesture forced on them by the panel closing, not a request to start over');
  assert.equal(afterClick.payload.task, 'the task whose answer matters',
    'and the task it answered must still be on screen next to the answer');
});

test('the New Session button still starts over on demand', async () => {
  const port = makeFakePort('scoutfox_sidepanel:100');
  mock.__listeners.onConnect(port);
  await new Promise((r) => setTimeout(r, 20));

  await sendMessage(mock.__listeners, { action: 'CLEAR_HISTORY', tabId: 100 });
  await new Promise((r) => setTimeout(r, 20));

  const cleared = lastStateUpdate(port);
  assert.deepEqual(cleared.payload.history, [],
    'keeping a finished run through a reopen must not remove the explicit, deliberate way to clear it');
});
