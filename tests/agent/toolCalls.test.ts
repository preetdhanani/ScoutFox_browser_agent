/**
 * src/background/agent/toolCalls.ts: detection and conversion of tool-call markup. The cases that
 * decide what the parser does with a whole reply are in shared/fixtures/parse-cases.json; these are
 * the rules of the converter itself.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ACTION_VERBS, verbsFor } from '../../src/background/agent/actions.ts';
import { convertBareToolCall, convertToolCallMarkup, endsInsideMarkupToken, hasToolCallMarkup, isToolCallShape, TOOL_CALL_MARKUP, TOOL_CALL_MARKUP_ERROR } from '../../src/background/agent/toolCalls.ts';

const convert = (text: string, verbs: readonly string[] = ACTION_VERBS) => convertToolCallMarkup(text, verbs);

test('detection: every family of markup, and nothing else', () => {
  for (const text of [
    '<｜DSML｜function_calls>', '<|DSML|invoke name="x">', '<｜DSML｜parameter name="a">', '</｜DSML｜function_calls>',
    '<function_calls>', '</function_calls>', '<tool_call>', '</tool_call>', '<TOOL_CALL>',
    '<invoke name="click">', '<invoke   name="click">',
    '<｜tool▁calls▁begin｜>', '<|tool_calls_begin|>', '<｜tool▁call▁begin｜>', '<|tool_call_begin|>',
    '{"tool_calls": []}', '"tool_calls" : [', '{"TOOL_CALLS":[]}',
    // The formats of other model families: Llama, Qwen3-Coder, Granite, Mistral, Gemma, the old OpenAI key.
    '<|python_tag|>', '<｜python_tag｜>', '<|tool_call|>', '<function=click>', '<Function=click>', '[TOOL_CALLS]', '[tool_calls]',
    '```tool_code', '```tool_code\nclick(element_id=3)', '{"function_call": {"name": "click"}}', '"function_call" : {'
  ]) {
    assert.equal(hasToolCallMarkup(text), true, text);
    assert.ok(TOOL_CALL_MARKUP.test(text), text);
  }
  for (const text of [
    'I will click the button.', '{"action":"click","element_id":3}', 'The tool call failed.', 'call the function', '<div>tool_calls</div>',
    '<invoke>', 'invoke name=x', 'DSML', '{"tool_calls_count": 3}', '<functioncalls>', '<tool_calls>',
    '<function>', 'function=click', '[TOOL_CALL]', '```tool_codes', '```python', '"function_calls": 3', '{"function_call_count": 3}', '<python_tag>'
  ]) {
    assert.equal(hasToolCallMarkup(text), false, text);
  }
});

test('detection: the regex is the design regex, plus the fullwidth bar, a closing DSML tag and the formats of other model families', () => {
  assert.equal(TOOL_CALL_MARKUP.flags, 'i');
  // The alternatives of the design regex, one by one.
  for (const token of ['<｜DSML｜', '<|DSML|', '<function_calls>', '</function_calls>', '<tool_call>', '</tool_call>', '<invoke name=', '<|tool_calls_begin|>', '<|tool_call_begin|>', '"tool_calls":']) {
    assert.ok(TOOL_CALL_MARKUP.test(token), token);
  }
  // The additions.
  for (const token of ['<｜tool▁calls▁begin｜>', '</｜DSML｜function_calls>', '<|python_tag|>', '<|tool_call|>', '<function=click>', '[TOOL_CALLS]', '```tool_code', '"function_call":']) {
    assert.ok(TOOL_CALL_MARKUP.test(token), token);
  }
});

test('endsInsideMarkupToken: a reply cut off in the middle of a tag, with at least 4 characters', () => {
  for (const text of ['<tool_', 'I will do it <tool_ca', '<｜DSML', '<|DSML', '<invoke nam', '{"a":1,"tool_ca', '</function_c', '<｜tool▁calls▁beg', '</to', '<|python_ta', '<|tool_ca', '<function', '[TOOL_CAL', '```tool_co', '{"function_cal']) {
    assert.equal(endsInsideMarkupToken(text), true, text);
  }
  for (const text of ['', 'ok', '<t', '<', 'x < y', 'the tool', 'tool_calls', 'a <div', 'fine.', '<tool_call>', '</t', '<think>plan</th', '</thi', '<｜D']) {
    assert.equal(endsInsideMarkupToken(text), false, text);
  }
});

test('the error text is the design text', () => {
  assert.equal(TOOL_CALL_MARKUP_ERROR, 'Your reply used tool-call markup. This agent does not use tool calls. Reply with a single JSON object {"action": ...}.');
});

test('conversion: text with no complete call gives null', () => {
  for (const text of ['', 'plain', '<tool_call>', '<tool_call></tool_call>', '<｜DSML｜function_calls>', '{"tool_calls": 5}', '{"tool_calls": []}', '<invoke name="click">', '"tool_calls": [{"function": {"name": ']) {
    assert.equal(convert(text), null, text);
  }
});

test('conversion: the verb comes from the tool name, and the alias table is the JSON one', () => {
  assert.deepEqual(convert('<tool_call>{"name":"click_element","arguments":{"element_id":3}}</tool_call>'), { action: 'click', element_id: 3 });
  assert.deepEqual(convert('<tool_call>{"name":"done","arguments":{"answer":"x"}}</tool_call>'), { action: 'finish', answer: 'x' });
  assert.deepEqual(convert('<tool_call>{"name":" click ","arguments":{"element_id":3}}</tool_call>'), { action: 'click', element_id: 3 }, 'the name is trimmed');
  assert.equal(convert('<tool_call>{"name":"Click","arguments":{"element_id":3}}</tool_call>'), null, 'the match is exact, as for a JSON action');
  assert.equal(convert('<tool_call>{"name":"web_search","arguments":{"q":"x"}}</tool_call>'), null);
});

test('conversion: an action key in the parameters can not replace the verb', () => {
  assert.deepEqual(convert('<tool_call>{"name":"scroll","arguments":{"direction":"down","action":"finish"}}</tool_call>'), { action: 'scroll', direction: 'down' });
  assert.deepEqual(convert('<invoke name="scroll"><parameter name="direction">down</parameter><parameter name="action">finish</parameter></invoke>'), { action: 'scroll', direction: 'down' });
});

test('conversion: the verb must be one the mode offers', () => {
  const smallBrowse = verbsFor('browse', 'small');
  assert.equal(convert('<tool_call>{"name":"execute_js","arguments":{"code":"1"}}</tool_call>', smallBrowse), null);
  assert.deepEqual(convert('<tool_call>{"name":"execute_js","arguments":{"code":"1"}}</tool_call>', verbsFor('browse', 'large')), { action: 'execute_js', code: '1' });
  assert.equal(convert('<tool_call>{"name":"finish","arguments":{"answer":"x"}}</tool_call>', verbsFor('browse', 'large')), null, 'finish is a verb of the answer mode');
  assert.deepEqual(convert('<tool_call>{"name":"finish","arguments":{"answer":"x"}}</tool_call>', verbsFor('answer', 'large')), { action: 'finish', answer: 'x' });
});

test('conversion: only the first call is used, in the order they are written', () => {
  const two = '<function_calls><invoke name="scroll"><parameter name="direction">up</parameter></invoke><invoke name="click"><parameter name="element_id">2</parameter></invoke></function_calls>';
  assert.deepEqual(convert(two), { action: 'scroll', direction: 'up' });
  const mixed = '<tool_call>{"name":"go_back","arguments":{}}</tool_call> {"tool_calls":[{"function":{"name":"scroll","arguments":"{\\"direction\\":\\"down\\"}"}}]}';
  assert.deepEqual(convert(mixed), { action: 'go_back' });
  const reversed = '{"tool_calls":[{"function":{"name":"scroll","arguments":"{\\"direction\\":\\"down\\"}"}}]} <tool_call>{"name":"go_back","arguments":{}}</tool_call>';
  assert.deepEqual(convert(reversed), { action: 'scroll', direction: 'down' });
});

test('XML parameters: DSML types come from string="true" and string="false", the registry types the rest', () => {
  const dsml = (attrs: string, value: string, field = 'text', verb = 'type') => `<｜DSML｜invoke name="${verb}"><｜DSML｜parameter name="${field}"${attrs}>${value}</｜DSML｜parameter></｜DSML｜invoke>`;
  assert.deepEqual(convert(dsml(' string="true"', ' 007 ')), { action: 'type', text: ' 007 ' }, 'string="true" is kept exactly');
  assert.deepEqual(convert(dsml(' string="false"', ' 7 ', 'element_id')), { action: 'type', element_id: 7 });
  assert.deepEqual(convert(dsml(' string="false"', 'true', 'submit')), { action: 'type', submit: true });
  assert.deepEqual(convert(dsml(' string="false"', '[1,2]', 'x')), { action: 'type', x: [1, 2] });
  assert.deepEqual(convert(dsml(' string="false"', 'not json', 'x')), { action: 'type', x: 'not json' });
  // Anthropic: no attribute, so the registry decides.
  assert.deepEqual(convert(dsml('', ' 2024 ')), { action: 'type', text: '2024' });
  assert.deepEqual(convert(dsml('', '5', 'element_id')), { action: 'type', element_id: 5 });
  assert.deepEqual(convert(dsml('', 'x', 'element_id')), { action: 'type', element_id: 'x' }, 'left for the id check to reject');
  assert.deepEqual(convert(dsml('', 'FALSE', 'submit')), { action: 'type', submit: false });
  assert.deepEqual(convert(dsml('', 'maybe', 'submit')), { action: 'type', submit: 'maybe' });
  // A field the registry does not know: JSON when it reads as JSON.
  assert.deepEqual(convert(dsml('', '12', 'unknown')), { action: 'type', unknown: 12 });
  assert.deepEqual(convert(dsml('', 'hello', 'unknown')), { action: 'type', unknown: 'hello' });
  assert.deepEqual(convert(dsml('', '"quoted"', 'unknown')), { action: 'type', unknown: '"quoted"' }, 'text stays as written');
});

test('XML parameters: a browser_batch steps array and a read_network_requests filter are JSON', () => {
  const batch = '<invoke name="browser_batch"><parameter name="steps">[{"action":"click","element_id":2}]</parameter><parameter name="stopOnError">true</parameter></invoke>';
  assert.deepEqual(convert(batch), { action: 'browser_batch', steps: [{ action: 'click', element_id: 2 }], stopOnError: true });
  const net = '<invoke name="read_network_requests"><parameter name="filter">{"status":"error"}</parameter><parameter name="limit">5</parameter></invoke>';
  assert.deepEqual(convert(net), { action: 'read_network_requests', filter: { status: 'error' }, limit: 5 });
});

test('XML calls: malformed ones give no call, and a later good one is still found', () => {
  const noClose = '<invoke name="click"><parameter name="element_id">5</parameter>';
  assert.equal(convert(noClose), null);
  const nested = '<invoke name="click"><invoke name="scroll"><parameter name="direction">down</parameter></invoke>';
  assert.deepEqual(convert(nested), { action: 'scroll', direction: 'down' }, 'the first one never closed, the second did');
  const halfTag = '<invoke name="click"><parameter name="element_id">5</parameter><parameter name="te</invoke>';
  assert.equal(convert(halfTag), null, 'a parameter tag that is cut in the middle');
  const noParamClose = '<invoke name="click"><parameter name="element_id">5</invoke>';
  assert.equal(convert(noParamClose), null);
  const closeOnly = '</invoke><invoke name="click">';
  assert.equal(convert(closeOnly), null);
  const noParams = '<invoke name="go_back"></invoke>';
  assert.deepEqual(convert(noParams), { action: 'go_back' });
});

test('JSON calls: arguments as an object or a JSON string, parameters and input as other names, function wrapper', () => {
  assert.deepEqual(convert('<tool_call>{"name":"click","parameters":{"element_id":3}}</tool_call>'), { action: 'click', element_id: 3 });
  assert.deepEqual(convert('<tool_call>{"name":"click","input":{"element_id":3}}</tool_call>'), { action: 'click', element_id: 3 });
  assert.deepEqual(convert('<tool_call>{"type":"function","function":{"name":"click","arguments":"{\\"element_id\\":3}"}}</tool_call>'), { action: 'click', element_id: 3 });
  assert.deepEqual(convert('<tool_call>{"name":"go_back"}</tool_call>'), { action: 'go_back' }, 'no arguments at all');
  assert.deepEqual(convert('<tool_call>{"name":"go_back","arguments":""}</tool_call>'), { action: 'go_back' });
  assert.equal(convert('<tool_call>{"name":"click","arguments":"not json"}</tool_call>'), null);
  assert.equal(convert('<tool_call>{"name":"click","arguments":[1]}</tool_call>'), null);
  assert.equal(convert('<tool_call>{"name":5}</tool_call>'), null);
  assert.equal(convert('<tool_call>[]</tool_call>'), null);
  assert.equal(convert('<tool_call>null</tool_call>'), null);
});

test('JSON calls: an array of calls, and a fenced call inside the tag', () => {
  assert.deepEqual(convert('<function_calls>[{"name":"scroll","arguments":{"direction":"down"}},{"name":"go_back"}]</function_calls>'), { action: 'scroll', direction: 'down' });
  assert.deepEqual(convert('<tool_call>\n```json\n{"name":"go_back","arguments":{}}\n```\n</tool_call>'), { action: 'go_back' });
});

test('JSON calls: nothing is repaired, so a call cut off in the middle is not a call', () => {
  assert.equal(convert('<tool_call>{"name":"click","arguments":{"element_id":5}</tool_call>'), null, 'a brace is missing');
  assert.equal(convert('<tool_call>{"name":"click","arguments":{"element_id":5}}'), null, 'the closing tag is missing');
  assert.equal(convert('{"tool_calls":[{"function":{"name":"click","arguments":"{\\"element_id\\":5"}}]}'), null, 'the arguments string is cut off');
});

test('OpenAI: the array is found wherever the key is, and the key in a string is not', () => {
  const call = '{"function":{"name":"go_back","arguments":"{}"}}';
  assert.deepEqual(convert(`{"tool_calls":[${call}]}`), { action: 'go_back' });
  assert.deepEqual(convert(`{"choices":[{"message":{"tool_calls":[${call}]}}]}`), { action: 'go_back' });
  assert.deepEqual(convert(`text "tool_calls": [ ${call} ] more`), { action: 'go_back' });
  assert.deepEqual(convert(`{"a":"[]","tool_calls":[${call}],"b":"]"}`), { action: 'go_back' });
  assert.equal(convert(`{"note":"\\"tool_calls\\": [${call}]"}`), null, 'inside a string it is text');
});

test('OpenAI: many keys are not all scanned', () => {
  const started = performance.now();
  assert.equal(convert('"tool_calls":['.repeat(100_000)), null);
  assert.ok(performance.now() - started < 1000);
});

test('conversion does not change what it is given and does not pollute prototypes', () => {
  const text = '<tool_call>{"name":"click","arguments":{"element_id":3,"__proto__":{"polluted":1}}}</tool_call>';
  const before = text.slice();
  const result = convert(text);
  assert.equal(text, before);
  assert.equal(result?.action, 'click');
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
});

/* ------------------------------------------------------------------ *
 * Other families: a JSON call after a token or a key, <function=...>, and a bare call
 * ------------------------------------------------------------------ */

