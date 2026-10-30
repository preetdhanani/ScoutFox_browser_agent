/**
 * The covers over embedded frames, frame by frame: an iframe the top page cannot read is shown only
 * when its own frame agent confirmed its covers (its path is in shownFramePaths), and the check after
 * the capture throws the picture away when anything changed since the covers went up.
 *
 * Frames are named by their path from the top page (src/content/frameIds.ts), read from window
 * identities only, so these tests build small window trees.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { maskSensitiveFields, masksStillHold } from '../../src/content/screenshotPrivacy.ts';
import { framePathOf, framePathKeyOf, shownFrames } from '../../src/content/frameIds.ts';

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
  contentWindow?: unknown;
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
    contentWindow: opts.contentWindow,
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




/** A window tree: a top window with child windows, each with its own children (like window.frames). */
function windows(shape: number[][]): { top: any; at: (...path: number[]) => any } {
  const make = (parent: any) => {
    const w: any = { parent, length: 0 };
    w.top = parent ? parent.top : w;
    if (!parent) w.parent = w;
    return w;
  };
  const top = make(null);
  const add = (parent: any) => {
    const child = make(parent);
    parent[parent.length] = child;
    parent.length += 1;
    return child;
  };
  // shape[i] = the number of children of the i-th child of the top (a two-level tree is enough here).
  shape.forEach((kids) => {
    const child = add(top);
    for (let k = 0; k < kids.length; k++) add(child);
  });
  return { top, at: (...path: number[]) => path.reduce((w, i) => w[i], top) };
}

const covers = (layer: unknown) => ((layer as Node | null)?.children ?? []).map((c) => c.getAttribute('data-mask'));

test('framePathOf reads a frame path from window identities, the top page is the empty path', () => {
  const tree = windows([[], [0, 0]]);
  assert.deepEqual(framePathOf(tree.top), []);
  assert.deepEqual(framePathOf(tree.at(0)), [0]);
  assert.deepEqual(framePathOf(tree.at(1, 1)), [1, 1]);
  assert.equal(framePathOf(null), null);
});

test('framePathOf gives null for a window its parent does not list (a detached frame)', () => {
  const tree = windows([[]]);
  const stray: any = { parent: tree.top, top: tree.top, length: 0 };
  assert.equal(framePathOf(stray), null);
});

test('framePathOf gives null when reading the tree throws (fail closed)', () => {
  const hostile: any = {};
  Object.defineProperty(hostile, 'top', { get() { throw new Error('blocked'); } });
  assert.equal(framePathOf(hostile), null);
});

test('framePathKeyOf: an iframe with no window yet has no path', () => {
  assert.equal(framePathKeyOf({ contentWindow: null } as any), null);
});

test('shownFrames shows only the confirmed paths, and never a frame whose path is unknown', () => {
  const shown = shownFrames(['1', '1.0'], (f: any) => f.key);
  assert.equal(shown({ key: '1' } as any), true);
  assert.equal(shown({ key: '1.0' } as any), true);
  assert.equal(shown({ key: '0' } as any), false);
  assert.equal(shown({ key: null } as any), false);
  assert.equal(shownFrames([], (f: any) => f.key)({ key: '1' } as any), false);
  assert.equal(shownFrames('1', (f: any) => f.key)({ key: '1' } as any), false, 'a non-array is no list');
});

test('an unreadable iframe is covered whole unless its own agent confirmed it', () => {
  const tree = windows([[], []]);
  const lesson = el('iframe', { contentDocument: null, contentWindow: tree.at(0), rect: { left: 0, top: 100, width: 800, height: 600 } });
  const ad = el('iframe', { contentDocument: null, contentWindow: tree.at(1), rect: { left: 0, top: 0, width: 300, height: 50 } });
  const d = doc([lesson, ad]);
  assert.deepEqual(covers(maskSensitiveFields(d as any, undefined, shownFrames(['0']))), ['iframe'], 'only the unconfirmed ad frame is covered');
  assert.deepEqual(covers(maskSensitiveFields(d as any)), ['iframe', 'iframe'], 'with no list, every unreadable frame is covered');
});

test('a shown frame that throws while being asked is covered (fail closed)', () => {
  const frame = el('iframe', { contentDocument: null, rect: { left: 0, top: 0, width: 100, height: 100 } });
  const layer = maskSensitiveFields(doc([frame]) as any, undefined, () => { throw new Error('boom'); });
  assert.deepEqual(covers(layer), ['iframe']);
});

test('masksStillHold: true right after the covers went up, false when no mask walk ran', () => {
  const pw = el('input', { type: 'password' });
  const d = doc([pw]);
  assert.equal(masksStillHold(d as any), false, 'no walk ran in this document');
  maskSensitiveFields(d as any);
  assert.equal(masksStillHold(d as any), true);
});

test('masksStillHold: a password field that appeared after the walk throws the picture away', () => {
  const all: Node[] = [];
  const d = doc(all);
  maskSensitiveFields(d as any);
  assert.equal(masksStillHold(d as any), true, 'nothing to cover is a holding mask');
  all.push(el('input', { type: 'password' }));
  assert.equal(masksStillHold(d as any), false);
});

test('masksStillHold: an iframe that appeared after the walk throws the picture away', () => {
  const all: Node[] = [];
  const d = doc(all);
  maskSensitiveFields(d as any);
  all.push(el('iframe', { contentDocument: null }));
  assert.equal(masksStillHold(d as any), false);
});

test('masksStillHold: a cover layer the page took out throws the picture away', () => {
  const d = doc([el('input', { type: 'password' })]);
  const layer: any = maskSensitiveFields(d as any);
  layer.isConnected = false;
  assert.equal(masksStillHold(d as any), false);
});
