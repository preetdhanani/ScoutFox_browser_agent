/**
 * src/background/agent/repairJson.ts: the repair ladder with string-aware counting, and the
 * string-aware brace scanner that replaced the non-greedy /\{[\s\S]*?\}/ regex.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { balancedEnd, findTopLevelObjects, parsePartialOrTruncatedJson, rescueTruncatedJson } from '../../src/background/agent/repairJson.ts';

/* ------------------------------------------------------------------ *
 * The ladder
 * ------------------------------------------------------------------ */

test('step 1: a valid value is parsed as it is, whatever it is', () => {
  assert.deepEqual(parsePartialOrTruncatedJson('{"action":"click","element_id":3}'), { action: 'click', element_id: 3 });
  assert.deepEqual(parsePartialOrTruncatedJson('  [1, 2]  '), [1, 2]);
  assert.equal(parsePartialOrTruncatedJson('7'), 7);
  assert.equal(parsePartialOrTruncatedJson('"x"'), 'x');
});

test('anything that is not a non-empty string gives null', () => {
  for (const value of [undefined, null, '', 0, 42, {}, [], true]) assert.equal(parsePartialOrTruncatedJson(value), null);
  assert.equal(parsePartialOrTruncatedJson('   '), null);
  assert.equal(parsePartialOrTruncatedJson('not json at all'), null);
});

test('step 2: raw newlines inside a string are escaped', () => {
  assert.deepEqual(parsePartialOrTruncatedJson('{"text":"line one\nline two"}'), { text: 'line one\nline two' });
  assert.deepEqual(parsePartialOrTruncatedJson('{"text":"a\r\nb"}'), { text: 'a\nb' });
});

test('step 3: an unclosed string and unclosed objects are closed', () => {
  assert.deepEqual(parsePartialOrTruncatedJson('{"a":"abc'), { a: 'abc' });
  assert.deepEqual(parsePartialOrTruncatedJson('{"a":{"b":"x'), { a: { b: 'x' } });
  assert.deepEqual(parsePartialOrTruncatedJson('{"a":1'), { a: 1 });
});

test('step 3 counts outside strings: a brace inside a string adds no closing brace', () => {
  // The old repair counted the "{" of the code as an open object and appended a second "}".
  assert.deepEqual(parsePartialOrTruncatedJson('{"code":"if (x) { y","n":1'), { code: 'if (x) { y', n: 1 });
  assert.deepEqual(parsePartialOrTruncatedJson('{"a":"}}}","b":2'), { a: '}}}', b: 2 });
  assert.deepEqual(parsePartialOrTruncatedJson('{"a":"[[[","b":2'), { a: '[[[', b: 2 });
});

test('step 3 counts quotes outside escapes: an escaped backslash before a quote closes the string', () => {
  // {"a":"x\\"} has the string x\ , closed. The old lookbehind read \" as an escaped quote.
  assert.deepEqual(parsePartialOrTruncatedJson('{"a":"x\\\\","b":1'), { a: 'x\\', b: 1 });
  assert.deepEqual(parsePartialOrTruncatedJson('{"a":"say \\"hi\\"","b":1'), { a: 'say "hi"', b: 1 });
});

test('step 3 closes arrays and objects in the order they were opened', () => {
  assert.deepEqual(parsePartialOrTruncatedJson('{"steps":[{"a":1},{"a":2}'), { steps: [{ a: 1 }, { a: 2 }] });
  assert.deepEqual(parsePartialOrTruncatedJson('{"a":[1,2'), { a: [1, 2] });
  assert.deepEqual(parsePartialOrTruncatedJson('[{"a":[{"b":1'), [{ a: [{ b: 1 }] }]);
});

test('step 3 drops a dangling backslash so it does not escape the closing quote', () => {
  assert.deepEqual(parsePartialOrTruncatedJson('{"a":"abc\\'), { a: 'abc' });
});

