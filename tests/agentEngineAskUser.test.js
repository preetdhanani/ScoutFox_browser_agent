/**
 * Regression tests for the ask_user dead end: notifyStateChange({question}) had zero consumers
 * anywhere in the repo (grep confirmed only the emit site and the prompt text reference it), so
 * an agent honest enough to ask for help had no way to actually hear back - the user's only
 * recourse was the plain Resume button, which re-enters the loop with no answer in history.
 *
 * Drives engine.runLoopBody()/engine.answerQuestion() directly, same idiom as
 * tests/agentEngineLlmRetry.test.js and tests/agentEngineOutcomeHonesty.test.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const STORED = {
  agent_settings: { provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'test-model', maxSteps: 10 }
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

test('ask_user pauses the run and records a pending question the panel can show', async () => {
  const engine = freshEngine();
  await engine.restorePromise;

  const realCompletion = ApiClients.generateCompletion;
  ApiClients.generateCompletion = async () => JSON.stringify({ action: 'ask_user', question: 'Which account should I use?' });
  try {
    await engine.runLoopBody();
  } finally {
    ApiClients.generateCompletion = realCompletion;
  }

  assert.equal(engine.status, 'paused');
  assert.equal(engine.pendingQuestion, 'Which account should I use?');
});

test('answerQuestion refuses when nothing is pending', async () => {
  const engine = freshEngine();
  await engine.restorePromise;
  engine.status = 'idle';

  const res = engine.answerQuestion('some answer');
  assert.equal(res.success, false);
  assert.match(res.error, /no pending question/i);
});

test('answerQuestion refuses an empty answer without disturbing the pending question', async () => {
  const engine = freshEngine();
  await engine.restorePromise;
  engine.status = 'paused';
  engine.pendingQuestion = 'Which account?';

  const res = engine.answerQuestion('   ');
  assert.equal(res.success, false);
  assert.equal(engine.pendingQuestion, 'Which account?', 'an empty submission must not clear the question');
});

test('answering resumes the run with the answer recorded and fed back to the model', async () => {
  const engine = freshEngine();
  await engine.restorePromise;

  const realCompletion = ApiClients.generateCompletion;
  ApiClients.generateCompletion = async () => JSON.stringify({ action: 'ask_user', question: 'Which account should I use?' });
  try {
    await engine.runLoopBody();
  } finally {
    ApiClients.generateCompletion = realCompletion;
  }
  assert.equal(engine.status, 'paused');

  let sentMessages = null;
  ApiClients.generateCompletion = async (settings, messages) => {
    sentMessages = messages;
    return JSON.stringify({ action: 'finish', answer: 'Used the primary account, done.' });
  };
  const res = engine.answerQuestion('the primary one');
  assert.equal(res.success, true);

  // answerQuestion() fires the loop itself (fire-and-forget), same pattern as resume().
  await new Promise((r) => setTimeout(r, 50));
  ApiClients.generateCompletion = realCompletion;

  assert.equal(engine.pendingQuestion, null);
  const answerEntry = engine.history.find((h) => h.type === 'user_answer');
  assert.ok(answerEntry, 'the answer must be recorded in history, visible in the panel timeline');
  assert.equal(answerEntry.content, 'the primary one');

  assert.ok(sentMessages, 'the next LLM call must actually happen');
  const sawAnswer = sentMessages.some((m) => m.content && m.content.includes('the primary one'));
  assert.ok(sawAnswer, 'the model must actually see the answer, not just the panel');

  assert.equal(engine.status, 'idle');
  assert.equal(engine.history.find((h) => h.type === 'finish')?.answer, 'Used the primary account, done.');
});

test('a plain Resume (not answering) also clears the pending question instead of leaving stale UI state', async () => {
  const engine = freshEngine();
  await engine.restorePromise;
  engine.status = 'paused';
  engine.pendingQuestion = 'Which account?';

  const realCompletion = ApiClients.generateCompletion;
  ApiClients.generateCompletion = async () => JSON.stringify({ action: 'finish', answer: 'proceeded without an answer' });

  const res = engine.resume();
  assert.equal(res.success, true);
  await new Promise((r) => setTimeout(r, 50));
  ApiClients.generateCompletion = realCompletion;

  assert.equal(engine.pendingQuestion, null);
});
