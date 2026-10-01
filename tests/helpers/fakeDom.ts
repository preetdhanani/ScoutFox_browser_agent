/**
 * fakeDom - page snapshots and a fake content script, for Node tests.
 *
 * Two things, both built from a tiny description of a page:
 *   pageSnapshot(page)   the object content/domCompressor.js returns from getSnapshot(): title, url,
 *                        scrollState, elementCount, elementsText, elements and pageText. The
 *                        engine's prompt is built from exactly these fields.
 *   fakeDom({ pages })   the content-script side of a whole site. site.attach(fc, tabId) answers the
 *                        messages the engine sends with chrome.tabs.sendMessage (GET_DOM_SNAPSHOT and
 *                        EXECUTE_ACTION) from the page the tab is on, and follows links.
 *
 * Example:
 *   import { fakeChrome } from './helpers/fakeChrome.ts';
 *   import { fakeDom, pageSnapshot, link, button, input } from './helpers/fakeDom.ts';
 *
 *   const site = fakeDom({
 *     pages: [
 *       {
 *         url: 'https://shop.test/',
 *         title: 'Shop',
 *         text: [{ heading: 'Laptop 16' }, 'ab 1.399,00 EUR', 'Kostenloser Versand.'],
 *         elements: [
 *           link('Laptops', 'https://shop.test/laptops'),                       // a[href] that leads on
 *           input('search', { placeholder: 'Suche', label: 'Suche' }),
 *           button('In den Warenkorb', { type: 'button' }),
 *           link('Impressum', undefined, { y: 900 }),                           // 900 px down: [off-screen]
 *         ],
 *       },
 *       { url: 'https://shop.test/laptops', title: 'Laptops', text: 'Alle Laptops im Ueberblick.' },
 *     ],
 *   });
 *   const fc = fakeChrome({ tabs: { list: [{ id: 101, url: 'https://shop.test/' }] }, dom: true });
 *   site.attach(fc, 101);                        // fc.dom.set(101, ...) with the two handlers
 *   pageSnapshot(site.pages[0]).elementsText;    // '[1] a "Laptops"\n[2] input[search] "Suche" ...'
 *
 * A page (PageSpec):
 *   url, title (default: none, so 'Untitled Page' like the real one), viewportHeight (800),
 *   pageHeight (default: the lowest element, at least the viewport), scrollY (0),
 *   text     the visible text. A string is trimmed, as the real extractor trims innerText. A list is formatted like the real
 *            extractor does for a page of headings and paragraphs: only the first 90 pieces are read,
 *            { heading } becomes "\n### heading\n", pieces of 3 characters or less are dropped, the
 *            rest is joined with "\n". Both forms are cut at 4500 characters, and a text that is cut
 *            ends with the line "[page text truncated at 4500 characters]", like the real one. Three
 *            things of the real extractor are NOT modelled, because a description has no positions
 *            and no innerText: it falls back to the whole innerText when the pieces add up to under
 *            100 characters, and on a page scrolled more than 200 px with more than 30 pieces it
 *            reads the pieces near the viewport instead of the first 90, so the text there changes
 *            as the page scrolls. Here the text is the same at every scroll position. The third is
 *            the collapse of repeated text: the real extractor turns four or more units in a row that
 *            are the same after masking digits ("Batch 1 Shipped" ... "Batch 9 Shipped") into
 *            "first ... last (N similar entries)", and this fake does not. A description just gives
 *            the text the model should see, whatever it is, so describe such a page already collapsed.
 *            (Pieces that differ in more than digits are never collapsed.)
 *   elements the interactive elements in document order (see ElementSpec). Only these appear in the
 *            list the model sees, numbered 1, 2, 3... from the top on every snapshot, first 120.
 * An element (ElementSpec): tag, text, type, role, placeholder, label (the aria-label), id, name,
 *   testId, value, disabled, checked, expanded, editable (contenteditable), y (top edge in px from the
 *   page top, default 0), goes (the URL that a click, or typing with submit, leads to), cssPath. The role, the label, the value
 *   preview and the state come out the way the real code computes them from such an element (an <a>
 *   is a link, a search input is a searchbox, a checkbox has the value "on", a password never shows
 *   its value...). The [off-screen] marker follows y and the scroll position.
 *
 * What the fake content script does on EXECUTE_ACTION (the reply is what the real one sends):
 *   click        the checkbox flips, radio selects, and an element with `goes` opens that page
 *   type         like the real setFieldValue: every input (a checkbox or radio too, which it does not
 *                tick) and every textarea takes the text as its value, and an element with role="textbox"
 *                or `editable` takes it as its text. With submit an element with `goes` opens it. A missing
 *                text puts in '' and is quoted as "undefined", like the real reply
 *   scroll       moves scrollY, clamped to the page, so off-screen elements come into view. Only a missing
 *                direction or amount gets its default, and a value that is not a number ("300") is used as it is
 *   navigate     opens that page (its URL must be declared)
 *   go_back, go_forward   walk the pages this fake opened on that tab
 *   read_page_text, extract_page_text   the text, cut at 1500 characters
 *   press_key, wait      answer the real message (a missing key is Enter, any other value is quoted as it is).
 *                wait does not really wait
 *   Anything else with a real content-script meaning (browser_batch, or typing into a <select>) is a
 *   test mistake here. An unknown verb gets the real "Unknown action" reply.
 *   A page opens a moment after the reply (navigationDelayMs, default 0 = the next timer tick), by
 *   fc.tabs.navigate(), so tabs.onUpdated fires after the engine has started waiting for it. The
 *   page a message sees is the one for the tab's CURRENT URL. State (typed text, checked, scroll)
 *   lasts until a page this fake opens replaces it (a test that calls fc.tabs.navigate itself, to
 *   the URL the tab is already on, keeps it).
 *
 * What is a page failure and what is a test mistake:
 *   Replies the real content script gives (an element that is not there: "Element [9] no longer
 *   resolvable in DOM.", typing into a link) come back as { success: false, error }. Test mistakes
 *   throw to the code under test and are also kept in site.violations, in case it swallows the
 *   error: a tab on a URL with no declared page, a link whose target is not declared, and an action
 *   this fake does not simulate. site.assertClean() throws when there are any. A mistake in the
 *   description itself (an unknown key, a missing url or tag, a page declared twice) throws at once
 *   from fakeDom() or pageSnapshot().
 *
 * The shape is pinned to the real thing in tests/fakeDom.test.ts: the same page description gives
 * exactly what the real DOMCompressor returns, and what the committed recorded snapshots contain.
 */

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

