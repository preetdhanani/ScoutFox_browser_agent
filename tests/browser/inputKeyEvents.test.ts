import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeChrome } from '../helpers/fakeChrome.ts';
import { CDPManager } from '../../src/background/browser/cdp.ts';
import { InputDispatcher } from '../../src/background/browser/input.ts';

// Chromium fires keypress (and so inserts a character or submits a form on Enter)
// only for a 'keyDown' that carries text. A 'rawKeyDown' with text is swallowed:
// Enter does not submit and a single character is not typed. Verified in a real
// Chromium with puppeteer-core; these tests pin the wire shape.

function setup(tag = 'input') {
  const keyEvents: any[] = [];
  const fc = fakeChrome({
    debugger: {
      commands: {
        'Emulation.setFocusEmulationEnabled': {},
        'Page.enable': {},
        'Input.dispatchMouseEvent': {},
        'Input.dispatchKeyEvent': (p: any) => { keyEvents.push(p); return {}; },
        'Input.insertText': {}
      }
    },
    tabs: { list: [{ id: 101, url: 'https://example.com' }] },
    scripting: { executeScript: [{ result: 800 }] },
    dom: {
      101: {
        RESOLVE_ELEMENT_POINT: () => ({ success: true, point: { x: 10, y: 10 }, tag, text: 'Search' }),
        EFFECT_PROBE_BEGIN: () => ({ success: true }),
        EFFECT_PROBE_END: () => ({ success: true, effect: 'value_set' })
      }
    }
  });
  (globalThis as any).chrome = fc.chrome;
  const dispatcher = new InputDispatcher(new CDPManager());
  return { dispatcher, keyEvents };
}

test('type with submit sends Enter as keyDown with text so the form submits', async () => {
  const { dispatcher, keyEvents } = setup();
  const res = await dispatcher.dispatchAction(101, { action: 'type', element_id: 4, text: 'laptops', submit: true });
  assert.equal(res.success, true);
  const enterDown = keyEvents.find((e) => e.key === 'Enter' && e.type !== 'keyUp');
  assert.equal(enterDown?.type, 'keyDown');
  assert.equal(enterDown?.text, '\r');
});

test('type select-all stays rawKeyDown and carries no text, so no character is inserted', async () => {
  const { dispatcher, keyEvents } = setup();
  await dispatcher.dispatchAction(101, { action: 'type', element_id: 4, text: 'laptops' });
  const selectAll = keyEvents.find((e) => e.commands?.includes('selectAll'));
  assert.equal(selectAll?.type, 'rawKeyDown');
  assert.equal(selectAll?.text, undefined);
  assert.equal(selectAll?.unmodifiedText, undefined);
});

test('press_key with a printable character sends keyDown with text', async () => {
  const { dispatcher, keyEvents } = setup();
  const res = await dispatcher.dispatchAction(101, { action: 'press_key', key: 'x' });
  assert.equal(res.success, true);
  const down = keyEvents.find((e) => e.type !== 'keyUp');
  assert.equal(down?.type, 'keyDown');
  assert.equal(down?.text, 'x');
});

test('press_key Enter sends keyDown with text', async () => {
  const { dispatcher, keyEvents } = setup();
  await dispatcher.dispatchAction(101, { action: 'press_key', key: 'Enter' });
  const down = keyEvents.find((e) => e.type !== 'keyUp');
  assert.equal(down?.type, 'keyDown');
  assert.equal(down?.text, '\r');
});

test('press_key without text (Tab, ArrowDown) keeps rawKeyDown', async () => {
  for (const key of ['Tab', 'ArrowDown', 'Escape']) {
    const { dispatcher, keyEvents } = setup();
    await dispatcher.dispatchAction(101, { action: 'press_key', key });
    const down = keyEvents.find((e) => e.type !== 'keyUp');
    assert.equal(down?.type, 'rawKeyDown', key);
    assert.equal(down?.text, undefined, key);
  }
});
