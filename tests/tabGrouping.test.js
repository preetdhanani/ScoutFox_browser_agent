/**
 * Comprehensive Unit & Integration Test Suite for ScoutFox Chrome Tab Grouping,
 * Sandboxing, Service Worker State Persistence, Side Panel Scoping, and Auto-Grouping.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Creates a clean mock Chrome API environment for test isolation.
 */
function createMockChromeEnv() {
  const tabs = new Map();
  const tabGroups = new Map();
  const sidePanelOptions = new Map();
  const storageData = {};

  const createdListeners = [];
  const activatedListeners = [];
  const removedListeners = [];
  const connectListeners = [];
  const messageListeners = [];

  let groupCounter = 5000;

  const mockChrome = {
    runtime: {
      lastError: null,
      getPlatformInfo: (cb) => cb && cb({ os: 'mac' }),
      onConnect: {
        addListener: (fn) => connectListeners.push(fn)
      },
      onMessage: {
        addListener: (fn) => messageListeners.push(fn)
      }
    },
    storage: {
      get session() { return this.local; }, // agent_sessions lives in storage.session; one backing store keeps seeds simple
      local: {
        get: (keys, cb) => {
          const result = {};
          if (Array.isArray(keys)) {
            keys.forEach(k => { result[k] = storageData[k]; });
          } else if (typeof keys === 'string') {
            result[keys] = storageData[keys];
          } else if (typeof keys === 'object' && keys !== null) {
            Object.keys(keys).forEach(k => {
              result[k] = storageData[k] !== undefined ? storageData[k] : keys[k];
            });
          } else {
            Object.assign(result, storageData);
          }
          mockChrome.runtime.lastError = null;
          if (cb) cb(result);
          return Promise.resolve(result);
        },
        set: (items, cb) => {
          Object.assign(storageData, items);
          mockChrome.runtime.lastError = null;
          if (cb) cb();
          return Promise.resolve();
        },
        clear: (cb) => {
          for (const key of Object.keys(storageData)) delete storageData[key];
          mockChrome.runtime.lastError = null;
          if (cb) cb();
          return Promise.resolve();
        }
      }
    },
    tabs: {
      get: (tabId, cb) => {
        const tab = tabs.get(tabId);
        if (!tab) {
          mockChrome.runtime.lastError = { message: `No tab with id: ${tabId}` };
          if (cb) cb(undefined);
          return Promise.resolve(undefined);
        }
        mockChrome.runtime.lastError = null;
        if (cb) cb(tab);
        return Promise.resolve(tab);
      },
      query: async (queryInfo = {}) => {
        let list = Array.from(tabs.values());
        if (queryInfo.groupId !== undefined) {
          list = list.filter(t => t.groupId === queryInfo.groupId);
        }
        if (queryInfo.active !== undefined) {
          list = list.filter(t => !!t.active === !!queryInfo.active);
        }
        if (queryInfo.currentWindow !== undefined) {
          list = list.filter(t => !!t.currentWindow === !!queryInfo.currentWindow);
        }
        if (queryInfo.lastFocusedWindow !== undefined) {
          list = list.filter(t => !!t.lastFocusedWindow === !!queryInfo.lastFocusedWindow);
        }
        return list;
      },
      group: (opts, cb) => {
        const targetTabIds = Array.isArray(opts.tabIds) ? opts.tabIds : [opts.tabIds];
        let gid = opts.groupId;

        // Like Chrome: a NEW group lands in createProperties.windowId, or else the last-focused
        // window - and the tab moves there with it.
        let moveToWindow;
        if (!gid) {
          gid = ++groupCounter;
          tabGroups.set(gid, { id: gid, title: '', color: '' });
          moveToWindow = opts.createProperties?.windowId ?? LAST_FOCUSED_WINDOW_ID;
        }

        for (const tid of targetTabIds) {
          const tab = tabs.get(tid);
          if (tab) {
            tab.groupId = gid;
            if (moveToWindow !== undefined && tab.windowId !== undefined) tab.windowId = moveToWindow;
          }
        }

        mockChrome.runtime.lastError = null;
        if (cb) cb(gid);
        return Promise.resolve(gid);
      },
      onCreated: {
        addListener: (fn) => createdListeners.push(fn)
      },
      onActivated: {
        addListener: (fn) => activatedListeners.push(fn)
      },
      onRemoved: {
        addListener: (fn) => removedListeners.push(fn)
      }
    },
    tabGroups: {
      TAB_GROUP_ID_NONE: -1,
      get: (groupId, cb) => {
        const group = tabGroups.get(groupId);
        if (!group) {
          mockChrome.runtime.lastError = { message: `No group with id: ${groupId}` };
          if (cb) cb(undefined);
          return Promise.resolve(undefined);
        }
        mockChrome.runtime.lastError = null;
        if (cb) cb(group);
        return Promise.resolve(group);
      },
      update: (groupId, opts, cb) => {
        let group = tabGroups.get(groupId);
        if (!group) {
          group = { id: groupId, ...opts };
          tabGroups.set(groupId, group);
        } else {
          Object.assign(group, opts);
        }
        mockChrome.runtime.lastError = null;
        if (cb) cb(group);
        return Promise.resolve(group);
      }
    },
    sidePanel: {
      setOptions: (opts, cb) => {
        sidePanelOptions.set(opts.tabId, opts);
        mockChrome.runtime.lastError = null;
        if (cb) cb();
        return Promise.resolve();
      }
    },
    declarativeNetRequest: {
      updateSessionRules: (rules, cb) => { if (cb) cb(); }
    },
    alarms: {
      create: () => {},
      clear: () => {},
      get: (name, cb) => cb(null),
      onAlarm: { addListener: () => {} }
    }
  };

  return {
    mockChrome,
    tabs,
    tabGroups,
    sidePanelOptions,
    storageData,
    createdListeners,
    activatedListeners,
    removedListeners,
    connectListeners,
    messageListeners
  };
}

