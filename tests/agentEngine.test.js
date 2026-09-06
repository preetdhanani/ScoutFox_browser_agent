import test from 'node:test';
import assert from 'node:assert/strict';

// Mock Chrome APIs before importing AgentEngine
global.chrome = {
  storage: {
    local: {
      get: (keys, cb) => cb({}),
      set: (data, cb) => cb && cb()
    }
  },
  tabs: {
    get: (id, cb) => cb({ id, groupId: -1, url: 'https://example.com' }),
    query: async () => [{ id: 101, url: 'https://example.com' }],
    sendMessage: (tabId, msg, cb) => cb({ success: true })
  }
};

import { AgentEngine } from '../background/agentEngine.js';

test('AgentEngine - Parse DeepSeek <think> reasoning tags', () => {
  const engine = new AgentEngine();
  const rawOutput = `<think>
I need to click the search button on element [3].
</think>
\`\`\`json
{
  "action": "click",
  "element_id": 3,
  "reason": "Click search button"
}
\`\`\``;

  const result = engine.parseResponse(rawOutput, 10);
  assert.equal(result.thought, 'I need to click the search button on element [3].');
  assert.equal(result.action.action, 'click');
  assert.equal(result.action.element_id, 3);
});

test('AgentEngine - Plain text intent extraction for smaller LLMs', () => {
  const engine = new AgentEngine();
  const textOutput = 'I will click on element [5] to continue.';
  
  const result = engine.parseResponse(textOutput, 10);
  assert.equal(result.action.action, 'click');
  assert.equal(result.action.element_id, 5);
});

test('AgentEngine - Element ID Clamping Guardrail', () => {
  const engine = new AgentEngine();
  const output = `\`\`\`json
{
  "action": "click",
  "element_id": 99,
  "reason": "Hallucinated ID"
}
\`\`\``;

  const result = engine.parseResponse(output, 12);
  assert.equal(result.action.element_id, 12); // Clamped to max elements (12)
});

test('AgentEngine - Schema Normalization & Key Aliases', () => {
  const engine = new AgentEngine();
  const output = `\`\`\`json
{
  "action": "click_element",
  "elementId": 2
}
\`\`\``;

  const result = engine.parseResponse(output, 10);
  assert.equal(result.action.action, 'click');
  assert.equal(result.action.element_id, 2);
});

test('AgentEngine - Parse read_page_text Action', () => {
  const engine = new AgentEngine();
  const output = `\`\`\`json
{
  "action": "extract_page_text",
  "reason": "Extract full text body for reading"
}
\`\`\``;

  const result = engine.parseResponse(output, 10);
  assert.equal(result.action.action, 'read_page_text');
});

test('AgentEngine - Parse execute_js Action', () => {
  const engine = new AgentEngine();
  const output = `\`\`\`json
{
  "action": "eval_js",
  "code": "return document.title",
  "world": "MAIN"
}
\`\`\``;

  const result = engine.parseResponse(output, 10);
  assert.equal(result.action.action, 'execute_js');
  assert.equal(result.action.code, 'return document.title');
});

test('AgentEngine - Parse Truncated execute_js Action Payload', () => {
  const engine = new AgentEngine();
  const truncatedOutput = `\`\`\`json
{
  "action": "execute_js",
  "code": "const reject = document.querySelector('#cookie_action_close_header_reject'); if (reject) reject.click(); const sel = document.querySelector('select'); if (sel) { sel.value = '1'; } const order = [...document.querySelectorAll('button')].find(b => /order now/i.test(b.textContent`;

  const result = engine.parseResponse(truncatedOutput, 10);
  assert.equal(result.action.action, 'execute_js');
  assert.ok(result.action.code.includes('cookie_action_close_header_reject'));
  assert.notEqual(result.action.action, 'finish'); // Proves it did not wrongly fall back to finish action!
});

test('AgentEngine - Parse read_network_requests Action', () => {
  const engine = new AgentEngine();
  const output = `\`\`\`json
{
  "action": "network_requests",
  "filter": { "status": "error" },
  "limit": 5
}
\`\`\``;

  const result = engine.parseResponse(output, 10);
  assert.equal(result.action.action, 'read_network_requests');
});

test('AgentEngine - Parse browser_batch Action', () => {
  const engine = new AgentEngine();
  const output = `\`\`\`json
{
  "action": "batch_actions",
  "steps": [
    { "action": "type", "element_id": 1, "text": "a@b.com" },
    { "action": "click", "element_id": 2 }
  ]
}
\`\`\``;

  const result = engine.parseResponse(output, 10);
  assert.equal(result.action.action, 'browser_batch');
  assert.equal(result.action.steps.length, 2);
});

test('AgentEngine - Redact Sensitive Data in Network Payloads', () => {
  const engine = new AgentEngine();
  const payloadJson = JSON.stringify({
    user: 'testuser',
    password: 'superSecretPassword123',
    apiKey: 'sk-1234567890abcdef',
    token: 'bearer-xyz-123',
    card: '4111222233334444'
  });

  const redacted = engine.redactSensitiveData(payloadJson);
  assert.ok(!redacted.includes('superSecretPassword123'));
  assert.ok(!redacted.includes('sk-1234567890abcdef'));
  assert.ok(redacted.includes('[REDACTED]'));
  assert.ok(redacted.includes('testuser'));
});

// ensureScoutFoxGroup coverage (group creation, reuse, adoption, persistence) lives in
// tests/tabGrouping.test.js against a fuller mock - this file's version only asserted a
// hardcoded stub id, a strict subset of that coverage. Not duplicated here.

test('AgentEngine - clearHistory resets state', () => {
  const engine = new AgentEngine();
  engine.history = [{ type: 'user_goal', prompt: 'test' }];
  engine.planSteps = [{ id: 1, text: 'step 1' }];
  engine.stepCount = 5;

  engine.clearHistory();

  assert.equal(engine.history.length, 0);
  assert.equal(engine.planSteps.length, 0);
  assert.equal(engine.stepCount, 0);
});

test('AgentEngine - Zombie Running State Reset on Service Worker Restore', async () => {
  // Keyed by windowId ('default', since this engine is constructed with none) - restoreState
  // reads agent_sessions now, not a single global agent_session slot. Seeding the old key here
  // would make this test pass vacuously (nothing restored, status defaults to idle anyway)
  // rather than actually exercising the zombie-status reset it is named for.
  global.chrome.storage.local.get = (keys, cb) => cb({
    agent_sessions: {
      default: {
        history: [],
        planSteps: [],
        stepCount: 4,
        status: 'running'
      }
    }
  });

  const engine = new AgentEngine();
  await engine.restoreState();

  assert.equal(engine.status, 'idle');
});
