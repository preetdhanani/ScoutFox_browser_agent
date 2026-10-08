/**
 * src/background/agent/parse.ts: raw model output -> the action, or the parse error the model sees.
 *
 * Most cases are data (shared/fixtures/parse-cases.json, also meant for the Python runner): DeepSeek
 * DSML, Anthropic function_calls, Qwen <tool_call> and OpenAI tool_calls, well-formed and cut off;
 * nested browser_batch and filter objects; braces and quotes inside strings; fenced JSON; think
 * tags; text intents; prose. The rest of this file is what data cannot say: a reply in tool-call
 * markup never becomes a finish however it is cut, a reply cut off inside an object is never
 * repaired into a different action, and hostile input (megabytes of junk, unclosed tags, deep
 * nesting) is handled in linear time and never throws.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import fixture from '../shared/fixtures/parse-cases.json' with { type: 'json' };
import { ACTION_VERBS, verbsFor } from '../src/background/agent/actions.ts';
import type { PolicyMode, Tier } from '../src/background/agent/actions.ts';
import { parseBareActionJson, parseModelReply, planTextsFromStepsObject } from '../src/background/agent/parse.ts';
import type { ParseResult } from '../src/background/agent/parse.ts';
import { refsFromCount } from '../src/background/agent/sanitize.ts';
import { TOOL_CALL_MARKUP, TOOL_CALL_MARKUP_ERROR } from '../src/background/agent/toolCalls.ts';

interface FixtureCase {
  name: string;
  input: string | string[];
  scope?: 'all' | { mode: PolicyMode; tier: Tier };
  refs?: number | number[] | null;
  neverFinish?: boolean;
  expect: {
    action?: Record<string, unknown>;
    thought?: string;
    error?: string;
    kind?: string;
  };
}

const cases = (fixture as unknown as { cases: FixtureCase[] }).cases;

function verbsOf(scope: FixtureCase['scope']): string[] {
  return scope === undefined || scope === 'all' ? ACTION_VERBS : verbsFor(scope.mode, scope.tier);
}

function refsOf(refs: FixtureCase['refs']) {
  if (refs === null) return undefined;
  if (Array.isArray(refs)) return new Set(refs);
  return refsFromCount(refs ?? 10);
}

function textOf(input: string | string[]): string {
  return Array.isArray(input) ? input.join('\n') : input;
}

function parseCase(c: FixtureCase): ParseResult {
  return parseModelReply(textOf(c.input), { verbs: verbsOf(c.scope), refs: refsOf(c.refs) });
}

function isFinish(result: ParseResult): boolean {
  return result.action !== undefined && result.action.action === 'finish';
}

const ALL = { verbs: ACTION_VERBS, refs: refsFromCount(10) };

/* ------------------------------------------------------------------ *
 * The fixture file
 * ------------------------------------------------------------------ */

for (const c of cases) {
  test(`fixture: ${c.name}`, () => {
    const result = parseCase(c);
    const { expect } = c;

    if (expect.action !== undefined) {
      assert.equal(result.error, undefined, `expected an action, got the error: ${result.error}`);
      assert.deepEqual(result.action, expect.action);
    } else {
      assert.equal(result.action, undefined, `expected an error, got the action: ${JSON.stringify(result.action)}`);
    }
    if (expect.error !== undefined) assert.equal(result.error, expect.error);
    if (expect.kind !== undefined) assert.equal(result.error === undefined ? undefined : result.kind, expect.kind);
    if (expect.thought !== undefined) assert.equal(result.thought, expect.thought);
    if (c.neverFinish) assert.equal(isFinish(result), false, 'a tool-call reply must never end the run');
  });
}

