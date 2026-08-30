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
  global.chrome.storage.local.get = (keys, cb) => cb({
    agent_session: {
      history: [],
      planSteps: [],
      stepCount: 4,
      status: 'running'
    }
  });

  const engine = new AgentEngine();
  await engine.restoreState();

  assert.equal(engine.status, 'idle');
});
