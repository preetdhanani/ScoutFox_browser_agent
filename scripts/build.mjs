#!/usr/bin/env node
/**
 * Builds the extension into dist/ with Vite (the passes live in ../vite.config.mjs), then checks
 * that dist/ is something Chrome can actually load. Any Vite error or failed check exits 1.
 *
 *   node scripts/build.mjs                 build, then check
 *   node scripts/build.mjs --verify-only   only check the existing dist/
 *
 * The check exists because Chrome reports most of these problems late and vaguely (a worker that
 * "failed to register", a content script that silently never runs), not at build time.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
import { build, parseSync, version as viteVersion } from 'vite';
import { passes, ROOT, OUT_DIR } from '../vite.config.mjs';

const DIST = path.join(ROOT, OUT_DIR);
const distPath = (rel) => path.join(DIST, ...rel.split('/'));

/** Every file and directory under dist/, as posix paths relative to dist/, sorted. */
function walk(dir = DIST, prefix = '') {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    found.push({ rel, isDir: entry.isDirectory() });
    if (entry.isDirectory()) found.push(...walk(path.join(dir, entry.name), rel));
  }
  return found.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/** Parse a built file. `module` says what import/export/import.meta syntax it uses. */
function parseBuilt(rel, sourceType) {
  const code = fs.readFileSync(distPath(rel), 'utf8');
  const { program, module, errors } = parseSync(rel, code, { lang: 'js', sourceType });
  return { code, program, module, errors };
}

/** Every file path the manifest points to, as { key, file } with a path relative to dist/. */
function manifestRefs(manifest) {
  const refs = [];
  const add = (key, file) => {
    if (typeof file === 'string' && file) refs.push({ key, file: file.replace(/^\/+/, '') });
  };
  add('background.service_worker', manifest.background?.service_worker);
  add('side_panel.default_path', manifest.side_panel?.default_path);
  for (const [i, script] of (manifest.content_scripts || []).entries()) {
    for (const file of script.js || []) add(`content_scripts[${i}].js`, file);
    for (const file of script.css || []) add(`content_scripts[${i}].css`, file);
  }
  for (const [size, file] of Object.entries(manifest.icons || {})) add(`icons.${size}`, file);
  const icon = manifest.action?.default_icon;
  for (const [size, file] of Object.entries(typeof icon === 'string' ? { icon } : icon || {})) add(`action.default_icon.${size}`, file);
  add('action.default_popup', manifest.action?.default_popup);
  add('options_page', manifest.options_page);
  add('options_ui.page', manifest.options_ui?.page);
  return refs;
}

function checkManifestPaths({ manifest }) {
  const refs = manifestRefs(manifest);
  const problems = [];
  for (const { key, file } of refs) {
    if (!fs.existsSync(distPath(file)) || !fs.statSync(distPath(file)).isFile()) {
      problems.push(`manifest ${key} points to "${file}", which is not in ${OUT_DIR}/`);
    }
  }
  return { detail: `${refs.length} paths`, problems };
}

/** The worker must be ONE file: MV3 workers cannot use dynamic import(), and a static import would need a second file. */
function checkWorker({ manifest }) {
  const file = manifest.background?.service_worker;
  if (!file || !fs.existsSync(distPath(file))) return { detail: 'no worker', problems: [] }; // the paths check reports it
  const { module, errors } = parseBuilt(file, 'module');
  const problems = errors.map((e) => `${file}: does not parse: ${e.message}`);
  if (module.staticImports.length) problems.push(`${file}: has ${module.staticImports.length} top-level import statement(s), the worker must be one file`);
  if (module.dynamicImports.length) problems.push(`${file}: has ${module.dynamicImports.length} dynamic import(), not allowed in a service worker`);
  return { detail: `${file}, 0 imports`, problems };
}

