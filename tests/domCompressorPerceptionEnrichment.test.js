/**
 * Regression tests for perception enrichment: an element record used to carry no computed
 * ARIA role (only the literal [role] attribute or the bare tag name), no interactive state
 * (disabled/checked/expanded), no viewport marker, and no bounds - so the model had to guess
 * whether a "button" was actually a link, a checkbox was ticked, a menu was open, or an element
 * was even currently visible on screen without scrolling.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMCompressor } from '../src/content/domCompressor.ts';
import { withGlobals } from './helpers/contentGlobals.ts';

function createEnv(interactiveEls, { innerWidth = 1200, innerHeight = 800 } = {}) {
  const fakeWindow = { location: { href: 'https://example.com', hostname: 'example.com' }, innerWidth, innerHeight };
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

function makeEl(overrides) {
  return {
    tagName: 'DIV',
    nodeType: 1,
    getAttribute: () => null,
    checkVisibility: () => true,
    getBoundingClientRect: () => ({ width: 50, height: 20, top: 10, left: 10, bottom: 30, right: 60 }),
    setAttribute: () => {},
    innerText: '',
    ...overrides
  };
}

function getSnapshotForEls(interactiveEls, winOptions) {
  const env = createEnv(interactiveEls, winOptions);
  const compressor = new DOMCompressor();
  return withGlobals(
    { window: env.fakeWindow, document: env.fakeDocument, Node: env.fakeNode, CSS: env.fakeCSS },
    () => compressor.getSnapshot()
  );
}

test('a plain <a href> gets the implicit "link" role, not just its tag name', () => {
  const el = makeEl({ tagName: 'A', innerText: 'Docs' });
  const snapshot = getSnapshotForEls([el]);
  assert.equal(snapshot.elements[0].role, 'link');
});

test('a checkbox input reports its checked state and role', () => {
  const el = makeEl({ tagName: 'INPUT', getAttribute: (a) => (a === 'type' ? 'checkbox' : null), checked: true });
  const info = getSnapshotForEls([el]).elements[0];
  assert.equal(info.role, 'checkbox');
  assert.equal(info.checked, true);
  assert.match(info.formatted, /checked/);
});

test('a disabled element is reported as disabled', () => {
  const el = makeEl({ tagName: 'BUTTON', disabled: true, innerText: 'Submit' });
  const info = getSnapshotForEls([el]).elements[0];
  assert.equal(info.disabled, true);
  assert.match(info.formatted, /disabled/);
});

test('aria-expanded is reported as expanded or collapsed', () => {
  const el = makeEl({ tagName: 'BUTTON', getAttribute: (a) => (a === 'aria-expanded' ? 'true' : null), innerText: 'Menu' });
  const info = getSnapshotForEls([el]).elements[0];
  assert.equal(info.expanded, true);
  assert.match(info.formatted, /expanded/);
});

test('a password field never has its value included, even when the field has one', () => {
  const el = makeEl({ tagName: 'INPUT', getAttribute: (a) => (a === 'type' ? 'password' : null), value: 'hunter2' });
  const info = getSnapshotForEls([el]).elements[0];
  assert.doesNotMatch(info.formatted, /hunter2/, 'a password value must never reach the LLM-visible snapshot');
});

test('a regular text input DOES surface its current value, so the model can see what is already typed', () => {
  const el = makeEl({ tagName: 'INPUT', getAttribute: (a) => (a === 'type' ? 'text' : null), value: 'san francisco' });
  const info = getSnapshotForEls([el]).elements[0];
  assert.match(info.formatted, /value="san francisco"/);
});

test('an element outside the current viewport is marked off-screen', () => {
  const el = makeEl({ tagName: 'BUTTON', innerText: 'Load more', getBoundingClientRect: () => ({ width: 50, height: 20, top: 5000, left: 10, bottom: 5020, right: 60 }) });
  const info = getSnapshotForEls([el], { innerHeight: 800 }).elements[0];
  assert.equal(info.inViewport, false);
  assert.match(info.formatted, /\[off-screen\]/);
});

test('an element inside the current viewport carries no off-screen marker', () => {
  const el = makeEl({ tagName: 'BUTTON', innerText: 'Go' });
  const info = getSnapshotForEls([el], { innerHeight: 800 }).elements[0];
  assert.equal(info.inViewport, true);
  assert.doesNotMatch(info.formatted, /off-screen/);
});

test('the element window is viewport-first: an in-viewport element late in the DOM is listed before off-screen ones', () => {
  const earlyOffscreen = makeEl({ tagName: 'BUTTON', innerText: 'Early off-screen', getBoundingClientRect: () => ({ width: 50, height: 20, top: 5000, left: 10, bottom: 5020, right: 60 }) });
  const lateOffscreen = makeEl({ tagName: 'BUTTON', innerText: 'Later off-screen', getBoundingClientRect: () => ({ width: 50, height: 20, top: 9000, left: 10, bottom: 9020, right: 60 }) });
  const inView = makeEl({ tagName: 'BUTTON', innerText: 'Late in view' });
  const snapshot = getSnapshotForEls([earlyOffscreen, lateOffscreen, inView]);
  assert.deepEqual(snapshot.elements.map((e) => e.text), ['Late in view', 'Early off-screen', 'Later off-screen']);
});

test('off-screen elements are ordered by their distance to the viewport, nearest first', () => {
  const farBelow = makeEl({ tagName: 'BUTTON', innerText: 'Far below', getBoundingClientRect: () => ({ width: 50, height: 20, top: 9000, left: 10, bottom: 9020, right: 60 }) });
  const nearBelow = makeEl({ tagName: 'BUTTON', innerText: 'Near below', getBoundingClientRect: () => ({ width: 50, height: 20, top: 900, left: 10, bottom: 920, right: 60 }) });
  const justAbove = makeEl({ tagName: 'BUTTON', innerText: 'Just above', getBoundingClientRect: () => ({ width: 50, height: 20, top: -100, left: 10, bottom: -80, right: 60 }) });
  const snapshot = getSnapshotForEls([farBelow, nearBelow, justAbove]);
  assert.deepEqual(snapshot.elements.map((e) => e.text), ['Just above', 'Near below', 'Far below']);
});

test('a snapshot over the cap ends with the omitted-count marker line and reports the pre-cap count', () => {
  const els = Array.from({ length: 130 }, (_, i) => makeEl({ tagName: 'BUTTON', innerText: `Btn ${i}` }));
  const snapshot = getSnapshotForEls(els);
  assert.equal(snapshot.elementCount, 130, 'elementCount counts what was found, before the cap');
  assert.equal(snapshot.elements.length, 120, 'the cap itself is unchanged');
  assert.equal(snapshot.omittedCount, 10);
  assert.match(snapshot.elementsText, /\n\[\+10 more interactive elements not listed[^\]]*\]$/);
});

test('under the cap there is no marker line and omittedCount is 0', () => {
  const els = Array.from({ length: 3 }, (_, i) => makeEl({ tagName: 'BUTTON', innerText: `Btn ${i}` }));
  const snapshot = getSnapshotForEls(els);
  assert.equal(snapshot.elementCount, 3);
  assert.equal(snapshot.omittedCount, 0);
  assert.doesNotMatch(snapshot.elementsText, /not listed/);
});
