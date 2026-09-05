/**
 * Phase 2 of the per-window session work, end-to-end: a real task chooses "open_window" (via a
 * stubbed LLM response, everything else genuinely real - START_TASK, the real runLoop,
 * executeActionOnTab, openNewWindow, background.js's onWindowOpenedCallback wiring), and a
 * second panel opening in the resulting new window reflects the SAME session rather than
 * starting a blank one.
 *
 * This is its own file, separate from multiWindowSameSession.test.js's unit-level tests,
 * because background.js imports Logger/ApiClients via their plain specifiers, and node --test
 * isolates by FILE, not by individual test() - within one file, this file's own
 * `await import('../background/background.js')` and the OTHER file's per-test
 * `global.chrome = <its own mock>` reassignments raced across the await boundary: node's test
 * runner can start running already-registered test() callbacks while this file's own top-level
 * `await import(...)` is still paused mid-execution, so a later test's mock swap could
 * overwrite global.chrome out from under background.js's own still-pending initialization,
 * crashing on "Cannot read properties of undefined (reading 'addListener')". A fresh process
 * per file removes the race entirely.
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';

const { ApiClients } = await import('../background/apiClients.js');

function makeBackgroundChromeMock() {
  const tabs = new Map();
  const windows = new Map();
  let tabCounter = 2000;
  let lastRelevantTabId = null; // most recently created/grouped tab, for the onUpdated stub below
  let winCounter = 200;
  let groupCounter = 8000;
  const storage = {};
  const listeners = {};
  const noop = () => {};
  const listener = () => ({ addListener: noop });

  function addWindow(windowId, tabId, url) {
    const tab = { id: tabId, windowId, url, groupId: -1 };
    windows.set(windowId, { id: windowId, tabs: [tab] });
    tabs.set(tabId, tab);
  }

  return {
    __tabs: tabs,
    __storage: storage,
    __listeners: listeners,
    __addWindow: addWindow,
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
          remove: (keys, cb) => { (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete storage[k]); if (cb) cb(); }
        }
      },
      tabs: {
        onRemoved: listener(),
        onActivated: listener(),
        onCreated: listener(),
        // waitForTabComplete registers a listener AFTER the tab is created and waits (real
        // wall-clock, up to 4s) for a 'complete' event matching its own tabId, or times out. A
        // no-op listener here means every open_window/navigate/click step actually blocks for
        // the full 4s in this test - firing a synthetic 'complete' for the most recently
        // created/grouped tab shortly after registration keeps the real code path genuine
        // (still a real wait, real listener, real match-by-tabId) without the multi-second cost.
        onUpdated: {
          addListener: (fn) => { if (lastRelevantTabId !== null) setTimeout(() => fn(lastRelevantTabId, { status: 'complete' }, tabs.get(lastRelevantTabId)), 5); },
          removeListener: noop,
          hasListener: () => false
        },
        get: (id, cb) => { const t = tabs.get(id); if (cb) { cb(t); return undefined; } return Promise.resolve(t); },
        query: (q, cb) => {
          let list = Array.from(tabs.values());
          if (q.windowId !== undefined) list = list.filter((t) => t.windowId === q.windowId);
          if (q.active) list = list.slice(0, 1);
          if (cb) { cb(list); return undefined; }
          return Promise.resolve(list);
        },
        group: (opts, cb) => {
          const ids = Array.isArray(opts.tabIds) ? opts.tabIds : [opts.tabIds];
          const gid = opts.groupId !== undefined ? opts.groupId : groupCounter++;
          ids.forEach((id) => { const t = tabs.get(id); if (t) t.groupId = gid; });
          lastRelevantTabId = ids[ids.length - 1];
          cb(gid);
        },
        sendMessage: (tabId, msg, cb) => {
          cb({
            success: true,
            data: {
              title: 'x',
              url: tabs.get(tabId)?.url,
              elementCount: 0,
              elementsText: '',
              pageText: '',
              scrollState: { scrollY: 0, pageHeight: 800, viewportHeight: 800 }
            }
          });
        }
      },
      tabGroups: { onRemoved: listener(), get: (id, cb) => cb({ id, title: 'ScoutFox' }), update: (id, opts, cb) => cb && cb() },
      windows: {
        onRemoved: { addListener: (fn) => { listeners.onWindowRemoved = fn; } },
        create: (opts, cb) => {
          const windowId = winCounter++;
          const tabId = tabCounter++;
          const tab = { id: tabId, windowId, url: opts.url, groupId: -1 };
          windows.set(windowId, { id: windowId, tabs: [tab] });
          tabs.set(tabId, tab);
          lastRelevantTabId = tabId;
          cb({ id: windowId, tabs: [tab] });
        }
      },
      scripting: { executeScript: async () => [{ result: undefined }] },
      alarms: { create: noop, clear: noop, get: (n, cb) => cb(null), onAlarm: listener() },
      action: { onClicked: listener() },
      declarativeNetRequest: { updateSessionRules: () => Promise.resolve() },
      sidePanel: { setPanelBehavior: () => Promise.resolve(), setOptions: (opts, cb) => cb && cb(), open: () => Promise.resolve() }
    }
  };
}

function makeFakePort(name) {
  const disconnectListeners = [];
  return {
    name,
    received: [],
    postMessage(msg) { this.received.push(msg); },
    onDisconnect: { addListener: (fn) => disconnectListeners.push(fn) },
    _disconnect() { disconnectListeners.forEach((fn) => fn()); }
  };
}

function lastStateUpdate(port) {
  return [...port.received].reverse().find((m) => m.type === 'STATE_UPDATE');
}

function sendMessage(listeners, msg) {
  return new Promise((resolve) => listeners.onMessage(msg, {}, resolve));
}

/**
 * Poll until a window's task genuinely finishes, rather than guessing a fixed delay. Both
 * tests in this file share one background.js module instance (one process, one sessions Map),
 * so if a fixed sleep left test 1's loop still running in the background, test 2's OWN
 * START_TASK could genuinely race it - not a product bug, but exactly what real async
 * completion polling avoids.
 */
