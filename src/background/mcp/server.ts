// src/background/mcp/server.ts
// MCP server that wraps the existing browser APIs.
//
// The server is called in-process by the client (src/background/mcp/client.ts), which owns the
// tool loop. There is no JSON-RPC transport and no @modelcontextprotocol/sdk: the tools are a
// plain list of names and argument schemas (./tools.ts) and a tool call is a method call.
import { takeSnapshot } from '../browser/snapshot.ts';
import { executeAction } from '../browser/execute.ts';
import { cdp } from '../browser/cdp.ts';
import { captureScreenshot, ScreenshotError, chromePagePort, type ScreenshotDeps } from '../browser/screenshot.ts';
import { checkFrame, imageToViewport, isInsideFrame, makeFrame, outOfFrameMessage, type CoordinateFrame } from '../browser/screenshotFrame.ts';
import { Logger } from '../../shared/logger.ts';
import { toPicturePixels, type CoordinateSpace } from '../llm/coordinates.ts';
import type { ExecResult, RunRuntime } from '../runner/runtimeRegistry.ts';

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
  isError?: boolean;
}

/** How many pictures a session keeps for the panel. The model's copy is trimmed separately. */
export const PICTURE_KEEP = 8;

/** Two refusals in a row is a page that keeps moving: the coordinate path then ends for the run. */
export const COORDINATE_REFUSAL_LIMIT = 2;

/** What the model is told when the coordinate path is closed, which names the path that works. */
export const COORDINATES_CLOSED_MESSAGE =
  'Error: the page keeps moving, so coordinates cannot be trusted. Use get_page_elements and click by element id instead.';

/** A refusal to click by coordinates, in the words the model reads. */
export function coordinateClickRefusal(args: Record<string, any>): string | null {
  const hasX = args?.x !== undefined && args?.x !== null;
  const hasY = args?.y !== undefined && args?.y !== null;
  const hasId = args?.element_id !== undefined && args?.element_id !== null;
  if (hasId) return null;
  if (hasX && hasY) return null;
  if (hasX || hasY) {
    return 'Error: a coordinate click needs both x and y. Give both, or use element_id from get_page_elements.';
  }
  return 'Error: click needs either an element_id from get_page_elements, or both x and y read off a take_screenshot picture.';
}

/** Words of a find query that say nothing about the element ("the Releases link" is about "releases"). */
const FIND_FILLER = new Set(['a', 'an', 'the', 'or', 'and', 'of', 'to', 'for', 'on', 'in', 'link', 'button', 'element', 'page', 'field', 'input', 'box', 'tab', 'icon', 'menu', 'item']);

/**
 * The element lines that match a find query, best first, at most 10.
 *
 * A model asks in words ("Releases link or latest release", "downloads page link"), not with the
 * exact text of the element. The whole query as one substring found nothing for both of those on
 * GitHub and python.org, and each miss cost a round plus a full element list. So the query is split
 * into words, the filler words are dropped, and a line scores the share of the remaining words it
 * contains (a word also matches as the start of a longer one: "download" finds "Downloads").
 * A line with the whole query in it always comes first.
 */
export function rankElementLines(elementsText: string, query: string): string[] {
  const lines = String(elementsText || '').split('\n').filter((line) => /^\s*\[\d+\]/.test(line));
  const whole = String(query || '').toLowerCase().trim();
  if (!whole) return [];
  const words = whole.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1 && !FIND_FILLER.has(w));
  const scored = lines.map((line, index) => {
    const text = line.toLowerCase();
    if (text.includes(whole)) return { line, index, score: 2 };
    if (words.length === 0) return { line, index, score: 0 };
    // Words glued to numbers in a path ("laptop16") also count as their parts, so "Laptop 16" finds it.
    const parts = text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const tokens = [...parts, ...parts.flatMap((t) => t.split(/(?<=\p{L})(?=\p{N})|(?<=\p{N})(?=\p{L})/u))];
    const hits = words.filter((w) => tokens.some((t) => t === w || (w.length >= 4 && t.startsWith(w)) || (t.length >= 4 && w.startsWith(t))));
    return { line, index, score: hits.length / words.length };
  });
  // At least half of the words: one word of a one- or two-word query.
  return scored
    .filter((s) => s.score >= 0.5)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 10)
    .map((s) => s.line);
}