/** Content scripts are injected as classic scripts: any import, export or import.meta is a SyntaxError in the page. */
function checkContentScripts({ manifest, entries }) {
  const files = new Set(entries.filter((e) => !e.isDir && e.rel.startsWith('content/') && e.rel.endsWith('.js')).map((e) => e.rel));
  for (const script of manifest.content_scripts || []) for (const file of script.js || []) files.add(file.replace(/^\/+/, ''));
  const problems = [];
  for (const file of [...files].sort()) {
    if (!fs.existsSync(distPath(file))) continue; // the paths check reports it
    const { code, module, errors } = parseBuilt(file, 'module');
    for (const e of errors) problems.push(`${file}: does not parse: ${e.message}`);
    if (module.staticImports.length) problems.push(`${file}: has import statement(s)`);
    if (module.staticExports.length) problems.push(`${file}: has export statement(s)`);
    if (module.dynamicImports.length) problems.push(`${file}: has dynamic import(), it would need a chunk the page cannot load`);
    if (module.importMetas.length) problems.push(`${file}: uses import.meta`);
    try {
      new vm.Script(code, { filename: file }); // compiles only, never runs; V8 decides what a classic script is
    } catch (err) {
      problems.push(`${file}: is not a valid classic script: ${err.message}`);
    }
  }
  return { detail: `${files.size} files`, problems };
}

/** Every node below `root`, without recursion. */
function* allNodes(root) {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    yield node;
    stack.push(...childNodes(node));
  }
}

const isNode = (value) => value && typeof value.type === 'string';

function childNodes(node) {
  return Object.values(node).flatMap((value) => (Array.isArray(value) ? value.filter(isNode) : isNode(value) ? [value] : []));
}

const isFunction = (node) => node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression' || node.type === 'FunctionDeclaration';

/** The names a binding pattern declares: `a`, `{ a, b: [c] }`, `...rest`, `d = 1`. */
function boundNames(pattern) {
  switch (pattern?.type) {
    case 'Identifier': return [pattern.name];
    case 'ObjectPattern': return pattern.properties.flatMap((p) => boundNames(p.type === 'RestElement' ? p.argument : p.value));
    case 'ArrayPattern': return pattern.elements.flatMap(boundNames);
    case 'RestElement': return boundNames(pattern.argument);
    case 'AssignmentPattern': return boundNames(pattern.left);
    default: return [];
  }
}

/**
 * The names a function declares for itself: parameters, its own name, and every var, let, const,
 * function, class and catch name in its body, not counting nested functions (those are their own
 * scope). A let or const in a block counts for the whole function. That is a little too generous,
 * and it is fine: this only has to catch bundle-scope names, which are never declared in there.
 */
