/**
 * Shared chrome.runtime.connect() port fake, for tests that drive the real background.js
 * through its onConnect listener rather than calling AgentEngine directly.
 *
 * Was hand-rolled byte-for-byte identically in backgroundSessionFreshCollision.test.js,
 * multiWindowSameSessionE2E.test.js and multiWindowSessionIsolation.test.js.
 */
export function makeFakePort(name) {
  const disconnectListeners = [];
  return {
    name,
    received: [],
    postMessage(msg) { this.received.push(msg); },
    onDisconnect: { addListener: (fn) => disconnectListeners.push(fn) },
    _disconnect() { disconnectListeners.forEach((fn) => fn()); }
  };
}

/**
 * The port also receives LOG_ENTRY broadcasts interleaved with STATE_UPDATE messages (every
 * Logger call broadcasts to every connected port) - most visibly the diagnostic logging a fix
 * itself adds. The last message overall is not reliably a STATE_UPDATE, so pick the last one
 * that actually is.
 */
export function lastStateUpdate(port) {
  return [...port.received].reverse().find((m) => m.type === 'STATE_UPDATE');
}

/** Drive a captured chrome.runtime.onMessage listener like a real sendMessage round trip. */
export function sendMessage(listeners, msg) {
  return new Promise((resolve) => listeners.onMessage(msg, {}, resolve));
}
