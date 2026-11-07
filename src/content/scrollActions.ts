/**
 * Tarka scroll actions: scroll_target, scroll_measure, scroll_fallback and the plain scroll, for
 * one document. The top frame's executor (actions.ts) and the frame agent of every embedded frame
 * (frameAgent.ts) both run them, each on its own document with its own kept box.
 *
 * A page shell that does not scroll, with the content in an iframe (a lesson on a learning
 * platform), has nothing to move in the top document. scroll_target then names the iframe instead
 * (`frame`), and the background repeats scroll_target in that frame, whose agent picks the box.
 */

import { pickScrollTarget, positionOf, scrollInstantly, settledPosition, stepOf, visibleRect, type ScrollBox, type ScrollPosition } from './scrollMeasure.ts';

/** An iframe that is smaller than this share of the viewport is not scrolled in place of the page. */
const FRAME_MIN_SHARE = 0.3;

/** The embedded frame a scroll goes into, and where its viewport starts in this document's viewport. */
export interface FrameRoute {
  /** The frame's path from the top page (frameIds.ts), which the background maps to a frame id. */
  path: string;
  offset: { left: number; top: number };
  /** The scroll point in the frame's own viewport, when the scroll was asked at a point. */
  point?: { x: number; y: number };
}

export interface ScrollEnv {
  /** Resolves an element id of the element list; frames have no element list. */
  resolveElement?: (id: number | string) => Element | null;
  /** The path key of the frame an iframe element shows (frameIds.ts), null when unknown. */
  framePathOf?: (frame: HTMLIFrameElement) => string | null;
  /** Words for the box, when this document is not the top page. */
  label?: (box: ScrollBox, label: string) => string;
}

/** The box the last scroll_target picked, which scroll_measure and scroll_fallback read and move. */
let scrollBox: ScrollBox = null;

function liveScrollBox(doc: Document): ScrollBox {
  return scrollBox && (scrollBox as Element).isConnected !== false && doc.contains(scrollBox) ? scrollBox : null;
}

function positionPayload(position: ScrollPosition) {
  return { top: position.top, max: position.max, height: position.height, atTop: position.atTop, atBottom: position.atBottom };
}

/** Where an iframe's document starts, in this viewport: past its border and padding. */
function contentOffset(frame: HTMLIFrameElement, win: Window): { left: number; top: number } {
  const r = frame.getBoundingClientRect();
  let padLeft = 0;
  let padTop = 0;
  try {
    const style = win.getComputedStyle(frame);
    padLeft = parseFloat(style.paddingLeft || '') || 0;
    padTop = parseFloat(style.paddingTop || '') || 0;
  } catch (_) {}
  return { left: r.left + (frame.clientLeft || 0) + padLeft, top: r.top + (frame.clientTop || 0) + padTop };
}

function isFrame(el: Element | null | undefined): el is HTMLIFrameElement {
  return !!el && (el.tagName || '').toLowerCase() === 'iframe';
}

/**
 * The embedded frame a scroll should go into, or null to scroll this document:
 *   - a point on an iframe: that frame, at the same point in its own viewport;
 *   - no element and no point, and the box this document would move cannot move that way: the
 *     largest visible iframe, when it covers at least FRAME_MIN_SHARE of the viewport.
 * An element id is never routed: element ids belong to the top document.
 */
export function frameToScroll(
  doc: Document,
  win: Window,
  at: { direction: 'up' | 'down'; element?: Element | null; point?: { x: number; y: number } | null; hit?: Element | null; before: ScrollPosition },
  framePathOf: ((frame: HTMLIFrameElement) => string | null) | undefined
): FrameRoute | null {
  if (!framePathOf || at.element) return null;
  const pathOf = (frame: HTMLIFrameElement) => {
    try {
      const path = framePathOf(frame);
      return typeof path === 'string' && path !== '' ? path : null;
    } catch (_) {
      return null;
    }
  };
  if (at.point) {
    if (!isFrame(at.hit)) return null;
    const path = pathOf(at.hit);
    if (!path) return null;
    const offset = contentOffset(at.hit, win);
    return { path, offset, point: { x: Math.round(at.point.x - offset.left), y: Math.round(at.point.y - offset.top) } };
  }
  const stuck = at.direction === 'down' ? at.before.atBottom : at.before.atTop;
  if (!stuck) return null;
  const viewport = (win.innerWidth || 0) * (win.innerHeight || 0);
  let best: HTMLIFrameElement | null = null;
  let bestArea = 0;
  for (const frame of Array.from(doc.querySelectorAll('iframe')) as HTMLIFrameElement[]) {
    const r = visibleRect(frame, win);
    const area = r ? (r.right - r.left) * (r.bottom - r.top) : 0;
    if (area > bestArea) {
      best = frame;
      bestArea = area;
    }
  }
  if (!best || viewport <= 0 || bestArea < viewport * FRAME_MIN_SHARE) return null;
  const path = pathOf(best);
  return path ? { path, offset: contentOffset(best, win) } : null;
}

