/**
 * Regression tests for perception enrichment: an element record used to carry no computed
 * ARIA role (only the literal [role] attribute or the bare tag name), no interactive state
 * (disabled/checked/expanded), no viewport marker, and no bounds - so the model had to guess
 * whether a "button" was actually a link, a checkbox was ticked, a menu was open, or an element
 * was even currently visible on screen without scrolling.
 *
 * content/domCompressor.js is a browser IIFE with no exports, loaded here via new Function
 * against a minimal fake DOM - the same technique used throughout this suite.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const SRC = fs.readFileSync(new URL('../content/domCompressor.js', import.meta.url), 'utf8');

function loadCompressor(interactiveEls, { innerWidth = 1200, innerHeight = 800 } = {}) {
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
  const fn = new Function('window', 'document', 'Node', 'CSS', `${SRC}\nreturn window.domCompressorInstance;`);
  return fn(fakeWindow, fakeDocument, fakeNode, fakeCSS);
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

test('a plain <a href> gets the implicit "link" role, not just its tag name', () => {
  const el = makeEl({ tagName: 'A', innerText: 'Docs' });
  const compressor = loadCompressor([el]);
  const snapshot = compressor.getSnapshot();
  assert.equal(snapshot.elements[0].role, 'link');
});

test('a checkbox input reports its checked state and role', () => {
  const el = makeEl({ tagName: 'INPUT', getAttribute: (a) => (a === 'type' ? 'checkbox' : null), checked: true });
  const compressor = loadCompressor([el]);
  const info = compressor.getSnapshot().elements[0];
  assert.equal(info.role, 'checkbox');
  assert.equal(info.checked, true);
  assert.match(info.formatted, /checked/);
});

test('a disabled element is reported as disabled', () => {
  const el = makeEl({ tagName: 'BUTTON', disabled: true, innerText: 'Submit' });
  const compressor = loadCompressor([el]);
  const info = compressor.getSnapshot().elements[0];
  assert.equal(info.disabled, true);
  assert.match(info.formatted, /disabled/);
});

test('aria-expanded is reported as expanded or collapsed', () => {
  const el = makeEl({ tagName: 'BUTTON', getAttribute: (a) => (a === 'aria-expanded' ? 'true' : null), innerText: 'Menu' });
  const compressor = loadCompressor([el]);
  const info = compressor.getSnapshot().elements[0];
  assert.equal(info.expanded, true);
  assert.match(info.formatted, /expanded/);
});

test('a password field never has its value included, even when the field has one', () => {
  const el = makeEl({ tagName: 'INPUT', getAttribute: (a) => (a === 'type' ? 'password' : null), value: 'hunter2' });
  const compressor = loadCompressor([el]);
  const info = compressor.getSnapshot().elements[0];
  assert.doesNotMatch(info.formatted, /hunter2/, 'a password value must never reach the LLM-visible snapshot');
});

test('a regular text input DOES surface its current value, so the model can see what is already typed', () => {
  const el = makeEl({ tagName: 'INPUT', getAttribute: (a) => (a === 'type' ? 'text' : null), value: 'san francisco' });
  const compressor = loadCompressor([el]);
  const info = compressor.getSnapshot().elements[0];
  assert.match(info.formatted, /value="san francisco"/);
});

test('an element outside the current viewport is marked off-screen', () => {
  const el = makeEl({ tagName: 'BUTTON', innerText: 'Load more', getBoundingClientRect: () => ({ width: 50, height: 20, top: 5000, left: 10, bottom: 5020, right: 60 }) });
  const compressor = loadCompressor([el], { innerHeight: 800 });
  const info = compressor.getSnapshot().elements[0];
  assert.equal(info.inViewport, false);
  assert.match(info.formatted, /\[off-screen\]/);
});

test('an element inside the current viewport carries no off-screen marker', () => {
  const el = makeEl({ tagName: 'BUTTON', innerText: 'Go' });
  const compressor = loadCompressor([el], { innerHeight: 800 });
  const info = compressor.getSnapshot().elements[0];
  assert.equal(info.inViewport, true);
  assert.doesNotMatch(info.formatted, /off-screen/);
});
