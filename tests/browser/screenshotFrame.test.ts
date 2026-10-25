/**
 * The coordinate frame: src/background/browser/screenshotFrame.ts.
 *
 * A vision model answers in the pixels of the picture it was given. The frame is that picture,
 * and this module maps a coordinate in it back to the live page and decides whether the frame is
 * still true.
 *
 * The two failures this file exists to catch:
 *   1. A coordinate in the picture is scaled as if it were a page pixel. At a device pixel ratio
 *      of 2, that lands the click at twice the distance from the top left.
 *   2. A click lands on a frame the page has moved out from under. The pixels are stale, and the
 *      click goes somewhere the model never saw.
 *
 * What these tests hold on to:
 *   1. A coordinate maps by the ratio between the picture and the viewport, and the device pixel
 *      ratio never appears in the formula.
 *   2. A coordinate outside the picture is refused, with a message that names the picture.
 *   3. A changed URL, viewport, display or scroll refuses the frame with the reason that changed.
 *   4. A two-pixel scroll shift is NOT a refusal: pages move on their own.
 *   5. A changed page signature is refused, and a missing signature is not evidence of change.
 *   6. No frame at all is refused with the message that says to take one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NO_FRAME_MESSAGE,
  SCROLL_TOLERANCE_PX,
  checkFrame,
  imageToViewport,
  isInsideFrame,
  makeFrame,
  outOfFrameMessage,
  type CoordinateFrame,
  type LivePageState
} from '../../src/background/browser/screenshotFrame.ts';

/** A frame of a 1512 by 860 CSS pixel viewport, captured on a retina display into 3024 by 1720. */
function retinaFrame(overrides: Partial<CoordinateFrame> = {}): CoordinateFrame {
  return {
    url: 'https://shop.example.com/cart',
    viewportWidth: 1512,
    viewportHeight: 860,
    devicePixelRatio: 2,
    scrollX: 0,
    scrollY: 0,
    sig: { interactiveHash: 'abc123', textHash: 'def456' },
    imageWidth: 3024,
    imageHeight: 1720,
    ...overrides
  };
}

/** The same page, live, with nothing changed. */
function live(overrides: Partial<LivePageState> = {}): LivePageState {
  return {
    url: 'https://shop.example.com/cart',
    viewportWidth: 1512,
    viewportHeight: 860,
    devicePixelRatio: 2,
    scrollX: 0,
    scrollY: 0,
    sig: { interactiveHash: 'abc123', textHash: 'def456' },
    ...overrides
  };
}

test('a coordinate in the picture maps to the viewport by the ratio of the two, with no DPR term', () => {
  const frame = retinaFrame();
  // 1200 in a 3024 pixel picture of a 1512 pixel viewport is 600 in the viewport.
  assert.deepEqual(imageToViewport(frame, 1200, 400), { x: 600, y: 200 });
  // The same picture at a DPR of 1 would be 1512 wide, and the same 1200 would be 1200.
  assert.deepEqual(imageToViewport({ ...frame, imageWidth: 1512, imageHeight: 860 }, 1200, 400), { x: 1200, y: 400 });
  // And the device pixel ratio itself is not read: the same numbers give the same answer with
  // any DPR, because the ratio between the picture and the viewport already contains it.
  assert.deepEqual(imageToViewport(retinaFrame({ devicePixelRatio: 3 }), 1200, 400), { x: 600, y: 200 });
});

test('a scaled-down picture maps a coordinate back to the viewport the model never saw', () => {
  // The budget shrank a 3024 by 1720 capture to 1456 by 828. The model read a coordinate off
  // the 1456 picture, and the click has to land in the 1512 CSS pixel viewport.
  const frame = retinaFrame({ imageWidth: 1456, imageHeight: 828 });
  const point = imageToViewport(frame, 728, 414);
  // The middle of the picture is the middle of the viewport, whatever the DPR was.
  assert.deepEqual(point, { x: 756, y: 430 });
});

test('the top left maps to the top left, and the last pixel inside the frame maps inside the viewport', () => {
  const frame = retinaFrame({ imageWidth: 1456, imageHeight: 828 });
  assert.deepEqual(imageToViewport(frame, 0, 0), { x: 0, y: 0 });
  const last = imageToViewport(frame, 1455, 827);
  assert.ok(last.x < frame.viewportWidth && last.y < frame.viewportHeight, `${JSON.stringify(last)} must be inside`);
});

test('a coordinate inside the picture is inside, and one on or past the edge is not', () => {
  const frame = retinaFrame({ imageWidth: 1568, imageHeight: 892 });
  assert.equal(isInsideFrame(frame, 0, 0), true);
  assert.equal(isInsideFrame(frame, 1567, 891), true);
  assert.equal(isInsideFrame(frame, 1568, 400), false, 'the width itself is one past the last pixel');
  assert.equal(isInsideFrame(frame, 400, 892), false);
  assert.equal(isInsideFrame(frame, -1, 400), false);
  assert.equal(isInsideFrame(frame, Number.NaN, 400), false);
});

