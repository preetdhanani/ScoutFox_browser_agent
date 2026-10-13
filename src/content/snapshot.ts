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
