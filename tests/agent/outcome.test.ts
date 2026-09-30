/**
 * Unit tests for agent/outcome.ts in isolation. See tests/agentEngineOutcomeHonesty.test.js
 * for the wired-in behaviour (runLoopBody actually using these, and what the panel does with
 * the result).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFinishEntry, buildMaxStepsEntry, NO_ANSWER_GIVEN } from '../../src/background/agent/outcome.ts';

test('buildFinishEntry keeps a real answer as-is', () => {
  const entry = buildFinishEntry({ action: 'finish', answer: 'Found the price: $120.' });
  assert.equal(entry.type, 'finish');
  assert.equal(entry.answer, 'Found the price: $120.');
  assert.equal(entry.unconfirmed, undefined, 'a real answer must not be flagged unconfirmed');
});

test('buildFinishEntry reports honestly when the model gave no answer, instead of inventing one', () => {
  const entry = buildFinishEntry({ action: 'finish' });
  assert.equal(entry.answer, NO_ANSWER_GIVEN);
  assert.notEqual(entry.answer, 'Task completed successfully.',
    'must not claim success the model never reported');
});

test('buildFinishEntry flags an auto-wrapped freeform answer as unconfirmed', () => {
  const entry = buildFinishEntry({ action: 'finish', answer: 'I am not sure how to proceed.', autoWrapped: true });
  assert.equal(entry.unconfirmed, true);
  assert.equal(entry.answer, 'I am not sure how to proceed.', 'the text itself is preserved either way');
});

test('buildMaxStepsEntry is an error, never a finish', () => {
  const entry = buildMaxStepsEntry(25);
  assert.equal(entry.type, 'error', 'an unfinished run must never look like a finished one');
  assert.match(entry.content, /25/);
  assert.match(entry.content, /without finishing|did not finish|maximum/i);
});
