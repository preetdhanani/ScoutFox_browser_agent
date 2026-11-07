/**
 * The capture: src/background/browser/screenshot.ts.
 *
 * One capture is: the gate, the viewport probe, the UI hidden, a capture at scale 1, the size
 * MEASURED, a second capture only when the picture is over the budget, and the UI put back -
 * always, also when the capture threw.
 *
 * What these tests hold on to:
 *   1. A restricted page is refused with the same message the text read gives.
 *   2. An out-of-scope tab is refused, so a picture never leaves a tab the session may not read.
 *   3. A pinch-zoomed page is refused rather than photographed at a size nothing can trust.
 *   4. The scale of the second capture comes from the MEASURED size, not from a rule.
 *   5. A viewport already inside the budget is captured ONCE, and not resized.
 *   6. A picture whose shape does not match the viewport is refused.
 *   7. A missing page signature does not block the capture (the privacy covers do: see
 *      screenshotSafety.test.ts).
 *   8. The UI is put back after a failed capture, and after a successful one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ScreenshotError,
  WRONG_SHAPE_MESSAGE,
  ZOOMED_MESSAGE,
  captureScreenshot,
  shapeMatches,
  type ScreenshotDeps,
  type ScreenshotPagePort,
  type ViewportProbe
} from '../../src/background/browser/screenshot.ts';

/** The bytes of a JPEG whose header says w by h. */
function jpegBytes(w: number, h: number): number[] {
  return [
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (h >> 8) & 0xff, h & 0xff,
    (w >> 8) & 0xff, w & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xff, 0xd9
  ];
}

const jpeg = (w: number, h: number): string => Buffer.from(jpegBytes(w, h)).toString('base64');

/** A probe of a 1512 by 860 CSS pixel viewport on a retina display. */
function probe(overrides: Partial<ViewportProbe> = {}): ViewportProbe {
  return { width: 1512, height: 860, devicePixelRatio: 2, scrollX: 0, scrollY: 0, scale: 1, ...overrides };
}

/** A minimal page port: the probe is fixed, the signature answers, the UI calls are recorded. */
function pagePort(overrides: Partial<ScreenshotPagePort> = {}, state: { hideCalls: number; showCalls: number } = { hideCalls: 0, showCalls: 0 }): ScreenshotPagePort {
  return {
    tabUrl: async () => 'https://shop.example.com/cart',
    probe: async () => probe(),
    signature: async () => ({ interactiveHash: 'abc', textHash: 'def' }),
    hideUi: async () => {
      state.hideCalls += 1;
      return true;
    },
    showUi: async () => {
      state.showCalls += 1;
    },
    ...overrides
  };
}

/** A deps with a scripted CDP: each capture returns the next image, in order. */
function deps(options: {
  images?: string[];
  page?: ScreenshotPagePort;
  inScope?: boolean;
  url?: string | null;
  throwOn?: number;
} = {}): ScreenshotDeps & { commands: Array<{ method: string; params: any }> } {
  const images = options.images ?? [jpeg(3024, 1720)];
  const commands: Array<{ method: string; params: any }> = [];
  let captures = 0;
  return {
    commands,
    isTabInScope: async () => options.inScope ?? true,
    page: options.page ?? pagePort({ tabUrl: async () => options.url ?? 'https://shop.example.com/cart' }),
    sendCommand: async (_tabId, method, params) => {
      commands.push({ method, params });
      if (method !== 'Page.captureScreenshot') return {};
      const index = captures++;
      if (options.throwOn === index) throw new Error('renderer crashed');
      const image = images[Math.min(index, images.length - 1)];
      return { data: image };
    }
  };
}

test('a plain capture returns the picture, its measured size and the live viewport', async () => {
  const shot = await captureScreenshot(101, deps({ images: [jpeg(3024, 1720)] }));

  // The first capture is inside the budget only after a shrink, so the second one is 1456 wide.
  assert.equal(shot.mediaType, 'image/jpeg');
  assert.equal(shot.viewportWidth, 1512);
  assert.equal(shot.viewportHeight, 860);
  assert.equal(shot.devicePixelRatio, 2);
  assert.deepEqual(shot.sig, { interactiveHash: 'abc', textHash: 'def' });
  assert.ok(shot.imageWidth > 0 && shot.imageHeight > 0);
});

test('the scale of the second capture comes from the MEASURED size', async () => {
  const d = deps({ images: [jpeg(3024, 1720), jpeg(1456, 828)] });
  await captureScreenshot(101, d);

  const captures = d.commands.filter((c) => c.method === 'Page.captureScreenshot');
  assert.equal(captures.length, 2, 'a picture over the budget is captured twice');
  assert.equal(captures[0].params.clip.scale, 1, 'the first capture is at scale 1, to be measured');
  // 1456 is the largest aligned width that fits the token budget for a 3024 by 1720 picture.
  assert.equal(captures[0].params.clip.width, 1512, 'the clip is the viewport in CSS pixels');
  assert.equal(captures[0].params.clip.height, 860);
  assert.equal(captures[1].params.clip.scale, 1456 / 3024, 'the second scale is target / measured');
  assert.equal(captures[0].params.captureBeyondViewport, false, 'the picture is the viewport, not the page');
});

test('a viewport already inside the budget is captured once and not resized', async () => {
  const d = deps({ images: [jpeg(1280, 720)], page: pagePort({ probe: async () => probe({ width: 1280, height: 720, devicePixelRatio: 1 }) }) });
  const shot = await captureScreenshot(101, d);

  const captures = d.commands.filter((c) => c.method === 'Page.captureScreenshot');
  assert.equal(captures.length, 1, 'nothing to shrink, so no second capture');
  assert.equal(shot.imageWidth, 1280, 'the measured size is the picture, unchanged');
  assert.equal(shot.imageHeight, 720);
});

