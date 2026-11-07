/**
 * Tarka Page Text Extraction and Repeat Run Collapsing
 * Pure text processing functions and scroll-aware body text extraction.
 */

import { clipWithNote, PAGE_TEXT_MORE_HINT } from '../shared/clip.ts';
import { collapseRepeatedRuns, normalizePageText } from '../shared/textPaging.ts';
// The pure helpers live in shared/textPaging.ts (the service worker pages fetched text with them too).
export { collapseRepeatedRuns, HAS_LETTER, PAGE_TEXT_PART, pageTextPart, partCount, normalizePageText, collapseRepeatedRunsOnce, REPEAT_MIN_RUN, REPEAT_MAX_UNIT_WORDS, REPEAT_MAX_PASSES, PRICE_LIKE, DELIVERY_LIKE } from '../shared/textPaging.ts';
export type { PageTextPart } from '../shared/textPaging.ts';

export const PAGE_TEXT_CAP = 4500;
export const PAGE_TEXT_SCAN_LIMIT = 1000000;

/** How the model sees more of a page text that was narrowed to the blocks around the viewport. */
const PAGE_TEXT_WINDOW_HINT = 'only the text around the scroll position; call read_page to read the whole page in parts';

/**
 * Cuts the text at the cap, at a line boundary. A text that is cut, or that is a part of a longer text of total
 * characters, ends with a note line naming the shown and the full size.
 */
export function capPageText(text: string, cap = PAGE_TEXT_CAP, total = text.length, hint = PAGE_TEXT_MORE_HINT): string {
  return clipWithNote(text, cap, { what: 'page text', total, hint });
}

/** The text with its repeated runs collapsed, and the full size to report: the collapsed size, plus what the scan limit left out. */
function collapsePageText(text: string): { text: string; total: number } {
  const scanned = text.length > PAGE_TEXT_SCAN_LIMIT ? text.slice(0, PAGE_TEXT_SCAN_LIMIT) : text;
  const collapsed = collapseRepeatedRuns(scanned);
  return { text: collapsed, total: collapsed.length + (text.length - scanned.length) };
}

/**
 * Collapses the repeated text of a rendered page, then applies the cap.
 */
export function finishPageText(text: string, cap = PAGE_TEXT_CAP): string {
  const collapsed = collapsePageText(text);
  return capPageText(collapsed.text, cap, collapsed.total);
}

/** Shown instead of a page text under PAGE_TEXT_MIN_CHARS, so the model knows the page has no readable text. Kept short: the page verdict reads a text under 120 characters as a blank page. */
export const PAGE_TEXT_EMPTY_MARKER = '[no readable text on this page]';
export const PAGE_TEXT_MIN_CHARS = 10;
/** The content blocks to read, in priority order. The first selector that matches wins, and of its matches the one with the longest visible text. */
export const CONTENT_SELECTORS = ['main', '[role="main"]', 'article', '#readme', '.markdown-body'];
/** The window of a scrolled page, in viewport pixels: from this far above the viewport ... */
const WINDOW_ABOVE = 200;
/** ... to this far below it. */
const WINDOW_BELOW = 1500;
/** How deep the window opens blocks that straddle its edges. */
const WINDOW_MAX_DEPTH = 12;

/** The visible text of an element. innerText leaves out hidden elements and reads text from any element type. */
function visibleText(el: Element): string {
  return normalizePageText((el as HTMLElement).innerText ?? el.textContent ?? '');
}

/**
 * The block to read: the first content selector that matches, the longest of its matches, else <body>.
 * A selector whose matches have no visible text is passed over, so an empty <main> shell never hides the page.
 */
function chooseContainer(doc: Document): { container: Element; text: string } | null {
  for (const selector of CONTENT_SELECTORS) {
    let best: { container: Element; text: string } | null = null;
    for (const candidate of Array.from(doc.querySelectorAll(selector))) {
      const text = visibleText(candidate);
      if (!best || text.length > best.text.length) best = { container: candidate, text };
    }
    if (best && best.text.length >= PAGE_TEXT_MIN_CHARS) return best;
  }
  return doc.body ? { container: doc.body, text: visibleText(doc.body) } : null;
}

/**
 * The element whose text a whole-page read gives (the content block, else <body>), for the links
 * of that read: a link outside it (a nav bar, a footer) is not in the text, so it is not listed.
 */
export function readRootOf(doc: Document | null | undefined): Element | null {
  if (!doc) return null;
  try {
    return chooseContainer(doc)?.container ?? doc.body ?? null;
  } catch {
    return doc.body ?? null;
  }
}

/** True when the element has text of its own (not only inside child elements), so it cannot be split into its children. */
function hasOwnText(el: Element): boolean {
  return Array.from(el.childNodes || []).some((node) => node.nodeType === 3 && (node.textContent || '').trim() !== '');
}

