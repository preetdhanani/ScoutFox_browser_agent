/**
 * ScoutFox Floating Visual Badges
 * Renders floating indexed numeric badges for elements visible on the page.
 */

export const ACCENT_COLOR = '#a85f34'; // Studio Mono copper accent

export interface BadgeElementItem {
  id: number;
}

/**
 * Render floating visual badges on the webpage for indexed elements
 */
export function renderBadges(
  elements: BadgeElementItem[],
  doc: Document = typeof document !== 'undefined' ? document : (null as unknown as Document),
  win: (Window & typeof globalThis) | undefined = typeof window !== 'undefined' ? window : undefined
): HTMLDivElement | null {
  removeBadges(null, doc);

  if (!doc || !doc.body || !doc.createElement) return null;

  const badgeContainer = doc.createElement('div') as HTMLDivElement;
  badgeContainer.id = 'scoutfox-badge-container';
  badgeContainer.style.position = 'absolute';
  badgeContainer.style.top = '0';
  badgeContainer.style.left = '0';
  badgeContainer.style.width = '100%';
  badgeContainer.style.height = '100%';
  badgeContainer.style.pointerEvents = 'none';
  badgeContainer.style.zIndex = '2147483647'; // Max z-index

  doc.body.appendChild(badgeContainer);

  const compressor = win && (win as any).domCompressor ? (win as any).domCompressor : null;
  const scrollY = win ? win.scrollY : 0;
  const scrollX = win ? win.scrollX : 0;

  elements.forEach((item) => {
    const el = compressor ? compressor.getElement(item.id) : null;
    if (!el || typeof el.getBoundingClientRect !== 'function') return;

    const rect = el.getBoundingClientRect();
    const badge = doc.createElement('div') as HTMLDivElement;
    badge.className = 'scoutfox-badge';
    badge.textContent = String(item.id);
    badge.style.position = 'absolute';
    badge.style.top = `${rect.top + scrollY}px`;
    badge.style.left = `${rect.left + scrollX}px`;
    badge.style.backgroundColor = ACCENT_COLOR;
    badge.style.color = '#ffffff';
    badge.style.fontFamily = 'monospace, sans-serif';
    badge.style.fontSize = '11px';
    badge.style.fontWeight = 'bold';
    badge.style.padding = '1px 5px';
    badge.style.borderRadius = '4px';
    badge.style.boxShadow = '0 2px 4px rgba(0,0,0,0.4)';
    badge.style.border = '1px solid #ffffff';
    badge.style.pointerEvents = 'none';
    badge.style.transform = 'translate(-40%, -40%)';
    badge.style.transition = 'all 0.2s ease';

    badgeContainer.appendChild(badge);
  });

  return badgeContainer;
}

/**
 * Remove floating visual badges
 */
export function removeBadges(
  badgeContainer?: HTMLElement | null,
  doc: Document = typeof document !== 'undefined' ? document : (null as unknown as Document)
): void {
  if (badgeContainer && typeof badgeContainer.remove === 'function') {
    badgeContainer.remove();
  }
  const existing = doc && typeof doc.getElementById === 'function' ? doc.getElementById('scoutfox-badge-container') : null;
  if (existing && typeof existing.remove === 'function') {
    existing.remove();
  }
}
