/**
 * ScoutFox Interactive Element Selection and CSS Path Computation
 * Queries interactive elements and checks real-time viewport and layout visibility.
 */

export const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="textbox"]',
  '[role="combobox"]',
  '[role="tab"]',
  '[tabindex="0"]',
  '[onclick]'
].join(',');

/**
 * Check if element is visible on screen.
 */
export function isVisible(el: Element): boolean {
  if (!el) return false;
  const anyEl = el as Element & { checkVisibility?: (options?: { checkOpacity?: boolean; checkVisibilityCSS?: boolean }) => boolean };
  if (typeof anyEl.checkVisibility === 'function') {
    if (!anyEl.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
  }

  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;

  return true;
}

/**
 * Compute stable CSS selector path for an element.
 */
export function getCssPath(
  el: Element,
  doc: Document = typeof document !== 'undefined' ? document : (null as unknown as Document)
): string {
  if (!el || el.nodeType !== 1) return ''; // Node.ELEMENT_NODE === 1
  const cssObj = typeof CSS !== 'undefined' ? CSS : undefined;
  const escapeCss = (id: string) => (cssObj && typeof cssObj.escape === 'function' ? cssObj.escape(id) : id);

  if (el.id) return `#${escapeCss(el.id)}`;

  const path: string[] = [];
  let current: Element | null = el;
  const body = doc ? doc.body : null;

  while (current && current.nodeType === 1 && current !== body) {
    let selector = current.tagName.toLowerCase();
    if (current.id) {
      selector = `#${escapeCss(current.id)}`;
      path.unshift(selector);
      break;
    } else {
      let sibling: Element | null = current;
      let nth = 1;
      while ((sibling = sibling.previousElementSibling)) {
        if (sibling.tagName.toLowerCase() === selector) nth++;
      }
      if (nth > 1) selector += `:nth-of-type(${nth})`;
    }
    path.unshift(selector);
    current = current.parentElement;
  }
  return path.join(' > ');
}

/**
 * Find interactive and focusable elements on the page.
 */
export function findInteractiveElements(
  doc: Document = typeof document !== 'undefined' ? document : (null as unknown as Document)
): Element[] {
  if (!doc || typeof doc.querySelectorAll !== 'function') return [];
  const candidates = Array.from(doc.querySelectorAll(INTERACTIVE_SELECTOR));
  return candidates.filter((el) => isVisible(el));
}

/**
 * Where an element sits relative to the viewport: inside it, or how many pixels its nearest edge
 * is away from it. The same containment test perception.ts uses for the [off-screen] marker, so
 * the ordering and the marker never disagree. An element whose rect cannot be read counts as
 * in-viewport, like the marker does.
 */
export function viewportPosition(
  el: Element,
  win?: Window | null
): { inViewport: boolean; distance: number } {
  try {
    const rect = el.getBoundingClientRect();
    const vw = (win && win.innerWidth) || 0;
    const vh = (win && win.innerHeight) || 0;
    if (rect.bottom > 0 && rect.right > 0 && rect.top < vh && rect.left < vw) {
      return { inViewport: true, distance: 0 };
    }
    const distance = rect.bottom <= 0 ? -rect.bottom : rect.top - vh;
    return { inViewport: false, distance: Number.isFinite(distance) ? distance : Number.MAX_SAFE_INTEGER };
  } catch {
    return { inViewport: true, distance: 0 };
  }
}

/**
 * The element window order: the elements inside the viewport in document order first, then the
 * off-screen ones ordered by their distance to the viewport. The list cap cuts this order, so
 * scrolling moves the window instead of the cap always keeping the top of the document.
 */
export function orderByViewport(elements: Element[], win?: Window | null): Element[] {
  const inside: Element[] = [];
  const outside: Array<{ el: Element; distance: number }> = [];
  for (const el of elements) {
    const pos = viewportPosition(el, win);
    if (pos.inViewport) inside.push(el);
    else outside.push({ el, distance: pos.distance });
  }
  outside.sort((a, b) => a.distance - b.distance);
  return [...inside, ...outside.map((o) => o.el)];
}
