/**
 * The cursor overlay: src/content/cursor.ts.
 *
 * The overlay is what the user sees when the agent acts: a fox-shaped pointer that moves to the
 * target, a ripple where it clicks, and a ring around the element it highlighted. It is the
 * only sign the user gets that the agent is doing something, so it has to be visible, and it
 * has to clean up after itself.
 *
 * What these tests hold on to:
 *   1. The overlay is injected once and reused, not injected again on every action.
 *   2. The overlay never takes a click: it must not eat the user's own clicks.
 *   3. The pointer moves to where it was told, and fades out again.
 *   4. A click leaves a ripple, and the ripple goes away again.
 *   5. A highlighted element gets its own style back when the ring goes, even if it was
 *      highlighted twice (BUG-29).
 *   6. Nothing throws when there is no page to draw on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  animateCursor,
  ensureCursorOverlay,
  highlightElement,
  removeCursorOverlay,
  showClickEffect
} from '../../src/content/cursor.ts';

/** A document with the little bit of DOM the overlay uses. */
function fakeDoc() {
  const elements = new Map<string, any>();
  const appended: any[] = [];

  const body: any = {
    appendChild: (el: any) => {
      appended.push(el);
      if (el.id) elements.set(el.id, el);
    }
  };

  const doc: any = {
    body,
    documentElement: body,
    contains: (node: any) => appended.includes(node),
    getElementById: (id: string) => elements.get(id) || null,
    createElement: (tag: string) => {
      const el: any = {
        tagName: tag.toUpperCase(),
        id: '',
        className: '',
        style: {},
        innerHTML: '',
        children: [],
        parentNode: null,
        appendChild: (child: any) => {
          el.children.push(child);
          child.parentNode = el;
          if (child.id) elements.set(child.id, child);
        },
        remove: () => {
          const idx = appended.indexOf(el);
          if (idx >= 0) appended.splice(idx, 1);
          // The element leaves its parent too, the way a real one does.
          const parent = el.parentNode;
          if (parent && Array.isArray(parent.children)) {
            const at = parent.children.indexOf(el);
            if (at >= 0) parent.children.splice(at, 1);
          }
          el.parentNode = null;
          if (el.id) elements.delete(el.id);
        }
      };
      return el;
    }
  };
  return { doc, elements, appended };
}

/**
 * The overlay element, when it is there.
 *
 * The overlay functions hand back null when there is no page to draw on. The tests below are
 * about the case where there is one, so this narrows the type and keeps the assertions plain.
 */
function must<T>(value: T | null | undefined, what: string): T {
  assert.ok(value, what);
  return value;
}

/** The children of a container, as an array. An HTMLCollection is array-like, not an array. */
function kids(container: HTMLElement): HTMLElement[] {
  return Array.from(container.children) as HTMLElement[];
}

test('the overlay is injected once, with a container and a pointer', () => {
  const { doc, elements } = fakeDoc();

  const { container, pointer } = ensureCursorOverlay(null, null, doc);

  assert.ok(container, 'there is a container');
  assert.equal(container.id, 'scoutfox-cursor-container');
  assert.ok(pointer, 'there is a pointer');
  assert.equal(pointer.id, 'scoutfox-cursor-pointer');
  assert.equal(elements.get('scoutfox-cursor-container'), container);
  assert.match(pointer.innerHTML, /<svg/, 'the pointer is the fox shape');
});

test('the overlay is reused, not injected a second time', () => {
  const { doc, elements } = fakeDoc();

  const first = ensureCursorOverlay(null, null, doc);
  const second = ensureCursorOverlay(null, null, doc);

  assert.equal(second.container, first.container, 'the same container');
  assert.equal(second.pointer, first.pointer, 'the same pointer');
  assert.equal(elements.get('scoutfox-cursor-container'), first.container);
});

test('an overlay that is already on the page is taken over, not replaced', () => {
  const { doc } = fakeDoc();
  const first = ensureCursorOverlay(null, null, doc);

  // A second injection with the elements it finds on the page: same ones back.
  const second = ensureCursorOverlay(first.container, first.pointer, doc);
  assert.equal(second.container, first.container);
  assert.equal(second.pointer, first.pointer);
});

test('the overlay never takes a click: the user must still be able to use the page', () => {
  const { doc } = fakeDoc();
  const { container, pointer } = ensureCursorOverlay(null, null, doc);

  const box = must(container, 'there is a container');
  const tip = must(pointer, 'there is a pointer');
  assert.equal(box.style.pointerEvents, 'none', 'the container does not take clicks');
  assert.equal(tip.style.pointerEvents, 'none', 'the pointer does not take clicks');
  assert.equal(box.style.zIndex, '2147483647', 'and it is above the page');
});

