/**
 * Tests for tests/helpers/fakeChrome.ts, the shared fake of the chrome.* surface.
 *
 * The later phases (P3 debugger tests, P4 graph tests with a worker restart, the migration of the
 * hand-made mocks) all stand on it, so this file pins down: the strict Proxy (an undeclared API
 * throws, tools that probe the object do not), the call log, both call styles, and the small real
 * behaviours of every namespace.
 *
 * Events are dispatched a moment after the API call that caused them (like Chrome), so tests that
 * look at events `await fc.settle()` first.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import util from 'node:util';
import { fakeChrome } from './helpers/fakeChrome.ts';
import { createFakeStorage } from './helpers/fakeStorageSession.ts';

const NO_RECEIVER = 'Could not establish connection. Receiving end does not exist.';
const PORT_CLOSED = 'The message port closed before a response was received.';

/** Listen to events by path ('tabs.onCreated'); returns the log of [path, ...args]. */
function listen(fc, ...paths) {
  const log = [];
  for (const path of paths) {
    const event = path.split('.').reduce((object, key) => object[key], fc.chrome);
    event.addListener((...args) => log.push([path, ...args]));
  }
  return log;
}

const twoWindows = () =>
  fakeChrome({
    windows: { list: [{ id: 1, focused: true }, { id: 2 }] },
    tabs: {
      list: [
        { id: 11, windowId: 1, url: 'https://one.test/a' },
        { id: 12, windowId: 1, url: 'https://one.test/b' },
        { id: 21, windowId: 2, url: 'https://two.test/' },
      ],
    },
  });

// ---------------------------------------------------------------------------------------------
// Strictness: what is not declared throws
// ---------------------------------------------------------------------------------------------

test('an undeclared namespace throws when touched, and says how to declare it', () => {
  const fc = fakeChrome({ tabs: true });
  assert.throws(() => fc.chrome.debugger, /chrome\.debugger was not declared for this test - add it with fakeChrome\(\{ debugger: true \}\)/);
  assert.throws(() => fc.chrome.debugger.attach, /chrome\.debugger was not declared/);
  assert.throws(() => fc.chrome.alarms.create({ when: 1 }), /chrome\.alarms was not declared/);
});

