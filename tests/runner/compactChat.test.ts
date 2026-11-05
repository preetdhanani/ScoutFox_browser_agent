/**
 * Compact and the context meter of the runner (src/background/runner/AgentRunner.ts).
 *
 * What these tests hold on to:
 *   1. Compact is refused while a task runs, and when there is no earlier turn.
 *   2. A Compact stores the summary in a chat_compacted row, which the chain starts from.
 *   3. A failed summary call, or a New chat while it was in flight, leaves the chat as it was.
 *   4. The meter: 0 for an empty chat; between runs the estimate of the next request (system
 *      prompt, tools, chain); during a run the prompt of the last model call. It drops after a
 *      Compact and goes back to 0 after New chat.
 *   5. A chain over a quarter of the window is compacted before the task (auto), and a Stop while
 *      that summary is written cancels it.
 *   6. The snapshot kept for a worker restart never loses the last chat_compacted row.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRunner } from '../../src/background/runner/AgentRunner.ts';
import { fitSnapshot, type RunSnapshot } from '../../src/background/runner/runSnapshot.ts';
import { chainBlock } from '../../src/background/mcp/chatChain.ts';
import { finishEntry } from '../../src/background/mcp/historyEntries.ts';
import { fakeChrome } from '../helpers/fakeChrome.ts';
import { cdp } from '../../src/background/browser/cdp.ts';
import type { HistoryEntry } from '../../src/background/types.ts';

let nextTab = 7100;

/** A runner with `turns` finished turns, and a stand-in for the summary call. */
async function runnerWithTurns(t: any, turns: number, answer = 'The page lists 10 certifications.') {
  // A cloud provider: its window comes from the settings and the cache alone, with no request.
  const restore = fakeChrome({ storage: { local: { data: { agent_settings: { provider: 'openrouter', model: 'test/model' } } } }, tabs: true, dom: true }).install();
  t.after(restore);
  t.mock.method(cdp, 'detach', async () => {});
  const runner = new AgentRunner(nextTab++, 'default');
  await runner.restorePromise;
  for (let i = 1; i <= turns; i++) {
    runner.recordEntry({ type: 'user_goal', turn: i, prompt: `Goal ${i}`, timestamp: '10:00', isNewRun: true });
    runner.history.push(finishEntry(answer, '', undefined, 'done'));
  }
  const asked: string[] = [];
  let reply: (input: string, signal?: AbortSignal) => Promise<string> = async () => 'Summary: the page lists 10 certifications.';
  runner.summarizeChat = async (input: string, signal?: AbortSignal) => { asked.push(input); return reply(input, signal); };
  return { runner, asked, setReply: (fn: typeof reply) => { reply = fn; } };
}

const rowsOf = (runner: AgentRunner, type: string) => runner.history.filter((r) => r.type === type) as any[];

test('Compact is refused while a task runs, and when there is no earlier turn', async (t) => {
  const { runner, asked } = await runnerWithTurns(t, 1);
  runner.setRunStatus('running');
  const refused = await runner.compactChat();
  assert.equal(refused.success, false);
  assert.match(refused.error || '', /Stop the task/);
  runner.setRunStatus('idle');

  const empty = await runnerWithTurns(t, 0);
  const none = await empty.runner.compactChat();
  assert.equal(none.success, false);
  assert.match(none.error || '', /no earlier turn/);
  assert.equal(asked.length + empty.asked.length, 0, 'the model was never asked');
});

test('a Compact stores the summary in a chat_compacted row, and the chain starts from it', async (t) => {
  const { runner, asked } = await runnerWithTurns(t, 2);
  const result = await runner.compactChat();
  assert.equal(result.success, true);
  assert.equal(asked.length, 1, 'one model call');
  assert.match(asked[0], /Turn 1 \(done\)[\s\S]*Turn 2 \(done\)/, 'the call summarizes the turns');
  const [row] = rowsOf(runner, 'chat_compacted');
  assert.equal(row.summary, 'Summary: the page lists 10 certifications.');
  assert.equal(row.summarizedTurns, 2);
  assert.equal(row.auto, undefined, 'a Compact from the card is not marked automatic');
  const chain = chainBlock(runner.history);
  assert.match(chain, /Summary of 2 earlier turns/);
  assert.doesNotMatch(chain, /Turn 1 \(done\)/);
  assert.equal(runner.getState().context.summarizedTurns, 2);
  assert.equal(runner.getState().context.hasEarlierTurn, false, 'nothing new to compact right after a Compact');
});

