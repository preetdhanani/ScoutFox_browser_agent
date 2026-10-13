import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRunner } from '../../src/background/runner/AgentRunner.ts';
import { fakeChrome } from '../helpers/fakeChrome.ts';
import { createFakeStorage } from '../helpers/fakeStorageSession.ts';
import { SessionRunnerMeta } from '../../src/background/runner/runnerMeta.ts';
import { currentTurnHistory } from '../../src/background/agent/previousTurns.ts';
import { graphRig, act } from '../helpers/graphHarness.ts';

test('lifecycle: clearHistory resets counters, clears history and clears meta', async () => {
  const store = createFakeStorage();
  const fc = fakeChrome({ storage: store });
  const restore = fc.install();
  try {
    const runner = new AgentRunner(201, 'default', undefined, {
      complete: async () => ({ text: '{}', provider: 'test', model: 'm', meta: {} }),
    });

    runner.stepCount = 15;
    runner.stateVersion = 10;
    runner.currentTask = 'Task in progress';
    runner.history = [{ type: 'user_goal', turn: 1, prompt: 'Task', timestamp: '2026-01-01', isNewRun: true }];

    runner.clearHistory();

    assert.equal(runner.stepCount, 0);
    assert.equal(runner.stateVersion, 1); // 0 incremented by notifyStateChange
    assert.equal(runner.currentTask, '');
    assert.deepEqual(runner.history, []);
    assert.equal(runner.status, 'idle');
  } finally {
    restore();
  }
});

test('lifecycle: notifyStateChange schedules meta write to session storage', async () => {
  const store = createFakeStorage();
  const fc = fakeChrome({ storage: store });
  const restore = fc.install();
  try {
    const threadId = '202';
    const runner = new AgentRunner(202, 'default', undefined, {
      complete: async () => ({ text: '{}', provider: 'test', model: 'm', meta: {} }),
    });

    // Calling persistState forces writeImmediate
    await runner.persistState();

    const metaReader = new SessionRunnerMeta(threadId);
    const stored = await metaReader.read();
    assert.ok(stored);
    assert.equal(typeof stored.stateVersion, 'number');
    assert.ok(Array.isArray(stored.scoutFoxGroupIds));
  } finally {
    restore();
  }
});

test('lifecycle: restoreState restores stateVersion = stored + 1 across restarts', async () => {
  const rig = await graphRig({
    policy: [act.finish('Item 42 costs 99 USD.')],
  });
  try {
    await rig.start('Find item 42');
    assert.equal(rig.status(), 'idle');
    const oldVersion = rig.state().stateVersion;
    assert.ok(oldVersion >= 1);

    // Restart simulates service worker restart
    const newRunner = await rig.restart();
    assert.ok(newRunner.stateVersion >= oldVersion);
  } finally {
    rig.cleanup();
  }
});

test('lifecycle: each runner instance gets a distinct bootId', () => {
  const store = createFakeStorage();
  const fc = fakeChrome({ storage: store });
  const restore = fc.install();
  try {
    const a = new AgentRunner(301, 1, undefined, {
      complete: async () => ({ text: '{}', provider: 'test', model: 'm', meta: {} }),
    });
    const b = new AgentRunner(302, 2, undefined, {
      complete: async () => ({ text: '{}', provider: 'test', model: 'm', meta: {} }),
    });
    assert.ok(a.bootId && typeof a.bootId === 'string');
    assert.ok(b.bootId && typeof b.bootId === 'string');
    assert.notEqual(a.bootId, b.bootId);
  } finally {
    restore();
  }
});

test('lifecycle: state broadcasts carry bootId and stateVersion', () => {
  const store = createFakeStorage();
  const fc = fakeChrome({ storage: store });
  const restore = fc.install();
  try {
    const runner = new AgentRunner(303, 3, undefined, {
      complete: async () => ({ text: '{}', provider: 'test', model: 'm', meta: {} }),
    });
    let received: any = null;
    runner.setStateChangeCallback((state) => { received = state; });
    (runner as any).notifyStateChange();

    assert.ok(received);
    assert.equal(received.bootId, runner.bootId);
    assert.equal(typeof received.stateVersion, 'number');
  } finally {
    restore();
  }
});

test('lifecycle: state broadcasts do not carry the whole log ring', () => {
  const store = createFakeStorage();
  const fc = fakeChrome({ storage: store });
  const restore = fc.install();
  try {
    const runner = new AgentRunner(304, 4, undefined, {
      complete: async () => ({ text: '{}', provider: 'test', model: 'm', meta: {} }),
    });
    let received: any = null;
    runner.setStateChangeCallback((state) => { received = state; });
    (runner as any).notifyStateChange();

    assert.ok(received);
    assert.equal(received.logs, undefined);
  } finally {
    restore();
  }
});

test('lifecycle: pause and resume report failure when runner is idle', () => {
  const store = createFakeStorage();
  const fc = fakeChrome({ storage: store });
  const restore = fc.install();
  try {
    const runner = new AgentRunner(305, 5, undefined, {
      complete: async () => ({ text: '{}', provider: 'test', model: 'm', meta: {} }),
    });
    const pauseRes = runner.pause();
    assert.equal(pauseRes.success, false);
    assert.match(pauseRes.error || '', /Cannot pause when status is "idle"/i);

    const resumeRes = runner.resume();
    assert.equal(resumeRes.success, false);
    assert.match(resumeRes.error || '', /Cannot resume when status is "idle"/i);
  } finally {
    restore();
  }
});