export interface ElementSpec {
  /** Tag name, any case: 'a', 'button', 'input', 'select', 'textarea', or 'div' with a role. */
  tag: string;
  /** The visible text (innerText). */
  text?: string;
  /** The type attribute of an input or button. */
  type?: string;
  /** An explicit role attribute. Without it the role is worked out from tag and type. */
  role?: string;
  placeholder?: string;
  /** The aria-label. */
  label?: string;
  /** The DOM id. */
  id?: string;
  name?: string;
  /** data-testid. */
  testId?: string;
  /** The current value of an input or textarea. */
  value?: string;
  disabled?: boolean;
  checked?: boolean;
  /** aria-expanded. Left out means the attribute is not there. */
  expanded?: boolean;
  /** contenteditable: typing into it replaces its text (the snapshot does not show this attribute). */
  editable?: boolean;
  /** Top edge, in px from the top of the page. Default 0. */
  y?: number;
  /** The URL a click on this element (or typing with submit) opens. */
  goes?: string;
  /** Override for locator.cssPath. Default: #id, or tag[:nth-of-type(n)] as if every element sat directly in <body>. */
  cssPath?: string;
}

export type PageText = string | Array<string | { heading: string }>;

export interface PageSpec {
  url: string;
  title?: string;
  text?: PageText;
  elements?: ElementSpec[];
  viewportHeight?: number;
  pageHeight?: number;
  scrollY?: number;
}

export interface ElementLocator {
  index: number;
  tag: string;
  text: string;
  role: string;
  cssPath: string;
  attrs: { id: string; name: string; 'data-testid': string };
}

export interface SnapshotElement {
  id: number;
  tagName: string;
  type: string;
  role: string;
  disabled: boolean;
  checked: boolean;
  /** undefined when there is no aria-expanded (the key is still there, like in the real object). */
  expanded: boolean | undefined;
  inViewport: boolean;
  text: string;
  locator: ElementLocator;
  formatted: string;
}

