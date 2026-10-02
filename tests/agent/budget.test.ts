import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeSiteBase,
  computeSiteAlloc,
  computeWorkingTotal,
  computeUsableBudget,
  evaluateMeterMode,
  calculateSlackDraw
} from '../../src/background/agent/budget.ts';

test('budget: computeSiteBase clamps and scales by difficulty', () => {
  assert.equal(computeSiteBase('page', 1), 6);
  assert.equal(computeSiteBase('page', 2), 9);
  assert.equal(computeSiteBase('page', 3), 12);
  assert.equal(computeSiteBase('store', 1), 12);
  assert.equal(computeSiteBase('store', 2), 18);
  assert.equal(computeSiteBase('store', 3), 24);
  assert.equal(computeSiteBase('listing', 1), 10);
});

test('budget: computeSiteAlloc applies level multiplier', () => {
  // Medium = 2x
  assert.equal(computeSiteAlloc(6, 2), 12);
  assert.equal(computeSiteAlloc(12, 2), 24);
  // Low = 1x
  assert.equal(computeSiteAlloc(6, 1), 6);
  // High = 3x
  assert.equal(computeSiteAlloc(6, 3), 18);
});

test('budget: computeWorkingTotal calculates total and reserve', () => {
  // 3 sites: 24, 20, 20 = 64 steps
  const { workingTotal, reserve, sumAllocs } = computeWorkingTotal([24, 20, 20], 0.15);
  assert.equal(sumAllocs, 64);
  assert.equal(workingTotal, Math.round(64 / 0.85)); // 75
  assert.equal(reserve, 75 - 64); // 11
});

test('budget: computeUsableBudget bounds to 0', () => {
  assert.equal(computeUsableBudget(250, 50, 25), 175);
  assert.equal(computeUsableBudget(100, 90, 20), 0);
});

test('budget: evaluateMeterMode reflects thresholds', () => {
  // alloc 20
  assert.equal(evaluateMeterMode(5, 20), 'normal'); // 25%
  assert.equal(evaluateMeterMode(11, 20), 'normal'); // 55%
  assert.equal(evaluateMeterMode(12, 20), 'warn'); // 60%
  assert.equal(evaluateMeterMode(15, 20), 'warn'); // 75%
  assert.equal(evaluateMeterMode(16, 20), 'harvest'); // 80%
  assert.equal(evaluateMeterMode(18, 20), 'harvest'); // 90%
  assert.equal(evaluateMeterMode(19, 20), 'end'); // 95%
  assert.equal(evaluateMeterMode(20, 20), 'end'); // 100%
});

test('budget: calculateSlackDraw allows draw once if recent progress', () => {
  // 20 alloc -> max draw 25% = 5
  // progress at step 16, current 19 (diff 3 <= 5) -> allowed
  assert.equal(calculateSlackDraw(10, 20, 16, 19, false), 5);

  // already drawn -> 0
  assert.equal(calculateSlackDraw(10, 20, 16, 19, true), 0);

  // no recent progress (progress at step 10, current 19, diff 9 > 5) -> 0
  assert.equal(calculateSlackDraw(10, 20, 10, 19, false), 0);

  // slack pool small (only 3 in pool) -> draws 3
  assert.equal(calculateSlackDraw(3, 20, 16, 19, false), 3);
});
