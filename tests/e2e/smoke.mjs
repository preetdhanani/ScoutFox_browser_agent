/**
 * ScoutFox end-to-end smoke run, on the BUILT extension (dist/).
 *
 * It copies dist/ into a temp folder, adds tests/e2e/driver.html to the copy as driver.html (the
 * only extra file, so the loaded files are exactly what the shipped zip has), and loads that copy
 * as an unpacked extension into Chromium. It serves the local fixture site (tests/fixtures/site),
 * points the extension at a model server, and starts each task through the extension's own
 * message path: the same START_TASK message the side panel sends. When a run ends it prints the
 * outcome, the steps, the wall time, and the model calls and tokens.
 *
 * The model server is one of these:
 *   default  LISA (lisa-pro, an OpenAI-compatible custom endpoint; `npm run test:e2e`). The run adds it
 *            through the side panel's "Custom model API" dialog, like a user, and talks to it through a
 *            small local proxy (lib/keyProxy.mjs) that adds the key from the environment, so the key
 *            never enters the extension or the browser profile.
 *   --provider=nvidia  NVIDIA NIM with nvidia/nemotron-3.5-super-vl-120b-a12b, the built-in provider,
 *            through the same proxy. The profiles live in lib/providers.mjs.
 *   --provider=ollama  a small proxy in front of a real local Ollama (lib/ollamaProxy.mjs, see
 *            there for why a proxy is needed).
 *
 * A task with a followUp (tasks.mjs, web-chat-chain) gets a second turn in the same tab and chat once
 * the first has ended: the harness can compact the chat first through the context ring's card in the
 * real side panel (real clicks, close-ups of the ring, the card and the divider in light and dark),
 * send the tab to another fixture page, and then judges the second turn on its own.
 *
 * A graph run stops at the holds of the engine, and the harness answers them like a user at the side panel would:
 * it approves the plan the engine proposes, approves a confirmation to navigate to a host of the task's fixture site, denies
 * every other confirmation, and answers a question only when the task defines an answer (see answerHolds).
 *
 * The run fails (exit code 1, every problem printed) when a task does not end the way it must, its answer is
 * wrong, the service worker logs an error or hits a CSP violation, the fixture page a task runs on shows a console error
 * or a page error, the page's content scripts are not there (the MAIN-world net recorder did not
 * run, or the isolated-world content script does not answer), or the side panel page loaded on
 * its own shows a console error, a page error or a CSP violation.
 *
 * Setup:  cd tests/e2e && npm ci            (puppeteer-core only)
 *         npm run build                     from the repo root, or pass --build
 * Run:    node smoke.mjs                           the default tasks on LISA: the open-web tasks (a neutral
 *                                                  start page and only a question, the model picks every
 *                                                  site) and the three local fixture-page tasks (needs the key)
 *         node smoke.mjs --build                   build first, then the same (npm run test:e2e)
 *         node smoke.mjs --held-out                the held-out open-web tasks (never tuned against; run them
 *                                                  after every change, to show it helps in general)
 *         node smoke.mjs --sealed                  the sealed open-web tasks: only verdicts and numbers, no trace
 *         node smoke.mjs --repeat=3                every task 3 times, summarised as median and p90 per task
 *         node smoke.mjs --provider=nvidia         the open-web tasks on NVIDIA NIM
 *         node smoke.mjs --provider=ollama         all tasks with qwen3.8:27b-mlx on the real Ollama
 *         node smoke.mjs --task=web-eiffel-tower   one task (or a comma list)
 *         node smoke.mjs --model=gemma4:12b
 *         node smoke.mjs --headful                 watch it in a real window
 *         node smoke.mjs --out=report.json         also save the full report as JSON
 *         node smoke.mjs --panel-screenshots=dir   save the side panel (light and dark) per task
 *         node smoke.mjs --max-steps=30            the engine's step cap for a task
 *         node smoke.mjs --timeout=360000          per task, in milliseconds
 *         node smoke.mjs --dump-snapshots          save what the content script sees on each
 *                                                  fixture page to tests/fixtures/snapshots/
 *                                                  (the unit tests read these files; no model needed)
 *         node smoke.mjs --dump-snapshots=store    only the pages named here
 *         node smoke.mjs --prompt="..."            one run of your own on a real site (--start-url=)
 *         node smoke.mjs --help                    the options
 *   --build   runs `npm run build` first (a child process this script owns), so dist/ is fresh.
 *   --effort=<level>  the effort every task starts with (auto, off, low, medium, high, max;
 *             default medium): the model's reasoning level, checked on the wire for every call.
 *
 * Needs Chromium (branded Chrome ignores --load-extension) at CHROMIUM_PATH, default
 * /Applications/Chromium.app/Contents/MacOS/Chromium. The LISA mode needs LISA_API_KEY in the shell or LISA_API in the
 * repo .env (and takes LISA_URL, default https://chat-1.ki-awz.iisys.de/api). The NVIDIA mode needs NVIDIA_API_KEY or
 * NVIDIA_API (and takes NVIDIA_URL, default https://integrate.api.nvidia.com/v1). The Ollama mode needs Ollama at
 * OLLAMA_URL, default http://127.0.0.1:11434, with the model already pulled.
 * Other environment variables: FIXTURE_PORT (8765; the committed snapshots contain this port),
 * PROXY_PORT (11435, the model proxy) and CHROMIUM_ARGS (extra Chromium flags,
 * separated by spaces, for example --no-sandbox on a Linux CI runner).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from './lib/fixtureServer.mjs';
import { startOllamaProxy } from './lib/ollamaProxy.mjs';
import { PLACEHOLDER_KEY, startKeyProxy } from './lib/keyProxy.mjs';
import { DEFAULT_PROVIDER, REAL_PROVIDER_NAMES, providerSettings, proxiedBaseUrl, resolveProvider } from './lib/providers.mjs';
import { missingManifestFiles, prepareExtensionCopy } from './lib/extensionCopy.mjs';
import { pageReadSteps, runFacts, TASKS } from '../mcp/tasks.mjs';
import { aggregate, aggregateLines, callsForReport, expectedFinishOutcome, runVerdict } from './lib/metrics.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const DIST = path.join(REPO, 'dist');
const SITE = path.join(REPO, 'tests', 'fixtures', 'site');
const SNAPSHOT_DIR = path.join(REPO, 'tests', 'fixtures', 'snapshots');

const KNOWN_FLAGS = new Set(['task', 'model', 'headful', 'headless', 'out', 'panel-screenshots', 'dump-snapshots', 'max-steps', 'timeout', 'build', 'prompt', 'start-url', 'provider', 'held-out', 'sealed', 'repeat', 'effort', 'help']);
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
}));

/** How often each task runs (--repeat=k). A real model is not deterministic, so its numbers are read as median and p90. */
const REPEAT = args.repeat === undefined ? 1 : Number(args.repeat);
/**
 * --sealed: the sealed open-web tasks (tasks.mjs). They exist to judge the finished work, so nothing may be
 * tuned against them: their steps, answers and model calls are never printed or saved, only the verdict and
 * the numbers. Someone who reads a sealed trace has unsealed the set, and it has to be replaced.
 */
const SEALED = !!args.sealed;
// The repo's own .env (gitignored) may hold the model keys; a variable already set in the shell wins.
if (fs.existsSync(path.join(REPO, '.env'))) {
  try { process.loadEnvFile(path.join(REPO, '.env')); } catch { /* an unreadable .env is the same as none */ }
}
// The real model behind the run: LISA by default, another OpenAI-compatible profile of
// lib/providers.mjs (nvidia), or a local Ollama.
const PROVIDER = String(args.provider || DEFAULT_PROVIDER);
/** The resolved profile of a real OpenAI-compatible server, or null (Ollama). Holds the key: never logged. */
const REAL = REAL_PROVIDER_NAMES.includes(PROVIDER) ? resolveProvider(PROVIDER) : null;
const CHROMIUM = process.env.CHROMIUM_PATH || '/Applications/Chromium.app/Contents/MacOS/Chromium';
const CHROMIUM_ARGS = (process.env.CHROMIUM_ARGS || '').split(/\s+/).filter(Boolean);
// The device pixel ratio every task runs at: the picture and the CSS pixels are different grids, so
// the coordinate mapping of a screenshot is real. CHROMIUM_ARGS can still override it for a one-off run.
const SHOT_DPR = 2;
const OLLAMA = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
const MODEL = args.model || (REAL ? REAL.defaultModel : 'qwen3.8:27b-mlx');
/** The card title the panel draws for each finish outcome (OUTCOME_CARD in sidepanel/sidepanel.js). */
const OUTCOME_TITLE = { done: 'Done', partial: 'Partly done', blocked: 'Could not finish' };
const FIXTURE_PORT = Number(process.env.FIXTURE_PORT || 8765);
const PROXY_PORT = Number(process.env.PROXY_PORT || 11435);
// Per task: --timeout, else the task's own timeoutMs, else this default.
const TASK_TIMEOUT_MS = Number(args.timeout || 6 * 60 * 1000);
// The engine's hard step cap. Open-web research takes many steps (search, open, read, compare), so it gets 60.
const MAX_STEPS = Number(args['max-steps'] || 60);
// The effort every task starts with: the model's reasoning level (llm/effort.ts), sent in the
// provider's own field. --effort=low|high|... compares how hard the model thinks on the same tasks.
const EFFORT_LEVELS = ['auto', 'off', 'low', 'medium', 'high', 'max'];
const EFFORT = args.effort || 'medium';
const POLL_MS = 250;
// How long a run may stand paused with no hold the harness can answer, before it is stopped.
const PAUSE_GRACE_MS = 3000;

// The fixture pages whose snapshot the unit tests read (tests/fakeDom.test.ts), for --dump-snapshots.
const SNAPSHOT_PAGES = ['store'];
// Every run saves its screenshots here (one folder per task): the side panel with the steps and
// the end result, and the end state of the page. Gitignored; --panel-screenshots overrides the root.
const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const SHOT_ROOT = path.join(HERE, 'screenshots', RUN_STAMP);

/** A task's start address: the fixture server plus the page, or a real URL (an open-web task, --prompt) as it stands. */
const absolute = (page, fixtures) => (/^https?:\/\//.test(page) ? page : `${fixtures.origin}/${page}`);

// The side panel links Google Fonts. When the machine is offline those two requests fail, which
// is a network fact and not an extension bug, so that one console line is not counted.
const FONT_HOSTS = /^https:\/\/fonts\.(?:googleapis|gstatic)\.com\//;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtInt = (n) => (n === null || n === undefined ? '-' : Number(n).toLocaleString('en-US'));

function oneLine(value, max = 160) {
  const s = (typeof value === 'string' ? value : JSON.stringify(value)) || '';
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

/** A problem the user can fix: printed as one message, without a stack trace. */
class UserError extends Error {}
if (!EFFORT_LEVELS.includes(EFFORT)) throw new UserError(`--effort must be one of ${EFFORT_LEVELS.join(', ')}`);

// --prompt: one run of your own, on a real site, with a real model. The prompt is all the task gets:
// which page to open, what to search, what to click, and when to stop are the extension's decisions.
// Nothing is scripted and no expected answer is known in advance, so the run is judged on what a
// user would notice: it finished, the answer is not empty, the panel shows the steps, and nothing
// in the page, the worker, or the panel threw an error on the way.
if (args.prompt) {
  const startUrl = args['start-url'] ? String(args['start-url']) : 'https://www.google.com';
  if (!/^https?:\/\//.test(startUrl)) throw new UserError(`--start-url must be a full http(s) URL, got ${startUrl}`);
  TASKS.live = {
    name: 'live',
    page: startUrl, // runTask appends nothing: an absolute page is used as it stands
    prompt: String(args.prompt),
    timeoutMs: 10 * 60 * 1000,
    check: (run) => (run.answer || '').trim().length > 20,
    // The green card, read off the real panel: the word the user sees when a run is over.
    expectCard: { title: 'Done' }
  };
  if (!args.task) args.task = 'live';
}

// ---------------------------------------------------------------------------------------------
// Cleanup: the browser, the servers, the build child and the temp folders go away on success, on
// failure and on Ctrl+C. Nothing is left running.
// ---------------------------------------------------------------------------------------------

const cleanups = [];
const onCleanup = (fn) => { cleanups.push(fn); };
const tempDirs = new Set();
let browserProcess = null;
let cleaning = null;

function cleanup() {
  if (!cleaning) {
    cleaning = (async () => {
      while (cleanups.length) {
        try { await cleanups.pop()(); } catch { /* best effort, the next one still runs */ }
      }
    })();
  }
  return cleaning;
}

function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), prefix));
  tempDirs.add(dir);
  onCleanup(() => { fs.rmSync(dir, { recursive: true, force: true }); tempDirs.delete(dir); });
  return dir;
}

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
  process.on(signal, () => {
    if (cleaning) process.exit(code); // a second signal: stop waiting (the exit handler below still cleans up)
    console.error(`\n${signal}: stopping the run and cleaning up`);
    cleanup().finally(() => process.exit(code));
  });
}

// Last resort, synchronous: whatever the async cleanup did not reach.
process.on('exit', () => {
  if (browserProcess && browserProcess.exitCode === null && browserProcess.signalCode === null) {
    try { browserProcess.kill('SIGKILL'); } catch { /* already gone */ }
  }
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------------------------

async function loadPuppeteer() {
  try {
    return (await import('puppeteer-core')).default;
  } catch (err) {
    if (err && err.code === 'ERR_MODULE_NOT_FOUND') {
      throw new UserError('puppeteer-core is not installed. Run: cd tests/e2e && npm ci');
    }
    throw err;
  }
}

function checkChromium() {
  if (!fs.existsSync(CHROMIUM)) {
    throw new UserError(`Chromium not found at ${CHROMIUM}. Set CHROMIUM_PATH. It must be Chromium or Chrome for Testing: branded Chrome ignores --load-extension.`);
  }
}

function runBuild() {
  console.log('$ npm run build');
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['run', 'build'], { cwd: REPO, stdio: 'inherit' });
    onCleanup(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); });
    child.once('error', (err) => reject(new UserError(`Could not run "npm run build": ${err.message}`)));
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new UserError(`npm run build failed (${signal ? `signal ${signal}` : `exit code ${code}`}).`));
    });
  });
}

function checkDist() {
  if (!fs.existsSync(path.join(DIST, 'manifest.json'))) {
    throw new UserError('dist/manifest.json not found: run npm run build first (or pass --build).');
  }
}

// What the build reads. Update this list when sources move (it only feeds a warning).
// Paths that do not exist are skipped, so the ones a later phase adds (shared) are listed already.
// tsconfig.json is read by Vite's TypeScript transform (target, verbatimModuleSyntax), so it counts too.
const BUILD_INPUTS = ['content', 'sidepanel', 'src', 'shared', 'public', 'vite.config.mjs', 'scripts/build.mjs', 'tsconfig.json', 'package.json', 'package-lock.json'];

/** The smoke run tests dist/, so say so when dist/ is older than what it was built from. */
function warnIfDistIsStale() {
  const newestIn = (target) => {
    const stat = fs.statSync(target);
    if (!stat.isDirectory()) return stat.mtimeMs;
    return fs.readdirSync(target).reduce((latest, name) => Math.max(latest, newestIn(path.join(target, name))), 0);
  };
  const inputs = BUILD_INPUTS.map((rel) => path.join(REPO, rel)).filter((p) => fs.existsSync(p));
  const newestSource = Math.max(...inputs.map(newestIn));
  const built = fs.statSync(path.join(DIST, 'manifest.json')).mtimeMs;
  if (newestSource > built) {
    console.warn(`warning: dist/ is older than the sources (dist/ built ${new Date(built).toLocaleString()}, newest source ${new Date(newestSource).toLocaleString()}). This run tests the old build: run npm run build, or pass --build.`);
  }
}

