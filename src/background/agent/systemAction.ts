// src/background/agent/systemAction.ts
// Centralized system action handler for code navigation, reloads, waits, attach/detach, and injection.
import { describeRestrictedUrl } from '../browser/tabs.ts';
import { cdp } from '../browser/cdp.ts';
import { CONTENT_SCRIPT_FILES, NET_RECORDER_FILE } from '../browser/contentFiles.ts';
import { Logger } from '../../shared/logger.ts';
import type { RunRuntime } from '../runner/runtimeRegistry.ts';

export type SystemActionKind =
  | 'attach'
  | 'navigate'
  | 'reload'
  | 'back'
  | 'wait'
  | 'reinject'
  | 'detach'
  | 'clearBadges';

export interface SystemActionOptions {
  ms?: number;
  blockedDomains?: string[];
}

export interface SystemActionResult {
  ok: boolean;
  aborted?: boolean;
  error?: string;
}

let systemActionSeq = 0;

export async function systemAction(
  runtime: RunRuntime,
  tabId: number,
  kind: SystemActionKind,
  url?: string,
  opts?: SystemActionOptions
): Promise<SystemActionResult> {
  const isCleanup = kind === 'detach' || kind === 'clearBadges';

  // 1. Stop / Pause checks
  if (runtime.control.stopRequested) {
    if (!isCleanup) {
      return { ok: false, aborted: true, error: 'Task was stopped by user.' };
    }
  }

  if (runtime.control.pauseRequested) {
    if (!isCleanup) {
      return { ok: false, aborted: true, error: 'Task is paused.' };
    }
  }

  // 2. Tab scope check
  const inScope = await runtime.browser.isTabInScope(tabId);
  if (!inScope) {
    return { ok: false, error: `Tab ${tabId} is outside this session's ScoutFox group.` };
  }

  // 3. Restricted URL checks on current tab and target URL
  const tab = await runtime.browser.tabInfo(tabId).catch(() => null);
  if (tab?.url) {
    const currentRestricted = describeRestrictedUrl(tab.url);
    if (currentRestricted && (kind === 'attach' || kind === 'reinject')) {
      return { ok: false, error: currentRestricted };
    }
  }

  if (url) {
    const targetRestricted = describeRestrictedUrl(url);
    if (targetRestricted) {
      return { ok: false, error: targetRestricted };
    }
  }

  // 4. Blocked domains
  if (url) {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase();
      const blockedList = opts?.blockedDomains ?? [];
      if (blockedList.some((d) => host === d.toLowerCase() || host.endsWith(`.${d.toLowerCase()}`))) {
        return { ok: false, error: `Domain ${host} is blocked.` };
      }
    } catch (_) {}
  }

  // 5. http(s) target protocol check
  if (kind === 'navigate' && url) {
    if (!/^https?:\/\//i.test(url)) {
      return { ok: false, error: `Restricted protocol in ${url}` };
    }
  }

  // Set system action marker for network recording
  const prevMarker = (runtime as any)._systemActionMarker;
  (runtime as any)._systemActionMarker = `sys:${++systemActionSeq}`;

  try {
    switch (kind) {
      case 'attach': {
        const res = await runtime.browser.cdp.ensureAttached(tabId);
        if (res.mode === 'cdp') {
          runtime.attachedTabIds.add(tabId);
        }
        return { ok: res.mode === 'cdp' || res.reason === null, error: res.reason ?? undefined };
      }

      case 'detach': {
        if (runtime.attachedTabIds.has(tabId)) {
          await cdp.detach(tabId).catch(() => {});
          runtime.attachedTabIds.delete(tabId);
        }
        return { ok: true };
      }

      case 'navigate': {
        await runtime.browser.navigate(tabId, url!);
        await runtime.browser.waitForTabComplete(tabId, 5000).catch(() => {});
        return { ok: true };
      }

      case 'reload': {
        await runtime.browser.reload(tabId);
        await runtime.browser.waitForTabComplete(tabId, 8000).catch(() => {});
        return { ok: true };
      }

      case 'back': {
        await runtime.browser.goBack(tabId);
        await runtime.browser.waitForTabComplete(tabId, 5000).catch(() => {});
        return { ok: true };
      }

      case 'wait': {
        const waitMs = opts?.ms ?? 6000;
        try {
          await runtime.clock.sleep(waitMs, runtime.control.stepSignal());
          return { ok: true };
        } catch (err: any) {
          if (runtime.control.isUserAbort(err, runtime.control.stepSignal())) {
            return { ok: false, aborted: true, error: 'Wait aborted by user' };
          }
          throw err;
        }
      }

      case 'reinject': {
        if (typeof chrome !== 'undefined' && chrome.scripting && chrome.scripting.executeScript) {
          await chrome.scripting.executeScript({
            target: { tabId },
            files: [...CONTENT_SCRIPT_FILES],
          });
          try {
            await chrome.scripting.executeScript({
              target: { tabId, allFrames: true },
              world: 'MAIN',
              files: [NET_RECORDER_FILE],
            });
          } catch (err: any) {
            Logger.warn('Browser', `[INJECT_PARTIAL] Failed to inject net-recorder into MAIN world: ${err.message}`);
          }
        }
        return { ok: true };
      }

      case 'clearBadges': {
        await runtime.browser.clearBadges(tabId);
        return { ok: true };
      }

      default:
        return { ok: false, error: `Unknown system action kind: ${kind}` };
    }
  } finally {
    (runtime as any)._systemActionMarker = prevMarker;
  }
}
