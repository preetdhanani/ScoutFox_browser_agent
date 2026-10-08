/**
 * agent/answerAudit.ts
 *
 * Checks the model's final answer against what the ENGINE read (agent/evidence.ts). It checks
 * PROVENANCE, not truth: was this page opened, was this number on a page that was read. A number can
 * still be wrong on the page itself; that is not this file's business. What it does catch is the
 * failure that started all this: an answer with prices, shipping, delivery estimates and links for
 * sites that no page was ever read from.
 *
 * WHY CODE AND NOT A PROMPT RULE. A 9B model told "only write what you saw" will still write a table
 * with a row it never read, because the task asked for that row. The harness is the only part that
 * knows which pages were read, so the harness decides, with a function that can be tested against a
 * corpus (shared/fixtures/answer-audit-cases.json).
 *
 * HOW.
 *   1. The answer is cut into segments that one source can own: a markdown table row (cell by cell, the header row
 *      too), a list item, a heading line, a sentence. A heading (a "#" line, a line that is only bold such as
 *      **idealo.de**, or a line that is only a site name) governs the lines under it until the next heading of the same
 *      or a higher level. A line like **Summary**, "Fazit:" or "---" ends the section of the last site, and so does a
 *      closing paragraph after a list or a table. A name like "Idealo" counts as the site idealo.de when the task names
 *      that site (small models write the name far more often than the domain).
 *   2. Claims are taken out of the segments: links, money with a currency (or a number that looks like a price under a
 *      price word or a price column), percentages, durations with a time unit, and shipping or delivery statements.
 *      Numbers of the goal are not claims when repeated without a site, beside a comparing word or next to a number a
 *      page shows; given to a site as its value ("idealo.de lists it at EUR 1,899") they are. A usual tax rate beside a
 *      tax word ("incl. 19% VAT") is a legal fact, not a price claim. List items, counts, years and clock times never
 *      were (they have no unit).
 *   3. Each claim belongs to a site: the site named in its own row or sentence (the Source column of a row, the site
 *      named just before it or right after "at"), else the site of the sentence before when that site was never opened,
 *      else the site of the heading above it. A sentence that names a site of the task that was never opened and states
 *      data gives data for that site, whichever site is nearest to each number.
 *   4. A claim is grounded when a page of its site shows the same number in any format (a price, not a review count or
 *      a postal code), or a number that can be derived from numbers that pages showed: a price and the shipping written
 *      beside it, the leading prices of the shops one sentence names, a difference of prices the answer states, a
 *      percent difference or share of those; or an "about" number that is a rounding (half the unit it is written
 *      with, never over 2%). A duration may be less specific than the page ("3-5 days" for "3-5 Werktage"), never more.
 *      A link is genuine when a tab stood on it, or a page printed it, or the goal contains it. The same site with a
 *      different path is NOT enough. The front door of a site (https://idealo.de) names it and no page: harmless for a
 *      site that was opened, a mere mention for one that was not. Shops that an opened comparison page lists
 *      (notebooksbilliger.de on idealo.de) are rows of that page: their numbers are grounded by the words next to them.
 *   5. A percent difference is derived from the prices the ANSWER states, the goal's, and the leading price of each named
 *      site that was opened (the "official store" a percentage is measured against), not from every price on every page,
 *      or an invented "15%" would pass whenever two prices on some page differ by 15%. Its tolerance is the precision it
 *      is written with ("6%" covers 5.5 to 6.5, "5.8%" only 5.7 to 5.9).
 *
 * Codes (severity), exactly as the engine and the side panel use them:
 *   lie:  fabricated_url, source_not_opened, number_not_in_evidence, number_wrong_source
 *   gap:  source_unchecked     soft: unsupported_detail
 * Verdict: any lie -> "unverified", else any gap -> "partial", else "verified". Soft notes never change it.
 *
 * The output helpers turn an audit into what a person or a model reads: formatSendBack (the message the
 * model sees when its finish is refused), annotateAnswer (its answer with made-up links cut out, ONE warning line
 * written by code on top, before the model's words, and a code-written section at the end), buildEvidenceReport (an
 * answer written by code alone) and describeEvidenceForPrompt (the small block in every step message). prepareAnswer
 * turns what the model sent as "answer" into the one text that is audited, stored and shown (a list or an object
 * becomes text, invisible characters go, a huge answer is cut with a line that says so).
 *
 * Pure: no chrome or DOM globals, no clock, no randomness, no network, never throws (an internal error
 * comes back as a "partial" audit, which refuses nothing and hides nothing). Every pattern is linear or runs on a
 * bounded piece, and work that repeats per claim is done once per line, so a 300,000 character answer is fine.
 */
import {
  EvidenceLedger,
  amountKey,
  cutAtWord,
  frontDoorHost,
  hasUserInfo,
  hostsNamedIn,
  looksLikeDomain,
  maskLinks,
  normalizeSpaces,
  normalizeUrlForMatch,
  registrableHost,
  scanNumbers,
  scanSites,
  siteOf,
  snippetWithWholeWords
} from './evidence.ts';
import type { AmountRef, DurationRef, DurationToken, DurationUnit, MoneyToken, PercentRef, PercentToken, SiteMention } from './evidence.ts';
import { coerceAnswerText } from './outcome.ts';

// ---------------------------------------------------------------------------------------------
// The shape of an audit
// ---------------------------------------------------------------------------------------------

export type NoteCode = 'fabricated_url' | 'source_not_opened' | 'number_not_in_evidence' | 'number_wrong_source' | 'source_unchecked' | 'unsupported_detail';
export type NoteSeverity = 'lie' | 'gap' | 'soft';
export type Verdict = 'verified' | 'partial' | 'unverified';

export interface AuditNote {
  code: NoteCode;
  severity: NoteSeverity;
  /** One plain sentence. It quotes only the claim that was flagged, never the text around it. */
  text: string;
  /** The claims as the answer wrote them: a link, a number with its currency, "3-5 business days". */
  claims?: string[];
  /** The site the note is about (registrable host), when it has one. */
  host?: string;
  /** number_wrong_source: the site whose page really shows the number. */
  otherHost?: string;
}

/** A number or a fact that a page really showed, with where and in which words. */
export interface GroundedNumber {
  /** As written on the page, for example "EUR 2,069". */
  value: string;
  host: string;
  url: string;
  snippet: string;
}

export interface AnswerAudit {
  verdict: Verdict;
  /** How many notes of each severity. */
  lies: number;
  gaps: number;
  softs: number;
  notes: AuditNote[];
  /** The sites a page of which was read, each with the newest URL read on it. */
  opened: Array<{ host: string; url: string }>;
  /** Sites named in the task (or written about in the answer) that no page was read from. */
  notOpened: string[];
  grounded: GroundedNumber[];
}

export interface AuditInput {
  goal: string;
  /** Text as the model wrote it. A list or an object (a cloud model may send one) is turned into text first, see prepareAnswer. */
  answer: string;
  ledger: EvidenceLedger;
  /** The texts of the plan steps. A site named in one counts as named in the task. */
  planTexts?: string[];
}

const MAX_ANSWER_CHARS = 300_000;
const MAX_CLAIMS = 600;
const MAX_POOL = 150;
const MAX_GROUNDED = 12;

// Characters a browser ignores or maps inside an address (soft hyphen, zero-width space, joiners, word joiner, byte order
// mark): "https://www.idea\u200blo.de" opens idealo.de. They are taken out before anything is read.
const INVISIBLE_RE = /[\u00ad\u200b-\u200d\u2060\ufeff]/g;
const TOO_LONG_MARK = '\n[ScoutFox cut the rest of this very long answer: it could not be checked.]';

/**
 * The text of a final answer as the audit reads it, and as the engine stores and shows it: a list becomes its items on
 * separate lines, an object becomes indented JSON (see coerceAnswerText), invisible characters are removed, and an
 * answer longer than MAX_ANSWER_CHARS is cut with one code-written line, so no unchecked tail is ever shown next to a
 * verdict. Running it again on its own output changes nothing.
 */
export function prepareAnswer(answer: unknown): string {
  const text = coerceAnswerText(answer).replace(INVISIBLE_RE, '');
  if (text.length <= MAX_ANSWER_CHARS) return text;
  return text.slice(0, MAX_ANSWER_CHARS - TOO_LONG_MARK.length) + TOO_LONG_MARK;
}

// ---------------------------------------------------------------------------------------------
// Sites named in the task
// ---------------------------------------------------------------------------------------------

/**
 * The sites a text names, for a plan step or a goal: links and bare domains (idealo.de), as registrable
 * hosts, in order of appearance. File names (page.js) and "e.g." are not sites. The engine uses this to
 * tell which plan step is about which source.
 */
export function planHosts(text: string): string[] {
  return typeof text === 'string' ? hostsNamedIn(text.length > 20_000 ? text.slice(0, 20_000) : text) : [];
}

// Words before a site in the goal that make it a PLACE to go to ("on frame.work", "from idealo.de", "the site
// geizhals.de", "(idealo.de, geizhals.de)"), as opposed to a thing the task is about ("explain what socket.io is").
const PLACE_BEFORE_RE =
  /(?:\b(?:on|at|from|via|visit|open|browse|go\s+to|to|check|compare|between|sites?|stores?|shops?|websites?|urls?|pages?|links?|sources?|auf|bei|von|besuche|[o\u00f6]ffne|seite|seiten|zwischen|pr[u\u00fc]fe|suche|vergleiche|[u\u00fc]ber)\b|[([])[^.!?\n]*$/i;
const LIST_GAP_RE = /^\s*(?:,|;|&|\/)?\s*(?:(?:and|or|und|oder)\s+)?$/i;

/**
 * The sites the GOAL sends the agent to: a full link, a site after a word like on, at, from, visit, site, store,
 * or a bracketed list of sites, and the sites listed after one of those ("on idealo.de and geizhals.de"). A name
 * that only looks like a site ("Explain what socket.io is used for", "asp.net", "node.js") is a thing the task
 * is about, and is not a place to open: requiring a page of it would send a correct answer back twice.
 */
export function goalSources(goal: string): string[] {
  if (typeof goal !== 'string') return [];
  const text = goal.length > 20_000 ? goal.slice(0, 20_000) : goal;
  const out: string[] = [];
  let lastEnd = -1;
  for (const m of scanSites(text)) {
    let place = m.isUrl || PLACE_BEFORE_RE.test(text.slice(Math.max(0, m.start - 48), m.start));
    if (!place && lastEnd >= 0 && m.start - lastEnd <= 14 && LIST_GAP_RE.test(text.slice(lastEnd, m.start))) place = true;
    if (!place) continue;
    lastEnd = m.end;
    if (!out.includes(m.host)) out.push(m.host);
  }
  return out;
}

/**
 * The sites of the goal (the ones it sends the agent to, see goalSources) and of every plan step (a step that
 * names a site as its source), each once, goal first.
 */
export function namedSources(goal: string, planTexts: readonly string[] = []): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (hosts: string[]): void => {
    for (const h of hosts) {
      if (!seen.has(h)) {
        seen.add(h);
        out.push(h);
      }
    }
  };
  add(goalSources(goal));
  for (const step of planTexts.slice(0, 60)) add(planHosts(step));
  return out;
}

// Names that are words of the language before they are the name of a site: "frame" (frame.work), "price", "shop".
// A site whose name is one of them is only recognized by its domain, never by the bare word.
const COMMON_LABELS: ReadonlySet<string> = new Set([
  'frame', 'price', 'prices', 'store', 'stores', 'shop', 'shops', 'cloud', 'phone', 'phones', 'media', 'world', 'group', 'online', 'mobile', 'house', 'power',
  'light', 'green', 'first', 'smart', 'fresh', 'clean', 'paper', 'daily', 'local', 'north', 'south', 'order', 'check', 'share', 'study', 'video', 'music',
  'radio', 'games', 'sport', 'sports', 'watch', 'books', 'cards', 'news', 'learn', 'space', 'field', 'solar', 'trade', 'stock', 'stocks', 'money', 'travel',
  'hotel', 'flight', 'flights', 'forum', 'guide', 'login', 'account', 'search', 'about', 'other', 'where', 'there', 'these', 'those', 'which', 'their', 'check'
]);

/**
 * The name a site is called in running text ("idealo" for idealo.de): its first label, lowercase, when it is at
 * least `minLength` letters and not an everyday word. Empty for every other site, which then has to be named by
 * its domain.
 */
export function brandLabelOf(host: string, minLength = 5): string {
  const label = (registrableHost(typeof host === 'string' ? host : '').split('.')[0] ?? '').toLowerCase();
  return label.length >= minLength && /^[a-z]+$/.test(label) && !COMMON_LABELS.has(label) ? label : '';
}

/** Finds the sites a text names. */
type Scanner = (text: string) => SiteMention[];

/**
 * The scanner for an answer: the domains and links of scanSites, plus the brand name of every site the task
 * names ("Idealo", "Geizhals" for idealo.de and geizhals.de), because a small model writes the name in tables
 * and headings far more often than the domain. A brand is a mention of the site, never of a page (isUrl false).
 */
function makeScanner(named: readonly string[]): Scanner {
  const brands = new Map<string, string>();
  for (const host of named) {
    const label = brandLabelOf(host);
    if (label !== '' && !brands.has(label)) brands.set(label, host);
  }
  if (brands.size === 0) return scanSites;
  const re = new RegExp(`(?<![\\p{L}\\p{N}_@./\\\\-])(${[...brands.keys()].join('|')})(?![\\p{L}\\p{N}_-])`, 'giu');
  return (text) => {
    const sites = scanSites(text);
    // Links and the domains already found are blanked, so "idealo" inside "idealo.de" is not found twice.
    let blank = maskLinks(text);
    for (const site of sites) if (!site.isUrl) blank = blank.slice(0, site.start) + '\u0001'.repeat(site.end - site.start) + blank.slice(site.end);
    const found: SiteMention[] = [];
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(blank)) !== null && found.length < 400) {
      const host = brands.get((m[1] ?? '').toLowerCase());
      if (host) found.push({ start: m.index, end: m.index + (m[1] ?? '').length, raw: text.slice(m.index, m.index + (m[1] ?? '').length), host, isUrl: false });
    }
    return found.length === 0 ? sites : [...sites, ...found].sort((a, b) => a.start - b.start);
  };
}

