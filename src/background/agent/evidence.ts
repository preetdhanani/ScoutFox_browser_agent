/**
 * agent/evidence.ts
 *
 * What the ENGINE actually read, kept by code. The model's final answer is checked against this
 * (agent/answerAudit.ts), never against anything the model said about itself.
 *
 * WHY THIS EXISTS. A local model was asked for one price on three sites. It opened one site, then wrote
 * a table with a price, shipping and delivery estimate for all three, plus two links it had never
 * opened. Nothing in the harness recorded which pages had really been read, so nothing could tell a real
 * link or number from an invented one. This ledger is that record. It has three rules:
 *
 *   1. Only the engine writes to it: a DOM snapshot, or the text result of read_page_text,
 *      execute_js or read_network_requests, together with the URL the TAB was really on. A navigate
 *      action the model typed does not count; where the tab landed does.
 *   2. A site is "opened" when an entry has a URL on its registrable domain (www. is ignored), or the
 *      tab was sent there and landed on another site (a redirect; the entry's `via`). Which pages and
 *      sites were read is kept in a visit list apart from the texts, so making room for new text (the
 *      oldest pages are cut down to the lines around their numbers and links, then dropped) never turns
 *      an opened site into an unopened one.
 *   3. It is plain JSON (toSnapshot / fromSnapshot), so it can live in chrome.storage.session and, later,
 *      in a graph checkpoint. Everything derived (numbers, shown links) is recomputed on demand from the
 *      stored text, and cached on the side, so it never bloats the snapshot.
 *
 * This file also holds the text scanners the audit needs, because the ledger and the audit must read
 * numbers and links in exactly the same way or a real price would not match its own page:
 *
 *   - hostOf / registrableHost / normalizeUrlForMatch: what "the same site" and "the same link" mean;
 *   - scanNumbers: money, percentages and durations in any of the number formats of the pages we meet
 *     ("2,069.00", "2.069,00", "2 069", "2'069.00", "EUR 2,069", "2.069 Euro", "3-5 Werktage", ...);
 *   - findSnippet: the text around a value, found by code (provenance, not the model's quote).
 *
 * Everything here is pure: no chrome or DOM globals, no clock, no randomness, no network. No function
 * throws on any input (empty, huge, malformed, unicode), and every regular expression is safe on a
 * 50,000 character string: no nested unbounded repeats, anchored scans of small windows, sticky
 * matches instead of slicing, and a hard cap on the length of anything that is parsed by a pattern
 * that could backtrack.
 */

// ---------------------------------------------------------------------------------------------
// Sites and links
// ---------------------------------------------------------------------------------------------

/**
 * Public suffixes that have two labels, so the registrable domain is the last THREE labels
 * (shop.co.uk is a site, co.uk is not). A deliberately small list: the countries a shopping agent
 * meets most often, and the hosting platforms where every customer is a site of its own. An unknown
 * suffix falls back to the last two labels, which is right for every single-label suffix (com, de,
 * io, work, ...). No dependency on a public suffix list.
 */
const MULTI_PART_SUFFIXES: ReadonlySet<string> = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'ltd.uk', 'plc.uk', 'me.uk', 'net.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp',
  'com.br', 'net.br', 'org.br', 'gov.br',
  'co.in', 'net.in', 'org.in', 'gov.in', 'ac.in',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz',
  'com.mx', 'org.mx', 'gob.mx',
  'co.za', 'org.za', 'gov.za',
  'com.tr', 'org.tr', 'gov.tr',
  'com.sg', 'org.sg', 'edu.sg',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn',
  'com.hk', 'org.hk', 'com.tw', 'org.tw',
  'co.kr', 'or.kr', 'com.ar', 'com.co', 'com.ua', 'com.pl', 'com.pt', 'com.es', 'com.my', 'com.ph', 'co.id', 'co.il', 'co.th',
  // Shared hosting platforms. Every customer is a different site (a.myshopify.com is not b.myshopify.com), so
  // the platform behaves like a public suffix, and opening one store must not mark all of them as opened.
  'myshopify.com', 'github.io', 'blogspot.com', 'wordpress.com', 'netlify.app', 'vercel.app', 'pages.dev', 'web.app', 'firebaseapp.com',
  'herokuapp.com', 'azurewebsites.net', 'wixsite.com'
]);

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

function isLetter(ch: string | undefined): boolean {
  return ch !== undefined && ch !== '' && /[A-Za-z]/.test(ch);
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch !== '' && ch >= '0' && ch <= '9';
}

function isAlnum(ch: string | undefined): boolean {
  return isLetter(ch) || isDigit(ch);
}

/**
 * The hostname of a URL, lowercased, without port, user info or a trailing dot (www. is kept: use
 * registrableHost for "the site"). Accepts a scheme-less "www.idealo.de/x". Returns "" for anything
 * that is not a web address, for the schemes that are not web pages (chrome://, about:, file:) and for
 * text with spaces.
 */
