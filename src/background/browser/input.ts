/**
 * Unified input dispatcher for browser automation (Phase P3).
 * Routes clicks, keystrokes, and text inputs through CDP trusted events
 * when available, with automatic fallback to synthetic DOM events on
 * restricted pages, detached debugger, or native <select> elements.
 */

import { cdp as defaultCdp, CDPManager } from './cdp.ts';
import type { ResolvePointResponse } from '../../content/types.ts';
import { Logger } from '../../shared/logger.ts';
import type { EffectDetail, KeyModifier } from '../types.ts';

export interface DispatchOptions {
  docId?: string;
  signal?: AbortSignal;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  control?: { stopRequested?: boolean; pauseRequested?: boolean; signal?: AbortSignal };
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
  urlAfter?: string;
  stale?: boolean;
  obscuredBy?: string;
  /** Why the input dropped to synthetic DOM events (set on every synthetic fallback). */
  syntheticReason?: string;
  /** The facts the effect probe measured around the action. */
  effectDetail?: EffectDetail;
  /** The field text a type left behind, read right after typing; null when it could not be read. */
  fieldText?: string | null;
}

/** A scroll box's position as the content script reports it. */
interface ScrollReading {
  top: number;
  max: number;
  height: number;
  atTop: boolean;
  atBottom: boolean;
}

