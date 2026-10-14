/**
 * Regression test for a closed-but-never-actually-fixed issue: extractPageText()'s scrolled-
 * viewport fallback picked allTextNodes.slice(-50) - the last 50 matching nodes in DOCUMENT
 * order - whenever fewer than 10 nodes fell inside the generous +-200/+1500px viewport window.
 * On a page whose text is sparse near the user's actual scroll position but plentiful elsewhere,
 * that fallback returned whatever happened to be LAST in the DOM - typically the footer - instead
 * of anything near where the user had actually scrolled to.
 *
 * The extractor no longer counts nodes (page-text-extractor-whitelist): it reads the visible text of the
 * content block, and only when a scrolled page has more text than the cap does it narrow that text to the
 * blocks whose rect lies in the window around the viewport. So the near content is kept however few blocks
 * there are, and the end of the document is never picked for being last.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMCompressor } from '../src/content/domCompressor.ts';
import { withGlobals } from './helpers/contentGlobals.ts';
import { el, fakeDocument, fakeWindow } from './helpers/fakeElementTree.ts';

function extractPageText(body, { scrollY, innerHeight = 800 }) {
  return withGlobals({ window: fakeWindow({ scrollY, innerHeight, hostname: 'example.com' }), document: fakeDocument(body) }, () =>
    new DOMCompressor().extractPageText());
}

// A name for number i made of letters only (0 is "q", 10 is "a"...). The paragraphs below must not
// differ only by a digit: extractPageText() collapses four or more lines in a row that do (see
// tests/domCompressorRepeatedRuns.test.js), which would hide which of them were picked.
const letters = (i) => i.toString(26).replace(/\d/g, (d) => 'qrstuvwxyz'[d]);

/** A paragraph at a viewport-relative top (getBoundingClientRect() is viewport-relative, so on screen is near 0). */
const paragraph = (text, top) => el('p', { top, height: 20 }, text);

test('a scrolled page with sparse text near the viewport keeps that text, not the end of the document', () => {
  // 5 paragraphs genuinely near the current scroll position (scrollY=5000, innerHeight=800).
  const near = Array.from({ length: 5 }, (_, i) =>
    paragraph(`NEAR-VIEWPORT-CONTENT-PARAGRAPH-NUMBER-${letters(i)}-with-enough-text-to-not-be-filtered-out`, 50 + i * 10));
  // 55 paragraphs far from it in EITHER direction, with enough text that the page does not fit the cap.
  const far = Array.from({ length: 55 }, (_, i) =>
    paragraph(`FAR-AWAY-FOOTER-CONTENT-PARAGRAPH-NUMBER-${letters(i)}-should-not-be-picked-here ${'and more words to fill the page '.repeat(3)}`, i % 2 === 0 ? -9000 - i : 9000 + i));
  // Near ones FIRST in document order, far ones after: the old slice(-50) would have dropped exactly the near ones.
  const body = el('body', {}, ...near, ...far);

  const text = extractPageText(body, { scrollY: 5000 });

  for (let i = 0; i < near.length; i++) {
    assert.ok(text.includes(`NEAR-VIEWPORT-CONTENT-PARAGRAPH-NUMBER-${letters(i)}-`), `paragraph ${i}, near the current scroll position, must be read`);
  }
  assert.doesNotMatch(text, /FAR-AWAY-FOOTER/, 'the far paragraphs are outside the window and the page is narrowed to it');
});

test('a scrolled page whose text fits the cap is read whole, so nothing is lost for being off screen', () => {
  const nodes = Array.from({ length: 35 }, (_, i) => paragraph(`ORDINARY-PARAGRAPH-${letters(i)}`, -3000 + i * 200));
  const text = extractPageText(el('body', {}, ...nodes), { scrollY: 3000 });

  assert.ok(text.includes(`ORDINARY-PARAGRAPH-${letters(0)}`), 'the first one, far above the viewport');
  assert.ok(text.includes(`ORDINARY-PARAGRAPH-${letters(34)}`), 'and the last one, far below it');
});