export function hostOf(url: string): string {
  if (typeof url !== 'string') return '';
  const s = clip(url, 2048).trim();
  if (s === '') return '';
  let authority: string | undefined;
  // A backslash ends the authority, as it does in a browser: "https://idealo.de\@frame.work/x" opens idealo.de.
  const withScheme = /^([a-z][a-z0-9+.-]{0,15}):\/\/([^/\\?#\s]*)/i.exec(s);
  if (withScheme) {
    const scheme = (withScheme[1] ?? '').toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') return '';
    authority = withScheme[2];
  } else if (/^[a-z0-9.-]+(?::\d{1,5})?(?:[/?#]|$)/i.test(s)) {
    authority = /^[^/?#]*/.exec(s)?.[0];
  }
  if (authority === undefined || authority === '') return '';
  const at = authority.lastIndexOf('@');
  if (at >= 0) authority = authority.slice(at + 1);
  let host = authority;
  if (host.startsWith('[')) {
    const close = host.indexOf(']');
    return close > 0 ? host.slice(0, close + 1).toLowerCase() : '';
  }
  const colon = host.indexOf(':');
  if (colon >= 0) host = host.slice(0, colon);
  host = host.toLowerCase();
  while (host.endsWith('.')) host = host.slice(0, -1);
  if (host === '') return '';
  // A host with letters outside a-z (idealö.de) or invisible characters is mapped the way a browser maps it
  // (punycode), so a look-alike is a different site instead of being silently dropped.
  if (!/^[a-z0-9.-]+$/.test(host)) host = toAsciiHost(host);
  return host !== '' && /^[a-z0-9.-]+$/.test(host) ? host : '';
}

/** The ASCII (punycode) form of a host written with other letters, or "" when a browser would not accept it either. */
function toAsciiHost(host: string): string {
  if (/[\s/\\?#@:%]/.test(host)) return '';
  try {
    return new URL(`http://${host}/`).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** True when a link has user info in front of its host ("https://www.idealo.de@frame.work/x"): the text shows one site and the browser opens another. */
export function hasUserInfo(url: string): boolean {
  return typeof url === 'string' && /^[a-z][a-z0-9+.-]{0,15}:\/\/[^/\\?#\s]*@/i.test(clip(url, 2048).trim());
}

/**
 * The site a hostname belongs to: www. stripped, then the last two labels, or the last three when the
 * last two are a known multi-part suffix (co.uk). An IP address, "localhost" and a single label are
 * returned as they are.
 */
export function registrableHost(host: string): string {
  if (typeof host !== 'string') return '';
  let h = clip(host, 253).trim().toLowerCase();
  while (h.endsWith('.')) h = h.slice(0, -1);
  if (h.startsWith('www.')) h = h.slice(4);
  if (h === '' || h === 'www') return '';
  const labels = h.split('.');
  if (labels.length <= 2) return h;
  if (labels.every((l) => /^\d+$/.test(l))) return h;
  const last2 = labels.slice(-2).join('.');
  if (MULTI_PART_SUFFIXES.has(last2) && labels.length >= 3) return labels.slice(-3).join('.');
  return last2;
}

/** The site of a URL: registrableHost(hostOf(url)). "" when the text has no web host. */
export function siteOf(url: string): string {
  return registrableHost(hostOf(url));
}

/** Query parameters that only track where a click came from. They never change which page it is. */
function isTrackingParam(key: string): boolean {
  const k = key.toLowerCase();
  return k.startsWith('utm_') || k === 'gclid' || k === 'fbclid' || k === 'mc_eid' || k === 'mc_cid' || k === 'msclkid' || k === 'igshid' || k === 'yclid' || k === 'ref';
}

/** Undoes percent-encoding of one piece of a path or query. A broken sequence ("%zz") leaves the piece as it was written. */
function decodePiece(piece: string): string {
  try {
    return decodeURIComponent(piece);
  } catch {
    return piece;
  }
}

/**
 * Writes a decoded piece back with only the characters escaped that would be read as structure ("/", "&", "=",
 * "#", "?", "+", "%"), so "k%C3%BChlschrank" and "kühlschrank" are the same text but "a%26b" and "a&b" are not.
 */
function canonicalPiece(decoded: string): string {
  return decoded.replace(/[%&=#?+/]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * The form of a URL that two URLs are compared in: scheme dropped (http and https match each other),
 * host lowercased with www. and a default port removed, #fragment removed, trailing slashes removed,
 * tracking parameters (utm_*, gclid, fbclid, mc_eid, ref, ...) removed and the rest sorted. Chrome hands
 * out a percent-encoded address and a model writes what it typed, so every path segment and every query
 * key and value is decoded first ("k%C3%BChlschrank" is "kühlschrank", "%20" and "+" in a query are a
 * space). The path and the other parameters keep their case and value: a different path is a different page.
 * Not a URL: the trimmed lowercase text comes back, so that comparing two odd strings still works.
 */
export function normalizeUrlForMatch(url: string): string {
  if (typeof url !== 'string') return '';
  const raw = clip(url, 4096).trim();
  if (raw === '') return '';
  const m = /^([a-z][a-z0-9+.-]{0,15}):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#.*)?$/i.exec(raw) ?? /^()((?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d{1,5})?)([^?#]*)(?:\?([^#]*))?(?:#.*)?$/i.exec(raw);
  if (!m) return raw.toLowerCase();
  const scheme = (m[1] ?? '').toLowerCase();
  if (scheme !== '' && scheme !== 'http' && scheme !== 'https') return raw.replace(/#.*$/s, '').toLowerCase();
  let host = hostOf(`http://${m[2] ?? ''}`);
  if (host === '') host = (m[2] ?? '').toLowerCase();
  if (host.startsWith('www.')) host = host.slice(4);
  // "https://www.idealo.de@frame.work/x" opens frame.work but reads as idealo.de. It keeps its user info here, so it is
  // never the same address as "https://frame.work/x", and a check of the one cannot pass the other.
  if (hasUserInfo(raw)) host = `${(m[2] ?? '').slice(0, (m[2] ?? '').lastIndexOf('@')).toLowerCase()}@${host}`;
  let port = '';
  const portMatch = /:(\d{1,5})$/.exec(m[2] ?? '');
  if (portMatch && portMatch[1] !== '80' && portMatch[1] !== '443') port = `:${portMatch[1]}`;
  let path = m[3] ?? '';
  let pathEnd = path.length;
  while (pathEnd > 0 && path[pathEnd - 1] === '/') pathEnd--;
  path = path.slice(0, pathEnd);
  if (path.includes('%')) path = path.split('/').map((seg) => canonicalPiece(decodePiece(seg))).join('/');
  let query = '';
  if (m[4] !== undefined && m[4] !== '') {
    const kept: string[] = [];
    for (const pair of m[4].split('&')) {
      if (pair === '') continue;
      const eq = pair.indexOf('=');
      const key = decodePiece((eq < 0 ? pair : pair.slice(0, eq)).replace(/\+/g, ' '));
      if (isTrackingParam(key)) continue;
      kept.push(eq < 0 ? canonicalPiece(key) : `${canonicalPiece(key)}=${canonicalPiece(decodePiece(pair.slice(eq + 1).replace(/\+/g, ' ')))}`);
    }
    kept.sort();
    if (kept.length > 0) query = `?${kept.join('&')}`;
  }
  return `${host}${port}${path}${query}`;
}

/** The query pairs of a normalized URL, and the part before the query. */
function splitNormalized(n: string): { base: string; pairs: string[] } {
  const q = n.indexOf('?');
  return q < 0 ? { base: n, pairs: [] } : { base: n.slice(0, q), pairs: n.slice(q + 1).split('&') };
}

/**
 * True when the address that was asked about is the address that is known, or the same page with FEWER
 * query parameters: a site adds "&hloc=de" when it redirects, and an answer that cites the link without it
 * cites the same page. Never the other way round: a link with an extra or a different parameter is another
 * page (another search, another variant). Both arguments are normalizeUrlForMatch forms.
 */
export function urlCovers(known: string, asked: string): boolean {
  if (known === '' || asked === '') return false;
  if (known === asked) return true;
  const a = splitNormalized(asked);
  const k = splitNormalized(known);
  if (a.base !== k.base) return false;
  return a.pairs.every((pair) => k.pairs.includes(pair));
}

/**
 * The hostname of a link that is only a site's front door, "https://www.idealo.de/" and nothing else (no port, no
 * user info, no path beyond a slash; tracking parameters do not count), without its www. Empty for any other link.
 * A front door says nothing about a page, so citing it is harmless when the site is the one that was read.
 * "https://shop.idealo.de" gives "shop.idealo.de": whether that is the same site is for the caller to say.
 */
export function frontDoorHost(url: string): string {
  if (typeof url !== 'string' || !isOriginOnly(url) || hasUserInfo(url)) return '';
  const authority = /^(?:[a-z][a-z0-9+.-]{0,15}:\/\/)?([^/\\?#\s]*)/i.exec(clip(url, 2048).trim())?.[1] ?? '';
  if (/:\d+$/.test(authority)) return '';
  const host = hostOf(url);
  return host.startsWith('www.') ? host.slice(4) : host;
}

/** True when the URL is only a site's front door (no path, no query): citing it claims nothing about a page. */
export function isOriginOnly(url: string): boolean {
  const n = normalizeUrlForMatch(url);
  return n !== '' && !n.includes('/') && !n.includes('?');
}

// -- top-level domains -----------------------------------------------------------------------

const GENERIC_TLDS = [
  'com', 'org', 'net', 'edu', 'gov', 'mil', 'int', 'info', 'biz', 'name', 'pro', 'mobi', 'app', 'dev', 'io', 'ai', 'co', 'me', 'tv', 'cc', 'ly', 'fm', 'gg',
  'tech', 'online', 'site', 'store', 'shop', 'xyz', 'top', 'club', 'live', 'cloud', 'work', 'space', 'page', 'wiki', 'blog', 'news', 'media', 'agency', 'digital',
  'email', 'link', 'click', 'design', 'network', 'systems', 'solutions', 'services', 'global', 'world', 'today', 'life', 'group', 'company', 'center', 'community',
  'academy', 'health', 'tools', 'software', 'games', 'game', 'bio', 'eco', 'art', 'fun', 'one', 'plus', 'guru', 'ninja', 'rocks', 'zone', 'city', 'market',
  'deals', 'sale', 'direct', 'support', 'help', 'finance', 'money', 'bank', 'cash', 'pay', 'travel', 'hotel', 'cafe', 'food', 'pizza', 'beer', 'kaufen', 'test'
];

const COUNTRY_TLDS = (
  'ac ad ae af ag ai al am ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bm bn bo br bs bt bw by bz ca cc cd cf cg ch ci ck cl cm cn co cr cu cv cw cx cy cz ' +
  'de dj dk dm do dz ec ee eg er es et eu fi fj fk fm fo fr ga gd ge gf gg gh gi gl gm gn gp gq gr gs gt gu gw gy hk hm hn hr ht hu id ie il im in io iq ir is it ' +
  'je jm jo jp ke kg kh ki km kn kp kr kw ky kz la lb lc li lk lr ls lt lu lv ly ma mc md me mg mh mk ml mm mn mo mp mq mr ms mt mu mv mw mx my mz na nc ne nf ng ' +
  'ni nl no np nr nu nz om pa pe pf pg ph pk pl pm pn pr ps pt pw qa re ro rw sa sb sc sd se sg si sk sl sm sn so sr ss st su sv sx sy sz tc td tf tg th tj tk tl ' +
  'tm tn to tr tt tv tw tz ua ug uk us uy uz va vc ve vg vi vn vu wf ws ye yt za zm zw'
).split(' ');

/**
 * Endings that are much more likely a file name in model text ("page.js", "notes.md", "main.py") than a
 * site, even where they are also a country code (.py, .rs, .sh, .md). They are never read as a site.
 */
const FILE_LIKE_ENDINGS: ReadonlySet<string> = new Set([
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'json', 'css', 'scss', 'html', 'htm', 'xml', 'php', 'py', 'rb', 'go', 'rs', 'sh', 'md', 'txt', 'csv', 'log', 'yml', 'yaml', 'ini',
  'cfg', 'toml', 'lock', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'zip', 'gz', 'tar', 'exe', 'dll', 'bin',
  'dat', 'db', 'sql', 'map', 'c', 'h', 'cpp', 'hpp', 'java', 'kt', 'swift', 'mp3', 'mp4', 'mov', 'wav'
]);

const KNOWN_TLDS: ReadonlySet<string> = new Set([...GENERIC_TLDS, ...COUNTRY_TLDS].filter((t) => !FILE_LIKE_ENDINGS.has(t)));

/**
 * A single label then dots and labels then a top-level domain. The whole token is at most 253 characters
 * (the caller checks) and every label is at most 63, so this anchored pattern cannot backtrack badly.
 */
const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,24})$/i;

/** True when `token` looks like a site name: labels, dots and a real top-level domain, and not a file name. */
export function looksLikeDomain(token: string): boolean {
  if (typeof token !== 'string' || token.length < 4 || token.length > 253) return false;
  const m = DOMAIN_RE.exec(token);
  if (!m) return false;
  const tld = m[1] ?? '';
  const lower = tld.toLowerCase();
  if (!KNOWN_TLDS.has(lower)) return false;
  // "price.It" is a sentence with a missing space, "IDEALO.DE" is a site written in capitals.
  if (tld !== lower && token !== token.toUpperCase()) return false;
  return true;
}

/** One place in a text that names a site: a full link, or just the domain. */
export interface SiteMention {
  /** Offset of the first character and one past the last, in the scanned text. */
  start: number;
  end: number;
  /** The text as written (for a link: the link without the punctuation that follows it). */
  raw: string;
  /** The registrable host, for example "idealo.de". */
  host: string;
  /** True when this is a link to a page (has a scheme, or a path) and not only a site name. */
  isUrl: boolean;
}

const LINK_START_RE = /(?:https?:\/\/|www\.)[^\s<>"'`[\]|\u0001]{1,2048}/gi;

/**
 * Takes the punctuation and markdown that follow a link in prose off its end. A ")" stays if it closes a
 * "(" inside the link. Links longer than 2048 characters are cut there: no real page address is longer,
 * and it keeps this loop small on hostile input.
 */
function trimLinkEnd(link: string): string {
  let text = link.length > 2048 ? link.slice(0, 2048) : link;
  // A ")" with no "(" before it in the link closes something around the link: "(https://a.de/x)" or "[t](https://a.de/x)y".
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(') depth++;
    else if (c === ')') {
      if (depth === 0) {
        text = text.slice(0, i);
        break;
      }
      depth--;
    }
  }
  let end = text.length;
  while (end > 0) {
    const ch = text[end - 1] ?? '';
    if (ch === '(' || '.,;:!?*\'"}'.includes(ch) || ch === '\u2026') {
      end--;
      continue;
    }
    break;
  }
  return text.slice(0, end);
}

interface LinkSpan {
  start: number;
  end: number;
  raw: string;
}

/**
 * Every link of a text (https://..., http://..., www....), cut where the sentence around it takes over.
 * A link that was cut short ("(https://a.de/x)https://b.de/y") does not hide what follows: the scan goes
 * on from the end of the cut link, so the second link is found too.
 */
function findLinks(text: string): LinkSpan[] {
  const out: LinkSpan[] = [];
  LINK_START_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LINK_START_RE.exec(text)) !== null) {
    const start = m.index;
    if (m[0].toLowerCase().startsWith('www.') && isAlnum(start > 0 ? text[start - 1] : '')) continue;
    const cleaned = trimLinkEnd(m[0]);
    if (cleaned === '') {
      LINK_START_RE.lastIndex = start + 1;
      continue;
    }
    out.push({ start, end: start + cleaned.length, raw: cleaned });
    if (cleaned.length < m[0].length) LINK_START_RE.lastIndex = start + cleaned.length;
  }
  return out;
}

/** Replaces every link with a filler character of the same length, so numbers and domains inside links are not read as text. */
export function maskLinks(text: string): string {
  if (typeof text !== 'string' || text === '') return '';
  const links = findLinks(text);
  if (links.length === 0) return text;
  const parts: string[] = [];
  let cursor = 0;
  for (const l of links) {
    parts.push(text.slice(cursor, l.start), '\u0001'.repeat(l.end - l.start));
    cursor = l.end;
  }
  parts.push(text.slice(cursor));
  return parts.join('');
}

const DOMAIN_RUN_RE = /[A-Za-z0-9][A-Za-z0-9._-]*/g;
const PATH_AFTER_DOMAIN_RE = /[^\s<>"'`[\]|\u0001]{0,2048}/y;

/**
 * Every place where the text names a site, in order of appearance: full links (https://..., www....,
 * and domain-plus-path such as idealo.de/x) and bare domains (idealo.de). A token with a file ending
 * (page.js, e.g.) and an e-mail address are not sites. The host is always the registrable host.
 */
export function scanSites(text: string): SiteMention[] {
  if (typeof text !== 'string' || text === '') return [];
  const out: SiteMention[] = [];
  let m: RegExpExecArray | null;
  for (const link of findLinks(text)) {
    const cleaned = link.raw;
    const host = siteOf(cleaned.toLowerCase().startsWith('www.') ? `https://${cleaned}` : cleaned);
    // A scheme makes it a link to a page even without a path; a bare "www.idealo.de" only names the site.
    const isUrl = /^https?:/i.test(cleaned) || /\/[^/]/.test(cleaned);
    if (host !== '') out.push({ start: link.start, end: link.end, raw: cleaned, host, isUrl });
  }
  const rest = maskLinks(text);

  DOMAIN_RUN_RE.lastIndex = 0;
  // A domain written with a path ("a.de/x?u=b.de") owns the whole path: a site name inside it is part of that link.
  let consumedUntil = 0;
  while ((m = DOMAIN_RUN_RE.exec(rest)) !== null) {
    if (m.index < consumedUntil) continue;
    const run = m[0];
    if (run.length > 253 || !run.includes('.')) continue;
    let token = run;
    while (token.endsWith('.') || token.endsWith('-') || token.endsWith('_')) token = token.slice(0, -1);
    if (!looksLikeDomain(token)) continue;
    const start = m.index;
    const prev = start > 0 ? rest[start - 1] : '';
    if (prev === '@' || prev === '/' || prev === '\\') continue;
    let end = start + token.length;
    let isUrl = false;
    if (rest[end] === '/') {
      PATH_AFTER_DOMAIN_RE.lastIndex = end;
      const tail = PATH_AFTER_DOMAIN_RE.exec(rest);
      if (tail && tail[0].length > 1) {
        const linked = trimLinkEnd(token + tail[0]);
        end = start + linked.length;
        isUrl = linked.length > token.length + 1;
        if (!isUrl) end = start + token.length;
      }
    }
    const raw = text.slice(start, end);
    const host = siteOf(isUrl ? `https://${raw}` : `https://${token}`);
    if (host !== '') out.push({ start, end, raw, host, isUrl });
    consumedUntil = Math.max(consumedUntil, end);
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

/** The registrable hosts a text names (links and bare domains), first mention first, each once. */
export function hostsNamedIn(text: string): string[] {
  const seen = new Set<string>();
  const hosts: string[] = [];
  for (const site of scanSites(text)) {
    if (!seen.has(site.host)) {
      seen.add(site.host);
      hosts.push(site.host);
    }
  }
  return hosts;
}

/** The links of a text (not the bare domains), each with the punctuation of the sentence taken off. */
export function extractUrls(text: string): SiteMention[] {
  return scanSites(text).filter((s) => s.isUrl);
}

// ---------------------------------------------------------------------------------------------
// Numbers: money, percentages, durations
// ---------------------------------------------------------------------------------------------

export type DurationUnit = 'hour' | 'day' | 'bday' | 'week' | 'month' | 'year';

/** An amount of money, as written. `values` has two entries only for an ambiguous "1.399" or "1,399" (read both ways). */
export interface MoneyToken {
  kind: 'money';
  raw: string;
  start: number;
  end: number;
  values: number[];
  /** "EUR", "USD", "GBP", "CHF", ... or "" when no currency sits next to the number. */
  currency: string;
  /** The number looks like a price on its own: thousands grouping, two decimals, or four or more digits. */
  priceShape: boolean;
  /** A price word ("price", "Preis", "total", "from", "ab", ...) stands right before it. */
  priceContext: boolean;
  /** An approximation marker (about, ca., ~, rund, ...) stands right before it. */
  approx: boolean;
  /** Digits after the decimal mark as written (0 for "2,100" and for an ambiguous "1.399"). It says how precisely the amount was rounded. */
  decimals: number;
}

export interface PercentToken {
  kind: 'percent';
  raw: string;
  start: number;
  end: number;
  value: number;
  approx: boolean;
  /** Digits after the decimal mark as written: "6%" has 0, "5.8%" has 1. */
  decimals: number;
}

/** "3-5 business days", "2 bis 5 Werktage", "1 week": `low` equals `high` for a single number. */
export interface DurationToken {
  kind: 'duration';
  raw: string;
  start: number;
  end: number;
  low: number;
  high: number;
  unit: DurationUnit;
}

export interface ScanResult {
  money: MoneyToken[];
  percents: PercentToken[];
  durations: DurationToken[];
}

/** The spaces that separate thousands on real pages (no-break, narrow no-break, thin, figure) become a plain space, one for one. */
export function normalizeSpaces(text: string): string {
  return text.replace(/[\u00a0\u2007\u2009\u202f\u2002\u2003\u2005\u200a]/g, ' ');
}

interface Parsed {
  values: number[];
  /** Thousands grouping was used (2,069 or 2.069,00 or 1 399). */
  grouped: boolean;
  /** Digits after the decimal separator, 0 when there is none. */
  decimals: number;
  /** Digits of the whole part. */
  intDigits: number;
}

function digitsOnly(s: string): boolean {
  return s.length > 0 && /^\d+$/.test(s);
}

/**
 * Reads one numeral made of digit groups and separators, "2,069.00" or "2.069,00" or "2'069" or "1 399".
 *
 * The last "." or "," is the decimal mark when it is the only kind of mark used twice-or-more before
 * it, or when it differs from an earlier one (2,069.00: the "." is decimal, the "," groups thousands).
 * A single mark followed by exactly three digits, after one to three digits, cannot be told apart
 * ("1.399" is 1399 on a German page and 1.399 on an English one): both readings are returned, the
 * thousands one first. Anything that is not a clean numeral (1.2.3, 12,34,56, 30.09.2026) is null, so
 * dates, versions and lists are never read as amounts.
 */
function parseNumeral(run: string): Parsed | null {
  const parts: string[] = [];
  const seps: string[] = [];
  let current = '';
  for (const ch of run) {
    if (ch >= '0' && ch <= '9') current += ch;
    else {
      if (current === '') return null;
      parts.push(current);
      seps.push(ch === '\u2019' ? "'" : ch);
      current = '';
    }
  }
  if (current === '') return null;
  parts.push(current);
  const first = parts[0] ?? '';
  if (!digitsOnly(first)) return null;
  if (parts.length === 1) {
    const v = Number(first);
    return Number.isFinite(v) ? { values: [v], grouped: false, decimals: 0, intDigits: first.length } : null;
  }

  const last = seps[seps.length - 1] ?? '';
  const lastIsMark = last === '.' || last === ',';
  // Groups before the final mark: every one after the first must have exactly three digits, and the first one to three.
  const groupedOk = (groups: string[], groupSeps: string[]): boolean => {
    if (groups.length < 2) return true;
    const head = groups[0] ?? '';
    if (head.length < 1 || head.length > 3) return false;
    for (let i = 1; i < groups.length; i++) if ((groups[i] ?? '').length !== 3) return false;
    const sep0 = groupSeps[0];
    return groupSeps.every((s) => s === sep0);
  };

  const onlyKind = seps.every((s) => s === last);

  if (onlyKind && lastIsMark) {
    if (parts.length === 2) {
      const tail = parts[1] ?? '';
      const ambiguous = tail.length === 3 && first.length >= 1 && first.length <= 3 && !first.startsWith('0');
      const dec = Number(`${first}.${tail}`);
      if (ambiguous) return { values: [Number(first + tail), dec], grouped: true, decimals: 0, intDigits: first.length + 3 };
      return Number.isFinite(dec) ? { values: [dec], grouped: false, decimals: tail.length, intDigits: first.length } : null;
    }
    if (!groupedOk(parts, seps)) return null;
    return { values: [Number(parts.join(''))], grouped: true, decimals: 0, intDigits: parts.join('').length };
  }

  if (onlyKind && !lastIsMark) {
    // 2'069 or 1 399: the mark groups thousands, every group after the first has three digits.
    if (!groupedOk(parts, seps)) return null;
    return { values: [Number(parts.join(''))], grouped: true, decimals: 0, intDigits: parts.join('').length };
  }

  // Mixed marks. The last mark is the decimal one when it is "." or ",", and all earlier marks are the other kind or a space.
  if (!lastIsMark) return null;
  const decimalMark = last;
  const before = seps.slice(0, -1);
  const groups = parts.slice(0, -1);
  if (before.includes(decimalMark)) return null;
  if (!groupedOk(groups, before)) return null;
  const decimalPart = parts[parts.length - 1] ?? '';
  if (decimalPart.length < 1 || decimalPart.length > 4) return null;
  const whole = groups.join('');
  const v = Number(`${whole}.${decimalPart}`);
  return Number.isFinite(v) ? { values: [v], grouped: true, decimals: decimalPart.length, intDigits: whole.length } : null;
}

/**
 * A numeral that parseNumeral refuses ("2,149,00": a typo for a German price) but that sits next to a
 * currency, so it is an amount all the same. The last "." or "," is the decimal mark when one or two
 * digits follow it, every other mark is dropped. Only used beside a currency: a bare "1.2.3" stays a version.
 */
function lenientNumeral(run: string): Parsed | null {
  const parts = run.split(/[.,'\u2019]/);
  if (parts.length < 2 || parts.some((p) => !digitsOnly(p))) return null;
  const last = parts[parts.length - 1] ?? '';
  const whole = last.length <= 2 ? parts.slice(0, -1).join('') : parts.join('');
  const v = last.length <= 2 ? Number(`${whole}.${last}`) : Number(whole);
  return Number.isFinite(v) ? { values: [v], grouped: true, decimals: last.length <= 2 ? last.length : 0, intDigits: whole.length } : null;
}

/**
 * The value(s) of a numeral written in any common format, or an empty list. "2,069.00" and "2.069,00" and
 * "2069" and "2 069" and "2'069.00" are 2069; "1.399" and "1,399" are [1399, 1.399]. Text around the
 * numeral (a currency, a unit) is ignored. Never throws.
 */
export function canonicalAmounts(text: string): number[] {
  if (typeof text !== 'string') return [];
  const s = normalizeSpaces(clip(text, 200));
  const m = /\d+(?:[.,'\u2019 ]\d+)*/.exec(s);
  if (!m) return [];
  const run = m[0];
  if (!run.includes(' ')) return parseNumeral(run)?.values ?? [];
  // A space may only group thousands ("1 399", "2 069,00"). Anything else after a space is another number.
  const spaced = parseNumeral(run.replace(/ /g, "'"));
  if (spaced) return spaced.values;
  return parseNumeral(run.slice(0, run.indexOf(' ')))?.values ?? [];
}

/**
 * The key two amounts are compared by: the value in thousandths, rounded. Thousandths and not cents,
 * because the second reading of an ambiguous "2.069" is 2.069 and must not collide with a real 2.07.
 */
export function amountKey(value: number): number {
  return Math.round(value * 1000);
}

/** Two amounts are the same when they agree in thousandths (each list is "either reading"). */
export function sameAmount(a: readonly number[], b: readonly number[]): boolean {
  for (const x of a) for (const y of b) if (amountKey(x) === amountKey(y)) return true;
  return false;
}

const CURRENCY_WORDS: ReadonlyArray<readonly [string, string]> = [
  ['euros', 'EUR'],
  ['euro', 'EUR'],
  ['eur', 'EUR'],
  ['usd', 'USD'],
  ['dollars', 'USD'],
  ['dollar', 'USD'],
  ['gbp', 'GBP'],
  ['pfund', 'GBP'],
  ['chf', 'CHF'],
  ['franken', 'CHF'],
  ['cad', 'CAD'],
  ['aud', 'AUD'],
  ['jpy', 'JPY'],
  ['inr', 'INR'],
  ['sek', 'SEK'],
  ['nok', 'NOK'],
  ['dkk', 'DKK'],
  ['pln', 'PLN'],
  ['czk', 'CZK'],
  ['cny', 'CNY']
];

function currencyOfSymbol(ch: string | undefined): string {
  if (ch === '\u20ac') return 'EUR';
  if (ch === '$') return 'USD';
  if (ch === '\u00a3') return 'GBP';
  if (ch === '\u00a5') return 'JPY';
  if (ch === '\u20b9') return 'INR';
  return '';
}

interface CurrencyHit {
  currency: string;
  /** Start of the currency text (before) or end of it (after). */
  edge: number;
}

/** A currency right before the number (at most two spaces between), as a symbol or a word not glued to other letters. */
function currencyBefore(s: string, numberStart: number): CurrencyHit | null {
  let p = numberStart;
  while (p > 0 && numberStart - p < 2 && s[p - 1] === ' ') p--;
  const sym = currencyOfSymbol(s[p - 1]);
  if (sym !== '') return { currency: sym, edge: p - 1 };
  for (const [word, code] of CURRENCY_WORDS) {
    const from = p - word.length;
    if (from < 0) continue;
    if (s.slice(from, p).toLowerCase() === word && !isLetter(s[from - 1])) return { currency: code, edge: from };
  }
  return null;
}

/** A currency right after the number (at most two spaces between). */
function currencyAfter(s: string, numberEnd: number): CurrencyHit | null {
  let q = numberEnd;
  while (q < s.length && q - numberEnd < 2 && s[q] === ' ') q++;
  const sym = currencyOfSymbol(s[q]);
  if (sym !== '') return { currency: sym, edge: q + 1 };
  for (const [word, code] of CURRENCY_WORDS) {
    if (s.slice(q, q + word.length).toLowerCase() === word && !isAlnum(s[q + word.length])) return { currency: code, edge: q + word.length };
  }
  return null;
}

const PRICE_WORD_RE = /(?:^|[^A-Za-z])(?:price|prices|preis|preise|cost|costs|kosten|amount|betrag|total|gesamt|summe|from|ab|only|nur|versand|shipping|fee|gebuehr|uvp|msrp|rrp|value|wert|zzgl|plus)(?![A-Za-z])[^\d]{0,14}$/i;
const APPROX_RE = /(?:^|[^A-Za-z])(?:about|approx\.?|approximately|around|roughly|circa|ca\.?|rund|etwa|ungef(?:ae|\u00e4)hr|zirka|nearly|almost)\s*[([]?\s*$|[~\u2248]\s*$/i;

/**
 * The text right before `pos`, at most `n` characters. When the window starts in the middle of a word the
 * partial word is dropped, so "ab" from the end of "lab" cannot look like the price word "ab".
 */
function windowBefore(s: string, pos: number, n: number): string {
  const from = Math.max(0, pos - n);
  let w = s.slice(from, pos);
  if (from > 0 && isAlnum(s[from - 1]) && isAlnum(w[0])) {
    let i = 0;
    while (i < w.length && isAlnum(w[i])) i++;
    w = w.slice(i);
  }
  return w;
}

function approxBefore(s: string, tokenStart: number): boolean {
  return APPROX_RE.test(windowBefore(s, tokenStart, 16));
}

function priceWordBefore(s: string, tokenStart: number): boolean {
  return PRICE_WORD_RE.test(windowBefore(s, tokenStart, 26));
}

// "h" and "Std." are the short forms of hours ("Lieferung in 24h"). "h" is only a unit when a number stands right before it.
const UNIT_ALT =
  'business\\s+days?|working\\s+days?|work\\s+days?|workdays?|werktag(?:e|en)?|arbeitstag(?:e|en)?|days?|tag(?:e|en)?|weeks?|wochen?|hours?|hrs?|stunden?|std\\.?|months?|monat(?:e|en)?|years?|jahr(?:e|en)?|h';
const UNIT_STICKY = new RegExp(`\\s{0,2}(${UNIT_ALT})(?![A-Za-z0-9])`, 'iy');
// The second number of a range: a whole number or one with one or two decimals ("2-3", "2,5-3,5"). One that goes on ("1.000") is no range.
const RANGE_STICKY = /\s{0,2}(?:-|\u2013|\u2014|bis|to)\s{0,2}(\d{1,4}(?:[.,]\d{1,2})?)(?![\d]|[.,]\d)/iy;
const PERCENT_STICKY = /\s{0,2}(?:%|percent(?![A-Za-z])|prozent(?![A-Za-z])|per\s?cent(?![A-Za-z])|pct(?![A-Za-z]))/iy;

/** Maps the unit words of any supported language to a class. Business days and plain days are different classes. */
export function durationUnitOf(word: string): DurationUnit | null {
  const w = word.toLowerCase().replace(/\s+/g, ' ').trim();
  if (/^(business|working|work) days?$/.test(w) || /^workdays?$/.test(w) || w.startsWith('werktag') || w.startsWith('arbeitstag')) return 'bday';
  if (/^days?$/.test(w) || w.startsWith('tag')) return 'day';
  if (/^weeks?$/.test(w) || w.startsWith('woche')) return 'week';
  if (/^(hours?|hrs?|h|std\.?)$/.test(w) || w.startsWith('stunde')) return 'hour';
  if (/^months?$/.test(w) || w.startsWith('monat')) return 'month';
  if (/^years?$/.test(w) || w.startsWith('jahr')) return 'year';
  return null;
}

function matchDuration(s: string, a: number, b: number, value: number): DurationToken | null {
  if (!(value >= 0 && value <= 3650)) return null;
  let low = value;
  let high = value;
  let end = b;
  RANGE_STICKY.lastIndex = b;
  const r = RANGE_STICKY.exec(s);
  if (r) {
    const second = Number((r[1] ?? '').replace(',', '.'));
    if (Number.isFinite(second) && second >= value && second <= 3650) {
      UNIT_STICKY.lastIndex = b + r[0].length;
      const u = UNIT_STICKY.exec(s);
      const unit = u ? durationUnitOf(u[1] ?? '') : null;
      if (u && unit) {
        high = second;
        end = b + r[0].length + u[0].length;
        return { kind: 'duration', raw: s.slice(a, end), start: a, end, low, high, unit };
      }
    }
  }
  UNIT_STICKY.lastIndex = b;
  const u = UNIT_STICKY.exec(s);
  const unit = u ? durationUnitOf(u[1] ?? '') : null;
  if (!u || !unit) return null;
  end = b + u[0].length;
  low = value;
  high = value;
  return { kind: 'duration', raw: s.slice(a, end), start: a, end, low, high, unit };
}

const RUN_RE = /\d+(?:[.,'\u2019]\d+)*/g;

function isYearLike(v: number): boolean {
  return Number.isInteger(v) && v >= 1900 && v <= 2100;
}

/**
 * Finds every money amount, percentage and duration in a text. Only what has a unit is returned as such:
 * a bare number is a money token only when it looks like a price (see MoneyToken.priceShape) or stands
 * after a price word. Identifiers ("FW16", "a3141592"), version numbers, dates and clock times are not
 * numbers here. `text` should have its links masked (maskLinks) so that digits inside links are ignored.
 *
 * Linear in the length of the text: one pass with a simple numeral pattern, and small fixed windows
 * around each number.
 */
export function scanNumbers(text: string): ScanResult {
  const result: ScanResult = { money: [], percents: [], durations: [] };
  if (typeof text !== 'string' || text === '') return result;
  const s = normalizeSpaces(text);
  RUN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RUN_RE.exec(s)) !== null) {
    const a = m.index;
    let b = a + m[0].length;
    if (m[0].length > 40) continue;
    const prev = a > 0 ? s[a - 1] : '';
    if (isLetter(prev) && currencyBefore(s, a) === null) continue;
    let info = parseNumeral(m[0]);
    if (!info) {
      // Not a clean numeral. Beside a currency it is still an amount ("EUR 2,149,00"), anywhere else it is a date or a version.
      if (currencyBefore(s, a) === null && currencyAfter(s, b) === null) continue;
      info = lenientNumeral(m[0]);
      if (!info) continue;
    }

    // Thousands written with spaces: "1 399 EUR". Only with a currency beside it, or "Ryzen AI 5 340" would be 5340.
    if (!info.grouped && info.decimals === 0 && m[0].length <= 3 && !m[0].includes('.') && !m[0].includes(',')) {
      let e = b;
      // At most 5 groups (10^15 is more than any price). Without the cap a long run of "123 456 789 ..." with no
      // currency is walked again from every one of its numbers, which is quadratic.
      while (e - b < 20 && e + 4 <= s.length && s[e] === ' ' && /^\d{3}$/.test(s.slice(e + 1, e + 4)) && !isDigit(s[e + 4])) e += 4;
      if (e > b) {
        let withDecimal = e;
        if ((s[e] === ',' || s[e] === '.') && isDigit(s[e + 1])) {
          withDecimal = isDigit(s[e + 2]) && !isDigit(s[e + 3]) ? e + 3 : !isDigit(s[e + 2]) ? e + 2 : e;
        }
        if (currencyBefore(s, a) !== null || currencyAfter(s, withDecimal) !== null) {
          const spaced = parseNumeral(s.slice(a, withDecimal).replace(/ /g, "'"));
          if (spaced) {
            info = spaced;
            b = withDecimal;
            RUN_RE.lastIndex = b;
          }
        }
      }
    }

    const primary = info.values[0] ?? 0;
    const simpleInt = info.decimals === 0 && !info.grouped && info.values.length === 1;

    // A duration first: "3-5 Werktage" must not become money, "5 days" must not become an amount.
    if (simpleInt || (info.decimals > 0 && info.decimals <= 2 && info.values.length === 1)) {
      const dur = matchDuration(s, a, b, primary);
      if (dur) {
        result.durations.push(dur);
        RUN_RE.lastIndex = dur.end;
        continue;
      }
    }

    // A percentage: "5,8 %", "0.48%". Always read with a decimal mark, never as thousands.
    PERCENT_STICKY.lastIndex = b;
    const pm = PERCENT_STICKY.exec(s);
    if (pm) {
      const pv = info.values.length === 1 ? primary : (info.values[1] ?? primary);
      if (Number.isFinite(pv)) {
        const end = b + pm[0].length;
        const written = /[.,](\d+)$/.exec(m[0]);
        result.percents.push({ kind: 'percent', raw: s.slice(a, end), start: a, end, value: pv, approx: approxBefore(s, a), decimals: written ? (written[1] ?? '').length : 0 });
        RUN_RE.lastIndex = end;
        continue;
      }
    }

    // Money: a currency beside it, or a number that looks like a price by itself.
    const before = currencyBefore(s, a);
    const after = currencyAfter(s, b);
    const currency = before?.currency ?? after?.currency ?? '';
    const tokenStart = before ? before.edge : a;
    const tokenEnd = after ? after.edge : b;
    const glued = isLetter(s[b]);
    const shape = info.grouped || info.decimals === 2 || (info.decimals === 0 && info.intDigits >= 4 && !isYearLike(primary));
    const context = priceWordBefore(s, tokenStart);
    if (currency === '' && (glued || !shape)) continue;
    result.money.push({
      kind: 'money',
      raw: s.slice(tokenStart, tokenEnd),
      start: tokenStart,
      end: tokenEnd,
      values: info.values,
      currency,
      priceShape: shape,
      priceContext: context,
      approx: approxBefore(s, tokenStart),
      decimals: info.decimals
    });
    if (after) RUN_RE.lastIndex = Math.max(RUN_RE.lastIndex, tokenEnd);
  }
  return result;
}

/** The money tokens of a text that carry a currency. */
export function extractMoney(text: string): MoneyToken[] {
  return scanNumbers(maskLinks(text)).money.filter((t) => t.currency !== '');
}

/** The percentages of a text. */
export function extractPercents(text: string): PercentToken[] {
  return scanNumbers(maskLinks(text)).percents;
}

/** The durations of a text: single numbers and ranges with a time unit, in any supported language. */
export function extractDurations(text: string): DurationToken[] {
  return scanNumbers(maskLinks(text)).durations;
}

/** True when two durations are the same range in the same unit class. */
export function sameDuration(a: Pick<DurationToken, 'low' | 'high' | 'unit'>, b: Pick<DurationToken, 'low' | 'high' | 'unit'>): boolean {
  return a.unit === b.unit && a.low === b.low && a.high === b.high;
}

// ---------------------------------------------------------------------------------------------
// Snippets
// ---------------------------------------------------------------------------------------------

/** The text around [start, end), whitespace collapsed, with "..." where it was cut. */
export function snippetAround(text: string, start: number, end: number, radius: number): string {
  const r = Math.max(0, Math.min(500, Math.floor(Number.isFinite(radius) ? radius : 60)));
  const from = Math.max(0, start - r);
  const to = Math.min(text.length, end + r);
  let out = text.slice(from, to).replace(/\s+/g, ' ').trim();
  if (from > 0) out = `...${out}`;
  if (to < text.length) out = `${out}...`;
  return out;
}

/**
 * At most `max` characters of `text`, cut BETWEEN words and ended with "..." when something was left out. A value is
 * never shown half: "Shipping: 4,90 EUR" cut at 12 characters would read "Shipping: 4,", and a reader takes that for
 * a price of 4. Only a single word longer than the room is cut inside it (and is marked the same way). Text that fits
 * comes back trimmed and otherwise as it was.
 */
export function cutAtWord(text: string, max: number): string {
  const t = typeof text === 'string' ? text.trim() : '';
  const limit = Math.max(4, Math.floor(Number.isFinite(max) ? max : 0));
  if (t.length <= limit) return t;
  const room = limit - 3;
  const space = t.lastIndexOf(' ', room);
  return `${(space > 0 ? t.slice(0, space) : t.slice(0, room)).trimEnd()}...`;
}

/**
 * A snippet of a page (snippetAround) without the words the radius cut in half at its two ends. "... Versand: 6,9..."
 * would be read as a shipping price of 6,9 when the page says 6,90. The text is cut on white space, so a cut end is
 * one whole word shorter and still marked with "..."; `keep` (the value the snippet is about) is never cut away.
 */
export function snippetWithWholeWords(snippet: string, keep = ''): string {
  let out = typeof snippet === 'string' ? snippet : '';
  if (out.startsWith('...') && out.length > 3 && out[3] !== ' ') {
    const space = out.indexOf(' ', 3);
    const rest = space > 0 ? out.slice(space + 1) : '';
    if (rest !== '' && (keep === '' || rest.includes(keep))) out = `...${rest}`;
  }
  if (out.endsWith('...') && out.length > 3 && out[out.length - 4] !== ' ') {
    const space = out.lastIndexOf(' ', out.length - 4);
    const head = space > 0 ? out.slice(0, space) : '';
    if (head !== '' && (keep === '' || head.includes(keep))) out = `${head}...`;
  }
  return out;
}

/**
 * The text around `value` in `text`, found by code: this is what makes a number's provenance a fact
 * and not the model's quote. A string is searched as written (case does not matter); a number is
 * searched as a numeral in any format, so 2069 finds "EUR 2,069" and "2.069,00 EUR". Null when the
 * value is not in the text. Never throws.
 */
export function findSnippet(text: string, value: string | number, radius = 60): string | null {
  if (typeof text !== 'string' || text === '') return null;
  if (typeof value === 'string') {
    if (value === '') return null;
    const at = text.toLowerCase().indexOf(value.toLowerCase());
    return at < 0 ? null : snippetAround(text, at, at + value.length, radius);
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const scanned = scanNumbers(maskLinks(text));
  for (const t of scanned.money) {
    if (sameAmount(t.values, [value])) return snippetAround(text, t.start, t.end, radius);
  }
  for (const t of scanned.percents) {
    if (Math.abs(t.value - value) < 1e-9) return snippetAround(text, t.start, t.end, radius);
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------------------------

export type EvidenceKind = 'page' | 'text' | 'js' | 'network';

/** What the engine hands over after a read. `url` is the URL of the TAB at that moment. */
export interface EvidenceInput {
  step: number;
  kind: EvidenceKind;
  url: string;
  title?: string;
  text: string;
  /** The hrefs of the page, when the snapshot has them. */
  links?: string[];
  /**
   * Sites the tab was sent to that this page stands for: "twitter.com" when the tab was told to go there and
   * landed here, on x.com. It is what the ENGINE saw happen (a navigation, then a page on another site), never
   * something the model said. The page counts as a read of these sites too.
   */
  via?: string[];
}

/** One recorded read. Plain JSON: every field is a string, a number or an array of strings. */
export interface EvidenceEntry {
  step: number;
  kind: EvidenceKind;
  url: string;
  /** normalizeUrlForMatch(url). */
  nurl: string;
  /** The registrable host of `url`, or "" when the URL is not a web page. */
  host: string;
  title: string;
  text: string;
  links: string[];
  /** Other sites this page stands for (see EvidenceInput.via). Registrable hosts. */
  via: string[];
  /** The text was cut down to the lines around its numbers and links, to make room (see condenseText). Not stored. */
  condensed?: true;
}

/** The part of an entry that the snapshot stores. The rest is derived on load. */
interface StoredEntry {
  step: number;
  kind: EvidenceKind;
  url: string;
  title: string;
  text: string;
  links: string[];
  via?: string[];
}

/** A page the tab stood on. The list of these is never cut for room: it is what "opened" and "visited" rest on. */
export interface StoredVisit {
  url: string;
  title: string;
  step: number;
  via?: string[];
}

export interface LedgerSnapshot {
  v: 1;
  entries: StoredEntry[];
  /** Absent in a snapshot stored before the list existed: it is then rebuilt from the entries. */
  visits?: StoredVisit[];
}

export const MAX_ENTRIES = 60;
export const MAX_TOTAL_CHARS = 150_000;
export const MAX_TEXT_CHARS = 6000;
/** Pages and sites the visit list remembers. Far above what a run reaches; only a runaway session hits them. */
export const MAX_VISITS = 400;
export const MAX_HOSTS = 100;
const MAX_TITLE_CHARS = 300;
const MAX_URL_CHARS = 1500;
const MAX_LINKS = 80;
const MAX_LINK_CHARS = 240;
const MAX_VIA = 4;
/** What the visit list keeps of a page: its address (cut) and the start of its title. */
const VISIT_URL_CHARS = 500;
const VISIT_TITLE_CHARS = 80;
/** Characters kept on each side of a number or link when an old page is cut down to make room. */
export const CONDENSE_RADIUS = 80;
const CONDENSED_LINKS = 30;

function entryChars(e: { url: string; title: string; text: string; links: readonly string[] }): number {
  let n = e.url.length + e.title.length + e.text.length;
  for (const l of e.links) n += l.length;
  return n;
}

/** Text as stored: control characters (which JSON would have to escape at six characters each) become spaces. */
function cleanText(s: string): string {
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');
}

const KINDS: ReadonlySet<string> = new Set(['page', 'text', 'js', 'network']);

function buildEntry(input: { step?: unknown; kind?: unknown; url?: unknown; title?: unknown; text?: unknown; links?: unknown; via?: unknown }): EvidenceEntry | null {
  const url = typeof input.url === 'string' ? clip(cleanText(input.url).trim(), MAX_URL_CHARS) : '';
  const text = typeof input.text === 'string' ? clip(cleanText(input.text), MAX_TEXT_CHARS) : '';
  const title = typeof input.title === 'string' ? clip(cleanText(input.title).trim(), MAX_TITLE_CHARS) : '';
  if (url === '' && text.trim() === '' && title === '') return null;
  const links: string[] = [];
  if (Array.isArray(input.links)) {
    for (const l of input.links) {
      if (typeof l !== 'string' || l === '') continue;
      links.push(clip(cleanText(l).trim(), MAX_LINK_CHARS));
      if (links.length >= MAX_LINKS) break;
    }
  }
  const kind: EvidenceKind = typeof input.kind === 'string' && KINDS.has(input.kind) ? (input.kind as EvidenceKind) : 'page';
  const step = typeof input.step === 'number' && Number.isFinite(input.step) ? input.step : 0;
  const host = siteOf(url);
  const via: string[] = [];
  if (Array.isArray(input.via)) {
    for (const v of input.via) {
      const h = typeof v === 'string' ? registrableHost(v) : '';
      if (h !== '' && h !== host && !via.includes(h)) via.push(h);
      if (via.length >= MAX_VIA) break;
    }
  }
  return { step, kind, url, nurl: normalizeUrlForMatch(url), host, title, text, links, via };
}

/** True when the entry is a read of this site: its own site, or a site it stands for (a redirect). */
function entryHas(e: EvidenceEntry, host: string): boolean {
  return e.host === host || e.via.includes(host);
}

// -- what is derived from an entry (cached on the side, never stored) -------------------------

/** A money amount found on a page, with where it was found. */
export interface AmountRef {
  /** The candidate values as amountKey (an ambiguous numeral has two), the first being the usual reading. */
  keys: number[];
  value: number;
  /** As written on the page, for example "EUR 2,069". */
  raw: string;
  host: string;
  url: string;
  /** Index of the entry in the ledger, and the offset in the entry's searchable text. */
  entry: number;
  pos: number;
  /** A currency or a price word sits beside it: the amount is a price, and not just a number that looks like one. */
  priced: boolean;
  /** Digits after the decimal mark as written on the page ("2.049,00" has 2). A number with no currency and no price word is a price only when it is written to the cent. */
  decimals: number;
}

export interface PercentRef {
  value: number;
  raw: string;
  host: string;
  url: string;
  entry: number;
  pos: number;
}

export interface DurationRef {
  low: number;
  high: number;
  unit: DurationUnit;
  raw: string;
  host: string;
  url: string;
  entry: number;
  pos: number;
}

interface EntryIndex {
  /** title + newline + text: the text all offsets refer to. */
  blob: string;
  money: MoneyToken[];
  percents: PercentToken[];
  durations: DurationToken[];
  /** normalizeUrlForMatch of every link that is printed in the text or listed in the links. */
  shown: Set<string>;
  /** The page has wording about shipping or delivery. */
  support: boolean;
}

const SUPPORT_RE = /\b(?:shipping|versand\w*|porto\w*|kostenlos\w*|gratisversand|free|delivery|liefer\w*|ships|shipped)\b|\bwerktag/i;

/** True when the text has wording that can support a shipping or delivery statement (shipping, versand, versandkostenfrei, portofrei, kostenlos, free, delivery, lieferung, lieferzeit, ships, shipped, werktag). */
export function hasShippingWording(text: string): boolean {
  return typeof text === 'string' && SUPPORT_RE.test(text);
}

const indexCache = new WeakMap<EvidenceEntry, EntryIndex>();

function resolveLink(href: string, base: string): string {
  if (/^https?:\/\//i.test(href) || /^www\./i.test(href)) return href;
  if (href.startsWith('//')) return `https:${href}`;
  if (href.startsWith('/')) {
    const origin = /^(https?:\/\/[^/?#]+)/i.exec(base);
    return origin ? `${origin[1]}${href}` : '';
  }
  return '';
}

function indexOfEntry(entry: EvidenceEntry): EntryIndex {
  const cached = indexCache.get(entry);
  if (cached) return cached;
  const blob = entry.title === '' ? entry.text : `${entry.title}\n${entry.text}`;
  const scanned = scanNumbers(maskLinks(blob));
  const shown = new Set<string>();
  for (const site of extractUrls(blob)) {
    const n = normalizeUrlForMatch(site.raw.toLowerCase().startsWith('www.') ? `https://${site.raw}` : site.raw);
    if (n !== '') shown.add(n);
  }
  for (const href of entry.links) {
    const abs = resolveLink(href, entry.url);
    if (abs === '') continue;
    const n = normalizeUrlForMatch(abs.toLowerCase().startsWith('www.') ? `https://${abs}` : abs);
    if (n !== '') shown.add(n);
  }
  const index: EntryIndex = {
    blob,
    money: scanned.money,
    percents: scanned.percents,
    durations: scanned.durations,
    shown,
    support: SUPPORT_RE.test(blob)
  };
  indexCache.set(entry, index);
  return index;
}

/** An opened site: the registrable host, the newest URL read on it, and when. */
export interface OpenedHost {
  host: string;
  url: string;
  title: string;
  /** Step of the first and of the latest read. */
  firstStep: number;
  lastStep: number;
}

/** A page the tab stood on, as the visit list keeps it. */
interface Visit {
  url: string;
  nurl: string;
  /** The hostname without www., for example "shop.idealo.de". */
  hostname: string;
  title: string;
  step: number;
  via: string[];
}

/**
 * The text of a page cut down to what the audit uses: about CONDENSE_RADIUS characters on each side of every
 * money amount, percentage and duration, and every link in full, joined by " ... ". Whole pages are 6,000
 * characters and a ledger holds 150,000, so about 25 reads fill it; this keeps the numbers and the links of
 * many more pages and drops only the prose between them. Offsets change, so anything derived from the old
 * text has to be derived again. The text comes back as it was when cutting would not make it shorter.
 */
export function condenseText(text: string, radius: number = CONDENSE_RADIUS): string {
  if (typeof text !== 'string' || text === '') return '';
  const s = normalizeSpaces(text);
  const scanned = scanNumbers(maskLinks(s));
  const r = Math.max(0, Math.min(500, Math.floor(Number.isFinite(radius) ? radius : CONDENSE_RADIUS)));
  const spans: Array<[number, number]> = [];
  for (const t of scanned.money) spans.push([t.start - r, t.end + r]);
  for (const t of scanned.percents) spans.push([t.start - r, t.end + r]);
  for (const t of scanned.durations) spans.push([t.start - r, t.end + r]);
  for (const l of findLinks(s)) spans.push([l.start, l.end]);
  if (spans.length === 0) return '';
  spans.sort((a, b) => a[0] - b[0]);
  const pieces: string[] = [];
  let from = -1;
  let to = -1;
  for (const [a, b] of spans) {
    const lo = Math.max(0, a);
    const hi = Math.min(s.length, b);
    if (from >= 0 && lo <= to) {
      to = Math.max(to, hi);
      continue;
    }
    if (from >= 0) pieces.push(text.slice(from, to));
    from = lo;
    to = hi;
  }
  if (from >= 0) pieces.push(text.slice(from, to));
  const out = pieces.join(' ... ');
  return out.length < text.length ? out : text;
}

export class EvidenceLedger {
  entries: EvidenceEntry[] = [];
  // Private fields on purpose: the ledger is its entries (plain JSON); these two are rebuilt from the snapshot's visit list.
  /** Every page the tab stood on, by normalized URL, oldest first. Not touched when text is cut or entries go. */
  #visits = new Map<string, Visit>();
  /** Every site that was read, in the order it was first read. Not touched when text is cut or entries go. */
  #hosts = new Map<string, OpenedHost>();

  /**
   * Stores what the engine read. Returns the entry, or null when there was nothing to store (no URL, no
   * text, no title). An identical consecutive read (same normalized URL, same text) is not stored twice:
   * the step of the existing entry is moved up instead. Never throws.
   */
  record(input: EvidenceInput): EvidenceEntry | null {
    try {
      const entry = buildEntry(input);
      if (!entry) return null;
      this.#noteVisit(entry);
      const last = this.entries[this.entries.length - 1];
      if (last && last.nurl === entry.nurl && last.text === entry.text) {
        last.step = entry.step;
        for (const v of entry.via) if (!last.via.includes(v)) last.via.push(v);
        return last;
      }
      this.entries.push(entry);
      this.enforceCaps();
      return entry;
    } catch {
      return null;
    }
  }

  /** Remembers that the tab stood on this page and that these sites were read, for as long as the ledger lives. */
  #noteVisit(entry: { url: string; nurl: string; host: string; title: string; step: number; via: string[] }): void {
    if (entry.url !== '' && entry.nurl !== '') {
      const known = this.#visits.get(entry.nurl);
      if (known) {
        this.#visits.delete(entry.nurl);
        known.url = clip(entry.url, VISIT_URL_CHARS);
        known.step = entry.step;
        if (entry.title !== '') known.title = clip(entry.title, VISIT_TITLE_CHARS);
        for (const v of entry.via) if (!known.via.includes(v)) known.via.push(v);
        this.#visits.set(entry.nurl, known);
      } else {
        const hostname = hostOf(entry.url);
        this.#visits.set(entry.nurl, {
          url: clip(entry.url, VISIT_URL_CHARS),
          nurl: entry.nurl,
          hostname: hostname.startsWith('www.') ? hostname.slice(4) : hostname,
          title: clip(entry.title, VISIT_TITLE_CHARS),
          step: entry.step,
          via: [...entry.via]
        });
        if (this.#visits.size > MAX_VISITS) {
          const oldest = this.#visits.keys().next().value;
          if (oldest !== undefined) this.#visits.delete(oldest);
        }
      }
    }
    for (const host of [entry.host, ...entry.via]) {
      if (host === '') continue;
      const known = this.#hosts.get(host);
      if (!known) {
        this.#hosts.set(host, { host, url: entry.url, title: entry.title, firstStep: entry.step, lastStep: entry.step });
        if (this.#hosts.size > MAX_HOSTS) {
          const oldest = this.#hosts.keys().next().value;
          if (oldest !== undefined) this.#hosts.delete(oldest);
        }
      } else {
        known.url = entry.url;
        known.title = entry.title;
        known.lastStep = entry.step;
      }
    }
  }

  /** Forgets everything (a new task). */
  clear(): void {
    this.entries = [];
    this.#visits.clear();
    this.#hosts.clear();
  }

  get size(): number {
    return this.entries.length;
  }

  /** Characters held, the quantity that MAX_TOTAL_CHARS limits. */
  totalChars(): number {
    let n = 0;
    for (const e of this.entries) n += entryChars(e);
    return n;
  }

  /**
   * At most MAX_ENTRIES entries and about MAX_TOTAL_CHARS characters. When the text is too much, the OLDEST pages
   * are cut down first (condenseText: the lines around their numbers and links stay), so a price that was read early
   * can still be found. Only when that is not enough does a whole entry go, oldest first, and the newest entry of
   * each site last. Which sites and pages were read is kept apart from all this (the visit list), so cutting never
   * turns an opened site into an unopened one.
   */
  private enforceCaps(): void {
    let chars = this.totalChars();
    for (let i = 0; i < this.entries.length - 1 && chars > MAX_TOTAL_CHARS; i++) {
      const e = this.entries[i];
      if (!e || e.condensed) continue;
      const before = entryChars(e);
      condenseEntry(e);
      chars -= before - entryChars(e);
    }
    while (this.entries.length > 1 && (this.entries.length > MAX_ENTRIES || chars > MAX_TOTAL_CHARS)) {
      // The newest entry of every site stays as long as anything else can go, so a site read long ago keeps its page.
      const newestOfHost = new Map<string, number>();
      this.entries.forEach((e, i) => {
        for (const h of [e.host, ...e.via]) if (h !== '') newestOfHost.set(h, i);
      });
      const keep = new Set(newestOfHost.values());
      let victim = -1;
      for (let i = 0; i < this.entries.length - 1; i++) {
        if (!keep.has(i)) {
          victim = i;
          break;
        }
      }
      if (victim < 0) victim = 0;
      const gone = this.entries.splice(victim, 1)[0];
      if (gone) chars -= entryChars(gone);
    }
  }

  /** Plain JSON for chrome.storage.session or a checkpoint. Derived data is not included. */
  toSnapshot(): LedgerSnapshot {
    return {
      v: 1,
      entries: this.entries.map((e) => {
        const stored: StoredEntry = { step: e.step, kind: e.kind, url: e.url, title: e.title, text: e.text, links: [...e.links] };
        if (e.via.length > 0) stored.via = [...e.via];
        return stored;
      }),
      visits: [...this.#visits.values()].map((v) => {
        const stored: StoredVisit = { url: v.url, title: v.title, step: v.step };
        if (v.via.length > 0) stored.via = [...v.via];
        return stored;
      })
    };
  }

  /** The ledger of a snapshot. Anything that is not a snapshot gives an empty ledger; bad entries are skipped. Never throws. */
  static fromSnapshot(snapshot: unknown): EvidenceLedger {
    const ledger = new EvidenceLedger();
    try {
      const source = snapshot as { entries?: unknown; visits?: unknown } | null | undefined;
      // The visit list first (older snapshots have none), then the entries, which carry the newest text of a page.
      if (Array.isArray(source?.visits)) {
        for (const raw of source.visits) {
          if (raw === null || typeof raw !== 'object') continue;
          const visit = buildEntry({ ...(raw as Record<string, unknown>), text: '' });
          if (visit) ledger.#noteVisit(visit);
        }
      }
      const list = source?.entries;
      if (!Array.isArray(list)) return ledger;
      for (const raw of list) {
        if (raw === null || typeof raw !== 'object') continue;
        const entry = buildEntry(raw as Record<string, unknown>);
        if (entry) {
          ledger.entries.push(entry);
          ledger.#noteVisit(entry);
        }
      }
      ledger.enforceCaps();
    } catch {
      return new EvidenceLedger();
    }
    return ledger;
  }

  // -- queries -------------------------------------------------------------------------------

  /** The sites that were opened, in the order they were first read, each with the newest URL read on it. */
  openedHosts(): OpenedHost[] {
    return [...this.#hosts.values()].map((h) => ({ ...h }));
  }

  /** True when a page of this site was read. Accepts a host with or without www. */
  hasOpened(host: string): boolean {
    const h = registrableHost(host);
    return h !== '' && this.#hosts.has(h);
  }

  /** True when a tab stood on a page with exactly this hostname (shop.idealo.de, not idealo.de). www. is ignored. */
  hasHostname(hostname: string): boolean {
    if (typeof hostname !== 'string') return false;
    const h = hostname.trim().toLowerCase().replace(/^www\./, '');
    if (h === '') return false;
    for (const v of this.#visits.values()) if (v.hostname === h) return true;
    return false;
  }

  /** True when a tab stood on this URL (compared by normalizeUrlForMatch), or on the same page with more query parameters (see urlCovers). */
  wasVisited(url: string): boolean {
    const n = normalizeUrlForMatch(url);
    if (n === '') return false;
    if (this.#visits.has(n)) return true;
    for (const known of this.#visits.keys()) if (urlCovers(known, n)) return true;
    return false;
  }

  /** True when this URL is printed in the text of a page that was read, or listed among its links. */
  wasShown(url: string): boolean {
    const n = normalizeUrlForMatch(url);
    if (n === '') return false;
    for (const e of this.entries) {
      const shown = indexOfEntry(e).shown;
      if (shown.has(n)) return true;
      for (const known of shown) if (urlCovers(known, n)) return true;
    }
    return false;
  }

  /** True when a page of this site (or of any site, with no host) has wording about shipping or delivery. */
  hasShippingWording(host?: string): boolean {
    const h = host === undefined ? undefined : registrableHost(host);
    return this.entries.some((e) => (h === undefined || entryHas(e, h)) && indexOfEntry(e).support);
  }

  /** The searchable text of an entry (title, newline, text): the offsets of the refs below point into it. */
  textOf(entryIndex: number): string {
    const e = this.entries[entryIndex];
    return e ? indexOfEntry(e).blob : '';
  }

  /** A snippet of the page around a ref, found by code. Offsets are the same in the scanned and in the stored text (spaces are replaced one for one). */
  snippetFor(ref: { entry: number; pos: number; raw: string }, radius = 60): string {
    const blob = this.textOf(ref.entry);
    return snippetAround(blob, ref.pos, ref.pos + ref.raw.length, radius);
  }

  /** Every money amount on the pages read (of one site, or of all), newest page first. */
  amounts(host?: string): AmountRef[] {
    const h = host === undefined ? undefined : registrableHost(host);
    const out: AmountRef[] = [];
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (!e || (h !== undefined && !entryHas(e, h))) continue;
      for (const t of indexOfEntry(e).money) {
        const priced = t.currency !== '' || t.priceContext;
        // A number that only looks like one (a model number, a year) is an amount only when it has the shape of a price.
        if (!priced && !t.priceShape) continue;
        out.push({ keys: t.values.map((v) => amountKey(v)), value: t.values[0] ?? 0, raw: t.raw, host: e.host, url: e.url, entry: i, pos: t.start, priced, decimals: t.decimals });
      }
    }
    return out;
  }

  percents(host?: string): PercentRef[] {
    const h = host === undefined ? undefined : registrableHost(host);
    const out: PercentRef[] = [];
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (!e || (h !== undefined && !entryHas(e, h))) continue;
      for (const t of indexOfEntry(e).percents) out.push({ value: t.value, raw: t.raw, host: e.host, url: e.url, entry: i, pos: t.start });
    }
    return out;
  }

  durations(host?: string): DurationRef[] {
    const h = host === undefined ? undefined : registrableHost(host);
    const out: DurationRef[] = [];
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (!e || (h !== undefined && !entryHas(e, h))) continue;
      for (const t of indexOfEntry(e).durations) out.push({ low: t.low, high: t.high, unit: t.unit, raw: t.raw, host: e.host, url: e.url, entry: i, pos: t.start });
    }
    return out;
  }
}

/** Cuts the text of an entry down (see condenseText), and drops what was derived from the old text. */
function condenseEntry(e: EvidenceEntry): void {
  e.text = condenseText(e.text);
  e.links = e.links.slice(0, CONDENSED_LINKS);
  e.condensed = true;
  indexCache.delete(e);
}

/** The ledger of a snapshot (same as EvidenceLedger.fromSnapshot). */
export function ledgerFromSnapshot(snapshot: unknown): EvidenceLedger {
  return EvidenceLedger.fromSnapshot(snapshot);
}
