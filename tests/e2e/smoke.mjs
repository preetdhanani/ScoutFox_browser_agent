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
 *            Ollama needed. This is what CI runs (`npm run test:e2e`).
 *   default  a small proxy in front of a real local Ollama (lib/ollamaProxy.mjs, see there for
 *            why a proxy is needed).
 *
 * The run fails (exit code 1, every problem printed) when a task does not finish, its answer is
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
 *         node smoke.mjs --max-steps=10            the engine's step cap for a task
 *         node smoke.mjs --timeout=360000          per task, in milliseconds
 *         node smoke.mjs --dump-snapshots          save what the content script sees on each
 *                                                  fixture page to tests/fixtures/snapshots/
 *                                                  (the evals read these files; no model needed)
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
import { TASKS } from './lib/tasks.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const DIST = path.join(REPO, 'dist');
const SITE = path.join(REPO, 'tests', 'fixtures', 'site');
const SNAPSHOT_DIR = path.join(REPO, 'tests', 'fixtures', 'snapshots');

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
// The fixture tasks need 1 to 3 steps. A lower cap than the default 25 keeps a looping run
// short, and it is still far above what a working run uses.
const MAX_STEPS = Number(args['max-steps'] || 10);
const POLL_MS = 250;

const SNAPSHOT_PAGES = ['store', 'search', 'compare', 'challenge', 'error'];

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
const BUILD_INPUTS = ['background', 'content', 'sidepanel', 'src', 'shared', 'public', 'vite.config.mjs', 'scripts/build.mjs', 'tsconfig.json', 'package.json', 'package-lock.json'];

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
    if (e.type === 'error' || e.type === 'assert') errors.push(`service worker console.${e.type}: ${oneLine(textOfArgs(e.args), 300)}`);
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
      ...CHROMIUM_ARGS
    ]
  });
  browserProcess = browser.process();
  onCleanup(() => closeBrowser(browser));

  // Errors from the worker and from the driver page. A worker that restarts is watched again.
  const workerErrors = [];
  const isWorker = (t) => t.type() === 'service_worker' && t.url().endsWith('/background/sw.js');
  const watching = new Map(); // target -> the promise of its watcher, so awaiting it waits for the real attach
  const watch = (t) => {
    if (!watching.has(t)) {
      watching.set(t, watchWorker(t, workerErrors).catch((err) => workerErrors.push(`could not watch the service worker: ${err.message}`)));
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
  return { browser, driver, extensionId, workerErrors, panel: newPanelSink() };
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

async function dumpSnapshots(ctx, fixtures) {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  for (const name of SNAPSHOT_PAGES) {
    const url = `${fixtures.origin}/${name}.html`;
    const page = await ctx.browser.newPage();
    await page.goto(url, { waitUntil: 'load' });
    const tabId = await tabIdFor(ctx.driver, url);
    const snap = await snapshotOf(ctx.driver, tabId);
    // `elements` holds the per-element locators for the executor. The model never sees them,
    // so they are left out to keep the files small and readable.
    const { elements, ...forModel } = snap;
    const file = path.join(SNAPSHOT_DIR, `${name}.json`);
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
 * width of 400 px. Puppeteer cannot open Chrome's side panel (that needs a user gesture), so
 * sidepanel.html is opened as a page. The panel finds its tab with
 * chrome.tabs.query({active, currentWindow}), which would return the panel page itself here,
 * so only that one query is pointed at the task's tab.
 */
async function panelScreenshots(ctx, tabId, name, dir, schemes = ['light', 'dark']) {
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  for (const scheme of schemes) {
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
    await sleep(2000);
    const file = path.join(dir, `${name}-${scheme}.png`);
    await panel.screenshot({ path: file, fullPage: true });
    await collectCsp(panel, ctx.panel);
    files.push(file);
    await panel.close();
  }
  return files;
}

// ---------------------------------------------------------------------------------------------
// A task
// ---------------------------------------------------------------------------------------------

function lastTurn(history) {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].type === 'user_goal') return history.slice(i);
  }
  return history;
}

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

async function runTask(ctx, fixtures, llm, name) {
  const task = TASKS[name];
  if (!task) throw new Error(`Unknown task "${name}". Known: ${Object.keys(TASKS).join(', ')}`);
  const url = `${fixtures.origin}/${task.page}`;

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
    if (window.__port) window.__port.disconnect();
    window.__port = chrome.runtime.connect({ name: `scoutfox_sidepanel:${id}` });
    window.__port.onMessage.addListener((m) => { if (m.type === 'LOG_ENTRY') window.__logs.push(m.payload); });
  }, tabId);

  const firstCall = llm.calls.length;
  const startedAt = Date.now();
  const started = await ctx.driver.evaluate((id, prompt) => chrome.runtime.sendMessage({
    action: 'START_TASK', tabId: id, payload: { prompt }
  }), tabId, task.prompt);
  if (!started || !started.success) throw new Error(`START_TASK was rejected: ${JSON.stringify(started)}`);

  // START_TASK answers before the engine flips to "running", so the end of the run is the first
  // non-running status AFTER the run started. A fast run (the mock answers in milliseconds) can
  // begin and end between two polls, so "started" is also read from the history: the turn's
  // user_goal entry is written right after the status becomes "running". Each task has a fresh
  // tab and so a fresh session, which means any user_goal in it is this run's.
  const shotName = `${name}-${MODEL.replace(/[^a-z0-9.]+/gi, '_')}`;
  const shotDir = args['panel-screenshots'] ? path.resolve(String(args['panel-screenshots'])) : null;
  const screenshots = [];
  let state = null;
  let seenRunning = false;
  let liveShotTaken = false;
  let timedOut = false;
  for (;;) {
    state = await ctx.driver.evaluate((id) => chrome.runtime.sendMessage({ action: 'GET_AGENT_STATE', tabId: id }), tabId);
    const running = state.status === 'running';
    const begun = seenRunning || running || (state.history || []).some((h) => h.type === 'user_goal');
    if (running) {
      seenRunning = true;
      // The plan checklist is only drawn while a run is live, so catch it once mid-run.
      if (shotDir && !liveShotTaken && (state.planSteps || []).length) {
        liveShotTaken = true;
        screenshots.push(...await panelScreenshots(ctx, tabId, `${shotName}-live`, shotDir, ['light']));
      }
    } else if (begun) {
      break;
    }
    const waited = Date.now() - startedAt;
    if (!begun && waited > 15000) {
      throw new Error(`The engine did not start the run within 15 s of START_TASK (status "${state.status}").`);
    }
    if (waited > TASK_TIMEOUT_MS) {
      timedOut = true;
      await ctx.driver.evaluate((id) => chrome.runtime.sendMessage({ action: 'STOP_TASK', tabId: id }), tabId);
      break;
    }
    await sleep(POLL_MS);
  }
  const wallMs = Date.now() - startedAt;
  const logs = logsOfRun(state.logs, await ctx.driver.evaluate(() => window.__logs), tabId);

  const turn = lastTurn(state.history || []);
  const finish = turn.find((h) => h.type === 'finish');
  const errors = turn.filter((h) => h.type === 'error').map((h) => h.content);
  const steps = [];
  for (const item of turn) {
    if (item.type === 'agent_response') steps.push({ step: item.step, action: item.action, raw: item.rawResponse });
    if (item.type === 'execution_result' && steps.length) {
      const last = steps[steps.length - 1];
      if (!last.result) last.result = item.success ? `ok: ${item.message || ''}` : `FAILED: ${item.error || ''}`;
    }
  }
  const calls = llm.calls.slice(firstCall);
  const answer = finish ? finish.answer : null;
  // Before the tab closes: closing it ends its session, and the panel would show nothing.
  if (shotDir) screenshots.push(...await panelScreenshots(ctx, tabId, shotName, shotDir));
  if (page.url() !== probes[0].url) probes.push(await probePage(ctx, page, tabId));
  await sleep(300); // late page errors
  await page.close();

  return {
    task: name,
    model: MODEL,
    startUrl: url,
    prompt: task.prompt,
    status: state.status,
    timedOut,
    finished: !!finish,
    unconfirmed: !!(finish && finish.unconfirmed),
    answer,
    answerCorrect: answer ? task.check({ answer, steps }) : false,
    errors,
    pageErrors,
    probes,
    plan: (state.planSteps || []).map((s) => s.text),
    planFallback: logs.some((l) => /\[PLANNER_FALLBACK\]/.test(l.message)),
    steps,
    wallMs,
    modelCalls: calls.length,
    promptTokens: calls.reduce((s, c) => s + (c.promptEvalCount || 0), 0),
    outputTokens: calls.reduce((s, c) => s + (c.evalCount || 0), 0),
    calls,
    screenshots,
    warnings: logs.filter((l) => l.level === 'WARN' || l.level === 'ERROR').map((l) => `${l.level} ${oneLine(l.message, 200)}`)
  };
}

