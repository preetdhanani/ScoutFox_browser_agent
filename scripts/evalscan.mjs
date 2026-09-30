#!/usr/bin/env node
/**
 * evalscan: fails if dist/ reaches eval() or the Function constructor.
 *
 * Why: the extension pages and the service worker run under the MV3 CSP (`script-src 'self'`),
 * which blocks eval and the Function constructor. A library that probes them once (zod does, with
 * `new Function('')`) costs a CSP violation event, and a real call breaks a feature only in the
 * packaged extension.
 *
 * How: every .js file under dist/ is parsed (with Vite's parser, so comments and strings never
 * count), each hit is mapped back to its ORIGINAL source file and line through the sourcemap
 * next to the file, and the result is compared with ALLOWLIST below. Any hit that is not on the
 * list exits 1. It is a static scan, and it is a guard against an accident, not a wall against
 * someone who wants to hide a call.
 *
 * What counts as a hit:
 *   - a call or `new` of eval or Function, however the callee is written: eval(x), new Function(x),
 *     (0, eval)(x), new (Function)(x), globalThis.Function(x), window['eval'](x)
 *   - any other USE of the global `eval` or `Function` as a value: an alias (`const F = Function`,
 *     which is how zod 4 compiles), Reflect.construct(Function, ...), Function.call/apply/bind(...),
 *     eval.call(...), a tagged template (Function`x`), Function.prototype.constructor, and the
 *     same through globalThis, window, self or this (`const F = globalThis.Function`)
 *   - setTimeout, setInterval or setImmediate called with a string or template literal
 *   Harmless uses are not hits: `x instanceof Function`, `typeof Function`, `x === Function`, and
 *   `Function.prototype.<name>` where the name is not `constructor` (toString, call, apply, bind).
 *   A local variable that happens to be called Function is a false alarm on purpose (fail closed).
 *
 * What it does NOT catch (each one was tried and is not seen):
 *   - `.constructor(...)` on anything but Function.prototype: (async function () {}).constructor(x),
 *     fn.constructor(x), and a destructured constructor: `const { constructor: F } = () => {}`
 *   - a name built at run time: `globalThis['Fun' + 'ction'](...)`, `window[name](...)`,
 *     Reflect.get(globalThis, 'Function')
 *   - setTimeout(variable) where the variable holds a string, the scan only sees literals
 *   - import('data:...') and other dynamic imports of a URL: scripts/build.mjs rejects any dynamic
 *     import in the worker and in content scripts, but not in the side panel page
 *
 * The allowlist is narrow but not exact. An entry matches the ORIGINAL file, the kind of hit, a
 * snippet that must be in the ORIGINAL source line of the hit, and a maximum count. It does not know the enclosing
 * function or context: a second call with the same snippet on another line of that file is
 * allowed until the count is used up, even if it sits in a different function and does something
 * else. Raise `max` only after reading the new call.
 *
 * The maps are read, never scanned. Build first (`npm run build`), because dist/ is what ships.
 * The build writes them with sourcemap 'hidden': the .map files are next to the built files, but
 * the built files have no sourceMappingURL line. loadMap() reads `<file>.map` and nothing else, and
 * a built file that does end in a sourceMappingURL comment is an error: the build changed, and a
 * comment (or a string that looks like one) must not choose which map the hits are attributed by.
 * A file with no map is still scanned, but its hits point at the built file and no allowlist entry
 * matches them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'vite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

/**
 * Hits that are on purpose. An entry is narrow: one original source file, plus the kind of hit,
 * plus a snippet that must appear on the ORIGINAL source line of the hit (the line the map points
 * at), plus the number of times it may occur. A second copy of the snippet in that file, the same
 * snippet in another file, or another kind of hit on that line is a new hit and fails. Add an
 * entry only with a reason.
 *
 * Every entry but the first names a file under node_modules/. That is what keeps the list from
 * hiding a hit in our own sources: a hit in src/, background/ or content/ has a different file, so
 * no library entry can match it (tests/evalscan.test.js pins that). Never add an entry for our own
 * code, fix the code. A library entry says why the call cannot run or why it is harmless, and names
 * the version that was read. Versions are exact pins, so an entry goes stale loudly (its snippet or
 * kind stops matching, and the hit fails) when an upgrade changes the line.
 */
