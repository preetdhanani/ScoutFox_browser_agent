/**
 * The engine's verb list (KNOWN_ACTIONS) and its alias table (click_element -> click, done ->
 * finish, ...) used to be written out twice: in agentEngine.js and, for Ollama's grammar, in a
 * second registry. Both now come from shared/actions.json. These tests pin what the engine did
 * with a model's action name before that, so moving the table into the data file changed nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

global.chrome = {
  storage: { local: { get: (keys, cb) => cb({}), set: (data, cb) => cb && cb() } },
  tabs: { get: (id, cb) => cb({ id, groupId: -1, url: 'https://example.com' }), query: async () => [] }
};

const { AgentEngine, KNOWN_ACTIONS } = await import('../background/agentEngine.js');
const { ACTION_VERBS, REGISTRY } = await import('../src/background/agent/actions.ts');

// The alias table exactly as sanitizeActionSchema wrote it before the registry existed.
const ALIASES_BEFORE_THE_REGISTRY = {
  click: ['click_element', 'press'],
  type: ['type_text', 'input'],
  finish: ['done', 'complete', 'finished'],
  scroll: ['scroll_page'],
  read_page_text: ['extract_text', 'read_text', 'extract_page_text'],
  execute_js: ['eval_js', 'run_js', 'javascript'],
  read_network_requests: ['read_network', 'network_requests', 'get_network'],
  browser_batch: ['batch', 'batch_actions'],
  open_window: ['new_window', 'open_new_window', 'create_window']
};

const engine = new AgentEngine();

test('KNOWN_ACTIONS is the registry verb list, in the same order (the "Valid actions are" text lists it)', () => {
  assert.deepEqual([...KNOWN_ACTIONS], ACTION_VERBS);
  assert.deepEqual([...KNOWN_ACTIONS], [
    'click', 'type', 'scroll', 'press_key', 'navigate', 'go_back', 'go_forward', 'read_page_text',
    'execute_js', 'read_network_requests', 'browser_batch', 'wait', 'finish', 'ask_user', 'open_window'
  ]);
});

test('the registry aliases are exactly the alias table the engine had before', () => {
  const inRegistry = Object.fromEntries(REGISTRY.verbs.filter((v) => v.aliases.length).map((v) => [v.name, v.aliases]));
  assert.deepEqual(inRegistry, ALIASES_BEFORE_THE_REGISTRY);
});

test('sanitizeActionSchema turns every alias into its verb, and keeps every real verb', () => {
  for (const [verb, aliases] of Object.entries(ALIASES_BEFORE_THE_REGISTRY)) {
    for (const alias of aliases) {
      const result = engine.sanitizeActionSchema({ action: alias, element_id: 3 }, 20);
      assert.equal(result.action, verb, `${alias} -> ${verb}`);
      assert.ok(!('invalidAction' in result), `${alias} is not rejected`);
    }
  }
  for (const verb of ACTION_VERBS) {
    const result = engine.sanitizeActionSchema({ action: verb }, 20);
    assert.equal(result.action, verb);
    assert.ok(!('invalidAction' in result), `${verb} is not rejected`);
  }
});

test('a name that is neither a verb nor an alias is rejected as it was written, never guessed', () => {
  for (const name of ['fly', 'Click', ' click', 'click ', 'CLICK', 'mark_blocked', 'record_finding', 'constructor', '__proto__', 'toString', 'hasOwnProperty', '']) {
    const result = engine.sanitizeActionSchema({ action: name }, 20);
    assert.equal(result.action, name, JSON.stringify(name));
    assert.equal(result.invalidAction, name, `${JSON.stringify(name)} is invalid`);
  }
  for (const odd of [null, 42, true, ['click'], { x: 1 }]) {
    const result = engine.sanitizeActionSchema({ action: odd }, 20);
    assert.equal(result.action, odd);
    assert.deepEqual(result.invalidAction, odd);
  }
});

test('an action with no "action" key gets none added', () => {
  const result = engine.sanitizeActionSchema({ thought: 'x' }, 20);
  assert.ok(!('action' in result), 'the key stays absent, as before');
  assert.ok('invalidAction' in result);
});

test('the {"click": N} and {"type": ...} shapes still work, and go through the alias step too', () => {
  assert.deepEqual(engine.sanitizeActionSchema({ click: 4 }, 20), { click: 4, action: 'click', element_id: 4 });
  assert.equal(engine.sanitizeActionSchema({ type: 'hello', element_id: 2 }, 20).action, 'type');
  assert.equal(engine.sanitizeActionSchema({ click: 4, action: 'done' }, 20).action, 'finish', 'an explicit action wins and its alias resolves');
});

test('parseResponse lists the registry verbs when a verb is unknown, and accepts an alias in a JSON reply', () => {
  const unknown = engine.parseResponse('{"action":"fly"}', 20);
  assert.equal(unknown.error, 'Unknown action "fly". Valid actions are: click, type, scroll, press_key, navigate, go_back, go_forward, read_page_text, execute_js, read_network_requests, browser_batch, wait, finish, ask_user, open_window.');

  const done = engine.parseResponse('{"action":"done","answer":"x"}', 20);
  assert.equal(done.action.action, 'finish');
  const batch = engine.parseResponse('{"action":"batch","steps":[{"action":"click","element_id":1}]}', 20);
  assert.equal(batch.action.action, 'browser_batch');
  const js = engine.parseResponse('```json\n{"action":"run_js","code":"1"}\n```', 20);
  assert.equal(js.action.action, 'execute_js');
});
