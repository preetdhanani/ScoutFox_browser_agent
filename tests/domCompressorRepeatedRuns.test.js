/**
 * Regression test for a real run log: on frame.work's laptop configurator the page text that the
 * content script sends to the model (DOMCompressor.extractPageText, cut at 4500 characters) was
 * filled with "Batch 1 Shipped Batch 2 Shipped Batch 3 Ships December - Sold Out ..." again and
 * again until the cap. The price, the shipping and the delivery text never reached the small local
 * model, which then made up a shipping answer. read_page_text returns the same text, so the model
 * had no way to get past the noise.
 *
 * What the live page does (read with the real extractor in a real browser): every option of the
 * configurator is one <li> whose textContent holds the batch list once where people see it and
 * again in several hidden copies, so one <li> is about 5000 characters of the same few words.
 * tests/fixtures/site/configurator.html has that shape. The compressor is loaded the way the other
 * domCompressor tests load it (content/domCompressor.js is a browser IIFE, run with new Function
 * against a small fake DOM), and the fixture is read into the fake nodes by the tiny HTML reader
 * below, so the test runs on the page file and not on a hand copy of its text.
 *
 * The fix collapses a run of at least four units that are the same after masking digits into
 * "first ... last (N similar entries)", runs it again for repeated cycles, never touches a run
 * whose digits carry a price or a delivery time, and marks a text that is still cut at the cap.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const SRC = fs.readFileSync(new URL('../content/domCompressor.js', import.meta.url), 'utf8');
const FIXTURE = fs.readFileSync(new URL('./fixtures/site/configurator.html', import.meta.url), 'utf8');

const CAP = 4500;
const MARKER = `[page text truncated at ${CAP} characters]`;

// ---------------------------------------------------------------------------------------------
// The real compressor against a fake DOM
// ---------------------------------------------------------------------------------------------

function textNode(text, tagName = 'P') {
  return { tagName, textContent: text, getBoundingClientRect: () => ({ top: 0, bottom: 20 }) };
}

function loadCompressor({ nodes = [], contentType = 'text/html', hostname = 'shop.test', innerText = '' } = {}) {
  const container = { querySelectorAll: () => nodes, innerText, textContent: innerText };
  const fakeWindow = { scrollY: 0, innerHeight: 800, location: { href: `https://${hostname}/`, hostname } };
  const fakeDocument = {
    title: 'Test page',
    contentType,
    documentElement: { scrollHeight: 800 },
    body: container,
    querySelector: () => container // the <main> of the page, or the body: either way this container
  };
  const fn = new Function('window', 'document', `${SRC}\nreturn window.domCompressorInstance;`);
  return fn(fakeWindow, fakeDocument);
}

/** What the compressor returns for a page made of these paragraphs. */
function pageTextOf(...paragraphs) {
  // innerText is what the extractor falls back to for a page with under 100 characters of paragraphs.
  return loadCompressor({ nodes: paragraphs.map((p) => textNode(p)), innerText: paragraphs.join('\n') }).extractPageText();
}

const collapse = (text) => loadCompressor().collapseRepeatedRuns(text);

// ---------------------------------------------------------------------------------------------
// A tiny HTML reader for the fixture page: the elements that extractPageText selects inside <main>,
// in document order, each with its textContent (all descendant text, hidden or not, like a browser).
// ---------------------------------------------------------------------------------------------

const SELECTED = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'LI', 'TD', 'TH', 'PRE', 'CODE', 'BLOCKQUOTE']);
const VOID = new Set(['META', 'LINK', 'BR', 'HR', 'IMG', 'INPUT']);

function selectedNodesOfMain(html) {
  const nodes = [];
  const open = [];
  let inMain = false;
  for (const [, closing, name, text] of html.matchAll(/<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)[^>]*>|([^<]+)/g)) {
    if (text !== undefined) {
      if (inMain) for (const el of open) el.textContent += text.replaceAll('&amp;', '&');
      continue;
    }
    if (name === undefined) continue; // a comment
    const tag = name.toUpperCase();
    if (VOID.has(tag)) continue;
    if (closing) {
      const at = open.map((el) => el.tagName).lastIndexOf(tag);
      if (at >= 0) open.length = at;
      if (tag === 'MAIN') inMain = false;
      continue;
    }
    if (tag === 'MAIN') inMain = true;
    const el = textNode('', tag);
    open.push(el);
    if (inMain && SELECTED.has(tag)) nodes.push(el);
  }
  return nodes;
}

