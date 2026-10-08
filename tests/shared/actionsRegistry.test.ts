/**
 * Consistency of the registry data file itself (shared/actions.json): every verb is complete, the
 * alias table is unambiguous, and the tiers and policy modes say what the design says. The
 * schemas and prompt lines built from it are checked in tests/shared/actions.test.ts and (byte for
 * byte) in tests/actionRegistrySnapshot.test.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ACTION_VERBS, REGISTRY, resolveVerb, verbDef, verbsFor } from '../../src/background/agent/actions.ts';
import type { JsonSchema, PolicyMode, Tier } from '../../src/background/agent/actions.ts';
import { BATCH_MAX_STEPS, BATCH_STEP_VERBS, buildActionSchema } from '../../src/background/agent/schemas.ts';

const VERB_KEYS = ['aliases', 'category', 'modes', 'name', 'prompt', 'schema', 'tiers'];
const MODES: PolicyMode[] = ['browse', 'extract', 'answer', 'harvest'];
const TIERS: Tier[] = ['small', 'large'];

/** Every {$ref} and {$batchSteps} marker inside a property schema, at any depth. */
function markers(node: unknown, found: { refs: string[]; batchSteps: number } = { refs: [], batchSteps: 0 }) {
  if (Array.isArray(node)) node.forEach((item) => markers(item, found));
  else if (node && typeof node === 'object') {
    if ('$ref' in node) found.refs.push(String(node.$ref));
    if ('$batchSteps' in node) found.batchSteps++;
    Object.values(node).forEach((item) => markers(item, found));
  }
  return found;
}

test('the registry declares its version, the tiers, the policy modes and the shared definitions', () => {
  assert.equal(REGISTRY.version, 1);
  assert.deepEqual(REGISTRY.tiers, TIERS);
  assert.deepEqual(REGISTRY.modes, MODES);
  assert.ok(Array.isArray(REGISTRY.verbs) && REGISTRY.verbs.length > 0);
  assert.deepEqual(Object.keys(REGISTRY.$defs).sort(), ['elementId', 'httpUrl']);
});

test('every verb has all its fields, with the right types', () => {
  for (const verb of REGISTRY.verbs) {
    const where = `verb "${verb.name}"`;
    assert.deepEqual(Object.keys(verb).sort(), VERB_KEYS, `${where}: exactly the known fields (a typo would be ignored otherwise)`);
    assert.match(verb.name, /^[a-z][a-z0-9_]*$/, `${where}: a snake_case name`);
    assert.ok(['page', 'state'].includes(verb.category), `${where}: category is page or state`);

    for (const [field, values, allowed] of [['tiers', verb.tiers, TIERS], ['modes', verb.modes, MODES]] as const) {
      assert.ok(Array.isArray(values) && values.length > 0, `${where}: ${field} is a non-empty list`);
      assert.equal(new Set(values).size, values.length, `${where}: ${field} has no duplicates`);
      for (const value of values) assert.ok((allowed as readonly string[]).includes(value), `${where}: ${field} names "${value}", which is not a real one`);
    }

    assert.equal(typeof verb.prompt, 'string', `${where}: prompt`);
    assert.ok(Array.isArray(verb.schema.required) && verb.schema.required.every((f) => typeof f === 'string'), `${where}: schema.required is a list of names`);
    assert.equal(typeof verb.schema.properties, 'object', `${where}: schema.properties`);
    assert.ok(Array.isArray(verb.aliases) && verb.aliases.every((a) => typeof a === 'string' && a.length > 0), `${where}: aliases is a list of names`);
    assert.equal(new Set(verb.aliases).size, verb.aliases.length, `${where}: an alias is listed once`);
  }
});

test('no verb is defined twice, and verb helpers agree with the data', () => {
  const names = REGISTRY.verbs.map((v) => v.name);
  assert.equal(new Set(names).size, names.length, 'no duplicate names');
  assert.deepEqual(ACTION_VERBS, names, 'ACTION_VERBS is the registry order');
  for (const name of names) assert.equal(verbDef(name).name, name);
  assert.throws(() => verbDef('mark_blocked'), /Unknown action verb "mark_blocked"\. Known verbs: click, /);
  assert.throws(() => verbDef('press'), /Unknown action verb "press"/, 'verbDef does not resolve aliases');
});

