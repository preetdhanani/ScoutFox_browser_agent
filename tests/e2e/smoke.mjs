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
 * The model server is one of two:
 *   --mock   an offline, scripted stand-in for Ollama (lib/mockOllama.mjs). No model and no
 *            Ollama needed. This is what CI runs (`npm run test:e2e`). It speaks the protocol of the
 *            LangGraph engine (plan, policy per mode, reflect). It cannot drive the old engine any more.
 *   default  a small proxy in front of a real local Ollama (lib/ollamaProxy.mjs, see there for
 *            why a proxy is needed).
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
 * Run:    node smoke.mjs --mock                    offline, all tasks, no model needed
 *         node smoke.mjs --mock --build            build first, then the same (npm run test:e2e)
 *         node smoke.mjs                           all tasks with qwen3.5:9b on the real Ollama
 *         node smoke.mjs --task=store-price        one task (or a comma list)
 *         node smoke.mjs --model=gemma4:12b
 *         node smoke.mjs --headful                 watch it in a real window
 *         node smoke.mjs --out=report.json         also save the full report as JSON
 *         node smoke.mjs --panel-screenshots=dir   save the side panel (light and dark) per task
 *         node smoke.mjs --max-steps=30            the engine's step cap for a task
 *         node smoke.mjs --timeout=360000          per task, in milliseconds
 *         node smoke.mjs --dump-snapshots          save what the content script sees on each
 *                                                  fixture page to tests/fixtures/snapshots/
 *                                                  (the evals read these files; no model needed).
 *                                                  The pages that a task serves under another host
 *                                                  name (shop-a.html) go to tests/e2e/lib/snapshots/.
 *         node smoke.mjs --dump-snapshots=shop-a   only the pages named here
 *   --build   runs `npm run build` first (a child process this script owns), so dist/ is fresh.
 *   --mock    uses the offline mock. It first runs the mock's own quick self-test, and it also
 *             skips the Ollama preflight and the proxy.
 *   --tamper=<name>   makes one deliberate break in the temp COPY (never in dist/) to prove that
 *             this run can fail: no-content-script, worker-error, broken-panel, empty-page-text,
 *             zod-not-jitless, broken-net-recorder.
 *
 * Needs Chromium (branded Chrome ignores --load-extension) at CHROMIUM_PATH, default
 * /Applications/Chromium.app/Contents/MacOS/Chromium. Real mode also needs Ollama at OLLAMA_URL,
 * default http://127.0.0.1:11434, with the model already pulled.
 * Other environment variables: FIXTURE_PORT (8765; the committed snapshots contain this port),
 * PROXY_PORT (11435, also the port of the mock) and CHROMIUM_ARGS (extra Chromium flags,
 * separated by spaces, for example --no-sandbox on a Linux CI runner).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from './lib/fixtureServer.mjs';
import { startOllamaProxy } from './lib/ollamaProxy.mjs';
import { missingManifestFiles, prepareExtensionCopy, TAMPERS } from './lib/extensionCopy.mjs';
import { MOCK_FAIL_PREFIX } from './lib/callRecord.mjs';
import { runFacts, TASKS } from './lib/tasks.mjs';
import { HOST_RULES, SHOP_B } from './lib/twoSources.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const DIST = path.join(REPO, 'dist');
const SITE = path.join(REPO, 'tests', 'fixtures', 'site');
const SNAPSHOT_DIR = path.join(REPO, 'tests', 'fixtures', 'snapshots');
// Pages that a task serves under another host name. The committed fixture snapshots are what the evals
// read, so these go into the e2e folder, where the mock's self-test reads them.
const E2E_SNAPSHOT_DIR = path.join(HERE, 'lib', 'snapshots');

const KNOWN_FLAGS = new Set(['task', 'model', 'headful', 'out', 'panel-screenshots', 'dump-snapshots', 'max-steps', 'timeout', 'build', 'mock', 'tamper']);
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
}));

const MOCK = !!args.mock;
const CHROMIUM = process.env.CHROMIUM_PATH || '/Applications/Chromium.app/Contents/MacOS/Chromium';
const CHROMIUM_ARGS = (process.env.CHROMIUM_ARGS || '').split(/\s+/).filter(Boolean);
const OLLAMA = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
const MODEL = args.model || (MOCK ? 'mock-agent' : 'qwen3.5:9b');
const FIXTURE_PORT = Number(process.env.FIXTURE_PORT || 8765);
const PROXY_PORT = Number(process.env.PROXY_PORT || 11435);
// A mock task takes a few seconds, so a run that hangs should fail early.
const TASK_TIMEOUT_MS = Number(args.timeout || (MOCK ? 60 * 1000 : 6 * 60 * 1000));
// The fixture tasks need 1 to 3 steps. The cap is also the hard cap the graph engine builds its step budget from:
// a Medium site gets up to 24 steps, and with a cap of 30 that budget is not scaled down. So the cap is not lowered to
// the step count of a task. A run that loops is stopped by the loop guard below.
const MAX_STEPS = Number(args['max-steps'] || 30);
// The effort level every task starts with. Without it the engine reads the words of the task ("cheapest" means High).
const EFFORT = 'medium';
const POLL_MS = 250;
// The mock keeps count of identical requests in a row. A model that gets the same prompt this many times in a row
// is in a loop that nothing breaks, and the run is stopped instead of waiting for the task timeout.
const LOOP_LIMIT = 15;
// How long a run may stand paused with no hold the harness can answer, before it is stopped.
const PAUSE_GRACE_MS = 3000;