/**
 * The sites a text names, first mention first, each once: domains and links, and the brand name ("Idealo") of every
 * site in `named`. The engine uses it to tell which site a line of the answer or a plan step is about.
 */
export function mentionedSites(text: string, named: readonly string[] = []): string[] {
  if (typeof text !== 'string') return [];
  return hostsOfText(makeScanner(named), text.length > 20_000 ? text.slice(0, 20_000) : text);
}

// ---------------------------------------------------------------------------------------------
// Cutting the answer into segments
// ---------------------------------------------------------------------------------------------

interface Cell {
  start: number;
  end: number;
  /** The header of the table column, cleaned, or "". */
  header: string;
}

interface Segment {
  text: string;
  /** Where the segment starts in the whole answer (for ordering notes). */
  offset: number;
  cells: Cell[];
  mentions: SiteMention[];
  /** The hosts of the heading above this segment. */
  governing: string[];
  /** Per cell: the site a column header names, when a header is only a site name. */
  colHosts: Array<string | undefined>;
  /** The header row of a table: its links and numbers are claims, its words ("Shipping") are not. */
  header?: boolean;
  /** A table row: the site the whole row is about (the site of its Source / Shop column, or its first cell). */
  rowOwner?: string;
  /** Per cell: the cell names a site in words (a domain or a brand), and not only through a link. */
  cellNames: boolean[];
  /** The one site the sentence before this one (same paragraph or item) is about, when it says nothing against it: "I checked idealo.de. The price is ...". */
  prevSite?: string;
}

const ABBREVIATIONS: ReadonlySet<string> = new Set([
  'ca', 'approx', 'etc', 'vs', 'eg', 'e.g', 'ie', 'i.e', 'no', 'nr', 'st', 'dr', 'mr', 'mrs', 'ms', 'inc', 'ltd', 'co', 'bzw', 'ggf', 'usw', 'inkl', 'zzgl', 'evtl', 'z.b',
  'u.a', 'd.h', 'incl', 'excl', 'circa', 'resp', 'cf', 'ex', 'fig', 'est', 'min', 'max', 'tel', 'ok', 'mwst', 'ust', 'gesetzl', 'einschl', 'exkl', 'abzgl', 'bzgl', 'vgl', 'stk', 'mind'
]);

function isLetterChar(ch: string | undefined): boolean {
  return ch !== undefined && ch !== '' && /[A-Za-z]/.test(ch);
}

function endsWithAbbreviation(masked: string, dotAt: number): boolean {
  let i = dotAt - 1;
  let token = '';
  while (i >= 0 && token.length < 12 && (isLetterChar(masked[i]) || masked[i] === '.')) {
    token = (masked[i] ?? '') + token;
    i--;
  }
  token = token.toLowerCase();
  while (token.startsWith('.')) token = token.slice(1);
  if (token.length === 1 && isLetterChar(token)) return true;
  return ABBREVIATIONS.has(token);
}

const DOMAIN_START = /[a-z0-9][a-z0-9-]*\.[a-z]{2,24}/iy;