async function waitUntilIdle(listeners, windowId, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await sendMessage(listeners, { action: 'GET_AGENT_STATE', windowId });
    if (state.status === 'idle') return state;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`Task in window [${windowId}] did not reach idle within ${timeoutMs}ms`);
}

global.self = { addEventListener: () => {} };
const bgMock = makeBackgroundChromeMock();
global.chrome = bgMock.chrome;

await import('../background/background.js');

// Stub the LLM so a real runLoop step deterministically chooses open_window on step 1, then
// finishes on step 2 - exercising the actual production code path (executeActionOnTab ->
// openNewWindow -> onWindowOpenedCallback -> sessions.set) rather than a hand-rolled shortcut.
// ApiClients is the exact module specifier agentEngine.js imports, so mutating its method here
// patches what the real, already-running engine calls.
let step = 0;
const realGenerateCompletion = ApiClients.generateCompletion;
ApiClients.generateCompletion = async (settings, messages, systemPrompt) => {
  // generatePlan() calls this ONCE before the main loop ever starts, with its own fixed
  // systemPrompt, to build the checklist - distinct from the per-step action-decision calls
  // this stub actually needs to control. Handling it here (rather than letting it fall through
  // to the step counter below) is what keeps "step 1" meaning the loop's real first step.
  if (systemPrompt === 'You are a web task planner.') {
    return JSON.stringify(['Open the comparison window', 'Report the result']);
  }
  step++;
  if (step === 1) {
    return JSON.stringify({ action: 'open_window', url: 'https://example.com/second-window', reason: 'test' });
  }
  return JSON.stringify({ action: 'finish', answer: 'done comparing', reason: 'test' });
};

// Runs after every test() in this file has completed, not at import time - a bare top-level
// assignment would restore the real implementation before any test() body ever ran, since
// test() only registers the function; it does not execute it synchronously on this line.
after(() => { ApiClients.generateCompletion = realGenerateCompletion; });

