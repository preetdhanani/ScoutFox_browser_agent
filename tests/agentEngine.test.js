import test from 'node:test';
import assert from 'node:assert/strict';

// Mock storage & chrome APIs
const mockStorageData = {};
global.chrome = {
  storage: {
    local: {
      get: (keys, cb) => {
        const res = {};
        keys.forEach(k => res[k] = mockStorageData[k]);
        cb(res);
      },
      set: (items, cb) => {
        Object.assign(mockStorageData, items);
        if (cb) cb();
      }
    }
  },
  tabs: {
    get: async () => ({ id: 1, url: 'https://example.com' }),
    sendMessage: (id, msg, cb) => cb({ success: true, data: { title: 'Ex', url: 'https://ex.com', scrollState: {}, elementCount: 0, elementsText: '' } }),
    onUpdated: { addListener: () => {}, removeListener: () => {} },
    onActivated: { addListener: () => {} },
    onCreated: { addListener: () => {} }
  }
};

const { AgentEngine } = await import('../background/agentEngine.js');

test('AgentEngine - Response Parsing for <thought> and JSON actions', () => {
  const engine = new AgentEngine();

  const sampleLLMOutput = `<thought>
I need to search for papers on LLM evaluation by typing into element 3.
</thought>
\`\`\`json
{
  "action": "type",
  "element_id": 3,
  "text": "LLM evaluation research papers",
  "submit": true,
  "reason": "Search for papers"
}
\`\`\``;

  const result = engine.parseResponse(sampleLLMOutput);
  assert.equal(result.thought, 'I need to search for papers on LLM evaluation by typing into element 3.');
  assert.equal(result.action.action, 'type');
  assert.equal(result.action.element_id, 3);
  assert.equal(result.action.text, 'LLM evaluation research papers');
});

test('AgentEngine - Universal Guardrail 1: Regex Intent Extraction for Dumber Models', () => {
  const engine = new AgentEngine();

  // Plain text from a dumber model without JSON
  const plainTextOutput = `I analyzed the page. Action: click element 4 to view README file.`;

  const result = engine.parseResponse(plainTextOutput, 10);
  assert.equal(result.action.action, 'click');
  assert.equal(result.action.element_id, 4);
});

test('AgentEngine - Universal Guardrail 2: Element ID Hallucination Clamping', () => {
  const engine = new AgentEngine();

  // Model hallucinated element_id: 45 when page only has 8 elements
  const hallucinatedOutput = `\`\`\`json\n{"action": "click", "element_id": 45}\n\`\`\``;

  const result = engine.parseResponse(hallucinatedOutput, 8);
  assert.equal(result.action.action, 'click');
  assert.equal(result.action.element_id, 8); // Clamped to max 8
});

test('AgentEngine - Universal Guardrail 3: Action Schema Normalization', () => {
  const engine = new AgentEngine();

  // Non-standard key names (elementId instead of element_id, done instead of finish)
  const nonStandardOutput = `\`\`\`json\n{"action": "done", "elementId": "3"}\n\`\`\``;

  const result = engine.parseResponse(nonStandardOutput, 10);
  assert.equal(result.action.action, 'finish');
});

test('AgentEngine - DeepSeek R1 <think> Tag Support & JSON Parsing', () => {
  const engine = new AgentEngine();

  const deepSeekOutput = `<think>
Analyzing the page elements... Element 5 is the main search box for GitHub repos.
</think>
\`\`\`json
{
  "action": "type",
  "element_id": 5,
  "text": "agentic browser",
  "submit": true
}
\`\`\``;

  const result = engine.parseResponse(deepSeekOutput);
  assert.equal(result.thought, 'Analyzing the page elements... Element 5 is the main search box for GitHub repos.');
  assert.equal(result.action.action, 'type');
  assert.equal(result.action.element_id, 5);
});

test('AgentEngine - Freeform Text Direct Summary Auto-Wrapping', () => {
  const engine = new AgentEngine();

  const freeformTextOutput = `<think>
I have gathered all information from the README file.
</think>
Here is the summary of the ScoutFox README file:
1. ScoutFox is an autonomous AI browser agent.
2. Supports OpenRouter, AgentRouter, Ollama, Gemini, and OpenAI.
3. Built with Manifest V3 and Studio Mono design system.`;

  const result = engine.parseResponse(freeformTextOutput);
  assert.equal(result.thought, 'I have gathered all information from the README file.');
  assert.equal(result.action.action, 'finish');
  assert.ok(result.action.answer.includes('ScoutFox is an autonomous AI browser agent'));
});

test('AgentEngine - Instant Plan Checklist Initialization', () => {
  const engine = new AgentEngine();
  engine.planSteps = [
    { id: 1, text: 'Inspect & index webpage interactive elements', status: 'in_progress' },
    { id: 2, text: 'Plan sub-goals and execute browser actions', status: 'pending' },
    { id: 3, text: 'Extract target data & synthesize answer', status: 'pending' }
  ];

  assert.equal(engine.planSteps.length, 3);
  assert.equal(engine.planSteps[0].status, 'in_progress');
});

test('AgentEngine - Zombie Status Auto-Recovery on SW Restart', async () => {
  mockStorageData.agent_session = {
    task: 'Previous interrupted task',
    history: [],
    planSteps: [],
    stepCount: 4,
    status: 'running'
  };

  const engine = new AgentEngine();
  await engine.restoreState();

  assert.equal(engine.status, 'idle');
});
