import test from 'node:test';
import assert from 'node:assert/strict';

import type { LogEntry } from '../../src/shared/logger.ts';

const mockLogsData: Record<string, unknown> = {};
// Only storage.local get and set exist here, so the mock is not a full chrome namespace.
globalThis.chrome = {
  storage: {
    local: {
      get: (keys: string[], cb: (items: Record<string, unknown>) => void) => {
        const result: Record<string, unknown> = {};
        keys.forEach(k => { result[k] = mockLogsData[k]; });
        cb(result);
      },
      set: (items: Record<string, unknown>, cb?: () => void) => {
        Object.assign(mockLogsData, items);
        if (cb) cb();
      }
    }
  }
} as unknown as typeof chrome;

const { Logger } = await import('../../src/shared/logger.ts');

test('Logger - Add Log Entry and Retrieve History', () => {
  Logger.clearLogs();
  Logger.info('TestModule', 'Test info message', { count: 42 });

  const history = Logger.getLogsHistory();
  assert.equal(history.length, 1);
  assert.equal(history[0].module, 'TestModule');
  assert.equal(history[0].message, 'Test info message');
  assert.ok(history[0].data?.includes('42'));
});

test('Logger - Error logging with exception stack', () => {
  Logger.clearLogs();
  const testError = new Error('Database connection failed');
  Logger.error('DB', 'Failed operation', testError);

  const history = Logger.getLogsHistory();
  assert.equal(history.length, 1);
  assert.equal(history[0].level, 'ERROR');
  assert.ok(history[0].message.includes('Failed operation Database connection failed'));
});

test('Logger - Broadcast callback triggers on new entry', () => {
  Logger.clearLogs();
  let receivedEntry = null as LogEntry | null; // set inside the callback, which TS does not follow
  Logger.setBroadcastCallback((entry) => {
    receivedEntry = entry;
  });

  Logger.warn('Network', 'High latency detected', { latencyMs: 850 });

  assert.ok(receivedEntry);
  assert.equal(receivedEntry.module, 'Network');
  assert.equal(receivedEntry.level, 'WARN');
});

test('Logger - Memory cap to 300 items', () => {
  Logger.clearLogs();
  for (let i = 0; i < 350; i++) {
    Logger.info('Loop', `Message ${i}`);
  }

  const history = Logger.getLogsHistory();
  assert.equal(history.length, 300);
  assert.equal(history[0].message, 'Message 50');
  assert.equal(history[299].message, 'Message 349');
});
