/**
 * Regression tests for a real user report: a task ran to completion ("Opened google.com",
 * "finish") while the user sat watching a tab where nothing happened.
 *
 * getActiveTab()'s old third fallback searched the window for any scriptable tab and ran
 * against the FIRST one in tab-strip order, without ever activating it. So clicking the icon
 * on chrome://newtab (an entirely ordinary starting point) handed the agent whatever unrelated
 * tab the user happened to have open - their mail, a half-filled form - and drove it invisibly,
 * several positions away in the strip.
 *
 * Now: the focused tab if it can be scripted; else this session's OWN group tab, brought to
 * the front; else a fresh tab opened immediately to the right of the focused one. An unrelated
 * tab the user opened for their own purposes is never commandeered.
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { sendMessage } from './helpers/fakePort.js';

const { ApiClients } = await import('../background/apiClients.js');

function makeMock() {
  const tabs = new Map();
  const createCalls = [];
  const updateCalls = [];
  const onUpdatedListeners = [];
  let tabCounter = 500;
  let groupCounter = 9000;
  let lastCreatedTabId = null;
  const noop = () => {};
  const listeners = {};
  const storage = {};

  const matches = (tab, q = {}) => {
    if (q.windowId !== undefined && tab.windowId !== q.windowId) return false;
    if (q.active !== undefined && !!tab.active !== !!q.active) return false;
    if (q.groupId !== undefined && tab.groupId !== q.groupId) return false;
    if (q.currentWindow !== undefined && tab.windowId !== 1) return false;
    if (q.lastFocusedWindow !== undefined && tab.windowId !== 1) return false;
    return true;
  };

  return {
    __tabs: tabs,
    __listeners: listeners,
    __createCalls: createCalls,
    __updateCalls: updateCalls,
    __addTab: (t) => { tabs.set(t.id, { groupId: -1, windowId: 1, active: false, ...t }); },
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
        onActivated: { addListener: (fn) => { listeners.onActivated = fn; } },
        onCreated: { addListener: (fn) => { listeners.onCreated = fn; } },
        onUpdated: {
          addListener: (fn) => {
            onUpdatedListeners.push(fn);
            // waitForTabComplete() waits for a 'complete' update on the tab it was handed, or
            // times out after 4s - fire immediately so these tests don't sit through that.
            setTimeout(() => fn(lastCreatedTabId, { status: 'complete' }), 0);
          },
          removeListener: (fn) => {
            const i = onUpdatedListeners.indexOf(fn);
            if (i >= 0) onUpdatedListeners.splice(i, 1);
          },
          hasListener: (fn) => onUpdatedListeners.includes(fn)
        },
        query: (q, cb) => {
          const list = Array.from(tabs.values()).filter((t) => matches(t, q));
          if (cb) { cb(list); return; }
          return Promise.resolve(list);
        },
        // getTabDOMWithAutoInject() awaits this with no callback; isTabInScope() passes one.
        get: (id, cb) => {
          const tab = tabs.get(id);
          if (cb) { cb(tab); return; }
          return Promise.resolve(tab);
        },
        create: (opts, cb) => {
          createCalls.push({ ...opts });
          const id = ++tabCounter;
          lastCreatedTabId = id;
          const tab = { id, url: opts.url, groupId: -1, windowId: opts.windowId ?? 1, active: !!opts.active, index: opts.index ?? tabs.size };
          tabs.set(id, tab);
          if (opts.active) {
            for (const t of tabs.values()) t.active = t.id === id;
          }
          if (cb) cb(tab);
          return Promise.resolve(tab);
        },
        update: (id, props, cb) => {
          updateCalls.push({ id, props });
          const tab = tabs.get(id);
          if (tab && props.active) {
            for (const t of tabs.values()) t.active = t.id === id;
          }
          if (tab && props.url) tab.url = props.url;
          if (cb) cb(tab);
          return Promise.resolve(tab);
        },
        group: (opts, cb) => {
          const gid = opts.groupId || ++groupCounter;
          const ids = Array.isArray(opts.tabIds) ? opts.tabIds : [opts.tabIds];
          ids.forEach((id) => { const t = tabs.get(id); if (t) t.groupId = gid; });
          if (cb) cb(gid);
          return Promise.resolve(gid);
        },
        sendMessage: (tabId, msg, cb) => cb({
          success: true,
          data: {
            title: 'Test Page', url: tabs.get(tabId)?.url || 'https://example.com',
            scrollState: { scrollY: 0, pageHeight: 800, viewportHeight: 800 },
            elements: [], elementsText: '', elementCount: 0, pageText: ''
          }
        })
      },
      tabGroups: {
        onRemoved: { addListener: noop },
        get: (id, cb) => cb({ id, title: 'ScoutFox' }),
        update: (id, opts, cb) => cb && cb()
      },
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

// The user's own tab, sitting in the same window. Index 1, deliberately scriptable - this is
// exactly what the old fallback would have commandeered.
mock.__addTab({ id: 100, url: 'chrome://newtab/', index: 0, active: true });
mock.__addTab({ id: 200, url: 'https://mail.example.com/inbox', index: 1 });

await import('../background/background.js');
await new Promise((r) => setTimeout(r, 20));

// Finish on the first step so each run completes cleanly instead of leaving the keepalive
// interval holding this process open.
const realGenerateCompletion = ApiClients.generateCompletion;
ApiClients.generateCompletion = async (settings, messages, systemPrompt) => {
  if (systemPrompt === 'You are a web task planner.') return JSON.stringify(['Do the thing']);
  return JSON.stringify({ action: 'finish', answer: 'done', reason: 'test' });
};
after(() => { ApiClients.generateCompletion = realGenerateCompletion; });

/**
 * All tests in this file share one background.js instance (one process, one sessions Map), so
 * a run still finishing from the previous test would make the next START_TASK be refused
 * outright by claimForTask(). Poll for genuine completion rather than guessing a fixed delay.
 */
