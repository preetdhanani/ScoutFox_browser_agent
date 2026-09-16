/**
 * Regression test: describeRestrictedUrl() was only ever applied to the CURRENT tab's URL,
 * before a DOM read - never to a proposed `navigate` or `open_window` TARGET. A restricted
 * destination (chrome://, the Web Store, etc.) was actually reached
 * (window.location.href = url, or chrome.windows.create) and only discovered a step later, when
 * the next DOM read failed on it.
 *
 * Fixed by checking at executeActionOnTab() - the one chokepoint every top-level action already
 * passes through - before the tab (or a new window) ever gets there.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

let sentToTab = null;
let openedWindow = null;

global.chrome = {
  storage: { local: { get: (keys, cb) => cb({}), set: (data, cb) => cb && cb() } },
  runtime: { lastError: null },
  tabs: {
    get: (id, cb) => cb({ id, groupId: -1, url: 'https://example.com' }),
    query: async () => [],
    sendMessage: (tabId, msg, cb) => { sentToTab = msg; cb({ success: true }); }
  },
  windows: {
    create: (opts, cb) => { openedWindow = opts; cb && cb({ id: 999, tabs: [{ id: 501 }] }); }
  }
};

const { AgentEngine } = await import('../background/agentEngine.js');

test('navigating to a restricted URL is blocked before the tab ever leaves its current page', async () => {
  const engine = new AgentEngine();
  sentToTab = null;

  const result = await engine.executeActionOnTab(101, { action: 'navigate', url: 'chrome://settings' });

  assert.equal(result.success, false);
  assert.match(result.error, /chrome:\/\/settings/);
  assert.equal(sentToTab, null, 'the restricted url must never actually be dispatched to the tab');
});

test('opening a new window at a restricted URL is blocked the same way', async () => {
  const engine = new AgentEngine();
  openedWindow = null;

  const result = await engine.executeActionOnTab(101, { action: 'open_window', url: 'chrome://extensions' });

  assert.equal(result.success, false);
  assert.match(result.error, /chrome:\/\/extensions/);
  assert.equal(openedWindow, null, 'no window may be created for a restricted destination');
});

test('an ordinary https destination is unaffected by the gate', async () => {
  const engine = new AgentEngine();
  sentToTab = null;

  const result = await engine.executeActionOnTab(101, { action: 'navigate', url: 'https://example.com/pricing' });

  assert.equal(result.success, true);
  assert.ok(sentToTab, 'a normal destination must still reach the tab as before');
});
