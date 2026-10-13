/**
 * The plan hold is answered by the runner itself (autoApprovePlan, the product default), so the run must never
 * show a 'paused' status for it. A user reported "after every task the agent stops and I have to press Resume":
 * deriveStatus() wrote 'paused' first and returned the approval command without ever setting 'running', so the
 * panel showed a Resume button, with no card behind it, for the whole run.
 *
 * The negative control of the first test is a manual one, written here so it is not lost: put HEAD's shape back in
 * AgentRunner.deriveStatus - `this.status = 'paused';` BEFORE the `autoAnswered` check AND no `this.status = 'running'`
 * in the auto-approve branch - and the first test must go red. (Putting back only the early write is not enough: nothing
 * is broadcast between it and the later `running` write, so that alone is invisible.)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { graphRig, act, shopPlan } from '../helpers/graphHarness.ts';

test('an auto-approved plan never makes the runner report paused', async (t) => {
  const rig = await graphRig({ autoApprove: true, policy: [act.finish('Item 42 costs 99 USD.')] });
  t.after(rig.cleanup);

  // Every state the runner broadcasts, which is what the side panel renders from.
  const seen: string[] = [];
  rig.runner.setStateChangeCallback((state) => { seen.push(String(state.status)); });

  await rig.start('Quick lookup');

  assert.equal(rig.status(), 'idle');
  assert.ok(seen.includes('running'), 'the run was reported as running');
  assert.ok(!seen.includes('paused'), `a state with status "paused" was broadcast although nobody had to answer anything (${[...new Set(seen)].join(', ')})`);
  assert.equal(rig.runner.pauseReason, null);
  assert.equal(rig.pending().approval, null);
});

test('a worker restart at a plan hold leaves the run paused with a reason, and Resume approves the plan and builds the budget', async (t) => {
  // First worker: autoApprove off, so the run stands at the plan hold and is checkpointed there.
  const rig = await graphRig({ autoApprove: false, policy: [act.finish('Item 42 costs 99 USD.')] });
  t.after(rig.cleanup);
  await rig.start('Compare laptop models');
  assert.equal(rig.status(), 'paused');
  assert.ok(rig.pending().approval, 'the plan hold is pending');

  // Second worker: the flag is not persisted, so it starts with the default (true). The command that approves the
  // plan is dropped by restoreState, so nothing may claim the run is running.
  await rig.restart({ autoApprove: true });
  assert.equal(rig.status(), 'paused', 'a restored plan hold is paused, not "running" with nothing driving it');
  assert.equal(rig.runner.pauseReason, 'worker_restart');
  assert.equal(rig.pending().approval, null, 'there is no plan card in the product, so none is pending');

  // The panel's Resume sends a plain resume. On a plan hold that is the approval: it must go through `alloc`.
  const result = await rig.resume();
  assert.equal(result.success, true, result.error);
  assert.equal(rig.status(), 'idle');
  assert.equal(rig.runner.pauseReason, null, 'a run that is not paused has no pause reason left over');
  assert.equal(rig.finishAnswer(), 'Item 42 costs 99 USD.');
  const budget = rig.runner.budget as { workingTotal: number; sites: Record<string, unknown> };
  assert.ok(budget.workingTotal > 0, 'the budget was built (without alloc it stays at 0 and the site ends at once)');
  assert.ok(Object.keys(budget.sites).length > 0, 'every site got an allocation');
});

test('a plain resume of a hold that is not a plan hold keeps its old route', async (t) => {
  // An ask_user hold: Resume (not an answer) must not be read as an approval of anything.
  const rig = await graphRig({ policy: [act.askUser('Which size?'), act.finish('Size M, 99 USD.')] });
  t.after(rig.cleanup);
  await rig.start('Find the price of item 42');
  assert.equal(rig.status(), 'paused');
  assert.equal(rig.pending().question, 'Which size?');
  const resumed = await rig.resume();
  assert.equal(resumed.success, true, resumed.error);
  // The model is asked again (perceive), and the run ends with its second reply. Nothing was re-planned or re-budgeted.
  assert.equal(rig.status(), 'idle');
  assert.equal(rig.finishAnswer(), 'Size M, 99 USD.');
  assert.equal(rig.llm.callsOf('plan').length, 1);
});

test('a Pause pending at an auto-approved plan hold pauses the run for the user: no loop, and Resume carries on', async (t) => {
  // The flag lands where no stream is running to be aborted (the gap after the plan call). The hold node shows the plan
  // hold for every orchestrator pause, and the scheduler routes a pending pause back to it, so a runner that kept
  // approving would loop for ever with status 'running' and a Resume that is refused.
  // The plan reply is delayed so the plan call is really in flight when the flag lands (a zero-delay fake model answers
  // before a test could do anything). The flag is set WITHOUT the stream abort that runner.pause() adds, to be the gap.
  const rig = await graphRig({ autoApprove: true, plan: { text: shopPlan(), delayMs: 60 }, policy: [act.finish('Item 42 costs 99 USD.')] });
  t.after(rig.cleanup);
  let updates = 0;
  rig.runner.setStateChangeCallback(() => { updates += 1; });

  const run = rig.start('Quick lookup');
  await rig.waitForCall('plan');
  rig.runtime.control.pauseRequested = true;
  await run;
  await rig.settle();

  assert.ok(updates < 200, `the runner kept answering the hold (${updates} state updates)`);
  assert.equal(rig.status(), 'paused');
  assert.equal(rig.runner.pauseReason, 'user');
  assert.equal(rig.llm.callsOf('policy').length, 0, 'nothing ran while the pause was pending');

  const resumed = await rig.resume();
  assert.equal(resumed.success, true, resumed.error);
  assert.equal(rig.status(), 'idle');
  assert.equal(rig.finishAnswer(), 'Item 42 costs 99 USD.');
  assert.equal(rig.runner.pauseReason, null);
});

test('Pause and an immediate Resume: the run goes on and says so (no stale "paused" from the winding-down drive)', async (t) => {
  // The first drive ends AFTER resume() cleared the pause flag, sees a graph that is not finished and no pause, and used
  // to write paused with the reason worker_restart. The second drive never wrote 'running' again, so the panel showed
  // Resume (and a false reason) for a run that was going on.
  let rigRef: Awaited<ReturnType<typeof graphRig>> | null = null;
  const statusAtSecondCall: string[] = [];
  const rig = await graphRig({
    autoApprove: true,
    policy: [
      { text: act.scroll(), delayMs: 80 },
      () => { statusAtSecondCall.push(String(rigRef?.runner.status)); return act.finish('Item 42 costs 99 USD.'); },
    ],
  });
  rigRef = rig;
  t.after(rig.cleanup);

  const run = rig.start('Quick lookup');
  await rig.waitForCall('policy');
  assert.equal(rig.runner.pause().success, true);
  assert.equal(rig.runner.resume().success, true);
  await run;
  await rig.settle();

  assert.deepEqual(statusAtSecondCall, ['running'], 'while the resumed run is working the status says running');
  assert.equal(rig.status(), 'idle');
  assert.equal(rig.runner.pauseReason, null);
});
