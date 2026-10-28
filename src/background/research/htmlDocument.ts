// src/background/research/htmlDocument.ts
// HTML to a document tree, the way a browser parses it. The only file that imports parse5 (the
// WHATWG reference parser, also used by jsdom), so the dependency stays behind one small API.
//
// A regex cannot tell where a tag ends: a `>` inside a quoted attribute (`data-action="click->a#b"`),
// a `<!--` inside an attribute or a `</div>` inside a script string all depend on tokenizer state.
// parse5 runs the spec's tokenizer and tree builder, so the tree is the one Chrome would build.
//
// Depth cap: the tree builder checks the stack of open elements for many start tags, so its time
// grows with the square of the nesting depth (20,000 nested divs take over a second, and a lone
// `<div>` costs five bytes of a 2 MB body). Before parsing, one linear pass with parse5's own
// tokenizer finds the start tags that would open deeper than MAX_DEPTH and takes them (and their end
// tags) out of the source, the way Blink caps its tree depth. A page under the cap is parsed as it is.
//
// Pure, no chrome APIs.
import { parse, Tokenizer, TokenizerMode, html, type DefaultTreeAdapterTypes, type Token } from 'parse5';

export type HtmlNode = DefaultTreeAdapterTypes.Node;
export type HtmlElement = DefaultTreeAdapterTypes.Element;
export type HtmlDocument = DefaultTreeAdapterTypes.Document;

/** How deep elements may nest. Blink uses 512 for the same reason. */
export const MAX_DEPTH = 512;

const $ = html.TAG_ID;

/** Elements that never have content, so they never add depth. */
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr', 'image', 'keygen', 'param', 'basefont', 'bgsound', 'frame']);

// Scope boundaries the tree builder does not look past when a start tag closes an open element.
const BASE_SCOPE = ['html', 'table', 'td', 'th', 'caption', 'template', 'marquee', 'object', 'applet', 'button'];

/**
 * Start tags that close an open element on their own (a new `<li>` ends the open `<li>`, a `<div>`
 * ends an open `<p>`): which names they close, and the elements a search for them stops at. Without
 * this, a page of 600 `<p>` or `<li>` with no end tags would look 600 levels deep.
 */
const IMPLIED_CLOSE = new Map<string, { closes: Set<string>; until: Set<string> }>();
function implies(names: string[], closes: string[], until: string[]) {
  for (const name of names) IMPLIED_CLOSE.set(name, { closes: new Set(closes), until: new Set([...BASE_SCOPE, ...until]) });
}
implies(['address', 'article', 'aside', 'blockquote', 'center', 'details', 'dialog', 'dir', 'div', 'dl', 'fieldset',
  'figcaption', 'figure', 'footer', 'header', 'hgroup', 'main', 'menu', 'nav', 'ol', 'p', 'search', 'section', 'summary',
  'ul', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'listing', 'form', 'table', 'xmp', 'plaintext'], ['p'], []);
implies(['li'], ['li', 'p'], ['ul', 'ol']);
implies(['dt', 'dd'], ['dt', 'dd', 'p'], ['dl']);
implies(['option'], ['option'], ['select', 'datalist']);
implies(['optgroup'], ['option', 'optgroup'], ['select', 'datalist']);
implies(['tr'], ['tr', 'td', 'th'], ['tbody', 'thead', 'tfoot']);
implies(['td', 'th'], ['td', 'th'], ['tr']);
implies(['thead', 'tbody', 'tfoot'], ['thead', 'tbody', 'tfoot', 'tr', 'td', 'th'], []);
implies(['rb', 'rt', 'rp', 'rtc'], ['rb', 'rt', 'rp', 'rtc'], ['ruby']);

/** The tokenizer state a start tag switches to, as the tree builder does it (HTML namespace only). */
function textModeOf(tagID: number): number | null {
  switch (tagID) {
    case $.TEXTAREA:
    case $.TITLE:
      return TokenizerMode.RCDATA;
    case $.PLAINTEXT:
      return TokenizerMode.PLAINTEXT;
    case $.SCRIPT:
      return TokenizerMode.SCRIPT_DATA;
    case $.STYLE:
    case $.IFRAME:
    case $.XMP:
    case $.NOEMBED:
    case $.NOFRAMES:
    case $.NOSCRIPT:
      return TokenizerMode.RAWTEXT;
    default:
      return null;
  }
}

/** How far back an implied close looks (a stray `<p>` under hundreds of spans is not worth a deep search). */
const IMPLIED_SEARCH = 64;

