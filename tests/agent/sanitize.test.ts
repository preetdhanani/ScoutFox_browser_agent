/**
 * src/background/agent/sanitize.ts: verb aliases, the verb check, and the one element id check that
 * a single action and every browser_batch step go through.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ACTION_VERBS, verbsFor } from '../../src/background/agent/actions.ts';
import { checkElementId, maxRef, refsFromCount, sanitizeAction } from '../../src/background/agent/sanitize.ts';

const options = { verbs: ACTION_VERBS, refs: refsFromCount(10) };

test('refsFromCount: 1..N, and nothing for 0', () => {
  assert.deepEqual([...refsFromCount(4)], [1, 2, 3, 4]);
  assert.equal(refsFromCount(0).size, 0);
  assert.equal(maxRef(refsFromCount(7)), 7);
  assert.equal(maxRef(new Set([3, 12, 7])), 12);
  assert.equal(maxRef(undefined), 0);
});

test('checkElementId: whole numbers of 1 or more that are on the page', () => {
  const refs = new Set([3, 7, 12]);
  assert.deepEqual(checkElementId(7, refs), { ok: true, id: 7 });
  assert.deepEqual(checkElementId('7', refs), { ok: true, id: 7 });
  assert.deepEqual(checkElementId(' 7 ', refs), { ok: true, id: 7 }, 'blanks around the digits are fine');
  assert.deepEqual(checkElementId('07', refs), { ok: true, id: 7 });
  assert.deepEqual(checkElementId(7.0, refs), { ok: true, id: 7 }, 'JSON has no difference between 7 and 7.0');
  for (const bad of [5, 0, -3, 13, 'abc', null, undefined, {}, [], true, NaN, Infinity, '']) {
    assert.deepEqual(checkElementId(bad, refs), { ok: false }, String(JSON.stringify(bad)));
  }
});

test('checkElementId: an id is read whole, never loosely (parseInt turned each of these into a different real id)', () => {
  const refs = new Set([1, 3, 7, 12]);
  for (const bad of [3.9, 7.5, '7abc', '12abc', '1e3', '1e1', '3.9', '3.0', '0x7', '+7', '-7', '[7]', '#7', '7px', '7 8', '7,8', 7n, '９', 1e21, '99999999999999999999']) {
    assert.deepEqual(checkElementId(bad, refs), { ok: false }, String(bad));
    assert.deepEqual(checkElementId(bad), { ok: false }, `${String(bad)} with no list`);
  }
});

test('checkElementId: with no list, any whole number of 1 or more is fine', () => {
  assert.deepEqual(checkElementId(5000), { ok: true, id: 5000 });
  assert.deepEqual(checkElementId(0), { ok: false });
  assert.deepEqual(checkElementId('x'), { ok: false });
});

test('an id is never clamped onto another element', () => {
  const act = sanitizeAction({ action: 'click', element_id: 99 }, options);
  assert.equal(act.invalidElementId, '99');
  assert.equal(act.element_id, 99, 'the id is left as the model wrote it, not replaced by the last valid one');
});

test('the {"click": N} and {"type": ...} shapes, and element_id from the other key names', () => {
  assert.deepEqual(sanitizeAction({ click: 4 }, options), { click: 4, action: 'click', element_id: 4 });
  assert.equal(sanitizeAction({ type: 'hello', element_id: 2 }, options).action, 'type');
  assert.equal(sanitizeAction({ action: 'click', element: '3' }, options).element_id, 3);
  assert.equal(sanitizeAction({ action: 'click', id: 3 }, options).element_id, 3);
  assert.equal(sanitizeAction({ action: 'click', elementId: '3' }, options).element_id, 3);
  assert.equal(sanitizeAction({ action: 'click', ref: 3 }, options).element_id, 3, 'ref is the last of the names');
  assert.equal(sanitizeAction({ action: 'click', ref: 3, id: 4 }, options).element_id, 4, 'and every other name wins over it');
  assert.equal(sanitizeAction({ action: 'click', ref: 99 }, options).invalidElementId, '99', 'a ref is checked like any id');
  assert.equal(sanitizeAction({ action: 'click', element_id: 2, element: 9 }, options).element_id, 2, 'element_id wins');
});

test('the input object is not changed', () => {
  const input = { action: 'batch', steps: [{ action: 'click', element_id: '2' }] };
  const snapshot = JSON.parse(JSON.stringify(input));
  const act = sanitizeAction(input, options);
  assert.deepEqual(input, snapshot);
  assert.notEqual(act.steps, input.steps);
  assert.deepEqual(act.steps, [{ action: 'click', element_id: 2 }]);
});

test('a verb that is not in the mode is unavailable, and one that is nowhere is invalid', () => {
  const small = { verbs: verbsFor('browse', 'small'), refs: refsFromCount(10) };
  const unavailable = sanitizeAction({ action: 'run_js', code: 'x' }, small);
  assert.equal(unavailable.unavailableAction, 'execute_js');
  assert.ok(!('invalidAction' in unavailable));
  assert.equal(unavailable.action, 'execute_js', 'the alias is resolved first');

  const invalid = sanitizeAction({ action: 'fly' }, small);
  assert.equal(invalid.invalidAction, 'fly');
  assert.ok(!('unavailableAction' in invalid));
});

test('browser_batch: every step id is checked and written back as a number', () => {
  const ok = sanitizeAction({ action: 'browser_batch', steps: [{ action: 'click', element_id: '3' }, { action: 'type', index: '4', text: 'x' }, { action: 'click', elementId: 5 }, { action: 'click', element: '6' }] }, options);
  assert.equal(ok.invalidStepElementId, undefined);
  assert.deepEqual(ok.steps, [{ action: 'click', element_id: 3 }, { action: 'type', index: 4, text: 'x' }, { action: 'click', elementId: 5 }, { action: 'click', element: 6 }]);
});

test('browser_batch: the first bad id is reported as the model wrote it', () => {
  assert.equal(sanitizeAction({ action: 'browser_batch', steps: [{ action: 'click', element_id: 2 }, { action: 'click', element_id: 99 }, { action: 'click', element_id: 98 }] }, options).invalidStepElementId, 99);
  assert.equal(sanitizeAction({ action: 'browser_batch', steps: [{ action: 'click', element_id: 'abc' }] }, options).invalidStepElementId, 'abc');
  assert.equal(sanitizeAction({ action: 'browser_batch', steps: [{ click: 99 }] }, options).invalidStepElementId, 99);
  assert.equal(sanitizeAction({ action: 'browser_batch', steps: [{ action: 'click', element_id: null }] }, options).invalidStepElementId, null);
});

test('browser_batch: steps with no id, odd steps and a missing steps array are left alone', () => {
  const steps = [{ action: 'scroll', direction: 'down' }, { action: 'wait', amount: 1 }, 'not an object', null, 7, ['x']];
  const act = sanitizeAction({ action: 'browser_batch', steps }, options);
  assert.equal(act.invalidStepElementId, undefined);
  assert.deepEqual(act.steps, steps);
  assert.equal(sanitizeAction({ action: 'browser_batch' }, options).invalidStepElementId, undefined);
  assert.equal(sanitizeAction({ action: 'browser_batch', steps: 'click 99' }, options).invalidStepElementId, undefined);
});

test('browser_batch: a step that says click as an alias key still has its id checked, an id key of a non-batch action does not', () => {
  assert.equal(sanitizeAction({ action: 'browser_batch', steps: [{ click: 3 }] }, options).invalidStepElementId, undefined);
  assert.equal(sanitizeAction({ action: 'scroll', steps: [{ action: 'click', element_id: 99 }] }, options).invalidStepElementId, undefined, 'only a browser_batch has steps that run');
});

test('browser_batch: ids are members of the list, not a range', () => {
  const refs = new Set([3, 7, 12]);
  const step = (id: number) => sanitizeAction({ action: 'browser_batch', steps: [{ action: 'click', element_id: id }] }, { verbs: ACTION_VERBS, refs });
  assert.equal(step(7).invalidStepElementId, undefined);
  assert.equal(step(5).invalidStepElementId, 5);
  assert.equal(step(13).invalidStepElementId, 13);
});

test('the single-action check and the batch check agree on every value', () => {
  const refs = new Set([3, 7, 12]);
  for (const value of [3, 7, 12, 5, 0, -1, '7', '7x', 'x', null, {}, [], true, 1e9]) {
    const single = sanitizeAction({ action: 'click', element_id: value }, { verbs: ACTION_VERBS, refs });
    const inBatch = sanitizeAction({ action: 'browser_batch', steps: [{ action: 'click', element_id: value }] }, { verbs: ACTION_VERBS, refs });
    const singleBad = single.invalidElementId !== undefined;
    const batchBad = inBatch.invalidStepElementId !== undefined;
    assert.equal(singleBad, batchBad, `value ${JSON.stringify(value)}`);
  }
});

test('rejections are reported to the log sink', () => {
  const lines: string[] = [];
  const log = (level: string, message: string) => lines.push(`${level}: ${message}`);
  sanitizeAction({ action: 'click', element_id: 99 }, { ...options, log });
  sanitizeAction({ action: 'browser_batch', steps: [{ action: 'click', element_id: 98 }] }, { ...options, log });
  sanitizeAction({ action: 'execute_js' }, { verbs: verbsFor('browse', 'small'), log });
  assert.equal(lines.length, 3);
  assert.match(lines[0], /\(99, valid range 1-10\)/);
  assert.match(lines[1], /browser_batch step selected an element id that is not on the page \(98\)/);
  assert.match(lines[2], /"execute_js", which is not available here/);
});
