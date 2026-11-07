/**
 * Tarka DOMCompressor Class
 * Extracts interactive elements from the webpage and produces a concise structured snapshot.
 * Preserves the instance method dispatch seam for all callers and tamper scripts.
 */

import {
  extractPageTextFromDocument,
  extractFullPageTextFromDocument,
  finishPageText,
  collapseRepeatedRuns,
  capPageText,
  PAGE_TEXT_CAP
} from './pageText.ts';
import {
  generateDocId,
  getElementFromMap,
  isAttached,
  resolveElementWithStatus,
  type ElementMap,
  type ResolveElementResult
} from './refMap.ts';
import {
  computeRole,
  computeFieldKind,
  computeFormKind,
  computeHrefDomain,
  getElementSummary as formatElementSummary,
  getFocusedElementInfo,
  type FormattedElement,
  type ElementInfoRecord
} from './perception.ts';
import {
  getCssPath,
  findInteractiveElements,
  isVisible,
  orderByViewport,
  viewportPosition
} from './snapshot.ts';

export interface SnapshotOptions {
  maxElements?: number;
  withElementInfo?: boolean;
  showBadges?: boolean;
}

export interface ScrollState {
  scrollY: number;
  pageHeight: number;
  viewportHeight: number;
}

export interface DomSnapshot {
  title: string;
  url: string;
  domain: string;
  scrollState: ScrollState;
  elementCount: number;
  /** How many of the elementCount elements the list cap cut; 0 when everything fit. */
  omittedCount: number;
  elementsText: string;
  elements: FormattedElement[];
  refs: number[];
  shownRefs: number[];
  elementInfo: Record<string | number, ElementInfoRecord>;
  /** What has focus (press_key acts on it), for the risk gate; null when nothing does. */
  focused: ElementInfoRecord | null;
  pageText: string;
}

/** The last line of elementsText when the cap cut elements: the size of what is missing. */
export function omittedElementsNote(omitted: number): string {
  return `[+${omitted} more interactive elements not listed - scroll to bring them into view, or use find_element to search them]`;
}

// -------------------------------------------------------------------------------------------
// find_element: the deterministic matcher that reaches elements past the listed window
// -------------------------------------------------------------------------------------------

/** How many matches one find_element reply shows. */
export const FIND_MAX_MATCHES = 8;

/** The word characters a query and the element fields are tokenized into (ASCII plus German letters). */
const FIND_TOKEN_RE = /[a-z0-9äöüß]+/g;

/**
 * The text fields of one candidate, already read off the element. The real side reads them from the
 * DOM node, the fake content script from its element description; the scorer only sees this shape,
 * so both sides score the same way.
 */
export interface FindFields {
  text: string;
  ariaLabel: string;
  placeholder: string;
  name: string;
  title: string;
  alt: string;
  /** The path part of the link target, for "next page" style queries against /page/2. */
  hrefPath: string;
  role: string;
}

/** One candidate of a find scan: its fields, where it sits relative to the viewport, and its document order. */
export interface FindCandidate<T> {
  item: T;
  fields: FindFields;
  inViewport: boolean;
  /** Pixels from the viewport; 0 when in view. The tie-break and the nearest-labels fallback use it. */
  distance: number;
}

/** Field priority of the matcher: the visible text and the accessible name weigh most, the role least. */
const FIND_FIELD_WEIGHTS: Array<[keyof FindFields, number]> = [
  ['text', 3], ['ariaLabel', 3], ['placeholder', 2], ['name', 2], ['title', 2], ['alt', 2], ['hrefPath', 1], ['role', 1]
];

/**
 * Words of a query that say nothing about the element: a model asks in words ("the Releases link",
 * "downloads page link"), and "link" or "page" would match half the page.
 */
const FIND_FILLER = new Set(['a', 'an', 'the', 'or', 'and', 'of', 'to', 'for', 'on', 'in', 'link', 'button', 'element', 'page', 'field', 'input', 'box', 'tab', 'icon', 'menu', 'item']);

