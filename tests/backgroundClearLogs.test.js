/**
 * Regression test for clear-logs-not-propagated.
 *
 * btnClearLogs used to clear the panel's view and delete agent_logs_history from storage,
 * but never told the background worker. Logger's own in-memory logsHistory kept every entry,
 * and the very next log call's persistLogsToStorage() rewrote all of it back into storage -
 * so a cleared log pane silently refilled itself.
 *
 * This is its own file (rather than a test() inside a larger file) because background.js
 * imports Logger via the plain '../src/shared/logger.ts' specifier, and node --test isolates by
 * file, not by individual test() - a fresh process here is what guarantees this test's Logger
 * import and background.js's internal Logger import resolve to the exact same module instance.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { routerRig } from './helpers/routerRig.ts';
import { Logger } from '../src/shared/logger.ts';

test('CLEAR_LOGS message calls through to Logger.clearLogs()', async (t) => {
  const rig = await routerRig();
  t.after(rig.cleanup);

  Logger.clearLogs(); // clean slate, independent of restore timing from module init above
  Logger.info('Test', 'should be gone after clear');
  assert.equal(Logger.getLogsHistory().length, 1);

  const res = await rig.send({ action: 'CLEAR_LOGS' });

  assert.equal(res?.success, true);
  assert.equal(Logger.getLogsHistory().length, 0,
    'the background worker must actually clear its own in-memory logsHistory, or the next log call rewrites the old entries back to storage');
});

test('a log call after CLEAR_LOGS does not resurrect the cleared entries', async (t) => {
  const rig = await routerRig();
  t.after(rig.cleanup);

  Logger.clearLogs();
  Logger.info('Test', 'entry before clear');

  await rig.send({ action: 'CLEAR_LOGS' });

  Logger.info('Test', 'entry after clear');
  const history = Logger.getLogsHistory();

  assert.equal(history.length, 1);
  assert.equal(history[0]?.message, 'entry after clear');
});
