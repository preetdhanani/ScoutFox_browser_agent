/**
 * The bundler warnings gate of vite.config.mjs and scripts/build.mjs: a warning that is not on the list fails the build.
 *
 * The list is exact pairs of a Node built-in and the file that imports it (the 7 that @anthropic-ai/sdk's credential code
 * causes), and the gate records warnings instead of throwing from the bundler's hook, because a throw is swallowed for a
 * warning of a plugin. These tests feed the recorder the messages Vite writes. `npm run build` runs the real thing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedWarning, passes, ROOT, warningRecorder } from '../vite.config.mjs';

const PLUGIN = 'rolldown:vite-resolve';
const SEE = 'See https://vite.dev/guide/troubleshooting.html#module-externalized-for-browser-compatibility for more details.';
/** The warning Vite's resolver writes, with the importer as an absolute path (what it does). */
const external = (module, importer, plugin = PLUGIN) => ({ plugin, message: `Module "${module}" has been externalized for browser compatibility, imported by "${ROOT}${importer}". ${SEE}` });

const SDK = 'node_modules/@anthropic-ai/sdk';
const KNOWN = [
  ['node:fs', 'lib/credentials/credential-chain.mjs'],
  ['node:fs', 'lib/credentials/identity-token.mjs'],
  ['node:fs', 'lib/credentials/types.mjs'],
  ['node:fs', 'lib/credentials/user-oauth.mjs'],
  ['node:fs', 'core/credentials.mjs'],
  ['node:path', 'lib/credentials/types.mjs'],
  ['node:path', 'core/credentials.mjs']
];

test('allows exactly the seven pairs that the Anthropic SDK credential code causes', () => {
  for (const [module, file] of KNOWN) assert.equal(isAllowedWarning(external(module, `${SDK}/${file}`)), true, `${module} in ${file}`);
});

test('does not allow another built-in, another file, or another place for the same one', () => {
  const others = [
    external('node:os', `${SDK}/lib/credentials/types.mjs`),
    external('node:child_process', `${SDK}/core/credentials.mjs`),
    external('node:path', `${SDK}/lib/credentials/credential-chain.mjs`), // a real file, but not this pair
    external('node:fs', `${SDK}/lib/credentials/new-file.mjs`),
    external('node:fs', `${SDK}/client.mjs`),
    external('node:fs', 'src/background/llm/factory.ts'),
    external('node:fs', 'background/background.js'),
    external('node:fs', 'node_modules/openai/index.mjs'),
    external('node:fs', `node_modules/some-lib/node_modules/@anthropic-ai/sdk/lib/credentials/types.mjs`),
    external('fs', `${SDK}/lib/credentials/types.mjs`),
    external('node:fs', `${SDK}/lib/credentials/types.mjs`, 'vite:something-else'),
    { plugin: PLUGIN, message: `Module "node:fs" has been externalized for browser compatibility, imported by "/elsewhere/${SDK}/lib/credentials/types.mjs". ${SEE}` }
  ];
  for (const log of others) assert.equal(isAllowedWarning(log), false, log.message);
});

test('does not allow a warning that is not about a built-in, whatever its code', () => {
  assert.equal(isAllowedWarning({ code: 'EMPTY_IMPORT_META', message: '`import.meta` may not be a valid syntax with the `iife` output format.' }), false);
  assert.equal(isAllowedWarning({ plugin: PLUGIN, message: 'Could not resolve something' }), false);
  assert.equal(isAllowedWarning({ message: undefined }), false);
});

test('the recorder keeps allowed and unexpected warnings apart, and leaves other logs to the default handler', () => {
  const recorder = warningRecorder();
  const handled = [];
  const defaultHandler = (level, log) => handled.push([level, log.message]);
  recorder.onLog('warn', external('node:fs', `${SDK}/core/credentials.mjs`), defaultHandler);
  recorder.onLog('warn', { code: 'EMPTY_IMPORT_META', plugin: 'rolldown', message: 'import.meta is empty here' }, defaultHandler);
  recorder.onLog('warn', external('node:os', 'src/x.ts'), defaultHandler);
  recorder.onLog('info', { message: 'just info' }, defaultHandler);
  recorder.onLog('debug', { message: 'just debug' }, defaultHandler);
  recorder.viteWarning('some chunks are larger than 500 kB\nafter minification');
  assert.equal(recorder.allowed.length, 1);
  assert.deepEqual(recorder.unexpected.length, 3);
  assert.match(recorder.unexpected[0], /^\[rolldown\] EMPTY_IMPORT_META: import\.meta is empty here$/);
  assert.match(recorder.unexpected[1], /^\[rolldown:vite-resolve\] Module "node:os"/);
  assert.equal(recorder.unexpected[2], '[vite] some chunks are larger than 500 kB');
  assert.deepEqual(handled, [['info', 'just info'], ['debug', 'just debug']]);
});

test('onLog never throws for a warning: it records, and build.mjs fails after the pass', () => {
  const recorder = warningRecorder();
  assert.doesNotThrow(() => recorder.onLog('warn', { code: 'ANYTHING', message: 'x' }, () => { throw new Error('the default handler must not run for a warning'); }));
  assert.equal(recorder.unexpected.length, 1);
});

test('every pass has its own recorder, and its config uses that recorder', () => {
  const all = passes();
  assert.ok(all.length >= 3);
  assert.equal(new Set(all.map((pass) => pass.warnings)).size, all.length);
  for (const pass of all) assert.equal(pass.config.build.rolldownOptions.onLog, pass.warnings.onLog, `${pass.kind} ${pass.entry}`);
});
