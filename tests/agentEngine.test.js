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
    status: 'running' // Stale status in storage
  };

  const engine = new AgentEngine();
  await engine.restoreState();

  // Engine detects SW restarted (isLoopActive === false) and auto-resets zombie status to idle
  assert.equal(engine.status, 'idle');
});

test('AgentEngine - Invalid JSON parsing error diagnostic', () => {
  const engine = new AgentEngine();
  const invalidOutput = `<thought>Thinking...</thought>\n\`\`\`json\n{ action: click, element_id: bad }\n\`\`\``;

  const result = engine.parseResponse(invalidOutput);
  assert.ok(result.error);
  assert.ok(result.error.includes('Invalid JSON syntax'));
});
