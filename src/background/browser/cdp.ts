/**
 * Chrome DevTools Protocol (CDP) client and debugger lifecycle manager.
 * Handles chrome.debugger attachment, focus emulation, yellow-bar resize detection,
 * idle timeout detach (30 min), and attachment reconciliation.
 */

export interface AttachedTabInfo {
  attachedAt: number;
  /** The last attach or CDP command on this tab; the leak sweep leaves a recently used tab alone. */
  lastUsedAt?: number;
  pauseTimer?: ReturnType<typeof setTimeout>;
  userDetached?: boolean;
  /** Whether Page.enable was already sent for this attachment, so it stays off the hot path. */
  pageEnabled?: boolean;
}

export interface CDPManagerOptions {
  /** Timer for one chrome.debugger.attach round (including the foreign-debugger retries). */
  attachTimeoutMs?: number;
  /** Timer for one CDP command. */
  commandTimeoutMs?: number;
  /** The leak sweep does not detach a tab that ran an attach or a command within this window. */
  recentUseGraceMs?: number;
}

/** Which tabs the leak sweep keeps: a set of ids, or a predicate for callers whose set is large or dynamic. */
export type KeepTabs = ReadonlySet<number> | ((tabId: number) => boolean);

const DEFAULT_ATTACH_TIMEOUT_MS = 10_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
/** A tab that took a CDP command within this window is in use, whatever the caller's keep set says. */
const DEFAULT_RECENT_USE_GRACE_MS = 5 * 60 * 1000;
/** The foreign-extension iframe case often clears within moments: four tries, short backoff. */
const FOREIGN_ATTACH_TRIES = 4;
const FOREIGN_ATTACH_BACKOFF_MS = 100;

/** A CDP timer ran out. For an attach, the attach itself may still finish later. */
class CdpTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CdpTimeoutError';
  }
}

export class CDPManager {
  private attachedTabs = new Map<number, AttachedTabInfo>();
  private initialized = false;
  private attachTimeoutMs: number;
  private commandTimeoutMs: number;
  private recentUseGraceMs: number;
  /** Tabs whose debugger session ended while their attach round was still running, with the reason. */
  private detachedMidAttach = new Map<number, string>();
  /** In-flight attach per tab, so concurrent callers share one debugger.attach round. */
  private attaching = new Map<number, Promise<void>>();
  /** Tabs with an attach in flight; sendCommand must not re-attach from inside one. */
  private inAttach = new Set<number>();

  constructor(options: CDPManagerOptions = {}) {
    this.attachTimeoutMs = options.attachTimeoutMs ?? DEFAULT_ATTACH_TIMEOUT_MS;
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.recentUseGraceMs = options.recentUseGraceMs ?? DEFAULT_RECENT_USE_GRACE_MS;
    this.setupListeners();
  }

  private hasDebugger(): boolean {
    return typeof chrome !== 'undefined' && 'debugger' in chrome && Boolean(chrome.debugger);
  }

  private setupListeners(): void {
    if (this.initialized) return;
    if (this.hasDebugger() && chrome.debugger.onDetach) {
      chrome.debugger.onDetach.addListener((source, reason) => {
        if (source.tabId !== undefined) {
          // A session that ends while its attach round is still settling: the round must not
          // mark the tab attached afterwards.
          if (this.attaching.has(source.tabId)) {
            this.detachedMidAttach.set(source.tabId, String(reason));
          }
          const info = this.attachedTabs.get(source.tabId);
          if (info) {
            if (info.pauseTimer) {
              clearTimeout(info.pauseTimer);
            }
            if (reason === 'canceled_by_user') {
              info.userDetached = true;
            } else {
              this.attachedTabs.delete(source.tabId);
            }
          }
        }
      });
      this.initialized = true;
    }
  }

  /**
   * Check if the debugger is attached to the given tab and active.
   */
  isAttached(tabId: number): boolean {
    const info = this.attachedTabs.get(tabId);
    return !!info && !info.userDetached;
  }

