/**
 * ScoutFox scroll measurement: which box a scroll moves, where that box is, and whether it moved.
 *
 * The page itself often does not scroll. JupyterLab, Gmail, Slack and most web apps keep the
 * window still and scroll an inner panel, so window.scrollBy moves nothing there. The background
 * scrolls with a trusted mouse wheel at a point inside the box picked here, and this module reads
 * the box before and after, so the result says what really happened ("Scrolled the panel down
 * 640px", "Did not move: already at the bottom") instead of a "Scrolled" that is always true.
 *
 * Pure functions of a document and a window, so they can be tested without a browser.
 */

/** A box that scrolls: an element, or null for the window (the document's scrolling element). */
export type ScrollBox = Element | null;

/** Where a box is scrolled to, in CSS pixels. */
export interface ScrollPosition {
  top: number;
  /** The largest top the box can reach. */
  max: number;
  /** The visible height of the box. */
  height: number;
  atTop: boolean;
  atBottom: boolean;
}

const SCROLLS = /(auto|scroll|overlay)/;
/** How many elements the search for the largest scrolling box looks at, at most. */
const MAX_SCAN = 6000;
/** One scroll moves this share of the box's visible height, so a line at the edge stays in view. */
const STEP_SHARE = 0.8;
const MIN_STEP = 120;
/** A position within this many pixels of an edge is at that edge (sub-pixel rounding). */
const EDGE_SLACK = 1;

function styleOf(el: Element, win: Window): CSSStyleDeclaration | null {
  try {
    return win.getComputedStyle(el);
  } catch {
    return null;
  }
}

/** Whether an element scrolls vertically: an overflow that scrolls, and more content than room. */
export function scrollsVertically(el: Element, win: Window): boolean {
  const h = el as HTMLElement;
  if (!(h.scrollHeight > h.clientHeight + EDGE_SLACK)) return false;
  const style = styleOf(el, win);
  return !!style && SCROLLS.test(style.overflowY || '');
}

/** Whether the window itself scrolls: a document taller than the viewport, and no overflow:hidden on html or body. */
export function windowScrolls(doc: Document, win: Window): boolean {
  const root = (doc.scrollingElement || doc.documentElement) as HTMLElement | null;
  if (!root) return false;
  if (!(root.scrollHeight > (win.innerHeight || 0) + EDGE_SLACK)) return false;
  for (const el of [doc.documentElement, doc.body]) {
    if (!el) continue;
    const overflow = styleOf(el, win)?.overflowY || '';
    if (overflow === 'hidden' || overflow === 'clip') return false;
  }
  return true;
}

/** The element itself or the nearest ancestor (across shadow hosts) that scrolls vertically; null when only the window can. */
export function scrollBoxAround(el: Element | null, doc: Document, win: Window): ScrollBox {
  for (let node: Element | null = el, depth = 0; node && depth < 64; depth++) {
    if (node === doc.body || node === doc.documentElement) return null;
    if (scrollsVertically(node, win)) return node;
    const root = typeof node.getRootNode === 'function' ? (node.getRootNode() as any) : null;
    node = node.parentElement || (root && root.host) || null;
  }
  return null;
}

/** The part of an element's box that is inside the viewport, or null when none of it is. */
export function visibleRect(el: Element, win: Window): { left: number; top: number; right: number; bottom: number } | null {
  const r = el.getBoundingClientRect();
  const left = Math.max(0, r.left);
  const top = Math.max(0, r.top);
  const right = Math.min(win.innerWidth || 0, r.right);
  const bottom = Math.min(win.innerHeight || 0, r.bottom);
  return right > left && bottom > top ? { left, top, right, bottom } : null;
}

function areaOf(rect: { left: number; top: number; right: number; bottom: number } | null): number {
  return rect ? (rect.right - rect.left) * (rect.bottom - rect.top) : 0;
}

/** The scrolling element with the largest visible area, or null when no element scrolls. */
export function largestScrollBox(doc: Document, win: Window): Element | null {
  let best: Element | null = null;
  let bestArea = 0;
  const all = doc.querySelectorAll('*');
  const n = Math.min(all.length, MAX_SCAN);
  for (let i = 0; i < n; i++) {
    const el = all[i];
    if (el === doc.body || el === doc.documentElement) continue;
    if (!scrollsVertically(el, win)) continue;
    const area = areaOf(visibleRect(el, win));
    if (area > bestArea) {
      best = el;
      bestArea = area;
    }
  }
  return best;
}

/** Where a box is scrolled to now. */
export function positionOf(box: ScrollBox, doc: Document, win: Window): ScrollPosition {
  let top: number;
  let max: number;
  let height: number;
  if (box) {
    const h = box as HTMLElement;
    top = h.scrollTop;
    height = h.clientHeight;
    max = Math.max(0, h.scrollHeight - h.clientHeight);
  } else {
    const root = (doc.scrollingElement || doc.documentElement) as HTMLElement | null;
    top = win.scrollY || 0;
    height = win.innerHeight || 0;
    max = Math.max(0, (root ? root.scrollHeight : 0) - height);
  }
  top = Math.round(top);
  max = Math.round(max);
  return { top, max, height: Math.round(height), atTop: top <= EDGE_SLACK, atBottom: top >= max - EDGE_SLACK };
}

