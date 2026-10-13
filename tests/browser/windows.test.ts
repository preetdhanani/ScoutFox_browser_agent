import test from 'node:test';
import assert from 'node:assert/strict';
import { openNewWindow, type WindowContext } from '../../src/background/browser/windows.ts';

test('openNewWindow: fails gracefully when chrome.windows is unavailable', async () => {
  const originalChrome = (globalThis as any).chrome;
  try {
    (globalThis as any).chrome = {};
    const res = await openNewWindow({});
    assert.equal(res.success, false);
    assert.match(res.error ?? '', /chrome\.windows is unavailable/);
  } finally {
    (globalThis as any).chrome = originalChrome;
  }
});

test('openNewWindow: fails when window has no tabs', async () => {
  const originalChrome = (globalThis as any).chrome;
  try {
    (globalThis as any).chrome = {
      windows: {
        create: (opts: any, cb: (w: any) => void) => {
          cb({ id: 10, tabs: [] });
        }
      },
      runtime: { lastError: null }
    };

    const res = await openNewWindow({});
    assert.equal(res.success, false);
    assert.match(res.error ?? '', /no tab was found in it/);
  } finally {
    (globalThis as any).chrome = originalChrome;
  }
});

test('openNewWindow: strictly pins order (create -> adopt -> group -> setActiveTab)', async () => {
  const originalChrome = (globalThis as any).chrome;
  try {
    const events: string[] = [];

    (globalThis as any).chrome = {
      windows: {
        create: (opts: any, cb: (w: any) => void) => {
          events.push(`create:${opts.url}`);
          cb({ id: 88, tabs: [{ id: 99, windowId: 88 }] });
        }
      },
      runtime: { lastError: null }
    };

    const ctx: WindowContext = {
      adoptTab: async (tabId, winId) => {
        events.push(`adopt:${tabId}:${winId}`);
      },
      ensureGroup: async (tabId, winId) => {
        events.push(`group:${tabId}:${winId}`);
        return 777;
      },
      setActiveTab: async (tabId) => {
        events.push(`active:${tabId}`);
      }
    };

    const res = await openNewWindow(ctx, 'https://example.com/compare');
    assert.equal(res.success, true);
    assert.equal(res.windowId, 88);
    assert.equal(res.tabId, 99);
    assert.equal(res.message, 'Opened a new window at https://example.com/compare and switched to it.');

    assert.deepEqual(events, [
      'create:https://example.com/compare',
      'adopt:99:88',
      'group:99:88',
      'active:99'
    ]);
  } finally {
    (globalThis as any).chrome = originalChrome;
  }
});

test('openNewWindow: defaults URL to https://www.google.com when unspecified', async () => {
  const originalChrome = (globalThis as any).chrome;
  try {
    let createdUrl = '';
    (globalThis as any).chrome = {
      windows: {
        create: (opts: any, cb: (w: any) => void) => {
          createdUrl = opts.url;
          cb({ id: 12, tabs: [{ id: 34 }] });
        }
      },
      runtime: { lastError: null }
    };

    const res = await openNewWindow({});
    assert.equal(res.success, true);
    assert.equal(createdUrl, 'https://www.google.com');
  } finally {
    (globalThis as any).chrome = originalChrome;
  }
});

test('openNewWindow: handles chrome.windows.create error properly', async () => {
  const originalChrome = (globalThis as any).chrome;
  try {
    (globalThis as any).chrome = {
      windows: {
        create: (_opts: any, cb: (w: any) => void) => {
          (globalThis as any).chrome.runtime.lastError = { message: 'Window creation denied' };
          cb(null);
        }
      },
      runtime: { lastError: { message: 'Window creation denied' } }
    };

    const res = await openNewWindow({});
    assert.equal(res.success, false);
    assert.match(res.error ?? '', /Window creation denied/);
  } finally {
    (globalThis as any).chrome = originalChrome;
  }
});
