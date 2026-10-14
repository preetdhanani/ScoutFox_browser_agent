/**
 * fakeElementTree - a tiny element tree with the parts of the DOM the page text extractor reads
 * (src/content/pageText.ts), for Node tests.
 *
 * Build a tree by hand with el() and txt(), or read a fixture page with parseHtml(). Then
 * fakeDocument(body) gives a document the extractor can run on.
 *
 * What it models, the way a browser does it:
 *   - innerText is the rendered text: a hidden element (the `hidden` attribute, or an inline
 *     `display: none`) and everything inside it is left out, a block element starts a new line, an
 *     inline one (span, a, b...) does not. Like a browser, innerText of an element that is itself
 *     hidden is its textContent.
 *   - textContent is all the text under the element, hidden or not.
 *   - getBoundingClientRect() is zero for an element that is hidden or inside a hidden element, and
 *     else the `top` and `height` the element was given (default top 0, height 20), so a test can
 *     place blocks above and below the viewport.
 *   - querySelectorAll / querySelector take a comma list of simple selectors: tag, #id, .class,
 *     [attr] and [attr="value"], and combinations of them without spaces (main.content).
 * What it does not model: CSS from style sheets, ::before/::after text, tables (a cell is inline here; write
 * a tab into the text to get what innerText gives between two cells).
 */

const BLOCK = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BODY', 'DD', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TR', 'UL'
]);
const SILENT = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TITLE', 'HEAD']);
const VOID = new Set(['META', 'LINK', 'BR', 'HR', 'IMG', 'INPUT', 'SOURCE', 'WBR']);

export interface FakeText {
  nodeType: 3;
  textContent: string;
  parentElement: FakeElement | null;
}

export interface ElementOptions {
  /** Attributes: id, class, role, hidden, style... A `hidden` attribute (any value) or an inline display:none hides the element. */
  attrs?: Record<string, string>;
  /** The top edge in viewport pixels, for getBoundingClientRect(). */
  top?: number;
  height?: number;
}

export class FakeElement {
  nodeType = 1 as const;
  tagName: string;
  attrs: Record<string, string>;
  childNodes: Array<FakeElement | FakeText> = [];
  parentElement: FakeElement | null = null;
  style: Record<string, string> = {};
  private top: number;
  private height: number;

  constructor(tag: string, options: ElementOptions = {}) {
    this.tagName = tag.toUpperCase();
    this.attrs = { ...(options.attrs ?? {}) };
    this.top = options.top ?? 0;
    this.height = options.height ?? 20;
    const inline = /display\s*:\s*none/i.test(this.attrs.style ?? '');
    if (inline) this.style.display = 'none';
  }

  get id(): string {
    return this.attrs.id ?? '';
  }

  get children(): FakeElement[] {
    return this.childNodes.filter((n): n is FakeElement => n.nodeType === 1);
  }

  append(...nodes: Array<FakeElement | FakeText | string>): this {
    for (const node of nodes) {
      const child = typeof node === 'string' ? txt(node) : node;
      child.parentElement = this;
      this.childNodes.push(child);
    }
    return this;
  }

  getAttribute(name: string): string | null {
    return name in this.attrs ? this.attrs[name] : null;
  }

  /** Hidden itself: the hidden attribute or display none (set inline or through .style, as the extractor does with its badges). */
  get selfHidden(): boolean {
    return 'hidden' in this.attrs || this.style.display === 'none';
  }

  get rendered(): boolean {
    for (let el: FakeElement | null = this; el; el = el.parentElement) {
      if (el.selfHidden) return false;
    }
    return true;
  }

  get textContent(): string {
    return this.childNodes.map((n) => n.textContent).join('');
  }

  get innerText(): string {
    if (!this.rendered) return this.textContent;
    return renderedText(this)
      .split('\n')
      // A tab stays: it is how innerText separates table cells (written into the text here, as the fake has no tables).
      .map((line) => line.replace(/[^\S\t]+/g, ' ').trim())
      .filter(Boolean)
      .join('\n');
  }

  getBoundingClientRect(): { top: number; bottom: number; left: number; right: number; width: number; height: number } {
    if (!this.rendered) return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
    return { top: this.top, bottom: this.top + this.height, left: 0, right: 100, width: 100, height: this.height };
  }

