/**
 * Regression tests for issues #9, #10, #14 and #16.
 *
 *   #9   The Anthropic client sent `dangerously-allow-browser`, which is the JS SDK's client
 *        OPTION name and not a header. Being unknown, it failed CORS preflight, so the Claude
 *        provider never completed a single call.
 *   #10  generateCompletion accepted an abort signal but only forwarded it to Ollama, so Stop
 *        settled the promise while the HTTP request ran on to completion and kept billing.
 *   #14  Nothing guarded the window between clicking send and the task being accepted, so a
 *        double-click opened two concurrent agent loops against the same tab.
 *   #16  The shipped Groq default was a model Groq has decommissioned, so a fresh Groq setup
 *        failed on its first step.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spyFetch, hangUntilAborted, settledWithin, waitForRequests } from './helpers/llmWire.ts';

global.chrome = {
  runtime: { lastError: null },
  storage: { local: { get: (k, cb) => cb({}), set: (d, cb) => cb && cb() } },
  tabs: {
    get: (id, cb) => cb({ id, groupId: -1, url: 'https://example.com' }),
    query: async () => [{ id: 101, url: 'https://example.com' }],
    sendMessage: (tabId, msg, cb) => cb({ success: true }),
    onUpdated: { addListener: () => {}, removeListener: () => {}, hasListener: () => false }
  }
};

const { ApiClients } = await import('../background/apiClients.js');
const { AgentEngine } = await import('../background/agentEngine.js');
const { DEFAULT_PROVIDER_CONFIGS } = await import('../src/shared/storage.ts');

const MESSAGES = [{ role: 'user', content: 'hi' }];


/* ---------------------------- #9 ---------------------------- */

