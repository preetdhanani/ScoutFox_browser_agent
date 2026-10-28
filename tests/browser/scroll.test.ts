/**
 * scroll: a trusted mouse wheel at a point of the box to move, then a measurement of that box.
 *
 * The old scroll called window.scrollBy and always answered "Scrolled". On an app whose page does
 * not scroll (JupyterLab, Gmail) that moved nothing and still said it did, and the model scrolled
 * five times in a row. The contract here: the wheel goes to the point the page picked, the result
 * is the measured movement, a wheel that moved nothing falls back to a direct scroll of the same
 * box, and a box at its edge is not scrolled at all and says so.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeChrome } from '../helpers/fakeChrome.ts';
import { CDPManager } from '../../src/background/browser/cdp.ts';
import { InputDispatcher } from '../../src/background/browser/input.ts';
import { scrollResultText } from '../../src/background/mcp/server.ts';
import { pickScrollTarget, positionOf, scrollBoxAround, settledPosition, stepOf, labelOfBox } from '../../src/content/scrollMeasure.ts';

/** One scroll box on a fake page: its top, its end, and whether a wheel moves it. */
function setup({ top = 0, max = 3000, wheelMoves = true, attach = undefined as any } = {}) {
  const box = { top, max, height: 800 };
  const wheels: any[] = [];
  const asked: string[] = [];
  const position = () => ({ top: box.top, max: box.max, height: box.height, atTop: box.top <= 1, atBottom: box.top >= box.max - 1 });
  const moveBy = (delta: number) => { box.top = Math.min(box.max, Math.max(0, box.top + delta)); };
  const fc = fakeChrome({
    debugger: {
      ...(attach ? { attach } : {}),
      commands: {
        'Emulation.setFocusEmulationEnabled': {},
        'Page.enable': {},
        'Input.dispatchMouseEvent': (p: any) => {
          wheels.push(p);
          if (p.type === 'mouseWheel' && wheelMoves) moveBy(p.deltaY);
          return {};
        }
      }
    },
    tabs: { list: [{ id: 101, url: 'https://lab.example.com/notebook' }] },
    scripting: { executeScript: [{ result: 800 }] },
    dom: {
      101: {
        EFFECT_PROBE_BEGIN: () => ({ success: true, baseline: { url: 'https://lab.example.com/notebook', focus: null } }),
        EFFECT_PROBE_END: () => ({ success: true, effect: 'dom_changed' }),
        EXECUTE_ACTION: (message: any) => {
          const payload = message.payload;
          asked.push(payload.action);
          if (payload.action === 'scroll_target') return { success: true, result: { point: { x: 400, y: 300 }, label: 'the "Notebook cells" panel', step: 640, ...position() } };
          if (payload.action === 'scroll_measure') return { success: true, result: position() };
          if (payload.action === 'scroll_fallback') { moveBy(payload.delta); return { success: true, result: position() }; }
          return { success: false, error: `unexpected ${payload.action}` };
        }
      }
    }
  });
  (globalThis as any).chrome = fc.chrome;
  return { box, wheels, asked };
}

test('scroll turns the mouse wheel at the point the page picked, and reports the measured movement', async () => {
  const page = setup();
  const res: any = await new InputDispatcher(new CDPManager()).dispatchAction(101, { action: 'scroll', direction: 'down' });
  assert.equal(res.success, true);
  assert.equal(res.via, 'cdp', 'a trusted wheel, not a synthetic scroll');
  assert.deepEqual(page.wheels.filter((w) => w.type === 'mouseWheel'), [{ type: 'mouseWheel', x: 400, y: 300, deltaX: 0, deltaY: 640 }]);
  assert.equal(res.result.moved, 640);
  assert.equal(res.result.label, 'the "Notebook cells" panel');
  assert.equal(res.result.fallback, false);
  assert.deepEqual(page.asked, ['scroll_target', 'scroll_measure'], 'no fallback when the wheel moved the box');
  assert.equal(scrollResultText('down', res.result), 'Scrolled the "Notebook cells" panel down 640px, now at 640 of 3000px.');
});