  /**
   * Check if the user specifically dismissed the yellow bar on this tab.
   */
  isUserDetached(tabId: number): boolean {
    const info = this.attachedTabs.get(tabId);
    return !!info && !!info.userDetached;
  }

  /**
   * Attach debugger to tabId and enable focus emulation.
   * Deduplicated per tab: an already tracked tab is a no-op and concurrent
   * attaches share one round. The foreign-debugger error ("Another debugger
   * is already attached", e.g. DevTools or another extension holding the tab)
   * is retried with a short backoff and, if it persists, fails loudly instead
   * of being swallowed as a successful attach.
   */
  async attach(tabId: number): Promise<void> {
    if (!this.hasDebugger()) {
      throw new Error('chrome.debugger API is not available in this environment.');
    }

    this.setupListeners();

    // If user explicitly dismissed the yellow bar, do not re-attach; synthetic fallback is used
    if (this.isUserDetached(tabId)) {
      return;
    }

    // An attach in flight first: a second caller waits for the same round, settle wait included,
    // instead of returning while Page.enable and the debugger bar are still in progress.
    const inFlight = this.attaching.get(tabId);
    if (inFlight) {
      return await inFlight;
    }

    // Already tracked as attached: nothing to do (dedupe). Only a finished round marks a tab.
    if (this.isAttached(tabId)) {
      return;
    }

    const round = this.attachRound(tabId).finally(() => {
      this.attaching.delete(tabId);
      this.inAttach.delete(tabId);
    });
    this.attaching.set(tabId, round);
    this.inAttach.add(tabId);
    return await round;
  }