function pickReading(raw: any): ScrollReading {
  return {
    top: Number(raw?.top) || 0,
    max: Number(raw?.max) || 0,
    height: Number(raw?.height) || 0,
    atTop: raw?.atTop === true,
    atBottom: raw?.atBottom === true
  };
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

/** The key names press_key takes besides a single character and select_all. */
export const SPECIAL_KEY_NAMES = Object.keys(SPECIAL_KEYS);

/** The modifiers press_key takes, and their bit in CDP's Input.dispatchKeyEvent `modifiers`. */
export const KEY_MODIFIER_BITS: Record<KeyModifier, number> = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

/** The platform-neutral select-all key of press_key: Meta+A on a Mac, Ctrl+A elsewhere. */
export const SELECT_ALL_KEY = 'select_all';

/** Other spellings a model uses for a key name. */
const KEY_ALIASES: Record<string, string> = { return: 'Enter', esc: 'Escape', del: 'Delete', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };

/** The physical key of a punctuation character on a US layout: its code and Windows key code. */
const PUNCTUATION: Record<string, [string, number]> = {
  '-': ['Minus', 189], '_': ['Minus', 189], '=': ['Equal', 187], '+': ['Equal', 187],
  '[': ['BracketLeft', 219], '{': ['BracketLeft', 219], ']': ['BracketRight', 221], '}': ['BracketRight', 221],
  '\\': ['Backslash', 220], '|': ['Backslash', 220], ';': ['Semicolon', 186], ':': ['Semicolon', 186],
  "'": ['Quote', 222], '"': ['Quote', 222], ',': ['Comma', 188], '<': ['Comma', 188],
  '.': ['Period', 190], '>': ['Period', 190], '/': ['Slash', 191], '?': ['Slash', 191],
  '`': ['Backquote', 192], '~': ['Backquote', 192],
  '!': ['Digit1', 49], '@': ['Digit2', 50], '#': ['Digit3', 51], '$': ['Digit4', 52], '%': ['Digit5', 53],
  '^': ['Digit6', 54], '&': ['Digit7', 55], '*': ['Digit8', 56], '(': ['Digit9', 57], ')': ['Digit0', 48],
  ' ': ['Space', 32]
};

/**
 * The editing commands a Ctrl/Meta shortcut runs. A trusted key event does not run them by
 * itself in every page (Chromium only maps them for some focus targets), so they go on the event
 * as CDP `commands`, the way type already sends selectAll.
 */
const SHORTCUT_COMMANDS: Record<string, string> = { a: 'selectAll', c: 'copy', x: 'cut', v: 'paste', z: 'undo', y: 'redo' };

/** One key press, resolved to the fields of Input.dispatchKeyEvent. */
export interface ResolvedKey {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  /** The character the key inserts. Absent while Ctrl, Meta or Alt is held. */
  text?: string;
  /** The CDP modifiers bitmask (Alt=1, Ctrl=2, Meta=4, Shift=8). */
  modifiers: number;
  /** Editing commands the press runs (selectAll, copy, cut, paste, undo, redo). */
  commands?: string[];
  /** How the press reads to a person: "Shift+Enter", "Meta+A (select all)". */
  label: string;
}

/** The valid forms of a press_key key, for the error a model reads. */
export const PRESS_KEY_FORMS =
  `a key name (${SPECIAL_KEY_NAMES.join(', ')}), a single printable character such as "a" or "5", or "${SELECT_ALL_KEY}"`;

function isPrintableChar(key: string): boolean {
  const chars = [...key];
  if (chars.length !== 1) return false;
  const cp = chars[0].codePointAt(0) ?? 0;
  return cp >= 0x20 && cp !== 0x7f;
}

/**
 * Resolves a press_key request to the key event fields, or an error the model can act on.
 * Pure: the server validates with it before anything reaches the page, and sendKey sends it.
 */
export function resolveKey(rawKey: unknown, rawModifiers: unknown = [], { mac = false }: { mac?: boolean } = {}): ResolvedKey | { error: string } {
  const key = typeof rawKey === 'string' ? rawKey : '';
  const mods = Array.isArray(rawModifiers) ? rawModifiers : rawModifiers === undefined || rawModifiers === null ? [] : null;
  if (!mods) return { error: 'Error: press_key modifiers must be an array of "ctrl", "shift", "alt" or "meta".' };
  const bad = mods.filter((m) => !Object.prototype.hasOwnProperty.call(KEY_MODIFIER_BITS, String(m)));
  if (bad.length) return { error: `Error: press_key does not know the modifier ${JSON.stringify(bad[0])}. Use "ctrl", "shift", "alt" or "meta".` };
  const held = new Set(mods as KeyModifier[]);

  if (key === SELECT_ALL_KEY) {
    const primary: KeyModifier = mac ? 'meta' : 'ctrl';
    held.add(primary);
    return {
      key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65,
      modifiers: bitsOf(held), commands: ['selectAll'],
      label: `${labelOf(held, 'A')} (select all)`
    };
  }

  let name = SPECIAL_KEYS[key] ? key : '';
  if (!name && key.length > 1) {
    const lower = key.toLowerCase();
    name = SPECIAL_KEY_NAMES.find((n) => n.toLowerCase() === lower) || KEY_ALIASES[lower] || '';
  }
  let def: KeyDefinition;
  let eventKey: string;
  if (name) {
    def = SPECIAL_KEYS[name];
    eventKey = name === 'Space' ? ' ' : name;
  } else if (isPrintableChar(key)) {
    const shifted = held.has('shift') && /^[a-z]$/.test(key);
    eventKey = shifted ? key.toUpperCase() : key;
    if (/^[a-z]$/i.test(key)) def = { code: `Key${key.toUpperCase()}`, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0) };
    else if (/^[0-9]$/.test(key)) def = { code: `Digit${key}`, windowsVirtualKeyCode: 48 + Number(key) };
    else if (PUNCTUATION[key]) def = { code: PUNCTUATION[key][0], windowsVirtualKeyCode: PUNCTUATION[key][1] };
    else def = { code: '', windowsVirtualKeyCode: 0 };
    def = { ...def, text: eventKey, unmodifiedText: eventKey };
  } else {
    return { error: `Error: press_key does not know the key ${JSON.stringify(key)}. Use ${PRESS_KEY_FORMS}, with modifiers for a combination (key "a" with modifiers ["ctrl"]).` };
  }

  // A held Ctrl, Meta or Alt makes it a shortcut: no character is inserted. Shift alone keeps the
  // text, so Shift+Enter still inserts or triggers what Enter does with Shift held.
  const shortcut = held.has('ctrl') || held.has('meta') || held.has('alt');
  const resolved: ResolvedKey = {
    key: eventKey,
    code: def.code,
    windowsVirtualKeyCode: def.windowsVirtualKeyCode,
    modifiers: bitsOf(held),
    label: labelOf(held, name || (eventKey.length === 1 && /[a-z]/i.test(eventKey) ? eventKey.toUpperCase() : eventKey))
  };
  if (!shortcut && def.text) resolved.text = def.text;
  if ((held.has('ctrl') || held.has('meta')) && !held.has('alt')) {
    const lower = eventKey.toLowerCase();
    const command = lower === 'z' && held.has('shift') ? 'redo' : SHORTCUT_COMMANDS[lower];
    if (command) resolved.commands = [command];
  }
  return resolved;
}

function bitsOf(held: Set<KeyModifier>): number {
  let bits = 0;
  for (const m of held) bits |= KEY_MODIFIER_BITS[m];
  return bits;
}

function labelOf(held: Set<KeyModifier>, keyName: string): string {
  const order: KeyModifier[] = ['ctrl', 'alt', 'shift', 'meta'];
  const names: Record<KeyModifier, string> = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Meta' };
  return [...order.filter((m) => held.has(m)).map((m) => names[m]), keyName].join('+');
}