async function waitUntilIdle(timeoutMs = 3000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const state = await sendMessage(mock.__listeners, { action: 'GET_AGENT_STATE', windowId: 1 });
    if (state && state.status !== 'running') return state;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('the previous run never finished');
}

test('a restricted focused tab gets a fresh tab beside it - never the user\'s unrelated tab', async () => {
  mock.__createCalls.length = 0;

  const res = await sendMessage(mock.__listeners, {
    action: 'START_TASK', windowId: 1, payload: { prompt: 'find something' }
  });

  assert.equal(res.success, true, 'the task must start');
  assert.notEqual(res.tabId, 200,
    'the user\'s own unrelated tab must never be commandeered for automation - that was the ' +
    'old [TAB_SUBSTITUTED] behaviour, and it ran invisibly in a tab they were not even looking at');

  assert.equal(mock.__createCalls.length, 1, 'exactly one fresh tab must be opened for the task');
  const created = mock.__createCalls[0];
  assert.equal(created.active, true, 'the automation tab must come to the front, or the run is invisible');
  assert.equal(created.index, 1,
    'the fresh tab must open immediately to the RIGHT of the focused tab (index 0), not appended to the far end of the strip');
  assert.equal(created.windowId, 1, 'it must open in the requesting panel\'s own window');
  assert.equal(mock.__tabs.get(res.tabId).url, 'https://www.google.com', 'the task must run in that fresh tab');

  await waitUntilIdle();
});

test('a scriptable focused tab is used as-is, with no new tab opened', async () => {
  mock.__createCalls.length = 0;
  mock.__addTab({ id: 300, url: 'https://example.com/work', index: 2 });
  for (const t of mock.__tabs.values()) t.active = t.id === 300;

  const res = await sendMessage(mock.__listeners, {
    action: 'START_TASK', windowId: 1, payload: { prompt: 'work on this page' }
  });

  assert.equal(res.success, true, 'the task must start');
  assert.equal(res.tabId, 300, 'the tab the user is actually looking at must be the one automated');
  assert.equal(mock.__createCalls.length, 0, 'no extra tab should be opened when the focused tab already works');

  await waitUntilIdle();
});

test('this session\'s own group tab is brought to the front rather than driven in the background', async () => {
  mock.__createCalls.length = 0;
  mock.__updateCalls.length = 0;

  // Previous runs have left this session with a group containing scriptable tabs. The user has
  // since switched back to the restricted tab, so nothing in front of them can be automated.
  const grouped = Array.from(mock.__tabs.values()).filter((t) => t.groupId > 0);
  assert.ok(grouped.length > 0, 'sanity check: the runs above put at least one tab in the group');
  for (const t of mock.__tabs.values()) t.active = t.id === 100;

  const res = await sendMessage(mock.__listeners, {
    action: 'START_TASK', windowId: 1, payload: { prompt: 'carry on' }
  });

  assert.equal(res.success, true, 'the task must start');
  assert.notEqual(res.tabId, 200, 'the user\'s unrelated tab must still never be picked');
  assert.ok(mock.__tabs.get(res.tabId).groupId > 0,
    'the reused tab must be one inside this session\'s own ScoutFox group, not an arbitrary window tab');
  assert.equal(mock.__createCalls.length, 0, 'no new tab is needed when the session already owns a scriptable one');

  const activated = mock.__updateCalls.find((c) => c.id === res.tabId && c.props.active === true);
  assert.ok(activated,
    'that tab must be activated so the user can SEE the run - driving a background tab is what made a completed run look like nothing happened');

  await waitUntilIdle();
});