test('a failed summary call leaves the chat as it was and says why', async (t) => {
  const { runner, setReply } = await runnerWithTurns(t, 2);
  const before = JSON.stringify(runner.history);
  setReply(async () => { throw new Error('HTTP 503 from the provider'); });
  const result = await runner.compactChat();
  assert.equal(result.success, false);
  assert.match(result.error || '', /could not be compacted: HTTP 503/);
  assert.equal(JSON.stringify(runner.history), before, 'no row was added');
  assert.equal(runner.getState().context.compacting, false, 'the card is not left "compacting"');

  setReply(async () => '   ');
  assert.equal((await runner.compactChat()).success, false, 'an empty summary is a failure too');
  assert.equal(rowsOf(runner, 'chat_compacted').length, 0);
});

test('a New chat while the summary is written drops the summary', async (t) => {
  const { runner, setReply } = await runnerWithTurns(t, 2);
  let release!: (text: string) => void;
  setReply(() => new Promise<string>((resolve) => { release = resolve; }));
  const pending = runner.compactChat();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(runner.getState().context.compacting, true, 'the card says it is compacting');
  runner.clearHistory();
  release('A summary of a chat that is gone.');
  const result = await pending;
  assert.equal(result.success, false);
  assert.equal(runner.history.length, 0, 'the new chat stays empty');
});

test('the meter: 0 when empty, the next request between runs, the last call during a run', async (t) => {
  const { runner } = await runnerWithTurns(t, 0);
  await runner.refreshContext();
  assert.equal(runner.getState().context.used, 0, 'an empty chat is 0%');
  assert.equal(runner.getState().context.window, 262144);
  assert.equal(runner.getState().context.windowSource, 'default', 'a cloud model the list named no window for: 256K');

  runner.recordEntry({ type: 'user_goal', turn: 1, prompt: 'Goal 1', timestamp: '', isNewRun: true });
  runner.history.push(finishEntry('x'.repeat(4000), '', undefined, 'done'));
  const idle = runner.getState().context;
  assert.ok(idle.used > 1000, `between runs the next request is estimated (system prompt, tools, chain): ${idle.used}`);
  assert.equal(idle.estimated, true);

  runner.setRunStatus('running');
  assert.equal(runner.getState().context.used, idle.used, 'a run before its first call still shows the estimate');
  runner.noteUsage({ promptTokens: 31_200, outputTokens: 50, estimated: false });
  assert.equal(runner.getState().context.used, 31_200, 'during a run: the prompt of the last call');
  assert.equal(runner.getState().context.estimated, false);
  runner.endRun('idle', finishEntry('done'));
  assert.notEqual(runner.getState().context.used, 31_200, 'after the run: the estimate of the next request again');

  const beforeCompact = runner.getState().context.used;
  runner.summarizeChat = async () => 'Short.';
  assert.equal((await runner.compactChat()).success, true);
  assert.ok(runner.getState().context.used < beforeCompact, 'Compact makes the next request smaller');

  runner.clearHistory();
  assert.equal(runner.getState().context.used, 0, 'New chat is 0% again');
});

