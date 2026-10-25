/**
 * The element reference map: src/content/refMap.ts.
 *
 * The map is how the content script turns the element ids the model saw ("[3]") back into the
 * elements on the page. Two things can go wrong, and both are quiet: the document can have
 * navigated (every id in the map now points into a document that is gone), and the element can
 * have been removed from the page while the map still holds it.
 *
 * Both must be reported as failures with a reason the caller can show. A resolver that returns
 * "found" for an element that is no longer in the page makes the agent click a stale reference
 * and the page does nothing.
 *
 * What these tests hold on to:
 *   1. A live element resolves, and it is the same element.
 *   2. An element that was removed from the page does not resolve, and says so.
 *   3. A WeakRef whose element was collected does not resolve.
 *   4. A map from a different document does not resolve, and says which document was expected.
 *   5. The document id is random enough that two of them are not the same.
 *   6. A crypto that throws still gives a document id, not a crash.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  generateDocId,
  getElementFromMap,
  resolveElementWithStatus,
  type ElementMap
} from '../../src/content/refMap.ts';

/** A document that knows which elements are attached to it. */
function fakeDoc(attached: any[] = []) {
  return {
    contains: (node: any) => attached.includes(node)
  } as unknown as Document;
}

/** A stand-in for a page element. The map only ever asks whether it is still attached. */
function fakeEl(id: string): Element {
  return { id } as unknown as Element;
}

test('a live element resolves, and it is the same element', () => {
  const el = fakeEl('buy-button');
  const map: ElementMap = new Map([[3, el]]);
  const doc = fakeDoc([el]);

  assert.equal(getElementFromMap(map, 3, doc), el);

  const result = resolveElementWithStatus(map, 3, 'doc-1', 'doc-1', doc);
  assert.equal(result.success, true);
  assert.equal(result.element, el);
  assert.equal(result.stale, undefined, 'a live element is not stale');
});

test('an id that is not in the map does not resolve', () => {
  const map: ElementMap = new Map();
  const result = resolveElementWithStatus(map, 3, 'doc-1', 'doc-1', fakeDoc());
  assert.equal(result.success, false);
  assert.match(result.error || '', /Element \[3\]/);
});

test('an element that was removed from the page does not resolve, and says so', () => {
  // The map still holds the element, but the page no longer has it. Resolving it would send a
  // click at something that is not there.
  const el = fakeEl('gone');
  const map: ElementMap = new Map([[3, el]]);
  const doc = fakeDoc([]); // the element is not attached any more

  assert.equal(getElementFromMap(map, 3, doc), null);

  const result = resolveElementWithStatus(map, 3, 'doc-1', 'doc-1', doc);
  assert.equal(result.success, false);
  assert.equal(result.stale, true);
  assert.match(result.error || '', /no longer attached/);
});

test('a WeakRef whose element was collected does not resolve', () => {
  // A WeakRef is how the map holds elements without keeping them alive. When the element is
  // gone, deref() returns undefined, and the resolver must say the element is not there
  // rather than throw.
  const collected = new WeakRef<Element>({} as Element);
  const map: ElementMap = new Map([[3, collected]]);

  const result = resolveElementWithStatus(map, 3, 'doc-1', 'doc-1', fakeDoc());
  assert.equal(result.success, false);
  assert.equal(result.stale, true);
  assert.match(result.error || '', /no longer attached/);
});

test('a WeakRef that still points at a live element resolves', () => {
  const el = fakeEl('live');
  const map: ElementMap = new Map([[3, new WeakRef(el)]]);
  const doc = fakeDoc([el]);

  const result = resolveElementWithStatus(map, 3, 'doc-1', 'doc-1', doc);
  assert.equal(result.success, true);
  assert.equal(result.element, el);
});

test('a map from a different document does not resolve, and says which document was expected', () => {
  // The page navigated: the ids the model was given belong to the old document. Clicking them
  // would hit the wrong elements, so this has to be a clear failure, not a wrong click.
  const el = fakeEl('old-page-button');
  const map: ElementMap = new Map([[3, el]]);
  const doc = fakeDoc([el]);

  const result = resolveElementWithStatus(map, 3, 'doc-2', 'doc-1', doc);
  assert.equal(result.success, false);
  assert.equal(result.stale, true);
  assert.match(result.error || '', /Document navigated/);
  assert.match(result.error || '', /doc-1/);
  assert.match(result.error || '', /doc-2/);
});

test('the same document resolves, whatever the ids are', () => {
  const el = fakeEl('button');
  const map: ElementMap = new Map([[3, el]]);
  const doc = fakeDoc([el]);

  const result = resolveElementWithStatus(map, 3, 'doc-1', 'doc-1', doc);
  assert.equal(result.success, true);
});

test('a string id resolves the same as a number', () => {
  const el = fakeEl('button');
  const map: ElementMap = new Map([[3, el]]);
  const doc = fakeDoc([el]);

  assert.equal(getElementFromMap(map, '3' as any, doc), el);
});

test('a document id is not the same twice', () => {
  const one = generateDocId();
  const two = generateDocId();
  assert.ok(one, 'there is a document id');
  assert.notEqual(one, two, 'two document ids are not the same');
  assert.match(one, /^[a-z0-9]+-[a-z0-9]+$/, 'and it reads like one');
});

test('a crypto that throws still gives a document id, not a crash', () => {
  const broken = {
    getRandomValues() { throw new Error('no entropy here'); }
  } as unknown as Crypto;

  const id = generateDocId(broken);
  assert.ok(id, 'there is still a document id');
  assert.ok(id.length > 0);
});

test('a crypto that is not there still gives a document id, not a crash', () => {
  const id = generateDocId(null as unknown as Crypto);
  assert.ok(id, 'there is still a document id');
});
