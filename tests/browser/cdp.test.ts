import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeChrome } from '../helpers/fakeChrome.ts';
import { CDPManager } from '../../src/background/browser/cdp.ts';

test('CDPManager: attach attaches debugger and enables focus emulation', async () => {
  const fc = fakeChrome({
    debugger: {
      commands: {
        'Emulation.setFocusEmulationEnabled': {}
      }
    },
    tabs: { list: [{ id: 101, url: 'https://example.com' }] },
    scripting: {
      executeScript: [{ result: 800 }]
    }
  });
  (globalThis as any).chrome = fc.chrome;

  const cdp = new CDPManager();
  assert.equal(cdp.isAttached(101), false);

  await cdp.attach(101);

  assert.equal(cdp.isAttached(101), true);
  assert.equal(fc.debugger.attached.includes(101), true);

  const calls = fc.callsTo('debugger.sendCommand');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.args[1], 'Emulation.setFocusEmulationEnabled');
});

test('CDPManager: attach tolerates already attached debugger', async () => {
  const fc = fakeChrome({
    debugger: {
      commands: {
        'Emulation.setFocusEmulationEnabled': {}
      }
    },
    tabs: { list: [{ id: 101, url: 'https://example.com' }] },
    scripting: {
      executeScript: [{ result: 800 }]
    }
  });
  (globalThis as any).chrome = fc.chrome;

  const cdp = new CDPManager();
  await cdp.attach(101);

  // Calling attach again should not throw despite fakeChrome throwing "Another debugger is already attached"
  await cdp.attach(101);
  assert.equal(cdp.isAttached(101), true);
});

test('CDPManager: detach detaches tab idempotently', async () => {
  const fc = fakeChrome({
    debugger: {
      commands: {
        'Emulation.setFocusEmulationEnabled': {}
      }
    },
    tabs: { list: [{ id: 101, url: 'https://example.com' }] },
    scripting: {
      executeScript: [{ result: 800 }]
    }
  });
  (globalThis as any).chrome = fc.chrome;

  const cdp = new CDPManager();
  await cdp.attach(101);
  assert.equal(cdp.isAttached(101), true);

  await cdp.detach(101);
  assert.equal(cdp.isAttached(101), false);
  assert.equal(fc.debugger.attached.includes(101), false);

  // Second detach is a safe no-op
  await cdp.detach(101);
  assert.equal(cdp.isAttached(101), false);
});

test('CDPManager: handles user cancel detach and activates userDetached', async () => {
  const fc = fakeChrome({
    debugger: {
      commands: {
        'Emulation.setFocusEmulationEnabled': {}
      }
    },
    tabs: { list: [{ id: 101, url: 'https://example.com' }] },
    scripting: {
      executeScript: [{ result: 800 }]
    }
  });
  (globalThis as any).chrome = fc.chrome;

  const cdp = new CDPManager();
  await cdp.attach(101);
  assert.equal(cdp.isAttached(101), true);
  assert.equal(cdp.isUserDetached(101), false);

  // Simulate user clicking "Cancel" on yellow bar
  fc.debugger.detach(101, 'canceled_by_user');

  assert.equal(cdp.isAttached(101), false);
  assert.equal(cdp.isUserDetached(101), true);

  // Subsequent attach should refuse to attach to respect user choice
  await cdp.attach(101);
  assert.equal(cdp.isAttached(101), false);
  assert.equal(cdp.isUserDetached(101), true);
});

test('CDPManager: pause timer can be set and cleared', async () => {
  const fc = fakeChrome({
    debugger: {
      commands: {
        'Emulation.setFocusEmulationEnabled': {}
      }
    },
    tabs: { list: [{ id: 101, url: 'https://example.com' }] },
    scripting: {
      executeScript: [{ result: 800 }]
    }
  });
  (globalThis as any).chrome = fc.chrome;

  const cdp = new CDPManager();
  await cdp.attach(101);

  cdp.startPauseTimer(101);
  // Clear timer should clear without error
  cdp.clearPauseTimer(101);
  assert.equal(cdp.isAttached(101), true);
});

test('CDPManager: reconcileLeakedTargets detaches untracked attached tabs', async () => {
  const fc = fakeChrome({
    debugger: {
      commands: {
        'Emulation.setFocusEmulationEnabled': {}
      }
    },
    tabs: {
      list: [
        { id: 101, url: 'https://example.com' },
        { id: 102, url: 'https://example.com/other' }
      ]
    },
    scripting: {
      executeScript: [{ result: 800 }]
    }
  });
  (globalThis as any).chrome = fc.chrome;

  const cdp = new CDPManager();
  await cdp.attach(101);
  await cdp.attach(102);

  assert.equal(fc.debugger.attached.includes(101), true);
  assert.equal(fc.debugger.attached.includes(102), true);

  // Reconcile with only tab 101 active: tab 102 should be detached
  await cdp.reconcileLeakedTargets(new Set([101]));

  assert.equal(fc.debugger.attached.includes(101), true);
  assert.equal(fc.debugger.attached.includes(102), false);
  assert.equal(cdp.isAttached(101), true);
  assert.equal(cdp.isAttached(102), false);
});
