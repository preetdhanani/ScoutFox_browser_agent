// src/background/browser/snapshot.ts
// Body of BrowserPort.snapshot: tab validation, scope wall, restricted URL gate,
// content script injection fallback, and error mapping to PerceiveError.

import { describeRestrictedUrl, lastRuntimeError } from './tabs.ts';
import { TOP_FRAME } from './frames.ts';
import { CONTENT_SCRIPT_FILES, NET_RECORDER_FILE, ALL_FRAMES_ISOLATED_FILES } from './contentFiles.ts';
import { Logger } from '../../shared/logger.ts';
import type { PerceiveError } from '../types.ts';

export interface SnapshotOptions {
  showBadges?: boolean;
  maxElements?: number;
}

export interface SnapshotDeps {
  isTabInScope: (tabId: number) => Promise<boolean>;
  clearBadges?: (tabId: number) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

export interface SnapshotResult {
  url?: string;
  title?: string;
  elementsText?: string;
  pageText?: string;
  refs?: number[];
  shownRefs?: number[];
  elementInfo?: Record<number, any>;
  elementCount?: number;
  scrollState?: {
    scrollY?: number;
    pageHeight?: number;
    viewportHeight?: number;
  };
  docId: string;
  data?: any;
  [key: string]: any;
}

export class SnapshotError extends Error {
  readonly kind: PerceiveError['kind'];
  readonly terminal: boolean;
  readonly fatal: boolean;

