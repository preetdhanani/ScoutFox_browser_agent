/**
 * safety/risk-gate-coverage-holes, content side: the facts the risk gate needs about an element
 * that the model-facing label does not carry.
 *
 * - gateLabel: the name a control really has when its visible text is empty (the value of an
 *   input submit, aria-labelledby, image alt, title). The model-facing label stays as it was.
 * - submitControl: the element submits its form when clicked.
 * - formActionHost / formMethod: where and how the form sends.
 * - snapshot.focused: what press_key acts on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { getElementSummary } from '../../src/content/perception.ts';
import { DOMCompressor } from '../../src/content/domCompressor.ts';
import { withGlobals } from '../helpers/contentGlobals.ts';

const WIN = {
  location: { href: 'https://www.shop.de/kontakt', hostname: 'www.shop.de' },
  innerWidth: 1200,
  innerHeight: 800,
} as unknown as Window;

function form(attrs: Record<string, string> = {}) {
  return { id: '', className: '', getAttribute: (name: string) => attrs[name] ?? null };
}

function el(spec: {
  tag: string;
  attrs?: Record<string, string>;
  text?: string;
  value?: string;
  form?: ReturnType<typeof form> | null;
  imgs?: Array<{ alt: string }>;
  ownerDocument?: unknown;
}): any {
  const attrs = spec.attrs ?? {};
  return {
    tagName: spec.tag.toUpperCase(),
    nodeType: 1,
    id: attrs.id ?? '',
    innerText: spec.text ?? '',
    textContent: spec.text ?? '',
    value: spec.value ?? '',
    getAttribute: (name: string) => attrs[name] ?? null,
    closest: (selector: string) => (selector === 'form' ? spec.form ?? null : null),
    querySelectorAll: (selector: string) => (selector === 'img[alt]' ? (spec.imgs ?? []).map((i) => ({ getAttribute: (n: string) => (n === 'alt' ? i.alt : null) })) : []),
    ownerDocument: spec.ownerDocument,
    setAttribute: () => {},
    getBoundingClientRect: () => ({ width: 50, height: 20, top: 10, bottom: 30, left: 10, right: 60 }),
  };
}

const info = (element: any) => getElementSummary(element, 1, () => 'x', WIN).info as any;
const summary = (element: any) => getElementSummary(element, 1, () => 'x', WIN).summary;

test('perception: an input submit with only a value gets that value as its gate label, the model label is unchanged', () => {
  const buy = el({ tag: 'input', attrs: { type: 'submit' }, value: 'Buy now', form: form() });
  assert.equal(info(buy).gateLabel, 'Buy now');
  assert.equal(info(buy).label, 'element', 'the model-facing label keeps its old source order');
  assert.match(summary(buy).formatted, /value="Buy now"/, 'the model already sees the value');

  const image = el({ tag: 'input', attrs: { type: 'image', alt: 'Jetzt kaufen' }, form: form() });
  assert.equal(info(image).gateLabel, 'Jetzt kaufen');
});

test('perception: an icon-only button is named by its image alt, aria-labelledby or title', () => {
  assert.equal(info(el({ tag: 'button', imgs: [{ alt: 'Kostenpflichtig bestellen' }] })).gateLabel, 'Kostenpflichtig bestellen');

  const doc = { getElementById: (id: string) => (id === 'lbl' ? { textContent: '  Konto   erstellen ' } : null) };
  assert.equal(info(el({ tag: 'button', attrs: { 'aria-labelledby': 'lbl' }, ownerDocument: doc })).gateLabel, 'Konto erstellen');

  assert.equal(info(el({ tag: 'button', attrs: { title: 'Sign up' } })).gateLabel, 'Sign up');

  // A title never adds to a control that already has a name: a product link's SEO title is not its name.
  assert.equal(info(el({ tag: 'a', text: 'Lenovo ThinkPad X1', attrs: { href: '/p/1', title: 'Lenovo ThinkPad X1 jetzt kaufen' } })).gateLabel, undefined);
  // Nothing new to add: no gateLabel at all, so ordinary snapshots stay as they were.
  assert.equal(info(el({ tag: 'button', text: 'Weiter' })).gateLabel, undefined);
  assert.equal(info(el({ tag: 'button', attrs: { 'aria-label': 'Schließen' } })).gateLabel, undefined);
});

test('perception: submit controls, form method and a form that sends to another host are reported', () => {
  assert.equal(info(el({ tag: 'button', text: 'Senden', form: form() })).submitControl, true, 'a <button> without type submits');
  assert.equal(info(el({ tag: 'button', text: 'Senden', attrs: { type: 'submit' }, form: form() })).submitControl, true);
  assert.equal(info(el({ tag: 'input', attrs: { type: 'submit' }, value: 'Go', form: form() })).submitControl, true);
  assert.equal(info(el({ tag: 'button', text: '+', attrs: { type: 'button' }, form: form() })).submitControl, undefined);
  assert.equal(info(el({ tag: 'button', text: 'Senden' })).submitControl, undefined, 'outside a form nothing is submitted');

  assert.equal(info(el({ tag: 'button', text: 'Filtern', form: form({ method: 'GET' }) })).formMethod, 'get');
  assert.equal(info(el({ tag: 'button', text: 'Senden', form: form({ method: 'post' }) })).formMethod, undefined);
  assert.equal(info(el({ tag: 'button', text: 'Senden', attrs: { formmethod: 'get' }, form: form({ method: 'post' }) })).formMethod, 'get');

  assert.equal(info(el({ tag: 'input', attrs: { type: 'text' }, form: form({ action: 'https://collect.evil.example/s', role: 'search' }) })).formActionHost, 'collect.evil.example');
  assert.equal(info(el({ tag: 'input', attrs: { type: 'text' }, form: form({ action: '/suche', role: 'search' }) })).formActionHost, undefined, 'a same-host action is not reported');
  assert.equal(info(el({ tag: 'button', text: 'Go', attrs: { formaction: 'https://other.example/x' }, form: form() })).formActionHost, 'other.example');
});

function snapshotWithFocus(activeElement: unknown) {
  const fakeDocument = {
    title: 'Kontakt',
    contentType: 'text/html',
    documentElement: { scrollHeight: 1000 },
    body: { innerText: '', textContent: '', querySelectorAll: () => [] },
    activeElement,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  return withGlobals(
    { window: WIN, document: fakeDocument, Node: { ELEMENT_NODE: 1 }, CSS: { escape: (s: string) => s } },
    () => new DOMCompressor().getSnapshot() as any,
  );
}

test('perception: the snapshot reports the focused element so press_key Enter can be judged', () => {
  const field = el({ tag: 'textarea', attrs: { name: 'message' }, form: form() });
  const focused = snapshotWithFocus(field).focused;
  assert.ok(focused, 'a focused field is reported');
  assert.equal(focused.formKind, 'other');
  assert.equal(focused.fieldKind, 'text');

  assert.equal(snapshotWithFocus(null).focused, null, 'no focus: null, not missing');
  const body = { tagName: 'BODY', nodeType: 1, getAttribute: () => null };
  assert.equal(snapshotWithFocus(body).focused, null, 'the body having focus is no focus');
});
