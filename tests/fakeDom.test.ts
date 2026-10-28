/**
 * Tests for tests/helpers/fakeDom.ts, the page snapshots and the fake content script.
 *
 * A fake that builds the wrong snapshot is worse than no fake: every engine test built on it would
 * pass against a page the real content script never produces. So the first half of this file pins
 * the shape to the real thing, two ways:
 *   - the same page description, run through the REAL compressor (src/content/domCompressor.ts,
 *     which builds the shipped content/domCompressor.js, against a small fake DOM), must give a
 *     deep-equal snapshot, `elements` and all;
 *   - the committed snapshots that tests/e2e/smoke.mjs --dump-snapshots recorded in a real Chromium
 *     (tests/fixtures/snapshots) must come out of a description of the same page, key for key.
 * The second half checks the fake content script: what it answers to GET_DOM_SNAPSHOT and
 * EXECUTE_ACTION through fakeChrome's tabs.sendMessage, and how a click moves the tab on.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fakeChrome } from './helpers/fakeChrome.ts';
import type { FakeChrome } from './helpers/fakeChrome.ts';
import { button, fakeDom, input, link, pageSnapshot } from './helpers/fakeDom.ts';
import type { DomSnapshot, ElementSpec, FakeDom, PageSpec, PageText } from './helpers/fakeDom.ts';
import { DOMCompressor } from '../src/content/domCompressor.ts';
import { ActionExecutor } from '../src/content/actionExecutor.ts';
import { withGlobals } from './helpers/contentGlobals.ts';

// ---------------------------------------------------------------------------------------------
// The real DOMCompressor, against a fake DOM built from the same description
// ---------------------------------------------------------------------------------------------

interface FakeNode {
  tagName: string;
  nodeType: number;
  id: string;
  innerText: string;
  textContent: string;
  disabled: boolean;
  checked: boolean;
  value: string;
  parentElement: unknown;
  previousElementSibling: FakeNode | null;
  getAttribute(name: string): string | null;
  closest(selector: string): unknown;
  setAttribute(): void;
  checkVisibility(): boolean;
  getBoundingClientRect(): { width: number; height: number; top: number; bottom: number; left: number; right: number };
}

/**
 * Runs the compressor (src/content/domCompressor.ts) on a page made of the given elements, all direct children of <body>
 * (so cssPath is the plain tag path), and returns the real getSnapshot() result. The page needs an
 * explicit pageHeight, because scrollHeight is a fact of the browser that the description has to give.
 */
function realSnapshot(page: PageSpec, options: { scrollY?: number; maxElements?: number } = {}): unknown {
  assert.notEqual(page.pageHeight, undefined, 'give the page a pageHeight');
  const scrollY = options.scrollY ?? 0;
  const text = page.text;
  const body = {
    nodeType: 1,
    // The page has no content block, so the real extractor reads the innerText of <body>: a list
    // page is one block per piece, each on its own line, as a browser renders it.
    innerText: typeof text === 'string' ? text : Array.isArray(text) ? text.map((piece) => (typeof piece === 'string' ? piece : piece.heading)).join('\n') : '',
    textContent: '',
  };

  const nodes: FakeNode[] = [];
  for (const spec of page.elements ?? []) {
    const tag = spec.tag.toLowerCase();
    const attributes: Record<string, string> = {};
    if (spec.type) attributes.type = spec.type;
    if (spec.placeholder) attributes.placeholder = spec.placeholder;
    if (spec.label) attributes['aria-label'] = spec.label;
    if (spec.role) attributes.role = spec.role;
    if (spec.name) attributes.name = spec.name;
    if (spec.testId) attributes['data-testid'] = spec.testId;
    if (spec.expanded !== undefined) attributes['aria-expanded'] = String(spec.expanded);
    // A checkbox reports .checked; anything else is read from aria-checked.
    const checkable = tag === 'input' && (spec.type === 'checkbox' || spec.type === 'radio');
    if (!checkable && spec.checked) attributes['aria-checked'] = 'true';
    const top = (spec.y ?? 0) - scrollY;
    nodes.push({
      tagName: spec.tag.toUpperCase(),
      nodeType: 1,
      // A link() always has an href, like the <a href> it stands for (a same-page "#" when it leads nowhere).
      ...(tag === 'a' ? { href: new URL(spec.goes ?? '#', page.url).href } : {}),
      id: spec.id ?? '',
      innerText: spec.text ?? '',
      textContent: spec.text ?? '',
      disabled: spec.disabled ?? false,
      checked: checkable ? (spec.checked ?? false) : false,
      // Like a browser: a checkbox or radio without a value attribute has the value "on".
      value: spec.value ?? (checkable ? 'on' : ''),
      parentElement: body,
      previousElementSibling: nodes.at(-1) ?? null,
      getAttribute: (name) => attributes[name] ?? null,
      // The form the element is in: its kind as the aria-label, which computeFormKind() reads.
      closest: (selector: string) =>
        selector === 'form' && spec.form ? { id: '', className: '', getAttribute: (name: string) => (name === 'aria-label' ? spec.form : null) } : null,
      setAttribute: () => {},
      checkVisibility: () => true,
      getBoundingClientRect: () => ({ width: 50, height: 20, top, bottom: top + 20, left: 10, right: 60 }),
    });
  }

  const fakeWindow = {
    location: { href: page.url, hostname: new URL(page.url).hostname },
    innerWidth: 1200,
    innerHeight: page.viewportHeight ?? 800,
    scrollY,
  };
  const fakeDocument = {
    title: page.title ?? '',
    contentType: 'text/html',
    documentElement: { scrollHeight: page.pageHeight },
    body,
    querySelector: () => null,
    // The compressor asks for interactive elements with one selector list and for text with another.
    querySelectorAll: (selector: string) => (selector.includes('a[href]') ? nodes : []),
  };
  return withGlobals(
    {
      window: fakeWindow,
      document: fakeDocument,
      Node: { ELEMENT_NODE: 1 },
      CSS: { escape: (s: string) => s },
    },
    () => {
      const compressor = new DOMCompressor();
      return compressor.getSnapshot(options.maxElements === undefined ? {} : { maxElements: options.maxElements });
    }
  );
}

