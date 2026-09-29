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
