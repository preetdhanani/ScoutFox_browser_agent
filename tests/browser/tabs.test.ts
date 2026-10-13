import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeRestrictedUrl,
  isValidWebTab,
  isDisposableTab,
  lastRuntimeError,
  getTab,
  waitForTabComplete,
  liveTabUrl
} from '../../src/background/browser/tabs.ts';

test('describeRestrictedUrl identifies all browser-restricted URLs', () => {
  const restrictedList = [
    'chrome://settings/',
    'chrome://extensions/',
    'edge://flags/',
    'about:blank',
    'about:config',
    'brave://rewards/',
    'chrome-extension://abcdef/popup.html',
    'moz-extension://abcdef/popup.html',
    'https://chromewebstore.google.com/detail/test',
    'https://chrome.google.com/webstore/detail/test',
    'file:///home/user/document.pdf',
    'view-source:https://example.com',
    'devtools://devtools/bundled/inspector.html',
    'data:text/html,<h1>Test</h1>'
  ];

  for (const url of restrictedList) {
    const reason = describeRestrictedUrl(url);
    assert.ok(reason !== null, `expected ${url} to be restricted`);
    assert.ok(typeof reason === 'string');
  }
});

test('describeRestrictedUrl permits standard web URLs', () => {
  assert.equal(describeRestrictedUrl('https://example.com'), null);
  assert.equal(describeRestrictedUrl('http://localhost:3000'), null);
  assert.equal(describeRestrictedUrl('https://news.ycombinator.com/item?id=1'), null);
});

test('describeRestrictedUrl handles empty or missing URLs gracefully', () => {
  assert.match(describeRestrictedUrl(null) ?? '', /not finished loading/);
  assert.match(describeRestrictedUrl('') ?? '', /not finished loading/);
  assert.match(describeRestrictedUrl(undefined) ?? '', /not finished loading/);
});

test('isValidWebTab returns true for standard web tabs and false for restricted or empty tabs', () => {
  assert.equal(isValidWebTab({ url: 'https://example.com' }), true);
  assert.equal(isValidWebTab({ url: 'http://foo.bar' }), true);
  assert.equal(isValidWebTab({ url: 'chrome://history' }), false);
  assert.equal(isValidWebTab({ url: 'about:blank' }), false);
  assert.equal(isValidWebTab({ url: 'https://chromewebstore.google.com' }), false);
  assert.equal(isValidWebTab({ url: '' }), false);
  assert.equal(isValidWebTab(null), false);
  assert.equal(isValidWebTab(undefined), false);
  assert.equal(isValidWebTab({}), false);
});

test('isDisposableTab recognizes throwaway and new-tab pages', () => {
  assert.equal(isDisposableTab({ url: 'about:blank' }), true);
  assert.equal(isDisposableTab({ url: 'chrome://newtab' }), true);
  assert.equal(isDisposableTab({ url: 'chrome://newtab/' }), true);
  assert.equal(isDisposableTab({ url: 'chrome://new-tab-page' }), true);
  assert.equal(isDisposableTab({ url: 'chrome://new-tab-page/' }), true);
  assert.equal(isDisposableTab({ url: 'edge://newtab' }), true);
  assert.equal(isDisposableTab({ url: 'brave://newtab/' }), true);

  // Checks pendingUrl when url is absent
  assert.equal(isDisposableTab({ pendingUrl: 'chrome://newtab' }), true);
  assert.equal(isDisposableTab({ pendingUrl: 'about:blank' }), true);

  // Normal pages are never disposable
  assert.equal(isDisposableTab({ url: 'https://example.com' }), false);
  assert.equal(isDisposableTab({ url: 'chrome://settings' }), false);
  assert.equal(isDisposableTab(null), false);
  assert.equal(isDisposableTab({}), false);
});

test('lastRuntimeError reads message when chrome.runtime.lastError is present', () => {
  const originalChrome = (globalThis as any).chrome;
  try {
    (globalThis as any).chrome = {
      runtime: {
        lastError: { message: 'Tab not found' }
      }
    };
    assert.equal(lastRuntimeError(), 'Tab not found');

    (globalThis as any).chrome = {
      runtime: {
        lastError: {}
      }
    };
    assert.equal(lastRuntimeError(), 'Unknown chrome error');

    (globalThis as any).chrome = {
      runtime: {}
    };
    assert.equal(lastRuntimeError(), null);
  } finally {
    (globalThis as any).chrome = originalChrome;
  }
});

test('getTab returns tab object or null without throwing', async () => {
  const originalChrome = (globalThis as any).chrome;
  try {
    (globalThis as any).chrome = {
      tabs: {
        get: (id: number, cb: (tab: any) => void) => {
          if (id === 101) cb({ id: 101, url: 'https://example.com' });
          else cb(null);
        }
      }
    };

    const tab = await getTab(101);
    assert.deepEqual(tab, { id: 101, url: 'https://example.com' } as any);

    const missing = await getTab(999);
    assert.equal(missing, null);

    // Callback style
    let calledWith: any = undefined;
    await getTab(101, (t) => { calledWith = t; });
    assert.deepEqual(calledWith, { id: 101, url: 'https://example.com' });

    // Invalid tabId
    const zero = await getTab(0);
    assert.equal(zero, null);
  } finally {
    (globalThis as any).chrome = originalChrome;
  }
});

test('liveTabUrl returns tab url or fallback', async () => {
  const originalChrome = (globalThis as any).chrome;
  try {
    (globalThis as any).chrome = {
      tabs: {
        get: (id: number, cb: (tab: any) => void) => {
          if (id === 101) cb({ id: 101, url: 'https://example.com' });
          else if (id === 102) cb({ id: 102, url: '' });
          else cb(null);
        }
      }
    };

    assert.equal(await liveTabUrl(101, 'https://fallback.com'), 'https://example.com');
    assert.equal(await liveTabUrl(102, 'https://fallback.com'), 'https://fallback.com');
    assert.equal(await liveTabUrl(999, 'https://fallback.com'), 'https://fallback.com');
  } finally {
    (globalThis as any).chrome = originalChrome;
  }
});

test('waitForTabComplete resolves when tab status becomes complete', async () => {
  const originalChrome = (globalThis as any).chrome;
  try {
    let listenerRef: any = null;
    (globalThis as any).chrome = {
      tabs: {
        onUpdated: {
          addListener: (l: any) => { listenerRef = l; },
          removeListener: () => { listenerRef = null; }
        }
      }
    };

    const waitPromise = waitForTabComplete(101, 1000);
    assert.ok(listenerRef !== null);

    // Fire listener with complete
    listenerRef(101, { status: 'complete' });
    await waitPromise;
    assert.equal(listenerRef, null);
  } finally {
    (globalThis as any).chrome = originalChrome;
  }
});

test('waitForTabComplete handles abort signal and custom clock', async () => {
  const controller = new AbortController();
  controller.abort();

  // Already aborted should return immediately
  await waitForTabComplete(101, 1000, controller.signal);

  // Injected clock sleep
  let sleptMs = 0;
  const mockClock = {
    sleep: async (ms: number) => {
      sleptMs = ms;
    }
  };

  const originalChrome = (globalThis as any).chrome;
  try {
    (globalThis as any).chrome = {
      tabs: {
        onUpdated: {
          addListener: () => {},
          removeListener: () => {}
        }
      }
    };

    await waitForTabComplete(101, 500, undefined, mockClock);
    assert.equal(sleptMs, 500);
  } finally {
    (globalThis as any).chrome = originalChrome;
  }
});
