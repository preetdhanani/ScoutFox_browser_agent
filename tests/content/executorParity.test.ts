import test from 'node:test';
import assert from 'node:assert/strict';
import { ActionExecutor } from '../../src/content/actionExecutor.ts';
import { ACCENT_COLOR } from '../../src/content/badges.ts';

test('1. renderBadges and removeBadges manage floating badges correctly', () => {
  const elements = new Map<number, any>();
  const btn1 = {
    getBoundingClientRect: () => ({ top: 10, left: 20, width: 80, height: 30, right: 100, bottom: 40 })
  };
  elements.set(1, btn1);

  const createdElements: any[] = [];
  const bodyChildren: any[] = [];
  const body = {
    appendChild: (el: any) => bodyChildren.push(el),
    contains: (el: any) => bodyChildren.includes(el)
  };

  const fakeDocument = {
    body,
    getElementById: (id: string) => bodyChildren.find((el) => el.id === id) || null,
    createElement: (tag: string) => {
      const el: any = {
        tagName: tag.toUpperCase(),
        style: {},
        children: [],
        appendChild: (child: any) => el.children.push(child),
        remove: () => {
          const idx = bodyChildren.indexOf(el);
          if (idx >= 0) bodyChildren.splice(idx, 1);
        }
      };
      createdElements.push(el);
      return el;
    }
  };

  const fakeWindow = {
    domCompressor: { getElement: (id: number) => elements.get(id) || null },
    scrollY: 100,
    scrollX: 50
  };

  const executor = new ActionExecutor(fakeDocument as any, fakeWindow as any);
  executor.renderBadges([{ id: 1 }]);

  assert.ok(executor.badgeContainer, 'badgeContainer must be created');
  assert.equal(executor.badgeContainer!.id, 'scoutfox-badge-container');
  assert.equal(executor.badgeContainer!.style.zIndex, '2147483647');

  const children = (executor.badgeContainer as any).children;
  assert.equal(children.length, 1);
  const badge = children[0];
  assert.equal(badge.className, 'scoutfox-badge');
  assert.equal(badge.textContent, '1');
  assert.equal(badge.style.backgroundColor, ACCENT_COLOR);
  assert.equal(badge.style.top, '110px'); // top 10 + scrollY 100
  assert.equal(badge.style.left, '70px'); // left 20 + scrollX 50

  executor.removeBadges();
  assert.equal(executor.badgeContainer, null);
  assert.equal(bodyChildren.length, 0);
});