test('a restricted page is refused with the message the text read gives', async () => {
  await assert.rejects(
    () => captureScreenshot(101, deps({ url: 'chrome://settings' })),
    (err: any) => {
      assert.ok(err instanceof ScreenshotError);
      assert.match(err.message, /Chrome blocks all extensions/);
      return true;
    }
  );
});

test('a tab outside the scope wall is refused, so no picture leaves it', async () => {
  const d = deps({ inScope: false });
  await assert.rejects(
    () => captureScreenshot(101, d),
    (err: any) => {
      assert.match(err.message, /outside this session's Tarka group/);
      return true;
    }
  );
  assert.equal(d.commands.length, 0, 'nothing was captured');
});

test('a pinch-zoomed page is refused instead of photographed at an untrustworthy size', async () => {
  const d = deps({ page: pagePort({ probe: async () => probe({ scale: 1.5 }) }) });
  await assert.rejects(
    () => captureScreenshot(101, d),
    (err: any) => err.message === ZOOMED_MESSAGE
  );
  assert.equal(d.commands.filter((c) => c.method === 'Page.captureScreenshot').length, 0, 'nothing was captured');
});

test('a picture whose shape does not match the viewport is refused', async () => {
  // A 3024 by 3024 square picture of a 1512 by 860 viewport is not a picture of the viewport:
  // it is a picture of something else, and a coordinate in it cannot line up.
  await assert.rejects(
    () => captureScreenshot(101, deps({ images: [jpeg(3024, 3024)] })),
    (err: any) => err.message === WRONG_SHAPE_MESSAGE
  );
});

test('shapeMatches tolerates the rounding of a real capture and refuses a real difference', () => {
  assert.equal(shapeMatches({ width: 3024, height: 1720 }, { width: 1512, height: 860 }), true);
  assert.equal(shapeMatches({ width: 1456, height: 828 }, { width: 1512, height: 860 }), true);
  assert.equal(shapeMatches({ width: 1568, height: 892 }, { width: 1512, height: 860 }), true);
  // A 4:3 picture of a 16:10 viewport is not a rounding difference.
  assert.equal(shapeMatches({ width: 1920, height: 1440 }, { width: 1512, height: 860 }), false);
  // A square picture of a wide viewport is not one either.
  assert.equal(shapeMatches({ width: 3024, height: 3024 }, { width: 1512, height: 860 }), false);
  assert.equal(shapeMatches({ width: 0, height: 0 }, { width: 1512, height: 860 }), false);
});

test('a page without a signature is still captured', async () => {
  const state = { hideCalls: 0, showCalls: 0 };
  const d = deps({
    images: [jpeg(1280, 720)],
    page: pagePort({
      probe: async () => probe({ width: 1280, height: 720, devicePixelRatio: 1 }),
      signature: async () => null,
      hideUi: async () => {
        state.hideCalls += 1;
        return true;
      },
      showUi: async () => {
        state.showCalls += 1;
      }
    }, state)
  });
  const shot = await captureScreenshot(101, d);
  assert.equal(shot.sig, null, 'no signature is reported as none, not as a failure');
  assert.equal(shot.imageWidth, 1280);
});

test('the UI is hidden before the capture and put back after it', async () => {
  const order: string[] = [];
  const d = deps({
    images: [jpeg(1280, 720)],
    page: {
      tabUrl: async () => 'https://shop.example.com/cart',
      probe: async () => probe({ width: 1280, height: 720, devicePixelRatio: 1 }),
      signature: async () => null,
      hideUi: async () => {
        order.push('hide');
        return true;
      },
      showUi: async () => {
        order.push('show');
      }
    }
  });
  const original = d.sendCommand;
  d.sendCommand = async (...args) => {
    if (args[1] === 'Page.captureScreenshot') order.push('capture');
    return original(...args);
  };
  await captureScreenshot(101, d);
  assert.deepEqual(order, ['hide', 'capture', 'show']);
});

test('the UI is put back even when the capture throws', async () => {
  const order: string[] = [];
  const d = deps({
    throwOn: 0,
    page: {
      tabUrl: async () => 'https://shop.example.com/cart',
      probe: async () => probe({ width: 1280, height: 720, devicePixelRatio: 1 }),
      signature: async () => null,
      hideUi: async () => {
        order.push('hide');
        return true;
      },
      showUi: async () => {
        order.push('show');
      }
    }
  });
  await assert.rejects(() => captureScreenshot(101, d), /renderer crashed/);
  assert.deepEqual(order, ['hide', 'show'], 'the page is not left without its overlays');
});

test('a capture that comes back as something that is not an image is refused, not trusted', async () => {
  await assert.rejects(
    () => captureScreenshot(101, deps({ images: ['AAAA'] })),
    (err: any) => {
      assert.match(err.message, /could not be read/);
      return true;
    }
  );
});

test('an empty capture is refused with a message the model can act on', async () => {
  await assert.rejects(
    () => captureScreenshot(101, deps({ images: [''] })),
    (err: any) => {
      assert.match(err.message, /could not be photographed/);
      assert.match(err.message, /page text/i);
      return true;
    }
  );
});

test('a failed second capture keeps the first picture, which is valid, only larger', async () => {
  const d = deps({ images: [jpeg(3024, 1720)], throwOn: 1 });
  const shot = await captureScreenshot(101, d);
  assert.equal(shot.imageWidth, 3024, 'the first, measured picture is used');
  assert.equal(shot.imageHeight, 1720);
});
