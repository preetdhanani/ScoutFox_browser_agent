/**
 * selector-only-addressing: only selector-matched elements got ids, so details/summary, styled
 * labels for hidden controls, role options and handler-only divs could never be clicked.
 *
 * The tests run the REAL compressor (src/content/domCompressor.ts, which builds the shipped
 * content/domCompressor.js) against a small tree-shaped fake DOM whose querySelectorAll really
 * evaluates the selector, whose getComputedStyle resolves cursor by inheritance, and whose nodes
 * take listeners. The fakeDom helper (tests/helpers/fakeDom.ts) lists what a description names by
 * fiat, so it cannot see a selector gap; this file can.
 *
 * Each pattern is asserted to be listed exactly once with a usable id, nested clickable pairs to
 * produce one id, and a click on the id of a summary, a styled radio label and a role option to
 * resolve and dispatch to the right element.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMCompressor } from '../../src/content/domCompressor.ts';
import type { DomSnapshot } from '../../src/content/domCompressor.ts';
import { doClick } from '../../src/content/actions.ts';
import type { ActionExecutionContext } from '../../src/content/actions.ts';
import { resolveElement } from '../../src/content/resolve.ts';
import { withGlobals } from '../helpers/contentGlobals.ts';

// ---------------------------------------------------------------------------------------------
// A tree-shaped fake DOM: nested elements, attributes, styles, rects, listeners
// ---------------------------------------------------------------------------------------------

interface NodeSpec {
  tag: string;
  text?: string;
  attrs?: Record<string, string>;
  style?: { cursor?: string; display?: string; opacity?: string };
  rect?: { width: number; height: number; top?: number };
  onClick?: boolean;
  children?: NodeSpec[];
}

class FakeNode {
  tagName: string;
  nodeType = 1;
  attrs: Record<string, string>;
  style: { cursor?: string; display?: string; opacity?: string };
  rect: { width: number; height: number; top: number };
  text: string;
  children: FakeNode[] = [];
  parentElement: FakeNode | null = null;
  previousElementSibling: FakeNode | null = null;
  ownerDocument: FakeDocument;
  order: number;
  listeners = new Map<string, Array<() => void>>();

  constructor(spec: NodeSpec, doc: FakeDocument, order: { n: number }) {
    this.tagName = spec.tag.toUpperCase();
    this.attrs = { ...(spec.attrs ?? {}) };
    this.style = { ...(spec.style ?? {}) };
    this.rect = { width: spec.rect?.width ?? 120, height: spec.rect?.height ?? 24, top: spec.rect?.top ?? 0 };
    this.text = spec.text ?? '';
    this.ownerDocument = doc;
    this.order = order.n++;
    if (spec.onClick) this.addEventListener('click', () => {});
  }

  get id(): string {
    return this.attrs.id ?? '';
  }

  get innerText(): string {
    return [this.text, ...this.children.map((c) => c.innerText)].filter(Boolean).join('\n');
  }

  get textContent(): string {
    return this.innerText;
  }

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }

  getBoundingClientRect(): { width: number; height: number; top: number; bottom: number; left: number; right: number } {
    return { width: this.rect.width, height: this.rect.height, top: this.rect.top, bottom: this.rect.top + this.rect.height, left: 10, right: 10 + this.rect.width };
  }

  checkVisibility(): boolean {
    return this.style.display !== 'none' && this.style.opacity !== '0';
  }

  closest(selector: string): FakeNode | null {
    let node: FakeNode | null = this;
    while (node) {
      if (matchComplex(node, selector)) return node;
      node = node.parentElement;
    }
    return null;
  }

  contains(other: FakeNode | null): boolean {
    let node: FakeNode | null = other;
    while (node) {
      if (node === this) return true;
      node = node.parentElement;
    }
    return false;
  }

  compareDocumentPosition(other: FakeNode): number {
    // 4 = DOCUMENT_POSITION_FOLLOWING, 2 = DOCUMENT_POSITION_PRECEDING.
    return other.order > this.order ? 4 : 2;
  }

  addEventListener(type: string, fn: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  dispatchEvent(event: { type: string }): boolean {
    for (const fn of this.listeners.get(event.type) ?? []) fn();
    return true;
  }

  click(): void {
    this.dispatchEvent({ type: 'click' });
  }

  focus(): void {}

  scrollIntoView(): void {}
}

class FakeDocument {
  title: string;
  contentType = 'text/html';
  documentElement: { scrollHeight: number };
  body: FakeNode;
  activeElement: FakeNode;
  private all: FakeNode[] = [];

  constructor(title: string, pageHeight: number, bodySpec: NodeSpec) {
    this.title = title;
    this.documentElement = { scrollHeight: pageHeight };
    const order = { n: 0 };
    this.body = this.build(bodySpec, order, null, null);
    this.activeElement = this.body;
  }

  private build(spec: NodeSpec, order: { n: number }, parent: FakeNode | null, prev: FakeNode | null): FakeNode {
    const node = new FakeNode(spec, this, order);
    node.parentElement = parent;
    node.previousElementSibling = prev;
    this.all.push(node);
    let last: FakeNode | null = null;
    for (const child of spec.children ?? []) {
      const built = this.build(child, order, node, last);
      node.children.push(built);
      last = built;
    }
    return node;
  }

  /** Every element in document order, body excluded (like doc.querySelectorAll('*') on a page). */
  elements(): FakeNode[] {
    return this.all.filter((n) => n !== this.body);
  }

  querySelectorAll(selector: string): FakeNode[] {
    return this.elements().filter((el) => selector.split(',').some((alt) => matchComplex(el, alt.trim())));
  }

  querySelector(selector: string): FakeNode | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  getElementById(id: string): FakeNode | null {
    return this.all.find((el) => el.id === id) ?? null;
  }

  contains(node: FakeNode | null): boolean {
    return !!node && this.all.includes(node);
  }
}