test('JSON after a token: Llama <|python_tag|>, Mistral [TOOL_CALLS], Granite <|tool_call|>, the old OpenAI function_call', () => {
  assert.deepEqual(convert('<|python_tag|>{"name": "click", "parameters": {"element_id": 3}}'), { action: 'click', element_id: 3 });
  assert.deepEqual(convert('<｜python_tag｜>{"name": "go_back", "parameters": {}}'), { action: 'go_back' });
  assert.deepEqual(convert('[TOOL_CALLS] [{"name": "scroll", "arguments": {"direction": "up"}}]'), { action: 'scroll', direction: 'up' });
  assert.deepEqual(convert('[TOOL_CALLS][{"name": "go_back", "arguments": {}}]'), { action: 'go_back' });
  assert.deepEqual(convert('<|tool_call|>[{"name": "click", "arguments": {"element_id": 4}}]'), { action: 'click', element_id: 4 });
  assert.deepEqual(convert('{"function_call": {"name": "click", "arguments": "{\\"element_id\\": 3}"}}'), { action: 'click', element_id: 3 });
  assert.deepEqual(convert('Sure.\n<|python_tag|>\n{"name": "go_back", "parameters": {}}'), { action: 'go_back' }, 'blanks and text before the token');
});

test('JSON after a token: a call that is cut off, not valid, or not a verb of the mode is not a call', () => {
  for (const text of [
    '<|python_tag|>{"name": "click", "parameters": {"element_id": 3}',
    '<|python_tag|>',
    '<|python_tag|>click(element_id=3)',
    '[TOOL_CALLS] [{"name": "click", "arguments": {"element_id": ',
    '[TOOL_CALLS] []',
    '[TOOL_CALLS] not json',
    '<|tool_call|>[{"name": "click", "arguments": {"element_id": 3}}',
    '{"function_call": {"name": "click", "arguments": "{\\"element_id\\": 3"}}',
    '{"function_call": 5}'
  ]) {
    assert.equal(convert(text), null, text);
  }
  assert.equal(convert('[TOOL_CALLS] [{"name": "web_search", "arguments": {"q": "x"}}]'), null, 'not a verb');
  assert.equal(convert('[TOOL_CALLS] [{"name": "click", "arguments": {"element_id": 3}}]', verbsFor('answer', 'large')), null, 'not a verb of the mode');
});