function declaredNames(fn) {
  const names = new Set(fn.params.flatMap(boundNames));
  if (fn.type === 'FunctionExpression' && fn.id) names.add(fn.id.name);
  const stack = [fn.body];
  while (stack.length) {
    const node = stack.pop();
    if (node.type === 'VariableDeclarator') boundNames(node.id).forEach((n) => names.add(n));
    if (node.type === 'CatchClause') boundNames(node.param).forEach((n) => names.add(n));
    if ((node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') && node.id) names.add(node.id.name);
    if (!isFunction(node)) stack.push(...childNodes(node));
  }
  return names;
}

/** Names in `fn` that neither `fn` nor a function inside it declares, and that are not in `allowed`. */
function outsideNames(fn, allowed) {
  const found = new Set();
  const visit = (node, scopes) => {
    if (isFunction(node)) scopes = [...scopes, declaredNames(node)];
    switch (node.type) {
      case 'Identifier':
        if (!allowed.has(node.name) && !scopes.some((scope) => scope.has(node.name))) found.add(node.name);
        return;
      case 'MemberExpression': // `a.b`: b is a property name, not a variable
        visit(node.object, scopes);
        if (node.computed) visit(node.property, scopes);
        return;
      case 'Property': case 'PropertyDefinition': case 'MethodDefinition': // `{ key: value }`, class members
        if (node.computed) visit(node.key, scopes);
        if (node.value) visit(node.value, scopes);
        return;
      case 'ClassDeclaration': case 'ClassExpression': // the class name is not looked up
        for (const part of [node.superClass, node.body]) if (part) visit(part, scopes);
        return;
      case 'LabeledStatement': visit(node.body, scopes); return;
      case 'BreakStatement': case 'ContinueStatement': case 'MetaProperty': return;
      default: for (const child of childNodes(node)) visit(child, scopes);
    }
  };
  visit(fn, []);
  return [...found];
}

// What a function may use that it does not declare: standard globals, which exist in every page.
const PAGE_GLOBALS = new Set([
  'undefined', 'NaN', 'Infinity', 'arguments', 'globalThis', 'window', 'document', 'location', 'navigator', 'console',
  'Function', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'Promise', 'JSON', 'Math', 'Date',
  'RegExp', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Error', 'TypeError', 'RangeError', 'SyntaxError',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'setTimeout', 'clearTimeout'
]);

/**
 * A function passed as `func` to chrome.scripting.executeScript is sent to the page as its
 * toString() text and runs there, where none of the bundle exists. If the bundler renames it, or
 * moves a helper it uses out to the top of the bundle, the function still works in every test that
 * calls it as plain JS and breaks only inside a real page. So every `func` in the worker must use
 * only its own parameters and locals plus PAGE_GLOBALS. To allow a global, add it above.
 */
function checkExecuteScriptFuncs({ manifest }) {
  const file = manifest.background?.service_worker;
  if (!file || !fs.existsSync(distPath(file))) return { detail: 'no worker', problems: [] }; // the paths check reports it
  const { code, program } = parseBuilt(file, 'module');
  const lineOf = (node) => code.slice(0, node.start).split('\n').length;
  const problems = [];
  let checked = 0;
  for (const call of allNodes(program)) {
    const callee = call.type === 'CallExpression' && call.callee.type === 'MemberExpression' && call.callee.property.name;
    if (callee !== 'executeScript') continue;
    const options = call.arguments[0];
    if (options?.type !== 'ObjectExpression' || options.properties.some((p) => p.type !== 'Property')) {
      problems.push(`${file}:${lineOf(call)}: executeScript options are not a plain object literal, so the check cannot read them`);
      continue;
    }
    const prop = options.properties.find((p) => !p.computed && (p.key.name ?? p.key.value) === 'func');
    if (!prop) continue; // `files: [...]`, nothing serialized
    if (!isFunction(prop.value)) {
      problems.push(`${file}:${lineOf(prop)}: executeScript "func" is not an inline function, so the check cannot read it`);
      continue;
    }
    checked++;
    for (const name of outsideNames(prop.value, PAGE_GLOBALS)) {
      problems.push(`${file}:${lineOf(prop)}: executeScript func uses "${name}", which it does not declare. It runs in the page, where the bundle's names do not exist`);
    }
  }
  if (checked === 0) problems.push(`${file}: no executeScript({ func }) found, so this check is blind. If execute_js is gone on purpose, remove the check`);
  return { detail: `${checked} func checked`, problems };
}

/**
 * Chrome refuses to load an extension that has a file or folder whose name starts with "_"
 * (reserved). Two are reserved but valid, and only at the top of the extension folder: `_locales`
 * (translations) and `_metadata` (Chrome's own, in a store-installed extension).
 */
const RESERVED_BUT_VALID = ['_locales', '_metadata'];

function checkNames({ entries }) {
  const problems = [];
  for (const { rel } of entries) {
    const parts = rel.split('/');
    // The top-level `_locales` and `_metadata` are themselves fine. Anything below them, and every other path, is checked.
    const checked = RESERVED_BUT_VALID.includes(parts[0]) ? parts.slice(1) : parts;
    if (checked.some((part) => part.startsWith('_'))) problems.push(`${rel}: name starts with "_", Chrome will not load the extension`);
  }
  return { detail: `${entries.length} paths`, problems };
}

/** Every local file a page in dist/ points to must exist, and pages must have no inline script (the MV3 CSP blocks it). */
function checkHtml({ entries }) {
  const problems = [];
  let refCount = 0;
  for (const { rel } of entries.filter((e) => !e.isDir && e.rel.endsWith('.html'))) {
    const html = fs.readFileSync(distPath(rel), 'utf8');
    for (const [, body] of html.matchAll(/<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)) {
      if (body.trim()) problems.push(`${rel}: has an inline <script>, the extension CSP blocks it`);
    }
    // The extension CSP (script-src 'self') also blocks inline event handlers and javascript: URLs.
    for (const [, tag] of html.matchAll(/<([a-z][a-z0-9-]*)\b[^>]*\son[a-z]+\s*=\s*["']/gi)) {
      problems.push(`${rel}: <${tag.toLowerCase()}> has an inline event handler (on...=), the extension CSP blocks it`);
    }
    for (const [, tag] of html.matchAll(/<([a-z][a-z0-9-]*)\b[^>]*\b(?:href|src|action|formaction)\s*=\s*["']?\s*javascript:/gi)) {
      problems.push(`${rel}: <${tag.toLowerCase()}> uses a javascript: URL, the extension CSP blocks it`);
    }
    for (const [, tag, attrs] of html.matchAll(/<(script|link|img|source|iframe|audio|video|track|embed)\b([^>]*)>/gi)) {
      const m = attrs.match(/\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i);
      const ref = m && (m[1] ?? m[2] ?? m[3]);
      const local = ref && ref.split('#')[0].split('?')[0];
      if (!local || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(local)) continue; // none, or an absolute URL such as the Google Fonts links
      refCount++;
      const target = local.startsWith('/') ? path.join(DIST, local) : path.resolve(DIST, path.dirname(rel), local);
      if (!fs.existsSync(target)) problems.push(`${rel}: <${tag.toLowerCase()}> points to "${ref}", which is not in ${OUT_DIR}/`);
    }
  }
  return { detail: `${refCount} local refs`, problems };
}

function verifyDist() {
  if (!fs.existsSync(distPath('manifest.json'))) {
    return { results: [], failures: [`${OUT_DIR}/manifest.json is missing`] };
  }
  const manifest = JSON.parse(fs.readFileSync(distPath('manifest.json'), 'utf8'));
  const context = { manifest, entries: walk() };
  const checks = [
    ['manifest paths exist', checkManifestPaths],
    ['worker is one ES module', checkWorker],
    ['content scripts are classic', checkContentScripts],
    ['executeScript func is self-contained', checkExecuteScriptFuncs],
    ['no name starts with "_"', checkNames],
    ['html references resolve', checkHtml]
  ];
  const results = [];
  const failures = [];
  for (const [name, check] of checks) {
    const { detail, problems } = check(context);
    results.push({ name, detail });
    failures.push(...problems);
  }
  return { results, failures };
}

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

function printFiles() {
  const files = walk().filter((e) => !e.isDir).map((e) => ({ rel: e.rel, size: fs.statSync(distPath(e.rel)).size }));
  const shipped = files.filter((f) => !f.rel.endsWith('.map'));
  const maps = files.filter((f) => f.rel.endsWith('.map'));
  console.log(`\n${OUT_DIR}/ (${shipped.length} files + ${maps.length} sourcemaps)`);
  const width = Math.max(...shipped.map((f) => f.rel.length));
  for (const f of shipped) console.log(`  ${f.rel.padEnd(width)}  ${kb(f.size).padStart(9)}`);
  console.log(`  ${'sourcemaps (not zipped)'.padEnd(width)}  ${kb(maps.reduce((sum, f) => sum + f.size, 0)).padStart(9)}`);
}

async function main() {
  const verifyOnly = process.argv.includes('--verify-only');

  if (!verifyOnly) {
    console.log(`ScoutFox build, vite ${viteVersion}`);
    for (const pass of passes()) {
      await build(pass.config); // throws on any error, which exits 1 below
      console.log(`  built ${pass.kind.padEnd(9)} ${pass.entry}`);
    }
  }

  const { results, failures } = verifyDist();
  if (failures.length) {
    console.error(`\n${OUT_DIR}/ self-check FAILED:`);
    for (const line of failures) console.error(`  - ${line}`);
    process.exitCode = 1;
    return;
  }

  printFiles();
  console.log('\nself-check');
  for (const r of results) console.log(`  ok  ${r.name} (${r.detail})`);
  // performance.now() counts from the start of the process, so this includes loading Vite.
  console.log(`\n${verifyOnly ? 'checked' : 'built'} in ${(performance.now() / 1000).toFixed(2)} s`);
}

main().catch((err) => {
  console.error(`\nbuild FAILED: ${err && err.stack ? err.stack : err}`);
  process.exitCode = 1;
});