/** Whether this browser runs on a Mac, where the select-all key is Meta+A. */
export function isMacPlatform(): boolean {
  const nav: any = typeof navigator !== 'undefined' ? navigator : null;
  const platform = String(nav?.userAgentData?.platform || nav?.platform || '');
  return /mac/i.test(platform);
}

export class InputDispatcher {
  private cdp: CDPManager;
  /** Whether the browser is on a Mac (select-all is Meta+A there). A test sets it. */
  private mac: boolean;

  constructor(cdp: CDPManager = defaultCdp, { mac }: { mac?: boolean } = {}) {
    this.cdp = cdp;
    this.mac = mac ?? isMacPlatform();
  }

  /**
   * Main entry point to dispatch an action on a tab.
   */
  async dispatchAction(
    tabId: number,
    actionPayload: Record<string, any>,
    options: DispatchOptions = {}
  ): Promise<DispatchResult> {
    const { signal, docId, sleep, control } = options;

    if (signal?.aborted || control?.stopRequested || control?.pauseRequested) {
      return {
        success: false,
        error: 'Action aborted before execution.',
        via: 'synthetic'
      };
    }

    const action = actionPayload.action;

    switch (action) {
      case 'click':
        return await this.handleClick(tabId, actionPayload, docId, signal, sleep, control);

      case 'click_at':
        return await this.handleClickAt(tabId, actionPayload, signal, sleep, control);

      case 'type':
        return await this.handleType(tabId, actionPayload, docId, signal, sleep, control);

      case 'select':
        // Native <select> menus always use synthetic DOM setter to avoid OS popup locks
        return await this.fallbackToSynthetic(tabId, actionPayload, 'native select element');

      case 'press_key':
      case 'keypress':
        return await this.handlePressKey(tabId, actionPayload, signal, sleep, control);

      case 'scroll':
        return await this.handleScroll(tabId, actionPayload, control);

      default:
        // navigate, go_back, go_forward, read_page, find_element and the scroll helpers
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
    signal?: AbortSignal,
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>,
    control?: { stopRequested?: boolean; pauseRequested?: boolean; signal?: AbortSignal }
  ): Promise<DispatchResult> {
    const targetId = payload.element_id ?? payload.index ?? payload.elementId;
    if (targetId === undefined || targetId === null) {
      return {
        success: false,
        error: 'Click action requires an element_id.',
        via: 'synthetic'
      };
    }

    let urlBefore = '';
    try {
      const tab = await this.getTab(tabId);
      urlBefore = tab?.url || '';
    } catch (_) {}

    const attach = await this.ensureCdpAttached(tabId);
    if (!attach.ok) {
      return await this.syntheticWithUrlChange(tabId, payload, attach.reason, urlBefore);
    }

    const resolveRes = await this.resolvePoint(tabId, targetId, docId);
    if (!resolveRes.success) {
      // A stale element fails loudly: synthetic re-resolution could silently hit a
      // different element after a re-render, so the model gets the stale error instead.
      if (resolveRes.stale || resolveRes.obscuredBy) {
        return {
          success: false,
          error: resolveRes.error,
          stale: resolveRes.stale,
          obscuredBy: resolveRes.obscuredBy,
          via: 'cdp'
        };
      }
      return await this.syntheticWithUrlChange(
        tabId,
        payload,
        `element point could not be resolved: ${resolveRes.error}`,
        urlBefore
      );
    }

    // Native <select> elements should not receive CDP clicks to prevent native OS popup lock
    if (resolveRes.tag === 'select') {
      return await this.syntheticWithUrlChange(tabId, payload, 'native select element', urlBefore);
    }

    await this.probeBegin(tabId);

    try {
      await this.clickCoordinates(tabId, resolveRes.point.x, resolveRes.point.y, signal, sleep, control);
    } catch (err: any) {
      if (signal?.aborted || control?.stopRequested || control?.pauseRequested) {
        return {
          success: false,
          error: err.message || 'Action aborted',
          via: 'cdp'
        };
      }
      return await this.syntheticWithUrlChange(tabId, payload, `CDP click failed: ${err.message || err}`, urlBefore);
    }

    // Deliverable 4: The click effect probe END is sent about 300 ms after the click, on the injectable clock
    if (sleep) {
      await sleep(300, signal);
    } else {
      await new Promise((r) => setTimeout(r, 300));
    }

    const probe = await this.probeEnd(tabId);
    let effect = probe.effect;
    let urlAfter = '';
    try {
      const tab = await this.getTab(tabId);
      urlAfter = tab?.url || '';
    } catch (_) {}
    if (urlAfter && urlBefore !== urlAfter) {
      effect = 'url_changed';
    }

    const label = resolveRes.text || null;
    const message = `Clicked element [${targetId}]${label ? ` ("${label}")` : ''}`;

    return {
      success: true,
      label,
      message,
      effect,
      urlAfter: urlAfter || undefined,
      via: 'cdp',
      ...(probe.detail ? { effectDetail: probe.detail } : {})
    };
  }

  /**
   * A click at a viewport coordinate: the model read the point off a screenshot, so there is no
   * element to resolve and no element check to make - the server already asked the page what is
   * at the point and refused a sensitive field. Everything after the dispatch is the same as an
   * element click: the probe, the URL capture and the settle all live in executeAction.
   */
  private async handleClickAt(
    tabId: number,
    payload: Record<string, any>,
    signal?: AbortSignal,
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>,
    control?: { stopRequested?: boolean; pauseRequested?: boolean; signal?: AbortSignal }
  ): Promise<DispatchResult> {
    const x = Number(payload.x);
    const y = Number(payload.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { success: false, error: 'A coordinate click needs a numeric x and y.', via: 'synthetic' };
    }

    let urlBefore = '';
    try {
      const tab = await this.getTab(tabId);
      urlBefore = tab?.url || '';
    } catch (_) {}

    const attach = await this.ensureCdpAttached(tabId);
    if (!attach.ok) {
      return {
        success: false,
        error: `A coordinate click needs the debugger, which could not attach: ${attach.reason}. Use click with an element_id instead.`,
        via: 'synthetic',
        syntheticReason: attach.reason
      };
    }

    await this.probeBegin(tabId);
    try {
      await this.clickCoordinates(tabId, x, y, signal, sleep, control);
    } catch (err: any) {
      return { success: false, error: err.message || 'The coordinate click failed.', via: 'cdp' };
    }

    if (sleep) {
      await sleep(300, signal);
    } else {
      await new Promise((r) => setTimeout(r, 300));
    }

    const probe = await this.probeEnd(tabId);
    let effect = probe.effect;
    let urlAfter = '';
    try {
      const tab = await this.getTab(tabId);
      urlAfter = tab?.url || '';
    } catch (_) {}
    if (urlAfter && urlBefore !== urlAfter) effect = 'url_changed';

    return {
      success: true,
      message: `Clicked at (${Math.round(x)}, ${Math.round(y)})`,
      effect,
      urlAfter: urlAfter || undefined,
      via: 'cdp',
      ...(probe.detail ? { effectDetail: probe.detail } : {})
    };
  }

  /**
   * Runs the synthetic fallback and reports the URL change of a click-like action.
   */
  private async syntheticWithUrlChange(
    tabId: number,
    payload: Record<string, any>,
    reason: string,
    urlBefore: string
  ): Promise<DispatchResult> {
    const res = await this.fallbackToSynthetic(tabId, payload, reason);
    let urlAfter = '';
    try {
      const tab = await this.getTab(tabId);
      urlAfter = tab?.url || '';
    } catch (_) {}
    if (urlAfter && urlBefore !== urlAfter) {
      res.effect = 'url_changed';
      res.urlAfter = urlAfter;
    }
    return res;
  }

  /**
   * Handles type action via CDP: focus, then replace (selectAll) or append (caret to the end),
   * then Input.insertText, then an optional Enter.
   *
   * With an element_id the element is clicked first to focus it. Without one the text goes into
   * whatever has focus now (after a click into an editor, that is the editor), and the type is
   * refused when the page says nothing editable has focus. The field is read back right after the
   * insert, before any Enter, so the result can say what the field really holds.
   */
  private async handleType(
    tabId: number,
    payload: Record<string, any>,
    docId?: string,
    signal?: AbortSignal,
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>,
    control?: { stopRequested?: boolean; pauseRequested?: boolean; signal?: AbortSignal }
  ): Promise<DispatchResult> {
    const targetId = payload.element_id ?? payload.index ?? payload.elementId;
    const text = payload.text == null ? '' : String(payload.text);
    const submit = Boolean(payload.submit);
    const append = payload.mode === 'append';
    const hasTarget = targetId !== undefined && targetId !== null;

    let urlBefore = '';
    try {
      const tab = await this.getTab(tabId);
      urlBefore = tab?.url || '';
    } catch (_) {}

    const attach = await this.ensureCdpAttached(tabId);
    if (!attach.ok) {
      if (!hasTarget) {
        return {
          success: false,
          error: `Typing into the focused element needs the debugger, which could not attach: ${attach.reason}. Nothing was typed. Give an element_id instead.`,
          via: 'cdp',
          syntheticReason: attach.reason
        };
      }
      return await this.syntheticWithUrlChange(tabId, payload, attach.reason, urlBefore);
    }

    let label: string | null = null;
    let point: { x: number; y: number } | null = null;
    if (hasTarget) {
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
        return await this.syntheticWithUrlChange(tabId, payload, 'native select element', urlBefore);
      }
      label = resolveRes.text || null;
      point = resolveRes.point;
    }

    const baseline = await this.probeBegin(tabId);
    if (!hasTarget) {
      const focus = baseline?.focus;
      // Only a page that answered and said "nothing editable" is refused: a focus the content
      // script cannot see into (a frame) is still typed into, and the read-back says what it can.
      if (baseline && (!focus || focus.editable === false)) {
        return {
          success: false,
          error: `Nothing editable has focus${focus?.label ? ` (focus is on ${focus.label})` : ''}, so nothing was typed. Click into the field first, then call type without element_id, or give the element_id of the field.`,
          via: 'cdp'
        };
      }
      label = focus?.label || null;
    }

    let fieldText: string | null = null;
    try {
      // 1. Focus the element by clicking it (only with an element_id: without one, focus is already there).
      if (point) await this.clickCoordinates(tabId, point.x, point.y, signal, sleep, control);

      if (signal?.aborted || control?.stopRequested || control?.pauseRequested) throw new Error('Action aborted');

      // 2. Replace selects everything first; append moves the caret to the end. Both are a
      // rawKeyDown without text: the editing command does the work and no character is inserted.
      const primary = this.mac ? KEY_MODIFIER_BITS.meta : KEY_MODIFIER_BITS.ctrl;
      const prepare = append
        ? { key: 'End', code: 'End', windowsVirtualKeyCode: 35, modifiers: primary, commands: ['moveToEndOfDocument'] }
        : { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, commands: ['selectAll'] };
      let prepareDownSent = false;
      try {
        await this.cdp.sendCommand(tabId, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', ...prepare }, control);
        prepareDownSent = true;
      } finally {
        if (prepareDownSent) {
          try {
            const { commands: _commands, ...up } = prepare as any;
            await this.cdp.sendCommand(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...up }, control);
          } catch (_) {}
        }
      }

      if (signal?.aborted || control?.stopRequested || control?.pauseRequested) throw new Error('Action aborted');

      // 3. Insert new text using Input.insertText
      await this.cdp.sendCommand(tabId, 'Input.insertText', { text }, control);

      // 4. Read the field back before any Enter, so the result says what the field holds.
      const readBack = await this.probeEnd(tabId);
      fieldText = readBack.detail?.focus && typeof readBack.detail.focus.text === 'string' ? readBack.detail.focus.text : null;

      // 5. Submit if requested
      if (submit) {
        if (signal?.aborted || control?.stopRequested || control?.pauseRequested) throw new Error('Action aborted');
        let enterDownSent = false;
        try {
          // keyDown (not rawKeyDown) because it carries text: Chromium fires keypress
          // only for a keyDown with text, and keypress is what submits the form.
          await this.cdp.sendCommand(tabId, 'Input.dispatchKeyEvent', {
            type: 'keyDown',
            key: 'Enter',
            code: 'Enter',
            windowsVirtualKeyCode: 13,
            text: '\r',
            unmodifiedText: '\r'
          }, control);
          enterDownSent = true;
        } finally {
          if (enterDownSent) {
            try {
              await this.cdp.sendCommand(tabId, 'Input.dispatchKeyEvent', {
                type: 'keyUp',
                key: 'Enter',
                code: 'Enter',
                windowsVirtualKeyCode: 13
              }, control);
            } catch (_) {}
          }
        }
      }
    } catch (err: any) {
      return {
        success: false,
        error: err.message || 'CDP type failed.',
        via: 'cdp'
      };
    }

    if (submit) {
      if (sleep) {
        await sleep(300, signal);
      } else {
        await new Promise((r) => setTimeout(r, 300));
      }
    }

    const probe = await this.probeEnd(tabId);
    let effect = probe.effect;
    let urlAfter = '';
    try {
      const tab = await this.getTab(tabId);
      urlAfter = tab?.url || '';
    } catch (_) {}
    if (urlAfter && urlBefore !== urlAfter) {
      effect = 'url_changed';
    }

    const where = hasTarget ? `element [${targetId}]` : 'the focused element';
    const message = `Typed "${text}" into ${where}${label ? ` ("${label}")` : ''}`;

    return {
      success: true,
      label,
      submitted: submit,
      message,
      effect,
      urlAfter: urlAfter || undefined,
      via: 'cdp',
      fieldText,
      ...(probe.detail ? { effectDetail: probe.detail } : {})
    };
  }