/** How far one scroll moves a box: most of its visible height. */
export function stepOf(position: ScrollPosition): number {
  return Math.max(MIN_STEP, Math.round(position.height * STEP_SHARE));
}

/** The name a person reads for a box: "the page", or the panel by its label. */
export function labelOfBox(box: ScrollBox): string {
  if (!box) return 'the page';
  const attr = (name: string) => (typeof box.getAttribute === 'function' ? box.getAttribute(name) || '' : '').replace(/\s+/g, ' ').trim();
  let name = attr('aria-label');
  if (!name) {
    const ids = attr('aria-labelledby').split(' ').filter(Boolean);
    const doc = box.ownerDocument;
    name = ids.map((id) => (doc && doc.getElementById(id)?.textContent) || '').join(' ').replace(/\s+/g, ' ').trim();
  }
  const tag = (box.tagName || 'div').toLowerCase();
  if (name) return `the "${name.slice(0, 60)}" ${tag === 'main' || tag === 'div' || tag === 'section' ? 'panel' : tag}`;
  const id = (box as HTMLElement).id;
  if (id) return `the scroll area #${id.slice(0, 40)}`;
  const cls = typeof (box as HTMLElement).className === 'string' ? (box as HTMLElement).className.trim().split(/\s+/)[0] : '';
  return cls ? `the scroll area ${tag}.${cls.slice(0, 40)}` : `the scroll area <${tag}>`;
}

/** The box a scroll moves and the point the wheel goes to, for an element, a point, or neither. */
export interface ScrollTarget {
  box: ScrollBox;
  point: { x: number; y: number };
  label: string;
}

/**
 * Which box to scroll:
 *   - an element: the box that scrolls it (itself or an ancestor), else the window; the wheel goes to its visible center;
 *   - a point: the box under it, else the window; the wheel goes to that point;
 *   - neither: the scrolling box with the largest visible area, the window counted as the whole viewport when it
 *     scrolls; the wheel goes to the center of that box.
 */
export function pickScrollTarget(doc: Document, win: Window, at: { element?: Element | null; point?: { x: number; y: number } | null; hit?: Element | null } = {}): ScrollTarget {
  const vw = win.innerWidth || 0;
  const vh = win.innerHeight || 0;
  const centre = { x: Math.round(vw / 2), y: Math.round(vh / 2) };
  const middleOf = (el: Element) => {
    const r = visibleRect(el, win);
    return r ? { x: Math.round((r.left + r.right) / 2), y: Math.round((r.top + r.bottom) / 2) } : centre;
  };
  if (at.element) {
    const box = scrollBoxAround(at.element, doc, win);
    return { box, point: middleOf(at.element), label: labelOfBox(box) };
  }
  if (at.point) {
    const box = scrollBoxAround(at.hit ?? null, doc, win);
    return { box, point: { x: Math.round(at.point.x), y: Math.round(at.point.y) }, label: labelOfBox(box) };
  }
  const largest = largestScrollBox(doc, win);
  const windowArea = windowScrolls(doc, win) ? vw * vh : 0;
  if (largest && areaOf(visibleRect(largest, win)) > windowArea) {
    return { box: largest, point: middleOf(largest), label: labelOfBox(largest) };
  }
  return { box: null, point: centre, label: labelOfBox(null) };
}

/** Moves a box at once, with no animation: the fallback when a wheel did not move it. */
export function scrollInstantly(box: ScrollBox, win: Window, delta: number): void {
  const target: any = box || win;
  try {
    target.scrollBy({ top: delta, behavior: 'instant' });
  } catch {
    if (box) (box as HTMLElement).scrollTop += delta;
    else win.scrollTo(win.scrollX || 0, (win.scrollY || 0) + delta);
  }
}

/**
 * Reads a box's position until it stops changing for `quietMs` (a wheel scroll can animate), or
 * `maxMs` passed. Resolves with the last reading.
 */
export async function settledPosition(
  read: () => ScrollPosition,
  { quietMs = 200, maxMs = 1500, everyMs = 40, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), now = () => Date.now() }: {
    quietMs?: number; maxMs?: number; everyMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number;
  } = {}
): Promise<ScrollPosition> {
  const start = now();
  let last = read();
  let stableSince = now();
  while (now() - start < maxMs) {
    await sleep(everyMs);
    const current = read();
    if (current.top !== last.top || current.max !== last.max) {
      last = current;
      stableSince = now();
    } else if (now() - stableSince >= quietMs) {
      break;
    }
  }
  return last;
}