test('JSON after a token: many markers are not all scanned', () => {
  for (const unit of ['<|python_tag|>[', '[TOOL_CALLS] [', '"function_call":[', '<|tool_call|>{']) {
    const started = performance.now();
    assert.equal(convert(unit.repeat(100_000)), null, unit);
    assert.ok(performance.now() - started < 1000, unit);
  }
});

test('<function=name>: a JSON body, parameter children typed by the registry, and no body', () => {
  assert.deepEqual(convert('<function=click>{"element_id": 3}</function>'), { action: 'click', element_id: 3 });
  assert.deepEqual(convert('<function=go_back></function>'), { action: 'go_back' });
  assert.deepEqual(convert('<function=go_back>  </function>'), { action: 'go_back' });
  assert.deepEqual(
    convert('<function=type>\n<parameter=element_id>\n2\n</parameter>\n<parameter=text>\n2024\n</parameter>\n<parameter=submit>\nfalse\n</parameter>\n</function>'),
    { action: 'type', element_id: 2, text: '2024', submit: false }
  );
  assert.deepEqual(convert('<function=click_element>{"element_id": 3}</function>'), { action: 'click', element_id: 3 }, 'through the alias table');
  assert.deepEqual(convert('<function=scroll>{"direction":"down","action":"finish"}</function>'), { action: 'scroll', direction: 'down' }, 'an action key in the body can not replace the verb');
});

