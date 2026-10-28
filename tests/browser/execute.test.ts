import test from 'node:test';
import assert from 'node:assert/strict';
import { executeAction } from '../../src/background/browser/execute.ts';

test('executeAction - rejects immediately when signal is already aborted', async () => {
  const controller = new AbortController();
  controller.abort();

  const res = await executeAction(
    101,
    { action: 'click', element_id: 1 },
    { signal: controller.signal }
  );

  assert.equal(res.success, false);
  assert.equal(res.error, 'Action aborted');
  assert.equal(res.effect, 'none');
});

test('executeAction - gates restricted URL on navigate before dispatch', async () => {
  let dispatched = false;
  const res = await executeAction(
    101,
    { action: 'navigate', url: 'chrome://settings' },
    {
      dispatchAction: async () => {
        dispatched = true;
        return { success: true };
      },
    }
  );

  assert.equal(res.success, false);
  assert.equal(res.via, 'background');
  assert.equal(dispatched, false);
  assert.match(res.error || '', /chrome:\/\/settings/);
});

test('executeAction - rejects non-http(s) navigation target', async () => {
  const res = await executeAction(
    101,
    { action: 'navigate', url: 'javascript:alert(1)' },
    {}
  );

  assert.equal(res.success, false);
  assert.equal(res.via, 'background');
  assert.match(res.error || '', /Navigate target refused: only http and https addresses are allowed/);
});

test('executeAction - navigate refuses an address with credentials in it (the shared URL policy)', async () => {
  const res = await executeAction(101, { action: 'navigate', url: 'https://user:secret@example.com/' }, {});
  assert.equal(res.success, false);
  assert.match(res.error || '', /user name or password/);
});

test('executeAction - dispatches standard action and records url_changed when click causes navigation', async () => {
  let url = 'https://shop.test/list';

  const res = await executeAction(
    101,
    { action: 'click', element_id: 10 },
    {
      tabInfo: async () => ({
        url,
        title: 'Title',
        windowId: 1,
        groupId: 1,
        status: 'complete',
      }),
      dispatchAction: async () => {
        url = 'https://shop.test/item/10';
        return { success: true, message: 'Clicked [10]' };
      },
      waitDomQuiet: async () => {},
      waitForTabComplete: async () => {},
    }
  );

  assert.equal(res.success, true);
  assert.equal(res.effect, 'url_changed');
  assert.equal(res.urlAfter, 'https://shop.test/item/10');
});

test('executeAction - reports none effect when navigate reaches the same URL', async () => {
  const res = await executeAction(
    101,
    { action: 'navigate', url: 'https://shop.test/same' },
    {
      tabInfo: async () => ({
        url: 'https://shop.test/same',
        title: 'Same',
        windowId: 1,
        groupId: 1,
        status: 'complete',
      }),
      dispatchAction: async () => ({ success: true }),
      waitDomQuiet: async () => {},
      waitForTabComplete: async () => {},
    }
  );

  assert.equal(res.success, true);
  assert.equal(res.via, 'background');
  assert.equal(res.effect, 'none');
});

test('executeAction wait clamps to 1..5 s and runs in the background (BUG-36)', async () => {
  const sleeps: number[] = [];
  let dispatched = false;
  const res = await executeAction(
    101,
    { action: 'wait', amount: 600 },
    {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      dispatchAction: async () => {
        dispatched = true;
        return { success: true };
      },
    }
  );

  assert.deepEqual(sleeps, [5000], `a cloud wait of 600 s parks for 5 s at most, slept ${sleeps}`);
  assert.equal(dispatched, false, 'the wait runs in the background, not via the content script');
  assert.equal(res.success, true);
  assert.match(res.message || '', /Waited 5s/);
});

test('executeAction wait with amount 0 waits the legacy 1 s (BUG-36)', async () => {
  const sleeps: number[] = [];
  await executeAction(
    101,
    { action: 'wait', amount: 0 },
    {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    }
  );
  assert.deepEqual(sleeps, [1000]);
});

test('executeAction wait is interrupted by an aborted step signal (BUG-36)', async () => {
  const controller = new AbortController();
  const res = await executeAction(
    101,
    { action: 'wait', amount: 5 },
    {
      signal: controller.signal,
      sleep: async () => {
        controller.abort();
        throw new Error('Sleep aborted');
      },
    }
  );
  assert.equal(res.success, false);
  assert.equal(res.error, 'Action aborted');
});

