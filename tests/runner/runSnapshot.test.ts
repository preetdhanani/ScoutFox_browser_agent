/**
 * The run kept across worker restarts: src/background/runner/runSnapshot.ts and its use in
 * AgentRunner. Chrome stops an idle worker after about 30 seconds; without this the panel came
 * back to the start screen with the user's run gone.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRunner } from '../../src/background/runner/AgentRunner.ts';
import { INTERRUPTED_TEXT, RunSnapshotStore, fitSnapshot, restoredRun, runSnapshotKey, type RunSnapshot } from '../../src/background/runner/runSnapshot.ts';
import { fakeChrome } from '../helpers/fakeChrome.ts';

/** A storage.session stand-in that keeps what is written. */
function memoryArea() {
  const data: Record<string, unknown> = {};
  return {
    data,
    async get(key: any) { return { [key]: data[key] }; },
    async set(items: Record<string, unknown>) { Object.assign(data, JSON.parse(JSON.stringify(items))); },
    async remove(keys: any) { for (const k of [].concat(keys)) delete data[k]; }
  };
}

const finished = (): RunSnapshot => ({
  status: 'idle',
  task: 'What does it cost?',
  history: [{ type: 'user_goal', content: 'What does it cost?', turn: 1 } as any, { type: 'finish', answer: '1.399,00 EUR' } as any],
  planSteps: [],
  stepCount: 1,
  pauseReason: null,
  stateVersion: 7,
  savedAt: 0
});

test('a finished run comes back exactly as it was', () => {
  const run = finished();
  assert.equal(restoredRun(run), run);
});

test('a run the worker died under is stopped, keeps its steps, and says why', () => {
  const run = restoredRun({ ...finished(), status: 'running' });
  assert.equal(run.status, 'stopped');
  assert.equal(run.history.length, 3);
  // A final row, so the panel draws its "Interrupted" card (an error row would read "Failed").
  assert.deepEqual(run.history.at(-1), { type: 'partial_result', answer: INTERRUPTED_TEXT, table: null, reason: 'interrupted' });
  assert.equal(run.stateVersion, 8, 'a newer version, so the panel does not drop it');
});

test('fitSnapshot drops raw tool calls and then the oldest turns, never the last one', () => {
  const big = 'x'.repeat(5000);
  const history: any[] = [];
  for (let turn = 1; turn <= 5; turn++) {
    history.push({ type: 'user_goal', content: `task ${turn}`, turn });
    history.push({ type: 'agent_response', rawResponse: big, content: `step ${turn}` });
  }
  const fitted = fitSnapshot({ ...finished(), history }, 2000);
  assert.ok(!JSON.stringify(fitted).includes(big), 'raw tool calls are not kept');
  const fittedSmall = fitSnapshot({ ...finished(), history: history.map((r) => ({ ...r, content: `${r.content} ${'y'.repeat(300)}` })) }, 1500);
  assert.ok(JSON.stringify(fittedSmall).length <= 1500 || fittedSmall.history.length <= 2);
  assert.equal((fittedSmall.history.at(-2) as any).content.startsWith('task 5'), true, 'the last turn is kept');
});

test('the store writes the latest state once, and an empty idle state removes the key', async () => {
  const area = memoryArea();
  const store = new RunSnapshotStore(11, area as any);
  store.save({ ...finished(), task: 'first' });
  store.save({ ...finished(), task: 'second' });
  await store.flush();
  assert.equal((area.data[runSnapshotKey(11)] as any).task, 'second');
  store.save({ ...finished(), task: '', history: [], status: 'idle' }, true);
  await store.flush();
  assert.equal(area.data[runSnapshotKey(11)], undefined);
});

test('clear drops a pending write, so a cleared run does not come back', async () => {
  const area = memoryArea();
  const store = new RunSnapshotStore(12, area as any);
  store.save(finished());
  await store.clear();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(area.data[runSnapshotKey(12)], undefined);
});

test('a new runner for the tab (a restarted worker) shows the run the old one finished', async (t) => {
  const restore = fakeChrome({ storage: true }).install();
  t.after(restore);
  const first = new AgentRunner(301, 'default');
  first.currentTask = 'What does it cost?';
  first.recordEntry({ type: 'user_goal', content: 'What does it cost?', turn: 1 } as any);
  first.recordEntry({ type: 'finish', answer: '1.399,00 EUR' } as any);
  first.setRunStatus('idle');
  await new Promise((r) => setTimeout(r, 300));

  const restarted = new AgentRunner(301, 'default');
  await restarted.restorePromise;
  assert.equal(restarted.history.length, 2);
  assert.equal((restarted.history[1] as any).answer, '1.399,00 EUR');
  assert.equal(restarted.currentTask, 'What does it cost?');
  assert.ok(restarted.stateVersion >= first.stateVersion, 'the version does not go backwards');
});

test('New chat clears the kept run too', async (t) => {
  const restore = fakeChrome({ storage: true }).install();
  t.after(restore);
  const first = new AgentRunner(302, 'default');
  first.recordEntry({ type: 'user_goal', content: 'x', turn: 1 } as any);
  first.setRunStatus('idle');
  first.clearHistory();
  await new Promise((r) => setTimeout(r, 300));
  const restarted = new AgentRunner(302, 'default');
  await restarted.restorePromise;
  assert.equal(restarted.history.length, 0);
});

test('a tab Chrome replaced keeps its run for a restarted worker: the run is stored under the new tab id', async (t) => {
  const restore = fakeChrome({ storage: true }).install();
  t.after(restore);
  const first = new AgentRunner(303, 'default');
  first.currentTask = 'What does it cost?';
  first.recordEntry({ type: 'user_goal', content: 'What does it cost?', turn: 1 } as any);
  first.recordEntry({ type: 'finish', answer: '1.399,00 EUR' } as any);
  first.setRunStatus('idle');
  // Chrome swaps the tab (a prerendered page took its place) before the debounced write went out.
  first.replaceTab(303, 304);
  assert.equal(first.threadId, '304');
  await new Promise((r) => setTimeout(r, 300));

  const stored = await chrome.storage.session.get([runSnapshotKey(303), runSnapshotKey(304)]);
  assert.equal(stored[runSnapshotKey(303)], undefined, 'nothing is left under the old tab id');
  assert.ok(stored[runSnapshotKey(304)], 'the run is kept under the new tab id');

  // A restarted worker builds the runner from the tab id it sees now: the new one.
  const restarted = new AgentRunner(304, 'default');
  await restarted.restorePromise;
  assert.equal(restarted.history.length, 2);
  assert.equal((restarted.history[1] as any).answer, '1.399,00 EUR');
});
