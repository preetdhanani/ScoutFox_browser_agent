/**
 * Regression tests for the "accidental finish" of a real run: DeepSeek, through AgentRouter, answered
 * in its own tool-call syntax (DSML). parseResponse's prose stage wrapped that markup into a
 * `finish` action, which the panel showed as an "Unconfirmed answer", and the run ended with nothing
 * done.
 *
 * Tool-call markup now never reaches the prose stage (src/background/agent/parse.ts and
 * toolCalls.ts). The reply is either converted into the action it asks for, or it is the parse
 * error "Your reply used tool-call markup ...", which goes through the same unusable-reply path as
 * any other bad reply: the model sees the error and answers again, and 3 in a row stop the run.
 *
 * These tests drive the real engine loop the way tests/agentEngineOutcomeHonesty.test.js does. The
 * per-reply cases of the parser are in tests/parse.test.ts and shared/fixtures/parse-cases.json.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const STORED = {
  agent_settings: { provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'deepseek-test', maxSteps: 10, actionDelayMs: 1 }
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

// The engine waits one second after an unusable reply before it asks again. That wait is not what
// these tests are about, so it is shortened (this file runs in its own process).
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, ms === 1000 ? 1 : ms, ...args);

const { ApiClients } = await import('../background/apiClients.js');
const { AgentEngine } = await import('../background/agentEngine.js');
const { TOOL_CALL_MARKUP_ERROR } = await import('../src/background/agent/toolCalls.ts');

const DSML_TRUNCATED = [
  '<｜DSML｜function_calls>',
  '<｜DSML｜invoke name="finish">',
  '<｜DSML｜parameter name="answer" string="true">The Framework Laptop 16 costs 1.599,00 EUR</｜DSML｜param'
].join('\n');

const DSML_UNKNOWN_TOOL = [
  '<｜DSML｜function_calls>',
  '<｜DSML｜invoke name="web_search">',
  '<｜DSML｜parameter name="query" string="true">framework laptop 16 price</｜DSML｜parameter>',
  '</｜DSML｜invoke>',
  '</｜DSML｜function_calls>'
].join('\n');

const DSML_SCROLL = [
  '<｜DSML｜function_calls>',
  '<｜DSML｜invoke name="scroll">',
  '<｜DSML｜parameter name="direction" string="true">down</｜DSML｜parameter>',
  '</｜DSML｜invoke>',
  '</｜DSML｜function_calls>'
].join('\n');

function freshEngine() {
  const engine = new AgentEngine();
  engine.getTabDOMWithAutoInject = async () => ({
    elementCount: 3,
    elements: '[1] <button> Go',
    pageText: 'hello',
    title: 'Test',
    url: 'https://example.com',
    scrollState: { scrollY: 0, pageHeight: 1000, viewportHeight: 800 }
  });
  engine.generatePlan = async () => [];
  engine.persistState = async () => {};
  engine.notifyStateChange = () => {};
  engine.currentTask = 'find the price';
  engine.status = 'running';
  engine.activeTabId = 101;
  engine.stepCount = 0;
  engine.history = [{ type: 'user_goal', turn: 1, prompt: 'find the price' }];
  return engine;
}

/** Runs the loop with scripted model replies. Returns what the model was asked and what reached the page. */
async function run(engine, replies) {
  await engine.restorePromise;
  const asked = [];
  const executed = [];
  const realCompletion = ApiClients.generateCompletion;
  let i = 0;
  ApiClients.generateCompletion = async (settings, messages) => {
    asked.push(messages);
    return replies[i++] ?? replies[replies.length - 1];
  };
  engine.executeActionOnTab = async (tabId, action) => {
    executed.push(action);
    return { success: true, message: `did ${action.action}` };
  };
  try {
    await engine.runLoopBody();
  } finally {
    ApiClients.generateCompletion = realCompletion;
  }
  return { asked, executed };
}

const finishes = (engine) => engine.history.filter((h) => h.type === 'finish');

