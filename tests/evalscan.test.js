/**
 * scripts/evalscan.mjs guards dist/ against eval and the Function constructor, which the MV3 CSP
 * blocks. These tests feed it code as strings and check what it reports. It is the scanner's own
 * regression test: a shape that stops being reported here is a shape that would slip into dist/.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSync } from 'vite';
import { findHits } from '../scripts/evalscan.mjs';

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