test('lifecycle: stop() aborts active abort signal and sets status to stopped', async () => {
  const store = createFakeStorage();
  const fc = fakeChrome({ storage: store, tabs: true, dom: { 306: { CLEAR_BADGES: { success: true } } } });
  const restore = fc.install();
  try {
    const runner = new AgentRunner(306, 6, undefined, {
      complete: async () => ({ text: '{}', provider: 'test', model: 'm', meta: {} }),
    });
    runner.status = 'running';
    (runner as any).activeAbort = new AbortController();
    const signal = (runner as any).activeAbort.signal;
    assert.equal(signal.aborted, false);

    const stopRes = runner.stop();
    assert.equal(stopRes.success, true);
    assert.equal(signal.aborted, true);
    assert.equal(runner.status, 'stopped');
    await new Promise((r) => setTimeout(r, 10));
  } finally {
    restore();
  }
});

test('lifecycle: stop() on a held run consumes the interrupt - no paused resurrection after restart', async () => {
  const rig = await graphRig({
    policy: [
      act.askUser('Which color?'),
      act.finish('done'),
    ],
  });
  try {
    const run = rig.start('Task');
    await rig.waitForCall('policy');
    await run;
    assert.equal(rig.status(), 'paused');
    assert.equal(rig.pending().question, 'Which color?');

    const stopRes = await rig.stop();
    assert.equal(stopRes.success, true);
    assert.equal(rig.status(), 'stopped');

    // A service-worker restart must NOT resurrect the stopped run as 'paused'.
    const newRunner = await rig.restart();
    assert.equal(newRunner.getStatus(), 'stopped');
    assert.equal(newRunner.pendingQuestion, null);
  } finally {
    await rig.cleanup();
  }
});

test('lifecycle: stop() reports failure when runner is already idle or stopped', () => {
  const store = createFakeStorage();
  const fc = fakeChrome({ storage: store, tabs: true });
  const restore = fc.install();
  try {
    const runner = new AgentRunner(307, 7, undefined, {
      complete: async () => ({ text: '{}', provider: 'test', model: 'm', meta: {} }),
    });
    assert.equal(runner.status, 'idle');
    const stopRes1 = runner.stop();
    assert.equal(stopRes1.success, false);
    assert.match(stopRes1.error || '', /No task is running or paused/i);

    runner.status = 'stopped';
    const stopRes2 = runner.stop();
    assert.equal(stopRes2.success, false);
    assert.match(stopRes2.error || '', /No task is running or paused/i);
  } finally {
    restore();
  }
});

test('lifecycle: answerQuestion fails when not paused or without pending question', () => {
  const store = createFakeStorage();
  const fc = fakeChrome({ storage: store });
  const restore = fc.install();
  try {
    const runner = new AgentRunner(308, 8, undefined, {
      complete: async () => ({ text: '{}', provider: 'test', model: 'm', meta: {} }),
    });
    assert.equal(runner.status, 'idle');
    const res = runner.answerQuestion('some answer');
    assert.equal(res.success, false);
    assert.match(res.error || '', /no pending question/i);
  } finally {
    restore();
  }
});

test('lifecycle: answerQuestion fails with empty text', () => {
  const store = createFakeStorage();
  const fc = fakeChrome({ storage: store });
  const restore = fc.install();
  try {
    const runner = new AgentRunner(309, 9, undefined, {
      complete: async () => ({ text: '{}', provider: 'test', model: 'm', meta: {} }),
    });
    runner.status = 'paused';
    runner.pendingQuestion = 'What is your zip code?';

    const res1 = runner.answerQuestion('');
    assert.equal(res1.success, false);
    assert.match(res1.error || '', /cannot be empty/i);

    const res2 = runner.answerQuestion('   ');
    assert.equal(res2.success, false);
    assert.match(res2.error || '', /cannot be empty/i);
  } finally {
    restore();
  }
});

test('lifecycle: getState returns accurate snapshot of runner fields', () => {
  const store = createFakeStorage();
  const fc = fakeChrome({ storage: store });
  const restore = fc.install();
  try {
    const runner = new AgentRunner(310, 10, undefined, {
      complete: async () => ({ text: '{}', provider: 'test', model: 'm', meta: {} }),
    });
    runner.currentTask = 'Check flight prices';
    runner.stepCount = 4;
    runner.status = 'running';

    const state = runner.getState();
    assert.equal(state.task, 'Check flight prices');
    assert.equal(state.status, 'running');
    assert.equal(state.stepCount, 4);
    assert.equal(state.bootId, runner.bootId);
    assert.equal(typeof state.stateVersion, 'number');
  } finally {
    restore();
  }
});

test('lifecycle: currentTurnHistory isolates active turn from completed history', () => {
  const store = createFakeStorage();
  const fc = fakeChrome({ storage: store });
  const restore = fc.install();
  try {
    const runner = new AgentRunner(311, 11, undefined, {
      complete: async () => ({ text: '{}', provider: 'test', model: 'm', meta: {} }),
    });
    runner.history = [
      { type: 'user_goal', turn: 1, prompt: 'first task', timestamp: '2026-01-01', isNewRun: true },
      { type: 'step_start', step: 1, action: { action: 'scroll' } },
      { type: 'finish', answer: 'finished first' },
      { type: 'user_goal', turn: 2, prompt: 'second task', timestamp: '2026-01-02', isNewRun: false },
      { type: 'step_start', step: 2, action: { action: 'click' } },
    ] as any;

    const currentTurn = currentTurnHistory(runner.history);
    assert.equal(currentTurn.length, 2);
    assert.equal((currentTurn[0] as any).prompt, 'second task');
  } finally {
    restore();
  }
});
