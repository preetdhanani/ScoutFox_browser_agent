/**
 * ScoutFox Browser Actions Execution
 * Executes click, type, scroll, press_key, navigate, browser_batch primitives.
 */

import { clipWithNote } from '../shared/clip.ts';
import { pageTextPart } from './pageText.ts';

export interface ActionExecutionContext {
  doc?: Document;
  win?: Window & typeof globalThis;
  resolveElement: (elementId: number | string) => Element | null;
  highlightElement: (el: HTMLElement | null) => void;
  showClickEffect: (x: number, y: number) => void;
  animateCursor: (x: number, y: number) => void;
  waitForDomQuiet: (quietMs?: number, ceilingMs?: number) => Promise<void>;
  execute: (payload: any) => Promise<any>;
  describeElement: (el: Element | null) => string;
  setFieldValue: (el: Element, text: unknown) => { success: boolean; error?: string };
  doClick: (elementId: number | string) => any;
  doType: (elementId: number | string, text: unknown, submit?: unknown) => any;
  doScroll: (direction?: string, amount?: any) => any;
  doPressKey: (key?: string) => any;
  doBrowserBatch: (steps: any[], stopOnError?: boolean) => Promise<any>;
}

const SafeKeyboardEvent = typeof KeyboardEvent !== 'undefined' ? KeyboardEvent : (Event as any);
const SafeInputEvent = typeof InputEvent !== 'undefined' ? InputEvent : (Event as any);

/**
 * Short human-readable name for an element, for the action list in the side panel.
 */
export function describeElement(el: Element | null): string {
  if (!el) return '';
  const pick = (v: any) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '');
  const anyEl = el as any;
  const candidates = [
    pick(typeof el.getAttribute === 'function' ? el.getAttribute('aria-label') : null),
    pick(typeof el.getAttribute === 'function' ? el.getAttribute('alt') : null),
    pick(typeof el.getAttribute === 'function' ? el.getAttribute('title') : null),
    pick(typeof el.getAttribute === 'function' ? el.getAttribute('placeholder') : null),
    pick(anyEl.innerText || anyEl.textContent),
    pick(typeof el.getAttribute === 'function' ? el.getAttribute('name') : null),
    pick(anyEl.value)
  ];
  const label = candidates.find((c) => c && c.length > 0) || '';
  return label.length > 48 ? label.slice(0, 47) + '\u2026' : label;
}

/**
 * Put `text` into whatever kind of field `el` actually is.
 * Bypasses React value tracking via native prototype setter.
 */
