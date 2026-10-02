// tests/agent/profile.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  loadEffortMatrix,
  getEffortProfile,
  suggestEffortLevel,
} from '../../src/background/agent/profile.ts';

test('profile: loadEffortMatrix loads valid profiles from shared/effort.json', () => {
  const matrix = loadEffortMatrix();
  assert.ok(matrix.auto, 'Should include auto profile');
  assert.ok(matrix.low, 'Should include low profile');
  assert.ok(matrix.medium, 'Should include medium profile');
  assert.ok(matrix.high, 'Should include high profile');
  assert.ok(matrix.max, 'Should include max profile');

  assert.equal(matrix.low.multiplier, 1);
  assert.equal(matrix.medium.multiplier, 2);
  assert.equal(matrix.high.multiplier, 3);
  assert.equal(matrix.max.multiplier, 8);

  for (const lvl of ['auto', 'low', 'medium', 'high', 'max']) {
    const prof = matrix[lvl];
    assert.ok(prof, `Profile ${lvl} must exist`);
    assert.equal(typeof prof.searchDepth, 'number');
    assert.equal(typeof prof.maxSites, 'number');
    assert.equal(typeof prof.stepBudgetPerSite, 'number');
    assert.equal(typeof prof.tokenBudgetPerSite, 'number');
    assert.ok(prof.reflectMode);
    assert.equal(typeof prof.workerPlanning, 'boolean');
    assert.equal(typeof prof.replanBudgetPerSite, 'number');
    assert.equal(typeof prof.replanMaxRounds, 'number');
    assert.ok(prof.screenshotMode);
  }
});

test('profile: getEffortProfile resolves known and unknown levels safely', () => {
  const auto = getEffortProfile('auto');
  assert.equal(auto.level, 'auto');
  assert.equal(auto.multiplier, 2);
  assert.equal(auto.searchDepth, 2);
  assert.equal(auto.maxSites, 4);

  const low = getEffortProfile('low');
  assert.equal(low.level, 'low');
  assert.equal(low.multiplier, 1);
  assert.deepEqual(low.blockedLadder, ['mark']);
  assert.equal(low.reservePct, 0.10);
  assert.equal(low.searchDepth, 1);
  assert.equal(low.maxSites, 2);

  const medium = getEffortProfile('medium');
  assert.equal(medium.level, 'medium');
  assert.equal(medium.multiplier, 2);
  assert.deepEqual(medium.blockedLadder, ['reload', 'mark']);
  assert.equal(medium.reservePct, 0.15);
  assert.equal(medium.searchDepth, 2);
  assert.equal(medium.maxSites, 4);

  const high = getEffortProfile('high');
  assert.equal(high.level, 'high');
  assert.equal(high.multiplier, 3);
  assert.deepEqual(high.blockedLadder, ['reload', 'search', 'mark']);
  assert.equal(high.reservePct, 0.20);
  assert.equal(high.searchDepth, 3);
  assert.equal(high.maxSites, 6);

  const max = getEffortProfile('max');
  assert.equal(max.level, 'max');
  assert.equal(max.multiplier, 8);
  assert.equal(max.reservePct, 0.10);
  assert.equal(max.searchDepth, 4);
  assert.equal(max.maxSites, 8);

  // Fallback for null / undefined / unknown
  const fallback = getEffortProfile(null);
  assert.equal(fallback.level, 'medium');
  const unknown = getEffortProfile('nonexistent' as any);
  assert.equal(unknown.level, 'medium');

  // Extended levels
  const xhigh = getEffortProfile('xhigh');
  assert.equal(xhigh.level, 'xhigh');
  assert.equal(xhigh.multiplier, 4);
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
