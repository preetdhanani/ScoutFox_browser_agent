/**
 * The real-page corpus replay job.
 *
 * Loads every recorded page of tests/fixtures/real (see record-real.mjs) from a local server,
 * runs the REAL content scripts of the built extension over it in headless Chromium, and
 * asserts what the extractor and the perception must hold up on real pages:
 *   - the hand-written expectations in tests/fixtures/real/expectations.json (per page: a line
 *     must be in the page text, a control must be in the element list, ...),
 *   - the no-silent-cut rule: a snapshot that shows less text than the page has must say so
 *     with the truncation note,
 *   - the baseline alarm: a drop in extracted text length or element count against the stored
 *     baseline (tests/fixtures/real/baseline.json) beyond the tolerance fails the job.
 *
 * The replay never fetches the live web: every request that does not go to the local corpus
 * server or the extension itself is aborted, and the recorded DOM is served with its script
 * tags stripped, so the page cannot mutate after the capture.
 *
 * Run:  node tests/e2e/replay-real.mjs                    replay the whole corpus
 *       node tests/e2e/replay-real.mjs --only=a,b         replay only these pages
 *       node tests/e2e/replay-real.mjs --update-baseline  store the current counts as the baseline
 *       node tests/e2e/replay-real.mjs --build            run npm run build first
 *
 * Needs the built extension (dist/) and Chromium at CHROMIUM_PATH. CI runs this nightly
 * (.github/workflows/real-corpus.yml); `npm run test:replay` runs it by hand.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  CORPUS_DIR, BASELINE_DROP_TOLERANCE, BASELINE_FILE,
  loadManifest, loadExpectations, loadBaseline, readCorpusPage, stripScripts,
  evaluateExpectations, baselineProblems, auditCorpus, pageFilePaths
} from './lib/realCorpus.mjs';
import { prepareExtensionCopy } from './lib/extensionCopy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const DIST = path.join(REPO, 'dist');
const CHROMIUM = process.env.CHROMIUM_PATH || '/Applications/Chromium.app/Contents/MacOS/Chromium';
const CORPUS_PORT = Number(process.env.CORPUS_PORT || 8766);

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
}));
const ONLY = args.only ? String(args.only).split(',') : null;
const UPDATE_BASELINE = !!args['update-baseline'];
const SETTLE_MS = 1500;
const SNAPSHOT_TRIES = 50;
const MAX_READ_PARTS = 80; // 80 parts of 3000 chars cover a 240 KB page text; the corpus caps text at 200 KB.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Bounds one browser round-trip, so a message that is never answered cannot stall the whole job. */
const withTimeout = (promise, ms, what) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms))
]);
const oneLine = (value, max = 200) => {
  const s = (typeof value === 'string' ? value : JSON.stringify(value)) || '';
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
};

const cleanups = [];
let cleaning = null;
function cleanup() {
  if (!cleaning) cleaning = (async () => { while (cleanups.length) { try { await cleanups.pop()(); } catch { /* best effort */ } } })();
  return cleaning;
}
const tempDirs = new Set();
function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), prefix));
  tempDirs.add(dir);
  cleanups.push(() => { fs.rmSync(dir, { recursive: true, force: true }); tempDirs.delete(dir); });
  return dir;
}
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.on(signal, () => { cleanup().finally(() => process.exit(code)); });
}
process.on('exit', () => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function runBuild() {
  console.log('$ npm run build');
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['run', 'build'], { cwd: REPO, stdio: 'inherit' });
    cleanups.push(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); });
    child.once('error', (err) => reject(new Error(`Could not run "npm run build": ${err.message}`)));
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`npm run build failed (exit code ${code})`))));
  });
}

/** Serves the recorded pages from memory, scripts stripped, at /<name>. Nothing leaves the loopback interface. */
function startCorpusServer(pages) {
  const bodies = new Map(pages.map((p) => [`/${p.name}`, stripScripts(p.html)]));
  const server = http.createServer((req, res) => {
    const key = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\.html$/, '');
    const body = bodies.get(key);
    if (body === undefined) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not a corpus page');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(body);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(CORPUS_PORT, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` }));
  });
}

function closeServer(server) {
  return () => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

async function tabIdFor(driver, url) {
  for (let i = 0; i < 50; i++) {
    const id = await withTimeout(driver.evaluate(async (u) => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((t) => t.url === u);
      return tab ? tab.id : null;
    }, url), 5000, `tab lookup for ${url}`);
    if (id !== null) return id;
    await sleep(100);
  }
  throw new Error(`No tab found for ${url}`);
}

