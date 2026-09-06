/**
 * Regression test for a real Chrome API limitation reported directly by the user: the side
 * panel kept showing on every tab, not just the one it was opened on.
 *
 * manifest.json declares side_panel.default_path, which registers the panel GLOBALLY on
 * every tab as Chrome's fallback. The per-tab enable/disable calls this file already made
 * (onConnect, onCreated, onActivated - all verified correct by the other tests in this file
 * and confirmed working via a direct driven test before this fix) are not enough to override
 * that global default on their own. This is a documented Chrome limitation, not a logic bug:
 * setOptions({tabId, enabled:false}) does not reliably close a panel a global default_path is
 * still offering everywhere else.
 * https://github.com/GoogleChrome/chrome-extensions-samples/issues/987
 *
 * Fix: disable the panel EVERYWHERE at startup (no tabId = global), and stop relying on
 * openPanelOnActionClick's auto-open (which used that same global default with no scoping
 * applied yet - exactly the "shows on every tab" symptom). openPanelOnActionClick:true and
 * chrome.action.onClicked are mutually exclusive by Chrome's own design; flipping it to false
 * makes onClicked fire, and its handler enables the panel for ONLY the clicked tab first.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

function makeMock() {
  // windowId: 1 on every tab, matching the onActivated calls further down - one session per
  // window means those calls need an already-created session for window 1 to find at all.
  const tabs = new Map([
    [100, { id: 100, url: 'https://example.com/a', groupId: -1, windowId: 1 }],
    [200, { id: 200, url: 'https://example.com/b', groupId: -1, windowId: 1 }] // unrelated, pre-existing tab
  ]);
  let groupCounter = 5000;
  const noop = () => {};
  const listeners = {};
  const setOptionsCalls = [];
  const setPanelBehaviorCalls = [];

  return {
    __tabs: tabs,
    __listeners: listeners,
    __setOptionsCalls: setOptionsCalls,
    __setPanelBehaviorCalls: setPanelBehaviorCalls,
    chrome: {
      runtime: { lastError: null, onConnect: { addListener: noop }, onMessage: { addListener: noop } },
      storage: { local: { get: (k, cb) => cb({}), set: (d, cb) => cb && cb(), remove: (k, cb) => cb && cb() } },
      tabs: {
        onRemoved: { addListener: noop },
        onActivated: { addListener: (fn) => { listeners.onActivated = fn; } },
        onCreated: { addListener: (fn) => { listeners.onCreated = fn; } },
        onUpdated: { addListener: (fn) => { listeners.onUpdated = fn; } },
        query: (q, cb) => cb([tabs.get(100)]),
        get: (id, cb) => cb(tabs.get(id)),
        group: (opts, cb) => {
          const gid = groupCounter++;
          const ids = Array.isArray(opts.tabIds) ? opts.tabIds : [opts.tabIds];
          ids.forEach((id) => { const t = tabs.get(id); if (t) t.groupId = gid; });
          cb(gid);
        }
      },
      tabGroups: { onRemoved: { addListener: noop }, get: (id, cb) => cb({ id, title: 'ScoutFox' }), update: (id, opts, cb) => cb && cb() },
      alarms: { create: noop, clear: noop, get: (n, cb) => cb(null), onAlarm: { addListener: noop } },
      action: { onClicked: { addListener: (fn) => { listeners.onClicked = fn; } } },
      declarativeNetRequest: { updateSessionRules: () => Promise.resolve() },
      sidePanel: {
        setPanelBehavior: (opts) => { setPanelBehaviorCalls.push(opts); return Promise.resolve(); },
        setOptions: (opts, cb) => { setOptionsCalls.push(opts); if (cb) cb(); },
        open: () => Promise.resolve()
      }
    }
  };
}

global.self = { addEventListener: () => {} };
const mock = makeMock();
global.chrome = mock.chrome;

await import('../background/background.js');
await new Promise((r) => setTimeout(r, 20));

test('the panel is disabled globally at startup, not left on the manifest default for every tab', () => {
  const globalDisable = mock.__setOptionsCalls.find((c) => c.tabId === undefined && c.enabled === false);
  assert.ok(globalDisable,
    'boot must explicitly disable the panel everywhere - this is what overrides the manifest\'s global default_path fallback');
});

test('openPanelOnActionClick is off, so action.onClicked actually fires', () => {
  assert.deepEqual(mock.__setPanelBehaviorCalls, [{ openPanelOnActionClick: false }],
    'openPanelOnActionClick:true makes chrome.action.onClicked never fire at all, by Chrome\'s own design - the per-tab enable-on-click logic below would be permanently dead code');
});

test('clicking the toolbar icon enables the panel for ONLY that tab', async () => {
  mock.__setOptionsCalls.length = 0;
  await mock.__listeners.onClicked(mock.__tabs.get(100));
  await new Promise((r) => setTimeout(r, 20));

  const enableCall = mock.__setOptionsCalls.find((c) => c.tabId === 100 && c.enabled === true);
  assert.ok(enableCall, 'the clicked tab must be explicitly enabled');
  assert.equal(mock.__tabs.get(100).groupId >= 5000, true, 'the clicked tab must join the ScoutFox group');

  const tab200EverEnabled = mock.__setOptionsCalls.some((c) => c.tabId === 200 && c.enabled === true);
  assert.equal(tab200EverEnabled, false,
    'an unrelated tab must never be enabled just because a different tab\'s icon was clicked');
});

test('switching to a tab outside the group hides the panel there', async () => {
  mock.__setOptionsCalls.length = 0;
  await mock.__listeners.onActivated({ tabId: 200, windowId: 1 });
  await new Promise((r) => setTimeout(r, 20));

  assert.deepEqual(mock.__setOptionsCalls, [{ tabId: 200, enabled: false }],
    'the reactive per-tab scoping (added before this fix) must still disable the panel when switching away from the grouped tab');
});

test('switching back to the grouped tab re-enables the panel there', async () => {
  mock.__setOptionsCalls.length = 0;
  await mock.__listeners.onActivated({ tabId: 100, windowId: 1 });
  await new Promise((r) => setTimeout(r, 20));

  const enableCall = mock.__setOptionsCalls.find((c) => c.tabId === 100 && c.enabled === true);
  assert.ok(enableCall, 'switching back to the originally-opened tab must re-enable the panel there');
});

test('onActivated is a no-op for a window that never opened ScoutFox at all', async () => {
  mock.__setOptionsCalls.length = 0;
  // windowId 999 never had its session created (no icon click, no port connect) - the real
  // handler must resolve "no session for this window" and return before touching the panel.
  await mock.__listeners.onActivated({ tabId: 100, windowId: 999 });
  await new Promise((r) => setTimeout(r, 20));

  assert.deepEqual(mock.__setOptionsCalls, [],
    'a window with no session (and so no group) must produce zero setOptions calls');
});
