/**
 * The action schema registry (background/actionSchema.js) is what Ollama's grammar is built
 * from, so a mistake in it does not fail loudly: the model simply can no longer produce some
 * action, or produces a shape the engine cannot run. These tests pin the registry to the
 * engine's own verb list and check every branch against real examples.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTION_VERBS, BATCH_MAX_STEPS, BATCH_STEP_STYLE, BATCH_STEP_VERBS, ELEMENT_ID_MAX, HTTP_URL_PATTERN,
  PLAN_MAX_STEPS, PRESS_KEYS, buildActionPromptLines, buildActionSchema, buildBatchStepsSchema, buildPlanSchema
} from '../background/actionSchema.js';
import { KNOWN_ACTIONS } from '../background/agentEngine.js';
import { allSubschemas, unsupportedKeywords, validate } from './helpers/miniJsonSchema.js';

// One realistic, minimal action per verb. A new verb has to get an example here too.
const EXAMPLES = {
  click: { action: 'click', element_id: 3 },
  type: { action: 'type', element_id: 5, text: 'framework laptop 16', submit: true },
  scroll: { action: 'scroll', direction: 'down' },
  press_key: { action: 'press_key', key: 'Escape' },
  navigate: { action: 'navigate', url: 'https://www.idealo.de/preisvergleich/MainSearchProductCategory.html?q=framework+laptop+16' },
  go_back: { action: 'go_back' },
  go_forward: { action: 'go_forward' },
  read_page_text: { action: 'read_page_text' },
  execute_js: { action: 'execute_js', code: 'return document.title' },
  read_network_requests: { action: 'read_network_requests', filter: { status: 'error', since: 'last_action' }, includeBody: true, limit: 5 },
  browser_batch: {
    action: 'browser_batch',
    steps: [
      { action: 'type', element_id: 2, text: 'a@b.com', submit: false },
      { action: 'click', element_id: 5 }
    ],
    stopOnError: true
  },
  wait: { action: 'wait', amount: 2 },
  finish: { action: 'finish', answer: 'ab 1.399,00 EUR, kostenloser Versand' },
  ask_user: { action: 'ask_user', question: 'Which size do you want?' },
  open_window: { action: 'open_window', url: 'https://example.com/' }
};

/** [fieldName, schema] for every property in the schema, at any depth. */
function allProperties(schema) {
  const out = [];
  for (const node of allSubschemas(schema)) {
    for (const [name, sub] of Object.entries(node.properties || {})) out.push([name, sub]);
  }
  return out;
}

test('the registry verbs and KNOWN_ACTIONS are exactly the same set', () => {
  assert.deepEqual([...ACTION_VERBS].sort(), [...KNOWN_ACTIONS].sort(),
    'a verb the engine can dispatch must be one the Ollama grammar can produce, and the other way round');
  assert.equal(new Set(ACTION_VERBS).size, ACTION_VERBS.length, 'no verb may be defined twice');
  assert.deepEqual(Object.keys(EXAMPLES).sort(), [...ACTION_VERBS].sort(), 'every verb needs an example in this test');
});

test('every registry verb builds a valid oneOf branch', () => {
  const union = buildActionSchema();
  assert.equal(union.oneOf.length, ACTION_VERBS.length);
  assert.deepEqual(unsupportedKeywords(union), [], 'the schema uses only the keywords these tests understand');

  for (const verb of ACTION_VERBS) {
    const [branch] = buildActionSchema([verb]).oneOf;
    assert.equal(branch.type, 'object', verb);
    assert.equal(branch.additionalProperties, false, `${verb}: unknown fields must be impossible`);
    assert.deepEqual(branch.properties.action, { const: verb }, `${verb}: the action is a const, not an enum`);
    assert.equal(branch.required[0], 'action', verb);
    for (const field of branch.required) {
      assert.ok(branch.properties[field], `${verb}: required field "${field}" must be declared`);
    }
    assert.deepEqual(branch.properties.reason, { type: 'string' }, `${verb}: reason is allowed`);
    assert.ok(!branch.required.includes('reason'), `${verb}: reason is never required`);
    assert.ok(!('thought' in branch.properties), `${verb}: no thought field (it costs output tokens for no gain)`);

    const example = EXAMPLES[verb];
    assert.deepEqual(validate(branch, example), [], `${verb}: its example matches its own branch`);
    assert.deepEqual(validate(union, example), [], `${verb}: its example matches exactly one branch of the union`);
    assert.deepEqual(validate(union, { ...example, reason: 'short reason' }), [], `${verb}: an optional reason is fine`);
  }
});

