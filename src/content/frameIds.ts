/**
 * ScoutFox frame paths: which embedded frame an iframe element is, without asking the page.
 *
 * A frame's path is its index among its parent's child frames, at every level from the top:
 * [] is the top page, [2] is the third frame of the top page, [2, 0] is the first frame inside that.
 * It is read from window identities only (`parent.frames[i] === window`), which work across origins
 * and send nothing the page can see: no message, no attribute. The background finds each frame's
 * path the same way (frames.ts), so a path names the same frame on both sides.
 *
 * (chrome.runtime.getFrameId would map an element to a frame id directly, but Chrome does not
 * offer it to content scripts.)
 */

import type { FrameShown } from './screenshotPrivacy.ts';

/** How deep a path is followed at most. */
const MAX_DEPTH = 32;

/** The path of a window from the top page, or null when it cannot be read (a detached frame). */
export function framePathOf(win: Window | null | undefined): number[] | null {
  if (!win) return null;
  const path: number[] = [];
  try {
    let w: any = win;
    for (let depth = 0; w !== w.top; depth++) {
      if (depth >= MAX_DEPTH) return null;
      const parent = w.parent;
      let index = -1;
      for (let i = 0; i < parent.length; i++) {
        if (parent[i] === w) {
          index = i;
          break;
        }
      }
      if (index < 0) return null;
      path.unshift(index);
      w = parent;
    }
  } catch (_) {
    return null;
  }
  return path;
}

/** A path as one string, for sets and messages: "2.0"; the top page is "". */
export function pathKey(path: number[]): string {
  return path.join('.');
}

/** The path of the frame an iframe element shows, as a key, or null when it has no window yet. */
export function framePathKeyOf(frame: HTMLIFrameElement): string | null {
  let view: Window | null = null;
  try {
    view = frame.contentWindow;
  } catch (_) {
    view = null;
  }
  const path = framePathOf(view);
  return path && path.length ? pathKey(path) : null;
}

/**
 * The mask rule for the paths of frames whose agents confirmed their own covers: such an iframe is
 * shown, every other unreadable iframe is covered whole (a frame whose path cannot be read is never shown).
 */
export function shownFrames(paths: unknown, keyOf: (frame: HTMLIFrameElement) => string | null = framePathKeyOf): FrameShown {
  const confirmed = new Set((Array.isArray(paths) ? paths : []).filter((p): p is string => typeof p === 'string' && p !== ''));
  return (frame) => {
    if (!confirmed.size) return false;
    const key = keyOf(frame);
    return key !== null && confirmed.has(key);
  };
}
