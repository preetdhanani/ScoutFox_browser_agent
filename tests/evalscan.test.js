/**
 * scripts/evalscan.mjs guards dist/ against eval and the Function constructor, which the MV3 CSP
 * blocks. These tests feed it code as strings and check what it reports. It is the scanner's own
 * regression test: a shape that stops being reported here is a shape that would slip into dist/.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSync } from 'vite';
import { ALLOWLIST, classifyHits, findHits, loadMap } from '../scripts/evalscan.mjs';

function kindsOf(code) {
  const { program, errors } = parseSync('case.js', code, { lang: 'js', sourceType: 'unambiguous' });
  assert.deepEqual(errors, [], `the test code must parse: ${code}`);
  return findHits(program).map((hit) => hit.kind);
}

// Every way to reach eval or the Function constructor that the scan claims to catch.
const MUST_REPORT = [
  ['eval(x)', "eval('1')"],
  ['new Function(x)', "new Function('return 1')"],
  ['Function(x)', "Function('return 1')"],
  ['(0, eval)(x)', "(0, eval)('1')"],
  ['new (Function)(x)', "new (Function)('return 1')"],
  ['globalThis.Function(x)', "globalThis.Function('return 1')"],
  ['window["eval"](x)', "window['eval']('1')"],
  ['self.eval?.(x)', "self.eval?.('1')"],
  ['an alias, then new (zod 4)', "const F = Function; new F('return 1');"],
  ['an alias of eval', "const e = eval; e('1');"],
  ['Reflect.construct(Function)', "Reflect.construct(Function, ['return 1'])"],
  ['Function.call(...)', "Function.call(null, 'return 1')"],
  ['Function.apply(...)', "Function.apply(null, ['return 1'])"],
  ['Function.bind(...)(...)', "Function.bind(null)('return 1')"],
  ['eval.call(...)', "eval.call(null, '1')"],
  ['Reflect.apply(Function, ...)', "Reflect.apply(Function, null, ['return 1'])"],
  ['a tagged template', 'Function`return 1`'],
  ['new with a tagged template', 'new Function`return 1`'],
  ['Function.prototype.constructor(...)', "Function.prototype.constructor('return 1')"],
  ['Function.prototype[name](...)', "Function.prototype[name]('return 1')"],
  ['globalThis.Function as a value', 'const F = globalThis.Function;'],
  ['this.eval as a value', 'const e = this.eval;'],
  ['Function passed as an argument', 'register(Function);'],
  ['setTimeout with a string', "setTimeout('doIt()', 10)"],
  ['setInterval with a template', 'setInterval(`doIt()`, 10)'],
  ['window.setTimeout with a string', "window.setTimeout('doIt()')"]
];

// Uses that cannot create code, and names that only look like the global.
const MUST_NOT_REPORT = [
  ['x instanceof Function', 'if (x instanceof Function) run();'],
  ['typeof Function', "const ok = typeof Function === 'function';"],
  ['x === Function', 'const isPlain = obj.constructor === Function;'],
  ['x !== Function', 'const other = obj.constructor !== Function;'],
  ['Function.prototype.toString.call(f)', 'const src = Function.prototype.toString.call(f);'],
  ['Function.prototype.call.apply(...)', 'Function.prototype.call.apply(fn, args);'],
  ['x === Function.prototype', 'const same = Object.getPrototypeOf(f) === Function.prototype;'],
  ['a property key named Function', 'const o = { Function: 1, eval: 2 };'],
  ['a class member named eval', 'class A { eval() {} static Function = 1; }'],
  ['a property read that is not on a global object', 'const t = types.Function;'],
  ['a setTimeout with a function', 'setTimeout(() => run(), 10)'],
  ['a setTimeout with a variable', 'setTimeout(callback, 10)'],
  ['the words in a string', "const s = 'eval(x) and new Function(y)';"],
  ['the words in a comment', '// eval(x) and new Function(y)\nconst a = 1;'],
  ['a template literal that only mentions them', 'const t = `call eval() later`;'],
  ['an import of that name', "import { Function as F } from 'lib'; export { F };"],
  ['declaring a parameter or variable with that name', 'function f(Function) { var eval2 = 1; }']
];

test('reports every way of reaching eval or the Function constructor', () => {
  const missed = MUST_REPORT.filter(([, code]) => kindsOf(code).length === 0).map(([name]) => name);
  assert.deepEqual(missed, [], `these shapes slipped through the scan: ${missed.join('; ')}`);
});

test('does not report uses that cannot create code, nor the words in comments and strings', () => {
  const wrong = MUST_NOT_REPORT.map(([name, code]) => [name, kindsOf(code)]).filter(([, kinds]) => kinds.length > 0);
  assert.deepEqual(wrong, [], `false alarms: ${JSON.stringify(wrong)}`);
});

test('names the kind of hit, and reports one hit per call, not two', () => {
  assert.deepEqual(kindsOf("eval('1')"), ['eval(']);
  assert.deepEqual(kindsOf("new Function('x')"), ['new Function(']);
  assert.deepEqual(kindsOf("Function('x')"), ['Function(']);
  assert.deepEqual(kindsOf("(0, eval)('1')"), ['eval(']);
  assert.deepEqual(kindsOf("globalThis.Function('x')"), ['Function(']);
  assert.deepEqual(kindsOf("const F = Function; new F('x');"), ['Function (used as a value)']);
  assert.deepEqual(kindsOf("setTimeout('x')"), ['setTimeout(string)']);
  assert.deepEqual(kindsOf("eval('1'); eval('2');"), ['eval(', 'eval(']);
});

test('a local variable named Function is a false alarm on purpose (the scan fails closed)', () => {
  // The declaration is not a use of the global, the read of it is reported: the scan does not track
  // scopes, and a shadowed name is rare enough that a false alarm (fixed by renaming) is the safe side.
  assert.deepEqual(kindsOf('function f(Function) { return Function; }'), ['Function (used as a value)']);
});

test('importing the scanner does not start a scan of dist/', () => {
  // Importing the module at the top of this file would already have exited the process (or
  // printed a scan) if main() ran on import, so reaching this line is the check.
  assert.equal(typeof findHits, 'function');
});

// ---- the allowlist ----------------------------------------------------------------------------

/** A hit as evalscan builds it after the sourcemap lookup: the ORIGINAL file, the kind, and the trimmed source line. */
const hitOf = (entry, patch = {}) => ({ kind: entry.kind, file: entry.file, text: entry.snippet, line: 1, column: 1, ...patch });

