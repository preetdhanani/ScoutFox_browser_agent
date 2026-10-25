/**
 * The screenshot privacy and point helpers: src/content/screenshotPrivacy.ts.
 *
 * A picture is the page as PIXELS, often sent to a cloud model, and the text path is careful
 * about sensitive values (perception.ts blanks a password's value and marks password, card and
 * OTP fields "(user only)"). The picture must be at least as careful, or it undoes that care.
 *
 * What these tests hold on to:
 *   1. A password, card or OTP field is covered, and the field's VALUE is never touched.
 *   2. An ordinary text field is not covered.
 *   3. A cross-origin iframe is covered as a whole box, because its document cannot be read.
 *   4. A "show password" toggle that turns the field into type=text is still covered: the field
 *      is recognised by its kind, not only by its type.
 *   5. Removing the covers leaves the page as it was, with nothing left over.
 *   6. The point description says what is at a pixel, whether it is a control, and whether it is
 *      a masked field.
 *   7. The layer is not appended when there is nothing to cover, so an ordinary page is not
 *      changed by being photographed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MASK_LAYER_ID,
  describePoint,
  describePointElement,
  isInteractiveElement,
  maskSensitiveFields,
  maskedFieldRefusal,
  removeSensitiveMasks
} from '../../src/content/screenshotPrivacy.ts';

/** A fake DOM node, enough for the mask walk and the point description. */
interface FakeEl {
  tagName: string;
  id: string;
  className: string;
  type?: string;
  value?: string;
  textContent?: string;
  innerText?: string;
  style: Record<string, string>;
  children: FakeEl[];
  attrs: Record<string, string>;
  rect: { left: number; top: number; width: number; height: number };
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
  appendChild(child: FakeEl): void;
  remove(): void;
  closest(selector: string): FakeEl | null;
  readonly childElementCount: number;
  ownerDocument: any;
}

/** The mask layer comes back typed as an HTMLElement; in these tests it is the fake node. */
const asFake = (node: unknown): FakeEl => node as FakeEl;

function el(tag: string, opts: Partial<FakeEl> = {}): FakeEl {
  const node: FakeEl = {
    tagName: tag.toUpperCase(),
    id: opts.id ?? '',
    className: opts.className ?? '',
    type: opts.type,
    value: opts.value,
    textContent: opts.textContent ?? '',
    innerText: opts.innerText ?? '',
    style: {},
    children: [],
    attrs: { ...(opts.attrs ?? {}) },
    rect: opts.rect ?? { left: 10, top: 20, width: 200, height: 30 },
    getAttribute(name: string) {
      if (name === 'id') return this.id || null;
      if (name === 'class') return this.className || null;
      return this.attrs[name] ?? null;
    },
    get childElementCount() {
      return this.children.length;
    },
    setAttribute(name: string, value: string) {
      this.attrs[name] = value;
    },
    getBoundingClientRect() {
      return this.rect;
    },
    appendChild(child: FakeEl) {
      this.children.push(child);
      child.ownerDocument = node.ownerDocument;
    },
    remove() {
      const doc = this.ownerDocument;
      if (!doc) return;
      doc.removed.push(this);
      if (this.id) doc.byId.delete(this.id);
    },
    closest() {
      return null;
    },
    ownerDocument: null as any
  };
  node.ownerDocument = node;
  return node;
}