/** A stack of open element names with a count per name, so "is one open?" costs nothing. */
class OpenStack {
  readonly names: string[] = [];
  private readonly counts = new Map<string, number>();
  get size(): number {
    return this.names.length;
  }
  has(name: string): boolean {
    return (this.counts.get(name) ?? 0) > 0;
  }
  push(name: string): void {
    this.names.push(name);
    this.counts.set(name, (this.counts.get(name) ?? 0) + 1);
  }
  /** Pops the elements from index i to the top. */
  popFrom(i: number): void {
    while (this.names.length > i) {
      const name = this.names.pop() as string;
      this.counts.set(name, (this.counts.get(name) as number) - 1);
    }
  }
  /** The index of the nearest open element of that name; -1 when none is open. */
  nearest(name: string): number {
    if (!this.has(name)) return -1;
    let i = this.names.length - 1;
    while (this.names[i] !== name) i--;
    return i;
  }
}

/**
 * The [start, end) source ranges of the tags to take out so no element nests deeper than maxDepth,
 * found in one linear tokenizer pass. Empty for a page under the cap.
 *
 * It follows the tree builder only as far as depth needs: an end tag closes the nearest open element
 * of its name, and the start tags in IMPLIED_CLOSE close what they close. The elements opened past
 * the cap ("flat") always sit on top of the others, so they are kept on their own stack, and every
 * search is either bounded or pops what it walks over: the pass stays linear on any input.
 */
export function overDepthRanges(source: string, maxDepth = MAX_DEPTH): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const real = new OpenStack();
  const flat = new OpenStack();
  // Inside <svg> or <math> the tokenizer reads CDATA and does not switch to raw text for <style>.
  let foreign = 0;
  const cutTag = (token: Token.TagToken) => {
    if (token.location) ranges.push([token.location.startOffset, token.location.endOffset]);
  };
  const tokenizer: Tokenizer = new Tokenizer({ sourceCodeLocationInfo: true }, {
    onStartTag(token: Token.TagToken) {
      const name = token.tagName;
      if (name === 'svg' || name === 'math') foreign++;
      tokenizer.inForeignNode = foreign > 0;
      if (!foreign) {
        const mode = textModeOf(token.tagID);
        if (mode !== null) tokenizer.state = mode as typeof tokenizer.state;
      }
      if (token.selfClosing && foreign) return;
      if (VOID.has(name)) return;
      const implied = foreign ? undefined : IMPLIED_CLOSE.get(name);
      if (implied && flat.size) {
        if (implied.closes.has(flat.names[flat.size - 1])) flat.popFrom(flat.size - 1);
      } else if (implied && [...implied.closes].some((n) => real.has(n))) {
        const stop = Math.max(0, real.size - IMPLIED_SEARCH);
        for (let i = real.size - 1; i >= stop; i--) {
          const open = real.names[i];
          if (implied.closes.has(open)) {
            real.popFrom(i);
            break;
          }
          if (implied.until.has(open)) break;
        }
      }
      if (flat.size || real.size >= maxDepth) {
        cutTag(token);
        flat.push(name);
      } else {
        real.push(name);
      }
    },
    onEndTag(token: Token.TagToken) {
      const name = token.tagName;
      if ((name === 'svg' || name === 'math') && foreign) foreign--;
      tokenizer.inForeignNode = foreign > 0;
      // The nearest open element of that name, as the tree builder closes it; a stray end tag closes none.
      const f = flat.nearest(name);
      if (f >= 0) {
        cutTag(token);
        flat.popFrom(f);
        return;
      }
      const r = real.nearest(name);
      if (r < 0) return;
      flat.popFrom(0);
      real.popFrom(r);
    },
    onComment() {},
    onDoctype() {},
    onEof() {},
    onCharacter() {},
    onNullCharacter() {},
    onWhitespaceCharacter() {}
  });
  tokenizer.write(source, true);
  return ranges;
}

/** The source without the given ranges (in order, not overlapping). */
function cut(source: string, ranges: Array<[number, number]>): string {
  if (!ranges.length) return source;
  ranges.sort((a, b) => a[0] - b[0]);
  const parts: string[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    parts.push(source.slice(at, start), ' ');
    at = end;
  }
  parts.push(source.slice(at));
  return parts.join('');
}

/**
 * The document tree of an HTML source, as Chrome builds it with scripting on (so `<noscript>` is
 * raw text), with nesting capped at MAX_DEPTH.
 *
 * Known gap: parse5 8 has no declarative shadow DOM, so the content of
 * `<template shadowrootmode="open">` stays in the template and is not read as page text.
 */
export function parseHtml(source: string): HtmlDocument {
  const text = String(source || '');
  return parse(cut(text, overDepthRanges(text)), { scriptingEnabled: true });
}

/** The child nodes of a node (a template's content fragment for <template>), or none. */
export function childrenOf(node: HtmlNode): HtmlNode[] {
  return 'childNodes' in node ? (node.childNodes as HtmlNode[]) : [];
}

export function isElement(node: HtmlNode): node is HtmlElement {
  return 'tagName' in node;
}

export function isText(node: HtmlNode): node is DefaultTreeAdapterTypes.TextNode {
  return node.nodeName === '#text';
}