test('#9 Anthropic client sends the real browser-access header', async (t) => {
  const sent = spyFetch(t);

  await ApiClients.callAnthropic(
    { model: 'claude-3-5-sonnet-20241022', apiKey: 'k', providerConfigs: {} },
    MESSAGES, 'sys', {});

  const headers = sent[0].headers;
  assert.equal(headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(headers['dangerously-allow-browser'], undefined,
    'the SDK option name must not be sent as a header, it fails CORS preflight');
  assert.equal(headers['anthropic-version'], '2023-06-01');
  assert.equal(headers['x-api-key'], 'k');
});


/* ---------------------------- #10 ---------------------------- */

// The request is built by the LangChain client now, so `init.signal` is never the caller's own signal:
// the SDK derives its own from it (Ollama's fetch wrapper merges it with the call's). What the fix guards
// is that Stop reaches the request that is on the wire, so that is what these check: the signal fetch got
// is aborted when the task's signal aborts. Every provider is in the table, Ollama and AgentRouter too.
const SIGNAL_CASES = [
  ['callAnthropic', { model: 'claude-3-5-sonnet-20241022', apiKey: 'k' }],
  ['callOpenAI', { model: 'gpt-4o-mini', apiKey: 'k', baseUrl: 'https://api.openai.com' }],
  ['callGemini', { model: 'gemini-1.5-flash', apiKey: 'k' }],
  ['callOpenRouter', { model: 'x/y', apiKey: 'k', baseUrl: 'https://openrouter.ai/api/v1' }],
  ['callOllama', { model: 'qwen2.5:14b', baseUrl: 'http://localhost:11434' }],
  ['callAgentRouter', { model: 'claude-3-5-sonnet', apiKey: 'k', baseUrl: 'https://agentrouter.org/v1' }],
  ['callNvidia', { model: 'meta/llama-3.3-70b-instruct', apiKey: 'nvapi-123', baseUrl: 'https://integrate.api.nvidia.com/v1' }]
];

for (const [method, settings] of SIGNAL_CASES) {
  test(`#10 ${method} cancels the request on the wire when the task signal aborts`, async (t) => {
    const sent = spyFetch(t, hangUntilAborted);
    const controller = new AbortController();

    const call = ApiClients[method]({ ...settings, providerConfigs: {} }, MESSAGES, 'sys',
      { signal: controller.signal });
    await waitForRequests(sent);
    assert.equal(sent[0].signal.aborted, false, 'the request is in flight');

    controller.abort();

    assert.equal(await settledWithin(call), 'rejected', `${method} kept waiting after the abort`);
    assert.equal(sent[0].signal.aborted, true,
      `${method} dropped the signal, so Stop would not cancel the request`);
  });
}

test('#10 clients still work when no signal is supplied', async (t) => {
  const sent = spyFetch(t);

  const text = await ApiClients.callAnthropic(
    { model: 'claude-3-5-sonnet-20241022', apiKey: 'k', providerConfigs: {} },
    MESSAGES, 'sys');

  assert.equal(text, '{"action":"done"}', 'an absent signal must not crash the call');
  assert.equal(sent.length, 1);
});


/* ---------------------------- #14 ---------------------------- */

test('#14 claimForTask admits the first caller and refuses the second', () => {
  const engine = new AgentEngine();

  const first = engine.claimForTask();
  assert.equal(first.success, true);

  const second = engine.claimForTask();
  assert.equal(second.success, false, 'a second START_TASK must be refused');
  assert.match(second.error, /already running/i);
});

test('#14 claimForTask refuses while a task is running', () => {
  const engine = new AgentEngine();
  engine.status = 'running';

  assert.equal(engine.claimForTask().success, false);
});

test('#14 claimForTask refuses while the loop is still active', () => {
  const engine = new AgentEngine();
  engine.status = 'idle';
  engine.isLoopActive = true;

  assert.equal(engine.claimForTask().success, false,
    'a loop winding down must not be joined by a second one');
});

test('#14 releaseTaskClaim lets a later task start', () => {
  const engine = new AgentEngine();

  assert.equal(engine.claimForTask().success, true);
  engine.releaseTaskClaim();
  assert.equal(engine.claimForTask().success, true,
    'the claim must not leak, or the panel would be wedged for the session');
});

test('#14 an empty prompt releases the claim rather than wedging the engine', async () => {
  const engine = new AgentEngine();

  assert.equal(engine.claimForTask().success, true);
  await engine.startTask('   ', 1);

  assert.equal(engine.claimForTask().success, true,
    'a rejected empty prompt must not leave the engine permanently claimed');
});


/* ---------------------------- #16 ---------------------------- */

test('#16 the Groq default is not the decommissioned llama-3.1-70b-versatile', () => {
  const groq = DEFAULT_PROVIDER_CONFIGS.openai_compatible;

  assert.notEqual(groq.model, 'llama-3.1-70b-versatile',
    'this id returns model_decommissioned, so a fresh Groq setup fails on step 1');
  assert.equal(groq.model, 'llama-3.3-70b-versatile');
  assert.equal(groq.baseUrl, 'https://api.groq.com/openai/v1');
});

test('#16 no fallback model list still offers the decommissioned Groq id', () => {
  for (const provider of ['openai', 'openai_compatible']) {
    const models = ApiClients.getFallbackModels(provider);
    assert.ok(!models.includes('llama-3.1-70b-versatile'),
      `${provider} fallback list still offers a decommissioned model`);
  }
});

test('#16 every provider default model is a non-empty string', () => {
  for (const [provider, cfg] of Object.entries(DEFAULT_PROVIDER_CONFIGS)) {
    assert.equal(typeof cfg.model, 'string', `${provider} has no default model`);
    assert.ok(cfg.model.length > 0, `${provider} default model is empty`);
  }
});

test('DEFAULT_PROVIDER_CONFIGS.nvidia exists with default model and baseUrl', () => {
  const nvidia = DEFAULT_PROVIDER_CONFIGS.nvidia;
  assert.ok(nvidia, 'nvidia config exists');
  assert.equal(nvidia.model, 'meta/llama-3.3-70b-instruct');
  assert.equal(nvidia.baseUrl, 'https://integrate.api.nvidia.com/v1');
});
