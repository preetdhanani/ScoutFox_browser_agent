/**
 * Constrained decoding for Ollama (phase P0a), checked on the real request bodies.
 *
 * Each run goes through the real entry points - startTask, generatePlan, runLoopBody and the
 * real ApiClients - with only fetch, the tab and storage stubbed, so what is asserted is what
 * would go over the wire:
 *   - Ollama gets the action schema (or the plan schema) as `format`, think:false and the
 *     compact prompt, with no few-shot examples and no <thought> or fenced-block rules;
 *   - every cloud provider gets exactly the request it got before P0a: the legacy prompt
 *     (pinned by a golden file captured from the pre-P0a code) and no format or schema;
 *   - the Ollama plan object becomes the plan checklist, and the generic fallback plan is used
 *     only when the reply really cannot be used.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const STORED = { agent_settings: {} };

global.chrome = {
  storage: {
    get session() { return this.local; },
    local: { get: (keys, cb) => cb({ ...STORED }), set: (data, cb) => cb && cb() }
  },
  tabs: {
    get: (id, cb) => cb({ id, groupId: -1, url: 'https://example.com' }),
    query: async () => [],
    sendMessage: (tabId, msg, cb) => cb({ success: true })
  }
};

const { AgentEngine } = await import('../background/agentEngine.js');
const { ACTION_VERBS, buildActionSchema, buildPlanSchema, PLAN_MAX_STEPS } = await import('../background/actionSchema.js');
const { DEFAULT_SETTINGS } = await import('../utils/storage.js');
const { Logger } = await import('../utils/logger.js');

// The legacy system prompt exactly as the pre-P0a engine built it for the default identity.
// Cloud providers must keep getting this, byte for byte. If it ever changes on purpose,
// update the golden file in the same change.
const LEGACY_PROMPT = readFileSync(new URL('./fixtures/legacy-system-prompt.txt', import.meta.url), 'utf8');

const TASK = 'What does the Framework Laptop 16 cost on this page?';
const SNAPSHOT = {
  title: 'Framework Laptop 16 DIY Edition - Framework Store',
  url: 'http://127.0.0.1:8765/store.html',
  scrollState: { scrollY: 0, pageHeight: 1050, viewportHeight: 779 },
  elementCount: 3,
  elementsText: '[1] a "Framework"\n[2] input[search] "Suche"\n[3] button[button] "In den Warenkorb"',
  pageText: 'Framework Laptop 16 DIY Edition\nab 1.399,00 EUR\nKostenloser Versand nach Deutschland.'
};
const FINISH_REPLY = '{"action":"finish","answer":"ab 1.399,00 EUR, kostenloser Versand"}';

const CLOUD = {
  openrouter: { provider: 'openrouter', apiKey: 'k', model: 'anthropic/claude-3.5-sonnet', baseUrl: 'https://openrouter.ai/api/v1' },
  agent_router: { provider: 'agent_router', apiKey: 'k', model: 'claude-3-5-sonnet', baseUrl: 'https://agentrouter.org/v1' },
  openai: { provider: 'openai', apiKey: 'k', model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com' },
  openai_compatible: { provider: 'openai_compatible', apiKey: 'k', model: 'llama-3.3-70b-versatile', baseUrl: 'https://api.groq.com/openai/v1' },
  anthropic: { provider: 'anthropic', apiKey: 'k', model: 'claude-3-5-sonnet-20241022' },
  gemini: { provider: 'gemini', apiKey: 'k', model: 'gemini-1.5-flash' }
};
const OLLAMA = { provider: 'ollama', model: 'qwen3.5:9b', baseUrl: 'http://localhost:11434' };

/** A response every client can read its text from (Anthropic, OpenAI, Gemini and Ollama shapes). */
function llmResponse(text) {
  const json = {
    content: [{ type: 'text', text }],
    choices: [{ message: { content: text } }],
    candidates: [{ content: { parts: [{ text }] } }],
    message: { role: 'assistant', content: text },
    done: true,
    done_reason: 'stop'
  };
  return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json), clone() { return this; } };
}

/**
 * Stub fetch with a queue of replies (text, or a function that throws or returns a Response).
 * Returns the captured requests.
 */
function stubFetch(replies) {
  const calls = [];
  const queue = [...replies];
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return typeof next === 'function' ? next() : llmResponse(next);
  };
  return calls;
}

function newEngine() {
  const engine = new AgentEngine();
  engine.persistState = async () => {};
  engine.notifyStateChange = () => {};
  engine.getTabDOMWithAutoInject = async () => SNAPSHOT;
  return engine;
}

/** A real task through startTask: the plan call, then one step that finishes. */
async function runTask(settings, planReply) {
  STORED.agent_settings = { ...settings };
  const calls = stubFetch([planReply, FINISH_REPLY]);
  const engine = newEngine();
  await engine.restorePromise;
  await engine.startTask(TASK, 7);
  return { engine, calls };
}

