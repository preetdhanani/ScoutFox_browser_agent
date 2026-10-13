/**
 * ScoutFox Stable Element Resolver
 * Resolves element references across DOM mutations using 4 hierarchical tiers.
 */

import type { ElementLocator } from './perception.ts';

/**
 * Re-resolve element using Stable Locator descriptors to prevent stale index execution
 */
export function resolveElement(
  elementId: number | string,
  doc: Document = typeof document !== 'undefined' ? document : (null as unknown as Document),
  win: (Window & typeof globalThis) | undefined = typeof window !== 'undefined' ? window : undefined
): Element | null {
  const compressor = win && (win as any).domCompressor ? (win as any).domCompressor : null;
  const liveNode = compressor && typeof compressor.getElement === 'function' ? compressor.getElement(elementId) : null;

  // 1. Live Node Reference (if still attached to DOM)
  if (liveNode && doc && typeof doc.contains === 'function' && doc.contains(liveNode)) {
    return liveNode;
  }

  // Find descriptor from snapshot elements cache if available
  let locator: ElementLocator | null = null;
  if (compressor && Array.isArray(compressor.elements)) {
    const item = compressor.elements.find((e: any) => e.id === Number(elementId));
    if (item && item.locator) {
      locator = item.locator;
    }
  }

  if (!locator || !doc) {
    return null;
  }

  const cssObj = (win && (win as any).CSS) || (typeof CSS !== 'undefined' ? CSS : undefined);
  const escapeCss = (val: string) =>
    cssObj && typeof cssObj.escape === 'function' ? cssObj.escape(val) : val;

  // 2. Stable attributes (#id / [data-testid] / [name])
  if (locator.attrs) {
    if (locator.attrs.id && typeof doc.getElementById === 'function') {
      const el = doc.getElementById(locator.attrs.id);
      if (el && typeof doc.contains === 'function' && doc.contains(el)) return el;
    }
    if (locator.attrs['data-testid'] && typeof doc.querySelector === 'function') {
      const el = doc.querySelector(`[data-testid="${escapeCss(locator.attrs['data-testid'])}"]`);
      if (el && typeof doc.contains === 'function' && doc.contains(el)) return el;
    }
    if (locator.attrs.name && typeof doc.querySelector === 'function') {
      const el = doc.querySelector(`[name="${escapeCss(locator.attrs.name)}"]`);
      if (el && typeof doc.contains === 'function' && doc.contains(el)) return el;
    }
  }

  // 3. CSS Path
  if (locator.cssPath && typeof doc.querySelector === 'function') {
    try {
      const el = doc.querySelector(locator.cssPath);
      if (el && typeof doc.contains === 'function' && doc.contains(el)) return el;
    } catch (_) {}
  }

  // 4. Tag + Text + Role Match
  if (locator.tag && typeof doc.querySelectorAll === 'function') {
    const candidates = Array.from(doc.querySelectorAll(locator.tag));
    const matched = candidates.find((candidate) => {
      const txt = (
        (candidate as HTMLElement).innerText ||
        candidate.textContent ||
        ''
      )
        .trim()
        .replace(/\s+/g, ' ');
      return txt === locator!.text;
    });
    if (matched) return matched;
  }

  return null;
}
