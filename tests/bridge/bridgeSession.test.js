// Tests for the extension-side bridge session manager (src/background/bridge/bridgeSession.ts):
// start_task targeting, history diffing into task_event frames, task_done extraction, and the
// stop-bridge-runs-on-disconnect rule.

import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeSessionManager } from '../../src/background/bridge/bridgeSession.ts';

/** A fake WebSocket that records sent frames. */
function fakeSocket() {
  const sent = [];
  return {
    sent,
    send(text) {
      sent.push(JSON.parse(text));
    },
  };
}

function makeRunner(overrides = {}) {
  const runner = {
    status: 'idle',
    chatId: 'chat_1',
    history: [],
    activeTabId: 1,
    getState() {
      return { status: this.status, stepCount: this.history.filter((h) => h.type === 'agent_response').length, currentPhase: null, runStats: { steps: 1 }, findings: [], ...this.stateExtra };
    },
    stop() {
      this.status = 'stopped';
      return { success: true };
    },
    stateExtra: {},
    ...overrides,
  };
  return runner;
}

function makeDeps() {
  const sessions = new Map();
  const deps = {
    sessions,
    getSessions: () => [...new Set(sessions.values())],
    startTaskOnSession: async (tabId, payload) => {
      deps.started.push({ tabId, payload });
      return { ok: true, data: { tabId } };
    },
    started: [],
    stopSession: (session) => {
      deps.stopped.push(session);
      return session.engine.stop();
    },
    stopped: [],
    isValidWebTab: () => true,
    createTab: async (url) => {
      deps.createdTabs.push(url);
      return { id: 77 };
    },
    createdTabs: [],
  };
  return deps;
}

test('handleStartTask without tabId creates a dedicated tab and starts with autoApprove', async () => {
  const deps = makeDeps();
  const mgr = new BridgeSessionManager(deps);
  const res = await mgr.handleStartTask({ runId: 'r1', prompt: 'Find flights', autoApprove: true });
  assert.equal(res.ok, true);
  assert.deepEqual(deps.createdTabs, ['https://www.google.com'], 'a dedicated tab was created');
  assert.equal(deps.started[0].tabId, 77);
  assert.equal(deps.started[0].payload.autoApprove, true, 'bridge runs are always autonomous');
});

test('handleStartTask honors an explicit tabId and does not create a tab', async () => {
  const deps = makeDeps();
  const mgr = new BridgeSessionManager(deps);
  const res = await mgr.handleStartTask({ runId: 'r1', prompt: 'x', tabId: 42 });
  assert.equal(res.ok, true);
  assert.deepEqual(deps.createdTabs, []);
  assert.equal(deps.started[0].tabId, 42);
});

test('handleStartTask opens the requested startUrl in the dedicated tab', async () => {
  const deps = makeDeps();
  const mgr = new BridgeSessionManager(deps);
  const res = await mgr.handleStartTask({ runId: 'r1', prompt: 'x', startUrl: 'https://example.com/page' });
  assert.equal(res.ok, true);
  assert.deepEqual(deps.createdTabs, ['https://example.com/page']);
});

test('handleStartTask falls back to the search engine for a bad startUrl', async () => {
  const deps = makeDeps();
  const mgr = new BridgeSessionManager(deps);
  await mgr.handleStartTask({ runId: 'r1', prompt: 'x', startUrl: 'javascript:alert(1)' });
  assert.deepEqual(deps.createdTabs, ['https://www.google.com']);
});

test('handleStartTask rejects an empty prompt', async () => {
  const mgr = new BridgeSessionManager(makeDeps());
  const res = await mgr.handleStartTask({ runId: 'r1', prompt: '   ' });
  assert.equal(res.ok, false);
});

test('onStateChange sends only new history entries as task_event frames', () => {
  const deps = makeDeps();
  const mgr = new BridgeSessionManager(deps);
  const socket = fakeSocket();
  mgr.setSocket(socket);
  const runner = makeRunner();
  runner.history = [{ type: 'user_goal', prompt: 'x' }];
  mgr.onStateChange({ ownerTabId: 1, engine: runner });
  const events1 = socket.sent.filter((f) => f.type === 'task_event');
  assert.equal(events1.length, 1);
  assert.equal(events1[0].payload.entries ?? events1[0].payload.entry.type, events1[0].payload.entry ? 'user_goal' : 'entries');

  // A new entry: only the delta is sent.
  runner.history.push({ type: 'agent_response', step: 1, thought: 't', action: { action: 'click' }, rawResponse: { huge: true } });
  mgr.onStateChange({ ownerTabId: 1, engine: runner });
  const events2 = socket.sent.filter((f) => f.type === 'task_event');
  assert.equal(events2.length, 2);
  assert.equal(events2[1].payload.entry.type, 'agent_response');
  assert.equal(events2[1].payload.entry.rawResponse, undefined, 'rawResponse is projected away');
});

