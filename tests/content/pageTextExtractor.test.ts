/**
 * The page text the model reads (src/content/pageText.ts, extractPageTextFromDocument) is the visible text
 * of the page's content block, whatever element the text sits in.
 *
 * The bug this exists for: the extractor read only h1-h6, p, li, td, th, pre, code and blockquote, by
 * textContent, and only the first 90 of them. On the live frame.work configurator (2026-09-30) the price,
 * the free shipping line and the ships-within line sit in <span>s with none of those tags around them, while
 * the option <li>s hold thousands of characters of hidden duplicate batch lists. So the model got 4500
 * characters of "Batch N Shipped" and never the price, and answered "not shown" or made a price up.
 *
 * The extractor now picks the content block the way the reference get_page_text does (the first content
 * selector that matches, the longest of its matches, else <body>), reads its innerText (visible text only,
 * any element), collapses repeated runs, and narrows to the blocks around the viewport only when a scrolled
 * page has more text than the prompt can take.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { extractPageTextFromDocument, extractFullPageTextFromDocument, PAGE_TEXT_CAP, PAGE_TEXT_EMPTY_MARKER } from '../../src/content/pageText.ts';
import { el, fakeDocument, fakeWindow, parseHtml, type FakeElement } from '../helpers/fakeElementTree.ts';

const extract = (body: FakeElement, win = fakeWindow(), docExtra: Record<string, unknown> = {}) =>
  extractPageTextFromDocument(fakeDocument(body, docExtra) as unknown as Document, win as unknown as Window);

// A name made of letters only, so lines never differ by a digit alone (repeated runs of those collapse).
const letters = (i: number) => i.toString(26).replace(/\d/g, (d) => 'qrstuvwxyz'[Number(d)]);

// ---------------------------------------------------------------------------------------------
// The frame.work configurator, as the live page is built
// ---------------------------------------------------------------------------------------------

const PRICE = 'Starting at €2,069.00';
const SHIPPING = 'Free shipping on laptop and desktop orders';
const DELIVERY = 'Ships within 5 business days - Deliveries to Europe are currently delayed by up to 7 days due to global freight disruptions.';

/** The visible batch list of an option, and the hidden dropdown copies of it that the page keeps in the DOM. */
function batchItems(copy: number): FakeElement[] {
  const status = (n: number) => (n <= 2 ? 'Shipped' : n <= 9 ? 'Ships December - Sold Out' : 'Ships Q1 - Sold Out');
  return Array.from({ length: 17 }, (_, i) => el('li', {}, `Batch ${i + 1 + copy * 17} ${status(i + 1)}`));
}

/** frame.work's configurator: 12 option <li>s with ~5.7K hidden duplicate batch <li>s, the price block in <span>s in <div>s. */
function frameworkConfigurator(): { body: FakeElement; hiddenItems: number } {
  let hiddenItems = 0;
  const options = Array.from({ length: 12 }, (_, o) => {
    const hidden = Array.from({ length: 28 }, (_, copy) => {
      const items = batchItems(copy + 1);
      hiddenItems += items.length;
      return el('ul', { attrs: { class: 'batch-menu', hidden: '' } }, ...items);
    });
    return el('li', { attrs: { class: 'option-value-container' } },
      el('span', {}, `Option ${letters(o)}`), ' ', el('span', {}, `€${2069 + o * 245}`),
      el('div', { attrs: { class: 'batches' } }, el('span', {}, 'Batch 1 Shipped'), ' ', el('span', {}, 'Batch 2 Shipped')),
      ...hidden);
  });
  const body = el('body', {},
    el('header', {}, el('a', {}, 'Framework'), ' ', el('a', {}, 'Laptops')),
    el('main', { attrs: { id: 'main-content' } },
      el('h1', {}, 'Framework Laptop 16'),
      el('h2', {}, 'Configuration'),
      el('ul', { attrs: { class: 'options' } }, ...options),
      el('section', { attrs: { class: 'summary' } },
        el('div', { attrs: { class: 'price-block' } }, el('span', { attrs: { class: 'label' } }, 'Starting at'), ' ', el('span', { attrs: { class: 'amount' } }, '€2,069.00')),
        el('div', {}, el('span', {}, SHIPPING)),
        el('div', {}, el('span', {}, DELIVERY)),
        el('div', {}, el('button', {}, 'Add to cart')))),
    el('footer', {}, el('a', {}, 'Imprint')));
  return { body, hiddenItems };
}

