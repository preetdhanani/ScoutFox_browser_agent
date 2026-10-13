/**
 * Regression test for the data-loss half of the "the side panel disappeared" report.
 *
 * Chrome closes the side panel whenever the active tab changes to one the panel is not enabled
 * for, and no extension can reopen it without a fresh user gesture. So the only way back is to
 * click the toolbar icon again. That click ran clearHistory() on any session that was not
 * running or paused - which is every session whose run has just FINISHED. Recovering the panel
 * therefore destroyed the very result the user was trying to get back to.
 *
 * "Stale" was always meant to mean a conversation restored from storage that the user has moved
 * on from - see backgroundFreshOnOpen.test.js, which this file is the counterpart to. It was
 * never meant to mean a run that finished thirty seconds ago. Both read as status 'idle', which
 * is why a status-only test could not tell them apart.
 *
 * engine.dirty separates them exactly: the constructor sets it false, restoreState never sets
 * it, and every method that mutates this worker's own engine sets it true. So !dirty means
 * "everything on screen came out of storage and nothing has happened in this worker's lifetime".
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { routerRig } from './helpers/routerRig.ts';
import { SHOP_LIST_URL, act, shopPages, shopPlan } from './helpers/graphHarness.ts';

const FINAL_ANSWER = 'The answer the user asked for and has not read yet.';

test('a run that finished in this worker survives the click that reopens the panel', async (t) => {
  const rig = await routerRig({
    tabs: [{ id: 100, url: SHOP_LIST_URL, windowId: 1, active: true }],
    pages: shopPages(),
    llm: {
      plan: [shopPlan()],
      policy: [act.finish(FINAL_ANSWER)],
    },
  });
  t.after(rig.cleanup);

  const panel = await rig.connect(100);

  const started = await rig.startTask(100, 'the task whose answer matters');
  assert.equal(started.success, true);
  await rig.waitForStatus(100, 'idle');

  const finished = panel.lastState();
  assert.equal(finished?.['status'], 'idle', 'sanity check: a finished run reports idle, same as a stale restored one');
  const history = Array.isArray(finished?.['history']) ? finished['history'] : [];
  const answerEntry = history.find((h) => h.type === 'finish');
  assert.ok(answerEntry, 'sanity check: the run really did produce a finish entry before the click');

  // The user's panel was closed by Chrome when the automation tab was activated, so clicking the
  // icon is the ONLY way they can get it back. That gesture must not cost them the result.
  await rig.clickIcon(rig.fc.tabs.get(100));

  const afterClick = panel.lastState();
  assert.equal(afterClick?.['status'], 'idle', 'the session is still idle, as before');
  const afterHistory = Array.isArray(afterClick?.['history']) ? afterClick['history'] : [];
  const survivingAnswer = afterHistory.find((h) => h.type === 'finish');
  assert.ok(survivingAnswer,
    'clicking the icon to get the panel back must not destroy the run the user is trying to read - ' +
    'that click is a recovery gesture forced on them by the panel closing, not a request to start over');
  assert.equal(afterClick?.['task'], 'the task whose answer matters',
    'and the task it answered must still be on screen next to the answer');
});

test('the New Session button still starts over on demand', async (t) => {
  const rig = await routerRig({
    tabs: [{ id: 100, url: SHOP_LIST_URL, windowId: 1, active: true }],
    pages: shopPages(),
    llm: {
      plan: [shopPlan()],
      policy: [act.finish(FINAL_ANSWER)],
    },
  });
  t.after(rig.cleanup);

  const panel = await rig.connect(100);
  await rig.startTask(100, 'task to be cleared');
  await rig.waitForStatus(100, 'idle');

  const history = Array.isArray(panel.lastState()?.['history']) ? panel.lastState()['history'] : [];
  assert.ok(history.length > 0);

  const res = await rig.send({ action: 'CLEAR_HISTORY', tabId: 100 });
  assert.equal(res?.success, true);

  const cleared = panel.lastState();
  assert.deepEqual(cleared?.['history'], [],
    'keeping a finished run through a reopen must not remove the explicit, deliberate way to clear it');
});