const configuratorNodes = selectedNodesOfMain(FIXTURE);
const configuratorText = () => loadCompressor({ nodes: configuratorNodes }).extractPageText();

// ---------------------------------------------------------------------------------------------
// The reproduction: the configurator page
// ---------------------------------------------------------------------------------------------

test('the fixture keeps the shape of the live page: the batch text alone is more than twice the cap', () => {
  const batchText = configuratorNodes.filter((n) => n.tagName === 'LI').map((n) => n.textContent.replace(/\s+/g, ' ')).join(' ');
  assert.ok(batchText.length > CAP * 2, `the option <li>s hold ${batchText.length} characters, which must stay well above the cap of ${CAP}`);
  assert.ok((batchText.match(/Batch \d+ Shipped/g) || []).length > 200, 'and most of it is the repeated batch list');
});

test('the configurator page: the price, the shipping and the delivery text reach the model', () => {
  const text = configuratorText();
  assert.match(text, /Starting at €2,069\.00/);
  assert.match(text, /Free shipping on laptop and desktop orders/);
  assert.match(text, /Ships within 5 business days - Deliveries to Europe are currently delayed by up to 7 days/);
});

test('the configurator page: the real content keeps the order of the page', () => {
  const text = configuratorText();
  const at = (needle) => {
    const index = text.indexOf(needle);
    assert.notEqual(index, -1, `"${needle}" must be in the page text`);
    return index;
  };
  const order = [
    '### Framework Laptop 16',
    'For pre-order laptop and desktop configurations',
    '### Configuration',
    'System, Base',
    'System, Overkill',
    'Touchpad, One Piece Haptic Touchpad',
    '### Your order',
    'Starting at €2,069.00',
    'Free shipping on laptop and desktop orders',
    'Ships within 5 business days'
  ].map(at);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'the pieces must come in page order');
});

test('the configurator page: each batch list is collapsed to its ends and a count, and nothing needs the truncation marker', () => {
  const text = configuratorText();
  assert.ok(text.length <= CAP, `the text is ${text.length} characters`);
  assert.doesNotMatch(text, /page text truncated/);
  // The run of seven "Ships December - Sold Out" batches keeps its first and last entry and its count ...
  assert.match(text, /Batch 3 Ships December - Sold Out \.\.\. Batch 9 Ships December - Sold Out \(7 similar entries\)/);
  // ... and what was in the middle of the run is gone.
  assert.doesNotMatch(text, /Batch 5 Ships December/);
  // Every option is still there, with its own price.
  for (const option of ['System, Base', 'System, Performance Pro', 'System, Overkill', 'Graphics Module (NVIDIA GeForce RTX 5070) - 8GB', 'Touchpad, One Piece Haptic Touchpad']) {
    assert.ok(text.includes(option), `${option} must survive`);
  }
  for (const price of ['€2,069', '€2,314', '€3,554', '+€109']) assert.ok(text.includes(price), `${price} must survive`);
});

// ---------------------------------------------------------------------------------------------
// What collapses, and what must not
// ---------------------------------------------------------------------------------------------

const batches = (from, to, status = 'Shipped') => Array.from({ length: to - from + 1 }, (_, i) => `Batch ${from + i} ${status}`);

test('seventeen batches in a row become their first and last entry and a count', () => {
  assert.equal(collapse(batches(1, 17).join(' ')), 'Batch 1 Shipped ... Batch 17 Shipped (17 similar entries)');
});

test('the same run on separate lines collapses the same way and keeps the lines around it', () => {
  assert.equal(collapse(batches(1, 17).join('\n')), 'Batch 1 Shipped ... Batch 17 Shipped (17 similar entries)');
  assert.equal(
    collapse(`Intro\n${batches(1, 5).join('\n')}\nOutro`),
    'Intro\nBatch 1 Shipped ... Batch 5 Shipped (5 similar entries)\nOutro'
  );
});

