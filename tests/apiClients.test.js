import test from 'node:test';
import assert from 'node:assert/strict';
import { spyFetch, jsonResponse } from './helpers/llmWire.ts';

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

// OpenRouter is a LangChain chat model now, so the request is built by the real client and the reply must be
// a real Response. What the test guards is unchanged: the URL, the auth and app headers, and the text back.
test('ApiClients - OpenRouter Completion Success', async (t) => {
  const sent = spyFetch(t, () => jsonResponse({
    choices: [{ message: { content: '{"action": "finish", "answer": "Found 3 papers."}' } }]
  }));

  const settings = { provider: 'openrouter', apiKey: 'sk-or-test-key', model: 'anthropic/claude-3.5-sonnet' };
  const res = await ApiClients.generateCompletion(settings, [{ role: 'user', content: 'Find papers' }], 'System prompt');

  assert.equal(sent.length, 1, 'one request, no hidden retry');
  assert.equal(sent[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(sent[0].headers['authorization'], 'Bearer sk-or-test-key');
  assert.equal(sent[0].headers['x-title'], 'ScoutFox AI Agent');
  assert.equal(sent[0].body.model, 'anthropic/claude-3.5-sonnet');
  assert.deepEqual(sent[0].body.messages, [
    { role: 'system', content: 'System prompt' },
    { role: 'user', content: 'Find papers' }
  ]);
  assert.equal(res, '{"action": "finish", "answer": "Found 3 papers."}');
});

test('ApiClients - NVIDIA Completion Success', async (t) => {
  const sent = spyFetch(t, () => jsonResponse({
    choices: [{ message: { content: '{"action": "finish", "answer": "Found 3 papers."}' } }]
  }));

  const settings = { provider: 'nvidia', apiKey: 'nvapi-test-key', model: 'meta/llama-3.3-70b-instruct' };
  const res = await ApiClients.generateCompletion(settings, [{ role: 'user', content: 'Find papers' }], 'System prompt');

  assert.equal(sent.length, 1, 'one request, no hidden retry');
  assert.equal(sent[0].url, 'https://integrate.api.nvidia.com/v1/chat/completions');
  assert.equal(sent[0].headers['authorization'], 'Bearer nvapi-test-key');
  assert.equal(sent[0].body.model, 'meta/llama-3.3-70b-instruct');
  assert.deepEqual(sent[0].body.messages, [
    { role: 'system', content: 'System prompt' },
    { role: 'user', content: 'Find papers' }
  ]);
  assert.equal(res, '{"action": "finish", "answer": "Found 3 papers."}');
});

test('ApiClients - OpenRouter Missing API Key Error', async (t) => {
  const sent = spyFetch(t);
  const settings = { provider: 'openrouter', apiKey: '', model: 'anthropic/claude-3.5-sonnet' };

  await assert.rejects(
    async () => ApiClients.generateCompletion(settings, [{ role: 'user', content: 'Task' }], 'System'),
    /OpenRouter API Key is missing/
  );
  assert.equal(sent.length, 0, 'the missing key is found before any request');
});

test('ApiClients - NVIDIA Missing API Key Error', async (t) => {
  const sent = spyFetch(t);
  const settings = { provider: 'nvidia', apiKey: '', model: 'meta/llama-3.3-70b-instruct' };

  await assert.rejects(
    async () => ApiClients.generateCompletion(settings, [{ role: 'user', content: 'Task' }], 'System'),
    /NVIDIA API Key is missing/
  );
  assert.equal(sent.length, 0, 'the missing key is found before any request');
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