/** What DOMCompressor.getSnapshot() returns (and GET_DOM_SNAPSHOT answers in `data`). */
export interface DomSnapshot {
  title: string;
  url: string;
  scrollState: { scrollY: number; pageHeight: number; viewportHeight: number };
  elementCount: number;
  elementsText: string;
  elements: SnapshotElement[];
  pageText: string;
}

export interface SnapshotOptions {
  /** The element cap, like getSnapshot({ maxElements }). Default 120. */
  maxElements?: number;
  /** The scroll position. Default: page.scrollY, else 0. */
  scrollY?: number;
}

/** The answer of the content script to EXECUTE_ACTION. */
export interface ActionResult {
  success: boolean;
  message?: string;
  error?: string;
  label?: string;
  submitted?: boolean;
}

/** One EXECUTE_ACTION the fake content script answered. */
export interface DomAction {
  tabId: number;
  /** The page the tab was on when the action arrived. */
  url: string;
  payload: Record<string, unknown>;
  result: ActionResult;
}

export interface DomRead {
  tabId: number;
  snapshot: DomSnapshot;
}

/** The part of fakeChrome that attach() uses (a FakeChrome fits). */
export interface DomHost {
  readonly tabs: {
    get(id: number): { url: string } | undefined;
    navigate(id: number, url: string): void;
  };
  readonly dom: {
    set(tabId: number, handler: Record<string, (message: unknown) => unknown>): void;
  };
}

export interface FakeDomOptions {
  pages: PageSpec[];
  /** Milliseconds between the reply of a link-following action and the tab opening the new page. Default 0. */
  navigationDelayMs?: number;
}

export interface FakeDom {
  /** The declared pages, checked and with their URLs in the form Chrome shows them. */
  readonly pages: PageSpec[];
  /** Answer GET_DOM_SNAPSHOT and EXECUTE_ACTION on this tab (fc.dom.set), from the page at the tab's URL. */
  attach(host: DomHost, tabId: number): void;
  /** Every snapshot handed out, in order. */
  readonly reads: DomRead[];
  /** Every EXECUTE_ACTION answered, in order. */
  readonly actions: DomAction[];
  /** Test mistakes that were thrown to the code under test (also thrown by assertClean). */
  readonly violations: Error[];
  assertClean(): void;
}

// ---------------------------------------------------------------------------------------------
// Constants and small helpers
// ---------------------------------------------------------------------------------------------

const DEFAULT_VIEWPORT_HEIGHT = 800;
const ELEMENT_HEIGHT = 20;
const MAX_ELEMENTS = 120;
const PAGE_TEXT_LIMIT = 4500;
/** The last line of a page text that was cut at the limit (content/domCompressor.js capPageText). */
const PAGE_TEXT_MARKER = `[page text truncated at ${PAGE_TEXT_LIMIT} characters]`;
/** How many text pieces (headings, paragraphs...) of a page the real extractor reads when the page is not scrolled far. */
const MAX_TEXT_PIECES = 90;
const ELEMENT_TEXT_LIMIT = 60;
const READ_TEXT_LIMIT = 1500;
const LABEL_LIMIT = 48;
const ELEMENT_KEYS = ['tag', 'text', 'type', 'role', 'placeholder', 'label', 'id', 'name', 'testId', 'value', 'disabled', 'checked', 'expanded', 'editable', 'y', 'goes', 'cssPath'];
const PAGE_KEYS = ['url', 'title', 'text', 'elements', 'viewportHeight', 'pageHeight', 'scrollY'];

/** content/domCompressor.js computeRole(): the implicit role of an element without a role attribute. */
const INPUT_ROLES: Record<string, string> = { checkbox: 'checkbox', radio: 'radio', submit: 'button', reset: 'button', button: 'button', range: 'slider', search: 'searchbox' };
const TAG_ROLES: Record<string, string> = { a: 'link', button: 'button', select: 'combobox', textarea: 'textbox', option: 'option' };