/** A page that uses every branch of the element summary. */
const KITCHEN_SINK: PageSpec = {
  url: 'https://kitchen.test/sink?q=1',
  title: 'Kitchen sink',
  viewportHeight: 700,
  pageHeight: 3000,
  text: [
    { heading: 'Sink' },
    'A paragraph with   extra    spaces\nand a line break, long enough to matter.',
    'no',
    { heading: 'Second heading' },
    'Preis: 1.399,00 EUR inkl. MwSt.',
  ],
  elements: [
    link('Home'),
    link('Docs', 'https://kitchen.test/docs', { id: 'docs-link', testId: 'nav-docs' }),
    link('  Two   words  and\na newline '),
    link('x'.repeat(100)),
    button('Save', { type: 'button', name: 'save' }),
    button('Submit', { type: 'submit', disabled: true }),
    button('Menu', { expanded: true }),
    button('More', { expanded: false }),
    { tag: 'button', label: 'Close dialog' },
    { tag: 'button' },
    input('search', { placeholder: 'Suche', label: 'Suche' }),
    input('text', { placeholder: 'Name', value: 'san francisco' }),
    input('text', { value: 'v'.repeat(60) }),
    input('password', { label: 'Password', value: 'hunter2' }),
    input('checkbox', { label: 'Remember me', checked: true }),
    input('checkbox', { label: 'Newsletter' }),
    input('radio', { label: 'Yes', value: 'yes' }),
    input('range', { label: 'Volume' }),
    input('submit', { value: 'Go' }),
    { tag: 'input' },
    { tag: 'textarea', placeholder: 'Notes', value: 'hello' },
    { tag: 'select', label: 'Country', name: 'country' },
    { tag: 'div', role: 'tab', text: 'Overview' },
    { tag: 'div', role: 'button', text: 'Clickable div', checked: true },
    { tag: 'span', text: 'Only an onclick' },
    link('Far down', undefined, { y: 2000 }),
    button('Footer', { y: 2900 }),
  ],
};

test('the same description gives exactly what the real DOMCompressor returns, elements and locators included', () => {
  const real = realSnapshot(KITCHEN_SINK);
  const fake = pageSnapshot(KITCHEN_SINK);

  assert.deepStrictEqual(fake, real);
  // Guard the guard: the page really exercises the interesting cases.
  const snap = fake as DomSnapshot;
  assert.equal(snap.elementCount, 27);
  assert.ok(snap.elements.some((e) => e.expanded === undefined) && snap.elements.some((e) => e.expanded === false));
  assert.ok(snap.elementsText.includes('[off-screen]'));
  assert.ok(snap.elementsText.includes('value="on"'));
  assert.ok(!snap.elementsText.includes('hunter2'));
});

test('scrolled, the off-screen markers and the scroll state still match the real thing', () => {
  const real = realSnapshot(KITCHEN_SINK, { scrollY: 1800 });
  const fake = pageSnapshot(KITCHEN_SINK, { scrollY: 1800 });

  assert.deepStrictEqual(fake, real);
  const snap = fake;
  assert.equal(snap.scrollState.scrollY, 1800);
  assert.match(snap.elements.find((e) => e.text === 'Far down')?.formatted ?? '', /^\[\d+\] a "Far down"$/, 'now in view');
  assert.match(snap.elements[0]?.formatted ?? '', /"Far down"$/, 'the in-viewport element is listed first, not the first in document order');
  assert.match(snap.elements.find((e) => e.text === 'Home')?.formatted ?? '', /\[off-screen\]$/, 'the header scrolled out of view');
  const farDown = snap.elements.findIndex((e) => e.text === 'Far down');
  const footer = snap.elements.findIndex((e) => e.text === 'Footer');
  assert.ok(farDown > -1 && farDown < footer, 'the nearer off-screen element is listed before the farther one');
});

test('maxElements cuts the list like the real one, and the ids run 1..n', () => {
  const real = realSnapshot(KITCHEN_SINK, { maxElements: 5 });
  const fake = pageSnapshot(KITCHEN_SINK, { maxElements: 5 });

  assert.deepStrictEqual(fake, real);
  assert.equal(fake.elementCount, 27, 'elementCount counts what was found, before the cap');
  assert.equal(fake.omittedCount, 22);
  assert.deepEqual(fake.elements.map((e) => e.id), [1, 2, 3, 4, 5]);
  assert.match(fake.elementsText, /\[\+22 more interactive elements not listed[^\]]*\]$/);
});

test('under the cap nothing is omitted: no marker line and omittedCount 0', () => {
  const real = realSnapshot(KITCHEN_SINK) as DomSnapshot;
  assert.equal(real.omittedCount, 0);
  assert.doesNotMatch(real.elementsText, /not listed/);
  assert.equal(real.elementsText.split('\n').length, 27);
});

/**
 * A listing page the way the gap describes it: 150 header and sidebar links first in the DOM, then
 * 150 product links far below the fold. Scrolled to the products, the window must start with the
 * in-viewport product elements, not with the header links that only come first in document order.
 */
const LISTING: PageSpec = {
  url: 'https://listing.test/',
  title: 'Listing',
  viewportHeight: 800,
  pageHeight: 13000,
  elements: [
    ...Array.from({ length: 150 }, (_, i) => link(`Header ${i}`, undefined, { y: i * 20 })),
    ...Array.from({ length: 150 }, (_, i) => link(`Product ${i}`, undefined, { y: 10000 + i * 20 })),
  ],
};

test('scrolled to the products, the in-viewport product elements are listed first and the marker names the omitted count', () => {
  const real = realSnapshot(LISTING, { scrollY: 10000 });
  const fake = pageSnapshot(LISTING, { scrollY: 10000 });
  assert.deepStrictEqual(fake, real);

  const snap = real as DomSnapshot;
  assert.equal(snap.elementCount, 300, 'elementCount counts every interactive element found, before the cap');
  assert.equal(snap.refs.length, 120, 'the cap itself is unchanged');
  assert.equal(snap.omittedCount, 180);
  assert.match(snap.elementsText, /\[\+180 more interactive elements not listed[^\]]*\]$/);
  assert.match(snap.elements[0].formatted, /"Product 0"$/, 'the window starts with an in-viewport product');
  assert.match(snap.elements[39].formatted, /"Product 39"$/, 'the last in-viewport product');
  assert.match(snap.elements[40].formatted, /"Product 40" \[off-screen\]$/, 'off-screen products follow, nearest first');
  assert.doesNotMatch(snap.elementsText, /"Header /, 'no header link uses the window while products are cut');
});

/** A name for number i made of letters only (0 is "q", 10 is "a"...), so that no two are the same after masking digits. */
function letters(i: number): string {
  return i.toString(26).replace(/\d/g, (d) => 'qrstuvwxyz'[Number(d)] ?? d);
}

test('a page whose text is one string matches the real extractor for a plain text page', () => {
  const page: PageSpec = { url: 'https://raw.test/a', pageHeight: 800, text: 'A README that is long enough to skip the sparse-page fallback of the real extractor, with no headings at all.' };
  assert.deepStrictEqual(pageSnapshot(page), realSnapshot(page));
});

