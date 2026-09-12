/**
 * Regression test: generatePlan() called ApiClients.generateCompletion with no `signal` at
 * all, so Pause/Stop pressed while a task was still generating its initial plan could not
 * cancel that in-flight request - it ran to completion (or the full llmTimeoutMs) regardless
 * of the user's own action.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

global.chrome = {
  storage: { local: { get: (keys, cb) => cb({}), set: (data, cb) => cb && cb() } },
  tabs: { get: (id, cb) => cb({ id, groupId: -1, url: 'https://example.com' }), query: async () => [] }
};

const { ApiClients } = await import('../background/apiClients.js');
const { AgentEngine } = await import('../background/agentEngine.js');

test('generatePlan forwards the engine abort signal to the LLM call', async () => {
  const engine = new AgentEngine();
  engine.abortController = new AbortController();
  engine.currentTask = 'do a thing';

  let capturedOptions = null;
  const realCompletion = ApiClients.generateCompletion;
  ApiClients.generateCompletion = async (settings, messages, systemPrompt, options) => {
    capturedOptions = options;
    return JSON.stringify(['Step one', 'Step two']);
  };

  try {
    await engine.generatePlan('do a thing', {});
  } finally {
    ApiClients.generateCompletion = realCompletion;
  }

  assert.ok(capturedOptions, 'the planner call must actually pass options through');
  assert.equal(capturedOptions.signal, engine.abortController.signal,
    'Pause/Stop must be able to cancel plan generation, not just the main action loop');
});

test('aborting during plan generation still leaves a usable fallback plan, not a stuck task', async () => {
  const engine = new AgentEngine();
  engine.abortController = new AbortController();
  engine.currentTask = 'do a thing';

  const realCompletion = ApiClients.generateCompletion;
  ApiClients.generateCompletion = async (settings, messages, systemPrompt, options) => {
    engine.abortController.abort();
    const err = new Error('The user aborted a request.');
    err.name = 'AbortError';
    throw err;
  };

  try {
    await engine.generatePlan('do a thing', {});
  } finally {
    ApiClients.generateCompletion = realCompletion;
  }

  assert.ok(Array.isArray(engine.planSteps) && engine.planSteps.length > 0,
    'an aborted plan generation must still fall back to a usable checklist');
});
