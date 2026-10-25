/**
 * Cookie banners and other controls inside shadow roots, and coordinate clicks that land next to
 * a small control.
 *
 * Found on real pages: bahn.de's consent layer keeps its buttons in a shadow root, so the element
 * list never had them and the model could only click by coordinates. And a vision model points
 * within a few pixels of a target, which misses a 28 px close icon.
 *   1. findInteractiveElements lists the controls of open shadow roots, in the order of the page.
 *   2. A listed shadow control still resolves (isConnected, not document.contains).
 *   3. snapPoint moves a point next to a control onto it, and never when the point is on a control
 *      already, when two controls are equally close, or when the control is out of reach.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { findInteractiveElements } from '../../src/content/snapshot.ts';
import { getElementFromMap } from '../../src/content/refMap.ts';
import { snapPoint, SNAP_RADIUS_PX } from '../../src/content/screenshotPrivacy.ts';

type Rect = { left: number; top: number; width: number; height: number };

/** One simple selector part against an element: tag, a[href], [role="x"], input:not(...), *. */
function matchesPart(node: Node, part: string): boolean {
  const p = part.trim();
  if (p === '*') return true;
  const role = /^\[role="([^"]+)"\]$/.exec(p);
  if (role) return node.attrs.role === role[1];
  if (p === 'a[href]') return node.tag === 'a' && 'href' in node.attrs;
  const attr = /^\[([a-z-]+)\]$/.exec(p);
  if (attr) return attr[1] in node.attrs;
  if (p.startsWith('input')) return node.tag === 'input' && node.attrs.type !== 'hidden';
  if (/^[a-z]+$/.test(p)) return node.tag === p;
  return false;
}

class Node {
  tag: string;
  attrs: Record<string, string>;
  rect: Rect;
  children: Node[] = [];
  parentElement: Node | null = null;
  parentNode: any = null;
  shadowRoot: Root | null = null;
  isConnected = true;
  ownerDocument: any = null;
  innerText: string;
  textContent: string;
  constructor(tag: string, rect: Rect, attrs: Record<string, string> = {}, text = '') {
    this.tag = tag;
    this.attrs = attrs;
    this.rect = rect;
    this.innerText = text;
    this.textContent = text;
  }
  get tagName() { return this.tag.toUpperCase(); }
  get className() { return this.attrs.class || ''; }
  getAttribute(name: string) { return this.attrs[name] ?? null; }
  setAttribute(name: string, value: string) { this.attrs[name] = value; }
  getBoundingClientRect() { return { ...this.rect, right: this.rect.left + this.rect.width, bottom: this.rect.top + this.rect.height }; }
  closest(selector: string): Node | null {
    for (let n: Node | null = this; n; n = n.parentElement) if (selector.split(',').some((s) => matchesPart(n!, s))) return n;
    return null;
  }
  add(...kids: Node[]) {
    for (const kid of kids) { kid.parentElement = this; kid.parentNode = this; this.children.push(kid); }
    return this;
  }
  attachShadow(...kids: Node[]) {
    this.shadowRoot = new Root(this);
    for (const kid of kids) { kid.parentNode = this.shadowRoot; this.shadowRoot.children.push(kid); }
    return this;
  }
  querySelectorAll(sel: string) { return descendants(this.children).filter((n) => sel.split(',').some((s) => matchesPart(n, s))); }
}

class Root {
  children: Node[] = [];
  host: Node;
  constructor(host: Node) { this.host = host; }
  querySelectorAll(sel: string) { return descendants(this.children).filter((n) => sel.split(',').some((s) => matchesPart(n, s))); }
  getElementById() { return null; }
  elementFromPoint(x: number, y: number) { return topAt(this.children, x, y); }
}

/** The light descendants in tree order (not into shadow roots, like the real API). */
function descendants(list: Node[]): Node[] {
  const out: Node[] = [];
  for (const n of list) { out.push(n); out.push(...descendants(n.children)); }
  return out;
}

/** The last (topmost) element in tree order whose box holds the point, not entering shadow roots. */
function topAt(list: Node[], x: number, y: number): Node | null {
  let hit: Node | null = null;
  for (const n of descendants(list)) {
    const r = n.rect;
    if (x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height) hit = n;
  }
  return hit;
}

function page(body: Node) {
  const doc: any = {
    body,
    documentElement: body,
    defaultView: { getComputedStyle: () => ({ cursor: 'auto' }), innerWidth: 1280, innerHeight: 800 },
    querySelectorAll: (sel: string) => [body, ...body.querySelectorAll(sel)].filter((n) => sel.split(',').some((s) => matchesPart(n, s))),
    getElementById: () => null,
    contains: (n: Node) => descendants([body]).includes(n),
    elementFromPoint: (x: number, y: number) => topAt([body], x, y)
  };
  for (const n of descendants([body])) n.ownerDocument = doc;
  const walkShadow = (list: Node[]) => {
    for (const n of descendants(list)) if (n.shadowRoot) { for (const m of descendants(n.shadowRoot.children)) m.ownerDocument = doc; walkShadow(n.shadowRoot.children); }
  };
  walkShadow([body]);
  return doc;
}

const R = (left: number, top: number, width: number, height: number): Rect => ({ left, top, width, height });

