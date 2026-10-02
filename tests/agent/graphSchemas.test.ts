import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGraphPlanSchema,
  buildReflectSchema,
  buildPolicySchema,
  validateAgainst
} from '../../src/background/agent/schemas.ts';

test('buildGraphPlanSchema: initial mode validates valid plan and rejects bad plan', () => {
  const schema = buildGraphPlanSchema({ mode: 'initial' });
  assert.equal(schema.type, 'object');
  assert.deepEqual(schema.required, ['task_kind', 'columns', 'search_query', 'compare', 'sites']);

  const validPlan = {
    task_kind: 'research',
    columns: ['price', 'shipping'],
    search_query: 'framework laptop 16',
    compare: { reference_domain: 'frame.work', field: 'price', threshold_pct: 5 },
    sites: [
      {
        domain: 'frame.work',
        url: 'https://frame.work/de',
        goal: 'Find price on official store',
        role: 'reference',
        kind: 'store',
        difficulty: 1,
        required_fields: ['price'],
        done_when: 'all_required',
        check: { type: 'none', value: '' }
      }
    ]
  };

  const res = validateAgainst(schema, validPlan);
  assert.equal(res.ok, true, `Errors: ${res.errors.join(', ')}`);

  const invalidPlan = {
    task_kind: 'invalid_kind',
    columns: []
  };
  const invalidRes = validateAgainst(schema, invalidPlan);
  assert.equal(invalidRes.ok, false);
});

test('buildGraphPlanSchema: revise mode validates plan revision', () => {
  const schema = buildGraphPlanSchema({ mode: 'revise' });
  assert.equal(schema.type, 'object');
  assert.deepEqual(schema.required, ['drop', 'add', 'order', 'reason']);

  const validRevision = {
    drop: ['s2'],
    add: [],
    order: ['s1', 's3'],
    reason: 'Site s2 was blocked.'
  };

  const res = validateAgainst(schema, validRevision);
  assert.equal(res.ok, true, `Errors: ${res.errors.join(', ')}`);
});

test('buildReflectSchema: validates reflect decisions', () => {
  const schema = buildReflectSchema();
  const valid = { decision: 'continue', reason: 'Site completed cleanly.', changes: '' };
  assert.equal(validateAgainst(schema, valid).ok, true);

  const invalid = { decision: 'unknown_decision', reason: 'foo' };
  assert.equal(validateAgainst(schema, invalid).ok, false);
});

test('buildPolicySchema: browse, extract, answer, and harvest schemas', () => {
  // browse mode (collect)
  const browseSchema = buildPolicySchema({ mode: 'browse', goalKind: 'collect', columns: ['price', 'shipping'] });
  assert.equal(validateAgainst(browseSchema, { action: 'click', element_id: 12 }).ok, true);
  assert.equal(validateAgainst(browseSchema, { action: 'record_finding', price: '1299 EUR', shipping: 'free' }).ok, true);
  assert.equal(validateAgainst(browseSchema, { action: 'mark_not_found', reason: 'Out of stock' }).ok, true);
  assert.equal(validateAgainst(browseSchema, { action: 'mark_blocked', reason: 'Captcha wall' }).ok, true);

  // browse mode (do)
  const doSchema = buildPolicySchema({ mode: 'browse', goalKind: 'do' });
  assert.equal(validateAgainst(doSchema, { action: 'subgoal_done', summary: 'Added to cart', evidence: 'Items: 1' }).ok, true);

  // extract mode
  const extractSchema = buildPolicySchema({ mode: 'extract', columns: ['price'] });
  assert.equal(validateAgainst(extractSchema, { action: 'record_finding', price: '100 EUR' }).ok, true);
  assert.equal(validateAgainst(extractSchema, { action: 'continue_browsing', reason: 'Searching further' }).ok, true);
  assert.equal(validateAgainst(extractSchema, { action: 'click', element_id: 1 }).ok, false);

  // answer mode
  const answerSchema = buildPolicySchema({ mode: 'answer' });
  assert.equal(validateAgainst(answerSchema, { action: 'finish', answer: 'Here is the answer' }).ok, true);
  assert.equal(validateAgainst(answerSchema, { action: 'click', element_id: 1 }).ok, false);

  // harvest mode
  const harvestSchema = buildPolicySchema({ mode: 'harvest', columns: ['price'] });
  assert.equal(validateAgainst(harvestSchema, { action: 'record_finding', price: '100 EUR' }).ok, true);
  assert.equal(validateAgainst(harvestSchema, { action: 'scroll', direction: 'down' }).ok, true);
});
