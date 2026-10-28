// src/background/browser/execute.ts
// Runs one page action of an MCP tool on a tab through the input dispatcher, then settles and
// reports what the action changed.

import { describeRestrictedUrl } from './tabs.ts';
import { checkWebUrl } from '../research/urlPolicy.ts';
import { inputDispatcher } from './input.ts';
import type { ExecResult, RunRuntime } from '../runner/runtimeRegistry.ts';
import type { EffectDetail, OneShot } from '../types.ts';

export interface ExecuteActionDeps {
  runRuntime?: RunRuntime;
  docId?: string;
  signal?: AbortSignal;
  dispatchAction?: (tabId: number, action: any, opts: any) => Promise<any>;
  tabInfo?: (tabId: number) => Promise<{ url: string; title: string; windowId: number; groupId: number; status: string } | null>;
  waitForTabComplete?: (tabId: number, ms: number, signal?: AbortSignal) => Promise<void>;
  /**
   * Resolves true when the tab starts loading (or its URL changes) within `ms`, false when it does
   * not. Defaults to chrome.tabs.onUpdated.
   */
  watchLoadStart?: (tabId: number, ms: number, signal?: AbortSignal) => Promise<boolean>;
  waitDomQuiet?: (tabId: number, quietMs: number, maxMs: number) => Promise<void>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  actionDelayMs?: number;
  /** Reads the effect probe again after the action settled. Defaults to the content script's probe. */
  readProbe?: (tabId: number) => Promise<EffectDetail | null>;
}

/**
 * How long after a click, a coordinate click or a submitting type a page load must start to count
 * as one the action caused. A single-page app never loads, so waiting for "complete" there only
 * ever timed out: the settle now waits for a load only when one started.
 */
export const LOAD_START_WINDOW_MS = 500;

/** How long an action waits for a load that did start to complete. */
export const LOAD_COMPLETE_MAX_MS = 4000;

/** The longest wait for the DOM to go quiet after an action: a page with a ticker is never quiet. */
export const SETTLE_QUIET_MAX_MS = 800;

/**
 * Whether the tab starts loading, or changes its URL, within `ms`, read from chrome.tabs.onUpdated.
 * False when there is no tabs API to watch.
 */
export function watchLoadStartWithChrome(tabId: number, ms: number, signal?: AbortSignal): Promise<boolean> {
  if (typeof chrome === 'undefined' || !chrome.tabs?.onUpdated) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (value: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { chrome.tabs.onUpdated.removeListener(listener); } catch (_) {}
      resolve(value);
    };
    const listener = (updatedTabId: number, changeInfo: { status?: string; url?: string }) => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === 'loading' || typeof changeInfo.url === 'string') finish(true);
    };
    const timer = setTimeout(() => finish(false), ms);
    chrome.tabs.onUpdated.addListener(listener);
    signal?.addEventListener('abort', () => finish(false), { once: true });
  });
}

/** The actions whose result carries an observation: the probe is read again after they settled. */
const OBSERVED_VERBS = new Set(['click', 'click_at', 'type', 'press_key', 'scroll']);

/**
 * Dispatches an action onto a tab with safety gates and proper execution routing.
 */
