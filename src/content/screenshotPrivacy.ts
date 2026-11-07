/**
 * Tarka Screenshot Privacy
 * What must not be in a picture of the page, and what is where the model wants to click.
 *
 * A screenshot sends the page as PIXELS to a model, often a cloud model. The text path is
 * careful about sensitive values (src/content/perception.ts blanks a password field's value and
 * marks password, card and OTP fields "(user only)"), and a picture must be at least as careful,
 * or it undoes that care in one round trip.
 *
 * Two jobs, both done here because both need the same DOM access:
 *   1. maskSensitiveFields: draw an opaque cover over every field the text path would not read,
 *      and over every cross-origin iframe, whose document this script cannot see at all.
 *      The mask is an OVERLAY, never a write to the field: the page must not learn it was
 *      photographed, and the value must not be touched even briefly.
 *   2. describePoint: what is actually at a pixel a model read off a picture, so a coordinate
 *      click says what it hit. The element-id path gets this from RESOLVE_ELEMENT_POINT; a
 *      coordinate has to ask the page the same question.
 */

import { computeFieldKind } from './perception.ts';

/** The id of the layer the masks are drawn in. */
export const MASK_LAYER_ID = 'tarka-shot-mask';

/** The field kinds the text path refuses to read, and the picture must not show. */
const MASKED_FIELD_KINDS = new Set(['password', 'cc', 'otp']);

/** The kinds, in the words a person reads, for the refusal message. */
const FIELD_KIND_WORDS: Record<string, string> = {
  password: 'password field',
  cc: 'card field',
  otp: 'one-time-code field'
};

type Doc = Document;

/** A description of what is at a point, as the tool result reports it. */
export interface PointDescription {
  /** What the element is, in a short human form ("button "Buy now"", "div.overlay", "the page body"). */
  what: string;
  /** True when the element is a control a person would click. */
  interactive: boolean;
  /** The field kind when the point is on a masked field, which refuses the click. */
  fieldKind?: string;
}

/** A short description of an element: tag, id, class, and a little of its text. */
export function describePointElement(el: Element | null): string {
  if (!el) return 'nothing';
  const tag = (el.tagName || '').toLowerCase() || 'element';
  if (tag === 'body' || el === el.ownerDocument?.body) return 'the page body';
  if (tag === 'html' || el === el.ownerDocument?.documentElement) return 'the page';
  let out = tag;
  const id = el.getAttribute?.('id');
  if (id) out += `#${id}`;
  else {
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.') : '';
    if (cls) out += `.${cls}`;
  }
  const label = (
    el.getAttribute?.('aria-label')
    || (el as HTMLInputElement).innerText
    || (el as HTMLInputElement).value
    || el.getAttribute?.('placeholder')
    || el.textContent
    || ''
  ).trim().replace(/\s+/g, ' ');
  if (label) out += ` ${JSON.stringify(label.slice(0, 60))}`;
  // An embedded frame has no text of its own here: its title and host say what it is (a lesson, a
  // CAPTCHA), and the click refusal for bot checks reads them.
  if (tag === 'iframe') {
    const title = (el.getAttribute?.('title') || '').trim().replace(/\s+/g, ' ');
    let host = '';
    try {
      host = new URL(el.getAttribute?.('src') || '', el.ownerDocument?.baseURI || undefined).host;
    } catch (_) {}
    if (title) out += ` ${JSON.stringify(title.slice(0, 60))}`;
    if (host) out += ` (${host})`;
  }
  return out;
}

/** Whether the element is something a person would click, rather than a wrapper or a surface. */
export function isInteractiveElement(el: Element | null): boolean {
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'a' || tag === 'button' || tag === 'select' || tag === 'textarea' || tag === 'summary') return true;
  if (tag === 'input') return (el as HTMLInputElement).type !== 'hidden';
  if (typeof el.closest === 'function' && el.closest('a, button, [role="button"], [role="link"], [role="menuitem"], [role="tab"], label')) return true;
  const tabindex = el.getAttribute?.('tabindex');
  return tabindex !== null && tabindex !== undefined && tabindex !== '-1';
}

/**
 * The element a click at a viewport point lands on. elementFromPoint stops at a shadow host; the
 * click lands on what is inside it, so that is what is described and checked (a page built from
 * web components would otherwise be one host).
 */
function deepHit(doc: Doc, x: number, y: number): Element | null {
  let hit = typeof doc.elementFromPoint === 'function' ? doc.elementFromPoint(x, y) : null;
  for (let depth = 0; hit?.shadowRoot && typeof hit.shadowRoot.elementFromPoint === 'function' && depth < 32; depth++) {
    const inner = hit.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === hit) break;
    hit = inner;
  }
  return hit;
}

