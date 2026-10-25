/**
 * CDPManager attach lifecycle races: src/background/browser/cdp.ts.
 *
 *   1. An attach that times out but then succeeds late is detached again, so the tab is not left
 *      holding a session nobody tracks (the next attach would fail "Another debugger is already
 *      attached").
 *   2. A second caller that arrives while the first attach is still settling (Page.enable, the
 *      debugger bar) waits for the same round instead of returning before the bar has settled.
 *   3. The leak sweep never detaches a tab with an attach in flight or a tab that was used a
 *      moment ago, and it takes a predicate as well as a set.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeChrome } from '../helpers/fakeChrome.ts';
import { CDPManager } from '../../src/background/browser/cdp.ts';

const tick = () => new Promise((r) => setTimeout(r, 0));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A plain chrome.debugger whose attach answers after attachDelayMs. No scripting, so no settle wait. */
function slowDebugger(attachDelayMs: number) {
  const attached = new Set<number>();
  const detachCalls: number[] = [];
  const chromeStub: any = {
    debugger: {
      onDetach: { addListener() {} },
      attach: ({ tabId }: { tabId: number }) =>
        new Promise<void>((resolve, reject) => {
          setTimeout(() => {
            if (attached.has(tabId)) {
              reject(new Error(`Another debugger is already attached to the tab with id: ${tabId}.`));
              return;
            }
            attached.add(tabId);
            resolve();
          }, attachDelayMs);
        }),
      detach: async ({ tabId }: { tabId: number }) => {
        detachCalls.push(tabId);
        if (!attached.delete(tabId)) throw new Error(`Debugger is not attached to the tab with id: ${tabId}.`);
      },
      sendCommand: async () => ({})
    }
  };
  return { chromeStub, attached, detachCalls };
}

test('an attach that timed out but succeeded late is detached again', async () => {
  const { chromeStub, attached, detachCalls } = slowDebugger(40);
  (globalThis as any).chrome = chromeStub;

  const cdp = new CDPManager({ attachTimeoutMs: 10 });
  await assert.rejects(() => cdp.attach(101), /timed out/);
  assert.equal(cdp.isAttached(101), false);

  await wait(70);
  assert.deepEqual(detachCalls, [101], 'the late session is detached');
  assert.equal(attached.has(101), false, 'nothing is left attached behind the manager\'s back');
});

test('after a timed-out attach is cleaned up, the next attach works', async () => {
  const { chromeStub } = slowDebugger(40);
  (globalThis as any).chrome = chromeStub;

  const cdp = new CDPManager({ attachTimeoutMs: 10 });
  await assert.rejects(() => cdp.attach(101), /timed out/);
  await wait(70);

  // A generous timer this time: the attach answers in 40 ms.
  const cdp2 = cdp as any;
  cdp2.attachTimeoutMs = 1000;
  await cdp.attach(101);
  assert.equal(cdp.isAttached(101), true);
});

test('a second caller waits for the first attach to settle', async () => {
  let heightReads = 0;
  const fc = fakeChrome({
    debugger: { commands: { 'Emulation.setFocusEmulationEnabled': {}, 'Page.enable': {} } },
    tabs: { list: [{ id: 101, url: 'https://example.com' }] },
    // The first read is the height before the bar, the next one sees the bar.
    scripting: { executeScript: () => (heightReads++ === 0 ? 800 : 760) }
  });
  (globalThis as any).chrome = fc.chrome;

  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const cdp = new CDPManager();
  cdp.setClockSleep(() => gate);

  let firstDone = false;
  let secondDone = false;
  const first = cdp.attach(101).then(() => (firstDone = true));
  // Let the first round reach the settle wait (attach, focus emulation, Page.enable, height read).
  for (let i = 0; i < 20 && heightReads === 0; i++) await tick();
  await tick();
  assert.equal(heightReads > 0, true, 'the first round is in the settle wait');

  const second = cdp.attach(101).then(() => (secondDone = true));
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(secondDone, false, 'the second caller does not skip the settle wait');
  assert.equal(firstDone, false);

  release();
  await Promise.all([first, second]);
  assert.equal(cdp.isAttached(101), true);
  assert.equal(fc.callsTo('debugger.attach').length, 1, 'one round, shared');
});

test('the leak sweep keeps a tab whose attach is in flight', async () => {
  const fc = fakeChrome({
    debugger: { commands: { 'Emulation.setFocusEmulationEnabled': {}, 'Page.enable': {} } },
    tabs: { list: [{ id: 101, url: 'https://example.com' }] },
    scripting: { executeScript: () => 800 }
  });
  (globalThis as any).chrome = fc.chrome;

  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const cdp = new CDPManager();
  cdp.setClockSleep(() => gate);

  const pending = cdp.attach(101);
  for (let i = 0; i < 20 && !fc.debugger.attached.includes(101); i++) await tick();
  assert.equal(fc.debugger.attached.includes(101), true);

  // The caller's keep set does not know this tab yet (a run reaching a tab before adopting it).
  await cdp.reconcileLeakedTargets(new Set());
  assert.equal(fc.debugger.attached.includes(101), true, 'an attach in flight is not a leak');

  // Let the settle loop run out quickly: every later sleep returns at once and the clock jumps.
  const realNow = Date.now;
  Date.now = () => realNow() + 10_000;
  try {
    release();
    await pending;
  } finally {
    Date.now = realNow;
  }
});

test('the leak sweep keeps a tab used a moment ago, and still detaches an idle leak', async () => {
  const fc = fakeChrome({
    debugger: { commands: { 'Emulation.setFocusEmulationEnabled': {}, 'Page.enable': {}, 'Runtime.evaluate': {} } },
    tabs: { list: [{ id: 101, url: 'https://example.com' }, { id: 102, url: 'https://example.com/b' }] },
    scripting: { executeScript: () => 0 }
  });
  (globalThis as any).chrome = fc.chrome;

  const cdp = new CDPManager({ recentUseGraceMs: 60_000 });
  await cdp.attach(101);
  await cdp.sendCommand(101, 'Runtime.evaluate', {});
  await cdp.attach(102);

  // Tab 102 has not been used for longer than the grace: it is a leak.
  const realNow = Date.now;
  const lastUse102 = realNow();
  Date.now = () => lastUse102 + 120_000;
  try {
    await cdp.sendCommand(101, 'Runtime.evaluate', {});
    await cdp.reconcileLeakedTargets(new Set());
  } finally {
    Date.now = realNow;
  }
  assert.equal(fc.debugger.attached.includes(101), true, 'a tab in use is not a leak');
  assert.equal(fc.debugger.attached.includes(102), false, 'an idle tab nobody keeps is detached');
});

test('the leak sweep takes a predicate as well as a set', async () => {
  const fc = fakeChrome({
    debugger: { commands: { 'Emulation.setFocusEmulationEnabled': {}, 'Page.enable': {} } },
    tabs: { list: [{ id: 101, url: 'https://example.com' }, { id: 102, url: 'https://example.com/b' }] },
    scripting: { executeScript: () => 0 }
  });
  (globalThis as any).chrome = fc.chrome;

  const cdp = new CDPManager({ recentUseGraceMs: 0 });
  await cdp.attach(101);
  await cdp.attach(102);
  await cdp.reconcileLeakedTargets((tabId) => tabId === 102);
  assert.equal(fc.debugger.attached.includes(101), false);
  assert.equal(fc.debugger.attached.includes(102), true);
});