test('the pointer moves to where it was told, and fades out again', async () => {
  const { doc } = fakeDoc();
  const { pointer } = ensureCursorOverlay(null, null, doc);
  const tip = must(pointer, 'there is a pointer');

  let timer: ReturnType<typeof setTimeout> | null = null;
  animateCursor(120, 240, tip, () => timer, (t) => { timer = t; });

  assert.equal(tip.style.opacity, '1', 'the pointer is visible while it moves');
  assert.equal(tip.style.transform, 'translate(120px, 240px) scale(1)');

  // The pointer fades on its own after a while, so it does not stay on the screen.
  await new Promise((r) => setTimeout(r, 2700));
  assert.equal(tip.style.opacity, '0', 'and it fades out again');
});

test('a second move replaces the first, so the pointer does not fade early', async () => {
  const { doc } = fakeDoc();
  const { pointer } = ensureCursorOverlay(null, null, doc);
  const tip = must(pointer, 'there is a pointer');

  let timer: ReturnType<typeof setTimeout> | null = null;
  animateCursor(10, 10, tip, () => timer, (t) => { timer = t; });
  await new Promise((r) => setTimeout(r, 100));
  animateCursor(200, 200, tip, () => timer, (t) => { timer = t; });

  assert.equal(tip.style.transform, 'translate(200px, 200px) scale(1)');
  assert.ok(timer, 'there is one timer, not two');
});

test('a click leaves a ripple, and the ripple goes away again', async () => {
  const { doc } = fakeDoc();
  const { container, pointer } = ensureCursorOverlay(null, null, doc);
  const box = must(container, 'there is a container to draw the ripple into');
  const tip = must(pointer, 'there is a pointer');

  showClickEffect(300, 400, box, tip, doc);

  // The ripple goes into the overlay container, so it is removed with the overlay.
  const ripple = kids(box).find((el) => el.className === 'scoutfox-click-ripple');
  const mark = must(ripple, 'there is a ripple');
  assert.equal(mark.style.left, '300px');
  assert.equal(mark.style.top, '400px');
  assert.equal(mark.style.pointerEvents, 'none', 'the ripple does not take clicks');

  await new Promise((r) => setTimeout(r, 600));
  assert.equal(
    kids(box).some((el) => el.className === 'scoutfox-click-ripple'),
    false,
    'the ripple is gone again'
  );
});

test('removing the overlay takes the container off the page', () => {
  const { doc, appended } = fakeDoc();
  const { container } = ensureCursorOverlay(null, null, doc);
  assert.equal(appended.includes(container), true);

  let cleared = false;
  removeCursorOverlay(container, () => { cleared = true; });

  assert.equal(cleared, true, 'the fade timer was cleared');
  assert.equal(appended.includes(container), false, 'the container is off the page');
});

test('a highlighted element gets its own style back', async () => {
  const el: any = { style: { outline: '1px solid blue', outlineOffset: '0px', transition: 'none' } };

  highlightElement(el);
  assert.equal(el.style.outline, '3px solid #ff7a00', 'the ring is on');

  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(el.style.outline, '1px solid blue', 'the own style is back');
  assert.equal(el.style.transition, 'none', 'and so is the transition');
});

test('an element highlighted twice keeps its own style, not the ring (BUG-29)', async () => {
  // The second highlight must not capture the orange ring as the "original" style: if it did,
  // the element would keep the ring forever.
  const el: any = { style: { outline: '1px solid blue', outlineOffset: '0px', transition: 'none' } };

  highlightElement(el);
  await new Promise((r) => setTimeout(r, 400));
  highlightElement(el);

  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(el.style.outline, '1px solid blue', 'the own style is back, not the ring');
});

test('nothing throws when there is no page to draw on', () => {
  const nothing = null as unknown as Document;

  assert.deepEqual(ensureCursorOverlay(null, null, nothing), { container: null, pointer: null });
  assert.doesNotThrow(() => showClickEffect(1, 2, null, null, nothing));
  assert.doesNotThrow(() => animateCursor(1, 2, null, () => null, () => {}));
  assert.doesNotThrow(() => highlightElement(null));
  assert.doesNotThrow(() => removeCursorOverlay(null, () => {}));
});
