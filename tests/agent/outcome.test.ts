/**
 * Unit tests for agent/outcome.ts in isolation. See tests/agentEngineOutcomeHonesty.test.js
 * for the wired-in behaviour (runLoopBody actually using these, and what the panel does with
 * the result).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFinishEntry, buildMaxStepsEntry, coerceAnswerText, NO_ANSWER_GIVEN } from '../../src/background/agent/outcome.ts';

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

test('an answer that is a list or an object is stored as the text the panel shows, not as "[object Object]" or as a list', () => {
  assert.equal(buildFinishEntry({ action: 'finish', answer: ['| a | b |', '| 1 | 2 |'] }).answer, '| a | b |\n| 1 | 2 |');
  assert.equal(buildFinishEntry({ action: 'finish', answer: { price: 'EUR 5' } }).answer, '{\n  "price": "EUR 5"\n}');
  assert.equal(buildFinishEntry({ action: 'finish', answer: 42 }).answer, '42');
  assert.equal(buildFinishEntry({ action: 'finish', answer: [] }).answer, NO_ANSWER_GIVEN, 'an empty list is no answer');
  assert.equal(buildFinishEntry({ action: 'finish', answer: null }).answer, NO_ANSWER_GIVEN);
});

test('coerceAnswerText never throws, also for a value that cannot be turned into text', () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.equal(coerceAnswerText(circular), '');
  assert.equal(coerceAnswerText([['a', 'b'], { c: 1 }, null]), 'a\nb\n{\n  "c": 1\n}\n');
  assert.equal(coerceAnswerText({ toJSON() { throw new Error('boom'); } }), '');
  assert.equal(coerceAnswerText('text'), 'text');
  assert.equal(coerceAnswerText(undefined), '');
});

test('buildMaxStepsEntry says so when the answer that was sent back is shown above it', () => {
  const plain = buildMaxStepsEntry(10);
  const kept = buildMaxStepsEntry(10, { answerKept: true });
  assert.equal(kept.type, 'error');
  assert.match(kept.content, /maximum allowed steps \(10\)/);
  assert.match(kept.content, /shown above/);
  assert.notEqual(kept.content, plain.content);
  assert.match(plain.content, /^Stopped without finishing/);
});
