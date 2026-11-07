// src/background/mcp/server.ts
// MCP server that wraps the existing browser APIs.
//
// The server is called in-process by the client (src/background/mcp/client.ts), which owns the
// tool loop. There is no JSON-RPC transport and no @modelcontextprotocol/sdk: the tools are a
// plain list of names and argument schemas (./tools.ts) and a tool call is a method call.
import { takeSnapshot } from '../browser/snapshot.ts';
import { TOP_FRAME, readFrameTexts } from '../browser/frames.ts';
import { executeAction } from '../browser/execute.ts';
import { cdp } from '../browser/cdp.ts';
import { captureScreenshot, ScreenshotError, chromePagePort, type ScreenshotDeps } from '../browser/screenshot.ts';
import { checkFrame, imageToViewport, isInsideFrame, makeFrame, outOfFrameMessage, type CoordinateFrame } from '../browser/screenshotFrame.ts';
import { Logger } from '../../shared/logger.ts';
import { toPicturePixels, type CoordinateSpace } from '../llm/coordinates.ts';
import { resolveKey } from '../browser/input.ts';
import type { ExecResult, RunRuntime } from '../runner/runtimeRegistry.ts';
import type { EffectDetail } from '../types.ts';
import { RESEARCH_TOOL_NAMES } from './tools.ts';
import { sourceOf, wrapUntrusted } from './untrusted.ts';
import { finishOutcomeOf, type FinishOutcome } from './historyEntries.ts';
import { webSearch } from '../research/search.ts';
import { fetchUrl } from '../research/fetchText.ts';
import { Storage, normalizeResearch } from '../../shared/storage.ts';

/** A block of text in a tool result, which is what a model reads. */
export interface TextContent {
  type: 'text';
  text: string;
}

/**
 * A picture in a tool result.
 *
 * The bytes live here and in the LLM message, never in a history row: the panel rebuilds the
 * whole timeline from the history on every broadcast, and a base64 JPEG in it would be re-parsed
 * on every one of them, and written into the saved session.
 */
export interface ImageContent {
  type: 'image';
  /** The bytes, base64, no data: prefix. */
  data: string;
  mediaType: 'image/jpeg' | 'image/png';
  /** The id the panel fetches the picture by. */
  imageId: string;
  /** The measured size of the picture the model is given. */
  imageWidth: number;
  imageHeight: number;
}

export interface CallToolResult {
  content: Array<TextContent | ImageContent>;
  isError?: boolean;
}

/**
 * What a tool call produced: the text blocks the model reads, and at most one picture.
 *
 * The client separates the two because a picture travels in a `role:'user'` message after the
 * whole tool block, never inside a `role:'tool'` message (the providers accept text only there).
 */
export interface ToolOutcome {
  text: string;
  image?: ImageContent;
  /** A table to show alongside the answer for quick comparison. */
  table?: { columns: string[]; rows: string[][] };
  /** finish only: how the run went, as the model said it (done, partial, blocked). */
  outcome?: FinishOutcome;
  isError?: boolean;
  /** The name the timeline row shows for what the step read (a fetched document's title or file name). */
  label?: string;
}

/** How many pictures a session keeps for the panel. The model's copy is trimmed separately. */
export const PICTURE_KEEP = 8;

/** A refusal to click by coordinates, in the words the model reads. */
export function coordinateClickRefusal(args: Record<string, any>): string | null {
  const hasX = args?.x !== undefined && args?.x !== null;
  const hasY = args?.y !== undefined && args?.y !== null;
  const hasId = args?.element_id !== undefined && args?.element_id !== null;
  if (hasId) return null;
  if (hasX && hasY) return null;
  if (hasX || hasY) {
    return 'Error: a coordinate click needs both x and y. Give both, or use element_id from get_page_elements or find.';
  }
  return 'Error: click needs either an element_id from get_page_elements or find, or both x and y read off a take_screenshot picture.';
}

/** The words a bot check or CAPTCHA control uses. Tarka never clicks one: a person must pass it. */
export const BOT_CHECK_PATTERN = /verify (?:that )?you(?: are|'re) (?:a )?human|i'?m not a robot|are you a robot|captcha|human verification|bot check|challenges\.cloudflare\.com|turnstile/i;

/** The refusal of a click on a bot check, worded so the model stops and tells the user. */
export function botCheckRefusal(elementId: unknown, label: string): string {
  return `Refused: element [${elementId}] is a bot check (${label.trim().slice(0, 80)}). Tarka never clicks or solves bot checks or CAPTCHAs. Call finish now and tell the user the page is behind a bot check that a person has to pass.`;
}

export function botCheckPointRefusal(what: string): string {
  return `Refused: that point is on a bot check (${what.trim().slice(0, 80)}). Tarka never clicks or solves bot checks or CAPTCHAs. Call finish now and tell the user the page is behind a bot check that a person has to pass.`;
}

/**
 * What a click on a link to another page of this site says when the tab did not go there. A
 * consent banner can swallow every click on the page (frame.work does until cookies are answered),
 * and a bare "Clicked" made the model believe it had arrived.
 */
export function linkNotOpenedNote(elementLine: string): string {
  const path = /\(.*?\bhref="([^"]+)"/.exec(elementLine)?.[1];
  return path
    ? `\nNote: the link did not open its page (${path}): this tab is still on the same page. Something may be blocking clicks, such as a cookie or consent banner: answer it first, or navigate to the link's address.`
    : '';
}

