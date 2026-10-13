/**
 * A reply that is one JSON object holding only an answer, `{"answer": "..."}`, has no "action" key. It used to reach
 * the prose guardrail, which took the whole raw text (braces, quotes, \n escapes) as the final answer: the card showed
 * JSON. These tests pin what is unwrapped and, as important, what is NOT (prose and data objects stay as they were).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModelReply } from '../../src/background/agent/parse.ts';
import { verbsFor } from '../../src/background/agent/actions.ts';
import { answerWrapperOf } from '../../src/background/agent/answerJson.ts';

/** What the worker passes for an answer site in browse mode: the browse verbs plus finish. */
const BROWSE_WITH_FINISH = [...verbsFor('browse', 'small'), 'finish'];
const ANSWER_MODE = verbsFor('answer', 'small');
const COLLECT_ONLY = verbsFor('browse', 'small'); // no finish: the reply may not end the run

function finishOf(text: string, verbs: string[] = ANSWER_MODE) {
  const result = parseModelReply(text, { verbs });
  assert.equal(result.action?.action, 'finish', `expected a finish for ${JSON.stringify(text)}, got ${JSON.stringify(result)}`);
  return result.action as Record<string, unknown>;
}

test('{"answer": "text"} becomes the finish answer, flagged as inferred', () => {
  const action = finishOf('{"answer": "Top repo today: debpalash / VoiceStudio (62,532 stars)."}');
  assert.equal(action.answer, 'Top repo today: debpalash / VoiceStudio (62,532 stars).');
  assert.equal(action.autoWrapped, true, 'the model never sent the finish action');
});

test('the same shape with pretty printing, a code fence and thinking tags in front', () => {
  const pretty = '{\n  "answer": "line one\\nline two"\n}';
  assert.equal(finishOf(pretty).answer, 'line one\nline two', 'the escaped newline is a real newline in the answer');
  assert.equal(finishOf('```json\n{"answer": "fenced"}\n```').answer, 'fenced');
  assert.equal(finishOf('```\n{"answer": "bare fence"}\n```').answer, 'bare fence');
  assert.equal(finishOf('<think>the page lists repos</think>{"answer": "after thinking"}').answer, 'after thinking');
});

test('final_answer and finalAnswer are answer keys too, and meta keys may sit beside the answer', () => {
  assert.equal(finishOf('{"final_answer": "a"}').answer, 'a');
  assert.equal(finishOf('{"finalAnswer": "b"}').answer, 'b');
  assert.equal(finishOf('{"thought": "I read the page", "answer": "c", "confidence": 0.9, "reason": "listed"}').answer, 'c');
});

test('a number or a boolean becomes its string', () => {
  assert.equal(finishOf('{"answer": 5}').answer, '5');
  assert.equal(finishOf('{"answer": true}').answer, 'true');
});

test('an array or an object value is passed on as it is, and the finish text is made by coerceAnswerText later', () => {
  assert.deepEqual(finishOf('{"answer": ["one", "two"]}').answer, ['one', 'two']);
  assert.deepEqual(finishOf('{"answer": {"repo": "a", "stars": "1"}}').answer, { repo: 'a', stars: '1' });
});

test('an empty answer (null, empty string, empty array) is an EMPTY finish, never the JSON text', () => {
  for (const text of ['{"answer": null}', '{"answer": ""}', '{"answer": []}']) {
    const action = finishOf(text);
    assert.ok(action.answer === '' || (Array.isArray(action.answer) && action.answer.length === 0), `${text} -> ${JSON.stringify(action.answer)}`);
    assert.notEqual(action.answer, text, 'the raw reply is not the answer');
  }
});

test('not a wrapper: data keys, text around the object, two objects, a cut-off object', () => {
  const prose = (text: string) => {
    const action = finishOf(text);
    assert.equal(action.answer, text, `${JSON.stringify(text)} is prose and keeps its text`);
    assert.equal(action.autoWrapped, true);
  };
  prose('{"answer": "a", "sources": ["https://example.com"]}'); // a second data key
  prose('{"name": "Framework", "input": "laptop"}'); // no answer key
  prose('Here is the result: {"answer": "inside prose"}'); // text before
  prose('{"answer": "first"} and then {"answer": "second"}'); // two objects
  const cut = parseModelReply('{"answer": "this one is cut of', { verbs: ANSWER_MODE });
  assert.equal(cut.action, undefined, 'a truncated JSON object is a parse error, never an answer');
  assert.equal(cut.kind, 'malformed');
});

test('where the reply may not end the run (no finish in the verbs) the old rejection stays', () => {
  const result = parseModelReply('{"answer": "text"}', { verbs: COLLECT_ONLY });
  assert.equal(result.action, undefined);
  assert.equal(result.kind, 'not_an_action');
});

test('an answer that reads like an instruction is still an answer, not a navigation', () => {
  // intentAction() would turn "Go to https://..." into a navigate when the verbs offer it.
  const action = finishOf('{"answer": "Go to https://github.com/trending to see them."}', BROWSE_WITH_FINISH);
  assert.equal(action.action, 'finish');
  assert.equal(action.answer, 'Go to https://github.com/trending to see them.');
});

test('a real action with an answer in it is untouched', () => {
  const result = parseModelReply('{"action": "finish", "answer": "done"}', { verbs: ANSWER_MODE });
  assert.deepEqual(result.action, { action: 'finish', answer: 'done' });
});

test('answerWrapperOf reads only what it is meant to', () => {
  assert.deepEqual(answerWrapperOf('{"answer": "x"}'), { answer: 'x' });
  assert.equal(answerWrapperOf('plain prose'), null);
  assert.equal(answerWrapperOf(''), null);
  assert.equal(answerWrapperOf('[{"answer": "x"}]'), null, 'an array is not a wrapper');
  assert.equal(answerWrapperOf('{"answer": "x", "answer2": "y"}'), null);
  assert.equal(answerWrapperOf('{"answer": "x", "final_answer": "y"}'), null, 'two answer keys: unclear, so prose');
});

test('linear time on hostile input', () => {
  const started = performance.now();
  parseModelReply(`{"answer": "${'x'.repeat(1_000_000)}"}`, { verbs: ANSWER_MODE });
  parseModelReply(`${'{"answer":"a"}'.repeat(50_000)}`, { verbs: ANSWER_MODE });
  parseModelReply('{"answer": ' + '['.repeat(100_000) + ']'.repeat(100_000) + '}', { verbs: ANSWER_MODE });
  // A fence followed by a long run of white space: a regex for "one code fence" is quadratic on it (it hung a test run).
  parseModelReply('```' + ' '.repeat(1_000_000) + 'x', { verbs: ANSWER_MODE });
  parseModelReply('```' + ' \n'.repeat(500_000) + '```', { verbs: ANSWER_MODE });
  parseModelReply('```json' + ' '.repeat(1_000_000) + '```', { verbs: ANSWER_MODE });
  assert.ok(performance.now() - started < 3000, 'six hostile replies parse in under three seconds');
});
