/**
 * Regression tests for a real user report: with ScoutFox's tab group open, opening a new tab
 * of their own next to it silently made that tab part of the automation sandbox.
 *
 * chrome.tabs.onCreated adopted EVERY newly created tab in any window that had a session:
 * it grouped the tab into the ScoutFox group, and - if a run was in progress - retargeted the
 * agent onto it 500ms later. So a tab the user opened for themselves mid-run could have the
 * agent start clicking around in it.
 *
 * Chrome sets openerTabId on a tab opened BY another tab (a target="_blank" link the agent
 * clicked, window.open from a page it drives). A tab whose opener is the very tab the agent is
 * working in is the agent's own; a Cmd+T tab carries no opener, and a link the user clicked
 * elsewhere carries that other tab. Adoption is now gated on exactly that.
 *
 * Drives the REAL onCreated listener in background.js - the tests this replaces used a
 * hand-rolled simulateTabCreated() helper in tabGrouping.test.js that re-implemented (a since
 * outdated copy of) this logic and so could not have caught any of it.
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { sendMessage } from './helpers/fakePort.js';

const { ApiClients } = await import('../background/apiClients.js');

const AUTOMATED_TAB = 100;   // the tab the agent is driving
const UNRELATED_TAB = 200;   // a tab of the user's own, in the same window

function makeMock() {
  const tabs = new Map();
  const groupCalls = [];
  const getCalls = [];
  const ungroupCalls = [];
  const onUpdatedListeners = [];
  let groupCounter = 9000;
  const noop = () => {};
  const listeners = {};
  const storage = {};

  return {
    __tabs: tabs,
    __listeners: listeners,
    __groupCalls: groupCalls,
    __getCalls: getCalls,
    __ungroupCalls: ungroupCalls,
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
          addListener: (fn) => { onUpdatedListeners.push(fn); },
          removeListener: (fn) => {
            const i = onUpdatedListeners.indexOf(fn);
            if (i >= 0) onUpdatedListeners.splice(i, 1);
          },
          hasListener: (fn) => onUpdatedListeners.includes(fn)
        },
        query: (q = {}, cb) => {
          let list = Array.from(tabs.values());
          if (q.windowId !== undefined) list = list.filter((t) => t.windowId === q.windowId);
          if (q.active !== undefined) list = list.filter((t) => !!t.active === !!q.active);
          if (q.groupId !== undefined) list = list.filter((t) => t.groupId === q.groupId);
          if (cb) { cb(list); return; }
          return Promise.resolve(list);
        },
        get: (id, cb) => {
          getCalls.push(id);
          const tab = tabs.get(id);
          if (cb) { cb(tab); return; }
          return Promise.resolve(tab);
        },
        create: (opts, cb) => { if (cb) cb({ id: 999, ...opts }); },
        update: (id, props, cb) => {
          const tab = tabs.get(id);
          if (tab && props.active) for (const t of tabs.values()) t.active = t.id === id;
          if (cb) cb(tab);
          return Promise.resolve(tab);
        },
        group: (opts, cb) => {
          groupCalls.push({ ...opts });
          const gid = opts.groupId || ++groupCounter;
          const ids = Array.isArray(opts.tabIds) ? opts.tabIds : [opts.tabIds];
          ids.forEach((id) => { const t = tabs.get(id); if (t) t.groupId = gid; });
          if (cb) cb(gid);
          return Promise.resolve(gid);
        },
        ungroup: (tabIds, cb) => {
          const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
          ids.forEach((id) => {
            ungroupCalls.push(id);
            const t = tabs.get(id);
            if (t) t.groupId = -1;
          });
          if (cb) cb();
          return Promise.resolve();
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

mock.__addTab({ id: AUTOMATED_TAB, url: 'https://example.com/work', index: 0, active: true });
mock.__addTab({ id: UNRELATED_TAB, url: 'https://mail.example.com/inbox', index: 1 });

await import('../background/background.js');
await new Promise((r) => setTimeout(r, 20));

// Hang on the first step's action call so the run stays genuinely 'running' with activeTabId
// pinned to AUTOMATED_TAB for the whole file - that is the state the adoption gate reads.
const realGenerateCompletion = ApiClients.generateCompletion;
ApiClients.generateCompletion = async (settings, messages, systemPrompt) => {
  if (systemPrompt === 'You are a web task planner.') return JSON.stringify(['Do the thing']);
  return new Promise(() => {});
};
after(async () => {
  ApiClients.generateCompletion = realGenerateCompletion;
  // The stub never resolves, so the loop is stuck awaiting it and the KEEPALIVE_ON interval
  // would keep this process alive forever. STOP_TASK moves status off running, which is all
  // syncKeepaliveAlarm() checks.
  await sendMessage(mock.__listeners, { action: 'STOP_TASK', tabId: 100 });
});

// One real run, started once, left running for every test below.
const started = await sendMessage(mock.__listeners, {
  action: 'START_TASK', tabId: 100, payload: { prompt: 'do a thing' }
});
await new Promise((r) => setTimeout(r, 40));

test('the run is genuinely live on the expected tab (setup sanity check)', async () => {
  assert.equal(started.success, true, 'the task must have started');
  assert.equal(started.tabId, AUTOMATED_TAB, 'it must be driving the focused, scriptable tab');
  const state = await sendMessage(mock.__listeners, { action: 'GET_AGENT_STATE', tabId: 100 });
  assert.equal(state.status, 'running', 'the adoption gate reads activeTabId on a running session');
  assert.ok(mock.__tabs.get(AUTOMATED_TAB).groupId > 0, 'the automated tab must be in the ScoutFox group');
});

test('a tab the AGENT opened (opener is the tab it drives) is adopted into the group', async () => {
  mock.__groupCalls.length = 0;
  mock.__getCalls.length = 0;

  const agentOpened = { id: 700, windowId: 1, url: 'https://example.com/child', groupId: -1, openerTabId: AUTOMATED_TAB };
  mock.__addTab(agentOpened);
  mock.__listeners.onCreated(agentOpened);
  await new Promise((r) => setTimeout(r, 600)); // the follow step is behind a 500ms settle

  const grouped = mock.__groupCalls.find((c) => c.tabIds === 700);
  assert.ok(grouped, 'a tab opened by the page the agent is driving must join the ScoutFox group');
  assert.ok(mock.__getCalls.includes(700),
    'and the running agent must follow it - that is the target="_blank" case the listener exists for');
});

test('a tab the USER opened (Cmd+T, no opener) is left completely alone', async () => {
  mock.__groupCalls.length = 0;
  mock.__getCalls.length = 0;

  const userOpened = { id: 800, windowId: 1, url: 'https://news.example.com', groupId: -1 };
  mock.__addTab(userOpened);
  mock.__listeners.onCreated(userOpened);
  await new Promise((r) => setTimeout(r, 600));

  assert.equal(mock.__groupCalls.find((c) => c.tabIds === 800), undefined,
    'a tab the user opened next to the group must NOT be pulled into the automation sandbox');
  assert.equal(mock.__tabs.get(800).groupId, -1, 'it must stay ungrouped and independent');
  assert.equal(mock.__getCalls.includes(800), false,
    'and the running agent must never retarget onto it - it is the user\'s tab, not the agent\'s');
});

test('a tab opened from some OTHER tab of the user\'s is left alone too', async () => {
  mock.__groupCalls.length = 0;
  mock.__getCalls.length = 0;

  // A link the user clicked in their mail tab - it has an opener, just not the agent's tab.
  const fromUnrelated = { id: 900, windowId: 1, url: 'https://news.example.com/article', groupId: -1, openerTabId: UNRELATED_TAB };
  mock.__addTab(fromUnrelated);
  mock.__listeners.onCreated(fromUnrelated);
  await new Promise((r) => setTimeout(r, 600));

  assert.equal(mock.__groupCalls.find((c) => c.tabIds === 900), undefined,
    'an opener that is not the tab the agent is driving means the user opened it');
  assert.equal(mock.__tabs.get(900).groupId, -1, 'it must stay ungrouped and independent');
  assert.equal(mock.__getCalls.includes(900), false, 'and must not steal the agent\'s target');
});

test('a window with no ScoutFox session at all is untouched', async () => {
  mock.__groupCalls.length = 0;

  const otherWindowTab = { id: 1000, windowId: 42, url: 'https://example.com/elsewhere', groupId: -1, openerTabId: AUTOMATED_TAB };
  mock.__addTab(otherWindowTab);
  mock.__listeners.onCreated(otherWindowTab);
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(mock.__groupCalls.length, 0,
    'window 42 never opened ScoutFox, so nothing there is any of this session\'s business');
});

/**
 * The second half of the same user report: "the new opened tab should not be added by default
 * into the group ScoutFox already created."
 *
 * Leaving a tab alone is not the same as keeping it out. Chrome ITSELF adds a new tab to
 * whatever group its opener belongs to - ctrl+click a link inside a grouped tab and the result
 * joins that group, with no extension involvement at all. So the ScoutFox group grew on its own
 * as soon as the user started browsing from the agent's tab, which is the opposite of what the
 * group is for: it is meant to show at a glance exactly which tabs the agent may touch.
 */
