import test from 'node:test';
import assert from 'node:assert/strict';

const mockStorage = {
  agent_logs_history: [
    { timestamp: '12:00:00 PM', level: 'INFO', module: 'System', message: 'Prior persisted log 1' },
    { timestamp: '12:00:01 PM', level: 'INFO', module: 'System', message: 'Prior persisted log 2' }
  ]
};

global.chrome = {
  storage: {
    local: {
      get: (keys, cb) => {
        const out = {};
        keys.forEach(k => { out[k] = mockStorage[k]; });
        if (cb) cb(out);
      },
      set: (items, cb) => {
        Object.assign(mockStorage, items);
        if (cb) cb();
      },
      remove: (keys, cb) => {
        keys.forEach(k => delete mockStorage[k]);
        if (cb) cb();
      }
    }
  },
  runtime: { lastError: null },
  tabs: {
    query: async () => [{ id: 101, url: 'https://example.com' }],
    get: (id, cb) => cb && cb({ id, url: 'https://example.com' })
  }
};

const { Logger } = await import('../utils/logger.js');
const { AgentEngine } = await import('../background/agentEngine.js');

test('Logger - restores prior logs from storage on startup', () => {
  const history = Logger.getLogsHistory();
  assert.ok(history.length >= 2);
  assert.ok(history.some(e => e.message === 'Prior persisted log 1'));
});

test('AgentEngine - clearHistory resets turns but preserves debug logs', () => {
  const initialLogsCount = Logger.getLogsHistory().length;
  assert.ok(initialLogsCount > 0);

  const engine = new AgentEngine();
  engine.history = [{ type: 'user_goal', prompt: 'test' }];
  engine.clearHistory();

  assert.equal(engine.history.length, 0);
  assert.ok(Logger.getLogsHistory().length >= initialLogsCount, 'Debug logs must be retained across fresh opens');
});

test('AgentEngine - startTask adds [NEW_SESSION_RUN] marker in logs and tags isNewRun in history', async () => {
  const engine = new AgentEngine();
  engine.ensureScoutFoxGroup = async () => 999;
  engine.generatePlan = async () => {};
  engine.runLoop = async () => {};

  await engine.startTask('Search Wikipedia for AI', 101);

  assert.equal(engine.history.length, 1);
  assert.equal(engine.history[0].isNewRun, true);
  assert.equal(engine.history[0].turn, 1);

  const logs = Logger.getLogsHistory();
  assert.ok(logs.some(l => l.message.includes('[NEW_SESSION_RUN]')));
});
