/**
 * Phase 2 of the per-window session work, unit level: AgentEngine.openNewWindow /
 * ensureScoutFoxGroup / groupIdForWindow directly, no background.js involved.
 *
 * The agent can open a brand-new browser window when a task genuinely needs one, and that
 * window stays part of the SAME running session (shared history), rather than starting a
 * second, disconnected one. A Chrome tab group cannot span windows, so the new window's tab
 * gets its OWN ScoutFox group, tracked under the new window's id in
 * AgentEngine.scoutFoxGroupIds - but history, status, and everything else about the session
 * stay the ONE object both windows now share.
 *
 * The full real path through background.js (a real task choosing "open_window" via a stubbed
 * LLM, then a second panel connecting to the new window) is covered separately in
 * tests/multiWindowSameSessionE2E.test.js - importing background.js here would race this
 * file's own per-test chrome mocks across the await import() boundary, exactly the ordering
 * bug this split avoids (see that file's own header for the full explanation).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { AgentEngine } = await import('../background/agentEngine.js');

function makeEngineChromeMock() {
  const tabs = new Map();
  let tabCounter = 1;
  let winCounter = 1;
  let groupCounter = 5000;
  const noop = () => {};

  function addTab(id, windowId, url, groupId = -1) {
    tabs.set(id, { id, windowId, url, groupId });
  }

  return {
    __tabs: tabs,
    __addTab: addTab,
    chrome: {
      runtime: { lastError: null },
      storage: { local: { get: (k, cb) => cb({}), set: (d, cb) => cb && cb() } },
      tabs: {
        onUpdated: { addListener: noop, removeListener: noop, hasListener: () => false },
        get: (id, cb) => { const t = tabs.get(id); if (cb) { cb(t); return undefined; } return Promise.resolve(t); },
        group: (opts, cb) => {
          const ids = Array.isArray(opts.tabIds) ? opts.tabIds : [opts.tabIds];
          const gid = opts.groupId !== undefined ? opts.groupId : groupCounter++;
          ids.forEach((id) => { const t = tabs.get(id); if (t) t.groupId = gid; });
          cb(gid);
        }
      },
      tabGroups: { get: (id, cb) => cb({ id, title: 'ScoutFox' }), update: (id, opts, cb) => cb && cb() },
      windows: {
        create: (opts, cb) => {
          const windowId = 100 + winCounter++;
          const tabId = 900 + tabCounter++;
          addTab(tabId, windowId, opts.url);
          cb({ id: windowId, tabs: [tabs.get(tabId)] });
        }
      }
    }
  };
}

test('openNewWindow creates a new window, groups its tab separately, and keeps the session', async () => {
  const mock = makeEngineChromeMock();
  global.chrome = mock.chrome;

  const engine = new AgentEngine(1);
  await engine.restorePromise;
  engine.history = [{ type: 'user_goal', prompt: 'existing task' }];
  engine.currentTask = 'existing task';

  mock.__addTab(101, 1, 'https://example.com/original');
  await engine.ensureScoutFoxGroup(101); // window 1's own group, as startTask would establish

  let calledBackWith = null;
  engine.setWindowOpenedCallback((newWindowId) => { calledBackWith = newWindowId; });

  const result = await engine.openNewWindow('https://example.com/compare');

  assert.equal(result.success, true);
  assert.ok(result.windowId, 'must report the new window id');
  assert.ok(result.tabId, 'must report the new tab id');
  assert.equal(calledBackWith, result.windowId, 'onWindowOpenedCallback must fire with the new window id');

  assert.equal(engine.activeTabId, result.tabId, 'the engine now drives the new window\'s tab');
  assert.equal(engine.history.length, 1, 'existing history must be untouched - this is still the same session');
  assert.equal(engine.currentTask, 'existing task', 'the task must not be reset by opening a window');

  const groupForNewWindow = engine.groupIdForWindow(result.windowId);
  const groupForOriginalWindow = engine.groupIdForWindow(1);
  assert.ok(groupForNewWindow, 'the new window must get its own tab group');
  assert.notEqual(groupForNewWindow, groupForOriginalWindow,
    'a tab group cannot span windows, so the new window must NOT reuse the original window\'s group');
});

test('a tab created later in the new window joins ITS OWN group, not the original window\'s', async () => {
  const mock = makeEngineChromeMock();
  global.chrome = mock.chrome;

  const engine = new AgentEngine(1);
  await engine.restorePromise;
  mock.__addTab(101, 1, 'https://example.com/original');
  await engine.ensureScoutFoxGroup(101);

  const result = await engine.openNewWindow('https://example.com/compare');
  const newWindowId = result.windowId;

  mock.__addTab(999, newWindowId, 'https://example.com/another-tab-in-new-window');
  const groupId = await engine.ensureScoutFoxGroup(999, newWindowId);

  assert.equal(groupId, engine.groupIdForWindow(newWindowId),
    'a tab in the new window must join that window\'s own group');
  assert.notEqual(groupId, engine.groupIdForWindow(1),
    'it must not be grouped into the ORIGINAL window\'s group - Chrome would refuse that outright');
});
