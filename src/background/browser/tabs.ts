/**
 * tabs.ts: Pure helper module for tab operations, status checks, and URL restrictions.
 */

/**
 * Return chrome.runtime.lastError.message if set, or null.
 * Catches context-invalidated reads in test / non-extension contexts.
 */
export function lastRuntimeError(): string | null {
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError) {
      return chrome.runtime.lastError.message ?? 'Unknown chrome error';
    }
  } catch (_) {
    // context invalidated
  }
  return null;
}

/**
 * Explain why a URL cannot be automated, or return null if it can be.
 * Chrome blocks extensions from scripting internal pages, other extensions, and the Web Store.
 */
export function describeRestrictedUrl(url: string | null | undefined): string | null {
  if (!url) {
    return 'That tab has not finished loading a page yet. Wait for it to load, then start the task again.';
  }
  if (/^chrome:\/\//i.test(url) || /^edge:\/\//i.test(url) || /^about:/i.test(url) || /^brave:\/\//i.test(url)) {
    return `Tarka cannot read ${url} - Chrome blocks all extensions from accessing its own internal pages, so no extension can automate this screen. Switch to a normal website tab (anything starting with http:// or https://) and start the task again.`;
  }
  if (/^chrome-extension:\/\//i.test(url) || /^moz-extension:\/\//i.test(url)) {
    return `Tarka cannot read ${url} - browsers block extensions from scripting other extensions' pages. Switch to a normal website tab and start the task again.`;
  }
  if (/^https:\/\/chromewebstore\.google\.com/i.test(url) || /^https:\/\/chrome\.google\.com\/webstore/i.test(url)) {
    return 'Tarka cannot read the Chrome Web Store - Chrome blocks extensions from scripting it. Switch to another site and start the task again.';
  }
  if (/^(file|view-source|devtools|data):/i.test(url)) {
    return `Tarka cannot read ${url.split(':')[0]}: pages. Switch to a normal website tab and start the task again.`;
  }
  return null;
}

/**
 * Can this tab be automated by Tarka?
 * Delegates to describeRestrictedUrl as the single source of truth.
 */
export function isValidWebTab(tab: { url?: string | null } | null | undefined): boolean {
  if (!tab || !tab.url) return false;
  return describeRestrictedUrl(tab.url) === null;
}

/**
 * Is this tab a disposable throwaway page that can be navigated in place?
 */
export function isDisposableTab(tab: { url?: string | null; pendingUrl?: string | null } | null | undefined): boolean {
  const url = tab && (tab.url || tab.pendingUrl);
  if (!url) return false;
  return url === 'about:blank' || /^(chrome|edge|brave):\/\/(newtab|new-tab-page)\/?$/i.test(url);
}

/**
 * Retrieve a chrome tab safely, supporting both callback and promise forms.
 * Never throws.
 */
export function getTab(
  tabId: number,
  callback?: (tab: chrome.tabs.Tab | null) => void
): Promise<chrome.tabs.Tab | null> {
  const promise = new Promise<chrome.tabs.Tab | null>((resolve) => {
    try {
      if (!tabId || typeof chrome === 'undefined' || !chrome.tabs?.get) {
        resolve(null);
        return;
      }
      const maybePromise: any = (chrome.tabs.get as any)(tabId, (t: chrome.tabs.Tab) => {
        lastRuntimeError();
        resolve(t || null);
      });
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.then(
          (t: chrome.tabs.Tab | null) => resolve(t || null),
          () => resolve(null)
        );
      }
    } catch (_) {
      resolve(null);
    }
  });

  if (callback) {
    promise.then((t) => callback(t)).catch(() => callback(null));
  }
  return promise;
}

/**
 * Wait for a browser tab's loading status to become 'complete'.
 */
export async function waitForTabComplete(
  tabId: number,
  timeoutMs = 4000,
  signal?: AbortSignal,
  clock?: { sleep: (ms: number, signal?: AbortSignal) => Promise<void> }
): Promise<void> {
  if (signal?.aborted) return;
  if (typeof chrome === 'undefined' || !chrome.tabs?.onUpdated) return;

  await new Promise<void>((resolve) => {
    let resolved = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        if (timer !== null) clearTimeout(timer);
        if (typeof chrome !== 'undefined' && chrome.tabs?.onUpdated) {
          chrome.tabs.onUpdated.removeListener(listener);
        }
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }
    };

    const onAbort = () => cleanup();
    signal?.addEventListener('abort', onAbort);

    if (clock?.sleep) {
      clock.sleep(timeoutMs, signal).then(cleanup).catch(cleanup);
    } else {
      timer = setTimeout(cleanup, timeoutMs);
    }

    const listener = (tid: number, changeInfo: { status?: string }) => {
      if (tid === tabId && changeInfo.status === 'complete' && !resolved) {
        cleanup();
      }
    };

    chrome.tabs.onUpdated.addListener(listener);
  });
}

/**
 * The URL a tab is on right now, or fallback when the browser cannot say.
 */
export async function liveTabUrl(tabId: number, fallback = ''): Promise<string> {
  try {
    if (!tabId || typeof chrome === 'undefined' || !chrome.tabs?.get) return fallback;
    const tab = await getTab(tabId);
    return tab && typeof tab.url === 'string' && tab.url !== '' ? tab.url : fallback;
  } catch (_) {
    return fallback;
  }
}
