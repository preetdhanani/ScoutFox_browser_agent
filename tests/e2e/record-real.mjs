/**
 * The real-page corpus recorder.
 *
 * Visits every page in tests/fixtures/real/manifest.json in a real Chromium (the same
 * puppeteer-core setup the smoke run uses), waits for the page to settle, and records for
 * each page:
 *   - the serialized DOM (document.documentElement.outerHTML), size-capped and gzipped,
 *   - the visible text (document.body.innerText), size-capped, personal data scrubbed,
 *   - metadata (scrubbed URL, title, capture time, sizes, sha256 of the DOM).
 *
 * The recorded pages go to tests/fixtures/real/<name>.html.gz, <name>.txt and <name>.json.
 * They are committed, so the replay job (tests/e2e/replay-real.mjs) never fetches the live
 * web. Run this again to refresh the corpus (monthly in CI, see .github/workflows/real-corpus.yml),
 * and whenever a live bug contributes its page (see tests/fixtures/real/README.md).
 *
 * Personal data: a fresh profile with no cookies and no sign-in is used, and the scrubber in
 * lib/realCorpus.mjs replaces email addresses, phone-like digit runs and opaque tokens before
 * anything is written. The corpus audit in `npm test` re-checks every committed page.
 *
 * Run:  node tests/e2e/record-real.mjs                 record every manifest page
 *       node tests/e2e/record-real.mjs --only=a,b      record only these pages
 *       node tests/e2e/record-real.mjs --timeout=60000 per-page navigation timeout in ms
 *
 * Needs Chromium at CHROMIUM_PATH (default /Applications/Chromium.app/Contents/MacOS/Chromium).
 * The recorder fetches the live web on purpose; the replay job never does.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  CORPUS_DIR, HTML_CAP, TEXT_CAP, HTML_TRUNCATION_MARK, TEXT_TRUNCATION_MARK,
  loadManifest, scrubPersonalData, scrubUrl, capWithMark, capWithMarkBytes, pageFilePaths,
  parseChromiumArgs
} from './lib/realCorpus.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHROMIUM = process.env.CHROMIUM_PATH || '/Applications/Chromium.app/Contents/MacOS/Chromium';
const CHROMIUM_ARGS = parseChromiumArgs();

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
}));
const ONLY = args.only ? String(args.only).split(',') : null;
const GOTO_TIMEOUT = Number(args.timeout || 45000);
// After "load", scripts and lazy content keep settling. A fixed settle keeps the corpus
// reproducible without waiting for a network idle that analytics pages never reach.
const SETTLE_MS = 3000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
process.on('exit', () => { for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true }); });

async function main() {
  const manifest = loadManifest(CORPUS_DIR);
  const pages = ONLY ? manifest.pages.filter((p) => ONLY.includes(p.name)) : manifest.pages;
  const unknown = (ONLY || []).filter((n) => !manifest.pages.some((p) => p.name === n));
  if (unknown.length) throw new Error(`Unknown page(s) in --only: ${unknown.join(', ')}. Known: ${manifest.pages.map((p) => p.name).join(', ')}`);
  if (!pages.length) throw new Error('nothing to record');

  if (!fs.existsSync(CHROMIUM)) throw new Error(`Chromium not found at ${CHROMIUM}. Set CHROMIUM_PATH.`);
  let puppeteer;
  try {
    puppeteer = (await import('puppeteer-core')).default;
  } catch (err) {
    if (err && err.code === 'ERR_MODULE_NOT_FOUND') throw new Error('puppeteer-core is not installed. Run: cd tests/e2e && npm ci');
    throw err;
  }

  const profileDir = makeTempDir('tarka-record-');
  const browser = await puppeteer.launch({
    executablePath: CHROMIUM,
    headless: true,
    pipe: true,
    defaultViewport: { width: 1280, height: 900 },
    handleSIGINT: false,
    handleSIGTERM: false,
    args: [
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      // Headless Chromium is refused by several shop WAFs (frame.work, idealo, geizhals) before
      // the page renders. These two flags present it as a normal browser of the same engine.
      '--disable-blink-features=AutomationControlled',
      '--lang=de-DE,de',
      '--window-size=1280,900',
      ...CHROMIUM_ARGS
    ]
  });
  cleanups.push(() => browser.close().catch(() => {}));
  console.log(`recording ${pages.length} page(s) into ${CORPUS_DIR}`);

  const recorded = [];
  const failed = [];
  for (const page of pages) {
    const tab = await browser.newPage();
    try {
      // A normal browser UA: headless Chromium's own UA carries "HeadlessChrome", which several
      // shop WAFs refuse. A fresh profile carries no cookies, so no sign-in state or tracking
      // id of this machine can reach the page. The scrubber below is the second line of defence.
      await tab.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36');
      await tab.goto(page.url, { waitUntil: 'load', timeout: GOTO_TIMEOUT });
      await sleep(SETTLE_MS);
      const captured = await tab.evaluate(() => ({
        title: document.title,
        finalUrl: location.href,
        html: document.documentElement.outerHTML,
        text: document.body ? document.body.innerText : ''
      }));
      const html = capWithMarkBytes(scrubPersonalData(captured.html), HTML_CAP, HTML_TRUNCATION_MARK);
      const text = capWithMark(scrubPersonalData(captured.text), TEXT_CAP, TEXT_TRUNCATION_MARK);
      const url = scrubUrl(captured.finalUrl);
      const files = pageFilePaths(CORPUS_DIR, page.name);
      fs.mkdirSync(CORPUS_DIR, { recursive: true });
      const gz = zlib.gzipSync(Buffer.from(html, 'utf8'), { level: 9 });
      fs.writeFileSync(files.html, gz);
      fs.writeFileSync(files.text, text);
      const meta = {
        name: page.name,
        kind: page.kind || '',
        url,
        requestedUrl: scrubUrl(page.url),
        title: scrubPersonalData(captured.title),
        capturedAt: new Date().toISOString(),
        viewport: { width: 1280, height: 900 },
        htmlBytes: gz.length,
        htmlUncompressedBytes: Buffer.byteLength(html, 'utf8'),
        textLength: text.length,
        htmlSha256: crypto.createHash('sha256').update(html, 'utf8').digest('hex')
      };
      fs.writeFileSync(files.meta, `${JSON.stringify(meta, null, 2)}\n`);
      console.log(`recorded ${page.name}: ${meta.htmlUncompressedBytes} B DOM (${gz.length} B gzipped), ${meta.textLength} chars of text <- ${url}`);
      recorded.push(page.name);
    } catch (err) {
      failed.push({ name: page.name, url: page.url, error: String(err && err.message || err).split('\n')[0] });
      console.warn(`FAILED  ${page.name}: ${failed[failed.length - 1].error}`);
    } finally {
      await tab.close().catch(() => {});
    }
  }

  await browser.close().catch(() => {});
  console.log(`\ndone: ${recorded.length} recorded, ${failed.length} failed`);
  if (failed.length) {
    for (const f of failed) console.warn(`  ${f.name} (${f.url}): ${f.error}`);
    console.warn('failed pages are left out of the corpus; fix the URL or the reachability and run the recorder again for them (--only=...)');
    process.exitCode = 1;
  }
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