test('a real task opening a window keeps it in the SAME session, observable end-to-end', async () => {
  const WIN_A = 1;
  bgMock.__addWindow(WIN_A, 101, 'https://example.com/original');

  const portA = makeFakePort('scoutfox_sidepanel_fresh:1');
  bgMock.__listeners.onConnect(portA);
  await new Promise((r) => setTimeout(r, 20));

  // Snapshotted BEFORE this test's own task starts - both tests in this file share one
  // background.js module instance (one process, one tabs/windows registry), so this is what
  // makes "the window MY OWN task just opened" identifiable, rather than assuming there is
  // exactly one new window in the whole mock or matching by a URL the other test could share.
  const windowIdsBefore = new Set(Array.from(bgMock.__tabs.values()).map((t) => t.windowId));

  const startRes = await sendMessage(bgMock.__listeners, { action: 'START_TASK', windowId: WIN_A, payload: { prompt: 'compare two pages side by side' } });
  assert.equal(startRes.success, true);

  // Poll for genuine completion (open_window, then finish) rather than a fixed sleep - a
  // guessed delay risks leaving this task still running when the NEXT test starts, since they
  // share the same module-level sessions Map.
  const stateA = await waitUntilIdle(bgMock.__listeners, WIN_A);
  assert.equal(stateA.task, 'compare two pages side by side');
  assert.ok(stateA.history.some((h) => h.type === 'finish'), 'the task must have actually completed');
  assert.ok(stateA.history.some((h) => h.action && h.action.action === 'open_window'),
    'the open_window step must be recorded in this SAME session\'s history');

  const newWindowId = Array.from(bgMock.__tabs.values()).map((t) => t.windowId).find((id) => !windowIdsBefore.has(id));
  assert.ok(newWindowId, 'openNewWindow must have actually created a new window');

  // A panel opening in the NEW window - a completely fresh connection, from that document's
  // own honest point of view - must reflect the SAME session, not start a blank one.
  const portB = makeFakePort(`scoutfox_sidepanel_fresh:${newWindowId}`);
  bgMock.__listeners.onConnect(portB);
  await new Promise((r) => setTimeout(r, 20));

  const reflected = lastStateUpdate(portB);
  assert.equal(reflected.payload.task, 'compare two pages side by side',
    'the new window\'s own panel must show the SAME session\'s task, not a blank one');
  assert.ok(reflected.payload.history.some((h) => h.type === 'finish'),
    'and the same completed history - this is what "stays part of the same session" means observably');

  portA._disconnect();
  portB._disconnect();
});

test('closing only the newly-opened window does not end the session while the original stays open', async () => {
  const WIN_A = 2;
  bgMock.__addWindow(WIN_A, 201, 'https://example.com/original2');
  step = 0;

  const portA = makeFakePort('scoutfox_sidepanel_fresh:2');
  bgMock.__listeners.onConnect(portA);
  await new Promise((r) => setTimeout(r, 20));

  const windowIdsBefore = new Set(Array.from(bgMock.__tabs.values()).map((t) => t.windowId));

  await sendMessage(bgMock.__listeners, { action: 'START_TASK', windowId: WIN_A, payload: { prompt: 'another comparison task' } });
  await waitUntilIdle(bgMock.__listeners, WIN_A);

  const newWindowId = Array.from(bgMock.__tabs.values()).map((t) => t.windowId).find((id) => !windowIdsBefore.has(id));
  assert.ok(newWindowId);

  bgMock.__listeners.onWindowRemoved(newWindowId);
  await new Promise((r) => setTimeout(r, 20));

  // The session must still be alive and answer for the ORIGINAL window.
  const state = await sendMessage(bgMock.__listeners, { action: 'GET_AGENT_STATE', windowId: WIN_A });
  assert.equal(state.task, 'another comparison task',
    'closing the secondary window must not tear down the session while the original window is still open');

  portA._disconnect();
});