test('a page whose text is one string is trimmed like the real extractor trims innerText', () => {
  const page: PageSpec = {
    url: 'https://raw.test/a',
    pageHeight: 800,
    text: '   \n  A README that is long enough to skip the sparse-page fallback of the real extractor, with no headings at all.  \n ',
  };
  const fake = pageSnapshot(page);
  assert.deepStrictEqual(fake, realSnapshot(page));
  assert.match(fake.pageText, /^A README/);
  assert.doesNotMatch(fake.pageText, /\s$/);
  // Trimmed first and cut after, so the blanks in front do not use up the 4500 characters. The words are all
  // different (not "word word word ..." and not "w1 w2 w3 ...", which the real extractor now collapses into
  // one "(N similar entries)"), and the cut text ends with the marker line.
  const words = Array.from({ length: 2000 }, (_, i) => `w${letters(i)}`).join(' ');
  const padded: PageSpec = { url: 'https://raw.test/b', pageHeight: 800, text: `${' '.repeat(1000)}${words}` };
  const paddedFake = pageSnapshot(padded);
  assert.deepStrictEqual(paddedFake, realSnapshot(padded));
  // Cut at a word boundary, with the note naming the shown and the full size (silent-truncation-no-marker).
  const cut = words.lastIndexOf(' ', 4500);
  assert.equal(paddedFake.pageText, `${words.slice(0, cut)}\n[page text truncated: showing ${cut} of ${words.length} characters - call read_page to read the whole page in parts]`);
});

test('a page text that is a list is read whole, one line per piece, short pieces and headings included, like the real extractor', () => {
  const long: PageSpec = {
    url: 'https://long.test/',
    pageHeight: 800,
    // Letters, not digits, tell the pieces apart: the real extractor collapses four or more in a row that
    // differ only by a number ("paragraph number 0" ... "paragraph number 89") into one line.
    text: [{ heading: 'All the paragraphs' }, '€5', ...Array.from({ length: 120 }, (_, i) => `paragraph number ${letters(i)}`)],
  };
  const fake = pageSnapshot(long);
  assert.deepStrictEqual(fake, realSnapshot(long));
  // No 90-piece cap and no minimum length: every piece is read, the heading as its plain text.
  assert.match(fake.pageText, /^All the paragraphs\n€5\nparagraph number q\n/);
  assert.match(fake.pageText, new RegExp(`paragraph number ${letters(119)}$`));
  assert.equal(fake.pageText.split('\n').length, 122);
});

test('a page with fewer than 10 characters of text says so, like the real extractor', () => {
  for (const text of [undefined, '', '   ', 'Error 42', ['ab', 'c']] as Array<PageText | undefined>) {
    const page: PageSpec = { url: 'https://empty.test/', pageHeight: 800, ...(text === undefined ? {} : { text }) };
    const fake = pageSnapshot(page);
    assert.deepStrictEqual(fake, realSnapshot(page), JSON.stringify(text));
    assert.match(fake.pageText, /\[no readable text on this page\]$/);
  }
});

// ---------------------------------------------------------------------------------------------
// The recorded snapshots of a real Chromium
// ---------------------------------------------------------------------------------------------

function recorded(name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(new URL(`./fixtures/snapshots/${name}.json`, import.meta.url), 'utf8')) as Record<string, unknown>;
}

/** What smoke.mjs --dump-snapshots writes: the snapshot without the locators the model never sees. */
function forModel(snapshot: DomSnapshot): Record<string, unknown> {
  const { elements: _elements, ...rest } = snapshot;
  return JSON.parse(JSON.stringify(rest)) as Record<string, unknown>;
}

const STORE: PageSpec = {
  url: 'http://127.0.0.1:8765/store.html',
  title: 'Framework Laptop 16 DIY Edition - Framework Store',
  viewportHeight: 772,
  pageHeight: 1050,
  text: [
    { heading: 'Framework Laptop 16 DIY Edition (AMD Ryzen 7040 Series)' },
    'Ein modularer 16-Zoll-Laptop, den du selbst zusammenbaust und später aufrüsten kannst.',
    'ab 1.399,00 EUR',
    'inkl. MwSt.',
    'Kostenloser Versand nach Deutschland.',
    'Lieferung in 5-7 Werktagen.',
    { heading: 'Prozessor' },
    'AMD Ryzen 7 7840HS',
    'AMD Ryzen 9 7940HS',
    { heading: 'Grafik' },
    'Ohne Grafikmodul',
    'Mit Grafikmodul AMD Radeon RX 7700S',
    'In den Warenkorb',
    { heading: 'Technische Daten' },
    'Display: 16 Zoll, 2560 x 1600, 165 Hz',
    'Speicher: bis 96 GB DDR5',
    'Gewicht: ab 2,1 kg',
    '30 Tage Rückgaberecht, 1 Jahr Garantie',
    'Technische Daten',
  ],
  elements: [
    link('Framework', 'index.html'),
    link('Laptops'),
    link('Marketplace'),
    link('Support'),
    input('search', { placeholder: 'Suche', label: 'Suche', form: 'search' }),
    button('Warenkorb (0)', { type: 'button' }),
    button('Land: Deutschland', { type: 'button' }),
    button('AMD Ryzen 7 7840HS', { type: 'button' }),
    button('AMD Ryzen 9 7940HS', { type: 'button' }),
    button('Ohne Grafikmodul', { type: 'button' }),
    button('Mit Grafikmodul AMD Radeon RX 7700S', { type: 'button' }),
    button('In den Warenkorb', { type: 'button' }),
    link('Technische Daten', undefined, { y: 900 }),
    link('Versand & Rückgabe', undefined, { y: 900 }),
    link('Impressum', undefined, { y: 900 }),
    link('Datenschutz', undefined, { y: 900 }),
  ],
};

for (const [name, page] of [['store', STORE]] as const) {
  test(`the description of the ${name} fixture page gives the snapshot a real Chromium recorded`, () => {
    const snapshot = pageSnapshot(page);
    const fixture = recorded(name);

    assert.deepEqual(forModel(snapshot), fixture);
    assert.deepEqual(Object.keys(snapshot).sort(), [...Object.keys(fixture), 'elements'].sort(), 'the same keys, plus the locators the dump leaves out');
  });
}

// ---------------------------------------------------------------------------------------------
// The description
// ---------------------------------------------------------------------------------------------

test('defaults: no title is "Untitled Page", the page is as tall as its lowest element, and an empty page has no elements and says it has no text', () => {
  const empty = pageSnapshot({ url: 'https://empty.test' });
  assert.equal(empty.title, 'Untitled Page');
  assert.equal(empty.url, 'https://empty.test/', 'the URL is shown the way Chrome shows it');
  assert.deepEqual(empty.scrollState, { scrollY: 0, pageHeight: 800, viewportHeight: 800 });
  assert.equal(empty.elementCount, 0);
  assert.equal(empty.elementsText, '');
  assert.equal(empty.pageText, '[no readable text on this page]');

  const tall = pageSnapshot({ url: 'https://tall.test/', elements: [link('Bottom', undefined, { y: 1980 })] });
  assert.equal(tall.scrollState.pageHeight, 2000);
});