test('<function=name>: cut-off, unclosed, mixed-up and not-a-verb calls are not calls', () => {
  for (const text of [
    '<function=click>{"element_id": 3}',
    '<function=click>{"element_id": 3</function>',
    '<function=click>{"element_id": 3} and more</function>',
    '<function=click>[1]</function>',
    '<function=click>free text</function>',
    '<function=click><parameter=element_id>3</function>',
    '<function=click><parameter=element_id>3</parameter><parameter=text>x</function>',
    '<function=click><parameter=a><parameter=b>1</parameter></parameter></function>',
    '<function=>{"element_id": 3}</function>',
    '<function=click',
    '</function><function=click>'
  ]) {
    assert.equal(convert(text), null, text);
  }
  assert.equal(convert('<function=web_search>{"q": "x"}</function>'), null);
  const nested = '<function=click><function=scroll>{"direction":"down"}</function>';
  assert.deepEqual(convert(nested), { action: 'scroll', direction: 'down' }, 'the first one never closed, the second did');
});

test('a Gemma tool_code fence is detected but never converted (the call is python)', () => {
  const text = '```tool_code\nclick(element_id=3)\n```';
  assert.equal(hasToolCallMarkup(text), true);
  assert.equal(convert(text), null);
});

test('isToolCallShape: a name with arguments, parameters or input, an OpenAI function entry, and lists of them', () => {
  for (const value of [
    { name: 'click', arguments: { element_id: 3 } },
    { name: 'click', parameters: {} },
    { name: 'click', input: { element_id: 3 } },
    { name: 'click', arguments: '' },
    { id: '7', type: 'function', function: { name: 'click', arguments: '{}' } },
    { type: 'tool_use', id: 'toolu_01', name: 'click', input: {} },
    [{ name: 'click', arguments: {} }, { function: { name: 'go_back' } }]
  ]) {
    assert.equal(isToolCallShape(value), true, JSON.stringify(value));
  }
  for (const value of [
    { name: 'click' },
    { name: 5, arguments: {} },
    // A record in an answer, not a call: the arguments are an object, or the JSON string of `arguments`.
    { name: 'John', arguments: 5 },
    { name: 'Framework', input: 'laptop' },
    { name: 'x', parameters: [1] },
    { name: 'x', input: null },
    { action: 'click', name: 'x', arguments: {} },
    { function: { name: 5 } },
    { function: 'click' },
    { type: 'function' },
    { click: 3 },
    { type: 'hello', element_id: 2 },
    [],
    [{ name: 'click', arguments: {} }, { click: 3 }],
    'click', 5, null, undefined
  ]) {
    assert.equal(isToolCallShape(value), false, JSON.stringify(value));
  }
});