  /**
   * press_key: one trusted key press through CDP, with modifiers. There is no synthetic
   * fallback: an untrusted key event is ignored by editors (CodeMirror, Monaco) and by most
   * shortcuts, so a press that cannot be trusted is an honest error, never a fake success.
   */
  private async handlePressKey(
    tabId: number,
    payload: Record<string, any>,
    signal?: AbortSignal,
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>,
    control?: { stopRequested?: boolean; pauseRequested?: boolean; signal?: AbortSignal }
  ): Promise<DispatchResult> {
    const key = payload.key;
    if (!key) {
      return {
        success: false,
        error: 'press_key action requires a "key" parameter.',
        via: 'cdp'
      };
    }
    const resolved = resolveKey(key, payload.modifiers, { mac: this.mac });
    if ('error' in resolved) return { success: false, error: resolved.error, via: 'cdp' };

    const attach = await this.ensureCdpAttached(tabId);
    if (!attach.ok) {
      return {
        success: false,
        error: `press_key needs the debugger for a real key press, and it could not attach: ${attach.reason}. Nothing was pressed.`,
        via: 'cdp',
        syntheticReason: attach.reason
      };
    }

    await this.probeBegin(tabId);

    try {
      await this.sendResolvedKey(tabId, resolved, signal, control);
    } catch (err: any) {
      return {
        success: false,
        error: err.message || 'CDP keypress failed.',
        via: 'cdp'
      };
    }

    // A key often starts work the page does a moment later (Enter runs a cell, opens a page), so
    // the probe ends after the same short wait a click gets.
    if (sleep) await sleep(300, signal);
    else await new Promise((r) => setTimeout(r, 300));

    const probe = await this.probeEnd(tabId);
    return {
      success: true,
      message: `Pressed ${resolved.label}`,
      label: resolved.label,
      effect: probe.effect,
      via: 'cdp',
      ...(probe.detail ? { effectDetail: probe.detail } : {})
    };
  }

