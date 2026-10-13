import test from 'node:test';
import assert from 'node:assert/strict';
import { systemAction } from '../../src/background/agent/systemAction.ts';
import { createMockRuntime } from '../helpers/mockRuntime.ts';

test('systemAction: stops execution when stop is requested, but allows cleanup', async () => {
  const rt = createMockRuntime('test-stop');
  rt.control.stopRequested = true;

  // Regular actions should abort
  const navRes = await systemAction(rt, 101, 'navigate', 'https://example.com');
  assert.equal(navRes.ok, false);
  assert.equal(navRes.aborted, true);
  assert.match(navRes.error ?? '', /stopped by user/i);

  const waitRes = await systemAction(rt, 101, 'wait', undefined, { ms: 100 });
  assert.equal(waitRes.ok, false);
  assert.equal(waitRes.aborted, true);

  // Cleanup actions (detach, clearBadges) are allowed even when stopped
  rt.attachedTabIds.add(101);
  const detachRes = await systemAction(rt, 101, 'detach');
  assert.equal(detachRes.ok, true);

  const clearBadgesRes = await systemAction(rt, 101, 'clearBadges');
  assert.equal(clearBadgesRes.ok, true);
});

test('systemAction: pauses execution when pause is requested, but allows cleanup', async () => {
  const rt = createMockRuntime('test-pause');
  rt.control.pauseRequested = true;

  const reloadRes = await systemAction(rt, 101, 'reload');
  assert.equal(reloadRes.ok, false);
  assert.equal(reloadRes.aborted, true);
  assert.match(reloadRes.error ?? '', /paused/i);

  const clearBadgesRes = await systemAction(rt, 101, 'clearBadges');
  assert.equal(clearBadgesRes.ok, true);
});

test('systemAction: scope gate rejects tabs not in ScoutFox group', async () => {
  const rt = createMockRuntime('test-scope', {
    browser: {
      isTabInScope: async () => false
    }
  });

  const res = await systemAction(rt, 101, 'navigate', 'https://example.com');
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /outside this session's ScoutFox group/);
});

test('systemAction: restricted URL gates on current tab and target URL', async () => {
  const rt = createMockRuntime('test-restricted', {
    browser: {
      tabInfo: async () => ({
        url: 'chrome://settings',
        title: 'Settings',
        windowId: 1,
        groupId: 10,
        status: 'complete'
      })
    }
  });

  // Current tab is restricted -> attach / reinject rejected
  const attachRes = await systemAction(rt, 101, 'attach');
  assert.equal(attachRes.ok, false);
  assert.match(attachRes.error ?? '', /internal pages/i);

  // Target URL is restricted -> navigation rejected
  const navRes = await systemAction(rt, 101, 'navigate', 'chrome://extensions');
  assert.equal(navRes.ok, false);
  assert.match(navRes.error ?? '', /internal pages/i);
});

test('systemAction: blocked domains gate rejects specified domains and subdomains', async () => {
  const rt = createMockRuntime('test-blocked');

  const res = await systemAction(rt, 101, 'navigate', 'https://login.forbidden.com/auth', {
    blockedDomains: ['forbidden.com']
  });
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /Domain login\.forbidden\.com is blocked/);
});

test('systemAction: protocol gate permits only http and https navigation', async () => {
  const rt = createMockRuntime('test-proto');

  const ftpRes = await systemAction(rt, 101, 'navigate', 'ftp://ftp.example.com/file');
  assert.equal(ftpRes.ok, false);
  assert.match(ftpRes.error ?? '', /Restricted protocol/);

  const customRes = await systemAction(rt, 101, 'navigate', 'custom://app/start');
  assert.equal(customRes.ok, false);
  assert.match(customRes.error ?? '', /Restricted protocol/);
});

test('systemAction: sets and restores sys:<seq> marker during execution', async () => {
  let capturedMarkerDuringAction: string | undefined;
  let capturedRtNetMarker: string | undefined;

  const rt = createMockRuntime('test-marker', {
    browser: {
      navigate: async () => {
        capturedMarkerDuringAction = (rt as any)._systemActionMarker;
        capturedRtNetMarker = rt.net.marker();
      }
    }
  });

  assert.equal((rt as any)._systemActionMarker, undefined);
  assert.equal(rt.net.marker(), 'marker-1');

  const res = await systemAction(rt, 101, 'navigate', 'https://example.com');
  assert.equal(res.ok, true);

  assert.ok(capturedMarkerDuringAction?.startsWith('sys:'));
  assert.equal(capturedRtNetMarker, capturedMarkerDuringAction);
  // Restored after action completes
  assert.equal((rt as any)._systemActionMarker, undefined);
  assert.equal(rt.net.marker(), 'marker-1');
});

test('systemAction: attach and detach manage attachedTabIds', async () => {
  const rt = createMockRuntime('test-attach', {
    browser: {
      cdp: {
        ensureAttached: async () => ({ mode: 'cdp', reason: null }),
        detachAll: async () => {}
      }
    }
  });

  assert.equal(rt.attachedTabIds.has(101), false);

  const attachRes = await systemAction(rt, 101, 'attach');
  assert.equal(attachRes.ok, true);
  assert.equal(rt.attachedTabIds.has(101), true);

  const detachRes = await systemAction(rt, 101, 'detach');
  assert.equal(detachRes.ok, true);
  assert.equal(rt.attachedTabIds.has(101), false);
});

test('systemAction: executes navigation, reload, back, and wait', async () => {
  const events: string[] = [];

  const rt = createMockRuntime('test-actions', {
    browser: {
      navigate: async (_tabId, url) => { events.push(`navigate:${url}`); },
      reload: async () => { events.push('reload'); },
      goBack: async () => { events.push('back'); },
      waitForTabComplete: async () => { events.push('waitTab'); },
      clearBadges: async () => { events.push('clearBadges'); }
    },
    clock: {
      now: () => Date.now(),
      sleep: async (ms) => { events.push(`sleep:${ms}`); }
    }
  });

  await systemAction(rt, 101, 'navigate', 'https://example.com');
  await systemAction(rt, 101, 'reload');
  await systemAction(rt, 101, 'back');
  await systemAction(rt, 101, 'wait', undefined, { ms: 500 });
  await systemAction(rt, 101, 'clearBadges');

  assert.deepEqual(events, [
    'navigate:https://example.com',
    'waitTab',
    'reload',
    'waitTab',
    'back',
    'waitTab',
    'sleep:500',
    'clearBadges'
  ]);
});

test('systemAction: reinject executes isolated content scripts and MAIN world net recorder', async () => {
  const originalChrome = (globalThis as any).chrome;
  try {
    const injectedCalls: any[] = [];
    (globalThis as any).chrome = {
      scripting: {
        executeScript: async (opts: any) => {
          injectedCalls.push(opts);
        }
      }
    };

    const rt = createMockRuntime('test-reinject');
    const res = await systemAction(rt, 101, 'reinject');
    assert.equal(res.ok, true);

    assert.equal(injectedCalls.length, 2);
    // 1. Isolated world files
    assert.equal(injectedCalls[0].target.tabId, 101);
    assert.deepEqual(injectedCalls[0].files, [
      'content/domCompressor.js',
      'content/actionExecutor.js',
      'content/content.js'
    ]);
    // 2. MAIN world net-recorder
    assert.equal(injectedCalls[1].world, 'MAIN');
    assert.equal(injectedCalls[1].target.allFrames, true);
    assert.deepEqual(injectedCalls[1].files, ['content/net-recorder.js']);
  } finally {
    (globalThis as any).chrome = originalChrome;
  }
});