const LAST_FOCUSED_WINDOW_ID = 99;

// Initial default chrome mock for top-level module evaluation
global.chrome = createMockChromeEnv().mockChrome;

const { AgentEngine } = await import('../background/agentEngine.js');

// ============================================================================
// SCENARIO 1: ensureScoutFoxGroup Creation
// ============================================================================
test('1.1 ensureScoutFoxGroup - Creates a ScoutFox group with title "ScoutFox" and color "orange" when no group exists', async () => {
  const env = createMockChromeEnv();
  global.chrome = env.mockChrome;

  env.tabs.set(101, { id: 101, groupId: -1, url: 'https://google.com' });

  const engine = new AgentEngine();
  await engine.restorePromise;

  assert.equal(engine.scoutFoxGroupId, null, 'Initially scoutFoxGroupId must be null');

  const groupId = await engine.ensureScoutFoxGroup(101);

  assert.ok(groupId, 'Must return a valid non-null group ID');
  assert.equal(engine.scoutFoxGroupId, groupId, 'Engine scoutFoxGroupId must update to created group ID');

  const groupInfo = env.tabGroups.get(groupId);
  assert.ok(groupInfo, 'Created group must exist in tabGroups');
  assert.equal(groupInfo.title, 'ScoutFox', 'Tab group title must be set to "ScoutFox"');
  assert.equal(groupInfo.color, 'orange', 'Tab group color must be set to "orange"');
  assert.equal(env.tabs.get(101).groupId, groupId, 'Target tab must be assigned to the new group');
});

test('1.1b ensureScoutFoxGroup - Creates the group in the tab\'s own window, never the last-focused one', async () => {
  const env = createMockChromeEnv();
  global.chrome = env.mockChrome;
  // The user clicked into window 99 while a task was starting in window 7.
  env.tabs.set(102, { id: 102, groupId: -1, windowId: 7, url: 'https://google.com' });

  const engine = new AgentEngine();
  await engine.restorePromise;
  await engine.ensureScoutFoxGroup(102);

  assert.equal(env.tabs.get(102).windowId, 7, 'grouping must not drag the agent\'s tab into another window');
});

test('1.2 ensureScoutFoxGroup - Returns null safely when passed invalid tabId', async () => {
  const env = createMockChromeEnv();
  global.chrome = env.mockChrome;

  const engine = new AgentEngine();
  await engine.restorePromise;

  const result = await engine.ensureScoutFoxGroup(null);
  assert.equal(result, null, 'Must return null when tabId is missing or null');
});

