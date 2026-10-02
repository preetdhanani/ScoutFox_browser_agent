/**
 * Chrome DevTools Protocol (CDP) client and debugger lifecycle manager.
 * Handles chrome.debugger attachment, focus emulation, yellow-bar resize detection,
 * idle timeout detach (30 min), and attachment reconciliation.
 */

export interface AttachedTabInfo {
  attachedAt: number;
  pauseTimer?: ReturnType<typeof setTimeout>;
  userDetached?: boolean;
}

export class CDPManager {
  private attachedTabs = new Map<number, AttachedTabInfo>();
  private initialized = false;

  constructor() {
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
   * Tolerates "Another debugger is already attached".
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

    // Cancel any pending pause detach timer
    this.clearPauseTimer(tabId);

    const target = { tabId };
    try {
      await chrome.debugger.attach(target, '1.3');
    } catch (err: any) {
      const msg = (err && err.message) || String(err);
      if (!msg.includes('Another debugger is already attached')) {
        throw err;
      }
    }

    this.attachedTabs.set(tabId, {
      attachedAt: Date.now()
    });

    // Enable focus emulation so elements act as focused in the background
    try {
      await this.sendCommand(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true });
    } catch (_) {
      // Non-fatal if emulation is not supported on this target
    }

    // Wait for the yellow warning bar to settle
    await this.waitForYellowBarSettle(tabId);
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

  /**
   * Send a CDP command to the attached tab.
   */
  async sendCommand(tabId: number, method: string, params: Record<string, unknown> = {}): Promise<any> {
    if (!this.hasDebugger()) {
      throw new Error('chrome.debugger API is not available.');
    }

    return await chrome.debugger.sendCommand({ tabId }, method, params);
  }

  /**
   * Pause handler: starts a 30-minute timer to detach the debugger if still paused.
   */
  startPauseTimer(tabId: number, onDetachCallback?: () => void): void {
    const info = this.attachedTabs.get(tabId);
    if (!info) return;

    if (info.pauseTimer) {
      clearTimeout(info.pauseTimer);
    }

    const THIRTY_MINUTES_MS = 30 * 60 * 1000;
    info.pauseTimer = setTimeout(async () => {
      await this.detach(tabId);
      if (onDetachCallback) {
        onDetachCallback();
      }
    }, THIRTY_MINUTES_MS);
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
   * Detaches any attached target not in activeTabIds.
   */
  async reconcileLeakedTargets(activeTabIds: Set<number>): Promise<void> {
    if (!this.hasDebugger() || !chrome.debugger.getTargets) {
      return;
    }

    try {
      const targets = await chrome.debugger.getTargets();
      for (const target of targets) {
        if (target.attached && target.tabId !== undefined) {
          if (!activeTabIds.has(target.tabId)) {
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
      await new Promise(r => setTimeout(r, 100));
      const current = await readHeight();
      if (current > 0 && current < initialHeight) {
        // Yellow bar appeared and caused a height drop; wait 250ms for layout to settle
        await new Promise(r => setTimeout(r, 250));
        return;
      }
    }
  }
}

export const cdp = new CDPManager();
