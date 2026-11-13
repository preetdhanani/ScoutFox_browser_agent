/**
 * The extension-side mirror of bridge/protocol.mjs: the envelope shapes, and the projection
 * that turns a HistoryEntry into a wire-safe payload (no rawResponse, no image bytes, long
 * strings truncated). The two files must stay in sync; tests/bridge/protocol.test.js pins the
 * shared behaviour through the bridge copy.
 */

export const PROTOCOL_VERSION = 1;

export interface BridgeFrame {
  v: number;
  type: string;
  id: string | number | null;
  payload: Record<string, unknown>;
}

/** Extension -> bridge. */
export const EXT_TYPES = ['hello', 'result', 'task_event', 'task_done', 'history_reset'] as const;
/** Bridge -> extension. */
export const BRIDGE_TYPES = ['start_task', 'stop_task', 'get_state', 'ping'] as const;

export function parseFrame(raw: unknown): BridgeFrame | null {
  let frame: any;
  try {
    frame = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return null;
  if (frame.v !== PROTOCOL_VERSION) return null;
  if (typeof frame.type !== 'string') return null;
  if (!(EXT_TYPES as readonly string[]).includes(frame.type) && !(BRIDGE_TYPES as readonly string[]).includes(frame.type)) return null;
  if (frame.id !== null && frame.id !== undefined && typeof frame.id !== 'string' && typeof frame.id !== 'number') return null;
  if (!frame.payload || typeof frame.payload !== 'object' || Array.isArray(frame.payload)) return null;
  return { v: frame.v, type: frame.type, id: frame.id ?? null, payload: frame.payload };
}

export function encodeFrame(type: string, payload: Record<string, unknown>, id: string | number | null = null): string {
  return JSON.stringify({ v: PROTOCOL_VERSION, type, id, payload });
}

export const MAX_STRING_CHARS = 4000;
const DROP_KEYS = new Set(['rawResponse', 'imageId', 'imageWidth', 'imageHeight']);

/** Project one HistoryEntry for the wire (see bridge/protocol.mjs for the rationale). */
export function bridgeEntry(entry: unknown): unknown {
  return truncate(entry, 0);
}

function truncate(value: unknown, depth: number): unknown {
  if (depth > 6) return '[deep]';
  if (typeof value === 'string') return value.length > MAX_STRING_CHARS ? value.slice(0, MAX_STRING_CHARS) + '…' : value;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return (value as unknown[]).slice(0, 100).map((v) => truncate(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (DROP_KEYS.has(key)) continue;
    out[key] = truncate(val, depth + 1);
  }
  return out;
}

export interface HistoryDelta {
  reset: boolean;
  entries?: unknown[];
}

/**
 * History diff for one run. A shrink (clearHistory, loadChat, a cache trim) means the seq basis
 * is gone: the caller sends history_reset instead of a delta. chat_compacted does NOT shrink the
 * history array (it appends), so it never triggers a reset.
 */
export function historyDelta(history: unknown[], lastSeq: number): HistoryDelta {
  if (history.length < lastSeq) return { reset: true };
  if (history.length === lastSeq) return { reset: false, entries: [] };
  return { reset: false, entries: history.slice(lastSeq) };
}