class FakeDomError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FakeDomError';
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Throws (a plain Error, this is test setup) for a key the description does not have, so a typo cannot pass silently. */
function checkKeys(what: string, value: unknown, allowed: string[]): void {
  if (!isObject(value)) throw new Error(`fakeDom: ${what} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`fakeDom: ${what} has an unknown key "${key}"; known keys: ${allowed.join(', ')}`);
  }
}

/** The URL the way Chrome shows it (a bare origin gets its slash), so a page and a tab URL compare equal. */
function normalizeUrl(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

const collapse = (text: string): string => text.trim().replace(/\s+/g, ' ');

function implicitRole(tag: string, type: string): string {
  if (tag === 'input') return INPUT_ROLES[type] || 'textbox';
  return TAG_ROLES[tag] || tag;
}

function isCheckable(tag: string, type: string): boolean {
  return tag === 'input' && (type === 'checkbox' || type === 'radio');
}

/** The value property of an element: a checkbox or radio without a value attribute reports "on", like a browser. */
function valueOf(el: ElementSpec): string {
  const tag = el.tag.toLowerCase();
  return el.value ?? (isCheckable(tag, el.type ?? '') ? 'on' : '');
}

// ---------------------------------------------------------------------------------------------
// Element helpers for descriptions
// ---------------------------------------------------------------------------------------------

/** An <a href>. `goes` is the page a click opens. */
export function link(text: string, goes?: string, extra: Partial<ElementSpec> = {}): ElementSpec {
  return { tag: 'a', text, ...(goes === undefined ? {} : { goes }), ...extra };
}

export function button(text: string, extra: Partial<ElementSpec> = {}): ElementSpec {
  return { tag: 'button', text, ...extra };
}

export function input(type: string, extra: Partial<ElementSpec> = {}): ElementSpec {
  return { tag: 'input', type, ...extra };
}

// ---------------------------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------------------------

/** content/domCompressor.js capPageText(): a text over the limit is cut there and ends with a marker line. */
function capPageText(text: string): string {
  return text.length > PAGE_TEXT_LIMIT ? `${text.slice(0, PAGE_TEXT_LIMIT)}\n${PAGE_TEXT_MARKER}` : text;
}

/** content/domCompressor.js extractPageText() for a page of headings and paragraphs. */
function formatPageText(text: PageText | undefined): string {
  if (text === undefined) return '';
  // A plain page is its innerText, trimmed and then cut (extractPageText: `.trim()` then the cap).
  if (typeof text === 'string') return capPageText(text.trim());
  // The first 90 pieces of the page, counted before the short ones are dropped (allTextNodes.slice(0, 90)).
  return capPageText(
    text
      .slice(0, MAX_TEXT_PIECES)
      .map((piece) => (typeof piece === 'string' ? collapse(piece) : `\n### ${collapse(piece.heading)}\n`))
      .filter((piece) => piece.length > 3)
      .join('\n'),
  );
}

function pageHeightOf(page: PageSpec, viewportHeight: number): number {
  if (page.pageHeight !== undefined) return page.pageHeight;
  const lowest = Math.max(0, ...(page.elements ?? []).map((el) => (el.y ?? 0) + ELEMENT_HEIGHT));
  return Math.max(viewportHeight, lowest);
}

/** One element the way getElementSummary() describes it. `nth` is its position among elements of the same tag. */
function summarize(el: ElementSpec, id: number, nth: number, scrollY: number, viewportHeight: number): SnapshotElement {
  const tagName = el.tag.toLowerCase();
  const type = el.type ?? '';
  const placeholder = el.placeholder ?? '';
  const ariaLabel = el.label ?? '';
  const text = collapse(el.text ?? '').slice(0, ELEMENT_TEXT_LIMIT);
  const role = el.role || implicitRole(tagName, type);
  const disabled = el.disabled ?? false;
  const checked = el.checked ?? false;
  const expanded = el.expanded;
  // A password value is never shown, and only inputs and textareas show a value at all.
  const isPasswordLike = tagName === 'input' && type === 'password';
  const value = valueOf(el);
  const valuePreview = !isPasswordLike && (tagName === 'input' || tagName === 'textarea') && value ? value.slice(0, 40) : '';
  const top = (el.y ?? 0) - scrollY;
  const inViewport = top + ELEMENT_HEIGHT > 0 && top < viewportHeight;

  let extraAttrs = '';
  if (placeholder) extraAttrs += ` placeholder="${placeholder}"`;
  if (ariaLabel) extraAttrs += ` label="${ariaLabel}"`;
  if (disabled) extraAttrs += ' disabled';
  if (checked) extraAttrs += ' checked';
  if (expanded === true) extraAttrs += ' expanded';
  else if (expanded === false) extraAttrs += ' collapsed';
  if (valuePreview) extraAttrs += ` value="${valuePreview}"`;

  const labelText = text || ariaLabel || placeholder || 'element';
  const cssPath = el.cssPath ?? (el.id ? `#${el.id}` : nth > 1 ? `${tagName}:nth-of-type(${nth})` : tagName);

  return {
    id,
    tagName,
    type,
    role,
    disabled,
    checked,
    expanded,
    inViewport,
    text: labelText,
    locator: {
      index: id,
      tag: tagName,
      text: labelText,
      role,
      cssPath,
      attrs: { id: el.id ?? '', name: el.name ?? '', 'data-testid': el.testId ?? '' },
    },
    formatted: `[${id}] ${tagName}${type ? `[${type}]` : ''} "${labelText}"${extraAttrs ? ` (${extraAttrs.trim()})` : ''}${inViewport ? '' : ' [off-screen]'}`,
  };
}

