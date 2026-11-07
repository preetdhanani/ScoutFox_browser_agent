// src/background/browser/screenshot.ts
// The capture: a picture of the visible viewport, small enough to send to a model.
//
// The model sees the page as text today. A picture tells it what text cannot: that a control is
// disabled, that a banner covers the page, how a chart looks, where a target with no text is.
//
// The shape of one capture, in order:
//   1. The same gate every other read goes through (restricted URL, scope wall).
//   2. Attach the debugger, THEN probe the live viewport, in CSS pixels, and the page signature.
//   3. Refuse a pinch-zoomed page: the picture and the viewport would describe different areas.
//   4. Hide the extension's own badges and cursor and put up the privacy covers. A page that
//      cannot confirm the covers is not photographed at all (fail closed).
//   5. Capture once at scale 1, and MEASURE what came back.
//   6. If it is over the token budget, capture again at the scale the measurement says.
//   7. Put the UI back, always.
//
// Why the size is measured and not computed: CDP's clip scale and the device pixel ratio do not
// combine the way the schema's wording suggests, and a size wrong by a factor of two makes every
// coordinate read off the picture land in the wrong place. The measurement is what the frame and
// the budget use, so the arithmetic is derived from what the browser did.
//
// What is NOT checked, and why: the measured size is not compared against
// viewportWidth * devicePixelRatio. That product is exactly the thing this module refuses to
// assume, so refusing when it differs would break the one case the measurement exists for (a
// renderer that ignores the ratio). What is checked is the SHAPE: a picture whose aspect ratio is
// materially different from the viewport's is not a picture of the viewport, and a coordinate in
// it cannot line up with the page. That is the check that can actually be wrong.

import { describeRestrictedUrl } from './tabs.ts';
import { TOP_FRAME, frameMasksHold, maskEmbeddedFrames, unmaskEmbeddedFrames, type FrameMasks } from './frames.ts';
import { decodeImageSize } from './imageSize.ts';
import { fitToBudget, scaleForTarget, type ImageSize } from '../../shared/imageBudget.ts';
import type { PageSig } from '../types.ts';

/** How far the picture's shape may differ from the viewport's before the capture is refused. */
const ASPECT_TOLERANCE = 0.02;

/** One viewport, as the page reports it. All sizes are CSS pixels except devicePixelRatio. */
export interface ViewportProbe {
  width: number;
  height: number;
  devicePixelRatio: number;
  scrollX: number;
  scrollY: number;
  /** visualViewport.scale: 1 unless the page is pinch-zoomed. */
  scale: number;
}

/** The page state a frame needs from the content script. */
export interface PageSignature {
  interactiveHash: string;
  textHash: string;
  /** Where the controls in the viewport are, without their text: what a coordinate click relies on. */
  layoutHash?: string;
}

/** Everything the capture reads from the page, so a test can stand in for Chrome. */
export interface ScreenshotPagePort {
  /** The tab's URL, or null when the tab cannot be read. */
  tabUrl(tabId: number): Promise<string | null>;
  /** innerWidth, innerHeight, the device pixel ratio, the scroll offset and the zoom. */
  probe(tabId: number): Promise<ViewportProbe>;
  /** The page signature, or null when no content script answers. */
  signature(tabId: number): Promise<PageSignature | null>;
  /**
   * Hide the badges and the cursor overlay and put up the privacy covers over password, card and
   * OTP fields. It never throws. Resolves true only when the page confirmed the covers are up;
   * false refuses the capture. (A stand-in port that resolves nothing does not report either way.)
   */
  hideUi(tabId: number): Promise<boolean>;
  /**
   * After the capture: the covers are still up in the top page and in every embedded frame shown
   * uncovered, in the same documents, and nothing appeared that needed one. False throws the picture
   * away. (A stand-in port without it is not checked.)
   */
  verifyUi?(tabId: number): Promise<boolean>;
  /** Put the badges and the cursor overlay back, and take the covers down. Best effort: it never throws. */
  showUi(tabId: number): Promise<void>;
}

