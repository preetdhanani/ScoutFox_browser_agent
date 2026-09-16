/**
 * Regression tests for doBrowserBatch()'s success/error reporting.
 *
 * `const ok = completed > 0 && abortedAt === null` misreported the WHOLE batch as a failure
 * whenever stopOnError:false was set and any step failed: abortedAt is set on the first
 * failure and never cleared, so a batch where steps 2-5 all succeeded after step 1 failed still
 * came back success:false - and with no top-level message/error field at all, the model's next-
 * turn feedback (`Action Executed Successfully: ${message}` / `Action Failed: ${error}`) showed
 * it literally the word "undefined".
 *
 * content/actionExecutor.js is a browser IIFE with no exports, loaded here via new Function
 * against a minimal fake DOM - the same technique used in
 * tests/actionExecutorClickDoesNotDoubleFire.test.js, extended to resolve MULTIPLE element ids
 * so a batch can mix succeeding and failing steps.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const SRC = fs.readFileSync(new URL('../content/actionExecutor.js', import.meta.url), 'utf8');

/** @param {Record<number, object|null>} elementsById - id -> fake clickable element, or null to make that id unresolvable */
function loadActionExecutor(elementsById) {
  const fakeWindow = {
    domCompressor: { getElement: (id) => elementsById[id] || null },
    location: { href: 'https://example.com' },
    scrollY: 0
  };
  const fakeDocument = {
    contains: (node) => Object.values(elementsById).includes(node),
    getElementById: () => null,
    querySelector: () => null,
    createElement: () => ({ style: {}, appendChild() {}, remove() {} }),
    body: { appendChild() {}, contains: () => false }
  };
  class FakeMouseEvent { constructor(type) { this.type = type; } }
  for (const el of Object.values(elementsById)) {
    if (!el) continue;
    el.dispatchEvent = () => {};
    el.scrollIntoView = () => {};
    el.style = {};
    el.getBoundingClientRect = () => ({ top: 0, bottom: 10, left: 0, right: 10 });
  }
  const fn = new Function('window', 'document', 'MouseEvent', `${SRC}\nreturn window.actionExecutorInstance;`);
  return fn(fakeWindow, fakeDocument, FakeMouseEvent);
}

test('a batch where every step succeeds reports success with a real message', async () => {
  const instance = loadActionExecutor({ 1: { click() {}, tagName: 'BUTTON' }, 2: { click() {}, tagName: 'BUTTON' } });
  const res = await instance.doBrowserBatch([{ action: 'click', element_id: 1 }, { action: 'click', element_id: 2 }], true);

  assert.equal(res.success, true);
  assert.equal(res.completed, 2);
  assert.match(res.message, /2\/2/);
  assert.equal(res.error, undefined);
});

test('stopOnError:false with steps that later succeed no longer reports the whole batch as failed', async () => {
  // Step 0 (id 1) is unresolvable and fails; steps 1-3 (ids 2,3,4) all succeed.
  const instance = loadActionExecutor({
    1: null,
    2: { click() {}, tagName: 'BUTTON' },
    3: { click() {}, tagName: 'BUTTON' },
    4: { click() {}, tagName: 'BUTTON' }
  });
  const res = await instance.doBrowserBatch(
    [{ action: 'click', element_id: 1 }, { action: 'click', element_id: 2 }, { action: 'click', element_id: 3 }, { action: 'click', element_id: 4 }],
    false
  );

  assert.equal(res.completed, 3, 'the 3 resolvable steps must still have run');
  assert.equal(res.success, false, 'one real failure among the four must still be reported as a failure');
  assert.match(res.error, /First failure/);
  assert.match(res.error, /no longer resolvable/i);
});

test('stopOnError:false where every step succeeds reports success, not the old completed>0-but-abortedAt-stuck bug', async () => {
  const instance = loadActionExecutor({ 1: { click() {}, tagName: 'BUTTON' }, 2: { click() {}, tagName: 'BUTTON' } });
  const res = await instance.doBrowserBatch([{ action: 'click', element_id: 1 }, { action: 'click', element_id: 2 }], false);

  assert.equal(res.success, true);
  assert.equal(res.abortedAt, null);
});

test('stopOnError:true breaks on the first failure and reports it, not a silent success', async () => {
  const instance = loadActionExecutor({ 1: { click() {}, tagName: 'BUTTON' }, 2: null, 3: { click() {}, tagName: 'BUTTON' } });
  const res = await instance.doBrowserBatch(
    [{ action: 'click', element_id: 1 }, { action: 'click', element_id: 2 }, { action: 'click', element_id: 3 }],
    true
  );

  assert.equal(res.success, false);
  assert.equal(res.completed, 1, 'must stop at the failure, never reaching step 3');
  assert.equal(res.abortedAt, 1);
});