test('a value that is cut off where no closing can help still fails, and goes on to step 4', () => {
  assert.equal(parsePartialOrTruncatedJson('{"a":'), null);
  assert.equal(parsePartialOrTruncatedJson('{"a":1,'), null);
  assert.equal(parsePartialOrTruncatedJson('{"a":tru'), null);
});

test('step 4: a truncated execute_js keeps its code and is marked as recovered', () => {
  const cut = '{"action":"execute_js","code":"const a = 1; if (a) { console.log(\\"x\\");';
  const result = parsePartialOrTruncatedJson(`${cut}\n`);
  // Step 3 does close this one (the string, then the object), so nothing is marked recovered.
  assert.equal(result.action, 'execute_js');
  assert.equal(result.code, 'const a = 1; if (a) { console.log("x");');

  const pretty = '{\n  "action": "execute_js",\n  "code": "const a = document.querySelector(\'#b\'); if (a) { a.click(); } return a.te';
  const rescued = parsePartialOrTruncatedJson(pretty);
  assert.deepEqual(rescued, {
    action: 'execute_js',
    code: "const a = document.querySelector('#b'); if (a) { a.click(); } return a.te",
    world: 'MAIN',
    reason: 'Recovered from truncated model output'
  });
});

test('step 4: a truncated eval_js is rescued as execute_js', () => {
  const rescued = rescueTruncatedJson('{\n"action": "eval_js",\n"code": "return document.title');
  assert.equal(rescued.action, 'execute_js');
  assert.equal(rescued.code, 'return document.title');
});

test('step 4: a truncated execute_js is rescued under every alias of the registry, not only eval_js', () => {
  for (const alias of ['execute_js', 'eval_js', 'run_js', 'javascript']) {
    const rescued = rescueTruncatedJson(`{\n"action": "${alias}",\n"code": "return document.title`);
    assert.equal(rescued?.action, 'execute_js', alias);
    assert.equal(rescued?.code, 'return document.title', alias);
  }
  assert.equal(rescueTruncatedJson('{"action": "Javascript", "code": "x'), null, 'the match is exact, as for a JSON action');
  assert.equal(rescueTruncatedJson('{"action": "js", "code": "x'), null, 'a name that is not an alias');
});

test('step 4: click and type are rescued under their aliases too, and come back under the verb', () => {
  assert.equal(rescueTruncatedJson('{"action": "click_element", "element_id": 12, "reason": "the sec')?.action, 'click');
  assert.equal(rescueTruncatedJson('{"action": "press", "element_id": 12, "reason": "the sec')?.action, 'click');
  assert.equal(rescueTruncatedJson('{"action": "type_text", "element_id": 4, "text": "hi", "sub')?.action, 'type');
  assert.equal(rescueTruncatedJson('{"action": "input", "element_id": 4, "text": "hi", "sub')?.action, 'type');
  assert.equal(rescueTruncatedJson('{"action": "press_key", "key": "Ent')?.action, undefined, 'press_key is its own verb, not the alias press');
});

test('step 4: the tail of the code is cleaned, and whitespace runs are fast', () => {
  assert.equal(rescueTruncatedJson('{\n"action": "execute_js",\n"code": "run()"\n}').code, 'run()');
  assert.equal(rescueTruncatedJson('{\n"action": "execute_js",\n"code": "run()" } ]').code, 'run()');
  assert.equal(rescueTruncatedJson('{\n"action": "execute_js",\n"code": "run()"]}').code, 'run()"]}', 'the wrong order of ] and } is not a tail');
  const started = performance.now();
  rescueTruncatedJson(`{\n"action": "execute_js",\n"code": "a"${' '.repeat(400_000)}"${' '.repeat(400_000)}x`);
  assert.ok(performance.now() - started < 1000, 'whitespace after a quote must not backtrack');
});

