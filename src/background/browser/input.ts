/**
 * Unified input dispatcher for browser automation (Phase P3).
 * Routes clicks, keystrokes, and text inputs through CDP trusted events
 * when available, with automatic fallback to synthetic DOM events on
 * restricted pages, detached debugger, or native <select> elements.
 */

import { cdp as defaultCdp, CDPManager } from './cdp.ts';
import type { ResolvePointResponse } from '../../content/types.ts';
import { Logger } from '../../shared/logger.ts';

export interface DispatchOptions {
  docId?: string;
  signal?: AbortSignal;
}

export interface DispatchResult {
  success: boolean;
  message?: string;
  error?: string;
  label?: string | null;
  submitted?: boolean;
  result?: unknown;
  results?: unknown;
  via: 'cdp' | 'synthetic' | 'background';
  effect?: string;
  stale?: boolean;
  obscuredBy?: string;
}

interface KeyDefinition {
  code: string;
  windowsVirtualKeyCode: number;
  text?: string;
  unmodifiedText?: string;
}

const SPECIAL_KEYS: Record<string, KeyDefinition> = {
  Enter: { code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' },
  Tab: { code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { code: 'Backspace', windowsVirtualKeyCode: 8 },
  ArrowDown: { code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowUp: { code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowLeft: { code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  PageDown: { code: 'PageDown', windowsVirtualKeyCode: 34 },
  PageUp: { code: 'PageUp', windowsVirtualKeyCode: 33 },
  Home: { code: 'Home', windowsVirtualKeyCode: 36 },
  End: { code: 'End', windowsVirtualKeyCode: 35 },
  Delete: { code: 'Delete', windowsVirtualKeyCode: 46 },
  Space: { code: 'Space', windowsVirtualKeyCode: 32, text: ' ', unmodifiedText: ' ' }
};

export class InputDispatcher {
  private cdp: CDPManager;

  constructor(cdp: CDPManager = defaultCdp) {
    this.cdp = cdp;
  }

  /**
   * Main entry point to dispatch an action on a tab.
   */
  async dispatchAction(
    tabId: number,
    actionPayload: Record<string, any>,
    options: DispatchOptions = {}
  ): Promise<DispatchResult> {
    const { signal, docId } = options;

    if (signal?.aborted) {
      return {
        success: false,
        error: 'Action aborted before execution.',
        via: 'synthetic'
      };
    }

    const action = actionPayload.action;

    switch (action) {
      case 'click':
        return await this.handleClick(tabId, actionPayload, docId, signal);

      case 'type':
        return await this.handleType(tabId, actionPayload, docId, signal);

      case 'select':
        // Native <select> menus always use synthetic DOM setter to avoid OS popup locks
        return await this.fallbackToSynthetic(tabId, actionPayload);

      case 'press_key':
      case 'keypress':
        return await this.handlePressKey(tabId, actionPayload, signal);

      default:
        // scroll, wait, navigate, go_back, go_forward, browser_batch, read_page_text, etc.
        return await this.fallbackToSynthetic(tabId, actionPayload);
    }
  }

  /**
   * Handles click action via CDP trusted mouse events, falling back to synthetic if needed.
   */
  private async handleClick(
    tabId: number,
    payload: Record<string, any>,
    docId?: string,
    signal?: AbortSignal
  ): Promise<DispatchResult> {
    const targetId = payload.element_id ?? payload.index ?? payload.elementId;
    if (targetId === undefined || targetId === null) {
      return {
        success: false,
        error: 'Click action requires an element_id.',
        via: 'synthetic'
      };
    }

    const canUseCDP = await this.ensureCdpAttached(tabId);
    if (!canUseCDP) {
      return await this.fallbackToSynthetic(tabId, payload);
    }

    const resolveRes = await this.resolvePoint(tabId, targetId, docId);
    if (!resolveRes.success) {
      if (resolveRes.obscuredBy) {
        return {
          success: false,
          error: resolveRes.error,
          stale: resolveRes.stale,
          obscuredBy: resolveRes.obscuredBy,
          via: 'cdp'
        };
      }
      return await this.fallbackToSynthetic(tabId, payload);
    }

    // Native <select> elements should not receive CDP clicks to prevent native OS popup lock
    if (resolveRes.tag === 'select') {
      return await this.fallbackToSynthetic(tabId, payload);
    }

    await this.safeProbeBegin(tabId);

    try {
      await this.clickCoordinates(tabId, resolveRes.point.x, resolveRes.point.y, signal);
    } catch (err: any) {
      if (signal?.aborted) {
        return {
          success: false,
          error: err.message || 'Action aborted',
          via: 'cdp'
        };
      }
      return await this.fallbackToSynthetic(tabId, payload);
    }

    const effect = await this.safeProbeEnd(tabId);
    const label = resolveRes.text || null;
    const message = `Clicked element [${targetId}]${label ? ` ("${label}")` : ''}`;

    return {
      success: true,
      label,
      message,
      effect,
      via: 'cdp'
    };
  }

  /**
   * Handles type action via CDP click + selectAll + insertText.
   */
  private async handleType(
    tabId: number,
    payload: Record<string, any>,
    docId?: string,
    signal?: AbortSignal
  ): Promise<DispatchResult> {
    const targetId = payload.element_id ?? payload.index ?? payload.elementId;
    const text = payload.text == null ? '' : String(payload.text);
    const submit = Boolean(payload.submit);

    if (targetId === undefined || targetId === null) {
      return {
        success: false,
        error: 'Type action requires an element_id.',
        via: 'synthetic'
      };
    }

    const canUseCDP = await this.ensureCdpAttached(tabId);
    if (!canUseCDP) {
      return await this.fallbackToSynthetic(tabId, payload);
    }

    const resolveRes = await this.resolvePoint(tabId, targetId, docId);
    if (!resolveRes.success) {
      return {
        success: false,
        error: resolveRes.error,
        stale: resolveRes.stale,
        obscuredBy: resolveRes.obscuredBy,
        via: 'cdp'
      };
    }

    // Native select tags receiving a type command must use synthetic setter
    if (resolveRes.tag === 'select') {
      return await this.fallbackToSynthetic(tabId, payload);
    }

    await this.safeProbeBegin(tabId);

    try {
      // 1. Focus element by clicking it
      await this.clickCoordinates(tabId, resolveRes.point.x, resolveRes.point.y, signal);

      if (signal?.aborted) throw new Error('Action aborted');

      // 2. Select all existing text via selectAll command
      await this.cdp.sendCommand(tabId, 'Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key: 'a',
        code: 'KeyA',
        windowsVirtualKeyCode: 65,
        text: 'a',
        unmodifiedText: 'a',
        commands: ['selectAll']
      });

      await this.cdp.sendCommand(tabId, 'Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'a',
        code: 'KeyA',
        windowsVirtualKeyCode: 65
      });

      if (signal?.aborted) throw new Error('Action aborted');

      // 3. Insert new text using Input.insertText
      await this.cdp.sendCommand(tabId, 'Input.insertText', { text });

      // 4. Submit if requested
      if (submit) {
        if (signal?.aborted) throw new Error('Action aborted');
        await this.cdp.sendCommand(tabId, 'Input.dispatchKeyEvent', {
          type: 'rawKeyDown',
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13,
          text: '\r',
          unmodifiedText: '\r'
        });
        await this.cdp.sendCommand(tabId, 'Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13
        });
      }
    } catch (err: any) {
      return {
        success: false,
        error: err.message || 'CDP type failed.',
        via: 'cdp'
      };
    }

    const effect = await this.safeProbeEnd(tabId);
    const label = resolveRes.text || null;
    const message = `Typed "${text}" into element [${targetId}]${label ? ` ("${label}")` : ''}`;

    return {
      success: true,
      label,
      submitted: submit,
      message,
      effect,
      via: 'cdp'
    };
  }

  /**
   * Handles keyboard keypress via CDP or synthetic fallback.
   */
  private async handlePressKey(
    tabId: number,
    payload: Record<string, any>,
    signal?: AbortSignal
  ): Promise<DispatchResult> {
    const key = payload.key;
    if (!key) {
      return {
        success: false,
        error: 'press_key action requires a "key" parameter.',
        via: 'synthetic'
      };
    }

    const canUseCDP = await this.ensureCdpAttached(tabId);
    if (!canUseCDP) {
      return await this.fallbackToSynthetic(tabId, payload);
    }

    await this.safeProbeBegin(tabId);

    try {
      await this.sendKey(tabId, key, signal);
    } catch (err: any) {
      return {
        success: false,
        error: err.message || 'CDP keypress failed.',
        via: 'cdp'
      };
    }

    const effect = await this.safeProbeEnd(tabId);
    return {
      success: true,
      message: `Pressed key "${key}"`,
      effect,
      via: 'cdp'
    };
  }

  /**
   * Dispatches mouseMoved, mousePressed, and mouseReleased events at {x, y}.
   * Triggers visual click ripple in content script and holds mouse button briefly
   * so event listeners in modern frameworks process the interaction reliably.
   * Ensures mouseReleased is dispatched in a finally block if mousePressed succeeded.
   */
  async clickCoordinates(tabId: number, x: number, y: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error('Action aborted');

    // Trigger visual cursor ripple in content script
    try {
      await this.sendToTab(tabId, { action: 'SHOW_CLICK_ANIMATION', payload: { x, y } });
    } catch (_) {
      // Non-fatal if content script does not answer
    }

    await this.cdp.sendCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y
    });

    // Realistic hover settle delay (30ms)
    await new Promise((r) => setTimeout(r, 30));
    if (signal?.aborted) throw new Error('Action aborted');

    let mousePressed = false;
    try {
      await this.cdp.sendCommand(tabId, 'Input.dispatchMouseEvent', {
        type: 'mousePressed',
        button: 'left',
        buttons: 1,
        clickCount: 1,
        x,
        y
      });
      mousePressed = true;

      // Realistic press hold duration (50ms) before release
      await new Promise((r) => setTimeout(r, 50));
      if (signal?.aborted) throw new Error('Action aborted');
    } finally {
      if (mousePressed) {
        try {
          await this.cdp.sendCommand(tabId, 'Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            button: 'left',
            buttons: 0,
            clickCount: 1,
            x,
            y
          });
        } catch (_) {
          // Non-fatal if target tab closed or detached
        }
      }
    }
  }

  /**
   * Dispatches key down and key up events for a key string.
   */
  async sendKey(tabId: number, key: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error('Action aborted');

    const def = SPECIAL_KEYS[key] || {
      code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
      windowsVirtualKeyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0,
      text: key.length === 1 ? key : undefined,
      unmodifiedText: key.length === 1 ? key : undefined
    };

    const downParams: Record<string, unknown> = {
      type: 'rawKeyDown',
      key,
      code: def.code,
      windowsVirtualKeyCode: def.windowsVirtualKeyCode
    };
    if (def.text) downParams.text = def.text;
    if (def.unmodifiedText) downParams.unmodifiedText = def.unmodifiedText;

    await this.cdp.sendCommand(tabId, 'Input.dispatchKeyEvent', downParams);

    if (signal?.aborted) throw new Error('Action aborted');

    await this.cdp.sendCommand(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      code: def.code,
      windowsVirtualKeyCode: def.windowsVirtualKeyCode
    });
  }

  /**
   * Resolves element position and checks for occlusion via content script.
   */
  private async resolvePoint(
    tabId: number,
    elementId: number,
    docId?: string
  ): Promise<ResolvePointResponse> {
    try {
      const response = await this.sendToTab<ResolvePointResponse>(tabId, {
        action: 'RESOLVE_ELEMENT_POINT',
        payload: { docId, element_id: elementId }
      });
      return response;
    } catch (err: any) {
      return {
        success: false,
        error: err.message || `Failed to resolve point for element [${elementId}].`
      };
    }
  }

  /**
   * Ensures CDP is attached to the tab and allowed.
   */
  private async ensureCdpAttached(tabId: number): Promise<boolean> {
    if (this.cdp.isUserDetached(tabId)) {
      return false;
    }
    if (this.cdp.isAttached(tabId)) {
      return true;
    }
    try {
      await this.cdp.attach(tabId);
      return true;
    } catch (err) {
      Logger.info('InputDispatcher', `CDP attach failed on tab [${tabId}], falling back to synthetic.`, err);
      return false;
    }
  }

  /**
   * Safe execution of EFFECT_PROBE_BEGIN.
   */
  private async safeProbeBegin(tabId: number): Promise<void> {
    try {
      await this.sendToTab(tabId, { action: 'EFFECT_PROBE_BEGIN' });
    } catch (_) {
      // Non-fatal if probe is unsupported or page unloaded
    }
  }

  /**
   * Safe execution of EFFECT_PROBE_END.
   */
  private async safeProbeEnd(tabId: number): Promise<string> {
    try {
      const res = await this.sendToTab<{ success: boolean; effect?: string }>(tabId, {
        action: 'EFFECT_PROBE_END'
      });
      return res?.effect || 'none';
    } catch (_) {
      return 'none';
    }
  }

  /**
   * Fallback execution using the content script's synthetic ActionExecutor.
   */
  async fallbackToSynthetic(
    tabId: number,
    actionPayload: Record<string, any>
  ): Promise<DispatchResult> {
    try {
      const response = await this.sendToTab<any>(tabId, {
        action: 'EXECUTE_ACTION',
        payload: actionPayload
      });
      return {
        ...(response || { success: true }),
        via: 'synthetic'
      };
    } catch (err: any) {
      return {
        success: false,
        error: err.message || 'Synthetic action execution failed.',
        via: 'synthetic'
      };
    }
  }

  /**
   * Helper to send a message to a tab's content script with a Promise.
   */
  private sendToTab<T = any>(tabId: number, message: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.tabs.sendMessage) {
        return reject(new Error('chrome.tabs.sendMessage is not available.'));
      }
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }
        resolve(response);
      });
    });
  }
}

export const inputDispatcher = new InputDispatcher();
