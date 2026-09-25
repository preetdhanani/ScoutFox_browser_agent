/**
 * Tests for the per-window session model: each browser window gets its own independent
 * ScoutFox session (own tab group, own history, own running task, own Stop/Pause), reopening
 * the panel on a tab already in a window's group reflects that window's current session rather
 * than resetting it, and the agent can only read/act on tabs inside its OWN window's group -
 * zero access outside it.
 *
 * Imports the real background.js, not a reimplementation - see the other background*.test.js
 * files in this suite for why that distinction matters here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeFakePort, lastStateUpdate, sendMessage } from './helpers/fakePort.js';

function makeMultiWindowMock() {
  const tabs = new Map();
  const storage = {};
  let groupCounter = 9000;
  const groupTitles = new Map(); // groupId -> title, so ensureScoutFoxGroup's own-title check works
  const listeners = {};
  const noop = () => {};
  const listener = () => ({ addListener: noop });

  function addTab(id, windowId, url, groupId = -1) {
    tabs.set(id, { id, windowId, url, groupId });
  }

  return {
    __tabs: tabs,
    __storage: storage,
    __listeners: listeners,
    __addTab: addTab,
    __groupTitles: groupTitles,
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
          remove: (keys, cb) => { (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete storage[k]); if (cb) cb(); }
        }
      },
      tabs: {
        onRemoved: listener(),
        onActivated: listener(),
        onCreated: listener(),
        onUpdated: listener(),
        // Supports both call styles real chrome.tabs.get does: callback, or promise when none
        // is given (getTabDOMWithAutoInject's own first call uses the promise form).
        get: (id, cb) => {
          const t = tabs.get(id);
          if (cb) { cb(t); return undefined; }
          return Promise.resolve(t);
        },
        // Supports both call styles: getActiveTab in background.js uses the promise form
        // (no callback) throughout - this predates the per-window work, not new here.
        query: (q, cb) => {
          let list = Array.from(tabs.values());
          if (q.windowId !== undefined) list = list.filter((t) => t.windowId === q.windowId);
          if (q.groupId !== undefined) list = list.filter((t) => t.groupId === q.groupId);
          if (q.active) list = list.slice(0, 1); // one "active" tab per query is enough for these tests
          if (cb) { cb(list); return undefined; }
          return Promise.resolve(list);
        },
        group: (opts, cb) => {
          const ids = Array.isArray(opts.tabIds) ? opts.tabIds : [opts.tabIds];
          const gid = opts.groupId !== undefined ? opts.groupId : groupCounter++;
          ids.forEach((id) => { const t = tabs.get(id); if (t) t.groupId = gid; });
          cb(gid);
        }
      },
      tabGroups: {
        onRemoved: listener(),
        get: (id, cb) => cb(groupTitles.has(id) ? { id, title: groupTitles.get(id) } : undefined),
        update: (id, opts, cb) => { if (opts && opts.title) groupTitles.set(id, opts.title); if (cb) cb(); }
      },
      windows: { onRemoved: { addListener: (fn) => { listeners.onWindowRemoved = fn; } } },
      alarms: { create: noop, clear: noop, get: (n, cb) => cb(null), onAlarm: listener() },
      action: { onClicked: listener() },
      declarativeNetRequest: { updateSessionRules: () => Promise.resolve() },
      sidePanel: { setPanelBehavior: () => Promise.resolve(), setOptions: (opts, cb) => cb && cb(), open: () => Promise.resolve() }
    }
  };
}

global.self = { addEventListener: () => {} };
const mock = makeMultiWindowMock();
global.chrome = mock.chrome;

await import('../background/background.js');


test('two windows get fully independent sessions - starting a task in one never touches the other', async () => {
  const WIN_A = 1, WIN_B = 2;
  mock.__addTab(101, WIN_A, 'https://example.com/a');
  mock.__addTab(201, WIN_B, 'https://example.com/b');

  const portA = makeFakePort('scoutfox_sidepanel_fresh:1');
  mock.__listeners.onConnect(portA);
  await new Promise((r) => setTimeout(r, 20));

  const portB = makeFakePort('scoutfox_sidepanel_fresh:2');
  mock.__listeners.onConnect(portB);
  await new Promise((r) => setTimeout(r, 20));

  // Both are genuinely solitary within their OWN window, so both cleared to a blank session -
  // neither one being "fresh" collided with the other, because they are different windows.
  assert.deepEqual(lastStateUpdate(portA).payload.history, []);
  assert.deepEqual(lastStateUpdate(portB).payload.history, []);

  const startRes = await sendMessage(mock.__listeners, { action: 'START_TASK', windowId: WIN_A, payload: { prompt: 'task for window A only' } });
  assert.equal(startRes.success, true);
  assert.equal(startRes.tabId, 101, 'START_TASK with windowId=1 must resolve a tab INSIDE window 1, never window 2\'s tab');

  await new Promise((r) => setTimeout(r, 20));

  const stateA = await sendMessage(mock.__listeners, { action: 'GET_AGENT_STATE', windowId: WIN_A });
  const stateB = await sendMessage(mock.__listeners, { action: 'GET_AGENT_STATE', windowId: WIN_B });

  assert.equal(stateA.task, 'task for window A only', 'window A\'s own session must show the task it started');
  assert.equal(stateB.task, null, 'window B\'s session must be completely untouched by window A\'s task');
  assert.notEqual(stateA.bootId, undefined);
  assert.notEqual(stateA.scoutFoxGroupId, stateB.scoutFoxGroupId, 'each window must get its OWN tab group, never a shared one');

  portA._disconnect();
  portB._disconnect();
});

test('reopening the panel on a tab already in the window\'s group reflects the current session, not a reset', async () => {
  const WIN = 3;
  mock.__addTab(301, WIN, 'https://example.com/c');

  const port1 = makeFakePort('scoutfox_sidepanel_fresh:3');
  mock.__listeners.onConnect(port1);
  await new Promise((r) => setTimeout(r, 20));

  await sendMessage(mock.__listeners, { action: 'START_TASK', windowId: WIN, payload: { prompt: 'a real task' } });
  await new Promise((r) => setTimeout(r, 20));

  // Panel closes (worker not necessarily killed), then the SAME window's panel reopens later.
  // From the reopening document's own point of view this is a genuine, honest fresh connect.
  port1._disconnect();

  const port2 = makeFakePort('scoutfox_sidepanel_fresh:3');
  mock.__listeners.onConnect(port2);
  await new Promise((r) => setTimeout(r, 20));

  const reopened = lastStateUpdate(port2);
  assert.equal(reopened.payload.task, 'a real task',
    'reopening the panel on a tab already in this window\'s group must show the session that is actually there, not silently reset it');

  port2._disconnect();
});

test('a second, genuinely NEW window opening the extension starts its own blank session unaffected by an existing one', async () => {
  const WIN_EXISTING = 4, WIN_NEW = 5;
  mock.__addTab(401, WIN_EXISTING, 'https://example.com/d');
  mock.__addTab(501, WIN_NEW, 'https://example.com/e');

  const portExisting = makeFakePort('scoutfox_sidepanel_fresh:4');
  mock.__listeners.onConnect(portExisting);
  await new Promise((r) => setTimeout(r, 20));
  await sendMessage(mock.__listeners, { action: 'START_TASK', windowId: WIN_EXISTING, payload: { prompt: 'existing window task' } });
  await new Promise((r) => setTimeout(r, 20));

  const portNew = makeFakePort('scoutfox_sidepanel_fresh:5');
  mock.__listeners.onConnect(portNew);
  await new Promise((r) => setTimeout(r, 20));

  assert.deepEqual(lastStateUpdate(portNew).payload.history, [],
    'a brand new window opening the extension must start blank, not see the other window\'s session');
  assert.equal(lastStateUpdate(portNew).payload.task, null);

  portExisting._disconnect();
  portNew._disconnect();
});

test('the hard access wall: a session cannot read a tab outside its own ScoutFox group', async () => {
  const { AgentEngine } = await import('../background/agentEngine.js');
  const engineA = new AgentEngine(10);
  await engineA.restorePromise;
  engineA.scoutFoxGroupIds.set(10, 7000); // window 10's own group

  mock.__addTab(1001, 10, 'https://example.com/mine', 7000);   // inside window 10's own group
  mock.__addTab(1002, 11, 'https://example.com/theirs', 8000); // a DIFFERENT window's group entirely

  assert.equal(await engineA.isTabInScope(1001), true, 'a tab inside this session\'s own group must be in scope');
  assert.equal(await engineA.isTabInScope(1002), false, 'a tab in a DIFFERENT window\'s group must never be in scope');

  await assert.rejects(
    () => engineA.getTabDOMWithAutoInject(1002, false),
    /outside this session's ScoutFox group/,
    'acting on a tab outside this session\'s group must be refused outright, not silently succeed'
  );
});

test('closing a window ends its session and forgets its persisted state', async () => {
  const WIN = 6;
  mock.__addTab(601, WIN, 'https://example.com/f');

  const port = makeFakePort('scoutfox_sidepanel_fresh:6');
  mock.__listeners.onConnect(port);
  await new Promise((r) => setTimeout(r, 20));
  await sendMessage(mock.__listeners, { action: 'START_TASK', windowId: WIN, payload: { prompt: 'about to close' } });
  await new Promise((r) => setTimeout(r, 20));

  assert.ok(mock.__storage.agent_sessions && mock.__storage.agent_sessions['6'],
    'the window\'s session must actually be persisted before it closes');

  port._disconnect();

  assert.equal(typeof mock.__listeners.onWindowRemoved, 'function',
    'background.js must register a chrome.windows.onRemoved listener to clean up closed sessions');
  mock.__listeners.onWindowRemoved(WIN);
  await new Promise((r) => setTimeout(r, 20));

  assert.ok(!mock.__storage.agent_sessions['6'],
    'a closed window\'s persisted session must be removed, not left behind indefinitely');

  // A brand new port for that SAME window id, after it closed, must be treated as a totally
  // fresh session (no leftover in-memory engine either) rather than resurrecting the old one.
  const reopened = makeFakePort('scoutfox_sidepanel_fresh:6');
  mock.__listeners.onConnect(reopened);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(lastStateUpdate(reopened).payload.task, null,
    'a new session for a window id that previously closed must not remember the old task');

  reopened._disconnect();
});