// Files of ours, and a library that has no entry. A hit here must never be allowed, whatever it says.
const NOT_ALLOWED_FILES = [
  'src/background/llm/factory.ts',
  'src/background/agent/parse.ts',
  'src/shared/storage.ts',
  'background/background.js',
  'sidepanel/sidepanel.js',
  'content/content.js',
  'node_modules/some-other-library/index.js',
  'node_modules/zod/v4/core/schemas.js'
];

test('every allowlist entry is narrow: a file, a kind, a snippet and a count', () => {
  for (const entry of ALLOWLIST) {
    assert.match(entry.file, /^[\w@./-]+\.(?:js|mjs|ts)$/, `file of ${JSON.stringify(entry.snippet)}`);
    assert.ok(entry.kind && entry.snippet.length >= 8 && Number.isInteger(entry.max) && entry.max >= 1 && entry.why, `entry ${JSON.stringify(entry.snippet)} is incomplete`);
  }
});

test('the only allowlist entry that is not a library is the in-page execute_js', () => {
  const ours = ALLOWLIST.filter((entry) => !entry.file.startsWith('node_modules/'));
  assert.deepEqual(ours.map((entry) => entry.file), ['background/agentEngine.js']);
  assert.match(ours[0].snippet, /async \(\) => \{ \$\{src\} \}/);
});

test('the known hits are allowed, each as often as its max says and no more', () => {
  for (const entry of ALLOWLIST) {
    const hits = Array.from({ length: entry.max + 1 }, () => hitOf(entry));
    const { results } = classifyHits(hits);
    assert.deepEqual(results.map((r) => r.entry === entry), [...Array(entry.max).fill(true), false], entry.snippet);
  }
});