test('the frame.work shape: thousands of hidden duplicate <li>s and the price block in <span>s', () => {
  const { body, hiddenItems } = frameworkConfigurator();
  assert.ok(hiddenItems > 5500, `${hiddenItems} hidden <li>s, the live page had about 5.7K`);
  const main = body.querySelector('main') as FakeElement;
  assert.ok(main.textContent.length > 25 * PAGE_TEXT_CAP, 'textContent is dominated by the hidden lists');
  assert.ok(main.innerText.length < 1000, 'innerText, what people see, is short');
});

test('the frame.work configurator: the price, the shipping and the delivery line reach the page text', () => {
  const text = extract(frameworkConfigurator().body);
  assert.ok(text.includes(PRICE), `the price line is missing from:\n${text.slice(0, 600)}`);
  assert.ok(text.includes(SHIPPING), 'the shipping line is missing');
  assert.ok(text.includes(DELIVERY), 'the delivery line is missing');
});

test('the frame.work configurator: hidden duplicate lists no longer fill the page text', () => {
  const text = extract(frameworkConfigurator().body);
  assert.doesNotMatch(text, /Batch 18 /, 'batch numbers that exist only in the hidden copies must not be read');
  assert.ok(text.length < 1000, `the page text is ${text.length} characters`);
  assert.doesNotMatch(text, /page text truncated/);
  // The page in the order people see it, the header and footer outside <main> left out.
  const order = ['Framework Laptop 16', 'Configuration', `Option ${letters(0)}`, `Option ${letters(11)}`, PRICE, SHIPPING, 'Add to cart'].map((s) => text.indexOf(s));
  assert.ok(order.every((i) => i >= 0), JSON.stringify(order));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.doesNotMatch(text, /Imprint/);
});

test('repeated runs in the visible text are still collapsed', () => {
  const runs = Array.from({ length: 30 }, (_, i) => el('div', {}, el('span', {}, `Batch ${i + 1} Shipped`)));
  const text = extract(el('body', {}, el('main', {}, el('h1', {}, 'Shipping status of every batch'), ...runs)));
  assert.match(text, /Batch 1 Shipped \.\.\. Batch 30 Shipped \(30 similar entries\)/);
});

// ---------------------------------------------------------------------------------------------
// Which block is read
// ---------------------------------------------------------------------------------------------

test('the content block is <main> when the page has one, so a listing of <article> cards inside it is read whole', () => {
  const cards = Array.from({ length: 5 }, (_, i) => el('article', {}, el('span', {}, `Shop ${letters(i)} offers it for ${100 + i} EUR`)));
  const text = extract(el('body', {}, el('nav', {}, 'Navigation menu items'), el('main', {}, ...cards)));
  for (let i = 0; i < 5; i++) assert.ok(text.includes(`Shop ${letters(i)} offers it`), `card ${i} is missing`);
  assert.doesNotMatch(text, /Navigation/);
});

test('among several matches of the first selector that hits, the longest one is read', () => {
  const text = extract(el('body', {},
    el('article', {}, el('div', {}, 'A short teaser card.')),
    el('article', {}, el('div', {}, 'The full story, much longer than the teaser card in front of it.'))));
  assert.equal(text, 'The full story, much longer than the teaser card in front of it.');
});

test('a page without a content block is read from <body>, any element', () => {
  const text = extract(el('body', {}, el('div', {}, el('span', {}, 'Price'), ' ', el('b', {}, '€5')), el('div', {}, 'Delivery tomorrow')));
  assert.equal(text, 'Price €5\nDelivery tomorrow');
});

test('a content block with no visible text falls through to the next selector, then to <body>', () => {
  const text = extract(el('body', {}, el('main', {}, el('div', { attrs: { hidden: '' } }, 'Loading the configurator...')), el('div', {}, 'Visible text outside of main.')));
  assert.equal(text, 'Visible text outside of main.');
});

