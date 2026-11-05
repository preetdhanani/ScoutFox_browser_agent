/**
 * ScoutFox Browser Actions Execution
 * Executes the content-side primitives of the page tools: click, type, scroll, navigate, read_page, find_element.
 */

import { formatFindMessage } from './domCompressor.ts';
import { normalizePageText, pageTextPart, readRootOf } from './pageText.ts';
import { runScrollAction } from './scrollActions.ts';
import { collectLinks, linksBlock, type PageLink } from './pageLinks.ts';

export interface ActionExecutionContext {
  doc?: Document;
  win?: Window & typeof globalThis;
  resolveElement: (elementId: number | string) => Element | null;
  highlightElement: (el: HTMLElement | null) => void;
  showClickEffect: (x: number, y: number) => void;
  animateCursor: (x: number, y: number) => void;
  waitForDomQuiet: (quietMs?: number, ceilingMs?: number) => Promise<void>;
  describeElement: (el: Element | null) => string;
  setFieldValue: (el: Element, text: unknown) => { success: boolean; error?: string };
  doClick: (elementId: number | string) => any;
  doType: (elementId: number | string, text: unknown, submit?: unknown) => any;
  /** The path key of the frame an iframe element shows (frameIds.ts), for a scroll that goes into it. */
  framePathOf?: (frame: HTMLIFrameElement) => string | null;
}

/** The text of one embedded frame, read by its frame agent and passed in by the background. */
export interface FrameText {
  origin: string;
  text: string;
  /** The links of the frame, already absolute (pageLinks.ts). */
  links?: PageLink[];
}

/** The links the frames of a read sent with their text. */
function frameLinks(frames: unknown): PageLink[] {
  if (!Array.isArray(frames)) return [];
  return frames.flatMap((f: any) => (Array.isArray(f?.links) ? f.links : []))
    .filter((l: any): l is PageLink => !!l && typeof l.url === 'string' && typeof l.label === 'string' && typeof l.context === 'string');
}

/**
 * The page text with the text of its embedded frames after it. innerText never enters an iframe,
 * so a lesson or a document inside one is only readable this way. Each frame gets a heading line
 * that names where its text comes from.
 */