test('a wheel that moved nothing falls back to a direct scroll of the same box, and says so', async () => {
  const page = setup({ wheelMoves: false });
  const res: any = await new InputDispatcher(new CDPManager()).dispatchAction(101, { action: 'scroll', direction: 'down' });
  assert.equal(res.success, true);
  assert.equal(res.via, 'synthetic');
  assert.equal(res.result.moved, 640);
  assert.equal(res.result.fallback, true);
  assert.deepEqual(page.asked, ['scroll_target', 'scroll_measure', 'scroll_fallback']);
  assert.match(scrollResultText('down', res.result), /down 640px.*the mouse wheel did not move it, so it was scrolled directly/);
});

test('a box already at its edge is not scrolled, and the result says "Did not move" with the reason', async () => {
  const page = setup({ top: 3000 });
  const res: any = await new InputDispatcher(new CDPManager()).dispatchAction(101, { action: 'scroll', direction: 'down' });
  assert.equal(res.success, true);
  assert.equal(res.result.moved, 0);
  assert.equal(page.wheels.length, 0, 'no wheel is sent to a box that cannot move that way');
  assert.equal(scrollResultText('down', res.result), 'Did not move: already at the bottom of the "Notebook cells" panel.');
  // Up still works from the bottom.
  const up: any = await new InputDispatcher(new CDPManager()).dispatchAction(101, { action: 'scroll', direction: 'up' });
  assert.equal(up.result.moved, -640);
  assert.match(scrollResultText('up', up.result), /^Scrolled the "Notebook cells" panel up 640px, now at 2360 of 3000px\.$/);
});

test('the last step stops at the end and says it reached the bottom', async () => {
  setup({ top: 2800 });
  const res: any = await new InputDispatcher(new CDPManager()).dispatchAction(101, { action: 'scroll', direction: 'down' });
  assert.equal(res.result.moved, 200);
  assert.equal(scrollResultText('down', res.result), 'Scrolled the "Notebook cells" panel down 200px, now at 3000 of 3000px, the bottom.');
});

test('without the debugger the box is scrolled directly and measured, never a fake success', async () => {
  const page = setup({ attach: () => { throw new Error('Another debugger is already attached'); } });
  const res: any = await new InputDispatcher(new CDPManager()).dispatchAction(101, { action: 'scroll', direction: 'down' });
  assert.equal(res.success, true);
  assert.equal(res.via, 'synthetic');
  assert.match(res.syntheticReason, /could not attach/);
  assert.equal(res.result.moved, 640);
  assert.equal(page.wheels.length, 0);
});