test('step 4: click and type keep the id and the text that are there', () => {
  assert.deepEqual(rescueTruncatedJson('{\n"action": "click",\n"element_id": 12,\n"reason": "the sec'), {
    action: 'click', element_id: 12, text: undefined, reason: 'Recovered from truncated model output'
  });
  assert.deepEqual(rescueTruncatedJson('{\n"action": "type",\n"element_id": 4,\n"text": "hello world",\n"sub'), {
    action: 'type', element_id: 4, text: 'hello world', reason: 'Recovered from truncated model output'
  });
  assert.equal(rescueTruncatedJson('{"action": "scroll", "direction": "do'), null);
  assert.equal(rescueTruncatedJson('nothing here'), null);
});

/* ------------------------------------------------------------------ *
 * The scanner
 * ------------------------------------------------------------------ */

function spans(text: string) {
  return findTopLevelObjects(text).map((s) => ({ text: text.slice(s.start, s.end), closed: s.closed }));
}

test('balancedEnd: the end of one object or array, string-aware', () => {
  assert.deepEqual(balancedEnd('{"a":{"b":1}} tail', 0, '{', '}'), { end: 13, closed: true });
  assert.deepEqual(balancedEnd('xx {"a":"}"}', 3, '{', '}'), { end: 12, closed: true });
  assert.deepEqual(balancedEnd('{"a":"\\"}"}', 0, '{', '}'), { end: 11, closed: true });
  assert.deepEqual(balancedEnd('[1,[2,"]"],3]x', 0, '[', ']'), { end: 13, closed: true });
  assert.deepEqual(balancedEnd('{"a":{"b":1}', 0, '{', '}'), { end: 12, closed: false });
  assert.deepEqual(balancedEnd('{"a":"x', 0, '{', '}'), { end: 7, closed: false });
});

test('findTopLevelObjects: nested objects are one object', () => {
  assert.deepEqual(spans('a {"x":{"y":{"z":1}}} b'), [{ text: '{"x":{"y":{"z":1}}}', closed: true }]);
  assert.deepEqual(spans('{"action":"browser_batch","steps":[{"a":1},{"b":2}]}'), [{ text: '{"action":"browser_batch","steps":[{"a":1},{"b":2}]}', closed: true }]);
});

test('findTopLevelObjects: braces and quotes inside strings do not count', () => {
  assert.deepEqual(spans('{"a":"}{"} {"b":"\\"}"}'), [{ text: '{"a":"}{"}', closed: true }, { text: '{"b":"\\"}"}', closed: true }]);
  assert.deepEqual(spans('{"a":"x\\\\"} {"b":1}'), [{ text: '{"a":"x\\\\"}', closed: true }, { text: '{"b":1}', closed: true }]);
});

test('findTopLevelObjects: a quote in the prose outside an object is prose', () => {
  assert.deepEqual(spans('He said "go and then {"a":1}'), [{ text: '{"a":1}', closed: true }]);
});

test('findTopLevelObjects: several objects in order, and stray closing braces are ignored', () => {
  assert.deepEqual(spans('} {"a":1}}{"b":2} }'), [{ text: '{"a":1}', closed: true }, { text: '{"b":2}', closed: true }]);
  assert.deepEqual(spans('no braces'), []);
  assert.deepEqual(spans(''), []);
});

test('findTopLevelObjects: an object that ends the text is returned open, and it is the last one', () => {
  assert.deepEqual(spans('{"a":1} {"b":{"c":2'), [{ text: '{"a":1}', closed: true }, { text: '{"b":{"c":2', closed: false }]);
  assert.deepEqual(spans('{"a":"unterminated'), [{ text: '{"a":"unterminated', closed: false }]);
});

