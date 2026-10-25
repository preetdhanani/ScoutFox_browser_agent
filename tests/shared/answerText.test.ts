/**
 * The answer text: src/shared/answerText.ts.
 *
 * A model sometimes answers with a JSON object instead of prose. Rendered as it is, the user
 * reads a wall of braces where they expected a sentence. This module pulls the readable part
 * out of such an answer.
 *
 * The rule that matters most is the one that is easiest to break: an answer that is NOT JSON is
 * never touched. Prose that happens to contain a brace, or a number, or a word that looks like
 * a key, must come out exactly as the model wrote it. A module that "cleans up" too much
 * silently rewrites what the model said, and the user cannot tell.
 *
 * What these tests hold on to:
 *   1. Prose is never changed.
 *   2. A JSON answer comes back as its summary, and its evidence apart from it.
 *   3. The wrapper the model puts around the answer ({"subgoal_done": {...}}) is unwrapped.
 *   4. A JSON object with no known field is pretty-printed, not dropped.
 *   5. Broken JSON is shown as it is, not swallowed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractReadableAnswer,
  looksLikeJsonObject
} from '../../src/shared/answerText.ts';

test('a plain answer comes back exactly as it was written', () => {
  const answer = 'The price is 1.399,00 EUR and delivery takes 5-7 working days.';
  const result = extractReadableAnswer(answer);

  assert.equal(result.text, answer, 'not one character is changed');
  assert.equal(result.evidence, '', 'and there is no evidence');
  assert.equal(result.wasJson, false);
});

test('prose that contains a brace is not touched', () => {
  // The page shows a formula with braces. That is prose, not JSON, and it must survive.
  const answer = 'The selector matches {name: "Framework"} exactly.';
  const result = extractReadableAnswer(answer);

  assert.equal(result.text, answer);
  assert.equal(result.wasJson, false);
});

test('a JSON answer comes back as its summary', () => {
  const raw = JSON.stringify({ summary: 'The laptop costs 1.399,00 EUR.' });
  const result = extractReadableAnswer(raw);

  assert.equal(result.text, 'The laptop costs 1.399,00 EUR.');
  assert.equal(result.wasJson, true);
});

test('the evidence of a JSON answer is kept apart from the answer', () => {
  const raw = JSON.stringify({
    summary: 'The cheapest shop is NotebookWelt.',
    evidence: "The table shows 1.388,90 EUR plus 10,10 EUR shipping."
  });
  const result = extractReadableAnswer(raw);

  assert.equal(result.text, 'The cheapest shop is NotebookWelt.', 'the answer is the summary');
  assert.equal(result.evidence, 'The table shows 1.388,90 EUR plus 10,10 EUR shipping.');
});

test('the wrapper the model puts around the answer is unwrapped', () => {
  // This is the exact shape the panel showed as raw JSON before the extraction existed.
  const raw = JSON.stringify({
    subgoal_done: {
      summary: 'DeepSeek-V4.1-Flash-1017 is NOT listed in the free model catalog.',
      evidence: "The catalog shows two free models: DeepSeek-V4.1-Flash-1017 and glm-5-3."
    }
  });
  const result = extractReadableAnswer(raw);

  assert.equal(result.text, 'DeepSeek-V4.1-Flash-1017 is NOT listed in the free model catalog.');
  assert.equal(result.evidence, "The catalog shows two free models: DeepSeek-V4.1-Flash-1017 and glm-5-3.");
  assert.equal(result.wasJson, true);
});

test('a wrapper around a wrapper is unwrapped too', () => {
  const raw = JSON.stringify({ outer: { inner: { summary: 'The answer.' } } });
  const result = extractReadableAnswer(raw);

  assert.equal(result.text, 'The answer.');
});

test('a wrapper that holds more than one key is not unwrapped', () => {
  // Two things in the wrapper: picking one would throw the other away.
  const raw = JSON.stringify({
    subgoal_done: { summary: 'The first part.' },
    other_thing: { summary: 'The second part.' }
  });
  const result = extractReadableAnswer(raw);

  assert.equal(result.wasJson, true);
  assert.match(result.text, /The first part\./, 'the first summary is there');
  assert.match(result.text, /The second part\./, 'and so is the second one');
});

test('a JSON object with no known field is pretty-printed, not dropped', () => {
  const raw = JSON.stringify({ alpha: 1, beta: 'two' });
  const result = extractReadableAnswer(raw);

  assert.equal(result.wasJson, true);
  assert.match(result.text, /"alpha": 1/, 'the content is there');
  assert.match(result.text, /"beta": "two"/);
  assert.match(result.text, /\n/, 'and it is pretty-printed, so it can be read');
});

test('broken JSON is shown as it is, not swallowed', () => {
  // A model that ran out of tokens writes half an object. Showing the half is better than
  // showing nothing at all.
  const raw = '{"summary": "The answer is';
  const result = extractReadableAnswer(raw);

  assert.equal(result.text, raw, 'the text is kept as it is');
  assert.equal(result.wasJson, false, 'and it is not treated as a structured answer');
});

test('a summary that is a list of strings is read as its lines', () => {
  const raw = JSON.stringify({ summary: ['First point.', 'Second point.'] });
  const result = extractReadableAnswer(raw);

  assert.equal(result.text, 'First point.\nSecond point.');
});

test('an empty summary falls through to the next field', () => {
  const raw = JSON.stringify({ summary: '   ', answer: 'The real answer.' });
  const result = extractReadableAnswer(raw);

  assert.equal(result.text, 'The real answer.');
});

test('a JSON array is not an answer object and is left alone', () => {
  const raw = '["one", "two"]';
  const result = extractReadableAnswer(raw);

  assert.equal(result.text, raw);
  assert.equal(result.wasJson, false);
});

test('an empty answer stays empty', () => {
  const result = extractReadableAnswer('');
  assert.equal(result.text, '');
  assert.equal(result.wasJson, false);
});

test('the JSON check needs both a brace at the start and one at the end', () => {
  assert.equal(looksLikeJsonObject('{"a": 1}'), true);
  assert.equal(looksLikeJsonObject('{"a": 1'), false, 'a truncated object is not one');
  assert.equal(looksLikeJsonObject('a {"b": 2} c'), false, 'prose around it is not JSON');
  assert.equal(looksLikeJsonObject(''), false);
});

test('a very long answer is cut short with a mark', () => {
  const long = 'x'.repeat(5000);
  const raw = JSON.stringify({ summary: long });
  const result = extractReadableAnswer(raw);

  assert.ok(result.text.length < 5000, 'the answer is shorter than it was');
  assert.match(result.text, /…$/, 'and the cut is marked');
});
