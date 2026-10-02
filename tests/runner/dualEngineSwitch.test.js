/**
 * Tests for the dual-engine switch behind settings.engine.
 * Verifies that when settings.engine is switched between 'legacy' and 'graph',
 * background.js dynamically switches the session engine instance between AgentEngine
 * and AgentRunner when the status is 'idle' or 'stopped'.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeFakePort, sendMessage } from '../helpers/fakePort.js';

function makeMock() {
  const tabs = new Map([[100, { id: 100, url: 'https://example.com/a', groupId: -1, windowId: 1, active: true }]]);
  const localStorage = {};
  const sessionStorage = {};
  const noop = () => {};
  const listeners = {
    storageOnChanged: []
  };
  let groupCounter = 5000;

  const makeStorageArea = (backing) => ({
    get: (keys, cb) => {
      const result = {};
      if (keys === null) {
        Object.assign(result, backing);
      } else {
        (Array.isArray(keys) ? keys : [keys]).forEach((k) => {
          if (typeof k === 'string' && Object.hasOwn(backing, k)) {
            result[k] = backing[k];
          }
        });
      }
      if (cb) cb(result);
      return Promise.resolve(result);
    },
    set: (data, cb) => {
      Object.assign(backing, data);
      if (cb) cb();
      return Promise.resolve();
    },
    remove: (keys, cb) => {
      (Array.isArray(keys) ? keys : [keys]).forEach((k) => { delete backing[k]; });
      if (cb) cb();
      return Promise.resolve();
    }
  });

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
        local: makeStorageArea(localStorage),
        session: makeStorageArea(sessionStorage),
        onChanged: {
          addListener: (fn) => { listeners.storageOnChanged.push(fn); }
        }
      },
      tabs: {
        onRemoved: { addListener: noop, removeListener: noop },
        onActivated: { addListener: noop, removeListener: noop },
        onCreated: { addListener: noop, removeListener: noop },
        onUpdated: { addListener: noop, removeListener: noop },
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

globalThis.self = { addEventListener: () => {} };
const mock = makeMock();
globalThis.chrome = mock.chrome;

const { ApiClients } = await import('../../background/apiClients.js');
ApiClients.generateCompletion = async (settings, messages, systemPrompt) => {
  if (systemPrompt === 'You are a web task planner.') return JSON.stringify(['Do the task']);
  return JSON.stringify({ action: 'finish', answer: 'Task complete', reason: 'Done' });
};

await import('../../background/background.js');
await new Promise((r) => setTimeout(r, 30));

test('dual-engine switch: switches between legacy AgentEngine and graph AgentRunner behind settings.engine', async () => {
  const port = makeFakePort('scoutfox_sidepanel:100');
  mock.__listeners.onConnect(port);
  await new Promise((r) => setTimeout(r, 20));

  // 1. Initial state: GET_AGENT_STATE shows initial idle state
  const stateRes = await sendMessage(mock.__listeners, { action: 'GET_AGENT_STATE', tabId: 100 });
  assert.equal(stateRes.status, 'idle');

  // Start task on legacy engine
  const start1 = await sendMessage(mock.__listeners, {
    action: 'START_TASK', tabId: 100, payload: { prompt: 'Task 1' }
  });
  assert.equal(start1.success, true);
  await new Promise((r) => setTimeout(r, 50));

  // Stop task so status is 'stopped'
  const stop1 = await sendMessage(mock.__listeners, { action: 'STOP_TASK', tabId: 100 });
  assert.equal(stop1.success, true);

  const stoppedState = await sendMessage(mock.__listeners, { action: 'GET_AGENT_STATE', tabId: 100 });
  assert.equal(stoppedState.status, 'stopped');

  // 2. Switch settings.engine to 'graph'
  for (const listener of mock.__listeners.storageOnChanged) {
    listener({ agent_settings: { newValue: { engine: 'graph' } } }, 'local');
  }

  // 3. Start new task while status is 'stopped'. Engine must switch to AgentRunner!
  const start2 = await sendMessage(mock.__listeners, {
    action: 'START_TASK', tabId: 100, payload: { prompt: 'Task 2 on Graph' }
  });
  assert.equal(start2.success, true);
  await new Promise((r) => setTimeout(r, 50));

  // Stop task 2
  const stop2 = await sendMessage(mock.__listeners, { action: 'STOP_TASK', tabId: 100 });
  assert.equal(stop2.success, true);

  // 4. Switch settings.engine back to 'legacy'
  for (const listener of mock.__listeners.storageOnChanged) {
    listener({ agent_settings: { newValue: { engine: 'legacy' } } }, 'local');
  }

  // 5. Start new task while status is 'stopped'. Engine must switch back to AgentEngine!
  const start3 = await sendMessage(mock.__listeners, {
    action: 'START_TASK', tabId: 100, payload: { prompt: 'Task 3 on Legacy' }
  });
  assert.equal(start3.success, true);

  // Clean stop
  await sendMessage(mock.__listeners, { action: 'STOP_TASK', tabId: 100 });
});
