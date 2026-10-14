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

// cdp-synthetic-fallback: the foreign-debugger error ("Another debugger is already attached")
// used to be swallowed as a successful attach. Now it is retried with a short backoff, because
// a foreign extension iframe often detaches again within moments.
test('CDPManager: attach retries the foreign-debugger error and succeeds on a later try', async () => {
  let tries = 0;
  const foreignError = () => new Error('Another debugger is already attached to the tab with id: 101.');
  const fc = fakeChrome({
    debugger: {
      attach: () => {
        tries++;
        return tries < 4 ? foreignError() : undefined;
      },
      commands: { 'Emulation.setFocusEmulationEnabled': {} }
    },
    tabs: { list: [{ id: 101, url: 'https://example.com' }] },
    scripting: { executeScript: () => [{ result: 0 }] },
  });
  (globalThis as any).chrome = fc.chrome;

  const cdp = new CDPManager();
  await cdp.attach(101);

  assert.equal(cdp.isAttached(101), true);
  assert.equal(fc.callsTo('debugger.attach').length, 4, 'the foreign-debugger error is retried up to four tries');
});

test('CDPManager: attach gives up after four foreign-debugger tries and never marks the tab attached', async () => {
  const fc = fakeChrome({
    debugger: {
      attach: () => new Error('Another debugger is already attached to the tab with id: 101.'),
      commands: { 'Emulation.setFocusEmulationEnabled': {} }
    },
    tabs: { list: [{ id: 101, url: 'https://example.com' }] },
    scripting: { executeScript: () => [{ result: 0 }] },
  });
  (globalThis as any).chrome = fc.chrome;

  const cdp = new CDPManager();
  await assert.rejects(() => cdp.attach(101), /another debugger/i);

  assert.equal(cdp.isAttached(101), false, 'a failed attach must not mark the tab attached');
  assert.equal(fc.callsTo('debugger.attach').length, 4);
});

test('CDPManager: concurrent attaches share one debugger.attach call', async () => {
  const fc = fakeChrome({
    debugger: {
      commands: { 'Emulation.setFocusEmulationEnabled': {} }
    },
    tabs: { list: [{ id: 101, url: 'https://example.com' }] },
    scripting: { executeScript: () => [{ result: 0 }] },
  });
  (globalThis as any).chrome = fc.chrome;

  const cdp = new CDPManager();
  await Promise.all([cdp.attach(101), cdp.attach(101)]);

  assert.equal(cdp.isAttached(101), true);
  assert.equal(fc.callsTo('debugger.attach').length, 1, 'in-flight attaches are deduplicated per tab');
});

test('CDPManager: sendCommand re-attaches once and repeats after a not-attached error', async () => {
  const fc = fakeChrome({
    debugger: {
      commands: {
        'Emulation.setFocusEmulationEnabled': {},
        'Runtime.evaluate': () => ({ result: { value: 42 } })
      }
    },
    tabs: { list: [{ id: 101, url: 'https://example.com' }] },
    scripting: { executeScript: () => [{ result: 0 }] },
  });
  (globalThis as any).chrome = fc.chrome;

  const cdp = new CDPManager();
  await cdp.attach(101);

  // The browser ends the session behind our back (DevTools opened, tab crashed)
  fc.debugger.detach(101);
  assert.equal(cdp.isAttached(101), false);

  const res = await cdp.sendCommand(101, 'Runtime.evaluate', { expression: '1' });

  assert.deepEqual(res, { result: { value: 42 } }, 'the command is repeated once after the re-attach');
  assert.equal(cdp.isAttached(101), true);
  assert.equal(fc.callsTo('debugger.attach').length, 2, 'exactly one re-attach happened');
});

test('CDPManager: a command that never answers times out with a named error', async () => {
  const fc = fakeChrome({
    debugger: {
      commands: { 'Emulation.setFocusEmulationEnabled': {} },
      sendCommand: (_method: unknown) => new Promise(() => {})
    },
    tabs: { list: [{ id: 101, url: 'https://example.com' }] },
    scripting: { executeScript: () => [{ result: 0 }] },
  });
  (globalThis as any).chrome = fc.chrome;

  const cdp = new CDPManager({ commandTimeoutMs: 50 });
  await cdp.attach(101);

  await assert.rejects(
    () => cdp.sendCommand(101, 'Page.captureScreenshot', {}),
    /timed out/,
    'a hanging command must reject under the timer, not hang the run'
  );
});
