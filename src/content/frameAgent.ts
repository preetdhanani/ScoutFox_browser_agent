/**
 * Tarka frame agent: the content script of every embedded frame (manifest `all_frames`).
 *
 * The top frame's content script cannot see into an iframe from another origin, and innerText never
 * enters any iframe, so a lesson or a document that lives in one was invisible to the model. The
 * frame agent runs in the frame itself and answers the background for its own document only, with
 * the same rules the top page uses (pageText.ts, screenshotPrivacy.ts, scrollActions.ts):
 *
 *   FRAME_TEXT        the frame's visible text, or nothing for a frame too small to be content
 *   FRAME_MASK        cover this document's password, card and OTP fields, and every iframe in it
 *                     whose own agent did not confirm (payload.shownFramePaths); answers its path
 *   FRAME_MASK_CHECK  after the capture: the covers still hold, and the frame is still at that path
 *   FRAME_UNMASK      take the covers down
 *   FRAME_SCROLL      one scroll action (scroll_target, scroll_measure, scroll_fallback)
 *
 * It answers only FRAME_* actions, so it can never answer a message meant for the top frame. It
 * does nothing in the top frame, which has the full content script.
 */

import { extractFullPageTextFromDocument, readRootOf } from './pageText.ts';
import { collectLinks } from './pageLinks.ts';
import { maskSensitiveFields, masksStillHold, removeSensitiveMasks } from './screenshotPrivacy.ts';
import { runScrollAction } from './scrollActions.ts';
import { framePathKeyOf, framePathOf, pathKey, shownFrames } from './frameIds.ts';
import type { ScrollBox } from './scrollMeasure.ts';

/** A frame smaller than this (CSS pixels) is a tracker, an ad slot or hidden: its text is not page content. */
export const FRAME_MIN_WIDTH = 200;
export const FRAME_MIN_HEIGHT = 100;
/** The most text one frame adds to the page text. */
export const FRAME_TEXT_CAP = 60000;

/** The answer to one FRAME_* message for this document, or null when the action is not a frame action. */
export async function answerFrameMessage(request: any, doc: Document, win: Window): Promise<any | null> {
  const action = request && request.action;
  const host = (() => {
    try {
      return win.location.host || win.location.protocol;
    } catch (_) {
      return 'another site';
    }
  })();
  switch (action) {
    case 'FRAME_TEXT': {
      const width = win.innerWidth || 0;
      const height = win.innerHeight || 0;
      if (width < FRAME_MIN_WIDTH || height < FRAME_MIN_HEIGHT) return { success: true, text: '', skipped: `the frame is only ${width}x${height}` };
      const text = extractFullPageTextFromDocument(doc, win as Window);
      let origin = host;
      try {
        origin = win.location.origin;
      } catch (_) {}
      let base = 'https://localhost/';
      try {
        base = win.location.href;
      } catch (_) {}
      return { success: true, origin, text: String(text || '').slice(0, FRAME_TEXT_CAP), links: collectLinks(readRootOf(doc), base) };
    }
    case 'FRAME_MASK': {
      // The path is read now, not at discovery: the frame that drew the covers is the one confirmed.
      const path = framePathOf(win);
      if (!path || !path.length) return { success: false, error: 'the frame path could not be read' };
      maskSensitiveFields(doc, win, shownFrames(request.payload && request.payload.shownFramePaths));
      return { success: true, path: pathKey(path) };
    }
    case 'FRAME_MASK_CHECK': {
      // A frame that moved (another frame took its index) would vouch for the wrong iframe.
      const path = framePathOf(win);
      const samePath = !!path && pathKey(path) === String(request.payload && request.payload.path);
      return { success: samePath && masksStillHold(doc) };
    }
    case 'FRAME_UNMASK':
      removeSensitiveMasks(doc);
      return { success: true };
    case 'FRAME_SCROLL': {
      const frameWords = `the embedded frame (${host})`;
      const label = (box: ScrollBox, words: string) => (box ? `${words} in ${frameWords}` : frameWords);
      const result = await runScrollAction(request.payload, doc, win, { framePathOf: framePathKeyOf, label });
      return result || { success: false, error: `unknown scroll action ${JSON.stringify(request.payload && request.payload.action)}` };
    }
  }
  return null;
}

/** Installs the agent in this frame. Does nothing in the top frame, or twice. */
export function installFrameAgent(win: Window & typeof globalThis): void {
  const g = win as any;
  if (!g || g.top === g || g.__tarkaFrameAgent) return;
  const runtime = g.chrome && g.chrome.runtime;
  if (!runtime || !runtime.onMessage) return;
  g.__tarkaFrameAgent = true;
  runtime.onMessage.addListener((request: any, _sender: unknown, sendResponse: (r: unknown) => void) => {
    if (!request || typeof request.action !== 'string' || !request.action.startsWith('FRAME_')) return false;
    answerFrameMessage(request, win.document, win).then(
      (answer) => sendResponse(answer || { success: false, error: `unknown frame action ${request.action}` }),
      (err) => sendResponse({ success: false, error: String((err && err.message) || err) })
    );
    return true;
  });
}

if (typeof window !== 'undefined') installFrameAgent(window as Window & typeof globalThis);