test('every visible line counts: no node cap and no minimum length', () => {
  const lines = Array.from({ length: 200 }, (_, i) => el('div', {}, `line ${letters(i)}`));
  const text = extract(el('body', {}, el('main', {}, el('span', {}, '€5'), ...lines)));
  assert.match(text, /^€5\n/);
  assert.match(text, new RegExp(`line ${letters(199)}$`));
});

test('whitespace is normalised: one space inside a line, no blank lines, no space at the ends', () => {
  const text = extract(el('body', {}, el('main', {}, el('p', {}, '  Free \u00a0 shipping   on all   orders  '), el('div', {}), el('p', {}, '\n\n  Delivery in 3 days \n'))));
  assert.equal(text, 'Free shipping on all orders\nDelivery in 3 days');
});

test('the cells of a table row stay apart (innerText puts a tab between them)', () => {
  const body = el('body', {}, el('main', {}, el('div', {}, 'Shop\tPreis\tVersand\nNotebookWelt\t1.379,00 EUR\t\t9,90 EUR')));
  assert.equal(extract(body), 'Shop | Preis | Versand\nNotebookWelt | 1.379,00 EUR | 9,90 EUR');
});

test('a page with fewer than 10 characters of visible text says so with a marker', () => {
  assert.equal(extract(el('body', {})), PAGE_TEXT_EMPTY_MARKER);
  assert.equal(extract(el('body', {}, el('main', {}, el('div', { attrs: { hidden: '' } }, 'A long hidden text that nobody sees')))), PAGE_TEXT_EMPTY_MARKER);
  assert.equal(extract(el('body', {}, el('div', {}, 'Error 42'))), `Error 42\n${PAGE_TEXT_EMPTY_MARKER}`);
  // Nine characters are still too few, ten are a page text.
  assert.equal(extract(el('body', {}, el('div', {}, '123456789'))), `123456789\n${PAGE_TEXT_EMPTY_MARKER}`);
  assert.equal(extract(el('body', {}, el('div', {}, '1234567890'))), '1234567890');
  // The marker must stay short: the page verdict treats a page text under 120 characters as blank.
  assert.ok(PAGE_TEXT_EMPTY_MARKER.length + 10 < 120);
});

// ---------------------------------------------------------------------------------------------
// Scrolled pages
// ---------------------------------------------------------------------------------------------

/** A <main> of n blocks, block i at top = (i * 100 - scrollY), each with ~80 characters of distinct text. */
function tallPage(n: number, scrollY: number): FakeElement {
  const blocks = Array.from({ length: n }, (_, i) =>
    el('section', { top: i * 100 - scrollY, height: 100 }, el('span', {}, `Block ${letters(i)} `), `${'with some words that make it long enough '.repeat(2)}end ${letters(i)}.`));
  return el('body', {}, el('main', { top: -scrollY, height: n * 100 }, ...blocks));
}

test('a scrolled page with more text than the prompt can take is narrowed to the blocks around the viewport', () => {
  const scrollY = 6000;
  const text = extract(tallPage(200, scrollY), fakeWindow({ scrollY, innerHeight: 800 }));
  // The window is 200 px above the viewport to 1500 px below it: blocks 58 to 82.
  assert.ok(text.includes(`Block ${letters(60)} `), 'the block on screen is read');
  assert.ok(text.includes(`Block ${letters(80)} `), 'a block just below the screen is read');
  assert.ok(!text.includes(`Block ${letters(0)} `), 'the top of the page is not');
  assert.ok(!text.includes(`Block ${letters(150)} `), 'the far end of the page is not');
});

test('a block that straddles the window is opened and only its children in the window are read', () => {
  const scrollY = 6000;
  const children = Array.from({ length: 200 }, (_, i) =>
    el('div', { top: i * 100 - scrollY, height: 100 }, `Row ${letters(i)} ${'filler words for length '.repeat(3)}`));
  const text = extract(el('body', {}, el('main', { top: -scrollY, height: 20000 }, el('div', { top: -scrollY, height: 20000 }, ...children))), fakeWindow({ scrollY }));
  assert.ok(text.includes(`Row ${letters(62)} `));
  assert.ok(!text.includes(`Row ${letters(5)} `));
});