/** Whether inner is outer or inside it, across shadow roots. */
function composedContains(outer: Element, inner: Element | null): boolean {
  for (let node: any = inner; node; node = node.parentNode || node.host || null) {
    if (node === outer) return true;
  }
  return false;
}

/** How far, in CSS pixels, a coordinate click is moved onto the control next to it. */
export const SNAP_RADIUS_PX = 16;

/** Two controls whose distances differ by less than this are equally close: no snap, the intent is not clear. */
export const SNAP_TIE_PX = 4;

/** What a click can be moved onto: the controls a person clicks. */
const SNAP_SELECTOR = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="tab"], [role="radio"], [role="menuitem"], [role="option"], [role="switch"], [onclick]';

/** A coordinate click moved onto the control next to it. */
export interface PointSnap {
  x: number;
  y: number;
  /** The control, in the short human form describePointElement gives. */
  what: string;
  /** How far the point was from the control's box, in CSS pixels. */
  distance: number;
}

/**
 * A coordinate that landed just next to a control, moved onto the control's center.
 *
 * A vision model points within a few pixels of what it means, and a small control (a 28 px close
 * icon, a 20 px tall cookie button) is easy to miss by that much: the click then lands on the
 * banner around the button and nothing happens. So a point that is NOT on something clickable is
 * moved onto the nearest control within SNAP_RADIUS_PX, when that control is the clear nearest one
 * and its center really receives a click there. A point already on a control, or on a surface that
 * is clickable itself (cursor: pointer), is left alone. Masked fields are never a snap target.
 */
export function snapPoint(doc: Doc, x: number, y: number, radius = SNAP_RADIUS_PX): PointSnap | null {
  const hit = deepHit(doc, x, y);
  if (hit && isInteractiveElement(hit)) return null;
  // A canvas, a drawing or an editor takes clicks anywhere on itself: a point on it is meant there.
  const hitTag = (hit?.tagName || '').toLowerCase();
  if (hitTag === 'canvas' || hitTag === 'svg' || (hit as HTMLElement | null)?.isContentEditable === true) return null;
  const view = (doc as any).defaultView as Window | null | undefined;
  if (hit && view && typeof view.getComputedStyle === 'function') {
    try {
      if (view.getComputedStyle(hit).cursor === 'pointer') return null;
    } catch (_) { /* a style that cannot be read is no evidence either way */ }
  }
  if (typeof (doc as any).querySelectorAll !== 'function') return null;

  const near: Array<{ el: Element; distance: number; cx: number; cy: number }> = [];
  for (const root of collectRoots(doc)) {
    for (const el of Array.from(root.querySelectorAll(SNAP_SELECTOR)) as Element[]) {
      const r = el.getBoundingClientRect();
      if (!r || r.width <= 0 || r.height <= 0) continue;
      const dx = Math.max(r.left - x, 0, x - (r.left + r.width));
      const dy = Math.max(r.top - y, 0, y - (r.top + r.height));
      const distance = Math.hypot(dx, dy);
      if (distance > radius) continue;
      const tag = (el.tagName || '').toLowerCase();
      const kind = computeFieldKind(el, tag, tag === 'input' ? (el as HTMLInputElement).type : '');
      if (kind && MASKED_FIELD_KINDS.has(kind)) continue;
      near.push({ el, distance, cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) });
    }
  }
  // A point already on a candidate, or inside one (a card with an onclick around the text), is a
  // click on that candidate: moving it to the center of the card could land on another control in it.
  if (near.some((c) => c.distance === 0 || (hit && composedContains(c.el, hit)))) return null;
  // An element and the controls inside it: the innermost is the target a person aims at.
  const targets = near.filter((a) => !near.some((b) => b !== a && b.el !== a.el && composedContains(a.el, b.el)));
  targets.sort((a, b) => a.distance - b.distance);
  const best = targets[0];
  if (!best) return null;
  if (targets[1] && targets[1].distance - best.distance < SNAP_TIE_PX) return null;
  // The center must really receive the click: a control under an overlay is not a target.
  if (!composedContains(best.el, deepHit(doc, best.cx, best.cy))) return null;
  return { x: best.cx, y: best.cy, what: describePointElement(best.el), distance: Math.round(best.distance) };
}

/**
 * What is at a viewport point, for a coordinate click. The point is in CSS pixels.
 *
 * A masked field refuses the click: that is the one enforcement the text path does not have, and
 * a click on a password field is never something the agent should do on its own.
 */
