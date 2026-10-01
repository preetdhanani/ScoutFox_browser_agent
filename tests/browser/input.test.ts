import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeChrome } from '../helpers/fakeChrome.ts';
import { CDPManager } from '../../src/background/browser/cdp.ts';
import { InputDispatcher } from '../../src/background/browser/input.ts';

test('InputDispatcher: click dispatches CDP mouse sequence and returns via cdp', async () => {
  const sentMessages: any[] = [];
  const cdpCommands: any[] = [];

  const fc = fakeChrome({
    debugger: {
      commands: {
        'Emulation.setFocusEmulationEnabled': {},
        'Input.dispatchMouseEvent': (params: any) => {
          cdpCommands.push(params);
          return {};
        }
      }
    },
    tabs: { list: [{ id: 101, url: 'https://example.com' }] },
    scripting: { executeScript: [{ result: 800 }] },
    dom: {
      101: {
        RESOLVE_ELEMENT_POINT: (msg: any) => {
          sentMessages.push(msg);
          return {
            success: true,
            point: { x: 150, y: 250 },
            tag: 'button',
            text: 'Submit Order'
          };
        },
        EFFECT_PROBE_BEGIN: () => ({ success: true }),
        EFFECT_PROBE_END: () => ({ success: true, effect: 'dom_changed' })
      }
    }
  });
  (globalThis as any).chrome = fc.chrome;

  const cdp = new CDPManager();
  const dispatcher = new InputDispatcher(cdp);

  const res = await dispatcher.dispatchAction(101, {
    action: 'click',
    element_id: 5
  }, { docId: 'doc-123' });

  assert.equal(res.success, true);
  assert.equal(res.via, 'cdp');
  assert.equal(res.label, 'Submit Order');
  assert.equal(res.effect, 'dom_changed');
  assert.match(res.message || '', /Submit Order/);

  // Check mouse event sequence: move -> press -> release
  assert.equal(cdpCommands.length, 3);
  assert.equal(cdpCommands[0]?.type, 'mouseMoved');
  assert.equal(cdpCommands[0]?.x, 150);
  assert.equal(cdpCommands[0]?.y, 250);
  assert.equal(cdpCommands[1]?.type, 'mousePressed');
  assert.equal(cdpCommands[1]?.button, 'left');
  assert.equal(cdpCommands[2]?.type, 'mouseReleased');
  assert.equal(cdpCommands[2]?.button, 'left');
});

test('InputDispatcher: click ensures mouseReleased if aborted after mousePressed', async () => {
  const cdpCommands: any[] = [];
  const controller = new AbortController();

  const fc = fakeChrome({
    debugger: {
      commands: {
        'Emulation.setFocusEmulationEnabled': {},
        'Input.dispatchMouseEvent': (params: any) => {
          cdpCommands.push(params);
          if (params.type === 'mousePressed') {
            // Abort immediately after mouse pressed
            controller.abort();
          }
          return {};
        }
      }
    },
    tabs: { list: [{ id: 101, url: 'https://example.com' }] },
    scripting: { executeScript: [{ result: 800 }] },
    dom: {
      101: {
        RESOLVE_ELEMENT_POINT: () => ({
          success: true,
          point: { x: 100, y: 100 },
          tag: 'div',
          text: 'Box'
        }),
        EFFECT_PROBE_BEGIN: () => ({ success: true }),
        EFFECT_PROBE_END: () => ({ success: true, effect: 'none' })
      }
    }
  });
  (globalThis as any).chrome = fc.chrome;

  const cdp = new CDPManager();
  const dispatcher = new InputDispatcher(cdp);

  const res = await dispatcher.dispatchAction(101, {
    action: 'click',
    element_id: 1
  }, { signal: controller.signal });

  assert.equal(res.success, false);
  assert.match(res.error || '', /aborted/i);

  // mouseReleased must have been sent in finally block!
  const released = cdpCommands.find((c) => c.type === 'mouseReleased');
  assert.ok(released, 'mouseReleased must be sent even on mid-step abort');
});

test('InputDispatcher: click reports obscuredBy error when covered', async () => {
  const fc = fakeChrome({
    debugger: {
      commands: { 'Emulation.setFocusEmulationEnabled': {} }
    },
    tabs: { list: [{ id: 101, url: 'https://example.com' }] },
    scripting: { executeScript: [{ result: 800 }] },
    dom: {
      101: {
        RESOLVE_ELEMENT_POINT: () => ({
          success: false,
          obscuredBy: 'div.cookie-modal',
          error: 'Element [3] is covered by <div.cookie-modal>.'
        })
      }
    }
  });
  (globalThis as any).chrome = fc.chrome;

  const cdp = new CDPManager();
  const dispatcher = new InputDispatcher(cdp);

  const res = await dispatcher.dispatchAction(101, {
    action: 'click',
    element_id: 3
  });

  assert.equal(res.success, false);
  assert.equal(res.obscuredBy, 'div.cookie-modal');
  assert.match(res.error || '', /covered by <div\.cookie-modal>/);
  assert.equal(res.via, 'cdp');
});

