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
 * The executor is the TypeScript module (src/content/actionExecutor.ts, which builds the shipped
 * content/actionExecutor.js), run here against a minimal fake DOM.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ActionExecutor } from '../src/content/actionExecutor.ts';

/**
 * @param {object} domCompressorShape - what window.domCompressor looks like: getElement()
 *   (the live-reference tier) and elements (the fallback-locator cache this fix restores).
 * @param {object} documentOverrides - getElementById/querySelector/querySelectorAll for the
 *   specific fallback tier under test; everything else returns null/empty by default.
 */
function loadActionExecutor(domCompressorShape, documentOverrides = {}) {
  const fakeCSS = { escape: (s) => s };
  const fakeWindow = { domCompressor: domCompressorShape, scrollY: 0, CSS: fakeCSS };
  const fakeDocument = {
    contains: () => false, // every scenario here is "the live reference is gone"
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ style: {}, appendChild() {}, remove() {} }),
    body: { appendChild() {}, contains: () => false },
    ...documentOverrides
  };
  return new ActionExecutor(fakeDocument, fakeWindow);
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
      querySelectorAll: (sel) => (sel === '[data-testid="go-btn"]' ? [movedEl] : []),
      contains: (n) => n === movedEl
    }
  );
  assert.equal(instance.resolveElement(2), movedEl);
});

// cdp-synthetic-fallback: the cssPath tier took the FIRST match of an unanchored selector with no
// tag or text check, so after a re-render it could silently click a different element. It is gone.
test('the unanchored CSS path tier is gone: a cssPath match alone resolves to nothing', () => {
  const movedEl = {};
  const instance = loadActionExecutor(
    { getElement: () => null, elements: [{ id: 3, locator: { tag: 'a', text: 'Docs', attrs: { id: '', 'data-testid': '', name: '' }, cssPath: 'nav > a:nth-of-type(2)' } }] },
    { querySelector: (sel) => (sel === 'nav > a:nth-of-type(2)' ? movedEl : null), contains: (n) => n === movedEl }
  );
  assert.equal(instance.resolveElement(3), null, 'the css path could silently hit a different element, so it must not resolve');
});

// cdp-synthetic-fallback: the tag-plus-text tier took the first element of the same tag with the
// same label text, which could silently hit a different element (the first of several equal
// buttons). It is gone.
test('the same-tag same-text tier is gone: a tag and text match alone resolves to nothing', () => {
  const movedEl = { innerText: 'Submit' };
  const otherEl = { innerText: 'Cancel' };
  const instance = loadActionExecutor(
    { getElement: () => null, elements: [{ id: 4, locator: { tag: 'button', text: 'Submit', attrs: {}, cssPath: '' } }] },
    { querySelectorAll: (sel) => (sel === 'button' ? [otherEl, movedEl] : []) }
  );
  assert.equal(instance.resolveElement(4), null, 'the first of several equal buttons must never be clicked silently');
});

// cdp-synthetic-fallback: a stable attribute only counts when it matches exactly one element.
test('tier 2 needs a unique match: two elements with the same data-testid resolve to nothing', () => {
  const first = {};
  const second = {};
  const instance = loadActionExecutor(
    { getElement: () => null, elements: [{ id: 6, locator: { tag: 'button', text: 'Go', attrs: { id: '', 'data-testid': 'go-btn', name: '' }, cssPath: '' } }] },
    {
      querySelectorAll: (sel) => (sel === '[data-testid="go-btn"]' ? [first, second] : []),
      contains: (n) => n === first || n === second
    }
  );
  assert.equal(instance.resolveElement(6), null, 'an ambiguous data-testid could hit the wrong twin, so it must not resolve');
});

// cdp-synthetic-fallback: a tier 2 hit is a recovery of a re-rendered element and says so.
test('a tier 2 hit reports that the element was recovered by its stable attributes', () => {
  const movedEl = { id: 'search-box' };
  const instance = loadActionExecutor(
    { getElement: () => null, elements: [{ id: 1, locator: { tag: 'input', text: 'Search', attrs: { id: 'search-box' }, cssPath: '' } }] },
    { getElementById: (id) => (id === 'search-box' ? movedEl : null), contains: (n) => n === movedEl }
  );
  const detail = instance.resolveElementDetailed(1);
  assert.equal(detail.element, movedEl);
  assert.equal(detail.recoveredBy, 'stable-id');
});

test('the live reference tier is not a recovery', () => {
  const liveEl = {};
  const instance = loadActionExecutor(
    { getElement: () => liveEl, elements: [{ id: 5, locator: { tag: 'button', text: 'x', attrs: {}, cssPath: '' } }] },
    { contains: (n) => n === liveEl }
  );
  const detail = instance.resolveElementDetailed(5);
  assert.equal(detail.element, liveEl);
  assert.equal(detail.recoveredBy, undefined);
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
