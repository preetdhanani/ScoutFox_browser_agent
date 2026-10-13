import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureScoutFoxGroup, isTabInScope, groupIdForWindow, type GroupContext } from '../../src/background/browser/groups.ts';

function createMockChrome(tabsMap = new Map<number, any>(), groupsMap = new Map<number, any>()) {
  let groupCounter = 1000;
  return {
    tabs: {
      get: (id: number, cb: (t: any) => void) => {
        const tab = tabsMap.get(id);
        if (!tab) {
          (globalThis as any).chrome.runtime.lastError = { message: `No tab with id ${id}` };
          cb(undefined);
        } else {
          (globalThis as any).chrome.runtime.lastError = null;
          cb(tab);
        }
      },
      group: (opts: any, cb: (gid: number) => void) => {
        let gid = opts.groupId;
        if (!gid) {
          gid = ++groupCounter;
          groupsMap.set(gid, { id: gid, title: '', color: '', windowId: opts.createProperties?.windowId });
        }
        const ids = Array.isArray(opts.tabIds) ? opts.tabIds : [opts.tabIds];
        for (const tid of ids) {
          const tab = tabsMap.get(tid);
          if (tab) {
            tab.groupId = gid;
            if (opts.createProperties?.windowId !== undefined) {
              tab.windowId = opts.createProperties.windowId;
            }
          }
        }
        (globalThis as any).chrome.runtime.lastError = null;
        cb(gid);
      }
    },
    tabGroups: {
      TAB_GROUP_ID_NONE: -1,
      get: (gid: number, cb: (g: any) => void) => {
        const grp = groupsMap.get(gid);
        (globalThis as any).chrome.runtime.lastError = grp ? null : { message: 'Group not found' };
        cb(grp);
      },
      update: (gid: number, updateProps: any, cb: (g: any) => void) => {
        const grp = groupsMap.get(gid);
        if (grp) {
          Object.assign(grp, updateProps);
        }
        cb(grp);
      }
    },
    runtime: {
      lastError: null as any
    }
  };
}

test('groupIdForWindow: returns group id for window or first in map for default', () => {
  const groupIds = new Map<any, number>();
  groupIds.set(1, 101);
  groupIds.set(2, 102);

  const ctx: GroupContext = {
    windowId: 1,
    groupIds,
    persist: () => {}
  };

  assert.equal(groupIdForWindow(ctx, 1), 101);
  assert.equal(groupIdForWindow(ctx, 2), 102);
  assert.equal(groupIdForWindow(ctx, 3), null);
  assert.equal(groupIdForWindow(ctx, 'default'), 101);
});

test('isTabInScope: returns false for invalid or missing tab', async () => {
  const originalChrome = (globalThis as any).chrome;
  try {
    const tabsMap = new Map();
    (globalThis as any).chrome = createMockChrome(tabsMap);

    const ctx: GroupContext = {
      windowId: 1,
      groupIds: new Map([[1, 500]]),
      persist: () => {}
    };

    assert.equal(await isTabInScope(ctx, 0), false);
    assert.equal(await isTabInScope(ctx, 999), false);
  } finally {
    (globalThis as any).chrome = originalChrome;
  }
});

test('isTabInScope: returns true when chrome.tabs.get is unavailable', async () => {
  const originalChrome = (globalThis as any).chrome;
  try {
    (globalThis as any).chrome = undefined;
    const ctx: GroupContext = { groupIds: new Map(), persist: () => {} };
    assert.equal(await isTabInScope(ctx, 101), true);
  } finally {
    (globalThis as any).chrome = originalChrome;
  }
});

test('isTabInScope: validates whether tab belongs to session ScoutFox group for that window', async () => {
  const originalChrome = (globalThis as any).chrome;
  try {
    const tabsMap = new Map([
      [101, { id: 101, windowId: 1, groupId: 500 }],
      [102, { id: 102, windowId: 1, groupId: 600 }],
      [103, { id: 103, windowId: 2, groupId: 700 }]
    ]);
    (globalThis as any).chrome = createMockChrome(tabsMap);

    const ctx: GroupContext = {
      windowId: 1,
      groupIds: new Map([[1, 500]]),
      persist: () => {}
    };

    // Tab 101 is in group 500 -> in scope
    assert.equal(await isTabInScope(ctx, 101), true);
    // Tab 102 is in group 600 (not 500) -> out of scope
    assert.equal(await isTabInScope(ctx, 102), false);
    // Tab 103 is in window 2 which has no group -> out of scope
    assert.equal(await isTabInScope(ctx, 103), false);
  } finally {
    (globalThis as any).chrome = originalChrome;
  }
});

test('ensureScoutFoxGroup: creates fresh ScoutFox group in tab own window and persists', async () => {
  const originalChrome = (globalThis as any).chrome;
  try {
    const tabsMap = new Map([
      [101, { id: 101, windowId: 4, groupId: -1 }]
    ]);
    const groupsMap = new Map();
    (globalThis as any).chrome = createMockChrome(tabsMap, groupsMap);

    let persisted = false;
    const ctx: GroupContext = {
      windowId: 1, // session primary window is 1, but tab is in window 4
      groupIds: new Map(),
      persist: () => { persisted = true; }
    };

    const gid = await ensureScoutFoxGroup(ctx, 101);
    assert.ok(gid);
    assert.equal(persisted, true);
    assert.equal(ctx.groupIds.get(4), gid);

    // Group should be created with title ScoutFox and orange color
    const grp = groupsMap.get(gid);
    assert.ok(grp);
    assert.equal(grp.title, 'ScoutFox');
    assert.equal(grp.color, 'orange');
    assert.equal(grp.windowId, 4); // Created in tab's own window!
  } finally {
    (globalThis as any).chrome = originalChrome;
  }
});