test('element ids are bounded integers and never an enum', () => {
  const fields = allProperties(buildActionSchema()).filter(([name]) => name === 'element_id');
  assert.ok(fields.length >= 3, 'click, type and the browser_batch steps all have element ids');
  for (const [, schema] of fields) {
    // A bound at the current element count, like an enum of ids, lets the grammar quietly turn
    // a wrong id into a real one (asked for 99 with maximum 15, the models wrote 9).
    assert.deepEqual(schema, { type: 'integer', minimum: 1, maximum: ELEMENT_ID_MAX });
  }
  assert.ok(ELEMENT_ID_MAX >= 999999, 'the bound must stay wide');
});

test('no string field has a maxLength and no pattern uses "."', () => {
  for (const node of allSubschemas(buildActionSchema())) {
    assert.equal(node.maxLength, undefined, 'the grammar cuts a maxLength string in the middle of a word');
    if (node.pattern) {
      // Ollama reads "." as any character, including the closing quote.
      assert.doesNotMatch(node.pattern.replace(/\\./g, ''), /\./, `pattern ${node.pattern} must use explicit ranges`);
    }
  }
});

test('invalid actions are rejected by the union', () => {
  const union = buildActionSchema();
  const rejected = [
    [{ action: 'fly' }, 'unknown verb'],
    [{ action: 'click' }, 'missing element_id'],
    [{ action: 'click', element_id: 3, x: 1 }, 'unknown field'],
    [{ action: 'click', element_id: 0 }, 'element id 0'],
    [{ action: 'click', element_id: -2 }, 'negative element id'],
    [{ action: 'click', element_id: '3' }, 'element id as a string'],
    [{ action: 'click', element_id: 3.5 }, 'element id with a fraction'],
    [{ action: 'type', element_id: 1, text: 'x' }, 'type without submit'],
    [{ action: 'navigate', url: 'www.idealo.de' }, 'bare domain'],
    [{ action: 'navigate', url: 'https://example.com/a b' }, 'space in the URL'],
    [{ action: 'navigate', url: 'https://example.com/"x' }, 'quote in the URL'],
    [{ action: 'scroll', direction: 'left' }, 'unknown direction'],
    [{ action: 'press_key', key: 'Control+A' }, 'unknown key'],
    [{ action: 'wait', amount: 9 }, 'wait above 5 seconds'],
    [{ action: 'read_network_requests', limit: 500 }, 'limit above 50'],
    [{ action: 'browser_batch', steps: [] }, 'empty batch'],
    [{ action: 'browser_batch', steps: Array(BATCH_MAX_STEPS + 1).fill({ action: 'scroll', direction: 'down' }) }, 'too many batch steps'],
    [{ action: 'browser_batch', steps: [{ action: 'navigate', url: 'https://example.com/' }] }, 'a verb the batch executor refuses'],
    [{ action: 'finish' }, 'finish without answer']
  ];
  for (const [value, why] of rejected) {
    assert.notDeepEqual(validate(union, value), [], `must be rejected: ${why}`);
  }
  assert.notDeepEqual(validate(buildActionSchema(ACTION_VERBS, { withReason: false }), { ...EXAMPLES.click, reason: 'r' }), [],
    'withReason:false removes the reason field');
});

test('a subset of verbs builds exactly those branches, and an unknown verb throws', () => {
  const subset = buildActionSchema(['scroll', 'read_page_text', 'finish']);
  assert.deepEqual(subset.oneOf.map((b) => b.properties.action.const), ['scroll', 'read_page_text', 'finish']);
  assert.notDeepEqual(validate(subset, EXAMPLES.click), [], 'a verb outside the subset is impossible');
  assert.throws(() => buildActionSchema(['click', 'mark_blocked']), /Unknown action verb "mark_blocked"/);
  assert.throws(() => buildActionSchema([]), /at least one verb/);
});