test('three in a row stay as they are, four are collapsed', () => {
  const three = batches(1, 3).join(' ');
  assert.equal(collapse(three), three);
  assert.equal(collapse(batches(1, 4).join(' ')), 'Batch 1 Shipped ... Batch 4 Shipped (4 similar entries)');
});

test('every sentence around a run is kept, in order', () => {
  const input = `Choose an option. ${batches(1, 6).join(' ')} Free shipping on all orders.`;
  assert.equal(collapse(input), 'Choose an option. Batch 1 Shipped ... Batch 6 Shipped (6 similar entries) Free shipping on all orders.');
});

test('text with no repeated run is returned untouched, blank lines and headings included', () => {
  const text = '\n### Heading\n\nFirst paragraph with some words.\nSecond paragraph with other words.\n';
  assert.equal(collapse(text), text);
  assert.equal(collapse(''), '');
  assert.equal(collapse('one'), 'one');
});

test('a genuine list with different content is not collapsed', () => {
  const products = [
    'Framework Laptop 16 - 1.399,00 EUR',
    'Dell XPS 15 - 1.899,00 EUR',
    'Lenovo ThinkPad X1 - 1.749,00 EUR',
    'HP Spectre x360 - 1.599,00 EUR',
    'Asus Zenbook 14 - 999,00 EUR'
  ].join('\n');
  assert.equal(collapse(products), products);

  const results = ['Result: Alpha shop', 'Result: Beta shop', 'Result: Gamma shop', 'Result: Delta shop', 'Result: Epsilon shop'].join('\n');
  assert.equal(collapse(results), results);
});

test('numbers and separators on their own are never "entries"', () => {
  for (const text of ['1 2 3 4 5 6 7 8', '- - - - - - -', '* * * * *', '0 0 0 0 0 0', '2024 2025 2026 2027 2028']) {
    assert.equal(collapse(text), text);
  }
});

test('a run whose digits carry a price is kept whole', () => {
  const prices = ['Variant A €1,399', 'Variant A €1,449', 'Variant A €1,499', 'Variant A €1,549'].join(' ');
  assert.equal(collapse(prices), prices);
  const dollars = ['Plan 10 USD', 'Plan 20 USD', 'Plan 30 USD', 'Plan 40 USD', 'Plan 50 USD'].join('\n');
  assert.equal(collapse(dollars), dollars);
});

test('a run whose digits carry a delivery time or a shipping cost is kept whole', () => {
  const english = ['Delivery in 3 days', 'Delivery in 4 days', 'Delivery in 5 days', 'Delivery in 6 days'].join('\n');
  assert.equal(collapse(english), english);
  const german = ['Lieferung in 2 Tagen', 'Lieferung in 3 Tagen', 'Lieferung in 4 Tagen', 'Lieferung in 5 Tagen'].join('\n');
  assert.equal(collapse(german), german);
  const shipping = ['Standard shipping 5 EUR', 'Standard shipping 7 EUR', 'Standard shipping 9 EUR', 'Standard shipping 11 EUR'].join(' ');
  assert.equal(collapse(shipping), shipping);
});

test('the batch status "Ships December" is not a shipping cost or lead time, so it still collapses', () => {
  assert.equal(
    collapse(batches(3, 9, 'Ships December - Sold Out').join(' ')),
    'Batch 3 Ships December - Sold Out ... Batch 9 Ships December - Sold Out (7 similar entries)'
  );
});

test('the same price or delivery sentence repeated word for word is shown once with a count, nothing is lost', () => {
  const banner = Array(10).fill('Free shipping over €50').join(' ');
  assert.equal(collapse(banner), 'Free shipping over €50 (repeated 10 times)');
  const lines = Array(6).fill('Delivery in 3 days').join('\n');
  assert.equal(collapse(lines), 'Delivery in 3 days (repeated 6 times)');
});

test('a repeated cycle of runs collapses on the second pass', () => {
  const cycle = `${batches(1, 4).join(' ')} Batch 9 Ships Q1 - Sold Out`;
  assert.equal(
    collapse(Array(5).fill(cycle).join(' ')),
    'Batch 1 Shipped ... Batch 4 Shipped (4 similar entries) Batch 9 Ships Q1 - Sold Out (repeated 5 times)'
  );
});