test('the out-of-frame refusal names both the coordinate and the picture', () => {
  const message = outOfFrameMessage({ imageWidth: 1568, imageHeight: 892 }, 642, 1180);
  assert.match(message, /\(642, 1180\)/);
  assert.match(message, /1568x892/);
  assert.match(message, /take a new screenshot/i);
});

test('no frame at all is refused with the message that says to take one', () => {
  const result = checkFrame(null, live());
  assert.equal(result.ok, false);
  assert.equal(result.reason, NO_FRAME_MESSAGE);
  // The same message covers a restarted worker, so it must not blame a cause the model cannot know.
  assert.match(NO_FRAME_MESSAGE, /no screenshot has been taken/i);
  assert.match(NO_FRAME_MESSAGE, /Take one/i);
});

test('an unchanged page keeps the frame good', () => {
  assert.deepEqual(checkFrame(retinaFrame(), live()), { ok: true });
});

test('a changed URL refuses the frame and names the navigation', () => {
  const result = checkFrame(retinaFrame(), live({ url: 'https://shop.example.com/checkout' }));
  assert.equal(result.ok, false);
  assert.match(result.reason!, /navigated/);
  assert.match(result.reason!, /take a new screenshot/i);
});

test('a resized window refuses the frame and says so', () => {
  const result = checkFrame(retinaFrame(), live({ viewportHeight: 900 }));
  assert.equal(result.ok, false);
  assert.match(result.reason!, /resized/);
});

test('a changed device pixel ratio refuses the frame: the pixel grid is different', () => {
  const result = checkFrame(retinaFrame(), live({ devicePixelRatio: 1 }));
  assert.equal(result.ok, false);
  assert.match(result.reason!, /display has changed/);
});

test('a real scroll refuses the frame, because the same pixel now holds different content', () => {
  const result = checkFrame(retinaFrame(), live({ scrollY: 400 }));
  assert.equal(result.ok, false);
  assert.match(result.reason!, /scrolled/);
});

test('a small scroll is tolerated, because pages move on their own', () => {
  // Lazy images, scroll anchoring and smooth scrolling shift a page by a few pixels without
  // anyone touching it. Refusing those would send the model into a screenshot loop.
  assert.deepEqual(checkFrame(retinaFrame(), live({ scrollY: SCROLL_TOLERANCE_PX })), { ok: true });
  assert.deepEqual(checkFrame(retinaFrame(), live({ scrollY: -SCROLL_TOLERANCE_PX })), { ok: true });
  assert.deepEqual(checkFrame(retinaFrame(), live({ scrollX: 1, scrollY: 2 })), { ok: true });
  // One pixel past the tolerance is a refusal.
  assert.equal(checkFrame(retinaFrame(), live({ scrollY: SCROLL_TOLERANCE_PX + 1 })).ok, false);
  assert.equal(SCROLL_TOLERANCE_PX, 2, 'the tolerance is two CSS pixels');
});

test('a changed page signature refuses the frame: the picture no longer shows what is there', () => {
  for (const sig of [{ interactiveHash: 'zzz', textHash: 'def456' }, { interactiveHash: 'abc123', textHash: 'zzz' }]) {
    const result = checkFrame(retinaFrame(), live({ sig }));
    assert.equal(result.ok, false);
    assert.match(result.reason!, /page has changed/);
  }
});

test('a page that cannot report a signature is not treated as changed', () => {
  // A missing content script is not evidence that anything changed. Refusing on it would make
  // the feature unusable on a page the extension cannot inject into.
  assert.deepEqual(checkFrame(retinaFrame(), live({ sig: null })), { ok: true });
  assert.deepEqual(checkFrame(retinaFrame({ sig: null }), live()), { ok: true });
});

test('the URL is checked before the rest, so the reason names the real cause', () => {
  // A navigation changes the scroll, the signature and often the viewport too. Reporting "the
  // page has scrolled" would send the model looking for the wrong thing.
  const result = checkFrame(retinaFrame(), live({
    url: 'https://shop.example.com/other',
    scrollY: 900,
    sig: { interactiveHash: 'x', textHash: 'y' }
  }));
  assert.match(result.reason!, /navigated/);
});

test('a frame is made from the live page and the measured picture', () => {
  const state = live({ scrollY: 120, scrollX: 5 });
  const frame = makeFrame(state, { width: 1456, height: 828 });
  assert.deepEqual(frame, {
    url: state.url,
    viewportWidth: 1512,
    viewportHeight: 860,
    devicePixelRatio: 2,
    scrollX: 5,
    scrollY: 120,
    sig: { interactiveHash: 'abc123', textHash: 'def456' },
    imageWidth: 1456,
    imageHeight: 828
  });
  assert.deepEqual(checkFrame(frame, state), { ok: true });
});
