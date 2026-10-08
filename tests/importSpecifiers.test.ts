/**
 * Every relative import must name the file exactly as it is on disk, extension included.
 *
 * Node runs the TypeScript files by stripping their types (no compiler, no resolver), so an import
 * has to be `./sanitize.ts`: `./sanitize` and `./sanitize.js` both fail with ERR_MODULE_NOT_FOUND.
 * tsc does not catch this (moduleResolution "bundler" accepts both spellings) and neither does Vite,
 * which bundles them. So a file that no Node test imports could stay broken without anyone noticing,
 * until the day something does. This test reads every relative specifier and checks that the file
 * is there, as written.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** The folders with code that Node or Vite loads. node_modules and the build output are skipped. */
const FOLDERS = ['src', 'background', 'sidepanel', 'content', 'scripts', 'shared', 'tests'];

// `import x from '...'`, `import {\n a,\n b\n} from '...'`, `import '...'`, `export * from '...'`,
// `export { a } from '...'` (at the start of a line, so a comment or a string does not count) ...
const STATIC_IMPORT = /^\s*(?:import|export)\b(?:[^'"`;]*?\bfrom\s*|\s*)['"]([^'"\n]+)['"]/gm;
// ... and `import('...')`.
const DYNAMIC_IMPORT = /\bimport\(\s*['"]([^'"\n]+)['"]/g;

/** The text without block comments and whole-line comments (an example in a doc comment is not an import). */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

interface Problem {
  file: string;
  specifier: string;
}

/** Relative specifiers of `text` (a file at `file`) that do not name a file that exists, exactly as written. */
function findProblems(file: string, text: string, isFile: (path: string) => boolean): { checked: number; problems: Problem[] } {
  const code = withoutComments(text);
  const problems: Problem[] = [];
  let checked = 0;
  for (const pattern of [STATIC_IMPORT, DYNAMIC_IMPORT]) {
    for (const match of code.matchAll(pattern)) {
      const specifier = match[1];
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) continue; // a package or a node: module
      checked++;
      // Some tests load a module several times with a query (`logger.js?case=1`), which is not part of the file name.
      const withoutQuery = specifier.replace(/[?#].*$/, '');
      if (!isFile(resolve(dirname(file), withoutQuery))) problems.push({ file, specifier });
    }
  }
  return { checked, problems };
}

function sourceFiles(folder: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const path = join(folder, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(path));
    else if (/\.(ts|js|mjs)$/.test(entry.name)) found.push(path);
  }
  return found;
}

const isRealFile = (path: string): boolean => existsSync(path) && statSync(path).isFile();

test('every relative import names an existing file exactly as written (Node cannot guess an extension)', () => {
  // This file holds wrong imports as sample text, so it is not scanned itself.
  const files = FOLDERS.flatMap((folder) => sourceFiles(join(ROOT, folder))).filter((file) => file !== fileURLToPath(import.meta.url));
  let checked = 0;
  const problems: string[] = [];
  for (const file of files) {
    const result = findProblems(file, readFileSync(file, 'utf8'), isRealFile);
    checked += result.checked;
    for (const problem of result.problems) problems.push(`${relative(ROOT, problem.file)} imports '${problem.specifier}', which is not a file (write the file name with its extension, for example './name.ts')`);
  }
  assert.deepEqual(problems, []);
  // The scan really did look at the code: this is not a pass because nothing was read.
  assert.ok(files.length >= 100, `only ${files.length} files were scanned`);
  assert.ok(checked >= 150, `only ${checked} relative imports were checked`);
  assert.ok(files.some((file) => relative(ROOT, file) === join('src', 'background', 'agent', 'parse.ts')));
  assert.ok(files.some((file) => relative(ROOT, file) === join('background', 'agentEngine.js')));
});

test('the scan sees each way the mistake is made, and only that', () => {
  const on = new Set([resolve('/p/src/sanitize.ts'), resolve('/p/src/data.json'), resolve('/p/src/logger.js')]);
  const isFile = (path: string) => on.has(path);
  const scan = (text: string) => findProblems('/p/src/file.ts', text, isFile);
  const bad = (text: string) => scan(text).problems.map((problem) => problem.specifier);

  // The two spellings of the reviewer's example: no extension, and .js for a file that is .ts.
  assert.deepEqual(bad("import { a } from './sanitize';"), ['./sanitize']);
  assert.deepEqual(bad("import { a } from './sanitize.js';"), ['./sanitize.js']);
  assert.deepEqual(bad("import type { A } from './sanitize';"), ['./sanitize']);
  assert.deepEqual(bad("export * from './sanitize';"), ['./sanitize']);
  assert.deepEqual(bad("export { a, b } from './sanitize';"), ['./sanitize']);
  assert.deepEqual(bad("import './sanitize';"), ['./sanitize']);
  assert.deepEqual(bad("const m = await import('./sanitize');"), ['./sanitize']);
  assert.deepEqual(bad("import {\n  a,\n  b\n} from './sanitize';"), ['./sanitize']);
  assert.deepEqual(bad("import data from './missing.json' with { type: 'json' };"), ['./missing.json']);
  assert.deepEqual(bad("import x from '../nowhere/x.ts';"), ['../nowhere/x.ts']);

  // Correct imports, and things that are not relative imports of a file.
  assert.deepEqual(bad("import { a } from './sanitize.ts';"), []);
  assert.deepEqual(bad("import data from './data.json' with { type: 'json' };"), []);
  assert.deepEqual(bad("import { Logger } from './logger.js?case=1';"), [], 'a query is not part of the file name');
  assert.deepEqual(bad("import test from 'node:test';\nimport { x } from '@langchain/core';\nimport y from 'zod';"), []);
  assert.deepEqual(bad("// import { a } from './sanitize';\n/* import { b } from './sanitize'; */\n * import c from './sanitize';"), [], 'comments');
  assert.deepEqual(bad("const text = \"import a from './sanitize'\";"), [], 'a string that is not at the start of a line');
  assert.deepEqual(bad("/**\n *   await import('./sanitize');\n */"), [], 'an example in a doc comment');
  assert.equal(scan("import a from './sanitize.ts';\nimport b from './nope.ts';\nimport('./sanitize.ts');").checked, 3);
});