test('InputDispatcher: click on select element falls back to synthetic', async () => {
  let syntheticCalled = false;

  const fc = fakeChrome({
    debugger: {
      commands: { 'Emulation.setFocusEmulationEnabled': {} }
    },
    tabs: { list: [{ id: 101, url: 'https://example.com' }] },
    scripting: { executeScript: [{ result: 800 }] },
    dom: {
      101: {
        RESOLVE_ELEMENT_POINT: () => ({
          success: true,
          point: { x: 50, y: 50 },
          tag: 'select',
          text: 'Country'
        }),
        EXECUTE_ACTION: (msg: any) => {
          syntheticCalled = true;
          return { success: true, message: 'Synthetic select click' };
        }
      }
    }
  });
  (globalThis as any).chrome = fc.chrome;

  const cdp = new CDPManager();
  const dispatcher = new InputDispatcher(cdp);

  const res = await dispatcher.dispatchAction(101, {
    action: 'click',
    element_id: 2
  });

  assert.equal(res.success, true);
  assert.equal(res.via, 'synthetic');
  assert.equal(syntheticCalled, true);
});

test('InputDispatcher: type uses CDP focus, selectAll, insertText and Enter submit', async () => {
  const cdpEvents: any[] = [];

  const fc = fakeChrome({
    debugger: {
      commands: {
        'Emulation.setFocusEmulationEnabled': {},
        'Input.dispatchMouseEvent': (p: any) => { cdpEvents.push({ method: 'mouse', ...p }); return {}; },
        'Input.dispatchKeyEvent': (p: any) => { cdpEvents.push({ method: 'key', ...p }); return {}; },
        'Input.insertText': (p: any) => { cdpEvents.push({ method: 'insertText', ...p }); return {}; }
      }
    },
    tabs: { list: [{ id: 101, url: 'https://example.com' }] },
    scripting: { executeScript: [{ result: 800 }] },
    dom: {
      101: {
        RESOLVE_ELEMENT_POINT: () => ({
          success: true,
          point: { x: 200, y: 100 },
          tag: 'input',
          text: 'Search box'
        }),
        EFFECT_PROBE_BEGIN: () => ({ success: true }),
        EFFECT_PROBE_END: () => ({ success: true, effect: 'value_set' })
      }
    }
  });
  (globalThis as any).chrome = fc.chrome;

  const cdp = new CDPManager();
  const dispatcher = new InputDispatcher(cdp);

  const res = await dispatcher.dispatchAction(101, {
    action: 'type',
    element_id: 4,
    text: 'Framework 16',
    submit: true
  });

  assert.equal(res.success, true);
  assert.equal(res.via, 'cdp');
  assert.equal(res.submitted, true);
  assert.equal(res.effect, 'value_set');

  // Verify sequence:
  // 1. Mouse click to focus
  assert.ok(cdpEvents.some((e) => e.method === 'mouse' && e.type === 'mousePressed'));
  // 2. selectAll key event
  assert.ok(cdpEvents.some((e) => e.method === 'key' && e.commands?.includes('selectAll')));
  // 3. insertText
  const insert = cdpEvents.find((e) => e.method === 'insertText');
  assert.equal(insert?.text, 'Framework 16');
  // 4. Enter key event
  assert.ok(cdpEvents.some((e) => e.method === 'key' && e.key === 'Enter'));
});

test('InputDispatcher: select action routes to synthetic fallback', async () => {
  let syntheticPayload: any = null;

  const fc = fakeChrome({
    debugger: true,
    tabs: { list: [{ id: 101, url: 'https://example.com' }] },
    dom: {
      101: {
        EXECUTE_ACTION: (msg: any) => {
          syntheticPayload = msg.payload;
          return { success: true, message: 'Selected Option B' };
        }
      }
    }
  });
  (globalThis as any).chrome = fc.chrome;

  const cdp = new CDPManager();
  const dispatcher = new InputDispatcher(cdp);

  const res = await dispatcher.dispatchAction(101, {
    action: 'select',
    element_id: 7,
    value: 'Option B'
  });

  assert.equal(res.success, true);
  assert.equal(res.via, 'synthetic');
  assert.equal(syntheticPayload?.action, 'select');
  assert.equal(syntheticPayload?.value, 'Option B');
});

test('InputDispatcher: falls back to synthetic when user detached debugger', async () => {
  let syntheticCalled = false;

  const fc = fakeChrome({
    debugger: {
      commands: { 'Emulation.setFocusEmulationEnabled': {} }
    },
    tabs: { list: [{ id: 101, url: 'https://example.com' }] },
    scripting: { executeScript: [{ result: 800 }] },
    dom: {
      101: {
        EXECUTE_ACTION: () => {
          syntheticCalled = true;
          return { success: true, message: 'Synthetic clicked' };
        }
      }
    }
  });
  (globalThis as any).chrome = fc.chrome;

  const cdp = new CDPManager();
  await cdp.attach(101);
  // User cancels yellow bar
  fc.debugger.detach(101, 'canceled_by_user');
  assert.equal(cdp.isUserDetached(101), true);

  const dispatcher = new InputDispatcher(cdp);
  const res = await dispatcher.dispatchAction(101, {
    action: 'click',
    element_id: 1
  });

  assert.equal(res.success, true);
  assert.equal(res.via, 'synthetic');
  assert.equal(syntheticCalled, true);
});