test('a page text is cut at 4500 characters, in either form, and a cut text ends with the marker line', () => {
  // The cut is at a line or word boundary and the note names the shown and the full size (silent-truncation-no-marker).
  const marker = (shown: number, total: number) => `\n[page text truncated: showing ${shown} of ${total} characters - call read_page to read the whole page in parts]`;
  const long = Array.from({ length: 2000 }, (_, i) => `w${letters(i)}`).join(' ');
  const cut = long.lastIndexOf(' ', 4500);
  assert.equal(pageSnapshot({ url: 'https://a.test/', text: long }).pageText, `${long.slice(0, cut)}${marker(cut, long.length)}`);
  assert.equal(pageSnapshot({ url: 'https://a.test/', text: [long, long] }).pageText, `${long.slice(0, cut)}${marker(cut, long.length * 2 + 1)}`);
  // Exactly at the limit is not cut, so it has no marker.
  assert.equal(pageSnapshot({ url: 'https://a.test/', text: 'a'.repeat(4500) }).pageText, 'a'.repeat(4500));
  assert.equal(pageSnapshot({ url: 'https://a.test/', text: ['a'.repeat(4500)] }).pageText, 'a'.repeat(4500));
});

test('a typo in a page or element description throws instead of being ignored', () => {
  assert.throws(() => pageSnapshot({ url: 'https://a.test/', elemnts: [] } as never), /a page has an unknown key "elemnts"; known keys: url, title, text, elements/);
  assert.throws(() => pageSnapshot({ url: 'https://a.test/', elements: [{ tag: 'a', txt: 'x' } as never] }), /an element of https:\/\/a\.test\/ has an unknown key "txt"/);
  assert.throws(() => pageSnapshot({ url: 'https://a.test/', elements: [{ text: 'no tag' } as never] }), /needs a tag/);
  assert.throws(() => pageSnapshot({ title: 'no url' } as never), /a page needs a url/);
  assert.throws(() => fakeDom({ pages: [], navigationDelay: 5 } as never), /unknown key "navigationDelay"/);
  assert.throws(() => fakeDom({ pages: [{ url: 'https://a.test' }, { url: 'https://a.test/' }] }), /the page https:\/\/a\.test\/ is declared twice/);
});

// ---------------------------------------------------------------------------------------------
// The fake content script
// ---------------------------------------------------------------------------------------------

const SHOP = 'https://shop.test/';
const LAPTOPS = 'https://shop.test/laptops';
const PRODUCT = 'https://shop.test/laptops/16';

function shopPages(): PageSpec[] {
  return [
    {
      url: SHOP,
      title: 'Shop',
      text: [{ heading: 'Willkommen' }, 'Alles fuer den Laptop.'],
      elements: [
        link('Laptops', LAPTOPS),
        input('search', { placeholder: 'Suche', label: 'Suche', goes: LAPTOPS }),
        input('checkbox', { label: 'Newsletter' }),
        button('Warenkorb', { type: 'button' }),
        link('Impressum', undefined, { y: 1500 }),
      ],
      pageHeight: 2000,
    },
    {
      url: LAPTOPS,
      title: 'Laptops',
      text: [{ heading: 'Laptops' }, 'Framework Laptop 16 ab 1.399,00 EUR'],
      elements: [link('Home', SHOP), link('Framework Laptop 16', PRODUCT)],
    },
    { url: PRODUCT, title: 'Laptop 16', text: 'Framework Laptop 16 - ab 1.399,00 EUR', elements: [link('Zurueck', LAPTOPS)] },
  ];
}

interface Rig {
  site: FakeDom;
  fc: FakeChrome;
  /** chrome.tabs.sendMessage(101, message), the way the engine does. */
  send(message: unknown): Promise<any>;
  /** Wait for the page to open that an action started, and for the events it caused. */
  landed(): Promise<void>;
  updates: Array<[number, string | undefined]>;
}

function rig(startUrl = SHOP, pages: PageSpec[] = shopPages()): Rig {
  const site = fakeDom({ pages });
  const fc = fakeChrome({ tabs: { list: [{ id: 101, url: startUrl }] }, dom: true });
  site.attach(fc, 101);
  const updates: Array<[number, string | undefined]> = [];
  fc.chrome.tabs.onUpdated.addListener((id: number, info: { status?: string }) => updates.push([id, info.status]));
  return {
    site,
    fc,
    send: (message) => fc.chrome.tabs.sendMessage(101, message),
    landed: async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await fc.settle();
    },
    updates,
  };
}

const snapshotMessage = { action: 'GET_DOM_SNAPSHOT', payload: { showBadges: true } };
const act = (payload: Record<string, unknown>) => ({ action: 'EXECUTE_ACTION', payload });
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

test('GET_DOM_SNAPSHOT answers { success, data } with the snapshot of the page the tab is on', async () => {
  const r = rig();
  const answer = await r.send(snapshotMessage);

  assert.equal(answer.success, true);
  assert.deepEqual(answer.data, wire(pageSnapshot(shopPages()[0]!)), 'what the engine gets over the message wire');
  assert.equal(answer.data.title, 'Shop');
  assert.equal(r.site.reads.length, 1);
  assert.equal(r.site.reads[0]?.tabId, 101);
  r.site.assertClean();
  r.fc.assertClean();
});

