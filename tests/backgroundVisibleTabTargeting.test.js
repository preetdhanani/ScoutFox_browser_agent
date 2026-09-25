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
 * Now: the session's own tab if it can be scripted; else, if it is an empty new-tab page, that
 * same tab navigated in place; else a fresh tab opened immediately to the right of it. An
 * unrelated tab the user opened for their own purposes is never commandeered.
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakePort, sendMessage } from './helpers/fakePort.js';

const { ApiClients } = await import('../background/apiClients.js');

function makeMock() {
  const tabs = new Map();
  const createCalls = [];
  const updateCalls = [];
  const onUpdatedListeners = [];
  let tabCounter = 500;
  let groupCounter = 9000;
  let lastNavigatedTabId = null;
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
            setTimeout(() => fn(lastNavigatedTabId, { status: 'complete' }), 0);
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
          lastNavigatedTabId = id;
          const tab = { id, url: opts.url, groupId: -1, windowId: opts.windowId ?? 1, active: !!opts.active, index: opts.index ?? tabs.size };
          tabs.set(id, tab);
          if (opts.active) {
            for (const t of tabs.values()) t.active = t.id === id;
          }
          // Like Chrome: a tab handed back by create has not committed its navigation yet, so it
          // carries pendingUrl and no url. The stored tab (what tabs.get returns later) has both.
          const justCreated = { ...tab, url: undefined, pendingUrl: opts.url };
          if (cb) cb(justCreated);
          return Promise.resolve(justCreated);
        },
        update: (id, props, cb) => {
          updateCalls.push({ id, props });
          const tab = tabs.get(id);
          if (tab && props.active) {
            for (const t of tabs.values()) t.active = t.id === id;
          }
          if (tab && props.url) { tab.url = props.url; lastNavigatedTabId = id; }
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

// Tab 100 is a page that cannot be scripted and is not ours to navigate away from. Tab 200 is
// the user's own tab, deliberately scriptable - exactly what the old fallback commandeered.
mock.__addTab({ id: 100, url: 'chrome://settings/', index: 0, active: true });
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
    const state = await sendMessage(mock.__listeners, { action: 'GET_AGENT_STATE', tabId: 100 });
    if (state && state.status !== 'running') return state;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('the previous run never finished');
}

test('a restricted focused tab gets a fresh tab beside it - never the user\'s unrelated tab', async () => {
  mock.__createCalls.length = 0;
  mock.__updateCalls.length = 0;

  // The panel the user typed the task into, attached to tab 100. Its messages and the worker's
  // tab activations share one sequence, so the test can tell which came first.
  const sequence = [];
  const panelPort = makeFakePort('scoutfox_sidepanel_fresh:100');
  panelPort.postMessage = (msg) => { panelPort.received.push(msg); sequence.push(msg.type); };
  mock.__listeners.onConnect(panelPort);
  const realUpdate = mock.chrome.tabs.update;
  mock.chrome.tabs.update = (id, props, cb) => {
    if (props.active) sequence.push(`activate:${id}`);
    return realUpdate(id, props, cb);
  };

  const res = await sendMessage(mock.__listeners, {
    action: 'START_TASK', tabId: 100, payload: { prompt: 'find something' }
  });
  mock.chrome.tabs.update = realUpdate;

  assert.equal(res.success, true, 'the task must start');
  assert.notEqual(res.tabId, 200,
    'the user\'s own unrelated tab must never be commandeered for automation - that was the ' +
    'old [TAB_SUBSTITUTED] behaviour, and it ran invisibly in a tab they were not even looking at');

  assert.equal(mock.__createCalls.length, 1, 'exactly one fresh tab must be opened for the task');
  const created = mock.__createCalls[0];

  // Created in the BACKGROUND, then activated once it is grouped and the side panel is enabled
  // on it. The enable has to land first: the panel's handoff open() is rejected on a tab with no
  // panel enabled, and onActivated disables the panel on any tab outside a session.
  assert.equal(created.active, false,
    'the automation tab must be created in the background, so it can be grouped and have the panel enabled on it before it comes to the front');
  const activated = mock.__updateCalls.find((c) => c.id === res.tabId && c.props.active === true);
  assert.ok(activated,
    'the automation tab must still be brought to the front afterwards, or the run is invisible - deferring the activation must not mean skipping it');

  // Bringing another tab to the front hides a tab-scoped panel, and only a user gesture can show
  // one on the new tab. The worker has none, so the panel that submitted the task - which still
  // holds the Enter/click gesture - is told to reopen itself there. Checked in a real Chromium:
  // without this, the panel vanished the moment the task started.
  const handoff = panelPort.received.find((m) => m.type === 'PANEL_HANDOFF');
  assert.ok(handoff, 'the submitting panel must be asked to follow the run onto the new tab');
  assert.deepEqual(handoff.payload, { tabId: res.tabId, fromTabId: 100 },
    'the handoff must name the new tab, and the panel that submitted the task - only that panel holds the gesture');
  assert.ok(sequence.indexOf(`activate:${res.tabId}`) < sequence.indexOf('PANEL_HANDOFF'),
    'the handoff must come after the tab is brought to the front, so the reopened panel resolves the new tab as its own');

  assert.equal(created.index, 1,
    'the fresh tab must open immediately to the RIGHT of the focused tab (index 0), not appended to the far end of the strip');
  assert.equal(created.windowId, 1, 'it must open in the requesting panel\'s own window');
  assert.equal(mock.__tabs.get(res.tabId).url, 'https://www.google.com', 'the task must run in that fresh tab');
  assert.equal(res.tabUrl, 'https://www.google.com',
    'the panel must be told where the run started - a tab fresh out of tabs.create has only pendingUrl, which showed up as "unknown URL"');

  await waitUntilIdle();
});

