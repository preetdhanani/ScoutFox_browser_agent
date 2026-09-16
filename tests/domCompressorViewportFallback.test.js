/**
 * Regression test for a closed-but-never-actually-fixed issue: extractPageText()'s scrolled-
 * viewport fallback picked allTextNodes.slice(-50) - the last 50 matching nodes in DOCUMENT
 * order - whenever fewer than 10 nodes fell inside the generous +-200/+1500px viewport window.
 * On a page whose matching elements (h1-h6, p, li, td, th, pre, code, blockquote) are sparse
 * near the user's actual scroll position but plentiful elsewhere, that fallback returned
 * whatever happened to be LAST in the DOM - typically the footer - instead of anything near
 * where the user had actually scrolled to.
 *
 * Fixed by sorting every matching node by its distance from the viewport and taking the
 * nearest ones, so the fallback always centers on where the user is looking.
 *
 * content/domCompressor.js is a browser IIFE (no module exports, relies on window/document
 * globals), so it is loaded here via new Function against a minimal fake DOM - the same
 * technique used elsewhere in this suite for net-recorder.js and actionExecutor.js.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const SRC = fs.readFileSync(new URL('../content/domCompressor.js', import.meta.url), 'utf8');

function makeNode(text, rectTop) {
  return {
    tagName: 'P',
    textContent: text,
    getBoundingClientRect: () => ({ top: rectTop, bottom: rectTop + 20 })
  };
}

function loadCompressor({ scrollY, innerHeight, nodes, containerInnerText }) {
  const container = {
    querySelectorAll: () => nodes,
    innerText: containerInnerText,
    textContent: containerInnerText
  };

  const fakeWindow = { scrollY, innerHeight, location: { href: 'https://example.com/docs', hostname: 'example.com' } };
  const fakeDocument = {
    title: 'Docs',
    contentType: 'text/html',
    documentElement: { scrollHeight: 20000 },
    body: container,
    querySelector: () => null // no <article>/<main>/#readme match -> falls back to document.body
  };

  const fn = new Function('window', 'document', `${SRC}\nreturn window.domCompressorInstance;`);
  return fn(fakeWindow, fakeDocument);
}

test('the scrolled-viewport fallback centers on the current scroll position, not the end of the document', () => {
  // 5 nodes genuinely near the current scroll position (scrollY=5000, innerHeight=800, so the
  // viewport spans roughly y=5000-5800 in page coordinates; getBoundingClientRect() is
  // viewport-relative, so a node actually on screen has a small rect.top near 0).
  const nearNodes = Array.from({ length: 5 }, (_, i) =>
    makeNode(`NEAR-VIEWPORT-CONTENT-PARAGRAPH-NUMBER-${i}-with-enough-text-to-not-be-filtered-out`, 50 + i * 10));

  // 55 nodes far from the current scroll position in EITHER direction - enough that fewer
  // than 10 of the 60 total fall inside the generous viewport window, triggering the fallback,
  // and enough (>50 total) that a naive slice(-50) or slice(0,50) could plausibly miss the
  // near ones depending on where they sit in the array.
  const farNodes = Array.from({ length: 55 }, (_, i) =>
    makeNode(`FAR-AWAY-FOOTER-CONTENT-PARAGRAPH-NUMBER-${i}-should-not-be-picked-here`, i % 2 === 0 ? -9000 - i : 9000 + i));

  // Near nodes placed FIRST in document order, far ones after - so slice(-50) (the old,
  // buggy fallback) would grab indices [10..59], excluding the near nodes entirely, while
  // sorting by distance (the fix) must surface them regardless of their array position.
  const allNodes = [...nearNodes, ...farNodes];

  const compressor = loadCompressor({
    scrollY: 5000,
    innerHeight: 800,
    nodes: allNodes,
    containerInnerText: 'GENERIC-CONTAINER-FALLBACK-TEXT-should-not-be-needed-here-either'
  });

  const text = compressor.extractPageText();

  // The cap keeps 50 of 60 total nodes, so some of the LEAST-far nodes inevitably fill the
  // remainder alongside the near ones - that is expected, not a bug. The actual invariant a
  // distance-based fallback must satisfy is that the genuinely near content is never excluded
  // in favour of it; the old allTextNodes.slice(-50) could and did exclude it outright, since
  // it picked purely by array position (document order) with no regard for distance at all.
  for (let i = 0; i < nearNodes.length; i++) {
    assert.ok(text.includes(`NEAR-VIEWPORT-CONTENT-PARAGRAPH-NUMBER-${i}`),
      `paragraph ${i}, genuinely near the current scroll position, must survive the fallback`);
  }
});

test('a page with enough nodes directly in the viewport never needs the fallback at all', () => {
  const nodes = Array.from({ length: 35 }, (_, i) => makeNode(`ORDINARY-VISIBLE-PARAGRAPH-${i}`, 50 + i * 5));

  const compressor = loadCompressor({ scrollY: 500, innerHeight: 800, nodes, containerInnerText: '' });
  const text = compressor.extractPageText();

  assert.ok(text.includes('ORDINARY-VISIBLE-PARAGRAPH-0'));
});