test('the token counts of a task are kept in runStats and in the snapshot', async (t) => {
  const { runner } = await runnerWithTurns(t, 0);
  runner.runStats = { level: 'medium', modelCalls: 0, stepsUsed: 0, tokensIn: 0, tokensOut: 0, sitesDone: 0, sitesPartial: 0, elapsedMs: 0 };
  runner.setRunStatus('running');
  runner.noteUsage({ promptTokens: 1000, outputTokens: 20, estimated: false });
  runner.noteUsage({ promptTokens: 1500, outputTokens: 30, estimated: true });
  assert.equal(runner.runStats.tokensIn, 2500);
  assert.equal(runner.runStats.tokensOut, 50);
  assert.equal(runner.runStats.modelCalls, 2);
  const snapshot = (runner as any).runSnapshot();
  assert.deepEqual(snapshot.lastCall, { promptTokens: 1500, outputTokens: 30, estimated: true });
  assert.equal(snapshot.runStats.tokensIn, 2500);
});

test('a chain over a quarter of the window is compacted before the task, and marked automatic', async (t) => {
  const { runner, asked } = await runnerWithTurns(t, 3, 'y'.repeat(1400));
  runner.contextWindow = { tokens: 1000, source: 'user' };
  await (runner as any).autoCompactIfLong();
  assert.equal(asked.length, 1);
  const [row] = rowsOf(runner, 'chat_compacted');
  assert.equal(row.auto, true);

  const small = await runnerWithTurns(t, 1, 'short');
  await (small.runner as any).autoCompactIfLong();
  assert.equal(small.asked.length, 0, 'a short chain is sent as it is');
});

test('a Stop while the automatic summary is written cancels it and adds nothing', async (t) => {
  const { runner, setReply } = await runnerWithTurns(t, 3, 'y'.repeat(1400));
  runner.contextWindow = { tokens: 1000, source: 'user' };
  let sawAbort = false;
  setReply((_input, signal) => new Promise<string>((resolve, reject) => {
    signal?.addEventListener('abort', () => { sawAbort = true; reject(new Error('aborted')); }, { once: true });
  }));
  assert.equal(runner.claimForTask().success, true);
  const pending = (runner as any).autoCompactIfLong();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(runner.stop().success, true, 'the Stop lands on the task being claimed');
  // A summary that is not cancelled would hold the task start forever: give it a moment, not the test's whole timeout.
  const settled = await Promise.race([pending.then(() => true), new Promise((r) => setTimeout(() => r(false), 500))]);
  assert.equal(settled, true, 'the task start went on after the Stop');
  runner.releaseTaskClaim();
  assert.equal(sawAbort, true, 'the summary call was cancelled');
  assert.equal(rowsOf(runner, 'chat_compacted').length, 0);
});

test('COMPACT_CHAT holds the task claim: no Compact while a task is claimed', async (t) => {
  const { runner } = await runnerWithTurns(t, 1);
  assert.equal(runner.claimForTask().success, true);
  assert.equal(runner.claimForTask().success, false, 'a second claim (a Compact, or a task) is refused');
  runner.releaseTaskClaim();
});

test('the snapshot kept for a worker restart never loses the last chat_compacted row', () => {
  const history: HistoryEntry[] = [];
  const goal = (n: number): HistoryEntry => ({ type: 'user_goal', turn: n, prompt: `Goal ${n}`, timestamp: '', isNewRun: true });
  history.push(goal(1), finishEntry('a'.repeat(3000)));
  history.push({ type: 'chat_compacted', summary: 'The summary.', summarizedTurns: 1, timestamp: '' });
  for (let n = 2; n <= 6; n++) history.push(goal(n), finishEntry(String(n).repeat(3000)));
  const snapshot: RunSnapshot = { status: 'idle', task: 'Goal 6', history, planSteps: [], stepCount: 0, pauseReason: null, stateVersion: 1, savedAt: 0 };
  const fitted = fitSnapshot(snapshot, 9000);
  assert.ok(JSON.stringify(fitted).length <= 9000, 'it fits');
  const kept = fitted.history;
  assert.equal(kept[0].type, 'chat_compacted', 'the summary is kept in front');
  assert.equal((kept[0] as any).summary, 'The summary.');
  assert.ok(!kept.some((r) => r.type === 'user_goal' && r.turn === 2), 'old turns were cut');
  assert.ok(kept.some((r) => r.type === 'user_goal' && r.turn === 6), 'the last turn stays');
});