test('no entry can hide a hit in our own sources, nor in a library it was not written for', () => {
  for (const entry of ALLOWLIST) {
    for (const file of NOT_ALLOWED_FILES.filter((f) => f !== entry.file)) {
      const { results } = classifyHits([hitOf(entry, { file })]);
      assert.equal(results[0].entry, null, `${entry.snippet} in ${file} was allowed`);
    }
  }
});

test('an entry does not take another kind of hit, or another line, in its own file', () => {
  for (const entry of ALLOWLIST) {
    const otherKind = ['eval(', 'new Function(', 'Function(', 'Function (used as a value)', 'setTimeout(string)'].find((kind) => kind !== entry.kind);
    assert.equal(classifyHits([hitOf(entry, { kind: otherKind })]).results[0].entry, null, `${entry.snippet} with kind ${otherKind}`);
    assert.equal(classifyHits([hitOf(entry, { text: 'return new Function(userText)()' })]).results[0].entry, null, `${entry.snippet} on an unrelated line`);
  }
});

test('the zod probe entry is keyed by the zod source path, so another copy of zod is a new hit', () => {
  const probe = ALLOWLIST.find((entry) => entry.snippet === 'new F("")');
  assert.equal(probe.file, 'node_modules/zod/v4/core/util.js');
  const nested = hitOf(probe, { file: 'node_modules/@langchain/core/node_modules/zod/v4/core/util.js' });
  assert.equal(classifyHits([nested]).results[0].entry, null);
});

// ---- the sourcemap of a built file --------------------------------------------------------------

/** A built file `sw.js` with its `sw.js.map` (line 0 comes from `src/real.js`) in a temporary directory. */
function builtFile(t, code, { withMap = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalscan-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'sw.js');
  fs.writeFileSync(file, code);
  if (withMap) fs.writeFileSync(`${file}.map`, JSON.stringify({ version: 3, sources: ['src/real.js'], sourcesContent: ['new Function("real")'], mappings: 'AAAA' }));
  return file;
}

/** A sourcemap as a data: URI comment that puts line 0 in a library file, where an allowlist entry would take it. */
const FORGED_MAP_COMMENT = `//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify({
  version: 3, sources: ['node_modules/zod/v4/core/util.js'], sourcesContent: ['new F("")'], mappings: 'AAAA'
})).toString('base64')}`;

test('the map of a built file is its own .map, and null when there is none', (t) => {
  const map = loadMap(builtFile(t, 'const f = 1;\n'), 'const f = 1;\n');
  assert.ok(map.sources[0].endsWith(path.join('src', 'real.js')));
  assert.equal(loadMap(builtFile(t, 'const f = 1;\n', { withMap: false }), 'const f = 1;\n'), null);
});

test('a sourceMappingURL line inside a string of the code does not choose the map (a forged data: URI must not win over <file>.map)', (t) => {
  // The line sits in the middle of a template literal, as the string of a file of ours could: it is not a comment at all.
  const code = `const f = new Function("return 1");\nconst s = \`\n${FORGED_MAP_COMMENT}\n\`;\n`;
  const { errors } = parseSync('case.js', code, { lang: 'js', sourceType: 'unambiguous' });
  assert.deepEqual(errors, [], 'the code must parse');
  const map = loadMap(builtFile(t, code), code);
  assert.ok(map.sources[0].endsWith(path.join('src', 'real.js')), `the forged map was followed: ${map.sources[0]}`);
});

test('a built file that ends in a sourceMappingURL comment is refused: the build writes hidden maps', (t) => {
  for (const comment of ['//# sourceMappingURL=sw.js.map', '//@ sourceMappingURL=sw.js.map', FORGED_MAP_COMMENT]) {
    const code = `const f = 1;\n${comment}\n`;
    assert.throws(() => loadMap(builtFile(t, code), code), /ends in a sourceMappingURL comment.*hidden sourcemaps/s, comment.slice(0, 40));
  }
});
