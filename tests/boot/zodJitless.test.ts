/**
 * src/background/boot/zodJitless.ts keeps zod from building functions with `new Function`.
 *
 * The extension CSP (`script-src 'self'`) forbids that, and Chromium reports even a caught `new Function('')` as a
 * CSP violation (see scripts/evalscan.mjs and the zod-not-jitless control of tests/e2e). zod reads
 * `globalThis.__zod_globalConfig` once, when its core module runs, so the flag only works when it is set before zod.
 *
 * These tests run zod in a fresh Node process with a spy on the Function constructor, because a module that zod
 * already loaded cannot be un-loaded inside this process. The built worker is checked by scripts/build.mjs
 * ("zod is jitless before any library code", tested in tests/buildSelfCheck.test.js) and by the smoke run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BOOT = pathToFileURL(`${ROOT}src/background/boot/zodJitless.ts`).href;
const LLM = pathToFileURL(`${ROOT}src/background/llm/index.ts`).href;
const ZOD = pathToFileURL(`${ROOT}node_modules/zod/v4/index.js`).href;

/**
 * Runs `before` (imports, in this order), then parses with an object schema twice, and returns the arguments of
 * every construction of a Function that happened in that process. The spy is installed before anything else.
 */
function functionConstructions(before: string[]): string[] {
  const script = `
    const calls = [];
    globalThis.Function = new Proxy(Function, {
      construct(target, argv, newTarget) { calls.push(argv.join('|').slice(0, 60)); return Reflect.construct(target, argv, newTarget); },
      apply(target, self, argv) { calls.push('call ' + argv.join('|').slice(0, 60)); return Reflect.apply(target, self, argv); }
    });
    for (const url of ${JSON.stringify(before)}) await import(url);
    const { z } = await import(${JSON.stringify(ZOD)});
    const schema = z.object({ a: z.string(), b: z.number() });
    schema.parse({ a: 'x', b: 1 });
    schema.parse({ a: 'y', b: 2 });
    console.log(JSON.stringify(calls));
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', cwd: ROOT });
  assert.equal(run.status, 0, `the child process failed: ${run.stderr}`);
  return JSON.parse(run.stdout.trim().split('\n').pop() as string) as string[];
}

test('control: without the boot module zod probes new Function and compiles its object parser', () => {
  const calls = functionConstructions([]);
  assert.ok(calls.includes(''), `the probe new Function('') did not show: ${JSON.stringify(calls)}`);
  assert.ok(calls.length >= 2, `the compiled object parser did not show: ${JSON.stringify(calls)}`);
});

test('with the boot module first, zod builds no function at all', () => {
  assert.deepEqual(functionConstructions([BOOT]), []);
});

test('with the boot module first, loading the whole LLM layer and then zod builds no function either', () => {
  assert.deepEqual(functionConstructions([BOOT, LLM]), []);
});

test('the boot module only sets the flag, and imports nothing', () => {
  const source = fs.readFileSync(`${ROOT}src/background/boot/zodJitless.ts`, 'utf8');
  assert.doesNotMatch(source, /^\s*(?:import|export)\b/m, 'an import here could load zod before the flag is set');
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(BOOT)}); console.log(JSON.stringify(globalThis.__zod_globalConfig));`], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { jitless: true });
});

test('the worker entry and the side panel entry import it first', () => {
  for (const entry of ['background/background.js', 'sidepanel/sidepanel.js']) {
    const imports = fs.readFileSync(`${ROOT}${entry}`, 'utf8').split('\n').filter((line) => /^import\b/.test(line));
    assert.equal(imports[0], "import '../src/background/boot/zodJitless.ts';", `${entry}: the first import is not the zod boot module`);
  }
});
