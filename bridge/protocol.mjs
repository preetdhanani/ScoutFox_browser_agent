/**
 * Wire protocol shared by the bridge process and (mirrored in TS) the extension.
 *
 * One JSON object per WebSocket text frame:
 *   { v: 1, type: "<name>", id: "<correlation id or null>", payload: { ... } }
 *
 * Requests carry an id; events carry id: null. Every frame is validated before use, so a
 * malformed peer can never reach the run logic.
 */

export const PROTOCOL_VERSION = 1;

/** Extension -> bridge. */
export const EXT_TYPES = ['hello', 'result', 'task_event', 'task_done', 'history_reset'];
/** Bridge -> extension. */
export const BRIDGE_TYPES = ['start_task', 'stop_task', 'get_state', 'ping'];

/**
 * Validate one decoded frame. Returns the frame or null when it is not a well-formed envelope
 * of a known type. Payloads are checked shallowly here; handlers own their deeper checks.
 */
export function parseFrame(raw) {
  let frame;
  try {
    frame = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return null;
  if (frame.v !== PROTOCOL_VERSION) return null;
  if (typeof frame.type !== 'string') return null;
  if (!EXT_TYPES.includes(frame.type) && !BRIDGE_TYPES.includes(frame.type)) return null;
  if (frame.id !== null && frame.id !== undefined && typeof frame.id !== 'string' && typeof frame.id !== 'number') return null;
  if (!frame.payload || typeof frame.payload !== 'object' || Array.isArray(frame.payload)) return null;
  return { v: frame.v, type: frame.type, id: frame.id ?? null, payload: frame.payload };
}

export function encodeFrame(type, payload, id = null) {
  return JSON.stringify({ v: PROTOCOL_VERSION, type, id, payload });
}

/**
 * Project one HistoryEntry for the wire: drop rawResponse (model dumps), image-byte references
 * (bytes live in the extension's registry, the bridge never needs them) and truncate long strings.
 */
export const MAX_STRING_CHARS = 4000;
const DROP_KEYS = new Set(['rawResponse', 'imageId', 'imageWidth', 'imageHeight']);

export function bridgeEntry(entry) {
  return truncate(entry, 0);
}

function truncate(value, depth) {
  if (depth > 6) return '[deep]';
  if (typeof value === 'string') return value.length > MAX_STRING_CHARS ? value.slice(0, MAX_STRING_CHARS) + '…' : value;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => truncate(v, depth + 1));
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (DROP_KEYS.has(key)) continue;
    out[key] = truncate(val, depth + 1);
  }
  return out;
}

/**
 * History diff for one run: given the run's history and the last sequence sent, return the new
 * entries. A shrink (clearHistory, loadChat, a cache trim) is signalled by the caller through
 * `shrank`, and the caller then sends history_reset instead of a delta.
 */
export function historyDelta(history, lastSeq) {
  if (history.length < lastSeq) return { reset: true };
  if (history.length === lastSeq) return { reset: false, entries: [] };
  return { reset: false, entries: history.slice(lastSeq) };
}