export interface ScreenshotDeps {
  /** The scope wall: a tab outside this session's group is not photographed. */
  isTabInScope(tabId: number): Promise<boolean>;
  sendCommand(
    tabId: number,
    method: string,
    params: Record<string, unknown>,
    control?: { signal?: AbortSignal; stopRequested?: boolean; pauseRequested?: boolean }
  ): Promise<any>;
  page: ScreenshotPagePort;
}

/** One picture of the page, with the frame its coordinates are in. */
export interface ScreenshotShot {
  /** The image, base64, no data: prefix. */
  base64: string;
  mediaType: 'image/jpeg' | 'image/png';
  /** The size of the picture the model sees, in its own pixels. MEASURED, never assumed. */
  imageWidth: number;
  imageHeight: number;
  /** The live viewport in CSS pixels, which is what a mouse event takes. */
  viewportWidth: number;
  viewportHeight: number;
  devicePixelRatio: number;
  scrollX: number;
  scrollY: number;
  /** The page signature at capture time, for the staleness check. */
  sig: PageSignature | null;
}

/** A refusal whose message is written for the model to read and act on. */
export class ScreenshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScreenshotError';
  }
}

/** The refusal a pinch-zoomed page gets. */
export const ZOOMED_MESSAGE =
  'Error: the page is zoomed, so a screenshot would not line up with the coordinates. Reset the zoom to 100% and try again.';

/** The refusal a page that could not confirm its privacy covers gets. */
export const UNMASKED_MESSAGE =
  'Error: this page cannot be photographed safely, because the covers over password, card and one-time-code fields could not be put up. Read the page text instead.';

/** The refusal a picture gets when the covers did not hold until it was taken. */
export const MASKS_CHANGED_MESSAGE =
  'Error: the page changed while it was photographed (a frame navigated or a new field or frame appeared), so the picture was thrown away. Take the screenshot again.';

/** The refusal a picture of the wrong shape gets. */
export const WRONG_SHAPE_MESSAGE =
  'Error: the page was captured at an unexpected shape, so a coordinate in the picture would not line up with the page. Take a new screenshot.';

/**
 * Sends one message to the content script and resolves its answer, or null when it does not
 * answer. The signature is best effort (a page without one is still photographed); the privacy
 * covers are not, so hideUi turns a missing answer into a refusal.
 */
async function askContentScript(tabId: number, message: unknown): Promise<any> {
  if (typeof chrome === 'undefined' || !chrome.tabs?.sendMessage) return null;
  try {
    // The callback form is used on purpose: it is the one shape that reports a dead channel
    // through lastError instead of rejecting the caller.
    return await new Promise<any>((resolve) => {
      try {
        chrome.tabs.sendMessage(tabId, message, TOP_FRAME, (response) => {
          resolve(chrome.runtime?.lastError ? null : response ?? null);
        });
      } catch (_) {
        resolve(null);
      }
    });
  } catch (_) {
    return null;
  }
}

/** The embedded frames that put up covers for the capture in progress, per tab. */
const frameMasks = new Map<number, FrameMasks>();

/**
 * The real page port: chrome.scripting for the probe, the content script for the signature and
 * the UI, chrome.tabs for the URL.
 */
