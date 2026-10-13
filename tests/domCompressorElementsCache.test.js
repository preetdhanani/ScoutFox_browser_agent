/**
 * Regression test for the actual bug: DOMCompressor.getSnapshot() built the per-element locator
 * array locally and returned it, but never assigned it to `this.elements` - so
 * actionExecutor.js's resolveElement() (which reads `compressor.elements` to re-resolve a stale
 * element by #id/cssPath/tag+text) always saw undefined and returned null immediately. See
 * tests/actionExecutorElementResolution.test.js for the fallback-chain behaviour itself; this
 * test is the missing link - that the object those tests assume actually gets populated by a
 * real getSnapshot() call.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMCompressor } from '../src/content/domCompressor.ts';
import { withGlobals } from './helpers/contentGlobals.ts';

function createEnv(interactiveEls) {
  const fakeWindow = { location: { href: 'https://example.com', hostname: 'example.com' } };
  const fakeDocument = {
    title: 'Test Page',
    contentType: 'text/html',
    documentElement: { scrollHeight: 1000 },
    body: { innerText: '', textContent: '', querySelectorAll: () => [] },
    querySelector: () => null,
    querySelectorAll: (sel) => (sel.includes('a[href]') ? interactiveEls : [])
  };
  const fakeNode = { ELEMENT_NODE: 1 };
  const fakeCSS = { escape: (s) => s };
  return { fakeWindow, fakeDocument, fakeNode, fakeCSS };
}

function makeButton(id) {
  return {
    tagName: 'BUTTON',
    nodeType: 1,
    id,
    getAttribute: () => null,
    innerText: 'Submit',
    checkVisibility: () => true,
    getBoundingClientRect: () => ({ width: 50, height: 20 }),
    setAttribute: () => {}
  };
}

test('getSnapshot() populates this.elements, not just the returned snapshot object', () => {
  const env = createEnv([makeButton('submit-btn')]);
  const compressor = new DOMCompressor();
  const snapshot = withGlobals(
    { window: env.fakeWindow, document: env.fakeDocument, Node: env.fakeNode, CSS: env.fakeCSS },
    () => compressor.getSnapshot()
  );

  assert.equal(snapshot.elementCount, 1);
  assert.ok(Array.isArray(compressor.elements), 'this.elements must be set so resolveElement() can read it later');
  assert.equal(compressor.elements.length, 1);
  assert.equal(compressor.elements[0].locator.attrs.id, 'submit-btn');
  assert.deepEqual(compressor.elements, snapshot.elements, 'the cache and the returned snapshot must describe the same elements');
});

test('a second snapshot replaces the cache instead of accumulating stale entries', () => {
  const env = createEnv([makeButton('a')]);
  const compressor = new DOMCompressor();
  withGlobals(
    { window: env.fakeWindow, document: env.fakeDocument, Node: env.fakeNode, CSS: env.fakeCSS },
    () => compressor.getSnapshot()
  );
  assert.equal(compressor.elements.length, 1);

  withGlobals(
    { window: env.fakeWindow, document: env.fakeDocument, Node: env.fakeNode, CSS: env.fakeCSS },
    () => compressor.getSnapshot()
  );
  assert.equal(compressor.elements.length, 1, 'the cache must reflect only the latest snapshot');
});