export function describePoint(doc: Doc, x: number, y: number): PointDescription {
  const hit = deepHit(doc, x, y);
  const what = describePointElement(hit);
  if (!hit) return { what, interactive: false };
  const tag = (hit.tagName || '').toLowerCase();
  const type = tag === 'input' ? (hit as HTMLInputElement).type : '';
  const kind = computeFieldKind(hit, tag, type);
  const maskedKind = kind && MASKED_FIELD_KINDS.has(kind) ? kind : undefined;
  return {
    what,
    interactive: isInteractiveElement(hit),
    ...(maskedKind ? { fieldKind: maskedKind } : {})
  };
}

/** Same-origin frames nested deeper than this are covered whole rather than walked. */
const MAX_FRAME_DEPTH = 8;

type Scope = Pick<Document, 'querySelectorAll'>;

/** The root itself and every open shadow root under it, at any depth. Closed roots are not reachable. */
function collectRoots(root: Scope): Scope[] {
  const out: Scope[] = [root];
  for (let i = 0; i < out.length; i++) {
    for (const el of Array.from(out[i].querySelectorAll('*'))) {
      const sr = (el as Element).shadowRoot;
      if (sr) out.push(sr);
    }
  }
  return out;
}

function shift(rect: { left: number; top: number; width: number; height: number }, offset: { left: number; top: number }) {
  return { left: rect.left + offset.left, top: rect.top + offset.top, width: rect.width, height: rect.height };
}

/** The frame's padding in CSS pixels; zero when the computed style cannot be read. */
function framePadding(frame: HTMLIFrameElement, view: Window | null | undefined): { left: number; top: number } {
  try {
    const style = view && typeof view.getComputedStyle === 'function' ? view.getComputedStyle(frame) : null;
    return {
      left: parseFloat(style?.paddingLeft || '') || 0,
      top: parseFloat(style?.paddingTop || '') || 0
    };
  } catch (_) {
    return { left: 0, top: 0 };
  }
}

/** The refusal a click on a masked field gets. */
export function maskedFieldRefusal(kind: string): string {
  return `Error: that point is on a ${FIELD_KIND_WORDS[kind] || 'sensitive field'}, so the click was refused.`;
}

type Rect = { left: number; top: number; width: number; height: number };

/**
 * Says whether an iframe this script cannot read may stay uncovered: true only for a frame whose
 * own frame agent confirmed its covers (content/frameAgent.js). The caller maps the element to the
 * frame's path (frameIds.ts); anything it cannot map is not shown.
 */
export type FrameShown = (frame: HTMLIFrameElement) => boolean;

/** Nothing is shown: every unreadable iframe is covered whole. */
const NONE_SHOWN: FrameShown = () => false;

/**
 * Every field the text path refuses to read, and every iframe whose document this script cannot
 * read, in this document, in every open shadow root under it, and in every same-origin iframe under
 * it (recursively, so a cross-origin payment frame inside a same-origin wrapper is still found).
 * Rects are in this document's viewport coordinates.
 */
function walkSensitive(doc: Doc, onField: (el: Element, rect: Rect, kind: string) => void, onFrame: (frame: HTMLIFrameElement, rect: Rect) => void): void {
  // `offset` moves a frame's own viewport coordinates into the page's.
  const walkDocument = (root: Doc, offset: { left: number; top: number }, depth: number) => {
    for (const scope of collectRoots(root)) {
      for (const el of Array.from(scope.querySelectorAll('input, textarea'))) {
        // A textarea with no sensitive kind holds ordinary text, which is already visible in the
        // text path; only a kind the text path refuses is covered.
        const tag = (el.tagName || '').toLowerCase();
        const type = tag === 'input' ? (el as HTMLInputElement).type : '';
        const kind = computeFieldKind(el, tag, type);
        if (kind && MASKED_FIELD_KINDS.has(kind)) onField(el, shift(el.getBoundingClientRect(), offset), kind);
      }

      for (const frame of Array.from(scope.querySelectorAll('iframe')) as HTMLIFrameElement[]) {
        const frameRect = shift(frame.getBoundingClientRect(), offset);
        let inner: Doc | null = null;
        try {
          inner = frame.contentDocument;
        } catch (_) {
          inner = null;
        }
        if (inner && depth < MAX_FRAME_DEPTH) {
          try {
            // The inner document starts at the frame's content box: past its border
            // (clientLeft/clientTop) and its padding.
            const padding = framePadding(frame, root.defaultView);
            walkDocument(
              inner,
              {
                left: frameRect.left + (frame.clientLeft || 0) + padding.left,
                top: frameRect.top + (frame.clientTop || 0) + padding.top
              },
              depth + 1
            );
            continue;
          } catch (_) {
            // A frame that turned unreadable mid-walk is handled as unreadable below.
          }
        }
        onFrame(frame, frameRect);
      }
    }
  };
  walkDocument(doc, { left: 0, top: 0 }, 0);
}

