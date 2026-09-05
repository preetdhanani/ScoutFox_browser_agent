/**
 * Regression test for simplify-duplicate-log-restore.
 *
 * Logger's cold-boot restore of persisted logs is async. GET_AGENT_STATE used to answer with
 * Logger.getLogsHistory() immediately, so a resync landing before that restore finished could
 * get back an empty array - which the panel then trusted and used to overwrite logs it had
 * already restored through a separate, now-removed direct storage read in sidepanel.js.
 *
 * Fixed at the source: Logger exposes logsRestored(), and GET_AGENT_STATE awaits it before
 * responding, so its answer is always complete. This is its own file for the same reason as
 * backgroundClearLogs.test.js - a fresh process gives full control over the timing of the one
 * chrome.storage.local.get() call that both background.js's Logger import and this test share.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

let deliverStorageResult;
const pendingGet = new Promise((resolve) => { deliverStorageResult = resolve; });

function makeBackgroundChromeMock() {
  const storage = {};
  const noop = () => {};
  const listener = () => ({ addListener: noop });
  return {
    runtime: {
      lastError: null,
      onConnect: listener(),
      onMessage: { addListener: (fn) => { global.__messageListener = fn; } }
    },
    storage: {
      local: {
        get: (keys, cb) => {
          const wantsLogs = (Array.isArray(keys) ? keys : [keys]).includes('agent_logs_history');
          if (wantsLogs) {
            // The exact race: this callback does not fire until the test says so, simulating
            // a storage read for logs that has not landed yet when GET_AGENT_STATE arrives.
            pendingGet.then(() => cb({ agent_logs_history: ['restored-entry'] }));
          } else {
            cb({});
          }
        },
        set: (data, cb) => { Object.assign(storage, data); if (cb) cb(); },
        remove: (keys, cb) => { if (cb) cb(); }
      }
    },
    tabs: { onRemoved: listener(), onActivated: listener(), onCreated: listener(), onUpdated: listener(), query: (q, cb) => cb([]) },
    tabGroups: { onRemoved: listener() },
    alarms: { create: noop, clear: noop, get: (name, cb) => cb(null), onAlarm: listener() },
    action: { onClicked: listener() },
    declarativeNetRequest: { updateSessionRules: () => Promise.resolve() },
    sidePanel: { setPanelBehavior: () => Promise.resolve(), setOptions: (opts, cb) => cb && cb(), open: noop }
  };
}

global.self = { addEventListener: () => {} };
global.chrome = makeBackgroundChromeMock();

// Importing background.js triggers its static `import { Logger } from '../utils/logger.js'`,
// which runs logger.js's top-level restore IIFE - the one this test's mock storage.get controls.
await import('../background/background.js');

test('GET_AGENT_STATE does not answer while the log restore is still in flight', async () => {
  let settled = false;
  const responsePromise = new Promise((resolve) => {
    global.__messageListener({ action: 'GET_AGENT_STATE' }, {}, (res) => { settled = true; resolve(res); });
  });

  await new Promise((r) => setTimeout(r, 20));
  assert.equal(settled, false,
    'answering early with an empty logs array is the exact race that used to wipe the panel\'s already-restored logs');

  deliverStorageResult();
  const res = await responsePromise;

  assert.equal(settled, true);
  // background.js logs its own boot sequence (worker start, DNR rule install, engine restore)
  // before this test ever runs, so 'restored-entry' is prepended to real entries rather than
  // being the only one - the assertion only needs to prove it survived, not that it is alone.
  assert.ok(res.logs.includes('restored-entry'),
    'once resolved, the answer must include the logs that were restored, not an empty array');
});
