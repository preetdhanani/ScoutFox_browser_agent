/**
 * parseResponse stage 0: a reply that is exactly one JSON object with an "action" key.
 *
 * That is the shape Ollama's schema forces. The older stages cut a bare reply at its first
 * closing brace, so nested objects fell apart: a bare browser_batch came out as a single click
 * of its LAST step, and a read_network_requests filter was lost. Everything that is not a bare
 * action object (fenced blocks, <thought> tags, prose) must still go through the older stages
 * exactly as before.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

global.chrome = {
  storage: { local: { get: (keys, cb) => cb({}), set: (data, cb) => cb && cb() } },
  tabs: { get: (id, cb) => cb({ id, groupId: -1, url: 'https://example.com' }), query: async () => [] }
};

const { AgentEngine } = await import('../background/agentEngine.js');

const engine = new AgentEngine();

test('a bare JSON action is parsed whole, with no thought', () => {
  const result = engine.parseResponse('{"action":"click","element_id":4,"reason":"the search result"}', 10);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.action, { action: 'click', element_id: 4, reason: 'the search result' });
  assert.equal(result.thought, '');
});

test('whitespace and pretty-printing around a bare action are fine', () => {
  const result = engine.parseResponse('\n  {\n    "action": "type",\n    "element_id": 2,\n    "text": "framework laptop 16",\n    "submit": true\n  }\n', 10);
  assert.deepEqual(result.action, { action: 'type', element_id: 2, text: 'framework laptop 16', submit: true });
});

test('a bare browser_batch keeps every step', () => {
  const reply = JSON.stringify({
    action: 'browser_batch',
    steps: [
      { action: 'type', element_id: 2, text: 'a@b.com', submit: false },
      { action: 'type', element_id: 3, text: 'hunter2', submit: false },
      { action: 'click', element_id: 5 }
    ],
    stopOnError: true
  });
  const result = engine.parseResponse(reply, 10);
  assert.equal(result.action.action, 'browser_batch', 'must not collapse into the last step\'s click');
  assert.equal(result.action.steps.length, 3);
  assert.deepEqual(result.action.steps[2], { action: 'click', element_id: 5 });
  assert.equal(result.action.stopOnError, true);
});

test('a bare read_network_requests keeps its nested filter', () => {
  const result = engine.parseResponse('{"action":"read_network_requests","filter":{"status":"error","since":"last_action"},"includeBody":false,"limit":5}', 10);
  assert.deepEqual(result.action.filter, { status: 'error', since: 'last_action' });
  assert.equal(result.action.includeBody, false);
  assert.equal(result.action.limit, 5);
});

test('a bare action still gets the same checks as every other reply', () => {
  const outOfRange = engine.parseResponse('{"action":"click","element_id":99}', 12);
  assert.equal(outOfRange.action, undefined);
  assert.match(outOfRange.error, /element_id 99 does not exist/);

  const unknown = engine.parseResponse('{"action":"mark_blocked","reason":"bot check"}', 12);
  assert.equal(unknown.action, undefined);
  assert.match(unknown.error, /Unknown action "mark_blocked"/);

  const alias = engine.parseResponse('{"action":"click_element","elementId":"7"}', 12);
  assert.deepEqual([alias.action.action, alias.action.element_id], ['click', 7], 'aliases still resolve');
});

test('a stray open brace in the prose before the action does not hide it (each one was a parse error)', () => {
  const quoted = engine.parseResponse('I see the text "{" on the page.\n{"action":"click","element_id":3}', 10);
  assert.equal(quoted.error, undefined);
  assert.deepEqual(quoted.action, { action: 'click', element_id: 3 });

  const css = engine.parseResponse('Selector would be div.price { color... Anyway:\n{"action":"click","element_id":3}', 10);
  assert.equal(css.error, undefined);
  assert.deepEqual(css.action, { action: 'click', element_id: 3 });

  // The stray brace used to send the parser to the text intents, and "go to <url>" won over the action.
  const intent = engine.parseResponse('{go to https://a.de/x```json\n{"click": 4}{"action":"scroll","direction":"down"}', 10);
  assert.deepEqual(intent.action, { action: 'scroll', direction: 'down' });
});

test('replies that are not a bare action object still take the older stages', () => {
  const fenced = engine.parseResponse('<thought>Batch the login.</thought>\n```json\n{"action":"browser_batch","steps":[{"action":"type","element_id":1,"text":"a"},{"action":"click","element_id":2}]}\n```', 10);
  assert.equal(fenced.thought, 'Batch the login.');
  assert.equal(fenced.action.action, 'browser_batch');
  assert.equal(fenced.action.steps.length, 2);

  const withPreamble = engine.parseResponse('Sure. {"action":"scroll","direction":"down"}', 10);
  assert.deepEqual(withPreamble.action, { action: 'scroll', direction: 'down' });

  const noActionKey = engine.parseResponse('{"click": 3}', 10);
  assert.deepEqual([noActionKey.action.action, noActionKey.action.element_id], ['click', 3], 'the {"click": N} alias shape still works');

  const nonStringAction = engine.parseResponse('{"action": {"type": "click"}}', 10);
  assert.equal(nonStringAction.action, undefined, 'an object as the action is not a bare action; the old path rejects it');

  const prose = engine.parseResponse('The price is 1.399,00 EUR with free shipping.', 10);
  assert.equal(prose.action.action, 'finish');
  assert.equal(prose.action.autoWrapped, true, 'prose is still wrapped as an unconfirmed finish');
});

test('the first action wins over what is written after it: an alias shape, or an example of another action', () => {
  // Both used to replace the action (the last one won). The old engine ran the first one.
  const attributes = engine.parseResponse('I will click the search button {"action":"click","element_id":3}. The button has attributes {"type": "submit"}.', 20);
  assert.equal(attributes.error, undefined);
  assert.deepEqual(attributes.action, { action: 'click', element_id: 3 });

  const example = engine.parseResponse('My action: {"action":"click","element_id":3}. (Once done I would send {"action": "finish", "answer": "..."}.)', 20);
  assert.deepEqual(example.action, { action: 'click', element_id: 3 }, 'a finish the model did not mean must not end the run');

  const plan = engine.parseResponse('{"action":"click","element_id":2}\n{"action":"type","element_id":4,"text":"abc"}', 20);
  assert.deepEqual(plan.action, { action: 'click', element_id: 2 }, 'a plan of steps runs its first step now');
});

test('words of tool-call markup inside the strings of a valid action are content, not markup', () => {
  const finish = engine.parseResponse('```json\n{"action":"finish","answer":"The docs say: wrap each call in <tool_call> tags."}\n```', 20);
  assert.equal(finish.error, undefined);
  assert.equal(finish.action.answer, 'The docs say: wrap each call in <tool_call> tags.');
  assert.equal(finish.action.autoWrapped, undefined, 'a declared finish');

  const typed = engine.parseResponse('Typing the query.\n{"action":"type","element_id":3,"text":"<invoke name=","submit":true}', 20);
  assert.deepEqual(typed.action, { action: 'type', element_id: 3, text: '<invoke name=', submit: true });

  const orphan = engine.parseResponse('I could use a <tool_call> but this agent wants JSON.</think>\n{"action":"click","element_id":3}', 20);
  assert.deepEqual(orphan.action, { action: 'click', element_id: 3 });
});

test('tool calls in the formats of other model families are converted or a parse error, never an answer', () => {
  for (const reply of [
    '{"name": "click", "arguments": {"element_id": 3}}',
    '<|python_tag|>{"name": "click", "parameters": {"element_id": 3}}',
    '<function=click>{"element_id": 3}</function>',
    '[TOOL_CALLS] [{"name": "click", "arguments": {"element_id": 3}}]',
    '<|tool_call|>[{"name": "click", "arguments": {"element_id": 3}}]',
    '{"function_call": {"name": "click", "arguments": "{\\"element_id\\": 3}"}}',
    '{"id":"7","type":"function","function":{"name":"click","arguments":"{\\"element_id\\": 3}"}}'
  ]) {
    const result = engine.parseResponse(reply, 20);
    assert.equal(result.error, undefined, reply);
    assert.deepEqual(result.action, { action: 'click', element_id: 3 }, reply);
  }
  const gemma = engine.parseResponse('```tool_code\nclick(element_id=3)\n```', 20);
  assert.equal(gemma.action, undefined);
  assert.match(gemma.error, /^Your reply used tool-call markup/);
});

test('a rejected element_id keeps the wording of this engine, and is never read loosely', () => {
  const single = engine.parseResponse('{"action":"click","element_id":99}', 20);
  assert.equal(single.error, 'Selected element_id 99 does not exist on this page (valid range: 1-20). Re-check the numbered element list and choose a real one.');

  // A batch step is new behaviour, and has the design text.
  const batch = engine.parseResponse('{"action":"browser_batch","steps":[{"action":"click","element_id":99}]}', 20);
  assert.equal(batch.error, 'Element [99] is not in the current element list (it may be from an older view of the page). Use an id from the list.');

  // parseInt turned each of these into another real id.
  for (const id of ['3.9', '"12abc"', '"1e3"']) {
    const result = engine.parseResponse(`{"action":"click","element_id":${id}}`, 20);
    assert.equal(result.action, undefined, id);
    assert.match(result.error, /^Selected element_id /, id);
  }
  assert.equal(engine.parseResponse('{"action":"browser_batch","steps":[{"action":"click","element_id":"3abc"}]}', 20).action, undefined);
  assert.equal(engine.parseResponse('{"action":"click","element_id":"7"}', 20).action.element_id, 7, 'a numeric string is still the number');
  assert.equal(engine.parseResponse('{"action":"click","ref":3}', 20).action.element_id, 3, 'ref is an id key');
});
