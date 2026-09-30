/**
 * The worker's unhandledrejection handler ignores the Google SDK's second report of a cut Gemini stream and still logs
 * every other unhandled rejection as an error (src/background/boot/rejections.ts says why).
 *
 * Its own file, for the same reason as backgroundClearLogs.test.js: background.js imports Logger by a plain specifier,
 * and a fresh process makes this file's Logger the very instance the handler writes to.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const noop = () => {};
const event = () => ({ addListener: noop });
const listeners = {};
global.self = { addEventListener: (type, fn) => { listeners[type] = fn; } };
global.chrome = {
  runtime: { lastError: null, onConnect: event(), onMessage: event() },
  storage: { local: { get: (keys, cb) => cb({}), set: (data, cb) => cb && cb(), remove: (keys, cb) => cb && cb() } },
  tabs: { onRemoved: event(), onActivated: event(), onCreated: event(), onUpdated: event(), query: (q, cb) => cb([]) },
  tabGroups: { onRemoved: event() },
  alarms: { create: noop, clear: noop, get: (name, cb) => cb(null), onAlarm: event() },
  action: { onClicked: event() },
  declarativeNetRequest: { updateSessionRules: () => Promise.resolve() },
  sidePanel: { setPanelBehavior: () => Promise.resolve(), setOptions: (opts, cb) => cb && cb(), open: noop }
};

const { Logger } = await import('../src/shared/logger.ts');
await import('../background/background.js');

/** Fires the handler the way the runtime does, and returns whether the default (a console report) was prevented. Logger's console lines are muted. */
function reject(reason) {
  let prevented = false;
  const { info, error } = console;
  console.info = () => {};
  console.error = () => {};
  try {
    listeners.unhandledrejection({ reason, preventDefault: () => { prevented = true; } });
  } finally {
    Object.assign(console, { info, error });
  }
  return prevented;
}

test('the worker registered the handler at the top level', () => {
  assert.equal(typeof listeners.unhandledrejection, 'function');
});

test('a cut Gemini stream, and a Gemini 200 that is not an event stream, are prevented and logged at info, not as an error', () => {
  for (const text of ['Error reading from the stream', 'Failed to parse stream']) {
    Logger.clearLogs();
    assert.equal(reject(new Error(`[GoogleGenerativeAI Error]: ${text}`)), true, text);
    const history = Logger.getLogsHistory();
    assert.equal(history.length, 1);
    assert.equal(history[0].level, 'INFO');
    assert.match(history[0].message, /\[GEMINI_STREAM_CUT\]/);
  }
});

test('any other rejection is left alone and logged as an error', () => {
  for (const reason of [new Error('boom'), new Error('[GoogleGenerativeAI Error]: Error parsing JSON response: "{"'), 'plain text', undefined]) {
    Logger.clearLogs();
    assert.equal(reject(reason), false, String(reason));
    const history = Logger.getLogsHistory();
    assert.equal(history.length, 1);
    assert.equal(history[0].level, 'ERROR');
    assert.match(history[0].message, /\[UNHANDLED_REJECTION\]/);
  }
});