/** A fake document: a body, a lookup for the mask layer, and the elements each selector returns. */
function fakeDoc(spec: { fields?: FakeEl[]; frames?: FakeEl[]; pointAt?: FakeEl | null } = {}) {
  const byId = new Map<string, FakeEl>();
  const body = el('body');
  body.id = '';
  const doc: any = {
    body,
    documentElement: body,
    removed: [] as FakeEl[],
    byId,
    createElement(tag: string) {
      const node = el(tag);
      node.ownerDocument = doc;
      node.remove = function () {
        doc.removed.push(this);
        if (this.id) byId.delete(this.id);
        const at = body.children.indexOf(this);
        if (at >= 0) body.children.splice(at, 1);
      };
      return node;
    },
    getElementById(id: string) {
      return byId.get(id) ?? null;
    },
    querySelectorAll(selector: string) {
      if (selector === 'input, textarea') return spec.fields ?? [];
      if (selector === 'iframe') return spec.frames ?? [];
      return [];
    },
    elementFromPoint() {
      return spec.pointAt ?? null;
    },
    appendChild(node: FakeEl) {
      body.children.push(node);
      if (node.id) byId.set(node.id, node);
    }
  };
  body.ownerDocument = doc;
  // The mask code appends to document.body, so the body has to register ids the way the
  // document does, or getElementById cannot find the layer it just added.
  body.appendChild = function (child: FakeEl) {
    body.children.push(child);
    if (child.id) byId.set(child.id, child);
  };
  for (const field of spec.fields ?? []) field.ownerDocument = doc;
  for (const frame of spec.frames ?? []) frame.ownerDocument = doc;
  return doc;
}

test('a password field is covered, and its value is never touched', () => {
  const password = el('input', { type: 'password', value: 'hunter2', rect: { left: 40, top: 100, width: 240, height: 32 } });
  const doc = fakeDoc({ fields: [password] });

  const layer = maskSensitiveFields(doc);

  assert.ok(layer, 'a cover layer is drawn');
  assert.equal(layer!.id, MASK_LAYER_ID);
  assert.equal(asFake(layer!).children.length, 1, 'one cover, over the password field');
  assert.equal(asFake(layer!).children[0].style.left, '40px');
  assert.equal(asFake(layer!).children[0].style.top, '100px');
  assert.equal(asFake(layer!).children[0].getAttribute('data-mask'), 'password');
  assert.equal(password.value, 'hunter2', 'the value on the page is not written to');
});

test('a card field is covered even when it is a plain text input', () => {
  // A card number field is type=text with name="cardnumber" in the real world, so the type alone
  // would not catch it; the field kind does.
  const card = el('input', { type: 'text', attrs: { name: 'cardnumber' } });
  const doc = fakeDoc({ fields: [card] });
  const layer = maskSensitiveFields(doc);
  assert.equal(asFake(layer!).children.length, 1);
  assert.equal(asFake(layer!).children[0].getAttribute('data-mask'), 'cc');
});

test('an ordinary text field is not covered', () => {
  const search = el('input', { type: 'search', attrs: { name: 'q' } });
  const email = el('input', { type: 'email', attrs: { name: 'email' } });
  const doc = fakeDoc({ fields: [search, email] });

  const layer = maskSensitiveFields(doc);
  assert.equal(layer, null, 'nothing to cover, so no layer is added to the page');
  assert.equal(doc.body.children.length, 0);
});

test('a show-password toggle that made the field type=text is still covered', () => {
  // The toggle changes the type, and the id and name are what still say "password".
  const toggled = el('input', { type: 'text', attrs: { id: 'password-field', name: 'password' } });
  const doc = fakeDoc({ fields: [toggled] });
  const layer = maskSensitiveFields(doc);
  assert.equal(asFake(layer!).children.length, 1, 'the kind catches what the type no longer says');
});

test('a cross-origin iframe is covered as a whole box', () => {
  // contentDocument is null for a cross-origin frame: the main-frame script cannot see inside.
  const frame = el('iframe', { rect: { left: 0, top: 200, width: 1512, height: 400 } });
  (frame as any).contentDocument = null;
  const doc = fakeDoc({ frames: [frame] });

  const layer = maskSensitiveFields(doc);
  assert.equal(asFake(layer!).children.length, 1);
  assert.equal(asFake(layer!).children[0].getAttribute('data-mask'), 'iframe');
  assert.equal(asFake(layer!).children[0].style.width, '1512px');
  assert.equal(asFake(layer!).children[0].style.height, '400px');
});

