import test from 'node:test';
import assert from 'node:assert/strict';

const mockLogsData = {};
global.chrome = {
  storage: {
    local: {
      get: (keys, cb) => {
        const result = {};
        keys.forEach(k => { result[k] = mockLogsData[k]; });
        cb(result);
      },
      set: (items, cb) => {
        Object.assign(mockLogsData, items);
        if (cb) cb();
      }
    }
  }
};

const { Logger } = await import('../utils/logger.js');

test('Logger - Add Log Entry and Retrieve History', () => {
  Logger.clearLogs();
  Logger.info('TestModule', 'Test info message', { count: 42 });

  const history = Logger.getLogsHistory();
  assert.equal(history.length, 1);
  assert.equal(history[0].module, 'TestModule');
  assert.equal(history[0].message, 'Test info message');
  assert.ok(history[0].data.includes('42'));
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
  let receivedEntry = null;
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