function startsSentence(masked: string, at: number): boolean {
  const ch = masked[at];
  if (ch === undefined) return false;
  if (ch === '\u0001') return true;
  if (/[0-9"'([{#*\-\u2022>_`\u201c\u2018]/.test(ch)) return true;
  if (ch !== ch.toLowerCase()) return true;
  // A lowercase start is a new sentence only when it is a site name: "... EUR 2,069. idealo.de: not checked."
  DOMAIN_START.lastIndex = at;
  const m = DOMAIN_START.exec(masked);
  return m !== null && looksLikeDomain(m[0]);
}

/**
 * Sentence spans of a text. A full stop ends a sentence when white space follows and the next word
 * starts a sentence (capital letter, digit, bracket, link, or a site name), and the word before it is
 * not an abbreviation (ca., approx., e.g.). Links and decimal numbers never contain a split.
 */
function splitSentenceSpans(text: string): Array<[number, number]> {
  const masked = maskLinks(text);
  const n = masked.length;
  const spans: Array<[number, number]> = [];
  let start = 0;
  let i = 0;
  while (i < n) {
    const c = masked[i];
    if (c === '.' || c === '!' || c === '?' || c === '\u3002') {
      let j = i;
      while (j + 1 < n && (masked[j + 1] === '.' || masked[j + 1] === '!' || masked[j + 1] === '?')) j++;
      let k = j + 1;
      while (k < n && ')]"\'*_\u201d\u2019'.includes(masked[k] ?? '')) k++;
      if (k >= n) break;
      if (/\s/.test(masked[k] ?? '')) {
        let m = k;
        while (m < n && /\s/.test(masked[m] ?? '')) m++;
        if (m < n && startsSentence(masked, m) && !(c === '.' && endsWithAbbreviation(masked, i))) {
          spans.push([start, k]);
          start = m;
          i = m;
          continue;
        }
      }
      i = j + 1;
      continue;
    }
    i++;
  }
  spans.push([start, n]);
  return spans.filter(([a, b]) => b > a && text.slice(a, b).trim() !== '');
}

/** The sentences of a text, as the audit cuts them (links and decimal numbers never contain a split; "ca." and "e.g." do not end one). */
export function splitSentences(text: string): string[] {
  return typeof text === 'string' ? splitSentenceSpans(text).map(([a, b]) => text.slice(a, b).trim()) : [];
}

function stripMarkdown(s: string): string {
  return s.replace(/[*_`]+/g, '').replace(/\s+/g, ' ').trim();
}

const MAX_STRUCTURE_LINE = 2000;

/** The distinct hosts a text names, in order of appearance. */
function hostsOfText(scan: Scanner, text: string): string[] {
  return [...new Set(scan(text).map((m) => m.host))];
}

/** A line that acts as a heading for the lines below it without being a "#" heading: **idealo.de**, or just "idealo.de:". */
function labelHosts(content: string, scan: Scanner): string[] | null {
  if (content.length > 200) return null;
  const c = content.trim();
  if (c === '') return null;
  const bold = /^(\*\*|__)(.+?)\1\s*:?\s*$/.exec(c);
  if (bold) {
    const hosts = hostsOfText(scan, bold[2] ?? '');
    return hosts.length > 0 ? hosts : null;
  }
  const plain = c.replace(/[:\uff1a]\s*$/, '');
  const mentions = scan(plain);
  if (mentions.length === 1) {
    const only = mentions[0];
    if (only && only.start === 0 && only.end === plain.length) return [only.host];
  }
  return null;
}

// A line that only says "here comes the summary": **Summary**, "Fazit:", "Comparison table", "---". It ends the
// section of the last site, so a closing table or paragraph is not filed under it.
const CLOSER_RE =
  /^(?:the\s+|der\s+|die\s+|das\s+)?(?:(?:final|price|quick|short|overall|kurz|gesamt)\s+)?(?:summary|comparison|overview|conclusion|conclusions|results?|verdict|recommendation|takeaway|overall|bottom line|in short|in summary|to summari[sz]e|tl;?dr|final answer|fazit|zusammenfassung|ergebnis(?:se)?|vergleich(?:stabelle)?|preisvergleich|[u\u00fc]bersicht|empfehlung|gesamtergebnis|resumen)(?:\s+(?:table|list|tabelle))?$/i;
const THEMATIC_BREAK_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;

function isCloserLabel(content: string): boolean {
  const c = stripMarkdown(content).replace(/^#+\s*/, '').replace(/[:\uff1a.]\s*$/, '').trim();
  return c.length > 0 && c.length <= 40 && CLOSER_RE.test(c);
}

// "Price: ...", "Versand: ...": a line that gives one fact about the site above it. A blank line between such lines
// does not end the heading's section, because the next fact is still about the same site.
const FIELD_LINE_RE =
  /^\s*(?:[-*+\u2022]\s+)?(?:\*\*|__)?\s*(?:price|preis|cost|kosten|total|gesamt|shipping|versand(?:kosten)?|delivery|lieferung|lieferzeit|availability|verf[u\u00fc]gbarkeit|stock|lager|url|link|source|quelle|shop|seller|h[a\u00e4]ndler|condition|zustand|config(?:uration)?|konfiguration|model|modell|discount|rabatt|savings|difference|abweichung)\b[^:\n]{0,20}(?:\*\*|__)?\s*:/i;
const SOURCE_ITEM_RE = /^\s*(?:\*\*|__)?\s*(?:source|shop|site|store|seller|retailer|vendor|quelle|h[a\u00e4]ndler|anbieter)s?\s*(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*(.+)$/i;
// A table column that says which site a row is about.
const SOURCE_HEADER_RE = /\b(?:source|sources|shop|site|store|seller|retailer|vendor|reseller|platform|marketplace|quelle|h[a\u00e4]ndler|anbieter|website)\b/i;
// A column named "Against frame.work" or "Diff to idealo.de" compares with a site; it is not the column OF that site.
const COMPARISON_HEADER_RE = /\b(?:against|versus|vs\.?|diff(?:erence)?|delta|compared?|gegen(?:\u00fcber)?|abweichung|vergleich|zu)\b/i;

function isTableSeparator(line: string): boolean {
  const t = line.trim();
  return t.length > 0 && t.length <= MAX_STRUCTURE_LINE && t.includes('-') && t.includes('|') && /^[\s|:-]+$/.test(t);
}

function splitRowCells(line: string): Array<{ start: number; end: number }> {
  const cells: Array<{ start: number; end: number }> = [];
  let segStart = 0;
  const pushCell = (a: number, b: number): void => {
    let s = a;
    let e = b;
    while (s < e && /\s/.test(line[s] ?? '')) s++;
    while (e > s && /\s/.test(line[e - 1] ?? '')) e--;
    cells.push({ start: s, end: e });
  };
  const first = line.indexOf('|');
  segStart = first + 1;
  for (let i = segStart; i <= line.length; i++) {
    if (i === line.length || line[i] === '|') {
      if (i === line.length && line.slice(segStart).trim() === '') break;
      pushCell(segStart, i);
      segStart = i + 1;
    }
  }
  return cells;
}

interface Level {
  level: number;
  hosts: string[];
  /** Segments filed under this heading so far. */
  content: number;
  /** A list, a table or a "Price: ..." line was filed under it: what follows a blank line may be a closing paragraph. */
  blockSeen: boolean;
  /** Everything filed under it so far was a "Price: ..." line. */
  fieldsOnly: boolean;
  /** A blank line came after content, and nothing has come since. */
  pendingBlank: boolean;
  /** A closing paragraph or table was reached: nothing below governs any more. */
  released: boolean;
}

function newLevel(level: number, hosts: string[]): Level {
  return { level, hosts, content: 0, blockSeen: false, fieldsOnly: true, pendingBlank: false, released: false };
}

function buildSegments(text: string, scan: Scanner): Segment[] {
  const segments: Segment[] = [];
  const stack: Level[] = [];
  let para: Array<{ start: number; end: number }> = [];
  let tableHeaders: string[] | null = null;
  let tableColHosts: Array<string | undefined> = [];
  let tableSourceCol = -1;
  // A run of list items with exactly one "Source: idealo.de" item is about that site (the item can come after the data).
  let run: { start: number; source: string; count: number } | null = null;
  // The open list items by indentation, so a "Source: idealo.de" item nested under an item is about that item.
  let items: Array<{ indent: number; start: number }> = [];

  const governingLevel = (): Level | undefined => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const level = stack[i];
      if (level && level.hosts.length > 0) return level;
    }
    return undefined;
  };
  const governing = (): string[] => {
    const level = governingLevel();
    return level && !level.released ? level.hosts : [];
  };
  const noteContent = (kind: 'item' | 'para' | 'table', field: boolean): void => {
    const level = governingLevel();
    if (!level || level.released) return;
    level.content++;
    if (kind !== 'para' || field) level.blockSeen = true;
    if (!field) level.fieldsOnly = false;
  };
  /**
   * A new line of content arrives. After a blank line that followed content, a bold or site-name label stops governing
   * (a closing paragraph is not about the last site), and so does a "#" heading for a paragraph or a table that comes
   * after a list, a table or a "Price: ..." block. Further "Price: ..." lines after a blank line still belong to the
   * site above, and so do further list items under a "#" heading (a loose list).
   */
  const arrive = (kind: 'item' | 'para' | 'table', field: boolean): void => {
    const level = governingLevel();
    if (!level || !level.pendingBlank) return;
    level.pendingBlank = false;
    if (level.content === 0) return;
    const continues = field && level.fieldsOnly;
    if (level.level === 7) {
      if (!continues) {
        const at = stack.indexOf(level);
        if (at >= 0) stack.length = at;
      }
      return;
    }
    if (level.blockSeen && kind !== 'item' && !continues) level.released = true;
  };
  const closeSection = (): void => {
    const level = governingLevel();
    if (level && level.content > 0) {
      const at = stack.indexOf(level);
      if (at >= 0) stack.length = at;
    }
  };
  const closeRun = (): void => {
    if (run && run.count === 1) {
      for (let i = run.start; i < segments.length; i++) {
        const seg = segments[i];
        if (seg) seg.governing = [run.source];
      }
    }
    run = null;
    items = [];
  };
  const makeSegment = (sentence: string, offset: number, gov: string[]): Segment => ({
    text: sentence,
    offset,
    cells: [{ start: 0, end: sentence.length, header: '' }],
    mentions: scan(sentence),
    governing: gov,
    colHosts: [undefined],
    cellNames: [false]
  });
  const pushText = (piece: string, offset: number, gov: string[]): void => {
    let previous: string | undefined;
    for (const [a, b] of splitSentenceSpans(piece)) {
      const seg = makeSegment(piece.slice(a, b), offset + a, gov);
      if (previous !== undefined) seg.prevSite = previous;
      segments.push(seg);
      // A sentence that names one site hands it to the next sentence, unless it says the site was not looked at.
      const hosts = [...new Set(seg.mentions.map((m) => m.host))];
      if (hosts.length === 1) previous = UNCHECKED_RE.test(maskLinks(seg.text)) ? undefined : hosts[0];
      else if (hosts.length > 1) previous = undefined;
    }
  };
  const flushPara = (): void => {
    if (para.length === 0) return;
    const first = para[0];
    const last = para[para.length - 1];
    const lines = para;
    para = [];
    if (first && last) {
      pushText(text.slice(first.start, last.end), first.start, governing());
      noteContent('para', lines.every((l) => FIELD_LINE_RE.test(text.slice(l.start, l.end))));
    }
  };
  const pushHeading = (level: number, content: string, offset: number, hosts: string[]): void => {
    while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= level) stack.pop();
    const parentGoverning = governing();
    stack.push(newLevel(level, hosts));
    pushText(content, offset, parentGoverning);
  };

  // Lines with their offsets.
  const lines: Array<{ start: number; end: number }> = [];
  let pos = 0;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const end = nl < 0 ? text.length : nl;
    lines.push({ start: pos, end });
    if (nl < 0) break;
    pos = nl + 1;
  }

  for (let li = 0; li < lines.length; li++) {
    const span = lines[li];
    if (!span) continue;
    const line = text.slice(span.start, span.end);
    const trimmed = line.trim();
    if (trimmed === '') {
      flushPara();
      closeRun();
      tableHeaders = null;
      const level = governingLevel();
      if (level && level.content > 0) level.pendingBlank = true;
      continue;
    }
    if (line.length > MAX_STRUCTURE_LINE) {
      closeRun();
      tableHeaders = null;
      para.push(span);
      continue;
    }

    // Table.
    if (trimmed.startsWith('|')) {
      flushPara();
      closeRun();
      if (isTableSeparator(line)) continue;
      arrive('table', false);
      const cellSpans = splitRowCells(line);
      const next = lines[li + 1];
      const nextIsSeparator = next !== undefined && isTableSeparator(text.slice(next.start, next.end));
      let isHeader = false;
      if (nextIsSeparator && tableHeaders === null) {
        isHeader = true;
        tableHeaders = cellSpans.map((c) => stripMarkdown(line.slice(c.start, c.end)));
        // A column is the column OF a site when its header names exactly one site ("idealo.de", "Idealo (idealo.de)",
        // "idealo.de price"), unless it only compares with that site ("Against frame.work").
        tableColHosts = tableHeaders.map((h) => {
          const hosts = hostsOfText(scan, h);
          return hosts.length === 1 && !COMPARISON_HEADER_RE.test(h) ? hosts[0] : undefined;
        });
        tableSourceCol = tableHeaders.findIndex((h) => SOURCE_HEADER_RE.test(h) && hostsOfText(scan, h).length === 0);
      }
      const cells: Cell[] = cellSpans.map((c, idx) => ({ start: c.start, end: c.end, header: isHeader ? '' : (tableHeaders?.[idx] ?? '') }));
      const cellNames = cellSpans.map((c) => scan(line.slice(c.start, c.end)).some((m) => !m.isUrl));
      let rowOwner: string | undefined;
      if (!isHeader) {
        // The row is about the site of its Source / Shop column; a link in another cell is only a citation.
        const owned = tableSourceCol >= 0 ? cellSpans[tableSourceCol] : undefined;
        const ownedHosts = owned ? hostsOfText(scan, line.slice(owned.start, owned.end)) : [];
        if (ownedHosts.length === 1) rowOwner = ownedHosts[0];
        else if (tableColHosts.every((h) => h === undefined)) {
          const firstCell = cellSpans[0];
          const firstHosts = firstCell ? scan(line.slice(firstCell.start, firstCell.end)).filter((m) => !m.isUrl) : [];
          if (firstHosts.length === 1) rowOwner = firstHosts[0]?.host;
        }
      }
      const seg: Segment = {
        text: line,
        offset: span.start,
        cells,
        mentions: scan(line),
        governing: governing(),
        colHosts: cellSpans.map((_c, idx) => tableColHosts[idx]),
        cellNames
      };
      if (isHeader) seg.header = true;
      if (rowOwner !== undefined) seg.rowOwner = rowOwner;
      segments.push(seg);
      if (!isHeader) noteContent('table', false);
      continue;
    }
    tableHeaders = null;
    tableSourceCol = -1;

    // "#" heading.
    const heading = /^ {0,3}(#{1,6})[ \t]+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      closeRun();
      const level = (heading[1] ?? '#').length;
      const content = heading[2] ?? '';
      const at = span.start + line.length - content.length;
      if (isCloserLabel(content)) closeSection();
      pushHeading(level, content, at, hostsOfText(scan, content));
      continue;
    }

    // A line that only closes the section: "**Summary**", "Fazit:", "---".
    if (THEMATIC_BREAK_RE.test(line) || isCloserLabel(line)) {
      flushPara();
      closeRun();
      closeSection();
      continue;
    }

    // List item, or a plain line.
    const item = /^[ \t]*(?:[-*+\u2022]|\d{1,3}[.)])[ \t]+(.*)$/.exec(line);
    const content = item ? (item[1] ?? '') : line;
    const at = span.start + line.length - content.length;
    const label = labelHosts(content, scan);
    if (label) {
      flushPara();
      closeRun();
      pushHeading(7, content, at, label);
      continue;
    }
    if (item) {
      flushPara();
      const field = FIELD_LINE_RE.test(line);
      arrive('item', field);
      if (!run) run = { start: segments.length, source: '', count: 0 };
      const indent = (/^[ \t]*/.exec(line)?.[0] ?? '').replace(/\t/g, '    ').length;
      while (items.length > 0 && (items[items.length - 1]?.indent ?? 0) >= indent) items.pop();
      const parent = items[items.length - 1];
      const first = segments.length;
      let nested: string | undefined;
      const sourceItem = SOURCE_ITEM_RE.exec(content);
      if (sourceItem) {
        const hosts = hostsOfText(scan, sourceItem[1] ?? '');
        if (hosts.length === 1 && parent) nested = hosts[0];
        else if (hosts.length === 1) {
          run.count++;
          run.source = hosts[0] ?? '';
        }
      }
      pushText(content, at, governing());
      if (nested !== undefined && parent) {
        for (let i = parent.start; i < segments.length; i++) {
          const seg = segments[i];
          if (seg) seg.governing = [nested];
        }
      }
      items.push({ indent, start: first });
      noteContent('item', field);
      continue;
    }
    closeRun();
    if (para.length === 0) arrive('para', FIELD_LINE_RE.test(line));
    para.push(span);
  }
  flushPara();
  closeRun();
  return segments;
}

/**
 * How the audit cuts an answer: each segment with the sites it names and the sites of the heading
 * above it. For tests and debugging only; the audit itself uses the richer internal form. `named` are the
 * sites of the task, whose brand names ("Idealo") then count as mentions too.
 */
export function segmentAnswer(answer: string, named: readonly string[] = []): Array<{ text: string; hosts: string[]; governing: string[] }> {
  if (typeof answer !== 'string') return [];
  const text = normalizeSpaces((answer.length > MAX_ANSWER_CHARS ? answer.slice(0, MAX_ANSWER_CHARS) : answer).replace(/\r\n?/g, '\n'));
  return buildSegments(text, makeScanner(named)).map((seg) => ({ text: seg.text.trim(), hosts: [...new Set(seg.mentions.map((m) => m.host))], governing: seg.governing }));
}

// ---------------------------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------------------------

type ClaimKind = 'money' | 'percent' | 'duration' | 'detail' | 'url';

interface Claim {
  kind: ClaimKind;
  /** As the answer wrote it. */
  raw: string;
  /** The sites it belongs to (registrable hosts); empty means "check every page". */
  scope: string[];
  /** Position in the answer, to order the notes. */
  pos: number;
  /** Index of its segment, to tell which claims share a sentence or a row. */
  seg: number;
  money?: MoneyToken;
  percent?: PercentToken;
  duration?: DurationToken;
  url?: SiteMention;
  /** The number is one the task itself gave ("My friend says EUR 1,899 on idealo.de"). It is a claim only when it is attributed to a site and no page shows it. */
  goalEcho?: boolean;
  /** A word that compares or refutes stands right before it ("above EUR 2,000", "not EUR 1,899"). */
  comparing?: boolean;
  /** The sentence or row says that something was not checked, not found, blocked. */
  negated?: boolean;
  /** "within", "up to", "bis zu" stands right before a duration: it is an upper bound, and a page range that ends there supports it. */
  upTo?: boolean;
  /** The site of the sentence before, which owns this claim when that site was never opened (the claim's own scope is only a fallback then). */
  inherit?: string;
  /** The segment itself decided the scope (its own words, its row or its column), and not the heading above it. */
  local: boolean;
  /** The sites named on the claim's own line (a row, a sentence, one line of a paragraph), and where that line starts in the answer. */
  near: string[];
  line: number;
}

const DETAIL_RE = /\b(?:shipping|shipped|ships?|versand\w*|delivery|deliveries|delivered|liefer\w*|kostenlos\w*|gratis)\b/i;
const SHIPPING_HEADER_RE = /\b(?:shipping|versand\w*|delivery|lieferung|lieferzeit|liefer\w*|ships?)\b/i;
const PRICE_HEADER_RE = /(?:price|preis|cost|kosten|total|gesamt|shipping|versand|amount|betrag|fee|zzgl)/i;

// Letters and digits as any language writes them. \b and \w only know a-z, so "\bgepr\w+" never matched "geprüft".
const NOT_LETTER_BEFORE = '(?<![\\p{L}\\p{N}_])';

/** The ways an answer says that a SITE was not looked at: "not checked", "blocked", "captcha", "nicht geprüft", "übersprungen". */
const UNCHECKED_PARTS: readonly string[] = [
  "(?:not|never)\\s+(?:yet\\s+)?(?:been\\s+)?(?:checked|opened|visited|verified|read|looked\\s+at|reached|loaded|accessed|accessible|fetched|possible)",
  "(?:could\\s+not|couldn'?t|cannot|can'?t|unable\\s+to|wasn'?t\\s+able\\s+to|was\\s+not\\s+able\\s+to|failed\\s+to|did\\s+not|didn'?t|do\\s+not|don'?t)\\s+(?:find|see|read|open|check|get|access|reach|load|verify|visit|fetch|look)",
  // "idealo.de and geizhals.de were not." - the verb was said before.
  "(?:was|were|is|are|has|have|had)(?:\\s+not|n'?t)(?=\\s*(?:[.,;:)\\]]|$))",
  'unchecked|blocked|blockiert|gesperrt|captcha|cloudflare|robot\\s+check|access\\s+denied|forbidden|timed?\\s*out|timeout|failed\\s+to\\s+load|skipped|\\u00fcbersprungen|uebersprungen|zugriff\\s+verweigert|out\\s+of\\s+steps|never\\s+opened|not\\s+reached',
  'nicht\\s+(?:[\\p{L}\\p{N}_]+\\s+){0,2}(?:gepr[\\p{L}]*|ge(?:oe|\\u00f6)ffnet|erreicht|gelesen|abgerufen|besucht|erreichbar|geladen|verf[\\p{L}]*)',
  'l(?:\\u00e4|ae)dt\\s+nicht',
  'konnte\\s+nicht|konnten\\s+nicht|kann\\s+nicht'
];

/** The ways an answer says that a FACT is not known: "not stated", "unknown", "no price", "nicht angegeben", "keine Angabe". */
const NO_DATA_PARTS: readonly string[] = [
  'not\\s+(?:stated|shown|listed|given|available|mentioned|specified|known|found|visible)',
  'unknown|unbekannt|n\\/a|unavailable|not\\s+applicable',
  'no\\s+(?:price|shipping|delivery|versand|data|info|information|details)',
  'nicht\\s+(?:[\\p{L}\\p{N}_]+\\s+){0,2}(?:angegeben|genannt|bekannt|gefunden|ersichtlich)',
  'keine\\s+(?:angabe|angaben|preise?|daten|informationen)',
  'error|fehler'
];

const alternation = (parts: readonly string[]): RegExp => new RegExp(parts.map((p) => `${NOT_LETTER_BEFORE}(?:${p})`).join('|'), 'iu');

/**
 * Wording that says a SITE was not looked at: "not checked", "could not open", "blocked", "captcha", "access denied",
 * "timed out", "nicht geprüft", "übersprungen". Not a bare "not": "they do not differ by more than 5%" says nothing about
 * what was opened. The engine uses it for the same question (planEvidence.ts).
 */
export const UNCHECKED_RE: RegExp = alternation(UNCHECKED_PARTS);

/**
 * Wording that says a statement is NOT a claim: everything UNCHECKED_RE knows, and "not stated", "unknown", "I did not find
 * shipping information". A shipping or delivery word inside such a sentence is not a statement of fact, and a cell that says
 * "blocked" is the honest way to write "not checked".
 */
const NEGATION_RE: RegExp = alternation([...UNCHECKED_PARTS, ...NO_DATA_PARTS]);

/** Words that make a shipping or delivery cell a statement of fact, when the cell has no shipping word of its own ("Free", "DHL", "Abholung"). */
const POSITIVE_SHIPPING_RE = new RegExp(
  `${NOT_LETTER_BEFORE}(?:free|included|inkl\\p{L}*|inclusive|kostenlos\\p{L}*|gratis|versandkostenfrei|portofrei|standard|express|dhl|dpd|hermes|ups|gls|pick-?up|abholung)(?![\\p{L}\\p{N}_])`,
  'iu'
);
const TAX_WORD_RE = /(?<![\p{L}\p{N}_])(?:vat|mwst|mehrwertsteuer|ust|umsatzsteuer|tax|taxes|steuer|tva|iva|btw|gst)(?![\p{L}\p{N}_])/iu;
/** The rates of value added tax that a model knows by heart. A percentage of this kind beside a tax word is a legal fact and not a price claim. */
const STANDARD_TAX_RATES: readonly number[] = [19, 7, 20, 10, 13, 21, 9, 22, 23, 8.1, 2.6, 3.8, 5.5, 5];
const COMPARE_BEFORE_RE = /(?<![\p{L}])(?:than|below|under|above|over|within|less|more|als|unter|[u\u00fc]ber|bis|wrong|not|falsch|nicht|instead|statt|cheaper|teurer|exceeds?)(?![\p{L}])/iu;
const UP_TO_RE = /(?<![\p{L}])(?:within|up\s+to|max(?:imum)?|at\s+most|no\s+more\s+than|bis\s+zu|innerhalb|h\u00f6chstens|hoechstens|maximal|sp\u00e4testens|spaetestens)\s*$/iu;

function firstIndexAtOrAfter(mentions: readonly SiteMention[], pos: number): number {
  let lo = 0;
  let hi = mentions.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((mentions[mid]?.end ?? 0) <= pos) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** "EUR 2,189.00 at idealo.de": the words between a claim and the site after it that make the site the claim's own. */
const FORWARD_BINDING_RE = /^[\s(),]*(?:at|on|from|via|bei|von|auf|@|for|f\u00fcr|fuer|with|mit|by)\s+(?:the\s+)?(?:site\s+|shop\s+|store\s+)?$/i;

/** True when the site right after a claim is where the claim comes from: "... at idealo.de", "EUR 2,189 (idealo.de)", "EUR 2,189 (https://idealo.de/x)". */
function bindsForward(seg: Segment, claimEnd: number, next: SiteMention): boolean {
  const gap = seg.text.slice(claimEnd, next.start);
  if (gap.length > 16) return false;
  if (FORWARD_BINDING_RE.test(gap)) return true;
  return gap.trim() === '(' && (next.isUrl || seg.text[next.end] === ')');
}

/**
 * The sites a claim belongs to. A site that follows the claim after a preposition ("... EUR 2,189 at
 * idealo.de") owns it. Otherwise the site named most recently before it in its segment wins ("idealo.de:
 * EUR 2,189"); then the site a table column is named after; then the heading above; then a site named
 * after the claim. `local` is true when the segment itself decided (its own words, its row, its column), false
 * when the heading or the next mention did: only then may the sentence before lend its site.
 */
function scopeFor(seg: Segment, start: number, end: number, cellIndex: number): { scope: string[]; local: boolean } {
  // A table row is about the site of its Source column: a link in another cell of the row only cites a page.
  if (seg.rowOwner !== undefined && !seg.cellNames[cellIndex]) return { scope: [seg.rowOwner], local: true };
  const after = firstIndexAtOrAfter(seg.mentions, start);
  let k = after;
  while (k < seg.mentions.length && (seg.mentions[k]?.start ?? 0) < end) k++;
  const next = seg.mentions[k];
  if (next && bindsForward(seg, end, next)) return { scope: [next.host], local: true };
  const prev = after > 0 ? seg.mentions[after - 1] : undefined;
  if (prev) return { scope: [prev.host], local: true };
  const col = seg.colHosts[cellIndex];
  if (col) return { scope: [col], local: true };
  if (seg.governing.length > 0) return { scope: seg.governing, local: false };
  return { scope: next ? [next.host] : [], local: false };
}

/** The longest text of a shipping or delivery statement a note shows. Shorter than what quote() allows, so quote never cuts one. */
const DETAIL_MAX = 60;
/** How far after the shipping word the statement may run before it is cut. The end of the clause usually comes first. */
const DETAIL_LOOKAHEAD = 120;

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '9';
}

/**
 * Where the clause that starts a shipping statement ends: at ";", "|", a line break, a bracket or a link, and at a comma or
 * a full stop that ends a clause. A comma or a full stop BETWEEN TWO DIGITS is part of a number ("4,90", "1.329,00",
 * "3.5 days") and never ends anything: cutting there made "Shipping: 4,90 EUR" read "Shipping: 4". A full stop inside a word
 * or a name ("U.S.", "frame.work") does not end a clause either, only one followed by white space or the end does, and not one
 * that ends an abbreviation ("Shipping: approx. 4,90 EUR" is one statement, not "Shipping: approx").
 */
function clauseEnd(masked: string, from: number): number {
  const limit = Math.min(masked.length, from + DETAIL_LOOKAHEAD);
  for (let i = from; i < limit; i++) {
    const ch = masked[i];
    if (ch === ';' || ch === '|' || ch === '\n' || ch === '(' || ch === '\u0001') return i;
    if (ch === ',' || ch === '.') {
      if (isDigit(masked[i - 1]) && isDigit(masked[i + 1])) continue;
      if (ch === '.' && masked[i + 1] !== undefined && !/\s/.test(masked[i + 1] ?? '')) continue;
      if (ch === '.' && endsWithAbbreviation(masked, i)) continue;
      return i;
    }
  }
  return limit;
}

/**
 * A short piece of the statement itself: the shipping word with the "free" before it and the rest of its clause, at most
 * DETAIL_MAX characters, and cut between words when it is longer ("..." says so). Never a half number.
 */
function detailRaw(masked: string, index: number, matchLength: number): string {
  let from = index;
  const before = masked.slice(Math.max(0, index - 12), index);
  const free = /(free|kostenlos\w*|gratis)\s+$/i.exec(before);
  if (free) from = index - free[0].length;
  let end = clauseEnd(masked, index + matchLength);
  // A claim is a value and never a site or a link ("Versand amazon.de/a/b?c=d"): the note goes into the answer, which must not carry a link back in.
  const site = scanSites(masked.slice(index + matchLength, end))[0];
  if (site) end = index + matchLength + site.start;
  return cutAtWord(stripMarkdown(masked.slice(from, end)), DETAIL_MAX);
}

function isTrivialCell(text: string): boolean {
  const t = stripMarkdown(text);
  if (t.replace(/[^A-Za-z\u00c0-\u024f]/g, '').length < 2) return true;
  return /^(?:none|nein|no|n\/a|-+|\?+)$/i.test(t);
}

/** The clauses of a cell or sentence: the pieces between ";", brackets, ", ", " - " and full stops. */
function clauseSpans(text: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  const re = /[;()]|,\s|\s[-\u2013\u2014]\s|\.\s/g;
  let from = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    spans.push({ start: from, end: m.index });
    from = m.index + m[0].length;
  }
  spans.push({ start: from, end: text.length });
  return spans.filter((sp) => sp.end > sp.start);
}

/** True when a percentage sits within three words of a tax word and is one of the usual tax rates ("inkl. 19% MwSt."). */
function isTaxRate(cellText: string, t: PercentToken): boolean {
  if (!STANDARD_TAX_RATES.some((rate) => Math.abs(rate - t.value) < 1e-9)) return false;
  const before = cellText.slice(Math.max(0, t.start - 40), t.start).split(/\s+/).filter(Boolean).slice(-3).join(' ');
  const after = cellText.slice(t.end, t.end + 40).split(/\s+/).filter(Boolean).slice(0, 3).join(' ');
  return TAX_WORD_RE.test(before) || TAX_WORD_RE.test(after);
}

/** The lines of a segment, looked up by offset: where the line starts, the sites it names, and whether it says a site was not looked at. Each line is worked out once, however many claims it holds. */
function lineIndexOf(seg: Segment, masked: string): { of(offset: number): { start: number; near: string[]; negated: boolean } } {
  const breaks: number[] = [];
  for (let i = seg.text.indexOf('\n'); i >= 0; i = seg.text.indexOf('\n', i + 1)) breaks.push(i);
  const cache = new Map<number, { start: number; near: string[]; negated: boolean }>();
  return {
    of(offset: number) {
      // The first line break at or after the offset ends the line, the one before it starts it.
      let lo = 0;
      let hi = breaks.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if ((breaks[mid] ?? 0) < offset) lo = mid + 1;
        else hi = mid;
      }
      const start = lo === 0 ? 0 : (breaks[lo - 1] ?? -1) + 1;
      const end = lo < breaks.length ? (breaks[lo] ?? seg.text.length) : seg.text.length;
      let info = cache.get(start);
      if (!info) {
        info = {
          start,
          near: [...new Set(seg.mentions.filter((m) => m.start >= start && m.start < end).map((m) => m.host))],
          negated: UNCHECKED_RE.test(masked.slice(start, end))
        };
        cache.set(start, info);
      }
      return info;
    }
  };
}

function collectClaims(segments: readonly Segment[], goal: GoalFacts): Claim[] {
  const claims: Claim[] = [];
  segments.forEach((seg, segIndex) => {
    const masked = maskLinks(seg.text);
    const lines = lineIndexOf(seg, masked);
    seg.cells.forEach((cell, cellIndex) => {
      const cellText = masked.slice(cell.start, cell.end);
      if (cellText.trim() === '') return;
      const scanned = scanNumbers(cellText);
      const headerPrice = PRICE_HEADER_RE.test(cell.header);
      const comparingBefore = (at: number): boolean => COMPARE_BEFORE_RE.test(cellText.slice(Math.max(0, at - 30), at));
      const make = (kind: ClaimKind, raw: string, start: number, end: number, extra: Partial<Claim>): Claim => {
        const found = scopeFor(seg, start, end, cellIndex);
        // The line of the claim: what stands between the line breaks around it. The sites named there are its neighbours,
        // and a line that says a site was not looked at ("idealo.de: not checked") does not give data for that site.
        const line = lines.of(start);
        const claim: Claim = { kind, raw, scope: found.scope, pos: seg.offset + start, seg: segIndex, local: found.local, near: line.near, line: seg.offset + line.start, ...extra };
        if (!found.local && seg.prevSite !== undefined) claim.inherit = seg.prevSite;
        if (line.negated) claim.negated = true;
        return claim;
      };

      for (const t of scanned.money) {
        const bareClaim = t.currency === '' && t.priceShape && (t.priceContext || headerPrice);
        if (t.currency === '' && !bareClaim) continue;
        if (t.values.every((v) => v === 0)) continue;
        const start = cell.start + t.start;
        const end = cell.start + t.end;
        const claim = make('money', seg.text.slice(start, end), start, end, { money: t });
        // The task's own number. Repeating it with no site is fine; giving it to a site as that site's value is a claim.
        if (t.values.some((v) => goal.money.has(amountKey(v)))) {
          claim.goalEcho = true;
          claim.comparing = comparingBefore(t.start);
        }
        claims.push(claim);
      }
      for (const t of scanned.percents) {
        if (t.value === 0 || t.value === 100) continue;
        // A threshold of the task ("more than 5%") is not a claim. Neither is a usual tax rate beside a tax word.
        if (goal.percents.some((p) => Math.abs(p - t.value) < 1e-9)) continue;
        if (isTaxRate(cellText, t)) continue;
        const start = cell.start + t.start;
        const end = cell.start + t.end;
        claims.push(make('percent', seg.text.slice(start, end), start, end, { percent: t }));
      }
      for (const t of scanned.durations) {
        const start = cell.start + t.start;
        const end = cell.start + t.end;
        const claim = make('duration', seg.text.slice(start, end), start, end, { duration: t });
        if (goal.durations.has(`${t.low}|${t.high}|${t.unit}`)) {
          claim.goalEcho = true;
          claim.comparing = comparingBefore(t.start);
        }
        if (UP_TO_RE.test(cellText.slice(Math.max(0, t.start - 20), t.start))) claim.upTo = true;
        claims.push(claim);
      }

      // A shipping or delivery statement without a number: "free shipping", "Versand kostenlos". The header row of a
      // table only names its columns ("Shipping"); that is not a statement.
      if (seg.header) return;
      let found = false;
      const clauses = clauseSpans(cellText);
      let earlierNegated = false;
      for (let ci = 0; ci < clauses.length && !found; ci++) {
        const clause = clauses[ci];
        if (!clause) continue;
        const clauseText = cellText.slice(clause.start, clause.end);
        // "free shipping, delivery time unknown" states the first and disclaims the second: the negation belongs to its own clause.
        const clauseNegated = NEGATION_RE.test(clauseText);
        const positive = POSITIVE_SHIPPING_RE.test(clauseText);
        // "blocked, so no price, shipping or delivery": a bare shipping word after a disclaimer is part of the disclaimer.
        const carried = earlierNegated && !positive;
        if (clauseNegated) earlierNegated = true;
        if (clauseNegated || carried) continue;
        const dm = DETAIL_RE.exec(clauseText);
        if (!dm) continue;
        // "Shipping (not stated)": a bare shipping word whose next clause disclaims it says nothing.
        const following = clauses[ci + 1];
        if (following && NEGATION_RE.test(cellText.slice(following.start, following.end)) && !positive) continue;
        const at = clause.start + dm.index;
        claims.push(make('detail', detailRaw(cellText, at, dm[0].length), cell.start + at, cell.start + at + dm[0].length, {}));
        found = true;
      }
      // A cell under a shipping or delivery header with no shipping word of its own: "Free", "DHL", "Abholung" state
      // something, "blocked" and "Access denied (403)" do not.
      if (!found && SHIPPING_HEADER_RE.test(cell.header) && !DETAIL_RE.test(cellText) && !NEGATION_RE.test(cellText) && !isTrivialCell(cellText) && scanned.money.length === 0 && scanned.durations.length === 0 && POSITIVE_SHIPPING_RE.test(cellText)) {
        claims.push(make('detail', cutAtWord(stripMarkdown(cellText), DETAIL_MAX), cell.start, cell.end, {}));
      }
    });

    for (const site of seg.mentions) {
      if (!site.isUrl) continue;
      claims.push({ kind: 'url', raw: site.raw, scope: [site.host], pos: seg.offset + site.start, seg: segIndex, local: true, near: [site.host], line: seg.offset, url: site });
    }
  });
  return claims;
}

// ---------------------------------------------------------------------------------------------
// The goal
// ---------------------------------------------------------------------------------------------

interface GoalFacts {
  /** amountKey of every amount the goal mentions (either reading of an ambiguous one). */
  money: Set<number>;
  percents: number[];
  durations: Set<string>;
  /** Normalized links in the goal. */
  urls: Set<string>;
  hosts: string[];
  /** Amounts of the goal in the usual reading, for derivations. */
  amounts: number[];
}

function goalFacts(goal: string): GoalFacts {
  const text = normalizeSpaces(goal.length > 20_000 ? goal.slice(0, 20_000) : goal);
  const scanned = scanNumbers(maskLinks(text));
  const facts: GoalFacts = { money: new Set(), percents: [], durations: new Set(), urls: new Set(), hosts: planHosts(text), amounts: [] };
  for (const t of scanned.money) {
    for (const v of t.values) facts.money.add(amountKey(v));
    facts.amounts.push(t.values[0] ?? 0);
  }
  for (const t of scanned.percents) facts.percents.push(t.value);
  for (const t of scanned.durations) facts.durations.add(`${t.low}|${t.high}|${t.unit}`);
  for (const site of scanSites(text)) if (site.isUrl) facts.urls.add(normalizeUrlForMatch(site.raw));
  return facts;
}

// ---------------------------------------------------------------------------------------------
// Matching claims to pages
// ---------------------------------------------------------------------------------------------

interface Pool {
  amounts: AmountRef[];
  byKey: Map<number, AmountRef>;
  percents: PercentRef[];
  durations: DurationRef[];
}

/**
 * An amount on a page can ground a claim when it is a price: a currency or a price word stands beside it, or it is
 * written to the cent ("2.049,00"). A bare "1.399" (reviews), "5000" (mAh) or "10115" (a postal code) is a number that
 * looks like a price and is not one, so it must not make "EUR 1,399" true.
 */
function canGround(a: AmountRef): boolean {
  return a.priced || a.decimals >= 2;
}

function makePool(amounts: AmountRef[], percents: PercentRef[], durations: DurationRef[]): Pool {
  const usable = amounts.filter(canGround);
  const byKey = new Map<number, AmountRef>();
  for (const a of usable) for (const k of a.keys) if (!byKey.has(k)) byKey.set(k, a);
  return { amounts: usable, byKey, percents, durations };
}

/** Floating point slack, so 2189 + 4.99 is 2193.99 to the cent and a difference of exactly 0.1 points is inside the tolerance. */
const EPS = 1e-9;

/** Half the unit an amount was rounded to: "2,100" is +-50, "2,070" +-5, "2,089" +-0.5, "2,089.50" +-0.005. */
function halfUnit(value: number, decimals: number): number {
  if (decimals > 0) return 0.5 * 10 ** -decimals;
  let n = Math.round(Math.abs(value));
  let unit = 1;
  while (n >= 10 && n % 10 === 0) {
    n /= 10;
    unit *= 10;
  }
  return unit / 2;
}

/**
 * How far an approximate amount ("about EUR 2,100") may be from the amount it stands for: half of the unit its last
 * digits show it was rounded to, and never more than 2% of that amount. "about 2,100" can be 2,069 (a rounding to
 * hundreds); "about 2,089" cannot, because nobody rounds 2,069 to 2,089.
 */
function approxSlack(t: MoneyToken, written: number, actual: number): number {
  return Math.min(halfUnit(written, t.decimals), 0.02 * Math.abs(actual)) + EPS;
}

function matchMoneyAll(pool: Pool, t: MoneyToken): AmountRef[] {
  const out: AmountRef[] = [];
  for (const a of pool.amounts) {
    for (const v of t.values) {
      if (a.keys.includes(amountKey(v)) || (t.approx && a.value > 0 && Math.abs(a.value - v) <= approxSlack(t, v, a.value))) {
        out.push(a);
        break;
      }
    }
  }
  return out;
}

function matchMoney(pool: Pool, t: MoneyToken): AmountRef | null {
  for (const v of t.values) {
    const hit = pool.byKey.get(amountKey(v));
    if (hit) return hit;
  }
  if (t.approx) {
    for (const a of pool.amounts) {
      for (const v of t.values) if (a.value > 0 && Math.abs(a.value - v) <= approxSlack(t, v, a.value)) return a;
    }
  }
  return null;
}

/**
 * How far a written percentage may be from the real one. What is written shows how it was rounded: "6%" is
 * anything from 5.5 to 6.5, "5.8%" only 5.7 to 5.9 (half a unit of the last digit, and never under 0.1 points).
 * An approximation marker allows 0.5 points at least ("about 5.8%" for 5.4), and a whole number with a marker
 * ("about 6%") one point either way.
 */
function percentSlack(t: PercentToken): number {
  const unit = 10 ** -t.decimals;
  return (t.approx ? Math.max(0.5, unit) : Math.max(0.1, unit / 2)) + 0.005;
}

function matchPercentAll(pool: Pool, t: PercentToken): PercentRef[] {
  const slack = percentSlack(t);
  return pool.percents.filter((p) => Math.abs(p.value - t.value) <= slack + EPS || (t.approx && p.value > 0 && Math.abs(p.value - t.value) <= 0.02 * p.value));
}

/** A claim may be less specific than the page, never more: "3-5 days" covers a page's "3-5 Werktage", "3-5 Werktage" does not cover "3-5 days". */
function unitCovers(claim: DurationUnit, page: DurationUnit): boolean {
  return claim === page || (claim === 'day' && page === 'bday');
}

function matchDurationAll(pool: Pool, t: DurationToken, upTo: boolean): DurationRef[] {
  return pool.durations.filter(
    (d) =>
      unitCovers(t.unit, d.unit) &&
      // "within 3 business days" and "up to 3 days" are upper bounds: a page range that ends there supports them.
      ((d.low === t.low && d.high === t.high) || (upTo && t.low === t.high && d.high === t.low))
  );
}

/** The largest number of numbers a derivation looks at: with more, only the first ones count. */
const MAX_DERIVE = 60;
/**
 * Two amounts of one page are "beside each other" (a price and its shipping, a list price and a sale price) when no more
 * than one other amount stands between them and they are at most this many characters apart.
 */
const BESIDE = 150;
const BESIDE_AMOUNTS = 2;

/**
 * A sum or a difference of two prices that belong together: two amounts beside each other on one page (a price and its
 * shipping, a list price and a sale price), the leading price of each of the sites the sentence names (a total of two
 * shops), or two numbers the answer or the task states. Never a mix of numbers from unrelated places: a total for one
 * site cannot be made from another site's price and a third site's shipping, nor from a price of one offer and the
 * shipping of another.
 */
function derivedMoney(refs: readonly AmountRef[], statedBase: readonly number[], t: MoneyToken): boolean {
  const list = refs.slice(0, MAX_DERIVE);
  const leading = new Set<AmountRef>();
  const seenHosts = new Set<string>();
  for (const a of list) {
    if (!seenHosts.has(a.host)) {
      seenHosts.add(a.host);
      leading.add(a);
    }
  }
  const related = (a: AmountRef, b: AmountRef, apart: number): boolean =>
    a.entry === b.entry ? apart <= BESIDE_AMOUNTS && Math.abs(a.pos - b.pos) <= BESIDE : leading.has(a) && leading.has(b);
  for (const c of t.values) {
    const tol = t.approx ? Math.max(0.01, approxSlack(t, c, c)) : 0.01;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!a) continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (!b || !related(a, b, j - i)) continue;
        if (Math.abs(a.value + b.value - c) <= tol + EPS || Math.abs(Math.abs(a.value - b.value) - c) <= tol + EPS) return true;
      }
    }
    const s = statedBase.slice(0, MAX_DERIVE);
    for (let i = 0; i < s.length; i++) {
      const a = s[i] ?? 0;
      for (let j = i + 1; j < s.length; j++) {
        if (Math.abs(Math.abs(a - (s[j] ?? 0)) - c) <= tol + EPS) return true;
      }
    }
  }
  return false;
}

/**
 * A percent difference between two prices, computed both ways (against each of them), to the precision the percentage is
 * written with (see percentSlack). When the sentence states a price itself, one of the two must be that price.
 */
function derivedPercent(base: readonly number[], t: PercentToken, mustInclude: readonly number[]): boolean {
  const slack = percentSlack(t);
  const must = new Set(mustInclude.map((v) => amountKey(v)));
  const g = base.slice(0, MAX_POOL);
  for (let i = 0; i < g.length; i++) {
    const a = g[i] ?? 0;
    for (let j = i + 1; j < g.length; j++) {
      const b = g[j] ?? 0;
      if (must.size > 0 && !must.has(amountKey(a)) && !must.has(amountKey(b))) continue;
      const diff = Math.abs(a - b);
      if (a > 0 && Math.abs((diff / a) * 100 - t.value) <= slack + EPS) return true;
      if (b > 0 && Math.abs((diff / b) * 100 - t.value) <= slack + EPS) return true;
      // A share: "shipping is 0.24% of the price". Only when one amount is at most half of the other, or two similar
      // prices would make every percentage near 100 true.
      const small = Math.min(a, b);
      const large = Math.max(a, b);
      if (small > 0 && small <= large / 2 && Math.abs((small / large) * 100 - t.value) <= slack + EPS) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// The audit
// ---------------------------------------------------------------------------------------------

interface NoteDraft extends AuditNote {
  pos: number;
}

/** Text that goes inside quotes in a note: no markdown, no line breaks, at most `max` characters, cut between words when it is longer ("..." says so). */
function quote(s: string, max = 70): string {
  return cutAtWord(s.replace(/[`*_|<>#[\]\u0000-\u001f]/g, ' ').replace(/"/g, "'").replace(/\s+/g, ' '), max);
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

/**
 * True when `inner` stands in `outer` as a whole: its neighbours are not letters or digits, and not the decimal comma or the
 * thousands dot of a number that goes on ("4,90 EUR" is not in "14,90 EUR", "5 %" is not in "15 %", "4" is not in "4,90").
 * Both are lower case already.
 */
function containsWhole(outer: string, inner: string): boolean {
  if (inner === '') return false;
  for (let at = outer.indexOf(inner); at >= 0; at = outer.indexOf(inner, at + 1)) {
    const end = at + inner.length;
    const left = outer[at - 1];
    const right = outer[end];
    const glued = (side: string | undefined, next: string | undefined, edge: string | undefined): boolean =>
      side !== undefined && (WORD_CHAR.test(side) || ((side === ',' || side === '.' || side === "'") && isDigit(edge) && isDigit(next)));
    if (glued(left, outer[at - 2], inner[0]) || glued(right, outer[end + 1], inner[inner.length - 1])) continue;
    return true;
  }
  return false;
}

/** Drops a claim that is only a piece of another one ("Free" inside "Shipping: Free shipping"), so a note lists each fact once. A number that is part of a longer number is not a piece of it. */
function dedupeContained(claims: readonly string[]): string[] {
  const lower = claims.map((c) => c.toLowerCase());
  return claims.filter((_c, i) => !lower.some((other, j) => j !== i && other.length > (lower[i] ?? '').length && containsWhole(other, lower[i] ?? '')));
}

/** The most characters of claims one note lists. The text of a note is stored with a limit (RECORD_NOTE_CHARS), and a claim is never cut to fit it. */
const LIST_CHARS = 300;

/**
 * The claims of a note as one piece of text: whole claims, separated by semicolons (a comma is the decimal separator of half
 * the world, and "1.329,00 EUR, 4,90 EUR" is hard to read as two prices), at most `max` of them and LIST_CHARS characters,
 * and the number of the ones left out. At least one claim is always shown.
 */
function listClaims(claims: readonly string[], max = 6): string {
  const all = dedupeContained(claims).map((c) => quote(c)).filter((c) => c !== '');
  const shown: string[] = [];
  let chars = 0;
  for (const c of all) {
    if (shown.length >= max || (shown.length > 0 && chars + c.length + 2 > LIST_CHARS)) break;
    shown.push(c);
    chars += c.length + 2;
  }
  const rest = all.length - shown.length;
  return shown.join('; ') + (rest > 0 ? `; and ${rest} more` : '');
}

/** The text with one full stop at its end, and none after the "..." of a cut claim ("... and....") or after a stop that is already there. */
function endSentence(text: string): string {
  return text.endsWith('.') ? text : `${text}.`;
}

function joinAnd(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function coerceLedger(ledger: unknown): EvidenceLedger {
  return ledger instanceof EvidenceLedger ? ledger : EvidenceLedger.fromSnapshot(ledger);
}

/**
 * Audits a final answer. See the header of this file for the rules. Never throws: an internal error
 * returns a "partial" audit with one gap note, so the engine's clamp still ends the run.
 */
export function auditAnswer(input: AuditInput): AnswerAudit {
  try {
    return auditUnsafe(input);
  } catch {
    return {
      verdict: 'partial',
      lies: 0,
      gaps: 1,
      softs: 0,
      notes: [{ code: 'source_unchecked', severity: 'gap', text: 'The answer could not be checked against the pages that were read.' }],
      opened: [],
      notOpened: [],
      grounded: []
    };
  }
}

/** How far from a number a shop's name may stand on a comparison page for the number to be that shop's. */
const SHOP_WINDOW = 200;

/** The one-word name of a site ("notebooksbilliger" for notebooksbilliger.de), for finding it written without its domain. */
function labelPattern(host: string): RegExp | null {
  const label = brandLabelOf(host, 4);
  return label === '' ? null : new RegExp(`(?<![\\p{L}\\p{N}_])${label}(?![\\p{L}\\p{N}_])`, 'iu');
}

function auditUnsafe(input: AuditInput): AnswerAudit {
  const goal = typeof input?.goal === 'string' ? input.goal : '';
  const planTexts = Array.isArray(input?.planTexts) ? input.planTexts.filter((p): p is string => typeof p === 'string') : [];
  const ledger = coerceLedger(input?.ledger);
  const answer = normalizeSpaces(prepareAnswer(input?.answer).replace(/\r\n?/g, '\n'));

  const facts = goalFacts(goal);
  const named = namedSources(goal, planTexts);
  const openedHosts = ledger.openedHosts();
  const isOpened = (host: string): boolean => openedHosts.some((o) => o.host === host);

  const segments = buildSegments(answer, makeScanner(named));
  const claims = collectClaims(segments, facts);

  // Pools: everything read, and per site.
  const allPool = makePool(ledger.amounts(), ledger.percents(), ledger.durations());
  const sitePools = new Map<string, Pool>();
  const poolOf = (hosts: readonly string[]): Pool => {
    if (hosts.length === 1) {
      const only = hosts[0] ?? '';
      let pool = sitePools.get(only);
      if (!pool) {
        pool = makePool(ledger.amounts(only), ledger.percents(only), ledger.durations(only));
        sitePools.set(only, pool);
      }
      return pool;
    }
    return makePool(hosts.flatMap((h) => ledger.amounts(h)), hosts.flatMap((h) => ledger.percents(h)), hosts.flatMap((h) => ledger.durations(h)));
  };
  /** The prices the pages of these sites show (a price, its shipping, an old price), newest page first. */
  const pricesOf = (hosts: readonly string[]): AmountRef[] => poolOf(hosts).amounts.filter((a) => a.priced && a.value > 0);

  const drafts: NoteDraft[] = [];
  const claimedHosts = new Set<string>();
  const grounded: GroundedNumber[] = [];
  const groundedKeys = new Set<string>();
  const addGrounded = (ref: { host: string; url: string; raw: string; entry: number; pos: number }, key: string): void => {
    if (groundedKeys.has(key) || grounded.length >= MAX_GROUNDED) return;
    groundedKeys.add(key);
    grounded.push({ value: ref.raw.trim(), host: ref.host, url: ref.url, snippet: snippetWithWholeWords(ledger.snippetFor(ref, 60), ref.raw.trim()) });
  };

  // Claims for a site that was never opened, gathered per site.
  const unopened = new Map<string, { claims: string[]; seen: Set<string>; pos: number }>();
  const addUnopened = (host: string, raw: string, pos: number): void => {
    let entry = unopened.get(host);
    if (!entry) {
      entry = { claims: [], seen: new Set(), pos };
      unopened.set(host, entry);
    }
    entry.pos = Math.min(entry.pos, pos);
    if (!entry.seen.has(raw)) {
      entry.seen.add(raw);
      entry.claims.push(raw);
    }
    claimedHosts.add(host);
  };

  // Soft notes, per site.
  const softs = new Map<string, { claims: string[]; seen: Set<string>; pos: number }>();
  const addSoft = (host: string, raw: string, pos: number): void => {
    let entry = softs.get(host);
    if (!entry) {
      entry = { claims: [], seen: new Set(), pos };
      softs.set(host, entry);
    }
    if (!entry.seen.has(raw)) {
      entry.seen.add(raw);
      entry.claims.push(raw);
    }
  };

  // A shop that an opened comparison page lists (idealo.de shows notebooksbilliger.de, alternate.de, ...) is a row of that
  // page and not a second source. Its numbers are grounded by the page that shows them next to its name; the shop is not
  // "a site that was never opened" unless it is named in the task.
  const listedCache = new Map<string, boolean>();
  // What the pages name, worked out once however many shops the answer writes about.
  let pageHosts: Set<string> | null = null;
  let allText = '';
  const listedOnPages = (host: string): boolean => {
    if (!pageHosts) {
      pageHosts = new Set();
      const blobs: string[] = [];
      for (let i = 0; i < ledger.entries.length; i++) {
        const blob = ledger.textOf(i);
        blobs.push(blob);
        for (const h of hostsNamedIn(blob)) pageHosts.add(h);
      }
      allText = blobs.join('\n');
    }
    let listed = listedCache.get(host);
    if (listed === undefined) {
      const label = labelPattern(host);
      listed = pageHosts.has(host) || (label !== null && label.test(allText));
      listedCache.set(host, listed);
    }
    return listed;
  };
  const shownNear = (ref: { entry: number; pos: number; raw: string }, host: string): boolean => {
    const blob = ledger.textOf(ref.entry);
    const window = blob.slice(Math.max(0, ref.pos - SHOP_WINDOW), Math.min(blob.length, ref.pos + ref.raw.length + SHOP_WINDOW));
    const label = labelPattern(host);
    return hostsNamedIn(window).includes(host) || (label !== null && label.test(window));
  };

  const judged = new Set<string>();
  /** The claims a page showed, by claim key, with the amount for money (0 for the others). */
  const groundedValues = new Map<string, number>();
  const fabricated = new Set<string>();
  let evaluated = 0;

  // Prices the answer states and the pages show: the base of a percent difference and of the difference of two prices.
  // An invented "15%" cannot pass just because some page, somewhere, shows two prices that happen to differ by 15%.
  const stated: number[] = [];
  const statedKeys = new Set<number>();
  const statedBySeg = new Map<number, number[]>();
  const groundedSegs = new Set<number>();
  const noteStated = (claim: Claim, value: number): void => {
    if (!statedKeys.has(amountKey(value))) {
      statedKeys.add(amountKey(value));
      stated.push(value);
    }
    const list = statedBySeg.get(claim.seg) ?? [];
    list.push(value);
    statedBySeg.set(claim.seg, list);
  };
  /** The newest price of each site the task names and that was opened: "the official store" a percentage is measured against, even when the answer does not print its price. */
  const referencePrices = (): number[] => {
    const out: number[] = [];
    for (const host of named) {
      if (!isOpened(host)) continue;
      const first = poolOf([host]).amounts.find((a) => a.priced && a.value > 0);
      if (first) out.push(first.value);
    }
    return out;
  };
  let percentBase: number[] | null = null;
  const getPercentBase = (): number[] => {
    if (percentBase) return percentBase;
    const list: number[] = [];
    const keys = new Set<number>();
    for (const v of [...stated, ...facts.amounts, ...referencePrices()]) {
      const key = amountKey(v);
      if (v > 0 && !keys.has(key) && list.length < MAX_POOL) {
        keys.add(key);
        list.push(v);
      }
    }
    percentBase = list;
    return list;
  };

  /** The site a claim is filed under: its own scope, or the site of the sentence before when nobody opened that site. */
  const scopeOf = (claim: Claim): string[] => (claim.inherit !== undefined && !isOpened(claim.inherit) ? [claim.inherit] : claim.scope);

  // Failed claims that a sum or a difference may still explain. They wait until every price of the answer is known.
  interface Waiting {
    claim: Claim;
    scope: string[];
    openedScope: string[];
    closedScope: string[];
    label: string;
  }
  const waiting: Waiting[] = [];

  /** A claim for a site that no page of the engine belongs to. */
  const claimForClosed = (host: string, claim: Claim): void => {
    if (!named.includes(host) && listedOnPages(host)) {
      if (claim.kind === 'detail') return;
      const refs: Array<{ host: string; url: string; raw: string; entry: number; pos: number }> =
        claim.kind === 'money' && claim.money ? matchMoneyAll(allPool, claim.money) : claim.kind === 'percent' && claim.percent ? matchPercentAll(allPool, claim.percent) : claim.kind === 'duration' && claim.duration ? matchDurationAll(allPool, claim.duration, claim.upTo === true) : [];
      const hit = refs.find((r) => shownNear(r, host));
      if (hit) {
        addGrounded(hit, `${claim.kind}|${host}|${hit.raw}`);
        groundedSegs.add(claim.seg);
        return;
      }
      drafts.push({
        code: 'number_not_in_evidence',
        severity: 'lie',
        text: `"${quote(claim.raw)}" (written for ${host}) appears on no page the engine read next to ${host}.`,
        claims: [claim.raw],
        host,
        pos: claim.pos
      });
      return;
    }
    addUnopened(host, claim.raw, claim.pos);
  };

  const fail = (w: Waiting, otherHost: string): void => {
    const { claim, closedScope, openedScope, label } = w;
    if (otherHost !== '') {
      drafts.push({
        code: 'number_wrong_source',
        severity: 'lie',
        text: `"${quote(claim.raw)}" is written for ${label}, but no page of ${label} shows it. It only appears on ${otherHost}.`,
        claims: [claim.raw],
        host: openedScope[0],
        otherHost,
        pos: claim.pos
      });
      return;
    }
    if (closedScope.length > 0) {
      for (const h of closedScope) claimForClosed(h, claim);
      return;
    }
    drafts.push({
      code: 'number_not_in_evidence',
      severity: 'lie',
      text: label === '' ? `"${quote(claim.raw)}" appears on no page the engine read.` : `"${quote(claim.raw)}" (written for ${label}) appears on no page the engine read.`,
      claims: [claim.raw],
      host: openedScope[0],
      pos: claim.pos
    });
  };

  const echoes = claims.filter((c) => c.kind !== 'percent' && c.goalEcho === true);
  const percents = claims.filter((c) => c.kind === 'percent');
  const ordered = [...claims.filter((c) => c.kind !== 'percent' && c.goalEcho !== true), ...echoes, ...percents];
  for (const claim of ordered) {
    if (claim.kind === 'url') {
      const url = claim.url;
      if (!url) continue;
      const normalized = normalizeUrlForMatch(url.raw);
      if (fabricated.has(normalized) || judged.has(`url|${normalized}`)) continue;
      judged.add(`url|${normalized}`);
      const site = siteOf(url.raw.toLowerCase().startsWith('www.') ? `https://${url.raw}` : url.raw);
      let genuine: boolean;
      if (hasUserInfo(url.raw)) {
        // "https://www.idealo.de@frame.work/x" shows one site and opens another.
        genuine = false;
      } else if (facts.urls.has(normalized)) {
        genuine = true;
      } else {
        const door = frontDoorHost(url.raw);
        if (door === '') genuine = ledger.wasVisited(url.raw) || ledger.wasShown(url.raw);
        else if (door === site) {
          // The front door of a site names it and no page. For a site that was opened citing it is harmless; for one that was
          // not, it is a mention like a bare domain (the data written for it is still checked).
          if (!isOpened(site)) continue;
          genuine = true;
        } else genuine = ledger.hasHostname(door) || ledger.wasVisited(url.raw) || ledger.wasShown(url.raw);
      }
      if (!genuine) {
        fabricated.add(normalized);
        claimedHosts.add(claim.scope[0] ?? site);
        drafts.push({
          code: 'fabricated_url',
          severity: 'lie',
          text: `A link to ${site || 'an unknown site'} was never opened, and no page the engine read showed it: ${url.raw}`,
          claims: [url.raw],
          host: site,
          pos: claim.pos
        });
      }
      continue;
    }

    const scope = scopeOf(claim);
    // The task's own number is not a claim when it is repeated without a site, or beside a comparing word, or next to a
    // number that a page shows. Given to a site as that site's value ("idealo.de lists it at EUR 1,899") it is checked.
    if (claim.goalEcho === true && (!claim.local || scope.length === 0 || claim.comparing === true || groundedSegs.has(claim.seg))) continue;

    const key =
      claim.kind === 'money'
        ? `m|${amountKey(claim.money?.values[0] ?? 0)}|${scope.join(',')}`
        : claim.kind === 'percent'
          ? `p|${claim.percent?.value ?? 0}|${scope.join(',')}`
          : claim.kind === 'duration'
            ? `d|${claim.duration?.low}|${claim.duration?.high}|${claim.duration?.unit}|${claim.upTo === true}|${scope.join(',')}`
            : `x|${claim.raw.toLowerCase()}|${scope.join(',')}`;
    if (judged.has(key)) {
      // The same number for the same site, written again (in a summary): it was judged once, but its sentence still
      // states it, and a percentage in that sentence is about it.
      if (groundedValues.has(key)) {
        groundedSegs.add(claim.seg);
        const value = groundedValues.get(key);
        if (claim.kind === 'money' && value !== undefined && value > 0) noteStated(claim, value);
      }
      continue;
    }
    judged.add(key);
    if (++evaluated > MAX_CLAIMS) continue;

    const openedScope = scope.filter(isOpened);
    const closedScope = scope.filter((h) => !isOpened(h));

    if (scope.length > 0 && openedScope.length === 0) {
      for (const h of closedScope) claimForClosed(h, claim);
      continue;
    }

    if (claim.kind === 'detail') {
      if (scope.length === 0) {
        if (ledger.size > 0 && !ledger.hasShippingWording()) addSoft('', claim.raw, claim.pos);
      } else if (!openedScope.some((h) => ledger.hasShippingWording(h))) {
        addSoft(openedScope[0] ?? '', claim.raw, claim.pos);
      }
      continue;
    }

    const scopePool = scope.length === 0 ? allPool : poolOf(openedScope);
    const w: Waiting = { claim, scope, openedScope, closedScope, label: openedScope.join(' / ') };
    let otherHost = '';

    if (claim.kind === 'money' && claim.money) {
      const hit = matchMoney(scopePool, claim.money);
      if (hit) {
        noteStated(claim, hit.value);
        groundedSegs.add(claim.seg);
        groundedValues.set(key, hit.value);
        addGrounded(hit, `m|${hit.host}|${hit.keys[0]}`);
        continue;
      }
      const elsewhere = scope.length > 0 ? matchMoney(allPool, claim.money) : null;
      if (elsewhere) otherHost = elsewhere.host;
      else {
        waiting.push(w);
        continue;
      }
    } else if (claim.kind === 'percent' && claim.percent) {
      const hit = matchPercentAll(scopePool, claim.percent)[0];
      if (hit) {
        groundedSegs.add(claim.seg);
        groundedValues.set(key, 0);
        addGrounded(hit, `p|${hit.host}|${hit.value}`);
        continue;
      }
      const elsewhere = scope.length > 0 ? matchPercentAll(allPool, claim.percent)[0] : undefined;
      if (elsewhere) otherHost = elsewhere.host;
      else {
        waiting.push(w);
        continue;
      }
    } else if (claim.kind === 'duration' && claim.duration) {
      const hit = matchDurationAll(scopePool, claim.duration, claim.upTo === true)[0];
      if (hit) {
        groundedSegs.add(claim.seg);
        groundedValues.set(key, 0);
        addGrounded(hit, `d|${hit.host}|${hit.low}|${hit.high}|${hit.unit}`);
        continue;
      }
      const elsewhere = scope.length > 0 ? matchDurationAll(allPool, claim.duration, claim.upTo === true)[0] : undefined;
      if (elsewhere) otherHost = elsewhere.host;
    }
    fail(w, otherHost);
  }

  // The claims that no page shows as they stand: a sum or a difference of numbers that were shown may explain them.
  for (const w of waiting) {
    const { claim } = w;
    if (claim.kind === 'money' && claim.money) {
      // Prices of the site the claim is about and of the sites its own sentence names (a total of two shops), never of every page.
      const hosts = [...new Set([...w.openedScope, ...claim.near.filter(isOpened)])];
      const sites = hosts.length > 0 ? [hosts] : openedHosts.slice(0, 8).map((o) => [o.host]);
      if (sites.some((group) => derivedMoney(pricesOf(group), [...stated, ...facts.amounts, ...referencePrices()], claim.money as MoneyToken))) continue;
    } else if (claim.kind === 'percent' && claim.percent) {
      if (derivedPercent(getPercentBase(), claim.percent, statedBySeg.get(claim.seg) ?? [])) continue;
    }
    fail(w, '');
  }

  // A line (a sentence, a row, an item) that names a site of the task that nobody opened, and states data, gives data for
  // that site, whichever site sits nearest to each number: "idealo.de and geizhals.de show the same price as frame.work:
  // EUR 2,069". Not when the line says the site was not looked at, and not for a site that already has a claim of its
  // own on the line.
  const claimsByLine = new Map<string, Claim[]>();
  for (const claim of claims) {
    if (claim.kind === 'url' || claim.goalEcho === true) continue;
    const key = `${claim.seg}:${claim.line}`;
    const list = claimsByLine.get(key) ?? [];
    list.push(claim);
    claimsByLine.set(key, list);
  }
  for (const list of claimsByLine.values()) {
    const data = list.filter((c) => c.negated !== true);
    if (data.length === 0) continue;
    for (const host of new Set(list.flatMap((c) => c.near))) {
      if (!named.includes(host) || isOpened(host)) continue;
      if (list.some((c) => scopeOf(c).includes(host))) continue;
      for (const c of data) addUnopened(host, c.raw, c.pos);
    }
  }

  for (const [host, entry] of unopened) {
    drafts.push({
      code: 'source_not_opened',
      severity: 'lie',
      text: `${host} was never opened, but the answer gives data for it: ${endSentence(listClaims(entry.claims))}`,
      claims: dedupeContained(entry.claims).slice(0, 12),
      host,
      pos: entry.pos
    });
  }

  // Named sites that were never opened and got no claim: the task is not done for them.
  const gapDrafts: NoteDraft[] = [];
  for (const host of named) {
    if (isOpened(host) || claimedHosts.has(host)) continue;
    gapDrafts.push({
      code: 'source_unchecked',
      severity: 'gap',
      text: `${host} is named in the task, but no page of it was read, so that part of the task is not done.`,
      host,
      pos: 0
    });
  }

  const softDrafts: NoteDraft[] = [];
  for (const [host, entry] of softs) {
    softDrafts.push({
      code: 'unsupported_detail',
      severity: 'soft',
      text:
        host === ''
          ? `Shipping or delivery statement (${listClaims(entry.claims, 3)}): no page the engine read says anything about shipping or delivery.`
          : `${host}: shipping or delivery statement (${listClaims(entry.claims, 3)}), but no page of ${host} says anything about shipping or delivery.`,
      claims: dedupeContained(entry.claims).slice(0, 6),
      host: host === '' ? undefined : host,
      pos: entry.pos
    });
  }

  drafts.sort((a, b) => a.pos - b.pos);
  softDrafts.sort((a, b) => a.pos - b.pos);
  // The audit is stored as JSON (the finish entry, a checkpoint): no key with an undefined value, no ordering helper.
  const strip = (d: NoteDraft): AuditNote => {
    const note: AuditNote = { code: d.code, severity: d.severity, text: d.text };
    if (d.claims !== undefined) note.claims = d.claims;
    if (d.host !== undefined) note.host = d.host;
    if (d.otherHost !== undefined) note.otherHost = d.otherHost;
    return note;
  };
  const notes: AuditNote[] = [...drafts.map(strip), ...gapDrafts.map(strip), ...softDrafts.map(strip)];
  const lies = drafts.length;
  const gaps = gapDrafts.length;
  const softCount = softDrafts.length;

  // Sites that were named, or written about with data, and never opened.
  const notOpened: string[] = [];
  const addNotOpened = (h: string): void => {
    if (h !== '' && !isOpened(h) && !notOpened.includes(h)) notOpened.push(h);
  };
  for (const h of named) addNotOpened(h);
  for (const h of unopened.keys()) addNotOpened(h);
  for (const claim of claims) {
    if (claim.kind === 'url' && claim.url && fabricated.has(normalizeUrlForMatch(claim.url.raw))) addNotOpened(claim.scope[0] ?? '');
  }

  // Fill the grounded list with other prices that pages showed, newest page first.
  for (const a of allPool.amounts) {
    if (grounded.length >= MAX_GROUNDED) break;
    if (a.priced) addGrounded(a, `m|${a.host}|${a.keys[0]}`);
  }

  const result: AnswerAudit = {
    verdict: lies > 0 ? 'unverified' : gaps > 0 ? 'partial' : 'verified',
    lies,
    gaps,
    softs: softCount,
    notes,
    opened: openedHosts.map((o) => ({ host: o.host, url: o.url })),
    notOpened,
    grounded
  };
  return result;
}

// ---------------------------------------------------------------------------------------------
// What the model and the person read
// ---------------------------------------------------------------------------------------------

const LINK_REMOVED = '[link removed: never opened]';

/**
 * One line about a note. For the answer, links are left out: the text goes into the answer, which must not carry them
 * back in. For the model, no number of a source that was never opened is repeated: the model wrote it, and it is not a
 * fact to be copied into the next try.
 */
function describeNote(note: AuditNote, mode: 'model' | 'answer'): string {
  const claims = note.claims ?? [];
  const first = claims[0] ?? '';
  switch (note.code) {
    case 'fabricated_url':
      return mode === 'answer'
        ? `A link to ${note.host || 'an unknown site'} was never opened, so it was removed from this answer.`
        : `This link was never opened, and no page you read showed it: ${first}`;
    case 'source_not_opened':
      return mode === 'model'
        ? `${note.host ?? 'A site'} was never opened, but your answer gives data for it.`
        : `${note.host ?? 'A site'} was never opened, but the answer gives data for it (${listClaims(claims, 4)}).`;
    case 'number_not_in_evidence':
      return `"${quote(first)}" is on no page that was read.`;
    case 'number_wrong_source':
      return `"${quote(first)}" is written for ${note.host ?? 'a site'}, but no page of ${note.host ?? 'that site'} shows it (only ${note.otherHost ?? 'another site'} does).`;
    case 'source_unchecked':
      return `${note.host ?? 'A site'} was not opened yet, so its part of the task is not done.`;
    case 'unsupported_detail':
      return `${note.host ? `${note.host}: ` : ''}a shipping or delivery statement (${listClaims(claims, 3)}) has no support on the pages read.`;
    default:
      return note.text;
  }
}

/**
 * The message the model sees when its finish is refused. Short, for a small model: what was wrong in
 * numbered lines (the made-up links in full, so it knows which ones to drop), then what to do. It names no value
 * and no example answer, so there is nothing in it to copy into the next try.
 */
export function formatSendBack(audit: AnswerAudit): string {
  try {
    return formatSendBackUnsafe(audit);
  } catch {
    return 'Your finish was refused: the answer could not be checked against the pages you read. Open the sites the task names and read what the task asks for there, and never write a link or a number you did not see on a page. If a site blocks you, write "not checked" for it.';
  }
}

function formatSendBackUnsafe(audit: AnswerAudit): string {
  const problems = (audit?.notes ?? []).filter((n) => n.severity === 'lie' || n.severity === 'gap');
  const lines: string[] = [];
  // One sentence: the side panel shows it as the reason on the "Finish not accepted" row.
  lines.push(audit && audit.lies > 0 ? 'Your finish was refused because your answer says things that no page you read shows:' : 'Your finish was refused because part of the task is not done yet:');
  problems.slice(0, 8).forEach((n, i) => lines.push(`${i + 1}. ${describeNote(n, 'model')}`));
  if (problems.length > 8) lines.push(`(${problems.length - 8} more problems)`);
  lines.push('What to do now:');
  const notOpened = audit?.notOpened ?? [];
  if (notOpened.length > 0) {
    lines.push(`- Open ${joinAnd(notOpened.slice(0, 4))} and read what the task asks for there. Then finish again.`);
    lines.push('- If a site blocks you or you cannot open it, finish and write "not checked" for that site, with no numbers for it.');
  } else {
    lines.push('- Remove or correct every number and link listed above, using only what the pages you read show. Then finish again.');
  }
  lines.push('- Never write a link you did not open. Never write a number you did not see on a page.');
  return lines.join('\n');
}

const SECTION_TITLE = 'Verification notes (written by ScoutFox, not by the model)';

function removeLinks(text: string, bad: ReadonlySet<string>): string {
  // The links to cut, overlapping ones merged into one, so a replacement never lands on text another one already moved.
  const found = scanSites(text)
    .filter((s) => s.isUrl && bad.has(normalizeUrlForMatch(s.raw)))
    .sort((a, b) => a.start - b.start);
  const spans: Array<{ start: number; end: number }> = [];
  for (const s of found) {
    const last = spans[spans.length - 1];
    if (last && s.start < last.end) last.end = Math.max(last.end, s.end);
    else spans.push({ start: s.start, end: s.end });
  }
  spans.reverse();
  let out = text;
  let fence = Number.POSITIVE_INFINITY;
  for (const s of spans) {
    if (s.start >= fence) continue;
    let from = s.start;
    let to = s.end;
    let replacement = LINK_REMOVED;
    if (out[from - 1] === '<' && out[to] === '>') {
      from -= 1;
      to += 1;
    } else if (out[from - 1] === '(' && out[from - 2] === ']' && out[to] === ')') {
      const open = out.lastIndexOf('[', from - 2);
      if (open >= 0 && from - open < 400 && !out.slice(open, from).includes('\n')) {
        const label = removeLinks(out.slice(open + 1, from - 2), bad).trim();
        replacement = label === '' || label === LINK_REMOVED ? LINK_REMOVED : `${label} ${LINK_REMOVED}`;
        // The link text now stands where the link was. After a link address it must not run into it and make a new one.
        if (replacement !== LINK_REMOVED && open > 0 && /[^\s(\[{<"'*_>]/.test(out[open - 1] ?? '')) replacement = ` ${replacement}`;
        from = open;
        to += 1;
        fence = open;
      }
    }
    out = out.slice(0, from) + replacement + out.slice(to);
  }
  return out;
}

/** The one line written at the very top of an answer that was annotated. Code wrote it, and the panel knows it. */
export const BANNER_UNVERIFIED = 'WARNING - UNVERIFIED ANSWER: parts of this answer are not backed by any page ScoutFox read. See the notes at the end.';
export const BANNER_PARTIAL = 'PARTIAL ANSWER: not every source was checked. See the notes at the end.';
const MODEL_WROTE = 'Model wrote: ';

/** Takes a banner (ours, from an earlier pass) off the top of a text, so that annotating twice does not stack two. */
function withoutBanner(text: string): string {
  let out = text;
  for (let i = 0; i < 3; i++) {
    const lead = out.replace(/^\s+/, '');
    const banner = [BANNER_UNVERIFIED, BANNER_PARTIAL].find((b) => lead.startsWith(b));
    if (!banner) break;
    out = lead.slice(banner.length).replace(/^\s+/, '');
  }
  return out;
}

/**
 * A line of the model that carries the title of our section, or that is one of our banners, would pass for the code's
 * own words next to the real ones. It is kept, marked as the model's ("Model wrote: ..."), and never cut: the words
 * after it are the model's too.
 */
function neutralizeImpersonation(text: string): string {
  const key = SECTION_TITLE.toLowerCase();
  return text
    .split('\n')
    .map((line) => {
      if (line.startsWith(MODEL_WROTE)) return line;
      const plain = line.replace(/[*_`#>\s]+/g, ' ').trim().toLowerCase();
      return plain.includes(key) || line.trim() === BANNER_UNVERIFIED || line.trim() === BANNER_PARTIAL ? `${MODEL_WROTE}${line}` : line;
    })
    .join('\n');
}

/**
 * The model's answer with every link that was never opened cut out ("[link removed: never opened]";
 * inside a markdown link the link text stays), plus what the code adds: ONE warning line at the very top (before the
 * model's words, so a reader who stops there still knows), and a section at the end with the pages that were really
 * opened, the sites that were not, and one line for each problem. The model's own words stay, so what was real is
 * not thrown away. An answer with no lie and no gap comes back unchanged, and annotating an annotated answer again
 * gives the same text (the banner and the section are replaced, not stacked).
 */
export function annotateAnswer(answer: string, audit: AnswerAudit): string {
  try {
    return annotateUnsafe(answer, audit);
  } catch {
    return typeof answer === 'string' ? answer : '';
  }
}

function annotateUnsafe(answer: string, audit: AnswerAudit): string {
  const text = prepareAnswer(answer);
  const cut = text.indexOf(`\n\n---\n${SECTION_TITLE}`);
  const original = neutralizeImpersonation(withoutBanner(cut >= 0 ? text.slice(0, cut) : text));
  const notes = audit?.notes ?? [];
  const bad = new Set<string>();
  for (const n of notes) if (n.code === 'fabricated_url') for (const c of n.claims ?? []) bad.add(normalizeUrlForMatch(c));
  const cleaned = bad.size > 0 ? removeLinks(original, bad) : original;
  const problems = notes.filter((n) => n.severity === 'lie' || n.severity === 'gap');
  if (problems.length === 0) return cleaned;

  const out: string[] = [audit.verdict === 'unverified' ? BANNER_UNVERIFIED : BANNER_PARTIAL, '', cleaned, '', '---', SECTION_TITLE];
  out.push(
    audit.verdict === 'unverified'
      ? 'Verdict: unverified. Parts of this answer are not backed by any page the engine read.'
      : 'Verdict: partial. Some sites named in the task were not checked.'
  );
  const opened = audit.opened ?? [];
  out.push('Pages actually opened:');
  if (opened.length === 0) out.push('- none');
  for (const o of opened.slice(0, 10)) out.push(`- ${o.host}: ${o.url}`);
  const notOpened = audit.notOpened ?? [];
  out.push(`Sites not opened: ${notOpened.length > 0 ? notOpened.join(', ') : 'none'}`);
  out.push('Problems found:');
  for (const n of problems.slice(0, 12)) out.push(`- ${describeNote(n, 'answer')}`);
  if (problems.length > 12) out.push(`- ...and ${problems.length - 12} more.`);
  return out.join('\n');
}

/**
 * An answer written by code only: the pages that were read, the numbers found on them with their
 * words, and what could not be verified. None of the model's sentences are in it.
 */
export function buildEvidenceReport(audit: AnswerAudit): string {
  try {
    return buildReportUnsafe(audit);
  } catch {
    return 'ScoutFox could not verify the answer the model gave, and could not list what the engine read.';
  }
}

function buildReportUnsafe(audit: AnswerAudit): string {
  const out: string[] = ['ScoutFox could not verify the answer the model gave, so this report lists only what the engine read itself.', ''];
  out.push('Pages read:');
  const opened = audit?.opened ?? [];
  if (opened.length === 0) out.push('- none');
  for (const o of opened.slice(0, 10)) out.push(`- ${o.host}: ${o.url}`);
  out.push('');
  out.push('Numbers found on those pages:');
  const grounded = audit?.grounded ?? [];
  if (grounded.length === 0) out.push('- none');
  for (const g of grounded.slice(0, MAX_GROUNDED)) out.push(`- ${quote(g.value)} on ${g.host} (${g.url}): "${quote(g.snippet, 160)}"`);
  out.push('');
  out.push('Not verified:');
  const notOpened = audit?.notOpened ?? [];
  for (const h of notOpened.slice(0, 10)) out.push(`- ${h} was never opened, so nothing is reported for it.`);
  const lies = audit?.lies ?? 0;
  if (lies > 0) out.push(lies === 1 ? "- 1 statement in the model's answer is not backed by any page that was read, and is left out." : `- ${lies} statements in the model's answer are not backed by any page that was read, and are left out.`);
  if (notOpened.length === 0 && lies === 0) out.push('- nothing else');
  return out.join('\n');
}

const PROMPT_RULE_OPEN = "Before you finish, open every site under 'Not opened yet'. Write 'not checked' only for a site that blocked you or did not load.";
const PROMPT_RULE_PLAIN = 'Only write facts, prices and links that appear on pages you have read.';
const PROMPT_LIMIT = 600;
const PROMPT_PAGES = 6;
const PROMPT_URL_CHARS = 90;

/**
 * A link for the step message, at most PROMPT_URL_CHARS long and marked with "..." when it was cut. It is never cut inside a
 * number: "...?min=1.3..." would read as a value of 1.3 where the page says 1.329,00, so the whole number goes instead.
 */
function shortUrl(url: string): string {
  if (url.length <= PROMPT_URL_CHARS) return url;
  let end = PROMPT_URL_CHARS - 3;
  const joins = (at: number): boolean => isDigit(url[at - 1]) && (isDigit(url[at]) || ((url[at] === ',' || url[at] === '.') && isDigit(url[at + 1])));
  const joinsAfterSeparator = (at: number): boolean => (url[at - 1] === ',' || url[at - 1] === '.') && isDigit(url[at - 2]) && isDigit(url[at]);
  if (joins(end) || joinsAfterSeparator(end)) {
    while (end > 0 && (isDigit(url[end - 1]) || ((url[end - 1] === ',' || url[end - 1] === '.') && isDigit(url[end - 2])))) end--;
  }
  return `${url.slice(0, end)}...`;
}

/**
 * The small block of the step message: which sites the model has really read (newest first, at most six, with the page
 * that showed a price when that is not the page read last) and, only when there are some, which named sites it has not
 * opened yet, then one rule. Under 600 characters. An empty string when there is nothing to say (no site named,
 * nothing read).
 */
export function describeEvidenceForPrompt(ledger: EvidenceLedger, namedSources: readonly string[]): string {
  try {
    return describeUnsafe(ledger, namedSources);
  } catch {
    return '';
  }
}

interface ReadSite {
  host: string;
  /** The page read last on the site. */
  url: string;
  /** The newest page of the site that showed a price. */
  priceUrl: string;
}

function describeUnsafe(ledger: EvidenceLedger, namedSources: readonly string[]): string {
  const led = coerceLedger(ledger);
  const read: ReadSite[] = led
    .openedHosts()
    .map((o, order) => ({ o, order }))
    .sort((a, b) => b.o.lastStep - a.o.lastStep || b.order - a.order)
    .slice(0, PROMPT_PAGES)
    .map(({ o }) => ({ host: o.host, url: o.url, priceUrl: led.amounts(o.host).find((a) => a.priced)?.url ?? '' }));
  const named: string[] = [];
  for (const s of Array.isArray(namedSources) ? namedSources : []) {
    if (typeof s !== 'string') continue;
    let hosts = hostsNamedIn(s);
    if (hosts.length === 0 && looksLikeDomain(s.trim())) hosts = [registrableHost(s.trim())];
    for (const h of hosts) if (!named.includes(h)) named.push(h);
  }
  const notOpened = named.filter((h) => !led.hasOpened(h));
  if (read.length === 0 && notOpened.length === 0) return '';

  // "frame.work (prices on <config page>; latest page <details page>)": the price is cited from the page that shows it.
  const pageText = (p: ReadSite, detail: boolean): string => {
    if (p.priceUrl === '' || normalizeUrlForMatch(p.priceUrl) === normalizeUrlForMatch(p.url)) return `${p.host} (${shortUrl(p.url)})`;
    return detail ? `${p.host} (prices on ${shortUrl(p.priceUrl)}; latest page ${shortUrl(p.url)})` : `${p.host} (prices on ${shortUrl(p.priceUrl)})`;
  };
  const build = (pages: number, hostsShown: number, detail: boolean): string => {
    const lines: string[] = [];
    if (pages > 0) lines.push(`Pages you have read: ${read.slice(0, pages).map((p) => pageText(p, detail)).join(', ')}`);
    if (hostsShown > 0) {
      const more = notOpened.length > hostsShown ? ` and ${notOpened.length - hostsShown} more` : '';
      lines.push(`Not opened yet: ${notOpened.slice(0, hostsShown).join(', ')}${more}`);
    }
    lines.push(notOpened.length > 0 ? PROMPT_RULE_OPEN : PROMPT_RULE_PLAIN);
    return lines.join('\n');
  };
  let pages = read.length;
  let hostsShown = Math.min(notOpened.length, 8);
  let detail = true;
  let block = build(pages, hostsShown, detail);
  if (block.length > PROMPT_LIMIT) {
    detail = false;
    block = build(pages, hostsShown, detail);
  }
  while (block.length > PROMPT_LIMIT && pages > 1) {
    pages--;
    block = build(pages, hostsShown, detail);
  }
  while (block.length > PROMPT_LIMIT && hostsShown > 1) {
    hostsShown--;
    block = build(pages, hostsShown, detail);
  }
  if (block.length > PROMPT_LIMIT) block = build(pages > 0 ? 1 : 0, hostsShown, detail);
  return block.length > PROMPT_LIMIT ? block.slice(0, PROMPT_LIMIT) : block;
}
