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
 *   text     the visible text (what innerText of the page's content block gives). A string is the text itself; a list is
 *            one block per piece, each on its own line, { heading } as its plain text. Either way the
 *            whitespace is normalised like the real extractor does (one space inside a line, no blank
 *            lines, nothing at the ends), the text is cut at 4500 characters at a line boundary, and a text
 *            that is cut ends with the real note line "[page text truncated: showing N of M characters - ...]". A page
 *            with fewer than 10 characters of text (no text at all included) gets the line
 *            "[no readable text on this page]". Two things of the real extractor are NOT modelled,
 *            because a description has no positions: on a page scrolled more than 200 px whose text
 *            does not fit the cap, the real one reads only the blocks around the viewport, so the text
 *            there changes as the page scrolls. Here the text is the same at every scroll position. The
 *            second is the collapse of repeated text: the real extractor turns four or more units in a row that
 *            are the same after masking digits ("Batch 1 Shipped" ... "Batch 9 Shipped") into
 *            "first ... last (N similar entries)", and this fake does not. A description just gives
 *            the text the model should see, whatever it is, so describe such a page already collapsed.
 *            (Pieces that differ in more than digits are never collapsed.)
 *   elements the interactive elements in document order (see ElementSpec). Only these appear in
 *            the list the model sees, numbered 1, 2, 3... on every snapshot, viewport-first: the
 *            elements inside the viewport in document order, then the off-screen ones by distance
 *            to the viewport, cut at 120. A cut list ends with the marker line
 *            "[+N more interactive elements not listed - ...]", and elementCount counts what was
 *            found before the cap.
 * An element (ElementSpec): tag, text, type, role, placeholder, label (the aria-label), id, name,
 *   testId, value, disabled, checked, expanded, editable (contenteditable), form (the kind of the form it is in), y (top edge in px from the
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
 *   scroll       moves scrollY by the real step (most of the viewport), clamped to the page, and answers what
 *                moved like the real one. scroll_target, scroll_measure and scroll_fallback are the steps the
 *                background's measured scroll takes: the page is the box (a fake page has no inner panel), a
 *                wheel never moves it (the fake debugger does not scroll), so the fallback moves it
 *   navigate     opens that page (its URL must be declared)
 *   go_back, go_forward   walk the pages this fake opened on that tab
 *   read_page    the whole text (no cap), the part the request names, like the real one; with element_id
 *                that element's text, paged the same way
 *   find_element the real compressor's matcher over the described elements: ids continue after the
 *                window's ids and survive the next snapshot, and a zero match answers the real
 *                no-match message with the nearest labels
 *   wait         answers the real message, and does not really wait
 *   Anything else with a real content-script meaning (typing into a <select>) is a test mistake
 *   here. An unknown verb (press_key is CDP only, so the content script does not know it either)
 *   gets the real "Unknown action" reply.
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

// The cut, the note and the paging are the real content script's own pure functions, so the fake cannot drift from them.
import { computeHrefPath } from '../../src/content/perception.ts';
import { capPageText as realCapPageText, pageTextPart } from '../../src/content/pageText.ts';
import { stepOf, type ScrollPosition } from '../../src/content/scrollMeasure.ts';
import {
  omittedElementsNote,
  rankFindCandidates,
  nearestFindLabels,
  formatFindMessage,
  FIND_MAX_MATCHES,
  type FindCandidate,
  type FindFields
} from '../../src/content/domCompressor.ts';

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
  /** The kind of the <form> the element is in ('search', 'login', 'checkout' or 'other'), as content/perception.ts computeFormKind() reads it. Left out: not in a form. */
  form?: string;
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
  domain: string;
  scrollState: { scrollY: number; pageHeight: number; viewportHeight: number };
  elementCount: number;
  /** How many of the elementCount elements the list cap cut; 0 when everything fit. */
  omittedCount: number;
  elementsText: string;
  elements: SnapshotElement[];
  refs: number[];
  shownRefs: number[];
  elementInfo: Record<string, any>;
  /** What has focus, as risk facts (content/perception.ts getFocusedElementInfo()). A described page has no focus: null. */
  focused: Record<string, any> | null;
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
  /** Extra payload of the result (the real read_page_text returns { pageText }). */
  result?: Record<string, unknown>;
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
/** The page text of a page with fewer than 10 characters of visible text (src/content/pageText.ts PAGE_TEXT_EMPTY_MARKER). */
const PAGE_TEXT_EMPTY_MARKER = '[no readable text on this page]';
const PAGE_TEXT_MIN_CHARS = 10;
const ELEMENT_TEXT_LIMIT = 60;
const LABEL_LIMIT = 48;
const ELEMENT_KEYS = ['tag', 'text', 'type', 'role', 'placeholder', 'label', 'id', 'name', 'testId', 'value', 'disabled', 'checked', 'expanded', 'editable', 'form', 'y', 'goes', 'cssPath'];
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

/** The matcher fields of a described element, the way the real compressor reads them off the DOM node. */
function findFieldsOf(el: ElementSpec, pageUrl: string): FindFields {
  const tag = el.tag.toLowerCase();
  let hrefPath = '';
  if (tag === 'a') {
    try {
      hrefPath = new URL(el.goes ?? '#', pageUrl).pathname;
    } catch {
      hrefPath = '';
    }
  }
  return {
    text: el.text ?? '',
    ariaLabel: el.label ?? '',
    placeholder: el.placeholder ?? '',
    name: el.name ?? '',
    title: '',
    alt: '',
    hrefPath,
    role: el.role || implicitRole(tag, el.type ?? ''),
  };
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

/** src/content/pageText.ts capPageText(): a text over the limit is cut at a line boundary and ends with a note line. */
function capPageText(text: string): string {
  return realCapPageText(text);
}

/** src/content/pageText.ts normalizePageText(): one space inside a line, table cells (tabs) apart as " | ", no blank lines, nothing at the ends. */
function normalizeLines(text: string): string {
  return text
    .split(/\r?\n|\r/)
    .map((line) => line.split('\t').map((cell) => cell.replace(/[\s\u00a0]+/g, ' ').trim()).filter(Boolean).join(' | '))
    .filter(Boolean)
    .join('\n');
}

/** src/content/pageText.ts extractFullPageTextFromDocument(): the visible text, normalised, not cut. */
function fullPageText(text: PageText | undefined): string {
  return text === undefined
    ? ''
    : typeof text === 'string'
      ? normalizeLines(text)
      // Every piece is one block of the page: a line of its own, a heading as plain text, like innerText.
      : normalizeLines(text.map((piece) => (typeof piece === 'string' ? piece : piece.heading)).join('\n'));
}

/** A text under 10 characters is replaced by (or followed by) the empty marker, like the real markIfEmpty(). */
function markIfEmpty(text: string): string {
  if (text.length >= PAGE_TEXT_MIN_CHARS) return text;
  return text ? `${text}\n${PAGE_TEXT_EMPTY_MARKER}` : PAGE_TEXT_EMPTY_MARKER;
}

/** content/domCompressor.js extractPageText(): the visible text, normalised, cut, and marked when it is under 10 characters. */
function formatPageText(text: PageText | undefined): string {
  return markIfEmpty(capPageText(fullPageText(text)));
}

function pageHeightOf(page: PageSpec, viewportHeight: number): number {
  if (page.pageHeight !== undefined) return page.pageHeight;
  const lowest = Math.max(0, ...(page.elements ?? []).map((el) => (el.y ?? 0) + ELEMENT_HEIGHT));
  return Math.max(viewportHeight, lowest);
}

/** One element the way getElementSummary() describes it. `nth` is its position among elements of the same tag. */
/** content/perception.ts computeHrefDomain(): the host a link leads to. A link() always has an href: `goes`, or a same-page "#" when it leads nowhere. */
function hrefDomainOf(el: ElementSpec, pageUrl: string): string | undefined {
  if (el.tag.toLowerCase() !== 'a') return undefined;
  try {
    const url = new URL(el.goes ?? '#', pageUrl);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.hostname.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

function summarize(el: ElementSpec, id: number, nth: number, scrollY: number, viewportHeight: number, pageUrl: string): SnapshotElement {
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
  // A link to another site says where it goes.
  const hrefDomain = hrefDomainOf(el, pageUrl);
  let pageHost = '';
  try {
    pageHost = new URL(pageUrl).hostname.toLowerCase();
  } catch (_) {}
  if (hrefDomain && pageHost && hrefDomain !== pageHost) extraAttrs += ` domain="${hrefDomain}"`;
  else if (hrefDomain) {
    // A link on this site says which page it opens (perception.ts, computeHrefPath).
    const path = computeHrefPath(el.goes ?? '#', pageUrl);
    if (path) extraAttrs += ` href="${path}"`;
  }
  if (isPasswordLike) extraAttrs += ' (user only)';

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

/**
 * The risk-gate facts content/perception.ts computeElementInfo() adds, for what a description can say: gateLabel
 * (visible text and accessible name, when that adds to the label) and submitControl. A described form has no action
 * or method, so formActionHost and formMethod never appear.
 */
function gateFacts(el: ElementSpec, label: string): { gateLabel?: string; submitControl?: true } {
  const tagName = el.tag.toLowerCase();
  const type = (el.type ?? '').toLowerCase();
  const text = collapse(el.text ?? '').slice(0, ELEMENT_TEXT_LIMIT);
  const value = collapse(el.value ?? '');
  const name = collapse(el.label ?? '')
    || (tagName === 'input' && (type === 'submit' || type === 'button' || type === 'reset') ? value : '')
    || text;
  const parts: string[] = [];
  for (const part of [text, name]) {
    const c = part.slice(0, 120);
    if (c && !parts.some((p) => p.toLowerCase() === c.toLowerCase())) parts.push(c);
  }
  const gate = parts.join(' | ');
  const facts: { gateLabel?: string; submitControl?: true } = {};
  if (gate && gate !== label) facts.gateLabel = gate;
  if (el.form && ((tagName === 'button' && (type === '' || type === 'submit')) || (tagName === 'input' && (type === 'submit' || type === 'image')))) {
    facts.submitControl = true;
  }
  return facts;
}

function computeFieldKind(el: ElementSpec): string | undefined {
  const tagName = el.tag.toLowerCase();
  if (tagName !== 'input' && tagName !== 'textarea') return undefined;
  const lowerType = (el.type || '').toLowerCase();
  const name = (el.name || '').toLowerCase();
  const id = (el.id || '').toLowerCase();
  const combined = `${name} ${id}`;

  if (lowerType === 'password' || combined.includes('password') || combined.includes('passwort')) return 'password';
  if (lowerType === 'email' || combined.includes('email') || combined.includes('e-mail')) return 'email';
  if (/card|cc-number|cvv|cvc|cardnumber|kreditkarte/i.test(combined) || (lowerType === 'tel' && combined.includes('cc'))) return 'cc';
  if (/otp|2fa|one-time|verification|code|mfa|token/i.test(combined)) return 'otp';
  if (lowerType === 'search' || /search|suche|query/i.test(combined)) return 'search';
  if (/address|street|city|zip|postcode|plz|strasse|ort/i.test(combined)) return 'address';
  return 'text';
}

/**
 * The snapshot of a page as it stands, and which elements got an id (element N is listed[N - 1]).
 * The element window is viewport-first, like the real compressor: the in-viewport elements in
 * document order, then the off-screen ones by distance to the viewport, cut at the cap.
 */
/** The risk-gate and perception facts of one element, the way build() and the find_element case both compute them. */
function elementInfoOf(el: ElementSpec, s: SnapshotElement, pageUrl: string): Record<string, any> {
  return {
    role: s.role,
    label: s.text,
    formKind: el.form,
    fieldKind: computeFieldKind(el),
    hrefDomain: hrefDomainOf(el, pageUrl),
    ...gateFacts(el, s.text),
  };
}

/** The nth-of-type of every element among its same-tag siblings in document order, as cssPath needs it. */
function nthOfElements(elements: ElementSpec[]): Map<ElementSpec, number> {
  const nthSeen = new Map<string, number>();
  const nthOf = new Map<ElementSpec, number>();
  for (const el of elements) {
    const tag = el.tag.toLowerCase();
    const nth = (nthSeen.get(tag) ?? 0) + 1;
    nthSeen.set(tag, nth);
    nthOf.set(el, nth);
  }
  return nthOf;
}

function build(page: PageSpec, elements: ElementSpec[], scrollY: number, maxElements: number): { snapshot: DomSnapshot; listed: ElementSpec[] } {
  const viewportHeight = page.viewportHeight ?? DEFAULT_VIEWPORT_HEIGHT;
  const inside: ElementSpec[] = [];
  const outside: Array<{ el: ElementSpec; distance: number }> = [];
  for (const el of elements) {
    const top = (el.y ?? 0) - scrollY;
    // The horizontal half of the containment test is always true for a described element (left 10,
    // right 60, viewport 1200), so the y test alone decides, like summarize() below.
    if (top + ELEMENT_HEIGHT > 0 && top < viewportHeight) inside.push(el);
    else outside.push({ el, distance: top + ELEMENT_HEIGHT <= 0 ? -(top + ELEMENT_HEIGHT) : top - viewportHeight });
  }
  outside.sort((a, b) => a.distance - b.distance);
  const ordered = [...inside, ...outside.map((o) => o.el)];
  const listed = ordered.slice(0, maxElements);
  const omittedCount = elements.length - listed.length;
  // The nth-of-type of a cssPath counts same-tag siblings in DOM order, whatever order the window
  // lists them in, so it is computed before the window is cut and reordered.
  const nthOf = nthOfElements(elements);
  const summaries = listed.map((el, i) => summarize(el, i + 1, nthOf.get(el) ?? 1, scrollY, viewportHeight, page.url));
  const refs = summaries.map((e) => e.id);
  const shownRefs = refs.slice();
  let domain = '';
  try {
    domain = new URL(page.url).hostname;
  } catch (_) {}
  const elementInfo: Record<string, any> = {};
  for (const s of summaries) {
    const el = listed[s.id - 1];
    elementInfo[s.id] = el ? elementInfoOf(el, s, page.url) : { role: s.role, label: s.text };
  }
  const elementLines = summaries.map((e) => e.formatted);
  const elementsText = omittedCount > 0
    ? [...elementLines, omittedElementsNote(omittedCount)].join('\n')
    : elementLines.join('\n');
  return {
    listed,
    snapshot: {
      title: page.title || 'Untitled Page',
      url: normalizeUrl(page.url),
      domain,
      scrollState: { scrollY: Math.round(scrollY), pageHeight: Math.round(pageHeightOf(page, viewportHeight)), viewportHeight },
      elementCount: elements.length,
      omittedCount,
      elementsText,
      elements: summaries,
      refs,
      shownRefs,
      elementInfo,
      focused: null,
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
  /** The ids find_element handed out, kept across snapshots like the real compressor's foundElements. */
  found: Array<{ el: ElementSpec; id: number }>;
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
    state.doc = { url, page, elements, scrollY: page.scrollY ?? 0, listed: [], found: [] };
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

  const element = (doc: Doc, id: unknown): ElementSpec | undefined => {
    if (typeof id !== 'number') return undefined;
    if (id >= 1 && id <= doc.listed.length) return doc.listed[id - 1];
    return doc.found.find((f) => f.id === id)?.el;
  };
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
      case 'scroll':
      case 'scroll_target':
      case 'scroll_measure':
      case 'scroll_fallback': {
        // The real content script's scroll verbs (src/content/actions.ts) on a page that is its own
        // scroll box: the position is scrollY, its end is pageHeight - viewportHeight.
        const viewportHeight = doc.page.viewportHeight ?? DEFAULT_VIEWPORT_HEIGHT;
        const furthest = Math.max(0, Math.round(pageHeightOf(doc.page, viewportHeight) - viewportHeight));
        const position = (): ScrollPosition => {
          const top = Math.round(doc.scrollY);
          return { top, max: furthest, height: viewportHeight, atTop: top <= 1, atBottom: top >= furthest - 1 };
        };
        const moveBy = (delta: number) => { doc.scrollY = Math.min(furthest, Math.max(0, doc.scrollY + (Number.isFinite(delta) ? delta : 0))); };
        if (action === 'scroll_target') {
          if (payload.element_id !== undefined && payload.element_id !== null && !element(doc, payload.element_id)) {
            return { success: false, error: `Element [${String(payload.element_id)}] is not on this page any more. Get the element list again, or scroll without element_id.` };
          }
          return { success: true, result: { point: { x: 640, y: Math.round(viewportHeight / 2) }, label: 'the page', step: stepOf(position()), ...position() } };
        }
        if (action === 'scroll_measure') return { success: true, result: { ...position() } };
        if (action === 'scroll_fallback') {
          moveBy(Number(payload.delta) || 0);
          return { success: true, result: { ...position() } };
        }
        const before = position();
        moveBy((payload.direction === 'up' ? -1 : 1) * stepOf(before));
        const after = position();
        return { success: true, result: { moved: after.top - before.top, label: 'the page', ...after } };
      }
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
      case 'read_page': {
        // Mirrors the real content script (src/content/actions.ts): stateless, the part the request
        // names (1 by default) of the whole text, or of one element's text with element_id.
        const rawPart = payload.part;
        const partNumber = rawPart === undefined || rawPart === null || rawPart === '' ? 1 : Number(rawPart);
        if (!Number.isInteger(partNumber) || partNumber < 1) {
          return { success: false, error: `part must be a whole number from 1 up, got ${JSON.stringify(rawPart)}.` };
        }
        const requestedId = payload.element_id;
        let text: string;
        let what: string;
        if (requestedId !== undefined && requestedId !== null && String(requestedId).trim() !== '') {
          const el = element(doc, requestedId);
          if (!el) {
            return { success: false, error: `Element [${String(requestedId)}] is not on this page's element list. Use an element_id from the last get_page_elements or find, or read_page without element_id.` };
          }
          text = String(el.text ?? '');
          what = `Text of element [${String(requestedId)}]`;
        } else {
          text = markIfEmpty(fullPageText(doc.page.text));
          what = 'Page text';
        }
        const part = pageTextPart(text, partNumber);
        if (partNumber > part.count) {
          return { success: false, error: `${what} has only ${part.count} part${part.count === 1 ? '' : 's'}, so there is no part ${partNumber}. Read part 1 to ${part.count}.` };
        }
        return {
          success: true,
          message: `${what} (${part.note}):\n"""\n${part.text}\n"""`,
          result: { pageText: part.text, note: part.note, part: part.number, parts: part.count, hidesLines: false },
        };
      }
      case 'find_element': {
        // Mirrors the real compressor's findElements(): all candidates scored (not only the listed
        // window), ids continuing after the window ids and the earlier find ids, in the same
        // doc-scoped id space, so click and type resolve them.
        const query = typeof payload.query === 'string' ? payload.query.trim() : '';
        if (!query) {
          return { success: false, error: 'find_element needs a query: the plain words to look for, such as "next page".' };
        }
        const viewportHeight = doc.page.viewportHeight ?? DEFAULT_VIEWPORT_HEIGHT;
        const records: Array<FindCandidate<ElementSpec>> = doc.elements.map((el) => {
          const top = (el.y ?? 0) - doc.scrollY;
          const inViewport = top + ELEMENT_HEIGHT > 0 && top < viewportHeight;
          const distance = top + ELEMENT_HEIGHT <= 0 ? -(top + ELEMENT_HEIGHT) : top - viewportHeight;
          return { item: el, fields: findFieldsOf(el, doc.page.url), inViewport, distance };
        });
        const ranked = rankFindCandidates(records, query);
        const foundCount = ranked.length;
        const top = ranked.slice(0, FIND_MAX_MATCHES);
        const nthOf = nthOfElements(doc.elements);
        let nextId = Math.max(doc.listed.length, ...doc.found.map((f) => f.id), 0);
        const matches = top.map(({ item, score }) => {
          nextId++;
          const s = summarize(item, nextId, nthOf.get(item) ?? 1, doc.scrollY, viewportHeight, doc.page.url);
          doc.found.push({ el: item, id: nextId });
          return { id: nextId, line: s.formatted, score };
        });
        const result: Record<string, unknown> = {
          query,
          foundCount,
          shownCount: matches.length,
          tied: matches.length >= 2 && matches[0]!.score === matches[1]!.score,
          matches,
        };
        if (foundCount === 0) result.nearestLabels = nearestFindLabels(records, query);
        return { success: true, message: formatFindMessage(result as never), result };
      }
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
          // The found ids of earlier find_element calls survive the snapshot like the real
          // compressor's: a window id wins over a found id, and the survivors join the validation
          // set (refs) with fresh elementInfo, while shownRefs keeps only the rendered window.
          doc.found = doc.found.filter((f) => f.id > listed.length);
          const viewportHeight = doc.page.viewportHeight ?? DEFAULT_VIEWPORT_HEIGHT;
          const nthOf = nthOfElements(doc.elements);
          for (const f of doc.found) {
            const s = summarize(f.el, f.id, nthOf.get(f.el) ?? 1, doc.scrollY, viewportHeight, doc.page.url);
            snapshot.refs.push(f.id);
            snapshot.elementInfo[f.id] = elementInfoOf(f.el, s, doc.page.url);
          }
          doc.listed = listed;
          reads.push({ tabId, snapshot: structuredClone(snapshot) });
          return { success: true, data: snapshot, docId: 'fake-doc-id' };
        },
        RESOLVE_ELEMENT_POINT: (message) => {
          const payload = isObject(message) && isObject(message.payload) ? message.payload : {};
          const doc = docOf(host, tabId);
          const id = typeof payload.element_id === 'number' ? payload.element_id : undefined;
          const el = id !== undefined && id >= 1 && id <= doc.listed.length ? doc.listed[id - 1] : undefined;
          if (!el) {
            return { success: false, error: `Element [${id}] not found.` };
          }
          return {
            success: true,
            point: { x: 100, y: 100 },
            tag: el.tag.toLowerCase(),
            text: el.text || ''
          };
        },
        EFFECT_PROBE_BEGIN: () => ({ success: true }),
        EFFECT_PROBE_END: () => ({ success: true, effect: 'dom_changed' }),
        WAIT_DOM_QUIET: () => ({ success: true, quiet: true, elapsedMs: 50 }),
        CLEAR_BADGES: () => ({ success: true }),
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