  /**
   * scroll: a trusted mouse wheel at a point inside the box to move, then a measurement of that
   * box until it stops moving. The content script picks the box (an element's, the one under a
   * point, or the largest visible one) and reads its position before and after, so the result is
   * what really happened. When the wheel moved nothing and the box is not at its edge (a page that
   * ignores wheel events, a debugger that cannot attach), the box is moved at once by writing its
   * scroll position, and measured again.
   */
  private async handleScroll(
    tabId: number,
    payload: Record<string, any>,
    control?: { stopRequested?: boolean; pauseRequested?: boolean; signal?: AbortSignal }
  ): Promise<DispatchResult> {
    const direction = payload.direction === 'up' ? 'up' : 'down';
    const ask = async (body: Record<string, unknown>): Promise<any> => {
      try {
        return await this.sendToTab<any>(tabId, { action: 'EXECUTE_ACTION', payload: body });
      } catch (err: any) {
        return { success: false, error: err?.message || String(err) };
      }
    };
    const target = await ask({
      action: 'scroll_target',
      direction,
      ...(payload.element_id !== undefined && payload.element_id !== null ? { element_id: payload.element_id } : {}),
      ...(Number.isFinite(Number(payload.x)) && Number.isFinite(Number(payload.y)) && payload.x !== undefined && payload.y !== undefined ? { x: Number(payload.x), y: Number(payload.y) } : {})
    });
    if (!target?.success || !target.result) {
      return { success: false, error: target?.error || 'The page did not answer, so it is not known what to scroll. Nothing was scrolled.', via: 'cdp' };
    }
    const { point, label, step } = target.result;
    const before: ScrollReading = pickReading(target.result);
    await this.probeBegin(tabId);

    const atEdge = (p: ScrollReading) => (direction === 'down' ? p.atBottom : p.atTop);
    const delta = (direction === 'down' ? 1 : -1) * (Number(step) || 400);
    let after = before;
    let via: DispatchResult['via'] = 'cdp';
    let syntheticReason: string | undefined;
    if (!atEdge(before)) {
      const measured = await this.wheelAndMeasure(tabId, point, delta, before, control, ask);
      after = measured.after;
      syntheticReason = measured.reason;
      if (after.top === before.top && !atEdge(after)) {
        // The wheel moved nothing although the box can still move that way.
        const moved = await ask({ action: 'scroll_fallback', delta });
        if (moved?.success && moved.result) after = pickReading(moved.result);
        via = 'synthetic';
        syntheticReason = syntheticReason || 'the mouse wheel did not move it';
      }
    }

    const probe = await this.probeEnd(tabId);
    const moved = after.top - before.top;
    return {
      success: true,
      via,
      ...(syntheticReason ? { syntheticReason } : {}),
      effect: probe.effect,
      message: moved !== 0 ? `Scrolled ${label} ${moved > 0 ? 'down' : 'up'} ${Math.abs(moved)}px` : `Did not move ${label}`,
      result: { moved, label, direction, fallback: via === 'synthetic', ...after },
      ...(probe.detail ? { effectDetail: probe.detail } : {})
    };
  }

