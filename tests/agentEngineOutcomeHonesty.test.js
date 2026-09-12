/**
 * Regression tests for "never lies about whether it finished".
 *
 * Before this fix, three separate paths could end a run as an apparent success:
 *   1. Reaching maxSteps pushed {type:'finish'}, rendered as a green "Done" card identical to
 *      a real completion, and re-injected into the NEXT turn's prompt by previousTurnsSummary()
 *      as if the task had genuinely been completed.
 *   2. parseResponse's freeform-prose guardrail (stage 6) turned any garbled non-JSON reply
 *      into an invented finish - a model that failed to answer looked identical to one that
 *      succeeded.
 *   3. An explicit `finish` with no answer field was reported as "Task completed successfully."
 *      - a claim the model never actually made.
 *
 * See harness/outcome.js and tests/harnessOutcome.test.js for the isolated unit tests of the
 * classification logic; this file drives the real engine loop the way the panel does.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const STORED = {
  agent_settings: { provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'test-model', maxSteps: 2 }
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

function freshEngine(maxSteps = 2) {
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

test('running out of steps is reported as an error, never as a fake finish', async () => {
  const engine = freshEngine(2);
  await engine.restorePromise;

  const realCompletion = ApiClients.generateCompletion;
  // A real, valid action that is never `finish` - the loop burns every step without the model
  // ever declaring itself done, until it hits the step ceiling.
  ApiClients.generateCompletion = async () => JSON.stringify({ action: 'scroll', direction: 'down' });

  try {
    await engine.runLoopBody();
  } finally {
    ApiClients.generateCompletion = realCompletion;
  }

  assert.equal(engine.history.some((h) => h.type === 'finish'), false,
    'an unfinished run must never contain a finish entry');
  const stepLimitEntry = engine.history.filter((h) => h.type === 'error').pop();
  assert.ok(stepLimitEntry, 'must record why it stopped');
  assert.match(stepLimitEntry.content, /2/);

  // previousTurnsSummary() only recaps 'finish' entries - confirm this run is excluded, so a
  // future turn's prompt does not present the unfinished run as completed work.
  const recap = engine.previousTurnsSummary();
  assert.equal(recap.length, 0, 'an unfinished run must not be recapped as completed work');
});

test('finish with a real answer is not flagged unconfirmed', async () => {
  const engine = freshEngine(5);
  await engine.restorePromise;

  const realCompletion = ApiClients.generateCompletion;
  ApiClients.generateCompletion = async () => JSON.stringify({ action: 'finish', answer: 'The price is $120.' });
  try {
    await engine.runLoopBody();
  } finally {
    ApiClients.generateCompletion = realCompletion;
  }

  const finish = engine.history.find((h) => h.type === 'finish');
  assert.equal(finish.answer, 'The price is $120.');
  assert.equal(finish.unconfirmed, undefined);
});

test('finish with no answer is reported honestly instead of inventing a success message', async () => {
  const engine = freshEngine(5);
  await engine.restorePromise;

  const realCompletion = ApiClients.generateCompletion;
  ApiClients.generateCompletion = async () => JSON.stringify({ action: 'finish' });
  try {
    await engine.runLoopBody();
  } finally {
    ApiClients.generateCompletion = realCompletion;
  }

  const finish = engine.history.find((h) => h.type === 'finish');
  assert.notEqual(finish.answer, 'Task completed successfully.');
});

test('raw prose the model never wrapped in JSON is auto-completed but flagged unconfirmed', async () => {
  const engine = freshEngine(5);
  await engine.restorePromise;

  const realCompletion = ApiClients.generateCompletion;
  // Not JSON, and matches none of parseResponse's plain-English intent patterns (no click/type/
  // navigate/scroll/read wording) - only the freeform auto-wrap guardrail can turn this into an
  // action at all.
  ApiClients.generateCompletion = async () => 'I am not sure how to proceed with this task.';
  try {
    await engine.runLoopBody();
  } finally {
    ApiClients.generateCompletion = realCompletion;
  }

  const finish = engine.history.find((h) => h.type === 'finish');
  assert.ok(finish, 'the run must still end, not hang forever on unparseable prose');
  assert.equal(finish.unconfirmed, true,
    'an inferred ending must be distinguishable from a real, confirmed finish action');
});
