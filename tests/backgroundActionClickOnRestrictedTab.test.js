/**
 * Regression test for a real bug the user reported directly ("still can't open it"),
 * introduced alongside the side-panel-scoping fix in 80c4df1.
 *
 * The click handler required isValidWebTab(tab) before doing ANYTHING - including calling
 * chrome.sidePanel.setOptions()/open(). isValidWebTab exists to decide whether a tab can be
 * SCRIPTED for automation (content-script injection), not whether the panel UI can be shown.
 * A brand new browser tab opens on chrome://newtab/, which isValidWebTab rejects - so clicking
 * the toolbar icon while sitting on an entirely ordinary, freshly-opened tab did nothing at
 * all: setOptions and open() never even ran.
 *
 * Fix: enable + open the panel unconditionally on the clicked tab. isValidWebTab now only
 * gates ensureScoutFoxGroup (automation sandboxing), which is the thing it actually needs to
 * gate.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

function makeMock() {
  const tabs = new Map([
    [100, { id: 100, url: 'chrome://newtab/', groupId: -1 }],   // a brand new, ordinary tab
    [200, { id: 200, url: 'https://example.com/a', groupId: -1 }],
    // Previously missed entirely by isValidWebTab's own separate, narrower URL list - it only
    // recognised chrome://, chrome-extension://, edge:// and about:.
    [300, { id: 300, url: 'https://chromewebstore.google.com/detail/foo', groupId: -1 }],
    [400, { id: 400, url: 'file:///Users/me/notes.txt', groupId: -1 }]
  ]);
  const noop = () => {};
  const listeners = {};
  const callOrder = [];
  let groupCounter = 5000;

  return {
    __tabs: tabs,
    __listeners: listeners,
    __callOrder: callOrder,
    chrome: {
      runtime: { lastError: null, onConnect: { addListener: noop }, onMessage: { addListener: noop } },
      storage: { local: { get: (k, cb) => cb({}), set: (d, cb) => cb && cb(), remove: (k, cb) => cb && cb() } },
      tabs: {
        onRemoved: { addListener: noop },
        onActivated: { addListener: noop },
        onCreated: { addListener: noop },
        onUpdated: { addListener: noop },
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

test('clicking the icon on a restricted tab (chrome://newtab) still opens the panel', async () => {
  mock.__callOrder.length = 0;

  mock.__listeners.onClicked(mock.__tabs.get(100));
  await new Promise((r) => setTimeout(r, 30));

  const enableCall = mock.__callOrder.find((c) => c.call === 'setOptions' && c.opts.tabId === 100 && c.opts.enabled === true);
  const openCall = mock.__callOrder.find((c) => c.call === 'open' && c.opts.tabId === 100);

  assert.ok(enableCall,
    'the panel must be enabled for the clicked tab even when it cannot be automated - the user should always be able to open and SEE the extension');
  assert.ok(openCall,
    'chrome.sidePanel.open() must still be called for a restricted tab, or clicking the icon on a fresh browser tab does nothing at all');
});

test('a restricted tab is not added to the ScoutFox automation group', async () => {
  mock.__callOrder.length = 0;
  mock.__tabs.get(100).groupId = -1;

  mock.__listeners.onClicked(mock.__tabs.get(100));
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(mock.__tabs.get(100).groupId, -1,
    'a tab that cannot be scripted should not be grouped for automation - isValidWebTab should still gate THIS, just not panel visibility');
});

test('a Chrome Web Store tab is recognised as restricted, not grouped for automation', async () => {
  mock.__callOrder.length = 0;
  mock.__tabs.get(300).groupId = -1;

  mock.__listeners.onClicked(mock.__tabs.get(300));
  await new Promise((r) => setTimeout(r, 30));

  const openCall = mock.__callOrder.find((c) => c.call === 'open' && c.opts.tabId === 300);
  assert.ok(openCall, 'the panel must still open on a Web Store tab');
  assert.equal(mock.__tabs.get(300).groupId, -1,
    'a Web Store tab must not be grouped for automation - it used to slip through isValidWebTab\'s narrower, separate URL list as "valid"');
});

test('a file:// tab is recognised as restricted, not grouped for automation', async () => {
  mock.__callOrder.length = 0;
  mock.__tabs.get(400).groupId = -1;

  mock.__listeners.onClicked(mock.__tabs.get(400));
  await new Promise((r) => setTimeout(r, 30));

  const openCall = mock.__callOrder.find((c) => c.call === 'open' && c.opts.tabId === 400);
  assert.ok(openCall, 'the panel must still open on a file:// tab');
  assert.equal(mock.__tabs.get(400).groupId, -1,
    'a file:// tab must not be grouped for automation - also previously missed by isValidWebTab\'s narrower, separate URL list');
});

test('clicking the icon on a normal, scriptable tab still opens the panel AND groups it', async () => {
  mock.__callOrder.length = 0;
  mock.__tabs.get(200).groupId = -1;

  mock.__listeners.onClicked(mock.__tabs.get(200));
  await new Promise((r) => setTimeout(r, 30));

  const openCall = mock.__callOrder.find((c) => c.call === 'open' && c.opts.tabId === 200);
  assert.ok(openCall, 'a normal tab must still open the panel');
  assert.equal(mock.__tabs.get(200).groupId >= 5000, true, 'a normal, scriptable tab must still join the ScoutFox group');
});