async function snapshotOf(driver, tabId) {
  for (let i = 0; i < SNAPSHOT_TRIES; i++) {
    const res = await withTimeout(driver.evaluate(async (id) => {
      try {
        return await chrome.tabs.sendMessage(id, { action: 'GET_DOM_SNAPSHOT', payload: { showBadges: false } });
      } catch (err) {
        return { success: false, error: err.message };
      }
    }, tabId), 10000, `GET_DOM_SNAPSHOT on tab ${tabId}`);
    if (res && res.success) return res.data;
    await sleep(200);
  }
  throw new Error(`The content script never answered on tab ${tabId}`);
}

/**
 * The whole page text, read the way the engine reads it: read_page parts 1, 2, ... through the real
 * action executor, until the part that says it is the last. This is the text the model can reach,
 * not the snapshot's capped head.
 */
async function fullTextOf(driver, tabId) {
  const parts = [];
  for (let part = 1; part <= MAX_READ_PARTS; part++) {
    const res = await withTimeout(driver.evaluate(async (id, n) => {
      try {
        return await chrome.tabs.sendMessage(id, { action: 'EXECUTE_ACTION', payload: { action: 'read_page', part: n } });
      } catch (err) {
        return { success: false, error: err.message };
      }
    }, tabId, part), 15000, `read_page part ${part} on tab ${tabId}`);
    if (!res || !res.success) return { text: parts.join('\n'), error: (res && res.error) || 'no answer' };
    parts.push(res.result && res.result.pageText || '');
    if (!(res.result && res.result.part < res.result.parts)) break;
  }
  return { text: parts.join('\n'), error: null };
}