  /**
   * One wheel turn at the point, then the box's position once it settled. A debugger that cannot
   * attach or a wheel the page refuses comes back with the reason and the position unchanged.
   */
  private async wheelAndMeasure(
    tabId: number,
    point: { x: number; y: number },
    delta: number,
    before: ScrollReading,
    control: { stopRequested?: boolean; pauseRequested?: boolean; signal?: AbortSignal } | undefined,
    ask: (body: Record<string, unknown>) => Promise<any>
  ): Promise<{ after: ScrollReading; reason?: string }> {
    const attach = await this.ensureCdpAttached(tabId);
    if (!attach.ok) return { after: before, reason: attach.reason };
    try {
      await this.cdp.sendCommand(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: Math.round(point?.x ?? 0), y: Math.round(point?.y ?? 0), deltaX: 0, deltaY: delta
      }, control);
    } catch (err: any) {
      return { after: before, reason: `the mouse wheel failed: ${err?.message || err}` };
    }
    const measured = await ask({ action: 'scroll_measure' });
    return { after: measured?.success && measured.result ? pickReading(measured.result) : before };
  }

  /**
   * Dispatches mouseMoved, mousePressed, and mouseReleased events at {x, y}.
   * Triggers visual click ripple in content script and holds mouse button briefly
   * so event listeners in modern frameworks process the interaction reliably.
   * Ensures mouseReleased is dispatched in a finally block if mousePressed succeeded.
   */
  async clickCoordinates(
    tabId: number,
    x: number,
    y: number,
    signal?: AbortSignal,
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>,
    control?: { stopRequested?: boolean; pauseRequested?: boolean; signal?: AbortSignal }
  ): Promise<void> {
    if (signal?.aborted || control?.stopRequested || control?.pauseRequested) throw new Error('Action aborted');

    const doSleep = sleep
      ? (ms: number) => sleep(ms, signal)
      : (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    }, control);

    // Realistic hover settle delay (30ms)
    await doSleep(30);
    if (signal?.aborted || control?.stopRequested || control?.pauseRequested) throw new Error('Action aborted');

    let mousePressed = false;
    try {
      await this.cdp.sendCommand(tabId, 'Input.dispatchMouseEvent', {
        type: 'mousePressed',
        button: 'left',
        buttons: 1,
        clickCount: 1,
        x,
        y
      }, control);
      mousePressed = true;

      // Realistic press hold duration (50ms) before release
      await doSleep(50);
      if (signal?.aborted || control?.stopRequested || control?.pauseRequested) throw new Error('Action aborted');
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
          }, control);
        } catch (_) {
          // Non-fatal if target tab closed or detached
        }
      }
    }
  }

  /**
   * Dispatches key down and key up events for a key string, with modifiers.
   */
  async sendKey(
    tabId: number,
    key: string,
    signal?: AbortSignal,
    control?: { stopRequested?: boolean; pauseRequested?: boolean; signal?: AbortSignal },
    modifiers: KeyModifier[] = []
  ): Promise<void> {
    const resolved = resolveKey(key, modifiers, { mac: this.mac });
    if ('error' in resolved) throw new Error(resolved.error);
    await this.sendResolvedKey(tabId, resolved, signal, control);
  }

  private async sendResolvedKey(
    tabId: number,
    def: ResolvedKey,
    signal?: AbortSignal,
    control?: { stopRequested?: boolean; pauseRequested?: boolean; signal?: AbortSignal }
  ): Promise<void> {
    if (signal?.aborted || control?.stopRequested || control?.pauseRequested) throw new Error('Action aborted');

    // Same rule as Puppeteer: a key that carries text is a keyDown, so Chromium fires
    // keypress and inserts the character or submits on Enter. A rawKeyDown with text is
    // swallowed. Keys without text (Tab, arrows, Escape, any Ctrl/Meta/Alt shortcut) stay rawKeyDown.
    const downParams: Record<string, unknown> = {
      type: def.text ? 'keyDown' : 'rawKeyDown',
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.windowsVirtualKeyCode
    };
    if (def.modifiers) downParams.modifiers = def.modifiers;
    if (def.text) {
      downParams.text = def.text;
      downParams.unmodifiedText = def.text;
    }
    if (def.commands?.length) downParams.commands = def.commands;

    let keyDownSent = false;
    try {
      await this.cdp.sendCommand(tabId, 'Input.dispatchKeyEvent', downParams, control);
      keyDownSent = true;
    } finally {
      if (keyDownSent) {
        try {
          await this.cdp.sendCommand(tabId, 'Input.dispatchKeyEvent', {
            type: 'keyUp',
            key: def.key,
            code: def.code,
            windowsVirtualKeyCode: def.windowsVirtualKeyCode,
            ...(def.modifiers ? { modifiers: def.modifiers } : {})
          }, control);
        } catch (_) {}
      }
    }
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
   * Ensures CDP is attached to the tab and allowed. Returns the reason when it is not,
   * so every synthetic fallback can name why the trusted input path was not used.
   */
  private async ensureCdpAttached(tabId: number): Promise<{ ok: boolean; reason: string }> {
    if (this.cdp.isUserDetached(tabId)) {
      return { ok: false, reason: 'debugger detached by user' };
    }
    if (this.cdp.isAttached(tabId)) {
      return { ok: true, reason: '' };
    }
    try {
      await this.cdp.attach(tabId);
      return { ok: true, reason: '' };
    } catch (err: any) {
      const detail = err?.message || String(err);
      Logger.info('InputDispatcher', `CDP attach failed on tab [${tabId}], falling back to synthetic.`, err);
      return { ok: false, reason: `debugger could not attach: ${detail}` };
    }
  }

  /**
   * Safe execution of EFFECT_PROBE_BEGIN. Returns the page's baseline (url and focus), or null
   * when the page did not answer.
   */
  private async probeBegin(tabId: number): Promise<{ url?: string; focus?: { label: string; editable: boolean } | null } | null> {
    try {
      const res = await this.sendToTab<{ success: boolean; baseline?: any }>(tabId, { action: 'EFFECT_PROBE_BEGIN' });
      return res?.success && res.baseline && typeof res.baseline === 'object' ? res.baseline : null;
    } catch (_) {
      // Non-fatal if probe is unsupported or page unloaded
      return null;
    }
  }

  /**
   * EFFECT_PROBE_END: the effect and, from a page that measures it, the facts behind it. The
   * probe keeps its baseline, so it can be read again after the page settled (readProbe).
   */
  private async probeEnd(tabId: number): Promise<{ effect: string; detail?: EffectDetail }> {
    try {
      const res = await this.sendToTab<{ success: boolean; effect?: string; detail?: EffectDetail }>(tabId, {
        action: 'EFFECT_PROBE_END'
      });
      const detail = res?.detail && typeof res.detail === 'object' ? res.detail : undefined;
      return { effect: res?.effect || 'none', ...(detail ? { detail } : {}) };
    } catch (_) {
      return { effect: 'unknown' };
    }
  }

  /**
   * The probe read again, after the action settled: the facts at the moment the model reads the
   * result, not 300 ms after the input. Null when the page did not answer.
   */
  async readProbe(tabId: number): Promise<EffectDetail | null> {
    const probe = await this.probeEnd(tabId);
    return probe.detail ?? null;
  }

  /**
   * Fallback execution using the content script's synthetic ActionExecutor.
   * The effect probe runs around the synthetic action too, so a synthetic
   * action that changed nothing is reported as no visible change, and the
   * reason the trusted input path was not used is carried on the result.
   */
  async fallbackToSynthetic(
    tabId: number,
    actionPayload: Record<string, any>,
    reason?: string
  ): Promise<DispatchResult> {
    await this.probeBegin(tabId);
    try {
      const response = await this.sendToTab<any>(tabId, {
        action: 'EXECUTE_ACTION',
        payload: actionPayload
      });
      if (!response) {
        return {
          success: false,
          error: 'The content script did not answer the synthetic action request.',
          via: 'synthetic',
          ...(reason ? { syntheticReason: reason } : {})
        };
      }
      const probe = await this.probeEnd(tabId);
      return {
        ...response,
        via: 'synthetic',
        ...(reason ? { syntheticReason: reason } : {}),
        ...(probe.effect !== 'unknown' ? { effect: probe.effect } : {}),
        ...(probe.detail ? { effectDetail: probe.detail } : {})
      };
    } catch (err: any) {
      return {
        success: false,
        error: err.message || 'Synthetic action execution failed.',
        via: 'synthetic',
        ...(reason ? { syntheticReason: reason } : {})
      };
    }
  }

  /**
   * Helper to retrieve tab details safely.
   */
  private getTab(tabId: number): Promise<chrome.tabs.Tab | null> {
    if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.tabs.get) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime?.lastError || !tab) resolve(null);
        else resolve(tab);
      });
    });
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
