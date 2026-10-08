/**
 * The action registry (shared/actions.json) replaced a hand-written registry in
 * background/actionSchema.js (P0a). What goes to Ollama - the schemas in `format` and the
 * compact system prompt - must not change because the data moved into a file, so
 * shared/fixtures/action-schemas.json holds what the old code produced, and this test replays
 * every case against the current code and compares the bytes (key order included, because the
 * schema text is what Ollama's grammar is made from and what the request-size numbers count).
 *
 * The fixture was generated from the code before the change: every verb set and option
 * combination the code base and the tests use, both batch step styles, the plan schema, the
 * prompt lines and the compact prompt. Change it only when the model request is meant to change.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

global.chrome = {
  storage: { local: { get: (keys, cb) => cb({}), set: (data, cb) => cb && cb() } },
  tabs: { get: (id, cb) => cb({ id, groupId: -1, url: 'https://example.com' }), query: async () => [] }
};

const { AgentEngine } = await import('../background/agentEngine.js');
const { ACTION_VERBS, buildActionPromptLines } = await import('../src/background/agent/actions.ts');
const { buildActionSchema, buildBatchStepsSchema, buildPlanSchema } = await import('../src/background/agent/schemas.ts');

const FIXTURE = JSON.parse(readFileSync(new URL('../shared/fixtures/action-schemas.json', import.meta.url), 'utf8'));
const engine = new AgentEngine();

const FUNCTIONS = {
  buildActionSchema,
  buildBatchStepsSchema,
  buildPlanSchema,
  buildActionPromptLines,
  buildCompactSystemPrompt: (identity) => engine.buildCompactSystemPrompt(identity),
  buildSystemPrompt: (identity, provider) => engine.buildSystemPrompt(identity, provider)
};

/** A null argument in the fixture means the argument was not passed. */
const argsOf = (entry) => entry.args.map((a) => (a === null ? undefined : a));

test('the fixture is complete: known functions only, and every registry verb has its own schema case', () => {
  assert.ok(FIXTURE.cases.length >= 60, `${FIXTURE.cases.length} cases`);
  const names = FIXTURE.cases.map((c) => c.name);
  assert.equal(new Set(names).size, names.length, 'case names are unique');
  for (const entry of FIXTURE.cases) {
    assert.ok(FUNCTIONS[entry.fn], `${entry.name}: unknown function ${entry.fn}`);
    assert.ok(('expected' in entry) !== ('throws' in entry), `${entry.name}: exactly one of expected and throws`);
  }
  for (const verb of ACTION_VERBS) {
    for (const withReason of [true, false]) {
      const found = FIXTURE.cases.some((c) => c.fn === 'buildActionSchema'
        && JSON.stringify(c.args[0]) === JSON.stringify([verb])
        && (withReason ? c.args[1] === null : c.args[1]?.withReason === false));
      assert.ok(found, `${verb} (${withReason ? 'with' : 'without'} reason) has a case`);
    }
  }
  const covered = new Set(FIXTURE.cases.map((c) => c.fn));
  assert.deepEqual([...covered].sort(), Object.keys(FUNCTIONS).sort(), 'every builder has cases');
});

for (const entry of FIXTURE.cases) {
  test(`same bytes as before the registry: ${entry.name}`, () => {
    const run = () => FUNCTIONS[entry.fn](...argsOf(entry));
    if ('throws' in entry) {
      assert.throws(run, (err) => err.message === entry.throws, `${entry.name} must throw "${entry.throws}"`);
      return;
    }
    const actual = run();
    assert.equal(
      typeof actual === 'string' ? actual : JSON.stringify(actual),
      typeof entry.expected === 'string' ? entry.expected : JSON.stringify(entry.expected),
      `${entry.name} changed`
    );
  });
}