test('the required fields of a verb are declared, and the prompt line names exactly its fields', () => {
  for (const verb of REGISTRY.verbs) {
    const fields = Object.keys(verb.schema.properties);
    for (const required of verb.schema.required) {
      assert.ok(fields.includes(required), `${verb.name}: required field "${required}" is declared in properties`);
    }
    assert.ok(!fields.includes('action') && !fields.includes('reason'), `${verb.name}: action and reason are added by the builder`);
    assert.ok(verb.prompt.startsWith(`${verb.name} {${fields.join(', ')}} - `), `${verb.name}: prompt "${verb.prompt}" starts with the name and the field list`);
    assert.ok(verb.prompt.length > `${verb.name} {${fields.join(', ')}} - `.length + 5, `${verb.name}: the prompt has a description`);
    assert.doesNotMatch(verb.prompt, /\n|\u2014/, `${verb.name}: the prompt is one line and has no em dash`);
  }
});

test('every alias resolves to exactly one verb', () => {
  const owners = new Map<string, string[]>();
  for (const verb of REGISTRY.verbs) {
    for (const alias of verb.aliases) owners.set(alias, [...(owners.get(alias) ?? []), verb.name]);
  }
  assert.ok(owners.size >= 20, `the alias table is not empty (${owners.size} aliases)`);
  for (const [alias, verbs] of owners) {
    assert.equal(verbs.length, 1, `alias "${alias}" belongs to ${verbs.join(' and ')}`);
    assert.ok(!ACTION_VERBS.includes(alias), `alias "${alias}" is also a verb name`);
    assert.equal(resolveVerb(alias), verbs[0], `alias "${alias}" resolves to its verb`);
  }
  for (const verb of ACTION_VERBS) assert.equal(resolveVerb(verb), verb, `${verb} resolves to itself`);
});

test('resolveVerb is an exact match, and a name that is not a string never resolves', () => {
  for (const name of ['', ' click', 'click ', 'Click', 'CLICK', 'constructor', '__proto__', 'toString', 'hasOwnProperty', 'fly', 'mark_blocked']) {
    assert.equal(resolveVerb(name), undefined, JSON.stringify(name));
  }
  for (const value of [undefined, null, 42, true, ['click'], { action: 'click' }]) {
    assert.equal(resolveVerb(value), undefined, JSON.stringify(value));
  }
});

test('the tiers and policy modes name real verbs and say what the design says', () => {
  for (const mode of MODES) {
    for (const tier of TIERS) {
      const verbs = verbsFor(mode, tier);
      assert.ok(verbs.length > 0, `${mode} on the ${tier} tier offers verbs`);
      assert.equal(new Set(verbs).size, verbs.length);
      for (const verb of verbs) assert.ok(ACTION_VERBS.includes(verb), `${mode}/${tier} names the unknown verb "${verb}"`);
      assert.ok(verbs.includes('ask_user'), `ask_user is allowed in every mode (${mode}/${tier})`);
      // The mode's schema is its verbs, built by the same builder as any other list.
      assert.deepEqual(buildActionSchema(verbs).oneOf.map((b: JsonSchema) => b.properties.action.const), verbs);
    }
  }

  // docs/langgraph-design.md, "Policy modes" and "Tiers" (only the verbs that exist in the registry today).
  const power = ['execute_js', 'read_network_requests', 'browser_batch', 'open_window'];
  assert.deepEqual(verbsFor('browse', 'small'),
    ['click', 'type', 'scroll', 'press_key', 'navigate', 'go_back', 'go_forward', 'read_page_text', 'wait', 'ask_user'],
    'the small tier browse set has no power verbs');
  assert.deepEqual(verbsFor('browse', 'large'),
    ['click', 'type', 'scroll', 'press_key', 'navigate', 'go_back', 'go_forward', 'read_page_text',
      'execute_js', 'read_network_requests', 'browser_batch', 'wait', 'ask_user', 'open_window'],
    'the large tier adds the four power verbs to browse');
  assert.deepEqual(verbsFor('answer', 'small'), ['scroll', 'read_page_text', 'finish', 'ask_user']);
  assert.deepEqual(verbsFor('extract', 'small'), ['scroll', 'read_page_text', 'ask_user']);
  assert.deepEqual(verbsFor('harvest', 'small'), ['scroll', 'read_page_text', 'ask_user']);
  for (const verb of power) assert.deepEqual(verbDef(verb).tiers, ['large'], `${verb} is a power verb`);
  for (const verb of ACTION_VERBS.filter((v) => !power.includes(v))) assert.deepEqual(verbDef(verb).tiers, ['small', 'large'], verb);
  assert.deepEqual(verbDef('finish').modes, ['answer'], 'finish only ends a run in answer mode');
});

