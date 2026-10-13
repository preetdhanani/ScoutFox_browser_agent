import test from 'node:test';
import assert from 'node:assert/strict';
import { graphRig, act } from '../helpers/graphHarness.ts';
import { cappedList, MAX_HISTORY } from '../../src/background/graph/state.ts';

test('reducers: history rows are never written twice across site worker runs (B4 fix)', async () => {
  const rig = await graphRig({
    policy: [
      act.scroll('down', 100),
      act.scroll('down', 200),
      act.finish('Finished scrolling.'),
    ],
  });
  try {
    await rig.start('Scroll down twice and finish');
    assert.equal(rig.status(), 'idle');

    const history = rig.history();
    const responses = history.filter((h) => h.type === 'agent_response');
    const results = history.filter((h) => h.type === 'execution_result');

    // 2 scrolls + 1 finish = 3 responses, 2 execution results
    assert.equal(responses.length, 3);
    assert.equal(results.length, 2);

    // Verify step numbers are unique within each type
    const responseSteps = responses.map((r: any) => r.step);
    assert.deepEqual(responseSteps, [1, 2, 3]);

    const resultSteps = results.map((r: any) => r.step);
    assert.deepEqual(resultSteps, [1, 2]);
  } finally {
    rig.cleanup();
  }
});

test('reducers: cappedList bounds length and supports reset', () => {
  const reducer = cappedList<number>(5);
  const cur = [1, 2, 3];
  const next = reducer(cur, [4, 5, 6]);
  assert.deepEqual(next, [2, 3, 4, 5, 6]);

  const reset = reducer(next, { $reset: [10, 20] });
  assert.deepEqual(reset, [10, 20]);
});

test('reducers: cappedList with MAX_HISTORY caps at 400 and keeps newest entries (legacy agentEngineHistoryTrimming parity)', () => {
  const reducer = cappedList<{ step: number }>(MAX_HISTORY);
  const initial = Array.from({ length: 400 }, (_, i) => ({ step: i }));
  
  // Adding 10 new items
  const extra = Array.from({ length: 10 }, (_, i) => ({ step: 400 + i }));
  const updated = reducer(initial, extra);

  assert.equal(updated.length, 400);
  assert.equal(updated[0].step, 10, 'oldest entries should be dropped');
  assert.equal(updated[399].step, 409, 'latest entry preserved at tail');
});

test('reducers: cappedList handles appending empty array without mutating elements', () => {
  const reducer = cappedList<string>(10);
  const cur = ['a', 'b', 'c'];
  const next = reducer(cur, []);
  assert.deepEqual(next, ['a', 'b', 'c']);
});

test('reducers: cappedList caps when adding batch exceeding cap from empty state', () => {
  const reducer = cappedList<number>(3);
  const items = [10, 20, 30, 40, 50];
  const next = reducer([], items);
  assert.deepEqual(next, [30, 40, 50]);
});

test('reducers: cappedList reset with empty array clears all elements', () => {
  const reducer = cappedList<number>(5);
  const cur = [1, 2, 3];
  const reset = reducer(cur, { $reset: [] });
  assert.deepEqual(reset, []);
});

test('reducers: mergeMap handles $set updates and removes keys mapped to null', async () => {
  const { mergeMap } = await import('../../src/background/graph/state.ts');
  const reducer = mergeMap<string>();
  const cur = { a: 'first', b: 'second' };
  const next = reducer(cur, { $set: { b: 'updated', c: 'third', a: null } });
  assert.deepEqual(next, { b: 'updated', c: 'third' });
});

test('reducers: mergeMap handles $reset replacing all keys completely and respects cap with age callback', async () => {
  const { mergeMap } = await import('../../src/background/graph/state.ts');
  type Item = { val: string; time: number };
  const reducer = mergeMap<Item>(2, (item) => item.time);
  
  const reset = reducer({}, { $reset: { x: { val: 'x', time: 10 } } });
  assert.deepEqual(reset, { x: { val: 'x', time: 10 } });

  const next = reducer(reset, {
    $set: {
      y: { val: 'y', time: 20 },
      z: { val: 'z', time: 30 },
    },
  });
  // Cap is 2, oldest (x with time 10) should be dropped
  assert.deepEqual(Object.keys(next).sort(), ['y', 'z']);
});

