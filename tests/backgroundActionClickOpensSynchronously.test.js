/**
 * Regression test for a real production bug this session introduced and the user reported
 * immediately: clicking the extension's toolbar icon stopped opening the side panel at all.
 *
 * Chrome's user-gesture rule for chrome.sidePanel.open(): it must be called SYNCHRONOUSLY,
 * within the same tick as the click event, with nothing awaited beforehand. Crossing even one
 * await loses the gesture context, and open() then rejects - silently, since the call site
 * here is a fire-and-forget .catch(). Confirmed against multiple Chromium bug reports
 * describing this exact failure mode:
 * https://issues.chromium.org/issues/355266358
 * https://github.com/GoogleChrome/chrome-extensions-samples/issues/1001
 *
 * The prior version of the click handler awaited agentEngine.ensureScoutFoxGroup(tab.id)
 * BEFORE calling chrome.sidePanel.open() - exactly the pattern that breaks this. This test
 * asserts the ordering directly: open() must appear before any await in the handler's actual
 * execution, not just "eventually get called".
 */

import test from 'node:test';
import assert from 'node:assert/strict';

function makeMock() {
  const tabs = new Map([[100, { id: 100, url: 'https://example.com/a', groupId: -1 }]]);
  const noop = () => {};
  const listeners = {};
  const callOrder = [];

  // A storage read with a real async gap - if anything before sidePanel.open() ever awaits
  // this (directly or via ensureScoutFoxGroup), open() would be called only after this
  // resolves, one or more ticks late - too late for Chrome's gesture window.
  let groupCounter = 5000;

  return {
    __tabs: tabs,
    __listeners: listeners,
    __callOrder: callOrder,
    chrome: {
      runtime: { lastError: null, onConnect: { addListener: noop }, onMessage: { addListener: noop } },
      storage: {
        local: {
          get: (keys, cb) => { setTimeout(() => cb({}), 5); }, // deliberately async, not synchronous
          set: (d, cb) => { setTimeout(() => cb && cb(), 5); },
          remove: (k, cb) => cb && cb()
        }
      },
      tabs: {
        onRemoved: { addListener: noop },
        onActivated: { addListener: noop },
        onCreated: { addListener: noop },
        onUpdated: { addListener: noop },
        query: (q, cb) => cb([tabs.get(100)]),
        get: (id, cb) => cb(tabs.get(id)),
        group: (opts, cb) => {
          setTimeout(() => {
            const gid = groupCounter++;
            const ids = Array.isArray(opts.tabIds) ? opts.tabIds : [opts.tabIds];
            ids.forEach((id) => { const t = tabs.get(id); if (t) t.groupId = gid; });
            cb(gid);
          }, 5);
        }
      },
      tabGroups: { onRemoved: { addListener: noop }, get: (id, cb) => cb({ id, title: 'ScoutFox' }), update: (id, opts, cb) => cb && cb() },
      alarms: { create: noop, clear: noop, get: (n, cb) => cb(null), onAlarm: { addListener: noop } },
      action: { onClicked: { addListener: (fn) => { listeners.onClicked = fn; } } },
      declarativeNetRequest: { updateSessionRules: () => Promise.resolve() },
      sidePanel: {
        setPanelBehavior: () => Promise.resolve(),
        setOptions: (opts, cb) => { callOrder.push({ call: 'setOptions', opts }); if (cb) cb(); },
        open: (opts) => { callOrder.push({ call: 'open', opts }); return Promise.resolve(); }
      }
    }
  };
}

global.self = { addEventListener: () => {} };
const mock = makeMock();
global.chrome = mock.chrome;

await import('../background/background.js');
await new Promise((r) => setTimeout(r, 20));

test('chrome.sidePanel.open() is invoked synchronously by the click handler, not after an await', () => {
  mock.__callOrder.length = 0;

  // Call the listener exactly as Chrome does: synchronously, from this line. If the handler
  // itself awaits anything before calling open(), that call will not have happened yet by
  // the time this synchronous line returns - proving the bug this test guards against.
  mock.__listeners.onClicked(mock.__tabs.get(100));

  const openCallHappenedSynchronously = mock.__callOrder.some((c) => c.call === 'open');
  assert.equal(openCallHappenedSynchronously, true,
    'chrome.sidePanel.open() must be called in the same synchronous tick as the click - ' +
    'awaiting anything (ensureScoutFoxGroup, a storage read, tabs.group) before it loses ' +
    'Chrome\'s user-gesture window and open() then fails silently, breaking "click the icon to open the extension" entirely');

  // setOptions() may legitimately run before open() - it is callback-style, not awaited, so it
  // does not cross an async boundary either. The actual invariant is just that open() is not
  // preceded by anything that yields to the event loop, which the synchronous-call assertion
  // above already proves; a real await-before-open() bug would make this array empty entirely.
  assert.ok(mock.__callOrder.length >= 1);
});

test('the tab is still enabled and grouped, just not blocking open()', async () => {
  mock.__callOrder.length = 0;
  mock.__tabs.get(100).groupId = -1;

  mock.__listeners.onClicked(mock.__tabs.get(100));
  // ensureScoutFoxGroup chains several of this mock's deliberately-delayed (5ms) async calls
  // (tabs.get, storage.get, tabs.group, storage.set) sequentially - give it enough room to
  // actually finish, not just enough to prove open() didn't wait for it.
  await new Promise((r) => setTimeout(r, 100));

  const enableCall = mock.__callOrder.find((c) => c.call === 'setOptions' && c.opts.tabId === 100 && c.opts.enabled === true);
  assert.ok(enableCall, 'the tab must still be enabled for the panel, just not on open()\'s critical path');
  assert.equal(mock.__tabs.get(100).groupId >= 5000, true, 'the tab must still join the ScoutFox group');
});
