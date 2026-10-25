/**
 * The screenshot privacy masks in nested places: open shadow roots, iframes nested inside a
 * same-origin iframe, and the iframe's own border and padding.
 *
 * A web component (a payment widget, a login card) keeps its inputs in a shadow root, which
 * document.querySelectorAll does not enter. A cross-origin payment iframe is often wrapped in a
 * same-origin iframe. Both must still be covered, and a cover inside a frame must sit where the
 * field is drawn, which is past the frame's border and padding.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { maskSensitiveFields } from '../../src/content/screenshotPrivacy.ts';

type Rect = { left: number; top: number; width: number; height: number };

interface Node {
  tagName: string;
  id: string;
  className: string;
  type?: string;
  attrs: Record<string, string>;
  style: Record<string, string>;
  children: Node[];
  rect: Rect;
  shadowRoot?: Root | null;
  contentDocument?: Root | null;
  clientLeft?: number;
  clientTop?: number;
  padding?: { left: number; top: number };
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  getBoundingClientRect(): Rect;
  appendChild(child: Node): void;
  remove(): void;
  closest(): null;
  readonly childElementCount: number;
}

interface Root {
  /** Every element of this root, in tree order (not the content of nested shadow roots). */
  all: Node[];
  body?: Node;
  documentElement?: Node;
  defaultView?: { getComputedStyle(el: Node): { paddingLeft: string; paddingTop: string } };
  querySelectorAll(selector: string): Node[];
  createElement?(tag: string): Node;
  getElementById?(id: string): Node | null;
}

function el(tag: string, opts: Partial<Node> = {}): Node {
  return {
    tagName: tag.toUpperCase(),
    id: opts.id ?? '',
    className: '',
    type: opts.type,
    attrs: { ...(opts.attrs ?? {}) },
    style: {},
    children: [],
    rect: opts.rect ?? { left: 0, top: 0, width: 100, height: 20 },
    shadowRoot: opts.shadowRoot,
    contentDocument: opts.contentDocument,
    clientLeft: opts.clientLeft,
    clientTop: opts.clientTop,
    padding: opts.padding,
    getAttribute(name: string) {
      if (name === 'id') return this.id || null;
      return this.attrs[name] ?? null;
    },
    setAttribute(name: string, value: string) {
      this.attrs[name] = value;
    },
    getBoundingClientRect() {
      return this.rect;
    },
    appendChild(child: Node) {
      this.children.push(child);
    },
    remove() {},
    closest() {
      return null;
    },
    get childElementCount() {
      return this.children.length;
    }
  };
}

function query(all: Node[], selector: string): Node[] {
  if (selector === '*') return all;
  const tags = selector.split(',').map((s) => s.trim().toUpperCase());
  return all.filter((n) => tags.includes(n.tagName));
}

function shadow(all: Node[]): Root {
  return { all, querySelectorAll: (s) => query(all, s) };
}

/** A document; frames read their padding through defaultView.getComputedStyle. */
function doc(all: Node[]): Root & { layer(): Node | undefined } {
  const body = el('body');
  const byId = new Map<string, Node>();
  body.appendChild = (child: Node) => {
    body.children.push(child);
    if (child.id) byId.set(child.id, child);
  };
  return {
    all,
    body,
    documentElement: body,
    defaultView: {
      getComputedStyle: (n: Node) => ({ paddingLeft: `${n.padding?.left ?? 0}px`, paddingTop: `${n.padding?.top ?? 0}px` })
    },
    querySelectorAll: (s) => query(all, s),
    createElement: (tag: string) => el(tag),
    getElementById: (id: string) => byId.get(id) ?? null,
    layer: () => body.children[0]
  };
}

const covers = (layer: unknown) => ((layer as Node | null)?.children ?? []).map((c) => ({
  mask: c.getAttribute('data-mask'),
  left: c.style.left,
  top: c.style.top,
  width: c.style.width,
  height: c.style.height
}));

test('a password field inside an open shadow root is covered', () => {
  const pw = el('input', { type: 'password', rect: { left: 30, top: 40, width: 200, height: 30 } });
  const host = el('login-card', { shadowRoot: shadow([pw]) });
  const d = doc([host]);
  const layer = maskSensitiveFields(d as any);
  assert.deepEqual(covers(layer), [{ mask: 'password', left: '30px', top: '40px', width: '200px', height: '30px' }]);
});

test('a card field in a shadow root nested in another shadow root is covered', () => {
  const card = el('input', { type: 'text', attrs: { name: 'cardnumber' }, rect: { left: 5, top: 6, width: 50, height: 10 } });
  const inner = el('card-input', { shadowRoot: shadow([card]) });
  const outer = el('pay-widget', { shadowRoot: shadow([inner]) });
  const layer = maskSensitiveFields(doc([outer]) as any);
  assert.deepEqual(covers(layer).map((c) => c.mask), ['cc']);
});

test('a cross-origin iframe inside a same-origin iframe is covered, moved into the page', () => {
  const payment = el('iframe', { contentDocument: null, rect: { left: 10, top: 20, width: 300, height: 100 } });
  const innerDoc = doc([payment]);
  const wrapper = el('iframe', { contentDocument: innerDoc, rect: { left: 100, top: 200, width: 400, height: 300 } });
  const layer = maskSensitiveFields(doc([wrapper]) as any);
  assert.deepEqual(covers(layer), [{ mask: 'iframe', left: '110px', top: '220px', width: '300px', height: '100px' }]);
});

test('a password field two same-origin frames deep is covered at its page position', () => {
  const pw = el('input', { type: 'password', rect: { left: 1, top: 2, width: 30, height: 10 } });
  const level2 = el('iframe', { contentDocument: doc([pw]), rect: { left: 10, top: 10, width: 200, height: 200 } });
  const level1 = el('iframe', { contentDocument: doc([level2]), rect: { left: 100, top: 100, width: 400, height: 400 } });
  const layer = maskSensitiveFields(doc([level1]) as any);
  assert.deepEqual(covers(layer), [{ mask: 'password', left: '111px', top: '112px', width: '30px', height: '10px' }]);
});

test('a field inside a same-origin iframe is offset by the frame border and padding', () => {
  const pw = el('input', { type: 'password', rect: { left: 10, top: 10, width: 100, height: 20 } });
  const frame = el('iframe', {
    contentDocument: doc([pw]),
    rect: { left: 50, top: 60, width: 400, height: 300 },
    clientLeft: 3,
    clientTop: 4,
    padding: { left: 7, top: 8 }
  });
  const layer = maskSensitiveFields(doc([frame]) as any);
  assert.deepEqual(covers(layer), [{ mask: 'password', left: '70px', top: '82px', width: '100px', height: '20px' }]);
});

test('an iframe inside a shadow root is still covered when cross-origin', () => {
  const payment = el('iframe', { contentDocument: null, rect: { left: 0, top: 0, width: 80, height: 40 } });
  const host = el('checkout-widget', { shadowRoot: shadow([payment]) });
  const layer = maskSensitiveFields(doc([host]) as any);
  assert.deepEqual(covers(layer).map((c) => c.mask), ['iframe']);
});