/**
 * The lowercase words of a query, deduped, without the filler words (unless the query is nothing
 * but filler). A query of only punctuation has no tokens and matches nothing.
 */
export function findQueryTokens(query: string): string[] {
  const raw = String(query).toLowerCase().match(FIND_TOKEN_RE);
  if (!raw) return [];
  const all = [...new Set(raw)];
  const meaningful = all.filter((t) => !FIND_FILLER.has(t));
  return meaningful.length ? meaningful : all;
}

/** The words of a field, with words glued to numbers in a path also split ("laptop16" is also "laptop" and "16"). */
function fieldWords(value: string): string[] {
  const raw = String(value ?? '').toLowerCase().match(FIND_TOKEN_RE) ?? [];
  return [...raw, ...raw.flatMap((t) => t.split(/(?<=[a-zäöüß])(?=[0-9])|(?<=[0-9])(?=[a-zäöüß])/))];
}

/** A query word matches a field word when they are equal, or one starts the other and is 4 or more letters ("download" finds "Downloads"). */
function wordMatches(token: string, words: Set<string>): boolean {
  if (words.has(token)) return true;
  for (const w of words) {
    if ((token.length >= 4 && w.startsWith(token)) || (w.length >= 4 && token.startsWith(w))) return true;
  }
  return false;
}

function findNorm(text: string): string {
  return String(text ?? '').toLowerCase().replace(/[^a-z0-9äöüß]+/g, ' ').trim();
}

/**
 * The score of one candidate for a tokenized query: every query token counts once, at the weight of
 * the highest-priority field that has it as a whole word, plus an exact-phrase bonus when the whole
 * query appears word for word in the text or the aria label.
 */
export function scoreFindCandidate(fields: FindFields, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const fieldTokens = new Map<keyof FindFields, Set<string>>();
  for (const [field] of FIND_FIELD_WEIGHTS) {
    fieldTokens.set(field, new Set(fieldWords(String(fields[field] ?? ''))));
  }
  let score = 0;
  for (const token of tokens) {
    for (const [field, weight] of FIND_FIELD_WEIGHTS) {
      if (wordMatches(token, fieldTokens.get(field)!)) {
        score += weight;
        break;
      }
    }
  }
  if (tokens.length > 1) {
    const phrase = tokens.join(' ');
    if (findNorm(fields.text).includes(phrase) || findNorm(fields.ariaLabel).includes(phrase)) score += 4;
  }
  return score;
}

export interface RankedFind<T> {
  item: T;
  score: number;
}

/**
 * The candidates with a score above zero, best first: score, then in-viewport over off-screen, then
 * document order. Candidates with no token in any field are left out.
 */
export function rankFindCandidates<T>(candidates: Array<FindCandidate<T>>, query: string): Array<RankedFind<T>> {
  const tokens = findQueryTokens(query);
  if (tokens.length === 0) return [];
  const scored = candidates.map((c, order) => ({
    item: c.item,
    order,
    inViewport: c.inViewport,
    score: scoreFindCandidate(c.fields, tokens)
  }));
  const hits = scored.filter((s) => s.score > 0);
  hits.sort((a, b) => b.score - a.score || (a.inViewport === b.inViewport ? a.order - b.order : a.inViewport ? -1 : 1));
  return hits.map(({ item, score }) => ({ item, score }));
}

/**
 * The labels nearest a query that matched nothing, so the model can retry with better wording:
 * candidates sharing a word prefix with a query token first (3 characters or more, either direction),
 * then the ones nearest the viewport.
 */
