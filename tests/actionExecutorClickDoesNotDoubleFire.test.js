/**
 * Regression test for a closed-but-never-actually-fixed issue: doClick() dispatched a full
 * synthetic mouse-event sequence INCLUDING 'click', then also called el.click() - firing two
 * click events per requested click. On a checkbox or toggle button this flips the state on and
 * immediately back off; on a submit button it can double-submit a form.
 *
 * Fixed by dropping 'click' from the synthetic dispatch list and letting el.click() (which
 * fires its own proper click event, plus handles native defaults like checkbox toggling and
 * form submission) be the single source of the actual click.
 *
 * The executor is the TypeScript module (src/content/actionExecutor.ts, which builds the shipped
 * content/actionExecutor.js), run here against a minimal fake DOM. The MAIN-world net-recorder.js
 * is still an IIFE loaded with new Function in its own tests.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { ActionExecutor } from '../src/content/actionExecutor.ts';

function loadActionExecutor(fakeEl) {
  const dispatched = [];

  class FakeMouseEvent {
    constructor(type) { this.type = type; }
  }

  const fakeWindow = {
    domCompressor: { getElement: () => fakeEl },
    scrollY: 0,
    MouseEvent: FakeMouseEvent
  };

  const fakeDocument = {
    contains: (node) => node === fakeEl,
    createElement: () => ({ style: {}, appendChild() {}, remove() {} }),
    body: { appendChild() {}, contains: () => false },
    getElementById: () => null,
    querySelector: () => null
  };

  fakeEl.dispatchEvent = (event) => { dispatched.push(event.type); };
  fakeEl.scrollIntoView = () => {};
  fakeEl.style = {};
  fakeEl.getBoundingClientRect = () => ({ top: 0, bottom: 10, left: 0, right: 10 });

  const instance = new ActionExecutor(fakeDocument, fakeWindow);
  return { instance, dispatched };
}

test('doClick fires exactly one click, not two', () => {
  let clickCallCount = 0;
  const fakeEl = {
    click() { clickCallCount++; },
    tagName: 'BUTTON'
  };

  const { instance, dispatched } = loadActionExecutor(fakeEl);
  const result = instance.doClick(1);

  assert.equal(result.success, true);
  assert.equal(clickCallCount, 1, 'el.click() must be called exactly once');
  assert.ok(!dispatched.includes('click'),
    'a synthetic "click" MouseEvent must not ALSO be dispatched - el.click() already fires its own, so dispatching both fires two click events per requested click');
});

test('doClick still dispatches the realistic hover/press sequence before the click', () => {
  const fakeEl = { click() {}, tagName: 'BUTTON' };
  const { instance, dispatched } = loadActionExecutor(fakeEl);
  instance.doClick(1);

  assert.deepEqual(dispatched, ['mouseenter', 'mouseover', 'mousedown', 'mouseup'],
    'the hover/press sequence some listeners key off must still fire, just not a redundant click');
});

test('doClick falls back to a synthetic click only when el.click is not a function', () => {
  let dispatchedClick = false;
  const fakeEl = { tagName: 'g' }; // no .click() - e.g. an SVG element in an older engine
  const { instance, dispatched } = loadActionExecutor(fakeEl);
  const result = instance.doClick(1);

  assert.equal(result.success, true);
  assert.ok(dispatched.includes('click'),
    'without a native click() to rely on, a synthetic click must still be dispatched as a fallback');
});
