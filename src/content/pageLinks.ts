/**
 * The link targets of a read. The page text (innerText) has the words of a link and never where it
 * goes, so a model asked for "the credential URL of each certificate" could not see one, and read
 * element after element looking for it. read_page lists the links of the part it returns under the
 * text: the text itself is untouched, so paging, the collapse of repeated runs and the change
 * signatures stay as they were.
 *
 * A link is listed in the part whose text holds it: its context (the list item it sits in, when its
 * label repeats, like ten "Show credential" links) or else its label. A link whose words are not in
 * the text at all (an icon, a link outside the content block that was read) is not listed.
 */

import { normalizePageText } from '../shared/textPaging.ts';

/** One link of a page: what it says, what tells it apart from links with the same words, and where it goes. */
export interface PageLink {
  label: string;
  context: string;
  url: string;
}

/** The most links one part lists; the rest are counted. */
export const LINKS_PER_PART = 60;
/** A URL longer than this is cut, keeping its start (the host and the path). */
export const LINK_URL_MAX = 300;
/** The longest label or context a link line keeps. */
const LABEL_MAX = 100;
/** The heading of the block. The harness, the mock and the tamper anchor on it. */
export const LINKS_HEADING = 'Links in this part:';
/** The most anchors one read looks at: a page with thousands of links costs a read no more than this. */
export const LINKS_SCAN_MAX = 500;
/**
 * Query parameters that carry a secret (a session, a signature, a one-time code). An address the
 * model reads goes to the model's provider, so their values are replaced: the link stays readable
 * and a person can still see which link it is.
 */
const SECRET_PARAM = /^(.*token.*|.*secret.*|sig|signature|password|passwd|pwd|api[_-]?key|access[_-]?key|auth|authorization|session|sessionid|sid|otp|code|x-amz-signature|x-amz-credential|x-amz-security-token|x-goog-signature|x-goog-credential)$/i;
/** What a secret value is replaced with. */
export const REDACTED = 'REDACTED';

/** The elements whose first line tells apart links that say the same words. */
const CONTEXT_TAGS = new Set(['LI', 'ARTICLE', 'TR', 'SECTION']);

function oneLine(text: unknown, max = LABEL_MAX): string {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** The absolute http(s) address of a link, cut when it is very long, or null for anything else. */
export function linkUrl(raw: string | null, base: string): string | null {
  if (!raw || /^\s*(javascript|data|vbscript):/i.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw.trim(), base);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  // A link to a place on the page it is read from is no target of its own.
  const here = (() => { try { return new URL(base); } catch { return null; } })();
  if (here && url.hash && url.origin === here.origin && url.pathname === here.pathname && url.search === here.search) return null;
  // A user name or password in the address, and the value of a secret parameter, never leave the page.
  url.username = '';
  url.password = '';
  for (const key of [...new Set(url.searchParams.keys())]) {
    if (SECRET_PARAM.test(key)) url.searchParams.set(key, REDACTED);
  }
  const href = url.href;
  return href.length > LINK_URL_MAX ? `${href.slice(0, LINK_URL_MAX - 40)}…[${href.length - (LINK_URL_MAX - 40)} more chars]` : href;
}

function isRendered(el: Element): boolean {
  const rect = typeof (el as any).getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
  return !rect || rect.width > 0 || rect.height > 0;
}

/**
 * The first line of the nearest list item, article, table row or section around a link that is not
 * the link's own words. The lines of each container are read once per read (`lines`): many links
 * in one big container cost one innerText, not one each.
 */
function contextOf(link: Element, label: string, lines: Map<Element, string[]>): string {
  for (let el = link.parentElement; el; el = el.parentElement) {
    if (!CONTEXT_TAGS.has(el.tagName)) continue;
    let own = lines.get(el);
    if (!own) {
      own = normalizePageText(String((el as HTMLElement).innerText ?? el.textContent ?? '')).split('\n').slice(0, 4);
      lines.set(el, own);
    }
    const first = own.find((line) => line && line !== label);
    if (first) return oneLine(first);
  }
  return '';
}

/** The visible links under root, in document order, one per address. */
export function collectLinks(root: Element | null | undefined, base: string): PageLink[] {
  if (!root || typeof root.querySelectorAll !== 'function') return [];
  // A read of one link element lists that link too, not only the links inside it.
  const self = root.tagName === 'A' && typeof root.getAttribute === 'function' && root.getAttribute('href') !== null ? [root] : [];
  const anchors = [...self, ...Array.from(root.querySelectorAll('a[href]'))].slice(0, LINKS_SCAN_MAX);
  const found: Array<PageLink & { el: Element }> = [];
  const seen = new Set<string>();
  for (const a of anchors) {
    if (!isRendered(a)) continue;
    const url = linkUrl(a.getAttribute('href'), base);
    if (!url || seen.has(url)) continue;
    const label = oneLine((a as HTMLElement).innerText ?? a.textContent ?? '') || oneLine(a.getAttribute('aria-label')) || oneLine(a.getAttribute('title'));
    // A link that says its own address is already in the text.
    if (!label || label === url || url.startsWith(label)) continue;
    seen.add(url);
    found.push({ label, context: '', url, el: a });
  }
  // Only a label that repeats needs the item around it to be told apart.
  const counts = new Map<string, number>();
  for (const link of found) counts.set(link.label, (counts.get(link.label) || 0) + 1);
  const lines = new Map<Element, string[]>();
  return found.map(({ el, ...link }) => ((counts.get(link.label) || 0) > 1 ? { ...link, context: contextOf(el, link.label, lines) } : link));
}

/**
 * The links block of one part of a read: the links whose words sit inside this part of the text.
 * Links come in document order and so does the text, so the k-th link with the same words is
 * placed at the k-th place those words appear, never all at the first one. '' when there is none.
 */
export function linksBlock(links: PageLink[], text: string, part: { start: number; end: number }): string {
  const placed: Array<{ at: number; line: string }> = [];
  const next = new Map<string, number>();
  for (const link of links) {
    const anchor = link.context && text.includes(link.context) ? link.context : link.label;
    const at = text.indexOf(anchor, next.get(anchor) ?? 0);
    if (at < 0) continue;
    next.set(anchor, at + anchor.length);
    if (at < part.start || at >= part.end) continue;
    const label = link.context ? `${link.label} (${link.context})` : link.label;
    placed.push({ at, line: `- ${label.replace(/[\[\]]/g, '')}: ${link.url}` });
  }
  if (!placed.length) return '';
  placed.sort((a, b) => a.at - b.at);
  const shown = placed.slice(0, LINKS_PER_PART).map((p) => p.line);
  const more = placed.length - shown.length;
  return [LINKS_HEADING, ...shown, ...(more > 0 ? [`(${more} more links in this part are not listed)`] : [])].join('\n');
}