export async function executeAction(
  tabId: number,
  action: any,
  deps: ExecuteActionDeps
): Promise<ExecResult> {
  const signal = deps.signal ?? deps.runRuntime?.control.stepSignal();
  const verb = action?.action;

  // 1. Abort signal check
  if (signal?.aborted) {
    return {
      success: false,
      error: 'Action aborted',
      via: verb === 'navigate' || verb === 'go_back' || verb === 'go_forward' ? 'background' : 'cdp',
      effect: 'none',
    };
  }

  // 2. Restricted gates on the navigate target URL
  if (verb === 'navigate' && action?.url) {
    const restriction = describeRestrictedUrl(action.url);
    if (restriction) {
      return {
        success: false,
        error: restriction,
        via: 'background',
        effect: 'none',
      };
    }

    // The same URL rule as fetch_url (research/urlPolicy.ts): parsed, http(s) only, a host, no credentials.
    const checked = checkWebUrl(action.url);
    if (!checked.ok) {
      return {
        success: false,
        error: `Navigate target refused: ${checked.error}`,
        via: 'background',
        effect: 'none',
      };
    }
  }

  // 3. wait: clamped to 1..5 s and run in the background, where the step
  // signal can interrupt it. The content-side wait took any amount unchecked
  // (a cloud reply of amount:600 parked the run for 10 minutes inside one
  // action) and had no abort wiring (BUG-36).
  if (verb === 'wait') {
    const rawWait = Number((action as any).amount ?? (action as any).seconds ?? 1);
    const waitSec = Number.isFinite(rawWait) ? Math.min(5, Math.max(1, rawWait)) : 1;
    const sleepFn =
      deps.sleep ??
      ((ms: number, sig?: AbortSignal) =>
        deps.runRuntime?.clock ? deps.runRuntime.clock.sleep(ms, sig) : new Promise<void>((r) => setTimeout(r, ms)));
    try {
      await sleepFn(waitSec * 1000, signal);
    } catch (err: any) {
      if (signal?.aborted) {
        return { success: false, error: 'Action aborted', via: 'background', effect: 'none' };
      }
      throw err;
    }
    return { success: true, message: `Waited ${waitSec}s`, via: 'background', effect: 'none' };
  }

  // Helper for reading tab URL before/after
  const getTabUrl = async (tId: number): Promise<string> => {
    if (deps.tabInfo) {
      const info = await deps.tabInfo(tId).catch(() => null);
      return info?.url ?? '';
    }
    if (deps.runRuntime) {
      const info = await deps.runRuntime.browser.tabInfo(tId).catch(() => null);
      return info?.url ?? '';
    }
    return '';
  };

  const waitComplete = async (tId: number, ms: number): Promise<void> => {
    if (deps.waitForTabComplete) {
      await deps.waitForTabComplete(tId, ms, signal).catch(() => {});
    } else if (deps.runRuntime) {
      await deps.runRuntime.browser.waitForTabComplete(tId, ms).catch(() => {});
    }
  };

  const waitQuiet = async (tId: number, quietMs: number, maxMs: number): Promise<void> => {
    if (deps.waitDomQuiet) {
      await deps.waitDomQuiet(tId, quietMs, maxMs).catch(() => {});
    } else if (deps.runRuntime) {
      await deps.runRuntime.browser.waitDomQuiet(tId, quietMs, maxMs).catch(() => {});
    }
  };

  // A load the action started: the tab is loading or on another URL already, or it starts within
  // LOAD_START_WINDOW_MS. Only then is a "complete" worth waiting for.
  const loadStarted = async (tId: number, urlBefore: string): Promise<boolean> => {
    const info = deps.tabInfo
      ? await deps.tabInfo(tId).catch(() => null)
      : deps.runRuntime
        ? await deps.runRuntime.browser.tabInfo(tId).catch(() => null)
        : null;
    if (info?.status === 'loading') return true;
    if (info?.url && urlBefore && info.url !== urlBefore) return info.status !== 'complete';
    const watch = deps.watchLoadStart ?? watchLoadStartWithChrome;
    return await watch(tId, LOAD_START_WINDOW_MS, signal).catch(() => false);
  };

  const doSleep = async (ms: number): Promise<void> => {
    if (deps.sleep) {
      await deps.sleep(ms, signal).catch(() => {});
    } else if (deps.runRuntime?.clock) {
      await deps.runRuntime.clock.sleep(ms, signal).catch(() => {});
    } else {
      await new Promise((r) => setTimeout(r, ms));
    }
  };

  // 4. Page actions dispatched via inputDispatcher / dispatchAction
  try {
    const urlBefore = await getTabUrl(tabId);
    const isNav = verb === 'navigate' || verb === 'go_back' || verb === 'go_forward';

    const res = deps.dispatchAction
      ? await deps.dispatchAction(tabId, action, { docId: deps.docId, signal })
      : await inputDispatcher.dispatchAction(tabId, action, {
          docId: deps.docId,
          signal,
          sleep:
            deps.sleep ??
            ((ms, s) =>
              deps.runRuntime?.clock
                ? deps.runRuntime.clock.sleep(ms, s)
                : new Promise((r) => setTimeout(r, ms))),
          control: deps.runRuntime
            ? {
                stopRequested: deps.runRuntime.control.stopRequested,
                pauseRequested: deps.runRuntime.control.pauseRequested,
                signal,
              }
            : undefined,
        });

    // A synthetic result carries the effect probe result from fallbackToSynthetic; without one
    // it must not default to dom_changed, or a synthetic action that changed nothing would be
    // reported as "page updated" and verify would never fire the no-visible-change failure.
    const viaSynthetic = res.via === 'synthetic';
    let effect =
      (res.effect as ExecResult['effect']) ||
      (res.success && !viaSynthetic ? 'dom_changed' : 'none');
    // A lookup never changes the page, whatever the effect probe counted.
    if (verb === 'find_element' || verb === 'read_page') effect = 'none';
    const isClick = verb === 'click' || verb === 'click_at';
    const isTypeSubmit = verb === 'type' && (res.submitted || Boolean(action?.submit));

    let urlAfter = '';
    if (res.success && (isNav || isClick || isTypeSubmit)) {
      if (!action?.expected_outcome && await loadStarted(tabId, urlBefore)) {
        await waitComplete(tabId, LOAD_COMPLETE_MAX_MS);
      }
      urlAfter = await getTabUrl(tabId);
      if (urlAfter && urlBefore !== urlAfter) {
        effect = 'url_changed';
      } else if (isNav) {
        effect = 'none';
      }
    }

    // Full post-action settle
    if (res.success && (isNav || isClick || isTypeSubmit || verb === 'scroll' || verb === 'press_key')) {
      await waitQuiet(tabId, 300, SETTLE_QUIET_MAX_MS);
    }

    // The facts of the action, read once more after the settle, so the observation describes the
    // page the model will act on next. A page that does not answer keeps the reading taken right
    // after the input; with an injected dispatcher (a test) only an injected reader is asked.
    let effectDetail: EffectDetail | undefined = res.effectDetail;
    if (res.success && OBSERVED_VERBS.has(verb)) {
      const reader = deps.readProbe ?? (deps.dispatchAction ? null : (tId: number) => inputDispatcher.readProbe(tId));
      const settled = reader ? await reader(tabId).catch(() => null) : null;
      if (settled) effectDetail = settled;
    }

    // Action delay if configured
    const delay = deps.actionDelayMs ?? 0;
    if (res.success && delay > 0) {
      await doSleep(delay);
    }

    let oneShot: OneShot | undefined = undefined;
    if (verb === 'read_page' && res.success) {
      const pageText = res.result?.pageText ?? res.pageText ?? res.message ?? '';
      // The part note ("12000 chars, part 2 of 4, ...") and the stop hint go in the label the model
      // reads, not only in the raw message, or the model never learns which part it has.
      const note = typeof res.result?.note === 'string' && res.result.note ? res.result.note : undefined;
      oneShot = { label: note ? `Page Text (${note})` : 'Page Text', text: pageText, step: action.step ?? 0, ...(note ? { note } : {}) };
    }

    // find_element: a lookup never changes the page. The matcher's order is the answer: no extra
    // model call reorders it (that call went out without the run's effort and model settings).
    const findMessage = res.message;
    if (verb === 'find_element' && res.success) {
      oneShot = { label: 'Element Matches', text: findMessage ?? '', step: action.step ?? 0 };
    }

    return {
      success: res.success,
      message: findMessage,
      error: res.error,
      label: res.label ?? undefined,
      submitted: res.submitted,
      result: res.result ?? res.results ?? undefined,
      resultData: res.result ?? res.results ?? undefined,
      via: isNav ? 'background' : (res.via ?? 'cdp'),
      effect,
      urlAfter: urlAfter || res.urlAfter || undefined,
      syntheticReason: (res as any).syntheticReason,
      oneShot,
      ...(effectDetail ? { effectDetail } : {}),
      ...(res.fieldText !== undefined ? { fieldText: res.fieldText } : {}),
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message,
      via: verb === 'navigate' || verb === 'go_back' || verb === 'go_forward' ? 'background' : 'synthetic',
      effect: 'none',
    };
  }
}