/** One scroll action on this document. Unknown actions return null. */
export async function runScrollAction(payload: any, doc: Document | null | undefined, win: Window | null | undefined, env: ScrollEnv = {}): Promise<any> {
  const { action, element_id, direction } = payload || {};
  if (!['scroll', 'scroll_target', 'scroll_measure', 'scroll_fallback'].includes(action)) return null;
  if (!doc || !win) return { success: false, error: 'scroll needs a page.' };
  const words = (box: ScrollBox, label: string) => (env.label ? env.label(box, label) : label);
  switch (action) {
    case 'scroll': {
      // Only reached when the background could not drive the trusted wheel (see InputDispatcher.handleScroll):
      // the picked box is moved at once and measured, so the reply is what really happened.
      const picked = pickScrollTarget(doc, win, {});
      const before = positionOf(picked.box, doc, win);
      const sign = direction === 'up' ? -1 : 1;
      scrollInstantly(picked.box, win, sign * stepOf(before));
      const after = positionOf(picked.box, doc, win);
      return { success: true, result: { moved: after.top - before.top, label: words(picked.box, picked.label), ...positionPayload(after) } };
    }
    case 'scroll_target': {
      // The box a scroll moves and where the wheel goes: an element's box, the box under a point,
      // or the largest visible scrolling box. It is kept for scroll_measure and scroll_fallback.
      let element: Element | null = null;
      if (element_id !== undefined && element_id !== null) {
        element = env.resolveElement ? env.resolveElement(element_id) : null;
        if (!element) return { success: false, error: `Element [${element_id}] is not on this page any more. Get the element list again, or scroll without element_id.` };
      }
      const hasPoint = Number.isFinite(Number(payload.x)) && Number.isFinite(Number(payload.y)) && payload.x !== null && payload.y !== null && payload.x !== undefined && payload.y !== undefined;
      const point = hasPoint ? { x: Number(payload.x), y: Number(payload.y) } : null;
      const hit = point && typeof doc.elementFromPoint === 'function' ? doc.elementFromPoint(point.x, point.y) : null;
      const picked = pickScrollTarget(doc, win, { element, point, hit });
      scrollBox = picked.box;
      const before = positionOf(picked.box, doc, win);
      const frame = frameToScroll(doc, win, { direction: direction === 'up' ? 'up' : 'down', element, point, hit, before }, env.framePathOf);
      return { success: true, result: { point: picked.point, label: words(picked.box, picked.label), step: stepOf(before), ...positionPayload(before), ...(frame ? { frame } : {}) } };
    }
    case 'scroll_measure': {
      // The kept box's position once it stopped moving (a wheel scroll can animate).
      const box = liveScrollBox(doc);
      const settled = await settledPosition(() => positionOf(box, doc, win), {
        quietMs: Number(payload.quietMs) > 0 ? Number(payload.quietMs) : undefined,
        maxMs: Number(payload.maxMs) > 0 ? Number(payload.maxMs) : undefined
      });
      return { success: true, result: positionPayload(settled) };
    }
    case 'scroll_fallback': {
      // The wheel did not move the kept box: move it at once by delta, and measure it.
      const box = liveScrollBox(doc);
      scrollInstantly(box, win, Number(payload.delta) || 0);
      const settled = await settledPosition(() => positionOf(box, doc, win), { quietMs: 80, maxMs: 600 });
      return { success: true, result: positionPayload(settled) };
    }
  }
  return null;
}
