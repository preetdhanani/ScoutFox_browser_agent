/**
 * agent/schemas.ts in isolation: validateAgainst (the reply validator, @cfworker/json-schema) and
 * the parts of the builder that the registry tests do not cover. The schemas built for each
 * verb are checked in tests/shared/actions.test.ts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { REGISTRY, verbsFor } from '../../src/background/agent/actions.ts';
import { buildActionSchema, buildBatchStepsSchema, buildPlanSchema, validateAgainst } from '../../src/background/agent/schemas.ts';

test('validateAgainst says ok with no errors for a value that fits', () => {
  assert.deepEqual(validateAgainst(buildActionSchema(), { action: 'click', element_id: 3 }), { ok: true, errors: [] });
  assert.deepEqual(validateAgainst(buildPlanSchema(), { steps: [{ source: 'a', goal: 'b' }] }), { ok: true, errors: [] });
});

test('validateAgainst names where the value is wrong and why', () => {
  const [click] = buildActionSchema(['click']).oneOf;
  const tooSmall = validateAgainst(click, { action: 'click', element_id: 0 });
  assert.equal(tooSmall.ok, false);
  assert.ok(tooSmall.errors.some((e) => e.startsWith('#/element_id: ') && /less than 1/.test(e)), tooSmall.errors.join('\n'));

  const missing = validateAgainst(click, { action: 'click' });
  assert.ok(missing.errors.some((e) => /required property "element_id"/.test(e)), missing.errors.join('\n'));

  const extra = validateAgainst(click, { action: 'click', element_id: 3, x: 1 });
  assert.ok(extra.errors.some((e) => /"x"/.test(e)), extra.errors.join('\n'));

  const nested = validateAgainst(buildActionSchema(['browser_batch']).oneOf[0], {
    action: 'browser_batch', steps: [{ action: 'click', element_id: 1 }, { action: 'type', element_id: 2 }]
  });
  assert.equal(nested.ok, false);
  assert.ok(nested.errors.every((e) => e.includes(': ')), 'every error has a location and a text');
});

test('validateAgainst lists each problem once, however many branches report it', () => {
  const result = validateAgainst(buildActionSchema(), { action: 'click' });
  assert.equal(result.ok, false);
  assert.equal(new Set(result.errors).size, result.errors.length);
  assert.ok(result.errors.length > 0);
});

test('oneOf needs exactly one matching branch', () => {
  const both = { oneOf: [{ type: 'object', required: ['a'] }, { type: 'object', required: ['b'] }] };
  assert.equal(validateAgainst(both, { a: 1 }).ok, true);
  assert.equal(validateAgainst(both, { a: 1, b: 2 }).ok, false, 'two matching branches are not one');
  assert.equal(validateAgainst(both, {}).ok, false, 'no matching branch');
});

test('validateAgainst understands what the schemas use: integers, enums, consts, patterns with non-ASCII ranges, array bounds', () => {
  const union = buildActionSchema();
  const ok = (value: unknown) => validateAgainst(union, value).ok;
  assert.equal(ok({ action: 'click', element_id: 999999 }), true);
  assert.equal(ok({ action: 'click', element_id: 1000000 }), false, 'above the bound');
  assert.equal(ok({ action: 'click', element_id: 2.0 }), true, '2.0 is the integer 2');
  assert.equal(ok({ action: 'click', element_id: 2.5 }), false);
  assert.equal(ok({ action: 'navigate', url: 'https://www.example.de/zubehör/tastatur' }), true, 'a non-ASCII letter in a URL');
  assert.equal(ok({ action: 'navigate', url: 'https://example.com/a b' }), false);
  assert.equal(ok({ action: 'press_key', key: 'Enter' }), true);
  assert.equal(ok({ action: 'press_key', key: 'enter' }), false, 'enum values are exact');
  assert.equal(ok({ action: 'browser_batch', steps: [] }), false);
  assert.equal(ok({ action: 'browser_batch', steps: [{ action: 'scroll', direction: 'up' }] }), true);
  for (const notAnObject of ['click', 3, null, true, [{ action: 'click', element_id: 1 }]]) {
    assert.equal(ok(notAnObject), false, JSON.stringify(notAnObject));
  }
});

test('validateAgainst checks a value as JSON: undefined properties are absent, and it never throws', () => {
  const union = buildActionSchema();
  assert.equal(validateAgainst(union, { action: 'click', element_id: 3, reason: undefined }).ok, true, 'an undefined optional field is absent');
  assert.equal(validateAgainst(union, { action: 'click', element_id: undefined }).ok, false, 'an undefined required field is missing');
  assert.equal(validateAgainst(union, { action: 'click', element_id: 3, invalidAction: undefined }).ok, true);
  for (const noJsonForm of [undefined, () => 1, Symbol('x')]) {
    const result = validateAgainst(union, noJsonForm);
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /is not a JSON value/);
  }
  assert.equal(validateAgainst(union, NaN).ok, false, 'NaN is null in JSON');
});

test('a built schema is a copy: changing it does not change the registry or the next build', () => {
  const before = JSON.stringify(buildActionSchema());
  const registryBefore = JSON.stringify(REGISTRY);

  const schema = buildActionSchema();
  schema.oneOf[0].properties.element_id.maximum = 3;
  schema.oneOf[0].required.push('x');
  schema.oneOf[1].properties.element_id.minimum = 50;
  buildBatchStepsSchema('flat').items.properties.action.enum.push('navigate');
  buildBatchStepsSchema('oneOf').items.oneOf.pop();
  const plan = buildPlanSchema();
  plan.properties.steps.items.required.push('x');

  assert.equal(JSON.stringify(buildActionSchema()), before);
  assert.equal(JSON.stringify(REGISTRY), registryBefore);
  assert.equal(buildPlanSchema().properties.steps.items.required.length, 2);
});

test('a policy mode is a list of verbs: its schema has one branch per verb, and the modes differ', () => {
  const small = verbsFor('browse', 'small');
  const large = verbsFor('browse', 'large');
  assert.equal(buildActionSchema(small).oneOf.length, small.length);
  assert.ok(large.length > small.length, 'the large tier has more verbs');
  const answer = buildActionSchema(verbsFor('answer', 'small'));
  assert.equal(validateAgainst(answer, { action: 'finish', answer: 'x' }).ok, true);
  assert.equal(validateAgainst(answer, { action: 'click', element_id: 1 }).ok, false, 'answer mode cannot click');
  const browse = buildActionSchema(small);
  assert.equal(validateAgainst(browse, { action: 'execute_js', code: '1' }).ok, false, 'the small tier has no power verbs');
  assert.equal(validateAgainst(buildActionSchema(large), { action: 'execute_js', code: '1' }).ok, true);
});

test('the builder rejects a bad verb list and a bad batch style with a message that says what to do', () => {
  assert.throws(() => buildActionSchema([]), /needs at least one verb/);
  assert.throws(() => buildActionSchema('click' as never), /needs at least one verb/);
  assert.throws(() => buildActionSchema(['clik']), /Unknown action verb "clik"\. Known verbs: click, type/);
  assert.throws(() => buildActionSchema(['browser_batch'], { batchSteps: 'nested' as never }), /Use "oneOf" or "flat"/);
  assert.doesNotThrow(() => buildActionSchema(['click'], { batchSteps: 'nested' as never }), 'the style only matters for browser_batch');
});
