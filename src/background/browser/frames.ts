// src/background/browser/frames.ts
// The page's frames as the background reaches them: the top frame's content script, and the
// frame agent (content/frameAgent.js) in every embedded frame, which reads, masks and scrolls
// that frame's own document (an iframe from another origin is out of the top frame's reach).

import { describeRestrictedUrl } from './tabs.ts';
import { FRAME_AGENT_FILE } from './contentFiles.ts';

/**
 * The send options of every message meant for the top frame's content script. A message without a
 * frameId goes to EVERY frame of the tab and the first answer wins, so once embedded frames run a
 * script of their own, an unpinned message could be answered by the wrong frame.
 */
export const TOP_FRAME = { frameId: 0 } as const;


/** How long one frame may take to answer before it counts as not answering. */
export const FRAME_ANSWER_MS = 1500;

/** One embedded frame of a tab, as the background finds it. */
export interface EmbeddedFrame {
  frameId: number;
  /** The frame's current document. A frame that navigates keeps its frameId but gets a new documentId. */
  documentId?: string;
  /** 1 for a frame of the top page, 2 for a frame inside that, and so on. */
  depth: number;
  /** Its path from the top page (src/content/frameIds.ts): "2.0" is the first frame inside the third. */
  path: string;
  /** Whether the frame agent is installed in it. */
  agent: boolean;
  href: string;
}

/** What the frame calls need from Chrome, so a test can stand in for it. */
export interface FramePort {
  /** Runs `func` in every frame of the tab; one result per frame that ran it. */
  inAllFrames(tabId: number): Promise<Array<{ frameId: number; documentId?: string; result: any }>>;
  /** Injects the frame agent into these frames. */
  injectAgent(tabId: number, frameIds: number[]): Promise<void>;
  /** One message to one frame (by document when known); null when it does not answer in time. */
  send(tabId: number, target: { frameId: number; documentId?: string }, message: unknown, timeoutMs: number): Promise<any>;
}

export function chromeFramePort(): FramePort {
  return {
    async inAllFrames(tabId) {
      if (typeof chrome === 'undefined' || !chrome.scripting?.executeScript) return [];
      // INLINE on purpose (the build checks it): a func sent to the page is serialized and runs
      // where none of the bundle exists. Identity checks on window.parent/top work across origins.
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () => {
          // The same path rule as framePathOf in src/content/frameIds.ts.
          const page = globalThis as any;
          const path: number[] = [];
          let w = page;
          try {
            while (w !== w.top && path.length < 32) {
              const parent = w.parent;
              let index = -1;
              for (let i = 0; i < parent.length; i++) {
                if (parent[i] === w) {
                  index = i;
                  break;
                }
              }
              if (index < 0) return { depth: -1, path: '', agent: false, href: '' };
              path.unshift(index);
              w = parent;
            }
          } catch (_) {
            return { depth: -1, path: '', agent: false, href: '' };
          }
          let href = '';
          try {
            href = String(page.location.href);
          } catch (_) {}
          return { depth: path.length, path: path.join('.'), agent: page.__scoutfoxFrameAgent === true, href };
        }
      });
      return (results || []).map((r: any) => ({ frameId: r.frameId, documentId: r.documentId, result: r.result }));
    },
    async injectAgent(tabId, frameIds) {
      if (!frameIds.length || typeof chrome === 'undefined' || !chrome.scripting?.executeScript) return;
      await chrome.scripting.executeScript({ target: { tabId, frameIds }, files: [FRAME_AGENT_FILE] });
    },
    async send(tabId, target, message, timeoutMs) {
      if (typeof chrome === 'undefined' || !chrome.tabs?.sendMessage) return null;
      const options = target.documentId ? { documentId: target.documentId } : { frameId: target.frameId };
      return await new Promise<any>((resolve) => {
        const timer = setTimeout(() => resolve(null), timeoutMs);
        try {
          chrome.tabs.sendMessage(tabId, message, options, (response) => {
            clearTimeout(timer);
            resolve(chrome.runtime?.lastError ? null : response ?? null);
          });
        } catch (_) {
          clearTimeout(timer);
          resolve(null);
        }
      });
    }
  };
}

/**
 * The embedded frames of a tab (the top frame left out), with the frame agent installed wherever it
 * can be: a page that loaded before the extension has none, so it is injected once and the frames
 * are listed again. A frame the agent cannot run in (another extension's page, data: or blob:) stays
 * without one, and every caller treats it as unreadable and uncovered-never.
 */