test('maxElements in the payload cuts the list', async () => {
  const r = rig();
  const answer = await r.send({ action: 'GET_DOM_SNAPSHOT', payload: { maxElements: 2 } });
  assert.equal(answer.data.elementCount, 5, 'the count is what was found, before the cap');
  assert.equal(answer.data.omittedCount, 3);
  assert.equal(answer.data.elementsText.split('\n').length, 3, 'two element lines plus the marker line');
  assert.match(answer.data.elementsText, /\[\+3 more interactive elements not listed/);
});

test('a click on a link answers first, then the tab opens the page and tabs.onUpdated fires after the reply', async () => {
  const r = rig();
  await r.send(snapshotMessage);

  const reply = await r.send(act({ action: 'click', element_id: 1 }));
  assert.deepEqual(reply, { success: true, label: 'Laptops', message: 'Clicked element [1] ("Laptops")' });
  assert.equal(r.fc.tabs.get(101)?.url, SHOP, 'the page has not moved when the reply comes');
  assert.deepEqual(r.updates, []);

  await r.landed();
  assert.equal(r.fc.tabs.get(101)?.url, LAPTOPS);
  assert.deepEqual(r.updates, [[101, 'loading'], [101, 'complete']]);
  assert.equal((await r.send(snapshotMessage)).data.title, 'Laptops', 'the next read sees the new page');
  assert.deepEqual(r.site.actions.map((a) => [a.tabId, a.url, a.payload.action, a.result.success]), [[101, SHOP, 'click', true]]);
});

test('ids are numbered from 1 on every snapshot, and an id the last snapshot did not list is not resolvable', async () => {
  const r = rig();
  assert.deepEqual(await r.send(act({ action: 'click', element_id: 1 })), { success: false, error: 'Element [1] no longer resolvable in DOM.' }, 'no snapshot yet');

  await r.send(snapshotMessage);
  assert.deepEqual(await r.send(act({ action: 'click', element_id: 9 })), { success: false, error: 'Element [9] no longer resolvable in DOM.' });
  assert.deepEqual(await r.send(act({ action: 'click' })), { success: false, error: 'Element [undefined] no longer resolvable in DOM.' });
  r.site.assertClean();
  assert.equal(r.updates.length, 0, 'a failed click moves nothing');
});

test('typing sets the value that the next snapshot shows, and submit opens the page of a form that leads on', async () => {
  const r = rig();
  await r.send(snapshotMessage);

  const reply = await r.send(act({ action: 'type', element_id: 2, text: 'framework laptop 16', submit: true }));
  assert.deepEqual(reply, { success: true, label: 'Suche', submitted: true, message: 'Typed "framework laptop 16" into element [2] ("Suche")' });
  await r.landed();
  assert.equal(r.fc.tabs.get(101)?.url, LAPTOPS);

  // Back on the shop page the field starts empty again: a new page load is a new document,
  // even though nothing read the laptops page in between.
  await r.send(act({ action: 'navigate', url: SHOP }));
  await r.landed();
  assert.match((await r.send(snapshotMessage)).data.elementsText, /\[2\] input\[search\] "Suche" \(placeholder="Suche" label="Suche"\)/);
});

test('the typed value stays on the page while the tab stays on it', async () => {
  const r = rig();
  await r.send(snapshotMessage);
  await r.send(act({ action: 'type', element_id: 2, text: 'ryzen' }));

  assert.match((await r.send(snapshotMessage)).data.elementsText, /\[2\] input\[search\] "Suche" \(placeholder="Suche" label="Suche" value="ryzen"\)/);
  assert.equal(r.updates.length, 0, 'no submit, no navigation');
});

test('typing into something that is not a text field gives the real content script error', async () => {
  const r = rig();
  await r.send(snapshotMessage);
  assert.deepEqual(await r.send(act({ action: 'type', element_id: 1, text: 'x' })), {
    success: false,
    error: 'Element <a> is not a text field, dropdown or editable region, so it cannot be typed into.',
  });
  assert.deepEqual(await r.send(act({ action: 'type', element_id: 4, text: 'x' })), {
    success: false,
    error: 'Element <button> is not a text field, dropdown or editable region, so it cannot be typed into.',
  });
  // A checkbox is an <input>, and the real content script types into every <input> (see the
  // comparison with the real doType below), so it is not in this list.
});

// ---------------------------------------------------------------------------------------------
// The type action, against the REAL ActionExecutor doType
// ---------------------------------------------------------------------------------------------

/** setFieldValue reads the native setter from HTMLInputElement.prototype and HTMLTextAreaElement.prototype. */
class HTMLInputElementStub {
  #value = '';
  get value(): string {
    return this.#value;
  }
  set value(next: string) {
    this.#value = String(next);
  }
}
class HTMLTextAreaElementStub extends HTMLInputElementStub {}
class InputEventStub extends Event {}

/** A node with what doType, setFieldValue and describeElement touch, built from an element description. */
function typableNode(spec: ElementSpec): Record<string, unknown> {
  const tag = spec.tag.toLowerCase();
  const attributes: Record<string, string> = {};
  if (spec.type) attributes.type = spec.type;
  if (spec.placeholder) attributes.placeholder = spec.placeholder;
  if (spec.label) attributes['aria-label'] = spec.label;
  if (spec.role) attributes.role = spec.role;
  if (spec.name) attributes.name = spec.name;
  const node: any = tag === 'input' ? new HTMLInputElementStub() : tag === 'textarea' ? new HTMLTextAreaElementStub() : {};
  let text = spec.text ?? '';
  Object.defineProperty(node, 'textContent', { get: () => text, set: (next: string) => { text = String(next); } });
  Object.defineProperty(node, 'innerText', { get: () => text });
  Object.assign(node, {
    tagName: tag.toUpperCase(),
    style: {},
    isContentEditable: spec.editable === true,
    scrollIntoView: () => {},
    focus: () => {},
    dispatchEvent: () => true,
    closest: () => null,
    getAttribute: (name: string) => attributes[name] ?? null,
  });
  if (spec.value !== undefined && (tag === 'input' || tag === 'textarea')) node.value = spec.value;
  return node;
}

/** What the real doType answers for typing `text` into an element like this one. */
function realTypeReply(spec: ElementSpec, text: unknown, submit: unknown = false): unknown {
  const node = typableNode(spec);
  const fakeWindow: Record<string, any> = {
    domCompressor: { getElement: () => node, elements: [] },
    HTMLInputElement: HTMLInputElementStub,
    HTMLTextAreaElement: HTMLTextAreaElementStub,
    InputEvent: InputEventStub,
    KeyboardEvent: Event,
    MouseEvent: Event,
    CSS: { escape: (s: string) => s }
  };
  const fakeDocument = { contains: () => true };
  const executor = new ActionExecutor(fakeDocument as any, fakeWindow as any);
  return executor.doType(1, text, submit);
}

/** What the fake content script answers for the same element, alone on a page. */
async function fakeTypeReply(spec: ElementSpec, text: unknown, submit?: unknown): Promise<unknown> {
  const r = rig('https://fields.test/', [{ url: 'https://fields.test/', title: 'Fields', elements: [spec] }]);
  await r.send(snapshotMessage);
  return r.send(act({ action: 'type', element_id: 1, text, submit }));
}

const TYPE_CASES: Array<[string, ElementSpec, boolean]> = [
  ['a text input', input('text', { placeholder: 'Name' }), true],
  ['a search input', input('search', { label: 'Suche' }), true],
  ['a password input', input('password', { label: 'Password' }), true],
  ['a checkbox', input('checkbox', { label: 'Newsletter' }), true],
  ['a radio button', input('radio', { label: 'Yes', value: 'yes' }), true],
  ['a range input', input('range', { label: 'Volume' }), true],
  ['a textarea', { tag: 'textarea', placeholder: 'Notes' }, true],
  ['a div with role textbox and a label', { tag: 'div', role: 'textbox', label: 'rich' }, true],
  ['a div with role textbox and old text', { tag: 'div', role: 'textbox', text: 'old text' }, true],
  ['a contenteditable div', { tag: 'div', editable: true, text: 'editable region' }, true],
  ['a link', link('Laptops', 'https://shop.test/laptops'), false],
  ['a button', button('Warenkorb', { type: 'button' }), false],
  ['a div with role tab', { tag: 'div', role: 'tab', text: 'Overview' }, false],
  ['a div with role button', { tag: 'div', role: 'button', text: 'Clickable div' }, false],
];

for (const [name, spec, typable] of TYPE_CASES) {
  test(`type into ${name}: the fake answers what the real doType answers`, async () => {
    const real = realTypeReply(spec, 'typed text') as { success: boolean };
    assert.equal(real.success, typable, `the real doType: ${JSON.stringify(real)}`);
    assert.deepEqual(await fakeTypeReply(spec, 'typed text'), real);
  });
}

test('type with a missing or odd text answers what the real doType answers (a missing text is quoted as "undefined")', async () => {
  for (const [name, spec] of TYPE_CASES.filter(([, , typable]) => typable).map(([label, el]) => [label, el] as const)) {
    for (const text of [undefined, null, 5, 0, true, false, '', ['a', 'b']]) {
      const real = realTypeReply(spec, text);
      assert.deepEqual(await fakeTypeReply(spec, text), real, `${name}, text ${JSON.stringify(text)}`);
    }
  }
  assert.match((realTypeReply(input('text', { label: 'x' }), undefined) as { message: string }).message, /^Typed "undefined" into element \[1\]/);
});

test('type with a submit that is truthy but not true submits and is answered as submitted, like the real doType', async () => {
  const spec = input('search', { label: 'Suche' });
  for (const submit of ['yes', 1, true, false, 0, '', null, undefined]) {
    assert.deepEqual(await fakeTypeReply(spec, 'abc', submit), realTypeReply(spec, 'abc', submit), `submit ${JSON.stringify(submit)}`);
  }
});

test('typing into a div with role textbox or a contenteditable div replaces its text, and the next snapshot shows it', async () => {
  const r = rig('https://fields.test/', [{
    url: 'https://fields.test/',
    title: 'Fields',
    elements: [{ tag: 'div', role: 'textbox', text: 'old text' }, { tag: 'div', editable: true, text: 'region' }],
  }]);
  await r.send(snapshotMessage);
  await r.send(act({ action: 'type', element_id: 1, text: 'new text' }));
  const after = (await r.send(snapshotMessage)).data;
  assert.match(after.elementsText, /\[1\] div "new text"/);
  assert.match(after.elementsText, /\[2\] div "region"/, 'the other element is untouched');
});

test('typing into a checkbox sets its value like the real code and does not tick it', async () => {
  const r = rig('https://fields.test/', [{ url: 'https://fields.test/', title: 'Fields', elements: [input('checkbox', { label: 'Newsletter' })] }]);
  await r.send(snapshotMessage);
  await r.send(act({ action: 'type', element_id: 1, text: 'yes' }));
  const element = (await r.send(snapshotMessage)).data.elements[0];
  assert.equal(element.checked, false, 'typing is not a click');
  assert.match((await r.send(snapshotMessage)).data.elementsText, /value="yes"/);
});

test('a click flips a checkbox, and a disabled button does nothing but still answers', async () => {
  const pages: PageSpec[] = [{ url: SHOP, elements: [input('checkbox', { label: 'Newsletter' }), button('Buy', { disabled: true, goes: LAPTOPS })] }, { url: LAPTOPS }];
  const r = rig(SHOP, pages);
  await r.send(snapshotMessage);

  await r.send(act({ action: 'click', element_id: 1 }));
  assert.match((await r.send(snapshotMessage)).data.elementsText, /\[1\] input\[checkbox\] "Newsletter" \(label="Newsletter" checked value="on"\)/);
  await r.send(act({ action: 'click', element_id: 1 }));
  assert.doesNotMatch((await r.send(snapshotMessage)).data.elementsText, /checked/);

  assert.equal((await r.send(act({ action: 'click', element_id: 2 }))).success, true);
  await r.landed();
  assert.equal(r.fc.tabs.get(101)?.url, SHOP, 'the disabled button did not open its page');
});

test('the label a reply quotes is the first of aria-label, placeholder, text, name and value, cut at 48 characters', async () => {
  const pages: PageSpec[] = [
    {
      url: SHOP,
      elements: [
        { tag: 'button', text: 'Visible text', label: 'Aria label wins' },
        input('text', { placeholder: 'Placeholder', name: 'q' }),
        input('text', { name: 'query-field' }),
        link('x'.repeat(60)),
        { tag: 'textarea' },
        input('radio', { label: 'Yes' }),
      ],
    },
  ];
  const r = rig(SHOP, pages);
  await r.send(snapshotMessage);

  assert.equal((await r.send(act({ action: 'click', element_id: 1 }))).label, 'Aria label wins');
  assert.equal((await r.send(act({ action: 'type', element_id: 2, text: 'a' }))).label, 'Placeholder');
  assert.equal((await r.send(act({ action: 'type', element_id: 3, text: 'b' }))).label, 'query-field');
  assert.equal((await r.send(act({ action: 'click', element_id: 4 }))).label, `${'x'.repeat(47)}\u2026`);
  // A field with nothing else to call it by is named by what was just typed into it, like the real one.
  const typed = await r.send(act({ action: 'type', element_id: 5, text: 'hello' }));
  assert.deepEqual(typed, { success: true, label: 'hello', submitted: false, message: 'Typed "hello" into element [5] ("hello")' });

  await r.send(act({ action: 'click', element_id: 6 }));
  await r.send(act({ action: 'click', element_id: 6 }));
  assert.match((await r.send(snapshotMessage)).data.elementsText, /\[6\] input\[radio\] "Yes" \(label="Yes" checked value="on"\)/, 'a radio stays selected when clicked again');
});

test('scroll moves the page by the real step, clamped to its ends, says how far, and brings off-screen elements into view', async () => {
  const r = rig();
  const before = (await r.send(snapshotMessage)).data;
  assert.match(before.elementsText, /\[5\] a "Impressum" \[off-screen\]/);

  assert.deepEqual(await r.send(act({ action: 'scroll', direction: 'down' })), {
    success: true,
    result: { moved: 640, label: 'the page', top: 640, max: 1200, height: 800, atTop: false, atBottom: false }
  });
  assert.equal((await r.send(act({ action: 'scroll' }))).result.moved, 560, 'the second step stops at the end');
  const bottom = (await r.send(snapshotMessage)).data;
  assert.equal(bottom.scrollState.scrollY, 1200, 'the bottom is pageHeight - viewportHeight');
  assert.match(bottom.elementsText, /^\[1\] a "Impressum"$/m, 'in view now, and listed first');
  const stuck = await r.send(act({ action: 'scroll' }));
  assert.equal(stuck.result.moved, 0, 'at the bottom nothing moves, and the reply says so');
  assert.equal(stuck.result.atBottom, true);
  await r.send(act({ action: 'scroll', direction: 'up' }));
  await r.send(act({ action: 'scroll', direction: 'up' }));
  assert.equal((await r.send(snapshotMessage)).data.scrollState.scrollY, 0);
});

/**
 * The real ActionExecutor on a stub window whose page scrolls (no inner panel), for the actions
 * that need no element: scrollBy moves scrollY like a browser, clamped to the page.
 */
function realExecutor({ pageHeight = 5000, innerHeight = 800, scrollY = 0 } = {}): { run: (payload: Record<string, unknown>) => Promise<any>; win: Record<string, any> } {
  const root = { scrollHeight: pageHeight, clientHeight: innerHeight, getBoundingClientRect: () => ({ left: 0, top: 0, right: 1280, bottom: pageHeight }) };
  const fakeWindow: Record<string, any> = {
    domCompressor: { getElement: () => null, elements: [] },
    innerWidth: 1280,
    innerHeight,
    scrollX: 0,
    scrollY,
    scrollBy(options: { top: number }) { this.scrollY = Math.min(pageHeight - innerHeight, Math.max(0, this.scrollY + Number(options.top))); },
    getComputedStyle: () => ({ overflowY: 'visible' }),
    HTMLInputElement: HTMLInputElementStub,
    HTMLTextAreaElement: HTMLTextAreaElementStub,
    InputEvent: InputEventStub,
    KeyboardEvent: Event,
    MouseEvent: Event,
    CSS: { escape: (s: string) => s }
  };
  const fakeDocument = {
    contains: () => true,
    activeElement: { dispatchEvent: () => true },
    body: { dispatchEvent: () => true },
    documentElement: root,
    scrollingElement: root,
    querySelectorAll: () => []
  };
  const executor = new ActionExecutor(fakeDocument as any, fakeWindow as any);
  // The message crosses the wire as JSON, so a missing value is a missing key.
  return { run: (payload) => executor.execute(JSON.parse(JSON.stringify(payload))), win: fakeWindow };
}

test('scroll answers like the real content script: the same step, the same edges, the same reply', async () => {
  for (const [scrollY, direction] of [[1000, 'down'], [1000, 'up'], [0, 'up'], [4100, 'down'], [4200, 'down'], [300, 'up']] as const) {
    const real = realExecutor({ pageHeight: 5000, innerHeight: 800, scrollY });
    const reply = await real.run({ action: 'scroll', direction });
    const r = rig('https://long.test/', [{ url: 'https://long.test/', title: 'Long', pageHeight: 5000, scrollY, elements: [] }]);
    await r.send(snapshotMessage);
    assert.deepEqual(await r.send(act({ action: 'scroll', direction })), reply, `${direction} from ${scrollY}`);
    assert.equal((await r.send(snapshotMessage)).data.scrollState.scrollY, real.win.scrollY, `${direction} from ${scrollY}`);
  }
});

test('press_key is not a content-script verb (it is CDP only), here as in the real executor', async () => {
  const r = rig();
  await r.send(snapshotMessage);
  await assert.rejects(realExecutor().run({ action: 'press_key', key: 'Enter' }), /Unknown action: press_key/);
  assert.deepEqual(await r.send(act({ action: 'press_key', key: 'Enter' })), { success: false, error: 'Unknown action: press_key' });
});

test('navigate opens a declared page, and go_back and go_forward walk the pages this fake opened', async () => {
  const r = rig();
  await r.send(snapshotMessage);
  assert.deepEqual(await r.send(act({ action: 'navigate', url: LAPTOPS })), { success: true, message: `Navigating to ${LAPTOPS}` });
  await r.landed();
  await r.send(snapshotMessage);
  await r.send(act({ action: 'click', element_id: 2 }));
  await r.landed();
  assert.equal(r.fc.tabs.get(101)?.url, PRODUCT);

  assert.deepEqual(await r.send(act({ action: 'go_back' })), { success: true, message: 'Going back' });
  await r.landed();
  assert.equal(r.fc.tabs.get(101)?.url, LAPTOPS);
  await r.send(act({ action: 'go_back' }));
  await r.landed();
  assert.equal(r.fc.tabs.get(101)?.url, SHOP);
  assert.deepEqual(await r.send(act({ action: 'go_back' })), { success: true, message: 'Going back' }, 'nothing before the first page: it answers and stays');
  await r.landed();
  assert.equal(r.fc.tabs.get(101)?.url, SHOP);

  assert.deepEqual(await r.send(act({ action: 'go_forward' })), { success: true, message: 'Going forward' });
  await r.landed();
  assert.equal(r.fc.tabs.get(101)?.url, LAPTOPS);
});

test('read_page and wait answer like the real ones, and wait does not really wait', async () => {
  const r = rig(PRODUCT);
  await r.send(snapshotMessage);
  assert.deepEqual(await r.send(act({ action: 'read_page' })), {
    success: true,
    message: 'Page text (part 1 of 1, chars 1-37 of 37, end of the text):\n"""\nFramework Laptop 16 - ab 1.399,00 EUR\n"""',
    // The note travels with the result, so the model-facing one-shot and step record carry it (silent-truncation-no-marker).
    result: { pageText: 'Framework Laptop 16 - ab 1.399,00 EUR', note: 'part 1 of 1, chars 1-37 of 37, end of the text', part: 1, parts: 1, hidesLines: false },
  });
  assert.match((await r.send(act({ action: 'read_page', part: 2 }))).error, /only 1 part, so there is no part 2/);
  const started = Date.now();
  assert.deepEqual(await r.send(act({ action: 'wait', amount: 30 })), { success: true, message: 'Waited 30s' });
  assert.deepEqual(await r.send(act({ action: 'wait' })), { success: true, message: 'Waited 1s' });
  assert.ok(Date.now() - started < 2_000);
});

test('an unknown verb gets the real "Unknown action" reply, not a test mistake', async () => {
  const r = rig();
  assert.deepEqual(await r.send(act({ action: 'hover', element_id: 1 })), { success: false, error: 'Unknown action: hover' });
  r.site.assertClean();
});

test('navigationDelayMs holds the new page back that long', async () => {
  const site = fakeDom({ pages: shopPages(), navigationDelayMs: 40 });
  const fc = fakeChrome({ tabs: { list: [{ id: 101, url: SHOP }] }, dom: true });
  site.attach(fc, 101);
  await fc.chrome.tabs.sendMessage(101, snapshotMessage);
  await fc.chrome.tabs.sendMessage(101, act({ action: 'click', element_id: 1 }));

  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(fc.tabs.get(101)?.url, SHOP);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(fc.tabs.get(101)?.url, LAPTOPS);
});

test('a tab that was closed before the page opened is left alone', async () => {
  const r = rig();
  await r.send(snapshotMessage);
  await r.send(act({ action: 'click', element_id: 1 }));
  r.fc.tabs.close(101);
  await r.landed();
  assert.equal(r.fc.tabs.get(101), undefined);
});

// ---------------------------------------------------------------------------------------------
// Test mistakes
// ---------------------------------------------------------------------------------------------

test('a tab on a URL with no declared page throws with the fix, and is kept as a violation', async () => {
  const r = rig('https://unknown.test/x');
  assert.throws(() => r.send(snapshotMessage), /fakeDom: tab 101 is at https:\/\/unknown\.test\/x, but no page for that URL was declared - add it to fakeDom\(\{ pages: \[\{ url: 'https:\/\/unknown\.test\/x', \.\.\. \}\] \}\)/);
  assert.equal(r.site.violations.length, 1);
  assert.throws(() => r.site.assertClean(), /1 test mistake\(s\) were thrown to the code under test/);
});

test('a link to a page that was not declared throws when it is clicked, and so does navigate', async () => {
  const pages: PageSpec[] = [{ url: SHOP, elements: [link('Elsewhere', 'https://elsewhere.test/'), link('Home')] }];
  const r = rig(SHOP, pages);
  await r.send(snapshotMessage);

  assert.throws(() => r.send(act({ action: 'click', element_id: 1 })), /clicking element \[1\] \("Elsewhere"\) leads to https:\/\/elsewhere\.test\/, but no page for that URL was declared/);
  assert.throws(() => r.send(act({ action: 'navigate', url: 'https://nowhere.test' })), /the navigate action leads to https:\/\/nowhere\.test\/, but no page/);
  assert.equal((await r.send(act({ action: 'click', element_id: 2 }))).success, true, 'a link without a target is fine, it just does nothing');
  assert.equal(r.site.violations.length, 2);
  await r.landed();
  assert.equal(r.fc.tabs.get(101)?.url, SHOP);
});

test('typing into a <select> is not simulated, and says how to script it', async () => {
  const pages: PageSpec[] = [{ url: SHOP, elements: [{ tag: 'select', label: 'Country' }] }];
  const r = rig(SHOP, pages);
  await r.send(snapshotMessage);

  assert.throws(() => r.send(act({ action: 'type', element_id: 1, text: 'DE' })), /a <select>, is not simulated/);
  assert.equal(r.site.violations.length, 1);
});

test('the fake content script can be replaced for one message with fc.dom.on, which is how a test scripts what is not simulated', async () => {
  const r = rig();
  await r.send(snapshotMessage);
  r.fc.dom.on(101, 'EXECUTE_ACTION', { success: true, message: 'scripted' });
  assert.deepEqual(await r.send(act({ action: 'select', element_id: 1 })), { success: true, message: 'scripted' });
  r.site.assertClean();
});

test('attach on a fakeChrome without dom explains how to declare it', () => {
  const site = fakeDom({ pages: shopPages() });
  const fc = fakeChrome({ tabs: { list: [{ id: 101, url: SHOP }] } });
  assert.throws(() => site.attach(fc, 101), /fc\.dom is not available because dom was not declared/);
});

test('the elements of one tab do not leak into another', async () => {
  const site = fakeDom({ pages: shopPages() });
  const fc = fakeChrome({ tabs: { list: [{ id: 101, url: SHOP }, { id: 102, url: SHOP }] }, dom: true });
  site.attach(fc, 101);
  site.attach(fc, 102);
  await fc.chrome.tabs.sendMessage(101, snapshotMessage);
  await fc.chrome.tabs.sendMessage(102, snapshotMessage);
  await fc.chrome.tabs.sendMessage(101, act({ action: 'type', element_id: 2, text: 'only here' }));

  assert.match((await fc.chrome.tabs.sendMessage(101, snapshotMessage)).data.elementsText, /value="only here"/);
  assert.doesNotMatch((await fc.chrome.tabs.sendMessage(102, snapshotMessage)).data.elementsText, /only here/);
  assert.deepEqual(site.reads.map((r) => r.tabId), [101, 102, 101, 102]);
});

test('elements of a page description are not changed by what the fake content script does to them', async () => {
  const pages = shopPages();
  const before = structuredClone(pages);
  const r = rig(SHOP, pages);
  await r.send(snapshotMessage);
  await r.send(act({ action: 'type', element_id: 2, text: 'x' }));
  await r.send(act({ action: 'click', element_id: 3 }));

  assert.deepEqual(pages, before);
  const element: ElementSpec | undefined = r.site.pages[0]?.elements?.[2];
  assert.equal(element?.checked, undefined);
});

test('real domCompressor.getSnapshot() keys match fakeDom snapshot keys exactly', () => {
  const real = realSnapshot(KITCHEN_SINK) as Record<string, unknown>;
  const fake = pageSnapshot(KITCHEN_SINK) as unknown as Record<string, unknown>;
  const realKeys = Object.keys(real).sort();
  const fakeKeys = Object.keys(fake).sort();
  assert.deepStrictEqual(fakeKeys, realKeys);

  // Assert contract values
  assert.ok(Array.isArray(real.refs), 'refs must be an array');
  assert.ok(Array.isArray(real.shownRefs), 'shownRefs must be an array');
  assert.equal(typeof real.domain, 'string');
  assert.ok((real.domain as string).length > 0, 'domain must be non-empty');
  assert.deepStrictEqual(real.shownRefs, real.refs, 'shownRefs must equal refs');
  assert.deepStrictEqual(real.refs, (real.elements as any[]).map((e: any) => e.id), 'refs must match element ids');
  assert.ok(real.scrollState && typeof real.scrollState === 'object', 'scrollState must exist');
});

test('rendered element badges never pollute extractPageText()', () => {
  const badgeContainer = {
    id: 'scoutfox-badge-container',
    style: { display: '' },
    textContent: '1 2 3 4 5 6 7 8 9 10',
    innerText: '1 2 3 4 5 6 7 8 9 10',
  };
  const body = {
    nodeType: 1,
    get innerText() {
      return badgeContainer.style.display === 'none' ? 'Genuine page content only.' : '1 2 3 4 5 6 7 8 9 10 Genuine page content only.';
    },
    textContent: 'Genuine page content only.',
    querySelectorAll: () => [],
  };
  const fakeWindow = {
    location: { href: 'https://shop.test/', hostname: 'shop.test' },
    innerWidth: 1200,
    innerHeight: 800,
    scrollY: 0,
  };
  const fakeDocument = {
    title: 'Shop',
    contentType: 'text/html',
    documentElement: { scrollHeight: 800 },
    body,
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: (id: string) => (id === 'scoutfox-badge-container' ? badgeContainer : null),
  };
  const text = withGlobals(
    {
      window: fakeWindow,
      document: fakeDocument,
      Node: { ELEMENT_NODE: 1 },
      CSS: { escape: (s: string) => s },
    },
    () => {
      const compressor = new DOMCompressor();
      return compressor.extractPageText();
    }
  );
  assert.equal(text, 'Genuine page content only.');
  assert.doesNotMatch(text, /1 2 3 4 5/);
  assert.equal(badgeContainer.style.display, '');
});
