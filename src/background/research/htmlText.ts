// src/background/research/htmlText.ts
// HTML to readable text for fetch_url. The service worker has no DOMParser, so the page is parsed
// the way a browser parses it (htmlDocument.ts, the WHATWG parser) and the tree is walked once: what
// a person would read on the page, one block per line, with the noise (scripts, styles, the head,
// inline SVG) left out. A `>` inside an attribute, a `<!--` inside an attribute or a `</div>` inside a
// script string is markup to the parser, never text.
//
// Pure, no chrome APIs. The text it returns goes through the same paging as a page read
// (shared/textPaging.ts), so a long document comes in parts the same way.
import { collapseRepeatedRuns, normalizePageText } from '../../shared/textPaging.ts';
import { childrenOf, isElement, isText, parseHtml, type HtmlNode } from './htmlDocument.ts';

const HTML_NS = 'http://www.w3.org/1999/xhtml';

/** Elements whose whole content is left out: code, styling, metadata and pictures, never prose. */
const DROPPED = new Set(['script', 'style', 'noscript', 'svg', 'head', 'template', 'iframe', 'object', 'canvas', 'math']);

/** Elements that start a new line: block-level boxes and line breaks. */
const BLOCKS = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'dd', 'details', 'dialog', 'div', 'dl', 'dt', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main',
  'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'thead', 'tfoot', 'tr', 'ul', 'caption', 'option',
  'textarea', 'listing'
]);

/** Table cells: kept apart on their row, the way a page read shows them (" | "). */
const CELLS = new Set(['td', 'th']);

/** Elements whose source line breaks are kept (a command, a code sample, a text field). */
const PREFORMATTED = new Set(['pre', 'textarea', 'listing']);

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™', hellip: '…',
  mdash: '-', ndash: '-', minus: '-', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
  middot: '·', bull: '•', times: '×', euro: '€', pound: '£', yen: '¥', cent: '¢', deg: '°', para: '¶', sect: '§',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓', check: '✓', zwj: '', zwnj: '', shy: '', thinsp: ' ', ensp: ' ', emsp: ' '
};

/**
 * Decodes the character references of a text: named ones from a short list, and every numeric one.
 * For text that was cut out of HTML without a parser (search.ts reads result snippets this way).
 */
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

/**
 * Characters a model and the query filter read better plainly: invisible ones (soft hyphen, zero
 * width space and joiners, BOM) go, so "Eiffel­Tower" matches "Eiffel"; dashes become "-" and
 * typographic spaces a space, the same as decodeEntities does for their named references.
 */
function plainChars(text: string): string {
  return text.replace(/[­​-‍⁠﻿]/g, '').replace(/[–—−]/g, '-').replace(/[   ]/g, ' ');
}

// Marks that survive the whitespace collapse: a block break, a table cell, a line break inside <pre>.
const BLOCK_MARK = '\u0001';
const CELL_MARK = '\u0002';
const PRE_BREAK = '\u0003';

/** The title and the readable text of an HTML document. */
export interface HtmlRead {
  /** The document title, decoded and on one line, or '' when it has none. */
  title: string;
  /** One block per line, whitespace collapsed, repeated runs summarised (the helpers a page read uses). */
  text: string;
}

/**
 * Parses the document once and walks the tree once. The walk is iterative, so a deeply nested page
 * cannot overflow the stack. Dropped subtrees are still walked silently, only to find the title
 * (which sits in the dropped <head>).
 */
export function readHtml(html: string): HtmlRead {
  const doc = parseHtml(String(html || '').replace(/[\u0001-\u0003]/g, ' '));
  const out: string[] = [];
  let title: string | null = null;
  let silent = 0;
  let pre = 0;
  // An entry is a node to enter, or the element to leave (marked by `leave`).
  const todo: Array<{ node: HtmlNode; leave: boolean }> = [{ node: doc, leave: false }];
  while (todo.length) {
    const { node, leave } = todo.pop() as { node: HtmlNode; leave: boolean };
    if (isText(node)) {
      if (!silent) out.push(pre ? node.value.replace(/\r?\n|\r/g, PRE_BREAK) : node.value);
      continue;
    }
    if (!isElement(node)) {
      for (let i = childrenOf(node).length - 1; i >= 0; i--) todo.push({ node: childrenOf(node)[i], leave: false });
      continue;
    }
    const tag = node.tagName;
    const htmlNs = node.namespaceURI === HTML_NS;
    const dropped = DROPPED.has(tag);
    if (leave) {
      if (dropped) silent--;
      else if (htmlNs) {
        if (PREFORMATTED.has(tag)) pre--;
        if (BLOCKS.has(tag)) out.push(BLOCK_MARK);
        else if (CELLS.has(tag)) out.push(CELL_MARK);
      }
      continue;
    }
    if (tag === 'title' && htmlNs && title === null) {
      title = childrenOf(node).map((c) => (isText(c) ? c.value : '')).join('');
    }
    if (dropped) silent++;
    else if (htmlNs) {
      if (PREFORMATTED.has(tag)) pre++;
      if (BLOCKS.has(tag)) out.push(BLOCK_MARK);
      else if (CELLS.has(tag)) out.push(CELL_MARK);
    }
    todo.push({ node, leave: true });
    const children = childrenOf(node);
    for (let i = children.length - 1; i >= 0; i--) todo.push({ node: children[i], leave: false });
  }
  // Source whitespace is one space in HTML; only the marks above start a line or a cell.
  const text = plainChars(out.join(''))
    .replace(/\s+/g, ' ')
    .replace(new RegExp(BLOCK_MARK, 'g'), '\n')
    .replace(new RegExp(PRE_BREAK, 'g'), '\n')
    .replace(new RegExp(CELL_MARK, 'g'), '\t');
  return {
    title: plainChars(title ?? '').replace(/\s+/g, ' ').trim(),
    text: collapseRepeatedRuns(normalizePageText(text))
  };
}

/** The readable text of an HTML document (see readHtml). */
export function htmlToText(html: string): string {
  return readHtml(html).text;
}

/** The title of an HTML document, decoded and on one line, or '' when it has none (see readHtml). */
export function htmlTitle(html: string): string {
  return readHtml(html).title;
}
