// src/background/browser/screenshotFrame.ts
// The coordinate frame: the pixels a model's click coordinates are in.
//
// A vision model answers in the pixels of the picture it was given. If it looks at a 1568 by 892
// image it says (412, 288) meaning that image, never a 3024 by 1720 surface it has not seen.
// Asking the model to scale a coordinate in its head lands the click in the wrong place, so the
// image IS the frame, and this module maps a picture coordinate back to the live page:
//
//   viewportX = round(x * viewportWidth / imageWidth)
//   viewportY = round(y * viewportHeight / imageHeight)
//
// The device pixel ratio drops out. The picture is already in device pixels and the viewport is
// in CSS pixels, so the ratio between the two is the whole story, and there is no DPR factor
// left to get wrong.
//
// A frame is only good while the page still looks the way it did when the picture was taken.
// The check runs at click time against the live page rather than on a timer, so it cannot miss a
// change it looks for. See checkFrame.

import type { PageSig } from '../types.ts';
import type { ImageSize } from '../../shared/imageBudget.ts';

/** How far the page may scroll between the picture and the click and still be trusted. */
export const SCROLL_TOLERANCE_PX = 2;

/** The live page state a frame is measured against. */
export interface LivePageState {
  url: string;
  viewportWidth: number;
  viewportHeight: number;
  devicePixelRatio: number;
  scrollX: number;
  scrollY: number;
  /** The page signature (content/content.js getLightPageSignature), when the content script answered. */
  sig?: (Pick<PageSig, 'interactiveHash' | 'textHash'> & { layoutHash?: string }) | null;
}

/** The picture a frame describes, and the page state it was taken in. */
export interface CoordinateFrame extends LivePageState {
  imageWidth: number;
  imageHeight: number;
}

/** What the frame cannot be trusted for: an empty list means it is still good. */
export interface FrameCheck {
  ok: boolean;
  /** The refusal, worded for the model, or undefined when the frame is good. */
  reason?: string;
}

/** The refusal of a coordinate click whose picture shows controls that have moved since. */
export const FRAME_LAYOUT_CHANGED_MESSAGE =
  'Error: the controls on the page have moved since that screenshot, so the picture no longer shows where things are. Take a new screenshot, or click by element_id.';

/** The message a click gets when there is no picture to read a coordinate from. */
export const NO_FRAME_MESSAGE =
  'Error: no screenshot has been taken for this tab yet. Take one before clicking by coordinates.';

/**
 * The viewport CSS pixel a coordinate in the picture is. A coordinate outside the picture is
 * mapped anyway, so a caller can report it rather than silently clamp it to an edge; use
 * isInsideFrame first.
 */
export function imageToViewport(
  frame: Pick<CoordinateFrame, 'imageWidth' | 'imageHeight' | 'viewportWidth' | 'viewportHeight'>,
  x: number,
  y: number
): { x: number; y: number } {
  const scaleX = frame.imageWidth > 0 ? frame.viewportWidth / frame.imageWidth : 1;
  const scaleY = frame.imageHeight > 0 ? frame.viewportHeight / frame.imageHeight : 1;
  return { x: Math.round(x * scaleX), y: Math.round(y * scaleY) };
}

/** Whether a coordinate is a pixel in the picture the model was given. */
export function isInsideFrame(
  frame: Pick<CoordinateFrame, 'imageWidth' | 'imageHeight'>,
  x: number,
  y: number
): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return x >= 0 && y >= 0 && x < frame.imageWidth && y < frame.imageHeight;
}

/** The refusal for a coordinate outside the picture. It names the picture so the model can see the frame. */
export function outOfFrameMessage(
  frame: Pick<CoordinateFrame, 'imageWidth' | 'imageHeight'>,
  x: number,
  y: number
): string {
  const at = `(${Math.round(x)}, ${Math.round(y)})`;
  const size = `${frame.imageWidth}x${frame.imageHeight}`;
  return `Error: coordinate ${at} is outside the picture (${size}). Coordinates are pixels in the picture you were given. If the page or window changed, take a new screenshot first.`;
}

/**
 * Whether the frame still describes the live page, and if not, why, in words the model can act
 * on. Every refusal ends with "take a new screenshot", because that is the one fix for all of
 * them.
 *
 * The comparison order is deliberate: a different page makes every other difference a
 * consequence, so the URL is checked first and reports the real cause rather than "the page
 * changed".
 *
 * A scroll of up to SCROLL_TOLERANCE_PX is not a refusal: lazy images, scroll anchoring and
 * smooth scrolling move a page a few pixels on their own, and refusing those would send the
 * model into a screenshot loop that never ends.
 */
export function checkFrame(frame: CoordinateFrame | null | undefined, live: LivePageState): FrameCheck {
  if (!frame) return { ok: false, reason: NO_FRAME_MESSAGE };

  if (frame.url !== live.url) {
    return { ok: false, reason: 'Error: the page has navigated since that screenshot, so the coordinates in it no longer describe this page. Take a new screenshot.' };
  }
  if (frame.viewportWidth !== live.viewportWidth || frame.viewportHeight !== live.viewportHeight) {
    return { ok: false, reason: 'Error: the window has been resized since that screenshot, so the picture no longer covers this viewport. Take a new screenshot.' };
  }
  if (frame.devicePixelRatio !== live.devicePixelRatio) {
    return { ok: false, reason: 'Error: the display has changed since that screenshot, so the picture is in a different pixel grid. Take a new screenshot.' };
  }
  const dx = Math.abs(frame.scrollX - live.scrollX);
  const dy = Math.abs(frame.scrollY - live.scrollY);
  if (dx > SCROLL_TOLERANCE_PX || dy > SCROLL_TOLERANCE_PX) {
    return { ok: false, reason: 'Error: the page has scrolled since that screenshot, so the same pixel now points at different content. Take a new screenshot.' };
  }
  // Only the layout is compared: where the controls in the viewport are, never what they say. A
  // coordinate click hits a box, so text that changes in place (a kernel status, a clock, a
  // ticker) does not make the picture wrong, and refusing on it sent the model into a screenshot
  // loop on every live page. Compared only when both sides have it: a content script that cannot
  // answer is not evidence that the page changed.
  const frameLayout = frame.sig?.layoutHash;
  const liveLayout = live.sig?.layoutHash;
  if (frameLayout && liveLayout && frameLayout !== liveLayout) {
    return { ok: false, reason: FRAME_LAYOUT_CHANGED_MESSAGE };
  }
  return { ok: true };
}

/** The frame from a capture, and the picture's measured size. */
export function makeFrame(live: LivePageState, image: ImageSize): CoordinateFrame {
  return {
    url: live.url,
    viewportWidth: live.viewportWidth,
    viewportHeight: live.viewportHeight,
    devicePixelRatio: live.devicePixelRatio,
    scrollX: live.scrollX,
    scrollY: live.scrollY,
    sig: live.sig ?? null,
    imageWidth: image.width,
    imageHeight: image.height
  };
}