export const ALLOWLIST = [
  {
    file: 'background/agentEngine.js',
    kind: 'new Function(',
    snippet: 'new Function(`return (async () => { ${src} })()`)',
    max: 1,
    // The execute_js action. This code is the `func` of chrome.scripting.executeScript({ world: 'MAIN' }):
    // Chrome serializes it and runs it inside the web PAGE, under the page's own CSP. The
    // worker and the extension pages never call it, and the action reports "EVAL_BLOCKED" when
    // the page's CSP refuses it.
    why: 'execute_js runs this in the page (MAIN world), not in the worker'
  },
  {
    // zod 4.6.5. `allowsEval` returns false on its first line when globalThis.__zod_globalConfig.jitless is true,
    // before it gets to this call. src/background/boot/zodJitless.ts sets the flag as the first import of the
    // worker, scripts/build.mjs checks that order in dist/, and the smoke test's zod-not-jitless control shows
    // the CSP violation that this call causes when the flag is missing.
    file: 'node_modules/zod/v4/core/util.js',
    kind: 'new Function(',
    snippet: 'new F("")',
    max: 1,
    why: "zod's allowsEval probe, skipped under jitless (zodJitless is the first import of the worker)"
  },
  {
    // zod 4.6.5. Doc.compile is called from one place that is in the bundle: generateFastpass of an object schema,
    // which runs only when `jit && allowsEval.value`. jit is `!globalConfig.jitless`, so it is false here.
    // (compileFn in compile.js has the same alias, and it is not in the bundle because nothing calls it.)
    file: 'node_modules/zod/v4/core/doc.js',
    kind: 'Function (used as a value)',
    snippet: 'const F = Function;',
    max: 1,
    why: "zod's Doc.compile, only reached by the object fast path, which is off under jitless"
  },
  {
    // openai 7.25.0, lib/EventStream.mjs. It builds a set of trusted native error and intrinsic constructors.
    // The native Function constructor is only asked for its source text, to compare that text with another.
    file: 'node_modules/openai/lib/EventStream.mjs',
    kind: 'Function (used as a value)',
    snippet: 'functionToString.call(Function)',
    max: 1,
    why: 'the openai SDK reads the source text of the native Function constructor and compares it, it never calls it'
  },
  {
    // openai 7.25.0, lib/EventStream.mjs. `Function` is one entry of a list of native constructors. The loop only reads
    // each one's `prototype` descriptor and its source text (rememberTrustedIntrinsic), and the only Reflect.construct
    // in the file takes a constructor whose source text equals the native Error constructor's, so never Function.
    file: 'node_modules/openai/lib/EventStream.mjs',
    kind: 'Function (used as a value)',
    snippet: 'Function,',
    max: 1,
    why: 'the openai SDK lists Function among native constructors whose descriptors it reads, it never calls it'
  }
];

// ---- sourcemap reading ----------------------------------------------------------------------

