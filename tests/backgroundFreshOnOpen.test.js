/**
 * Regression test for a real user complaint: reopening the side panel resumed the previous
 * session's history, and that stale conversation got summarized (previousTurnsSummary()) back
 * into the very next task's LLM prompt - burning tokens on a conversation the user had already
 * moved on from and didn't ask to continue.
 *
 * Fix: clicking the toolbar icon - a deliberate, explicit "open ScoutFox" gesture, unlike an
 * internal port reconnect - clears an idle/finished session's history before anything else.
 * A session that is ACTUALLY running or paused right now must be left completely alone: that
 * is the exact "wipe an in-progress run" bug backgroundSessionFreshCollision.test.js and
 * multiWindowSameSessionE2E.test.js already guard against on the reconnect path - this file
 * only asserts the click path does not reintroduce it from a different angle.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { routerRig } from './helpers/routerRig.ts';
import { createFakeStorage } from './helpers/fakeStorageSession.ts';
import { SHOP_LIST_URL, act, shopPages, shopPlan } from './helpers/graphHarness.ts';

const STALE_ANSWER = 'The old answer the user already read and moved on from.';

test('clicking the icon on an idle session with stale history starts fresh', async (t) => {
  const store = createFakeStorage();
  const rig1 = await routerRig({
    store,
    tabs: [{ id: 100, url: SHOP_LIST_URL, windowId: 1, active: true }],
    pages: shopPages(),
    llm: {
      plan: [shopPlan()],
      policy: [act.finish(STALE_ANSWER)],
    },
  });
  await rig1.connect(100);
  await rig1.startTask(100, 'an old, unrelated finished task');
  await rig1.waitForStatus(100, 'idle');
  await rig1.cleanup();

  // Rig 2 boots with the SAME store, simulating a service worker restart / cold boot
  const rig2 = await routerRig({
    store,
    tabs: [{ id: 100, url: SHOP_LIST_URL, windowId: 1, active: true }],
    pages: shopPages(),
  });
  t.after(rig2.cleanup);

  const panel = await rig2.connect(100, { fresh: true });
  const baseline = panel.lastState();
  assert.equal(baseline?.['task'], 'an old, unrelated finished task');
  const baselineHistory = Array.isArray(baseline?.['history']) ? baseline['history'] : [];
  assert.ok(baselineHistory.length > 0, 'sanity check: the stale session really is showing before the click');

  await rig2.clickIcon(rig2.fc.tabs.get(100));

  const afterClick = panel.lastState();
  assert.notEqual(afterClick, baseline, 'clicking the icon must push a fresh STATE_UPDATE');
  assert.deepEqual(afterClick?.['history'], [],
    'an idle session\'s stale history must be cleared on the deliberate "open ScoutFox" click');
  assert.ok(!afterClick?.['task'], 'the stale task must be cleared too');
});

test('clicking the icon while a task is genuinely running leaves it completely untouched', async (t) => {
  let finishTask;
  const hangingPromise = new Promise((resolve) => { finishTask = resolve; });
  const rig = await routerRig({
    tabs: [{ id: 100, url: SHOP_LIST_URL, windowId: 1, active: true }],
    pages: shopPages(),
    llm: {
      plan: [shopPlan()],
      policy: [
        async () => {
          await hangingPromise;
          return act.finish('done');
        },
      ],
    },
  });
  t.after(async () => {
    finishTask?.();
    await rig.cleanup();
  });

  const panel = await rig.connect(100, { fresh: true });
  await rig.startTask(100, 'a brand new real task');
  await rig.waitForStatus(100, 'running');

  const running = panel.lastState();
  assert.equal(running?.['status'], 'running', 'sanity check: the task must actually be running before the click');

  await rig.clickIcon(rig.fc.tabs.get(100));

  const afterClick = panel.lastState();
  assert.equal(afterClick?.['status'], 'running',
    'a session that is genuinely running must never be cleared just because the icon was clicked again - ' +
    'that would wipe an in-progress run out from under the user, the exact bug class the reconnect-path tests guard against');
  assert.notEqual(afterClick?.['task'], null, 'the live task must survive the click');
});

test('clicking the icon while a task is paused leaves it completely untouched', async (t) => {
  let finishTask;
  const hangingPromise = new Promise((resolve) => { finishTask = resolve; });
  const rig = await routerRig({
    tabs: [{ id: 100, url: SHOP_LIST_URL, windowId: 1, active: true }],
    pages: shopPages(),
    llm: {
      plan: [shopPlan()],
      policy: [
        async () => {
          await hangingPromise;
          return act.finish('done');
        },
      ],
    },
  });
  t.after(async () => {
    finishTask?.();
    await rig.cleanup();
  });

  const panel = await rig.connect(100, { fresh: true });
  await rig.startTask(100, 'a brand new real task');
  await rig.waitForStatus(100, 'running');

  await rig.send({ action: 'PAUSE_TASK', tabId: 100 });
  await rig.waitForStatus(100, 'paused');

  const paused = panel.lastState();
  assert.equal(paused?.['status'], 'paused', 'sanity check: the task must actually be paused before the click');

  await rig.clickIcon(rig.fc.tabs.get(100));

  const afterClick = panel.lastState();
  assert.equal(afterClick?.['status'], 'paused',
    'a paused session must never be cleared just because the icon was clicked again');
  assert.notEqual(afterClick?.['task'], null, 'the paused task must survive the click');
});