export function chromePagePort(): ScreenshotPagePort {
  return {
    async tabUrl(tabId: number): Promise<string | null> {
      if (typeof chrome === 'undefined' || !chrome.tabs?.get) return null;
      try {
        return await new Promise<string | null>((resolve) => {
          try {
            chrome.tabs.get(tabId, (tab) => resolve(chrome.runtime?.lastError ? null : tab?.url ?? null));
          } catch (_) {
            resolve(null);
          }
        });
      } catch (_) {
        return null;
      }
    },

    async probe(tabId: number): Promise<ViewportProbe> {
      if (typeof chrome === 'undefined' || !chrome.scripting?.executeScript) {
        throw new ScreenshotError('Error: this browser does not allow reading the page size, so a screenshot cannot be taken. Use get_page_text instead.');
      }
      // The probe is INLINE on purpose: a func sent to the page is serialized as its source text
      // and runs where none of the bundle exists, so the build's check requires it to be an
      // inline function that uses only its own names and page globals. It reads them off
      // globalThis because this file compiles for the worker, where there is no `window` name.
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const page = globalThis as any;
          const view = page.visualViewport;
          return {
            width: page.innerWidth,
            height: page.innerHeight,
            devicePixelRatio: page.devicePixelRatio || 1,
            scrollX: page.scrollX || 0,
            scrollY: page.scrollY || 0,
            scale: view && typeof view.scale === 'number' ? view.scale : 1
          };
        }
      });
      const value = results?.[0]?.result as ViewportProbe | undefined;
      if (!value || !Number.isFinite(value.width) || value.width <= 0 || !Number.isFinite(value.height) || value.height <= 0) {
        throw new ScreenshotError('Error: the size of the page could not be read, so a screenshot cannot be taken. Read the page text instead.');
      }
      return value;
    },

    async signature(tabId: number): Promise<PageSignature | null> {
      const resp = await askContentScript(tabId, { action: 'GET_PAGE_SIG' });
      const sig = resp?.success ? resp.data : null;
      if (!sig || typeof sig.interactiveHash !== 'string' || typeof sig.textHash !== 'string') return null;
      return {
        interactiveHash: sig.interactiveHash,
        textHash: sig.textHash,
        ...(typeof sig.layoutHash === 'string' ? { layoutHash: sig.layoutHash } : {})
      };
    },

    async hideUi(tabId: number): Promise<boolean> {
      // The embedded frames first, deepest first: an iframe of the top page is shown only when its
      // own agent confirmed its covers; every other one the top page covers whole.
      const masks = await maskEmbeddedFrames(tabId).catch((): FrameMasks => ({ shownFramePaths: [], masked: [] }));
      frameMasks.set(tabId, masks);
      // Only an explicit success counts: no answer means no content script, so no covers.
      const resp = await askContentScript(tabId, { action: 'HIDE_AGENT_UI', payload: { shownFramePaths: masks.shownFramePaths } });
      return resp?.success === true;
    },

    async verifyUi(tabId: number): Promise<boolean> {
      const top = await askContentScript(tabId, { action: 'CHECK_AGENT_UI' });
      if (top?.success !== true) return false;
      const masks = frameMasks.get(tabId);
      return masks ? await frameMasksHold(tabId, masks).catch(() => false) : true;
    },

    async showUi(tabId: number): Promise<void> {
      await askContentScript(tabId, { action: 'SHOW_AGENT_UI' });
      const masks = frameMasks.get(tabId);
      frameMasks.delete(tabId);
      if (masks) await unmaskEmbeddedFrames(tabId, masks).catch(() => undefined);
    }
  };
}

