/**
 * Local-model harness regression tests.
 *
 * These cover the failure that made Ollama completely unusable: the response extractor had no
 * branch for Ollama's /api/chat payload shape, so every local generation was discarded and the
 * agent saw an empty string. The model was working the whole time. Because a parse failure only
 * logged and continued, a single unusable model consumed every step in the budget at ~30s each
 * before reporting nothing more specific than "reached maximum allowed steps".
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// The engine reads its provider config through Storage, so the stub has to describe a real
// local-model setup — otherwise the loop tests silently exercise the cloud defaults.
const STORED = {
  agent_settings: {
    provider: 'ollama',
    baseUrl: 'http://localhost:11434',
    model: 'qwen3.5:9b',
    maxSteps: 25,
    ollamaNumCtx: 8192,
    ollamaNumPredict: 1024
  }
};

global.chrome = {
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
const { buildActionSchema } = await import('../background/actionSchema.js');

const OLLAMA_SETTINGS = {
  provider: 'ollama',
  baseUrl: 'http://localhost:11434',
  model: 'qwen3.5:9b',
  temperature: 0.1,
  ollamaNumCtx: 8192,
  ollamaNumPredict: 1024
};

/** Replace global.fetch with a recorder returning `payload`; returns the captured requests. */
function stubFetch(responses) {
  const calls = [];
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return {
      ok: next.ok !== false,
      status: next.status || 200,
      clone: () => ({ text: async () => next.text || '' }),
      text: async () => next.text || '',
      json: async () => next.json
    };
  };
  return calls;
}

test('Ollama - extracts text from /api/chat message.content', async () => {
  stubFetch({ json: { message: { role: 'assistant', content: '{"action":"finish","answer":"done"}' }, done: true, done_reason: 'stop' } });
  const out = await ApiClients.callOllama(OLLAMA_SETTINGS, [{ role: 'user', content: 'go' }], 'sys', { json: true });
  // Before the fix this returned '' because data.message is an object, not a string.
  assert.equal(out, '{"action":"finish","answer":"done"}');
});

test('Ollama - falls back to message.thinking when content is empty', async () => {
  stubFetch({ json: { message: { role: 'assistant', content: '', thinking: '{"action":"click","element_id":3}' }, done: true, done_reason: 'length' } });
  const out = await ApiClients.callOllama(OLLAMA_SETTINGS, [{ role: 'user', content: 'go' }], 'sys', {});
  // A reasoning model cut off mid-thought still has recoverable JSON in `thinking`.
  assert.match(out, /"action":"click"/);
});

test('Ollama - request disables native thinking, pins the context window and sends the action schema', async () => {
  // The options the engine passes for its main action call (see runLoopBody).
  const schema = buildActionSchema();
  const calls = stubFetch({ json: { message: { role: 'assistant', content: 'ok' } } });
  await ApiClients.callOllama(OLLAMA_SETTINGS, [{ role: 'user', content: 'go' }], 'sys', { json: true, schema });

  assert.equal(calls[0].body.think, false, 'think must be false — local reasoning models leave content empty until they finish');
  assert.equal(calls[0].body.options.num_ctx, 8192, 'num_ctx must be explicit; Ollama defaults to 4096 and truncates from the front');
  assert.equal(calls[0].body.options.num_predict, 1024);
  // Changed on purpose from format:'json'. The schema constrains decoding further: the model
  // can only produce a known action with its required fields, not just any JSON object.
  assert.deepEqual(calls[0].body.format, schema, 'the action schema, not "json", constrains the main action call');
});

test('Ollama - JSON mode without a schema still sends format "json"', async () => {
  // verifyStep and other side calls ask for plain JSON and must keep getting exactly that.
  const calls = stubFetch({ json: { message: { role: 'assistant', content: '{"success":true}' } } });
  await ApiClients.callOllama(OLLAMA_SETTINGS, [{ role: 'user', content: 'go' }], 'sys', { json: true });
  assert.equal(calls[0].body.format, 'json');
  assert.equal(calls[0].body.think, false);
});

test('Ollama - a server that rejects a schema format gets format "json" instead, and remembers it', async () => {
  // Ollama before 0.5 only knows format:"json" and answers a schema with this 400.
  const oldServer = { ...OLLAMA_SETTINGS, baseUrl: 'http://old-ollama.test:11434' };
  const schema = buildActionSchema();
  const calls = stubFetch([
    { ok: false, status: 400, text: '{"error":"json: cannot unmarshal object into Go struct field ChatRequest.format of type string"}' },
    { json: { message: { role: 'assistant', content: '{"action":"scroll","direction":"down"}' } } }
  ]);
  const out = await ApiClients.callOllama(oldServer, [{ role: 'user', content: 'go' }], 'sys', { json: true, schema });
  assert.equal(out, '{"action":"scroll","direction":"down"}');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].body.format, schema);
  assert.equal(calls[1].body.format, 'json', 'the retry falls back to plain JSON mode');
  assert.equal(calls[1].body.think, false, 'the retry keeps think:false');

  const later = stubFetch({ json: { message: { role: 'assistant', content: 'ok' } } });
  await ApiClients.callOllama(oldServer, [{ role: 'user', content: 'go' }], 'sys', { json: true, schema });
  assert.equal(later.length, 1, 'the next call does not pay for the retry again');
  assert.equal(later[0].body.format, 'json');
});