test('a box that will not move at all is reported as not scrollable, with the way out', () => {
  const text = scrollResultText('down', { moved: 0, label: 'the page', top: 0, max: 0, atTop: true, atBottom: true });
  assert.match(text, /^Did not move: already at the bottom of the page\./);
  const stuck = scrollResultText('down', { moved: 0, label: 'the scroll area #list', top: 100, max: 900, atTop: false, atBottom: false });
  assert.match(stuck, /^Did not move: the scroll area #list did not scroll\. Give scroll an element_id/);
  assert.match(scrollResultText('down', null), /unknown/);
});

// ---- the content side: which box, where it is ----------------------------------------------------

/** A minimal element: a box with a scroll position and an overflow style. */
function el(name: string, { overflowY = 'visible', scrollHeight = 100, clientHeight = 100, rect = { left: 0, top: 0, right: 100, bottom: 100 }, parent = null as any, label = '' } = {}) {
  return {
    tagName: 'DIV', id: name, className: '', parentElement: parent, scrollTop: 0, scrollHeight, clientHeight, overflowY,
    getAttribute: (n: string) => (n === 'aria-label' ? label || null : null),
    getBoundingClientRect: () => ({ ...rect, width: rect.right - rect.left, height: rect.bottom - rect.top }),
    getRootNode: () => null,
    ownerDocument: null
  } as any;
}

function page({ windowScrolls = false, elements = [] as any[] } = {}) {
  const html = { tagName: 'HTML', scrollHeight: windowScrolls ? 4000 : 800, overflowY: windowScrolls ? 'visible' : 'hidden' } as any;
  const body = { tagName: 'BODY', overflowY: windowScrolls ? 'visible' : 'hidden' } as any;
  const doc = { documentElement: html, body, scrollingElement: html, querySelectorAll: () => elements } as any;
  const win = { innerWidth: 1280, innerHeight: 800, scrollY: 0, getComputedStyle: (e: any) => ({ overflowY: e.overflowY }) } as any;
  return { doc, win };
}

test('with nothing named, the largest visible scrolling panel is scrolled when the page itself does not scroll', () => {
  const small = el('code', { overflowY: 'auto', scrollHeight: 900, clientHeight: 200, rect: { left: 0, top: 0, right: 300, bottom: 200 } });
  const panel = el('cells', { overflowY: 'auto', scrollHeight: 9000, clientHeight: 700, rect: { left: 300, top: 100, right: 1280, bottom: 800 }, label: 'Notebook cells' });
  const { doc, win } = page({ elements: [small, panel] });
  const picked = pickScrollTarget(doc, win, {});
  assert.equal(picked.box, panel);
  assert.deepEqual(picked.point, { x: 790, y: 450 }, 'the wheel goes to the middle of the panel');
  assert.equal(picked.label, 'the "Notebook cells" panel');
});

test('on a page that scrolls, the page wins over a small scrolling box', () => {
  const small = el('code', { overflowY: 'auto', scrollHeight: 900, clientHeight: 200, rect: { left: 0, top: 0, right: 300, bottom: 200 } });
  const { doc, win } = page({ windowScrolls: true, elements: [small] });
  const picked = pickScrollTarget(doc, win, {});
  assert.equal(picked.box, null);
  assert.equal(picked.label, 'the page');
  assert.deepEqual(picked.point, { x: 640, y: 400 });
});

test('an element is scrolled by the box that holds it, and a point by the box under it', () => {
  const panel = el('list', { overflowY: 'scroll', scrollHeight: 14000, clientHeight: 700, rect: { left: 0, top: 50, right: 600, bottom: 750 } });
  const row = el('row', { parent: panel, rect: { left: 0, top: 60, right: 600, bottom: 90 } });
  const { doc, win } = page({ elements: [panel, row] });
  assert.equal(scrollBoxAround(row, doc, win), panel);
  const byElement = pickScrollTarget(doc, win, { element: row });
  assert.equal(byElement.box, panel);
  assert.deepEqual(byElement.point, { x: 300, y: 75 });
  const byPoint = pickScrollTarget(doc, win, { point: { x: 100, y: 500 }, hit: row });
  assert.equal(byPoint.box, panel);
  assert.deepEqual(byPoint.point, { x: 100, y: 500 });
  assert.equal(labelOfBox(panel), 'the scroll area #list');
});

test('a position knows its edges, and one step is most of the visible height', () => {
  const panel = el('cells', { overflowY: 'auto', scrollHeight: 3800, clientHeight: 800 });
  const { doc, win } = page();
  assert.deepEqual(positionOf(panel, doc, win), { top: 0, max: 3000, height: 800, atTop: true, atBottom: false });
  panel.scrollTop = 3000;
  assert.equal(positionOf(panel, doc, win).atBottom, true);
  assert.equal(stepOf(positionOf(panel, doc, win)), 640);
});

test('the measurement waits until the box stops moving (a wheel scroll can animate)', async () => {
  const tops = [0, 200, 450, 640, 640, 640, 640, 640, 640, 640];
  let i = 0;
  let clock = 0;
  const settled = await settledPosition(
    () => ({ top: tops[Math.min(i++, tops.length - 1)], max: 3000, height: 800, atTop: false, atBottom: false }),
    { quietMs: 100, maxMs: 2000, everyMs: 40, sleep: async (ms) => { clock += ms; }, now: () => clock }
  );
  assert.equal(settled.top, 640);
});