/**
 * How much visible text (characters that appeared plus went away) counts as "the page changed a
 * lot": then a fresh screenshot goes with the result. A clock or a status ticker changes a few
 * dozen characters, a new panel, dialog or result list several hundred.
 */
export const LARGE_TEXT_CHANGE_CHARS = 300;

/** The start of every observation line, which the harness and the tamper anchor on. */
export const OBSERVATION_PREFIX = 'Observation:';

/** The note on a picture that shows the same page as the one before it. */
export const SAME_PICTURE_NOTE = 'Same picture as your last screenshot.';

/** The note on a text read that is the same as the one before it. */
export const SAME_TEXT_NOTE = 'Same text as your last read.';

function quoted(text: string, max = 120): string {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return `"${t.length > max ? `${t.slice(0, max - 1)}…` : t}"`;
}

/**
 * The one fact line an action's result ends with: what the effect probe measured, never a
 * verdict. A fact that could not be measured says unknown.
 *
 * @param detail   the probe's facts (undefined when the page did not answer)
 * @param urlAfter the tab's url after the action when it changed (the tabs API is the authority on that)
 */
export function observationLine(detail: EffectDetail | undefined | null, urlAfter?: string): string {
  if (!detail) {
    return urlAfter
      ? `${OBSERVATION_PREFIX} url now ${urlAfter}; the rest is unknown (the page did not answer)`
      : `${OBSERVATION_PREFIX} unknown (the page did not answer the effect probe)`;
  }
  const urlChanged = urlAfter ? true : detail.urlChanged;
  const url = urlAfter || detail.url;
  if (!detail.base) {
    return `${OBSERVATION_PREFIX} url ${urlChanged === false ? 'unchanged' : `now ${url}`}; a new page loaded, so what changed in view is unknown`;
  }
  const focus = detail.focus;
  const caret = focus && focus.editable && typeof focus.caretLine === 'string' ? `, caret line ${quoted(focus.caretLine)}` : '';
  const containerMoved = detail.container && typeof detail.container.moved === 'number' && detail.container.moved !== 0;
  const quiet = detail.textChanged === false && detail.focusChanged === false && detail.scrollChanged === false
    && !containerMoved && urlChanged === false;
  if (quiet) return `${OBSERVATION_PREFIX} nothing in view changed; focus unchanged${caret}; url unchanged`;

  const parts: string[] = [];
  if (detail.focusChanged === null) parts.push('focus unknown');
  else if (!focus) parts.push(detail.focusChanged ? 'focus left the element (nothing focused)' : 'nothing focused');
  else parts.push(`${detail.focusChanged ? 'focus moved to' : 'focus still on'} ${quoted(focus.label, 80)}${caret}`);

  if (detail.textChanged === null) parts.push('text in view unknown');
  else if (!detail.textChanged) parts.push('text in view unchanged');
  else {
    const diff = [detail.added ? `+${quoted(detail.added, 400)}` : '', detail.removed ? `-${quoted(detail.removed, 400)}` : ''].filter(Boolean).join(' ');
    parts.push(`text in view changed${diff ? ` (${diff})` : ''}`);
  }

  if (detail.scrollChanged) parts.push(`page scrolled to x=${detail.scroll.x}, y=${detail.scroll.y}`);
  if (containerMoved) parts.push(`${quoted(detail.container!.label, 60)} scrolled ${detail.container!.moved! > 0 ? 'down' : 'up'} ${Math.abs(detail.container!.moved!)}px (now at ${detail.container!.top})`);
  if (detail.scrollChanged === false && !containerMoved) parts.push('scroll unchanged');
  else if (detail.scrollChanged === null) parts.push('scroll unknown');

  parts.push(urlChanged === null ? 'url unknown' : urlChanged ? `url now ${url}` : 'url unchanged');
  return `${OBSERVATION_PREFIX} ${parts.join('; ')}`;
}

/** Whether the visible text changed enough that a fresh picture is worth its tokens. */
export function isLargeChange(detail: EffectDetail | undefined | null): boolean {
  return !!detail && detail.base && detail.textChanged === true && detail.changedChars >= LARGE_TEXT_CHANGE_CHARS;
}

/**
 * What type says about the field after typing: the first 120 characters it holds, and an honest
 * note when the typed text is not in it.
 */
export function fieldReadBack(fieldText: string | null | undefined, typed: string): string {
  if (typeof fieldText !== 'string') return '\nThe field could not be read back, so it is not known what it holds now.';
  const norm = (t: string) => t.replace(/\s+/g, ' ').trim();
  const head = fieldText.replace(/\s+/g, ' ').trim().slice(0, 120);
  const want = norm(typed);
  const holds = !want || norm(fieldText).includes(want.slice(0, 1000));
  return `\nField now starts with: "${head}"${holds ? '' : '\nNote: the field does not contain the text you typed: the page may have refused or changed it.'}`;
}

/**
 * The line a read gets when a code editor on the page draws only the lines near the view
 * (CodeMirror 6 stands a .cm-gap in for the rest). The same words as the content script's note.
 */
export const EDITOR_LINES_NOTE = 'Note: a code editor here draws only the lines near the view (editor may hide off-screen lines). Scroll it into view to read the rest.';

/**
 * The arguments with an element_id a model wrote for "no element" ("None", "null", "", 0) taken
 * out, and a number written as a string ("12") read as the number. A coordinate click that also
 * carried element_id "None" was sent down the element path and failed with "Element [None]".
 */