test('browser_batch steps are built from the step verbs, in both styles', () => {
  assert.ok(['oneOf', 'flat'].includes(BATCH_STEP_STYLE));
  for (const style of ['oneOf', 'flat']) {
    const steps = buildBatchStepsSchema(style);
    assert.equal(steps.type, 'array', style);
    assert.equal(steps.minItems, 1, style);
    assert.equal(steps.maxItems, BATCH_MAX_STEPS, style);
    assert.deepEqual(unsupportedKeywords(steps), [], style);
    assert.deepEqual(validate(steps, EXAMPLES.browser_batch.steps), [], `${style}: a normal batch is valid`);
    assert.notDeepEqual(validate(steps, [{ action: 'finish', answer: 'x' }]), [], `${style}: finish is not a step`);
  }
  // The oneOf style keeps each step verb's required fields; the flat style cannot.
  const oneOf = buildBatchStepsSchema('oneOf');
  assert.deepEqual(oneOf.items.oneOf.map((b) => b.properties.action.const), BATCH_STEP_VERBS);
  assert.notDeepEqual(validate(oneOf, [{ action: 'type', element_id: 2 }]), [], 'oneOf: a type step needs its text');
  const flat = buildBatchStepsSchema('flat');
  assert.deepEqual(flat.items.properties.action, { enum: BATCH_STEP_VERBS });
  assert.deepEqual(validate(flat, [{ action: 'type', element_id: 2 }]), [], 'flat: every step field is optional');
  assert.throws(() => buildBatchStepsSchema('nested'), /Unknown browser_batch step style/);
});

test('prompt lines: one line per verb, naming its fields', () => {
  const lines = buildActionPromptLines();
  assert.equal(lines.length, ACTION_VERBS.length);
  const union = buildActionSchema();
  ACTION_VERBS.forEach((verb, i) => {
    const fields = Object.keys(union.oneOf[i].properties).filter((f) => f !== 'action' && f !== 'reason');
    const head = `${verb} {${fields.join(', ')}} - `;
    assert.ok(lines[i].startsWith(head), `"${lines[i]}" must start with "${head}"`);
    assert.ok(lines[i].length > head.length + 5, `${verb} has a description`);
    assert.doesNotMatch(lines[i], /\n/);
  });
  assert.match(lines[ACTION_VERBS.indexOf('press_key')], new RegExp(PRESS_KEYS.join(', ')), 'the key names are listed');
  assert.deepEqual(buildActionPromptLines(['finish']), [lines[ACTION_VERBS.indexOf('finish')]]);
});

test('the plan schema is an object with a capped list of {source, goal} steps', () => {
  const schema = buildPlanSchema();
  assert.deepEqual(unsupportedKeywords(schema), []);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['steps']);
  assert.equal(schema.properties.steps.maxItems, PLAN_MAX_STEPS);
  assert.equal(schema.properties.steps.minItems, 1);
  assert.deepEqual(schema.properties.steps.items.required, ['source', 'goal']);
  assert.equal(schema.properties.steps.items.additionalProperties, false);

  const step = { source: 'idealo.de', goal: 'Find the price of the Framework Laptop 16' };
  assert.deepEqual(validate(schema, { steps: [step] }), []);
  assert.notDeepEqual(validate(schema, { steps: Array(PLAN_MAX_STEPS + 1).fill(step) }), [], 'too many steps');
  assert.notDeepEqual(validate(schema, { steps: [] }), [], 'no steps');
  assert.notDeepEqual(validate(schema, ['a', 'b']), [], 'a bare array is not a plan object');
  assert.notDeepEqual(validate(schema, { steps: [{ goal: 'x' }] }), [], 'a step needs its source');
  assert.equal(buildPlanSchema({ maxSteps: 3 }).properties.steps.maxItems, 3);
});

test('the URL pattern takes real URLs and refuses what would break navigation', () => {
  const re = new RegExp(HTTP_URL_PATTERN, 'u');
  for (const ok of [
    'https://www.idealo.de/',
    'http://127.0.0.1:8765/store.html',
    'https://www.google.com/search?q=framework+laptop+16&hl=de',
    'https://www.example.de/zubehör/tastatur',
    'https://geizhals.de/?fs=framework%20laptop%2016#offers'
  ]) assert.match(ok, re);
  for (const bad of ['www.idealo.de', 'idealo.de', 'ftp://example.com/', 'https://', 'https://example.com/a b', 'https://example.com/\\x']) {
    assert.doesNotMatch(bad, re, bad);
  }
});