async function main() {
  const audit = auditCorpus(CORPUS_DIR, { requireBaseline: !UPDATE_BASELINE });
  if (audit.problems.length) {
    for (const p of audit.problems) console.error(`corpus: ${p.page ? `${p.page}: ` : ''}${p.problem}`);
    throw new Error('the corpus audit failed; fix the corpus before the replay runs');
  }
  const manifest = loadManifest(CORPUS_DIR);
  const expectations = loadExpectations(CORPUS_DIR);
  const names = ONLY ? audit.pages.filter((n) => ONLY.includes(n)) : audit.pages;
  const unknown = (ONLY || []).filter((n) => !audit.pages.includes(n));
  if (unknown.length) throw new Error(`Unknown page(s) in --only: ${unknown.join(', ')}. Recorded: ${audit.pages.join(', ')}`);

  if (args.build) await runBuild();
  if (!fs.existsSync(path.join(DIST, 'manifest.json'))) throw new Error('dist/manifest.json not found: run npm run build first (or pass --build).');
  if (!fs.existsSync(CHROMIUM)) throw new Error(`Chromium not found at ${CHROMIUM}. Set CHROMIUM_PATH.`);
  const puppeteer = (await import('puppeteer-core')).default;

  const pages = names.map((name) => ({ name, ...readCorpusPage(CORPUS_DIR, name) }));
  const corpus = await startCorpusServer(pages);
  cleanups.push(closeServer(corpus.server));

  const copy = prepareExtensionCopy({ distDir: DIST, driverHtml: path.join(HERE, 'driver.html') });
  tempDirs.add(copy.dir);
  cleanups.push(() => { copy.remove(); tempDirs.delete(copy.dir); });

  const profileDir = makeTempDir('scoutfox-replay-');
  const browser = await puppeteer.launch({
    executablePath: CHROMIUM,
    headless: true,
    pipe: true,
    enableExtensions: true,
    defaultViewport: null,
    handleSIGINT: false,
    handleSIGTERM: false,
    args: [
      `--disable-extensions-except=${copy.dir}`,
      `--load-extension=${copy.dir}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,900'
    ]
  });
  cleanups.push(() => browser.close().catch(() => {}));
  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/background/sw.js'), { timeout: 20000 });
  const extensionId = new URL(swTarget.url()).host;
  const driver = await browser.newPage();
  // The driver page lives in the extension, so its chrome.* APIs can reach the tabs (the way
  // the smoke run's driver.html does).
  await driver.goto(`chrome-extension://${extensionId}/driver.html`, { waitUntil: 'load' });
  console.log(`replaying ${pages.length} page(s) from ${corpus.origin}, extension ${extensionId}`);

  const results = [];
  for (const page of pages) {
    const url = `${corpus.origin}/${page.name}`;
    const tab = await browser.newPage();
    const problems = [];
    // No live fetches: only the corpus server and the extension itself may be contacted.
    await tab.setRequestInterception(true);
    tab.on('request', (req) => {
      const target = req.url();
      if (target.startsWith(corpus.origin) || target.startsWith('chrome-extension://') || target.startsWith('data:')) req.continue();
      else req.abort().catch(() => {});
    });
    let snap = null;
    let full = { text: '', error: null };
    try {
      await tab.goto(url, { waitUntil: 'load', timeout: 30000 });
      await sleep(SETTLE_MS);
      const tabId = await tabIdFor(driver, url);
      snap = await snapshotOf(driver, tabId);
      full = await fullTextOf(driver, tabId);
      const view = { pageText: snap.pageText || '', fullText: full.text, elementsText: snap.elementsText || '' };
      problems.push(...evaluateExpectations(expectations.pages[page.name] || [], view).map((p) => `expectation: ${p}`));
      // The no-silent-cut rule: a snapshot that shows less than the whole page text must say so.
      if (full.text.length > view.pageText.length + 100 && !/truncated: showing/.test(view.pageText)) {
        problems.push(`the snapshot shows ${view.pageText.length} of ${full.text.length} characters with no truncation note`);
      }
      if (full.error) problems.push(`read_page failed: ${oneLine(full.error)}`);
    } catch (err) {
      problems.push(`replay failed: ${oneLine(String(err && err.message || err), 300)}`);
    }
    const counts = snap ? { textLength: (snap.pageText || '').length, elementCount: snap.elementCount || 0 } : null;
    results.push({ name: page.name, url: page.meta.url, counts, problems, fullTextLength: full.text.length });
    console.log(`${problems.length ? 'FAIL' : 'ok  '} ${page.name}: text ${(counts && counts.textLength) || 0} chars, ${counts ? counts.elementCount : 0} elements${problems.length ? `, ${problems.length} problem(s)` : ''}`);
    for (const p of problems) console.log(`     - ${oneLine(p, 300)}`);
    await tab.close().catch(() => {});
  }

  await browser.close().catch(() => {});

  // The baseline alarm, over every replayed page.
  const baselinePath = path.join(CORPUS_DIR, BASELINE_FILE);
  let baseline = null;
  try { baseline = loadBaseline(CORPUS_DIR); } catch { /* a fresh corpus has none yet */ }
  const current = Object.fromEntries(results.filter((r) => r.counts).map((r) => [r.name, r.counts]));
  let baselineProblemsList = [];
  if (UPDATE_BASELINE) {
    const merged = { ...(baseline || { pages: {} }), pages: { ...((baseline && baseline.pages) || {}), ...current }, updatedAt: new Date().toISOString(), tolerance: BASELINE_DROP_TOLERANCE };
    fs.writeFileSync(baselinePath, `${JSON.stringify(merged, null, 2)}\n`);
    console.log(`baseline updated for ${Object.keys(current).length} page(s) -> ${path.relative(REPO, baselinePath)}`);
  } else if (baseline) {
    baselineProblemsList = baselineProblems(current, baseline).map((p) => ({ name: p.page, problems: [`baseline alarm: ${p.problem}`] }));
    for (const r of baselineProblemsList) {
      const row = results.find((x) => x.name === r.name);
      row.problems.push(...r.problems);
      console.log(`FAIL ${r.name}`);
      for (const p of r.problems) console.log(`     - ${oneLine(p, 300)}`);
    }
  } else {
    console.log('no baseline stored yet: run again with --update-baseline to store one');
  }

  const failed = results.filter((r) => r.problems.length);
  console.log(`\nREPLAY ${failed.length ? `FAILED (${failed.length} of ${results.length} page(s) with problems)` : `PASSED (${results.length} page(s))`}`);
  if (args.out) {
    const report = results.map(({ name, url, counts, problems, fullTextLength }) => ({ name, url, counts, fullTextLength, problems }));
    fs.writeFileSync(path.resolve(String(args.out)), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`report saved to ${args.out}`);
  }
  if (failed.length) process.exitCode = 1;
}

try {
  await main();
} catch (err) {
  console.error(`error: ${err && err.message ? err.message : err}`);
  process.exitCode = 1;
} finally {
  await cleanup();
  setTimeout(() => process.exit(process.exitCode || 0), 2000).unref();
}
