/**
 * Tests for tests/helpers/fakeDom.ts, the page snapshots and the fake content script.
 *
 * A fake that builds the wrong snapshot is worse than no fake: every engine test built on it would
 * pass against a page the real content script never produces. So the first half of this file pins
 * the shape to the real thing, two ways:
 *   - the same page description, run through the REAL content/domCompressor.js (loaded with
 *     new Function against a small fake DOM, like the other domCompressor tests do), must give a
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
import type { DomSnapshot, ElementSpec, FakeDom, PageSpec } from './helpers/fakeDom.ts';

// ---------------------------------------------------------------------------------------------
// The real DOMCompressor, against a fake DOM built from the same description
// ---------------------------------------------------------------------------------------------

const SOURCE = fs.readFileSync(new URL('../content/domCompressor.js', import.meta.url), 'utf8');

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
  setAttribute(): void;
  checkVisibility(): boolean;
  getBoundingClientRect(): { width: number; height: number; top: number; bottom: number; left: number; right: number };
}

/**
 * Runs content/domCompressor.js on a page made of the given elements, all direct children of <body>
 * (so cssPath is the plain tag path), and returns the real getSnapshot() result. The page needs an
 * explicit pageHeight, because scrollHeight is a fact of the browser that the description has to give.
 */
function realSnapshot(page: PageSpec, options: { scrollY?: number; maxElements?: number } = {}): unknown {
  assert.notEqual(page.pageHeight, undefined, 'give the page a pageHeight');
  const scrollY = options.scrollY ?? 0;
  const text = page.text;
  const textNodes = Array.isArray(text)
    ? text.map((piece) => ({
        tagName: typeof piece === 'string' ? 'P' : 'H2',
        textContent: typeof piece === 'string' ? piece : piece.heading,
        getBoundingClientRect: () => ({ top: 0, bottom: 20 }),
      }))
    : [];
  const body = {
    nodeType: 1,
    // The real extractor reads a plain string page from body.innerText.
    innerText: typeof text === 'string' ? text : '',
    textContent: '',
    querySelectorAll: () => textNodes,
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
  const load = new Function('window', 'document', 'Node', 'CSS', `${SOURCE}\nreturn window.domCompressorInstance;`);
  const compressor = load(fakeWindow, fakeDocument, { ELEMENT_NODE: 1 }, { escape: (s: string) => s });
  return compressor.getSnapshot(options.maxElements === undefined ? {} : { maxElements: options.maxElements });
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
  assert.match(snap.elements[0]?.formatted ?? '', /\[off-screen\]$/, 'the header scrolled out of view');
});

test('maxElements cuts the list like the real one, and the ids run 1..n', () => {
  const real = realSnapshot(KITCHEN_SINK, { maxElements: 5 });
  const fake = pageSnapshot(KITCHEN_SINK, { maxElements: 5 });

  assert.deepStrictEqual(fake, real);
  assert.equal(fake.elementCount, 5);
  assert.deepEqual(fake.elements.map((e) => e.id), [1, 2, 3, 4, 5]);
});

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
  // Trimmed first and cut after, so the blanks in front do not use up the 4500 characters.
  const padded: PageSpec = { url: 'https://raw.test/b', pageHeight: 800, text: `${' '.repeat(1000)}${'word '.repeat(2000)}` };
  assert.deepStrictEqual(pageSnapshot(padded), realSnapshot(padded));
  assert.equal(pageSnapshot(padded).pageText.length, 4500);
});