test('a cycle that repeats fewer than four times is left alone (only its runs collapse)', () => {
  const cycle = `${batches(1, 4).join(' ')} Batch 9 Ships Q1 - Sold Out`;
  const once = 'Batch 1 Shipped ... Batch 4 Shipped (4 similar entries) Batch 9 Ships Q1 - Sold Out';
  assert.equal(collapse(Array(3).fill(cycle).join(' ')), Array(3).fill(once).join(' '));
});

// ---------------------------------------------------------------------------------------------
// The cap and its marker
// ---------------------------------------------------------------------------------------------

/** n different words made of letters only, so that no two of them are the same after masking digits. */
function distinctWords(n) {
  return Array.from({ length: n }, (_, i) => `w${i.toString(26).replace(/\d/g, (d) => 'qrstuvwxyz'[d])}`);
}

/** Paragraph number i: thirty words that appear nowhere else. */
const longParagraph = (i) => distinctWords(30).map((w) => `${w}${'abcdefghijklmnopqrstuvwxyz'[i % 26]}${'abcdefghijklmnopqrstuvwxyz'[Math.floor(i / 26)]}`).join(' ');

test('a text that is cut at the cap ends with a marker that says so', () => {
  const paragraphs = Array.from({ length: 40 }, (_, i) => longParagraph(i));
  const full = paragraphs.join('\n');
  assert.ok(full.length > CAP, 'the paragraphs must be longer than the cap for this test to mean anything');
  const text = pageTextOf(...paragraphs);
  assert.ok(text.endsWith(`\n${MARKER}`), 'the marker is the last line');
  assert.equal(text.split(MARKER).length, 2, 'and it is there once');
  const kept = text.slice(0, -`\n${MARKER}`.length);
  assert.ok(kept.length <= CAP);
  assert.ok(full.startsWith(kept), 'what comes before the marker is the start of the page text, unchanged');
});

test('a text that fits the cap has no marker, also exactly at the cap', () => {
  assert.equal(pageTextOf('a'.repeat(CAP)), 'a'.repeat(CAP));
  assert.equal(pageTextOf('A short page text that is long enough to count.'), 'A short page text that is long enough to count.');
  assert.equal(pageTextOf('a'.repeat(CAP + 1)), `${'a'.repeat(CAP)}\n${MARKER}`);
});

test('collapsing first means the cap is spent on real content', () => {
  const noise = batches(1, 400).join(' ');
  const text = pageTextOf(noise, 'Free shipping on all orders, delivery in 3 to 5 business days.');
  assert.doesNotMatch(text, /page text truncated/);
  assert.match(text, /Batch 1 Shipped \.\.\. Batch 400 Shipped \(400 similar entries\)/);
  assert.match(text, /delivery in 3 to 5 business days\.$/);
});

test('a raw text page is never collapsed, it is the content itself, but it is capped and marked', () => {
  const few = batches(1, 6).join('\n');
  const rawFew = loadCompressor({ contentType: 'text/plain', innerText: few }).extractPageText();
  assert.equal(rawFew, few);

  const many = batches(1, 1000).join('\n');
  const rawMany = loadCompressor({ contentType: 'text/plain', innerText: many }).extractPageText();
  assert.equal(rawMany, `${many.slice(0, CAP)}\n${MARKER}`);

  const github = loadCompressor({ hostname: 'raw.githubusercontent.com', innerText: few }).extractPageText();
  assert.equal(github, few);
});

test('a huge page text is handled in bounded time, and a cut before the cap is still marked', { timeout: 20000 }, () => {
  // 1.2 million characters of words that never repeat: nothing collapses and the scan is cut.
  const distinct = distinctWords(200_000).join(' ');
  assert.ok(distinct.length > 1_000_000);
  const text = pageTextOf(distinct);
  assert.ok(text.endsWith(`\n${MARKER}`));

  // 1.2 million characters of one repeated word: it all collapses, but the page was cut, so it says so.
  const repeated = 'spam '.repeat(240_000);
  const collapsed = pageTextOf(repeated);
  assert.match(collapsed, /^spam \(repeated \d+ times\)\s*\n\[page text truncated\]$/);
});