const SNAPSHOT_PAGES = ['store', 'store-spans', 'search', 'compare', 'challenge', 'error'];
// `page` is the address the task starts on, query included; `name` is the file it is served from.
const HOST_PAGES = Object.values(TASKS).filter((t) => t.host).map((t) => ({ name: t.page.replace(/[?#].*$/, '').replace(/\.html$/, ''), page: t.page, host: t.host }))
  .filter((p, i, all) => all.findIndex((q) => q.name === p.name) === i);

/** The origin of the fixture server as a site of the task's host name (http://shop-a.test:8765), or as it is without one. */
function originFor(fixtures, host) {
  if (!host) return fixtures.origin;
  const url = new URL(fixtures.origin);
  url.hostname = host;
  return url.origin;
}

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

async function preflightOllama() {
  const version = await fetch(`${OLLAMA}/api/version`).then((r) => r.json()).catch(() => null);
  if (!version) {
    throw new UserError(`Ollama is not reachable at ${OLLAMA}. Start it, or run offline with --mock (a scripted stand-in, no model needed).`);
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
 * `new Function('')` probe passed this harness before Audits was watched (--tamper=zod-not-jitless
 * is the control). Audits.enable replays the issues collected so far, like Runtime.enable does.
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
    // shop-b.test is made unresolvable on purpose (twoSources.mjs HOST_RULES), so a run that opens it stands on
    // Chromium's own error page, where no extension script can be injected. The engine logs that at error level
    // (snapshot.ts INJECT_FAILED) and then ends the site without a value; for this one host it is the expected path.
    if (/\[INJECT_FAILED\]/.test(text) && /is showing error page/.test(text) && text.includes(`${SHOP_B}/`)) return;
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
    headless: !args.headful,
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
      '--window-size=1280,900',
      // shop-a.test -> the fixture server (see twoSources.mjs): a task about named sites runs on a page of one of them.
      `--host-resolver-rules=${HOST_RULES}`,
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
  browser.on('targetcreated', (t) => { if (isWorker(t)) void watch(t); });

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
  return { browser, driver, extensionId, workerErrors, worker, panel: newPanelSink() };
}

// ---------------------------------------------------------------------------------------------
// Fixture pages
// ---------------------------------------------------------------------------------------------

async function tabIdFor(driver, url) {
  for (let i = 0; i < 50; i++) {
    const id = await driver.evaluate(async (u) => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((t) => t.url === u);
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

async function dumpSnapshots(ctx, fixtures, only) {
  const pages = [
    ...SNAPSHOT_PAGES.map((name) => ({ name, origin: fixtures.origin, dir: SNAPSHOT_DIR })),
    ...HOST_PAGES.map(({ name, page, host }) => ({ name, page, origin: originFor(fixtures, host), dir: E2E_SNAPSHOT_DIR }))
  ];
  const wanted = only ? pages.filter((p) => only.includes(p.name)) : pages;
  for (const name of only || []) {
    if (!pages.some((p) => p.name === name)) throw new UserError(`Unknown page "${name}" for --dump-snapshots. Known: ${pages.map((p) => p.name).join(', ')}`);
  }
  for (const { name, page: startPage, origin, dir } of wanted) {
    const url = `${origin}/${startPage || `${name}.html`}`;
    const page = await ctx.browser.newPage();
    await page.goto(url, { waitUntil: 'load' });
    const tabId = await tabIdFor(ctx.driver, url);
    const snap = await snapshotOf(ctx.driver, tabId);
    // `elements` holds the per-element locators for the executor. The model never sees them,
    // so they are left out to keep the files small and readable.
    const { elements, ...forModel } = snap;
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
  const found = await page.evaluate(() => window.__cspViolations || []).catch(() => []);
  sink.cspViolations.push(...found);
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
  result.stored = await page.evaluate(() => chrome.storage.local.get('agent_settings').then((r) => r.agent_settings && r.agent_settings.llmTimeoutMs));
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
    gate.timeoutField = await checkTimeoutField(page);
    await sleep(500); // late errors
    await collectCsp(page, ctx.panel);
  } finally {
    await page.close().catch(() => {});
  }
  gate.problems.push(...gate.timeoutField.problems);
  if (gate.badge !== MODEL) gate.problems.push(`the panel script did not run: the model badge shows ${JSON.stringify(gate.badge)}, expected ${JSON.stringify(MODEL)}`);
  if (!/^(Loaded|Retrieved) \d+ model/.test(gate.modelStatus || '')) gate.problems.push(`the panel did not get the model list: status ${JSON.stringify(gate.modelStatus)}`);
  return gate;
}

/**
 * Screenshots of the real side panel showing the finished run, in light and dark, at a panel
 * width of 400 px (900 px high; "-tall" is 1800 px high and shows a long card from its top; "-tall-open" has the action group open, where the plan rows and the refused finishes are; "-zoom-plan" and "-zoom-card" are close-ups at twice the pixel density, and "-zoom-card-details" is the card again with its audit details open when they were closed). Puppeteer cannot open Chrome's side panel (that needs a user gesture), so
 * sidepanel.html is opened as a page. The panel finds its tab with
 * chrome.tabs.query({active, currentWindow}), which would return the panel page itself here,
 * so only that one query is pointed at the task's tab.
 */
async function panelScreenshots(ctx, tabId, name, dir, schemes = ['light', 'dark']) {
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  for (const scheme of schemes) {
    const panel = await openPanelFor(ctx, tabId, scheme);
    await sleep(2000);
    const file = path.join(dir, `${name}-${scheme}.png`);
    await panel.screenshot({ path: file, fullPage: true });
    files.push(file);
    // The panel scrolls inside itself and shows the newest card at the bottom, so a 900 px shot can cut off
    // the top of a long card (its title, the plan rows). A tall window shows the whole run in one picture.
    await panel.setViewport({ width: 400, height: 1800 });
    await sleep(300);
    const tall = path.join(dir, `${name}-${scheme}-tall.png`);
    await panel.screenshot({ path: tall, fullPage: true });
    files.push(tall);
    // The action group is closed on a finished run, and it holds the plan rows (a skipped step says "not checked"
    // there) and the rows of refused finishes, so one more picture with the group open.
    const opened = await panel.evaluate(() => {
      const head = document.querySelector('.act-group:not(.open) .act-head');
      if (head) head.click();
      return !!head;
    }).catch(() => false);
    if (opened) {
      await sleep(300);
      const open = path.join(dir, `${name}-${scheme}-tall-open.png`);
      await panel.screenshot({ path: open, fullPage: true });
      files.push(open);
    }
    // Two close-ups at twice the pixel density (the action group with its plan rows, and the finish card), to
    // judge icons, spacing, clipped text and long addresses at a size where they can be read.
    await panel.setViewport({ width: 400, height: 1800, deviceScaleFactor: 2 });
    await sleep(300);
    for (const [label, selector] of [['zoom-plan', '.act-group'], ['zoom-card', '.finish-card']]) {
      const element = await panel.$(selector);
      if (!element) continue;
      const zoom = path.join(dir, `${name}-${scheme}-${label}.png`);
      await element.screenshot({ path: zoom });
      files.push(zoom);
    }
    // The audit details of the finish card ("What could not be verified", "Checked against N pages") are closed on a
    // partial or a verified run, so one more close-up with them open.
    const detailsOpened = await panel.evaluate(() => {
      const closed = document.querySelector('.finish-card details.audit:not([open]) summary');
      if (closed) closed.click();
      return !!closed;
    }).catch(() => false);
    if (detailsOpened) {
      await sleep(300);
      const card = await panel.$('.finish-card');
      if (card) {
        const zoom = path.join(dir, `${name}-${scheme}-zoom-card-details.png`);
        await card.screenshot({ path: zoom });
        files.push(zoom);
      }
    }
    await collectCsp(panel, ctx.panel);
    await panel.close();
  }
  return files;
}

/** The real side panel page, attached to the task's tab (see panelScreenshots for why tabs.query is pointed at it). */
async function openPanelFor(ctx, tabId, scheme = 'light') {
  const panel = await ctx.browser.newPage();
  await watchPanelPage(panel, ctx.panel);
  await panel.setViewport({ width: 400, height: 900 });
  await panel.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
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
 * The final card the real side panel draws for the finished run: its classes and its title. A task
 * with `expectCard` (lib/tasks.mjs) is checked against it, so a run that did not finish can never
 * show the green "Done" card the user would trust.
 */
async function readPanelCard(ctx, tabId, expect) {
  const panel = await openPanelFor(ctx, tabId);
  const problems = [];
  try {
    await panel.waitForSelector('.finish-card .finish-title', { timeout: 8000 }).catch(() => {});
    const card = await panel.evaluate(() => {
      const cards = document.querySelectorAll('.finish-card');
      const el = cards[cards.length - 1];
      return el ? { classes: [...el.classList], title: el.querySelector('.finish-title')?.textContent.trim() || '' } : null;
    });
    await collectCsp(panel, ctx.panel);
    if (!card) {
      problems.push('the side panel shows no final card');
    } else {
      if (card.title === 'Done') problems.push('the side panel shows the "Done" card for a run that did not finish');
      if (expect.title && card.title !== expect.title) problems.push(`the side panel card is titled ${JSON.stringify(card.title)}, expected ${JSON.stringify(expect.title)}`);
      for (const cls of expect.classes || []) {
        if (!card.classes.includes(cls)) problems.push(`the side panel card has classes [${card.classes.join(' ')}], expected "${cls}"`);
      }
    }
  } finally {
    await panel.close().catch(() => {});
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
  const marker = `[START_TASK] Starting task on tab [${tabId}]`;
  const at = (stateLogs || []).findLastIndex((entry) => entry && String(entry.message).includes(marker));
  return at >= 0 ? stateLogs.slice(at) : (portLogs || []);
}

/**
 * Saves the settings the extension runs with. Same shape the side panel's own save writes: the panel
 * header shows providerConfigs[provider].model, the engine uses the top-level model.
 *
 * What makes a graph run the same every time: the engine kind, the model and its server, the hard step cap
 * (maxSteps, the base of the step budget) and the effort level (effortDefault; START_TASK asks for the same level
 * too, because the engine reads the words of a task when the level is "auto"). The engine reads no tier setting yet
 * (plan stage 2d), so the mock's /api/show answer will decide it later.
 */
async function saveSettings(ctx, llm, model) {
  await ctx.driver.evaluate(async (settings) => {
    await chrome.storage.local.set({ agent_settings: settings });
  }, {
    provider: 'ollama', baseUrl: llm.url, apiKey: '', model, maxSteps: MAX_STEPS, effortDefault: EFFORT,
    providerConfigs: { ollama: { baseUrl: llm.url, apiKey: '', model } }
  });
  ctx.model = model;
}

/** The model a task runs with: the mock's behaviour can depend on the model name (see mockOllama.mjs), a real run never does. */
const modelOf = (name) => (MOCK && TASKS[name].mockModel) || MODEL;

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

/** A host the task runs on: the fixture server's, and the host name the task serves its page under. */
function fixtureHostsOf(fixtures, task) {
  return [new URL(fixtures.origin).hostname, task.host].filter(Boolean).map((h) => h.toLowerCase());
}

/**
 * Answers every hold the state shows that has not been answered yet, the way a user would, and writes what it did into
 * run.decisions (the report prints them):
 *   - the plan card: not expected (START_TASK never sets autoApprove, so the engine approves the plan itself); kept as a fallback for an explicit autoApprove:false run;
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
    const level = (approval.effortProfile && approval.effortProfile.level) || (state.effort && state.effort.level) || EFFORT;
    const sites = ((approval.planMeta && approval.planMeta.sites) || []).map((s) => s.domain || '?').join(', ') || 'none';
    await decide('plan', 'approve', `level ${level}, sites: ${sites}`, { action: 'APPROVE_PLAN', payload: { level } });
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

/** The first MOCK-FAIL text anywhere in what the model said or the engine showed, or null (see mockOllama.mjs). */
function findMockFail(facts, calls) {
  const texts = [...facts.steps.map((s) => s.raw), facts.answer, ...calls.map((c) => c.content), ...facts.errors];
  const hit = texts.find((t) => typeof t === 'string' && t.includes(MOCK_FAIL_PREFIX));
  return hit ? oneLine(hit.slice(hit.indexOf(MOCK_FAIL_PREFIX)), 240) : null;
}

/** Did the engine accept the plan of the mock? Its rows read "<domain>: <goal>" for every site of the mock's plan reply, where the generic fallback plan has one row with the task. */
function planAccepted(calls, plan) {
  const first = calls.find((c) => c.node === 'plan' && c.status === 200);
  let sites;
  try { sites = JSON.parse(first ? first.content : '').sites; } catch { return false; }
  return Array.isArray(sites) && plan.length === sites.length && sites.every((s, i) => plan[i].text === `${s.domain}: ${s.goal}`);
}

async function runTask(ctx, fixtures, llm, name) {
  const task = TASKS[name];
  if (!task) throw new Error(`Unknown task "${name}". Known: ${Object.keys(TASKS).join(', ')}`);
  const model = modelOf(name);
  if (ctx.model !== model) await saveSettings(ctx, llm, model);
  const url = `${originFor(fixtures, task.host)}/${task.page}`;

  const page = await ctx.browser.newPage();
  const pageErrors = [];
  watchFixturePage(page, pageErrors);
  await page.goto(url, { waitUntil: 'load' });
  await page.bringToFront();
  const tabId = await tabIdFor(ctx.driver, url);
  // Before the run: the page as loaded. After the run (below): the page the task ended on, which
  // is a new document when a click navigated.
  const probes = [await probePage(ctx, page, tabId)];

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

  const firstCall = llm.calls.length;
  const tallyBefore = await readTally(ctx);
  const startedAt = Date.now();
  // No autoApprove: the engine approves the plan itself, exactly like the side panel does.
  const started = await ctx.driver.evaluate((id, prompt, effort) => chrome.runtime.sendMessage({
    action: 'START_TASK', tabId: id, payload: { prompt, effort }
  }), tabId, task.prompt, EFFORT);
  if (!started || !started.success) throw new Error(`START_TASK was rejected: ${JSON.stringify(started)}`);

  // START_TASK answers before the engine flips to "running", so the end of the run is the first
  // status that is neither "running" nor "paused" AFTER the run started ("paused" is a hold: a confirmation,
  // a question, a challenge, a budget question). A fast run (the mock answers in milliseconds) can begin and end between
  // two polls, so "started" is also read from the history: the turn's user_goal entry is written right after
  // the status becomes "running". Each task has a fresh tab and so a fresh session, which means any
  // user_goal in it is this run's.
  const shotName = `${name}-${model.replace(/[^a-z0-9.]+/gi, '_')}`;
  const shotDir = args['panel-screenshots'] ? path.resolve(String(args['panel-screenshots'])) : null;
  const screenshots = [];
  const hosts = fixtureHostsOf(fixtures, task);
  const run = { startedAt, decisions: [], problems: [], armed: { plan: true, confirm: true, question: true, challenge: true, budget: true }, stopped: null, loop: null };
  const getState = () => ctx.driver.evaluate((id) => chrome.runtime.sendMessage({ action: 'GET_AGENT_STATE', tabId: id }), tabId);
  const stop = () => ctx.driver.evaluate((id) => chrome.runtime.sendMessage({ action: 'STOP_TASK', tabId: id }), tabId);
  let state = null;
  let seenRunning = false;
  let liveShotTaken = false;
  let timedOut = false;
  let pausedSince = null;
  for (;;) {
    state = await getState();
    const holds = holdsOf(state);
    const running = state.status === 'running';
    const begun = seenRunning || running || holds.length > 0 || (state.history || []).some((h) => h.type === 'user_goal');
    if (running) {
      seenRunning = true;
      // The plan checklist is only drawn while a run is live, so catch it once mid-run.
      if (shotDir && !liveShotTaken && (state.planSteps || []).length) {
        liveShotTaken = true;
        screenshots.push(...await panelScreenshots(ctx, tabId, `${shotName}-live`, shotDir, ['light']));
      }
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
    // The mock counts identical requests in a row. The reply never depends on it, but a run that gets the same
    // prompt again and again changes nothing and will not end by itself.
    const lastCall = MOCK ? llm.calls[llm.calls.length - 1] : null;
    if (lastCall && llm.calls.length > firstCall && lastCall.repeat + 1 >= LOOP_LIMIT) {
      run.loop = { calls: lastCall.repeat + 1, lastCall: lastCall.n, node: lastCall.node, mode: lastCall.mode };
      run.stopped = 'loop guard';
      await stop();
      break;
    }
    if (waited > TASK_TIMEOUT_MS) {
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

  // The status of every broadcast of the run. A fast mock run lasts about two seconds, so the 3 s "standing pause" check above can
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
  // What the engine did, as facts (lib/tasks.mjs): the final entry, the sites and how they ended, the steps, the calls per node.
  const facts = runFacts({ history: state.history || [], planSteps: state.planSteps || [], calls, tally });
  const answer = facts.answer;
  // Before the tab closes: closing it ends its session, and the panel would show nothing.
  if (shotDir) screenshots.push(...await panelScreenshots(ctx, tabId, shotName, shotDir));
  const cardProblems = task.expectCard ? await readPanelCard(ctx, tabId, task.expectCard) : [];
  // Chromium's own error page (a host that does not resolve) never gets content scripts, so there is nothing to probe there.
  if (page.url() !== probes[0].url && !page.url().startsWith('chrome-error://')) probes.push(await probePage(ctx, page, tabId));
  await sleep(300); // late page errors
  await page.close();

  const expectOutcome = task.expectOutcome || 'finish';
  return {
    task: name,
    model,
    startUrl: url,
    prompt: task.prompt,
    status: state.status,
    timedOut,
    stopped: run.stopped,
    loop: run.loop,
    outcome: facts.outcome,
    expectOutcome,
    unconfirmed: facts.unconfirmed,
    answer,
    answerCorrect: answer ? !!task.check(facts) : false,
    expectProblems: [...(MOCK && task.expectMock ? task.expectMock(facts) : []), ...cardProblems],
    holdProblems: run.problems,
    stateUpdates: { count: states.length, byStatus: stateStatuses },
    mockFail: MOCK ? findMockFail(facts, calls) : null,
    planAccepted: MOCK ? planAccepted(calls, facts.plan) : null,
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
    if (c.note) lines.push(`          mock:  ${c.note}${c.repeat ? ` (the same request ${c.repeat + 1} times in a row)` : ''}`);
  }
  return lines;
}

const countsText = (counts) => Object.entries(counts || {}).map(([k, n]) => `${k} x${n}`).join(', ') || 'none';

function printReport(r) {
  const f = r.facts;
  console.log(`\n=== ${r.task} (${r.model}) ===`);
  console.log(`start page: ${r.startUrl}`);
  console.log(`prompt:     ${r.prompt}`);
  const how = r.stopped ? `; the harness stopped it (${r.stopped}${r.loop ? `: the same prompt ${r.loop.calls} times in a row, ${r.loop.node}:${r.loop.mode}, call ${r.loop.lastCall}` : ''})` : '';
  const outcome = r.outcome === 'finish' ? 'FINISH' : r.outcome === 'partial_result' ? 'PARTIAL RESULT' : `NO FINAL ENTRY (status ${r.status})`;
  console.log(`outcome:    ${outcome}${r.unconfirmed ? ' (unconfirmed)' : ''}, status ${r.status}${how}; expected ${r.expectOutcome}; answer check: ${r.answerCorrect ? 'PASS' : 'FAIL'}`);
  if (r.answer) console.log(`answer:     ${oneLine(r.answer, 400)}`);
  for (const p of r.expectProblems) console.log(`run check:  ${oneLine(p, 300)}`);
  if (r.mockFail) console.log(`mock fail:  ${r.mockFail}`);
  for (const p of r.holdProblems) console.log(`hold:       ${oneLine(p, 300)}`);
  console.log(`states:     ${r.stateUpdates.count} state update(s) reached the panel port: ${countsText(r.stateUpdates.byStatus)}`);
  for (const e of r.errors) console.log(`error:      ${oneLine(e, 300)}`);
  for (const p of r.probes) console.log(`page check: ${p.url.replace(/^https?:\/\/[^/]+/, '')} net recorder ${p.recorderActive ? 'active' : 'NOT ACTIVE'}, content script ${p.contentScript ? 'answers' : `DOES NOT ANSWER (${p.contentScriptError})`}`);
  for (const e of r.pageErrors) console.log(`page error: ${oneLine(e, 300)}`);
  console.log(`sites:      ${f.siteEnds.map((s) => `${s.siteId} ${s.status} (${s.findings} finding(s), ${s.stepsUsed} step(s))${s.reason ? `: ${oneLine(s.reason, 100)}` : ''}`).join(' | ') || 'no site ended'}`);
  console.log(`plan (${f.plan.length}${r.planAccepted === false ? ', the mock plan was NOT accepted' : ''}): ${f.plan.map((s, i) => `${i + 1}. [${s.status}] ${s.text}`).join(' | ')}`);
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
  console.log(`model calls: ${r.modelCalls} (plan ${f.calls.plan}, policy ${f.calls.policy}${Object.keys(f.calls.policyModes).length ? ` [${countsText(f.calls.policyModes)}]` : ''}, reflect ${f.calls.reflect}); prompt tokens ${fmtInt(r.promptTokens)}; output tokens ${fmtInt(r.outputTokens)}`);
  for (const line of callLines(r.calls)) console.log(line);
  // The log of the run (from the START_TASK line on): the tags it carries and how often, then its first and last lines.
  const tags = r.logLines.reduce((n, line) => { const tag = /\[([A-Z_]+)\]/.exec(line)?.[1] || 'untagged'; n[tag] = (n[tag] || 0) + 1; return n; }, {});
  console.log(`log of the run (${r.logLines.length} lines): ${countsText(tags)}`);
  for (const line of r.logLines.length <= 10 ? r.logLines : [...r.logLines.slice(0, 6), `... ${r.logLines.length - 9} more line(s) ...`, ...r.logLines.slice(-3)]) console.log(`  ${line}`);
  if (r.warnings.length) {
    console.log(`warnings (${r.warnings.length}):`);
    for (const w of r.warnings.slice(0, 12)) console.log(`  ${w}`);
  }
  for (const s of r.screenshots) console.log(`panel screenshot: ${s}`);
}

/** What makes this run fail. Empty means pass. */
function judge(ctx, reports, gate) {
  const failures = [];
  for (const r of reports) {
    if (r.stopped) failures.push(`${r.task}: the harness stopped the run (${r.stopped})${r.loop ? `: the model got the same prompt ${r.loop.calls} times in a row` : ''}`);
    if (!r.outcome) {
      if (!r.stopped) failures.push(`${r.task}: the run ended with no final entry (status ${r.status})`);
    } else if (r.outcome !== r.expectOutcome) {
      failures.push(`${r.task}: the run ended with a ${r.outcome} entry, expected ${r.expectOutcome}`);
    } else if (!r.answerCorrect) {
      failures.push(`${r.task}: the answer is wrong`);
    }
    for (const p of r.expectProblems) failures.push(`${r.task}: ${p}`);
    for (const p of r.holdProblems) failures.push(`${r.task}: ${p}`);
    for (const p of r.probes) {
      const where = p.url.replace(/^https?:\/\/[^/]+/, '');
      if (!p.recorderActive) failures.push(`${r.task}: the net recorder (content/net-recorder.js, MAIN world) did not run on ${where}: window.__scoutfox_net_recorder_active is not true`);
      if (!p.contentScript) failures.push(`${r.task}: the content script did not answer GET_DOM_SNAPSHOT on ${where} (${p.contentScriptError})`);
    }
    if (r.pageErrors.length) failures.push(`${r.task}: the page logged ${r.pageErrors.length} console error(s) or page error(s): ${oneLine(r.pageErrors[0], 200)}`);
    if (MOCK) {
      // The mock is deterministic and never fails a call, so any of these is a change in the extension.
      if (r.mockFail) failures.push(`${r.task}: the mock could not find what it needs in the prompt: ${r.mockFail}`);
      if (r.planAccepted === false) failures.push(`${r.task}: the engine did not take the mock's plan (the plan rows are not the sites of its reply, so the generic fallback plan was used or the plan call failed)`);
      if (r.unconfirmed) failures.push(`${r.task}: the run ended with an unconfirmed (auto-wrapped) finish`);
      if (r.errors.length) failures.push(`${r.task}: the run logged ${r.errors.length} error entr${r.errors.length === 1 ? 'y' : 'ies'}: ${oneLine(r.errors[0], 200)}`);
      const refused = r.calls.filter((c) => c.status !== 200);
      if (refused.length) failures.push(`${r.task}: ${refused.length} model call(s) were refused by the mock (HTTP ${[...new Set(refused.map((c) => c.status))].join('/')}): ${oneLine(refused[0].content, 240)}`);
    }
  }
  if (ctx.workerErrors.length) failures.push(`${ctx.workerErrors.length} service worker or driver page error(s)`);
  if (gate) {
    const p = ctx.panel;
    if (p.consoleErrors.length) failures.push(`side panel: ${p.consoleErrors.length} console error(s)`);
    if (p.pageErrors.length) failures.push(`side panel: ${p.pageErrors.length} page error(s)`);
    if (p.cspViolations.length) failures.push(`side panel: ${p.cspViolations.length} CSP violation(s)`);
    for (const problem of gate.problems) failures.push(`side panel: ${problem}`);
  }
  return failures;
}

function printFailureDetails(ctx, reports) {
  for (const r of reports) {
    if (!r.pageErrors.length) continue;
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

async function main() {
  for (const flag of Object.keys(args)) {
    if (!KNOWN_FLAGS.has(flag)) throw new UserError(`Unknown option "${flag}". Known: ${[...KNOWN_FLAGS].map((f) => `--${f}`).join(', ')}`);
  }
  if (args.tamper !== undefined && !TAMPERS[args.tamper]) {
    throw new UserError(`Unknown --tamper "${args.tamper}". Known: ${Object.entries(TAMPERS).map(([k, v]) => `${k} (${v.does})`).join('; ')}`);
  }
  // A real model meets the same goal in a task and in its mock-only variant, so the variants only run with --mock.
  const names = args.task ? String(args.task).split(',') : Object.keys(TASKS).filter((n) => MOCK || !TASKS[n].mockOnly);
  for (const name of names) {
    if (!TASKS[name]) throw new UserError(`Unknown task "${name}". Known: ${Object.keys(TASKS).join(', ')}`);
  }
  // A pending task is skipped with its reason and is never a failure: the engine cannot do what it checks yet.
  const skipped = names.filter((n) => TASKS[n].pending).map((n) => ({ task: n, reason: TASKS[n].pending }));
  const runNames = names.filter((n) => !TASKS[n].pending);

  const puppeteer = await loadPuppeteer();
  checkChromium();
  if (args.build) await runBuild();
  checkDist();
  if (!args.build) warnIfDistIsStale();

  // The model server. The snapshot dump needs none: it never calls a model.
  const needsModel = !args['dump-snapshots'];
  let env = {};
  if (needsModel && MOCK) {
    const { runMockSelfTest } = await import('./lib/mockOllama.selftest.mjs');
    const results = await runMockSelfTest();
    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
      for (const r of failed) console.error(`mock self-test FAILED: ${r.name}\n  ${r.detail}`);
      throw new UserError(`The mock's self-test failed (${failed.length} of ${results.length} checks). The mock is broken, the browser was not started.`);
    }
    env = { mock: true, mockSelfTest: `${results.length}/${results.length} checks passed` };
    console.log(`mock Ollama self-test: ${results.length}/${results.length} checks passed`);
  } else if (needsModel) {
    env = await preflightOllama();
    console.log(`Ollama ${env.ollamaVersion} at ${OLLAMA}; direct call with a chrome-extension Origin -> ${env.directStatusFromExtensionOrigin} (so the extension uses the proxy)`);
  }
  console.log(`Chromium: ${CHROMIUM}`);

  const fixtures = await listen('fixture server', () => startFixtureServer({ root: SITE, port: FIXTURE_PORT }));
  onCleanup(closeServer(fixtures.server));
  let llm = null;
  if (needsModel) {
    if (MOCK) {
      const { startMockOllama } = await import('./lib/mockOllama.mjs');
      // The models of the mock: the one of the run, and the personas of the tasks (/api/show knows exactly these).
      const models = [...new Set([MODEL, ...Object.values(TASKS).map((t) => t.mockModel).filter(Boolean)])];
      llm = await listen('mock Ollama', () => startMockOllama({ port: PROXY_PORT, models }));
    } else {
      llm = await listen('Ollama proxy', () => startOllamaProxy({ port: PROXY_PORT, target: OLLAMA }));
    }
    onCleanup(closeServer(llm.server));
  }
  console.log(`fixtures at ${fixtures.origin}${llm ? `, ${MOCK ? 'mock Ollama' : 'Ollama proxy'} at ${llm.url}` : ''}`);

  // The extension the browser loads: a copy of dist/ plus driver.html, never dist/ itself.
  const copy = prepareExtensionCopy({ distDir: DIST, driverHtml: path.join(HERE, 'driver.html'), tamper: args.tamper });
  tempDirs.add(copy.dir);
  onCleanup(() => { copy.remove(); tempDirs.delete(copy.dir); });
  console.log(`extension: copy of dist/ in ${copy.dir} (${copy.files.length - 1} shipped files, no sourcemaps, plus driver.html)`);
  if (args.tamper) console.log(`TAMPERED copy (${args.tamper}): ${TAMPERS[args.tamper].does}`);

  const ctx = await launch(puppeteer, copy.dir);
  console.log(`browser ${await ctx.browser.version()}, extension ${ctx.extensionId}`);

  const reports = [];
  let gate = null;
  if (args['dump-snapshots']) {
    await dumpSnapshots(ctx, fixtures, typeof args['dump-snapshots'] === 'string' ? args['dump-snapshots'].split(',') : null);
  } else {
    await saveSettings(ctx, llm, MODEL);

    for (const { task, reason } of skipped) console.log(`\n=== ${task} === SKIPPED (pending): ${reason}`);
    for (const name of runNames) {
      const report = await runTask(ctx, fixtures, llm, name);
      reports.push(report);
      printReport(report);
    }
    // A task can use another model name (the mock's persona): the side panel gate reads the configured one.
    if (ctx.model !== MODEL) await saveSettings(ctx, llm, MODEL);
    gate = await checkSidePanel(ctx);
  }

  console.log('\n=== summary ===');
  for (const r of reports) {
    const sites = r.facts.siteEnds.map((s) => `${s.siteId} ${s.status}`).join(', ') || 'no site ended';
    console.log(`${r.task}: ${r.outcome || `no final entry (status ${r.status}${r.stopped ? `, stopped: ${r.stopped}` : ''})`}, answer ${r.answerCorrect ? 'right' : 'wrong'}, sites ${sites}, ${r.facts.steps.length} step(s), ${(r.wallMs / 1000).toFixed(1)} s, ${r.modelCalls} model call(s) (plan ${r.facts.calls.plan}, policy ${r.facts.calls.policy}, reflect ${r.facts.calls.reflect}), ${fmtInt(r.promptTokens)} prompt + ${fmtInt(r.outputTokens)} output tokens`);
  }
  if (!args['dump-snapshots']) for (const { task, reason } of skipped) console.log(`${task}: skipped (pending: ${reason})`);
  console.log(`service worker errors (console, exceptions, CSP violations): ${ctx.workerErrors.length}`);
  if (reports.length) {
    const probes = reports.flatMap((r) => r.probes);
    console.log(`fixture pages: ${probes.length} page check(s), ${probes.filter((p) => p.recorderActive).length} with the net recorder active, ${probes.filter((p) => p.contentScript).length} with the content script answering, ${reports.reduce((n, r) => n + r.pageErrors.length, 0)} console or page errors`);
  }
  if (gate) {
    const p = ctx.panel;
    console.log(`side panel (${gate.url.replace(/^chrome-extension:\/\/[a-z]+/, 'chrome-extension://<id>')}): ${p.consoleErrors.length} console errors, ${p.pageErrors.length} page errors, ${p.cspViolations.length} CSP violations; model badge ${JSON.stringify(gate.badge)}, model list "${gate.modelStatus}"`);
  }
  printFailureDetails(ctx, reports);

  const failures = judge(ctx, reports, gate);
  if (args.out) {
    // A run that loops makes thousands of calls: the report keeps the first five and the last three of each task, and the count.
    const trimmed = reports.map((r) => ({ ...r, callCount: r.calls.length, calls: r.calls.length <= 8 ? r.calls : [...r.calls.slice(0, 5), ...r.calls.slice(-3)], logLines: r.logLines.length <= 40 ? r.logLines : [...r.logLines.slice(0, 25), ...r.logLines.slice(-15)] }));
    fs.writeFileSync(path.resolve(String(args.out)), JSON.stringify({
      env, mock: MOCK, tamper: args.tamper || null, model: MODEL, skipped, reports: trimmed, workerErrors: ctx.workerErrors, panel: { ...ctx.panel, gate }, failures
    }, null, 2));
    console.log(`report saved to ${args.out}`);
  }
  if (failures.length) {
    console.log(`\nSMOKE FAILED (${failures.length} problem${failures.length === 1 ? '' : 's'}):`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  } else {
    console.log(`\nSMOKE PASSED${reports.length ? ` (${reports.length} task${reports.length === 1 ? '' : 's'}, side panel clean, worker clean, fixture pages clean)` : ''}`);
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
