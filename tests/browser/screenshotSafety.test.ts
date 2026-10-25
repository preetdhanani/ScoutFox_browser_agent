/**
 * The capture fails closed on privacy, and probes the viewport only after the debugger is on.
 *
 *   1. When the page cannot confirm the privacy covers are up (no content script, the mask walk
 *      threw), no picture is taken: a password field would leave as pixels.
 *   2. The viewport is probed AFTER the debugger is attached. Attaching shows Chrome's
 *      "is debugging this browser" bar, which shrinks innerHeight; a probe from before it is a
 *      stale frame, and the next coordinate click would be refused as a resized window.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { captureScreenshot, chromePagePort, type ScreenshotDeps, type ViewportProbe } from '../../src/background/browser/screenshot.ts';
import { fakeChrome } from '../helpers/fakeChrome.ts';

const jpeg = (w: number, h: number): string =>
  Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08,
    (h >> 8) & 0xff, h & 0xff, (w >> 8) & 0xff, w & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9
  ]).toString('base64');

function deps(opts: { hide: () => Promise<boolean>; order?: string[] }): ScreenshotDeps & { captures: number } {
  const order = opts.order ?? [];
  const d = {
    captures: 0,
    isTabInScope: async () => true,
    sendCommand: async (_t: number, method: string) => {
      if (method !== 'Page.captureScreenshot') return {};
      d.captures += 1;
      return { data: jpeg(1280, 720) };
    },
    page: {
      tabUrl: async () => 'https://shop.example.com/login',
      probe: async (): Promise<ViewportProbe> => ({ width: 1280, height: 720, devicePixelRatio: 1, scrollX: 0, scrollY: 0, scale: 1 }),
      signature: async () => null,
      hideUi: async () => {
        order.push('hide');
        return opts.hide();
      },
      showUi: async () => {
        order.push('show');
      }
    }
  };
  return d;
}

test('a page that cannot confirm the privacy covers is not photographed', async () => {
  const order: string[] = [];
  const d = deps({ hide: async () => false, order });
  await assert.rejects(
    () => captureScreenshot(101, d),
    (err: any) => {
      assert.equal(err.name, 'ScreenshotError');
      assert.match(err.message, /cannot be photographed safely/);
      assert.match(err.message, /page text/i);
      return true;
    }
  );
  assert.equal(d.captures, 0, 'no picture was taken');
  assert.deepEqual(order, ['hide', 'show'], 'whatever was hidden is put back');
});

test('a page that confirms the covers is photographed', async () => {
  const d = deps({ hide: async () => true });
  const shot = await captureScreenshot(101, d);
  assert.equal(shot.imageWidth, 1280);
  assert.equal(d.captures, 1);
});

test('the real page port reports no confirmation when no content script answers', async () => {
  // dom is declared but tab 101 has no content script: the message finds no receiver.
  const fc = fakeChrome({ tabs: { list: [{ id: 101, url: 'https://shop.example.com/login' }] }, runtime: true, dom: {} });
  (globalThis as any).chrome = fc.chrome;
  assert.equal(await chromePagePort().hideUi(101), false);
});

test('the real page port reports no confirmation when the content script says it failed', async () => {
  const fc = fakeChrome({
    tabs: { list: [{ id: 101, url: 'https://shop.example.com/login' }] },
    runtime: true,
    dom: { 101: { HIDE_AGENT_UI: () => ({ success: false, error: 'executor not loaded' }) } }
  });
  (globalThis as any).chrome = fc.chrome;
  assert.equal(await chromePagePort().hideUi(101), false);
});

test('the real page port confirms when the content script says the covers are up', async () => {
  const fc = fakeChrome({
    tabs: { list: [{ id: 101, url: 'https://shop.example.com/login' }] },
    runtime: true,
    dom: { 101: { HIDE_AGENT_UI: () => ({ success: true }) } }
  });
  (globalThis as any).chrome = fc.chrome;
  assert.equal(await chromePagePort().hideUi(101), true);
});

test('the viewport is probed after the debugger is attached, so the frame is not stale', async () => {
  // The debugger bar appears on attach and takes 40 CSS pixels off the viewport height.
  let attached = false;
  const d: ScreenshotDeps = {
    isTabInScope: async () => true,
    sendCommand: async (_t, method) => {
      attached = true; // the real sendCommand attaches the debugger on first use
      if (method !== 'Page.captureScreenshot') return {};
      return { data: jpeg(1280, 680) };
    },
    page: {
      tabUrl: async () => 'https://shop.example.com/',
      probe: async () => ({ width: 1280, height: attached ? 680 : 720, devicePixelRatio: 1, scrollX: 0, scrollY: 0, scale: 1 }),
      signature: async () => null,
      hideUi: async () => true,
      showUi: async () => {}
    }
  };
  const shot = await captureScreenshot(101, d);
  assert.equal(shot.viewportHeight, 680, 'the frame is the viewport after the bar appeared');
});