/** Whether the picture's shape is close enough to the viewport's that a pixel maps onto it. */
export function shapeMatches(image: ImageSize, viewport: { width: number; height: number }): boolean {
  if (image.width <= 0 || image.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return false;
  const imageRatio = image.width / image.height;
  const viewportRatio = viewport.width / viewport.height;
  return Math.abs(imageRatio - viewportRatio) / viewportRatio <= ASPECT_TOLERANCE;
}

/** The media type a capture format maps to. */
function mediaTypeFor(format: 'jpeg' | 'png'): 'image/jpeg' | 'image/png' {
  return format === 'png' ? 'image/png' : 'image/jpeg';
}

/** One capture, at the given scale, with the viewport as the clip. Returns the bytes and the measured size. */
async function captureOnce(
  tabId: number,
  deps: ScreenshotDeps,
  probe: ViewportProbe,
  scale: number,
  format: 'jpeg' | 'png'
): Promise<{ base64: string; size: ImageSize }> {
  const params: Record<string, unknown> = {
    format,
    captureBeyondViewport: false,
    fromSurface: true,
    clip: {
      x: probe.scrollX,
      y: probe.scrollY,
      width: probe.width,
      height: probe.height,
      scale
    }
  };
  if (format === 'jpeg') params.quality = 80;

  const result = await deps.sendCommand(tabId, 'Page.captureScreenshot', params);
  const base64 = typeof result?.data === 'string' ? result.data : '';
  if (!base64) {
    throw new ScreenshotError('Error: the page could not be photographed. Read the page text instead.');
  }
  const size = decodeImageSize(base64);
  if (!size) {
    throw new ScreenshotError('Error: the page was photographed but the picture could not be read, so its coordinates would not be trustworthy. Try again, or read the page text instead.');
  }
  return { base64, size };
}

/**
 * Captures the visible viewport of a tab.
 *
 * Throws a ScreenshotError for every refusal, with a message written for the model: a restricted
 * page, an out-of-scope tab, a zoomed page, a picture of the wrong shape, a CDP failure.
 */
export async function captureScreenshot(tabId: number, deps: ScreenshotDeps): Promise<ScreenshotShot> {
  if (!tabId || typeof tabId !== 'number') {
    throw new ScreenshotError('Error: no tab was selected for the task, so there is nothing to photograph.');
  }

  // 1. The same gates every read goes through.
  let inScope = true;
  try {
    inScope = await deps.isTabInScope(tabId);
  } catch (_) {
    inScope = false;
  }
  if (!inScope) {
    throw new ScreenshotError(
      `Error: tab [${tabId}] is outside this session's Tarka group, so it cannot be photographed from here.`
    );
  }
  const url = await deps.page.tabUrl(tabId);
  const restriction = describeRestrictedUrl(url);
  if (restriction) throw new ScreenshotError(`Error: ${restriction}`);

  // 2. The debugger first, then the live viewport and the page signature. Attaching shows
  // Chrome's "is debugging this browser" bar, which takes height off the viewport; a probe from
  // before it is a stale frame, and the next coordinate click would be refused as a resized
  // window. sendCommand attaches on first use (and waits for the bar to settle), so a cheap
  // command here is the attach.
  await deps.sendCommand(tabId, 'Page.getLayoutMetrics', {});
  const probe = await deps.page.probe(tabId);

  // 3. A zoomed page puts the picture and the viewport in different places, in a way nothing
  // downstream can detect. Refusing is honest; a screenshot is not worth a click in the wrong spot.
  if (Number.isFinite(probe.scale) && Math.abs(probe.scale - 1) > 0.001) {
    throw new ScreenshotError(ZOOMED_MESSAGE);
  }

  const sig = await deps.page.signature(tabId);

  // 4. The extension's own UI must not be in the picture, and the fields the text path refuses
  // to read must be covered. A page that cannot confirm the covers (no content script, the mask
  // walk threw) is refused: a picture without them would send a password as pixels.
  try {
    const masked = await deps.page.hideUi(tabId);
    if (masked !== true) throw new ScreenshotError(UNMASKED_MESSAGE);

    // 5. One capture at scale 1, then measure it.
    const first = await captureOnce(tabId, deps, probe, 1, 'jpeg');
    if (!shapeMatches(first.size, probe)) throw new ScreenshotError(WRONG_SHAPE_MESSAGE);

    // 6. The picture that fits the token budget. A viewport already inside it is left alone, so
    // the common case is one capture and not a pixel thrown away.
    const target = fitToBudget(first.size.width, first.size.height);
    let shot = first;
    if (target.width > 0 && target.height > 0 && (target.width !== first.size.width || target.height !== first.size.height)) {
      // The scale comes from the MEASURED size, so it is the ratio between what came out and what
      // should have. A second capture that fails keeps the first: it is a valid picture, only larger.
      const scale = scaleForTarget(target, first.size);
      try {
        const second = await captureOnce(tabId, deps, probe, scale, 'jpeg');
        if (shapeMatches(second.size, probe)) shot = second;
      } catch (_) {
        shot = first;
      }
    }

    // 7. The covers must have held until the picture was taken: a frame that navigated, or a field or
    // frame that appeared after the walk, was in the picture with no cover.
    if (deps.page.verifyUi && (await deps.page.verifyUi(tabId)) !== true) throw new ScreenshotError(MASKS_CHANGED_MESSAGE);

    return {
      base64: shot.base64,
      mediaType: 'image/jpeg',
      imageWidth: shot.size.width,
      imageHeight: shot.size.height,
      viewportWidth: probe.width,
      viewportHeight: probe.height,
      devicePixelRatio: probe.devicePixelRatio,
      scrollX: probe.scrollX,
      scrollY: probe.scrollY,
      sig
    };
  } finally {
    // 8. Always put the UI back, also when the capture threw.
    await deps.page.showUi(tabId);
  }
}