test('a user tab Chrome auto-added to the ScoutFox group is pulled back out', async () => {
  mock.__ungroupCalls.length = 0;
  const scoutFoxGroupId = mock.__tabs.get(AUTOMATED_TAB).groupId;
  assert.ok(scoutFoxGroupId > 0, 'sanity check: the session really does have a group to be added to');

  // The user ctrl+clicks a link in the agent's tab for their own reasons. Chrome has already
  // placed it in the ScoutFox group by the time onCreated runs, which is why the tab arrives
  // carrying that groupId rather than -1.
  const userTabAutoGrouped = {
    id: 1100, windowId: 1, url: 'https://news.example.com/their-own-reading',
    groupId: scoutFoxGroupId, openerTabId: AUTOMATED_TAB
  };
  mock.__addTab(userTabAutoGrouped);
  // Not a running-agent action: the session is idle as far as tab-opening goes, so this is the
  // user's click, not the agent's. Stop the run first so the distinction is real.
  await sendMessage(mock.__listeners, { action: 'PAUSE_TASK', tabId: 100 });
  mock.__listeners.onCreated(userTabAutoGrouped);
  await new Promise((r) => setTimeout(r, 100));

  assert.ok(mock.__ungroupCalls.includes(1100),
    'Chrome auto-grouped the user\'s tab, so ScoutFox must actively remove it again - merely declining to group it does nothing');
  assert.equal(mock.__tabs.get(1100).groupId, -1, 'the user\'s tab must end up outside the group');
});

test('a user tab in a group of their OWN is never touched', async () => {
  mock.__ungroupCalls.length = 0;

  // The user keeps their own tab group. A new tab landing in it is none of ScoutFox's business,
  // and ungrouping it would be ScoutFox reorganising the user's tab strip for them.
  const inUsersOwnGroup = {
    id: 1200, windowId: 1, url: 'https://news.example.com/other', groupId: 4242, openerTabId: UNRELATED_TAB
  };
  mock.__addTab(inUsersOwnGroup);
  mock.__listeners.onCreated(inUsersOwnGroup);
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(mock.__ungroupCalls.includes(1200), false,
    'only tabs that landed in OUR group are released - a group the user built themselves is left exactly as it is');
  assert.equal(mock.__tabs.get(1200).groupId, 4242, 'their own group membership must survive untouched');
});