export function withFrameTexts(text: string, frames: unknown): string {
  const list = Array.isArray(frames) ? frames.filter((f): f is FrameText => !!f && typeof f.text === 'string' && f.text.trim() !== '' && typeof f.origin === 'string') : [];
  if (!list.length) return text;
  return [text, ...list.map((f) => `--- Embedded frame from ${f.origin} ---\n${f.text.trim()}`)].filter((part) => part.trim() !== '').join('\n\n');
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
 * Execute action requested by agent
 */

/** The note a read gets when a code editor on the page draws only the lines near the view (CodeMirror 6). */
export const EDITOR_HIDES_LINES_NOTE = '(editor may hide off-screen lines)';

/** The line a read starts with when an editor in it hides lines: the note, and how to read the rest. */
export const EDITOR_HIDES_LINES_NOTE_LINE = `Note: a code editor here draws only the lines near the view ${EDITOR_HIDES_LINES_NOTE}. Scroll it into view to read the rest.`;

/**
 * The text a person reads in an element. A CodeMirror editor is read from its .cm-content, one
 * line per .cm-line, and `hidesLines` says whether it left lines out (CodeMirror 6 draws only the
 * lines near the view and stands a .cm-gap in for the rest).
 */
export function readableText(el: Element): { text: string; hidesLines: boolean } {
  const editors: Element[] = [];
  const own = typeof el.closest === 'function' ? el.closest('.cm-content') : null;
  if (own) editors.push(own);
  else if (typeof el.querySelectorAll === 'function') editors.push(...Array.from(el.querySelectorAll('.cm-content')));
  const hidesLines = editors.some((cm) => typeof cm.querySelector === 'function' && !!cm.querySelector('.cm-gap'));
  const source = own || el;
  const raw = (source as HTMLElement).innerText ?? source.textContent ?? '';
  return { text: normalizePageText(String(raw)), hidesLines };
}

export async function execute(
  actionPayload: any,
  context: ActionExecutionContext,
  doc: Document = context.doc || (typeof document !== 'undefined' ? document : (null as unknown as Document)),
  win: (Window & typeof globalThis) | undefined = context.win || (typeof window !== 'undefined' ? window : undefined)
): Promise<any> {
  const { action, element_id, text, submit, direction, amount, seconds, url } = actionPayload;

  switch (action) {
    case 'click':
      return context.doClick(element_id);
    case 'type':
      return context.doType(element_id, text, submit);
    case 'scroll':
    case 'scroll_target':
    case 'scroll_measure':
    case 'scroll_fallback':
      return runScrollAction(actionPayload, doc, win, {
        resolveElement: (id) => context.resolveElement(id),
        framePathOf: context.framePathOf ? (frame) => context.framePathOf!(frame) : undefined
      });
    case 'navigate':
      if (win && win.location) win.location.href = url;
      return { success: true, message: `Navigating to ${url}` };
    case 'go_back':
      if (win && win.history) win.history.back();
      return { success: true, message: 'Going back' };
    case 'go_forward':
      if (win && win.history) win.history.forward();
      return { success: true, message: 'Going forward' };
    case 'read_page': {
      // Stateless: the part is named in the request (1 when it is left out), so the same request
      // always gives the same text and a model can never fall into re-reading the first part.
      const rawPart = actionPayload.part;
      const partNumber = rawPart === undefined || rawPart === null || rawPart === '' ? 1 : Number(rawPart);
      if (!Number.isInteger(partNumber) || partNumber < 1) {
        return { success: false, error: `part must be a whole number from 1 up, got ${JSON.stringify(rawPart)}.` };
      }
      let source: { text: string; hidesLines: boolean };
      let what: string;
      let links: PageLink[] = [];
      const base = (win && win.location && win.location.href) || 'https://localhost/';
      const requestedId = actionPayload.element_id;
      if (requestedId !== undefined && requestedId !== null && String(requestedId).trim() !== '') {
        const el = context.resolveElement ? context.resolveElement(requestedId as number | string) : null;
        if (!el) {
          return { success: false, error: `Element [${String(requestedId)}] is not on this page's element list. Use an element_id from the last get_page_elements or find, or read_page without element_id.` };
        }
        source = readableText(el);
        what = `Text of element [${String(requestedId)}]`;
        links = collectLinks(el, base);
      } else {
        // The whole page text (inner scroll panels included, nothing windowed to the scroll
        // position), not the snapshot's capped one, so paging reaches every part of the page.
        const compressor = win && (win as any).domCompressor ? (win as any).domCompressor : null;
        const text = compressor && typeof compressor.extractFullPageText === 'function'
          ? compressor.extractFullPageText()
          : doc && doc.body
            ? normalizePageText((doc.body as HTMLElement).innerText || doc.body.textContent || '')
            : '';
        const hidesLines = !!(doc && typeof doc.querySelector === 'function' && doc.querySelector('.cm-content .cm-gap'));
        source = { text: withFrameTexts(String(text), actionPayload.frames), hidesLines };
        what = 'Page text';
        links = [...collectLinks(readRootOf(doc), base), ...frameLinks(actionPayload.frames)];
      }
      const part = pageTextPart(source.text, partNumber);
      if (partNumber > part.count) {
        return { success: false, error: `${what} has only ${part.count} part${part.count === 1 ? '' : 's'}, so there is no part ${partNumber}. Read part 1 to ${part.count}.` };
      }
      const editorNote = source.hidesLines ? `${EDITOR_HIDES_LINES_NOTE_LINE}\n` : '';
      const linkLines = linksBlock(links, source.text, part);
      return {
        success: true,
        message: `${what} (${part.note}):\n${editorNote}"""\n${part.text}${linkLines ? `\n\n${linkLines}` : ''}\n"""`,
        result: { pageText: part.text, links: linkLines, note: part.note, part: part.number, parts: part.count, hidesLines: source.hidesLines },
      };
    }
    case 'find_element': {
      // The lookup verb for elements past the listed window. The compressor scans ALL interactive
      // candidates, scores them against the query, and hands the best ones ids in its own
      // elementMap, so the ids the reply lists are the ids click and type accept.
      const query = typeof actionPayload.query === 'string' ? actionPayload.query.trim() : '';
      if (!query) {
        return { success: false, error: 'find_element needs a query: the plain words to look for, such as "next page".' };
      }
      const compressor = win && (win as any).domCompressor ? (win as any).domCompressor : null;
      if (!compressor || typeof compressor.findElements !== 'function') {
        return { success: false, error: 'find_element is not available on this page (no element snapshot engine running).' };
      }
      const found = compressor.findElements(query);
      return { success: true, message: formatFindMessage(found), result: found };
    }
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
