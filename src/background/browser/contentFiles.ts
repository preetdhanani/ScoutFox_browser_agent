// src/background/browser/contentFiles.ts
// Constant lists of content script files injected into pages.

export const ISOLATED_CONTENT_FILES = [
  'content/domCompressor.js',
  'content/actionExecutor.js',
  'content/content.js',
] as const;

export const MAIN_CONTENT_FILES = [
  'content/net-recorder.js',
] as const;

// Isolated-world script injected into EVERY frame: each frame relays its own
// MAIN-world recorder's messages to the background (a child frame's
// postMessage never reaches the top frame's listener - BUG-45).
export const ALL_FRAMES_ISOLATED_FILES = [
  'content/netRelay.js',
  'content/frameAgent.js',
] as const;

// The frame agent: reads, masks and scrolls one embedded frame for the background (it does
// nothing in the top frame). See src/content/frameAgent.ts.
export const FRAME_AGENT_FILE = 'content/frameAgent.js';

// Backwards-compatible aliases
export const CONTENT_SCRIPT_FILES = ISOLATED_CONTENT_FILES;
export const NET_RECORDER_FILE = MAIN_CONTENT_FILES[0];
export const NET_RELAY_FILE = ALL_FRAMES_ISOLATED_FILES[0];