/** The real server's key is set and the model is in its catalog; the run does not start otherwise. */
async function preflightReal() {
  const where = `${REAL.origin}${REAL.mount}`;
  if (!REAL.apiKey) {
    throw new UserError(`No ${REAL.label} key: set ${REAL.keyEnv.join(' or ')} in this shell or in the repo .env.`);
  }
  const res = await fetch(`${where}/models`, { headers: { Authorization: `Bearer ${REAL.apiKey}` } }).catch((err) => ({ ok: false, status: err.message }));
  if (!res.ok) throw new UserError(`${REAL.label} is not reachable at ${where} (${res.status}). Check the network and ${REAL.urlEnv}.`);
  const ids = ((await res.json().catch(() => ({}))).data || []).map((m) => m.id);
  if (!ids.includes(MODEL)) throw new UserError(`${REAL.label} does not list the model "${MODEL}" (it lists ${ids.slice(0, 10).join(', ') || 'none'}). Pick one with --model=.`);
  // The key is not returned: `env` goes into the saved report, and the key must never be in it.
  return { provider: REAL.name, url: where, models: ids.length };
}

async function preflightOllama() {
  const version = await fetch(`${OLLAMA}/api/version`).then((r) => r.json()).catch(() => null);
  if (!version) {
    throw new UserError(`Ollama is not reachable at ${OLLAMA}. Start it, or use the default provider (LISA).`);
  }
  // What the extension would get if it talked to Ollama directly. A 403 here is why the
  // proxy exists.
  const direct = await fetch(`${OLLAMA}/api/tags`, { headers: { Origin: `chrome-extension://${'a'.repeat(32)}` } })
    .then((r) => r.status).catch((e) => `error ${e.message}`);
  return { ollamaVersion: version.version, directStatusFromExtensionOrigin: direct };
}

async function listen(what, start) {
  try {
    return await start();
  } catch (err) {
    if (err && err.code === 'EADDRINUSE') {
      throw new UserError(`${what}: port ${err.port} is already in use (another smoke run?). Stop the other process${what.startsWith('fixture') ? ' or set FIXTURE_PORT' : ' or set PROXY_PORT'}.`);
    }
    throw err;
  }
}

function closeServer(server) {
  return () => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

// ---------------------------------------------------------------------------------------------
// The browser
// ---------------------------------------------------------------------------------------------

function textOfArgs(list) {
  return (list || []).map((a) => (a.value !== undefined ? String(a.value) : (a.description || a.type))).join(' ');
}

/**
 * Collects the errors of one service worker: console errors and asserts, uncaught exceptions,
 * the browser's own error log entries and CSP violations. A raw CDP session is used because
 * puppeteer's worker object drops uncaught exceptions. Runtime.enable replays what the worker
 * logged before we attached, so an error at start-up (top level of sw.js) is caught too.
 *
 * A CSP violation in a worker is NOT a console message and not a log entry. Chromium reports it
 * only as a `ContentSecurityPolicyIssue` of the Audits domain (and as a `securitypolicyviolation`
 * event in the worker, which is too late to listen for at start-up). That is why zod's blocked
 * `new Function('')` probe passed this harness before Audits was watched. Audits.enable replays the issues collected so far, like Runtime.enable does.
 */
async function watchWorker(target, errors) {
  const session = await target.createCDPSession();
  session.on('Audits.issueAdded', (e) => {
    const issue = e.issue || {};
    const d = (issue.details && issue.details.contentSecurityPolicyIssueDetails) || {};
    if (issue.code !== 'ContentSecurityPolicyIssue' || d.isReportOnly) return;
    const at = d.sourceCodeLocation ? ` at ${d.sourceCodeLocation.url}:${d.sourceCodeLocation.lineNumber + 1}:${d.sourceCodeLocation.columnNumber + 1}` : '';
    errors.push(`service worker CSP violation: ${d.violatedDirective} ${d.contentSecurityPolicyViolationType}${at}`);
  });
  session.on('Runtime.consoleAPICalled', (e) => {
    if (e.type !== 'error' && e.type !== 'assert') return;
    const text = textOfArgs(e.args);
    errors.push(`service worker console.${e.type}: ${oneLine(text, 300)}`);
  });
  session.on('Runtime.exceptionThrown', (e) => {
    const d = e.exceptionDetails || {};
    errors.push(`service worker exception: ${oneLine((d.exception && d.exception.description) || d.text || 'unknown', 300)}`);
  });
  session.on('Log.entryAdded', (e) => {
    if (e.entry && e.entry.level === 'error') errors.push(`service worker log: ${oneLine(`${e.entry.text} ${e.entry.url || ''}`, 300)}`);
  });
  await session.send('Runtime.enable');
  await session.send('Log.enable').catch(() => { /* not every target has the Log domain */ });
  // Not optional: without it a CSP violation in the worker cannot be seen, so a failure to enable it is an error of its own.
  await session.send('Audits.enable');
  // Counting what the engine sends to the page is optional: a worker that cannot be counted leaves the tally empty.
  await instrumentWorker(session);
  return session;
}

/**
 * Puts the counters into the worker. The target exists before the worker has run its script, and there is no `chrome` until
 * it has, so this asks again for a few seconds. Returns 'ok', 'already', 'not patchable' or null (never got there).
 */
async function instrumentWorker(session) {
  for (let i = 0; i < 50; i++) {
    const res = await session.send('Runtime.evaluate', { expression: TALLY_SCRIPT, returnByValue: true }).catch(() => null);
    const value = res && res.result && res.result.value;
    if (value === 'ok' || value === 'already' || value === 'not patchable') return value;
    await sleep(100);
  }
  return null;
}

/**
 * Counts what the engine sends to the pages, inside the worker: every chrome.tabs.sendMessage by its action name, and every
 * chrome.debugger.sendCommand by its method. The wrappers only count and pass everything on. This is how the harness sees that
 * a click was (or was never) sent to the page, which the history of the panel cannot show: a click the engine's parser rejects
 * leaves no trace there. It changes the temp copy's worker at run time, never a file.
 */
const TALLY_SCRIPT = `(() => {
  if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.tabs.sendMessage) return 'no chrome yet';
  if (self.__e2eTally) return 'already';
  const tally = { messages: {}, cdp: {} };
  const bump = (bucket, key) => { bucket[key] = (bucket[key] || 0) + 1; };
  const sendMessage = chrome.tabs.sendMessage;
  chrome.tabs.sendMessage = function (tabId, message, ...rest) {
    bump(tally.messages, message && typeof message.action === 'string' ? message.action : '(no action)');
    return sendMessage.call(this, tabId, message, ...rest);
  };
  if (chrome.debugger && chrome.debugger.sendCommand) {
    const sendCommand = chrome.debugger.sendCommand;
    chrome.debugger.sendCommand = function (target, method, ...rest) {
      bump(tally.cdp, String(method));
      return sendCommand.call(this, target, method, ...rest);
    };
  }
  if (chrome.tabs.sendMessage === sendMessage) return 'not patchable';
  self.__e2eTally = tally;
  return 'ok';
})()`;

/** What the worker has counted so far ({messages, cdp}), or null when it was not counting (a worker that restarted, a CDP session that is gone). */
async function readTally(ctx) {
  try {
    const res = await ctx.worker.session.send('Runtime.evaluate', { expression: 'JSON.stringify(self.__e2eTally || null)', returnByValue: true });
    return JSON.parse(res.result.value);
  } catch {
    return null;
  }
}

/** The counts of `after` minus those of `before` (both from readTally), or null when either is missing. */
function tallyDelta(after, before) {
  if (!after || !before) return null;
  const minus = (a, b) => Object.fromEntries(Object.entries(a).map(([k, n]) => [k, n - (b[k] || 0)]).filter(([, n]) => n !== 0));
  return { messages: minus(after.messages, before.messages), cdp: minus(after.cdp, before.cdp) };
}

async function closeBrowser(browser) {
  const proc = browser.process();
  let giveUp;
  const timeout = new Promise((resolve) => { giveUp = setTimeout(resolve, 10000); });
  await Promise.race([browser.close().catch(() => {}), timeout]);
  clearTimeout(giveUp); // a timer left running would keep the process alive
  if (proc && proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
}

async function launch(puppeteer, extensionDir) {
  const profileDir = makeTempDir('scoutfox-e2e-');
  const browser = await puppeteer.launch({
    executablePath: CHROMIUM,
    headless: !!args.headless,
    pipe: true,
    enableExtensions: true,
    defaultViewport: null,
    // This script owns the signals (see the handlers at the top): puppeteer's own SIGINT handler
    // exits at once and would cut the cleanup short.
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      // The display's device pixel ratio is forced to 2 here, so the picture and the CSS pixels
      // are different grids, which is what makes the coordinate mapping real.
      `--window-size=1920,1200`,
      `--force-device-scale-factor=${SHOT_DPR}`,
      ...CHROMIUM_ARGS
    ]
  });
  browserProcess = browser.process();
  onCleanup(() => closeBrowser(browser));

  // Errors from the worker and from the driver page. A worker that restarts is watched again.
  const workerErrors = [];
  const worker = { session: null }; // the CDP session of the newest worker, for the tally
  const isWorker = (t) => t.type() === 'service_worker' && t.url().endsWith('/background/sw.js');
  const watching = new Map(); // target -> the promise of its watcher, so awaiting it waits for the real attach
  const watch = (t) => {
    if (!watching.has(t)) {
      watching.set(t, watchWorker(t, workerErrors).then((session) => { worker.session = session; }).catch((err) => workerErrors.push(`could not watch the service worker: ${err.message}`)));
    }
    return watching.get(t);
  };
  // How many times a worker started: a restart task proves the worker really went away and came back.
  const workerStarts = { count: 0 };
  browser.on('targetcreated', (t) => { if (isWorker(t)) { workerStarts.count += 1; void watch(t); } });

  let swTarget;
  try {
    swTarget = await browser.waitForTarget(isWorker, { timeout: 20000 });
  } catch (err) {
    const missing = missingManifestFiles(extensionDir);
    throw new UserError(`The service worker (background/sw.js) did not start within 20 s, so Chromium most likely refused to load the extension. ${missing.length
      ? `manifest.json points to files that are not in the extension folder: ${missing.join(', ')}.`
      : 'Every file the manifest points to is there, so look at the manifest itself, or run with --headful and open chrome://extensions.'} (${err.message})`);
  }
  await watch(swTarget);
  const extensionId = new URL(swTarget.url()).host;

  const driver = await browser.newPage();
  driver.on('pageerror', (err) => workerErrors.push(`driver page: ${err}`));
  driver.on('console', (msg) => { if (msg.type() === 'error') workerErrors.push(`driver page console.error: ${oneLine(msg.text(), 300)}`); });
  await driver.goto(`chrome-extension://${extensionId}/driver.html`);
  return { browser, driver, extensionId, workerErrors, worker, workerStarts, panel: newPanelSink() };
}

// ---------------------------------------------------------------------------------------------
// Fixture pages
// ---------------------------------------------------------------------------------------------

async function tabIdFor(driver, url) {
  for (let i = 0; i < 50; i++) {
    const id = await driver.evaluate(async (u) => {
      const wanted = u.replace(/\/+$/, '');
      const tab = (await chrome.tabs.query({})).find((t) => (t.url || '').replace(/\/+$/, '') === wanted);
      return tab ? tab.id : null;
    }, url);
    if (id !== null) return id;
    await sleep(100);
  }
  throw new Error(`No tab found for ${url}`);
}

async function snapshotOf(driver, tabId, tries = 50) {
  // The manifest's content scripts load at document_idle, so the first tries can land before
  // the listener exists.
  for (let i = 0; i < tries; i++) {
    const res = await driver.evaluate(async (id) => {
      try {
        return await chrome.tabs.sendMessage(id, { action: 'GET_DOM_SNAPSHOT', payload: { showBadges: false } });
      } catch (err) {
        return { success: false, error: err.message };
      }
    }, tabId);
    if (res && res.success) return res.data;
    await sleep(200);
  }
  throw new Error(`The content script never answered on tab ${tabId}`);
}

/**
 * Errors of a fixture page (the page a task runs on), from before its first script runs, so an
 * error at document_start (where the MAIN-world net recorder runs) is seen too. Everything counts,
 * with one exception that was checked and is unrelated to the extension: the browser's own request
 * for /favicon.ico, which the fixture site does not have (a 404 "Failed to load resource" line).
 */
function watchFixturePage(page, errors) {
  page.on('pageerror', (err) => errors.push(`page error: ${oneLine(String(err), 300)}`));
  page.on('console', (msg) => {
    if (msg.type() !== 'error' && msg.type() !== 'assert') return;
    const at = (msg.location() && msg.location().url) || '';
    if (/^Failed to load resource/.test(msg.text()) && /\/favicon\.ico$/.test(at)) return;
    errors.push(`console.${msg.type()}: ${oneLine(msg.text(), 300)}${at ? ` (${at})` : ''}`);
  });
}

/**
 * Are the extension's scripts really on this page? Two facts, read the way each script can be
 * reached. The MAIN-world recorder (content/net-recorder.js) sets a flag on the page's own window,
 * so page.evaluate (which runs in the page's world) can read it. The isolated-world content script
 * is reached the way the engine reaches it: a GET_DOM_SNAPSHOT message to the tab. Never throws.
 */
async function probePage(ctx, page, tabId) {
  const probe = { url: page.url(), recorderActive: false, contentScript: false, contentScriptError: null };
  probe.recorderActive = (await page.evaluate(() => window.__scoutfox_net_recorder_active === true).catch(() => false)) === true;
  try {
    await snapshotOf(ctx.driver, tabId, 15);
    probe.contentScript = true;
  } catch (err) {
    probe.contentScriptError = err.message;
  }
  return probe;
}

/**
 * Every part of read_page on a tab, joined: the page's whole text as the model can read it, and
 * the links block of each part ("Links in this part:", content/pageLinks.ts) in part order.
 */
async function fullPageTextOf(driver, tabId) {
  const parts = [];
  const linksByPart = [];
  // The embedded frames' texts, asked of each frame's agent the way the engine does
  // (readFrameTexts in src/background/browser/frames.ts), so the snapshot holds what read_page gives.
  const frames = await driver.evaluate(async (id) => {
    const out = [];
    const rows = await chrome.scripting.executeScript({ target: { tabId: id, allFrames: true }, func: () => globalThis.__scoutfoxFrameAgent === true }).catch(() => []);
    for (const row of rows) {
      if (row.frameId === 0 || row.result !== true) continue;
      const answer = await chrome.tabs.sendMessage(id, { action: 'FRAME_TEXT' }, { frameId: row.frameId }).catch(() => null);
      if (answer && answer.success && typeof answer.text === 'string' && answer.text.trim()) out.push({ origin: answer.origin, text: answer.text.trim(), ...(Array.isArray(answer.links) && answer.links.length ? { links: answer.links } : {}) });
    }
    return out;
  }, tabId);
  for (let part = 1; part <= 50; part++) {
    const res = await driver.evaluate(async (id, n, frameTexts) => {
      try {
        return await chrome.tabs.sendMessage(id, { action: 'EXECUTE_ACTION', payload: { action: 'read_page', part: n, ...(frameTexts.length ? { frames: frameTexts } : {}) } }, { frameId: 0 });
      } catch (err) {
        return { success: false, error: err.message };
      }
    }, tabId, part, frames);
    if (!res || !res.success) throw new Error(`read_page part ${part} failed on tab ${tabId}: ${res && res.error}`);
    parts.push(res.result.pageText);
    linksByPart.push(typeof res.result.links === 'string' ? res.result.links : '');
    if (res.result.part >= res.result.parts) break;
  }
  return { text: parts.join('\n'), linksByPart };
}

async function dumpSnapshots(ctx, fixtures, only) {
  const pages = SNAPSHOT_PAGES.map((name) => ({ name, origin: fixtures.origin, dir: SNAPSHOT_DIR }));
  const wanted = only ? pages.filter((p) => only.includes(p.name)) : pages;
  for (const name of only || []) {
    if (!pages.some((p) => p.name === name)) throw new UserError(`Unknown page "${name}" for --dump-snapshots. Known: ${pages.map((p) => p.name).join(', ')}`);
  }
  for (const { name, origin, dir } of wanted) {
    const url = `${origin}/${name}.html`;
    const page = await ctx.browser.newPage();
    await page.goto(url, { waitUntil: 'load' });
    const tabId = await tabIdFor(ctx.driver, url);
    const snap = await snapshotOf(ctx.driver, tabId);
    // `elements` holds the per-element locators for the executor. The model never sees them,
    // so they are left out to keep the files small and readable.
    const { elements, ...forModel } = snap;
    // The whole page text, the way read_page reads it (every part through the real content
    // script, joined back at the line breaks they were cut at).
    const full = await fullPageTextOf(ctx.driver, tabId);
    forModel.fullPageText = full.text;
    // Only a page with links in what it reads carries the blocks, so the other snapshots stay as they were.
    if (full.linksByPart.some(Boolean)) forModel.linksByPart = full.linksByPart;
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}.json`);
    fs.writeFileSync(file, `${JSON.stringify(forModel, null, 2)}\n`);
    console.log(`snapshot ${name}: ${snap.elementCount} elements, ${snap.pageText.length} chars of text -> ${path.relative(REPO, file)}`);
    await page.close();
  }
}

// ---------------------------------------------------------------------------------------------
// The side panel
// ---------------------------------------------------------------------------------------------

function newPanelSink() {
  return { consoleErrors: [], pageErrors: [], cspViolations: [] };
}

/** Records what a side panel page reports, before any of its scripts run. */
async function watchPanelPage(page, sink) {
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    if (/^Failed to load resource/.test(msg.text()) && FONT_HOSTS.test((msg.location() && msg.location().url) || '')) return;
    sink.consoleErrors.push(oneLine(msg.text(), 300));
  });
  page.on('pageerror', (err) => sink.pageErrors.push(oneLine(String(err), 300)));
  await page.evaluateOnNewDocument(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__cspViolations.push(`${e.violatedDirective} blocked ${e.blockedURI || 'inline'}`);
    });
  });
}

async function collectCsp(page, sink) {
  // The real panel has no page binding, so the hook below was never installed there and this
  // reads []: a real panel that blocked a script shows up as a missing step or a console error,
  // which the same run reports anyway. The fallback page does have the hook.
  const found = (await page.evaluate(() => window.__cspViolations || []).catch(() => [])) || [];
  for (const violation of found) if (!sink.cspViolations.includes(violation)) sink.cspViolations.push(violation);
}

/**
 * The LLM timeout field is in ms and its min="5000" is not enforced when the panel reads it, so a
 * value below that is saved as 5000. The field must then show 5000, the stored value, and not keep
 * the number that was typed. The change is made the way a user makes it (type, then the change
 * event that leaving the field fires), and the value that was in the field is put back after.
 */
async function checkTimeoutField(page) {
  const result = { typed: 1000, shown: null, stored: null, problems: [] };
  const original = await page.$eval('#llmTimeoutInput', (el) => el.value);
  const set = async (value) => {
    await page.$eval('#llmTimeoutInput', (el, v) => {
      el.value = v;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, String(value));
  };
  await set(result.typed);
  await page.waitForFunction(() => document.getElementById('llmTimeoutInput').value !== '1000', { timeout: 3000 }).catch(() => { /* judged below */ });
  result.shown = await page.$eval('#llmTimeoutInput', (el) => el.value);
  // The stored value the engine uses, in timeoutMsOf's order: the provider's own config first
  // (where the panel saves it for a built-in provider), then a custom provider's descriptor, then the global one.
  result.stored = await page.evaluate(() => chrome.storage.local.get('agent_settings').then(({ agent_settings: s }) => {
    if (!s) return undefined;
    const own = Number(s.providerConfigs?.[s.provider]?.llmTimeoutMs);
    if (own > 0) return own;
    const custom = Number(s.customProviders?.[s.provider]?.llmTimeoutMs);
    if (custom > 0) return custom;
    return s.llmTimeoutMs;
  }));
  await set(original);
  await page.waitForFunction((v) => document.getElementById('llmTimeoutInput').value === v, { timeout: 3000 }, original).catch(() => {});
  if (result.stored !== 5000) result.problems.push(`typing ${result.typed} into "LLM Timeout (ms)" stored ${JSON.stringify(result.stored)}, expected 5000`);
  if (result.shown !== '5000') result.problems.push(`after saving, the "LLM Timeout (ms)" field shows ${JSON.stringify(result.shown)} and not the stored value 5000`);
  return result;
}

/**
 * The side panel gate. Chrome's side panel cannot be opened from a script (that needs a user
 * gesture), so sidepanel.html is opened as a page, like panelScreenshots does. It must load with
 * no console error, no page error and no CSP violation, its script must actually have run (the
 * model badge shows the configured model) and its request for the model list must have worked.
 */
async function checkSidePanel(ctx) {
  const url = `chrome-extension://${ctx.extensionId}/sidepanel/sidepanel.html`;
  const gate = { url, badge: null, modelStatus: null, problems: [] };
  const page = await ctx.browser.newPage();
  try {
    await watchPanelPage(page, ctx.panel);
    await page.setViewport({ width: 400, height: 900 });
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(
      (model) => {
        const badge = document.getElementById('currentModelBadge');
        const status = document.getElementById('modelFetchStatus');
        return !!badge && badge.textContent === model && !!status && /^(Loaded|Retrieved) \d+ model/.test(status.textContent);
      },
      { timeout: 8000 },
      MODEL
    ).catch(() => { /* judged below, with what the page shows */ });
    gate.badge = await page.$eval('#currentModelBadge', (el) => el.textContent).catch(() => null);
    gate.modelStatus = await page.$eval('#modelFetchStatus', (el) => el.textContent).catch(() => null);
    // The panel asks the worker for its build after connecting. The bar must report "same".
    await page.waitForFunction(() => !!document.getElementById('updateBanner')?.dataset.workerBuild, { timeout: 8000 }).catch(() => {});
    gate.workerBuild = await page.$eval('#updateBanner', (el) => ({ result: el.dataset.workerBuild || null, shown: !el.hidden && el.getBoundingClientRect().height > 0 })).catch(() => null);
    gate.timeoutField = await checkTimeoutField(page);
    await sleep(500); // late errors
    await collectCsp(page, ctx.panel);
  } finally {
    await page.close().catch(() => {});
  }
  gate.problems.push(...gate.timeoutField.problems);
  if (!gate.workerBuild || !gate.workerBuild.result) gate.problems.push('the panel never compared its build with the background worker (no GET_BUILD answer)');
  else if (gate.workerBuild.result !== 'same' || gate.workerBuild.shown) gate.problems.push('the panel shows "ScoutFox was updated. Reload it": the background worker is from a different build than the panel');
  if (gate.badge !== MODEL) gate.problems.push(`the panel script did not run: the model badge shows ${JSON.stringify(gate.badge)}, expected ${JSON.stringify(MODEL)}`);
  if (!/^(Loaded|Retrieved) \d+ model/.test(gate.modelStatus || '')) gate.problems.push(`the panel did not get the model list: status ${JSON.stringify(gate.modelStatus)}`);
  return gate;
}

/**
 * The ScoutFox mark. It is a fox head, drawn in one line, and it must be in the panel twice: in
 * the header next to the name, and in the middle of the panel above "What would you like to
 * automate?".
 *
 * The check reads the shape out of the rendered DOM, not out of a source file, so it proves what
 * a user sees: both marks are there, both are the same shape, and neither is a zero-size box
 * (a mark that failed to draw would still be in the DOM).
 */
async function checkBrandMark(ctx) {
  const url = `chrome-extension://${ctx.extensionId}/sidepanel/sidepanel.html`;
  const page = await ctx.browser.newPage();
  const result = { url, header: null, middle: null, problems: [] };
  try {
    await page.setViewport({ width: 400, height: 900 });
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => !!document.querySelector('.empty-glyph svg'), { timeout: 8000 })
      .catch(() => { /* judged below, with what the page shows */ });
    const read = (selector) => page.evaluate((sel) => {
      const host = document.querySelector(sel);
      const svg = host && host.querySelector('svg');
      if (!svg) return null;
      const box = svg.getBoundingClientRect();
      return {
        path: svg.querySelector('path')?.getAttribute('d') || '',
        eyes: svg.querySelectorAll('circle').length,
        width: Math.round(box.width),
        height: Math.round(box.height),
        color: getComputedStyle(svg).color
      };
    }, selector);
    result.header = await read('.logo-icon');
    result.middle = await read('.empty-glyph');
  } finally {
    await page.close().catch(() => {});
  }

  const FOX_PATH = 'M3.2 3 8.6 8.4 5.6 11.2Q6.6 17 12 21.6Q17.4 17 18.4 11.2L15.4 8.4 20.8 3 15.2 6.2Q12 5.2 8.8 6.2Z';
  for (const [where, mark] of [['header', result.header], ['middle of the panel', result.middle]]) {
    if (!mark) {
      result.problems.push(`the ${where} has no fox mark`);
      continue;
    }
    if (mark.path !== FOX_PATH) {
      result.problems.push(`the ${where} does not show the fox mark: its shape is "${mark.path}"`);
    }
    if (mark.eyes !== 2) {
      result.problems.push(`the ${where} shows a mark with ${mark.eyes} eye(s), expected 2`);
    }
    if (mark.width < 8 || mark.height < 8) {
      result.problems.push(`the ${where} shows the mark at ${mark.width}x${mark.height} px, too small to be seen`);
    }
  }
  if (result.header && result.middle && result.header.path !== result.middle.path) {
    result.problems.push('the mark in the header and the mark in the middle of the panel are different shapes');
  }
  return result;
}

