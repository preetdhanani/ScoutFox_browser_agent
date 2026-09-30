/**
 * The shim (background/apiClients.js) around the LLM layer.
 *
 * What is pinned: the shim keeps every member that the engine, the background script and the tests use, and each
 * one reaches the provider it is named after. Since P2-3 every provider is served by src/background/llm, Ollama and
 * AgentRouter included, so nothing is left in the shim itself. The deadline and the abort of each provider are
 * pinned in deadline.test.ts and pause.test.ts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spyFetch } from '../helpers/llmWire.ts';

globalThis.chrome = {
  storage: { local: { get: (keys, cb) => cb({}), set: (items, cb) => cb && cb() } }
};

const { ApiClients } = await import('../../background/apiClients.js');

const MESSAGES = [{ role: 'user', content: 'hi' }];

test('the shim keeps every member of the old ApiClients', () => {
  for (const member of ['generateCompletion', 'fetchAvailableModels', 'getFallbackModels', 'callOpenRouter', 'callOpenAI', 'callAnthropic', 'callGemini', 'callAgentRouter', 'callOllama']) {
    assert.equal(typeof ApiClients[member], 'function', member);
  }
});

test('callOllama and callAgentRouter reach their own providers, with the caller\'s options', async (t) => {
  const sent = spyFetch(t);
  const schema = { type: 'object', properties: { action: { const: 'go_back' } } };
  assert.equal(await ApiClients.callOllama({ model: 'qwen2.5:14b', baseUrl: 'http://localhost:11434' }, MESSAGES, 'sys', { json: true, schema }), '{"action":"done"}');
  assert.equal(await ApiClients.callAgentRouter({ apiKey: 'sk-test-123', model: 'claude-3-5-sonnet' }, MESSAGES, 'sys'), '{"action":"done"}');

  assert.equal(sent[0].url, 'http://localhost:11434/api/chat');
  assert.deepEqual(sent[0].body.format, schema, 'json and schema go through to Ollama');
  assert.equal(sent[1].url, 'https://agentrouter.org/v1/messages');
});

test('generateCompletion dispatches by settings.provider, ollama and agent_router included', async (t) => {
  const sent = spyFetch(t);
  await ApiClients.generateCompletion({ provider: 'ollama', model: 'qwen2.5:14b' }, MESSAGES, 'sys');
  await ApiClients.generateCompletion({ provider: 'agent_router', apiKey: 'sk-test-123' }, MESSAGES, 'sys');
  await ApiClients.generateCompletion({ provider: 'openai', apiKey: 'sk-test-123' }, MESSAGES, 'sys');
  assert.deepEqual(sent.map((request) => request.url), [
    'http://localhost:11434/api/chat',
    'https://agentrouter.org/v1/messages',
    'https://api.openai.com/v1/chat/completions'
  ]);
});

test('an unknown provider is refused by name', async () => {
  await assert.rejects(ApiClients.generateCompletion({ provider: 'nope' }, MESSAGES, 'sys'), { message: 'Unsupported LLM provider: nope' });
});

test('generateCompletion can be replaced on the object, which is how the engine tests stub the model', async () => {
  const real = ApiClients.generateCompletion;
  ApiClients.generateCompletion = async () => 'from the stub';
  try {
    assert.equal(await ApiClients.generateCompletion({}, MESSAGES, 'sys'), 'from the stub');
  } finally {
    ApiClients.generateCompletion = real;
  }
});

test('callOpenAI serves openai_compatible with the Groq default and every other provider as openai', async (t) => {
  const sent = spyFetch(t);
  await ApiClients.callOpenAI({ provider: 'openai_compatible', apiKey: 'gsk-test-123' }, MESSAGES, 'sys');
  await ApiClients.callOpenAI({ provider: 'openai', apiKey: 'sk-test-123' }, MESSAGES, 'sys');
  await ApiClients.callOpenAI({ apiKey: 'sk-test-123' }, MESSAGES, 'sys');
  assert.deepEqual(sent.map((r) => r.url), [
    'https://api.groq.com/openai/v1/chat/completions',
    'https://api.openai.com/v1/chat/completions',
    'https://api.openai.com/v1/chat/completions'
  ]);
});