test('the covers are removed again, leaving the page as it was', () => {
  const password = el('input', { type: 'password', value: 'secret' });
  const doc = fakeDoc({ fields: [password] });

  maskSensitiveFields(doc);
  assert.equal(doc.body.children.length, 1, 'the layer is up');
  removeSensitiveMasks(doc);
  assert.equal(doc.body.children.length, 0, 'and it is gone');
  assert.equal(doc.getElementById(MASK_LAYER_ID), null);
  assert.equal(password.value, 'secret', 'the field was never written to');
});

test('a stale layer from an earlier capture does not stack up', () => {
  const doc = fakeDoc({ fields: [el('input', { type: 'password' })] });
  maskSensitiveFields(doc);
  maskSensitiveFields(doc);
  assert.equal(doc.body.children.length, 1, 'one layer, not two');
});

test('the described point names the element, whether it is a control, and a masked field', () => {
  const doc = fakeDoc({ pointAt: el('button', { id: 'buy', textContent: 'Buy now' }) });
  const point = describePoint(doc, 100, 100);
  assert.match(point.what, /button#buy/);
  assert.match(point.what, /Buy now/);
  assert.equal(point.interactive, true);
  assert.equal(point.fieldKind, undefined);
});

test('a point on a password field refuses the click and says what kind of field it is', () => {
  const doc = fakeDoc({ pointAt: el('input', { type: 'password', attrs: { name: 'password' } }) });
  const point = describePoint(doc, 100, 100);
  assert.equal(point.fieldKind, 'password');
  assert.match(maskedFieldRefusal(point.fieldKind!), /password field/);
  assert.match(maskedFieldRefusal(point.fieldKind!), /refused/);
});

test('a point on a plain surface is allowed, and says it is not a control', () => {
  // A canvas or a chart is a legitimate target, so this is not a refusal.
  const doc = fakeDoc({ pointAt: el('div', { className: 'chart-surface' }) });
  const point = describePoint(doc, 100, 100);
  assert.equal(point.interactive, false);
  assert.match(point.what, /div\.chart-surface/);
  assert.equal(point.fieldKind, undefined);
});

test('a point on nothing describes nothing rather than throwing', () => {
  const doc = fakeDoc({ pointAt: null });
  const point = describePoint(doc, 100, 100);
  assert.equal(point.interactive, false);
  assert.equal(point.what, 'nothing');
});

test('an element description is short and human, not an HTML dump', () => {
  const body = el('body');
  assert.equal(describePointElement(body as unknown as Element), 'the page body');
  const link = el('a', { id: 'next', textContent: 'Next page' });
  assert.equal(describePointElement(link as unknown as Element), 'a#next "Next page"');
  assert.equal(describePointElement(null), 'nothing');
});

test('a control counts as interactive, a wrapper does not', () => {
  const asElement = (node: FakeEl) => node as unknown as Element;
  assert.equal(isInteractiveElement(asElement(el('button'))), true);
  assert.equal(isInteractiveElement(asElement(el('a'))), true);
  assert.equal(isInteractiveElement(asElement(el('input', { type: 'text' }))), true);
  assert.equal(isInteractiveElement(asElement(el('input', { type: 'hidden' }))), false);
  assert.equal(isInteractiveElement(asElement(el('div'))), false);
  assert.equal(isInteractiveElement(asElement(el('span', { attrs: { tabindex: '0' } }))), true);
  assert.equal(isInteractiveElement(null), false);
});

test('a point on a web-component page names the element inside the shadow root, not the host', () => {
  const inner = el('button', { id: 'search', textContent: 'Suchen' });
  const host: any = el('div', { textContent: '@font-face{font-family:DBWebIconFont}' });
  host.shadowRoot = { elementFromPoint: () => inner };
  const doc = fakeDoc({ pointAt: host });
  const point = describePoint(doc, 100, 100);
  assert.match(point.what, /button#search/);
  assert.doesNotMatch(point.what, /font-face/);
  assert.equal(point.interactive, true);
});
