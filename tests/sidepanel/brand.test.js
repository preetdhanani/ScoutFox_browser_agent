/**
 * The ScoutFox mark: a fox head, drawn in one line, in two places.
 *
 * The header mark is in the static HTML, and the mark in the middle of the panel is written by
 * the renderer in sidepanel.js, because that whole block is rebuilt when a session is cleared.
 * Two files, one mark: this test proves they carry the same shape, so the panel cannot show a
 * fox in the header and something else above "What would you like to automate?".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { FOX_MARK } from '../../sidepanel/brand.js';

const HTML = fs.readFileSync(new URL('../../sidepanel/sidepanel.html', import.meta.url), 'utf8');
const PANEL_JS = fs.readFileSync(new URL('../../sidepanel/sidepanel.js', import.meta.url), 'utf8');

/** Every <svg> in the HTML, as the markup itself. */
function svgsIn(html) {
  return html.match(/<svg\b[\s\S]*?<\/svg>/g) || [];
}

test('brand: the mark is a fox head, drawn as one closed outline with two eyes', () => {
  // The outline of the head: two ears, a cheek on each side, a pointed muzzle.
  assert.match(FOX_MARK, /<path d="M3\.2 3 8\.6 8\.4 5\.6 11\.2Q6\.6 17 12 21\.6Q17\.4 17 18\.4 11\.2L15\.4 8\.4 20\.8 3 15\.2 6\.2Q12 5\.2 8\.8 6\.2Z"\/>/);
  // The two eyes, drawn as filled dots so they read at 19 px.
  assert.match(FOX_MARK, /<circle cx="9\.5" cy="12\.8" r="1" fill="currentColor" stroke="none"\/>/);
  assert.match(FOX_MARK, /<circle cx="14\.5" cy="12\.8" r="1" fill="currentColor" stroke="none"\/>/);
  // A line drawing in the theme's own colour, so it follows the accent in light and in dark.
  assert.match(FOX_MARK, /stroke="currentColor"/);
  assert.match(FOX_MARK, /fill="none"/);
  // The mark is decorative: the name next to it already says what this is.
  assert.match(FOX_MARK, /aria-hidden="true"/);
});

test('brand: the header carries the fox next to the name', () => {
  const header = /<div class="brand">([\s\S]*?)<\/div>\s*<div class="brand-text">/.exec(HTML);
  assert.ok(header, 'the header must have a .brand block with a .brand-text block');
  assert.ok(
    header[1].includes(FOX_MARK),
    'the header logo must be the fox mark from sidepanel/brand.js'
  );
  assert.ok(
    /<h1>ScoutFox<\/h1>/.test(HTML),
    'the name next to the fox must still be there'
  );
});

test('brand: the middle of the panel carries the fox above the headline', () => {
  const empty = /<div class="empty-glyph"[^>]*>([\s\S]*?)<\/div>/.exec(HTML);
  assert.ok(empty, 'the empty state must have an .empty-glyph block');
  assert.ok(
    empty[1].includes(FOX_MARK),
    'the mark above "What would you like to automate?" must be the fox mark from sidepanel/brand.js'
  );
  // The order matters: the fox sits above the headline, not below it.
  assert.ok(
    HTML.indexOf('class="empty-glyph"') < HTML.indexOf('What would you like to automate?'),
    'the fox must be above the headline'
  );
});

test('brand: the old asterisk mark is gone from the panel', () => {
  // The mark before the fox was an eight-spoked asterisk, in three places.
  for (const file of [HTML, PANEL_JS]) {
    assert.ok(!file.includes('M12 2.5v19'), 'the old asterisk mark must be gone');
  }
  // The header and the empty state are the only places the mark appears in the static HTML.
  assert.equal(svgsIn(HTML).filter((svg) => svg.includes('M3.2 3 8.6 8.4')).length, 2);
});

test('brand: the renderer writes the same fox when it rebuilds the empty state', () => {
  // The renderer replaces the whole timeline with the empty state, so its own copy of the mark
  // has to be the one from brand.js and not a second drawing that can drift.
  assert.match(
    PANEL_JS,
    /import \{ FOX_MARK \} from '\.\/brand\.js';/,
    'sidepanel.js must import the mark from brand.js'
  );
  assert.match(
    PANEL_JS,
    /<div class="empty-glyph" aria-hidden="true">\s*\$\{FOX_MARK\}\s*<\/div>/,
    'the empty state the renderer writes must use the shared mark'
  );
  // The renderer must not carry a second copy of the shape.
  assert.ok(!PANEL_JS.includes('M3.2 3 8.6 8.4'), 'sidepanel.js must not draw the mark itself');
});

test('brand: the mark is sized by CSS, so one shape serves the header and the middle', () => {
  const CSS = fs.readFileSync(new URL('../../sidepanel/sidepanel.css', import.meta.url), 'utf8');
  // The header mark is small, the mark in the middle of the panel is large.
  assert.match(CSS, /\.logo-icon svg\s*\{[^}]*width:\s*19px/);
  assert.match(CSS, /\.empty-glyph svg\s*\{[^}]*width:\s*100%/);
  // Neither gives the svg a size of its own, so the shape can never be stretched.
  assert.ok(!/\.logo-icon svg\s*\{[^}]*height:\s*auto/.test(CSS), 'the mark keeps its proportions');
});