test('findTopLevelObjects: a brace in the prose does not hide the object after it', () => {
  // The quote inside the prose brace used to flip the string state of the scan for the rest of the text.
  assert.deepEqual(spans('I see "{" on the page. {"a":1}'), [{ text: '{"a":1}', closed: true }]);
  assert.deepEqual(spans('div.price { color... {"a":1}'), [{ text: '{"a":1}', closed: true }]);
  assert.deepEqual(spans('{go to https://a.de/x```json\n{"click": 4}{"action":"scroll"}'), [
    { text: '{"click": 4}', closed: true },
    { text: '{"action":"scroll"}', closed: true }
  ]);
  // The stray brace used to close by accident, at the closing brace of the real object.
  const accident = 'I see "{" on the page.\n{"action":"finish","answer":"Price {ab} is \\"1,00\\" EUR"}';
  assert.deepEqual(spans(accident), [{ text: accident.slice(accident.indexOf('{"action"')), closed: true }]);
  // Nested objects behind a stray brace stay whole.
  assert.deepEqual(spans('x { {"a":{"b":1}} {"c":2}'), [{ text: '{"a":{"b":1}}', closed: true }, { text: '{"c":2}', closed: true }]);
  assert.deepEqual(spans('{{"a":1}}'), [{ text: '{"a":1}', closed: true }], 'a doubled brace is one stray and one object');
});

test('findTopLevelObjects: what can begin an object is a key and a colon, an empty object, or a text that stops too early to tell', () => {
  for (const text of ['{"a":1}', '{ "a" : 1 }', '{\n  "a":\n1\n}', '{}', '{ }', '{"a\\"b":1}', '{"a":']) {
    assert.equal(findTopLevelObjects(text).length, 1, text);
  }
  // Cut off before the first key is complete: still an object, listed as open, so the ladder can look at it.
  for (const text of ['{', '{  ', '{"', '{"acti', '{"action"', '{"action" ', '{"action']) {
    assert.deepEqual(findTopLevelObjects(text).map((s) => s.closed), [false], text);
  }
  for (const text of ['{a:1}', "{'a':1}", '{ a }', '{"a" 1}', '{"a" "b"}', '{,"a":1}', '{[1]}', '{{}}', '{ 1 }']) {
    assert.ok(findTopLevelObjects(text).every((s) => s.start !== 0), `${text} does not begin an object`);
  }
});

test('findTopLevelObjects: an open object is still not scanned again from inside (its steps are not actions)', () => {
  assert.deepEqual(spans('{"action":"browser_batch","steps":[{"action":"click","element_id":2}'), [
    { text: '{"action":"browser_batch","steps":[{"action":"click","element_id":2}', closed: false }
  ]);
  assert.deepEqual(spans('{"action":"browser_batch","steps":[{"action":"click","element_id":2},{"action":"click","element_id":'), [
    { text: '{"action":"browser_batch","steps":[{"action":"click","element_id":2},{"action":"click","element_id":', closed: false }
  ]);
});

test('findTopLevelObjects: braces and keys that do not begin an object are linear', () => {
  const texts = [
    '{'.repeat(300_000),
    '{"'.repeat(150_000),
    '{"a" '.repeat(100_000),
    '{ "'.repeat(100_000),
    '{ '.repeat(200_000),
    `{"${'{'.repeat(300_000)}"x`,
    `${'{"a"'.repeat(60_000)} x`,
    '{"\\"'.repeat(80_000),
    `${'{'.repeat(100_000)}${' '.repeat(300_000)}`
  ];
  for (const text of texts) {
    const started = performance.now();
    const result = findTopLevelObjects(text);
    const took = performance.now() - started;
    assert.ok(result.length <= 1, `${text.slice(0, 8)} gave ${result.length} spans`);
    assert.ok(took < 500, `${text.slice(0, 8)} took ${took.toFixed(0)} ms`);
  }
});

test('findTopLevelObjects: 200000 small objects in one pass', () => {
  const started = performance.now();
  const result = findTopLevelObjects('{"a":1} '.repeat(200_000));
  assert.equal(result.length, 200_000);
  assert.ok(performance.now() - started < 1000);
});