/**
 * The text of the blocks of a scrolled page that lie in the window around the viewport, cut by block rect.
 * A block wholly inside the window is read whole, a block outside it is skipped, and a block that straddles an
 * edge is opened into its children. A block with an empty rect is not rendered (display: none, or inside a
 * hidden element); its children are looked at, so a hidden subtree is never read.
 */
function windowedText(container: Element, viewportHeight: number): string {
  const top = -WINDOW_ABOVE;
  const bottom = viewportHeight + WINDOW_BELOW;
  const parts: string[] = [];
  const visit = (el: Element, depth: number) => {
    for (const child of Array.from(el.children)) {
      const rect = child.getBoundingClientRect();
      const empty = rect.width === 0 && rect.height === 0;
      if (!empty && (rect.bottom < top || rect.top > bottom)) continue;
      const inside = !empty && rect.top >= top && rect.bottom <= bottom;
      if (!empty && (inside || depth >= WINDOW_MAX_DEPTH || child.children.length === 0 || hasOwnText(child))) {
        const text = visibleText(child);
        if (text) parts.push(text);
      } else if (child.children.length > 0 && depth < WINDOW_MAX_DEPTH) {
        visit(child, depth + 1);
      }
    }
  };
  visit(container, 0);
  return parts.join('\n');
}

/** A page text under PAGE_TEXT_MIN_CHARS is replaced by (or, when there is some, followed by) the empty marker. */
function markIfEmpty(text: string): string {
  if (text.length >= PAGE_TEXT_MIN_CHARS) return text;
  return text ? `${text}\n${PAGE_TEXT_EMPTY_MARKER}` : PAGE_TEXT_EMPTY_MARKER;
}

/**
 * The page text the model reads: the visible text of the page's content block, any element type, with repeated
 * runs collapsed and the cap applied. A page scrolled down whose text is longer than the cap is narrowed to the
 * blocks around the viewport first. A cut or narrowed text ends with a note naming the full size.
 */
export function extractPageTextFromDocument(
  doc: Document = typeof document !== 'undefined' ? document : (null as unknown as Document),
  win: Window = typeof window !== 'undefined' ? window : (null as unknown as Window)
): string {
  return extractText(doc, win, false);
}

/**
 * The whole page text that read_page pages through: the same content block, collapsed the same way, with no
 * cap and no window, so every part of the page can be read.
 */
export function extractFullPageTextFromDocument(
  doc: Document = typeof document !== 'undefined' ? document : (null as unknown as Document),
  win: Window = typeof window !== 'undefined' ? window : (null as unknown as Window)
): string {
  return extractText(doc, win, true);
}

function extractText(doc: Document, win: Window, full: boolean): string {
  if (!doc) return '';
  const badgeContainer = doc.getElementById ? doc.getElementById('tarka-badge-container') : null;
  let prevDisplay = '';
  if (badgeContainer && badgeContainer.style) {
    prevDisplay = badgeContainer.style.display;
    badgeContainer.style.display = 'none';
  }
  try {
    const hostname = (win && win.location && win.location.hostname) || '';
    const rawContentType = Boolean(
      doc.contentType &&
      doc.contentType.startsWith('text/') &&
      doc.contentType !== 'text/html' &&
      doc.contentType !== 'text/xml'
    );
    if (hostname.includes('raw.githubusercontent.com') || rawContentType) {
      const rawText = doc.body ? ((doc.body as HTMLElement).innerText || doc.body.textContent || '') : '';
      return markIfEmpty(full ? rawText.trim() : capPageText(rawText.trim()));
    }

    const chosen = chooseContainer(doc);
    if (!chosen) return PAGE_TEXT_EMPTY_MARKER;

    const whole = collapsePageText(chosen.text);
    if (full) return markIfEmpty(whole.text);
    let finished = capPageText(whole.text, PAGE_TEXT_CAP, whole.total);
    const scrollY = win ? win.scrollY : 0;
    const vHeight = (win && win.innerHeight) ? win.innerHeight : 800;
    // Only a scrolled page whose text does not fit the cap is narrowed. The narrowed text is a part of the page,
    // so its note names the size of the whole page text and says it is the part around the scroll position.
    if (scrollY > 200 && whole.text.length > PAGE_TEXT_CAP) {
      const near = windowedText(chosen.container, vHeight);
      if (near.length >= PAGE_TEXT_MIN_CHARS) {
        const narrowed = collapsePageText(near);
        finished = capPageText(narrowed.text, PAGE_TEXT_CAP, Math.max(whole.total, narrowed.total), PAGE_TEXT_WINDOW_HINT);
      }
    }

    return markIfEmpty(finished);
  } catch {
    const bodyText = doc.body ? ((doc.body as HTMLElement).innerText || doc.body.textContent || '') : '';
    return markIfEmpty(full ? bodyText : capPageText(bodyText, 3000));
  } finally {
    if (badgeContainer && badgeContainer.style) {
      badgeContainer.style.display = prevDisplay;
    }
  }
}
