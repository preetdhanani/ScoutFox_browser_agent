/**
 * press_key and type without an element id: the key events that reach the page over CDP.
 *
 * An editor like CodeMirror only takes trusted input, and reads the modifiers off the key event.
 * So the wire shape is the contract: the modifiers bitmask on both events, no text while Ctrl,
 * Meta or Alt is held (a shortcut inserts nothing), text kept for Shift+Enter, the editing
 * commands for the shortcuts, and the code and key code of the physical key.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeChrome } from '../helpers/fakeChrome.ts';
import { CDPManager } from '../../src/background/browser/cdp.ts';
import { InputDispatcher, resolveKey, KEY_MODIFIER_BITS } from '../../src/background/browser/input.ts';

function detail(focusText: string | null, editable = true) {
  return {
    base: true, url: 'https://example.com', urlChanged: false,
    focus: { label: 'textbox "Code cell editor"', editable, caretLine: focusText, text: focusText },
    focusChanged: false, scroll: { x: 0, y: 0 }, scrollChanged: false, container: null,
    textHash: 'h', textChanged: false, added: '', removed: '', changedChars: 0
  };
}

function setup({ focus = { label: 'textbox "Code cell editor"', editable: true } as any, attach = undefined as any, fieldText = 'echo tarka' } = {}) {
  const sent: Array<{ method: string; params: any }> = [];
  const pageMessages: string[] = [];
  const record = (method: string) => (p: any) => { sent.push({ method, params: p }); return {}; };
  const fc = fakeChrome({
    debugger: {
      ...(attach ? { attach } : {}),
      commands: {
        'Emulation.setFocusEmulationEnabled': {},
        'Page.enable': {},
        'Input.dispatchMouseEvent': record('Input.dispatchMouseEvent'),
        'Input.dispatchKeyEvent': record('Input.dispatchKeyEvent'),
        'Input.insertText': record('Input.insertText')
      }
    },
    tabs: { list: [{ id: 101, url: 'https://example.com' }] },
    scripting: { executeScript: [{ result: 800 }] },
    dom: {
      101: {
        RESOLVE_ELEMENT_POINT: () => ({ success: true, point: { x: 10, y: 10 }, tag: 'input', text: 'Search' }),
        EFFECT_PROBE_BEGIN: () => { pageMessages.push('EFFECT_PROBE_BEGIN'); return { success: true, baseline: { url: 'https://example.com', focus } }; },
        EFFECT_PROBE_END: () => { pageMessages.push('EFFECT_PROBE_END'); return { success: true, effect: 'dom_changed', detail: detail(fieldText) }; },
        EXECUTE_ACTION: () => { pageMessages.push('EXECUTE_ACTION'); return { success: true, message: 'synthetic' }; }
      }
    }
  });
  (globalThis as any).chrome = fc.chrome;
  return { sent, pageMessages, keys: () => sent.filter((s) => s.method === 'Input.dispatchKeyEvent').map((s) => s.params) };
}

const noSleep = { sleep: async () => {} };

test('resolveKey: select_all is Meta+A on a Mac and Ctrl+A elsewhere, with the selectAll command and no text', () => {
  const mac = resolveKey('select_all', [], { mac: true });
  const other = resolveKey('select_all', [], { mac: false });
  assert.ok(!('error' in mac) && !('error' in other));
  if ('error' in mac || 'error' in other) return;
  assert.equal(mac.modifiers, KEY_MODIFIER_BITS.meta);
  assert.equal(other.modifiers, KEY_MODIFIER_BITS.ctrl);
  for (const k of [mac, other]) {
    assert.deepEqual(k.commands, ['selectAll']);
    assert.equal(k.text, undefined);
    assert.equal(k.code, 'KeyA');
    assert.equal(k.windowsVirtualKeyCode, 65);
  }
});

test('resolveKey: the modifiers bitmask is Alt=1, Ctrl=2, Meta=4, Shift=8', () => {
  const k = resolveKey('ArrowDown', ['alt', 'ctrl', 'meta', 'shift']);
  assert.ok(!('error' in k));
  if (!('error' in k)) assert.equal(k.modifiers, 15);
});

test('resolveKey: Shift+Enter keeps its text, a Ctrl or Meta shortcut drops it and carries the editing command', () => {
  const shiftEnter = resolveKey('Enter', ['shift']);
  assert.ok(!('error' in shiftEnter));
  if (!('error' in shiftEnter)) {
    assert.equal(shiftEnter.text, '\r');
    assert.equal(shiftEnter.modifiers, 8);
    assert.equal(shiftEnter.label, 'Shift+Enter');
  }
  const cases: Array<[string, string[], string]> = [
    ['c', ['ctrl'], 'copy'], ['x', ['meta'], 'cut'], ['v', ['ctrl'], 'paste'],
    ['z', ['ctrl'], 'undo'], ['z', ['ctrl', 'shift'], 'redo'], ['y', ['ctrl'], 'redo'], ['a', ['meta'], 'selectAll']
  ];
  for (const [key, mods, command] of cases) {
    const k = resolveKey(key, mods);
    assert.ok(!('error' in k), key);
    if ('error' in k) continue;
    assert.equal(k.text, undefined, `${mods.join('+')}+${key} inserts no character`);
    assert.deepEqual(k.commands, [command], `${mods.join('+')}+${key}`);
  }
  const alt = resolveKey('c', ['alt']);
  if (!('error' in alt)) {
    assert.equal(alt.text, undefined, 'an Alt shortcut inserts no character either');
    assert.equal(alt.commands, undefined, 'Alt+C is not copy');
  }
});

test('resolveKey: digits and punctuation get the code and key code of their physical key', () => {
  const expect: Array<[string, string, number]> = [
    ['5', 'Digit5', 53], ['0', 'Digit0', 48], ['/', 'Slash', 191], ['?', 'Slash', 191], ['-', 'Minus', 189],
    ['.', 'Period', 190], ['(', 'Digit9', 57], ['A', 'KeyA', 65], ['z', 'KeyZ', 90], [' ', 'Space', 32]
  ];
  for (const [key, code, vk] of expect) {
    const k = resolveKey(key);
    assert.ok(!('error' in k), key);
    if ('error' in k) continue;
    assert.equal(k.code, code, key);
    assert.equal(k.windowsVirtualKeyCode, vk, key);
    assert.equal(k.text, key, `${key} inserts itself`);
  }
});

test('resolveKey: key names are matched without case, and a wrong key or modifier is a clear error', () => {
  const enter = resolveKey('enter');
  assert.ok(!('error' in enter) && enter.key === 'Enter');
  const esc = resolveKey('Esc');
  assert.ok(!('error' in esc) && esc.key === 'Escape');
  const combo = resolveKey('Ctrl+A');
  assert.ok('error' in combo);
  if ('error' in combo) {
    assert.match(combo.error, /does not know the key "Ctrl\+A"/);
    assert.match(combo.error, /select_all/);
    assert.match(combo.error, /single printable character/);
    assert.match(combo.error, /modifiers \["ctrl"\]/);
  }
  const mod = resolveKey('a', ['cmd']);
  assert.ok('error' in mod && /modifier "cmd"/.test(mod.error));
  assert.ok('error' in resolveKey(''));
});

test('press_key: Shift+Enter goes out as a keyDown with text and the Shift bit on both events', async () => {
  const { keys } = setup();
  const res = await new InputDispatcher(new CDPManager(), { mac: false }).dispatchAction(101, { action: 'press_key', key: 'Enter', modifiers: ['shift'] }, noSleep);
  assert.equal(res.success, true);
  assert.equal(res.message, 'Pressed Shift+Enter');
  const [down, up] = keys();
  assert.equal(down.type, 'keyDown');
  assert.equal(down.text, '\r');
  assert.equal(down.modifiers, 8);
  assert.equal(up.type, 'keyUp');
  assert.equal(up.modifiers, 8);
  assert.ok(res.effectDetail, 'the probe facts travel with the result');
});

test('press_key: select_all goes out as rawKeyDown with the selectAll command and the platform modifier', async () => {
  for (const mac of [true, false]) {
    const { keys } = setup();
    await new InputDispatcher(new CDPManager(), { mac }).dispatchAction(101, { action: 'press_key', key: 'select_all' }, noSleep);
    const [down] = keys();
    assert.equal(down.type, 'rawKeyDown');
    assert.deepEqual(down.commands, ['selectAll']);
    assert.equal(down.modifiers, mac ? 4 : 2);
    assert.equal(down.text, undefined);
  }
});

test('press_key: when the debugger cannot attach it is an honest error, and no synthetic key is sent', async () => {
  const { pageMessages, keys } = setup({ attach: new Error('Cannot attach to this target.') });
  const res = await new InputDispatcher(new CDPManager()).dispatchAction(101, { action: 'press_key', key: 'Enter' }, noSleep);
  assert.equal(res.success, false);
  assert.match(res.error || '', /could not attach/);
  assert.match(res.error || '', /Nothing was pressed/);
  assert.equal(pageMessages.includes('EXECUTE_ACTION'), false, 'the synthetic fallback is never used');
  assert.equal(keys().length, 0);
});

test('type without element_id types into the focused editor: no click, selectAll then insertText, and the field is read back', async () => {
  const { sent, keys } = setup();
  const res = await new InputDispatcher(new CDPManager(), { mac: false }).dispatchAction(101, { action: 'type', text: 'echo tarka' }, noSleep);
  assert.equal(res.success, true, res.error);
  assert.equal(sent.some((s) => s.method === 'Input.dispatchMouseEvent'), false, 'nothing is clicked: the focus is already there');
  assert.deepEqual(keys()[0].commands, ['selectAll']);
  assert.deepEqual(sent.find((s) => s.method === 'Input.insertText')?.params, { text: 'echo tarka' });
  assert.equal(res.fieldText, 'echo tarka');
  assert.match(res.message || '', /the focused element \("textbox "Code cell editor""\)/);
});

test('type without element_id is refused when the page says nothing editable has focus', async () => {
  const { sent } = setup({ focus: { label: 'button "Run"', editable: false } });
  const res = await new InputDispatcher(new CDPManager()).dispatchAction(101, { action: 'type', text: 'x' }, noSleep);
  assert.equal(res.success, false);
  assert.match(res.error || '', /Nothing editable has focus \(focus is on button "Run"\)/);
  assert.equal(sent.some((s) => s.method === 'Input.insertText'), false);
});

test('type mode append moves the caret to the end instead of selecting all', async () => {
  const { keys } = setup();
  await new InputDispatcher(new CDPManager(), { mac: true }).dispatchAction(101, { action: 'type', element_id: 4, text: ' more', mode: 'append' }, noSleep);
  const prepare = keys()[0];
  assert.equal(prepare.type, 'rawKeyDown');
  assert.equal(prepare.key, 'End');
  assert.deepEqual(prepare.commands, ['moveToEndOfDocument']);
  assert.equal(prepare.modifiers, 4);
  assert.equal(keys().some((k) => k.commands?.includes('selectAll')), false);
});