/** The pixel size of a PNG the harness just wrote, from ImageMagick. */
function imageSize(file) {
  return new Promise((resolve, reject) => {
    const identify = spawn('magick', ['identify', '-format', '%w %h', file]);
    let output = '';
    identify.stdout.on('data', (chunk) => { output += chunk; });
    identify.stderr.on('data', () => {});
    identify.on('close', (code) => {
      const match = /(\d+)\s+(\d+)/.exec(output);
      if (code === 0 && match) resolve({ width: Number(match[1]), height: Number(match[2]) });
      else reject(new Error(`identify could not read ${path.basename(file)}`));
    });
  });
}

/**
 * Put the page a task ran on next to Chrome's side panel, at the proportions Chrome uses, so one
 * image shows what an end user sees with the panel open.
 *
 * Both screenshots come from the same Chrome, so their pixel widths are already in the right ratio;
 * the page is scaled to three panel widths (a wide window) and the panel keeps its own width. Both
 * are placed at the top of a white canvas of one height, so nothing is squashed, stretched, or cut
 * off, and the text is legible at 1:1 pixels. Returns the combined path, or null if it failed.
 */
async function combineSideBySide(pageEnd, panelFile, outPath) {
  try {
    const [pageSize, panelSize] = await Promise.all([imageSize(pageEnd), imageSize(panelFile)]);
    const pageWidth = panelSize.width * 3;
    const canvasHeight = Math.max(Math.round((pageSize.height * pageWidth) / pageSize.width), panelSize.height);
    await new Promise((resolve, reject) => {
      const magick = spawn('magick', [
        '(', pageEnd, '-resize', `${pageWidth}x`, '-background', 'white', '-gravity', 'north', '-extent', `${pageWidth}x${canvasHeight}`, ')',
        '(', panelFile, '-background', 'white', '-gravity', 'north', '-extent', `${panelSize.width}x${canvasHeight}`, ')',
        '+append',
        outPath
      ]);
      magick.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`magick exited with code ${code}`));
      });
      magick.stderr.on('data', () => {}); // ignore ImageMagick warnings
    });
    return outPath;
  } catch (err) {
    console.error(`side-by-side combine failed: ${err?.message || String(err)}`);
    return null;
  }
}

/** The page a task's panel belongs to, the panel's own URL, and the trigger page's URL. */
const panelUrls = (ctx) => ({
  panel: `chrome-extension://${ctx.extensionId}/sidepanel/sidepanel.html`,
  trigger: (tabId) => `chrome-extension://${ctx.extensionId}/panel-trigger.html?tab=${tabId}`
});

/**
 * The REAL Chrome side panel, attached to the task's tab.
 *
 * Chrome opens a side panel only on a user gesture, and CDP cannot click the toolbar icon (browser
 * UI is no DevTools target). So a page of the extension takes the click: panel-trigger.html covers
 * its whole viewport with one button and calls chrome.sidePanel.open({ tabId }) inside that click's
 * own task, which is what Chrome insists on. The panel then appears as a page target of its own:
 * Chrome's own width, Chrome's own header, and chrome.tabs.query({ active, currentWindow })
 * answered by Chrome rather than patched by the harness. That is the surface the user looks at.
 *
 * The extension shows a panel only on a tab that has a session, and it decides that on
 * tabs.onActivated. Making the extension activate the tab for this purpose is not an option here:
 * a scratch tab created mid-run can be adopted by the runner (NEW_TAB_DETECTED), which would steer
 * the task away from its page. So the harness states what the extension would have stated on
 * activation - this tab shows the panel - through the same API, and nothing else changes.
 *
 * Returns { page, reason }. panelScreenshots falls back to the panel opened as a page when page is
 * null and says so, because a silent fallback would quietly stop verifying what the user sees.
 */
async function openRealPanel(ctx, tabId) {
  const { panel: panelUrl, trigger } = panelUrls(ctx);
  // Headless Chromium has no side panel surface at all: no panel document is ever created there,
  // however the panel is asked for. The suite runs headful by default for exactly this reason.
  if (args.headless) return { cdp: null, targetId: null, reason: 'not attempted: headless Chromium creates no side panel' };
  const enabled = await ctx.driver.evaluate(async (id) => {
    try {
      await chrome.sidePanel.setOptions({ tabId: id, path: 'sidepanel/sidepanel.html', enabled: true });
      const opts = await chrome.sidePanel.getOptions({ tabId: id });
      return { enabled: !!opts.enabled, error: null };
    } catch (err) {
      return { enabled: false, error: `chrome.sidePanel.setOptions for tab ${id} failed: ${err.message}` };
    }
  }, tabId);
  if (!enabled.enabled) return { cdp: null, targetId: null, reason: enabled.error || `the panel of tab ${tabId} is still not enabled after setOptions said ok` };

  const trig = await ctx.browser.newPage();
  let openedViaTrigger = null;
  try {
    await trig.goto(trigger(tabId), { waitUntil: 'load' });
    await trig.click('#openPanel');
    await trig.waitForFunction(() => window.__openResult !== 'pending', { timeout: 6000 }).catch(() => {});
    openedViaTrigger = await trig.evaluate(() => window.__openResult).catch(() => 'unknown');
  } catch (err) {
    openedViaTrigger = `failed: ${err.message}`;
  } finally {
    await trig.close().catch(() => {});
  }
  if (openedViaTrigger !== 'ok') return { cdp: null, targetId: null, reason: `chrome.sidePanel.open() said "${openedViaTrigger}"` };

  // Chrome's panel is a page target of its own. Puppeteer is not used to find it first: this
  // browser is open through a pipe, and over a pipe Chrome does not announce targets it created
  // itself, so browser.targets() never lists the panel (probed: the raw CDP list shows it, the
  // puppeteer list does not). Target.getTargets over the browser connection does, every time.
  const session = await ctx.browser.target().createCDPSession();
  const targetId = await panelTargetId(session, panelUrl, 8000);
  if (!targetId) {
    const list = await session.send('Target.getTargets').catch(() => null);
    await session.detach().catch(() => {});
    const seen = list ? list.targetInfos.map((t) => `${t.type}:${t.url}`).join(' | ') : 'the CDP target list could not be read';
    return { page: null, reason: `open() was accepted but Chrome created no document for ${panelUrl}; targets now: ${seen}` };
  }
  // Attaching is what makes the panel drivable: a pipe connection only learns about a target Chrome
  // made itself once something is attached to it. Puppeteer registers the session Chrome answers
  // with (and deliberately does not wrap the target in a Page: it was not puppeteer's to open), so
  // the session is taken from the connection underneath, and the panel is driven over CDP from here.
  let child = null;
  try {
    const { sessionId } = await session.send('Target.attachToTarget', { targetId, flatten: true });
    // puppeteer keeps every session it has ever opened on the connection underneath a session, and
    // registers this one when the Target.attachedToTarget event for it arrives. The reply to the
    // command can beat that event by a few milliseconds, so this waits rather than guessing.
    const connection = typeof session.connection === 'function' ? session.connection() : session.connection;
    const deadline = Date.now() + 4000;
    while (!child && Date.now() < deadline) {
      child = connection?.session?.(sessionId) || connection?._session?.(sessionId) || null;
      if (!child) await sleep(100);
    }
  } catch { /* reported below */ }
  if (!child) {
    await session.detach().catch(() => {});
    return { page: null, reason: `CDP attached to the panel document but puppeteer would not hand back that session (${panelUrl})` };
  }
  // Console output and CSP on this surface are not watched: the CDP adapter is not a puppeteer
  // page, and the gate (checkSidePanel) already watches the same document as a page. What is
  // watched here is the panel's own uncaught exceptions, in panelViaCdp.
  return { page: { real: true, ...(await panelViaCdp(child)) }, reason: null };
}

