/**
 * The two TypeScript projects and what each one may use.
 *
 * tsconfig.json is the extension itself (src/): it runs in the MV3 service worker, so it has the
 * WebWorker lib and the chrome types, and Node globals or `document` must NOT compile there. Code
 * that uses Buffer, process, NodeJS.Timeout or document passes a typecheck that allows them and then
 * fails at run time in the worker. tests/tsconfig.json extends it and adds the node types, because
 * the tests run in Node.
 *
 * These tests run the real tsc on small scratch projects that extend the two configs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TSC = join(ROOT, 'node_modules', '.bin', 'tsc');

/** What a Node script or a page uses and a service worker does not have. */
const NODE_AND_DOM = [
  'export const bytes = Buffer.from(new Uint8Array(3)).toString("base64");',
  'export const debug = process.env.DEBUG;',
  'export const timer: NodeJS.Timeout = setTimeout(() => {}, 1);',
  'export const title = document.title;',
  ''
].join('\n');

/** What the service worker really has. */
const WORKER_GLOBALS = [
  'const controller = new AbortController();',
  'export const timer: number = setTimeout(() => controller.abort(), 1);',
  'export const copy = structuredClone({ a: 1 });',
  'export const started = performance.now();',
  'export const page = fetch("https://example.com", { signal: controller.signal });',
  'export const read = chrome.storage.session.get("k");',
  'export const encoded = new TextEncoder().encode("x");',
  'export const listener = () => self.addEventListener("message", () => {});',
  ''
].join('\n');

/** Runs tsc --noEmit on one file that sits in a scratch project extending `config`. */
function typecheck(config: string, source: string): { ok: boolean; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tsconfig-scope-'));
  try {
    writeFileSync(join(dir, 'file.ts'), source);
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        extends: join(ROOT, config),
        // The scratch project is outside the repo, so it has to be told where the type packages are.
        compilerOptions: { typeRoots: [join(ROOT, 'node_modules', '@types')] },
        include: ['file.ts'],
        exclude: []
      })
    );
    try {
      execFileSync(TSC, ['--noEmit', '-p', join(dir, 'tsconfig.json')], { encoding: 'utf8', stdio: 'pipe' });
      return { ok: true, output: '' };
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string };
      return { ok: false, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('src/ (tsconfig.json) rejects Buffer, process, NodeJS.* and document, which the service worker does not have', () => {
  const result = typecheck('tsconfig.json', NODE_AND_DOM);
  assert.equal(result.ok, false, 'Node globals and document must not typecheck in src/');
  assert.match(result.output, /Cannot find name 'Buffer'/);
  assert.match(result.output, /Cannot find name 'process'/);
  assert.match(result.output, /Cannot find namespace 'NodeJS'/);
  assert.match(result.output, /Cannot find name 'document'/);
});

test('src/ (tsconfig.json) still has everything the service worker has', () => {
  const result = typecheck('tsconfig.json', WORKER_GLOBALS);
  assert.equal(result.output, '');
  assert.equal(result.ok, true);
});

test('tests/ (tests/tsconfig.json) has the Node globals and node: modules on top of the same rules', () => {
  const node = [
    'import test from "node:test";',
    'import { readFileSync } from "node:fs";',
    'export const bytes = Buffer.from("x").toString("base64");',
    'export const debug = process.env.DEBUG;',
    'export const timer: NodeJS.Timeout = setTimeout(() => {}, 1);',
    'export const now = setImmediate(() => {});',
    'export { test, readFileSync };',
    ''
  ].join('\n');
  const result = typecheck('tests/tsconfig.json', node);
  assert.equal(result.output, '');
  assert.equal(result.ok, true);
  // Tests may use Node, but they are still not a page: document does not exist in either project.
  assert.equal(typecheck('tests/tsconfig.json', 'export const title = document.title;\n').ok, false);
});

test('npm run typecheck runs both projects', () => {
  const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts as Record<string, string>;
  const commands = scripts.typecheck.split('&&').map((part) => part.trim());
  assert.ok(commands.some((c) => /^tsc --noEmit$/.test(c) || /^tsc --noEmit -p (\.\/)?tsconfig\.json$/.test(c)), `no run of tsconfig.json in: ${scripts.typecheck}`);
  assert.ok(commands.some((c) => /^tsc --noEmit -p (\.\/)?tests(\/tsconfig\.json)?$/.test(c)), `no run of tests/tsconfig.json in: ${scripts.typecheck}`);
});