test('a cut-off DSML reply does not end the run: the model is told, and its next reply is used', async () => {
  const engine = freshEngine();
  const { asked, executed } = await run(engine, [DSML_TRUNCATED, '{"action":"finish","answer":"The price is 1.599,00 EUR."}']);

  assert.equal(asked.length, 2, 'the model is asked again after the unusable reply');
  assert.deepEqual(executed, [], 'nothing was dispatched to the page');

  const first = engine.history.find((h) => h.type === 'agent_response');
  assert.equal(first.action, null, 'the DSML reply produced no action');
  assert.equal(first.rawResponse, DSML_TRUNCATED);

  const failure = engine.history.find((h) => h.type === 'execution_result');
  assert.equal(failure.success, false);
  assert.equal(failure.error, TOOL_CALL_MARKUP_ERROR, 'the design text, not repeated with the generic reminder');

  const secondCallMessages = asked[1].map((m) => m.content).join('\n');
  assert.ok(secondCallMessages.includes(TOOL_CALL_MARKUP_ERROR), 'the model sees the error on its next turn');
  assert.ok(secondCallMessages.includes(DSML_TRUNCATED), 'and its own reply');

  assert.equal(finishes(engine).length, 1, 'exactly one finish, and it is the model\'s real one');
  assert.equal(finishes(engine)[0].answer, 'The price is 1.599,00 EUR.');
  assert.equal(finishes(engine)[0].unconfirmed, undefined, 'a declared finish, not an inferred "Unconfirmed answer"');
  assert.equal(engine.status, 'idle');
});

test('a DSML reply for a tool this agent does not have is the same retry, never a finish', async () => {
  const engine = freshEngine();
  const { executed } = await run(engine, [DSML_UNKNOWN_TOOL, '{"action":"finish","answer":"done"}']);

  assert.deepEqual(executed, []);
  const failure = engine.history.find((h) => h.type === 'execution_result');
  assert.equal(failure.error, TOOL_CALL_MARKUP_ERROR);
  assert.deepEqual(finishes(engine).map((f) => f.answer), ['done']);
});

test('three tool-call replies in a row stop the run with the circuit breaker, and no finish is invented', async () => {
  const engine = freshEngine();
  const { asked } = await run(engine, [DSML_TRUNCATED]);

  assert.equal(asked.length, 3, 'three unusable replies, then it stops');
  assert.equal(finishes(engine).length, 0, 'a run that never got a usable action must not have a finish entry');
  assert.equal(engine.status, 'idle');
  assert.equal(engine.isLoopActive, false);

  const stopped = engine.history.filter((h) => h.type === 'error').pop();
  assert.ok(stopped, 'the user must see why it stopped');
  assert.match(stopped.content, /^Stopped early/);
  assert.match(stopped.content, /failed to produce a usable action 3 times in a row/);
  assert.ok(stopped.content.includes(TOOL_CALL_MARKUP_ERROR), 'the last parser error is in the message');
  assert.equal(engine.previousTurnsSummary().length, 0, 'the unfinished turn is not recapped as completed work');
});

test('a good reply in between resets the count: two tool-call replies, a scroll, two more, then a finish', async () => {
  const engine = freshEngine();
  const { executed } = await run(engine, [DSML_TRUNCATED, DSML_UNKNOWN_TOOL, '{"action":"scroll","direction":"down"}', DSML_TRUNCATED, DSML_UNKNOWN_TOOL, '{"action":"finish","answer":"ok"}']);

  assert.deepEqual(executed, [{ action: 'scroll', direction: 'down' }]);
  assert.deepEqual(finishes(engine).map((f) => f.answer), ['ok']);
  assert.equal(engine.history.filter((h) => h.type === 'error').length, 0, 'the breaker never tripped');
});

test('a well-formed DSML call is converted and executed like a JSON action', async () => {
  const engine = freshEngine();
  const { executed } = await run(engine, [DSML_SCROLL, '{"action":"finish","answer":"done"}']);

  assert.deepEqual(executed, [{ action: 'scroll', direction: 'down' }], 'the converted action reached the page');
  const response = engine.history.find((h) => h.type === 'agent_response');
  assert.deepEqual(response.action, { action: 'scroll', direction: 'down' });
  assert.equal(response.rawResponse, DSML_SCROLL, 'the panel still shows what the model wrote');
  assert.equal(engine.history.filter((h) => h.type === 'execution_result' && h.success === false).length, 0);
  assert.deepEqual(finishes(engine).map((f) => f.answer), ['done']);
});

test('an explicit finish written as a tool call is a real finish, not an unconfirmed one', async () => {
  const engine = freshEngine();
  const dsmlFinish = '<｜DSML｜function_calls><｜DSML｜invoke name="finish"><｜DSML｜parameter name="answer" string="true">1.599,00 EUR</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜function_calls>';
  await run(engine, [dsmlFinish]);

  assert.equal(finishes(engine).length, 1);
  assert.equal(finishes(engine)[0].answer, '1.599,00 EUR');
  assert.equal(finishes(engine)[0].unconfirmed, undefined, 'the model declared it');
});

