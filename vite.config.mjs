/**
 * Vite configs for the extension build (P0: today's plain JS, unchanged).
 *
 * scripts/build.mjs runs these one after the other through Vite's JS API, all into dist/.
 * They are separate passes because rolldown refuses `codeSplitting: false` with more than one
 * input, and because each kind of file has its own output rules:
 *
 *   worker     one ES module with a fixed name (background/sw.js) and no chunks: an MV3 worker
 *              cannot use dynamic import, and the manifest needs a stable path
 *   side panel an HTML page with normal code splitting (its js and css land in assets/)
 *   content    one classic-script IIFE per entry, written to the same path as its source: the
 *              manifest and the auto-inject fallback list them by path, and the first three
 *              share window.domCompressor / window.actionExecutor inside one isolated world
 *
 * public/ (manifest.json, icons/) is copied by the first pass, which also empties dist/.
 *
 * This is a .mjs file and not the .ts of the design. build.mjs has to import it from plain node,
 * and importing .ts there depends on Node's type stripping (default only from 22.18 and 24.3,
 * experimental at first). Nothing in a config needs TypeScript. build.mjs passes
 * `configFile: false`, so Vite never loads this file by itself. The default export at the end
 * only exists to turn a plain `vite build` into a clear error.
 *
 * Minify is OFF, but the output is still not a copy of the source: Vite turns `minify: false` into
 * rolldown's dead-code removal, and tree-shaking rewrites code in ways that keep its behaviour
 * (one-use constants are inlined, braces around one statement go away, `undefined` becomes
 * `void 0`, top-level const/let/class become `var`, and constants such as LLM_MAX_ATTEMPTS become
 * their value). So never grep dist/ for source names. An independent review replaced every source
 * module with its built output and all tests still passed.
 *
 * Functions handed to chrome.scripting.executeScript({ func }) are serialized as
 * text and must stay self-contained, and unminified output keeps dist/ readable and the
 * sourcemap lines exact for evalscan. scripts/build.mjs checks every such function in the built
 * worker ("executeScript func is self-contained") and fails the build when one uses a name that it
 * does not declare itself. Minify renames and inlines, so before turning it on, read that check
 * and make sure it still proves what it says on the minified output.
 */
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('.', import.meta.url));
export const OUT_DIR = 'dist';

export const WORKER_ENTRY = 'background/background.js';
export const WORKER_OUTPUT = 'background/sw.js';
export const SIDE_PANEL_ENTRY = 'sidepanel/sidepanel.html';
// Source path in, dist path out. They are the same today; they will differ once the sources move.
// Order does not matter for the build. The manifest decides the injection order.
export const CONTENT_ENTRIES = [
  { input: 'content/domCompressor.js', output: 'content/domCompressor.js' },
  { input: 'content/actionExecutor.js', output: 'content/actionExecutor.js' },
  { input: 'content/content.js', output: 'content/content.js' },
  { input: 'content/net-recorder.js', output: 'content/net-recorder.js' }
];

/**
 * Chrome refuses to load an extension that has a file or folder whose name starts with "_" (the
 * names are reserved). Rolldown builds chunk and asset names from module names, so a module
 * `_helper.js` or a virtual module such as "\0commonjsHelpers" comes out as `_helper-HASH.js`.
 * This is rolldown's default cleanup (invalid characters become "_") plus dropping leading "_".
 */
const INVALID_NAME_CHARS = /[\u0000-\u001F"#$&*+,:;<=>?[\]^`{|}\u007F]/g;
export function sanitizeFileName(name) {
  return name.replace(INVALID_NAME_CHARS, '_').replace(/^_+/, '') || 'chunk';
}

/**
 * A warning from the bundler means the output may not do what the source says. Example: rolldown
 * replaces `import.meta` in an IIFE with `{}` and only warns, so without this the build would exit
 * 0 and ship a changed script (the self-check for import.meta cannot see it, the bundler removed
 * it first). So every warning fails the build, unless its code is listed here together with a reason.
 * Rolldown calls this for info and debug logs too: those go to the default handler untouched.
 */
const ALLOWED_WARNING_CODES = [];
export function failOnWarning(level, log, defaultHandler) {
  if (level !== 'warn' || ALLOWED_WARNING_CODES.includes(log.code)) return defaultHandler(level, log);
  throw new Error(`a bundler warning fails the build: ${log.message}`);
}

/** Options every pass shares. `publicDir` and `emptyOutDir` are switched on by the first pass only. */
function base(output = {}) {
  return {
    root: ROOT,
    configFile: false,
    envDir: false,
    clearScreen: false,
    // build.mjs prints its own summary. Warnings and errors still come through.
    logLevel: 'warn',
    publicDir: false,
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    build: {
      outDir: OUT_DIR,
      emptyOutDir: false,
      target: 'chrome120',
      minify: false,
      // 'hidden' writes the .map files but leaves the `//# sourceMappingURL` line out of the JS. The zip has
      // no maps, so with that line DevTools on any page would try to fetch a map that is not there.
      // The maps are only read by scripts/evalscan.mjs, which falls back to `<file>.map`.
      sourcemap: 'hidden',
      modulePreload: false,
      chunkSizeWarningLimit: 2500,
      reportCompressedSize: false,
      // `cwd` keeps the //#region comments and the sourcemap paths the same wherever the build is
      // started from. Without it they are relative to the process's working directory.
      rolldownOptions: { cwd: ROOT, onLog: failOnWarning, output: { sanitizeFileName, ...output } }
    }
  };
}

/** Pass 1: the service worker as ONE ES module, plus public/ (manifest, icons) and an empty dist. */
export function workerConfig() {
  const config = base({ format: 'es', codeSplitting: false, entryFileNames: WORKER_OUTPUT });
  config.publicDir = 'public';
  config.build.emptyOutDir = true;
  config.build.rolldownOptions.input = WORKER_ENTRY;
  return config;
}

/** Pass 2: the side panel page and its assets. */
export function sidePanelConfig() {
  const config = base();
  config.build.rolldownOptions.input = SIDE_PANEL_ENTRY;
  return config;
}

/** Passes 3 and up: one classic-script IIFE per content entry, written to the same path as the source. */
export function contentConfig({ input, output }) {
  const config = base({ format: 'iife', codeSplitting: false, entryFileNames: output });
  config.build.rolldownOptions.input = input;
  return config;
}

/** All passes in build order. */
export function passes() {
  return [
    { kind: 'worker', entry: WORKER_ENTRY, config: workerConfig() },
    { kind: 'sidepanel', entry: SIDE_PANEL_ENTRY, config: sidePanelConfig() },
    ...CONTENT_ENTRIES.map((entry) => ({ kind: 'content', entry: entry.input, config: contentConfig(entry) }))
  ];
}

// A plain `vite build` would run one pass and leave a dist/ that Chrome cannot load.
export default function useNpmRunBuild() {
  throw new Error('Do not run vite directly. Use "npm run build": the build is several Vite passes, see scripts/build.mjs.');
}