export function nearestFindLabels<T>(candidates: Array<FindCandidate<T>>, query: string, count: number = 5): string[] {
  const tokens = findQueryTokens(query).filter((t) => t.length >= 3);
  const labelOf = (c: FindCandidate<T>): string => {
    const f = c.fields;
    return [f.text, f.ariaLabel, f.placeholder, f.name, f.title, f.alt].find((v) => String(v ?? '').trim() !== '') ?? '';
  };
  let pool: Array<FindCandidate<T>> = [];
  if (tokens.length > 0) {
    const relaxed = candidates.map((c, order) => {
      let hits = 0;
      for (const token of tokens) {
        for (const [field] of FIND_FIELD_WEIGHTS) {
          const raw = String(c.fields[field] ?? '').toLowerCase().match(FIND_TOKEN_RE) ?? [];
          if (raw.some((ft) => ft.length >= 3 && (ft.startsWith(token) || token.startsWith(ft)))) {
            hits++;
            break;
          }
        }
      }
      return { c, order, hits };
    });
    const withHits = relaxed.filter((r) => r.hits > 0)
      .sort((a, b) => b.hits - a.hits || (a.c.inViewport === b.c.inViewport ? a.order - b.order : a.c.inViewport ? -1 : 1))
      .map((r) => r.c);
    const rest = candidates.filter((c) => !withHits.includes(c))
      .sort((a, b) => a.distance - b.distance);
    pool = [...withHits, ...rest];
  } else {
    pool = [...candidates].sort((a, b) => a.distance - b.distance);
  }
  const labels: string[] = [];
  for (const c of pool) {
    const label = labelOf(c).replace(/\s+/g, ' ').trim().slice(0, 60);
    if (label && !labels.includes(label)) labels.push(label);
    if (labels.length >= count) break;
  }
  return labels;
}

/** One match of a find_element reply: its id, its ELEMENTS-format line, and its matcher score. */
export interface FindElementMatch {
  id: number;
  line: string;
  score: number;
}

/** What findElements() returns, and what travels to the background as the action's result. */
export interface FindElementsResult {
  query: string;
  /** How many candidates matched at all (the header states this count). */
  foundCount: number;
  /** How many of them the reply shows (the cap is FIND_MAX_MATCHES). */
  shownCount: number;
  /** True when the top two scores are equal: the background may spend one model call on the order. */
  tied: boolean;
  matches: FindElementMatch[];
  /** Only on zero matches: the labels nearest the words, for a retry with better wording. */
  nearestLabels?: string[];
}

/** The model-facing text of a find_element reply: the header with both counts, then the ELEMENTS-format lines. */
export function formatFindMessage(result: {
  query: string; foundCount: number; shownCount: number; matches: Array<{ line: string }>; nearestLabels?: string[];
}): string {
  if (result.foundCount === 0) {
    const labels = (result.nearestLabels ?? []).join(', ');
    return `No element on this page matches "${result.query}".`
      + (labels ? ` Labels nearest your words: ${labels}.` : '')
      + ' Try other words and call find_element again.';
  }
  const cut = result.foundCount > result.shownCount ? ' (best matches)' : '';
  return `FOUND ${result.foundCount} match${result.foundCount === 1 ? '' : 'es'} for "${result.query}" - showing ${result.shownCount}${cut}.`
    + ` The ids below work like the ones in the ELEMENTS list:\n${result.matches.map((m) => m.line).join('\n')}`;
}

export class DOMCompressor {
  elementMap: ElementMap;
  counter: number;
  docId: string;
  elements?: FormattedElement[];
  elementInfo: Record<string | number, ElementInfoRecord>;
  /**
   * The ids find_element handed out, with their elements, kept across snapshots in the same
   * elementMap and docId so click and type resolve them after the next snapshot rebuilt the
   * window. Cleared when the page navigates (a new content script is a new compressor).
   */
  foundElements: Map<number, WeakRef<Element> | Element>;

  constructor() {
    this.elementMap = new Map();
    this.counter = 0;
    this.docId = this.generateDocId();
    this.elementInfo = {};
    this.foundElements = new Map();
  }

  generateDocId(): string {
    return generateDocId(typeof crypto !== 'undefined' ? crypto : undefined);
  }