test('an undeclared method throws on access (not only on the call) and names the API', () => {
  const fc = fakeChrome({ tabs: true });
  assert.throws(
    () => fc.chrome.tabs.captureVisibleTab,
    /fakeChrome: chrome\.tabs\.captureVisibleTab was not declared for this test - add it to fakeChrome\(\{ tabs: \{ methods: \{ captureVisibleTab: /
  );
  assert.throws(() => typeof fc.chrome.tabs.duplicate, /chrome\.tabs\.duplicate was not declared/);
  assert.throws(() => fc.chrome.tabs.duplicate(1), /chrome\.tabs\.duplicate was not declared/);
});

test('an undeclared event throws with the events option as the hint', () => {
  const fc = fakeChrome({ tabs: true });
  assert.throws(() => fc.chrome.tabs.onReplaced, /chrome\.tabs\.onReplaced was not declared for this test - add it to fakeChrome\(\{ tabs: \{ events: \['onReplaced'\] \} \}\)/);
});

test('a name fakeChrome does not know at all says so, instead of suggesting an option that would be rejected', () => {
  const fc = fakeChrome({ tabs: true });
  assert.throws(() => fc.chrome.bookmarks, /fakeChrome has no chrome\.bookmarks at all/);
});

test('tabs.sendMessage without the content-script side points at dom', () => {
  const fc = fakeChrome({ tabs: true });
  assert.throws(() => fc.chrome.tabs.sendMessage, /chrome\.tabs\.sendMessage was not declared.*dom: \{ <tabId>/);
});

test('every such throw is also kept in fc.violations, even when the code under test swallows it', () => {
  const fc = fakeChrome({ tabs: true });
  const codeUnderTest = () => {
    try {
      fc.chrome.tabs.captureVisibleTab({});
    } catch {
      return 'swallowed';
    }
  };
  assert.equal(codeUnderTest(), 'swallowed');
  assert.equal(fc.violations.length, 1);
  assert.match(fc.violations[0].message, /captureVisibleTab/);
  assert.equal(fc.violations[0].name, 'FakeChromeError');
  assert.throws(() => fc.assertClean(), /1 test mistake\(s\).*captureVisibleTab/s);
  assert.doesNotThrow(() => fakeChrome({ tabs: true }).assertClean());
});

test('declared extras: a method with a value, an Error, an array or a function; an extra event; a replaced built-in', async () => {
  const fc = fakeChrome({
    tabs: {
      list: [{ id: 1, url: 'https://a.test/' }],
      methods: {
        captureVisibleTab: 'data:image/png;base64,AAAA',
        discard: new Error('Cannot discard the active tab'),
        duplicate: [{ id: 50 }, { id: 51 }],
        goBack: (tabId) => ({ wentBack: tabId }),
        get: { id: 1, replaced: true },
      },
      events: ['onReplaced'],
    },
  });
  const { tabs } = fc.chrome;
  assert.equal(await tabs.captureVisibleTab(), 'data:image/png;base64,AAAA');
  await assert.rejects(tabs.discard(1), { message: 'Cannot discard the active tab' });
  assert.equal((await tabs.duplicate(1)).id, 50);
  assert.equal((await tabs.duplicate(1)).id, 51);
  assert.throws(() => tabs.duplicate(1), /chrome\.tabs\.duplicate was called 3 times but only 2 results were scripted/);
  assert.deepEqual(await tabs.goBack(7), { wentBack: 7 });
  assert.deepEqual(await tabs.get(1), { id: 1, replaced: true }, 'a scripted method replaces the built-in one');
  const log = listen(fc, 'tabs.onReplaced');
  fc.fire('tabs.onReplaced', 2, 1);
  assert.deepEqual(log, [['tabs.onReplaced', 2, 1]]);
});

test('a scripted value is copied for each call, so the code under test cannot change what the next call returns', async () => {
  const fc = fakeChrome({ tabs: { methods: { getZoomSettings: { mode: 'automatic', list: [1] } } } });
  const first = await fc.chrome.tabs.getZoomSettings(1);
  first.list.push(2);
  assert.deepEqual(await fc.chrome.tabs.getZoomSettings(1), { mode: 'automatic', list: [1] });
});

test('scripted results that run out give a clear error naming the API and the counts, never undefined', async () => {
  const fc = fakeChrome({
    tabs: { list: [{ id: 1 }], methods: { getZoomSettings: ['a', 'b'] } },
    scripting: { executeScript: [1] },
    debugger: { commands: { 'Page.reload': [{}] } },
    dom: { 1: { PING: [{ pong: 1 }] } },
    runtime: { sendMessage: [{ ok: 1 }] },
  });
  const c = fc.chrome;
  await c.tabs.getZoomSettings(1);
  await c.tabs.getZoomSettings(1);
  assert.throws(() => c.tabs.getZoomSettings(1), /chrome\.tabs\.getZoomSettings was called 3 times but only 2 results were scripted - add more entries to the array, or use a function/);

  await c.scripting.executeScript({ target: { tabId: 1 }, func: () => 1 });
  assert.throws(() => c.scripting.executeScript({ target: { tabId: 1 }, func: () => 1 }), /chrome\.scripting\.executeScript was called 2 times but only 1 result was scripted/);

  await c.debugger.attach({ tabId: 1 }, '1.3');
  await c.debugger.sendCommand({ tabId: 1 }, 'Page.reload');
  assert.throws(() => c.debugger.sendCommand({ tabId: 1 }, 'Page.reload'), /chrome\.debugger\.sendCommand\('Page\.reload'\) was called 2 times but only 1 result was scripted/);

  await c.tabs.sendMessage(1, { action: 'PING' });
  assert.throws(() => c.tabs.sendMessage(1, { action: 'PING' }), /the dom handler for 'PING' on tab 1 was called 2 times but only 1 result was scripted/);

  await c.runtime.sendMessage({ x: 1 });
  assert.throws(() => c.runtime.sendMessage({ x: 1 }), /chrome\.runtime\.sendMessage was called 2 times but only 1 result was scripted/);
  assert.equal(fc.violations.length, 5, 'each one is also kept as a test mistake');
});

test('a queue entry that is a function is called with the arguments of that call', async () => {
  const fc = fakeChrome({ scripting: { executeScript: [(injection) => injection.args[0] * 2, new Error('second call fails')] } });
  const first = await fc.chrome.scripting.executeScript({ target: { tabId: 1 }, func: () => {}, args: [21] });
  assert.equal(first[0].result, 42);
  await assert.rejects(fc.chrome.scripting.executeScript({ target: { tabId: 1 }, func: () => {} }), { message: 'second call fails' });
});

test('a function that throws is a bug in the test: the throw reaches the caller untouched', () => {
  const fc = fakeChrome({ scripting: { executeScript: () => { throw new RangeError('assertion in a handler'); } } });
  assert.throws(() => fc.chrome.scripting.executeScript({ target: { tabId: 1 }, func: () => {} }), RangeError);
});

test('unknown namespaces and unknown options are refused at construction, so a typo cannot pass silently', () => {
  assert.throws(() => fakeChrome({ bookmarks: true }), /unknown namespace "bookmarks"/);
  assert.throws(() => fakeChrome({ tabs: { lst: [] } }), /unknown option "lst" in fakeChrome\(\{ tabs: \{\.\.\.\} \}\); known options: list, navigation, methods, events/);
  assert.throws(() => fakeChrome({ dom: true }), /dom needs tabs declared too/);
  assert.throws(() => fakeChrome({ runtime: false }), /chrome\.runtime always exists/);
});

test('chrome.runtime always exists with id and lastError; the rest of it needs runtime: true', () => {
  const bare = fakeChrome({ tabs: true });
  assert.equal(typeof bare.chrome.runtime.id, 'string');
  assert.equal(bare.chrome.runtime.lastError, undefined);
  assert.throws(() => bare.chrome.runtime.sendMessage, /chrome\.runtime\.sendMessage was not declared for this test - chrome\.runtime only has id and lastError here/);
  assert.throws(() => bare.chrome.runtime.onMessage, /chrome\.runtime only has id and lastError here/);
  const full = fakeChrome({ runtime: true });
  assert.doesNotThrow(() => full.chrome.runtime.onMessage.addListener(() => {}));
});

test('`false` means the browser has no such API: undefined, no throw, and `in` says no', () => {
  const fc = fakeChrome({ tabs: true, sidePanel: false, storage: false });
  assert.equal(fc.chrome.sidePanel, undefined);
  assert.equal(fc.chrome.storage, undefined);
  assert.equal('sidePanel' in fc.chrome, false);
  const featureDetect = fc.chrome.sidePanel && fc.chrome.sidePanel.setOptions ? 'has side panel' : 'no side panel';
  assert.equal(featureDetect, 'no side panel');
  assert.equal(fc.violations.length, 0);
});

test('`in` never throws: it says whether a namespace is declared', () => {
  const fc = fakeChrome({ tabs: true, alarms: true });
  assert.equal('tabs' in fc.chrome, true);
  assert.equal('alarms' in fc.chrome, true);
  assert.equal('debugger' in fc.chrome, false);
  assert.equal('captureVisibleTab' in fc.chrome.tabs, false);
  assert.equal('get' in fc.chrome.tabs, true);
  assert.equal(fc.violations.length, 0);
});

test('assigning a member is allowed, as an escape hatch for one-off tricks', async () => {
  const fc = fakeChrome({ tabs: true });
  fc.chrome.tabs.captureVisibleTab = async () => 'shot';
  assert.equal(await fc.chrome.tabs.captureVisibleTab(), 'shot');
});

// ---------------------------------------------------------------------------------------------
// The Proxy is safe for tools that probe objects
// ---------------------------------------------------------------------------------------------

test('the proxy does not throw for await, JSON.stringify, util.inspect, string conversion or symbols', async () => {
  const fc = fakeChrome({ tabs: true, storage: true, runtime: true, alarms: true });
  const { chrome } = fc;
  // await: `then` is not there, so the object is not treated as a promise
  assert.equal(await chrome, chrome);
  assert.equal(await chrome.tabs, chrome.tabs);
  assert.equal(await Promise.resolve(chrome.storage.session), chrome.storage.session);
  // JSON.stringify: toJSON is not there, functions are skipped
  assert.doesNotThrow(() => JSON.stringify(chrome));
  const json = JSON.parse(JSON.stringify(chrome));
  assert.equal(json.tabs.TAB_ID_NONE, -1);
  assert.equal(json.storage.local.QUOTA_BYTES, 10485760);
  // util.inspect / console.log / %o: a short description, no dump, no throw
  assert.match(util.inspect(chrome), /^FakeChrome chrome \{ runtime, tabs, alarms, storage \}$/);
  assert.match(util.inspect(chrome.tabs), /^FakeChrome chrome\.tabs \{/);
  assert.doesNotThrow(() => util.format('%o %O %s %j', chrome, chrome.tabs, chrome, chrome));
  assert.doesNotThrow(() => util.inspect(chrome, { showHidden: true, depth: 5, showProxy: true }));
  // string conversion and symbol keys
  assert.equal(String(chrome), '[object Object]');
  assert.equal(chrome[Symbol('anything')], undefined);
  assert.equal(chrome[Symbol.toPrimitive], undefined);
  assert.equal(chrome.tabs[Symbol.iterator], undefined);
  assert.equal(chrome[Symbol.for('nodejs.util.inspect.custom')] instanceof Function, true);
  // keys tools probe
  for (const key of ['then', 'toJSON', 'inspect', 'asymmetricMatch', '$$typeof', 'nodeType', 'tagName', '_isMockFunction', '__esModule']) {
    assert.equal(chrome[key], undefined, key);
    assert.equal(chrome.tabs[key], undefined, key);
  }
  assert.equal(typeof chrome.constructor, 'function');
  assert.equal(typeof chrome.tabs.hasOwnProperty, 'function');
  assert.deepEqual(Object.keys(chrome), ['runtime', 'tabs', 'alarms', 'storage']);
  assert.equal(fc.violations.length, 0, 'none of this counted as a test mistake');
});

test('an assert diff between the fake and something else prints instead of throwing a fakeChrome error', () => {
  const fc = fakeChrome({ tabs: true });
  assert.throws(() => assert.deepStrictEqual(fc.chrome.tabs, {}), (error) => error.name === 'AssertionError');
  assert.throws(() => assert.deepStrictEqual(fc.chrome, { tabs: {} }), (error) => error.name === 'AssertionError');
  assert.equal(fc.violations.length, 0);
});

// ---------------------------------------------------------------------------------------------
// Recorded calls
// ---------------------------------------------------------------------------------------------

test('calls: every call is recorded in order as { api, args }, without the callback', async () => {
  const fc = fakeChrome({ tabs: { list: [{ id: 1, url: 'https://a.test/' }] }, alarms: true, sidePanel: true, storage: true });
  const { chrome } = fc;
  await chrome.tabs.get(1);
  chrome.tabs.update(1, { pinned: true }, () => {});
  await chrome.sidePanel.setOptions({ tabId: 1, enabled: true });
  await chrome.storage.local.set({ a: 1 });
  await chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
  assert.deepEqual(fc.calls.map((c) => c.api), ['tabs.get', 'tabs.update', 'sidePanel.setOptions', 'storage.local.set', 'alarms.create']);
  assert.deepEqual(fc.calls[1], { api: 'tabs.update', args: [1, { pinned: true }] });
  assert.deepEqual(fc.calls[3].args, [{ a: 1 }]);
});

test('calls: callsTo() filters by API, resetCalls() empties the same array', async () => {
  const fc = fakeChrome({ tabs: { list: [{ id: 1 }, { id: 2 }] } });
  await fc.chrome.tabs.get(1);
  await fc.chrome.tabs.get(2);
  await fc.chrome.tabs.query({});
  assert.deepEqual(fc.callsTo('tabs.get').map((c) => c.args), [[1], [2]]);
  assert.equal(fc.callsTo('tabs.query').length, 1);
  assert.deepEqual(fc.callsTo('tabs.remove'), []);
  const held = fc.calls;
  fc.resetCalls();
  assert.equal(held.length, 0);
  assert.equal(fc.calls, held, 'the array is emptied in place');
  await fc.chrome.tabs.get(1);
  assert.equal(held.length, 1);
});

test('calls: the recorded args are copies made at call time; functions are kept as they are', async () => {
  const fc = fakeChrome({ scripting: { executeScript: [null] }, tabs: { list: [{ id: 1 }] } });
  const options = { target: { tabId: 1 }, func: function marker() {}, args: [{ deep: 1 }] };
  await fc.chrome.scripting.executeScript(options);
  options.args[0].deep = 999;
  assert.equal(fc.calls[0].args[0].args[0].deep, 1);
  assert.equal(fc.calls[0].args[0].func, options.func);
});

test('calls: addListener and removeListener are calls too', () => {
  const fc = fakeChrome({ tabs: true });
  const listener = () => {};
  fc.chrome.tabs.onCreated.addListener(listener);
  fc.chrome.tabs.onCreated.removeListener(listener);
  assert.deepEqual(fc.calls, [
    { api: 'tabs.onCreated.addListener', args: [listener] },
    { api: 'tabs.onCreated.removeListener', args: [listener] },
  ]);
  assert.equal(fc.chrome.tabs.onCreated.hasListener(listener), false);
});

test('calls: a call that fails, or that throws for a bad argument, is still recorded', async () => {
  const fc = fakeChrome({ tabs: true });
  await assert.rejects(fc.chrome.tabs.get(404), { message: 'No tab with id: 404.' });
  assert.throws(() => fc.chrome.tabs.get('nope'), TypeError);
  assert.deepEqual(fc.calls.map((c) => c.args), [[404], ['nope']]);
});

// ---------------------------------------------------------------------------------------------
// Both call styles, lastError
// ---------------------------------------------------------------------------------------------

test('call styles: the same answer as a promise or in a callback, and the callback style returns nothing', async () => {
  const fc = fakeChrome({
    tabs: { list: [{ id: 1, url: 'https://a.test/' }] },
    tabGroups: true,
    windows: true,
    sidePanel: true,
    alarms: true,
    action: true,
    declarativeNetRequest: true,
    storage: true,
    runtime: true,
  });
  const c = fc.chrome;
  const cases = [
    [c.tabs.get, [1]],
    [c.tabs.query, [{}]],
    [c.tabGroups.query, [{}]],
    [c.windows.getAll, []],
    [c.windows.getCurrent, []],
    [c.sidePanel.getOptions, [{}]],
    [c.sidePanel.getPanelBehavior, []],
    [c.alarms.getAll, []],
    [c.action.getBadgeText, [{}]],
    [c.declarativeNetRequest.getSessionRules, []],
    [c.declarativeNetRequest.getDynamicRules, []],
    [c.storage.local.get, [null]],
    [c.storage.session.getKeys, []],
    [c.runtime.getPlatformInfo, []],
  ];
  for (const [fn, args] of cases) {
    const promise = fn(...args);
    assert.ok(promise instanceof Promise, `${fn.name || 'call'} returns a promise without a callback`);
    const viaPromise = await promise;
    const seen = await new Promise((resolve) => assert.equal(fn(...args, (value) => resolve(value)), undefined));
    assert.deepEqual(seen, viaPromise);
  }
});

test('call styles: an API with no result calls its callback with no arguments at all (not with undefined)', async () => {
  const fc = fakeChrome({
    tabs: { list: [{ id: 1, url: 'https://a.test/' }, { id: 2, url: 'https://b.test/' }] },
    storage: true,
    sidePanel: true,
    action: true,
    declarativeNetRequest: true,
  });
  const c = fc.chrome;
  const callbackArgs = (fn, ...args) => new Promise((resolve) => fn(...args, (...seen) => resolve(seen)));
  const cases = [
    ['storage.local.set', c.storage.local.set, [{ a: 1 }]],
    ['storage.local.remove', c.storage.local.remove, ['a']],
    ['storage.session.clear', c.storage.session.clear, []],
    ['tabs.remove', c.tabs.remove, [2]],
    ['sidePanel.setOptions', c.sidePanel.setOptions, [{ enabled: true }]],
    ['action.setBadgeText', c.action.setBadgeText, [{ text: 'ON' }]],
    ['declarativeNetRequest.updateSessionRules', c.declarativeNetRequest.updateSessionRules, [{ addRules: [] }]],
  ];
  for (const [name, fn, args] of cases) {
    assert.deepEqual(await callbackArgs(fn, ...args), [], `${name}: the callback gets zero arguments`);
  }
  // Chrome runs a callback with no arguments for these. Code that checks arguments.length, or that
  // takes (result) and tests `=== undefined`, sees a difference between [] and [undefined].
});

test('lastError: a failing call rejects, or sets runtime.lastError only while its callback runs', async () => {
  const fc = fakeChrome({ tabs: true });
  const { chrome } = fc;
  await assert.rejects(chrome.tabs.get(404), { message: 'No tab with id: 404.' });
  assert.equal(chrome.runtime.lastError, undefined, 'the promise style never sets lastError');

  const seen = [];
  await new Promise((resolve) =>
    chrome.tabs.get(404, (...args) => {
      seen.push({ args, message: chrome.runtime.lastError?.message });
      resolve();
    })
  );
  assert.deepEqual(seen, [{ args: [], message: 'No tab with id: 404.' }]);
  assert.equal(chrome.runtime.lastError, undefined, 'and it is gone again after the callback');
  assert.deepEqual(fc.uncheckedLastErrors, []);
});

test('lastError: a callback that never reads it is reported in fc.uncheckedLastErrors', async () => {
  const fc = fakeChrome({ tabs: true });
  fc.chrome.tabs.get(404, () => {});
  fc.chrome.tabs.get(405, () => void fc.chrome.runtime.lastError);
  await fc.settle();
  assert.deepEqual(fc.uncheckedLastErrors, ['No tab with id: 404.']);
});

test('fc.settle() waits for callbacks and events the fake queued', async () => {
  const fc = fakeChrome({ tabs: { list: [{ id: 1 }] } });
  const log = listen(fc, 'tabs.onUpdated');
  fc.chrome.tabs.update(1, { url: 'https://x.test/' }, () => {});
  assert.deepEqual(log, [], 'nothing has happened yet');
  await fc.settle();
  assert.deepEqual(log.map(([, , change]) => change), [{ status: 'loading', url: 'https://x.test/' }, { status: 'complete' }]);
});

// ---------------------------------------------------------------------------------------------
// tabs
// ---------------------------------------------------------------------------------------------

test('tabs: seeded tabs get Chrome-like defaults, one active tab per window, and their own windows', async () => {
  const fc = twoWindows();
  const tabs = await fc.chrome.tabs.query({});
  assert.deepEqual(tabs.map((t) => [t.id, t.windowId, t.index, t.active]), [
    [11, 1, 0, true],
    [12, 1, 1, false],
    [21, 2, 0, true],
  ]);
  assert.deepEqual(tabs[0], {
    id: 11, windowId: 1, index: 0, groupId: -1, active: true, highlighted: true, pinned: false, incognito: false,
    discarded: false, autoDiscardable: true, audible: false, status: 'complete', url: 'https://one.test/a', title: '',
  });
});

test('tabs: seeding refuses two active tabs in one window and duplicate ids', () => {
  assert.throws(() => fakeChrome({ tabs: { list: [{ id: 1, active: true }, { id: 2, active: true }] } }), /window 1 has 2 active tabs/);
  assert.throws(() => fakeChrome({ tabs: { list: [{ id: 1 }, { id: 1 }] } }), /tab id 1 already exists/);
});

test('tabs.get: a copy of the tab, or "No tab with id"', async () => {
  const fc = fakeChrome({ tabs: { list: [{ id: 5, url: 'https://a.test/' }] } });
  const tab = await fc.chrome.tabs.get(5);
  tab.url = 'https://changed.test/';
  assert.equal((await fc.chrome.tabs.get(5)).url, 'https://a.test/', 'changing the copy does not change the browser');
  await assert.rejects(fc.chrome.tabs.get(999), { message: 'No tab with id: 999.' });
  assert.throws(() => fc.chrome.tabs.get('5'), TypeError);
});

test('tabs.query: the filters that matter', async () => {
  const fc = twoWindows();
  const ids = async (q) => (await fc.chrome.tabs.query(q)).map((t) => t.id);
  assert.deepEqual(await ids({}), [11, 12, 21]);
  assert.deepEqual(await ids({ active: true }), [11, 21]);
  assert.deepEqual(await ids({ active: true, currentWindow: true }), [11]);
  assert.deepEqual(await ids({ active: true, lastFocusedWindow: true }), [11]);
  assert.deepEqual(await ids({ currentWindow: false }), [21]);
  assert.deepEqual(await ids({ windowId: 2 }), [21]);
  assert.deepEqual(await ids({ windowId: -2 }), [11, 12], 'WINDOW_ID_CURRENT is the focused window');
  assert.deepEqual(await ids({ index: 1 }), [12]);
  assert.deepEqual(await ids({ status: 'complete', pinned: false }), [11, 12, 21]);
  assert.deepEqual(await ids({ url: 'https://one.test/*' }), [11, 12]);
  assert.deepEqual(await ids({ url: ['*://two.test/*', 'https://one.test/b'] }), [12, 21]);
  assert.deepEqual(await ids({ url: '*://*.test/a' }), [11]);
  assert.deepEqual(await ids({ url: '<all_urls>' }), [11, 12, 21]);
  assert.deepEqual(await ids({ url: 'http://one.test/*' }), []);
  assert.deepEqual(await ids({ groupId: -1 }), [11, 12, 21]);
  assert.deepEqual(await ids({ windowType: 'normal' }), [11, 12, 21]);
  assert.throws(() => fc.chrome.tabs.query({ nonsense: true }), /does not implement the 'nonsense' filter/);
  assert.throws(() => fc.chrome.tabs.query('all'), TypeError);
});

test('tabs.query: windowType keeps only the tabs of windows of that type', async () => {
  const fc = fakeChrome({
    windows: { list: [{ id: 1, focused: true }, { id: 2, type: 'popup' }, { id: 3, type: 'devtools' }] },
    tabs: {
      list: [
        { id: 11, windowId: 1 },
        { id: 21, windowId: 2 },
        { id: 22, windowId: 2 },
        { id: 31, windowId: 3 },
      ],
    },
  });
  const ids = async (q) => (await fc.chrome.tabs.query(q)).map((t) => t.id);
  assert.deepEqual(await ids({ windowType: 'normal' }), [11]);
  assert.deepEqual(await ids({ windowType: 'popup' }), [21, 22]);
  assert.deepEqual(await ids({ windowType: 'devtools' }), [31]);
  assert.deepEqual(await ids({ windowType: 'app' }), [], 'a type no window has');
  assert.deepEqual(await ids({ windowType: 'popup', active: true }), [21], 'and it combines with the other filters');
  assert.deepEqual(await ids({}), [11, 21, 22, 31], 'without the filter every window counts');
});

test('tabs.query: a *.host pattern matches the host and its subdomains, and not a host that only ends in the same letters', async () => {
  const fc = fakeChrome({
    tabs: {
      list: [
        { id: 1, url: 'https://example.test/' },
        { id: 2, url: 'https://a.example.test/' },
        { id: 3, url: 'https://b.a.example.test/x' },
        { id: 4, url: 'https://fooexample.test/' },
        { id: 5, url: 'https://example.test.evil.test/' },
        { id: 6, url: 'https://example.testing/' },
      ],
    },
  });
  const ids = async (pattern) => (await fc.chrome.tabs.query({ url: pattern })).map((t) => t.id);
  assert.deepEqual(await ids('*://*.example.test/*'), [1, 2, 3], 'the bare domain and every level of subdomain');
  assert.deepEqual(await ids('*://example.test/*'), [1], 'no wildcard: the exact host only');
  assert.deepEqual(await ids('https://*.a.example.test/*'), [2, 3]);
});

test('tabs.query: title globs and mute state', async () => {
  const fc = fakeChrome({ tabs: { list: [{ id: 1, title: 'Framework Laptop 13' }, { id: 2, title: 'idealo' }] } });
  assert.deepEqual((await fc.chrome.tabs.query({ title: 'Framework*' })).map((t) => t.id), [1]);
  await fc.chrome.tabs.update(2, { muted: true });
  assert.deepEqual((await fc.chrome.tabs.query({ muted: true })).map((t) => t.id), [2]);
});

test('tabs.query: <all_urls> matches web and file pages, never browser pages such as chrome:// or an extension page', async () => {
  const fc = fakeChrome({
    tabs: {
      list: [
        { id: 1, url: 'https://example.test/' },
        { id: 2, url: 'file:///tmp/a.html' },
        { id: 3, url: 'chrome://extensions/' },
        { id: 4, url: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/sidepanel/sidepanel.html' },
        { id: 5, url: 'about:blank' },
      ],
    },
  });
  assert.deepEqual((await fc.chrome.tabs.query({ url: '<all_urls>' })).map((t) => t.id), [1, 2]);
});

test('tabs.create: the tab starts loading and its URL commits a moment later, with the events in Chrome\'s order', async () => {
  const fc = twoWindows();
  const log = listen(fc, 'tabs.onCreated', 'tabs.onActivated', 'tabs.onUpdated');
  const created = await fc.chrome.tabs.create({ url: 'https://new.test/' });
  assert.equal(created.status, 'loading');
  assert.equal(created.url, '');
  assert.equal(created.pendingUrl, 'https://new.test/');
  assert.equal(created.active, true);
  assert.equal(created.windowId, 1, 'in the focused window');
  assert.equal(created.index, 2);
  assert.ok(created.id > 21);
  await fc.settle();
  assert.deepEqual(log.map((entry) => entry[0]), ['tabs.onCreated', 'tabs.onActivated', 'tabs.onUpdated', 'tabs.onUpdated']);
  assert.deepEqual(log[1][1], { tabId: created.id, windowId: 1 });
  assert.deepEqual(log[2].slice(1, 3), [created.id, { status: 'loading', url: 'https://new.test/' }]);
  assert.deepEqual(log[3].slice(1, 3), [created.id, { status: 'complete' }]);
  const now = await fc.chrome.tabs.get(created.id);
  assert.deepEqual([now.url, now.status, now.pendingUrl], ['https://new.test/', 'complete', undefined]);
  assert.equal((await fc.chrome.tabs.get(11)).active, false, 'the old active tab is no longer active');
});

test('tabs.create: background tab, other window, index, opener, and a bare create opens the new tab page', async () => {
  const fc = twoWindows();
  const background = await fc.chrome.tabs.create({ url: 'https://bg.test/', active: false, windowId: 2 });
  assert.deepEqual([background.active, background.windowId], [false, 2]);
  const inserted = await fc.chrome.tabs.create({ url: 'https://ins.test/', index: 0, openerTabId: 12 });
  assert.deepEqual([inserted.index, inserted.openerTabId], [0, 12]);
  assert.deepEqual((await fc.chrome.tabs.query({ windowId: 1 })).map((t) => t.index), [0, 1, 2]);
  const bare = await fc.chrome.tabs.create({});
  assert.equal(bare.pendingUrl, 'chrome://newtab/');
  assert.throws(() => fc.chrome.tabs.create({ colour: 'red' }), /Unexpected property: 'colour'/);
  await assert.rejects(fc.chrome.tabs.create({ windowId: 77 }), { message: 'No window with id: 77.' });
});

test('tabs.create: the callback style gets the tab', async () => {
  const fc = fakeChrome({ tabs: true });
  const { args } = await new Promise((resolve) => fc.chrome.tabs.create({ url: 'https://x.test/' }, (...a) => resolve({ args: a })));
  assert.equal(args[0].pendingUrl, 'https://x.test/');
});

test('tabs.update: a URL change navigates (loading, then complete); the returned tab still has the old URL', async () => {
  const fc = fakeChrome({ tabs: { list: [{ id: 1, url: 'https://old.test/' }] } });
  const log = listen(fc, 'tabs.onUpdated');
  const returned = await fc.chrome.tabs.update(1, { url: 'https://new.test/' });
  assert.equal(returned.url, 'https://old.test/');
  assert.equal(returned.pendingUrl, 'https://new.test/');
  await fc.settle();
  assert.deepEqual(log.map(([, id, change, tab]) => [id, change, tab.status]), [
    [1, { status: 'loading', url: 'https://new.test/' }, 'loading'],
    [1, { status: 'complete' }, 'complete'],
  ]);
  assert.equal((await fc.chrome.tabs.get(1)).url, 'https://new.test/');
});

test('tabs.update: navigation "manual" keeps the tab loading until completeLoad()', async () => {
  const fc = fakeChrome({ tabs: { list: [{ id: 1, url: 'https://old.test/' }], navigation: 'manual' } });
  const log = listen(fc, 'tabs.onUpdated');
  await fc.chrome.tabs.update(1, { url: 'https://slow.test/' });
  await fc.settle();
  assert.equal((await fc.chrome.tabs.get(1)).status, 'loading');
  assert.equal(log.length, 1);
  fc.tabs.completeLoad(1, { title: 'Slow page' });
  assert.deepEqual(log[1].slice(1, 3), [1, { status: 'complete', title: 'Slow page' }]);
  assert.deepEqual([(await fc.chrome.tabs.get(1)).status, (await fc.chrome.tabs.get(1)).title], ['complete', 'Slow page']);
});

test('tabs.update: active moves the active flag inside the window and fires onActivated; pinned fires onUpdated', async () => {
  const fc = twoWindows();
  const log = listen(fc, 'tabs.onActivated', 'tabs.onUpdated');
  await fc.chrome.tabs.update(12, { active: true, pinned: true });
  await fc.settle();
  assert.deepEqual((await fc.chrome.tabs.query({ windowId: 1 })).map((t) => [t.id, t.active]), [[11, false], [12, true]]);
  assert.equal((await fc.chrome.tabs.get(21)).active, true, 'the other window is untouched');
  assert.deepEqual(log[0], ['tabs.onActivated', { tabId: 12, windowId: 1 }]);
  assert.deepEqual(log[1].slice(0, 3), ['tabs.onUpdated', 12, { pinned: true }]);
});

test('tabs.update: without a tab id it updates the active tab; bad calls fail', async () => {
  const fc = twoWindows();
  await fc.chrome.tabs.update({ pinned: true });
  assert.equal((await fc.chrome.tabs.get(11)).pinned, true);
  await assert.rejects(fc.chrome.tabs.update(999, { pinned: true }), { message: 'No tab with id: 999.' });
  assert.throws(() => fc.chrome.tabs.update(11, { colour: 'red' }), /Unexpected property: 'colour'/);
  assert.throws(() => fc.chrome.tabs.update(11), TypeError);
});

test('tabs.remove: fires onRemoved, activates a neighbour, and closes the window with its last tab', async () => {
  const fc = twoWindows();
  const log = listen(fc, 'tabs.onRemoved', 'tabs.onActivated', 'windows.onRemoved');
  await fc.chrome.tabs.remove(11); // the active tab of window 1
  await fc.settle();
  assert.deepEqual(log[0], ['tabs.onRemoved', 11, { windowId: 1, isWindowClosing: false }]);
  assert.deepEqual(log[1], ['tabs.onActivated', { tabId: 12, windowId: 1 }]);
  assert.equal((await fc.chrome.tabs.get(12)).active, true);
  assert.deepEqual((await fc.chrome.tabs.get(12)).index, 0);
  await fc.chrome.tabs.remove(21); // the only tab of window 2
  await fc.settle();
  assert.deepEqual(log.at(-1), ['windows.onRemoved', 2]);
});

test('tabs.remove: an array of ids, and a missing id fails without removing any', async () => {
  const fc = twoWindows();
  await assert.rejects(fc.chrome.tabs.remove([12, 999]), { message: 'No tab with id: 999.' });
  assert.equal((await fc.chrome.tabs.query({})).length, 3);
  await fc.chrome.tabs.remove([12, 21]);
  assert.deepEqual((await fc.chrome.tabs.query({})).map((t) => t.id), [11]);
});

test('tabs.reload: the tab goes loading, then complete, at the same URL', async () => {
  const fc = fakeChrome({ tabs: { list: [{ id: 1, url: 'https://a.test/' }] } });
  const log = listen(fc, 'tabs.onUpdated');
  await fc.chrome.tabs.reload(1);
  await fc.settle();
  assert.deepEqual(log.map((e) => e[2]), [{ status: 'loading', url: 'https://a.test/' }, { status: 'complete' }]);
});

test('tabs.group: a NEW group lands in the focused window and drags the tab there, unless createProperties.windowId says otherwise', async () => {
  const fc = fakeChrome({
    windows: { list: [{ id: 7 }, { id: 99, focused: true }] },
    tabs: { list: [{ id: 101, windowId: 7 }, { id: 102, windowId: 7 }, { id: 201, windowId: 99 }] },
    tabGroups: true,
  });
  const log = listen(fc, 'tabGroups.onCreated', 'tabs.onUpdated');
  const dragged = await fc.chrome.tabs.group({ tabIds: 101 });
  assert.equal((await fc.chrome.tabs.get(101)).windowId, 99, 'the tab was dragged into the focused window');
  assert.equal((await fc.chrome.tabGroups.get(dragged)).windowId, 99);
  const stays = await fc.chrome.tabs.group({ tabIds: [102], createProperties: { windowId: 7 } });
  assert.equal((await fc.chrome.tabs.get(102)).windowId, 7, 'with createProperties.windowId it stays');
  assert.notEqual(stays, dragged);
  await fc.settle();
  assert.deepEqual(log.filter((e) => e[0] === 'tabGroups.onCreated').map((e) => e[1].windowId), [99, 7]);
  assert.deepEqual(log.filter((e) => e[0] === 'tabs.onUpdated').map((e) => [e[1], e[2]]), [[101, { groupId: dragged }], [102, { groupId: stays }]]);
});

test('tabs.group: joining an existing group, and moving a tab between groups drops the group it leaves', async () => {
  const fc = fakeChrome({ tabs: { list: [{ id: 1 }, { id: 2 }, { id: 3 }] }, tabGroups: true });
  const log = listen(fc, 'tabGroups.onRemoved');
  const a = await fc.chrome.tabs.group({ tabIds: [1, 2] });
  const b = await fc.chrome.tabs.group({ tabIds: 3 });
  assert.deepEqual((await fc.chrome.tabs.query({ groupId: a })).map((t) => t.id), [1, 2]);
  await fc.chrome.tabs.group({ tabIds: 3, groupId: a });
  assert.deepEqual((await fc.chrome.tabs.query({ groupId: a })).map((t) => t.id), [1, 2, 3]);
  await fc.settle();
  assert.deepEqual(log.map((e) => e[1].id), [b], 'group b lost its only tab');
  await assert.rejects(fc.chrome.tabs.group({ tabIds: 1, groupId: 999 }), { message: 'No group with id: 999.' });
  await assert.rejects(fc.chrome.tabs.group({ tabIds: [1, 404] }), { message: 'No tab with id: 404.' });
  assert.throws(() => fc.chrome.tabs.group({ tabIds: [] }), TypeError);
});

test('tabs.ungroup: the tab leaves its group, an empty group is removed, ungrouping a loose tab does nothing', async () => {
  const fc = fakeChrome({ tabs: { list: [{ id: 1 }, { id: 2 }] }, tabGroups: true });
  const gid = await fc.chrome.tabs.group({ tabIds: [1, 2] });
  const log = listen(fc, 'tabs.onUpdated', 'tabGroups.onRemoved');
  await fc.chrome.tabs.ungroup(1);
  await fc.settle();
  assert.deepEqual(log.map((e) => [e[0], e[1] ?? null]), [['tabs.onUpdated', 1]]);
  assert.equal(log[0][2].groupId, -1);
  await fc.chrome.tabs.ungroup([2, 1]);
  await fc.settle();
  assert.equal(log.filter((e) => e[0] === 'tabGroups.onRemoved').length, 1);
  await assert.rejects(fc.chrome.tabGroups.get(gid), { message: `No group with id: ${gid}.` });
});

test('tabs.group without tabGroups declared still works (tabs.group belongs to tabs)', async () => {
  const fc = fakeChrome({ tabs: { list: [{ id: 1 }] } });
  const gid = await fc.chrome.tabs.group({ tabIds: 1 });
  assert.equal((await fc.chrome.tabs.get(1)).groupId, gid);
  assert.throws(() => fc.chrome.tabGroups, /chrome\.tabGroups was not declared/, 'the group exists but chrome.tabGroups is not there to ask about it');
  assert.throws(() => fc.tabGroups, /fc\.tabGroups is not available/);
});

test('tabs: tabs seeded with a groupId get that group, even if it was not listed', async () => {
  const fc = fakeChrome({ tabs: { list: [{ id: 1, groupId: 5 }] }, tabGroups: true });
  assert.deepEqual(await fc.chrome.tabGroups.get(5), { id: 5, windowId: 1, title: '', color: 'grey', collapsed: false });
});

test('tabs handle: add() opens a tab as the user would (onCreated with a copy), close() closes one, activate() switches', async () => {
  const fc = twoWindows();
  const log = listen(fc, 'tabs.onCreated', 'tabs.onActivated', 'tabs.onRemoved');
  const added = fc.tabs.add({ id: 300, openerTabId: 11, url: 'https://opened.test/' });
  assert.deepEqual([added.id, added.windowId, added.active, added.openerTabId], [300, 1, false, 11]);
  assert.deepEqual(log, [['tabs.onCreated', added]], 'the listener already ran, synchronously');
  fc.tabs.add({ id: 301, active: true });
  assert.equal(fc.tabs.get(301).active, true);
  assert.equal(fc.tabs.get(11).active, false);
  assert.deepEqual(log.at(-1), ['tabs.onActivated', { tabId: 301, windowId: 1 }]);
  fc.tabs.activate(12);
  assert.equal(fc.tabs.get(12).active, true);
  fc.tabs.close(300);
  assert.deepEqual(log.at(-1), ['tabs.onRemoved', 300, { windowId: 1, isWindowClosing: false }]);
  assert.equal(fc.tabs.get(300), undefined);
  assert.deepEqual(fc.tabs.list().map((t) => t.id), [11, 12, 301, 21]);
  // The three listen() calls are the only chrome.* calls this test made. add(), activate() and close() are the user's actions, not the code's, so they are not in the log.
  assert.deepEqual(fc.calls.map((c) => c.api), ['tabs.onCreated.addListener', 'tabs.onActivated.addListener', 'tabs.onRemoved.addListener']);
  assert.ok(fc.calls.every((c) => c.args.length === 1 && typeof c.args[0] === 'function'), 'each one carries its listener');
});

test('tabs handle: navigate() and patch() fire onUpdated; list() and get() return copies', async () => {
  const fc = fakeChrome({ tabs: { list: [{ id: 1, url: 'https://a.test/', title: 'A' }] } });
  const log = listen(fc, 'tabs.onUpdated');
  fc.tabs.navigate(1, 'https://b.test/');
  assert.deepEqual(log.map((e) => e[2]), [{ status: 'loading', url: 'https://b.test/' }, { status: 'complete' }]);
  fc.tabs.patch(1, { title: 'B', audible: true });
  assert.deepEqual(log.at(-1).slice(1, 3), [1, { title: 'B', audible: true }]);
  const listed = fc.tabs.list();
  listed[0].title = 'changed';
  fc.tabs.get(1).title = 'changed';
  assert.equal(fc.tabs.get(1).title, 'B');
});

test('tabs handle: asking for it when tabs was not declared says how to declare it', () => {
  const fc = fakeChrome({ alarms: true });
  assert.throws(() => fc.tabs, /fc\.tabs is not available because tabs was not declared - add tabs: true/);
  assert.throws(() => fc.storage, /fc\.storage is not available because storage was not declared/);
  assert.throws(() => fc.dom, /fc\.dom is not available/);
});

// ---------------------------------------------------------------------------------------------
// tabs.sendMessage and the content-script side (dom)
// ---------------------------------------------------------------------------------------------

test('dom: sendMessage is answered by the tab\'s handler for message.action, with a copy of the reply', async () => {
  const snapshot = { success: true, data: { title: 'T', url: 'https://a.test/', elements: [{ id: 1 }] } };
  const original = structuredClone(snapshot); // taken before any call: what the tab's handler must keep answering
  const fc = fakeChrome({ tabs: { list: [{ id: 101 }] }, dom: { 101: { GET_DOM_SNAPSHOT: snapshot } } });
  const first = await fc.chrome.tabs.sendMessage(101, { action: 'GET_DOM_SNAPSHOT' });
  assert.deepEqual(first, original);
  assert.notEqual(first, snapshot, 'the reply is not the scripted object itself');
  assert.notEqual(first.data.elements, snapshot.data.elements, 'and not even a part of it');
  first.data.elements.push({ id: 2 });
  assert.deepEqual(await fc.chrome.tabs.sendMessage(101, { action: 'GET_DOM_SNAPSHOT' }), original, 'the caller changing its reply does not change the next reply');
  assert.deepEqual(snapshot, original, 'and does not change what the handler holds');
  assert.deepEqual(fc.callsTo('tabs.sendMessage').map((c) => c.args), [[101, { action: 'GET_DOM_SNAPSHOT' }], [101, { action: 'GET_DOM_SNAPSHOT' }]]);
});

test('dom: the callback style, options, and a message that has crossed JSON', async () => {
  const seen = [];
  const fc = fakeChrome({
    tabs: { list: [{ id: 1 }] },
    dom: { 1: { EXECUTE_ACTION: (message, sender) => { seen.push({ message, sender }); return { success: true }; } } },
  });
  const message = { action: 'EXECUTE_ACTION', payload: { keep: 1, drop: undefined, when: new Date(0) } };
  const { args } = await new Promise((resolve) => fc.chrome.tabs.sendMessage(1, message, { frameId: 0 }, (...a) => resolve({ args: a })));
  assert.deepEqual(args, [{ success: true }]);
  assert.deepEqual(seen[0].message, { action: 'EXECUTE_ACTION', payload: { keep: 1, when: '1970-01-01T00:00:00.000Z' } });
  assert.equal(seen[0].sender.id, fc.chrome.runtime.id);
  assert.throws(() => fc.chrome.tabs.sendMessage(1, message, { colour: 1 }), /Unexpected property: 'colour'/);
});

test('dom: one function can answer every message of a tab, and it may be async', async () => {
  const fc = fakeChrome({ tabs: { list: [{ id: 1 }] }, dom: { 1: async (message) => ({ echo: message.action }) } });
  assert.deepEqual(await fc.chrome.tabs.sendMessage(1, { action: 'ANYTHING' }), { echo: 'ANYTHING' });
  assert.deepEqual(await fc.chrome.tabs.sendMessage(1, { action: 'ELSE' }), { echo: 'ELSE' });
});

test('dom: a tab without a content script fails like Chrome, and so does a tab that does not exist', async () => {
  const fc = fakeChrome({ tabs: { list: [{ id: 1 }, { id: 2 }] }, dom: { 1: { PING: 'pong' } } });
  await assert.rejects(fc.chrome.tabs.sendMessage(2, { action: 'PING' }), { message: NO_RECEIVER });
  await assert.rejects(fc.chrome.tabs.sendMessage(404, { action: 'PING' }), { message: 'No tab with id: 404.' });
  assert.equal(await fc.chrome.tabs.sendMessage(1, { action: 'PING' }), 'pong');
  fc.dom.remove(1); // the page navigated away: its content script is gone
  await assert.rejects(fc.chrome.tabs.sendMessage(1, { action: 'PING' }), { message: NO_RECEIVER });
  fc.dom.set(1, { PING: 'pong again' }); // the auto-inject put it back
  assert.equal(await fc.chrome.tabs.sendMessage(1, { action: 'PING' }), 'pong again');
  assert.equal(fc.dom.has(1), true);
  assert.equal(fc.dom.has(2), false);
});

test('dom: through the callback style the failure is lastError', async () => {
  const fc = fakeChrome({ tabs: { list: [{ id: 2 }] }, dom: true });
  const seen = await new Promise((resolve) => fc.chrome.tabs.sendMessage(2, { action: 'PING' }, (...args) => resolve({ args, message: fc.chrome.runtime.lastError?.message })));
  assert.deepEqual(seen, { args: [], message: NO_RECEIVER });
});

test('dom: a handler that answers nothing is "the message port closed", an Error is a failure', async () => {
  const fc = fakeChrome({
    tabs: { list: [{ id: 1 }] },
    dom: { 1: { SILENT: () => undefined, BROKEN: new Error('content script crashed'), NULLISH: null } },
  });
  await assert.rejects(fc.chrome.tabs.sendMessage(1, { action: 'SILENT' }), { message: PORT_CLOSED });
  await assert.rejects(fc.chrome.tabs.sendMessage(1, { action: 'BROKEN' }), { message: 'content script crashed' });
  assert.equal(await fc.chrome.tabs.sendMessage(1, { action: 'NULLISH' }), null);
});

test('dom: an action nobody scripted is a test mistake, and a queue keeps its place between calls', async () => {
  const fc = fakeChrome({ tabs: { list: [{ id: 1 }] }, dom: { 1: { READ: [{ page: 1 }, { page: 2 }] } } });
  assert.throws(() => fc.chrome.tabs.sendMessage(1, { action: 'CLICK' }), /the dom handler for tab 1 has no answer for action 'CLICK' - add it to fakeChrome\(\{ dom: \{ 1: \{ CLICK: \.\.\. \} \} \}\)/);
  assert.throws(() => fc.chrome.tabs.sendMessage(1, { nothing: true }), /has no answer for a message without action\/type/);
  assert.deepEqual(await fc.chrome.tabs.sendMessage(1, { action: 'READ' }), { page: 1 });
  assert.deepEqual(await fc.chrome.tabs.sendMessage(1, { action: 'READ' }), { page: 2 });
  assert.equal(fc.violations.length, 2);
});

test('dom: handlers can be added later, per action, and a message may use `type` instead of `action`', async () => {
  const fc = fakeChrome({ tabs: { list: [{ id: 1 }] }, dom: true });
  fc.dom.on(1, 'CLEAR_BADGES', { success: true });
  fc.dom.on(1, 'GET_PAGE_SIG', [{ hash: 'a' }, { hash: 'b' }]);
  assert.deepEqual(await fc.chrome.tabs.sendMessage(1, { action: 'CLEAR_BADGES' }), { success: true });
  assert.deepEqual(await fc.chrome.tabs.sendMessage(1, { type: 'GET_PAGE_SIG' }), { hash: 'a' });
  fc.dom.on(1, 'GET_PAGE_SIG', [{ hash: 'c' }]); // replacing the script restarts its queue
  assert.deepEqual(await fc.chrome.tabs.sendMessage(1, { action: 'GET_PAGE_SIG' }), { hash: 'c' });
  fc.dom.set(1, () => 'all');
  assert.throws(() => fc.dom.on(1, 'X', 1), /is a function/);
});

// ---------------------------------------------------------------------------------------------
// tabGroups
// ---------------------------------------------------------------------------------------------

test('tabGroups: get, update and query, with Chrome\'s color names and its "No group with id" error', async () => {
  const fc = fakeChrome({
    windows: { list: [{ id: 1, focused: true }, { id: 2 }] },
    tabs: { list: [{ id: 1, windowId: 1, groupId: 10 }, { id: 2, windowId: 2, groupId: 11 }] },
    tabGroups: { list: [{ id: 10, title: 'ScoutFox', color: 'orange', windowId: 1 }, { id: 11, title: 'Other', windowId: 2 }] },
  });
  const { tabGroups } = fc.chrome;
  assert.equal(tabGroups.TAB_GROUP_ID_NONE, -1);
  assert.deepEqual(await tabGroups.get(10), { id: 10, title: 'ScoutFox', color: 'orange', windowId: 1, collapsed: false });
  await assert.rejects(tabGroups.get(99), { message: 'No group with id: 99.' });
  assert.deepEqual((await tabGroups.query({ title: 'Scout*' })).map((g) => g.id), [10]);
  assert.deepEqual((await tabGroups.query({ windowId: 2 })).map((g) => g.id), [11]);
  assert.deepEqual((await tabGroups.query({ windowId: -2 })).map((g) => g.id), [10]);
  assert.deepEqual((await tabGroups.query({ color: 'grey' })).map((g) => g.id), [11]);
  const log = listen(fc, 'tabGroups.onUpdated');
  const updated = await tabGroups.update(11, { title: 'Renamed', color: 'blue', collapsed: true });
  assert.deepEqual(updated, { id: 11, title: 'Renamed', color: 'blue', windowId: 2, collapsed: true });
  await fc.settle();
  assert.deepEqual(log, [['tabGroups.onUpdated', updated]]);
  assert.throws(() => tabGroups.update(11, { color: 'chartreuse' }), /color must be one of grey, blue, red/);
  assert.throws(() => tabGroups.update(11, { size: 3 }), /Unexpected property: 'size'/);
  await assert.rejects(tabGroups.update(99, { title: 'x' }), { message: 'No group with id: 99.' });
});

test('tabGroups handle: add() and remove() act as the user would', async () => {
  const fc = fakeChrome({ tabs: { list: [{ id: 1 }] }, tabGroups: true });
  const log = listen(fc, 'tabGroups.onCreated', 'tabGroups.onRemoved', 'tabs.onUpdated');
  const group = fc.tabGroups.add({ id: 5, title: 'ScoutFox', color: 'orange' });
  assert.deepEqual(log, [['tabGroups.onCreated', group]]);
  await fc.chrome.tabs.group({ tabIds: 1, groupId: 5 });
  await fc.settle();
  fc.tabGroups.remove(5);
  assert.equal(fc.tabs.get(1).groupId, -1, 'its tab was ungrouped');
  assert.equal(fc.tabGroups.get(5), undefined);
  assert.deepEqual(log.at(-1), ['tabGroups.onRemoved', { ...group }]);
  assert.deepEqual(fc.tabGroups.list(), []);
});

// ---------------------------------------------------------------------------------------------
// windows
// ---------------------------------------------------------------------------------------------

test('windows: get, getCurrent, getLastFocused, getAll (populate) and the constants', async () => {
  const fc = twoWindows();
  const { windows } = fc.chrome;
  assert.deepEqual([windows.WINDOW_ID_NONE, windows.WINDOW_ID_CURRENT], [-1, -2]);
  const current = await windows.getCurrent();
  assert.deepEqual([current.id, current.focused, current.type, current.state], [1, true, 'normal', 'normal']);
  assert.equal('tabs' in current, false, 'no tabs unless populate: true');
  assert.equal((await windows.getLastFocused()).id, 1);
  assert.deepEqual((await windows.getAll()).map((w) => [w.id, w.focused]), [[1, true], [2, false]]);
  const populated = await windows.getAll({ populate: true });
  assert.deepEqual(populated.map((w) => w.tabs.map((t) => t.id)), [[11, 12], [21]]);
  assert.equal((await windows.get(2, { populate: true })).tabs[0].id, 21);
  assert.equal((await windows.get(-2)).id, 1);
  await assert.rejects(windows.get(404), { message: 'No window with id: 404.' });
});

test('windows.create: a window with a tab for each URL, focused by default; onCreated, tabs.onCreated, onFocusChanged fire', async () => {
  const fc = twoWindows();
  const log = listen(fc, 'windows.onCreated', 'tabs.onCreated', 'windows.onFocusChanged');
  const created = await fc.chrome.windows.create({ url: ['https://x.test/', 'https://y.test/'] });
  assert.equal(created.focused, true);
  assert.deepEqual(created.tabs.map((t) => [t.windowId, t.pendingUrl, t.active]), [[created.id, 'https://x.test/', true], [created.id, 'https://y.test/', false]]);
  await fc.settle();
  assert.deepEqual(log.map((e) => e[0]), ['windows.onCreated', 'tabs.onCreated', 'tabs.onCreated', 'windows.onFocusChanged']);
  assert.deepEqual(log.at(-1), ['windows.onFocusChanged', created.id]);
  assert.equal((await fc.chrome.windows.getLastFocused()).id, created.id);
  const unfocused = await fc.chrome.windows.create({ url: 'https://z.test/', focused: false });
  assert.equal(unfocused.focused, false);
  assert.equal((await fc.chrome.windows.getLastFocused()).id, created.id);
  assert.throws(() => fc.chrome.windows.create({ colour: 1 }), /Unexpected property: 'colour'/);
});

test('windows.create with a tabId moves that tab into the new window, and the old window closes if it was its last tab', async () => {
  const fc = twoWindows();
  const log = listen(fc, 'windows.onRemoved', 'windows.onCreated');
  const created = await fc.chrome.windows.create({ tabId: 21 });
  assert.deepEqual(created.tabs.map((t) => [t.id, t.windowId, t.active]), [[21, created.id, true]]);
  await fc.settle();
  assert.deepEqual(log.map((e) => e[0]), ['windows.onCreated', 'windows.onRemoved']);
  assert.deepEqual(log[1], ['windows.onRemoved', 2], 'window 2 lost its only tab');
  assert.deepEqual((await fc.chrome.windows.getAll()).map((w) => w.id), [1, created.id]);
});

test('grouping the last tab of a window out of it closes that window (and the groups in it)', async () => {
  const fc = fakeChrome({
    windows: { list: [{ id: 1, focused: true }, { id: 2 }] },
    tabs: { list: [{ id: 11, windowId: 1 }, { id: 21, windowId: 2 }] },
    tabGroups: true,
  });
  const log = listen(fc, 'windows.onRemoved', 'windows.onFocusChanged');
  await fc.chrome.tabs.group({ tabIds: 21 }); // the new group lands in focused window 1
  assert.equal((await fc.chrome.tabs.get(21)).windowId, 1);
  assert.deepEqual((await fc.chrome.tabs.query({ windowId: 1 })).map((t) => [t.id, t.active]), [[11, true], [21, false]]);
  await fc.settle();
  assert.deepEqual(log, [['windows.onRemoved', 2]]);
});

test('windows.update focuses a window; windows.remove closes its tabs with isWindowClosing and moves the focus', async () => {
  const fc = twoWindows();
  const log = listen(fc, 'windows.onFocusChanged', 'tabs.onRemoved', 'windows.onRemoved');
  await fc.chrome.windows.update(2, { focused: true });
  await fc.settle();
  assert.deepEqual(log, [['windows.onFocusChanged', 2]]);
  assert.deepEqual((await fc.chrome.tabs.query({ active: true, currentWindow: true })).map((t) => t.id), [21]);
  log.length = 0;
  await fc.chrome.windows.remove(2);
  await fc.settle();
  assert.deepEqual(log, [
    ['tabs.onRemoved', 21, { windowId: 2, isWindowClosing: true }],
    ['windows.onRemoved', 2],
    ['windows.onFocusChanged', 1],
  ]);
  assert.deepEqual((await fc.chrome.windows.getAll()).map((w) => [w.id, w.focused]), [[1, true]]);
  await assert.rejects(fc.chrome.windows.remove(2), { message: 'No window with id: 2.' });
});

test('windows handle: add(), focus() and close() act as the user would, synchronously', () => {
  const fc = twoWindows();
  const log = listen(fc, 'windows.onCreated', 'windows.onFocusChanged', 'windows.onRemoved');
  const added = fc.windows.add({ id: 3 });
  assert.deepEqual(log, [['windows.onCreated', added]]);
  fc.windows.focus(3);
  assert.equal(fc.windows.focusedId, 3);
  assert.deepEqual(log.at(-1), ['windows.onFocusChanged', 3]);
  fc.windows.close(3);
  assert.deepEqual(log.at(-1), ['windows.onFocusChanged', 1]);
  assert.deepEqual(fc.windows.list().map((w) => w.id), [1, 2]);
  assert.equal(fc.windows.get(3), undefined);
});

// ---------------------------------------------------------------------------------------------
// storage inside fakeChrome
// ---------------------------------------------------------------------------------------------

test('storage: chrome.storage.local and .session over a store, with onChanged at both levels', async () => {
  const store = createFakeStorage();
  const fc = fakeChrome({ storage: store, runtime: true });
  const log = listen(fc, 'storage.onChanged', 'storage.session.onChanged');
  await fc.chrome.storage.session.set({ a: { n: 1 } });
  await fc.chrome.storage.local.set({ b: 2 });
  assert.deepEqual(await fc.chrome.storage.session.get('a'), { a: { n: 1 } });
  assert.deepEqual(log, [
    ['storage.session.onChanged', { a: { newValue: { n: 1 } } }],
    ['storage.onChanged', { a: { newValue: { n: 1 } } }, 'session'],
    ['storage.onChanged', { b: { newValue: 2 } }, 'local'],
  ]);
  assert.equal(fc.storage, store);
  assert.deepEqual(fc.callsTo('storage.session.set').map((c) => c.args), [[{ a: { n: 1 } }]]);
});

test('storage: `true` gives a private store, and options configure it (a small quota)', async () => {
  const fc = fakeChrome({ storage: { session: { quotaBytes: 30 } } });
  assert.equal(fc.chrome.storage.session.QUOTA_BYTES, 30);
  await assert.rejects(fc.chrome.storage.session.set({ big: 'x'.repeat(50) }), { message: 'Session storage quota bytes exceeded. Values were not stored.' });
  const seen = await new Promise((resolve) => fc.chrome.storage.session.set({ big: 'x'.repeat(50) }, (...args) => resolve({ args, message: fc.chrome.runtime.lastError?.message })));
  assert.deepEqual(seen, { args: [], message: 'Session storage quota bytes exceeded. Values were not stored.' });
  assert.equal(fc.storage.session.bytesInUse(), 0);
  assert.equal(fakeChrome({ storage: true }).storage.session.quotaBytes, 10485760);
  assert.equal(fakeChrome({ storage: true }).chrome.storage.local.QUOTA_BYTES, 10485760);
});

test('storage: sync and managed are not there, and other members of an area say what fakeStorageSession implements', () => {
  const fc = fakeChrome({ storage: true });
  assert.throws(() => fc.chrome.storage.sync, /only local and session exist in fakeChrome/);
  assert.throws(() => fc.chrome.storage.local.watch, /fakeStorageSession implements get, set, remove, clear, getBytesInUse, getKeys, setAccessLevel, onChanged and QUOTA_BYTES/);
});

test('storage: a worker restart is a new fakeChrome over the same store - data stays, listeners and call log do not', async () => {
  const store = createFakeStorage();
  const first = fakeChrome({ storage: store, runtime: true });
  let heardByFirst = 0;
  first.chrome.storage.onChanged.addListener(() => heardByFirst++);
  await first.chrome.storage.session.set({ 'sf:meta:1': { boot: 1 } });
  assert.equal(heardByFirst, 1);

  first.kill(); // the old worker dies
  const second = fakeChrome({ storage: store, runtime: true });
  assert.deepEqual(await second.chrome.storage.session.get('sf:meta:1'), { 'sf:meta:1': { boot: 1 } });
  assert.equal(second.chrome.storage.onChanged.hasListeners(), false, 'fresh listeners');
  assert.deepEqual(second.calls.map((c) => c.api), ['storage.session.get'], 'fresh call log');
  await second.chrome.storage.session.set({ 'sf:meta:1': { boot: 2 } });
  assert.equal(heardByFirst, 1, 'the dead worker hears nothing');
  assert.deepEqual(store.snapshot().session, { 'sf:meta:1': { boot: 2 } });
});

test('storage: two live fakeChromes over one store hear each other (worker and side panel)', async () => {
  const store = createFakeStorage();
  const worker = fakeChrome({ storage: store });
  const panel = fakeChrome({ storage: store });
  const heard = listen(panel, 'storage.onChanged');
  await worker.chrome.storage.local.set({ agent_settings: { model: 'm' } });
  assert.deepEqual(heard, [['storage.onChanged', { agent_settings: { newValue: { model: 'm' } } }, 'local']]);
});

// ---------------------------------------------------------------------------------------------
// runtime
// ---------------------------------------------------------------------------------------------

test('runtime: id, getURL, getManifest and getPlatformInfo', async () => {
  const fc = fakeChrome({ runtime: { id: 'myextensionid', manifest: { manifest_version: 3, version: '9.9.9' }, platform: { os: 'linux' } } });
  const { runtime } = fc.chrome;
  assert.equal(runtime.id, 'myextensionid');
  assert.equal(runtime.getURL('sidepanel/sidepanel.html'), 'chrome-extension://myextensionid/sidepanel/sidepanel.html');
  assert.equal(runtime.getURL('/icons/icon16.png'), 'chrome-extension://myextensionid/icons/icon16.png');
  assert.deepEqual(runtime.getManifest(), { manifest_version: 3, version: '9.9.9' });
  assert.deepEqual(await runtime.getPlatformInfo(), { os: 'linux' });
  assert.match(fakeChrome({ runtime: true }).chrome.runtime.id, /^[a-p]{32}$/);
  assert.deepEqual(fc.calls.map((c) => c.api), ['runtime.getURL', 'runtime.getURL', 'runtime.getManifest', 'runtime.getPlatformInfo']);
});

test('runtime.sendMessage from the code under test: no receiving end by default, or a scripted answer', async () => {
  const fc = fakeChrome({ runtime: true });
  await assert.rejects(fc.chrome.runtime.sendMessage({ type: 'STATE_UPDATE' }), { message: NO_RECEIVER });
  const seen = await new Promise((resolve) => fc.chrome.runtime.sendMessage({ type: 'STATE_UPDATE' }, (...args) => resolve({ args, message: fc.chrome.runtime.lastError?.message })));
  assert.deepEqual(seen, { args: [], message: NO_RECEIVER });

  const scripted = fakeChrome({ runtime: { sendMessage: (message) => ({ got: message.type }) } });
  assert.deepEqual(await scripted.chrome.runtime.sendMessage({ type: 'PING' }), { got: 'PING' });
  assert.deepEqual(await scripted.chrome.runtime.sendMessage('other-extension-id', { type: 'PING' }), { got: 'PING' });
});

test('runtime.send(): the side panel sends a message, the onMessage listener answers with sendResponse', async () => {
  const fc = fakeChrome({ runtime: true });
  fc.chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'GET_AGENT_STATE') sendResponse({ status: 'idle', echoedSender: sender.id });
  });
  assert.deepEqual(await fc.runtime.send({ action: 'GET_AGENT_STATE' }), { status: 'idle', echoedSender: fc.chrome.runtime.id });
  await assert.rejects(fc.runtime.send({ action: 'SOMETHING_ELSE' }), { message: PORT_CLOSED });
});

test('runtime.send(): an async answer (return true), a custom sender, and a message that crossed JSON', async () => {
  const fc = fakeChrome({ runtime: true });
  fc.chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    setTimeout(() => sendResponse({ tab: sender.tab?.id, message }), 5);
    return true;
  });
  const response = await fc.runtime.send({ a: 1, gone: undefined }, { id: fc.chrome.runtime.id, tab: { id: 42 } });
  assert.deepEqual(response, { tab: 42, message: { a: 1 } });
});

test('runtime.send(): no listeners, a listener that never answers, and a listener that throws', async () => {
  const none = fakeChrome({ runtime: true });
  await assert.rejects(none.runtime.send({}), { message: NO_RECEIVER });

  const silent = fakeChrome({ runtime: true });
  silent.chrome.runtime.onMessage.addListener(() => true); // says it will answer, never does
  await assert.rejects(silent.runtime.send({}, undefined, 30), /returned true but never called sendResponse within 30 ms/);

  const broken = fakeChrome({ runtime: true });
  broken.chrome.runtime.onMessage.addListener(() => {
    throw new Error('listener bug');
  });
  await assert.rejects(broken.runtime.send({}), { message: 'listener bug' });
});

test('runtime.send(): the first response wins, and later ones are ignored', async () => {
  const fc = fakeChrome({ runtime: true });
  fc.chrome.runtime.onMessage.addListener((m, s, sendResponse) => sendResponse('first'));
  fc.chrome.runtime.onMessage.addListener((m, s, sendResponse) => sendResponse('second'));
  assert.equal(await fc.runtime.send({}), 'first');
});

test('runtime ports: connect() gives the panel end, onConnect listeners get the worker end, messages go both ways', async () => {
  const fc = fakeChrome({ runtime: true });
  const workerSide = [];
  fc.chrome.runtime.onConnect.addListener((port) => {
    workerSide.push(port);
    port.onMessage.addListener((message, from) => from.postMessage({ echo: message }));
  });
  const panel = fc.runtime.connect({ name: 'scoutfox_sidepanel_fresh:101' });
  assert.equal(workerSide.length, 1);
  assert.equal(workerSide[0].name, 'scoutfox_sidepanel_fresh:101');
  assert.equal(workerSide[0].sender.id, fc.chrome.runtime.id, 'the worker end carries the sender');
  assert.equal(panel.sender, undefined);
  workerSide[0].postMessage({ type: 'STATE_UPDATE', payload: { n: 1 } });
  panel.postMessage({ ask: 'hello', dropped: undefined });
  assert.deepEqual(panel.received, [], 'delivery is asynchronous, like Chrome');
  await fc.settle();
  assert.deepEqual(panel.received, [{ type: 'STATE_UPDATE', payload: { n: 1 } }, { echo: { ask: 'hello' } }]);
  assert.deepEqual(workerSide[0].received, [{ ask: 'hello' }]);
});

test('runtime ports: disconnect() fires onDisconnect on the other end only, and the port is dead afterwards', async () => {
  const fc = fakeChrome({ runtime: true });
  const log = [];
  fc.chrome.runtime.onConnect.addListener((port) => {
    port.onDisconnect.addListener(() => log.push('worker end disconnected'));
  });
  const panel = fc.runtime.connect({ name: 'p' });
  panel.onDisconnect.addListener(() => log.push('panel end disconnected'));
  panel.postMessage('last words');
  panel.disconnect();
  await fc.settle();
  assert.deepEqual(log, ['worker end disconnected']);
  assert.throws(() => panel.postMessage('again'), /Attempting to use a disconnected port object/);
  panel.disconnect(); // harmless
});

test('runtime ports: a port opened by the code under test has its far end in outgoingPorts', async () => {
  const fc = fakeChrome({ runtime: true });
  const port = fc.chrome.runtime.connect({ name: 'to-the-panel' });
  assert.equal(port.name, 'to-the-panel');
  assert.equal(fc.runtime.outgoingPorts.length, 1);
  port.postMessage({ hello: 1 });
  await fc.settle();
  assert.deepEqual(fc.runtime.outgoingPorts[0].received, [{ hello: 1 }]);
  assert.equal(fc.callsTo('runtime.connect').length, 1);
});

test('runtime events: onInstalled and onStartup exist and can be fired', () => {
  const fc = fakeChrome({ runtime: true });
  const log = listen(fc, 'runtime.onInstalled', 'runtime.onStartup');
  fc.fire('runtime.onInstalled', { reason: 'install' });
  fc.fire('runtime.onStartup');
  assert.deepEqual(log, [['runtime.onInstalled', { reason: 'install' }], ['runtime.onStartup']]);
});

// ---------------------------------------------------------------------------------------------
// sidePanel
// ---------------------------------------------------------------------------------------------

test('sidePanel: setOptions and getOptions per tab over a default, setPanelBehavior, all recorded', async () => {
  const fc = fakeChrome({ sidePanel: true });
  const { sidePanel } = fc.chrome;
  assert.deepEqual(await sidePanel.getOptions({}), { enabled: true });
  await sidePanel.setOptions({ enabled: false });
  await sidePanel.setOptions({ tabId: 7, path: 'sidepanel/sidepanel.html', enabled: true });
  assert.deepEqual(await sidePanel.getOptions({}), { enabled: false });
  assert.deepEqual(await sidePanel.getOptions({ tabId: 7 }), { enabled: true, path: 'sidepanel/sidepanel.html' });
  assert.deepEqual(await sidePanel.getOptions({ tabId: 8 }), { enabled: false });
  assert.deepEqual(fc.sidePanel.optionsFor(7), { enabled: true, path: 'sidepanel/sidepanel.html' });
  assert.deepEqual(fc.sidePanel.optionsFor(), { enabled: false });
  assert.deepEqual(await sidePanel.getPanelBehavior(), { openPanelOnActionClick: false });
  await sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  assert.deepEqual(fc.sidePanel.behavior, { openPanelOnActionClick: true });
  assert.deepEqual(fc.callsTo('sidePanel.setOptions').map((c) => c.args), [[{ enabled: false }], [{ tabId: 7, path: 'sidepanel/sidepanel.html', enabled: true }]]);
  assert.throws(() => sidePanel.setOptions({ tab: 7 }), /Unexpected property: 'tab'/);
});

test('sidePanel.open: recorded, needs a tabId or windowId, and the test can make it refuse', async () => {
  const fc = fakeChrome({ sidePanel: { open: [undefined, new Error('sidePanel.open() may only be called in response to a user gesture.')] } });
  await fc.chrome.sidePanel.open({ tabId: 7 });
  await assert.rejects(fc.chrome.sidePanel.open({ tabId: 8 }), { message: /user gesture/ });
  assert.deepEqual(fc.sidePanel.opened, [{ tabId: 7 }], 'a refused open is not counted as opened');
  assert.deepEqual(fc.callsTo('sidePanel.open').map((c) => c.args), [[{ tabId: 7 }], [{ tabId: 8 }]]);
  await assert.rejects(fakeChrome({ sidePanel: true }).chrome.sidePanel.open({}), { message: /tabId or windowId/ });
});

test('sidePanel.open: the default always opens, and a function decides per call', async () => {
  const always = fakeChrome({ sidePanel: true });
  await always.chrome.sidePanel.open({ windowId: 1 });
  assert.deepEqual(always.sidePanel.opened, [{ windowId: 1 }]);
  const picky = fakeChrome({ sidePanel: { open: ({ tabId }) => (tabId === 1 ? undefined : new Error('no')) } });
  await picky.chrome.sidePanel.open({ tabId: 1 });
  await assert.rejects(picky.chrome.sidePanel.open({ tabId: 2 }), { message: 'no' });
});

// ---------------------------------------------------------------------------------------------
// scripting
// ---------------------------------------------------------------------------------------------

test('scripting.executeScript: a plain value is the main frame result, an array entry is the full results array', async () => {
  const fc = fakeChrome({
    tabs: { list: [{ id: 1 }] },
    scripting: { executeScript: ['ok', [{ frameId: 0, result: 'main' }, { frameId: 3, result: 'iframe' }], null, undefined] },
  });
  const run = () => fc.chrome.scripting.executeScript({ target: { tabId: 1, allFrames: true }, func: () => 1 });
  const first = await run();
  assert.deepEqual(first.map((r) => [r.frameId, r.result]), [[0, 'ok']]);
  assert.match(first[0].documentId, /^[A-Z0-9]{32}$/);
  assert.deepEqual(await run(), [{ frameId: 0, result: 'main' }, { frameId: 3, result: 'iframe' }]);
  assert.equal((await run())[0].result, null);
  assert.equal((await run())[0].result, undefined);
});

test('scripting.executeScript: a function sees the injection, an Error fails the call, both call styles', async () => {
  const seen = [];
  const fc = fakeChrome({
    tabs: { list: [{ id: 1 }] },
    scripting: { executeScript: (injection) => { seen.push(injection); return injection.files ? new Error('Cannot access a chrome:// URL') : { via: 'func' }; } },
  });
  const ok = await fc.chrome.scripting.executeScript({ target: { tabId: 1 }, func: () => 1, args: ['a'] });
  assert.deepEqual(ok[0].result, { via: 'func' });
  assert.deepEqual(seen[0].args, ['a']);
  await assert.rejects(fc.chrome.scripting.executeScript({ target: { tabId: 1 }, files: ['content/content.js'] }), { message: 'Cannot access a chrome:// URL' });
  const viaCallback = await new Promise((resolve) => fc.chrome.scripting.executeScript({ target: { tabId: 1 }, files: ['x.js'] }, (...args) => resolve({ args, message: fc.chrome.runtime.lastError?.message })));
  assert.deepEqual(viaCallback, { args: [], message: 'Cannot access a chrome:// URL' });
});

test('scripting.executeScript: results are JSON copies, and the tab must exist when tabs is declared', async () => {
  const shared = { list: [1] };
  const fc = fakeChrome({ tabs: { list: [{ id: 1 }] }, scripting: { executeScript: shared } });
  const one = await fc.chrome.scripting.executeScript({ target: { tabId: 1 }, func: () => 1 });
  one[0].result.list.push(2);
  assert.deepEqual((await fc.chrome.scripting.executeScript({ target: { tabId: 1 }, func: () => 1 }))[0].result, { list: [1] });
  await assert.rejects(fc.chrome.scripting.executeScript({ target: { tabId: 404 }, func: () => 1 }), { message: 'No tab with id: 404.' });
  const noTabs = fakeChrome({ scripting: { executeScript: 'fine' } });
  assert.equal((await noTabs.chrome.scripting.executeScript({ target: { tabId: 404 }, func: () => 1 }))[0].result, 'fine');
  assert.throws(() => fc.chrome.scripting.executeScript({ func: () => 1 }), TypeError);
  assert.throws(() => fc.chrome.scripting.executeScript({ target: { tabId: 1 }, code: '1' }), /Unexpected property: 'code'/);
});

test('scripting.executeScript with nothing scripted is a test mistake that says so', () => {
  const fc = fakeChrome({ scripting: true });
  assert.throws(() => fc.chrome.scripting.executeScript({ target: { tabId: 1 }, func: () => 1 }), /executeScript was called but no results are scripted - add fakeChrome\(\{ scripting: \{ executeScript: \[\.\.\.\] \} \}\)/);
  assert.equal(fc.violations.length, 1);
});

// ---------------------------------------------------------------------------------------------
// debugger
// ---------------------------------------------------------------------------------------------

test('debugger: attach, sendCommand with scripted results per CDP method, detach; recorded in order', async () => {
  const fc = fakeChrome({
    debugger: {
      commands: {
        'Page.captureScreenshot': { data: 'AAAA' },
        'Input.dispatchMouseEvent': [{}, {}],
        'Runtime.evaluate': (params) => ({ result: { type: 'string', value: `evaluated ${params.expression}` } }),
        'Emulation.setFocusEmulationEnabled': undefined,
      },
    },
  });
  const { debugger: cdp } = fc.chrome;
  const target = { tabId: 7 };
  await cdp.attach(target, '1.3');
  assert.deepEqual(fc.debugger.attached, [7]);
  assert.deepEqual(await cdp.sendCommand(target, 'Page.captureScreenshot', { format: 'png' }), { data: 'AAAA' });
  await cdp.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mousePressed' });
  await cdp.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased' });
  assert.deepEqual(await cdp.sendCommand(target, 'Runtime.evaluate', { expression: '1+1' }), { result: { type: 'string', value: 'evaluated 1+1' } });
  assert.deepEqual(await cdp.sendCommand(target, 'Emulation.setFocusEmulationEnabled', { enabled: true }), {}, 'no result means {}');
  await cdp.detach(target);
  assert.deepEqual(fc.debugger.attached, []);
  assert.deepEqual(fc.calls.map((c) => [c.api, c.args[1]]), [
    ['debugger.attach', '1.3'],
    ['debugger.sendCommand', 'Page.captureScreenshot'],
    ['debugger.sendCommand', 'Input.dispatchMouseEvent'],
    ['debugger.sendCommand', 'Input.dispatchMouseEvent'],
    ['debugger.sendCommand', 'Runtime.evaluate'],
    ['debugger.sendCommand', 'Emulation.setFocusEmulationEnabled'],
    ['debugger.detach', undefined],
  ]);
  assert.deepEqual(fc.callsTo('debugger.sendCommand')[0].args, [target, 'Page.captureScreenshot', { format: 'png' }]);
});

test('debugger: a command function gets (params, target), a fallback gets (method, params, target), an Error fails the command', async () => {
  const fc = fakeChrome({
    debugger: {
      commands: { 'Page.navigate': (params, target) => ({ frameId: `${target.tabId}:${params.url}` }), 'DOM.getDocument': new Error('Target closed') },
      sendCommand: (method, params, target) => ({ fallback: method, tabId: target.tabId }),
    },
  });
  await fc.chrome.debugger.attach({ tabId: 3 }, '1.3');
  assert.deepEqual(await fc.chrome.debugger.sendCommand({ tabId: 3 }, 'Page.navigate', { url: 'u' }), { frameId: '3:u' });
  await assert.rejects(fc.chrome.debugger.sendCommand({ tabId: 3 }, 'DOM.getDocument'), { message: 'Target closed' });
  assert.deepEqual(await fc.chrome.debugger.sendCommand({ tabId: 3 }, 'Anything.else'), { fallback: 'Anything.else', tabId: 3 });
});

test('debugger: a CDP method nobody scripted is a test mistake that names the method', async () => {
  const fc = fakeChrome({ debugger: { commands: { 'Page.reload': {} } } });
  await fc.chrome.debugger.attach({ tabId: 1 }, '1.3');
  assert.throws(
    () => fc.chrome.debugger.sendCommand({ tabId: 1 }, 'Input.insertText', { text: 'x' }),
    /chrome\.debugger\.sendCommand\('Input\.insertText'\) has no scripted result - add it to fakeChrome\(\{ debugger: \{ commands: \{ 'Input\.insertText': \.\.\. \} \} \}\)/
  );
  assert.equal(fc.violations.length, 1);
});

test('debugger: the attach outcomes - refused by the test, already attached, not attached', async () => {
  const fc = fakeChrome({ debugger: { attach: [undefined, new Error('Cannot attach to this target.')], commands: { 'Page.reload': {} } } });
  const { debugger: cdp } = fc.chrome;
  await cdp.attach({ tabId: 1 }, '1.3'); // scripted: allowed
  await assert.rejects(cdp.attach({ tabId: 2 }, '1.3'), { message: 'Cannot attach to this target.' }); // scripted: refused
  assert.deepEqual(fc.debugger.attached, [1], 'a refused attach attaches nothing');
  await assert.rejects(cdp.sendCommand({ tabId: 2 }, 'Page.reload'), { message: 'Debugger is not attached to the tab with id: 2.' });
  await assert.rejects(cdp.detach({ tabId: 2 }), { message: 'Debugger is not attached to the tab with id: 2.' });

  const plain = fakeChrome({ debugger: true });
  await plain.chrome.debugger.attach({ tabId: 1 }, '1.3');
  await assert.rejects(plain.chrome.debugger.attach({ tabId: 1 }, '1.3'), { message: 'Another debugger is already attached to the tab with id: 1.' });
  const perTab = fakeChrome({ debugger: { attach: ({ tabId }) => (tabId === 9 ? new Error('Cannot access a chrome:// URL') : undefined) } });
  await perTab.chrome.debugger.attach({ tabId: 1 }, '1.3');
  await assert.rejects(perTab.chrome.debugger.attach({ tabId: 9 }, '1.3'), { message: 'Cannot access a chrome:// URL' });
});

test('debugger: argument checks', async () => {
  const fc = fakeChrome({ debugger: true });
  assert.throws(() => fc.chrome.debugger.attach({ tabId: 1 }), TypeError);
  assert.throws(() => fc.chrome.debugger.attach({ extensionId: 'x' }, '1.3'), /only supports a \{ tabId \} debuggee/);
  assert.throws(() => fc.chrome.debugger.sendCommand({ tabId: 1 }, 5), TypeError);
});

test('debugger handle: the browser ends the session (onDetach), and CDP events reach onEvent', async () => {
  const fc = fakeChrome({ debugger: { commands: { 'Page.reload': {} } } });
  const log = listen(fc, 'debugger.onDetach', 'debugger.onEvent');
  await fc.chrome.debugger.attach({ tabId: 5 }, '1.3');
  fc.debugger.event(5, 'Page.frameNavigated', { frame: { url: 'https://x.test/' } });
  fc.debugger.detach(5, 'canceled_by_user');
  assert.deepEqual(log, [
    ['debugger.onEvent', { tabId: 5 }, 'Page.frameNavigated', { frame: { url: 'https://x.test/' } }],
    ['debugger.onDetach', { tabId: 5 }, 'canceled_by_user'],
  ]);
  assert.deepEqual(fc.debugger.attached, []);
  await assert.rejects(fc.chrome.debugger.sendCommand({ tabId: 5 }, 'Page.reload'), { message: 'Debugger is not attached to the tab with id: 5.' });
  assert.throws(() => fc.debugger.detach(5), /not attached to tab 5/);
  assert.throws(() => fc.debugger.event(5, 'X'), /not attached to tab 5/);
  await fc.chrome.debugger.attach({ tabId: 5 }, '1.3'); // it can attach again afterwards
  fc.debugger.detach(5);
  assert.equal(log.at(-1)[2], 'target_closed', 'the default reason');
});

test('debugger: an explicit detach() by the code does not fire onDetach', async () => {
  const fc = fakeChrome({ debugger: true });
  const log = listen(fc, 'debugger.onDetach');
  await fc.chrome.debugger.attach({ tabId: 1 }, '1.3');
  await fc.chrome.debugger.detach({ tabId: 1 });
  await fc.settle();
  assert.deepEqual(log, []);
});

// ---------------------------------------------------------------------------------------------
// alarms
// ---------------------------------------------------------------------------------------------

test('alarms: create, get, getAll, clear and clearAll', async () => {
  const fc = fakeChrome({ alarms: true });
  const { alarms } = fc.chrome;
  const before = Date.now();
  await alarms.create('keepalive', { periodInMinutes: 0.5 });
  await alarms.create({ delayInMinutes: 1 }); // unnamed: the name is ''
  await alarms.create('at', { when: 1_800_000_000_000 });
  const keepalive = await alarms.get('keepalive');
  assert.deepEqual([keepalive.name, keepalive.periodInMinutes], ['keepalive', 0.5]);
  assert.ok(keepalive.scheduledTime >= before + 30_000 - 5);
  assert.equal((await alarms.get()).name, '');
  assert.equal((await alarms.get('at')).scheduledTime, 1_800_000_000_000);
  assert.equal(await alarms.get('missing'), undefined);
  assert.deepEqual((await alarms.getAll()).map((a) => a.name), ['keepalive', '', 'at']);
  assert.equal(await alarms.clear('keepalive'), true);
  assert.equal(await alarms.clear('keepalive'), false);
  await alarms.create('keepalive', { periodInMinutes: 1 });
  await alarms.create('keepalive', { periodInMinutes: 2 }); // same name replaces
  assert.equal((await alarms.getAll()).filter((a) => a.name === 'keepalive').length, 1);
  assert.equal(await alarms.clearAll(), true);
  assert.equal(await alarms.clearAll(), false);
  assert.deepEqual(await alarms.getAll(), []);
});

test('alarms: bad create calls fail like Chrome', async () => {
  const fc = fakeChrome({ alarms: true });
  await assert.rejects(fc.chrome.alarms.create('x', { when: 1, delayInMinutes: 1 }), { message: 'Cannot set both when and delayInMinutes.' });
  await assert.rejects(fc.chrome.alarms.create('x', {}), { message: /at least one of when, delayInMinutes, or periodInMinutes/ });
  assert.throws(() => fc.chrome.alarms.create('x', { in: 5 }), /Unexpected property: 'in'/);
});

test('alarms handle: fire() runs onAlarm; a one-shot alarm is gone, a repeating one moves on', async () => {
  const fc = fakeChrome({ alarms: true });
  const log = listen(fc, 'alarms.onAlarm');
  await fc.chrome.alarms.create('once', { when: 2_000_000_000_000 });
  await fc.chrome.alarms.create('repeat', { when: 2_000_000_000_000, periodInMinutes: 1 });
  fc.alarms.fire('once');
  assert.equal(log[0][1].name, 'once');
  assert.equal(await fc.chrome.alarms.get('once'), undefined, 'removed before the listener could see it again');
  fc.alarms.fire('repeat');
  assert.equal((await fc.chrome.alarms.get('repeat')).scheduledTime, 2_000_000_060_000);
  assert.deepEqual(fc.alarms.list().map((a) => a.name), ['repeat']);
  assert.throws(() => fc.alarms.fire('nope'), /there is no alarm named "nope" to fire \(alarms: "repeat"\)/);
});

// ---------------------------------------------------------------------------------------------
// declarativeNetRequest
// ---------------------------------------------------------------------------------------------

test('declarativeNetRequest: dynamic and session rules, add and remove in one call, unique ids, all or nothing', async () => {
  const rule = (id) => ({ id, priority: 1, action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Origin', operation: 'remove' }] }, condition: { urlFilter: 'localhost' } });
  const fc = fakeChrome({ declarativeNetRequest: { dynamicRules: [rule(9)] } });
  const dnr = fc.chrome.declarativeNetRequest;
  await dnr.updateSessionRules({ addRules: [rule(1), rule(2)] });
  await dnr.updateSessionRules({ removeRuleIds: [1], addRules: [rule(1)] }); // remove first, then add: fine
  assert.deepEqual((await dnr.getSessionRules()).map((r) => r.id), [1, 2]);
  assert.deepEqual((await dnr.getSessionRules({ ruleIds: [2] })).map((r) => r.id), [2]);
  await assert.rejects(dnr.updateSessionRules({ addRules: [rule(3), rule(2)] }), { message: 'Rule with id 2 does not have a unique ID.' });
  assert.deepEqual((await dnr.getSessionRules()).map((r) => r.id), [1, 2], 'rule 3 was not added either');
  assert.deepEqual((await dnr.getDynamicRules()).map((r) => r.id), [9], 'dynamic rules are a separate set, here seeded');
  await dnr.updateDynamicRules({ addRules: [rule(4)] });
  assert.deepEqual(fc.declarativeNetRequest.dynamicRules().map((r) => r.id), [4, 9]);
  assert.deepEqual(fc.declarativeNetRequest.sessionRules().map((r) => r.id), [1, 2]);
  await assert.rejects(dnr.updateSessionRules({ addRules: [{ id: 0 }] }), { message: /must have an integer id of at least 1/ });
  assert.throws(() => dnr.updateSessionRules({ addRule: [] }), /Unexpected property: 'addRule'/);
  assert.equal(fc.callsTo('declarativeNetRequest.updateSessionRules').length, 5);
});

// ---------------------------------------------------------------------------------------------
// action
// ---------------------------------------------------------------------------------------------

test('action: setBadgeText is recorded and readable per tab over a default; onClicked fires with the active tab', async () => {
  const fc = twoWindows();
  const fcAction = fakeChrome({ tabs: { list: [{ id: 1, url: 'https://a.test/' }] }, action: true });
  const { action } = fcAction.chrome;
  await action.setBadgeText({ text: 'ON' });
  await action.setBadgeText({ text: '3', tabId: 1 });
  await action.setBadgeBackgroundColor({ color: '#ff8800' });
  await action.setTitle({ title: 'ScoutFox is running', tabId: 1 });
  assert.equal(await action.getBadgeText({}), 'ON');
  assert.equal(await action.getBadgeText({ tabId: 1 }), '3');
  assert.equal(await action.getBadgeText({ tabId: 2 }), 'ON');
  assert.deepEqual([fcAction.action.badgeText(), fcAction.action.badgeText(1), fcAction.action.badgeColor(), fcAction.action.title(1), fcAction.action.title()], ['ON', '3', '#ff8800', 'ScoutFox is running', undefined]);
  assert.deepEqual(fcAction.callsTo('action.setBadgeText').map((c) => c.args), [[{ text: 'ON' }], [{ text: '3', tabId: 1 }]]);

  const log = listen(fcAction, 'action.onClicked');
  fcAction.action.click();
  assert.equal(log[0][1].id, 1);
  fcAction.action.click({ id: 77, url: 'chrome://extensions' });
  assert.equal(log[1][1].id, 77);
  assert.throws(() => fakeChrome({ action: true }).action.click(), /needs a tab/);
});

// ---------------------------------------------------------------------------------------------
// fire(), install(), kill()
// ---------------------------------------------------------------------------------------------

test('fire(): calls the listeners of any declared event now, returns what they returned, and lists the events when one is unknown', () => {
  const fc = fakeChrome({ tabs: true, alarms: true, storage: true });
  const seen = [];
  fc.chrome.tabs.onCreated.addListener((tab) => { seen.push(tab.id); return 'a'; });
  fc.chrome.tabs.onCreated.addListener((tab) => { seen.push(tab.id * 2); return 'b'; });
  assert.deepEqual(fc.fire('tabs.onCreated', { id: 21 }), ['a', 'b']);
  assert.deepEqual(seen, [21, 42]);
  assert.equal(fc.fire('tabs.onRemoved', 1, {}).length, 0, 'no listeners: nothing runs, nothing fails');
  assert.throws(() => fc.fire('debugger.onDetach'), /no event "debugger\.onDetach" is declared \(declared events: alarms\.onAlarm, storage\.local\.onChanged, storage\.onChanged, storage\.session\.onChanged, tabs\.onActivated/);
  const failing = fakeChrome({ tabs: true });
  const ran = [];
  failing.chrome.tabs.onCreated.addListener(() => { throw new Error('first'); });
  failing.chrome.tabs.onCreated.addListener(() => ran.push('second'));
  assert.throws(() => failing.fire('tabs.onCreated', {}), { message: 'first' });
  assert.deepEqual(ran, ['second'], 'the other listeners still ran');
});

test('install() sets globalThis.chrome and hands back a function that restores what was there', () => {
  assert.equal('chrome' in globalThis, false, 'this test file starts without a global chrome');
  const fc = fakeChrome({ tabs: true });
  const restore = fc.install();
  assert.equal(globalThis.chrome, fc.chrome);
  restore();
  assert.equal('chrome' in globalThis, false);

  const sentinel = { previous: true };
  globalThis.chrome = sentinel;
  const restoreToSentinel = fakeChrome({ tabs: true }).install();
  restoreToSentinel();
  assert.equal(globalThis.chrome, sentinel);
  delete globalThis.chrome;
});

test('kill(): every listener is dropped', () => {
  const fc = fakeChrome({ tabs: true, runtime: true, alarms: true });
  const log = listen(fc, 'tabs.onCreated', 'alarms.onAlarm');
  fc.kill();
  fc.fire('tabs.onCreated', { id: 1 });
  assert.deepEqual(log, []);
  assert.equal(fc.chrome.tabs.onCreated.hasListeners(), false);
});

test('kill(): what the worker had queued never runs, further chrome.* calls throw, and what it wrote to the store stays', async () => {
  const store = createFakeStorage({ local: { delayMs: 15 } });
  const fc = fakeChrome({ storage: store, tabs: { list: [{ id: 1 }] } });
  const heard = listen(fc, 'storage.onChanged', 'tabs.onUpdated');
  let resolved = 0;
  fc.chrome.storage.local.set({ k: 'v' }).then(() => resolved++);
  fc.chrome.tabs.update(1, { url: 'https://x.test/' }, () => resolved++);
  fc.kill();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(resolved, 0, 'no callback and no promise of the dead worker fires');
  assert.deepEqual(heard, [], 'no event either');
  assert.deepEqual(store.snapshot().local, { k: 'v' }, 'the storage write was applied at call time');
  assert.throws(() => fc.chrome.tabs.get(1), /fakeChrome: tabs\.get was called after kill\(\) - that worker is dead/);
  assert.throws(() => fc.chrome.tabs.onCreated.addListener(() => {}), /called after kill\(\)/);
  assert.equal(fc.violations.length, 2);
  fc.kill(); // killing twice is harmless
  assert.equal(fc.tabs.get(1).id, 1, 'the test can still look at the state');
});

test('kill(): the worker\'s ports disconnect, so the other end hears onDisconnect (how a side panel notices a restart)', () => {
  const fc = fakeChrome({ runtime: true });
  fc.chrome.runtime.onConnect.addListener(() => {});
  const panel = fc.runtime.connect({ name: 'panel' });
  const owned = fc.chrome.runtime.connect({ name: 'worker-opened' });
  const heard = [];
  panel.onDisconnect.addListener(() => heard.push('panel end'));
  fc.runtime.outgoingPorts[0].onDisconnect.addListener(() => heard.push('far end of the worker-opened port'));
  fc.kill();
  assert.deepEqual(heard, ['panel end', 'far end of the worker-opened port']);
  assert.throws(() => panel.postMessage('x'), /disconnected port/);
  assert.throws(() => owned.postMessage('x'), /disconnected port/);
});

test('a worker restart end to end: the panel notices, reconnects to the new worker, and the data is still there', async () => {
  const store = createFakeStorage();
  const boot = (n) => {
    const fc = fakeChrome({ storage: store, runtime: true, alarms: true });
    fc.chrome.runtime.onConnect.addListener((port) => port.postMessage({ type: 'STATE_UPDATE', boot: n }));
    fc.chrome.storage.session.onChanged.addListener(() => fc.chrome.runtime.id); // module state that the restart resets
    return fc;
  };
  const first = boot(1);
  await first.chrome.storage.session.set({ 'sf:meta:1': { boot: 1 } });
  await first.chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
  const panel = first.runtime.connect({ name: 'scoutfox_sidepanel_fresh:1' });
  await first.settle();
  assert.deepEqual(panel.received, [{ type: 'STATE_UPDATE', boot: 1 }]);

  let panelNoticed = false;
  panel.onDisconnect.addListener(() => {
    panelNoticed = true;
  });
  first.kill();
  assert.equal(panelNoticed, true);

  const second = boot(2);
  const panelAgain = second.runtime.connect({ name: 'scoutfox_sidepanel_fresh:1' });
  await second.settle();
  assert.deepEqual(panelAgain.received, [{ type: 'STATE_UPDATE', boot: 2 }]);
  assert.deepEqual(await second.chrome.storage.session.get('sf:meta:1'), { 'sf:meta:1': { boot: 1 } });
  assert.deepEqual(second.callsTo('storage.session.set'), [], 'the new worker starts with a clean call log');
  assert.deepEqual(second.alarms.list(), [], 'alarms belong to the fake, not the store: a test that needs them re-creates them');
});

test('a listener the code registers at import time runs when the test fires the event (the usual pattern)', async () => {
  const fc = fakeChrome({ tabs: { list: [{ id: 100, url: 'https://a.test/' }] }, tabGroups: true, runtime: true, storage: true });
  // stands in for background.js
  const adopted = [];
  fc.chrome.tabs.onCreated.addListener(async (tab) => {
    const opener = tab.openerTabId === undefined ? undefined : await fc.chrome.tabs.get(tab.openerTabId);
    if (opener) {
      adopted.push(tab.id);
      await fc.chrome.tabs.group({ tabIds: tab.id });
    }
  });
  fc.tabs.add({ id: 200 }); // the user opens their own tab: no opener
  fc.tabs.add({ id: 300, openerTabId: 100 }); // a link the agent clicked
  await fc.settle();
  assert.deepEqual(adopted, [300]);
  assert.deepEqual(fc.callsTo('tabs.group').map((c) => c.args), [[{ tabIds: 300 }]]);
  assert.equal(fc.tabs.get(300).groupId > 0, true);
  assert.equal(fc.tabs.get(200).groupId, -1);
});