test('the fixture file has at least 40 cases, unique names, and every kind of tool-call reply', () => {
  assert.ok(cases.length >= 40, `only ${cases.length} cases`);
  assert.equal(new Set(cases.map((c) => c.name)).size, cases.length, 'case names must be unique');
  const inputs = cases.map((c) => textOf(c.input));
  for (const [what, pattern] of [
    ['DeepSeek DSML', /DSML/],
    ['Anthropic invoke', /<invoke name=/],
    ['function_calls', /<function_calls>/],
    ['Qwen <tool_call>', /<tool_call>/],
    ['OpenAI tool_calls', /"tool_calls"/],
    ['a <think> block', /<think>/],
    ['a fenced block', /```/],
    ['a nested browser_batch', /browser_batch/]
  ] as const) {
    assert.ok(inputs.some((input) => pattern.test(input)), `no case has ${what}`);
  }
  // The two the design names: malformed DSML and a truncated <tool_call>, for answer mode.
  const answerMode = cases.filter((c) => typeof c.scope === 'object' && c.scope.mode === 'answer' && c.neverFinish);
  assert.ok(answerMode.some((c) => /DSML/.test(textOf(c.input)) && c.expect.kind === 'tool_call_markup'), 'malformed DSML for answer mode');
  assert.ok(answerMode.some((c) => /<tool_call>/.test(textOf(c.input)) && c.expect.kind === 'tool_call_markup'), 'a truncated <tool_call> for answer mode');
  assert.ok(cases.filter((c) => c.neverFinish).length >= 20, 'the tool-call cases must say neverFinish');
});

test('every tool-call error in the fixture is the design text, and every neverFinish case holds', () => {
  for (const c of cases.filter((x) => x.expect.kind === 'tool_call_markup')) {
    assert.equal(c.expect.error, TOOL_CALL_MARKUP_ERROR, c.name);
    assert.equal(c.neverFinish, true, `${c.name} must say neverFinish`);
  }
  assert.equal(TOOL_CALL_MARKUP_ERROR, 'Your reply used tool-call markup. This agent does not use tool calls. Reply with a single JSON object {"action": ...}.');
});

/* ------------------------------------------------------------------ *
 * Tool-call markup never becomes prose, however it is cut
 * ------------------------------------------------------------------ */

const DSML_CLICK = '<｜DSML｜function_calls>\n<｜DSML｜invoke name="click">\n<｜DSML｜parameter name="element_id" string="false">5</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜function_calls>';
const DSML_ASCII = DSML_CLICK.replaceAll('｜', '|');
const QWEN_CLICK = '<tool_call>\n{"name": "click", "arguments": {"element_id": 5}}\n</tool_call>';
const ANTHROPIC_SCROLL = '<function_calls>\n<invoke name="scroll">\n<parameter name="direction">down</parameter>\n</invoke>\n</function_calls>';
const OPENAI_CLICK = JSON.stringify({ role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'click', arguments: '{"element_id":5}' } }] });
const OLD_DEEPSEEK = '<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>click\n```json\n{"element_id": 5}\n```<｜tool▁call▁end｜><｜tool▁calls▁end｜>';
// The formats of other model families (Llama, Qwen3-Coder, Mistral, Granite, Gemma, the old OpenAI key, and bare JSON).
const PYTHON_TAG_CLICK = '<|python_tag|>{"name": "click", "parameters": {"element_id": 5}}';
const FUNCTION_TAG_CLICK = '<function=click>{"element_id": 5}</function>';
const QWEN_CODER_CLICK = '<tool_call>\n<function=click>\n<parameter=element_id>\n5\n</parameter>\n</function>\n</tool_call>';
const MISTRAL_CLICK = '[TOOL_CALLS] [{"name": "click", "arguments": {"element_id": 5}}]';
const GRANITE_CLICK = '<|tool_call|>[{"name": "click", "arguments": {"element_id": 5}}]';
const GEMMA_CLICK = '```tool_code\nclick(element_id=5)\n```';
const FUNCTION_CALL_KEY = '{"function_call": {"name": "click", "arguments": "{\\"element_id\\": 5}"}}';
const BARE_CALL = '{"name": "click", "arguments": {"element_id": 5}}';
const OPENAI_ENTRY = '{"id": "7", "type": "function", "function": {"name": "click", "arguments": "{\\"element_id\\": 5}"}}';
const OTHER_FAMILIES: Array<[string, string]> = [
  ['Llama python_tag', PYTHON_TAG_CLICK], ['Llama function tag', FUNCTION_TAG_CLICK], ['Qwen3-Coder', QWEN_CODER_CLICK], ['Mistral', MISTRAL_CLICK],
  ['Granite', GRANITE_CLICK], ['Gemma tool_code', GEMMA_CLICK], ['function_call key', FUNCTION_CALL_KEY], ['bare name and arguments', BARE_CALL], ['OpenAI entry', OPENAI_ENTRY]
];

test('every prefix of a tool-call reply is never a finish, in any mode', () => {
  const modes: Array<string[]> = [ACTION_VERBS, verbsFor('answer', 'large'), verbsFor('browse', 'large'), verbsFor('browse', 'small')];
  for (const [label, reply] of [['DSML', DSML_CLICK], ['DSML with | bars', DSML_ASCII], ['Qwen', QWEN_CLICK], ['Anthropic', ANTHROPIC_SCROLL], ['OpenAI', OPENAI_CLICK], ['old DeepSeek tokens', OLD_DEEPSEEK]]) {
    for (const verbs of modes) {
      for (let length = 0; length <= reply.length; length++) {
        const prefix = reply.slice(0, length);
        const result = parseModelReply(prefix, { verbs, refs: refsFromCount(10) });
        assert.equal(isFinish(result), false, `${label}, ${verbs.length} verbs, cut at ${length}: ${JSON.stringify(prefix.slice(-30))} became a finish`);
        if (result.action !== undefined) assert.notEqual(result.action.autoWrapped, true, `${label} cut at ${length} was wrapped as prose`);
      }
    }
  }
});

test('every prefix of a reply in another family\'s tool-call format is never a finish or prose, in any mode', () => {
  const modes: Array<string[]> = [ACTION_VERBS, verbsFor('answer', 'large'), verbsFor('browse', 'large'), verbsFor('browse', 'small')];
  for (const [label, reply] of OTHER_FAMILIES) {
    for (const verbs of modes) {
      for (let length = 0; length <= reply.length; length++) {
        const prefix = reply.slice(0, length);
        const result = parseModelReply(prefix, { verbs, refs: refsFromCount(10) });
        // A prefix with almost nothing in it ("<", "[T") is too short to be told from prose, and is not a call either.
        if (length < 4) continue;
        assert.equal(isFinish(result), false, `${label}, ${verbs.length} verbs, cut at ${length}: ${JSON.stringify(prefix.slice(-30))} became a finish`);
        if (result.action !== undefined) {
          assert.notEqual(result.action.autoWrapped, true, `${label} cut at ${length} was wrapped as prose`);
          assert.deepEqual(result.action, { action: 'click', element_id: 5 }, `${label} cut at ${length} gave another action`);
        }
      }
    }
  }
});

test('each family\'s whole reply is converted, or is the tool-call error where the mode does not offer the verb', () => {
  for (const [label, reply] of OTHER_FAMILIES) {
    const result = parseModelReply(reply, ALL);
    if (label === 'Gemma tool_code') {
      assert.equal(result.kind, 'tool_call_markup', label);
      continue;
    }
    assert.deepEqual(result.action, { action: 'click', element_id: 5 }, label);
    const answerMode = parseModelReply(reply, { verbs: verbsFor('answer', 'large'), refs: refsFromCount(10) });
    assert.equal(answerMode.kind, 'tool_call_markup', `${label} in answer mode`);
    assert.equal(answerMode.error, TOOL_CALL_MARKUP_ERROR, label);
    const offPage = parseModelReply(reply.replace('5', '99'), { verbs: ACTION_VERBS, refs: refsFromCount(10) });
    assert.equal(offPage.kind, 'bad_element_id', `${label}: a converted call is checked like any action`);
  }
});

test('a tool call with a token, followed by an action in JSON, is still the tool call (the markup wins, as for the other formats)', () => {
  // A bare call ({"name": ..., "arguments": ...}) has no token, so an action object next to it is the action.
  for (const [label, reply] of OTHER_FAMILIES.filter(([label]) => label !== 'bare name and arguments' && label !== 'OpenAI entry')) {
    const result = parseModelReply(`${reply}\n{"action":"finish","answer":"guess"}`, ALL);
    assert.equal(isFinish(result), false, label);
  }
  assert.equal(parseModelReply(`${BARE_CALL}\n{"action":"scroll","direction":"down"}`, ALL).action?.action, 'scroll');
});

test('every prefix of a tool-call reply that has one whole markup token is a converted action or the tool-call error', () => {
  for (const [label, reply] of [['DSML', DSML_CLICK], ['Qwen', QWEN_CLICK], ['Anthropic', ANTHROPIC_SCROLL], ['OpenAI', OPENAI_CLICK]]) {
    const start = { DSML: 16, Qwen: 11, Anthropic: 16, OpenAI: reply.indexOf('"tool_calls":') + 13 }[label] as number;
    for (let length = start; length <= reply.length; length++) {
      const result = parseModelReply(reply.slice(0, length), ALL);
      if (result.action !== undefined) {
        assert.ok(['click', 'scroll'].includes(result.action.action as string), `${label} cut at ${length} gave ${JSON.stringify(result.action)}`);
      } else {
        assert.equal(result.kind, 'tool_call_markup', `${label} cut at ${length} gave ${result.error}`);
        assert.equal(result.error, TOOL_CALL_MARKUP_ERROR);
      }
    }
  }
});

test('markup inside a fenced block, after prose, or after a think block is still markup', () => {
  for (const reply of [`\`\`\`xml\n${QWEN_CLICK}\n\`\`\``, `Sure, doing it.\n${DSML_CLICK}`, `<think>hmm</think>\n${DSML_CLICK}`, `${QWEN_CLICK}\nAnd then the answer is {"action":"finish","answer":"done"}`]) {
    const result = parseModelReply(reply, ALL);
    assert.deepEqual(result.action, { action: 'click', element_id: 5 }, reply);
  }
});

test('once markup is found, a JSON finish written next to it is not used', () => {
  const both = `<tool_call>\n{"name": "web_search", "arguments": {"q": "x"}}\n</tool_call>\n{"action":"finish","answer":"guess"}`;
  const result = parseModelReply(both, ALL);
  assert.equal(result.action, undefined);
  assert.equal(result.kind, 'tool_call_markup');
});

test('a reply cut off inside an object is not repaired into a different action', () => {
  const ALL_20 = { verbs: ACTION_VERBS, refs: refsFromCount(20) };
  const reply = JSON.stringify({ action: 'click', element_id: 12, reason: 'the second result' });
  for (let length = 1; length < reply.length; length++) {
    const result = parseModelReply(reply.slice(0, length), ALL_20);
    assert.equal(result.action, undefined, `cut at ${length} (${JSON.stringify(reply.slice(0, length))}) gave ${JSON.stringify(result.action)}`);
  }
  assert.deepEqual(parseModelReply(reply, ALL_20).action, { action: 'click', element_id: 12, reason: 'the second result' });

  const navigate = JSON.stringify({ action: 'navigate', url: 'https://www.idealo.de/preisvergleich/OffersOfProduct/1.html' });
  for (let length = 1; length < navigate.length; length++) {
    const result = parseModelReply(`\`\`\`json\n${navigate.slice(0, length)}`, ALL);
    assert.equal(result.action, undefined, `an unfinished fence cut at ${length} opened a page`);
  }
});

test('a stray brace or quote in the prose before an action never changes the action', () => {
  const actions = [
    { action: 'click', element_id: 3 },
    { action: 'scroll', direction: 'down' },
    { action: 'browser_batch', steps: [{ action: 'type', element_id: 1, text: 'a@b.com' }, { action: 'click', element_id: 2 }] },
    { action: 'finish', answer: 'Price {ab} is "1.399,00" EUR' },
    { action: 'execute_js', code: 'if (x) { y(); }' }
  ];
  const preambles = [
    'I see the text "{" on the page.',
    'Selector would be div.price { color... Anyway:',
    '{',
    '{{',
    'A { and a " and a [ and a ` in one line.',
    '{go to https://a.de/x',
    '```json\n{"click": 4}',
    'Use {curly} braces, then { another one',
    'He said "hi { there'
  ];
  for (const action of actions) {
    const bare = parseModelReply(JSON.stringify(action), ALL);
    assert.deepEqual(bare.action, action, 'the bare action is the reference');
    for (const preamble of preambles) {
      for (const separator of ['\n', ' ']) {
        const text = `${preamble}${separator}${JSON.stringify(action)}`;
        const result = parseModelReply(text, ALL);
        // "```json\n{"click": 4}" is a fence with no closing marker: the later object wins as it always did.
        assert.deepEqual(result.action, action, `${JSON.stringify(text)} gave ${JSON.stringify(result.action ?? result.error)}`);
      }
    }
  }
});

test('which object is the action: the first one with an action key, else the last alias shape', () => {
  const click3 = { action: 'click', element_id: 3 };
  const first = (text: string) => parseModelReply(text, ALL).action;
  // The old engine's order. A later object never replaces an action, whatever it looks like.
  assert.deepEqual(first(`I will click {"action":"click","element_id":3}. The button has attributes {"type": "submit"}.`), click3);
  assert.deepEqual(first(`My action: {"action":"click","element_id":3}. (Then I would send {"action": "finish", "answer": "..."}.)`), click3);
  assert.deepEqual(first(`{"action":"click","element_id":3} {"action":"finish","answer":"done"} {"click": 9}`), click3);
  assert.deepEqual(first('[{"action":"click","element_id":3},{"action":"click","element_id":4}]'), click3);
  assert.deepEqual(first('{"type": "submit"} {"finish": "x"} {"action":"click","element_id":3}'), click3, 'an alias shape before the action does not win either');
  assert.deepEqual(first('```json\n{"action":"click","element_id":3}\n```\nthen ```json\n{"action":"finish","answer":"x"}\n```'), click3, 'the first fenced block');
  // With no action key anywhere, the last alias shape wins, as the old backwards scan did.
  assert.deepEqual(first('{"click": 1} then {"click": 3}'), { click: 3, action: 'click', element_id: 3 });
  assert.deepEqual(first('{"click": 3} {"note": "x"}'), { click: 3, action: 'click', element_id: 3 });
  // An OpenAI entry has a type key too, and is a tool call, not the {"type": ...} shape.
  assert.deepEqual(first('{"id":"7","type":"function","function":{"name":"click","arguments":"{\\"element_id\\":3}"}}'), click3);
  assert.equal(first('{"id":"7","type":"function","function":{"name":"click","arguments":"{}"}}')?.action, 'click', 'and never a type action with the id of the call');
});

test('a closing think tag with no opening one ends the reasoning, unless it sits inside an object', () => {
  const orphan = parseModelReply('I could use a <tool_call> but this agent wants JSON.</think>\n{"action":"click","element_id":3}', ALL);
  assert.deepEqual(orphan.action, { action: 'click', element_id: 3 });
  assert.equal(orphan.thought, 'I could use a <tool_call> but this agent wants JSON.');
  const noOpen = parseModelReply('hmm, maybe scroll first</reasoning>{"action":"scroll","direction":"down"}', ALL);
  assert.deepEqual(noOpen.action, { action: 'scroll', direction: 'down' });
  assert.equal(noOpen.thought, 'hmm, maybe scroll first');
  const prose = parseModelReply('Weighing the options.</think>The price is 5 EUR.', ALL);
  assert.equal(prose.action?.answer, 'The price is 5 EUR.');
  assert.equal(prose.thought, 'Weighing the options.');
  // Inside the strings of an action it is text, and the answer is kept whole.
  const inside = parseModelReply('```json\n{"action":"finish","answer":"end a block with </think> and go on"}\n```', ALL);
  assert.equal(inside.action?.answer, 'end a block with </think> and go on');
  assert.equal(inside.thought, '');
  // A pair still works as before, and a second orphan later is left in the text.
  const pair = parseModelReply('<think>a</think>{"action":"scroll","direction":"up"}', ALL);
  assert.equal(pair.thought, 'a');
  assert.deepEqual(pair.action, { action: 'scroll', direction: 'up' });
});

test('markup words in the strings of an action are content: an answer about tool calls is an answer, and typed text is text', () => {
  const answer = '```json\n{"action":"finish","answer":"The docs say: wrap each call in <tool_call> tags, or use <invoke name=\\"x\\">."}\n```';
  assert.equal(parseModelReply(answer, ALL).action?.answer, 'The docs say: wrap each call in <tool_call> tags, or use <invoke name="x">.');
  assert.deepEqual(parseModelReply('Typing the query.\n{"action":"type","element_id":3,"text":"<invoke name=","submit":true}', ALL).action, { action: 'type', element_id: 3, text: '<invoke name=', submit: true });
  // A reply that is a tool call is still one, even when an action object sits next to it.
  assert.equal(parseModelReply('<tool_call>x</tool_call> {"action":"finish","answer":"<tool_call>"}', ALL).kind, 'tool_call_markup');
  // And an object that is cut off, or has no action key, does not hide markup in its strings.
  assert.equal(parseModelReply('{"action":"finish","answer":"<tool_call>"', ALL).kind, 'tool_call_markup');
  assert.equal(parseModelReply('{"note":"<tool_call>","tool_calls":[]}', ALL).kind, 'tool_call_markup');
});

test('a rejected element_id: the design text by default, the old wording when the old engine asks for it', () => {
  const design = 'Element [99] is not in the current element list (it may be from an older view of the page). Use an id from the list.';
  const legacy = 'Selected element_id 99 does not exist on this page (valid range: 1-10). Re-check the numbered element list and choose a real one.';
  const single = '{"action":"click","element_id":99}';
  const batch = '{"action":"browser_batch","steps":[{"action":"click","element_id":99}]}';
  assert.equal(parseModelReply(single, ALL).error, design);
  assert.equal(parseModelReply(single, { ...ALL, legacyElementIdError: true }).error, legacy);
  assert.equal(parseModelReply(single, { ...ALL, legacyElementIdError: true }).kind, 'bad_element_id');
  assert.equal(parseModelReply(single, { verbs: ACTION_VERBS }).error, undefined, 'with no list of ids any id of 1 or more is fine');
  assert.equal(parseModelReply('{"action":"click","element_id":0}', { verbs: ACTION_VERBS, legacyElementIdError: true }).error, 'Selected element_id 0 does not exist on this page (valid ids start at 1). Re-check the numbered element list and choose a real one.');
  // A batch step has the design text either way, so one reply never mixes two texts for the same rule under the default.
  assert.equal(parseModelReply(batch, ALL).error, design);
  assert.equal(parseModelReply(batch, { ...ALL, legacyElementIdError: true }).error, design);
  // The id is shown the way the model wrote it: a number, a numeric string as a number, anything else in quotes.
  assert.equal(parseModelReply('{"action":"click","element_id":"99"}', ALL).error, design);
  assert.match(parseModelReply('{"action":"click","element_id":"abc"}', ALL).error ?? '', /^Element \["abc"\] is not in the current element list/);
  assert.match(parseModelReply('{"action":"click","element_id":3.9}', ALL).error ?? '', /^Element \[3\.9\] is not in the current element list/);
});

test('a record with a name in an answer is prose, not a tool call', () => {
  for (const answer of [
    'The product is {"name": "Framework Laptop 16", "input": "laptop", "price": 1399}.',
    'Result: {"name": "John", "arguments": 5} is the entry.',
    '{"name": "Framework", "input": "laptop"}'
  ]) {
    const result = parseModelReply(answer, ALL);
    assert.equal(result.action?.action, 'finish', answer);
    assert.equal(result.action?.autoWrapped, true, answer);
  }
});

test('an unknown verb keeps its own text, and a verb the mode does not offer says so', () => {
  assert.match(parseModelReply('{"action":"hover","element_id":3}', ALL).error ?? '', /^Unknown action "hover"\. Valid actions are: /);
  assert.match(parseModelReply('{"action":"execute_js","code":"1"}', { verbs: verbsFor('browse', 'small') }).error ?? '', /^Action "execute_js" is not available here\. Valid actions are: /);
});

test('no prefix of a plain prose answer is affected: prose still becomes an unconfirmed finish', () => {
  const prose = 'The Framework Laptop 16 costs 1.599,00 EUR at frame.work.';
  const result = parseModelReply(prose, ALL);
  assert.deepEqual(result.action, { action: 'finish', answer: prose, reason: 'Direct text output from model', autoWrapped: true });
});

/* ------------------------------------------------------------------ *
 * Hostile and odd input: linear time, never a throw
 * ------------------------------------------------------------------ */

/** Runs a parse and fails when it takes longer than the limit, which is what quadratic backtracking looks like. */
function within(label: string, limitMs: number, text: string, options = ALL): ParseResult {
  const started = performance.now();
  const result = parseModelReply(text, options);
  const took = performance.now() - started;
  assert.ok(took < limitMs, `${label}: ${text.length} characters took ${took.toFixed(0)} ms (limit ${limitMs} ms)`);
  return result;
}

const MB = 1_000_000;

test('long junk is a parse error or prose, in linear time', () => {
  const junk = within('random junk', 1500, 'lorem ipsum dolor sit amet '.repeat(40_000));
  assert.equal(junk.action?.action, 'finish', 'plain prose is still wrapped');
  assert.equal(junk.action?.autoWrapped, true);
  const noise = within('symbol soup', 1500, '{[("\\}])<>/`'.repeat(80_000));
  assert.ok(noise.action === undefined || noise.action.autoWrapped === true, 'symbol soup is an error or a flagged prose finish');
});

test('a very long input finds the action at its end, in linear time', () => {
  const text = `${'word {brace} "quote" '.repeat(50_000)} {"action":"scroll","direction":"down"}`;
  const result = within('one action after a megabyte', 1500, text);
  assert.deepEqual(result.action, { action: 'scroll', direction: 'down' });
});

test('very many objects: the action among them is found, in linear time', () => {
  const text = `${'{"a":1}'.repeat(100_000)}{"action":"click","element_id":4}${'{"b":2}'.repeat(10_000)}`;
  const result = within('100000 objects', 2000, text);
  assert.deepEqual(result.action, { action: 'click', element_id: 4 });
  // Actions first: the first one wins, and the scan ends there.
  const actions = within('100000 actions', 2000, `{"action":"click","element_id":4}${'{"action":"scroll","direction":"down"}'.repeat(100_000)}`);
  assert.deepEqual(actions.action, { action: 'click', element_id: 4 });
  // Alias shapes only: all of them are read, and the last wins.
  const aliases = within('100000 alias shapes', 3000, `${'{"click": 1}'.repeat(100_000)}{"click": 4}`);
  assert.deepEqual(aliases.action, { click: 4, action: 'click', element_id: 4 });
  // Markup words in the strings of many complete actions are checked once.
  const strings = within('50000 actions with markup words', 3000, '{"action":"finish","answer":"<tool_call>"}'.repeat(50_000));
  assert.equal(strings.action?.action, 'finish');
});

test('unbalanced braces, brackets and quotes', () => {
  // Starting with an object that never closes: a cut-off JSON payload, so a parse error and never prose.
  for (const text of ['{'.repeat(200_000), '{"'.repeat(100_000), '{"action":"click","element_id":'.repeat(20_000)]) {
    const result = within('unclosed object', 1500, text);
    assert.equal(result.action, undefined, text.slice(0, 20));
    assert.equal(result.kind, 'malformed', text.slice(0, 20));
  }
  // Anything else that is not JSON is prose, as it always was, and is flagged unconfirmed.
  for (const text of ['}'.repeat(200_000), '['.repeat(200_000), '"'.repeat(200_000)]) {
    const result = within('junk that is prose', 1500, text);
    assert.equal(result.action?.autoWrapped, true, text.slice(0, 20));
  }
});

test('deeply nested JSON does not overflow the stack', () => {
  for (const depth of [10_000, 200_000]) {
    const nested = `{"action":"click","element_id":3,"x":${'['.repeat(depth)}${']'.repeat(depth)}}`;
    const result = within('deep nesting', 2000, nested);
    // The engine may give the action or an error, but it must return.
    assert.ok(result.action !== undefined || typeof result.error === 'string');
    const fenced = within('deep nesting in a fence', 2000, `\`\`\`json\n${nested}\n\`\`\``);
    assert.ok(fenced.action !== undefined || typeof fenced.error === 'string');
  }
});

test('thousands of unclosed <think> tags and unclosed fences are linear', () => {
  const thinks = within('unclosed think tags', 1500, '<think>'.repeat(100_000) + ' then some words');
  assert.equal(thinks.thought, '');
  const many = within('closed think tags', 1500, '<think>a</think>'.repeat(50_000) + '{"action":"scroll","direction":"up"}');
  assert.deepEqual(many.action, { action: 'scroll', direction: 'up' });
  assert.equal(many.thought, 'a');
  within('fence openers', 1500, '```json '.repeat(100_000));
  within('a fence with a megabyte of spaces', 1500, '```json' + ' '.repeat(MB) + '{"a":1}');
});

test('thousands of unclosed tool-call tags are linear and give the tool-call error', () => {
  for (const unit of [
    '<invoke name="x">', '<｜DSML｜invoke name="x"><｜DSML｜parameter name="a">', '<tool_call>', '<function_calls>', '"tool_calls":[', '</tool_call>',
    '<|python_tag|>[', '<function=click>', '<function=click><parameter=a>', '[TOOL_CALLS] [', '<|tool_call|>{', '"function_call":{', '```tool_code\n'
  ]) {
    const result = within(`unclosed ${unit}`, 2000, unit.repeat(60_000));
    assert.equal(isFinish(result), false, unit);
    assert.equal(result.action, undefined, unit);
    assert.equal(result.kind, 'tool_call_markup', unit);
  }
});

test('thousands of unclosed bare calls are linear and are cut-off JSON, never prose', () => {
  for (const unit of ['{"name":"click","arguments":{"a":1}', '{"name":"click","arguments":']) {
    const result = within(`unclosed ${unit}`, 2000, unit.repeat(60_000));
    assert.equal(result.action, undefined, unit);
    assert.equal(result.kind, 'malformed', unit);
  }
});

test('whitespace runs and repeated intent words are linear', () => {
  within('spaces after a quote', 1500, '{"action":"execute_js","code":"x"' + ' '.repeat(MB) + 'y');
  within('spaces after click', 1500, 'click' + ' '.repeat(MB) + 'x');
  within('read read read', 1500, 'read '.repeat(200_000));
  within('extract extract', 1500, 'extract '.repeat(200_000) + 'text');
  within('newlines', 1500, '\n'.repeat(MB));
  const spacedCode = within('truncated execute_js followed by spaces', 1500, `{"action":"execute_js","code":"run()"${' '.repeat(300_000)}"${' '.repeat(300_000)}x`);
  assert.equal(isFinish(spacedCode), false);
});

test('the intent words are matched per line, as the old regex did', () => {
  const readOn = (text: string) => parseModelReply(text, ALL).action?.action;
  assert.equal(readOn('please read the page text'), 'read_page_text');
  assert.equal(readOn('Please EXTRACT the TEXT'), 'read_page_text');
  assert.equal(readOn('get the page content now'), 'read_page_text');
  assert.equal(readOn('read the page\ntext is below'), 'finish', 'the words are on different lines, so it is prose');
});

test('huge parameter values and huge action strings pass through', () => {
  const code = 'x'.repeat(2 * MB);
  const result = within('a 2 MB string', 1500, JSON.stringify({ action: 'execute_js', code }));
  assert.equal((result.action?.code as string).length, code.length);
  const dsml = within('a 2 MB DSML parameter', 1500, `<｜DSML｜function_calls><｜DSML｜invoke name="execute_js"><｜DSML｜parameter name="code" string="true">${code}</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜function_calls>`);
  assert.equal((dsml.action?.code as string).length, code.length);
});

test('unicode: emoji, right-to-left text, zero-width characters and lone surrogates', () => {
  const lone = String.fromCharCode(0xd83d);
  for (const text of ['\u{1F6D2}'.repeat(50_000), 'a\u200bb\u200dc '.repeat(10_000), '\u202eabc\u202c '.repeat(10_000), `${lone}${lone}${lone}${lone}${lone}${lone}`, '\ufeff{"action":"scroll","direction":"down"}']) {
    const result = within('unicode', 1500, text);
    assert.ok(result.action !== undefined || typeof result.error === 'string');
  }
  // A byte order mark in front of a bare action is not part of the JSON, so the scanner still finds it.
  assert.deepEqual(parseModelReply('\ufeff{"action":"scroll","direction":"down"}', ALL).action, { action: 'scroll', direction: 'down' });
  const surrogate = parseModelReply(JSON.stringify({ action: 'type', element_id: 2, text: `${lone}x`, submit: false }), ALL);
  assert.equal(surrogate.action?.action, 'type');
});

test('null bytes and control characters', () => {
  const result = parseModelReply(`{"action":"type","element_id":2,"text":"a${String.fromCharCode(0)}b\tc","submit":false}`, ALL);
  assert.equal(result.action?.action, 'type');
  const control = parseModelReply(String.fromCharCode(0, 1, 2, 3, 4, 5, 6, 7, 8) + 'abcdefgh', ALL);
  assert.ok(control.action !== undefined || typeof control.error === 'string');
});

test('a __proto__ key does not pollute Object.prototype', () => {
  const result = parseModelReply('{"action":"click","element_id":3,"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}', ALL);
  assert.equal(result.action?.action, 'click');
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  const viaMarkup = parseModelReply('<tool_call>{"name":"click","arguments":{"element_id":3,"__proto__":{"polluted":true}}}</tool_call>', ALL);
  assert.equal(viaMarkup.action?.action, 'click');
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('input that is not a string is empty output', () => {
  for (const value of [undefined, null, 0, false, {}, [], 42]) {
    const result = parseModelReply(value, ALL);
    assert.equal(result.kind, 'empty');
    assert.equal(result.error, 'Empty output from model.');
  }
});

test('the parser never throws on random byte soup (2000 seeded replies), and markup never becomes prose', () => {
  let seed = 12345;
  const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pieces = ['{', '}', '[', ']', '"', '\\', ':', ',', '<', '>', '/', '｜', '|', 'DSML', 'tool_call', 'tool_calls', 'invoke name=', 'parameter', 'action', 'click', 'finish', 'element_id', '```', 'json', ' ', '\n', '5', 'x', '\u{1F6D2}',
    'python_tag', 'function=', 'function_call', 'TOOL_CALLS', 'tool_code', 'name', 'arguments', '"name":"click"', '"arguments":{}'];
  const markup = TOOL_CALL_MARKUP;
  for (let i = 0; i < 2000; i++) {
    // Half of the replies also have think tags. A think block is removed before the markup check, so
    // for those the only claim is that the parser returns.
    const withThink = i % 2 === 1;
    const source = withThink ? [...pieces, '<think>', '</think>'] : pieces;
    let text = '';
    const length = 1 + Math.floor(next() * 60);
    for (let j = 0; j < length; j++) text += source[Math.floor(next() * source.length)];
    const result = parseModelReply(text, ALL);
    assert.ok(result.action !== undefined || typeof result.error === 'string', JSON.stringify(text));
    if (result.action !== undefined) assert.equal(typeof result.action.action, 'string', JSON.stringify(text));
    if (!withThink && markup.test(text) && result.action !== undefined) {
      assert.notEqual(result.action.autoWrapped, true, `markup became prose: ${JSON.stringify(text)}`);
    }
  }
});

/* ------------------------------------------------------------------ *
 * Rules the fixture does not spell out
 * ------------------------------------------------------------------ */

test('the parser does not change its input, and repeated calls give the same answer', () => {
  const text = '<think>a</think>\n```json\n{"action":"browser_batch","steps":[{"action":"click","element_id":"2"}]}\n```';
  const before = text.slice();
  const first = parseModelReply(text, ALL);
  const second = parseModelReply(text, ALL);
  assert.equal(text, before);
  assert.deepEqual(first, second);
  assert.deepEqual(first.action, { action: 'browser_batch', steps: [{ action: 'click', element_id: 2 }] });
});

test('the guardrails report through the log sink, and the parser is silent without one', () => {
  const lines: string[] = [];
  const log = (level: string, message: string) => lines.push(`${level}: ${message}`);
  parseModelReply('{"action":"fly"}', { ...ALL, log });
  parseModelReply('{"action":"click","element_id":99}', { ...ALL, log });
  parseModelReply('The price is 5 EUR.', { ...ALL, log });
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^warn: \[GUARDRAIL_REJECTED\] Model requested an unrecognised action "fly"\.$/);
  assert.match(lines[1], /^warn: \[GUARDRAIL_REJECTED\] Model selected an invalid element_id \(99, valid range 1-10\)/);
  assert.match(lines[2], /^info: \[UNIVERSAL_GUARDRAIL\] Model provided direct text response/);
  assert.doesNotThrow(() => parseModelReply('{"action":"fly"}', ALL));
});

test('the verb list decides what is allowed: the same reply in three modes', () => {
  const reply = '{"action":"execute_js","code":"return 1"}';
  assert.equal(parseModelReply(reply, { verbs: verbsFor('browse', 'large') }).action?.action, 'execute_js');
  assert.equal(parseModelReply(reply, { verbs: verbsFor('browse', 'small') }).kind, 'unavailable_action');
  assert.equal(parseModelReply(reply, { verbs: verbsFor('answer', 'large') }).kind, 'unavailable_action');
  // A verb that is not in the registry at all is unknown in every mode.
  assert.equal(parseModelReply('{"action":"fly"}', { verbs: verbsFor('browse', 'small') }).kind, 'unknown_action');
});

test('an alias resolves to the verb before the mode is checked', () => {
  const small = verbsFor('browse', 'small');
  for (const alias of ['run_js', 'eval_js', 'batch', 'new_window', 'read_network']) {
    const result = parseModelReply(JSON.stringify({ action: alias }), { verbs: small });
    assert.equal(result.kind, 'unavailable_action', alias);
    assert.doesNotMatch(result.error ?? '', new RegExp(`"${alias}"`), 'the message names the verb, not the alias');
  }
});

test('parseBareActionJson: only a whole object with a string action', () => {
  assert.deepEqual(parseBareActionJson(' {"action":"scroll"} '), { action: 'scroll' });
  assert.equal(parseBareActionJson('{"action":1}'), null);
  assert.equal(parseBareActionJson('[{"action":"scroll"}]'), null);
  assert.equal(parseBareActionJson('{"action":"scroll"} trailing'), null);
  assert.equal(parseBareActionJson('{"action":'), null);
});

test('thought text: the first think block is the thought, all of them are removed', () => {
  const result = parseModelReply('<think>first</think>{"action":"scroll","direction":"down"}<thought>second</thought>', ALL);
  assert.equal(result.thought, 'first');
  assert.deepEqual(result.action, { action: 'scroll', direction: 'down' });
  const mixed = parseModelReply('<think>a</thought>{"action":"scroll","direction":"up"}', ALL);
  assert.equal(mixed.thought, 'a', 'the closing tag may be a different one of the three');
});

test('the expected outcome of the model is passed on unchanged', () => {
  const withKey = parseModelReply('{"action":"click","element_id":2,"expected_outcome":"the cart opens"}', ALL);
  assert.equal(withKey.expectedOutcome, 'the cart opens');
  const camel = parseModelReply('{"action":"click","element_id":2,"expectedOutcome":"x"}', ALL);
  assert.equal(camel.expectedOutcome, 'x');
  assert.equal(parseModelReply('{"action":"click","element_id":2}', ALL).expectedOutcome, null);
});

/* ------------------------------------------------------------------ *
 * The plan reply
 * ------------------------------------------------------------------ */

test('planTextsFromStepsObject: sources are shown only when they add something, and the list is capped', () => {
  const plan = JSON.stringify({ steps: [
    { source: 'idealo.de', goal: 'Find the price' },
    { source: 'current page', goal: 'Read the price' },
    { source: 'geizhals.de', goal: 'Open geizhals.de and search' },
    'A plain string step',
    { source: 'x', goal: '' },
    null,
    { goal: 'No source' },
    { source: 'zz.de', goal: 'seven' },
    { source: 'zz.de', goal: 'eight' }
  ] });
  const texts = planTextsFromStepsObject(plan);
  assert.deepEqual(texts, [
    'idealo.de: Find the price',
    'Read the price',
    'Open geizhals.de and search',
    'A plain string step',
    'No source',
    'zz.de: seven'
  ]);
  assert.equal(texts.length, 6, 'capped at PLAN_MAX_STEPS');
});

test('planTextsFromStepsObject: nothing usable gives an empty list', () => {
  for (const reply of ['', 'not json', '[]', '{"steps": "no"}', '{}', null, undefined, 42]) {
    assert.deepEqual(planTextsFromStepsObject(reply), [], String(reply));
  }
});

test('planTextsFromStepsObject: a plan cut off after a whole step is repaired by the ladder', () => {
  const texts = planTextsFromStepsObject('{"steps": [{"source": "a.de", "goal": "one"}, {"source": "b.de", "goal": "two"}');
  assert.deepEqual(texts, ['a.de: one', 'b.de: two']);
});
