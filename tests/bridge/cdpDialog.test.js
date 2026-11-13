// Tests for the CDP JavaScript-dialog auto-dismiss: a page opening alert/confirm/prompt must
// not hang the debugger, and the onDialogOpening listener must be told.

import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeChrome } from '../helpers/fakeChrome.ts';
import { CDPManager } from '../../src/background/browser/cdp.ts';

async function setup() {
  const fc = fakeChrome({
    debugger: {
      commands: {
        'Emulation.setFocusEmulationEnabled': {},
        'Page.enable': {},
        'Page.handleJavaScriptDialog': {},
      },
    },
    tabs: { list: [{ id: 101, url: 'https://example.com' }] },
    scripting: { executeScript: [{ result: 800 }] },
  });
  const restore = fc.install();
  const cdp = new CDPManager();
  await cdp.attach(101);
  return { fc, cdp, restore };
}

test('a JavaScript dialog is auto-dismissed with Page.handleJavaScriptDialog', async () => {
  const { fc, cdp, restore } = await setup();
  try {
    const seen = [];
    cdp.onDialogOpening((tabId, type, message) => seen.push({ tabId, type, message }));
    // The page opens an alert().
    fc.debugger.event(101, 'Page.javascriptDialogOpening', { type: 'alert', message: 'hello' });
    await fc.settle();
    const handled = fc.callsTo('debugger.sendCommand').filter((c) => c.args[1] === 'Page.handleJavaScriptDialog');
    assert.equal(handled.length, 1, 'the dialog was answered');
    assert.deepEqual(handled[0].args[2], { accept: true }, 'alert is accepted');
    assert.deepEqual(seen, [{ tabId: 101, type: 'alert', message: 'hello' }]);
  } finally {
    restore();
  }
});

test('confirm and prompt dialogs are dismissed (not accepted)', async () => {
  const { fc, cdp, restore } = await setup();
  try {
    fc.debugger.event(101, 'Page.javascriptDialogOpening', { type: 'confirm', message: 'sure?' });
    fc.debugger.event(101, 'Page.javascriptDialogOpening', { type: 'prompt', message: 'type:' });
    await fc.settle();
    const handled = fc.callsTo('debugger.sendCommand').filter((c) => c.args[1] === 'Page.handleJavaScriptDialog');
    assert.equal(handled.length, 2);
    assert.deepEqual(handled[0].args[2], { accept: false }, 'confirm is dismissed');
    assert.deepEqual(handled[1].args[2], { accept: false }, 'prompt is dismissed');
  } finally {
    restore();
  }
});

test('a beforeunload dialog is accepted so navigation can proceed', async () => {
  const { fc, cdp, restore } = await setup();
  try {
    fc.debugger.event(101, 'Page.javascriptDialogOpening', { type: 'beforeunload', message: 'leave?' });
    await fc.settle();
    const handled = fc.callsTo('debugger.sendCommand').filter((c) => c.args[1] === 'Page.handleJavaScriptDialog');
    assert.deepEqual(handled[0].args[2], { accept: true });
  } finally {
    restore();
  }
});

test('dialog events for other methods are ignored', async () => {
  const { fc, cdp, restore } = await setup();
  try {
    fc.debugger.event(101, 'Page.frameNavigated', { frame: { url: 'https://x.test/' } });
    await fc.settle();
    const handled = fc.callsTo('debugger.sendCommand').filter((c) => c.args[1] === 'Page.handleJavaScriptDialog');
    assert.equal(handled.length, 0);
  } finally {
    restore();
  }
});
