/**
 * How a run ends. Every exit from running or paused goes through AgentRunner.endRun, which halts
 * the loop and leaves a terminal status plus a final row in one broadcast: the panel always has a
 * card to draw, and nothing writes into the run after its end. Also: a restarted worker keeps the
 * "stopped" status of an interrupted run, New chat stops the loop, and a replaced tab keeps its
 * session.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRunner } from '../../src/background/runner/AgentRunner.ts';
import { INTERRUPTED_TEXT } from '../../src/background/runner/runSnapshot.ts';
import { STOPPED_TEXT, finishEntry, errorEntry } from '../../src/background/mcp/historyEntries.ts';
import { fakeChrome } from '../helpers/fakeChrome.ts';
import { routerRig } from '../helpers/routerRig.ts';
import { act } from '../helpers/shopPages.ts';
import { cdp } from '../../src/background/browser/cdp.ts';

const TERMINAL = new Set(['idle', 'stopped', 'error']);
const FINAL_ROWS = new Set(['finish', 'partial_result', 'error']);

/** A model call that stays in flight until the test lets it answer. */
function heldReply() {
  let release!: (text: string) => void;
  const answer = new Promise<string>((resolve) => { release = resolve; });
  const held = { asked: 0, release: (text: string) => release(text), reply: () => { held.asked += 1; return answer; } };
  return held;
}

/** A runner whose loop is a stand-in that counts how often it was told to stop. */
function runnerWithLoop(tabId: number, status: 'running' | 'paused') {
  const runner = new AgentRunner(tabId, 'default');
  const loop = { stops: 0, stop() { this.stops += 1; } };
  (runner as any).mcpClient = loop;
  runner.recordEntry({ type: 'user_goal', turn: 1, prompt: 'Do it', timestamp: '', isNewRun: true });
  runner.setRunStatus(status, status === 'paused' ? 'user' : null);
  return { runner, loop };
}

test('every way out of a running or paused run leaves a terminal status and a final row, and halts the loop', async (t) => {
  const restore = fakeChrome({ storage: true, tabs: true, dom: true }).install();
  t.after(restore);
  t.mock.method(cdp, 'detach', async () => {});
  const exits: Array<[string, (r: AgentRunner) => void, string, string]> = [
    ['the user\'s Stop', (r) => { r.stop(); }, 'stopped', 'partial_result'],
    ['the model\'s finish', (r) => { r.endRun('idle', finishEntry('It costs 9 EUR.')); }, 'idle', 'finish'],
    ['a failed run', (r) => { r.endRun('error', errorEntry('The provider refused the key.')); }, 'error', 'error']
  ];
  let tabId = 600;
  for (const from of ['running', 'paused'] as const) {
    for (const [name, exit, status, rowType] of exits) {
      const { runner, loop } = runnerWithLoop(tabId++, from);
      exit(runner);
      assert.equal(runner.status, status, `${name} from ${from}: the status`);
      assert.ok(TERMINAL.has(runner.status), `${name} from ${from}: the status is terminal`);
      const last = runner.history.at(-1) as any;
      assert.equal(last.type, rowType, `${name} from ${from}: the final row`);
      assert.ok(FINAL_ROWS.has(last.type));
      assert.equal(loop.stops, 1, `${name} from ${from}: the loop was told to stop`);
      assert.equal(runner.pauseReason, null);
      // A run ends once: a later ending (a finish racing the Stop) is dropped.
      assert.equal(runner.endRun('idle', finishEntry('late')), false, `${name} from ${from}: a second ending is dropped`);
      assert.equal(runner.history.at(-1), last);
    }
  }
});

test('Stop writes the "Stopped by you" row the panel draws', async (t) => {
  const restore = fakeChrome({ storage: true, tabs: true, dom: true }).install();
  t.after(restore);
  t.mock.method(cdp, 'detach', async () => {});
  const { runner } = runnerWithLoop(620, 'running');
  assert.equal(runner.stop().success, true);
  assert.deepEqual(runner.history.at(-1), { type: 'partial_result', answer: STOPPED_TEXT, table: null, reason: 'stopped' });
  assert.deepEqual(runner.stop(), { success: false, error: 'No task is running or paused.' }, 'a stopped run cannot be stopped again');
});

test('New chat stops the loop before it clears the thread', async (t) => {
  const restore = fakeChrome({ storage: true, tabs: true, dom: true }).install();
  t.after(restore);
  t.mock.method(cdp, 'detach', async () => {});
  const { runner, loop } = runnerWithLoop(621, 'running');
  runner.clearHistory();
  assert.equal(loop.stops, 1, 'the loop was told to stop');
  assert.equal(runner.status, 'idle');
  assert.deepEqual(runner.history, [], 'no final row: the thread is cleared');
  assert.equal((runner as any).mcpClient, null, 'the old loop is let go');
  assert.equal((runner as any).runtime.control.stepSignal().aborted, true, 'an action in flight is aborted');
});