/**
 * A panel document Chrome made, driven over the CDP session that Target.attachToTarget opened.
 * It implements what the checks and the screenshots use of a page, and nothing else.
 */
async function panelViaCdp(panel) {
  await panel.send('Page.enable');
  await panel.send('Runtime.enable');
  const errors = [];
  panel.on('Runtime.exceptionThrown', (event) => {
    const text = event.exceptionDetails?.exception?.description || event.exceptionDetails?.text || 'unknown exception';
    if (!errors.includes(text)) errors.push(text);
  });
  const text = (selector) =>
    panel.send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(selector)})?.innerText || ''` })
      .then((r) => r.result?.value || '')
      .catch(() => '');
  return {
    text,
    waitForText: (selector, ms) => pollUntil(() => text(selector), ms),
    errors: () => errors.slice(),
    /** A real mouse click (CDP Input) in the middle of the first element the selector matches: a user's click, not element.click(). */
    click: async (selector) => {
      const box = await panel.send('Runtime.evaluate', {
        expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
        returnByValue: true
      });
      const at = box.result?.value;
      if (!at) throw new Error(`no element matches ${selector} on the panel`);
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await panel.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
      }
    },
    evaluate: async (fn, ...args) => {
      const argList = args.map((a) => JSON.stringify(a)).join(', ');
      const source = typeof fn === 'function' ? `(${fn.toString()})(${argList})` : String(fn);
      const result = await panel.send('Runtime.evaluate', { expression: source, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    },
    /**
     * The whole panel, not only the part Chrome is showing: captureBeyondViewport asks for the full
     * scrollable content at the panel's own width and pixel ratio.
     */
    screenshot: async (file) => {
      const metrics = await panel.send('Page.getLayoutMetrics');
      const width = Math.ceil(metrics.cssContentSize?.width || metrics.cssLayoutViewport?.clientWidth || metrics.layoutView?.clientWidth || 400);
      const height = Math.ceil(metrics.cssContentSize?.height || metrics.cssLayoutViewport?.clientHeight || metrics.layoutView?.clientHeight || 900);
      const { data } = await panel.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 } });
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
      return { width, height };
    },
    /** prefers-color-scheme of the panel document, the way the system setting sets it. */
    setColorScheme: (scheme) => panel.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }),
    /** A close-up: one element as it is drawn now, with a margin around it. */
    shootElement: async (selector, file, margin = 8) => {
      const found = await panel.send('Runtime.evaluate', {
        expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`,
        returnByValue: true
      });
      const box = found.result?.value;
      if (!box || !box.width || !box.height) throw new Error(`no visible element matches ${selector} on the panel`);
      const x = Math.max(0, box.x - margin);
      const y = Math.max(0, box.y - margin);
      const clip = { x, y, width: Math.ceil(box.width + margin * 2), height: Math.ceil(box.height + margin * 2), scale: 1 };
      const { data } = await panel.send('Page.captureScreenshot', { format: 'png', clip });
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
    },
    close: () => panel.detach().catch(() => {})
  };
}

/** Reads `read()` until it gives something non-blank, and returns the last read either way. */
async function pollUntil(read, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value && value.trim()) return value;
    if (Date.now() > deadline) return value || '';
    await sleep(250);
  }
}

/** Polls CDP for the panel's document and returns its target id, or null after the timeout. */
async function panelTargetId(session, panelUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { targetInfos } = await session.send('Target.getTargets');
    const hit = targetInfos.find((t) => t.type === 'page' && t.url === panelUrl);
    if (hit) return hit.targetId;
    await sleep(150);
  }
  return null;
}

/**
 * Screenshots of the finished run: one image per task, the page the task ran on on the left and
 * Chrome's real side panel on the right, at the proportions Chrome uses. That is the view an end
 * user has, so it is the view that gets verified.
 *
 * Returns the files it wrote: the panel alone, and the combined view. When Chrome gives no panel
 * document (only possible with --headless, see openRealPanel) it falls back to the panel as a page
 * and records that, because a silent fallback would quietly stop verifying what the user sees.
 */
async function panelScreenshots(ctx, tabId, name, dir, pageEnd = null) {
  fs.mkdirSync(dir, { recursive: true });
  ctx.panelSurfaces = ctx.panelSurfaces || new Map();
  const panel = await panelSurface(ctx, tabId);
  const file = path.join(dir, `${name}-panel.png`);
  try {
    await sleep(panel.real ? 1500 : 2000); // let the panel render the state the run just left behind
    await panel.screenshot(file);
  } finally {
    ctx.panel.pageErrors.push(...panel.errors());
    await panel.close(); // Chrome owns the real panel: the harness only lets go of it
  }
  ctx.panelSurfaces.set(name, panel.real ? 'real Chrome side panel' : `panel page (fallback: ${panel.reason})`);
  const combined = pageEnd && fs.existsSync(pageEnd)
    ? await combineSideBySide(pageEnd, file, path.join(dir, `${name}-side-by-side.png`))
    : null;
  return combined ? [file, combined] : [file];
}

/**
 * The panel of one tab, with the few things a check needs from it: the text of a node, waiting for
 * that text, running a function in the page, its page errors, a screenshot, and how to let go.
 *
 * `real` tells the two surfaces apart and the report prints it. Chrome's own side panel proves the
 * scoping, Chrome's header, and the width Chrome gave the panel. The fallback is the same document
 * opened as a 400 px page (all a headless run can do), which proves the content and nothing else.
 */
async function panelSurface(ctx, tabId) {
  let real = await openRealPanel(ctx, tabId);
  // Chrome occasionally accepts sidePanel.open() and still creates no panel document within the
  // wait. One retry has been enough every time that happened; falling back on the first miss
  // would quietly demote the run's evidence to the panel page.
  if (!real.page && !args.headless && /created no document/.test(real.reason || '')) {
    real = await openRealPanel(ctx, tabId);
  }
  if (real.page) return { real: true, ...real.page };
  const page = await openPanelAsPage(ctx, tabId);
  const text = (selector) => page.$eval(selector, (el) => el.innerText || '').catch(() => '');
  return {
    real: false,
    reason: real.reason,
    text,
    waitForText: (selector, ms) => pollUntil(() => text(selector), ms),
    click: (selector) => page.click(selector),
    evaluate: (fn, ...args) => page.evaluate(fn, ...args),
    screenshot: async (file) => {
      await page.setViewport({ width: 400, height: 900 }); // no Chrome around to size the fallback
      await page.screenshot({ path: file, fullPage: true });
      return { width: 400, height: 900 };
    },
    setColorScheme: (scheme) => page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]),
    shootElement: async (selector, file, margin = 8) => {
      const el = await page.$(selector);
      const box = el && await el.boundingBox();
      if (!box) throw new Error(`no visible element matches ${selector} on the panel`);
      await page.screenshot({ path: file, clip: { x: Math.max(0, box.x - margin), y: Math.max(0, box.y - margin), width: box.width + margin * 2, height: box.height + margin * 2 } });
    },
    // The fallback page's console output and CSP hook are collected by watchPanelPage instead.
    errors: () => [],
    close: () => page.close().catch(() => {})
  };
}

/** The panel opened as an ordinary tab: the fallback when Chrome gives no panel document. */
async function openPanelAsPage(ctx, tabId, scheme = 'light') {
  const panel = await ctx.browser.newPage();
  await watchPanelPage(panel, ctx.panel);
  await panel.setViewport({ width: 400, height: 900 });
  await panel.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
  // Opened this way the panel is a tab of its own, and chrome.tabs.query({active, currentWindow})
  // would answer with itself: only that one query is pointed at the task's tab, which is what a
  // real panel gets from Chrome for free.
  await panel.evaluateOnNewDocument((id) => {
    const original = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = (queryInfo, cb) => {
      if (queryInfo && queryInfo.active && queryInfo.currentWindow && typeof cb === 'function') {
        return original({}, (tabs) => cb((tabs || []).filter((t) => t.id === id)));
      }
      return original(queryInfo, cb);
    };
  }, tabId);
  await panel.goto(`chrome-extension://${ctx.extensionId}/sidepanel/sidepanel.html`);
  return panel;
}

/**
 * The effort that went out on the wire (llm/effort.ts), call by call. The effort is the model's
 * reasoning level, so every request of a run at EFFORT must carry that level in the dialect of the
 * provider: enable_thinking and a reasoning budget for Nemotron on NIM (the one dialect checked here). The first call gets the chosen level; with "one level less on routine steps" (the default)
 * later calls may carry the level below it. A request with no field at all is the bug this checks:
 * the composer's effort reaching nothing.
 */
function effortWireProblems(calls, { provider, model, effort }) {
  if (effort === 'auto' || calls.length === 0) return [];
  const problems = [];
  const lower = { max: 'high', high: 'medium', medium: 'low', low: 'low', off: 'off' };
  if (provider === 'nvidia' && /nemotron/i.test(model)) {
    const budget = { low: 1024, medium: 4096, high: 12000, max: 24000 };
    calls.forEach((call, i) => {
      const fields = call.effort || {};
      if (effort === 'off') {
        if (fields.chat_template_kwargs?.enable_thinking !== false) problems.push(`model call ${i + 1} did not turn thinking off: ${JSON.stringify(fields)}`);
        return;
      }
      const allowed = i === 0 ? [budget[effort]] : [budget[effort], budget[lower[effort]]];
      if (fields.chat_template_kwargs?.enable_thinking !== true || !allowed.includes(fields.reasoning_budget)) {
        problems.push(`model call ${i + 1} went out with ${JSON.stringify(fields)}, expected enable_thinking and a reasoning_budget of ${allowed.join(' or ')} for effort ${effort}`);
      }
    });
    return problems;
  }
  return [];
}

/**
 * The final card the panel draws for the finished run: its classes and its title. A task with
 * `expectCard` (lib/tasks.mjs) is checked against it, so a run that did not finish can never show
 * the green "Done" card the user would trust.
 */
/**
 * The Logs tab after a run, read like a user reads it: the default view has the run's model calls
 * and steps, each with a sentence and a JSON tree that opens on click, and none of the plumbing
 * (ports, keepalive, worker boots). Saved as a screenshot in light and dark.
 */
async function checkLogsTab(ctx, tabId, shotName, shotDir, screenshots) {
  const problems = [];
  for (const scheme of ['light', 'dark']) {
    const panel = await openPanelAsPage(ctx, tabId, scheme);
    try {
      await panel.click('.nav-btn[data-tab="logs"]');
      await panel.waitForSelector('#logOutput .log-entry', { timeout: 8000 }).catch(() => {});
      if (scheme === 'light') {
        const seen = await panel.evaluate(() => {
          const out = document.getElementById('logOutput');
          return {
            llm: out.querySelectorAll('.log-entry.log-kind-llm').length,
            steps: out.querySelectorAll('.log-entry.log-kind-tool').length,
            plumbing: /PORT_CONNECT|KEEPALIVE|WORKER_BOOT|BROADCAST_DROPPED/.test(out.textContent || ''),
            stepText: out.querySelector('.log-entry.log-kind-tool .log-msg')?.textContent || ''
          };
        });
        if (seen.llm === 0) problems.push('the Logs tab shows no model call entry for the run');
        if (seen.steps === 0) problems.push('the Logs tab shows no agent step entry for the run');
        if (seen.plumbing) problems.push('the default Logs view shows plumbing lines (ports, keepalive, worker boot)');
        if (seen.steps && !/^[A-Z][a-z]+ /.test(seen.stepText)) problems.push(`the step entry does not read as a sentence: ${JSON.stringify(seen.stepText.slice(0, 80))}`);
        // Open the arguments of the first step, like a user clicking the tree.
        const toggle = await panel.$('#logOutput .log-entry.log-kind-tool .jt-toggle[data-path="$.arguments"]');
        if (!toggle) {
          problems.push('the step entry has no arguments node in its JSON tree');
        } else {
          await toggle.click();
          const opened = await panel.evaluate((el) => el.getAttribute('aria-expanded') === 'true' && !el.nextElementSibling.hidden, toggle);
          if (!opened) problems.push('clicking a JSON tree node in the Logs tab did not open it');
        }
      }
      await sleep(400); // the tab's colour transition, so the shot shows the settled tab bar
      const file = path.join(shotDir, `${shotName}-logs-${scheme}.png`);
      fs.mkdirSync(shotDir, { recursive: true });
      await panel.screenshot({ path: file });
      screenshots.push(file);
    } finally {
      await panel.close();
    }
  }
  return problems;
}

/**
 * Chrome stops an idle MV3 worker after about 30 seconds; a user who comes back later meets a fresh
 * worker. This does the same on purpose: every service worker of the profile is stopped over CDP,
 * the next message wakes a new one, and the real side panel must still show the finished run.
 */
async function restartWorkerAndReadCard(ctx, tabId, expect) {
  // A panel that stays open through the restart, like the user's: it must never fall back to the
  // start screen, not even for a moment, so every mutation is watched, not only the end state.
  const openPanel = await openPanelAsPage(ctx, tabId);
  await openPanel.waitForSelector('.finish-card', { timeout: 8000 }).catch(() => {});
  await openPanel.evaluate(() => {
    window.__sawStartScreen = !!document.getElementById('emptyState');
    new MutationObserver(() => { if (document.getElementById('emptyState')) window.__sawStartScreen = true; })
      .observe(document.body, { childList: true, subtree: true });
  });
  const restartProblems = await stopAndWakeWorker(ctx, tabId);
  if (restartProblems.length) {
    await openPanel.close();
    return restartProblems;
  }
  // The open panel reconnects its port and resyncs; give it the time a user would.
  await sleep(2000);
  const sawStartScreen = await openPanel.evaluate(() => window.__sawStartScreen === true).catch(() => null);
  const stillShown = await openPanel.evaluate(() => document.querySelectorAll('.finish-card').length).catch(() => 0);
  await openPanel.close();
  const problems = [];
  if (sawStartScreen) problems.push('after a worker restart: the open side panel fell back to the start screen');
  if (!stillShown) problems.push('after a worker restart: the open side panel lost the finished run');
  problems.push(...(await readPanelCard(ctx, tabId, expect)).map((p) => `after a worker restart: ${p}`));
  return problems;
}

/**
 * Stops every service worker of the extension over CDP and wakes a new one with a message, the
 * way Chrome stops an idle worker and the panel wakes it again. Returns problems (empty when a
 * new worker really started), so a restart check can never pass on a worker that kept running.
 */