/** The words a bot check or CAPTCHA control uses. ScoutFox never clicks one: a person must pass it. */
export const BOT_CHECK_PATTERN = /verify (?:that )?you(?: are|'re) (?:a )?human|i'?m not a robot|are you a robot|captcha|human verification|bot check/i;

/** The refusal of a click on a bot check, worded so the model stops and tells the user. */
export function botCheckRefusal(elementId: unknown, label: string): string {
  return `Refused: element [${elementId}] is a bot check (${label.trim().slice(0, 80)}). ScoutFox never clicks or solves bot checks or CAPTCHAs. Call finish now and tell the user the page is behind a bot check that a person has to pass.`;
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

/** The element lines of a list ("[3] button \"Buy\""), by id. */
function elementLinesById(elementsText: string): Map<number, string> {
  const lines = new Map<number, string>();
  for (const line of String(elementsText || '').split('\n')) {
    const match = line.match(/^\s*\[(\d+)\]/);
    if (match) lines.set(Number(match[1]), line);
  }
  return lines;
}

export class ScoutFoxMCPServer {
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

  // List available tools - returns the same definitions as SCOUTFOX_TOOLS
  async listTools(): Promise<any[]> {
    const { SCOUTFOX_TOOLS } = await import('./tools.ts');
    return SCOUTFOX_TOOLS;
  }

  // Execute a tool call
  async callTool(name: string, args: any): Promise<ToolOutcome> {
    if (!this.runtime) {
      return { text: 'Error: No active browser session', isError: true };
    }

    const tabId = this.runtime.tabs.activeTabId ?? this.runtime.tabs.ownerTabId;

    if (!tabId) {
      return { text: 'Error: No active tab', isError: true };
    }

    try {
      return await this.executeTool(name, args, tabId);
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
      case 'get_page_text': {
        const snapshot = await takeSnapshot(tabId, { showBadges: false, maxElements: 0 }, {
          isTabInScope: async () => true,
          sleep: (ms) => rt.clock.sleep(ms)
        });
        return { text: snapshot.pageText || '(page has no text)' };
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
        const snapshot = await takeSnapshot(tabId, { showBadges: false, maxElements: 100 }, {
          isTabInScope: async () => true,
          sleep: (ms) => rt.clock.sleep(ms)
        });
        this.elementLines.set(tabId, elementLinesById(snapshot.elementsText || ''));
        const matches = this.findElements(snapshot.elementsText || '', args.query);
        return { text: matches };
      }

      case 'read_page_text': {
        const scrolled = await this.run(tabId, { action: 'scroll', direction: 'down' }, rt);
        if (!scrolled.ok) return scrolled.result;
        await rt.clock.sleep(500);
        const snapshot = await takeSnapshot(tabId, { showBadges: false, maxElements: 0 }, {
          isTabInScope: async () => true,
          sleep: (ms) => rt.clock.sleep(ms)
        });
        return { text: snapshot.pageText || '(empty)' };
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
        return { text: `Clicked element [${args.element_id}]${args.reason ? `: ${args.reason}` : ''}${arrived}` };
      }

      case 'type': {
        const field = this.elementLines.get(tabId)?.get(Number(args.element_id)) || '';
        if (BOT_CHECK_PATTERN.test(field)) return { text: botCheckRefusal(args.element_id, field), isError: true };
        const outcome = await this.run(tabId, { action: 'type', element_id: args.element_id, text: args.text, submit: args.submit }, rt);
        if (!outcome.ok) return outcome.result;
        this.lastTyped.add(tabId);
        const arrived = outcome.exec?.effect === 'url_changed' ? await this.arrivedPageText(tabId, rt) : '';
        return { text: `Typed into element [${args.element_id}]${args.submit ? ' and pressed Enter' : ''}${args.reason ? `: ${args.reason}` : ''}${arrived}` };
      }

      case 'scroll': {
        const outcome = await this.run(tabId, { action: 'scroll', direction: args.direction }, rt);
        if (!outcome.ok) return outcome.result;
        return { text: `Scrolled ${args.direction}${args.reason ? `: ${args.reason}` : ''}` };
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
        return { text: `TASK_COMPLETE: ${args.answer}`, table: args.table };
      }

      case 'render_table': {
        if (!Array.isArray(args.columns) || !args.columns.every((c: any) => typeof c === 'string')) {
          return { text: 'Error: render_table needs columns as an array of strings.', isError: true };
        }
        if (!Array.isArray(args.rows) || !args.rows.every((r: any) => Array.isArray(r) && r.length === args.columns.length)) {
          return { text: 'Error: render_table needs rows as arrays, each row matching the column count.', isError: true };
        }
        return { text: `Table built: ${args.rows.length} row(s), ${args.columns.length} column(s).`, table: { columns: args.columns, rows: args.rows } };
      }

      default:
        return { text: `Unknown tool: ${name}`, isError: true };
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
        text: 'Error: this model cannot see pictures, so the screenshot was not taken. Use get_page_text instead.',
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
        text: `Captured the visible page (${shot.imageWidth}x${shot.imageHeight}, ${shot.mediaType}). ${how}`,
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
      return { text: `${why} Read the page text with get_page_text instead.`, isError: true };
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
  private async clickAtCoordinates(tabId: number, args: Record<string, any>, rt: RunRuntime): Promise<ToolOutcome> {
    // A page that keeps moving refuses every coordinate click, and the model would take another
    // screenshot and try again, forever. After two refusals in a row the coordinate path is
    // closed for this tab, and the model is told once which path still works.
    if (this.coordinatesClosed.has(tabId)) {
      return { text: COORDINATES_CLOSED_MESSAGE, isError: true };
    }
    const frame = this.frameFor(tabId);
    if (!frame) {
      return {
        text: 'Error: no screenshot has been taken for this tab yet. Take one before clicking by coordinates.',
        isError: true
      };
    }
    // The model's numbers in its own scale, as a pixel of the picture (see coordinates.ts).
    const read = toPicturePixels(this.coordinateSpace, Number(args.x), Number(args.y), { width: frame.imageWidth, height: frame.imageHeight });
    // The far edge of a 0-1000 scale (or a fraction of 1) is the last pixel row, not one past it.
    // Past the end of the scale stays outside the picture and is refused below.
    const scaleEnd = read.reading === 'fraction' ? 1 : 1000;
    const atEdge = (value: number, raw: number, size: number) => (read.reading !== 'pixels' && raw <= scaleEnd && value >= size ? size - 1 : value);
    const x = atEdge(read.x, Number(args.x), frame.imageWidth);
    const y = atEdge(read.y, Number(args.y), frame.imageHeight);
    if (!isInsideFrame(frame, x, y)) {
      const message = this.coordinateSpace === 'per-mille'
        ? `Error: (${Number(args.x)}, ${Number(args.y)}) is outside the picture. x and y are positions from 0 to 1000 of the picture (${frame.imageWidth}x${frame.imageHeight}), not pixels. If the page changed, take a new screenshot first.`
        : outOfFrameMessage(frame, Number(args.x), Number(args.y));
      return { text: message, isError: true };
    }

    // The page is re-read at click time, because a frame is only good while the page is the same.
    // It goes through the same deps the capture used, so the two are read the same way.
    const live = await this.readLiveState(tabId, rt, this.screenshotDepsFor(tabId));
    const check = checkFrame(frame, live);
    if (!check.ok) {
      this.refusalCount += 1;
      const reason = check.reason || 'Error: the screenshot is out of date. Take a new one.';
      if (this.refusalCount >= COORDINATE_REFUSAL_LIMIT) {
        this.coordinatesClosed.add(tabId);
        return { text: `${reason}\n${COORDINATES_CLOSED_MESSAGE}`, isError: true };
      }
      return { text: reason, isError: true };
    }

    let point = imageToViewport(frame, x, y);

    // What is actually at that pixel. A point just next to a control is moved onto it (the page
    // answers with `snapped`). A sensitive field refuses the click; anything else is described in
    // the result, so the user and the model both know what was hit.
    const described = await this.describePointOnPage(tabId, point);
    if (described.refused) {
      return { text: described.refused, isError: true };
    }
    if (described.snapped) point = { x: described.snapped.x, y: described.snapped.y };

    this.refusalCount = 0;
    const outcome = await this.run(tabId, { action: 'click_at', x: point.x, y: point.y }, rt);
    if (!outcome.ok) return outcome.result;
    this.lastTyped.delete(tabId);
    const arrived = outcome.exec?.effect === 'url_changed' ? await this.arrivedPageText(tabId, rt) : '';
    const where = `(${Number(args.x)}, ${Number(args.y)})${read.reading === 'pixels' ? ' in the picture' : read.reading === 'fraction' ? ' (a fraction of the picture)' : ' on the 0-1000 scale'}`;
    const snapped = described.snapped ? `, moved ${described.snapped.distance} px onto the control next to it` : '';
    const hit = described.what ? ` - ${described.what}${described.interactive ? '' : ', which is not a control'}` : '';
    return { text: `Clicked at ${where}${snapped}${hit}${args.reason ? `: ${args.reason}` : ''}${arrived}` };
  }

  /** The scale the model of this run points with on a picture. The client sets it every turn. */
  private coordinateSpace: CoordinateSpace = 'pixels';

  setCoordinateSpace(space: CoordinateSpace): void {
    this.coordinateSpace = space;
  }

  /** How many coordinate clicks in a row the frame refused. Two stops the coordinate path for the run. */
  private refusalCount = 0;
  /** The tabs whose coordinate path is closed for the rest of the run. */
  private coordinatesClosed = new Set<number>();

  get coordinateRefusals(): number {
    return this.refusalCount;
  }

  /** The live page state a frame is checked against. */
  private async readLiveState(tabId: number, rt: RunRuntime, deps: ScreenshotDeps): Promise<{
    url: string; viewportWidth: number; viewportHeight: number; devicePixelRatio: number;
    scrollX: number; scrollY: number; sig: { interactiveHash: string; textHash: string } | null;
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
          chrome.tabs.sendMessage(tabId, { action: 'DESCRIBE_POINT', payload: { ...point, snap: true } }, (resp) => {
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
      return `${head}\nPAGE TEXT (no need to call get_page_text for this page):\n${snapshot.pageText || '(page has no text)'}`;
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

  private findElements(elementsText: string, query: string): string {
    const ranked = rankElementLines(elementsText, query);
    return ranked.length > 0
      ? ranked.map((line) => `${line} | matches "${query}"`).join('\n')
      : `No elements found matching "${query}". Try get_page_elements to see all.`;
  }
}