test('ensureScoutFoxGroup: reuses active group for subsequent tabs in same window', async () => {
  const originalChrome = (globalThis as any).chrome;
  try {
    const tabsMap = new Map([
      [101, { id: 101, windowId: 1, groupId: 1001 }],
      [102, { id: 102, windowId: 1, groupId: -1 }]
    ]);
    const groupsMap = new Map([
      [1001, { id: 1001, title: 'ScoutFox', color: 'orange', windowId: 1 }]
    ]);
    (globalThis as any).chrome = createMockChrome(tabsMap, groupsMap);

    const ctx: GroupContext = {
      windowId: 1,
      groupIds: new Map([[1, 1001]]),
      persist: () => {}
    };

    const gid = await ensureScoutFoxGroup(ctx, 102);
    assert.equal(gid, 1001);
    assert.equal(tabsMap.get(102)?.groupId, 1001);
  } finally {
    (globalThis as any).chrome = originalChrome;
  }
});

test('ensureScoutFoxGroup: adopts existing titled ScoutFox group if tab already in one', async () => {
  const originalChrome = (globalThis as any).chrome;
  try {
    const tabsMap = new Map([
      [101, { id: 101, windowId: 2, groupId: 2002 }]
    ]);
    const groupsMap = new Map([
      [2002, { id: 2002, title: 'ScoutFox', color: 'orange', windowId: 2 }]
    ]);
    (globalThis as any).chrome = createMockChrome(tabsMap, groupsMap);

    let persisted = false;
    const ctx: GroupContext = {
      windowId: 2,
      groupIds: new Map(), // No group recorded initially
      persist: () => { persisted = true; }
    };

    const gid = await ensureScoutFoxGroup(ctx, 101);
    assert.equal(gid, 2002);
    assert.equal(ctx.groupIds.get(2), 2002);
    assert.equal(persisted, true);
  } finally {
    (globalThis as any).chrome = originalChrome;
  }
});

test('ensureScoutFoxGroup: detects closed group and creates fresh group', async () => {
  const originalChrome = (globalThis as any).chrome;
  try {
    const tabsMap = new Map([
      [101, { id: 101, windowId: 1, groupId: -1 }]
    ]);
    // Stored group 8888 is NOT in groupsMap (was closed by user)
    const groupsMap = new Map();
    (globalThis as any).chrome = createMockChrome(tabsMap, groupsMap);

    const ctx: GroupContext = {
      windowId: 1,
      groupIds: new Map([[1, 8888]]),
      persist: () => {}
    };

    const newGid = await ensureScoutFoxGroup(ctx, 101);
    assert.ok(newGid);
    assert.notEqual(newGid, 8888);
    assert.equal(ctx.groupIds.get(1), newGid);
  } finally {
    (globalThis as any).chrome = originalChrome;
  }
});

test('ensureScoutFoxGroup: returns null safely when passed invalid tabId', async () => {
  const originalChrome = (globalThis as any).chrome;
  try {
    (globalThis as any).chrome = createMockChrome();
    const ctx: GroupContext = { windowId: 1, groupIds: new Map(), persist: () => {} };
    assert.equal(await ensureScoutFoxGroup(ctx, null as any), null);
    assert.equal(await ensureScoutFoxGroup(ctx, undefined as any), null);
  } finally {
    (globalThis as any).chrome = originalChrome;
  }
});

test('ensureScoutFoxGroup: returns null when target tab ID does not exist in Chrome', async () => {
  const originalChrome = (globalThis as any).chrome;
  try {
    (globalThis as any).chrome = createMockChrome(new Map()); // empty tabsMap
    const ctx: GroupContext = { windowId: 1, groupIds: new Map(), persist: () => {} };
    assert.equal(await ensureScoutFoxGroup(ctx, 9999), null);
  } finally {
    (globalThis as any).chrome = originalChrome;
  }
});

test('ensureScoutFoxGroup: creates group in tab own window', async () => {
  const originalChrome = (globalThis as any).chrome;
  try {
    const tabsMap = new Map([
      [101, { id: 101, windowId: 7, groupId: -1 }]
    ]);
    const groupsMap = new Map();
    (globalThis as any).chrome = createMockChrome(tabsMap, groupsMap);

    const ctx: GroupContext = {
      windowId: 7,
      groupIds: new Map(),
      persist: () => {}
    };

    const gid = await ensureScoutFoxGroup(ctx, 101, 7);
    assert.ok(gid);
    assert.equal(tabsMap.get(101)?.windowId, 7);
    assert.equal(ctx.groupIds.get(7), gid);
  } finally {
    (globalThis as any).chrome = originalChrome;
  }
});

test('ensureScoutFoxGroup: persist callback writes group id to caller store', async () => {
  const originalChrome = (globalThis as any).chrome;
  try {
    const tabsMap = new Map([
      [101, { id: 101, windowId: 1, groupId: -1 }]
    ]);
    const groupsMap = new Map();
    (globalThis as any).chrome = createMockChrome(tabsMap, groupsMap);

    let persistedCount = 0;
    const ctx: GroupContext = {
      windowId: 1,
      groupIds: new Map(),
      persist: () => { persistedCount++; }
    };

    const gid = await ensureScoutFoxGroup(ctx, 101);
    assert.ok(gid);
    assert.equal(persistedCount, 1);
  } finally {
    (globalThis as any).chrome = originalChrome;
  }
});

test('ensureScoutFoxGroup: cold boot without stored session starts empty', () => {
  const ctx: GroupContext = {
    windowId: 1,
    groupIds: new Map(),
    persist: () => {}
  };
  assert.equal(ctx.groupIds.size, 0);
  assert.equal(groupIdForWindow(ctx, 1), null);
});
