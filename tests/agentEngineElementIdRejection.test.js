/**
 * Engine-level regression test: a hallucinated element_id must give the model a chance to
 * correct itself (the same parse-error/retry path as malformed JSON), not silently execute a
 * click on whatever real element happened to sit at the clamped id. See
 * tests/agentEngine.test.js and tests/criticalRegressions.test.js for the parseResponse-level
 * unit tests of the rejection itself.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const STORED = {
  agent_settings: { provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'test-model', maxSteps: 10 }
};

global.chrome = {
  runtime: { lastError: null },
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
    elementCount: 3, // element_id 99 below is nowhere near valid
    elements: '[1] <button> Go\n[2] <a> Docs\n[3] <input> Search',
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

test('a hallucinated element_id is never dispatched as an execution_result - it is corrected via a retry instead', async () => {
  const engine = freshEngine();
  await engine.restorePromise;

  let calls = 0;
  const realCompletion = ApiClients.generateCompletion;
  ApiClients.generateCompletion = async () => {
    calls++;
    if (calls === 1) return JSON.stringify({ action: 'click', element_id: 99, reason: 'hallucinated' });
    if (calls === 2) return JSON.stringify({ action: 'click', element_id: 2, reason: 'the real Docs link' });
    return JSON.stringify({ action: 'finish', answer: 'done' });
  };

  try {
    await engine.runLoopBody();
  } finally {
    ApiClients.generateCompletion = realCompletion;
  }

  assert.equal(calls, 3, 'the model must be re-prompted after the rejection, not just given up on');

  // The rejected attempt must never reach the page: no agent_response carries element_id 99,
  // and no execution_result was produced for it (execution_result only comes from actually
  // dispatching to the tab).
  const dispatchedIds = engine.history
    .filter((h) => h.type === 'agent_response' && h.action && h.action.element_id !== undefined)
    .map((h) => h.action.element_id);
  assert.ok(!dispatchedIds.includes(99), 'the hallucinated id must never appear as a dispatched action');
  assert.ok(dispatchedIds.includes(2), 'the corrected, valid click must go through normally');

  const parseError = engine.history.find((h) => h.type === 'execution_result' && h.success === false && /element_id/i.test(h.error || ''));
  assert.ok(parseError, 'the model must see a corrective message naming element_id, not a generic failure');
});
