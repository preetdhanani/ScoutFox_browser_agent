/**
 * The runner around a task: the claim, a Pause before the loop starts, the debugger after the
 * run, the tab group map after a worker restart, and what a runner leaves behind.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRunner } from '../../src/background/runner/AgentRunner.ts';
import { ScoutFoxMCPClient } from '../../src/background/mcp/client.ts';
import { cdp } from '../../src/background/browser/cdp.ts';
import { fakeChrome } from '../helpers/fakeChrome.ts';

test('a Pause clicked while the task is being claimed lands as a real pause, and the actions are not aborted', async (t) => {
  const restore = fakeChrome({ storage: true, tabs: { list: [{ id: 201, url: 'https://a.test', title: 'A', windowId: 1 }] }, tabGroups: true }).install();
  t.after(restore);
  const seen: any[] = [];
  t.mock.method(ScoutFoxMCPClient.prototype, 'startTask', async function (_prompt: string, opts: any) { seen.push(opts); });

  const runner = new AgentRunner(201, 'default');
  assert.equal(runner.claimForTask().success, true);
  assert.equal(runner.pause().success, true, 'the pause is accepted during the claim');
  await runner.startTask('Read the page', 201);

  assert.equal(runner.status, 'paused', 'the panel shows paused, not running');
  assert.equal(runner.pauseReason, 'user');
  assert.deepEqual(seen, [{ startPaused: true, effort: 'medium' }], 'the client sets up the turn and waits, with the default effort of Settings');
  const signal = (runner as any).runtime.control.stepSignal();
  assert.equal(signal.aborted, false, 'the step signal is not left aborted, so actions after Resume run');
});

test('a failure while setting up the tab group still releases the claim', async (t) => {
  const restore = fakeChrome({ storage: true }).install();
  t.after(restore);
  const runner = new AgentRunner(202, 'default');
  (runner as any).ensureScoutFoxGroup = async () => { throw new Error('tabGroups is gone'); };
  assert.equal(runner.claimForTask().success, true);
  await assert.rejects(runner.startTask('Do it', 202), /tabGroups is gone/);
  assert.equal(runner.claimForTask().success, true, 'the next task on the tab can claim it');
  runner.releaseTaskClaim();
});

test('a finished run releases the debugger from its tabs; a paused one keeps it', async (t) => {
  const restore = fakeChrome({ storage: true }).install();
  t.after(restore);
  const detached: number[] = [];
  t.mock.method(cdp, 'isAttached', () => true);
  t.mock.method(cdp, 'detach', async (tabId: number) => { detached.push(tabId); });

  const runner = new AgentRunner(203, 'default');
  runner.setRunStatus('paused', 'user');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(detached, [], 'paused keeps the debugger');
  runner.setRunStatus('idle');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(detached, [203], 'the run is over: the debugger goes');
});

test('the tab group map is read back after a worker restart', async (t) => {
  const restore = fakeChrome({ storage: true }).install();
  t.after(restore);
  const first = new AgentRunner(204, 'default');
  first.scoutFoxGroupIds.set(7, 99);
  await first.persistState();

  const restarted = new AgentRunner(204, 'default');
  await restarted.restorePromise;
  assert.equal(restarted.scoutFoxGroupIds.get(7), 99, 'the group of window 7 is known again');
});

test('a runner is not kept alive by a global map nothing reads', () => {
  const restore = fakeChrome({ storage: true }).install();
  try {
    new AgentRunner(205, 'default');
    assert.equal((globalThis as any).__scoutfoxSessions, undefined);
  } finally {
    restore();
  }
});

test('network requests the content script records are kept for the tab', () => {
  const restore = fakeChrome({ storage: true }).install();
  try {
    const runner = new AgentRunner(206, 'default');
    runner.recordNetworkRequest(206, { url: 'https://a.test/api', method: 'GET', status: 200 } as any);
    assert.equal(runner.networkBuffers.has(206), true);
  } finally {
    restore();
  }
});