test('2. ensureCursorOverlay, animateCursor, and showClickEffect produce correct overlay structure', () => {
  const bodyChildren: any[] = [];
  const body = {
    appendChild: (el: any) => bodyChildren.push(el),
    contains: (el: any) => bodyChildren.includes(el)
  };

  const fakeDocument = {
    body,
    documentElement: body,
    getElementById: (id: string) => bodyChildren.find((el) => el.id === id) || null,
    createElement: (tag: string) => {
      const el: any = {
        tagName: tag.toUpperCase(),
        style: {},
        children: [],
        appendChild: (child: any) => {
          el.children.push(child);
          bodyChildren.push(child);
        },
        remove: () => {
          const idx = bodyChildren.indexOf(el);
          if (idx >= 0) bodyChildren.splice(idx, 1);
        }
      };
      return el;
    }
  };

  const executor = new ActionExecutor(fakeDocument as any, { scrollY: 0 } as any);
  executor.ensureCursorOverlay();

  assert.ok(executor.cursorContainer);
  assert.equal(executor.cursorContainer!.id, 'scoutfox-cursor-container');
  assert.ok(executor.cursorEl);
  assert.equal(executor.cursorEl!.id, 'scoutfox-cursor-pointer');
  assert.match(executor.cursorEl!.innerHTML, /<svg/);
  assert.match(executor.cursorEl!.innerHTML, /#ff7a00/);

  executor.animateCursor(150, 250);
  assert.equal(executor.cursorEl!.style.opacity, '1');
  assert.match(executor.cursorEl!.style.transform, /translate\(150px, 250px\)/);

  executor.showClickEffect(150, 250);
  assert.ok(executor.cursorFadeTimer);

  executor.removeCursorOverlay();
  assert.equal(executor.cursorContainer, null);
  assert.equal(executor.cursorEl, null);
  assert.equal(executor.cursorFadeTimer, null);
});

test('3. doClick dispatches PointerEvent and MouseEvent sequence when PointerEvent is available', () => {
  const dispatched: string[] = [];

  class MockPointerEvent {
    type: string;
    clientX: number;
    clientY: number;
    constructor(type: string, init: any = {}) {
      this.type = type;
      this.clientX = init.clientX;
      this.clientY = init.clientY;
    }
  }

  class MockMouseEvent {
    type: string;
    clientX: number;
    clientY: number;
    constructor(type: string, init: any = {}) {
      this.type = type;
      this.clientX = init.clientX;
      this.clientY = init.clientY;
    }
  }

  let clicked = false;
  const btn = {
    tagName: 'BUTTON',
    getBoundingClientRect: () => ({ left: 100, top: 200, width: 50, height: 20 }),
    dispatchEvent: (ev: any) => dispatched.push(ev.type),
    click: () => { clicked = true; },
    scrollIntoView: () => {},
    focus: () => {},
    style: {}
  };

  const fakeWindow = {
    domCompressor: { getElement: () => btn },
    scrollY: 0,
    PointerEvent: MockPointerEvent,
    MouseEvent: MockMouseEvent
  };

  const fakeDocument = {
    contains: () => true,
    createElement: () => ({ style: {}, appendChild: () => {}, remove: () => {} }),
    body: { appendChild: () => {}, contains: () => false },
    getElementById: () => null
  };

  const executor = new ActionExecutor(fakeDocument as any, fakeWindow as any);
  const res = executor.doClick(1);

  assert.equal(res.success, true);
  assert.equal(clicked, true);
  // PointerEvents fire first, then MouseEvents
  assert.ok(dispatched.includes('pointerenter'));
  assert.ok(dispatched.includes('pointerover'));
  assert.ok(dispatched.includes('pointerdown'));
  assert.ok(dispatched.includes('pointerup'));
  assert.ok(dispatched.includes('mouseenter'));
  assert.ok(dispatched.includes('mouseover'));
  assert.ok(dispatched.includes('mousedown'));
  assert.ok(dispatched.includes('mouseup'));
});

test('4. setFieldValue handles select, input/textarea via prototype setter, and contenteditable', () => {
  const executor = new ActionExecutor();

  // Select element
  const selectDispatched: string[] = [];
  const selectEl = {
    tagName: 'SELECT',
    value: 'opt1',
    options: [
      { value: 'opt1', textContent: 'Option 1' },
      { value: 'opt2', textContent: 'Option 2' }
    ],
    dispatchEvent: (ev: any) => selectDispatched.push(ev.type)
  };
  const selRes = executor.setFieldValue(selectEl as any, 'Option 2');
  assert.equal(selRes.success, true);
  assert.equal(selectEl.value, 'opt2');
  assert.deepEqual(selectDispatched, ['input', 'change']);

  // Missing select option returns error
  const selMissing = executor.setFieldValue(selectEl as any, 'Nonexistent');
  assert.equal(selMissing.success, false);
  assert.match(selMissing.error!, /No option matching "Nonexistent"/);

  // Contenteditable
  const editDispatched: string[] = [];
  const editEl = {
    tagName: 'DIV',
    isContentEditable: true,
    textContent: '',
    dispatchEvent: (ev: any) => editDispatched.push(ev.type)
  };
  const editRes = executor.setFieldValue(editEl as any, 'Hello world');
  assert.equal(editRes.success, true);
  assert.equal(editEl.textContent, 'Hello world');
  assert.deepEqual(editDispatched, ['input', 'change']);

  // Unsupported element
  const spanEl = {
    tagName: 'SPAN',
    getAttribute: () => null
  };
  const spanRes = executor.setFieldValue(spanEl as any, 'Text');
  assert.equal(spanRes.success, false);
  assert.match(spanRes.error!, /cannot be typed into/);
});

test('5. doBrowserBatch enforces step bounds, forbidden actions, and accurate error reporting', async () => {
  const fakeWindow = {
    location: { href: 'https://example.com/' }
  };
  const executor = new ActionExecutor(undefined, fakeWindow as any);

  // Empty steps
  const emptyRes = await executor.doBrowserBatch([]);
  assert.equal(emptyRes.success, false);
  assert.match(emptyRes.error, /non-empty "steps"/);

  // Exceeds 8 steps
  const tooMany = Array.from({ length: 9 }, () => ({ action: 'scroll' }));
  const tooManyRes = await executor.doBrowserBatch(tooMany);
  assert.equal(tooManyRes.success, false);
  assert.match(tooManyRes.error, /maximum allowed 8 steps/);

  // Forbidden action in batch
  const forbiddenRes = await executor.doBrowserBatch([{ action: 'navigate', url: 'https://other.com' }]);
  assert.equal(forbiddenRes.success, false);
  assert.equal(forbiddenRes.results[0].ok, false);
  assert.match(forbiddenRes.results[0].error, /is forbidden inside browser_batch/);
});
