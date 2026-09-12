/**
 * Regression tests for a real user report: a Make.com/Airtable task died at action 4 on
 *
 *   LLM Connection Error (agent_router): Provider [agent_router] did not respond within 120s.
 *   The request was abandoned - check that the endpoint and model are reachable, or raise
 *   llmTimeoutMs in settings.
 *
 * Before this fix, agentEngine.js's Phase 2 LLM call had no retry at all - one failure set
 * status='idle' and returned, and resume() then refuses because it requires status==='paused'.
 * The task was gone for good, with no way back in short of re-running it from scratch.
 *
 * Now a transient failure gets retried (harness/recovery.js), and only once every retry is
 * spent does the run stop - by pausing, not going idle, so the existing Resume button (which
 * already preserves stepCount/history/planSteps) continues from the exact step that failed.
 *
 * Drives engine.runLoopBody()/engine.resume() directly, same idiom as
 * tests/localModels.test.js's parse-circuit-breaker tests: DOM read and planning are stubbed
 * out so only the LLM-call/retry path under test is exercised.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const STORED = {
  agent_settings: {
    provider: 'agent_router',
    baseUrl: 'https://agentrouter.org/v1',
    model: 'claude-3-5-sonnet',
    maxSteps: 25
  }
};

global.chrome = {
  storage: { local: { get: (keys, cb) => cb(STORED), set: (data, cb) => cb && cb() } },
  tabs: {
    get: (id, cb) => cb({ id, groupId: -1, url: 'https://example.com' }),
    query: async () => [{ id: 101, url: 'https://example.com' }],
    sendMessage: (tabId, msg, cb) => cb({ success: true }),
    group: (opts, cb) => cb(999)
  },
  tabGroups: { update: (id, opts, cb) => cb && cb() }
};

const { ApiClients } = await import('../background/apiClients.js');
const { AgentEngine } = await import('../background/agentEngine.js');
const { LLM_MAX_ATTEMPTS } = await import('../background/harness/recovery.js');

function freshEngine() {
  const engine = new AgentEngine();
  engine.getTabDOMWithAutoInject = async () => ({
    elementCount: 3,
    elements: '[1] <button> Go',
    pageText: 'hello',
    title: 'Test',
    url: 'https://example.com',
    scrollState: { scrollY: 0, pageHeight: 1000, viewportHeight: 800 }
  });
  engine.generatePlan = async () => [];
  engine.persistState = async () => {};
  engine.notifyStateChange = () => {};
  engine.currentTask = 'do a thing';
  engine.status = 'running';
  engine.activeTabId = 101;
  engine.stepCount = 0;
  engine.history = [{ type: 'user_goal', turn: 1, prompt: 'do a thing' }];
  return engine;
}

test('a transient LLM failure recovers after retrying, with no failure trace left behind', async () => {
  const engine = freshEngine();
  await engine.restorePromise;

  let calls = 0;
  const realCompletion = ApiClients.generateCompletion;
  ApiClients.generateCompletion = async () => {
    calls++;
    if (calls < 3) throw new Error('socket hang up');
    return JSON.stringify({ action: 'finish', answer: 'all good' });
  };

  try {
    await engine.runLoopBody();
  } finally {
    ApiClients.generateCompletion = realCompletion;
  }

  assert.equal(calls, 3, 'must retry a failed call instead of giving up on the first failure');
  assert.equal(engine.status, 'idle', 'a run that recovers finishes normally');
  assert.equal(engine.history.filter((h) => h.type === 'error').length, 0,
    'a retry that succeeds must leave no failure trace in history');
  assert.equal(engine.history.find((h) => h.type === 'finish')?.answer, 'all good');
});

test('an LLM failure that outlasts every retry pauses the run instead of killing it', async () => {
  const engine = freshEngine();
  await engine.restorePromise;

  let calls = 0;
  const realCompletion = ApiClients.generateCompletion;
  ApiClients.generateCompletion = async () => {
    calls++;
    throw new Error('Provider [agent_router] did not respond within 120s.');
  };

  try {
    await engine.runLoopBody();
  } finally {
    ApiClients.generateCompletion = realCompletion;
  }

  assert.equal(calls, LLM_MAX_ATTEMPTS, `must give up only after ${LLM_MAX_ATTEMPTS} attempts`);
  assert.equal(engine.status, 'paused', 'must stay resumable instead of dying as idle');
  assert.equal(engine.isLoopActive, false);

  const err = engine.history.filter((h) => h.type === 'error').pop();
  assert.ok(err, 'the user must see why it stopped');
  assert.match(err.content, /agent_router/, 'must name the provider that failed');
  assert.match(err.content, new RegExp(`${LLM_MAX_ATTEMPTS} attempts`), 'must say how many attempts were made');
  assert.equal(err.step, engine.stepCount, 'must name the exact step it paused at');
});

test('resuming after an exhausted-retry pause continues the same run from the same step', async () => {
  const engine = freshEngine();
  await engine.restorePromise;

  const realCompletion = ApiClients.generateCompletion;
  ApiClients.generateCompletion = async () => { throw new Error('temporary outage'); };
  try {
    await engine.runLoopBody();
  } finally {
    ApiClients.generateCompletion = realCompletion;
  }
  assert.equal(engine.status, 'paused');
  const stepAtPause = engine.stepCount;
  assert.ok(stepAtPause >= 1);

  // This is exactly what the panel's Resume button calls. Before this fix resume() correctly
  // refused ("Cannot resume: the agent is idle...") because the old code path always went idle.
  ApiClients.generateCompletion = async () => JSON.stringify({ action: 'finish', answer: 'done after resume' });
  const resumeResult = engine.resume();
  assert.equal(resumeResult.success, true, 'Resume must accept the pause this run just set');

  // resume() fires the loop itself (fire-and-forget) - give it a moment to run to completion.
  await new Promise((r) => setTimeout(r, 100));
  ApiClients.generateCompletion = realCompletion;

  assert.equal(engine.status, 'idle', 'the resumed run must be able to finish');
  assert.ok(engine.stepCount >= stepAtPause, 'stepCount must carry forward, not reset to 0');
  assert.equal(engine.history.find((h) => h.type === 'finish')?.answer, 'done after resume');
});

test('a genuine user Stop landing during the LLM call is never retried or mislabelled as a connection error', async () => {
  const engine = freshEngine();
  await engine.restorePromise;

  let calls = 0;
  const realCompletion = ApiClients.generateCompletion;
  ApiClients.generateCompletion = async () => {
    calls++;
    // Simulate the user pressing Stop while this exact request is in flight.
    engine.status = 'stopped';
    throw new Error('some transport noise unrelated to abort wording');
  };

  try {
    await engine.runLoopBody();
  } finally {
    ApiClients.generateCompletion = realCompletion;
  }

  assert.equal(calls, 1, 'a user Stop must not trigger any retry attempts');
  assert.equal(engine.status, 'stopped', 'the user\'s own Stop must not be overwritten by the retry/pause path');
  assert.equal(engine.history.filter((h) => h.type === 'error').length, 0,
    'a user-initiated stop is not a reportable failure');
});