test('Ollama - the think retry keeps the schema', async () => {
  const schema = buildActionSchema();
  const calls = stubFetch([
    { ok: false, status: 400, text: 'model does not support think' },
    { json: { message: { role: 'assistant', content: '{"action":"go_back"}' } } }
  ]);
  const out = await ApiClients.callOllama({ ...OLLAMA_SETTINGS, model: 'no-think-schema-model' }, [{ role: 'user', content: 'go' }], 'sys', { json: true, schema });
  assert.equal(out, '{"action":"go_back"}');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.think, undefined);
  assert.deepEqual(calls[1].body.format, schema, 'dropping think must not drop the schema');
});

test('Ollama - omits format when JSON mode is not requested', async () => {
  const calls = stubFetch({ json: { message: { role: 'assistant', content: 'ok' } } });
  await ApiClients.callOllama(OLLAMA_SETTINGS, [{ role: 'user', content: 'go' }], 'sys', {});
  assert.equal(calls[0].body.format, undefined);
});

test('Ollama - retries without think when the model rejects the flag', async () => {
  const calls = stubFetch([
    { ok: false, status: 400, text: 'model does not support think' },
    { json: { message: { role: 'assistant', content: 'recovered' } } }
  ]);
  const out = await ApiClients.callOllama(
    { ...OLLAMA_SETTINGS, model: 'no-think-model' },
    [{ role: 'user', content: 'go' }], 'sys', {}
  );
  assert.equal(out, 'recovered');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.think, false);
  assert.equal(calls[1].body.think, undefined, 'the retry must drop the field entirely');
});

test('Ollama - surfaces a real HTTP error instead of a generic connection message', async () => {
  stubFetch({ ok: false, status: 500, text: 'internal boom' });
  await assert.rejects(
    () => ApiClients.callOllama(OLLAMA_SETTINGS, [{ role: 'user', content: 'go' }], 'sys', {}),
    /Ollama API error \(500\)/
  );
});

test('AgentEngine - stops after 3 unusable replies instead of burning every step', async () => {
  const engine = new AgentEngine();
  await engine.restorePromise;

  let llmCalls = 0;
  const realCompletion = ApiClients.generateCompletion;
  ApiClients.generateCompletion = async () => { llmCalls++; return ''; };

  engine.getTabDOMWithAutoInject = async () => ({
    elementCount: 3,
    elements: '[0] <button> Go',
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
  engine.history = [{ type: 'user_goal', turn: 1, content: 'do a thing', prompt: 'do a thing' }];

  try {
    await engine.runLoopBody();
  } finally {
    ApiClients.generateCompletion = realCompletion;
  }

  // Previously this ran to maxSteps (25 by default, 15 in the reported log) at ~30s per call.
  assert.equal(llmCalls, 3, `expected 3 attempts before giving up, got ${llmCalls}`);
  assert.equal(engine.status, 'idle');
  assert.equal(engine.isLoopActive, false);

  const err = engine.history.filter(h => h.type === 'error').pop();
  assert.ok(err, 'the user must see why it stopped');
  assert.match(err.content, /empty response/i);
  assert.match(err.content, /qwen3\.5:9b/, 'the message must name the model that failed');
});

test('AgentEngine - parse-error counter resets after a good reply', async () => {
  const engine = new AgentEngine();
  await engine.restorePromise;

  const replies = ['', '', '{"action":"finish","answer":"all good"}'];
  let i = 0;
  const realCompletion = ApiClients.generateCompletion;
  ApiClients.generateCompletion = async () => replies[i++] ?? '';

  engine.getTabDOMWithAutoInject = async () => ({
    elementCount: 3, elements: '[0] <button> Go', pageText: 'hello', title: 'T', url: 'https://example.com',
    scrollState: { scrollY: 0, pageHeight: 1000, viewportHeight: 800 }
  });
  engine.generatePlan = async () => [];
  engine.persistState = async () => {};
  engine.notifyStateChange = () => {};

  engine.currentTask = 'do a thing';
  engine.status = 'running';
  engine.activeTabId = 101;
  engine.stepCount = 0;
  engine.history = [{ type: 'user_goal', turn: 1, content: 'do a thing', prompt: 'do a thing' }];

  try {
    await engine.runLoopBody();
  } finally {
    ApiClients.generateCompletion = realCompletion;
  }

  // Two duds then a valid action must finish the task, not trip the breaker.
  const finish = engine.history.filter(h => h.type === 'finish').pop();
  assert.ok(finish, 'a recovered task must still finish');
  assert.equal(finish.answer, 'all good');
  assert.equal(engine.history.filter(h => h.type === 'error').length, 0);
});
