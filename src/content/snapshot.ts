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
  'summary',
  'details > summary',
  '[contenteditable="true"]',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="textbox"]',
  '[role="combobox"]',
  '[role="tab"]',
  '[role="radio"]',
  '[role="menuitem"]',
  '[role="menuitemradio"]',
  '[role="option"]',
  '[role="switch"]',
  '[role="slider"]',
  '[role="treeitem"]',
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
 * The control a <label> stands for: the labeled control property, then for="", then a control the
 * label wraps. Null when the label has none.
 */
function labeledControl(label: Element, doc: Pick<Document, 'getElementById'>): Element | null {
  const control = (label as HTMLLabelElement).control;
  if (control && control.nodeType === 1) return control;
  const forId = label.getAttribute('for');
  if (forId && typeof doc.getElementById === 'function') {
    const byFor = doc.getElementById(forId);
    if (byFor) return byFor;
  }
  if (typeof label.querySelector === 'function') {
    try {
      return label.querySelector('input, select, textarea');
    } catch {
      return null;
    }
  }
  return null;
}

/** True when an ancestor of the element is already listed, so the ancestor covers the click. */
function hasListedAncestor(el: Element, kept: Set<Element>): boolean {
  let parent = composedParent(el);
  while (parent) {
    if (kept.has(parent)) return true;
    parent = composedParent(parent);
  }
  return false;
}

/** The parent of an element, crossing out of a shadow root to its host. */
function composedParent(el: Element): Element | null {
  if (el.parentElement) return el.parentElement;
  const root = (el as Element & { parentNode?: { host?: Element } | null }).parentNode;
  return root && root.host ? root.host : null;
}

/** A document or a shadow root: where the passes below look for elements. */
type Scope = Pick<Document, 'querySelectorAll'> & Partial<Pick<Document, 'getElementById'>>;

/**
 * Every open shadow root under a root, at any depth, in tree order. A cookie banner or a booking
 * widget built from web components keeps its buttons in one, where document.querySelectorAll never
 * looks. Closed roots cannot be reached from a page script.
 */
function openShadowRoots(root: Scope): Scope[] {
  const out: Scope[] = [];
  for (const el of Array.from(root.querySelectorAll('*'))) {
    const shadow = (el as Element).shadowRoot as unknown as Scope | null | undefined;
    if (shadow && typeof shadow.querySelectorAll === 'function') out.push(shadow, ...openShadowRoots(shadow));
  }
  return out;
}

/**
 * The position of every element in tree order, with the content of a shadow root placed right
 * after its host. compareDocumentPosition has no order between two trees, so this is how elements
 * from the document and from shadow roots are put in one order.
 */
function composedOrder(doc: Scope): Map<Element, number> {
  const order = new Map<Element, number>();
  const visit = (root: Scope): void => {
    for (const el of Array.from(root.querySelectorAll('*'))) {
      order.set(el as Element, order.size);
      const shadow = (el as Element).shadowRoot as unknown as Scope | null | undefined;
      if (shadow && typeof shadow.querySelectorAll === 'function') visit(shadow);
    }
  };
  visit(doc);
  return order;
}

/**
 * The cheap clickable heuristic: a text-bearing leaf whose computed cursor is pointer. Cursor is
 * inherited, so the text leaf of a pointer-styled card matches, and its click bubbles to the
 * card's handler. Elements with element children are no leaves, so a card that also holds a real
 * button is never listed over that button.
 */
function isClickableLeaf(el: Element, win?: Window | null): boolean {
  const children = (el as Element & { children?: ArrayLike<Element> }).children;
  if (children && children.length > 0) return false;
  const text = ((el as HTMLElement).innerText || el.textContent || '').trim();
  if (!text) return false;
  const styleReader = win && typeof win.getComputedStyle === 'function' ? win.getComputedStyle : (typeof window !== 'undefined' ? window.getComputedStyle : undefined);
  if (!styleReader) return false;
  try {
    return styleReader(el).cursor === 'pointer';
  } catch {
    return false;
  }
}

/** Sorts into document order when the elements can say their position, so the element window keeps DOM order. */
const DOCUMENT_POSITION_FOLLOWING = 4;
const DOCUMENT_POSITION_PRECEDING = 2;

function inDocumentOrder(elements: Element[]): Element[] {
  if (elements.length < 2) return elements;
  const probe = elements[0] as Element & { compareDocumentPosition?: (other: Element) => number };
  if (typeof probe.compareDocumentPosition !== 'function') return elements;
  return [...elements].sort((a, b) => {
    const pos = (a as Element & { compareDocumentPosition(other: Element): number }).compareDocumentPosition(b);
    if (pos & DOCUMENT_POSITION_FOLLOWING) return -1;
    if (pos & DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });
}

/**
 * Find interactive and focusable elements on the page.
 *
 * Three passes, deduped to exactly one id per physical target, merged back into document order:
 *   1. the selector matches (the visibility rules of these are unchanged);
 *   2. a label whose associated control is visually hidden (a styled radio or checkbox over a
 *      zero-size native input): the label is the one visible, clickable thing of the pair, so it
 *      carries the id, and a click on it activates the control like a user's click does;
 *   3. handler-only clickables: a text-bearing leaf with computed cursor pointer and no listed
 *      clickable ancestor (an addEventListener card, swatch or custom dropdown option).
 */
export function findInteractiveElements(
  doc: Document = typeof document !== 'undefined' ? document : (null as unknown as Document)
): Element[] {
  if (!doc || typeof doc.querySelectorAll !== 'function') return [];
  const listed: Element[] = [];
  const kept = new Set<Element>();
  const add = (el: Element): void => {
    if (kept.has(el)) return;
    listed.push(el);
    kept.add(el);
  };
  // The document first, then each open shadow root: the same three passes in every one.
  const shadows = openShadowRoots(doc);
  for (const scope of [doc as Scope, ...shadows]) collectFrom(scope, doc, add, kept, scope !== doc);

  if (shadows.length === 0) return inDocumentOrder(listed);
  const order = composedOrder(doc);
  return [...listed].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
}

/** The three passes of findInteractiveElements over one document or shadow root. */
function collectFrom(scope: Scope, doc: Document, add: (el: Element) => void, kept: Set<Element>, inShadow = false): void {
  // A label's for="" names an id in its own tree, so a shadow root looks it up in itself.
  const idScope = typeof scope.getElementById === 'function' ? (scope as Pick<Document, 'getElementById'>) : doc;
  for (const el of Array.from(scope.querySelectorAll(INTERACTIVE_SELECTOR))) {
    // A control inside a host that is listed already (<x-btn role="button"> around its own
    // <button>) is the same target: one id for it, not two.
    if (isVisible(el) && !(inShadow && hasListedAncestor(el, kept))) add(el);
  }

  for (const label of Array.from(scope.querySelectorAll('label'))) {
    if (kept.has(label) || !isVisible(label) || hasListedAncestor(label, kept)) continue;
    const control = labeledControl(label, idScope);
    if (!control || (control.getAttribute('type') || '').toLowerCase() === 'hidden' || isVisible(control)) continue;
    add(label);
  }

  for (const el of Array.from(scope.querySelectorAll('*'))) {
    if (kept.has(el) || !isVisible(el) || hasListedAncestor(el, kept)) continue;
    if ((el.tagName || '').toLowerCase() === 'label') {
      const control = labeledControl(el, idScope);
      if (control && isVisible(control)) continue;
    }
    if (!isClickableLeaf(el, doc.defaultView)) continue;
    add(el);
  }
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
