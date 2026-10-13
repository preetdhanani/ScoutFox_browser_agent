// src/background/browser/windows.ts
// Multi-window operations for ScoutFox browser automation.
import { lastRuntimeError } from './tabs.ts';
import { Logger } from '../../shared/logger.ts';

export interface WindowContext {
  adoptTab?(tabId: number, windowId: number): void | Promise<void>;
  ensureGroup?(tabId: number, windowId: number): Promise<number | null>;
  setActiveTab?(tabId: number): void | Promise<void>;
}

export interface OpenWindowResult {
  success: boolean;
  message?: string;
  error?: string;
  windowId?: number;
  tabId?: number;
}

export async function openNewWindow(
  ctx: WindowContext,
  url?: string
): Promise<OpenWindowResult> {
  if (typeof chrome === 'undefined' || !chrome.windows || !chrome.windows.create) {
    return {
      success: false,
      error: 'chrome.windows is unavailable in this context, so a new window cannot be opened.',
    };
  }

  const targetUrl = url && /^https?:\/\//i.test(url) ? url : (url || 'https://www.google.com');

  try {
    const win = await new Promise<chrome.windows.Window | null>((resolve, reject) => {
      chrome.windows.create({ url: targetUrl, focused: true }, (w) => {
        const err = lastRuntimeError();
        if (err) {
          reject(new Error(err));
          return;
        }
        resolve(w ?? null);
      });
    });

    const newTab = win && Array.isArray(win.tabs) ? win.tabs[0] : null;
    if (!win || !newTab || typeof newTab.id !== 'number' || typeof win.id !== 'number') {
      return {
        success: false,
        error: 'The new window was created, but no tab was found in it.',
      };
    }

    if (ctx.adoptTab) {
      try {
        await ctx.adoptTab(newTab.id, win.id);
      } catch (err: any) {
        Logger.warn('Browser', '[TAB_ADOPTED_CALLBACK_ERROR] onTabAdoptedCallback threw', err);
      }
    }

    if (ctx.ensureGroup) {
      const groupId = await ctx.ensureGroup(newTab.id, win.id);
      if (!groupId) {
        // The tab is still adopted and drivable (the runner keeps adopted tabs
        // in scope without a group), but the grouping itself failed - say so
        // instead of failing silently (BUG-39).
        Logger.warn('Browser', `[WINDOW_GROUP_FAILED] Tab [${newTab.id}] in window [${win.id}] could not be added to a ScoutFox group; the session keeps it in scope by adoption.`);
      }
    }

    if (ctx.setActiveTab) {
      await ctx.setActiveTab(newTab.id);
    }

    Logger.info(
      'Browser',
      `[WINDOW_OPENED] Opened a new window [${win.id}] at ${targetUrl}, now driving tab [${newTab.id}] there. Still the same session.`
    );

    return {
      success: true,
      message: `Opened a new window at ${targetUrl} and switched to it.`,
      windowId: win.id,
      tabId: newTab.id,
    };
  } catch (err: any) {
    return {
      success: false,
      error: `Could not open a new window: ${err.message}`,
    };
  }
}
