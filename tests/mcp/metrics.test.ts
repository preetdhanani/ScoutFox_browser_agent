/**
 * How the smoke run measures a task (tests/e2e/lib/metrics.mjs): what counts as a success, and the
 * median and p90 over repeated runs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// @ts-ignore - a plain .mjs module of the harness
import { aggregate, aggregateLines, callsForReport, expectedFinishOutcome, quantile, runVerdict } from '../e2e/lib/metrics.mjs';

const run = (over: Record<string, unknown> = {}) => ({
  task: 't', outcome: 'finish', expectOutcome: 'finish', expectFinishOutcome: 'done', finishOutcome: 'done', answerCorrect: true,
  status: 'idle', facts: { steps: [1, 2, 3] }, modelCalls: 3, promptTokens: 300, outputTokens: 30, wallMs: 3000, ...over
});

test('an open-web task must end "done"; a task can name its own outcome; a fixture task names none', () => {
  assert.equal(expectedFinishOutcome({ web: true }), 'done');
  assert.equal(expectedFinishOutcome({ web: true, expectFinishOutcome: 'partial' }), 'partial');
  assert.equal(expectedFinishOutcome({}), null);
  assert.equal(expectedFinishOutcome(undefined), null);
});

test('a run succeeds only with the right final entry, the right outcome and a right answer', () => {
  assert.equal(runVerdict(run()), null);
  assert.match(runVerdict(run({ outcome: null })), /no final entry/);
  assert.match(runVerdict(run({ outcome: 'partial_result' })), /partial_result entry, expected finish/);
  assert.match(runVerdict(run({ answerCorrect: false })), /answer is wrong/);
  assert.match(runVerdict(run({ outcome: null, stopped: 'loop' })), /harness stopped the run \(loop\)/);
  assert.equal(runVerdict(run({ outcome: null, cleared: true })), null, 'New chat mid-run ends with no final entry by design');
  assert.equal(runVerdict(run({ outcome: null, userStopped: true })), null);
});

test('a right-looking answer the model itself called "partial" is not a success', () => {
  assert.match(runVerdict(run({ finishOutcome: 'partial' })), /outcome "partial", expected "done"/);
  assert.match(runVerdict(run({ finishOutcome: null })), /outcome null, expected "done"/);
  assert.equal(runVerdict(run({ expectFinishOutcome: null, finishOutcome: 'partial' })), null, 'a task with no expected outcome is not judged on it');
});

test('quantile uses the nearest rank and ignores what is not a number', () => {
  assert.equal(quantile([12, 4, 8], 0.5), 8);
  assert.equal(quantile([12, 4, 8], 0.9), 12);
  assert.equal(quantile([5], 0.9), 5);
  assert.equal(quantile([], 0.5), null);
  assert.equal(quantile([1, NaN, 3, undefined as any], 0.5), 1);
});

test('aggregate groups repeated runs per task with median, p90 and successes', () => {
  const rows = aggregate([
    run({ task: 'a', facts: { steps: new Array(4) }, promptTokens: 26000 }),
    run({ task: 'b' }),
    run({ task: 'a', facts: { steps: new Array(12) }, promptTokens: 83000, finishOutcome: 'partial' }),
    run({ task: 'a', facts: { steps: new Array(5) }, promptTokens: 30000 })
  ]);
  assert.deepEqual(rows.map((r: any) => r.task), ['a', 'b'], 'first-seen order');
  const a = rows[0];
  assert.equal(a.runs, 3);
  assert.equal(a.successes, 2);
  assert.deepEqual(a.steps, { median: 5, p90: 12 });
  assert.deepEqual(a.promptTokens, { median: 30000, p90: 83000 });
  const lines = aggregateLines(rows);
  assert.match(lines[1], /^a\s+2\/3\s+5\/12/);
  assert.equal(lines.at(-1), 'success: 3/4 runs');
});

test('the saved report keeps every call and cuts only the reply text', () => {
  const calls = Array.from({ length: 60 }, (_, i) => ({ n: i + 1, promptEvalCount: 100, content: 'x'.repeat(1000) }));
  const kept = callsForReport(calls, 50);
  assert.equal(kept.length, 60);
  assert.equal(kept[59].n, 60);
  assert.equal(kept[0].content.length, 53);
  assert.equal(calls[0].content.length, 1000, 'the input is not changed');
});