/** A page like bahn.de: a search link in the light DOM, and a consent layer in a shadow root. */
function bannerPage() {
  const search = new Node('a', R(20, 20, 80, 30), { href: '/search' }, 'Suchen');
  const deny = new Node('button', R(900, 700, 120, 40), {}, 'Only necessary');
  const accept = new Node('button', R(1040, 700, 140, 40), {}, 'Allow all cookies');
  const panel = new Node('div', R(880, 680, 320, 80), { class: 'buttons' }).add(deny, accept);
  // The host's box covers the layer, so elementFromPoint stops at it there, like a browser does.
  const host = new Node('div', R(880, 680, 320, 80), { id: 'usercentrics-root' }).attachShadow(panel);
  const footer = new Node('a', R(20, 760, 80, 20), { href: '/imprint' }, 'Impressum');
  const body = new Node('body', R(0, 0, 1280, 800)).add(search, host, footer);
  return { doc: page(body), search, deny, accept, footer, panel, host };
}

test('the buttons of a shadow-root consent layer are listed, in the order of the page', () => {
  const { doc, search, deny, accept, footer } = bannerPage();
  const listed = findInteractiveElements(doc);
  assert.deepEqual(listed, [search, deny, accept, footer], 'the shadow content sits where its host is');
});

test('a listed shadow-root button still resolves by its id', () => {
  const { doc, accept } = bannerPage();
  assert.equal(doc.contains(accept), false, 'document.contains never sees into a shadow root');
  const map = new Map<number, any>([[7, accept]]);
  assert.equal(getElementFromMap(map, 7, doc), accept);
  accept.isConnected = false;
  assert.equal(getElementFromMap(map, 7, doc), null, 'a removed one is still gone');
});

test('a point on the banner just next to a small button is moved onto the button', () => {
  const { doc, accept } = bannerPage();
  // 6 px right of "Allow all cookies", on the panel around it.
  const snap = snapPoint(doc, 1186, 720);
  assert.ok(snap, 'snapped');
  assert.deepEqual({ x: snap!.x, y: snap!.y }, { x: 1110, y: 720 }, 'the center of the button');
  assert.match(snap!.what, /Allow all cookies/);
  assert.equal(snap!.distance, 6);
  assert.ok(accept);
});

test('a point already on a button is left alone', () => {
  const { doc } = bannerPage();
  assert.equal(snapPoint(doc, 1100, 710), null);
});

test('a point between two buttons that are about equally close is left alone: the intent is not clear', () => {
  const { doc } = bannerPage();
  // The gap between the buttons is 1020..1040: 10 px from both.
  assert.equal(snapPoint(doc, 1030, 720), null);
});

test('a point further than the radius from every control is left alone', () => {
  const { doc } = bannerPage();
  assert.equal(snapPoint(doc, 1040, 680 - SNAP_RADIUS_PX - 2), null);
});

test('a control whose center is under something else is not a target', () => {
  const { doc, panel } = bannerPage();
  // An overlay over the accept button: its center no longer receives the click.
  panel.add(new Node('div', R(1030, 690, 160, 60), { class: 'overlay' }));
  assert.equal(snapPoint(doc, 1186, 720), null);
});

test('a point inside a clickable card is a click on the card, never moved onto a button in it', () => {
  const remove = new Node('button', R(300, 300, 80, 30), {}, 'Delete');
  const title = new Node('span', R(110, 110, 120, 20), {}, 'Item title');
  const card = new Node('div', R(100, 100, 400, 260), { onclick: '' }).add(title, remove);
  const doc = page(new Node('body', R(0, 0, 1280, 800)).add(card));
  assert.equal(snapPoint(doc, 120, 118), null, 'the point is inside the card: no snap to its center or its Delete button');
});

test('a point on a canvas is meant there, even next to a button', () => {
  const canvas = new Node('canvas', R(0, 100, 800, 500));
  const zoom = new Node('button', R(805, 100, 30, 30), {}, '+');
  const doc = page(new Node('body', R(0, 0, 1280, 800)).add(canvas, zoom));
  assert.equal(snapPoint(doc, 795, 110), null);
});

test('a button host and the button in its shadow root get one id, not two', () => {
  const inner = new Node('button', R(10, 10, 100, 30), {}, 'Buy');
  const host = new Node('x-btn', R(10, 10, 100, 30), { role: 'button' }).attachShadow(inner);
  const doc = page(new Node('body', R(0, 0, 1280, 800)).add(host));
  assert.deepEqual(findInteractiveElements(doc), [host]);
});

test('a shadow-root element that is gone is never "recovered" as a light-DOM element with the same id', async () => {
  const { resolveElementDetailed } = await import('../../src/content/resolve.ts');
  const twin = { id: 'submit', isConnected: true, getBoundingClientRect: () => ({ width: 10, height: 10 }) };
  const doc: any = { contains: () => true, getElementById: (id: string) => (id === 'submit' ? twin : null), querySelectorAll: () => [] };
  const win: any = {
    domCompressor: {
      getElement: () => null,
      elements: [{ id: 3, locator: { inShadow: true, index: 3, tag: 'button', text: 'Accept', role: 'button', cssPath: '#submit', attrs: { id: 'submit', name: '', 'data-testid': '' } } }]
    }
  };
  assert.equal(resolveElementDetailed(3, doc, win).element, null);
});
