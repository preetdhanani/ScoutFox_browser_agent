/**
 * Tarka Element Reference Map and Navigation State
 * Manages numeric element ID assignment, WeakRef dereferencing, and document freshness checks.
 */

export type ElementEntry = Element | WeakRef<Element>;
export type ElementMap = Map<number, ElementEntry>;

export interface ResolveElementResult {
  success: boolean;
  element?: Element;
  stale?: boolean;
  error?: string;
}

/**
 * Generates a random document ID using Crypto.getRandomValues with Math.random fallback.
 */
export function generateDocId(cryptoObj: Crypto = typeof crypto !== 'undefined' ? crypto : (null as unknown as Crypto)): string {
  try {
    if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
      const buf = new Uint32Array(2);
      cryptoObj.getRandomValues(buf);
      return `${buf[0].toString(36)}-${buf[1].toString(36)}`;
    }
  } catch {
    // Fallback on Math.random
  }
  return Math.random().toString(36).slice(2);
}

/**
 * Whether an element is still in the document. An element inside a shadow root is not
 * document.contains()'d, so isConnected (which crosses shadow roots) decides when the element has it.
 */
export function isAttached(el: Element, doc?: Document | null): boolean {
  const connected = (el as Element & { isConnected?: boolean }).isConnected;
  if (typeof connected === 'boolean') return connected && (!doc || !el.ownerDocument || el.ownerDocument === doc);
  return !(doc && typeof doc.contains === 'function' && !doc.contains(el));
}

/**
 * Retrieve element by assigned ID from map, ensuring it is attached to the document.
 */
export function getElementFromMap(
  map: ElementMap,
  id: number | string,
  doc: Document = typeof document !== 'undefined' ? document : (null as unknown as Document)
): Element | null {
  const entry = map.get(Number(id));
  if (!entry) return null;
  const el = (typeof WeakRef !== 'undefined' && entry instanceof WeakRef)
    ? (entry.deref() as Element | undefined)
    : (entry as Element);
  if (!el) return null;

  if (!isAttached(el, doc)) return null;
  return el;
}

/**
 * Resolve element with docId validation and detailed stale diagnostics.
 */
export function resolveElementWithStatus(
  map: ElementMap,
  id: number | string,
  currentDocId: string,
  expectedDocId?: string,
  doc: Document = typeof document !== 'undefined' ? document : (null as unknown as Document)
): ResolveElementResult {
  if (expectedDocId && currentDocId && expectedDocId !== currentDocId) {
    return {
      success: false,
      stale: true,
      error: `Document navigated (expected ${expectedDocId}, got ${currentDocId}).`
    };
  }
  const el = getElementFromMap(map, id, doc);
  if (!el) {
    return {
      success: false,
      stale: true,
      error: `Element [${id}] is no longer attached to the document.`
    };
  }
  return { success: true, element: el };
}
