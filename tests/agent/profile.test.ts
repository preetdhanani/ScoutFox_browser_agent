// tests/agent/profile.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  loadEffortMatrix,
  getEffortProfile,
  suggestEffortLevel,
  detectOverBudget,
  calculatePlanEstimate,
} from '../../src/background/agent/profile.ts';

test('profile: loadEffortMatrix loads valid profiles from shared/effort.json', () => {
  const matrix = loadEffortMatrix();
  assert.ok(matrix.low, 'Should include low profile');
  assert.ok(matrix.medium, 'Should include medium profile');
  assert.ok(matrix.high, 'Should include high profile');

  assert.equal(matrix.low.multiplier, 1);
  assert.equal(matrix.medium.multiplier, 2);
  assert.equal(matrix.high.multiplier, 3);
});

test('profile: getEffortProfile resolves known and unknown levels safely', () => {
  const low = getEffortProfile('low');
  assert.equal(low.level, 'low');
  assert.equal(low.multiplier, 1);
  assert.deepEqual(low.blockedLadder, ['mark']);
  assert.equal(low.reservePct, 0.10);

  const medium = getEffortProfile('medium');
  assert.equal(medium.level, 'medium');
  assert.equal(medium.multiplier, 2);
  assert.deepEqual(medium.blockedLadder, ['reload', 'mark']);
  assert.equal(medium.reservePct, 0.15);

  const high = getEffortProfile('high');
  assert.equal(high.level, 'high');
  assert.equal(high.multiplier, 3);
  assert.deepEqual(high.blockedLadder, ['reload', 'search', 'mark']);
  assert.equal(high.reservePct, 0.20);

  // Fallback for null / undefined / unknown
  const fallback = getEffortProfile(null);
  assert.equal(fallback.level, 'medium');
  const unknown = getEffortProfile('nonexistent' as any);
  assert.equal(unknown.level, 'medium');

  // Extended levels
  const xhigh = getEffortProfile('xhigh');
  assert.equal(xhigh.level, 'xhigh');
  assert.equal(xhigh.multiplier, 4);

  const max = getEffortProfile('max');
  assert.equal(max.level, 'max');
  assert.equal(max.multiplier, 8);
});

test('profile: suggestEffortLevel heuristics identify query intent', () => {
  const compQuery = suggestEffortLevel('Compare the price of Framework Laptop 16 across Amazon and BestBuy');
  assert.equal(compQuery.level, 'high');
  assert.ok(compQuery.reason.includes('comparison'));

  const cheapestQuery = suggestEffortLevel('Find the cheapest flight from Berlin to Rome');
  assert.equal(cheapestQuery.level, 'high');

  const simpleQuery = suggestEffortLevel('What is the current time in Tokyo?');
  assert.equal(simpleQuery.level, 'low');

  const standardQuery = suggestEffortLevel('Search for python tutorial on docs.python.org');
  assert.equal(standardQuery.level, 'medium');

  const multiSite = suggestEffortLevel('Research laptops', 5);
  assert.equal(multiSite.level, 'high');
});

test('profile: detectOverBudget evaluates budget constraints and scaling factor', () => {
  const normal = detectOverBudget(250, 100);
  assert.equal(normal.isOverBudget, false);
  assert.equal(normal.deficit, 0);
  assert.equal(normal.scale, 1.0);
  assert.equal(normal.choices.length, 0);

  const over = detectOverBudget(250, 300);
  assert.equal(over.isOverBudget, true);
  assert.equal(over.deficit, 50);
  assert.ok(Math.abs(over.scale - 250 / 300) < 0.001);
  assert.ok(over.choices.includes('drop_sites'));
  assert.ok(over.choices.includes('raise_cap'));
});

test('profile: calculatePlanEstimate estimates steps and duration', () => {
  const med = getEffortProfile('medium');
  const estimate = calculatePlanEstimate(med, 3, 10);

  // 10 base * 2 mult = 20 steps / site
  assert.equal(estimate.estimatedStepsPerSite, 20);
  // 3 sites * 20 = 60 site steps
  // 60 * 0.15 reserve = 9 reserve steps
  assert.equal(estimate.reserveSteps, 9);
  assert.equal(estimate.estimatedSteps, 69);
  // 3 sites * 30s = 90s
  assert.equal(estimate.estimatedSeconds, 90);
});