export function normalizeElementId(args: any): any {
  if (!args || typeof args !== 'object' || !('element_id' in args)) return args;
  const raw = args.element_id;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\s*\d+\s*$/.test(raw) ? Number(raw) : NaN;
  const { element_id: _dropped, ...rest } = args;
  return Number.isInteger(n) && n >= 1 ? { ...rest, element_id: n } : rest;
}

/** The part a read_page call asks for: a whole number from 1 up, 1 when it is left out. */
export function readPagePart(raw: unknown): number | null {
  if (raw === undefined || raw === null) return 1;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/** What the content script measured for one scroll (InputDispatcher.handleScroll). */
export interface ScrollMeasurement {
  moved: number;
  label: string;
  direction?: 'up' | 'down';
  top: number;
  max: number;
  atTop: boolean;
  atBottom: boolean;
  fallback?: boolean;
}

/**
 * The first line of a scroll result: what moved and by how much, measured, or that nothing moved
 * and why. Never a "Scrolled" that is not true.
 */
export function scrollResultText(direction: 'up' | 'down', m: ScrollMeasurement | null | undefined): string {
  if (!m || typeof m.moved !== 'number') return `Scrolled ${direction}, but the page did not say how far, so whether anything moved is unknown.`;
  const label = m.label || 'the page';
  if (m.moved === 0) {
    const edge = direction === 'down' ? m.atBottom : m.atTop;
    return edge
      ? `Did not move: already at the ${direction === 'down' ? 'bottom' : 'top'} of ${label}.`
      : `Did not move: ${label} did not scroll. Give scroll an element_id inside the area you want to move, or x and y on it from a screenshot.`;
  }
  const where = m.atBottom ? ', the bottom' : m.atTop ? ', the top' : '';
  const how = m.fallback ? ' (the mouse wheel did not move it, so it was scrolled directly)' : '';
  return `Scrolled ${label} ${m.moved > 0 ? 'down' : 'up'} ${Math.abs(m.moved)}px, now at ${m.top} of ${m.max}px${where}${how}.`;
}

/** A short stable hash of a text, for "same as last time". */
function textHash(text: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  return `${h.toString(16)}:${text.length}`;
}

/** The element lines of a list ("[3] button \"Buy\""), by id. */
function elementLinesById(elementsText: string): Map<number, string> {
  const lines = new Map<number, string>();
  for (const line of String(elementsText || '').split('\n')) {
    const match = line.match(/^\s*\[(\d+)\]/);
    if (match) lines.set(Number(match[1]), line);
  }
  return lines;
}

export class TarkaMCPServer {
  private runtime: RunRuntime | null = null;
  /** The element list the model last saw, per tab: what a click on an id targets. */
  private elementLines = new Map<number, Map<number, string>>();
  /** The frame of the last screenshot, per tab. The model's coordinates are in these pixels. */
  private frames = new Map<number, CoordinateFrame>();
  /** True once a provider refused a picture this run: the tool is no longer offered or run. */
  private visionUnavailable = false;
  /** How the server reaches the page for a capture. Replaced by a test or the harness. */
  private screenshotDeps: ((tabId: number) => ScreenshotDeps) | null = null;
  private mintedImages = 0;
  /**
   * The pictures this session took, by id, for the panel's thumbnail. The bytes never enter a
   * history row: the panel rebuilds the timeline on every broadcast, so a base64 JPEG in a row
   * would be re-parsed on every one of them and written into the saved session.
   *
   * The last PICTURE_KEEP pictures are kept, oldest dropped first. A run longer than that leaves
   * rows whose picture is gone, and those rows say so instead of showing a broken image.
   */
  private images = new Map<string, { data: string; mediaType: string; tabId: number }>();

  setRuntime(runtime: RunRuntime) {
    this.runtime = runtime;
  }

  /** Replaces the capture path, so a test can stand in for Chrome. */
  setScreenshotDeps(factory: ((tabId: number) => ScreenshotDeps) | null) {
    this.screenshotDeps = factory;
  }

  /** The frame the last screenshot of a tab left behind, for a coordinate click. */
  frameFor(tabId: number): CoordinateFrame | null {
    return this.frames.get(tabId) ?? null;
  }

  /** The bytes of one picture of this session, or null when it is not held (or was dropped). */
  getScreenshot(imageId: string): { data: string; mediaType: string } | null {
    const held = this.images.get(String(imageId || ''));
    return held ? { data: held.data, mediaType: held.mediaType } : null;
  }

  /** How many pictures the registry holds. */
  get keptImages(): number {
    return this.images.size;
  }

  /** Turns the screenshot tool off for the rest of the run, after a provider refused a picture. */
  setVisionUnavailable(): void {
    this.visionUnavailable = true;
  }

  isVisionUnavailable(): boolean {
    return this.visionUnavailable;
  }

  /** The element line an id stood for in the last list of a tab ("[12] button \"Buy\""), or ''. */
  elementLabel(tabId: number | null | undefined, elementId: unknown): string {
    if (typeof tabId !== 'number' || elementId === undefined || elementId === null) return '';
    return this.elementLines.get(tabId)?.get(Number(elementId)) || '';
  }

  // List available tools - returns the same definitions as TARKA_TOOLS
  async listTools(): Promise<any[]> {
    const { TARKA_TOOLS } = await import('./tools.ts');
    return TARKA_TOOLS;
  }

  /** The fetch the research tools use: the worker's own, unless a test stood one in. */
  private researchFetch: typeof fetch | null = null;

  setResearchFetch(fetchImpl: typeof fetch | null) {
    this.researchFetch = fetchImpl;
  }

  // Execute a tool call
  async callTool(name: string, args: any): Promise<ToolOutcome> {
    // Research reads the web from the worker, not from the tab: it runs with no tab at all.
    if (RESEARCH_TOOL_NAMES.has(name)) return await this.research(name, args || {});

    if (!this.runtime) {
      return { text: 'Error: No active browser session', isError: true };
    }

    const tabId = this.runtime.tabs.activeTabId ?? this.runtime.tabs.ownerTabId;

    if (!tabId) {
      return { text: 'Error: No active tab', isError: true };
    }

    try {
      return await this.executeTool(name, normalizeElementId(args), tabId);
    } catch (err: any) {
      Logger.error('MCP Server', `Tool ${name} failed`, err);
      return { text: `Error: ${err.message}`, isError: true };
    }
  }

  private async executeTool(name: string, args: any, tabId: number): Promise<ToolOutcome> {
    const rt = this.runtime!;
    // Only the action right after a type gets the covered-button hint.
    if (name !== 'type' && name !== 'click') this.lastTyped.delete(tabId);

    switch (name) {
      case 'read_page': {
        const part = readPagePart(args?.part);
        if (part === null) return { text: `Error: part must be a whole number from 1 up, got ${JSON.stringify(args?.part)}.`, isError: true };
        const hasId = args?.element_id !== undefined && args?.element_id !== null;
        // innerText never enters an iframe: the text of each embedded frame (a lesson, a document
        // viewer) is read by that frame's own agent and added after the page text.
        const frames = hasId ? [] : await readFrameTexts(tabId).catch(() => []);
        const outcome = await this.run(tabId, { action: 'read_page', part, ...(hasId ? { element_id: args.element_id } : {}), ...(frames.length ? { frames } : {}) }, rt);
        if (!outcome.ok) return outcome.result;
        const read: any = outcome.exec?.result || {};
        const text = typeof read.pageText === 'string' && read.pageText ? read.pageText : '(no text)';
        // The link targets of this part (content/pageLinks.ts) go after the text, inside the same
        // untrusted envelope: an address is the page's words too.
        const body = typeof read.links === 'string' && read.links ? `${text}\n\n${read.links}` : text;
        const editorNote = read.hidesLines ? `\n${EDITOR_LINES_NOTE}` : '';
        const head = `${hasId ? `Text of element [${args.element_id}]` : 'Page text'} (${read.note || `part ${part}`}):${editorNote}`;
        const url = (await rt.browser.tabInfo(tabId).catch(() => null))?.url || '';
        const hash = textHash(`${url}\n${hasId ? args.element_id : ''}\n${part}\n${body}`);
        const same = this.lastTextHash.get(tabId) === hash;
        this.lastTextHash.set(tabId, hash);
        // The page's words are the page's, not the user's: they come in the untrusted envelope.
        return { text: `${same ? `${SAME_TEXT_NOTE}\n` : ''}${head}\n${wrapUntrusted(sourceOf(url), body)}` };
      }

      case 'get_page_elements': {
        const snapshot = await takeSnapshot(tabId, { showBadges: false, maxElements: 100 }, {
          isTabInScope: async () => true,
          sleep: (ms) => rt.clock.sleep(ms)
        });
        this.elementLines.set(tabId, elementLinesById(snapshot.elementsText || ''));
        return { text: snapshot.elementsText || '(no interactive elements found)' };
      }

      case 'find': {
        // The content script scans every element of the page (not only the listed window), and
        // the ids it hands out work for click and type like the ones of get_page_elements.
        const query = String(args?.query ?? '').trim();
        if (!query) return { text: 'Error: find needs a query: the plain words to look for, such as "next page".', isError: true };
        const outcome = await this.run(tabId, { action: 'find_element', query }, rt);
        if (!outcome.ok) return outcome.result;
        const found: any = outcome.exec?.result || {};
        const known = this.elementLines.get(tabId) ?? new Map<number, string>();
        for (const m of Array.isArray(found.matches) ? found.matches : []) {
          if (Number.isFinite(Number(m?.id)) && typeof m?.line === 'string') known.set(Number(m.id), m.line);
        }
        this.elementLines.set(tabId, known);
        return { text: outcome.exec?.message || `No element on this page matches "${query}".` };
      }

      case 'take_screenshot': {
        return await this.takeScreenshot(tabId, args);
      }

      case 'click': {
        const refusal = coordinateClickRefusal(args);
        if (refusal) return { text: refusal, isError: true };
        if (args?.element_id === undefined || args?.element_id === null) {
          return await this.clickAtCoordinates(tabId, args, rt);
        }
        // A bot check is never clicked, whatever the model thinks it should do: that is the user's.
        const target = this.elementLines.get(tabId)?.get(Number(args.element_id)) || '';
        if (BOT_CHECK_PATTERN.test(target)) return { text: botCheckRefusal(args.element_id, target), isError: true };
        const outcome = await this.run(tabId, { action: 'click', element_id: args.element_id }, rt);
        if (!outcome.ok) return outcome.result;
        this.lastTyped.delete(tabId);
        const arrived = outcome.exec?.effect === 'url_changed' ? await this.arrivedPageText(tabId, rt) : linkNotOpenedNote(target);
        return await this.observed(tabId, `Clicked element [${args.element_id}]${args.reason ? `: ${args.reason}` : ''}${arrived}`, outcome.exec);
      }

      case 'type': {
        const hasId = args?.element_id !== undefined && args?.element_id !== null;
        const field = hasId ? this.elementLines.get(tabId)?.get(Number(args.element_id)) || '' : '';
        if (BOT_CHECK_PATTERN.test(field)) return { text: botCheckRefusal(args.element_id, field), isError: true };
        const mode = args.mode === 'append' ? 'append' : 'replace';
        const outcome = await this.run(tabId, {
          action: 'type',
          ...(hasId ? { element_id: args.element_id } : {}),
          text: args.text,
          submit: args.submit,
          mode
        }, rt);
        if (!outcome.ok) return outcome.result;
        this.lastTyped.add(tabId);
        const arrived = outcome.exec?.effect === 'url_changed' ? await this.arrivedPageText(tabId, rt) : '';
        const where = hasId ? `element [${args.element_id}]` : `the focused element${outcome.exec?.label ? ` (${outcome.exec.label})` : ''}`;
        const how = mode === 'append' ? 'Appended to' : 'Typed into';
        const readBack = outcome.exec?.via === 'cdp' ? fieldReadBack(outcome.exec?.fieldText, String(args.text ?? '')) : '';
        return await this.observed(tabId, `${how} ${where}${mode === 'replace' ? ' (replaced its content)' : ''}${args.submit ? ' and pressed Enter' : ''}${args.reason ? `: ${args.reason}` : ''}${readBack}${arrived}`, outcome.exec);
      }

      case 'press_key': {
        const resolved = resolveKey(args?.key, args?.modifiers);
        if ('error' in resolved) return { text: resolved.error, isError: true };
        const outcome = await this.run(tabId, { action: 'press_key', key: args.key, modifiers: Array.isArray(args.modifiers) ? args.modifiers : [] }, rt);
        if (!outcome.ok) return outcome.result;
        const arrived = outcome.exec?.effect === 'url_changed' ? await this.arrivedPageText(tabId, rt) : '';
        const label = outcome.exec?.label || resolved.label;
        return await this.observed(tabId, `Pressed ${label}${args.reason ? `: ${args.reason}` : ''}${arrived}`, outcome.exec);
      }

      case 'scroll': {
        const direction = args?.direction === 'up' ? 'up' : 'down';
        const action: Record<string, unknown> = { action: 'scroll', direction };
        const hasX = args?.x !== undefined && args?.x !== null;
        const hasY = args?.y !== undefined && args?.y !== null;
        if (args?.element_id !== undefined && args?.element_id !== null) {
          action.element_id = args.element_id;
        } else if (hasX || hasY) {
          if (!(hasX && hasY)) return { text: 'Error: scroll at a point needs both x and y read off a take_screenshot picture.', isError: true };
          const mapped = this.pictureToViewport(tabId, args);
          if ('error' in mapped) return { text: mapped.error, isError: true };
          action.x = mapped.point.x;
          action.y = mapped.point.y;
        }
        const outcome = await this.run(tabId, action, rt);
        if (!outcome.ok) return outcome.result;
        const text = scrollResultText(direction, outcome.exec?.result as ScrollMeasurement | undefined);
        return await this.observed(tabId, `${text}${args?.reason ? ` Reason: ${args.reason}` : ''}`, outcome.exec);
      }

      case 'navigate': {
        const outcome = await this.run(tabId, { action: 'navigate', url: args.url }, rt);
        if (!outcome.ok) return outcome.result;
        return { text: `Navigated to ${args.url}${args.reason ? `: ${args.reason}` : ''}${await this.arrivedPageText(tabId, rt)}` };
      }

      case 'wait': {
        await rt.clock.sleep(args.amount * 1000);
        return { text: `Waited ${args.amount}s${args.reason ? `: ${args.reason}` : ''}` };
      }

      case 'go_back': {
        const outcome = await this.run(tabId, { action: 'go_back' }, rt);
        if (!outcome.ok) return outcome.result;
        return { text: 'Went back in history' };
      }

      case 'go_forward': {
        const outcome = await this.run(tabId, { action: 'go_forward' }, rt);
        if (!outcome.ok) return outcome.result;
        return { text: 'Went forward in history' };
      }

      case 'finish': {
        return { text: `TASK_COMPLETE: ${args.answer}`, table: args.table, outcome: finishOutcomeOf(args.outcome) };
      }

      default:
        return { text: `Unknown tool: ${name}`, isError: true };
    }
  }

  /**
   * web_search and fetch_url: a request from the service worker, never from the user's tab. Off
   * in Settings > Research, a call is refused (the model is not offered them then either).
   */
  private async research(name: string, args: any): Promise<ToolOutcome> {
    const settings = await Promise.resolve(this.runtime?.settings ? this.runtime.settings() : Storage.getSettings()).catch(() => null);
    const research = normalizeResearch(settings?.research);
    if (!research.enabled) {
      return { text: `Error: web research is off in Settings > Research, so ${name} did not run. Use the tab, or tell the user.`, isError: true };
    }
    const deps = { fetchImpl: this.researchFetch ?? undefined, signal: this.runtime?.control.stepSignal() };
    try {
      if (name === 'web_search') {
        const out = await webSearch(args, research, deps);
        return { text: out.text, ...(out.isError ? { isError: true } : {}) };
      }
      const out = await fetchUrl(args, deps);
      return { text: out.text, ...(out.isError ? { isError: true } : {}), ...(out.label ? { label: out.label } : {}) };
    } catch (err: any) {
      Logger.error('MCP Server', `Tool ${name} failed`, err);
      return { text: `Error: ${err?.message || String(err)}`, isError: true };
    }
  }

  /** The capture path: the real one, unless a test stood one in. */
  private screenshotDepsFor(tabId: number): ScreenshotDeps {
    if (this.screenshotDeps) return this.screenshotDeps(tabId);
    return {
      isTabInScope: (tId) => this.runtime!.browser.isTabInScope(tId),
      sendCommand: (tId, method, params, control) => this.sendCdp(tId, method, params, control),
      page: chromePagePort()
    };
  }

  /** Sends one CDP command through the shared manager. Split out so a test can stand in for it. */
  private async sendCdp(
    tabId: number,
    method: string,
    params: Record<string, unknown>,
    control?: { signal?: AbortSignal; stopRequested?: boolean; pauseRequested?: boolean }
  ): Promise<any> {
    await cdp.attach(tabId);
    return cdp.sendCommand(tabId, method, params, control);
  }

  /**
   * take_screenshot: the picture, its frame, and a text block the model can read.
   *
   * A failure comes back as an error the model can act on, never as a thrown exception that ends
   * the run: a restricted page or a renderer that will not answer has a text fallback.
   */
  private async takeScreenshot(tabId: number, args: Record<string, any>): Promise<ToolOutcome> {
    if (this.visionUnavailable) {
      return {
        text: 'Error: this model cannot see pictures, so the screenshot was not taken. Use read_page instead.',
        isError: true
      };
    }
    try {
      const shot = await captureScreenshot(tabId, this.screenshotDepsFor(tabId));
      const tempFrame = makeFrame(
        {
          url: (await this.runtime!.browser.tabInfo(tabId))?.url ?? '',
          viewportWidth: shot.viewportWidth,
          viewportHeight: shot.viewportHeight,
          devicePixelRatio: shot.devicePixelRatio,
          scrollX: shot.scrollX,
          scrollY: shot.scrollY,
          sig: shot.sig
        },
        { width: shot.imageWidth, height: shot.imageHeight }
      );
      this.frames.set(tabId, tempFrame);
      // The same page signature, scroll and url as the last picture of this tab: the model is told,
      // so it stops taking the same picture again. A page without a signature is never "the same".
      const shotKey = shot.sig
        ? JSON.stringify([tempFrame.url, shot.sig.interactiveHash, shot.sig.textHash, shot.scrollX, shot.scrollY, shot.viewportWidth, shot.viewportHeight])
        : null;
      const samePicture = shotKey !== null && this.lastShotKey.get(tabId) === shotKey;
      if (shotKey) this.lastShotKey.set(tabId, shotKey);
      else this.lastShotKey.delete(tabId);
      this.mintedImages += 1;
      const imageId = `shot-${Date.now().toString(36)}-${this.mintedImages}`;
      this.images.set(imageId, { data: shot.base64, mediaType: shot.mediaType, tabId });
      while (this.images.size > PICTURE_KEEP) {
        const oldest = this.images.keys().next().value;
        if (oldest === undefined) break;
        this.images.delete(oldest);
      }
      const how = this.coordinateSpace === 'per-mille'
        ? 'To click on it, give x and y on a 0-1000 scale of this picture.'
        : 'Coordinates you read off this picture are pixels in this picture.';
      return {
        text: `${samePicture ? `${SAME_PICTURE_NOTE} ` : ''}Captured the visible page (${shot.imageWidth}x${shot.imageHeight}, ${shot.mediaType}). ${how}`,
        image: {
          type: 'image',
          data: shot.base64,
          mediaType: shot.mediaType,
          imageId,
          imageWidth: shot.imageWidth,
          imageHeight: shot.imageHeight
        }
      };
    } catch (err: any) {
      const why = err instanceof ScreenshotError ? err.message : `Error: the screenshot failed: ${err?.message || String(err)}`;
      Logger.info('MCP Server', `Screenshot failed: ${why}`);
      return { text: `${why} Read the page text with read_page instead.`, isError: true };
    }
  }

  /**
   * click with x and y: the coordinate is a pixel in the last picture of this tab.
   *
   * The order is the one the plan names: the frame is checked against the live page FIRST, the
   * coordinate is mapped from the picture into viewport CSS pixels, the page is asked what is at
   * that point, and only then is the click dispatched - through executeAction, so it gets the
   * effect probe, the urlAfter capture and the settle an element-id click gets.
   */
  /**
   * A picture coordinate of the model as a viewport CSS pixel, through the frame of the last
   * screenshot of the tab, or the refusal the model reads.
   */
  private pictureToViewport(tabId: number, args: Record<string, any>): { point: { x: number; y: number }; frame: CoordinateFrame; reading: string } | { error: string } {
    const frame = this.frameFor(tabId);
    if (!frame) return { error: 'Error: no screenshot has been taken for this tab yet. Take one before using x and y.' };
    // The model's numbers in its own scale, as a pixel of the picture (see coordinates.ts).
    const read = toPicturePixels(this.coordinateSpace, Number(args.x), Number(args.y), { width: frame.imageWidth, height: frame.imageHeight });
    // The far edge of a 0-1000 scale (or a fraction of 1) is the last pixel row, not one past it.
    // Past the end of the scale stays outside the picture and is refused below.
    const scaleEnd = read.reading === 'fraction' ? 1 : 1000;
    const atEdge = (value: number, raw: number, size: number) => (read.reading !== 'pixels' && raw <= scaleEnd && value >= size ? size - 1 : value);
    const x = atEdge(read.x, Number(args.x), frame.imageWidth);
    const y = atEdge(read.y, Number(args.y), frame.imageHeight);
    if (!isInsideFrame(frame, x, y)) {
      return {
        error: this.coordinateSpace === 'per-mille'
          ? `Error: (${Number(args.x)}, ${Number(args.y)}) is outside the picture. x and y are positions from 0 to 1000 of the picture (${frame.imageWidth}x${frame.imageHeight}), not pixels. If the page changed, take a new screenshot first.`
          : outOfFrameMessage(frame, Number(args.x), Number(args.y))
      };
    }
    return { point: imageToViewport(frame, x, y), frame, reading: read.reading };
  }

  private async clickAtCoordinates(tabId: number, args: Record<string, any>, rt: RunRuntime): Promise<ToolOutcome> {
    const mapped = this.pictureToViewport(tabId, args);
    if ('error' in mapped) return { text: mapped.error, isError: true };
    const { frame } = mapped;

    // The page is re-read at click time, because a frame is only good while the page is the same.
    // It goes through the same deps the capture used, so the two are read the same way. A refusal
    // is for this one call: the next screenshot gives a fresh frame, and the path stays open.
    const live = await this.readLiveState(tabId, rt, this.screenshotDepsFor(tabId));
    const check = checkFrame(frame, live);
    if (!check.ok) {
      this.refusalCount += 1;
      return { text: check.reason || 'Error: the screenshot is out of date. Take a new one.', isError: true };
    }

    let point = mapped.point;

    // What is actually at that pixel. A point just next to a control is moved onto it (the page
    // answers with `snapped`). A sensitive field refuses the click; anything else is described in
    // the result, so the user and the model both know what was hit.
    const described = await this.describePointOnPage(tabId, point);
    if (described.refused) {
      return { text: described.refused, isError: true };
    }
    // A bot check is never clicked, by element or by point. Embedded frames are shown in pictures,
    // so a CAPTCHA frame can be seen and pointed at: what is under the point decides.
    if (described.what && BOT_CHECK_PATTERN.test(described.what)) {
      return { text: botCheckPointRefusal(described.what), isError: true };
    }
    if (described.snapped) point = { x: described.snapped.x, y: described.snapped.y };

    this.refusalCount = 0;
    const outcome = await this.run(tabId, { action: 'click_at', x: point.x, y: point.y }, rt);
    if (!outcome.ok) return outcome.result;
    this.lastTyped.delete(tabId);
    const arrived = outcome.exec?.effect === 'url_changed' ? await this.arrivedPageText(tabId, rt) : '';
    const where = `(${Number(args.x)}, ${Number(args.y)})${mapped.reading === 'pixels' ? ' in the picture' : mapped.reading === 'fraction' ? ' (a fraction of the picture)' : ' on the 0-1000 scale'}`;
    const snapped = described.snapped ? `, moved ${described.snapped.distance} px onto the control next to it` : '';
    const hit = described.what ? ` - ${described.what}${described.interactive ? '' : ', which is not a control'}` : '';
    return await this.observed(tabId, `Clicked at ${where}${snapped}${hit}${args.reason ? `: ${args.reason}` : ''}${arrived}`, outcome.exec);
  }

  /**
   * An action's result with its observation line, and a fresh picture when the visible text
   * changed a lot and this run may take pictures: the model then reads what happened from the
   * result, instead of spending a round on a screenshot.
   */
  private async observed(tabId: number, text: string, exec: ExecResult | undefined): Promise<ToolOutcome> {
    const urlAfter = exec?.effect === 'url_changed' && exec.urlAfter ? exec.urlAfter : undefined;
    const line = observationLine(exec?.effectDetail, urlAfter);
    const result: ToolOutcome = { text: `${text}\n${line}` };
    if (!this.visionUnavailable && isLargeChange(exec?.effectDetail)) {
      const shot = await this.takeScreenshot(tabId, {});
      if (shot.image && !shot.isError) {
        result.image = shot.image;
        result.text += '\nThe view changed a lot: a fresh screenshot of it is attached.';
      }
    }
    return result;
  }

  /** The scale the model of this run points with on a picture. The client sets it every turn. */
  private coordinateSpace: CoordinateSpace = 'pixels';

  setCoordinateSpace(space: CoordinateSpace): void {
    this.coordinateSpace = space;
  }

  /** How many coordinate clicks in a row the frame refused (reported, never a reason to close the path). */
  private refusalCount = 0;

  get coordinateRefusals(): number {
    return this.refusalCount;
  }

  /** The live page state a frame is checked against. */
  private async readLiveState(tabId: number, rt: RunRuntime, deps: ScreenshotDeps): Promise<{
    url: string; viewportWidth: number; viewportHeight: number; devicePixelRatio: number;
    scrollX: number; scrollY: number; sig: { interactiveHash: string; textHash: string; layoutHash?: string } | null;
  }> {
    const info = await rt.browser.tabInfo(tabId).catch(() => null);
    const probe = await deps.page.probe(tabId);
    const sig = await deps.page.signature(tabId);
    return {
      url: info?.url ?? (await deps.page.tabUrl(tabId)) ?? '',
      viewportWidth: probe.width,
      viewportHeight: probe.height,
      devicePixelRatio: probe.devicePixelRatio,
      scrollX: probe.scrollX,
      scrollY: probe.scrollY,
      sig
    };
  }

  /** Asks the page what is at a viewport point, through the content script's DESCRIBE_POINT. */
  private async describePointOnPage(
    tabId: number,
    point: { x: number; y: number }
  ): Promise<{ what: string; interactive: boolean; refused?: string; snapped?: { x: number; y: number; distance: number } }> {
    if (typeof chrome === 'undefined' || !chrome.tabs?.sendMessage) return { what: '', interactive: false };
    try {
      const response: any = await new Promise((resolve) => {
        try {
          chrome.tabs.sendMessage(tabId, { action: 'DESCRIBE_POINT', payload: { ...point, snap: true } }, TOP_FRAME, (resp) => {
            resolve(chrome.runtime?.lastError ? null : resp ?? null);
          });
        } catch (_) {
          resolve(null);
        }
      });
      if (!response) return { what: '', interactive: false };
      if (response.success === false) {
        return { what: String(response.what || ''), interactive: false, refused: String(response.error || 'Error: that point was refused.') };
      }
      const snap = response.snapped;
      const snapped = snap && Number.isFinite(Number(snap.x)) && Number.isFinite(Number(snap.y))
        ? { x: Number(snap.x), y: Number(snap.y), distance: Number(snap.distance) || 0 }
        : undefined;
      return { what: String(response.what || ''), interactive: response.interactive === true, ...(snapped ? { snapped } : {}) };
    } catch (_) {
      return { what: '', interactive: false };
    }
  }

  /**
   * Runs an action on the page and turns the outcome into a tool result.
   *
   * A failed action must come back as a failure. The model reads the text of a tool result and
   * decides what to do next: if a click that never reached the page is answered with "Clicked
   * element [3]", the model believes the page moved on, and the run ends with an answer about a
   * page it never changed. So the error of the action goes back to the model, and the result is
   * marked as an error so the panel shows it as a failed step.
   */
  /** The tabs whose last action was a type, for the covered-button hint. */
  private lastTyped = new Set<number>();
  /** The hash of the last read_page per tab, for "Same text as your last read". */
  private lastTextHash = new Map<number, string>();
  /** The page signature of the last picture per tab, for "Same picture as your last screenshot". */
  private lastShotKey = new Map<number, string>();


  /**
   * The start of the page text for the first message of a task: the snapshot's text, capped, the
   * same text an arrived page shows. It is not a tool call, so it never counts as a read.
   */
  async pagePreview(): Promise<string> {
    const rt = this.runtime;
    const tabId = rt ? rt.tabs.activeTabId ?? rt.tabs.ownerTabId : null;
    if (!rt || !tabId) return '';
    try {
      const snapshot = await takeSnapshot(tabId, { showBadges: false, maxElements: 0 }, {
        isTabInScope: async () => true,
        sleep: (ms) => rt.clock.sleep(ms)
      });
      return snapshot.pageText || '(page has no text)';
    } catch (err: any) {
      return `Error: ${err?.message || String(err)}`;
    }
  }

  /**
   * The text of the page an action led to, for the result of that action: a new page costs the
   * model one round less when it does not have to ask for the text it is going to ask for anyway.
   * Empty when the page cannot be read; the action itself still counts as done.
   */
  private async arrivedPageText(tabId: number, rt: RunRuntime): Promise<string> {
    try {
      const snapshot = await takeSnapshot(tabId, { showBadges: false, maxElements: 0 }, {
        isTabInScope: async () => true,
        sleep: (ms) => rt.clock.sleep(ms)
      });
      const head = `\n\nNOW ON: ${snapshot.title || 'Untitled'} (${snapshot.url || ''})`;
      return `${head}\nPAGE TEXT (no need to call read_page for the start of this page):\n${wrapUntrusted(sourceOf(snapshot.url || ''), snapshot.pageText || '(page has no text)')}`;
    } catch (_) {
      return '';
    }
  }

  private async run(
    tabId: number,
    action: Record<string, unknown>,
    rt: RunRuntime
  ): Promise<{ ok: boolean; result: ToolOutcome; exec?: ExecResult }> {
    // The user's pause between actions (Settings, actionDelayMs) applies to every page action.
    const settings = await Promise.resolve(rt.settings?.()).catch(() => null);
    const outcome: ExecResult = await executeAction(tabId, action, {
      runRuntime: rt,
      signal: rt.control.stepSignal(),
      actionDelayMs: Number(settings?.actionDelayMs) > 0 ? Number(settings?.actionDelayMs) : undefined
    });
    if (outcome.success) return { ok: true, result: { text: '' }, exec: outcome };
    const why = outcome.error || outcome.message || 'the action did not go through';
    Logger.info('MCP Server', `Tool action "${String(action.action)}" failed: ${why}`);
    // A button under the search suggestions of the field the model just typed into: Enter is the
    // way through, and the model is told so instead of trying the covered button again.
    const hint = /is covered by/i.test(why) && this.lastTyped.has(tabId)
      ? ' You just typed into a field: to submit it, call type again with submit=true (it presses Enter) instead of clicking.'
      : '';
    return { ok: false, result: { text: `Error: ${why}${hint}`, isError: true }, exec: outcome };
  }
}
