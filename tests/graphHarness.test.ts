/**
 * Tests for tests/helpers/graphHarness.ts: the real AgentRunner over the fakes, on a zero clock.
 *
 * Each test is also the smallest example of one thing a graph test does with the harness: run a task
 * to its finish, stop at a hold and answer it, pause and resume a run that is in flight, stop, and
 * restart the worker over the same storage. None of them waits for a real timer: a model reply that
 * must be "in flight" has a long delayMs, and the pause or stop that the test sends aborts it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { act, graphRig, shopPlan, zeroClock } from './helpers/graphHarness.ts';
import { runtimeRegistry } from '../src/background/runner/runtimeRegistry.ts';

test('graphHarness: a task runs to its finish, and the model, the page and the clock can be read afterwards', async (t) => {
  const rig = await graphRig({ policy: [act.scroll('down', 300), act.finish('Item 42 costs 99 USD.')] });
  t.after(rig.cleanup);

  const result = await rig.start('Find the price of item 42');

  assert.equal(result.success, true);
  assert.equal(rig.status(), 'idle');
  assert.equal(rig.finishAnswer(), 'Item 42 costs 99 USD.');
  assert.deepEqual(
    rig.site.actions.map((a) => a.payload),
    [{ action: 'scroll', direction: 'down', amount: 300 }],
    'the scroll went through the real BrowserPort to the fake content script'
  );
  assert.equal(rig.llm.callsOf('plan').length, 1);
  assert.equal(rig.llm.callsOf('policy').length, 2);
  assert.match(rig.llm.callsOf('policy')[0]?.system ?? '', /\S/, 'the call log shows what the policy node told the model');
  assert.match(rig.llm.callsOf('policy')[1]?.messages[0]?.content ?? '', /Items List/, 'and the page it was shown');
  assert.equal(rig.runtime.clock, rig.clock, 'the runtime runs on the zero clock');
  assert.equal(rig.state().task, 'Find the price of item 42');
  rig.llm.assertDrained();
  rig.assertClean();
});

test('graphHarness: a run stops at a hold and answers take it on - the question hold, and the plan hold', async (t) => {
  const rig = await graphRig({ autoApprove: false, policy: [act.askUser('Which color do you prefer?'), act.finish('Found the blue one.')] });
  t.after(rig.cleanup);

  // The plan card: the run is paused and the plan is waiting for the user.
  await rig.start('Find an item');
  assert.equal(rig.status(), 'paused');
  assert.ok(rig.pending().approval, 'the plan is waiting for approval');
  assert.equal(rig.llm.callsOf('policy').length, 0, 'nothing runs before the plan is approved');

  // The question: the run is paused again, a blank answer is refused, a real one resumes it.
  await rig.approvePlan();
  assert.equal(rig.status(), 'paused');
  assert.equal(rig.pending().question, 'Which color do you prefer?');
  assert.equal(rig.pending().approval, null);
  assert.equal((await rig.answer('  ')).success, false);
  assert.equal(rig.pending().question, 'Which color do you prefer?', 'the question stays');
  assert.equal((await rig.answer('Blue')).success, true);
  assert.equal(rig.status(), 'idle');
  assert.equal(rig.pending().question, null);
  assert.equal((rig.entries('user_answer')[0] as { content?: string } | undefined)?.content, 'Blue');
  assert.equal(rig.finishAnswer(), 'Found the blue one.');
  rig.assertClean();
});

test('graphHarness: a user pause while the model is thinking aborts the call, and resume asks the model again', async (t) => {
  const rig = await graphRig({
    autoApprove: false,
    policy: [{ text: act.finish('never used'), delayMs: 60_000 }, act.finish('Done after the pause.')],
  });
  t.after(rig.cleanup);

  await rig.start('Find an item');
  const run = rig.approvePlan(); // not awaited: the run is in flight
  await rig.waitForCall('policy');
  assert.equal(rig.status(), 'running');

  assert.equal(rig.runner.pause().success, true);
  await run;
  assert.equal(rig.status(), 'paused');
  assert.equal(rig.runner.pauseReason, 'user');
  assert.equal(rig.llm.callsOf('policy')[0]?.outcome, 'aborted', 'the pause cut the call that was in flight');
  assert.equal(rig.entries('finish').length, 0);

  assert.equal((await rig.resume()).success, true);
  assert.equal(rig.status(), 'idle');
  assert.equal(rig.runner.pauseReason, null);
  assert.equal(rig.finishAnswer(), 'Done after the pause.');
  assert.deepEqual(rig.llm.callsOf('policy').map((c: any) => c.outcome), ['aborted', 'text']);
  rig.llm.assertDrained();
  rig.assertClean();
});

test('graphHarness: stop ends a paused run, and a stop while the model is thinking aborts its request', async (t) => {
  const rig = await graphRig({ policy: [act.askUser('Need input'), { text: act.finish('too late'), delayMs: 60_000 }] });
  t.after(rig.cleanup);

  await rig.start('Task that asks');
  assert.equal(rig.status(), 'paused');
  assert.equal((await rig.stop()).success, true);
  assert.equal(rig.status(), 'stopped');
  assert.equal((await rig.stop()).success, false, 'nothing left to stop');

  // A second task on the same rig, stopped while the model call is in flight.
  rig.runner.clearHistory();
  await rig.settle();
  const run = rig.start('Task that is stopped');
  await rig.waitForCall('policy', 2);
  assert.equal(rig.runner.stop().success, true);
  await run;
  await rig.settle();

  assert.equal(rig.status(), 'stopped');
  assert.equal(rig.llm.callsOf('policy')[1]?.outcome, 'aborted');
  assert.equal(rig.entries('finish').length, 0, 'a stopped run never finishes');
  assert.equal(rig.site.actions.length, 0, 'nothing was dispatched to the page');
  rig.assertClean();
});

test('graphHarness: a restart builds a new runner over the same storage and the paused run continues in it', async (t) => {
  const rig = await graphRig({ policy: [act.askUser('Which size?'), act.finish('Size M.')] });
  t.after(rig.cleanup);

  await rig.start('Find a shirt');
  assert.equal(rig.pending().question, 'Which size?');
  const before = rig.runner;
  const oldChrome = rig.fc;

  const after = await rig.restart();

  assert.notEqual(after, before, 'a new runner');
  assert.notEqual(after.bootId, before.bootId);
  assert.notEqual(rig.fc, oldChrome, 'a new chrome over the same store');
  assert.equal(rig.fc.tabs.get(rig.tabId)?.url, oldChrome.tabs.get(rig.tabId)?.url, 'the tab is still there');
  assert.equal(runtimeRegistry.get(String(rig.tabId)), rig.runtime);
  assert.equal(rig.runtime.clock, rig.clock, 'the new runtime is on the zero clock too');
  assert.equal(rig.state().task, 'Find a shirt', 'the task came back from the checkpoint');
  assert.equal(rig.entries('user_goal').length, 1);
  assert.equal(rig.status(), 'paused');
  assert.equal(rig.pending().question, 'Which size?', 'the open question came back');

  assert.equal((await rig.answer('M')).success, true);
  assert.equal(rig.status(), 'idle');
  assert.equal(rig.finishAnswer(), 'Size M.');
  assert.equal(rig.llm.callsOf('policy').length, 2, 'the model script went on where it was, it was not started again');
  rig.assertClean();
});

test('graphHarness: the zero clock never waits - sleep resolves at once and only moves the virtual time', async () => {
  const clock = zeroClock(1000);
  const controller = new AbortController();
  const started = Date.now();

  await clock.sleep(60_000);
  assert.equal(clock.now(), 61_000);
  controller.abort();
  await clock.sleep(5_000, controller.signal);
  assert.equal(clock.now(), 61_000, 'an aborted sleep does not move the time');
  clock.advance(10);
  assert.equal(clock.time, 61_010);
  assert.deepEqual(clock.sleeps, [60_000, 5_000]);
  assert.ok(Date.now() - started < 1_000, 'a minute of virtual sleep took no real time');
  assert.equal(JSON.parse(shopPlan()).sites.length, 1);
});