test('page verbs are the ones the design lists, and finish and ask_user are state verbs', () => {
  const page = REGISTRY.verbs.filter((v) => v.category === 'page').map((v) => v.name);
  assert.deepEqual(page, [
    'click', 'type', 'scroll', 'press_key', 'navigate', 'go_back', 'go_forward', 'read_page_text',
    'execute_js', 'read_network_requests', 'browser_batch', 'wait', 'open_window'
  ]);
  assert.deepEqual(REGISTRY.verbs.filter((v) => v.category === 'state').map((v) => v.name), ['finish', 'ask_user']);
});

test('the shared definitions are all used, and every reference resolves', () => {
  const used = new Set<string>();
  let batchMarkers = 0;
  for (const verb of REGISTRY.verbs) {
    const found = markers(verb.schema.properties);
    for (const ref of found.refs) {
      assert.match(ref, /^#\/\$defs\//, `${verb.name}: reference ${ref}`);
      const name = ref.slice('#/$defs/'.length);
      assert.ok(REGISTRY.$defs[name], `${verb.name}: ${ref} is defined`);
      used.add(name);
    }
    if (found.batchSteps) {
      assert.equal(verb.name, 'browser_batch', 'only browser_batch has steps');
      batchMarkers += found.batchSteps;
    }
  }
  assert.deepEqual([...used].sort(), Object.keys(REGISTRY.$defs).sort(), 'no unused definition');
  assert.equal(batchMarkers, 1, 'browser_batch has its steps marker once');
  assert.equal(markers(REGISTRY.$defs).refs.length, 0, 'a definition does not refer to another one');
});

test('the browser_batch block matches the verbs it names and the prompt line', () => {
  assert.ok(Number.isInteger(BATCH_MAX_STEPS) && BATCH_MAX_STEPS > 0);
  assert.equal(new Set(BATCH_STEP_VERBS).size, BATCH_STEP_VERBS.length);
  for (const step of BATCH_STEP_VERBS) {
    assert.ok(ACTION_VERBS.includes(step), `step verb "${step}" is a verb`);
    assert.equal(verbDef(step).category, 'page', `step verb "${step}" is a page verb`);
    assert.ok(verbDef(step).tiers.includes('small'), `step verb "${step}" is a base verb, not a power verb`);
  }
  assert.ok(!BATCH_STEP_VERBS.includes('browser_batch'), 'a batch cannot hold a batch');
  // The prompt line repeats these two facts in words; they must not drift from the data.
  const last = BATCH_STEP_VERBS[BATCH_STEP_VERBS.length - 1];
  const words = `${BATCH_STEP_VERBS.slice(0, -1).join(', ')} or ${last}`;
  assert.ok(verbDef('browser_batch').prompt.includes(`run up to ${BATCH_MAX_STEPS} steps`), 'the prompt names the step limit');
  assert.ok(verbDef('browser_batch').prompt.includes(`each step is a ${words} action`), 'the prompt names the step verbs');
});
