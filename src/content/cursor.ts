/**
 * Tarka Cursor Overlay and Action Animations
 * Injects and manages visual cursor indicator, click ripple, and element highlight.
 */

export interface CursorOverlayState {
  container: HTMLElement | null;
  pointer: HTMLElement | null;
}

/**
 * Ensure cursor overlay elements are injected into page
 */
export function ensureCursorOverlay(
  existingContainer?: HTMLElement | null,
  existingPointer?: HTMLElement | null,
  doc: Document = typeof document !== 'undefined' ? document : (null as unknown as Document)
): CursorOverlayState {
  if (!doc || !doc.createElement) return { container: null, pointer: null };

  if (existingContainer && doc.contains && doc.contains(existingContainer) && existingPointer) {
    return { container: existingContainer, pointer: existingPointer };
  }

  let container = doc.getElementById ? doc.getElementById('tarka-cursor-container') : null;
  if (!container) {
    container = doc.createElement('div');
    container.id = 'tarka-cursor-container';
    if (container.style) {
      container.style.position = 'fixed';
      container.style.top = '0';
      container.style.left = '0';
      container.style.width = '0';
      container.style.height = '0';
      container.style.pointerEvents = 'none';
      container.style.zIndex = '2147483647';
      container.style.overflow = 'visible';
    }
    const parent = doc.body || doc.documentElement;
    if (parent && parent.appendChild) {
      parent.appendChild(container);
    }
  }

  let pointer = doc.getElementById ? doc.getElementById('tarka-cursor-pointer') : null;
  if (!pointer) {
    pointer = doc.createElement('div');
    pointer.id = 'tarka-cursor-pointer';
    if (pointer.style) {
      pointer.style.position = 'fixed';
      pointer.style.top = '0';
      pointer.style.left = '0';
      pointer.style.width = '24px';
      pointer.style.height = '24px';
      pointer.style.pointerEvents = 'none';
      pointer.style.zIndex = '2147483647';
      pointer.style.opacity = '0';
      pointer.style.transform = 'translate(-100px, -100px)';
      pointer.style.transition = 'transform 0.22s cubic-bezier(0.2, 0.8, 0.2, 1), opacity 0.2s ease';
    }
    pointer.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="display:block;filter:drop-shadow(0 2px 4px rgba(0,0,0,0.35));"><path d="M0 0L6.5 17L9.5 10.5L16 7.5L0 0Z" fill="#ff7a00" stroke="#ffffff" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    if (container && container.appendChild) {
      container.appendChild(pointer);
    }
  }

  return { container, pointer };
}

/**
 * Animate cursor to target (x, y) coordinates
 */
export function animateCursor(
  x: number,
  y: number,
  pointer: HTMLElement | null,
  getTimer: () => ReturnType<typeof setTimeout> | null,
  setTimer: (timer: ReturnType<typeof setTimeout> | null) => void
): void {
  if (typeof x !== 'number' || typeof y !== 'number') return;
  if (!pointer || !pointer.style) return;

  pointer.style.opacity = '1';
  pointer.style.transform = `translate(${x}px, ${y}px) scale(1)`;

  const currentTimer = getTimer();
  if (currentTimer) clearTimeout(currentTimer);

  const newTimer = setTimeout(() => {
    if (pointer && pointer.style) {
      pointer.style.opacity = '0';
    }
  }, 2500);
  setTimer(newTimer);
}

/**
 * Trigger visual click pulse and ripple ring at (x, y) coordinates
 */
export function showClickEffect(
  x: number,
  y: number,
  container: HTMLElement | null,
  pointer: HTMLElement | null,
  doc: Document = typeof document !== 'undefined' ? document : (null as unknown as Document)
): void {
  if (typeof x !== 'number' || typeof y !== 'number') return;
  if (!doc || !doc.createElement) return;

  const ripple = doc.createElement('div');
  ripple.className = 'tarka-click-ripple';
  if (ripple.style) {
    ripple.style.position = 'fixed';
    ripple.style.left = `${x}px`;
    ripple.style.top = `${y}px`;
    ripple.style.width = '24px';
    ripple.style.height = '24px';
    ripple.style.marginLeft = '-12px';
    ripple.style.marginTop = '-12px';
    ripple.style.borderRadius = '50%';
    ripple.style.border = '2.5px solid #ff7a00';
    ripple.style.backgroundColor = 'rgba(255, 122, 0, 0.25)';
    ripple.style.pointerEvents = 'none';
    ripple.style.zIndex = '2147483647';
    ripple.style.transform = 'scale(0.2)';
    ripple.style.opacity = '1';
    ripple.style.transition = 'transform 0.4s cubic-bezier(0.1, 0.8, 0.3, 1), opacity 0.4s ease-out';
  }

  if (container && container.appendChild) {
    container.appendChild(ripple);
  }

  if (typeof requestAnimationFrame !== 'undefined') {
    requestAnimationFrame(() => {
      if (ripple.style) {
        ripple.style.transform = 'scale(2.2)';
        ripple.style.opacity = '0';
      }
    });
  }

  if (pointer && pointer.style) {
    pointer.style.transform = `translate(${x}px, ${y}px) scale(0.82)`;
    setTimeout(() => {
      if (pointer && pointer.style) {
        pointer.style.transform = `translate(${x}px, ${y}px) scale(1)`;
      }
    }, 120);
  }

  setTimeout(() => {
    if (typeof ripple.remove === 'function') {
      ripple.remove();
    } else if (ripple.parentNode && ripple.parentNode.removeChild) {
      ripple.parentNode.removeChild(ripple);
    }
  }, 450);
}

/**
 * Remove cursor overlay elements
 */
export function removeCursorOverlay(
  container: HTMLElement | null,
  clearTimer: () => void
): void {
  clearTimer();
  if (container && typeof container.remove === 'function') {
    container.remove();
  }
}

/**
 * The style an element had before the agent highlighted it, keyed by element.
 * Set only on the FIRST highlight: a second highlight of the same element must
 * not capture the orange ring as the "original" and restore it permanently
 * (BUG-29).
 */
const highlightOriginals = new WeakMap<HTMLElement, { outline: string; outlineOffset: string; transition: string }>();

/**
 * Temporary visual highlight ring around target element
 */
export function highlightElement(el: HTMLElement | null): void {
  if (!el || !el.style) return;
  if (!highlightOriginals.has(el)) {
    highlightOriginals.set(el, {
      outline: el.style.outline,
      outlineOffset: el.style.outlineOffset,
      transition: el.style.transition,
    });
  }
  const orig = highlightOriginals.get(el)!;

  el.style.transition = 'outline 0.15s ease, outline-offset 0.15s ease';
  el.style.outline = '3px solid #ff7a00';
  el.style.outlineOffset = '2px';

  setTimeout(() => {
    el.style.outline = orig.outline;
    el.style.outlineOffset = orig.outlineOffset;
    el.style.transition = orig.transition;
    highlightOriginals.delete(el);
  }, 1200);
}
