// src/background/research/htmlText.ts
// A small HTML-to-text tokenizer for fetch_url. The service worker has no DOMParser, and the text
// only has to be readable for a model, not a faithful rendering: what a person would read on the
// page, one block per line, with the noise (scripts, styles, the head, inline SVG) left out.
//
// Pure, no chrome APIs. The text it returns goes through the same paging as a page read
// (shared/textPaging.ts), so a long document comes in parts the same way.
import { collapseRepeatedRuns, normalizePageText } from '../../shared/textPaging.ts';

/** Elements whose whole content is dropped: code, styling, metadata and pictures, never prose. */
const DROPPED = ['script', 'style', 'noscript', 'svg', 'head', 'template', 'iframe', 'object', 'canvas', 'math'];

/** Elements that start a new line: block-level boxes and line breaks. */
const BLOCKS = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'dd', 'details', 'dialog', 'div', 'dl', 'dt', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main',
  'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'thead', 'tfoot', 'tr', 'ul', 'caption', 'option'
]);

/** Table cells: kept apart on their row, the way a page read shows them (" | "). */
const CELLS = new Set(['td', 'th']);

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™', hellip: '…',
  mdash: '-', ndash: '-', minus: '-', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
  middot: '·', bull: '•', times: '×', euro: '€', pound: '£', yen: '¥', cent: '¢', deg: '°', para: '¶', sect: '§',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓', check: '✓', zwj: '', zwnj: '', shy: '', thinsp: ' ', ensp: ' ', emsp: ' '
};

/** Decodes the character references of a text: named ones from a short list, and every numeric one. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);?/gi, (whole, ref: string) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return whole;
      return String.fromCodePoint(code);
    }
    const named = NAMED[ref.toLowerCase()];
    return named !== undefined ? named : whole;
  });
}

/** The title of an HTML document, decoded and on one line, or '' when it has none. */
export function htmlTitle(html: string): string {
  const raw = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1] ?? '';
  return decodeEntities(raw.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

// Marks that survive the whitespace collapse: a block break, a table cell, a line break inside <pre>.
const BLOCK_MARK = '\u0001';
const CELL_MARK = '\u0002';
const PRE_BREAK = '\u0003';

/**
 * The readable text of an HTML document: one block per line, entities decoded, whitespace
 * collapsed, repeated runs summarised (the same helpers a page read uses).
 */
export function htmlToText(html: string): string {
  let s = String(html || '').replace(/[\u0001-\u0003]/g, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ' ');
  s = s.replace(/<![^>]*>/g, ' ');
  for (const tag of DROPPED) {
    s = s.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), ' ');
    // An unclosed one (a broken page) drops to the end, never into the text.
    s = s.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*$`, 'i'), ' ');
  }
  // The line breaks of preformatted text (a command, a code sample) are kept.
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_m, inner: string) => `${BLOCK_MARK}${inner.replace(/\r?\n/g, PRE_BREAK)}${BLOCK_MARK}`);
  s = s.replace(/<\/?([a-z][a-z0-9-]*)\b[^>]*>/gi, (_m, name: string) => {
    const tag = name.toLowerCase();
    if (BLOCKS.has(tag)) return BLOCK_MARK;
    if (CELLS.has(tag)) return CELL_MARK;
    return '';
  });
  // A tag cut off at the end of a truncated document is dropped.
  s = s.replace(/<[a-z/!][^>]*$/i, '');
  // Source whitespace is one space in HTML; only the marks above start a line or a cell.
  s = s.replace(/\s+/g, ' ');
  s = decodeEntities(s)
    .replace(new RegExp(BLOCK_MARK, 'g'), '\n')
    .replace(new RegExp(PRE_BREAK, 'g'), '\n')
    .replace(new RegExp(CELL_MARK, 'g'), '\t');
  return collapseRepeatedRuns(normalizePageText(s));
}
