/**
 * ScoutFox Stable Element Resolver
 * Resolves element references across DOM mutations using the live reference
 * plus a recovery tier over stable attributes only. The unanchored CSS path
 * and the same-tag same-text tiers were removed: both could silently hit a
 * different element after a re-render (the first radio button, the first of
 * several equal buttons).
 */

import type { ElementLocator } from './perception.ts';
import { isAttached } from './refMap.ts';

export interface ResolvedElement {
  element: Element | null;
  /** Set when the element was re-found by its stable attributes after the live reference went stale. */
  recoveredBy?: 'stable-id';
}

/** An element counts as visible when it has a non-zero box, or when visibility cannot be measured. */
function isVisibleEnough(el: Element): boolean {
  const anyEl = el as HTMLElement;
  if (typeof anyEl.getBoundingClientRect !== 'function') return true;
  try {
    const rect = anyEl.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  } catch (_) {
    return true;
  }
}

/**
 * Re-resolve element using Stable Locator descriptors to prevent stale index execution.
 * The stable-attribute tier only accepts exactly one visible match, and reports the hit
 * as a recovery so callers can say the element was re-rendered and found again.
 */
export function resolveElementDetailed(
  elementId: number | string,
  doc: Document = typeof document !== 'undefined' ? document : (null as unknown as Document),
  win: (Window & typeof globalThis) | undefined = typeof window !== 'undefined' ? window : undefined
): ResolvedElement {
  const compressor = win && (win as any).domCompressor ? (win as any).domCompressor : null;
  const liveNode = compressor && typeof compressor.getElement === 'function' ? compressor.getElement(elementId) : null;

  // 1. Live Node Reference (if still attached to DOM)
  if (liveNode && doc && isAttached(liveNode, doc)) {
    return { element: liveNode };
  }

  // Find descriptor from snapshot elements cache if available
  let locator: ElementLocator | null = null;
  if (compressor && Array.isArray(compressor.elements)) {
    const item = compressor.elements.find((e: any) => e.id === Number(elementId));
    if (item && item.locator) {
      locator = item.locator;
    }
  }

  // A shadow-root element's id and name mean nothing in the document: a light-DOM element with the
  // same id would be a different control. Such an element is gone once its live node is gone.
  if (!locator || !doc || locator.inShadow) {
    return { element: null };
  }

  const cssObj = (win && (win as any).CSS) || (typeof CSS !== 'undefined' ? CSS : undefined);
  const escapeCss = (val: string) =>
    cssObj && typeof cssObj.escape === 'function' ? cssObj.escape(val) : val;

  const attached = (el: Element | null): el is Element =>
    !!el && typeof doc.contains === 'function' && doc.contains(el);

  // 2. Recovery over stable attributes (#id / [data-testid] / [name]), each only with
  //    exactly one visible match, so an ambiguous attribute can never hit the wrong twin.
  if (locator.attrs) {
    if (locator.attrs.id && typeof doc.getElementById === 'function') {
      const el = doc.getElementById(locator.attrs.id);
      if (attached(el) && isVisibleEnough(el)) {
        return { element: el, recoveredBy: 'stable-id' };
      }
    }
    if (locator.attrs['data-testid'] && typeof doc.querySelectorAll === 'function') {
      let matches: Element[] = [];
      try {
        matches = Array.from(doc.querySelectorAll(`[data-testid="${escapeCss(locator.attrs['data-testid'])}"]`));
      } catch (_) {}
      if (matches.length === 1 && attached(matches[0]) && isVisibleEnough(matches[0])) {
        return { element: matches[0], recoveredBy: 'stable-id' };
      }
    }
    if (locator.attrs.name && typeof doc.querySelectorAll === 'function') {
      let matches: Element[] = [];
      try {
        matches = Array.from(doc.querySelectorAll(`[name="${escapeCss(locator.attrs.name)}"]`));
      } catch (_) {}
      if (matches.length === 1 && attached(matches[0]) && isVisibleEnough(matches[0])) {
        return { element: matches[0], recoveredBy: 'stable-id' };
      }
    }
  }

  return { element: null };
}

/**
 * Re-resolve element using Stable Locator descriptors to prevent stale index execution
 */
export function resolveElement(
  elementId: number | string,
  doc: Document = typeof document !== 'undefined' ? document : (null as unknown as Document),
  win: (Window & typeof globalThis) | undefined = typeof window !== 'undefined' ? window : undefined
): Element | null {
  return resolveElementDetailed(elementId, doc, win).element;
}
