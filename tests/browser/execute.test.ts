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
  assert.match(res.error || '', /Navigate target must be http or https/);
});

test('executeAction - handles execute_js returning result, resultData and oneShot', async () => {
  const res = await executeAction(
    101,
    { action: 'execute_js', code: 'return 42;', step: 3 },
    {
      // execute_js is opt-in (safety/confirm-card-blind-approval): the caller passes the setting.
      allowExecuteJs: true,
      executeJs: async (_, code) => ({
        success: true,
        result: 42,
        message: 'Executed',
      }),
    }
  );

  assert.equal(res.success, true);
  assert.equal(res.result, 42);
  assert.equal(res.resultData, 42);
  assert.equal(res.via, 'background');
  assert.equal(res.effect, 'none');
  assert.ok(res.oneShot);
  assert.equal(res.oneShot.label, 'JavaScript Result');
  assert.equal(res.oneShot.text, '42');
  assert.equal(res.oneShot.step, 3);
});

test('executeAction - refuses execute_js when the setting is off, before any script runs', async () => {
  let ran = false;
  for (const allowExecuteJs of [undefined, false]) {
    const res = await executeAction(101, { action: 'execute_js', code: 'return 42;' }, {
      allowExecuteJs,
      executeJs: async () => { ran = true; return { success: true, result: 42 }; },
    });
    assert.equal(res.success, false);
    assert.match(res.error || '', /execute_js is turned off in Settings/);
    assert.match(res.error || '', /Do not call execute_js again/);
    assert.equal(res.effect, 'none');
  }
  assert.equal(ran, false, 'the script never ran');
});

test('executeAction - handles open_window with url_changed effect', async () => {
  const res = await executeAction(
    101,
    { action: 'open_window', url: 'https://shop.test/deal' },
    {
      openNewWindow: async (url) => ({
        success: true,
        windowId: 2,
        tabId: 501,
        message: `Opened ${url}`,
      }),
    }
  );

  assert.equal(res.success, true);
  assert.equal(res.via, 'background');
  assert.equal(res.effect, 'url_changed');
  assert.equal(res.urlAfter, 'https://shop.test/deal');
});

test('executeAction - handles read_network_requests with oneShot', async () => {
  const res = await executeAction(
    101,
    { action: 'read_network_requests', limit: 5, step: 2 },
    {
      readNetworkRequests: () => 'GET /api/price -> 200 OK',
    }
  );

  assert.equal(res.success, true);
  assert.equal(res.via, 'background');
  assert.ok(res.oneShot);
  assert.equal(res.oneShot.label, 'Recent Network Activity');
  assert.equal(res.oneShot.text, 'GET /api/price -> 200 OK');
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

test('executeAction browser_batch reads the live stop flag per step (BUG-31)', async () => {
  const dispatched: any[] = [];
  // A realistic control object: executeAction used to copy stopRequested once
  // per batch, so a mid-batch stop never terminated the remaining steps.
  const control: any = {
    stopRequested: false,
    pauseRequested: false,
    stepSignal: () => new AbortController().signal,
    isUserAbort: () => false,
  };

  const res = await executeAction(
    101,
    {
      action: 'browser_batch',
      steps: [
        { action: 'click', element_id: 1 },
        { action: 'click', element_id: 2 },
        { action: 'click', element_id: 3 },
      ],
    },
    {
      runRuntime: {
        control,
        clock: { sleep: async () => {}, now: () => Date.now() },
        browser: { tabInfo: async () => ({ url: 'https://example.com', title: 'x', windowId: 1, groupId: 0, status: 'complete' }), waitDomQuiet: async () => {} },
      } as any,
      dispatchAction: async (_t, step) => {
        dispatched.push(step);
        if (dispatched.length === 1) control.stopRequested = true;
        return { success: true };
      },
    }
  );

  assert.equal(dispatched.length, 1, `only the step before the stop was dispatched, got ${dispatched.length}`);
  // The completed steps did run fine, so the batch stays "successful" - but the
  // summary must say it was stopped by the user's stop, not abort mid-way.
  assert.match(res.message || '', /stopped by stop/, String(res.message));
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
test('executeAction - read_page_text one-shot carries the part note', async () => {
  const res = await executeAction(
    101,
    { action: 'read_page_text', step: 4 },
    {
      dispatchAction: async () => ({
        success: true,
        message: 'Extracted text snippet (12000 chars, part 2 of 4, chars 3001-6000):\n"""\nchunk two\n"""',
        result: { pageText: 'chunk two', note: '12000 chars, part 2 of 4, chars 3001-6000' },
      }),
    } as any
  );
  assert.equal(res.success, true);
  assert.ok(res.oneShot);
  assert.match(res.oneShot.label, /part 2 of 4, chars 3001-6000/);
  assert.equal(res.oneShot.note, '12000 chars, part 2 of 4, chars 3001-6000');
  assert.equal(res.oneShot.text, 'chunk two');
});