test('convertBareToolCall: the whole reply, its one fenced block, or a complete object inside prose', () => {
  const bare = (text: string, verbs: readonly string[] = ACTION_VERBS) => convertBareToolCall(text, verbs);
  assert.deepEqual(bare('{"name": "click", "arguments": {"element_id": 3}}'), { found: true, action: { action: 'click', element_id: 3 } });
  assert.deepEqual(bare('  \n{"name": "click", "arguments": {"element_id": 3}}\n '), { found: true, action: { action: 'click', element_id: 3 } });
  assert.deepEqual(bare('```json\n{"name": "go_back", "arguments": {}}\n```'), { found: true, action: { action: 'go_back' } });
  assert.deepEqual(bare('[{"name": "scroll", "arguments": {"direction": "up"}}, {"name": "go_back"}]'), { found: true, action: { action: 'scroll', direction: 'up' } });
  assert.deepEqual(bare('I will call:\n{"name": "go_back", "arguments": {}}\nthanks'), { found: true, action: { action: 'go_back' } });
  assert.deepEqual(bare('{"id":"7","type":"function","function":{"name":"go_back","arguments":"{}"}}'), { found: true, action: { action: 'go_back' } });
  // Found, but not usable: the name is not a verb of the mode, or the arguments are not JSON.
  assert.deepEqual(bare('{"name": "web_search", "arguments": {"q": "x"}}'), { found: true, action: null });
  assert.deepEqual(bare('{"name": "click", "arguments": {"element_id": 3}}', verbsFor('answer', 'large')), { found: true, action: null });
  assert.deepEqual(bare('{"name": "click", "arguments": "not json"}'), { found: true, action: null });
  // Not a call.
  for (const text of ['', 'plain', '{"action":"click","element_id":3}', '{"name": "click"}', '{"name": "click", "arguments": {"element_id": 3}', '{"a":1} {"b":2}', '[1,2]', '"name"']) {
    assert.deepEqual(bare(text), { found: false, action: null }, text);
  }
});