test('1.3 ensureScoutFoxGroup - Returns null when target tab ID does not exist in Chrome', async () => {
  const env = createMockChromeEnv();
  global.chrome = env.mockChrome;

  const engine = new AgentEngine();
  await engine.restorePromise;

  const result = await engine.ensureScoutFoxGroup(99999);
  assert.equal(result, null, 'Must return null when tab does not exist in browser');
});

// ============================================================================
// SCENARIO 2: ensureScoutFoxGroup ID Reuse & Sandbox Deduplication
// ============================================================================
test('2.1 ensureScoutFoxGroup - Reuses existing active ScoutFox group ID when adding subsequent tabs', async () => {
  const env = createMockChromeEnv();
  global.chrome = env.mockChrome;

  env.tabs.set(101, { id: 101, groupId: -1, url: 'https://example.com/page1' });
  env.tabs.set(102, { id: 102, groupId: -1, url: 'https://example.com/page2' });
  env.tabs.set(103, { id: 103, groupId: -1, url: 'https://example.com/page3' });

  const engine = new AgentEngine();
  await engine.restorePromise;

  const group1 = await engine.ensureScoutFoxGroup(101);
  assert.ok(group1, 'First tab creates group');

  const group2 = await engine.ensureScoutFoxGroup(102);
  const group3 = await engine.ensureScoutFoxGroup(103);

  assert.equal(group2, group1, 'Second tab must reuse existing group ID');
  assert.equal(group3, group1, 'Third tab must reuse existing group ID');
  assert.equal(engine.scoutFoxGroupId, group1, 'scoutFoxGroupId must remain constant');

  assert.equal(env.tabs.get(101).groupId, group1);
  assert.equal(env.tabs.get(102).groupId, group1);
  assert.equal(env.tabs.get(103).groupId, group1);
  assert.equal(env.tabGroups.size, 1, 'Only one tab group should have been created (no duplicates)');
});

test('2.2 ensureScoutFoxGroup - Immediately returns group ID if tab is already inside active ScoutFox group', async () => {
  const env = createMockChromeEnv();
  global.chrome = env.mockChrome;

  env.tabs.set(101, { id: 101, groupId: -1, url: 'https://example.com' });

  const engine = new AgentEngine();
  await engine.restorePromise;

  const gid = await engine.ensureScoutFoxGroup(101);
  assert.equal(env.tabs.get(101).groupId, gid);

  const recheckGid = await engine.ensureScoutFoxGroup(101);
  assert.equal(recheckGid, gid, 'Calling ensureScoutFoxGroup again on already grouped tab returns same ID');
});

// ============================================================================
// SCENARIO 3: User Closed Group Detection & Reset Recovery
// ============================================================================
test('3.1 ensureScoutFoxGroup - Detects if existing group was closed by user, resets group ID, and creates fresh group', async () => {
  const env = createMockChromeEnv();
  global.chrome = env.mockChrome;

  env.tabs.set(101, { id: 101, groupId: -1, url: 'https://example.com/tab1' });
  env.tabs.set(102, { id: 102, groupId: -1, url: 'https://example.com/tab2' });

  const engine = new AgentEngine();
  await engine.restorePromise;

  const initialGroupId = await engine.ensureScoutFoxGroup(101);
  assert.equal(engine.scoutFoxGroupId, initialGroupId);

  // User closes the tab group in Chrome
  env.tabGroups.delete(initialGroupId);

  // Subsequent call for tab 102
  const freshGroupId = await engine.ensureScoutFoxGroup(102);

  assert.notEqual(freshGroupId, initialGroupId, 'Must create a fresh group when previous group was closed');
  assert.equal(engine.scoutFoxGroupId, freshGroupId, 'scoutFoxGroupId must update to fresh group ID');
  assert.equal(env.tabGroups.get(freshGroupId).title, 'ScoutFox', 'Fresh group must be titled ScoutFox');
  assert.equal(env.tabGroups.get(freshGroupId).color, 'orange', 'Fresh group must be colored orange');
  assert.equal(env.tabs.get(102).groupId, freshGroupId);
});