export function setFieldValue(el: Element, text: unknown): { success: boolean; error?: string } {
  const tag = (el.tagName || '').toUpperCase();
  const str = text == null ? '' : String(text);

  if (tag === 'SELECT') {
    const selectEl = el as HTMLSelectElement;
    const options = Array.from(selectEl.options || []);
    const match =
      options.find((o) => o.value === str) ||
      options.find((o) => (o.textContent || '').trim() === str.trim()) ||
      options.find((o) => (o.textContent || '').trim().toLowerCase() === str.trim().toLowerCase());
    if (!match) {
      const available = options
        .map((o) => (o.textContent || o.value || '').trim())
        .filter(Boolean)
        .slice(0, 12);
      return {
        success: false,
        error: `No option matching "${str}" in this dropdown. Available: ${available.join(' | ') || '(none)'}`
      };
    }
    selectEl.value = match.value;
    selectEl.dispatchEvent(new Event('input', { bubbles: true }));
    selectEl.dispatchEvent(new Event('change', { bubbles: true }));
    return { success: true };
  }

  const isTextField = tag === 'INPUT' || tag === 'TEXTAREA';
  if (isTextField) {
    const proto =
      tag === 'TEXTAREA'
        ? typeof HTMLTextAreaElement !== 'undefined'
          ? HTMLTextAreaElement.prototype
          : Object.getPrototypeOf(el)
        : typeof HTMLInputElement !== 'undefined'
          ? HTMLInputElement.prototype
          : Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value');
    if (setter && setter.set) {
      setter.set.call(el, str);
    } else {
      (el as HTMLInputElement | HTMLTextAreaElement).value = str;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { success: true };
  }

  const anyEl = el as HTMLElement;
  if (anyEl.isContentEditable || (typeof el.getAttribute === 'function' && el.getAttribute('role') === 'textbox')) {
    anyEl.textContent = str;
    anyEl.dispatchEvent(new SafeInputEvent('input', { bubbles: true, data: str, inputType: 'insertText' } as any));
    anyEl.dispatchEvent(new Event('change', { bubbles: true }));
    return { success: true };
  }

  return {
    success: false,
    error: `Element <${tag.toLowerCase()}> is not a text field, dropdown or editable region, so it cannot be typed into.`
  };
}

/**
 * Simulate realistic click on element with stable locator re-resolution
 */
export function doClick(
  elementId: number | string,
  context: ActionExecutionContext,
  win: (Window & typeof globalThis) | undefined = context.win || (typeof window !== 'undefined' ? window : undefined)
): { success: boolean; label?: string; message?: string; error?: string } {
  const el = context.resolveElement(elementId);
  if (!el) {
    return { success: false, error: `Element [${elementId}] no longer resolvable in DOM.` };
  }

  const anyEl = el as HTMLElement;
  if (typeof anyEl.scrollIntoView === 'function') {
    try {
      anyEl.scrollIntoView({ behavior: 'smooth', block: 'center' } as any);
    } catch (_) {
      anyEl.scrollIntoView();
    }
  }
  context.highlightElement(anyEl);

  const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
  const width = rect.width || (rect.right - rect.left) || 0;
  const height = rect.height || (rect.bottom - rect.top) || 0;
  const x = Math.round(rect.left + width / 2);
  const y = Math.round(rect.top + height / 2);
  context.showClickEffect(x, y);

  if (typeof anyEl.focus === 'function') {
    try { anyEl.focus(); } catch (_) {}
  }

  const eventCoords = {
    bubbles: true,
    cancelable: true,
    view: win as any,
    clientX: x,
    clientY: y,
    screenX: x,
    screenY: y,
    button: 0,
    buttons: 1,
    isPrimary: true
  };

  const PointerEventCtor = (win && (win as any).PointerEvent) || (typeof PointerEvent !== 'undefined' ? PointerEvent : undefined);
  const MouseEventCtor = (win && (win as any).MouseEvent) || (typeof MouseEvent !== 'undefined' ? MouseEvent : undefined);

  if (PointerEventCtor) {
    try {
      el.dispatchEvent(new PointerEventCtor('pointerenter', { ...eventCoords, buttons: 0 }));
      el.dispatchEvent(new PointerEventCtor('pointerover', { ...eventCoords, buttons: 0 }));
      el.dispatchEvent(new PointerEventCtor('pointerdown', eventCoords));
      el.dispatchEvent(new PointerEventCtor('pointerup', { ...eventCoords, buttons: 0 }));
    } catch (_) {}
  }

  ['mouseenter', 'mouseover', 'mousedown', 'mouseup'].forEach((eventType) => {
    if (MouseEventCtor) {
      const event = new MouseEventCtor(eventType, {
        view: win as any,
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y
      });
      el.dispatchEvent(event);
    }
  });

  if (typeof anyEl.click === 'function') {
    anyEl.click();
  } else if (MouseEventCtor) {
    el.dispatchEvent(new MouseEventCtor('click', { view: win as any, bubbles: true, cancelable: true, clientX: x, clientY: y }));
  }

  const clickLabel = context.describeElement(el);
  return {
    success: true,
    label: clickLabel,
    message: `Clicked element [${elementId}]${clickLabel ? ` ("${clickLabel}")` : ''}`
  };
}

/**
 * Simulate realistic typing into input field with stable locator re-resolution
 */
export function doType(
  elementId: number | string,
  text: unknown,
  submit: unknown = false,
  context: ActionExecutionContext
): { success: boolean; label?: string; submitted?: boolean; message?: string; error?: string } {
  const el = context.resolveElement(elementId);
  if (!el) {
    return { success: false, error: `Element [${elementId}] no longer resolvable in DOM.` };
  }

  const anyEl = el as HTMLElement;
  if (typeof anyEl.scrollIntoView === 'function') {
    try {
      anyEl.scrollIntoView({ behavior: 'smooth', block: 'center' } as any);
    } catch (_) {
      anyEl.scrollIntoView();
    }
  }
  context.highlightElement(anyEl);

  const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
  const width = rect.width || (rect.right - rect.left) || 0;
  const height = rect.height || (rect.bottom - rect.top) || 0;
  const x = Math.round(rect.left + width / 2);
  const y = Math.round(rect.top + height / 2);
  context.animateCursor(x, y);

  if (typeof anyEl.focus === 'function') {
    anyEl.focus();
  }

  const applied = context.setFieldValue(el, text);
  if (!applied.success) {
    return { success: false, error: applied.error };
  }

  if (submit) {
    const form = typeof el.closest === 'function' ? (el.closest('form') as HTMLFormElement | null) : null;
    if (form) {
      if (typeof form.requestSubmit === 'function') {
        form.requestSubmit();
      } else if (typeof form.submit === 'function') {
        form.submit();
      }
    } else {
      const KeyboardEventCtor = (context.win && (context.win as any).KeyboardEvent) || SafeKeyboardEvent;
      const enter = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
      el.dispatchEvent(new KeyboardEventCtor('keydown', enter as any));
      el.dispatchEvent(new KeyboardEventCtor('keypress', enter as any));
      el.dispatchEvent(new KeyboardEventCtor('keyup', enter as any));
    }
  }

  const typeLabel = context.describeElement(el);
  return {
    success: true,
    label: typeLabel,
    submitted: !!submit,
    message: `Typed "${text}" into element [${elementId}]${typeLabel ? ` ("${typeLabel}")` : ''}`
  };
}

/**
 * Scroll webpage smoothly
 */
export function doScroll(
  direction: any = 'down',
  amount: any = 500,
  win: (Window & typeof globalThis) | undefined = typeof window !== 'undefined' ? window : undefined
): { success: boolean; message: string } {
  const distance = direction === 'up' ? -amount : amount;
  if (win && typeof win.scrollBy === 'function') {
    win.scrollBy({ top: distance, behavior: 'smooth' } as any);
  }
  return { success: true, message: `Scrolled ${direction} by ${amount}px` };
}

/**
 * Dispatch keypress event
 */
export function doPressKey(
  key = 'Enter',
  doc: Document = typeof document !== 'undefined' ? document : (null as unknown as Document)
): { success: boolean; message: string } {
  const activeEl = (doc && (doc.activeElement || doc.body)) || null;
  if (activeEl) {
    const KeyboardEventCtor = (doc && (doc.defaultView as any)?.KeyboardEvent) || SafeKeyboardEvent;
    activeEl.dispatchEvent(new KeyboardEventCtor('keydown', { key, bubbles: true } as any));
    activeEl.dispatchEvent(new KeyboardEventCtor('keyup', { key, bubbles: true } as any));
  }
  return { success: true, message: `Pressed key [${key}]` };
}

/**
 * Execute deterministic sequence of primitives in one round trip with stable locator re-resolution
 */
export async function doBrowserBatch(
  steps: any[],
  stopOnError: boolean = true,
  context: ActionExecutionContext,
  win: (Window & typeof globalThis) | undefined = context.win || (typeof window !== 'undefined' ? window : undefined)
): Promise<any> {
  if (!Array.isArray(steps) || steps.length === 0) {
    return { success: false, error: 'browser_batch requires a non-empty "steps" array' };
  }

  if (steps.length > 8) {
    return { success: false, error: 'browser_batch exceeds maximum allowed 8 steps limit' };
  }

  const forbidden = ['navigate', 'go_back', 'go_forward', 'ask_user', 'finish', 'browser_batch'];
  const results: any[] = [];
  let completed = 0;
  let abortedAt: number | null = null;
  let terminatedBy: string | null = null;

  const initialUrl = win && win.location ? win.location.href : '';

  for (let i = 0; i < steps.length; i++) {
    const step = { ...steps[i] };

    const actName = step.action || (step.click !== undefined ? 'click' : step.type !== undefined ? 'type' : '');
    const targetId = step.element_id || step.index || step.elementId || step.element;

    if (forbidden.includes(actName)) {
      const err = `Action "${actName}" is forbidden inside browser_batch`;
      results.push({ step: i, action: actName, ok: false, error: err });
      abortedAt = i;
      if (stopOnError) break;
      continue;
    }

    try {
      const stepPayload = { ...step, action: actName, element_id: targetId };
      const stepRes = await context.execute(stepPayload);

      if (stepRes.success !== false) {
        results.push({ step: i, action: actName, ok: true, message: stepRes.message });
        completed++;
      } else {
        results.push({ step: i, action: actName, ok: false, error: stepRes.error });
        abortedAt = i;
        if (stopOnError) break;
      }
    } catch (stepErr: any) {
      results.push({ step: i, action: actName, ok: false, error: stepErr.message });
      abortedAt = i;
      if (stopOnError) break;
    }

    if (win && win.location && win.location.href !== initialUrl) {
      terminatedBy = 'navigation';
      break;
    }

    await context.waitForDomQuiet(300, 1500);
  }

  const ok = results.length > 0 && results.every((r) => r.ok);
  const summary = `${completed}/${steps.length} step(s) completed${terminatedBy ? ` (stopped by ${terminatedBy})` : ''}`;
  return {
    success: ok,
    completed,
    total: steps.length,
    results,
    abortedAt,
    terminatedBy,
    message: ok ? summary : undefined,
    error: ok ? undefined : `${summary}. First failure: ${(results.find((r) => !r.ok) || {}).error || 'unknown'}`
  };
}

/**
 * Execute action requested by agent
 */

// The read position of read_page_text on the current page, with the whole extracted text it pages
// through. Module state on purpose: the action executor lives for the lifetime of the page, so a
// navigation resets it with the page itself.
interface PageReadState { url: string; text: string; next: number; exhausted: boolean }
let pageReadState: PageReadState | null = null;
/** An element text over this is cut, with a note naming its full size. */
const ELEMENT_TEXT_CAP = 2000;

export async function execute(
  actionPayload: any,
  context: ActionExecutionContext,
  doc: Document = context.doc || (typeof document !== 'undefined' ? document : (null as unknown as Document)),
  win: (Window & typeof globalThis) | undefined = context.win || (typeof window !== 'undefined' ? window : undefined)
): Promise<any> {
  const { action, element_id, text, submit, direction, amount, seconds, key, url, steps, stopOnError = true } = actionPayload;

  switch (action) {
    case 'click':
      return context.doClick(element_id);
    case 'type':
      return context.doType(element_id, text, submit);
    case 'scroll':
      return context.doScroll(direction, amount);
    case 'press_key':
      return context.doPressKey(key);
    case 'navigate':
      if (win && win.location) win.location.href = url;
      return { success: true, message: `Navigating to ${url}` };
    case 'go_back':
      if (win && win.history) win.history.back();
      return { success: true, message: 'Going back' };
    case 'go_forward':
      if (win && win.history) win.history.forward();
      return { success: true, message: 'Going forward' };
    case 'read_page_text':
    case 'extract_page_text': {
      const compressor = win && (win as any).domCompressor ? (win as any).domCompressor : null;
      // Scoped read: with a valid element_id, return only that element's text. This is how the model
      // reads result 2, 3, ... of a long search page, whose full text is capped far below the page.
      const requestedId = actionPayload.element_id;
      if (requestedId !== undefined && requestedId !== null && String(requestedId).trim() !== '') {
        const el = context.resolveElement
          ? context.resolveElement(requestedId as number | string)
          : null;
        if (!el) {
          return { success: false, error: `Element [${String(requestedId)}] is not on this page's element list. Use an element_id from the last snapshot, or read_page_text without element_id for the next part of the page text.` };
        }
        const elText = ((el as HTMLElement).innerText || (el as Element).textContent || '').trim();
        const shown = clipWithNote(elText, ELEMENT_TEXT_CAP, { what: 'element text', hint: 'read a smaller element inside it by its element_id' });
        return {
          success: true,
          message: `Text of element [${String(requestedId)}] (${elText.length} chars):\n"""\n${shown}\n"""`,
          result: { pageText: shown },
        };
      }
      // The whole page text, not the snapshot's capped one, so paging reaches past the snapshot cap.
      const pageText =
        compressor && typeof compressor.extractFullPageText === 'function'
          ? compressor.extractFullPageText()
          : compressor && typeof compressor.extractPageText === 'function'
            ? compressor.extractPageText()
            : doc && doc.body
              ? (doc.body as HTMLElement).innerText || doc.body.textContent || ''
              : '';
      const url = win && win.location ? win.location.href : '';
      // The prompt promises "read more text of this page". A repeated read of the SAME text must
      // move forward, or the model re-reads the same first part forever (it did exactly that on
      // an arXiv feed page: five identical reads, no progress, run ended without the answer).
      // A different URL, or a text that changed under the same URL, starts the read over.
      if (!pageReadState || pageReadState.url !== url || pageReadState.text !== pageText) {
        pageReadState = { url, text: pageText, next: 0, exhausted: false };
      }
      // After the end, the read starts over - but the model must know it is re-reading, or it burns
      // steps on text it already has (it did: a full wrap-around read after "end of the text").
      const again = pageReadState.next === 0 && pageReadState.exhausted;
      const part = pageTextPart(pageText, pageReadState.next, again);
      pageReadState.next = part.last ? 0 : pageReadState.next + 1;
      if (part.last) pageReadState.exhausted = true;
      return {
        success: true,
        message: `Extracted text snippet (${part.note}):\n"""\n${part.text}\n"""`,
        result: { pageText: part.text, note: part.note },
      };
    }
    case 'browser_batch':
      return context.doBrowserBatch(steps, stopOnError);
    case 'wait': {
      // The background clamps model waits to 1..5 s (BUG-36); this content-side
      // fallback keeps the same band so nothing here can park a run either,
      // and amount:0 waits the legacy 1 s.
      const waitSec = Math.min(5, Math.max(1, amount ?? seconds ?? 1));
      await new Promise((r) => setTimeout(r, waitSec * 1000));
      return { success: true, message: `Waited ${waitSec}s` };
    }
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}