// silent-truncation-no-marker: the part note and the stop hint were only in the raw result message; the one-shot
// the model reads carried the bare chunk, so the model never learnt which part it had or that it had them all.
test('executeAction - read_page one-shot carries the part note', async () => {
  const res = await executeAction(
    101,
    { action: 'read_page', part: 2, step: 4 },
    {
      dispatchAction: async () => ({
        success: true,
        message: 'Page text (part 2 of 4, chars 3001-6000 of 12000, next: read_page with part 3):\n"""\nchunk two\n"""',
        result: { pageText: 'chunk two', note: 'part 2 of 4, chars 3001-6000 of 12000, next: read_page with part 3' },
      }),
    } as any
  );
  assert.equal(res.success, true);
  assert.ok(res.oneShot);
  assert.match(res.oneShot.label, /part 2 of 4, chars 3001-6000/);
  assert.equal(res.oneShot.note, 'part 2 of 4, chars 3001-6000 of 12000, next: read_page with part 3');
  assert.equal(res.oneShot.text, 'chunk two');
});

// cdp-synthetic-fallback: execute used to default every successful synthetic result to
// dom_changed, so a synthetic click that changed nothing was reported as "page updated" and
// verify never fired the no-visible-change failure.
test('executeAction - a synthetic action that changes nothing reports effect none', async () => {
  const res = await executeAction(
    101,
    { action: 'click', element_id: 1 },
    {
      dispatchAction: async () => ({
        success: true,
        via: 'synthetic',
        message: 'Clicked element [1]',
        syntheticReason: 'debugger could not attach: not permitted',
      }),
      waitForTabComplete: async () => {},
      waitDomQuiet: async () => {},
    } as any
  );

  assert.equal(res.success, true);
  assert.equal(res.via, 'synthetic');
  assert.equal(res.effect, 'none', 'a synthetic result without a probe effect must not default to dom_changed');
  assert.equal(res.syntheticReason, 'debugger could not attach: not permitted');
});

// cdp-synthetic-fallback carry-over: read_page is a pure read; it went through the synthetic
// path and inherited the dom_changed default, so a read counted as a page change.
test('executeAction - a synthetic read_page reports no effect', async () => {
  const res = await executeAction(
    101,
    { action: 'read_page' },
    {
      dispatchAction: async () => ({
        success: true,
        via: 'synthetic',
        message: 'Page text',
        result: { pageText: 'hello' },
      }),
    } as any
  );

  assert.equal(res.success, true);
  assert.equal(res.effect, 'none', 'a pure read must not count as a page change');
});

// A5: a click on a single-page app never loads a page, so the old settle waited the whole
// waitComplete(4000) after every click (about 5.5 s per click on JupyterLab). The settle now waits
// for "complete" only when a load really started, and the DOM-quiet wait is capped at 800 ms.
function settleRig({ status = 'complete', urlAfter = 'https://app.example.com/', loadStarts = false } = {}) {
  const calls: string[] = [];
  let url = 'https://app.example.com/';
  const deps: any = {
    dispatchAction: async () => { url = urlAfter; return { success: true, via: 'cdp', effect: 'dom_changed', message: 'Clicked' }; },
    tabInfo: async () => ({ url, title: 'App', windowId: 1, groupId: 0, status }),
    watchLoadStart: async (_tabId: number, ms: number) => { calls.push(`watch ${ms}`); return loadStarts; },
    waitForTabComplete: async (_tabId: number, ms: number) => { calls.push(`complete ${ms}`); },
    waitDomQuiet: async (_tabId: number, quietMs: number, maxMs: number) => { calls.push(`quiet ${quietMs}/${maxMs}`); },
    readProbe: async () => null
  };
  return { deps, calls };
}

test('executeAction - a click that starts no load does not wait for a page to complete', async () => {
  const { deps, calls } = settleRig();
  const res = await executeAction(101, { action: 'click', element_id: 1 }, deps);
  assert.equal(res.success, true);
  assert.deepEqual(calls, ['watch 500', 'quiet 300/800'], 'it watches for a load for 500 ms, then only waits for a quiet DOM, at most 800 ms');
});

test('executeAction - a click that starts a load waits for it to complete', async () => {
  const watched = settleRig({ loadStarts: true });
  await executeAction(101, { action: 'click', element_id: 1 }, watched.deps);
  assert.deepEqual(watched.calls, ['watch 500', 'complete 4000', 'quiet 300/800']);

  // A tab already loading, or already on another URL that is still loading, needs no watch.
  const loading = settleRig({ status: 'loading' });
  await executeAction(101, { action: 'click', element_id: 1 }, loading.deps);
  assert.deepEqual(loading.calls, ['complete 4000', 'quiet 300/800']);

  // A new page that already finished loading is not waited for again.
  const arrived = settleRig({ urlAfter: 'https://app.example.com/next' });
  const res = await executeAction(101, { action: 'click', element_id: 1 }, arrived.deps);
  assert.deepEqual(arrived.calls, ['quiet 300/800']);
  assert.equal(res.effect, 'url_changed');
});

test('executeAction - press_key and scroll never wait for a page load, only for a quiet DOM', async () => {
  for (const action of [{ action: 'press_key', key: 'Enter' }, { action: 'scroll', direction: 'down' }]) {
    const { deps, calls } = settleRig({ loadStarts: true });
    await executeAction(101, action, deps);
    assert.deepEqual(calls, ['quiet 300/800'], action.action);
  }
});