test('3.2 ensureScoutFoxGroup - Adopts existing titled ScoutFox group if tab is already in one', async () => {
  const env = createMockChromeEnv();
  global.chrome = env.mockChrome;

  const PRE_EXISTING_GID = 7777;
  env.tabGroups.set(PRE_EXISTING_GID, { id: PRE_EXISTING_GID, title: 'ScoutFox', color: 'orange' });
  env.tabs.set(201, { id: 201, groupId: PRE_EXISTING_GID, url: 'https://example.com' });

  const engine = new AgentEngine();
  await engine.restorePromise;
  engine.scoutFoxGroupId = null; // Unset engine state

  const gid = await engine.ensureScoutFoxGroup(201);

  assert.equal(gid, PRE_EXISTING_GID, 'Must adopt pre-existing group titled ScoutFox');
  assert.equal(engine.scoutFoxGroupId, PRE_EXISTING_GID, 'Engine state must adopt group ID');
});

// ============================================================================
// SCENARIO 4: scoutFoxGroupId Persistence Across Service Worker Restarts
// ============================================================================
test('4.1 scoutFoxGroupId Persistence - persistState writes scoutFoxGroupId to chrome.storage.session', async () => {
  const env = createMockChromeEnv();
  global.chrome = env.mockChrome;

  const engine = new AgentEngine();
  await engine.restorePromise;

  engine.scoutFoxGroupId = 8888;
  engine.currentTask = 'Persist Test Task';

  await engine.persistState();

  // Keyed by windowId ('default' here, since this engine was constructed with none) - one
  // engine per window means persistence lives under agent_sessions, not a single global slot.
  assert.ok(env.storageData.agent_sessions, 'agent_sessions must exist in storage');
  assert.ok(env.storageData.agent_sessions.default, 'this engine\'s own window entry must exist');
  assert.equal(env.storageData.agent_sessions.default.scoutFoxGroupId, 8888, 'scoutFoxGroupId must be persisted');
});

test('4.2 scoutFoxGroupId Persistence - restoreState restores scoutFoxGroupId across service worker cold boot', async () => {
  const env = createMockChromeEnv();
  global.chrome = env.mockChrome;

  env.storageData.agent_sessions = {
    default: {
      task: 'Restored Task',
      status: 'idle',
      scoutFoxGroupId: 9999,
      history: [],
      planSteps: []
    }
  };

  const engine = new AgentEngine();
  await engine.restoreState();

  assert.equal(engine.scoutFoxGroupId, 9999, 'scoutFoxGroupId must be restored from persisted storage snapshot');
  assert.equal(engine.currentTask, 'Restored Task');
});

test('4.3 scoutFoxGroupId Persistence - restoreState leaves scoutFoxGroupId null when no stored session exists', async () => {
  const env = createMockChromeEnv();
  global.chrome = env.mockChrome;

  const engine = new AgentEngine();
  await engine.restoreState();

  assert.equal(engine.scoutFoxGroupId, null, 'scoutFoxGroupId defaults to null on clean boot');
});

// Tab isolation & side panel scoping (switching away from / back to the grouped tab, and the
// no-session/no-group no-op guard) is covered against the REAL chrome.tabs.onActivated
// listener in tests/backgroundSidePanelScoping.test.js - not duplicated here. This file used
// to carry its own copy via a hand-rolled simulateTabActivated() helper that checked
// engine.scoutFoxGroupId directly; background.js has since moved to a per-window
// session.engine.groupIdForWindow(), so that helper was silently testing logic real
// production code no longer runs at all.

// Multi-tab auto-grouping (which newly created tabs this session adopts, and which it must
// leave alone) is covered against the REAL chrome.tabs.onCreated listener in
// tests/backgroundTabAdoption.test.js. This file used to carry its own copy via a hand-rolled
// simulateTabCreated() helper that read engine.scoutFoxGroupId and re-implemented the
// restricted-URL check as a bare 'chrome://' prefix test; background.js has since moved to a
// per-window groupIdForWindow() and the shared describeRestrictedUrl(), and adopts a tab only
// when its openerTabId shows the agent itself opened it - so that helper asserted behaviour
// production no longer has.
