/**
 * Regression test for clear-logs-not-propagated.
 *
 * btnClearLogs used to clear the panel's view and delete agent_logs_history from storage,
 * but never told the background worker. Logger's own in-memory logsHistory kept every entry,
 * and the very next log call's persistLogsToStorage() rewrote all of it back into storage -
 * so a cleared log pane silently refilled itself.
 *
 * This is its own file (rather than a test() inside a larger file) because background.js
 * imports Logger via the plain '../utils/logger.js' specifier, and node --test isolates by
 * file, not by individual test() - a fresh process here is what guarantees this test's Logger
 * import and background.js's internal Logger import resolve to the exact same module instance.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

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
          const result = {};
          (Array.isArray(keys) ? keys : [keys]).forEach((k) => { result[k] = storage[k]; });
          cb(result);
        },
        set: (data, cb) => { Object.assign(storage, data); if (cb) cb(); },
        remove: (keys, cb) => { (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete storage[k]); if (cb) cb(); }
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

// Same specifier background.js itself uses - this IS the instance routeMessage will act on.
const { Logger } = await import('../utils/logger.js');
await import('../background/background.js');

test('CLEAR_LOGS message calls through to Logger.clearLogs()', async () => {
  Logger.clearLogs(); // clean slate, independent of restore timing from module init above
  Logger.info('Test', 'should be gone after clear');
  assert.equal(Logger.getLogsHistory().length, 1);

  const res = await new Promise((resolve) => {
    global.__messageListener({ action: 'CLEAR_LOGS' }, {}, resolve);
  });

  assert.equal(res.success, true);
  assert.equal(Logger.getLogsHistory().length, 0,
    'the background worker must actually clear its own in-memory logsHistory, or the next log call rewrites the old entries back to storage');
});

test('a log call after CLEAR_LOGS does not resurrect the cleared entries', async () => {
  Logger.clearLogs();
  Logger.info('Test', 'entry before clear');

  await new Promise((resolve) => { global.__messageListener({ action: 'CLEAR_LOGS' }, {}, resolve); });

  Logger.info('Test', 'entry after clear');
  const history = Logger.getLogsHistory();

  assert.equal(history.length, 1);
  assert.equal(history[0].message, 'entry after clear');
});