const BASE64 = new Map([...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'].map((c, i) => [c, i]));

/** One base64 VLQ segment -> its numbers. */
function decodeVlq(segment) {
  const numbers = [];
  let value = 0;
  let shift = 0;
  for (const char of segment) {
    const digit = BASE64.get(char);
    if (digit === undefined) throw new Error(`bad character "${char}" in sourcemap mappings`);
    value += (digit & 31) << shift;
    if (digit & 32) {
      shift += 5;
    } else {
      numbers.push(value & 1 ? -(value >>> 1) : value >>> 1);
      value = 0;
      shift = 0;
    }
  }
  return numbers;
}

/** `mappings` -> per generated line, the segments [generatedColumn, sourceIndex, sourceLine, sourceColumn] in column order. */
function decodeMappings(mappings) {
  const lines = [];
  let source = 0;
  let sourceLine = 0;
  let sourceColumn = 0;
  for (const line of mappings.split(';')) {
    const segments = [];
    let column = 0;
    for (const raw of line ? line.split(',') : []) {
      const n = decodeVlq(raw);
      column += n[0];
      if (n.length < 4) continue; // a segment with no source
      source += n[1];
      sourceLine += n[2];
      sourceColumn += n[3];
      segments.push([column, source, sourceLine, sourceColumn]);
    }
    lines.push(segments);
  }
  return lines;
}

/** A `//# sourceMappingURL=` comment on the last non-empty line of a built file: where a real one always is. */
const TRAILING_MAP_COMMENT = /^[ \t]*\/\/[#@][ \t]*sourceMappingURL=/;

/**
 * The map that belongs to a built file, or null: always `<file>.map`. The map is never taken from a comment inside the
 * code, because that could be a string of our own code that names a forged map. A built file that ends in such a
 * comment is refused, since the build is meant to write hidden maps (vite.config.mjs).
 */
export function loadMap(file, code) {
  const lastLine = code.trimEnd().split('\n').pop() ?? '';
  if (TRAILING_MAP_COMMENT.test(lastLine)) {
    throw new Error(`${displayPath(file)} ends in a sourceMappingURL comment, but the build writes hidden sourcemaps. Read its map from ${displayPath(file)}.map only, so fix the build (sourcemap: 'hidden') instead of following the comment.`);
  }
  const mapPath = `${file}.map`;
  if (!fs.existsSync(mapPath)) return null;
  const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
  if (!map.mappings || !Array.isArray(map.sources)) throw new Error(`${path.relative(ROOT, mapPath)}: not a sourcemap with sources and mappings`);
  const dir = path.dirname(mapPath);
  return {
    lines: decodeMappings(map.mappings),
    sources: map.sources.map((s) => (s === null ? null : path.resolve(dir, map.sourceRoot || '', s))),
    contents: map.sourcesContent || []
  };
}

/**
 * Where a generated (line, column), both 0-based, comes from: { file, line, column, text }, or
 * null when the map has nothing on that line. The segment at or before the column wins. A call
 * such as `(0, eval)(x)` starts on a bracket that has no segment of its own, so then the first
 * segment after the column is used.
 */
function originalPosition(map, line, column) {
  let found = null;
  for (const segment of map.lines[line] || []) {
    if (segment[0] <= column) {
      found = segment;
    } else {
      found ??= segment;
      break;
    }
  }
  if (!found || map.sources[found[1]] === null) return null;
  const abs = map.sources[found[1]];
  let text = map.contents[found[1]];
  if (typeof text !== 'string') text = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
  return { file: displayPath(abs), line: found[2] + 1, column: found[3] + 1, text: text.split('\n')[found[2]] ?? '' };
}

function displayPath(abs) {
  const rel = path.relative(ROOT, abs);
  return (rel.startsWith('..') ? abs : rel).split(path.sep).join('/');
}

// ---- finding the hits -----------------------------------------------------------------------

const DANGEROUS = new Set(['eval', 'Function']);
const GLOBAL_OBJECTS = new Set(['globalThis', 'window', 'self', 'global', 'top', 'parent', 'frames']);
const TIMERS = new Set(['setTimeout', 'setInterval', 'setImmediate']);
const COMPARISONS = new Set(['instanceof', '===', '!==', '==', '!=']);
const FUNCTION_LIKE = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const MODULE_NAMES = new Set(['ImportSpecifier', 'ImportDefaultSpecifier', 'ImportNamespaceSpecifier', 'ExportSpecifier', 'ExportNamespaceSpecifier']);

/** Every node of a parsed program with the path up to the root ({ node, key, up }), without recursion (minified bundles can nest very deep). */
function* walk(root) {
  const stack = [{ node: root, key: null, up: null }];
  while (stack.length) {
    const item = stack.pop();
    yield item;
    for (const key of Object.keys(item.node)) {
      const value = item.node[key];
      if (Array.isArray(value)) {
        for (const child of value) if (child && typeof child.type === 'string') stack.push({ node: child, key, up: item });
      } else if (value && typeof value.type === 'string') {
        stack.push({ node: value, key, up: item });
      }
    }
  }
}

/** The node a callee really is: parentheses, `?.` and `(0, x)` peeled off. */
function peel(callee) {
  for (;;) {
    if (callee.type === 'ParenthesizedExpression' || callee.type === 'ChainExpression') callee = callee.expression;
    else if (callee.type === 'SequenceExpression') callee = callee.expressions[callee.expressions.length - 1];
    else return callee;
  }
}

/** The name a member expression reads: a.b -> "b", a['b'] -> "b", anything computed at run time -> null. */
function memberName(member) {
  const { property } = member;
  if (!member.computed && property.type === 'Identifier') return property.name;
  if (member.computed && property.type === 'Literal' && typeof property.value === 'string') return property.value;
  return null;
}

/** The name a callee ends in: eval, window.eval, (0, eval), globalThis['Function'] and so on. */
function calleeName(callee) {
  const node = peel(callee);
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression') return memberName(node);
  return null;
}

/** Is this member expression `globalThis.x`, `window.x`, `self.x`, `this.x` (the ways to reach a global by name)? */
function onGlobalObject(member) {
  const object = peel(member.object);
  return object.type === 'ThisExpression' || (object.type === 'Identifier' && GLOBAL_OBJECTS.has(object.name));
}

/** True when an identifier at this position is a NAME (a property, a label, a declaration), not a use of the global. */
function isNotAReference({ node, key, up }) {
  const parent = up.node;
  const grand = up.up && up.up.node;
  if (parent.type === 'MemberExpression' && key === 'property' && !parent.computed) return true;
  if (parent.type === 'Property' && key === 'key' && !parent.computed) return true;
  if (['MethodDefinition', 'PropertyDefinition', 'AccessorProperty'].includes(parent.type) && key === 'key' && !parent.computed) return true;
  if (MODULE_NAMES.has(parent.type)) return true;
  if (['LabeledStatement', 'BreakStatement', 'ContinueStatement'].includes(parent.type) && key === 'label') return true;
  if (parent.type === 'MetaProperty') return true;
  // Declarations and patterns: this makes a new binding (or assigns into a pattern), it does not read the global.
  if (parent.type === 'VariableDeclarator' && key === 'id') return true;
  if ((FUNCTION_LIKE.has(parent.type) || parent.type === 'ClassDeclaration' || parent.type === 'ClassExpression') && (key === 'id' || key === 'params')) return true;
  if (parent.type === 'CatchClause' && key === 'param') return true;
  if (parent.type === 'RestElement' || parent.type === 'ArrayPattern' || parent.type === 'ObjectPattern') return true;
  if (parent.type === 'AssignmentPattern' && key === 'left') return true;
  if (parent.type === 'Property' && key === 'value' && grand && grand.type === 'ObjectPattern') return true;
  return false;
}

/** A use that cannot create code: `x instanceof Function`, `typeof Function`, `x === Function`. */
function isComparison(up) {
  const parent = up.up.node;
  return (parent.type === 'BinaryExpression' && COMPARISONS.has(parent.operator)) || (parent.type === 'UnaryExpression' && parent.operator === 'typeof');
}

/** `Function.prototype.toString`, `.call`, `.apply`, `.bind`: anything but `.constructor` (or a name only known at run time). */
function isSafePrototypeMember(item) {
  const proto = item.up; // the node that holds the identifier, hopefully `Function.prototype`
  if (proto.node.type !== 'MemberExpression' || item.key !== 'object' || memberName(proto.node) !== 'prototype') return false;
  const outer = proto.up; // what `Function.prototype` is used in
  if (outer.node.type === 'MemberExpression' && proto.key === 'object') {
    const name = memberName(outer.node);
    return name !== null && name !== 'constructor';
  }
  return isComparison(proto); // x === Function.prototype
}

/** The hits of one parsed program, as { kind, node }. `node` is where to point. */
export function findHits(program) {
  const hits = [];
  const seen = new Set(); // the callee nodes already reported as calls, so the value pass does not report them again

  // Pass 1: calls, `new`, and timers given a string.
  for (const { node } of walk(program)) {
    if (node.type === 'CallExpression' || node.type === 'NewExpression') {
      const name = calleeName(node.callee);
      if (DANGEROUS.has(name)) {
        seen.add(peel(node.callee));
        hits.push({ kind: name === 'eval' ? 'eval(' : node.type === 'NewExpression' ? 'new Function(' : 'Function(', node });
      } else if (node.type === 'CallExpression' && TIMERS.has(name)) {
        const first = node.arguments[0];
        if (first && ((first.type === 'Literal' && typeof first.value === 'string') || first.type === 'TemplateLiteral')) {
          hits.push({ kind: `${name}(string)`, node });
        }
      }
    }
  }

  // Pass 2: the global eval or Function used as a value in any other way.
  for (const item of walk(program)) {
    const { node } = item;
    if (seen.has(node) || !item.up) continue;
    if (node.type === 'Identifier' && DANGEROUS.has(node.name)) {
      if (isNotAReference(item)) continue;
      if (isComparison(item)) continue;
      if (node.name === 'Function' && isSafePrototypeMember(item)) continue;
      hits.push({ kind: `${node.name} (used as a value)`, node });
    } else if (node.type === 'MemberExpression' && DANGEROUS.has(memberName(node)) && onGlobalObject(node)) {
      if (isComparison(item)) continue;
      hits.push({ kind: `${memberName(node)} (used as a value, through a global object)`, node });
    }
  }
  return hits;
}

/**
 * Matches every hit against the allowlist: { results: [{ hit, entry }], used }. `entry` is the allowlist
 * entry that took the hit, or null when it is not allowed. An entry takes at most `max` hits, in the
 * order given, so the caller sorts first. `hit` is { kind, file, text }, where file is the ORIGINAL file.
 */
export function classifyHits(hits, list = ALLOWLIST) {
  const used = new Map(list.map((entry) => [entry, 0]));
  const results = hits.map((hit) => {
    const entry = list.find((e) => e.file === hit.file && e.kind === hit.kind && hit.text.includes(e.snippet) && used.get(e) < e.max) ?? null;
    if (entry) used.set(entry, used.get(entry) + 1);
    return { hit, entry };
  });
  return { results, used };
}

function jsFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...jsFiles(full));
    else if (/\.(?:js|mjs|cjs)$/.test(entry.name)) files.push(full); // never the .map files
  }
  return files.sort();
}