/** The snapshot of a page as it stands, and which elements got an id (element N is listed[N - 1]). */
function build(page: PageSpec, elements: ElementSpec[], scrollY: number, maxElements: number): { snapshot: DomSnapshot; listed: ElementSpec[] } {
  const viewportHeight = page.viewportHeight ?? DEFAULT_VIEWPORT_HEIGHT;
  const listed = elements.slice(0, maxElements);
  const seen = new Map<string, number>();
  const summaries = listed.map((el, i) => {
    const tag = el.tag.toLowerCase();
    const nth = (seen.get(tag) ?? 0) + 1;
    seen.set(tag, nth);
    return summarize(el, i + 1, nth, scrollY, viewportHeight);
  });
  return {
    listed,
    snapshot: {
      title: page.title || 'Untitled Page',
      url: normalizeUrl(page.url),
      scrollState: { scrollY: Math.round(scrollY), pageHeight: Math.round(pageHeightOf(page, viewportHeight)), viewportHeight },
      elementCount: summaries.length,
      elementsText: summaries.map((e) => e.formatted).join('\n'),
      elements: summaries,
      pageText: formatPageText(page.text),
    },
  };
}

/** What getSnapshot() returns for this page. */
export function pageSnapshot(page: PageSpec, options: SnapshotOptions = {}): DomSnapshot {
  checkPage(page);
  return build(page, page.elements ?? [], options.scrollY ?? page.scrollY ?? 0, options.maxElements || MAX_ELEMENTS).snapshot;
}

function checkPage(page: PageSpec): void {
  checkKeys('a page', page, PAGE_KEYS);
  if (typeof page.url !== 'string' || page.url === '') throw new Error('fakeDom: a page needs a url');
  for (const el of page.elements ?? []) {
    checkKeys(`an element of ${page.url}`, el, ELEMENT_KEYS);
    if (typeof el.tag !== 'string' || el.tag === '') throw new Error(`fakeDom: an element of ${page.url} needs a tag`);
  }
}

// ---------------------------------------------------------------------------------------------
// The fake content script
// ---------------------------------------------------------------------------------------------

/** The document of one tab: the page's elements copied (typing and clicking change them), and the scroll position. */
interface Doc {
  url: string;
  page: PageSpec;
  elements: ElementSpec[];
  scrollY: number;
  /** The elements of the last snapshot: the ids the model can act on. */
  listed: ElementSpec[];
}

interface TabState {
  doc?: Doc;
  back: string[];
  forward: string[];
}

/** describeElement() of content/actionExecutor.js: the first of label, placeholder, text, name, value. */
function describe(el: ElementSpec): string {
  const label = [el.label, el.placeholder, el.text, el.name, valueOf(el)].map((v) => collapse(v ?? '')).find((v) => v.length > 0) ?? '';
  return label.length > LABEL_LIMIT ? `${label.slice(0, LABEL_LIMIT - 1)}\u2026` : label;
}

