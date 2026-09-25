/**
 * Regression test for a direct user request: "it should not be like, if I open the extension
 * then instantly it makes a group - rather, as soon as I give it a task, then it should make a
 * group."
 *
 * Opening the panel is not asking for work. Grouping on open reorganised the tab strip - moving
 * the tab, colouring it, boxing it - just for looking at the extension. The ScoutFox group is a
 * sandbox marker showing which tabs the agent may touch, so it only means anything once there
 * is something to sandbox.
 *
 * This was not always avoidable. While side-panel visibility was keyed off the group, a session
 * with no group had no way to keep its panel alive across a tab switch, so the group had to
 * exist from the moment the panel opened. Per-tab sessions replaced that key with "does this tab
 * have a session", which is true from the click itself - freeing the group to arrive with the
 * task, where it belongs.
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { sendMessage } from './helpers/fakePort.js';

const { ApiClients } = await import('../background/apiClients.js');

const TAB = 100;

function makeMock() {
  const tabs = new Map([[TAB, { id: TAB, url: 'https://example.com/work', groupId: -1, windowId: 1, active: true, index: 0 }]]);
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
        query: (q, cb) => {
          const list = Array.from(tabs.values());
          if (cb) { cb(list); return; }
          return Promise.resolve(list);
        },
        get: (id, cb) => {
          const tab = tabs.get(id);
          if (cb) { cb(tab); return; }
          return Promise.resolve(tab);
        },
        update: (id, props, cb) => { if (cb) cb(tabs.get(id)); return Promise.resolve(tabs.get(id)); },
        sendMessage: (tabId, msg, cb) => cb({
          success: true,
          data: {
            title: 'Test Page', url: tabs.get(tabId)?.url || 'https://example.com',
            scrollState: { scrollY: 0, pageHeight: 800, viewportHeight: 800 },
            elements: [], elementsText: '', elementCount: 0, pageText: ''
          }
        }),
        group: (opts, cb) => {
          const gid = opts.groupId || groupCounter++;
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

const realGenerateCompletion = ApiClients.generateCompletion;
ApiClients.generateCompletion = async (settings, messages, systemPrompt) => {
  if (systemPrompt === 'You are a web task planner.') return JSON.stringify(['Do the one thing']);
  return JSON.stringify({ action: 'finish', answer: 'done', reason: 'test' });
};
after(() => { ApiClients.generateCompletion = realGenerateCompletion; });

test('opening the panel creates a session but NO tab group', async () => {
  mock.__listeners.onClicked(mock.__tabs.get(TAB));
  await new Promise((r) => setTimeout(r, 40));

  assert.equal(mock.__tabs.get(TAB).groupId, -1,
    'the user asked for the extension, not for work - their tab must be left exactly where and how it was');

  // The session itself DOES exist from the click. That is what keeps the panel alive, and it is
  // the thing the group used to be standing in for.
  const state = await sendMessage(mock.__listeners, { action: 'GET_AGENT_STATE', tabId: TAB });
  assert.ok(state, 'a session must exist for the clicked tab');
  assert.equal(state.scoutFoxGroupId, null, 'and it must not have a group yet');
});

test('giving it a task is what creates the group', async () => {
  const res = await sendMessage(mock.__listeners, {
    action: 'START_TASK', tabId: TAB, payload: { prompt: 'now actually do something' }
  });
  assert.equal(res.success, true, 'the task must start');
  await new Promise((r) => setTimeout(r, 120));

  assert.ok(mock.__tabs.get(TAB).groupId >= 5000,
    'once there is a task, the tab is sandboxed into a ScoutFox group - that is when the marker means something');

  const state = await sendMessage(mock.__listeners, { action: 'GET_AGENT_STATE', tabId: TAB });
  assert.ok(state.scoutFoxGroupId, 'and the session must report the group it created');
});