  getSnapshot(options: SnapshotOptions = {}): DomSnapshot {
    const maxElements = options.maxElements || 120;
    this.elementMap.clear();
    this.elementInfo = {};
    this.counter = 0;
    this.docId = this.docId || this.generateDocId();

    const doc = typeof document !== 'undefined' ? document : undefined;
    const win = typeof window !== 'undefined' ? window : undefined;

    const interactiveElements = this.findInteractiveElements();
    // Viewport-first window: in-viewport elements in document order, then the off-screen ones by
    // distance to the viewport, cut at the cap. Scrolling moves the window instead of the cap
    // always keeping the top of the document (docs/langgraph-design.md, element window order).
    const ordered = orderByViewport(interactiveElements, win);
    const listed = ordered.slice(0, maxElements);
    const omittedCount = ordered.length - listed.length;

    const formattedElements: FormattedElement[] = [];

    for (const el of listed) {
      this.counter++;
      const id = this.counter;
      if (typeof WeakRef !== 'undefined') {
        this.elementMap.set(id, new WeakRef(el));
      } else {
        this.elementMap.set(id, el);
      }

      el.setAttribute('data-agent-id', String(id));
      const info = this.getElementSummary(el, id);
      formattedElements.push(info);
    }

    const title = (doc && doc.title) || 'Untitled Page';
    const url = (win && win.location && win.location.href) || '';
    const scrollY = Math.round((win && win.scrollY) || 0);
    const pageHeight = Math.round((doc && doc.documentElement && doc.documentElement.scrollHeight) || 0);
    const viewportHeight = (win && win.innerHeight) || 0;

    this.elements = formattedElements;

    let domain = '';
    try {
      domain = (win && win.location && win.location.hostname) || '';
    } catch {
      // Ignored
    }

    const elementLines = formattedElements.map((e) => e.formatted);
    const elementsText = omittedCount > 0
      ? [...elementLines, omittedElementsNote(omittedCount)].join('\n')
      : elementLines.join('\n');

    // The found ids of earlier find_element calls survive this snapshot: a window id always wins
    // over a found id (the element itself is then reachable under its new window id, so the stale
    // found id is dropped instead of being left pointing at a different element), and a found id
    // whose element left the document is dropped too. The survivors are re-registered in the new
    // elementMap and get fresh elementInfo, so the risk gate reads them like window ids.
    for (const id of [...this.foundElements.keys()]) {
      if (id <= this.counter) {
        this.foundElements.delete(id);
        continue;
      }
      const ref = this.foundElements.get(id)!;
      const el = ref instanceof WeakRef ? ref.deref() : ref;
      if (!el || !isAttached(el, doc)) {
        this.foundElements.delete(id);
        continue;
      }
      this.elementMap.set(id, ref);
      this.getElementSummary(el, id);
    }

    const windowRefs = formattedElements.map((e) => e.id);
    const refs = [...windowRefs, ...this.foundElements.keys()];

    return {
      title,
      url,
      domain,
      scrollState: { scrollY, pageHeight, viewportHeight },
      elementCount: interactiveElements.length,
      omittedCount,
      elementsText,
      elements: formattedElements,
      refs,
      shownRefs: windowRefs,
      elementInfo: this.elementInfo || {},
      focused: getFocusedElementInfo(doc, win),
      pageText: this.extractPageText()
    };
  }

  extractPageText(): string {
    const doc = typeof document !== 'undefined' ? document : undefined;
    const win = typeof window !== 'undefined' ? window : undefined;
    return extractPageTextFromDocument(doc, win);
  }

  /** The whole page text, with no cap and no window: what read_page pages through. */
  extractFullPageText(): string {
    const doc = typeof document !== 'undefined' ? document : undefined;
    const win = typeof window !== 'undefined' ? window : undefined;
    return extractFullPageTextFromDocument(doc, win);
  }

  finishPageText(text: string): string {
    return finishPageText(text);
  }

  collapseRepeatedRuns(text: string): string {
    return collapseRepeatedRuns(text);
  }

  capPageText(text: string, cap = PAGE_TEXT_CAP, total = text.length): string {
    return capPageText(text, cap, total);
  }

  getElement(id: number | string): Element | null {
    const doc = typeof document !== 'undefined' ? document : undefined;
    return getElementFromMap(this.elementMap, id, doc);
  }