test('convertBareToolCall: many objects in one reply are scanned once', () => {
  const started = performance.now();
  assert.deepEqual(convertBareToolCall('{"a":1}'.repeat(100_000), ACTION_VERBS), { found: false, action: null });
  assert.deepEqual(convertBareToolCall(`${'{"a":1}'.repeat(100_000)}{"name":"go_back","arguments":{}}`, ACTION_VERBS), { found: true, action: { action: 'go_back' } });
  assert.ok(performance.now() - started < 2000);
});

/* ------------------------------------------------------------------ *
 * Markup words inside the strings of a complete action are content
 * ------------------------------------------------------------------ */

test('hasToolCallMarkup: a token inside a string value of a complete action object is that action\'s content', () => {
  for (const text of [
    '{"action":"finish","answer":"wrap each call in <tool_call> tags"}',
    'Done: {"action":"finish","answer":"the <｜DSML｜invoke name=\\"x\\"> tag"}',
    '```json\n{"action":"type","element_id":3,"text":"<invoke name=","submit":true}\n```',
    '{"action":"browser_batch","steps":[{"action":"type","element_id":1,"text":"<function_calls>"}]}',
    // A raw line break inside a string is repaired the way the JSON ladder repairs it.
    '{"action":"finish","answer":"line one\nline two </tool_call>"}'
  ]) {
    assert.equal(hasToolCallMarkup(text), false, text);
    assert.equal(TOOL_CALL_MARKUP.test(text), true, `the raw regex does see the token: ${text}`);
  }
});