test('a page text that is a list is cut at its first 90 pieces before the short ones are dropped, like the real extractor', () => {
  const long: PageSpec = {
    url: 'https://long.test/',
    pageHeight: 800,
    text: Array.from({ length: 120 }, (_, i) => `paragraph number ${i}`),
  };
  const fake = pageSnapshot(long);
  assert.deepStrictEqual(fake, realSnapshot(long));
  assert.match(fake.pageText, /paragraph number 89$/);
  assert.doesNotMatch(fake.pageText, /paragraph number 90/);

  // The cap counts pieces, not survivors: 45 pieces that are too short to keep use up half of it.
  const padded: PageSpec = {
    url: 'https://padded.test/',
    pageHeight: 800,
    text: [...Array.from({ length: 45 }, () => 'ab'), ...Array.from({ length: 75 }, (_, i) => `paragraph ${i}`)],
  };
  const paddedFake = pageSnapshot(padded);
  assert.deepStrictEqual(paddedFake, realSnapshot(padded));
  assert.match(paddedFake.pageText, /paragraph 44$/);
  assert.equal(paddedFake.pageText.split('\n').length, 45);
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
  viewportHeight: 779,
  pageHeight: 1050,
  text: [
    { heading: 'Framework Laptop 16 DIY Edition (AMD Ryzen 7040 Series)' },
    'Ein modularer 16-Zoll-Laptop, den du selbst zusammenbaust und später aufrüsten kannst.',
    'ab 1.399,00 EUR',
    'inkl. MwSt.',
    'Kostenloser Versand nach Deutschland.',
    'Lieferung in 5-7 Werktagen.',
    { heading: 'Prozessor' },
    { heading: 'Grafik' },
    'In den Warenkorb',
    { heading: 'Technische Daten' },
    'Display: 16 Zoll, 2560 x 1600, 165 Hz',
    'Speicher: bis 96 GB DDR5',
    'Gewicht: ab 2,1 kg',
    '30 Tage Rückgaberecht, 1 Jahr Garantie',
    'Technische Daten',
  ],
  elements: [
    link('Framework'),
    link('Laptops'),
    link('Marketplace'),
    link('Support'),
    input('search', { placeholder: 'Suche', label: 'Suche' }),
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

const CHALLENGE: PageSpec = {
  url: 'http://127.0.0.1:8765/challenge.html',
  title: 'Just a moment...',
  viewportHeight: 779,
  pageHeight: 779,
  text: [
    { heading: 'shop.example' },
    'Verifying you are human. This may take a few seconds.',
    'shop.example needs to review the security of your connection before proceeding.',
    'Ray ID: 8c1f2a3b4d5e6f70',
    'Performance & security by Cloudflare',
  ],
  elements: [input('checkbox', { label: 'Verify you are human' }), link('Cloudflare')],
};

const PRODUCTS: Array<[string, string]> = [
  ['Framework Laptop 13 DIY Edition (Intel Core Ultra)', 'Notebook, 13,5 Zoll, 9 Angebote, ab 1.049,00 EUR'],
  ['Framework Laptop 16 DIY Edition (AMD Ryzen 7040)', 'Notebook, 16 Zoll, 4 Angebote, ab 1.379,00 EUR'],
  ['Framework Laptop 16 Grafikmodul AMD Radeon RX 7700S', 'Zubehör, 3 Angebote, ab 449,00 EUR'],
  ['Framework Laptop 16 Tastatur-Modul (Deutsch)', 'Zubehör, 2 Angebote, ab 99,00 EUR'],
  ['Framework Laptop 16 Netzteil 180 W', 'Zubehör, 5 Angebote, ab 79,00 EUR'],
];

const SEARCH: PageSpec = {
  url: 'http://127.0.0.1:8765/search.html',
  title: 'framework laptop 16 - Suchergebnisse | PreisFuchs',
  viewportHeight: 779,
  pageHeight: 815,
  text: [
    { heading: 'Suchergebnisse für "framework laptop 16"' },
    '6 Treffer',
    'Anzeige Gaming-Laptops bis zu 50% reduziert',
    'Anzeige',
    'Gaming-Laptops bis zu 50% reduziert',
    ...PRODUCTS.flatMap(([name, detail]) => [`${name} ${detail}`, name, detail]),
    'Weiter',
  ],
  elements: [
    link('PreisFuchs'),
    input('search', { label: 'Suche', value: 'framework laptop 16' }),
    button('Suchen', { type: 'submit' }),
    button('Sortieren: Relevanz', { type: 'button' }),
    input('checkbox', { label: 'Nur Laptops' }),
    link('Gaming-Laptops bis zu 50% reduziert'),
    ...PRODUCTS.map(([name]) => link(name)),
    link('Weiter'),
  ],
};

for (const [name, page] of [['store', STORE], ['challenge', CHALLENGE], ['search', SEARCH]] as const) {
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

test('defaults: no title is "Untitled Page", the page is as tall as its lowest element, and an empty page has no text or elements', () => {
  const empty = pageSnapshot({ url: 'https://empty.test' });
  assert.equal(empty.title, 'Untitled Page');
  assert.equal(empty.url, 'https://empty.test/', 'the URL is shown the way Chrome shows it');
  assert.deepEqual(empty.scrollState, { scrollY: 0, pageHeight: 800, viewportHeight: 800 });
  assert.equal(empty.elementCount, 0);
  assert.equal(empty.elementsText, '');
  assert.equal(empty.pageText, '');

  const tall = pageSnapshot({ url: 'https://tall.test/', elements: [link('Bottom', undefined, { y: 1980 })] });
  assert.equal(tall.scrollState.pageHeight, 2000);
});

test('a page text is cut at 4500 characters, in either form', () => {
  const long = 'word '.repeat(2000);
  assert.equal(pageSnapshot({ url: 'https://a.test/', text: long }).pageText.length, 4500);
  assert.equal(pageSnapshot({ url: 'https://a.test/', text: [long, long] }).pageText.length, 4500);
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
  assert.equal(answer.data.elementCount, 2);
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
// The type action, against the REAL content/actionExecutor.js doType
// ---------------------------------------------------------------------------------------------

const EXECUTOR_SOURCE = fs.readFileSync(new URL('../content/actionExecutor.js', import.meta.url), 'utf8');

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
  const window: Record<string, any> = { domCompressor: { getElement: () => node, elements: [] } };
  const load = new Function('window', 'document', 'HTMLInputElement', 'HTMLTextAreaElement', 'InputEvent', 'KeyboardEvent', 'MouseEvent', 'CSS', 'setTimeout', EXECUTOR_SOURCE);
  load(window, { contains: () => true }, HTMLInputElementStub, HTMLTextAreaElementStub, InputEventStub, Event, Event, { escape: (s: string) => s }, () => 0);
  return window.actionExecutorInstance.doType(1, text, submit);
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

test('scroll moves the page, clamped to its ends, and brings off-screen elements into view', async () => {
  const r = rig();
  const before = (await r.send(snapshotMessage)).data;
  assert.match(before.elementsText, /\[5\] a "Impressum" \[off-screen\]/);

  assert.deepEqual(await r.send(act({ action: 'scroll', direction: 'down', amount: 1000 })), { success: true, message: 'Scrolled down by 1000px' });
  const middle = (await r.send(snapshotMessage)).data;
  assert.equal(middle.scrollState.scrollY, 1000);
  assert.match(middle.elementsText, /\[5\] a "Impressum"$/, 'in view now');
  assert.match(middle.elementsText, /\[1\] a "Laptops" \[off-screen\]/, 'the top scrolled away');

  await r.send(act({ action: 'scroll' }));
  await r.send(act({ action: 'scroll', amount: 5000 }));
  assert.equal((await r.send(snapshotMessage)).data.scrollState.scrollY, 1200, 'the bottom is pageHeight - viewportHeight');
  await r.send(act({ action: 'scroll', direction: 'up', amount: 99999 }));
  assert.equal((await r.send(snapshotMessage)).data.scrollState.scrollY, 0);
});

/** The real content/actionExecutor.js on a stub window, for the actions that need no element: scrollBy is recorded. */
function realExecutor(): { run: (payload: Record<string, unknown>) => Promise<any>; scrolled: unknown[] } {
  const scrolled: unknown[] = [];
  const window: Record<string, any> = { domCompressor: { getElement: () => null, elements: [] }, scrollBy: (options: { top: unknown }) => scrolled.push(options.top) };
  const document = { contains: () => true, activeElement: { dispatchEvent: () => true }, body: { dispatchEvent: () => true } };
  const load = new Function('window', 'document', 'HTMLInputElement', 'HTMLTextAreaElement', 'InputEvent', 'KeyboardEvent', 'MouseEvent', 'CSS', 'setTimeout', EXECUTOR_SOURCE);
  load(window, document, HTMLInputElementStub, HTMLTextAreaElementStub, InputEventStub, Event, Event, { escape: (s: string) => s }, () => 0);
  // The message crosses the wire as JSON, so a missing value is a missing key.
  return { run: (payload) => window.actionExecutorInstance.execute(JSON.parse(JSON.stringify(payload))), scrolled };
}

test('scroll: only a missing direction or amount gets its default, and any other value is used and quoted as it is, like the real doScroll', async () => {
  const payloads: Array<Record<string, unknown>> = [
    {}, { direction: 'down' }, { direction: 'up' }, { amount: 200 }, { direction: 'up', amount: 300 },
    { direction: 'down', amount: '300' }, { direction: 'up', amount: '300' }, { amount: null }, { direction: null }, { direction: 'UP', amount: 100 },
    { amount: 'abc' }, { direction: 5, amount: 40 }, { direction: 'up', amount: -70 }, { amount: 0 }
  ];
  for (const payload of payloads) {
    const real = realExecutor();
    const reply = await real.run({ action: 'scroll', ...payload });
    const r = rig('https://long.test/', [{ url: 'https://long.test/', title: 'Long', pageHeight: 5000, scrollY: 1000, elements: [] }]);
    await r.send(snapshotMessage);
    assert.deepEqual(await r.send(act({ action: 'scroll', ...payload })), reply, JSON.stringify(payload));
    // scrollBy({ top }) turns its value into a number, and a value that is not one scrolls 0.
    const top = Number(real.scrolled[0]);
    const expected = Math.min(4200, Math.max(0, 1000 + (Number.isFinite(top) ? top : 0)));
    assert.equal((await r.send(snapshotMessage)).data.scrollState.scrollY, expected, JSON.stringify(payload));
  }
});

test('press_key: only a missing key is Enter, any other value is quoted as it is, like the real doPressKey', async () => {
  const r = rig();
  await r.send(snapshotMessage);
  for (const payload of [{}, { key: 'Escape' }, { key: 5 }, { key: null }, { key: true }, { key: '' }, { key: 'Control+a' }]) {
    const reply = await realExecutor().run({ action: 'press_key', ...payload });
    assert.deepEqual(await r.send(act({ action: 'press_key', ...payload })), reply, JSON.stringify(payload));
  }
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

test('read_page_text, press_key and wait answer like the real ones, and wait does not really wait', async () => {
  const r = rig(PRODUCT);
  await r.send(snapshotMessage);
  assert.deepEqual(await r.send(act({ action: 'read_page_text' })), {
    success: true,
    message: 'Extracted text snippet (37 chars):\n"""\nFramework Laptop 16 - ab 1.399,00 EUR\n"""',
  });
  assert.equal((await r.send(act({ action: 'extract_page_text' }))).success, true);
  assert.deepEqual(await r.send(act({ action: 'press_key', key: 'Escape' })), { success: true, message: 'Pressed key [Escape]' });
  assert.deepEqual(await r.send(act({ action: 'press_key' })), { success: true, message: 'Pressed key [Enter]' });
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

test('browser_batch and typing into a <select> are not simulated, and say how to script them', async () => {
  const pages: PageSpec[] = [{ url: SHOP, elements: [{ tag: 'select', label: 'Country' }] }];
  const r = rig(SHOP, pages);
  await r.send(snapshotMessage);

  assert.throws(() => r.send(act({ action: 'browser_batch', steps: [] })), /browser_batch is not simulated - script the EXECUTE_ACTION answer with fc\.dom\.on\(tabId, 'EXECUTE_ACTION', \.\.\.\)/);
  assert.throws(() => r.send(act({ action: 'type', element_id: 1, text: 'DE' })), /a <select>, is not simulated/);
  assert.equal(r.site.violations.length, 2);
});

test('the fake content script can be replaced for one message with fc.dom.on, which is how a test scripts what is not simulated', async () => {
  const r = rig();
  await r.send(snapshotMessage);
  r.fc.dom.on(101, 'EXECUTE_ACTION', { success: true, message: 'batch done' });
  assert.deepEqual(await r.send(act({ action: 'browser_batch', steps: [] })), { success: true, message: 'batch done' });
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