test('hidden blocks are never read back in by the window (their rect is zero, like in a browser)', () => {
  const scrollY = 6000;
  const page = tallPage(200, scrollY);
  (page.querySelector('main') as FakeElement).append(el('div', { attrs: { hidden: '' } }, 'SECRET hidden dropdown copy'));
  const text = extract(page, fakeWindow({ scrollY }));
  assert.doesNotMatch(text, /SECRET/);
});

test('a scrolled page whose text fits is read whole, from the top', () => {
  const scrollY = 1500;
  const text = extract(tallPage(20, scrollY), fakeWindow({ scrollY }));
  assert.ok(text.includes(`Block ${letters(0)} `));
  assert.ok(text.includes(`Block ${letters(19)} `));
});

test('a page that is not scrolled is read from the top, also when it is long', () => {
  const text = extract(tallPage(200, 0), fakeWindow({ scrollY: 0 }));
  assert.match(text, new RegExp(`^Block ${letters(0)} `));
});

test('a scrolled page with nothing in the window keeps the whole text', () => {
  const scrollY = 50000;
  const text = extract(tallPage(200, scrollY), fakeWindow({ scrollY }));
  assert.match(text, new RegExp(`^Block ${letters(0)} `));
});

// ---------------------------------------------------------------------------------------------
// The fixture page of the e2e run
// ---------------------------------------------------------------------------------------------

test('the e2e fixture store-spans.html: its price, shipping and delivery lines (all in spans) reach the page text', () => {
  const body = parseHtml(fs.readFileSync(new URL('../fixtures/site/store-spans.html', import.meta.url), 'utf8'));
  const text = extract(body);
  assert.match(text, /ab 1\.449,00 EUR/);
  assert.match(text, /Kostenloser Versand nach Deutschland/);
  assert.match(text, /Lieferung in 3-4 Werktagen/);
  assert.doesNotMatch(text, /Charge 40/, 'the hidden dropdown copies are not read');
});

// ---------------------------------------------------------------------------------------------
// The old rules are gone
// ---------------------------------------------------------------------------------------------

test('pageText.ts has no tag whitelist, no 90-node cap and no 100-character fallback any more', () => {
  const source = fs.readFileSync(new URL('../../src/content/pageText.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /'h1, h2, h3, h4, h5, h6, p, li/);
  assert.doesNotMatch(source, /slice\(0, 90\)/);
  assert.doesNotMatch(source, /length < 100\b/);
});

// ---------------------------------------------------------------------------------------------
// silent-truncation-no-marker: every cut says so
// ---------------------------------------------------------------------------------------------

test('a scrolled page narrowed to the window says so, with the size of the whole page text', () => {
  const scrollY = 6000;
  const text = extract(tallPage(200, scrollY), fakeWindow({ scrollY, innerHeight: 800 }));
  const whole = extract(tallPage(200, 0), fakeWindow({ scrollY: 0 }));
  const fullSize = Number(whole.match(/of (\d+) characters/)?.[1]);
  assert.ok(fullSize > PAGE_TEXT_CAP);
  assert.match(text, new RegExp(`\\n\\[page text truncated: showing \\d+ of ${fullSize} characters - [^\\]]*scroll position[^\\]]*\\]$`));
});

test('a long page text cut at the cap ends with a note naming the full size and read_page', () => {
  const text = extract(tallPage(200, 0), fakeWindow({ scrollY: 0 }));
  assert.match(text, /\n\[page text truncated: showing \d+ of \d+ characters - [^\]]*read_page[^\]]*\]$/);
});

test('the full extraction for read_page is the whole page text, with no cap and no window', () => {
  const scrollY = 6000;
  const full = extractFullPageTextFromDocument(fakeDocument(tallPage(200, scrollY)) as unknown as Document, fakeWindow({ scrollY }) as unknown as Window);
  assert.ok(full.length > PAGE_TEXT_CAP * 2);
  assert.match(full, new RegExp(`^Block ${letters(0)} `));
  assert.ok(full.includes(`Block ${letters(199)} `));
  assert.doesNotMatch(full, /truncated/);
});