function systemPromptOf(provider, body) {
  if (provider === 'gemini') return body.system_instruction.parts[0].text;
  if (provider === 'anthropic' || provider === 'agent_router') return body.system;
  return body.messages[0].role === 'system' ? body.messages[0].content : null;
}

function allText(body) {
  return JSON.stringify(body);
}

test('Ollama: the action request sends the schema, think:false and the compact prompt', async () => {
  const { engine, calls } = await runTask(OLLAMA, '{"steps":[{"source":"current page","goal":"Read the price"}]}');

  assert.equal(calls.length, 2, 'one plan call and one action call');
  const step = calls[1];
  assert.equal(step.url, 'http://localhost:11434/api/chat');
  assert.deepEqual(step.body.format, buildActionSchema(), 'the action schema replaces format:"json"');
  assert.equal(step.body.think, false);
  assert.equal(step.body.stream, false);
  assert.equal(step.body.options.num_ctx, DEFAULT_SETTINGS.ollamaNumCtx);

  const system = step.body.messages[0];
  assert.equal(system.role, 'system');
  assert.equal(system.content, engine.buildCompactSystemPrompt(DEFAULT_SETTINGS.systemInstructions));
  for (const m of step.body.messages) {
    assert.doesNotMatch(m.content, /FEW-SHOT|--- Example|<thought>|```/, `no few-shot text or output rules in the ${m.role} message`);
  }

  // The bare JSON reply goes straight through the parser and ends the task.
  const finish = engine.history.find((h) => h.type === 'finish');
  assert.ok(finish, 'the task finished');
  assert.equal(finish.answer, 'ab 1.399,00 EUR, kostenloser Versand');
  assert.ok(!finish.unconfirmed, 'a real finish action, not wrapped prose');
});

test('Ollama: the plan request sends the plan schema', async () => {
  const { calls } = await runTask(OLLAMA, '{"steps":[{"source":"current page","goal":"Read the price"}]}');
  const plan = calls[0];
  assert.deepEqual(plan.body.format, buildPlanSchema());
  assert.equal(plan.body.think, false);
  assert.equal(plan.body.messages[0].content, 'You are a web task planner.');
  assert.match(plan.body.messages[1].content, /\{"steps": \[\{"source": "\.\.\.", "goal": "\.\.\."\}\]\}/);
  assert.doesNotMatch(plan.body.messages[1].content, /raw JSON array/, 'the Ollama plan prompt no longer asks for an array');
});

for (const [name, settings] of Object.entries(CLOUD)) {
  test(`${name}: the request bodies are unchanged - legacy prompt, no format, no schema`, async () => {
    const { engine, calls } = await runTask(settings, '["Read the price", "Answer"]');
    assert.equal(calls.length, 2, 'one plan call and one action call');
    for (const call of calls) {
      assert.ok(!('format' in call.body), 'no format field');
      assert.ok(!('think' in call.body), 'no think field');
      assert.doesNotMatch(allText(call.body), /oneOf|additionalProperties/, 'no schema anywhere in the body');
    }
    assert.equal(systemPromptOf(name, calls[1].body), LEGACY_PROMPT, 'the legacy system prompt, byte for byte');
    assert.match(allText(calls[0].body), /Output ONLY a raw JSON array of short sub-goal action strings/, 'the plan call still asks for an array');
    assert.deepEqual(engine.planSteps.map((s) => s.text), ['Read the price', 'Answer'], 'the array plan still works');
    assert.ok(engine.history.some((h) => h.type === 'finish'));
  });
}

test('the prompt is chosen by provider, not by model name', async () => {
  const ollamaWithOtherModel = await runTask({ ...OLLAMA, model: 'llama3.1:8b' }, '{"steps":[{"source":"current page","goal":"Read"}]}');
  assert.deepEqual(ollamaWithOtherModel.calls[1].body.format, buildActionSchema());
  assert.equal(ollamaWithOtherModel.calls[1].body.messages[0].content, ollamaWithOtherModel.engine.buildCompactSystemPrompt(DEFAULT_SETTINGS.systemInstructions));

  // A local model name behind an OpenAI-compatible endpoint is still a cloud-style provider.
  const compatibleWithLocalName = await runTask({ ...CLOUD.openai_compatible, model: 'qwen3.5:9b' }, '["Read"]');
  assert.equal(systemPromptOf('openai_compatible', compatibleWithLocalName.calls[1].body), LEGACY_PROMPT);
  assert.ok(!('format' in compatibleWithLocalName.calls[1].body));
});

test('the compact prompt: one line per action, no few-shot, no thought or fence rules, much smaller', () => {
  const engine = newEngine();
  const identity = DEFAULT_SETTINGS.systemInstructions;
  const compact = engine.buildSystemPrompt(identity, 'ollama');
  const legacy = engine.buildSystemPrompt(identity);

  assert.equal(compact, engine.buildCompactSystemPrompt(identity));
  assert.equal(legacy, LEGACY_PROMPT, 'no provider (and every cloud provider) keeps the legacy prompt');
  assert.ok(compact.startsWith(identity), 'the identity line comes from the settings, as before');
  assert.ok(engine.buildSystemPrompt('You are TestBot.', 'ollama').startsWith('You are TestBot.\n'));

  for (const verb of ACTION_VERBS) {
    assert.equal(compact.match(new RegExp(`^${verb} \\{`, 'gm'))?.length, 1, `exactly one line for ${verb}`);
  }
  assert.doesNotMatch(compact, /FEW-SHOT|Example/i, 'no few-shot examples');
  assert.doesNotMatch(compact, /<thought>|<think>|reasoning/i, 'no thought instructions');
  assert.doesNotMatch(compact, /```|fenced|code block/i, 'no fenced-block instructions');
  assert.match(compact, /Reply with ONE JSON object/);
  assert.match(compact, /Never click CAPTCHA or "verify you are human" boxes/);

  const ratio = compact.length / legacy.length;
  assert.ok(ratio < 0.35, `the compact prompt must be clearly smaller than the legacy one (ratio ${ratio.toFixed(2)})`);
});

// ---------------------------------------------------------------------------------------------
// The Ollama plan object becomes the plan checklist.

function fallbackLogsSince(start) {
  return Logger.getLogsHistory().slice(start).filter((e) => /\[PLANNER_FALLBACK\]/.test(e.message));
}

async function planWith(replies) {
  STORED.agent_settings = { ...OLLAMA };
  const calls = stubFetch(replies);
  const engine = newEngine();
  engine.currentTask = TASK;
  engine.abortController = new AbortController();
  const logStart = Logger.getLogsHistory().length;
  await engine.generatePlan(TASK, { ...DEFAULT_SETTINGS, ...OLLAMA });
  return { engine, calls, fallbackLogs: fallbackLogsSince(logStart) };
}

test('the Ollama plan object becomes planSteps', async () => {
  const reply = JSON.stringify({
    steps: [
      { source: 'frame.work', goal: 'Open frame.work and read the price of the Framework Laptop 16' },
      { source: 'idealo.de', goal: 'Find the price of the Framework Laptop 16' },
      { source: 'current page', goal: 'Compare the prices and answer' }
    ]
  });
  const { engine, fallbackLogs } = await planWith([reply]);
  assert.deepEqual(engine.planSteps, [
    { id: 1, text: 'Open frame.work and read the price of the Framework Laptop 16', status: 'in_progress' },
    { id: 2, text: 'idealo.de: Find the price of the Framework Laptop 16', status: 'pending' },
    { id: 3, text: 'Compare the prices and answer', status: 'pending' }
  ]);
  assert.equal(fallbackLogs.length, 0, 'a usable plan must not log a fallback');
});

test('an Ollama plan longer than the cap is cut in code', async () => {
  const steps = Array.from({ length: PLAN_MAX_STEPS + 4 }, (_, i) => ({ source: 'current page', goal: `Step ${i + 1} goal` }));
  const { engine } = await planWith([JSON.stringify({ steps })]);
  assert.equal(engine.planSteps.length, PLAN_MAX_STEPS, 'the grammar is not the only guard');
});

test('the Ollama plan fallback is used only on real failure', async () => {
  const fallbackTexts = ['Execute targeted web actions & navigate', 'Extract relevant information & synthesize answer'];
  const failures = {
    'an empty steps list': ['{"steps":[]}'],
    'steps with no goal text': ['{"steps":[{"source":"idealo.de","goal":"  "}]}'],
    'a reply that is not JSON': ['I think you should look at the price.'],
    'an object without steps': ['{"plan":["Read the price"]}'],
    'an HTTP error': [() => ({ ok: false, status: 500, text: async () => 'boom', clone() { return this; } })],
    'a network failure': [() => { throw new Error('fetch failed ECONNREFUSED'); }]
  };
  for (const [why, replies] of Object.entries(failures)) {
    const { engine, fallbackLogs } = await planWith(replies);
    assert.deepEqual(engine.planSteps.slice(1).map((s) => s.text), fallbackTexts, `${why}: the generic plan is used`);
    assert.equal(fallbackLogs.length, 1, `${why}: the fallback is logged`);
  }

  const { engine, fallbackLogs } = await planWith(['{"steps":[{"source":"current page","goal":"Read the price"}]}']);
  assert.deepEqual(engine.planSteps.map((s) => s.text), ['Read the price'], 'a valid object is used as it is');
  assert.equal(fallbackLogs.length, 0);
});
