import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const SRC = fs.readFileSync(new URL('../../content/actionExecutor.js', import.meta.url), 'utf8');

function createFakeDOM() {
  const elements = new Map<string, any>();
  const appendedToBody: any[] = [];

  const body: any = {
    appendChild: (el: any) => {
      appendedToBody.push(el);
      if (el.id) elements.set(el.id, el);
    }
  };

  const document: any = {
    body,
    documentElement: body,
    contains: (node: any) => appendedToBody.includes(node) || Array.from(elements.values()).includes(node),
    getElementById: (id: string) => elements.get(id) || null,
    createElement: (tag: string) => {
      const el: any = {
        tagName: tag.toUpperCase(),
        id: '',
        className: '',
        style: {},
        innerHTML: '',
        children: [],
        appendChild: (child: any) => {
          el.children.push(child);
          if (child.id) elements.set(child.id, child);
        },
        remove: () => {
          if (el.id) elements.delete(el.id);
          const idx = appendedToBody.indexOf(el);
          if (idx >= 0) appendedToBody.splice(idx, 1);
        }
      };
      return el;
    }
  };

  const window: any = {
    document,
    scrollY: 0,
    scrollX: 0
  };

  class FakeMouseEvent {
    type: string;
    constructor(type: string) { this.type = type; }
  }

  const fn = new Function('window', 'document', 'MouseEvent', `${SRC}\nreturn window.actionExecutorInstance;`);
  const executor = fn(window, document, FakeMouseEvent);

  return { executor, document, elements, appendedToBody };
}

test('ensureCursorOverlay creates container and SVG pointer overlay with safe attributes', () => {
  const { executor, elements } = createFakeDOM();

  executor.ensureCursorOverlay();

  const container = elements.get('scoutfox-cursor-container');
  assert.ok(container, 'container element must exist');
  assert.equal(container.style.position, 'fixed');
  assert.equal(container.style.pointerEvents, 'none');
  assert.equal(container.style.zIndex, '2147483647');

  const pointer = elements.get('scoutfox-cursor-pointer');
  assert.ok(pointer, 'pointer element must exist');
  assert.equal(pointer.style.pointerEvents, 'none');
  assert.equal(pointer.style.zIndex, '2147483647');
  assert.match(pointer.innerHTML, /<svg/i);
  assert.match(pointer.innerHTML, /#ff7a00/);
});

test('animateCursor moves cursor to coordinates and makes it visible', () => {
  const { executor, elements } = createFakeDOM();

  executor.animateCursor(120, 240);

  const pointer = elements.get('scoutfox-cursor-pointer');
  assert.ok(pointer);
  assert.equal(pointer.style.opacity, '1');
  assert.equal(pointer.style.transform, 'translate(120px, 240px) scale(1)');
});

test('showClickEffect creates expanding ripple ring and animates pointer press dip', () => {
  const { executor, elements } = createFakeDOM();

  executor.showClickEffect(200, 350);

  const pointer = elements.get('scoutfox-cursor-pointer');
  assert.ok(pointer);
  assert.equal(pointer.style.opacity, '1');
  assert.match(pointer.style.transform, /scale\(0\.82\)/);

  const container = elements.get('scoutfox-cursor-container');
  const ripple = container.children.find((c: any) => c.className === 'scoutfox-click-ripple');
  assert.ok(ripple, 'click ripple element must be created');
  assert.equal(ripple.style.position, 'fixed');
  assert.equal(ripple.style.left, '200px');
  assert.equal(ripple.style.top, '350px');
  assert.equal(ripple.style.borderRadius, '50%');
});

test('removeCursorOverlay cleans up container and resets state', () => {
  const { executor, elements } = createFakeDOM();

  executor.ensureCursorOverlay();
  assert.ok(elements.get('scoutfox-cursor-container'));

  executor.removeCursorOverlay();
  assert.equal(elements.get('scoutfox-cursor-container'), undefined);
});

test('highlightElement applies outline and outlineOffset to target', () => {
  const { executor } = createFakeDOM();
  const el: any = { style: {} };

  executor.highlightElement(el);

  assert.equal(el.style.outline, '3px solid #ff7a00');
  assert.equal(el.style.outlineOffset, '2px');
});