  querySelectorAll(selector: string): FakeElement[] {
    const alternatives = selector.split(',').map((s) => s.trim()).filter(Boolean).map(parseSelector);
    const out: FakeElement[] = [];
    const walk = (el: FakeElement) => {
      for (const child of el.children) {
        if (alternatives.some((match) => match(child))) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

function renderedText(node: FakeElement | FakeText): string {
  if (node.nodeType === 3) return node.textContent;
  if (node.selfHidden || SILENT.has(node.tagName)) return '';
  if (node.tagName === 'BR') return '\n';
  const inner = node.childNodes.map(renderedText).join('');
  return BLOCK.has(node.tagName) ? `\n${inner}\n` : inner;
}

function parseSelector(simple: string): (el: FakeElement) => boolean {
  const m = simple.match(/^([a-zA-Z][\w-]*)?((?:[#.][\w-]+)*)((?:\[[\w-]+(?:="[^"]*")?\])*)$/);
  if (!m) throw new Error(`fakeElementTree: unsupported selector "${simple}"`);
  const tag = m[1]?.toUpperCase();
  const ids = [...m[2].matchAll(/#([\w-]+)/g)].map((x) => x[1]);
  const classes = [...m[2].matchAll(/\.([\w-]+)/g)].map((x) => x[1]);
  const attrs = [...m[3].matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)].map((x) => ({ name: x[1], value: x[2] }));
  return (el) =>
    (!tag || el.tagName === tag) &&
    ids.every((id) => el.id === id) &&
    classes.every((c) => (el.attrs.class ?? '').split(/\s+/).includes(c)) &&
    attrs.every(({ name, value }) => (value === undefined ? name in el.attrs : el.attrs[name] === value));
}

export function txt(text: string): FakeText {
  return { nodeType: 3, textContent: text, parentElement: null };
}

/** An element with its children: el('main', {}, el('span', {}, 'Price')). */
export function el(tag: string, options: ElementOptions = {}, ...children: Array<FakeElement | FakeText | string>): FakeElement {
  return new FakeElement(tag, options).append(...children);
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&nbsp;': ' ', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };

/** Reads an HTML page into a tree and returns its <body>. Comments are skipped, the head is read but never rendered. */
export function parseHtml(html: string): FakeElement {
  const root = new FakeElement('#root');
  const open: FakeElement[] = [root];
  for (const [, closing, name, rawAttrs, text] of html.matchAll(/<!--[\s\S]*?-->|<!doctype[^>]*>|<(\/?)([a-zA-Z][\w-]*)([^>]*)>|([^<]+)/gi)) {
    const top = open[open.length - 1];
    if (text !== undefined) {
      top.append(text.replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e] ?? e));
      continue;
    }
    if (name === undefined) continue; // a comment or the doctype
    const tag = name.toUpperCase();
    if (closing) {
      const at = open.map((e) => e.tagName).lastIndexOf(tag);
      if (at > 0) open.length = at;
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const [, key, , quoted, bare] of (rawAttrs ?? '').matchAll(/([\w-]+)(\s*=\s*(?:"([^"]*)"|([^\s>"]+)))?/g)) {
      attrs[key.toLowerCase()] = quoted ?? bare ?? '';
    }
    const element = new FakeElement(tag, { attrs });
    top.append(element);
    if (!VOID.has(tag) && !/\/\s*$/.test(rawAttrs ?? '')) open.push(element);
  }
  const body = root.querySelector('body');
  if (!body) throw new Error('fakeElementTree: the page has no <body>');
  return body;
}

/** A document around a body, with what the extractor asks of it. */
export function fakeDocument(body: FakeElement, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Test page',
    contentType: 'text/html',
    body,
    documentElement: { scrollHeight: 2000 },
    querySelector: (s: string) => body.querySelector(s),
    querySelectorAll: (s: string) => body.querySelectorAll(s),
    getElementById: (id: string) => body.querySelector(`#${id}`),
    ...extra
  };
}

/** A window at a scroll position. */
export function fakeWindow({ scrollY = 0, innerHeight = 800, hostname = 'shop.test' } = {}): Record<string, unknown> {
  return { scrollY, innerHeight, innerWidth: 1200, location: { href: `https://${hostname}/`, hostname } };
}
