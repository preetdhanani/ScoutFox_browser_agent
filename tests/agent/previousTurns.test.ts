import test from 'node:test';
import assert from 'node:assert/strict';
import {
  previousTurnsSummary,
  currentTurnHistory,
  lastCompletedTurn,
  PREVIOUS_TURNS_LIMIT,
} from '../../src/background/agent/previousTurns.ts';
import type { HistoryEntry } from '../../src/background/graph/state.ts';

test('previousTurns: previousTurnsSummary recaps up to 4 completed turns with 280-char truncation', () => {
  const longAnswer = 'A'.repeat(350);
  const history: HistoryEntry[] = [
    { type: 'user_goal', turn: 1, prompt: 'Find item 1', timestamp: '2026-01-01', isNewRun: true },
    { type: 'finish', answer: longAnswer },
    { type: 'user_goal', turn: 2, prompt: 'Find item 2', timestamp: '2026-01-01', isNewRun: true },
    { type: 'finish', answer: 'Item 2 costs 50 EUR.' },
  ];

  const summary = previousTurnsSummary(history);
  assert.equal(summary.length, 2);
  assert.ok(summary[0].includes('- Asked: "Find item 1"\n  Result: '));
  // 280 characters max
  const answerPart = summary[0].split('Result: ')[1];
  assert.equal(answerPart.length, 280);
  assert.equal(summary[1], '- Asked: "Find item 2"\n  Result: Item 2 costs 50 EUR.');
});

test('previousTurns: tags unconfirmed finish entries with (unconfirmed)', () => {
  const history: HistoryEntry[] = [
    { type: 'user_goal', turn: 1, prompt: 'Search specifications', timestamp: '2026-01-01', isNewRun: true },
    { type: 'finish', answer: 'The laptop has 32GB RAM.', unconfirmed: true },
  ];

  const summary = previousTurnsSummary(history);
  assert.equal(summary.length, 1);
  assert.equal(
    summary[0],
    '- Asked: "Search specifications"\n  Result (unconfirmed): The laptop has 32GB RAM.'
  );
});

test('previousTurns: tags partial_result entries with (did not finish - partial)', () => {
  const history: HistoryEntry[] = [
    { type: 'user_goal', turn: 1, prompt: 'Compare all shops', timestamp: '2026-01-01', isNewRun: true },
    {
      type: 'partial_result',
      answer: 'Found prices on shop A and B, but shop C was blocked.',
      table: null,
      reason: 'partial',
    },
  ];

  const summary = previousTurnsSummary(history);
  assert.equal(summary.length, 1);
  assert.equal(
    summary[0],
    '- Asked: "Compare all shops"\n  Result (did not finish - partial): Found prices on shop A and B, but shop C was blocked.'
  );
});

test('previousTurns: tags audit verdicts when verdict is unverified or partial', () => {
  const history: any[] = [
    { type: 'user_goal', turn: 1, prompt: 'Check shipping cost', timestamp: '2026-01-01', isNewRun: true },
    {
      type: 'finish',
      answer: 'Free shipping on orders over 50 EUR.',
      audit: { verdict: 'unverified' },
    },
    { type: 'user_goal', turn: 2, prompt: 'Check express delivery', timestamp: '2026-01-01', isNewRun: true },
    {
      type: 'finish',
      answer: 'Express takes 1 day.',
      audit: { verdict: 'partial' },
    },
    { type: 'user_goal', turn: 3, prompt: 'Check standard delivery', timestamp: '2026-01-01', isNewRun: true },
    {
      type: 'finish',
      answer: 'Standard takes 3 days.',
      audit: { verdict: 'verified' },
    },
  ];

  const summary = previousTurnsSummary(history);
  assert.equal(summary.length, 3);
  assert.ok(
    summary[0].includes('Result (unverified: not everything in it was checked against pages that were read):')
  );
  assert.ok(
    summary[1].includes('Result (partial: not everything in it was checked against pages that were read):')
  );
  // Verified should have no audit verdict caveat tag
  assert.equal(summary[2], '- Asked: "Check standard delivery"\n  Result: Standard takes 3 days.');
});

test('previousTurns: currentTurnHistory isolates steps since the latest user_goal', () => {
  const history: HistoryEntry[] = [
    { type: 'user_goal', turn: 1, prompt: 'Task 1', timestamp: '2026-01-01', isNewRun: true },
    { type: 'execution_result', step: 1, success: true },
    { type: 'finish', answer: 'Task 1 done' },
    { type: 'user_goal', turn: 2, prompt: 'Task 2', timestamp: '2026-01-01', isNewRun: true },
    { type: 'execution_result', step: 1, success: true },
  ];

  const turn2 = currentTurnHistory(history);
  assert.equal(turn2.length, 2);
  assert.equal(turn2[0].type, 'user_goal');
  assert.equal((turn2[0] as any).prompt, 'Task 2');
  assert.equal(turn2[1].type, 'execution_result');
});

test('previousTurns: lastCompletedTurn extracts the last finished goal and answer', () => {
  const history: HistoryEntry[] = [
    { type: 'user_goal', turn: 1, prompt: 'Find Framework 16 price', timestamp: '2026-01-01', isNewRun: true },
    { type: 'finish', answer: 'Price is 1.599 EUR.' },
  ];

  const last = lastCompletedTurn(history);
  assert.deepEqual(last, {
    goal: 'Find Framework 16 price',
    answer: 'Price is 1.599 EUR.',
  });

  const empty = lastCompletedTurn([]);
  assert.equal(empty, null);
});