function printReport(r) {
  console.log(`\n=== ${r.task} (${r.model}) ===`);
  console.log(`start page: ${r.startUrl}`);
  console.log(`prompt:     ${r.prompt}`);
  const outcome = r.timedOut ? 'TIMED OUT' : r.finished ? (r.unconfirmed ? 'FINISHED (unconfirmed)' : 'FINISHED') : `ENDED WITHOUT FINISH (status ${r.status})`;
  console.log(`outcome:    ${outcome}; answer check: ${r.answerCorrect ? 'PASS' : 'FAIL'}`);
  if (r.answer) console.log(`answer:     ${oneLine(r.answer, 400)}`);
  for (const e of r.errors) console.log(`error:      ${oneLine(e, 300)}`);
  for (const p of r.probes) console.log(`page check: ${p.url.replace(/^https?:\/\/[^/]+/, '')} net recorder ${p.recorderActive ? 'active' : 'NOT ACTIVE'}, content script ${p.contentScript ? 'answers' : `DOES NOT ANSWER (${p.contentScriptError})`}`);
  for (const e of r.pageErrors) console.log(`page error: ${oneLine(e, 300)}`);
  console.log(`plan (${r.plan.length}${r.planFallback ? ', generic fallback' : ''}): ${r.plan.map((t, i) => `${i + 1}. ${t}`).join(' | ')}`);
  console.log('steps:');
  for (const s of r.steps) console.log(`  #${s.step} ${oneLine(s.action, 140)}${s.result ? ` -> ${oneLine(s.result, 100)}` : ''}`);
  console.log(`wall time:  ${(r.wallMs / 1000).toFixed(1)} s`);
  console.log(`model calls: ${r.modelCalls}; prompt tokens ${fmtInt(r.promptTokens)}; output tokens ${fmtInt(r.outputTokens)}`);
  for (const c of r.calls) {
    console.log(`  call ${c.n}: ${(c.ms / 1000).toFixed(1)} s, status ${c.status}, format ${c.format}, think ${c.think}, system ${fmtInt(c.systemChars)} chars, request ${fmtInt(c.requestBytes)} B, prompt_eval ${fmtInt(c.promptEvalCount)}, eval ${fmtInt(c.evalCount)}, done ${c.doneReason}`);
    console.log(`          reply: ${oneLine(c.content, 150)}`);
    if (c.note) console.log(`          mock:  ${c.note}`);
  }
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
    if (!r.finished) failures.push(`${r.task}: the run did not finish (${r.timedOut ? 'timed out' : `status ${r.status}`})`);
    else if (!r.answerCorrect) failures.push(`${r.task}: the answer is wrong`);
    for (const p of r.probes) {
      const where = p.url.replace(/^https?:\/\/[^/]+/, '');
      if (!p.recorderActive) failures.push(`${r.task}: the net recorder (content/net-recorder.js, MAIN world) did not run on ${where}: window.__scoutfox_net_recorder_active is not true`);
      if (!p.contentScript) failures.push(`${r.task}: the content script did not answer GET_DOM_SNAPSHOT on ${where} (${p.contentScriptError})`);
    }
    if (r.pageErrors.length) failures.push(`${r.task}: the page logged ${r.pageErrors.length} console error(s) or page error(s): ${oneLine(r.pageErrors[0], 200)}`);
    if (MOCK) {
      // The mock is deterministic and never fails a call, so any of these is a change in the extension.
      if (r.planFallback) failures.push(`${r.task}: the generic fallback plan was used, the mock's plan reply was not accepted`);
      if (r.unconfirmed) failures.push(`${r.task}: the run ended with an unconfirmed (auto-wrapped) finish`);
      if (r.errors.length) failures.push(`${r.task}: the run logged ${r.errors.length} error entr${r.errors.length === 1 ? 'y' : 'ies'}: ${oneLine(r.errors[0], 200)}`);
      if (r.modelCalls !== 1 + r.steps.length) failures.push(`${r.task}: ${r.modelCalls} model calls for ${r.steps.length} step(s), expected 1 plan call plus 1 per step (a call was repeated or added)`);
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
  const names = args.task ? String(args.task).split(',') : Object.keys(TASKS);
  for (const name of names) {
    if (!TASKS[name]) throw new UserError(`Unknown task "${name}". Known: ${Object.keys(TASKS).join(', ')}`);
  }

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
      llm = await listen('mock Ollama', () => startMockOllama({ port: PROXY_PORT, models: [MODEL] }));
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
    await dumpSnapshots(ctx, fixtures);
  } else {
    // Same shape the side panel's own save writes: the panel header shows
    // providerConfigs[provider].model, the engine uses the top-level model.
    await ctx.driver.evaluate(async (settings) => {
      await chrome.storage.local.set({ agent_settings: settings });
    }, {
      provider: 'ollama', baseUrl: llm.url, apiKey: '', model: MODEL, maxSteps: MAX_STEPS,
      providerConfigs: { ollama: { baseUrl: llm.url, apiKey: '', model: MODEL } }
    });

    for (const name of names) {
      const report = await runTask(ctx, fixtures, llm, name);
      reports.push(report);
      printReport(report);
    }
    gate = await checkSidePanel(ctx);
  }

  console.log('\n=== summary ===');
  for (const r of reports) {
    console.log(`${r.task}: ${r.finished ? 'finished' : 'not finished'}, answer ${r.answerCorrect ? 'right' : 'wrong'}, ${r.steps.length} step(s), ${(r.wallMs / 1000).toFixed(1)} s, ${r.modelCalls} model call(s), ${fmtInt(r.promptTokens)} prompt + ${fmtInt(r.outputTokens)} output tokens`);
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
  printFailureDetails(ctx, reports);

  const failures = judge(ctx, reports, gate);
  if (args.out) {
    fs.writeFileSync(path.resolve(String(args.out)), JSON.stringify({
      env, mock: MOCK, tamper: args.tamper || null, model: MODEL, reports, workerErrors: ctx.workerErrors, panel: { ...ctx.panel, gate }, failures
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
