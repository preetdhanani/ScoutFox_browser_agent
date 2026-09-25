/**
 * Tests for the per-TAB session model: each tab gets its own independent ScoutFox session (own
 * tab group, own history, own running task, own Stop/Pause), reopening the panel on a tab
 * reflects that tab's current session rather than resetting it, and the agent can only read/act
 * on tabs inside its OWN group - zero access outside it.
 *
 * Per tab, not per window, so two tabs side by side in the SAME window are as independent as two
 * tabs in different windows. That is the point of the model: start a task in one tab, open
 * another tab and start something completely unrelated, and neither disturbs the other.
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
        get session() { return this.local; }, // agent_sessions lives in storage.session; one backing store keeps seeds simple
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
        onRemoved: { addListener: (fn) => { listeners.onTabRemoved = fn; } },
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


test('two tabs in the SAME window get fully independent sessions', async () => {
  const WIN = 1;
  mock.__addTab(101, WIN, 'https://example.com/a');
  mock.__addTab(102, WIN, 'https://example.com/b');

  const portA = makeFakePort('scoutfox_sidepanel_fresh:101');
  mock.__listeners.onConnect(portA);
  await new Promise((r) => setTimeout(r, 20));

  const portB = makeFakePort('scoutfox_sidepanel_fresh:102');
  mock.__listeners.onConnect(portB);
  await new Promise((r) => setTimeout(r, 20));

  assert.deepEqual(lastStateUpdate(portA).payload.history, []);
  assert.deepEqual(lastStateUpdate(portB).payload.history, []);

  const startRes = await sendMessage(mock.__listeners, { action: 'START_TASK', tabId: 101, payload: { prompt: 'task for tab 101 only' } });
  assert.equal(startRes.success, true);
  assert.equal(startRes.tabId, 101, 'a task must run in the tab whose panel started it, never a neighbouring tab');

  await new Promise((r) => setTimeout(r, 20));

  const stateA = await sendMessage(mock.__listeners, { action: 'GET_AGENT_STATE', tabId: 101 });
  const stateB = await sendMessage(mock.__listeners, { action: 'GET_AGENT_STATE', tabId: 102 });

  assert.equal(stateA.task, 'task for tab 101 only', 'tab 101\'s own session must show the task it started');
  assert.equal(stateB.task, null,
    'tab 102\'s session must be completely untouched - same window, but a different session entirely');
  assert.notEqual(stateA.bootId, undefined);

  portA._disconnect();
  portB._disconnect();
});

test('two tabs in DIFFERENT windows are independent too, with their own tab groups', async () => {
  mock.__addTab(201, 2, 'https://example.com/c');
  mock.__addTab(301, 3, 'https://example.com/d');

  const portA = makeFakePort('scoutfox_sidepanel_fresh:201');
  mock.__listeners.onConnect(portA);
  const portB = makeFakePort('scoutfox_sidepanel_fresh:301');
  mock.__listeners.onConnect(portB);
  await new Promise((r) => setTimeout(r, 20));

  await sendMessage(mock.__listeners, { action: 'START_TASK', tabId: 201, payload: { prompt: 'window 2 task' } });
  await sendMessage(mock.__listeners, { action: 'START_TASK', tabId: 301, payload: { prompt: 'window 3 task' } });
  await new Promise((r) => setTimeout(r, 20));

  const stateA = await sendMessage(mock.__listeners, { action: 'GET_AGENT_STATE', tabId: 201 });
  const stateB = await sendMessage(mock.__listeners, { action: 'GET_AGENT_STATE', tabId: 301 });

  assert.equal(stateA.task, 'window 2 task');
  assert.equal(stateB.task, 'window 3 task');
  assert.notEqual(stateA.scoutFoxGroupId, stateB.scoutFoxGroupId,
    'each session must get its OWN tab group, never a shared one - and a Chrome group cannot span windows anyway');

  portA._disconnect();
  portB._disconnect();
});

test('reopening the panel on a tab reflects that tab\'s current session, not a reset', async () => {
  mock.__addTab(401, 4, 'https://example.com/e');

  const port1 = makeFakePort('scoutfox_sidepanel_fresh:401');
  mock.__listeners.onConnect(port1);
  await new Promise((r) => setTimeout(r, 20));

  await sendMessage(mock.__listeners, { action: 'START_TASK', tabId: 401, payload: { prompt: 'a real task' } });
  await new Promise((r) => setTimeout(r, 20));

  // Panel closes (worker not necessarily killed), then the SAME tab's panel reopens later.
  // From the reopening document's own point of view this is a genuine, honest fresh connect.
  port1._disconnect();

  const port2 = makeFakePort('scoutfox_sidepanel_fresh:401');
  mock.__listeners.onConnect(port2);
  await new Promise((r) => setTimeout(r, 20));

  const reopened = lastStateUpdate(port2);
  assert.equal(reopened.payload.task, 'a real task',
    'reopening the panel on a tab must show the session that is actually there, not silently reset it');

  port2._disconnect();
});

test('a brand new tab opening the extension starts its own blank session', async () => {
  mock.__addTab(501, 5, 'https://example.com/f');
  mock.__addTab(502, 5, 'https://example.com/g');

  const portExisting = makeFakePort('scoutfox_sidepanel_fresh:501');
  mock.__listeners.onConnect(portExisting);
  await new Promise((r) => setTimeout(r, 20));
  await sendMessage(mock.__listeners, { action: 'START_TASK', tabId: 501, payload: { prompt: 'existing tab task' } });
  await new Promise((r) => setTimeout(r, 20));

  const portNew = makeFakePort('scoutfox_sidepanel_fresh:502');
  mock.__listeners.onConnect(portNew);
  await new Promise((r) => setTimeout(r, 20));

  assert.deepEqual(lastStateUpdate(portNew).payload.history, [],
    'a brand new tab opening the extension must start blank, not see the neighbouring tab\'s session');
  assert.equal(lastStateUpdate(portNew).payload.task, null);

  portExisting._disconnect();
  portNew._disconnect();
});

test('the hard access wall: a session cannot read a tab outside its own ScoutFox group', async () => {
  const { AgentEngine } = await import('../background/agentEngine.js');
  // Session owned by tab 1001, which lives in window 10.
  const engineA = new AgentEngine(1001, 10);
  await engineA.restorePromise;
  engineA.scoutFoxGroupIds.set(10, 7000); // window 10's own group

  mock.__addTab(1001, 10, 'https://example.com/mine', 7000);   // inside this session's own group
  mock.__addTab(1002, 11, 'https://example.com/theirs', 8000); // a DIFFERENT group entirely

  assert.equal(await engineA.isTabInScope(1001), true, 'a tab inside this session\'s own group must be in scope');
  assert.equal(await engineA.isTabInScope(1002), false, 'a tab in a DIFFERENT group must never be in scope');

  await assert.rejects(
    () => engineA.getTabDOMWithAutoInject(1002, false),
    /outside this session's ScoutFox group/,
    'acting on a tab outside this session\'s group must be refused outright, not silently succeed'
  );
});

test('closing a tab ends its session and forgets its persisted state', async () => {
  mock.__addTab(601, 6, 'https://example.com/h');

  const port = makeFakePort('scoutfox_sidepanel_fresh:601');
  mock.__listeners.onConnect(port);
  await new Promise((r) => setTimeout(r, 20));
  await sendMessage(mock.__listeners, { action: 'START_TASK', tabId: 601, payload: { prompt: 'about to close' } });
  await new Promise((r) => setTimeout(r, 20));

  assert.ok(mock.__storage.agent_sessions && mock.__storage.agent_sessions['601'],
    'the tab\'s session must actually be persisted before it closes - that is what survives a worker restart');

  port._disconnect();

  assert.equal(typeof mock.__listeners.onTabRemoved, 'function',
    'background.js must register a chrome.tabs.onRemoved listener to clean up closed sessions');
  mock.__listeners.onTabRemoved(601);
  await new Promise((r) => setTimeout(r, 20));

  assert.ok(!mock.__storage.agent_sessions['601'],
    'a closed tab\'s persisted session must be removed, not left behind indefinitely');

  // A brand new port for that SAME tab id, after it closed, must be treated as a totally fresh
  // session (no leftover in-memory engine either) rather than resurrecting the old one. Chrome
  // does reuse tab ids, so this is a real scenario, not a hypothetical.
  const portAfter = makeFakePort('scoutfox_sidepanel_fresh:601');
  mock.__listeners.onConnect(portAfter);
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(lastStateUpdate(portAfter).payload.task, null,
    'a new tab reusing that id must not inherit the closed session');
  portAfter._disconnect();
});