function lineStarts(code) {
  const starts = [0];
  for (let i = code.indexOf('\n'); i !== -1; i = code.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

/** 0-based line of an offset, given the sorted line start offsets. */
function lineOf(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return low;
}

// ---- main -----------------------------------------------------------------------------------

function main() {
  if (!fs.existsSync(DIST)) {
    console.error('evalscan: dist/ not found. Run `npm run build` first.');
    process.exit(1);
  }
  const files = jsFiles(DIST);
  if (files.length === 0) {
    console.error('evalscan: no .js files in dist/. Run `npm run build` first.');
    process.exit(1);
  }

  const hits = [];
  let mapsUsed = 0;
  for (const file of files) {
    const code = fs.readFileSync(file, 'utf8');
    const shown = displayPath(file);
    const { program, errors } = parseSync(shown, code, { lang: 'js', sourceType: 'unambiguous' });
    if (errors.length) {
      // Fail closed: a file that cannot be parsed cannot be vouched for.
      console.error(`evalscan: cannot parse ${shown}: ${errors[0].message}`);
      process.exit(1);
    }
    let map;
    try {
      map = loadMap(file, code);
    } catch (error) {
      // Fail closed: a map that cannot be trusted cannot vouch for a hit.
      console.error(`evalscan: ${error.message}`);
      process.exit(1);
    }
    if (map) mapsUsed++;
    const starts = lineStarts(code);
    for (const { kind, node } of findHits(program)) {
      const line = lineOf(starts, node.start);
      const column = node.start - starts[line];
      const origin = map && originalPosition(map, line, column);
      hits.push({
        kind,
        dist: `${shown}:${line + 1}:${column + 1}`,
        // Without a map the built file is all we can point at, and no allowlist entry can match it.
        file: origin ? origin.file : shown,
        line: origin ? origin.line : line + 1,
        column: origin ? origin.column : column + 1,
        text: (origin ? origin.text : code.split('\n')[line]).trim()
      });
    }
  }
  hits.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || a.column - b.column));

  const { results, used } = classifyHits(hits);
  let allowed = 0;
  let denied = 0;
  for (const { hit, entry } of results) {
    const at = `${hit.file}:${hit.line}:${hit.column}`;
    if (entry) {
      allowed++;
      console.log(`allowed      ${at}  ${hit.kind}  (${entry.why})`);
    } else {
      denied++;
      console.log(`NOT ALLOWED  ${at}  ${hit.kind}  ${hit.text.slice(0, 100)}  [${hit.dist}]`);
    }
  }
  for (const [entry, count] of used) {
    if (count === 0) console.log(`note: allowlist entry for ${entry.file} (${entry.snippet}) matched nothing, remove it if the code is gone`);
  }

  console.log(`evalscan: ${files.length} files scanned (${mapsUsed} sourcemaps used), ${hits.length} hit(s): ${allowed} allowed, ${denied} not allowed`);
  process.exitCode = denied ? 1 : 0;
}

// Run only when started as a script: tests/evalscan.test.js imports findHits and must not trigger a scan.
if (fs.realpathSync(process.argv[1] ?? '') === fs.realpathSync(fileURLToPath(import.meta.url))) main();