test('a restarted worker keeps an interrupted run "stopped" with its final row, also when the runner meta exists', async (t) => {
  const restore = fakeChrome({ storage: true, tabs: true, dom: true }).install();
  t.after(restore);
  const first = new AgentRunner(622, 'default');
  first.tarkaGroupIds.set(7, 99);
  await first.persistState(); // the meta every real run writes when it groups its tab
  first.recordEntry({ type: 'user_goal', turn: 1, prompt: 'Keep waiting', timestamp: '', isNewRun: true });
  first.setRunStatus('running');
  await (first as any).snapshots.flush();

  const restarted = new AgentRunner(622, 'default');
  await restarted.restorePromise;
  assert.equal(restarted.status, 'stopped', 'the meta does not turn the interrupted run into an idle one');
  assert.deepEqual(restarted.history.at(-1), { type: 'partial_result', answer: INTERRUPTED_TEXT, table: null, reason: 'interrupted' });
  assert.equal(restarted.tarkaGroupIds.get(7), 99, 'the tab group map still comes back from the meta');
});

test('through the router: Stop, New chat and a closed tab each end a run that is waiting on the model', async (t) => {
  const stopHeld = heldReply();
  const clearHeld = heldReply();
  const closeHeld = heldReply();
  const rig = await routerRig({
    tabs: [
      { id: 100, url: 'https://example.com/a', windowId: 1, active: true },
      { id: 101, url: 'https://example.com/b', windowId: 1 },
      { id: 102, url: 'https://example.com/c', windowId: 1 }
    ],
    llm: { policy: [stopHeld.reply, clearHeld.reply, closeHeld.reply] }
  });
  t.after(rig.cleanup);
  const endings: Array<{ status: string; row: string | null }> = [];
  const realEndRun = AgentRunner.prototype.endRun;
  t.mock.method(AgentRunner.prototype, 'endRun', function (this: AgentRunner, status: any, row: any) {
    const ended = realEndRun.call(this, status, row);
    if (ended) endings.push({ status, row: row ? row.type : null });
    return ended;
  });

  // Stop while the model call is in flight.
  await rig.startTask(100, 'Wait for me');
  await rig.waitForStatus(100, 'running');
  assert.equal((await rig.send({ action: 'STOP_TASK', tabId: 100 })).success, true);
  const stopped = await rig.state(100);
  assert.equal(stopped['status'], 'stopped');
  assert.equal(stopped['history'].at(-1).type, 'partial_result');
  stopHeld.release(act.wait(1));
  await rig.settle();
  assert.equal((await rig.state(100))['history'].at(-1).type, 'partial_result', 'the late reply writes nothing after the end');

  // New chat while the model call is in flight: the reply that comes back later must go nowhere.
  await rig.startTask(101, 'Wait for me');
  await rig.waitForStatus(101, 'running');
  await rig.send({ action: 'CLEAR_HISTORY', tabId: 101 });
  clearHeld.release(act.wait(1));
  await rig.settle();
  await new Promise((r) => setTimeout(r, 50));
  await rig.settle();
  const cleared = await rig.state(101);
  assert.equal(cleared['status'], 'idle');
  assert.deepEqual(cleared['history'], [], 'nothing was written into the cleared thread');
  assert.equal(closeHeld.asked, 0, 'the model was not asked again after New chat');

  // The owner tab closes while the model call is in flight.
  await rig.startTask(102, 'Wait for me');
  await rig.waitForStatus(102, 'running');
  rig.fc.tabs.close(102);
  await rig.settle();

  assert.deepEqual(endings, [
    { status: 'stopped', row: 'partial_result' },
    { status: 'idle', row: null },
    { status: 'stopped', row: 'partial_result' }
  ], 'each of the three went through endRun');
  closeHeld.release(act.wait(1));
  await rig.settle();
});

test('a tab Chrome replaces keeps its session and its run under the new id', async (t) => {
  const held = heldReply();
  const rig = await routerRig({
    tabs: [{ id: 100, url: 'https://example.com/a', windowId: 1, active: true }],
    llm: { policy: [held.reply] }
  });
  t.after(rig.cleanup);
  await rig.startTask(100, 'Wait for me');
  await rig.waitForStatus(100, 'running');

  rig.fc.tabs.replace(100, { id: 200 });
  await rig.settle();

  const moved = await rig.state(200);
  assert.equal(moved['status'], 'running', 'the new id answers with the run');
  assert.equal(moved['task'], 'Wait for me');
  assert.equal(rig.runtime(200)?.ownerTabId, 200, 'the run now owns the new tab, under its id');
  assert.equal(rig.runtime(200)?.tabs.activeTabId, 200, 'and works in it');
  assert.equal(rig.runtime(100), undefined, 'nothing is left under the old id');
  // The new id is the owner now: Stop through it ends the run with its card.
  assert.equal((await rig.send({ action: 'STOP_TASK', tabId: 200 })).success, true);
  assert.equal((await rig.state(200))['history'].at(-1).type, 'partial_result');
  held.release(act.wait(1));
  await rig.settle();
});
