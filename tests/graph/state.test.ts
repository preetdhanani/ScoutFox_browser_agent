import test from 'node:test';
import assert from 'node:assert/strict';
import { cappedList, mergeMap, AgentState } from '../../src/background/graph/state.ts';
import { WorkerState } from '../../src/background/graph/workerState.ts';

test('state: cappedList appends and caps correctly', () => {
  const reducer = cappedList<number>(3);
  let list = reducer([], [1, 2]);
  assert.deepEqual(list, [1, 2]);

  list = reducer(list, [3, 4]);
  assert.deepEqual(list, [2, 3, 4], 'capped to last 3 elements');

  list = reducer(list, { $reset: [10, 20] });
  assert.deepEqual(list, [10, 20], 'reset works');
});

test('state: mergeMap merges, deletes on null, and handles reset', () => {
  const reducer = mergeMap<string>();
  let map = reducer({}, { $set: { a: '1', b: '2' } });
  assert.deepEqual(map, { a: '1', b: '2' });

  map = reducer(map, { $set: { b: null, c: '3' } });
  assert.deepEqual(map, { a: '1', c: '3' });

  map = reducer(map, { $reset: { x: '10' } });
  assert.deepEqual(map, { x: '10' });
});

test('state: AgentState and WorkerState have valid schema structures', () => {
  assert.ok(AgentState.spec, 'AgentState schema defined');
  assert.ok(WorkerState.spec, 'WorkerState schema defined');
});
