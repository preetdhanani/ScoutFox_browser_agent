/**
 * Regression tests for the stable-locator fallback chain in ActionExecutor.resolveElement().
 *
 * The chain was designed as 4 tiers - live reference, then #id/data-testid/name, then cssPath,
 * then tag+text - but tiers 2-4 have never actually run: resolveElement() reads
 * `compressor.elements` (content/actionExecutor.js), and DOMCompressor.getSnapshot() built that
 * exact array locally and returned it without ever assigning it to `this.elements`
 * (content/domCompressor.js). So `compressor.elements` was always undefined, `locator` always
 * null, and every element whose live reference went stale (removed and re-inserted, replaced by
 * a re-render) failed with "no longer resolvable" instead of being re-found.
 *
 * content/actionExecutor.js is a browser IIFE with no exports, loaded here via new Function
 * against a minimal fake DOM - the same technique used throughout this suite for content
 * scripts (see actionExecutorClickDoesNotDoubleFire.test.js).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const SRC = fs.readFileSync(new URL('../content/actionExecutor.js', import.meta.url), 'utf8');

/**
 * @param {object} domCompressorShape - what window.domCompressor looks like: getElement()
 *   (the live-reference tier) and elements (the fallback-locator cache this fix restores).
 * @param {object} documentOverrides - getElementById/querySelector/querySelectorAll for the
 *   specific fallback tier under test; everything else returns null/empty by default.
 */
function loadActionExecutor(domCompressorShape, documentOverrides = {}) {
  const fakeWindow = { domCompressor: domCompressorShape, scrollY: 0 };
  const fakeDocument = {
    contains: () => false, // every scenario here is "the live reference is gone"
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ style: {}, appendChild() {}, remove() {} }),
    body: { appendChild() {}, contains: () => false },
    ...documentOverrides
  };
  const fakeCSS = { escape: (s) => s };
  const fn = new Function('window', 'document', 'CSS', `${SRC}\nreturn window.actionExecutorInstance;`);
  return fn(fakeWindow, fakeDocument, fakeCSS);
}

test('a stale live reference with no elements cache resolves to nothing (pre-fix behaviour, still correct on its own)', () => {
  const instance = loadActionExecutor({ getElement: () => null, elements: undefined });
  assert.equal(instance.resolveElement(1), null);
});

test('tier 2: re-resolves a stale element by its stable #id', () => {
  const movedEl = { id: 'search-box' };
  const instance = loadActionExecutor(
    { getElement: () => null, elements: [{ id: 1, locator: { tag: 'input', text: 'Search', attrs: { id: 'search-box' }, cssPath: '' } }] },
    { getElementById: (id) => (id === 'search-box' ? movedEl : null), contains: (n) => n === movedEl }
  );
  assert.equal(instance.resolveElement(1), movedEl, 'must find the element by #id once the live reference is gone');
});

test('tier 2: falls back to data-testid, then name, when id is absent', () => {
  const movedEl = {};
  const instance = loadActionExecutor(
    { getElement: () => null, elements: [{ id: 2, locator: { tag: 'button', text: 'Go', attrs: { id: '', 'data-testid': 'go-btn', name: '' }, cssPath: '' } }] },
    {
      querySelector: (sel) => (sel === '[data-testid="go-btn"]' ? movedEl : null),
      contains: (n) => n === movedEl
    }
  );
  assert.equal(instance.resolveElement(2), movedEl);
});

test('tier 3: re-resolves by CSS path when no stable attribute matches', () => {
  const movedEl = {};
  const instance = loadActionExecutor(
    { getElement: () => null, elements: [{ id: 3, locator: { tag: 'a', text: 'Docs', attrs: { id: '', 'data-testid': '', name: '' }, cssPath: 'nav > a:nth-of-type(2)' } }] },
    { querySelector: (sel) => (sel === 'nav > a:nth-of-type(2)' ? movedEl : null), contains: (n) => n === movedEl }
  );
  assert.equal(instance.resolveElement(3), movedEl);
});

test('tier 4: re-resolves by matching tag and visible text as a last resort', () => {
  const movedEl = { innerText: 'Submit' };
  const otherEl = { innerText: 'Cancel' };
  const instance = loadActionExecutor(
    { getElement: () => null, elements: [{ id: 4, locator: { tag: 'button', text: 'Submit', attrs: {}, cssPath: '' } }] },
    { querySelectorAll: (sel) => (sel === 'button' ? [otherEl, movedEl] : []) }
  );
  assert.equal(instance.resolveElement(4), movedEl, 'must match the element whose text equals the recorded label, not just any button');
});

test('a live reference still attached to the DOM is used directly, without touching the fallback tiers at all', () => {
  const liveEl = {};
  let queried = false;
  const instance = loadActionExecutor(
    { getElement: () => liveEl, elements: [{ id: 5, locator: { tag: 'button', text: 'x', attrs: {}, cssPath: '' } }] },
    { contains: (n) => n === liveEl, querySelector: () => { queried = true; return null; } }
  );
  assert.equal(instance.resolveElement(5), liveEl);
  assert.equal(queried, false, 'the fallback chain must not even be consulted when the live node is still valid');
});