export async function embeddedFrames(tabId: number, port: FramePort = chromeFramePort()): Promise<EmbeddedFrame[]> {
  const list = async () => {
    const rows = await port.inAllFrames(tabId).catch(() => []);
    return rows
      .filter((r) => r && r.frameId !== 0 && r.result && Number(r.result.depth) > 0)
      .map((r) => ({ frameId: r.frameId, documentId: r.documentId, depth: Number(r.result.depth), path: String(r.result.path || ''), agent: r.result.agent === true, href: String(r.result.href || '') }));
  };
  let frames = await list();
  const missing = frames.filter((f) => !f.agent && !describeRestrictedUrl(f.href)).map((f) => f.frameId);
  if (missing.length) {
    await port.injectAgent(tabId, missing).catch(() => undefined);
    frames = await list();
  }
  return frames;
}

/** The text of each embedded frame worth reading, for read_page: its origin and its text. */
export async function readFrameTexts(tabId: number, port: FramePort = chromeFramePort()): Promise<Array<{ origin: string; text: string }>> {
  const frames = (await embeddedFrames(tabId, port)).filter((f) => f.agent && !describeRestrictedUrl(f.href));
  const answers = await Promise.all(frames.map((f) => port.send(tabId, f, { action: 'FRAME_TEXT' }, FRAME_ANSWER_MS)));
  const out: Array<{ origin: string; text: string }> = [];
  answers.forEach((a) => {
    const text = a && a.success && typeof a.text === 'string' ? a.text.trim() : '';
    if (text) out.push({ origin: String(a.origin || 'another site'), text });
  });
  return out;
}

/** The frames whose agents put up their covers for one capture. */
export interface FrameMasks {
  /** Paths of the frames that confirmed their own covers AND the covers over their unconfirmed children. */
  shownFramePaths: string[];
  /** The documents that drew covers: each is checked after the capture and cleared after it. */
  masked: Array<{ frameId: number; documentId?: string; path?: string }>;
}

/**
 * Puts up the covers in every embedded frame, deepest first, so a frame is confirmed only after its
 * own child frames were: each frame covers its sensitive fields and every unreadable iframe in it
 * that is not confirmed yet. A frame that does not answer is not confirmed, and the frame above it
 * covers it whole (fail closed).
 */
export async function maskEmbeddedFrames(tabId: number, port: FramePort = chromeFramePort()): Promise<FrameMasks> {
  const frames = (await embeddedFrames(tabId, port)).filter((f) => f.agent);
  const confirmed: string[] = [];
  const masked: FrameMasks['masked'] = [];
  const depths = [...new Set(frames.map((f) => f.depth))].sort((a, b) => b - a);
  for (const depth of depths) {
    const level = frames.filter((f) => f.depth === depth);
    const shownFramePaths = [...confirmed];
    const answers = await Promise.all(level.map((f) => port.send(tabId, f, { action: 'FRAME_MASK', payload: { shownFramePaths } }, FRAME_ANSWER_MS)));
    level.forEach((f, i) => {
      const answer = answers[i];
      // The path the frame read when it drew its covers: that is the iframe it vouches for.
      const path = answer && answer.success === true && typeof answer.path === 'string' && answer.path !== '' ? answer.path : null;
      masked.push({ frameId: f.frameId, documentId: f.documentId, ...(path ? { path } : {}) });
      if (path) confirmed.push(path);
    });
  }
  return { shownFramePaths: confirmed, masked };
}

/**
 * After the capture: every confirmed frame's covers still hold, in the SAME document (a frame that
 * navigated has a new document, and the message to the old one finds nobody) and at the SAME path
 * (a frame that moved would vouch for another iframe). Anything but a yes from all of them throws
 * the picture away.
 */
export async function frameMasksHold(tabId: number, masks: FrameMasks, port: FramePort = chromeFramePort()): Promise<boolean> {
  const confirmed = masks.masked.filter((m) => m.path && masks.shownFramePaths.includes(m.path));
  const answers = await Promise.all(confirmed.map((m) => port.send(tabId, m, { action: 'FRAME_MASK_CHECK', payload: { path: m.path } }, FRAME_ANSWER_MS)));
  return answers.every((a) => a && a.success === true);
}

/** Takes the covers down in every frame that drew them. Best effort. */
export async function unmaskEmbeddedFrames(tabId: number, masks: FrameMasks, port: FramePort = chromeFramePort()): Promise<void> {
  await Promise.all(masks.masked.map((m) => port.send(tabId, { frameId: m.frameId }, { action: 'FRAME_UNMASK' }, FRAME_ANSWER_MS).catch(() => null)));
}

/** The frame id of the embedded frame at a path, or null when no frame with an agent is there. */
export async function frameIdAtPath(tabId: number, path: string, port: FramePort = chromeFramePort()): Promise<number | null> {
  const frame = (await embeddedFrames(tabId, port)).find((f) => f.agent && f.path === path);
  return frame ? frame.frameId : null;
}