/**
 * What the last mask walk covered or let through in each document, so the check after the capture
 * can tell a field or frame that appeared since (it was in the picture uncovered).
 */
const seenAtMask = new WeakMap<Doc, { fields: WeakSet<Element>; frames: WeakSet<Element>; layer: HTMLElement | null }>();

/**
 * Draws the covers over the sensitive fields and the cross-origin iframes, and returns the layer
 * so it can be removed again. Nothing in the page is modified except one appended element.
 *
 * A same-origin iframe is not masked as a whole: its document is readable, so its own fields,
 * shadow roots and nested iframes are walked like the rest of the page (it is treated as
 * cross-origin only when its document is not readable). Open shadow roots are walked too, since
 * querySelectorAll does not enter them; a closed shadow root cannot be reached from here.
 *
 * An unreadable iframe for which `shown` says true is left uncovered: its own frame agent covered
 * its fields (fail closed: the default shows none).
 */
export function maskSensitiveFields(doc: Doc, win?: Window, shown: FrameShown = NONE_SHOWN): HTMLElement | null {
  if (!doc || !doc.createElement) return null;
  // A layer from an earlier capture that never got removed must not stack up.
  removeSensitiveMasks(doc);

  const layer = doc.createElement('div');
  layer.id = MASK_LAYER_ID;
  layer.style.position = 'fixed';
  layer.style.top = '0';
  layer.style.left = '0';
  layer.style.width = '100%';
  layer.style.height = '100%';
  layer.style.pointerEvents = 'none';
  layer.style.zIndex = '2147483646';

  const parent = doc.body || doc.documentElement;
  if (!parent) return null;

  const cover = (rect: Rect, label: string) => {
    if (rect.width <= 0 || rect.height <= 0) return;
    const box = doc.createElement('div');
    box.className = 'tarka-shot-mask';
    box.setAttribute('data-mask', label);
    box.style.position = 'fixed';
    box.style.left = `${Math.max(0, rect.left)}px`;
    box.style.top = `${Math.max(0, rect.top)}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
    // The same weight as the field, so the picture shows THAT a field is there without showing
    // what is in it. The label is not drawn: it would be read by the model.
    box.style.background = '#2b2b2b';
    box.style.borderRadius = '2px';
    box.style.boxShadow = 'inset 0 0 0 1px rgba(255,255,255,0.18)';
    layer.appendChild(box);
  };

  const seen = { fields: new WeakSet<Element>(), frames: new WeakSet<Element>(), layer: null as HTMLElement | null };
  // The mask over an unreadable frame that no agent vouched for is the whole rectangle, which means
  // the model cannot see anything inside it. That trade-off is stated in docs/screenshot.md.
  walkSensitive(
    doc,
    (el, rect, kind) => {
      seen.fields.add(el);
      cover(rect, kind);
    },
    (frame, rect) => {
      seen.frames.add(frame);
      let vouched = false;
      try {
        vouched = shown(frame) === true;
      } catch (_) {
        vouched = false;
      }
      if (!vouched) cover(rect, 'iframe');
    }
  );

  // A layer with no covers is not worth appending: an empty fixed layer is still a DOM change.
  if (layer.childElementCount > 0) {
    parent.appendChild(layer);
    seen.layer = layer;
  }
  seenAtMask.set(doc, seen);
  // The window argument is kept for the signature the callers use; the layer is positioned in
  // viewport coordinates by CSS, so no scroll offset is needed.
  void win;
  return seen.layer;
}

/**
 * After the capture: do the covers drawn by the last maskSensitiveFields still hold? False when no
 * mask walk ran in this document, when the layer was taken out of the page, or when a sensitive
 * field or an unreadable iframe exists now that the walk did not see (it was in the picture with
 * no cover). A false throws the picture away.
 */
export function masksStillHold(doc: Doc): boolean {
  if (!doc) return false;
  const seen = seenAtMask.get(doc);
  if (!seen) return false;
  if (seen.layer && (seen.layer.isConnected === false || (typeof doc.contains === 'function' && !doc.contains(seen.layer)))) return false;
  let holds = true;
  walkSensitive(
    doc,
    (el) => {
      if (!seen.fields.has(el)) holds = false;
    },
    (frame) => {
      if (!seen.frames.has(frame)) holds = false;
    }
  );
  return holds;
}

/** Removes the mask layer, if one is up. */
export function removeSensitiveMasks(doc: Doc): void {
  if (!doc || !doc.getElementById) return;
  const existing = doc.getElementById(MASK_LAYER_ID);
  if (existing && typeof existing.remove === 'function') existing.remove();
}