  private async attachRound(tabId: number): Promise<void> {
    // Cancel any pending pause detach timer
    this.clearPauseTimer(tabId);

    const target = { tabId };
    let lastForeignError: Error | undefined;

    this.detachedMidAttach.delete(tabId);

    for (let attempt = 1; attempt <= FOREIGN_ATTACH_TRIES; attempt++) {
      const pending = Promise.resolve(chrome.debugger.attach(target, '1.3')) as Promise<void>;
      try {
        await this.withTimeout(
          pending,
          this.attachTimeoutMs,
          `Debugger attach timed out after ${Math.round(this.attachTimeoutMs / 1000)} s (DevTools may be open or the renderer crashed).`
        );
      } catch (err: any) {
        if (err instanceof CdpTimeoutError) {
          // The timer won, but chrome.debugger.attach can still succeed later. That session would
          // be held by nobody and every later attach would fail "Another debugger is already
          // attached", so a late success is detached again.
          pending.then(
            () => {
              Promise.resolve(chrome.debugger.detach(target)).catch(() => {});
            },
            () => {}
          );
          throw err;
        }
        const msg = (err && err.message) || String(err);
        if (!msg.includes('Another debugger is already attached')) {
          throw err;
        }
        lastForeignError = new Error(
          'Debugger could not attach: another debugger (DevTools or another extension) is attached to this tab.'
        );
        if (attempt < FOREIGN_ATTACH_TRIES) {
          await this.sleepDelay(FOREIGN_ATTACH_BACKOFF_MS * attempt);
          continue;
        }
        throw lastForeignError;
      }

      // Enable focus emulation so elements act as focused in the background
      try {
        await this.sendCommand(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true });
      } catch (_) {
        // Non-fatal if emulation is not supported on this target
      }

      // Enable the Page domain once per attachment. chrome.debugger.attach does not reliably
      // enable it, and a Page.captureScreenshot that fails with "wasn't found" is a confusing
      // first-run surprise. Page.enable is idempotent; the flag keeps it off the hot path.
      let pageEnabled = false;
      try {
        await this.sendCommand(tabId, 'Page.enable', {});
        pageEnabled = true;
      } catch (_) {
        // A target without the Page domain still takes every other command.
      }

      // Wait for the yellow warning bar to settle
      await this.waitForYellowBarSettle(tabId);

      // The tab is marked attached only now, after the settle wait, so isAttached never reports
      // a tab whose viewport is still moving. A session that ended during the round is not marked.
      const endedReason = this.detachedMidAttach.get(tabId);
      this.detachedMidAttach.delete(tabId);
      if (endedReason !== undefined) {
        if (endedReason === 'canceled_by_user') {
          this.attachedTabs.set(tabId, { attachedAt: Date.now(), userDetached: true });
          return;
        }
        throw new Error(`Debugger detached from the tab while attaching (${endedReason}).`);
      }
      const now = Date.now();
      this.attachedTabs.set(tabId, { attachedAt: now, lastUsedAt: now, pageEnabled });
      return;
    }
  }

  /** Rejects with the named error (a CdpTimeoutError) when the promise does not settle within the timer. */
  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new CdpTimeoutError(message)), timeoutMs);
      if (typeof (timer as any)?.unref === 'function') {
        (timer as any).unref();
      }
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        }
      );
    });
  }

  /**
   * Detach debugger from tabId idempotently.
   */
  async detach(tabId: number): Promise<void> {
    this.clearPauseTimer(tabId);
    this.attachedTabs.delete(tabId);

    if (!this.hasDebugger()) {
      return;
    }

    try {
      await chrome.debugger.detach({ tabId });
    } catch (err: any) {
      const msg = (err && err.message) || String(err);
      if (!msg.includes('Debugger is not attached') && !msg.includes('No tab with given id')) {
        // Log or rethrow non-idempotent errors if needed
      }
    }
  }

  /**
   * Detach debugger from all tracked attached tabs.
   */
  async detachAll(): Promise<void> {
    const tabIds = Array.from(this.attachedTabs.keys());
    await Promise.allSettled(tabIds.map((tabId) => this.detach(tabId)));
  }

  private activeControl?: { signal?: AbortSignal; stopRequested?: boolean; pauseRequested?: boolean };

  setActiveControl(control?: { signal?: AbortSignal; stopRequested?: boolean; pauseRequested?: boolean }): void {
    this.activeControl = control;
  }

  /**
   * Send a CDP command to the attached tab. The command runs under a timer,
   * and a not-attached or detached-while-handling error re-attaches once and
   * repeats the command instead of failing the action silently.
   */
  async sendCommand(
    tabId: number,
    method: string,
    params: Record<string, unknown> = {},
    control?: { signal?: AbortSignal; stopRequested?: boolean; pauseRequested?: boolean },
    retried = false
  ): Promise<any> {
    if (!this.hasDebugger()) {
      throw new Error('chrome.debugger API is not available.');
    }

    const isExempt =
      (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased') ||
      (method === 'Input.dispatchKeyEvent' && params?.type === 'keyUp');

    const effectiveControl = control ?? this.activeControl;

    const used = this.attachedTabs.get(tabId);
    if (used) used.lastUsedAt = Date.now();

    if (!isExempt) {
      if (effectiveControl?.signal?.aborted || effectiveControl?.stopRequested || effectiveControl?.pauseRequested) {
        throw new Error(`CDP command ${method} aborted: stop or pause requested.`);
      }
    }

    try {
      return await this.withTimeout(
        Promise.resolve(chrome.debugger.sendCommand({ tabId }, method, params)) as Promise<any>,
        this.commandTimeoutMs,
        `CDP command ${method} timed out after ${Math.round(this.commandTimeoutMs / 1000)} s (the renderer may have crashed or the debugger detached).`
      );
    } catch (err: any) {
      const msg = (err && err.message) || String(err);
      const detached = /not attached|detached while handling|detachedFromTarget/i.test(msg);
      if (
        retried ||
        !detached ||
        this.inAttach.has(tabId) ||
        (effectiveControl?.signal?.aborted || effectiveControl?.stopRequested || effectiveControl?.pauseRequested)
      ) {
        throw err;
      }
      // Re-attach once and repeat the command; if that fails too, the error goes to the caller.
      await this.attach(tabId);
      return await this.sendCommand(tabId, method, params, control, true);
    }
  }

  private clockSleep?: (ms: number, signal?: AbortSignal) => Promise<void>;

  setClockSleep(fn: (ms: number, signal?: AbortSignal) => Promise<void>): void {
    this.clockSleep = fn;
  }

  private async sleepDelay(ms: number, signal?: AbortSignal): Promise<void> {
    if (this.clockSleep) {
      await this.clockSleep(ms, signal);
    } else {
      await new Promise((r) => setTimeout(r, ms));
    }
  }

  /**
   * Pause handler: starts a 30-minute timer to detach the debugger if still paused.
   */
  startPauseTimer(tabId: number, onDetachCallback?: () => void, timeoutMs = 30 * 60 * 1000): void {
    const info = this.attachedTabs.get(tabId);
    if (!info) return;

    if (info.pauseTimer) {
      clearTimeout(info.pauseTimer);
    }

    info.pauseTimer = setTimeout(async () => {
      await this.detach(tabId);
      if (onDetachCallback) {
        onDetachCallback();
      }
    }, timeoutMs);
    if (typeof (info.pauseTimer as any)?.unref === 'function') {
      (info.pauseTimer as any).unref();
    }
  }

  /**
   * Resume handler: clears any pause timer and re-attaches if needed.
   */
  clearPauseTimer(tabId: number): void {
    const info = this.attachedTabs.get(tabId);
    if (info && info.pauseTimer) {
      clearTimeout(info.pauseTimer);
      info.pauseTimer = undefined;
    }
  }

  /**
   * Reconcile leaked attachments at boot or on alarm.
   * Detaches any attached target the caller does not keep. `keep` is a set of tab ids or a
   * predicate. Whatever it says, a tab with an attach in flight, or one that ran an attach or a
   * CDP command within the recent-use grace, is in use and never treated as a leak: the caller's
   * set can lag behind a run that just reached a new tab.
   */
  async reconcileLeakedTargets(keep: KeepTabs): Promise<void> {
    if (!this.hasDebugger() || !chrome.debugger.getTargets) {
      return;
    }

    const kept = typeof keep === 'function' ? keep : (tabId: number) => keep.has(tabId);
    const inUse = (tabId: number): boolean => {
      if (this.attaching.has(tabId)) return true;
      const info = this.attachedTabs.get(tabId);
      const lastUsedAt = info?.lastUsedAt ?? info?.attachedAt;
      return lastUsedAt !== undefined && Date.now() - lastUsedAt < this.recentUseGraceMs;
    };

    try {
      const targets = await chrome.debugger.getTargets();
      for (const target of targets) {
        if (target.attached && target.tabId !== undefined) {
          if (!kept(target.tabId) && !inUse(target.tabId)) {
            try {
              await chrome.debugger.detach({ tabId: target.tabId });
            } catch (_) {}
            this.attachedTabs.delete(target.tabId);
          }
        }
      }
    } catch (_) {}
  }

  /**
   * Detects yellow bar appearance: reads innerHeight and waits up to 1.5s for settle.
   */
  private async waitForYellowBarSettle(tabId: number): Promise<void> {
    if (typeof chrome === 'undefined' || !chrome.scripting || !chrome.scripting.executeScript) {
      return;
    }

    const readHeight = async (): Promise<number> => {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => (globalThis as any).innerHeight
        });
        return (results && results[0] && typeof results[0].result === 'number') ? results[0].result : 0;
      } catch (_) {
        return 0;
      }
    };

    const initialHeight = await readHeight();
    if (initialHeight === 0) return;

    const start = Date.now();
    const TIMEOUT_MS = 1500;

    while (Date.now() - start < TIMEOUT_MS) {
      await this.sleepDelay(100);
      const current = await readHeight();
      if (current > 0 && current < initialHeight) {
        // Yellow bar appeared and caused a height drop; wait 250ms for layout to settle
        await this.sleepDelay(250);
        return;
      }
    }
  }
}

export const cdp = new CDPManager();