// ---------------------------------------------------------------------------------------------
// A small selector matcher for the simple selectors INTERACTIVE_SELECTOR is built from
// ---------------------------------------------------------------------------------------------

function matchSimple(el: FakeNode, simple: string): boolean {
  let rest = simple;
  if (rest.startsWith('*')) rest = rest.slice(1);
  const tag = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(rest);
  if (tag) {
    if (el.tagName.toLowerCase() !== tag[0].toLowerCase()) return false;
    rest = rest.slice(tag[0].length);
  }
  while (rest.length > 0) {
    let m = /^:not\(\[([^\]=]+)(?:="([^"]*)")?\]\)/.exec(rest);
    if (m) {
      const value = el.getAttribute(m[1]);
      if (m[2] === undefined ? value !== null : value === m[2]) return false;
      rest = rest.slice(m[0].length);
      continue;
    }
    m = /^\[([^\]=]+)(?:="([^"]*)")?\]/.exec(rest);
    if (m) {
      const value = el.getAttribute(m[1]);
      if (m[2] === undefined ? value === null : value !== m[2]) return false;
      rest = rest.slice(m[0].length);
      continue;
    }
    throw new Error(`fake DOM: unsupported selector token "${rest}" in "${simple}"`);
  }
  return true;
}

function matchComplex(el: FakeNode, selector: string): boolean {
  const seq = selector.trim().replace(/>/g, ' > ').split(/\s+/).filter(Boolean);
  if (seq.length === 0) return false;
  let node: FakeNode | null = el;
  let i = seq.length - 1;
  if (seq[i] === '>' || !matchSimple(node, seq[i])) return false;
  i--;
  while (i >= 0 && node) {
    if (seq[i] === '>') {
      node = node.parentElement;
      i--;
      if (!node || i < 0 || !matchSimple(node, seq[i])) return false;
      i--;
    } else {
      let parent: FakeNode | null = node.parentElement;
      let found = false;
      while (parent) {
        if (matchSimple(parent, seq[i])) {
          node = parent;
          found = true;
          break;
        }
        parent = parent.parentElement;
      }
      if (!found) return false;
      i--;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// The fixture page of the four patterns, and the snapshot helpers
// ---------------------------------------------------------------------------------------------

const PAGE_SPEC: NodeSpec = {
  tag: 'body',
  children: [
    {
      tag: 'main',
      children: [
        { tag: 'h1', text: 'Configurator widgets' },
        { tag: 'p', text: 'Every widget below stands for one pattern the selector missed.' },
        {
          tag: 'details',
          attrs: { id: 'shipping-info' },
          children: [
            { tag: 'summary', text: 'Shipping and returns' },
            { tag: 'p', text: 'Returns are accepted within 30 days of delivery.' },
          ],
        },
        {
          tag: 'div',
          attrs: { class: 'choice' },
          children: [
            { tag: 'input', attrs: { type: 'radio', id: 'storage-512', name: 'storage' }, rect: { width: 0, height: 0 } },
            { tag: 'label', attrs: { for: 'storage-512' }, text: '512 GB', style: { cursor: 'pointer' } },
            { tag: 'input', attrs: { type: 'radio', id: 'storage-1tb', name: 'storage' }, rect: { width: 0, height: 0 } },
            { tag: 'label', attrs: { for: 'storage-1tb' }, text: '1 TB', style: { cursor: 'pointer' } },
          ],
        },
        {
          tag: 'div',
          attrs: { role: 'listbox', 'aria-label': 'Batch size' },
          children: [
            { tag: 'div', attrs: { role: 'option' }, text: 'Batch of 1' },
            { tag: 'div', attrs: { role: 'option' }, text: 'Batch of 5' },
          ],
        },
        { tag: 'div', attrs: { class: 'swatch' }, text: 'Midnight Black', style: { cursor: 'pointer' }, onClick: true },
        {
          tag: 'div',
          attrs: { class: 'card' },
          style: { cursor: 'pointer' },
          children: [{ tag: 'span', text: 'Pro module' }],
        },
        {
          tag: 'div',
          attrs: { onclick: '' },
          text: 'Banner',
          children: [{ tag: 'span', text: 'Banner text', style: { cursor: 'pointer' } }],
        },
        { tag: 'label', text: 'Remember me', children: [{ tag: 'input', attrs: { type: 'checkbox' } }] },
        { tag: 'button', text: 'Buy', rect: { width: 0, height: 0 } },
        { tag: 'a', attrs: { href: '/docs' }, text: 'Docs' },
      ],
    },
  ],
};

interface Built {
  doc: FakeDocument;
  win: Record<string, unknown>;
  all: FakeNode[];
}

function buildPage(spec: NodeSpec = PAGE_SPEC): Built {
  const doc = new FakeDocument('Pattern widgets', 3000, spec);
  const cursorOf = (el: FakeNode): string => {
    let node: FakeNode | null = el;
    while (node) {
      if (node.style.cursor !== undefined) return node.style.cursor;
      node = node.parentElement;
    }
    return 'auto';
  };
  const win = {
    location: { href: 'https://patterns.test/', hostname: 'patterns.test' },
    innerWidth: 1200,
    innerHeight: 800,
    scrollY: 0,
    getComputedStyle: (el: FakeNode) => ({ cursor: cursorOf(el) }),
    CSS: { escape: (s: string) => s },
  };
  return { doc, win, all: doc.elements() };
}

function snapshotOf(built: Built): { snapshot: DomSnapshot; compressor: DOMCompressor } {
  const compressor = new DOMCompressor();
  (built.win as Record<string, unknown>).domCompressor = compressor;
  const snapshot = withGlobals(
    { window: built.win, document: built.doc, CSS: { escape: (s: string) => s } },
    () => compressor.getSnapshot()
  ) as DomSnapshot;
  return { snapshot, compressor };
}

const listed = (snapshot: DomSnapshot, text: string) => snapshot.elements.filter((e) => e.text === text);
const listedByTag = (snapshot: DomSnapshot, tag: string, text: string) =>
  snapshot.elements.filter((e) => e.tagName === tag && e.text === text);

// ---------------------------------------------------------------------------------------------
// The four patterns, each listed exactly once
// ---------------------------------------------------------------------------------------------

test('details > summary is listed exactly once, and the details element itself is not', () => {
  const built = buildPage();
  const { snapshot } = snapshotOf(built);
  assert.equal(listed(snapshot, 'Shipping and returns').length, 1, 'the summary must carry the one id of the pair');
  assert.equal(snapshot.elements.filter((e) => e.tagName === 'summary').length, 1);
  assert.equal(snapshot.elements.filter((e) => e.tagName === 'details').length, 0, 'the details wrapper gets no second id');
});

test('a styled radio with a zero-size native input is reached by its label, and only the label is listed', () => {
  const built = buildPage();
  const { snapshot } = snapshotOf(built);
  assert.equal(listed(snapshot, '512 GB').length, 1);
  assert.equal(listed(snapshot, '1 TB').length, 1);
  assert.equal(listedByTag(snapshot, 'label', '512 GB').length, 1, 'the label is the listed target');
  for (const id of ['storage-512', 'storage-1tb']) {
    assert.equal(snapshot.elements.filter((e) => e.locator.attrs.id === id).length, 0, `the hidden input ${id} gets no id of its own`);
  }
});

test('role=option entries of a custom listbox are listed exactly once', () => {
  const built = buildPage();
  const { snapshot } = snapshotOf(built);
  assert.equal(listed(snapshot, 'Batch of 1').length, 1);
  assert.equal(listed(snapshot, 'Batch of 5').length, 1);
  assert.equal(snapshot.elements.filter((e) => e.role === 'option').length, 2);
});

test('a handler-only div with cursor pointer and text is listed, with no interactive ancestor', () => {
  const built = buildPage();
  const { snapshot } = snapshotOf(built);
  assert.equal(listed(snapshot, 'Midnight Black').length, 1);
  assert.equal(listedByTag(snapshot, 'div', 'Midnight Black').length, 1);
});

// ---------------------------------------------------------------------------------------------
// One id per physical target
// ---------------------------------------------------------------------------------------------

test('nested cursor-pointer pair: the leaf inside the card is listed once and the card itself is not', () => {
  const built = buildPage();
  const { snapshot } = snapshotOf(built);
  assert.equal(listed(snapshot, 'Pro module').length, 1, 'the pair produces one id, not two');
  assert.equal(listedByTag(snapshot, 'span', 'Pro module').length, 1, 'the leaf carries it');
  assert.equal(listedByTag(snapshot, 'div', 'Pro module').length, 0, 'the card div gets no second id');
});

test('a cursor-pointer leaf inside an already-listed clickable ancestor is skipped', () => {
  const built = buildPage();
  const { snapshot } = snapshotOf(built);
  assert.equal(snapshot.elements.filter((e) => e.tagName === 'div' && e.text.startsWith('Banner')).length, 1, 'the onclick div is listed');
  assert.equal(listed(snapshot, 'Banner text').length, 0, 'its cursor-pointer span is covered by the ancestor');
});

test('a label whose control is visible is skipped: the control already carries the id', () => {
  const built = buildPage();
  const { snapshot } = snapshotOf(built);
  const checkboxes = snapshot.elements.filter((e) => e.tagName === 'input' && e.type === 'checkbox');
  assert.equal(checkboxes.length, 1, 'the visible checkbox is listed');
  assert.equal(listedByTag(snapshot, 'label', 'Remember me').length, 0, 'the label gets no second id for the pair');
});

test('the visibility rules of the existing selector matches are unchanged: a zero-size button is not listed', () => {
  const built = buildPage();
  const { snapshot } = snapshotOf(built);
  assert.equal(listed(snapshot, 'Buy').length, 0);
  assert.equal(listed(snapshot, 'Docs').length, 1, 'an ordinary link is still listed');
});

// ---------------------------------------------------------------------------------------------
// A click on the new ids resolves and dispatches to the right element
// ---------------------------------------------------------------------------------------------

function clickContext(built: Built): ActionExecutionContext {
  const { doc, win } = built;
  return {
    doc: doc as unknown as Document,
    win: win as unknown as Window & typeof globalThis,
    resolveElement: (id) => resolveElement(id, doc as unknown as Document, win as unknown as Window & typeof globalThis),
    highlightElement: () => {},
    showClickEffect: () => {},
    animateCursor: () => {},
    waitForDomQuiet: async () => {},
    describeElement: () => '',
    setFieldValue: () => ({ success: true }),
    doClick: () => ({ success: true }),
    doType: () => ({ success: true }),
  };
}

test('a click on the id of the summary, the styled radio label, the role option and the swatch resolves and dispatches to the right element', () => {
  const built = buildPage();
  const { snapshot } = snapshotOf(built);
  const context = clickContext(built);
  const byText = (text: string): FakeNode => built.all.find((el) => el.innerText === text) as FakeNode;

  const targets: Array<[string, string]> = [
    ['Shipping and returns', 'summary'],
    ['512 GB', 'label'],
    ['Batch of 1', 'option'],
    ['Midnight Black', 'swatch'],
  ];
  for (const [text, what] of targets) {
    const summary = listed(snapshot, text);
    assert.equal(summary.length, 1, `${what}: listed exactly once`);
    const id = summary[0].id;
    const node = byText(text);
    let clicks = 0;
    node.addEventListener('click', () => {
      clicks++;
    });
    const result = doClick(id, context, built.win as unknown as Window & typeof globalThis);
    assert.equal(result.success, true, `${what}: the click succeeds`);
    assert.equal(resolveElement(id, docOf(built), winOf(built)), node, `${what}: the id resolves to the right element`);
    assert.equal(clicks, 1, `${what}: the click dispatches to that element`);
  }
});

function docOf(built: Built): Document {
  return built.doc as unknown as Document;
}

function winOf(built: Built): Window & typeof globalThis {
  return built.win as unknown as Window & typeof globalThis;
}
