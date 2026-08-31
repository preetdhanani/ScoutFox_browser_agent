import test from 'node:test';
import assert from 'node:assert/strict';

// Mock storage
const mockStore = {};
global.chrome = {
  storage: {
    local: {
      get: (keys, cb) => {
        const res = {};
        keys.forEach(k => res[k] = mockStore[k]);
        cb(res);
      },
      set: (items, cb) => {
        Object.assign(mockStore, items);
        if (cb) cb();
      }
    }
  }
};

const { ApiClients } = await import('../background/apiClients.js');

test('ApiClients - OpenRouter Completion Success', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(opts.headers['Authorization'], 'Bearer sk-or-test-key');
    assert.equal(opts.headers['X-Title'], 'ScoutFox AI Agent');
    
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '{"action": "finish", "answer": "Found 3 papers."}' } }]
      })
    };
  };

  const settings = { provider: 'openrouter', apiKey: 'sk-or-test-key', model: 'anthropic/claude-3.5-sonnet' };
  const res = await ApiClients.generateCompletion(settings, [{ role: 'user', content: 'Find papers' }], 'System prompt');
  
  assert.ok(res.includes('"finish"'));
  global.fetch = originalFetch;
});

test('ApiClients - OpenRouter Missing API Key Error', async () => {
  const settings = { provider: 'openrouter', apiKey: '', model: 'anthropic/claude-3.5-sonnet' };
  
  await assert.rejects(
    async () => ApiClients.generateCompletion(settings, [{ role: 'user', content: 'Task' }], 'System'),
    /OpenRouter API Key is missing/
  );
});

test('ApiClients - OpenRouter Model Listing Fetch & Fallbacks', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/models');
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: [{ id: 'anthropic/claude-3.5-sonnet' }, { id: 'deepseek/deepseek-r1' }]
      })
    };
  };

  const settings = { provider: 'openrouter', apiKey: 'sk-or-test-key' };
  const models = await ApiClients.fetchAvailableModels(settings, true);

  assert.equal(models.length, 2);
  assert.equal(models[0], 'anthropic/claude-3.5-sonnet');
  global.fetch = originalFetch;
});

test('ApiClients - Ollama Connection Failure Guard', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error('fetch failed ECONNREFUSED');
  };

  const settings = { provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'qwen2.5:14b' };
  await assert.rejects(
    async () => ApiClients.generateCompletion(settings, [{ role: 'user', content: 'Task' }], 'System'),
    /Cannot connect to Ollama at http:\/\/localhost:11434/
  );

  global.fetch = originalFetch;
});
