/**
 * A pause with no card behind it used to show only a Resume button, which reads as "the agent stopped by itself".
 * pauseReasonText says why, in one line, for exactly the pauses that draw no card of their own.
 *
 * sidepanel.js is a browser module that touches window and document once at load, so the same small stub as
 * tests/sidepanelAudit.test.js is enough to import its pure helpers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { addEventListener() {} };
globalThis.document = { readyState: 'loading', addEventListener() {}, getElementById() { return null; } };

const { pauseReasonText } = await import('../../sidepanel/sidepanel.js');

test('each pause reason has its own line', () => {
  assert.match(pauseReasonText({ status: 'paused', pauseReason: 'user' }), /^Paused by you\./);
  assert.match(pauseReasonText({ status: 'paused', pauseReason: 'llm_failure' }), /model request failed/);
  assert.match(pauseReasonText({ status: 'paused', pauseReason: 'worker_restart' }), /extension restarted/);
});

test('an unknown or missing reason is said honestly, not made up', () => {
  assert.equal(pauseReasonText({ status: 'paused', pauseReason: null }), 'Paused. Press Resume to continue.');
  assert.equal(pauseReasonText({ status: 'paused' }), 'Paused. Press Resume to continue.');
  assert.equal(pauseReasonText({ status: 'paused', pauseReason: 'something_new' }), 'Paused. Press Resume to continue.');
});

test('nothing for a run that is not paused', () => {
  for (const status of ['idle', 'running', 'stopped', 'error']) {
    assert.equal(pauseReasonText({ status, pauseReason: 'user' }), '', status);
  }
  assert.equal(pauseReasonText(undefined), '');
  assert.equal(pauseReasonText(null), '');
});

test('nothing for a pause that draws its own card (question, confirmation, challenge, budget)', () => {
  for (const hold of ['pendingQuestion', 'pendingConfirm', 'pendingChallengeHelp', 'pendingContinueBudget']) {
    assert.equal(pauseReasonText({ status: 'paused', pauseReason: 'user', [hold]: { any: 'card' } }), '', hold);
  }
  // A plan hold has no card in the product, so it does not count as one.
  assert.match(pauseReasonText({ status: 'paused', pauseReason: 'worker_restart', pendingApproval: { kind: 'approve_plan' } }), /extension restarted/);
});