test('a session whose own tab is scriptable uses it as-is, with no new tab opened', async () => {
  mock.__createCalls.length = 0;
  // A SECOND, independent session, on a tab of its own. This is the per-tab model: tab 300 has
  // its own panel and its own engine, and knows nothing about tab 100's session above.
  mock.__addTab({ id: 300, url: 'https://example.com/work', index: 2, active: true });

  const res = await sendMessage(mock.__listeners, {
    action: 'START_TASK', tabId: 300, payload: { prompt: 'work on this page' }
  });

  assert.equal(res.success, true, 'the task must start');
  assert.equal(res.tabId, 300,
    'a session runs in ITS OWN tab - the one its panel is attached to and the user is looking at');
  assert.equal(mock.__createCalls.length, 0, 'no extra tab should be opened when the session\'s own tab already works');

  await waitUntilIdle();
});

test('a session never reaches into a tab belonging to a different session', async () => {
  mock.__createCalls.length = 0;
  // Tab 300 (another session's tab) is scriptable and is the one in front of the user. Tab 100's
  // session must still not touch it: whose tab it is beats what happens to be focused.
  //
  // This is the guarantee that makes two tabs genuinely independent. The old window-keyed
  // version asked the WINDOW for its active tab, so starting a task in one tab could drive a
  // completely different tab's page - the user's mail, a half-filled form.
  for (const t of mock.__tabs.values()) t.active = t.id === 300;

  const res = await sendMessage(mock.__listeners, {
    action: 'START_TASK', tabId: 100, payload: { prompt: 'carry on' }
  });

  assert.equal(res.success, true, 'the task must start');
  assert.notEqual(res.tabId, 300, 'another session\'s tab must never be commandeered, focused or not');
  assert.notEqual(res.tabId, 200, 'and neither must a tab the user opened for themselves');

  await waitUntilIdle();
});

test('a follow-up task continues in the tab the run already moved into', async () => {
  mock.__createCalls.length = 0;
  mock.__updateCalls.length = 0;

  // The first test's run left this session owning an extra tab - the one getActiveTab opened
  // when tab 100 turned out to be chrome://settings. That tab is where the user is watching, so a
  // follow-up must carry on there rather than opening yet another one.
  const sessionTabs = Array.from(mock.__tabs.values()).filter((t) => t.groupId > 0);
  assert.ok(sessionTabs.length > 0, 'sanity check: the first run put at least one tab in the group');

  const res = await sendMessage(mock.__listeners, {
    action: 'START_TASK', tabId: 100, payload: { prompt: 'and now the next thing' }
  });

  assert.equal(res.success, true, 'the task must start');
  assert.ok(mock.__tabs.get(res.tabId).groupId > 0,
    'the reused tab must be one inside this session\'s own ScoutFox group, not an arbitrary window tab');
  assert.equal(mock.__createCalls.length, 0, 'no new tab is needed when the session already owns a scriptable one');

  await waitUntilIdle();
});

test('an empty new-tab page is reused in place - no second tab, so the side panel stays open', async () => {
  mock.__createCalls.length = 0;
  mock.__updateCalls.length = 0;
  // A brand-new window's first tab. Opening a tab beside it moves the active tab out from under
  // the tab-scoped panel and Chrome closes the panel - reproduced in a real Chromium.
  mock.__addTab({ id: 400, url: 'chrome://newtab/', index: 3, windowId: 2, active: true });

  const res = await sendMessage(mock.__listeners, {
    action: 'START_TASK', tabId: 400, payload: { prompt: 'find something' }
  });

  assert.equal(res.success, true, 'the task must start');
  assert.equal(res.tabId, 400, 'the task must run in the new-tab page the panel is attached to');
  assert.equal(mock.__createCalls.length, 0, 'no second tab may be opened for an empty page');
  assert.equal(mock.__tabs.get(400).url, 'https://www.google.com', 'the empty tab must be navigated in place');
  assert.ok(mock.__tabs.get(400).groupId > 0, 'the reused tab must join this session\'s ScoutFox group');

  await waitUntilIdle();
});