test('onStateChange emits history_reset when the history shrank', () => {
  const deps = makeDeps();
  const mgr = new BridgeSessionManager(deps);
  const socket = fakeSocket();
  mgr.setSocket(socket);
  const runner = makeRunner();
  runner.history = [{ type: 'user_goal' }, { type: 'agent_response' }];
  mgr.onStateChange({ ownerTabId: 1, engine: runner });
  runner.history = [];
  mgr.onStateChange({ ownerTabId: 1, engine: runner });
  assert.ok(socket.sent.some((f) => f.type === 'history_reset'), 'reset frame sent');
});

test('task_done is emitted when the tracked run leaves running/paused', () => {
  const deps = makeDeps();
  const mgr = new BridgeSessionManager(deps);
  const socket = fakeSocket();
  mgr.setSocket(socket);
  const runner = makeRunner();
  runner.history = [{ type: 'user_goal' }];
  mgr.onStateChange({ ownerTabId: 1, engine: runner });

  // Mark the run as tracked (as handleStartTask would after reading the start reply's chatId).
  mgr.trackedRunId = 'chat_1';
  mgr.wireRunId = 'chat_1';
  runner.history.push({ type: 'agent_response', step: 1, thought: 't', action: {} });
  runner.history.push({ type: 'finish', answer: 'The answer.', outcome: 'done', table: { columns: ['a'], rows: [] } });
  runner.status = 'idle';
  mgr.onStateChange({ ownerTabId: 1, engine: runner });

  const done = socket.sent.find((f) => f.type === 'task_done');
  assert.ok(done, 'task_done sent');
  assert.equal(done.payload.answer, 'The answer.');
  assert.equal(done.payload.outcome, 'done');
  assert.deepEqual(done.payload.table.columns, ['a']);
});

test('task_done is NOT emitted for runs the bridge did not start', () => {
  const deps = makeDeps();
  const mgr = new BridgeSessionManager(deps);
  const socket = fakeSocket();
  mgr.setSocket(socket);
  const runner = makeRunner();
  mgr.onStateChange({ ownerTabId: 1, engine: runner });
  runner.history.push({ type: 'finish', answer: 'x', outcome: 'done' });
  runner.status = 'idle';
  mgr.onStateChange({ ownerTabId: 1, engine: runner });
  assert.equal(socket.sent.some((f) => f.type === 'task_done'), false, 'no task_done for an untracked run');
});

test('stopBridgeRuns stops only bridge-started running sessions', () => {
  const deps = makeDeps();
  const mgr = new BridgeSessionManager(deps);
  const bridgeRunner = makeRunner({ chatId: 'chat_bridge' });
  bridgeRunner.status = 'running';
  const panelRunner = makeRunner({ chatId: 'chat_panel' });
  panelRunner.status = 'running';
  deps.sessions.set(1, { ownerTabId: 1, engine: bridgeRunner });
  deps.sessions.set(2, { ownerTabId: 2, engine: panelRunner });
  mgr.bridgeRuns.add('chat_bridge');

  mgr.stopBridgeRuns();
  assert.deepEqual(deps.stopped.map((s) => s.engine.chatId), ['chat_bridge'], 'only the bridge run was stopped');
  assert.equal(panelRunner.status, 'running', 'the panel run was untouched');
});

test('sendHello lists the sessions with tabId, chatId and status', () => {
  const deps = makeDeps();
  const mgr = new BridgeSessionManager(deps);
  const socket = fakeSocket();
  mgr.setSocket(socket);
  deps.sessions.set(1, { ownerTabId: 1, engine: makeRunner() });
  mgr.sendHello('build-x');
  const hello = socket.sent.find((f) => f.type === 'hello');
  assert.ok(hello);
  assert.equal(hello.payload.proto, 1);
  assert.equal(hello.payload.build, 'build-x');
  assert.deepEqual(hello.payload.sessions, [{ tabId: 1, chatId: 'chat_1', status: 'idle', url: '', title: '' }]);
});
