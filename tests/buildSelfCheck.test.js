/**
 * The zod check of scripts/build.mjs, on strings shaped like what rolldown writes (unminified, one //#region comment
 * per module, in the order the modules run). The check decides whether the worker sets zod's jitless flag before any
 * library code, so a check that stops seeing a broken order would ship a worker that breaks the extension CSP. The
 * real dist/ is checked by `npm run build` itself and by the smoke run's zod-not-jitless control.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSync } from 'vite';
import { zodJitlessProblems } from '../scripts/build.mjs';

const RUNTIME = '//#region \\0rolldown/runtime.js\nvar __create = Object.create;\n//#endregion';
const BOOT = '//#region src/background/boot/zodJitless.ts\n/** doc */\nglobalThis.__zod_globalConfig = { jitless: true };\n//#endregion';
const LOGGER = '//#region src/shared/logger.ts\nconst Logger = {};\n//#endregion';
const ZOD = '//#region node_modules/zod/v4/core/core.js\nvar globalConfig = globalThis.__zod_globalConfig;\n//#endregion';
const APP = '//#region background/background.js\nself.addEventListener("error", () => {});\n//#endregion';

/** The problems of one built script, the way build.mjs asks for them. */
function problemsOf(code, staticImports = 0) {
  const { program, errors } = parseSync('sw.js', code, { lang: 'js', sourceType: 'module' });
  assert.deepEqual(errors, [], 'the test code must parse');
  return zodJitlessProblems('sw.js', code, program, staticImports);
}

test('passes when the flag comes right after rolldown helpers, before any library and before our own code', () => {
  assert.deepEqual(problemsOf([RUNTIME, BOOT, LOGGER, ZOD, APP].join('\n')), []);
  assert.deepEqual(problemsOf([BOOT, ZOD].join('\n')), []);
});

test('other keys next to jitless are fine', () => {
  assert.deepEqual(problemsOf(BOOT.replace('{ jitless: true }', '{ jitless: true, other: 1 }') + '\n' + ZOD), []);
});

test('fails when zod runs before the flag is set', () => {
  const problems = problemsOf([RUNTIME, ZOD, BOOT].join('\n'));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /node_modules\/zod\/v4\/core\/core\.js.*runs before zodJitless/);
});

test('fails when any other module runs before the flag, ours included', () => {
  const problems = problemsOf([RUNTIME, LOGGER, BOOT, ZOD].join('\n'));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /src\/shared\/logger\.ts.*runs before zodJitless/);
});

test('names every module that runs first', () => {
  assert.equal(problemsOf([RUNTIME, LOGGER, ZOD, BOOT].join('\n')).length, 2);
});

test('fails when the statement is missing', () => {
  assert.match(problemsOf([RUNTIME, ZOD].join('\n'))[0], /no top-level "globalThis\.__zod_globalConfig = \{ jitless: true \}"/);
});

test('fails when the statement is not at the top level of the file', () => {
  const inFunction = BOOT.replace('globalThis.__zod_globalConfig = { jitless: true };', 'function boot() { globalThis.__zod_globalConfig = { jitless: true }; }');
  assert.match(problemsOf([inFunction, ZOD].join('\n'))[0], /no top-level/);
  const inBlock = BOOT.replace('globalThis.__zod_globalConfig = { jitless: true };', 'if (Math.random() > 2) { globalThis.__zod_globalConfig = { jitless: true }; }');
  assert.match(problemsOf([inBlock, ZOD].join('\n'))[0], /no top-level/);
});

test('fails when the flag is not true, or is set on something else', () => {
  for (const wrong of [
    'globalThis.__zod_globalConfig = { jitless: false };',
    'globalThis.__zod_globalConfig = { jitless: 1 };',
    'globalThis.__zod_globalConfig = {};',
    'self.__zod_globalConfig = { jitless: true };',
    'globalThis.__zod_config = { jitless: true };',
    'globalThis.__zod_globalConfig ||= { jitless: true };',
    'globalThis["__zod_globalConfig"] = { jitless: true };',
    '// globalThis.__zod_globalConfig = { jitless: true };'
  ]) {
    const code = [RUNTIME, BOOT.replace('globalThis.__zod_globalConfig = { jitless: true };', wrong), ZOD].join('\n');
    assert.match(problemsOf(code)[0], /no top-level/, wrong);
  }
});

test('refuses a bundle without //#region comments (minified) instead of passing it', () => {
  const minified = 'globalThis.__zod_globalConfig = { jitless: true };var a = globalThis.__zod_globalConfig;';
  assert.match(problemsOf(minified)[0], /no \/\/#region comments.*minify/);
});

test('fails when the file has an import statement, because that file would run first', () => {
  const problems = problemsOf([RUNTIME, BOOT, ZOD].join('\n'), 1);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /1 import statement.*could load zod first/);
});

test('a region that only sits in a string or a comment is not a module', () => {
  // The region is found by a comment at the start of a line, and a string cannot start a line inside a statement.
  const code = [RUNTIME, BOOT, ZOD.replace('var globalConfig', 'var note = "//#region node_modules/other/index.js"; var globalConfig')].join('\n');
  assert.deepEqual(problemsOf(code), []);
});

test('importing build.mjs does not start a build', () => {
  // Importing the module at the top of this file would already have run a build (and printed it) if main() ran on import.
  assert.equal(typeof zodJitlessProblems, 'function');
});