export function fakeDom(options: FakeDomOptions): FakeDom {
  checkKeys('fakeDom({...})', options, ['pages', 'navigationDelayMs']);
  const delayMs = options.navigationDelayMs ?? 0;
  const pages = new Map<string, PageSpec>();
  for (const page of options.pages) {
    checkPage(page);
    const url = normalizeUrl(page.url);
    if (pages.has(url)) throw new Error(`fakeDom: the page ${url} is declared twice`);
    pages.set(url, { ...page, url });
  }
  const tabs = new Map<number, TabState>();
  const reads: DomRead[] = [];
  const actions: DomAction[] = [];
  const violations: Error[] = [];

  /** A test mistake met while a message is answered: kept, and thrown to the code under test. */
  const violation = (message: string): FakeDomError => {
    const error = new FakeDomError(message);
    violations.push(error);
    return error;
  };

  const stateOf = (tabId: number): TabState => {
    let state = tabs.get(tabId);
    if (!state) {
      state = { back: [], forward: [] };
      tabs.set(tabId, state);
    }
    return state;
  };

  const docOf = (host: DomHost, tabId: number): Doc => {
    const tab = host.tabs.get(tabId);
    if (!tab) throw violation(`fakeDom: the fake content script on tab ${tabId} was asked something, but that tab does not exist any more`);
    const url = normalizeUrl(tab.url);
    const state = stateOf(tabId);
    if (state.doc?.url === url) return state.doc;
    const page = pages.get(url);
    if (!page) {
      throw violation(`fakeDom: tab ${tabId} is at ${url}, but no page for that URL was declared - add it to fakeDom({ pages: [{ url: '${url}', ... }] })`);
    }
    const elements = (page.elements ?? []).map((el) => ({ ...el }));
    state.doc = { url, page, elements, scrollY: page.scrollY ?? 0, listed: [] };
    return state.doc;
  };

  /** The tab opens `url` after the reply, so tabs.onUpdated fires after the caller started to wait for it. */
  const open = (host: DomHost, tabId: number, url: string, why: string, track: boolean): void => {
    const target = normalizeUrl(url);
    if (!pages.has(target)) {
      throw violation(`fakeDom: ${why} leads to ${target}, but no page for that URL was declared - add it to fakeDom({ pages: [{ url: '${target}', ... }] })`);
    }
    const state = stateOf(tabId);
    if (track && state.doc) {
      state.back.push(state.doc.url);
      state.forward.length = 0;
    }
    setTimeout(() => {
      if (!host.tabs.get(tabId)) return;
      delete state.doc; // a page load is a new document: typed text, checked boxes and scroll are gone
      host.tabs.navigate(tabId, target);
    }, delayMs);
  };

  const element = (doc: Doc, id: unknown): ElementSpec | undefined => (typeof id === 'number' ? doc.listed[id - 1] : undefined);
  const gone = (id: unknown): ActionResult => ({ success: false, error: `Element [${String(id)}] no longer resolvable in DOM.` });

  const execute = (host: DomHost, tabId: number, doc: Doc, payload: Record<string, unknown>): ActionResult => {
    const { action, element_id: id } = payload;
    switch (action) {
      case 'click': {
        const el = element(doc, id);
        if (!el) return gone(id);
        const tag = el.tag.toLowerCase();
        if (!el.disabled) {
          if (isCheckable(tag, el.type ?? '')) el.checked = el.type === 'radio' ? true : !el.checked;
          if (el.goes !== undefined) open(host, tabId, el.goes, `clicking element [${String(id)}] ("${describe(el)}")`, true);
        }
        const label = describe(el);
        return { success: true, label, message: `Clicked element [${String(id)}]${label ? ` ("${label}")` : ''}` };
      }
      case 'type': {
        const el = element(doc, id);
        if (!el) return gone(id);
        const tag = el.tag.toLowerCase();
        if (tag === 'select') throw violation(`fakeDom: typing into element [${String(id)}], a <select>, is not simulated - script the EXECUTE_ACTION answer with fc.dom.on(tabId, 'EXECUTE_ACTION', ...) for this test`);
        // content/actionExecutor.js setFieldValue: any <input> and <textarea> takes the text as its value
        // (a checkbox too: its value changes, it is not ticked), then an element with contenteditable or
        // an explicit role="textbox" takes it as its text. Nothing else can be typed into.
        const isField = tag === 'input' || tag === 'textarea';
        if (!isField && el.role !== 'textbox' && el.editable !== true) {
          return { success: false, error: `Element <${tag}> is not a text field, dropdown or editable region, so it cannot be typed into.` };
        }
        // setFieldValue puts nothing (null or undefined) in as '', and anything else as String(text); the
        // reply quotes the raw value, so a missing text is answered as "undefined".
        const value = payload.text == null ? '' : String(payload.text);
        if (isField) el.value = value;
        else el.text = value;
        const submit = !!payload.submit; // any truthy value submits, and is answered as submitted: true
        if (submit && el.goes !== undefined) open(host, tabId, el.goes, `submitting element [${String(id)}] ("${describe(el)}")`, true);
        const label = describe(el);
        return { success: true, label, submitted: submit, message: `Typed "${String(payload.text)}" into element [${String(id)}]${label ? ` ("${label}")` : ''}` };
      }
      case 'scroll': {
        // doScroll(direction = 'down', amount = 500): only a missing value gets the default, whatever else the
        // model sent is used and quoted as it is ("300" from a model that writes numbers as strings scrolls 300).
        const direction: unknown = payload.direction === undefined ? 'down' : payload.direction;
        const amount: unknown = payload.amount === undefined ? 500 : payload.amount;
        const distance = Number(amount) * (direction === 'up' ? -1 : 1);
        const viewportHeight = doc.page.viewportHeight ?? DEFAULT_VIEWPORT_HEIGHT;
        const furthest = Math.max(0, pageHeightOf(doc.page, viewportHeight) - viewportHeight);
        doc.scrollY = Math.min(furthest, Math.max(0, doc.scrollY + (Number.isFinite(distance) ? distance : 0)));
        return { success: true, message: `Scrolled ${String(direction)} by ${String(amount)}px` };
      }
      case 'press_key':
        // doPressKey(key = 'Enter'): only a missing key becomes Enter.
        return { success: true, message: `Pressed key [${String(payload.key === undefined ? 'Enter' : payload.key)}]` };
      case 'wait':
        return { success: true, message: `Waited ${String(payload.amount || 1)}s` };
      case 'navigate': {
        const url = String(payload.url);
        open(host, tabId, url, 'the navigate action', true);
        return { success: true, message: `Navigating to ${url}` };
      }
      case 'go_back':
      case 'go_forward': {
        const state = stateOf(tabId);
        const from = action === 'go_back' ? state.back : state.forward;
        const to = action === 'go_back' ? state.forward : state.back;
        const url = from.pop();
        if (url !== undefined) {
          to.push(doc.url);
          open(host, tabId, url, `the ${String(action)} action`, false);
        }
        return { success: true, message: action === 'go_back' ? 'Going back' : 'Going forward' };
      }
      case 'read_page_text':
      case 'extract_page_text': {
        const text = formatPageText(doc.page.text);
        return { success: true, message: `Extracted text snippet (${text.length} chars):\n"""\n${text.slice(0, READ_TEXT_LIMIT)}\n"""` };
      }
      case 'browser_batch':
        throw violation('fakeDom: browser_batch is not simulated - script the EXECUTE_ACTION answer with fc.dom.on(tabId, \'EXECUTE_ACTION\', ...) for this test');
      default:
        return { success: false, error: `Unknown action: ${String(action)}` };
    }
  };

  return {
    pages: [...pages.values()],
    attach: (host, tabId) => {
      host.dom.set(tabId, {
        GET_DOM_SNAPSHOT: (message) => {
          const payload = isObject(message) && isObject(message.payload) ? message.payload : {};
          const doc = docOf(host, tabId);
          const maxElements = typeof payload.maxElements === 'number' ? payload.maxElements : MAX_ELEMENTS;
          const { snapshot, listed } = build(doc.page, doc.elements, doc.scrollY, maxElements || MAX_ELEMENTS);
          doc.listed = listed;
          reads.push({ tabId, snapshot: structuredClone(snapshot) });
          return { success: true, data: snapshot };
        },
        EXECUTE_ACTION: (message) => {
          const payload = isObject(message) && isObject(message.payload) ? message.payload : {};
          const doc = docOf(host, tabId);
          const result = execute(host, tabId, doc, payload);
          actions.push({ tabId, url: doc.url, payload: structuredClone(payload), result: structuredClone(result) });
          return result;
        },
      });
    },
    reads,
    actions,
    violations,
    assertClean: () => {
      if (violations.length > 0) {
        throw new Error(`fakeDom: ${violations.length} test mistake(s) were thrown to the code under test:\n${violations.map((v) => `  - ${v.message}`).join('\n')}`);
      }
    },
  };
}