test('hasToolCallMarkup: markup outside such an object, in a key, or in an object that is not a complete action is still markup', () => {
  for (const text of [
    '{"action":"finish","answer":"ok"} <tool_call>',
    '<tool_call>{"action":"finish","answer":"x"}</tool_call>',
    '<｜DSML｜function_calls><｜DSML｜invoke name="browser_batch"><｜DSML｜parameter name="steps" string="false">[{"action":"click","element_id":2}]</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜function_calls>',
    '{"tool_calls":[{"function":{"name":"click","arguments":"{}"}}]}',
    '{"role":"assistant","tool_calls":[]}',
    '{"answer":"<tool_call>"}',
    '{"action":"finish","answer":"<tool_call>"',
    '{"action":"finish","answer":"<tool_call>"} {"action":"scroll","direction":"down"} <invoke name="x">',
    '{"action":5,"answer":"<tool_call>"}'
  ]) {
    assert.equal(hasToolCallMarkup(text), true, text);
  }
});

test('hasToolCallMarkup: a reply with very many complete action objects is checked in linear time', () => {
  const started = performance.now();
  const unit = '{"action":"finish","answer":"<tool_call>"}';
  assert.equal(hasToolCallMarkup(unit.repeat(50_000)), false);
  assert.equal(hasToolCallMarkup(`${unit.repeat(50_000)}<tool_call>`), true);
  assert.ok(performance.now() - started < 2000);
});