  resolveElementWithStatus(id: number | string, expectedDocId?: string): ResolveElementResult {
    const doc = typeof document !== 'undefined' ? document : undefined;
    return resolveElementWithStatus(this.elementMap, id, this.docId, expectedDocId, doc);
  }

  getCssPath(el: Element): string {
    const doc = typeof document !== 'undefined' ? document : undefined;
    return getCssPath(el, doc);
  }

  findInteractiveElements(): Element[] {
    const doc = typeof document !== 'undefined' ? document : undefined;
    return findInteractiveElements(doc);
  }

  /**
   * find_element: scan ALL interactive candidates (not only the listed window), score them against
   * the query with the deterministic matcher, and give the best ones ids that continue after the
   * current counter in the same elementMap and docId, so click and type resolve them.
   */
  findElements(query: string): FindElementsResult {
    const win = typeof window !== 'undefined' ? window : undefined;
    const candidates = this.findInteractiveElements();
    const records: Array<FindCandidate<Element>> = candidates.map((el) => {
      const pos = viewportPosition(el, win);
      const tag = (el.tagName || '').toLowerCase();
      const type = ((el.getAttribute && el.getAttribute('type')) || '').toLowerCase();
      const rawHref = typeof (el as any).href === 'string' ? (el as any).href : ((el.getAttribute && el.getAttribute('href')) || '');
      let hrefPath = '';
      if (rawHref) {
        try {
          const target = new URL(rawHref, win && win.location ? win.location.href : undefined);
          hrefPath = `${target.pathname}${target.search}`;
        } catch {
          hrefPath = '';
        }
      }
      const attr = (name: string): string => (el.getAttribute && el.getAttribute(name)) || '';
      const fields: FindFields = {
        text: ((el as HTMLElement).innerText || el.textContent || ''),
        ariaLabel: attr('aria-label'),
        placeholder: attr('placeholder'),
        name: attr('name'),
        title: attr('title'),
        alt: attr('alt'),
        hrefPath,
        role: this.computeRole(el, tag, type)
      };
      return { item: el, fields, inViewport: pos.inViewport, distance: pos.distance };
    });

    const ranked = rankFindCandidates(records, query);
    const foundCount = ranked.length;
    const top = ranked.slice(0, FIND_MAX_MATCHES);

    // Ids continue after the current counter AND the ids earlier finds handed out, so a find never
    // reuses an id that still resolves to a different element.
    let nextId = Math.max(this.counter, ...this.foundElements.keys(), 0);
    const matches: FindElementMatch[] = top.map(({ item, score }) => {
      nextId++;
      const id = nextId;
      const entry: WeakRef<Element> | Element = typeof WeakRef !== 'undefined' ? new WeakRef(item) : item;
      this.elementMap.set(id, entry);
      const summary = this.getElementSummary(item, id);
      this.foundElements.set(id, entry);
      return { id, line: summary.formatted, score };
    });

    const result: FindElementsResult = {
      query,
      foundCount,
      shownCount: matches.length,
      tied: matches.length >= 2 && matches[0].score === matches[1].score,
      matches
    };
    if (foundCount === 0) result.nearestLabels = nearestFindLabels(records, query);
    return result;
  }

  isVisible(el: Element): boolean {
    return isVisible(el);
  }

  computeRole(el: Element, tagName: string, type: string): string {
    return computeRole(el, tagName, type);
  }

  computeFieldKind(el: Element, tagName: string, type: string): string | undefined {
    return computeFieldKind(el, tagName, type);
  }

  computeFormKind(el: Element): string | undefined {
    return computeFormKind(el);
  }

  computeHrefDomain(el: Element, tagName: string): string | undefined {
    const win = typeof window !== 'undefined' ? window : undefined;
    return computeHrefDomain(el, tagName, win && win.location ? win.location.href : undefined);
  }

  getElementSummary(el: Element, id: number): FormattedElement {
    const win = typeof window !== 'undefined' ? window : undefined;
    const { summary, info } = formatElementSummary(el, id, (element) => this.getCssPath(element), win);
    this.elementInfo = this.elementInfo || {};
    this.elementInfo[id] = info;
    return summary;
  }
}