async function stopAndWakeWorker(ctx, tabId) {
  const startsBefore = ctx.workerStarts.count;
  // A worker with a DevTools session attached is kept alive, so the harness's own watcher lets go
  // first; the new worker is watched again when its target appears.
  await ctx.worker.session?.detach().catch(() => {});
  // stopAllWorkers does not reach an extension's worker; stopWorker with the version the
  // extension page's ServiceWorker domain reports does (the worker target is destroyed).
  const cdp = await ctx.driver.createCDPSession();
  try {
    const versions = [];
    cdp.on('ServiceWorker.workerVersionUpdated', (e) => versions.push(...e.versions));
    await cdp.send('ServiceWorker.enable');
    await sleep(300);
    const running = versions.filter((v) => v.scriptURL.includes(`${ctx.extensionId}/background/sw.js`) && v.runningStatus === 'running');
    if (running.length === 0) return ['the harness found no running service worker to stop'];
    for (const v of running) await cdp.send('ServiceWorker.stopWorker', { versionId: v.versionId });
  } finally {
    await cdp.detach().catch(() => {});
  }
  await sleep(500);
  // Any extension message wakes the worker again, the way a panel reopening does.
  // The answer is not needed, only the wake: the evaluate gets a bound so a slow first answer of a
  // cold worker cannot hang the run.
  await Promise.race([
    ctx.driver.evaluate((id) => new Promise((resolve) => chrome.runtime.sendMessage({ action: 'GET_AGENT_STATE', tabId: id }, () => { void chrome.runtime.lastError; resolve(); })), tabId),
    sleep(5000)
  ]).catch(() => {});
  const deadline = Date.now() + 10000;
  while (ctx.workerStarts.count <= startsBefore && Date.now() < deadline) await sleep(100);
  if (ctx.workerStarts.count <= startsBefore) return ['the service worker did not restart, so the restart check proved nothing'];
  return [];
}

