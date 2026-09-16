/**
 * Regression tests for the three ask-user findings resolved in this pass:
 *
 *   ollama-token-cap-active   DEFAULT_SETTINGS.ollamaNumPredict was 1024 with no Settings UI
 *                             control, so it was always 1024 in practice despite apiClients.js
 *                             already supporting a higher value.
 *   clear-logs-not-propagated btnClearLogs cleared the panel's view and storage, but never told
 *                             the background worker, whose own in-memory logsHistory rewrote
 *                             everything back to storage on the next log call.
 *   simplify-duplicate-log-restore  Two log-restore paths raced on a background cold boot:
 *                             GET_AGENT_STATE could answer with an empty logs array before
 *                             Logger's own async storage restore had finished, silently wiping
 *                             whatever the panel had already shown. Fixed at the source: the
 *                             restore is now awaitable, and GET_AGENT_STATE awaits it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

/* ---------------------------- ollama-token-cap-active ---------------------------- */

test('ollamaNumPredict default is no longer the inert 1024', async () => {
  const { DEFAULT_SETTINGS } = await import('../utils/storage.js');

  assert.notEqual(DEFAULT_SETTINGS.ollamaNumPredict, 1024,
    'this was the value that made the token-cap fix a no-op with no UI control to change it');
  assert.equal(DEFAULT_SETTINGS.ollamaNumPredict, 8192);
});

test('a settings object with no ollamaNumPredict still resolves to a generous cap via getSettings()', async () => {
  const store = {};
  global.chrome = {
    storage: {
      local: {
        get: (keys, cb) => cb({ agent_settings: store.agent_settings }),
        set: (data, cb) => { Object.assign(store, data); if (cb) cb(); }
      }
    }
  };
  const { Storage } = await import('../utils/storage.js?case=ollamaNumPredict');

  const settings = await Storage.getSettings();
  assert.equal(settings.ollamaNumPredict, 8192);
});


/* ---------------------------- Logger: clear + restore race ---------------------------- */

function makeChromeStorageMock(initial = {}) {
  const store = { ...initial };
  return {
    storage: {
      local: {
        get: (keys, cb) => {
          const result = {};
          (Array.isArray(keys) ? keys : [keys]).forEach((k) => { result[k] = store[k]; });
          cb(result);
        },
        set: (items, cb) => { Object.assign(store, items); if (cb) cb(); },
        remove: (keys, cb) => {
          (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete store[k]);
          if (cb) cb();
        }
      }
    },
    __store: store
  };
}

test('clear-logs-not-propagated: Logger.clearLogs() empties the in-memory history immediately', async () => {
  global.chrome = makeChromeStorageMock();
  const { Logger } = await import('../utils/logger.js?case=clearLogs');

  Logger.info('Test', 'entry one');
  Logger.info('Test', 'entry two');
  assert.equal(Logger.getLogsHistory().length, 2);

  Logger.clearLogs();
  assert.equal(Logger.getLogsHistory().length, 0,
    'clearLogs must empty logsHistory synchronously, or the very next log call would still find old entries to persist alongside the new one');
});

test('simplify-duplicate-log-restore: logsRestored() resolves even when chrome.storage never calls back', async () => {
  // No chrome.storage at all - matches a non-extension context, and exercises the
  // early-resolve branch that previously had nothing to make it awaitable.
  delete global.chrome;
  const { Logger } = await import('../utils/logger.js?case=noStorage');

  await assert.doesNotReject(Logger.logsRestored());
});

test('simplify-duplicate-log-restore: logsRestored() only resolves after the storage read actually lands', async () => {
  let deliverStorageResult;
  const pendingGet = new Promise((resolve) => { deliverStorageResult = resolve; });

  global.chrome = {
    storage: {
      local: {
        // Simulates a cold-boot restore that has not landed yet when logsRestored() is
        // first awaited - the exact race that used to let an empty logs array through.
        get: (keys, cb) => { pendingGet.then(() => cb({ agent_logs_history: ['restored'] })); },
        set: () => {}
      }
    }
  };
  const { Logger } = await import('../utils/logger.js?case=raceTiming');

  let resolved = false;
  Logger.logsRestored().then(() => { resolved = true; });

  await new Promise((r) => setTimeout(r, 20));
  assert.equal(resolved, false,
    'logsRestored() must still be pending while the storage read is in flight');

  deliverStorageResult();
  await Logger.logsRestored();
  assert.equal(resolved, true);
});


// The two background.js scenarios (CLEAR_LOGS, GET_AGENT_STATE race) live in their own
// dedicated files: tests/backgroundClearLogs.test.js and tests/backgroundGetAgentStateRace.test.js.
//
// background.js imports Logger via the plain specifier '../utils/logger.js', with no query
// string, and module-level state only runs its restore IIFE once per process. Testing it
// alongside other logger.js scenarios in this file (which deliberately use ?case=... query
// suffixes to force fresh instances per test) would either observe a DIFFERENT Logger instance
// than the one background.js actually uses, or share a Logger instance whose restore already
// resolved in an earlier test - node --test isolates by FILE, not by individual test(), so a
// clean process per scenario is what actually gets a fresh, correctly-shared module graph.