  constructor(message: string, kind: PerceiveError['kind'], terminal: boolean, fatal: boolean) {
    super(message);
    this.name = 'SnapshotError';
    this.kind = kind;
    this.terminal = terminal;
    this.fatal = fatal;
  }
}

/**
 * Maps an error from taking a DOM snapshot to a structured PerceiveError.
 */
export function toPerceiveError(err: unknown, tries = 1): PerceiveError {
  if (err instanceof SnapshotError) {
    return {
      message: err.message,
      terminal: err.terminal,
      fatal: err.fatal,
      kind: err.kind,
      tries,
    };
  }

  const msg = err instanceof Error ? err.message : String(err || '');

  // A tab_gone message must actually be about a tab. The bare "closed" and "not found"
  // alternatives also caught "connection closed" and "element not found", which made
  // unrelated failures run-fatal. Chrome's own "No tab with id: N." belongs here too.
  if (/no target tab|tabid is required|no tab with id|tab (?:was )?closed|tab[^\n]{0,60}(?:no longer exists|probably closed|not found)/i.test(msg)) {
    return {
      message: msg,
      terminal: true,
      fatal: true,
      kind: 'tab_gone',
      tries,
    };
  }

  if (/outside.*scoutfox group/i.test(msg)) {
    return {
      message: msg,
      terminal: true,
      fatal: true,
      kind: 'out_of_scope',
      tries,
    };
  }

  if (/restricted url|blocks all extensions|cannot automate browser settings|chrome:\/\/|chrome-extension:\/\//i.test(msg)) {
    return {
      message: msg,
      terminal: true,
      fatal: false,
      kind: 'restricted',
      tries,
    };
  }

  return {
    message: msg,
    terminal: false,
    fatal: false,
    kind: 'unreadable',
    tries,
  };
}

/**
 * Reads the page DOM snapshot with scope verification, restricted URL gating,
 * and automatic injection retry.
 */
export async function takeSnapshot(
  tabId: number,
  opts: SnapshotOptions = {},
  deps: SnapshotDeps
): Promise<SnapshotResult> {
  // 1. Missing tabId check
  if (!tabId || typeof tabId !== 'number') {
    throw new SnapshotError('No target tab was selected for this task.', 'tab_gone', true, true);
  }

  // 2. Tab existence check via chrome.tabs.get
  let tab: chrome.tabs.Tab | null = null;
  if (typeof chrome !== 'undefined' && chrome.tabs?.get) {
    try {
      tab = await new Promise<chrome.tabs.Tab | null>((resolve) => {
        const maybePromise: any = chrome.tabs.get(tabId, (t) => {
          const rErr = lastRuntimeError();
          if (rErr || !t) resolve(null);
          else resolve(t);
        });
        if (maybePromise && typeof maybePromise.then === 'function') {
          maybePromise.then((t: any) => resolve(t ?? null), () => resolve(null));
        }
      });
    } catch {
      tab = null;
    }
  } else {
    tab = { id: tabId, url: 'https://example.com', title: 'Example' } as chrome.tabs.Tab;
  }

  if (!tab) {
    throw new SnapshotError(
      `The target tab [${tabId}] no longer exists (it was probably closed). Open the page you want automated and start the task again.`,
      'tab_gone',
      true,
      true
    );
  }

  // 3. Hard access wall: tab must be within this session's ScoutFox group
  const inScope = await deps.isTabInScope(tabId);
  if (!inScope) {
    throw new SnapshotError(
      `Tab [${tabId}] is outside this session's ScoutFox group and cannot be automated from here. Each window's ScoutFox session only acts on tabs within its own group.`,
      'out_of_scope',
      true,
      true
    );
  }

  // 4. Restricted URL gate
  const restriction = describeRestrictedUrl(tab.url || '');
  if (restriction) {
    throw new SnapshotError(restriction, 'restricted', true, false);
  }

  // 5. Clear badges if explicitly requested false
  if (opts.showBadges === false && deps.clearBadges) {
    await deps.clearBadges(tabId).catch(() => {});
  }

  const sendSnapshotMessage = (tId: number): Promise<any> => {
    return new Promise((resolve, reject) => {
      if (typeof chrome === 'undefined' || !chrome.tabs?.sendMessage) {
        return resolve({
          success: true,
          data: { url: tab?.url || '', title: tab?.title || '', elementsText: '', refs: [] },
          docId: 'doc-1',
        });
      }
      chrome.tabs.sendMessage(
        tId,
        {
          action: 'GET_DOM_SNAPSHOT',
          payload: {
            maxElements: opts.maxElements ?? 120,
            // Element badges are off: numbers are drawn on the page only when a caller asks for them.
            showBadges: opts.showBadges === true,
          },
        },
        TOP_FRAME,
        (resp) => {
          const err = lastRuntimeError();
          if (err) {
            reject(new Error(err));
          } else if (resp && resp.success === false) {
            reject(new SnapshotError(resp.error || 'DOM snapshot failed', 'unreadable', false, false));
          } else if (!resp) {
            reject(new Error('No response from content script'));
          } else {
            resolve(resp);
          }
        }
      );
    });
  };

  // 6. First attempt to capture snapshot
  try {
    const resp = await sendSnapshotMessage(tabId);
    const data = resp?.data ?? resp;
    const docId = resp?.docId ?? data?.docId ?? 'doc-1';
    return {
      ...data,
      data,
      docId,
    };
  } catch (primaryErr: any) {
    if (primaryErr instanceof SnapshotError) {
      throw primaryErr;
    }
    // 7. Fallback injection attempt
    Logger.debug('Browser', `[INJECT] Content script not active on tab [${tabId}] (${tab.url}). Injecting script dependencies...`);

    try {
      if (typeof chrome !== 'undefined' && chrome.scripting?.executeScript) {
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
        } catch (netErr: any) {
          Logger.warn(
            'Browser',
            `[INJECT_PARTIAL] Page scripts loaded, but the network recorder could not be injected into tab [${tabId}].`,
            netErr
          );
        }

        // The per-frame relay is what carries child-frame records to the
        // background; without it iframe traffic never reaches
        // NET_REQUEST_RECORDED (BUG-45).
        try {
          await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            files: [...ALL_FRAMES_ISOLATED_FILES],
          });
        } catch (relayErr: any) {
          Logger.warn(
            'Browser',
            `[INJECT_PARTIAL] The per-frame network relay could not be injected into tab [${tabId}]. Network records from child frames will be missing.`,
            relayErr
          );
        }
      }

      if (deps.sleep) {
        await deps.sleep(400);
      } else {
        await new Promise((r) => setTimeout(r, 400));
      }

      const retryResp = await sendSnapshotMessage(tabId);
      const data = retryResp?.data ?? retryResp;
      const docId = retryResp?.docId ?? data?.docId ?? 'doc-1';
      return {
        ...data,
        data,
        docId,
      };
    } catch (injectErr: any) {
      if (injectErr instanceof SnapshotError) {
        throw injectErr;
      }
      Logger.error('Browser', `[INJECT_FAILED] Could not inject page scripts into tab [${tabId}] (${tab.url})`, injectErr);
      throw new SnapshotError(
        `Could not read the page at ${tab.url} - ${injectErr.message}. Reload that tab (Cmd+R) and start the task again.`,
        'unreadable',
        false,
        false
      );
    }
  }
}