async function readPanelCard(ctx, tabId, expect) {
  const panel = await panelSurface(ctx, tabId);
  const problems = [];
  try {
    await panel.waitForText('.finish-card .finish-title', 8000);
    const card = await panel.evaluate(() => {
      const cards = document.querySelectorAll('.finish-card');
      const el = cards[cards.length - 1];
      return el ? {
        classes: [...el.classList],
        title: el.querySelector('.finish-title')?.textContent.trim() || '',
        body: el.querySelector('.finish-body')?.textContent || ''
      } : null;
    });
    problems.push(...panel.errors().map((e) => `the side panel page threw: ${e}`));
    await collectCsp(panel, ctx.panel);
    if (!card) {
      problems.push('the side panel shows no final card');
    } else {
      // What must never happen is a card that disagrees with what the task expected: a run that
      // was meant to fail showing the green "Done" the user would trust. expect.title says which
      // card this task's ending deserves, so one comparison covers both directions.
      if (expect.title && card.title !== expect.title) problems.push(`the side panel card is titled ${JSON.stringify(card.title)}, expected ${JSON.stringify(expect.title)}`);
      for (const cls of expect.classes || []) {
        if (!card.classes.includes(cls)) problems.push(`the side panel card has classes [${card.classes.join(' ')}], expected "${cls}"`);
      }
      // What the card says. A run whose answer was a JSON object must show the sentence inside
      // it, so the check is on the text the user reads, not on the text the model wrote.
      for (const [what, pattern] of Object.entries(expect.body || {})) {
        if (!new RegExp(pattern, 'i').test(card.body)) {
          problems.push(`the side panel card body does not ${what}: it reads ${JSON.stringify(card.body.slice(0, 200))}`);
        }
      }
      // What the card must not show. Raw JSON in the answer is the thing the user would have to
      // read through, so its absence is a check, not a nicety.
      for (const pattern of expect.noBody || []) {
        if (new RegExp(pattern, 'i').test(card.body)) {
          problems.push(`the side panel card body shows ${JSON.stringify(pattern)}, which the user should never have to read`);
        }
      }
    }
  } finally {
    ctx.panel.pageErrors.push(...panel.errors());
    await panel.close(); // Chrome owns the real panel: the harness only lets go of it
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// A task
// ---------------------------------------------------------------------------------------------

/**
 * The log entries of this run. The worker keeps one log buffer for every run since it started, and
 * the state answer carries all of it, so the run's own part starts at the engine's START_TASK
 * line for this tab. That part is complete and in order at the moment the state was read. The
 * copy that arrived through the port is only the fallback (buffer wrapped, line not found): the
 * port and the state answer are two channels, and the port may still have entries in flight.
 */
function logsOfRun(stateLogs, portLogs, tabId) {
  const marker = new RegExp(`^Started the task [\\s\\S]* on tab \\[${tabId}\\]$`);
  const at = (stateLogs || []).findLastIndex((entry) => entry && marker.test(String(entry.message)));
  return at >= 0 ? stateLogs.slice(at) : (portLogs || []);
}

/**
 * A custom provider (LISA) is added the way a user adds it: Settings > LLM Provider > "Custom
 * endpoint…", the "Custom model API" dialog filled in, "Fetch available models" (a real request,
 * through the key proxy, to the server's model list), then "Add provider". The run then uses the
 * descriptor the dialog stored, so a broken dialog fails the run instead of being bypassed.
 *
 * The dialog is shot in light and dark, with the fetched models listed.
 */
async function addCustomProvider(ctx, llm) {
  const custom = REAL.custom;
  const baseUrl = proxiedBaseUrl(REAL, llm.url);
  const result = { id: custom.id, baseUrl, fetchStatus: null, models: [], stored: null, screenshots: [], problems: [] };
  const shotDir = args['panel-screenshots'] ? path.resolve(String(args['panel-screenshots'])) : path.join(SHOT_ROOT, 'provider-setup');
  const page = await ctx.browser.newPage();
  try {
    await watchPanelPage(page, ctx.panel);
    await page.setViewport({ width: 400, height: 900 });
    await page.goto(`chrome-extension://${ctx.extensionId}/sidepanel/sidepanel.html`, { waitUntil: 'load' });
    await page.click('.nav-btn[data-tab="settings"]');
    await page.waitForSelector('#providerSelect', { visible: true, timeout: 8000 });
    await page.select('#providerSelect', '__custom_provider__');
    await page.waitForSelector('#cpOverlay', { visible: true, timeout: 5000 });
    const type = async (selector, text) => {
      await page.click(selector, { clickCount: 3 });
      await page.type(selector, text);
    };
    await type('#cpIdInput', custom.id);
    await type('#cpNameInput', custom.displayName);
    await type('#cpBaseUrlInput', baseUrl);
    await page.click(custom.protocol === 'anthropic' ? '#cpProtocolAnthropic' : '#cpProtocolOpenai');
    await type('#cpApiKeyInput', PLACEHOLDER_KEY);
    await type('#cpTimeoutInput', String(REAL.llmTimeoutMs));
    await page.click('#btnCpFetchModels');
    await page.waitForFunction(() => {
      const t = document.getElementById('cpFetchStatus').textContent;
      return !!t && !/^Fetching/.test(t);
    }, { timeout: 30000 }).catch(() => { /* judged below */ });
    result.fetchStatus = await page.$eval('#cpFetchStatus', (el) => el.textContent);
    result.models = await page.$$eval('#cpModelsList .cp-model-id', (els) => els.map((el) => el.textContent));
    fs.mkdirSync(shotDir, { recursive: true });
    // Tall enough that the dialog (max-height: 100%) does not scroll, so the shot shows every field and model.
    await page.setViewport({ width: 400, height: 2000 });
    for (const scheme of ['light', 'dark']) {
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
      await sleep(400); // the theme transition, so the shot shows the settled colours
      const file = path.join(shotDir, `provider-setup-${custom.id}-dialog-${scheme}.png`);
      await (await page.$('#cpDialog')).screenshot({ path: file });
      result.screenshots.push(file);
    }
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    await page.setViewport({ width: 400, height: 900 });
    await page.click('#btnCpSave');
    await page.waitForSelector('#cpOverlay', { hidden: true, timeout: 5000 }).catch(() => { /* judged below */ });
    result.formError = await page.$eval('#cpError', (el) => (el.style.display === 'none' ? '' : el.textContent)).catch(() => '');
    result.stored = await page.evaluate((id, key) => chrome.storage.local.get('agent_settings').then(({ agent_settings: s }) => ({
      descriptor: (s && s.customProviders && s.customProviders[id]) || null,
      customProviders: (s && s.customProviders) || {},
      keyIsPlaceholder: !!(s && s.providerConfigs && s.providerConfigs[id] && s.providerConfigs[id].apiKey === key)
    })), custom.id, PLACEHOLDER_KEY);
    await collectCsp(page, ctx.panel);
  } finally {
    await page.close().catch(() => {});
  }
  if (!result.models.includes(MODEL)) result.problems.push(`"Fetch available models" listed ${JSON.stringify(result.models)}, not the run's model "${MODEL}" (status: ${JSON.stringify(result.fetchStatus)})`);
  if (result.formError) result.problems.push(`"Add provider" showed an error: ${result.formError}`);
  const d = result.stored && result.stored.descriptor;
  if (!d) {
    result.problems.push(`"Add provider" stored no custom provider "${custom.id}"`);
  } else {
    if (d.protocol !== custom.protocol) result.problems.push(`the stored protocol is ${JSON.stringify(d.protocol)}, expected ${JSON.stringify(custom.protocol)}`);
    if (d.baseUrl !== baseUrl) result.problems.push(`the stored base URL is ${JSON.stringify(d.baseUrl)}, expected ${JSON.stringify(baseUrl)}`);
    if (!d.models.includes(MODEL)) result.problems.push(`the stored model list ${JSON.stringify(d.models)} lacks "${MODEL}"`);
    if (d.llmTimeoutMs !== REAL.llmTimeoutMs) result.problems.push(`the stored timeout is ${JSON.stringify(d.llmTimeoutMs)}, expected ${REAL.llmTimeoutMs}`);
    if (!result.stored.keyIsPlaceholder) result.problems.push('the key typed into the dialog was not stored as the provider\'s credential');
  }
  ctx.customProviders = (result.stored && result.stored.customProviders) || {};
  return result;
}

/**
 * Saves the settings the extension runs with. Same shape the side panel's own save writes: the panel
 * header shows providerConfigs[provider].model, the engine uses the top-level model.
 *
 * What makes a graph run the same every time: the engine kind, the model and its server, the hard step cap
 * (maxSteps, the base of the step budget) and the effort level (effortDefault; START_TASK asks for the same level
 * too, because the engine reads the words of a task when the level is "auto").
 */
async function saveSettings(ctx, llm, model) {
  // A real OpenAI-compatible server (lib/providers.mjs): the extension talks to the local key proxy
  // and holds only a placeholder key; the proxy adds the real one. A custom provider keeps the
  // descriptor its dialog created (addCustomProvider). Ollama speaks its own API.
  const connection = REAL
    ? providerSettings(REAL, llm.url, model, ctx.customProviders || {})
    : { provider: 'ollama', baseUrl: llm.url, apiKey: '', providerConfigs: { ollama: { baseUrl: llm.url, apiKey: '', model } } };
  await ctx.driver.evaluate(async (settings) => {
    await chrome.storage.local.set({ agent_settings: settings });
  }, { ...connection, model, maxSteps: MAX_STEPS, effortDefault: EFFORT });
  ctx.model = model;
}

/**
 * The real-model tasks whose sites do not answer (task.reachable), each with the reason. One GET
 * per address with a 10 s timeout; any HTTP answer counts as reachable (a 403 to a bare fetch is
 * still a site that is up), only a network error or the timeout does not.
 */
async function unreachableTasks(names) {
  const out = [];
  for (const name of names) {
    for (const url of TASKS[name].reachable || []) {
      const why = await fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(10000) })
        .then(() => null, (err) => String((err && err.cause && err.cause.code) || (err && err.message) || err));
      if (why) {
        out.push({ task: name, reason: `unreachable: ${url} did not answer (${why})` });
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The holds of the engine, answered like a user at the side panel
// ---------------------------------------------------------------------------------------------

/** The names of the holds a state shows (the engine waits for a person at each). */
function holdsOf(state) {
  return [
    state.pendingApproval && 'plan',
    state.pendingConfirm && 'confirm',
    state.pendingQuestion && 'question',
    state.pendingChallengeHelp && 'challenge',
    state.pendingContinueBudget && 'budget'
  ].filter(Boolean);
}

/**
 * Sends one message to the worker the way the side panel does, and does not wait for the answer: the answer to
 * APPROVE_PLAN, CONFIRM_ACTION and the other resumes comes only when the engine has driven the run on to its next
 * stop, which can be the end of the run. The answers are kept on the driver page, and the report shows them.
 */
function fire(ctx, message) {
  return ctx.driver.evaluate((m) => {
    window.__replies = window.__replies || [];
    chrome.runtime.sendMessage(m).then(
      (reply) => { window.__replies.push({ action: m.action, reply }); },
      (err) => { window.__replies.push({ action: m.action, error: String((err && err.message) || err) }); }
    );
  }, message);
}

/** The hosts of the fixture site: a confirmation to navigate to one of them is approved. */
function fixtureHostsOf(fixtures) {
  return [new URL(fixtures.origin).hostname.toLowerCase()];
}

/**
 * Answers every hold the state shows that has not been answered yet, the way a user would, and writes what it did into
 * run.decisions (the report prints them):
 *   - the plan card: not expected (START_TASK always asks for autoApprove), so a plan hold is a problem; it is still approved so the run can end;
 *   - a confirmation: approve when it is a navigation to a host of the task's fixture site, deny everything else;
 *   - a question: answer it only when the task defines an answer for it, else stop the run and fail it (the harness never
 *     makes an answer up);
 *   - a bot check that asks for help: skip the site (the harness never solves a bot check);
 *   - a budget question: finish the site, never spend more.
 * A hold is answered once, and armed again when the state no longer shows it.
 */
async function answerHolds(ctx, run, task, tabId, state, hosts) {
  const decide = async (hold, decision, detail, message) => {
    run.decisions.push({ atMs: Date.now() - run.startedAt, hold, decision, detail });
    if (message) await fire(ctx, { ...message, tabId });
  };
  const once = (hold, shown) => {
    if (!shown) { run.armed[hold] = true; return false; }
    if (!run.armed[hold]) return false;
    run.armed[hold] = false;
    return true;
  };

  if (once('plan', state.pendingApproval)) {
    const approval = state.pendingApproval;
    const steps = (approval.plan || []).map((s) => String(s));
    const summary = steps.length ? `${steps.length} step(s): ${steps.map((s) => oneLine(s, 60)).join(' | ')}` : 'no steps';
    // Auto mode must never stop here; a hold that appears anyway is a real failure, not a
    // reason to quietly approve it.
    run.problems.push('the run stopped at a plan even though auto-approve was on');
    await decide('plan', 'approve', summary, { action: 'APPROVE_PLAN', payload: { decision: 'approve' } });
  }

  if (once('confirm', state.pendingConfirm)) {
    const c = state.pendingConfirm;
    const target = String(c.targetDomain || '').toLowerCase().replace(/^www\./, '');
    const approve = c.variant === 'navigate' && !!target && hosts.some((h) => target === h || target.endsWith(`.${h}`));
    await decide('confirm', approve ? 'approve' : 'deny', `${c.variant}: ${c.actionSummary} (target ${c.targetDomain || 'none'}, page ${c.pageUrl})`,
      { action: 'CONFIRM_ACTION', payload: { decision: approve ? 'approve' : 'reject' } });
  }

  if (once('question', state.pendingQuestion)) {
    const question = String(state.pendingQuestion);
    const known = (task.answers || []).find((a) => a.match.test(question));
    if (known) {
      await decide('question', 'answer', `"${oneLine(question, 120)}" -> "${known.answer}"`, { action: 'ANSWER_QUESTION', payload: { answer: known.answer } });
    } else {
      run.problems.push(`the run asked the user "${oneLine(question, 200)}" and the task defines no answer for it`);
      run.stopped = 'unanswered question';
      await decide('question', 'stop the run', `"${oneLine(question, 120)}" has no answer in the task`, { action: 'STOP_TASK' });
    }
  }

  if (once('challenge', state.pendingChallengeHelp)) {
    const c = state.pendingChallengeHelp;
    await decide('challenge', 'skip the site', `${c.domain}: ${oneLine(c.reason, 120)}`, { action: 'RESOLVE_CHALLENGE', payload: { action: 'skip' } });
  }

  if (once('budget', state.pendingContinueBudget)) {
    const b = state.pendingContinueBudget;
    await decide('budget', 'finish the site', `${b.domain} used ${b.stepsUsed} steps`, { action: 'CONTINUE_BUDGET', payload: { action: 'finish' } });
  }
}

// ---------------------------------------------------------------------------------------------
// Running one task
// ---------------------------------------------------------------------------------------------

/** How many user_goal entries a history has: one per task started in the tab. */
const goalsIn = (state) => ((state && state.history) || []).filter((h) => h.type === 'user_goal').length;

/**
 * Starts one task in the tab the way the side panel does (START_TASK), answers its holds like a user, and waits until
 * the run has ended. Returns what the run left behind. The start of the run is a NEW user_goal entry, not just any
 * user_goal in the history, so a tab that already ran a task is read right too.
 *
 * @param {object} task  the task: its answers to questions are used for the holds
 * @param {{name: string, dir: string, list: object[]} | null} shot  where the mid-run panel screenshot goes, or null
 */
async function driveTask(ctx, llm, task, tabId, hosts, shot) {
  // Listen like a side panel attached to that tab would: same port name, same messages.
  await ctx.driver.evaluate((id) => {
    window.__logs = [];
    window.__states = [];
    window.__replies = [];
    if (window.__port) window.__port.disconnect();
    window.__port = chrome.runtime.connect({ name: `scoutfox_sidepanel:${id}` });
    window.__port.onMessage.addListener((m) => {
      if (m.type === 'LOG_ENTRY') window.__logs.push(m.payload);
      // Every state the runner broadcasts is what the side panel renders from. Only the few fields that decide whether a
      // pause has a reason are kept (a payload carries the whole history, and there is one per stream chunk).
      if (m.type === 'STATE_UPDATE' && m.payload) {
        const p = m.payload;
        window.__states.push({
          status: p.status,
          pauseReason: p.pauseReason == null ? null : p.pauseReason,
          hold: !!(p.pendingQuestion || p.pendingApproval || p.pendingConfirm || p.pendingChallengeHelp || p.pendingContinueBudget)
        });
      }
    });
  }, tabId);

  const getState = () => ctx.driver.evaluate((id) => chrome.runtime.sendMessage({ action: 'GET_AGENT_STATE', tabId: id }), tabId);
  const stop = () => ctx.driver.evaluate((id) => chrome.runtime.sendMessage({ action: 'STOP_TASK', tabId: id }), tabId);
  const goalsBefore = goalsIn(await getState());
  const firstCall = llm.calls.length;
  const tallyBefore = await readTally(ctx);
  const startedAt = Date.now();
  // The panel's own choice: autonomous, no manual plan approval.
  const started = await ctx.driver.evaluate((id, prompt, effort) => chrome.runtime.sendMessage({
    action: 'START_TASK', tabId: id, payload: { prompt, effort, autoApprove: true }
  }), tabId, task.prompt, EFFORT);
  if (!started || !started.success) throw new Error(`START_TASK was rejected: ${JSON.stringify(started)}`);

  // START_TASK answers before the engine flips to "running", so the end of the run is the first
  // status that is neither "running" nor "paused" AFTER the run started ("paused" is a hold: a confirmation,
  // a question, a challenge, a budget question). A fast run can begin and end between
  // two polls, so "started" is also read from the history: the turn's user_goal entry is written right after
  // the status becomes "running", and this run's is the one after the goalsBefore entries the tab already had.
  const run = { startedAt, decisions: [], problems: [], armed: { plan: true, confirm: true, question: true, challenge: true, budget: true }, stopped: null };
  let state = null;
  let seenRunning = false;
  let liveShotTaken = false;
  let timedOut = false;
  let pausedSince = null;
  for (;;) {
    state = await getState();
    const holds = holdsOf(state);
    const running = state.status === 'running';
    const begun = seenRunning || running || holds.length > 0 || goalsIn(state) > goalsBefore;
    // A plan is visible only while it is live: the checklist once the run is moving, or the
    // approval card while manual mode waits. Catch whichever comes first, once.
    if (shot && shot.dir && !liveShotTaken && ((state.planSteps || []).length || state.pendingApproval)) {
      liveShotTaken = true;
      shot.list.push(...await panelScreenshots(ctx, tabId, `${shot.name}-live`, shot.dir));
    }
    if (running) {
      seenRunning = true;
    } else if (begun && state.status !== 'paused') {
      break;
    }
    if (state.status === 'paused') {
      if (holds.length) {
        pausedSince = null;
        await answerHolds(ctx, run, task, tabId, state, hosts);
        if (run.stopped) break;
      } else {
        // Paused by the user or by a failure: nobody is going to resume it.
        pausedSince = pausedSince ?? Date.now();
        if (Date.now() - pausedSince > PAUSE_GRACE_MS) {
          run.problems.push('the run is paused and shows no hold that the harness can answer');
          run.stopped = 'paused with no hold';
          await stop();
          break;
        }
      }
    } else {
      pausedSince = null;
    }
    const waited = Date.now() - startedAt;
    if (!begun && waited > 15000) {
      throw new Error(`The engine did not start the run within 15 s of START_TASK (status "${state.status}").`);
    }
    if (waited > (args.timeout ? TASK_TIMEOUT_MS : task.timeoutMs || TASK_TIMEOUT_MS)) {
      timedOut = true;
      run.stopped = 'timeout';
      await stop();
      break;
    }
    await sleep(POLL_MS);
  }
  // The harness stopped it: the state read above is from before the Stop, so read it again (the engine settles in a moment).
  if (run.stopped) {
    await sleep(500);
    state = await getState();
  }
  const wallMs = Date.now() - startedAt;
  const logs = logsOfRun(state.logs, await ctx.driver.evaluate(() => window.__logs), tabId);
  const replies = await ctx.driver.evaluate(() => window.__replies || []);
  // An answer of the harness that the engine refused would leave the run standing at its hold, so it is a problem of its own.
  for (const reply of replies) {
    if (reply.error || (reply.reply && reply.reply.success === false)) {
      run.problems.push(`the engine refused the answer of the harness to ${reply.action}: ${oneLine(reply.error || reply.reply.error || reply.reply, 160)}`);
    }
  }

  // The status of every broadcast of the run. A fast run can last about two seconds, so the 3 s "standing pause" check above can
  // never see a pause that is wrong for only part of the run; this reads each state the panel was sent instead. A pause is
  // fine when somebody has to answer something (a hold) or the user paused; anything else is a Resume button with no
  // reason, which is what users reported ("it stops after every task and I have to press Resume").
  const states = await ctx.driver.evaluate(() => window.__states || []);
  const stateStatuses = {};
  for (const st of states) stateStatuses[st.status] = (stateStatuses[st.status] || 0) + 1;
  const strayPause = states.find((st) => st.status === 'paused' && !st.hold && st.pauseReason !== 'user');
  if (strayPause) {
    run.problems.push(`the runner reported "paused" with no hold to answer and no user pause (pauseReason ${JSON.stringify(strayPause.pauseReason)}): the panel shows a Resume button with no reason`);
  }
  if (states.length === 0) {
    run.problems.push('no STATE_UPDATE reached the harness port, so the paused-without-a-reason check could not look at anything');
  }

  const calls = llm.calls.slice(firstCall);
  const tally = tallyDelta(await readTally(ctx), tallyBefore);
  // What the engine did, as facts (lib/tasks.mjs): the final entry of the LAST turn, the sites and how they ended, the
  // steps, the calls per node.
  const facts = runFacts({ history: state.history || [], planSteps: state.planSteps || [], calls, tally });
  return { state, run, timedOut, wallMs, logs, replies, states, stateStatuses, calls, facts };
}

/**
 * Compact, the way a user does it (a task's followUp.compact): the context ring of the composer must
 * show a share above 0% after the first turn, a real click on the ring opens its card, a real click
 * on "Compact chat" asks the model for the summary, and the timeline must then show the "Chat
 * compacted" divider. The ring, the open card and the divider (its summary opened, like a reader
 * does) are shot as close-ups, light and dark. Returns the problems, the screenshots and the
 * summary the runner kept (the follow-up's first request must hold it).
 */
async function compactThroughPanel(ctx, tabId, shotDir, shotName) {
  const out = { problems: [], screenshots: [], ringLabel: '', cardText: '', summary: '' };
  fs.mkdirSync(shotDir, { recursive: true });
  const panel = await panelSurface(ctx, tabId);
  const closeUps = async (selector, what) => {
    for (const scheme of ['light', 'dark']) {
      await panel.setColorScheme(scheme);
      await sleep(400); // the theme transition, so the shot shows the settled colours
      const file = path.join(shotDir, `${shotName}-${what}-${scheme}.png`);
      try {
        await panel.shootElement(selector, file);
        out.screenshots.push(file);
      } catch (err) {
        out.problems.push(`the ${what} close-up (${scheme}) could not be taken: ${oneLine(err.message, 160)}`);
      }
    }
    await panel.setColorScheme('light');
  };
  const ringLabel = () => panel.evaluate(() => document.getElementById('btnContext')?.getAttribute('aria-label') || '');
  try {
    // The ring after the first turn: the chat has a turn, so the next request is more than nothing.
    await pollUntil(async () => (/^Context: (<1|[1-9]\d*)% of /.test(await ringLabel()) ? 'ok' : ''), 8000);
    out.ringLabel = await ringLabel();
    if (!/^Context: (<1|[1-9]\d*)% of /.test(out.ringLabel)) out.problems.push(`after the first turn the context ring says ${JSON.stringify(out.ringLabel)}, expected a share above 0%`);
    await closeUps('#composer', 'context-ring');

    await panel.click('#btnContext');
    const opened = await pollUntil(() => panel.evaluate(() => {
      const menu = document.getElementById('contextMenu');
      return menu && !menu.hidden && menu.querySelector('.ctx-compact') ? 'open' : '';
    }), 4000);
    if (!opened) {
      out.problems.push('a click on the context ring did not open its card');
      return out;
    }
    const card = await panel.evaluate(() => {
      const menu = document.getElementById('contextMenu');
      return { text: menu.innerText, compactOff: menu.querySelector('.ctx-compact').disabled };
    });
    out.cardText = card.text;
    if (card.compactOff) out.problems.push('the card\'s "Compact chat" button is off after a finished turn');
    if (!/This chat/.test(card.text) || !/of \d+(\.\d)?[KM]? ·/.test(card.text)) out.problems.push(`the context card does not show the bar of this chat: ${JSON.stringify(oneLine(card.text, 200))}`);
    if (!/earlier answers of this chat are sent/i.test(card.text)) out.problems.push('the context card does not say that earlier answers are sent with each request');
    await closeUps('#contextMenu', 'context-card');

    await panel.click('#contextMenu .ctx-compact');
    // The summary is a real model call: up to the model's own timeout.
    const tag = await pollUntil(() => panel.evaluate(() => document.querySelector('#timeline .chat-compacted .compact-tag')?.textContent || ''), 180000);
    if (!/Chat compacted/.test(tag)) {
      const toast = await panel.evaluate(() => document.getElementById('toastContainer')?.innerText || '').catch(() => '');
      out.problems.push(`no "Chat compacted" row appeared after "Compact chat"${toast ? ` (the panel said: ${oneLine(toast, 200)})` : ''}`);
      return out;
    }
    // A reader opens the summary under the divider.
    await panel.click('#timeline .chat-compacted .compact-summary > summary');
    await sleep(300);
    const shown = await panel.evaluate(() => document.querySelector('#timeline .chat-compacted .compact-summary')?.open === true);
    if (!shown) out.problems.push('a click on the divider\'s summary line did not open the summary');
    await closeUps('#timeline .chat-compacted', 'compacted');
  } finally {
    ctx.panel.pageErrors.push(...panel.errors());
    await panel.close(); // Chrome owns the real panel: the harness only lets go of it
  }
  const state = await ctx.driver.evaluate((id) => chrome.runtime.sendMessage({ action: 'GET_AGENT_STATE', tabId: id }), tabId);
  const row = [...((state && state.history) || [])].reverse().find((h) => h.type === 'chat_compacted');
  if (!row || !String(row.summary || '').trim()) out.problems.push('the history has no chat_compacted row with a summary');
  else out.summary = String(row.summary);
  return out;
}

/**
 * The second turn of a task with a followUp (tasks.mjs), in the same tab and the same chat: a Compact
 * through the panel first when the task asks for it, then the tab goes to followUp.navigate, then the
 * second prompt is sent like the first. Its own checks: the answer, the outcome, no page reads when
 * noReads is set, the summary in the first request after a Compact, and the panel's end card.
 */
async function runFollowUp(ctx, fixtures, llm, task, tabId, page, hosts, shotDir, shotName, screenshots) {
  const fu = task.followUp;
  const out = { prompt: fu.prompt, problems: [], compact: null, answer: null, answerCorrect: false, facts: null, calls: [], wallMs: 0 };
  if (fu.compact) {
    out.compact = await compactThroughPanel(ctx, tabId, shotDir, shotName);
    out.problems.push(...out.compact.problems);
    screenshots.push(...out.compact.screenshots);
  }
  if (fu.navigate) {
    await page.goto(absolute(fu.navigate, fixtures), { waitUntil: 'load' });
    await page.bringToFront();
  }
  const name = `${shotName}-followup`;
  const turn = await driveTask(ctx, llm, { prompt: fu.prompt, answers: fu.answers || [], timeoutMs: fu.timeoutMs || task.timeoutMs }, tabId, hosts, { name, dir: shotDir, list: screenshots });
  const f = turn.facts;
  out.facts = f;
  out.calls = turn.calls;
  out.answer = f.answer;
  out.wallMs = turn.wallMs;
  out.answerCorrect = !!(f.answer && fu.check(f));
  out.problems.push(...turn.run.problems);
  if (turn.run.stopped) out.problems.push(`the harness stopped the follow-up (${turn.run.stopped})`);
  if (f.outcome !== 'finish') out.problems.push(`the follow-up ended with ${f.outcome || 'no final entry'}, expected a finish`);
  else if (f.finishOutcome !== 'done') out.problems.push(`the follow-up finished with outcome ${JSON.stringify(f.finishOutcome)}, expected "done"`);
  if (!out.answerCorrect) out.problems.push(`the follow-up answer is wrong: ${JSON.stringify(oneLine(f.answer || '', 200))}`);
  if (fu.noReads) {
    const reads = pageReadSteps(f);
    if (reads.length) out.problems.push(`the follow-up read or looked at the page (${reads.map((s) => s.action.action).join(', ')}); its answer must come from the chat`);
  }
  if (fu.compact && out.compact && out.compact.summary) {
    const first = turn.calls[0];
    const sent = String((first && first.firstUserText) || '');
    if (!first) out.problems.push('the follow-up made no model call');
    else if (!sent.startsWith('EARLIER IN THIS CHAT')) out.problems.push(`the first request of the follow-up does not start with the chain: ${JSON.stringify(oneLine(sent, 120))}`);
    else if (!sent.includes(out.compact.summary.trim())) out.problems.push('the first request of the follow-up does not hold the summary of the Compact');
  }
  out.problems.push(...effortWireProblems(turn.calls, { provider: PROVIDER, model: MODEL, effort: EFFORT }).map((p) => `follow-up: ${p}`));
  const pageEnd = path.join(shotDir, `${name}-page-end.png`);
  await page.screenshot({ path: pageEnd, fullPage: true }).catch(() => page.screenshot({ path: pageEnd, fullPage: false })).catch((err) => {
    out.problems.push(`the follow-up page end screenshot could not be taken: ${oneLine(err.message, 200)}`);
  });
  screenshots.push(pageEnd);
  screenshots.push(...await panelScreenshots(ctx, tabId, name, shotDir, pageEnd));
  out.problems.push(...(await readPanelCard(ctx, tabId, { title: 'Done' })).map((p) => `follow-up: ${p}`));
  return out;
}

async function runTask(ctx, fixtures, llm, name, attempt = 1) {
  const task = TASKS[name];
  if (!task) throw new Error(`Unknown task "${name}". Known: ${Object.keys(TASKS).join(', ')}`);
  const model = MODEL;
  if (ctx.model !== model) await saveSettings(ctx, llm, model);
  const url = absolute(task.page, fixtures);

  const page = await ctx.browser.newPage();
  const pageErrors = [];
  watchFixturePage(page, pageErrors);
  await page.goto(url, { waitUntil: 'load' });
  await page.bringToFront();
  const tabId = await tabIdFor(ctx.driver, url);
  // Before the run: the page as loaded. After the run (below): the page the task ended on, which
  // is a new document when a click navigated.
  const probes = [await probePage(ctx, page, tabId)];

  const hosts = fixtureHostsOf(fixtures);
  const shotName = `${name}-${model.replace(/[^a-z0-9.]+/gi, '_')}`;
  // Screenshots are part of every run, not an option: each test case gets its folder with the
  // side panel (steps and end result, light and dark) and the end state of the page.
  // A repeated task (--repeat) keeps each attempt's screenshots in a folder of its own.
  const shotRoot = args['panel-screenshots'] ? path.resolve(String(args['panel-screenshots'])) : path.join(SHOT_ROOT, name);
  const shotDir = REPEAT > 1 ? path.join(shotRoot, `run-${attempt}`) : shotRoot;
  const screenshots = [];

  const { state, run, timedOut, wallMs, logs, replies, states, stateStatuses, calls, facts } =
    await driveTask(ctx, llm, task, tabId, hosts, { name: shotName, dir: shotDir, list: screenshots });
  const answer = facts.answer;
  // Before the tab closes: closing it ends its session, and the panel would show nothing.
  // The page end state is taken first so the pair belongs to the same moment.
  const pageEnd = path.join(shotDir, `${shotName}-page-end.png`);
  fs.mkdirSync(shotDir, { recursive: true }); // the panel shot used to make it; this shot comes first now
  // A very tall page (GitHub's releases list) is past what Chromium can capture in one full-page
  // picture ("Unable to capture screenshot"): the visible viewport is then the evidence instead.
  await page.screenshot({ path: pageEnd, fullPage: true }).catch(() => page.screenshot({ path: pageEnd, fullPage: false })).catch((err) => {
    // A missing page screenshot is a hole in the evidence, so it is reported, not swallowed.
    ctx.pageShotProblems = ctx.pageShotProblems || [];
    ctx.pageShotProblems.push(`${shotName}: the page end screenshot could not be taken: ${oneLine(err.message, 200)}`);
  });
  screenshots.push(pageEnd);
  // One image per task: the page the task ran on, next to Chrome's real side panel.
  screenshots.push(...await panelScreenshots(ctx, tabId, shotName, shotDir, pageEnd));
  // Every run is checked where the user reads its ending: the card at the end of the thread, on
  // Chrome's real panel. What the card must say follows from how the run ended, so a run that did
  // not finish can never get away with the green "Done" a user would trust. A run with a failed
  // step is a failed run, even when the model finished with an answer: the answer being honest
  // about the failure does not make the task a success.
  // The title the card deserves follows from how the run ended. A task may add its own checks on
  // what the card says (expectCard.body, expectCard.noBody) and may override the title.
  const expectCard = {
    // A run the harness stopped (a timeout) without a final entry ends like a user's Stop.
    title: run.stopped && (!facts.outcome || facts.outcome === 'partial_result') && !facts.failed
      ? 'Stopped by you'
      : task.expectOutcome && task.expectOutcome !== 'finish'
      ? 'Failed'
      // A finish that said how the run went: the card follows the outcome, a failed step is only a note.
      : facts.outcome === 'finish' && OUTCOME_TITLE[facts.finishOutcome]
      ? OUTCOME_TITLE[facts.finishOutcome]
      : (facts.failed ? 'Failed' : (facts.unconfirmed ? 'Unconfirmed answer' : 'Done')),
    ...(task.expectCard || {})
  };
  const cardProblems = await readPanelCard(ctx, tabId, expectCard);
  // Element badges are off: whatever the run did, the page must not end with numbers drawn on it.
  const badgeCount = await Promise.race([
    page.evaluate(() => document.querySelectorAll('.scoutfox-badge').length),
    sleep(5000).then(() => { throw new Error('the page did not answer the badge count within 5 s'); })
  ]).catch((err) => { console.log(`badge check: ${err.message}`); return 0; });
  const badgeProblems = badgeCount > 0 ? [`the page shows ${badgeCount} numbered element badge(s), but element badges are off`] : [];
  const restartProblems = task.restartWorker ? await restartWorkerAndReadCard(ctx, tabId, expectCard) : [];
  const logProblems = task.expectLogs ? await checkLogsTab(ctx, tabId, shotName, shotDir, screenshots) : [];
  // The effort is the model's reasoning level: every request of the run must carry it.
  const effortProblems = effortWireProblems(calls, { provider: PROVIDER, model, effort: EFFORT });
  // A task can ask the page itself for evidence of what the run did (a consent cookie set by the
  // banner's own button): the page is the witness, not the history the engine wrote.
  const pageProblems = task.expectPage
    ? await Promise.race([task.expectPage(page), sleep(10000).then(() => ['the page did not answer the page check within 10 s'])]).catch((err) => [`the page check failed: ${oneLine(err.message, 200)}`])
    : [];
  // A second turn in the same tab and chat (task.followUp): the chain, after a Compact through the panel.
  const followUp = task.followUp ? await runFollowUp(ctx, fixtures, llm, task, tabId, page, hosts, shotDir, shotName, screenshots) : null;
  // Chromium's own error page (a host that does not resolve) never gets content scripts, so there is nothing to probe there.
  if (page.url() !== probes[probes.length - 1].url && !page.url().startsWith('chrome-error://')) probes.push(await probePage(ctx, page, tabId));
  await sleep(300); // late page errors
  await page.close();

  const expectOutcome = task.expectOutcome || 'finish';
  return {
    task: name,
    attempt,
    model,
    startUrl: url,
    prompt: task.prompt,
    status: state.status,
    timedOut,
    stopped: run.stopped,
    outcome: facts.outcome,
    expectOutcome,
    finishOutcome: facts.finishOutcome,
    expectFinishOutcome: expectedFinishOutcome(task),
    unconfirmed: facts.unconfirmed,
    answer,
    answerCorrect: answer ? !!task.check(facts) : false,
    notes: answer && task.warn ? task.warn(facts) : [],
    expectProblems: [...cardProblems, ...badgeProblems, ...restartProblems, ...logProblems, ...effortProblems, ...pageProblems, ...(followUp ? followUp.problems : [])],
    followUp: followUp ? {
      prompt: followUp.prompt,
      answer: followUp.answer,
      answerCorrect: followUp.answerCorrect,
      problems: followUp.problems,
      ringLabel: followUp.compact ? followUp.compact.ringLabel : null,
      summary: followUp.compact ? followUp.compact.summary : null,
      steps: followUp.facts ? followUp.facts.steps : [],
      outcome: followUp.facts ? followUp.facts.outcome : null,
      finishOutcome: followUp.facts ? followUp.facts.finishOutcome : null,
      modelCalls: followUp.calls.length,
      wallMs: followUp.wallMs,
      calls: callsForReport(followUp.calls)
    } : null,
    holdProblems: run.problems,
    stateUpdates: { count: states.length, byStatus: stateStatuses },
    decisions: run.decisions,
    replies,
    facts,
    errors: facts.errors,
    pageErrors,
    probes,
    wallMs,
    modelCalls: calls.length,
    promptTokens: calls.reduce((s, c) => s + (c.promptEvalCount || 0), 0),
    outputTokens: calls.reduce((s, c) => s + (c.evalCount || 0), 0),
    calls,
    screenshots,
    logLines: logs.map((l) => `${l.level} ${l.module}: ${oneLine(l.message, 200)}`),
    warnings: logs.filter((l) => l.level === 'WARN' || l.level === 'ERROR').map((l) => `${l.level} ${oneLine(l.message, 200)}`)
  };
}

/** The calls of a run as a few lines: all of them for a short run, the first three and the last two for a long one. */
function callLines(calls) {
  const lines = [];
  const shown = calls.length <= 8 ? calls : [...calls.slice(0, 3), null, ...calls.slice(-2)];
  for (const c of shown) {
    if (c === null) { lines.push(`  ... ${calls.length - 5} more call(s) ...`); continue; }
    lines.push(`  call ${c.n} (${c.node}${c.mode ? `:${c.mode}` : ''}): ${(c.ms / 1000).toFixed(1)} s, status ${c.status}, format ${c.format}, think ${c.think}, system ${fmtInt(c.systemChars)} chars, request ${fmtInt(c.requestBytes)} B, prompt_eval ${fmtInt(c.promptEvalCount)}, eval ${fmtInt(c.evalCount)}, done ${c.doneReason}`);
    lines.push(`          reply: ${oneLine(c.content, 150)}`);
  }
  return lines;
}

const countsText = (counts) => Object.entries(counts || {}).map(([k, n]) => `${k} x${n}`).join(', ') || 'none';

function printReport(r) {
  const f = r.facts;
  console.log(`\n=== ${r.task}${REPEAT > 1 ? ` (run ${r.attempt} of ${REPEAT})` : ''} (${r.model}) ===`);
  console.log(`start page: ${r.startUrl}`);
  console.log(`prompt:     ${r.prompt}`);
  const how = r.stopped ? `; the harness stopped it (${r.stopped})` : '';
  const outcome = r.outcome === 'finish' ? 'FINISH' : r.outcome === 'partial_result' ? 'PARTIAL RESULT' : `NO FINAL ENTRY (status ${r.status})`;
  console.log(`outcome:    ${outcome}${r.unconfirmed ? ' (unconfirmed)' : ''}, status ${r.status}${how}; expected ${r.expectOutcome}; model's outcome: ${r.finishOutcome || 'none'}${r.expectFinishOutcome ? ` (expected ${r.expectFinishOutcome})` : ''}; answer check: ${r.answerCorrect ? 'PASS' : 'FAIL'}`);
  for (const note of r.notes || []) console.log(`note:       ${note}`);
  if (r.answer) console.log(`answer:     ${oneLine(r.answer, 400)}`);
  for (const p of r.expectProblems) console.log(`run check:  ${oneLine(p, 300)}`);
  for (const p of r.holdProblems) console.log(`hold:       ${oneLine(p, 300)}`);
  console.log(`states:     ${r.stateUpdates.count} state update(s) reached the panel port: ${countsText(r.stateUpdates.byStatus)}`);
  for (const e of r.errors) console.log(`error:      ${oneLine(e, 300)}`);
  for (const p of r.probes) console.log(`page check: ${p.url.replace(/^https?:\/\/[^/]+/, '')} net recorder ${p.recorderActive ? 'active' : 'NOT ACTIVE'}, content script ${p.contentScript ? 'answers' : `DOES NOT ANSWER (${p.contentScriptError})`}`);
  for (const e of r.pageErrors) console.log(`page error: ${oneLine(e, 300)}`);
  console.log(`sites:      ${f.siteEnds.map((s) => `${s.siteId} ${s.status} (${s.findings} finding(s), ${s.stepsUsed} step(s))${s.reason ? `: ${oneLine(s.reason, 100)}` : ''}`).join(' | ') || 'no site ended'}`);
  console.log(`plan (${f.plan.length}): ${f.plan.map((s, i) => `${i + 1}. [${s.status}] ${s.text}`).join(' | ') || 'none'}`);
  if (r.decisions.length) {
    console.log('decisions of the harness:');
    for (const d of r.decisions) console.log(`  +${(d.atMs / 1000).toFixed(1)} s ${d.hold}: ${d.decision} - ${oneLine(d.detail, 200)}`);
  } else {
    console.log('decisions of the harness: none (the engine asked for nothing)');
  }
  for (const reply of r.replies) console.log(`  answer to ${reply.action}: ${oneLine(reply.reply ?? { error: reply.error }, 120)}`);
  console.log(`steps (${f.steps.length}):`);
  for (const s of f.steps.slice(0, 12)) console.log(`  #${s.step} ${s.mode || ''} ${s.action ? oneLine(s.action, 130) : `REJECTED, the engine dropped the reply: ${oneLine(s.raw, 100)}`}${s.result ? ` -> ${oneLine(s.result, 100)}` : ''}`);
  if (f.steps.length > 12) console.log(`  ... ${f.steps.length - 12} more`);
  console.log(`history rows (${f.rows.length}${f.duplicateRows ? `, ${f.duplicateRows} of them exact copies of an earlier row` : ''}): ${countsText(f.rows.reduce((n, h) => { n[h.type] = (n[h.type] || 0) + 1; return n; }, {}))}`);
  console.log(`execution results in the history: ${f.executions}`);
  console.log(`messages the engine sent to the page: ${f.pageMessages ? countsText(f.pageMessages) : 'not counted'}; debugger commands: ${f.cdpCommands ? countsText(f.cdpCommands) : 'not counted'}`);
  console.log(`wall time:  ${(r.wallMs / 1000).toFixed(1)} s`);
  console.log(`model calls: ${r.modelCalls} (by node: ${countsText(f.calls.byNode)}); prompt tokens ${fmtInt(r.promptTokens)}; output tokens ${fmtInt(r.outputTokens)}`);
  for (const line of callLines(r.calls)) console.log(line);
  // The log of the run (from the START_TASK line on): the tags it carries and how often, then its first and last lines.
  const tags = r.logLines.reduce((n, line) => { const tag = /\[([A-Z_]+)\]/.exec(line)?.[1] || 'untagged'; n[tag] = (n[tag] || 0) + 1; return n; }, {});
  console.log(`log of the run (${r.logLines.length} lines): ${countsText(tags)}`);
  for (const line of r.logLines.length <= 10 ? r.logLines : [...r.logLines.slice(0, 6), `... ${r.logLines.length - 9} more line(s) ...`, ...r.logLines.slice(-3)]) console.log(`  ${line}`);
  if (r.warnings.length) {
    console.log(`warnings (${r.warnings.length}):`);
    for (const w of r.warnings.slice(0, 12)) console.log(`  ${w}`);
  }
  if (r.followUp) {
    const fu = r.followUp;
    console.log(`follow-up:  ${oneLine(fu.prompt, 160)}`);
    if (fu.ringLabel !== null) console.log(`  ring after turn 1: ${fu.ringLabel || 'none'}`);
    if (fu.summary !== null) console.log(`  summary of the Compact: ${oneLine(fu.summary || 'none', 300)}`);
    console.log(`  outcome ${fu.outcome || 'none'} (${fu.finishOutcome || 'no outcome'}); answer check: ${fu.answerCorrect ? 'PASS' : 'FAIL'}; ${fu.steps.length} step(s), ${fu.modelCalls} model call(s), ${(fu.wallMs / 1000).toFixed(1)} s`);
    if (fu.answer) console.log(`  answer: ${oneLine(fu.answer, 300)}`);
    for (const s of fu.steps.slice(0, 8)) console.log(`  #${s.step} ${s.action ? oneLine(s.action, 130) : oneLine(s.raw, 100)}${s.result ? ` -> ${oneLine(s.result, 100)}` : ''}`);
  }
  for (const s of r.screenshots) console.log(`panel screenshot: ${s}`);
}

/** What makes this run fail. Empty means pass. */
function judge(ctx, reports, gate) {
  const failures = [];
  // Every panel screenshot must come from Chrome's own side panel. The page fallback renders the
  // same document, but at a width the harness picked, so it verifies less. Falling back is a
  // failure on purpose: it stops the suite from quietly going back to the emulated surface.
  for (const [name, surface] of ctx.panelSurfaces || []) {
    if (surface === 'real Chrome side panel') continue;
    if (surface.includes('headless Chromium')) { ctx.panelWarnings = true; continue; }
    failures.push(`${name}: the panel screenshot came from the fallback, not the real side panel (${surface})`);
  }
  for (const problem of ctx.pageShotProblems || []) failures.push(problem);
  for (const r of reports) {
    if (r.stopped) failures.push(`${r.task}: the harness stopped the run (${r.stopped})`);
    // Every run is judged by the success rule of lib/metrics.mjs (final entry, the model's own outcome, the answer).
    const verdict = runVerdict(r);
    const label = REPEAT > 1 ? `${r.task} (run ${r.attempt})` : r.task;
    // A run the harness stopped is already reported above, with its reason.
    if (verdict && !(!r.outcome && r.stopped)) failures.push(`${label}: ${verdict}`);
    for (const p of r.expectProblems) failures.push(`${r.task}: ${p}`);
    for (const p of r.holdProblems) failures.push(`${r.task}: ${p}`);
    for (const p of r.probes) {
      const where = p.url.replace(/^https?:\/\/[^/]+/, '');
      if (!p.recorderActive) failures.push(`${r.task}: the net recorder (content/net-recorder.js, MAIN world) did not run on ${where}: window.__scoutfox_net_recorder_active is not true`);
      if (!p.contentScript) failures.push(`${r.task}: the content script did not answer GET_DOM_SNAPSHOT on ${where} (${p.contentScriptError})`);
    }
    // On the open web a site's own errors (a 429 from a search engine, a broken analytics script)
    // are the site's, not the extension's: there only an error that names the extension fails.
    const pageErrors = TASKS[r.task]?.web ? r.pageErrors.filter((e) => /chrome-extension:|scoutfox/i.test(e)) : r.pageErrors;
    if (pageErrors.length) failures.push(`${r.task}: the page logged ${pageErrors.length} console error(s) or page error(s): ${oneLine(pageErrors[0], 200)}`);
  }
  if (ctx.workerErrors.length) failures.push(`${ctx.workerErrors.length} service worker or driver page error(s)`);
  if (gate) {
    const p = ctx.panel;
    if (p.consoleErrors.length) failures.push(`side panel: ${p.consoleErrors.length} console error(s)`);
    if (p.pageErrors.length) failures.push(`side panel: ${p.pageErrors.length} page error(s)`);
    if (p.cspViolations.length) failures.push(`side panel: ${p.cspViolations.length} CSP violation(s)`);
    for (const problem of gate.problems) failures.push(`side panel: ${problem}`);
  }
  if (ctx.brand) {
    for (const problem of ctx.brand.problems) failures.push(`side panel: ${problem}`);
  }
  if (ctx.providerSetup) {
    for (const problem of ctx.providerSetup.problems) failures.push(`provider setup: ${problem}`);
  }
  return failures;
}

function printFailureDetails(ctx, reports) {
  for (const r of reports) {
    // A sealed task's page errors name the sites it visited, which is part of its trace.
    if (!r.pageErrors.length || SEALED) continue;
    console.log(`\nfixture page errors of ${r.task} (${r.pageErrors.length}):`);
    for (const e of r.pageErrors.slice(0, 20)) console.log(`  ${oneLine(e, 300)}`);
  }
  if (ctx.workerErrors.length) {
    console.log(`\nservice worker and driver page errors (${ctx.workerErrors.length}):`);
    for (const e of ctx.workerErrors.slice(0, 20)) console.log(`  ${oneLine(e, 300)}`);
  }
  for (const [label, list] of [['console errors', ctx.panel.consoleErrors], ['page errors', ctx.panel.pageErrors], ['CSP violations', ctx.panel.cspViolations]]) {
    if (!list.length) continue;
    console.log(`\nside panel ${label} (${list.length}):`);
    for (const e of list.slice(0, 20)) console.log(`  ${oneLine(e, 300)}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

/** The options, for --help (the header of this file says more about each). */
const HELP = `Usage: node tests/e2e/smoke.mjs [options]   (npm run test:e2e runs it with --build)

  (no option)          the default tasks on LISA: the open-web tasks and the three local fixture-page tasks
  --held-out           the held-out open-web tasks
  --sealed             the sealed open-web tasks: only verdicts and numbers, never a trace
  --task=a,b           these tasks only
  --repeat=k           every task k times (1 to 20), summarised as median and p90
  --provider=name      ${[...REAL_PROVIDER_NAMES, 'ollama'].join(', ')} (default ${DEFAULT_PROVIDER})
  --model=id           the model (default: the provider's default model)
  --effort=level       ${EFFORT_LEVELS.join(', ')} (default medium)
  --build              run npm run build first
  --headful, --headless
  --out=file.json      also save the full report as JSON
  --panel-screenshots=dir   where the screenshots go (default tests/e2e/screenshots/<time>)
  --max-steps=n        the engine's step cap (default 60)
  --timeout=ms         per task (default: the task's own, else 6 minutes)
  --prompt="..."       one run of your own on a real site (--start-url=, default https://www.google.com)
  --dump-snapshots[=store]  save what the content script sees on the fixture pages (no model needed)

Tasks: ${Object.keys(TASKS).join(', ')}`;

async function main() {
  if (args.help) {
    console.log(HELP);
    return;
  }
  for (const flag of Object.keys(args)) {
    if (!KNOWN_FLAGS.has(flag)) throw new UserError(`Unknown option "${flag}". Known: ${[...KNOWN_FLAGS].map((f) => `--${f}`).join(', ')}`);
  }
  if (!Number.isInteger(REPEAT) || REPEAT < 1 || REPEAT > 20) throw new UserError(`--repeat must be a whole number from 1 to 20, got ${args.repeat}`);
  if (SEALED && args['held-out']) throw new UserError('--sealed runs the sealed open-web tasks; it cannot be combined with --held-out');
  // Naming a sealed task without --sealed would print its trace and unseal it.
  for (const n of args.task ? String(args.task).split(',') : []) {
    if (TASKS[n]?.sealed && !SEALED) throw new UserError(`"${n}" is a sealed task: run it only with --sealed, which shows its verdict and numbers but not its trace`);
  }
  if (!REAL && PROVIDER !== 'ollama') throw new UserError(`--provider must be one of ${[...REAL_PROVIDER_NAMES, 'ollama'].join(', ')}, got ${PROVIDER}`);
  // The default set is every task that is neither held out nor sealed: the open-web tasks (the model picks every
  // site itself) and the three local fixture-page tasks. --held-out runs only the held-out open-web tasks (heldOut),
  // which a plain run leaves out. --sealed runs only the sealed tasks, and shows only their verdicts and numbers.
  const names = args.task
    ? String(args.task).split(',')
    : Object.keys(TASKS).filter((n) => TASKS[n].web && !!TASKS[n].heldOut === !!args['held-out'] && !!TASKS[n].sealed === SEALED);
  for (const name of names) {
    if (!TASKS[name]) throw new UserError(`Unknown task "${name}". Known: ${Object.keys(TASKS).join(', ')}`);
  }
  // A pending task is skipped with its reason and is never a failure: the engine cannot do what it checks yet.
  const skipped = names.filter((n) => TASKS[n].pending).map((n) => ({ task: n, reason: `pending: ${TASKS[n].pending}` }));
  // A real-model task that names the sites it needs (reachable) is skipped when one does not answer:
  // an offline machine or a site outage is not an agent failure.
  const unreachable = await unreachableTasks(names.filter((n) => !TASKS[n].pending));
  skipped.push(...unreachable);
  const runNames = names.filter((n) => !TASKS[n].pending && !unreachable.some((u) => u.task === n));

  const puppeteer = await loadPuppeteer();
  checkChromium();
  if (args.build) await runBuild();
  checkDist();
  if (!args.build) warnIfDistIsStale();

  // The model server. The snapshot dump needs none: it never calls a model.
  const needsModel = !args['dump-snapshots'];
  let env = {};
  if (needsModel && REAL) {
    env = await preflightReal();
    console.log(`${REAL.label} at ${env.url} (${env.models} models listed), model ${MODEL}`);
  } else if (needsModel) {
    env = await preflightOllama();
    console.log(`Ollama ${env.ollamaVersion} at ${OLLAMA}; direct call with a chrome-extension Origin -> ${env.directStatusFromExtensionOrigin} (so the extension uses the proxy)`);
  }
  console.log(`Chromium: ${CHROMIUM}`);

  const fixtures = await listen('fixture server', () => startFixtureServer({ root: SITE, port: FIXTURE_PORT }));
  onCleanup(closeServer(fixtures.server));
  let llm = null;
  if (needsModel) {
    if (REAL) {
      llm = await listen(`${REAL.label} proxy`, () => startKeyProxy({ port: PROXY_PORT, target: REAL.origin, apiKey: REAL.apiKey, label: REAL.label }));
    } else {
      llm = await listen('Ollama proxy', () => startOllamaProxy({ port: PROXY_PORT, target: OLLAMA }));
    }
    onCleanup(closeServer(llm.server));
  }
  console.log(`fixtures at ${fixtures.origin}${llm ? `, ${REAL ? `${REAL.label} proxy` : 'Ollama proxy'} at ${llm.url}` : ''}`);

  // The extension the browser loads: a copy of dist/ plus the two test-only pages, never dist/ itself.
  const copy = prepareExtensionCopy({
    distDir: DIST,
    driverHtml: path.join(HERE, 'driver.html'),
    panelTriggerHtml: path.join(HERE, 'panel-trigger.html'),
    panelTriggerJs: path.join(HERE, 'panel-trigger.js')
  });
  tempDirs.add(copy.dir);
  onCleanup(() => { copy.remove(); tempDirs.delete(copy.dir); });
  console.log(`extension: copy of dist/ in ${copy.dir} (${copy.files.length - 3} shipped files, no sourcemaps, plus driver.html and panel-trigger.html)`);

  const ctx = await launch(puppeteer, copy.dir);
  console.log(`browser ${await ctx.browser.version()}, extension ${ctx.extensionId}`);

  const reports = [];
  let gate = null;
  if (args['dump-snapshots']) {
    await dumpSnapshots(ctx, fixtures, typeof args['dump-snapshots'] === 'string' ? args['dump-snapshots'].split(',') : null);
  } else {
    if (REAL && REAL.custom) {
      ctx.providerSetup = await addCustomProvider(ctx, llm);
      console.log(`provider setup: ${REAL.label} through the "Custom model API" dialog: ${ctx.providerSetup.problems.length ? `FAILED (${ctx.providerSetup.problems.length} problem(s))` : 'added'}; fetch status: ${ctx.providerSetup.fetchStatus}`);
      for (const file of ctx.providerSetup.screenshots) console.log(`panel screenshot: ${file}`);
    }
    await saveSettings(ctx, llm, MODEL);

    for (const { task, reason } of skipped) console.log(`\n=== ${task} === SKIPPED (${reason})`);
    for (const name of runNames) {
      for (let attempt = 1; attempt <= REPEAT; attempt++) {
        const report = await runTask(ctx, fixtures, llm, name, attempt);
        reports.push(report);
        // A sealed task is measured, not read: its steps and answer stay out of the console (see SEALED).
        if (SEALED) console.log(`\n=== ${name} (run ${attempt} of ${REPEAT}) === ${runVerdict(report) ? 'FAILED' : 'ok'}`);
        else printReport(report);
      }
    }
    gate = await checkSidePanel(ctx);
    ctx.brand = await checkBrandMark(ctx);
  }

  console.log('\n=== summary ===');
  for (const r of SEALED ? [] : reports) {
    console.log(`${r.task}${REPEAT > 1 ? ` (run ${r.attempt})` : ''}: ${r.outcome || `no final entry (status ${r.status}${r.stopped ? `, stopped: ${r.stopped}` : ''})`}, answer ${r.answerCorrect ? 'right' : 'wrong'}, ${r.facts.steps.length} step(s), ${(r.wallMs / 1000).toFixed(1)} s, ${r.modelCalls} model call(s) (by node: ${countsText(r.facts.calls.byNode)}), ${fmtInt(r.promptTokens)} prompt + ${fmtInt(r.outputTokens)} output tokens`);
  }
  if (!args['dump-snapshots']) for (const { task, reason } of skipped) console.log(`${task}: skipped (${reason})`);
  if (reports.length) {
    console.log(`\n=== per task (${REPEAT} run${REPEAT === 1 ? '' : 's'} each; median/p90) ===`);
    for (const line of aggregateLines(aggregate(reports))) console.log(line);
  }
  console.log(`service worker errors (console, exceptions, CSP violations): ${ctx.workerErrors.length}`);
  if (reports.length) {
    const probes = reports.flatMap((r) => r.probes);
    console.log(`fixture pages: ${probes.length} page check(s), ${probes.filter((p) => p.recorderActive).length} with the net recorder active, ${probes.filter((p) => p.contentScript).length} with the content script answering, ${reports.reduce((n, r) => n + r.pageErrors.length, 0)} console or page errors`);
  }
  if (gate) {
    const p = ctx.panel;
    console.log(`side panel (${gate.url.replace(/^chrome-extension:\/\/[a-z]+/, 'chrome-extension://<id>')}): ${p.consoleErrors.length} console errors, ${p.pageErrors.length} page errors, ${p.cspViolations.length} CSP violations; model badge ${JSON.stringify(gate.badge)}, model list "${gate.modelStatus}"`);
  }
  if (ctx.brand) {
    const b = ctx.brand;
    console.log(`fox mark: header ${b.header ? `${b.header.width}x${b.header.height} px` : 'missing'}, middle of the panel ${b.middle ? `${b.middle.width}x${b.middle.height} px` : 'missing'}`);
  }
  const surfaces = [...(ctx.panelSurfaces || new Map()).entries()];
  if (surfaces.length) {
    const realCount = surfaces.filter(([, s]) => s === 'real Chrome side panel').length;
    console.log(`panel screenshots: ${realCount} of ${surfaces.length} taken on Chrome's real side panel`);
    if (ctx.panelWarnings) console.log('  (headless run: Chrome creates no side panel, so these are the panel page at 400 px - run without --headless to verify the real panel)');
    for (const [name, s] of surfaces) if (s !== 'real Chrome side panel') console.log(`  ${name}: ${s}`);
  }
  printFailureDetails(ctx, reports);

  const failures = judge(ctx, reports, gate);
  if (args.out) {
    // A run that loops makes thousands of calls: the report keeps the first five and the last three of each task, and the count.
    const trimmed = reports.map((r) => ({ ...r, callCount: r.calls.length, calls: callsForReport(r.calls), logLines: r.logLines.length <= 40 ? r.logLines : [...r.logLines.slice(0, 25), ...r.logLines.slice(-15)] }));
    fs.writeFileSync(path.resolve(String(args.out)), JSON.stringify({
      env, provider: PROVIDER, model: MODEL, repeat: REPEAT, sealed: SEALED, skipped, aggregate: aggregate(reports), reports: SEALED ? [] : trimmed, workerErrors: ctx.workerErrors, panel: { ...ctx.panel, gate }, brand: ctx.brand || null, providerSetup: ctx.providerSetup || null, failures
    }, null, 2));
    console.log(`report saved to ${args.out}`);
  }
  if (failures.length) {
    console.log(`\nSMOKE FAILED (${failures.length} problem${failures.length === 1 ? '' : 's'}):`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  } else {
    const taskCount = new Set(reports.map((r) => r.task)).size;
    console.log(`\nSMOKE PASSED${reports.length ? ` (${taskCount} task${taskCount === 1 ? '' : 's'}${REPEAT > 1 ? `, ${reports.length} runs` : ''}, side panel clean, worker clean, fixture pages clean)` : ''}`);
  }
}

try {
  await main();
} catch (err) {
  if (err instanceof UserError) console.error(`\nerror: ${err.message}`);
  else console.error(`\nerror: ${err && err.stack ? err.stack : err}`);
  process.exitCode = 1;
} finally {
  await cleanup();
  // Everything is closed by now. If a handle still keeps the process alive, do not hang a CI job.
  setTimeout(() => process.exit(process.exitCode || 0), 5000).unref();
}