test('a Qwen <tool_call> and an OpenAI tool_calls reply are handled the same way', async () => {
  for (const reply of [
    '<tool_call>\n{"name": "scroll", "arguments": {"direction": "down"}}\n</tool_call>',
    JSON.stringify({ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'scroll', arguments: '{"direction":"down"}' } }] })
  ]) {
    const engine = freshEngine();
    const { executed } = await run(engine, [reply, '{"action":"finish","answer":"ok"}']);
    assert.deepEqual(executed, [{ action: 'scroll', direction: 'down' }], reply);
    assert.deepEqual(finishes(engine).map((f) => f.answer), ['ok'], reply);
  }
  for (const reply of ['<tool_call>\n{"name": "scroll", "arguments": {"direction": "dow', '{"tool_calls":[{"function":{"name":"scroll","arguments":"{\\"dir']) {
    const engine = freshEngine();
    const { executed } = await run(engine, [reply, '{"action":"finish","answer":"ok"}']);
    assert.deepEqual(executed, [], reply);
    assert.deepEqual(finishes(engine).map((f) => f.answer), ['ok'], reply);
    assert.equal(engine.history.find((h) => h.type === 'execution_result').error, TOOL_CALL_MARKUP_ERROR, reply);
  }
});

test('the tool-call formats of other model families never end the run as an "Unconfirmed answer"', async () => {
  // Each was plain prose to the old parser: the raw call became the answer of a finish.
  const formats = {
    'bare name and arguments': '{"name": "scroll", "arguments": {"direction": "down"}}',
    'Llama python_tag': '<|python_tag|>{"name": "scroll", "parameters": {"direction": "down"}}',
    'Llama function tag': '<function=scroll>{"direction": "down"}</function>',
    'Mistral TOOL_CALLS': '[TOOL_CALLS] [{"name": "scroll", "arguments": {"direction": "down"}}]',
    'Granite tool_call token': '<|tool_call|>[{"name": "scroll", "arguments": {"direction": "down"}}]',
    'old OpenAI function_call': '{"function_call": {"name": "scroll", "arguments": "{\\"direction\\": \\"down\\"}"}}'
  };
  for (const [label, reply] of Object.entries(formats)) {
    const engine = freshEngine();
    const { executed } = await run(engine, [reply, '{"action":"finish","answer":"ok"}']);
    assert.deepEqual(executed, [{ action: 'scroll', direction: 'down' }], label);
    assert.deepEqual(finishes(engine).map((f) => [f.answer, f.unconfirmed]), [['ok', undefined]], label);
  }
  // A Gemma tool_code fence is detected but not converted: the model is told, and the run goes on.
  const engine = freshEngine();
  const { executed } = await run(engine, ['```tool_code\nscroll(direction="down")\n```', '{"action":"finish","answer":"ok"}']);
  assert.deepEqual(executed, []);
  assert.equal(engine.history.find((h) => h.type === 'execution_result').error, TOOL_CALL_MARKUP_ERROR);
  assert.deepEqual(finishes(engine).map((f) => f.answer), ['ok']);
});

test('plain prose still ends the run as an unconfirmed answer (tool-call text does not)', async () => {
  const engine = freshEngine();
  await run(engine, ['The price is 1.599,00 EUR.']);
  assert.equal(finishes(engine).length, 1);
  assert.equal(finishes(engine)[0].unconfirmed, true);
});

test('a browser_batch with a step id that is not on the page is refused before anything runs', async () => {
  const engine = freshEngine();
  const stale = JSON.stringify({ action: 'browser_batch', steps: [{ action: 'click', element_id: 1 }, { action: 'click', element_id: 99 }] });
  const { executed } = await run(engine, [stale, '{"action":"finish","answer":"ok"}']);

  assert.deepEqual(executed, [], 'step 1 must not run when step 2 is bad');
  const failure = engine.history.find((h) => h.type === 'execution_result');
  assert.equal(failure.success, false);
  assert.match(failure.error, /^Element \[99\] is not in the current element list \(it may be from an older view of the page\)\. Use an id from the list\./);
  assert.match(failure.error, /Reply with a single JSON object containing an "action" key and nothing else\.$/, 'the generic reminder is kept for the other parse errors');
  assert.deepEqual(finishes(engine).map((f) => f.answer), ['ok']);
});

test('a browser_batch whose step ids are all on the page is dispatched whole', async () => {
  const engine = freshEngine();
  const batch = { action: 'browser_batch', steps: [{ action: 'type', element_id: 1, text: 'a@b.com' }, { action: 'click', element_id: 2 }], stopOnError: true };
  const { executed } = await run(engine, [JSON.stringify(batch), '{"action":"finish","answer":"ok"}']);
  assert.deepEqual(executed, [batch]);
});
