/**
 * The real-page corpus (tests/fixtures/real): shared logic for the recorder
 * (tests/e2e/record-real.mjs), the replay job (tests/e2e/replay-real.mjs) and the corpus
 * audit in `npm test` (tests/realCorpus.test.js).
 *
 * The corpus holds recorded REAL pages (serialized DOM, visible text, metadata), recorded by
 * the recorder in a real Chromium, with personal data scrubbed and every file size-capped.
 * The replay loads the recorded DOM from a local server, runs the real content scripts over
 * it, and asserts hand-written expectations plus a baseline alarm: a drop in extracted text
 * length or element count against the stored baseline fails the job.
 *
 * This module is pure logic only (no browser, no server), so `npm test` can pin it.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CORPUS_DIR = path.resolve(HERE, '..', '..', 'fixtures', 'real');

/** The corpus must hold at least this many recorded real pages (ticket acceptance). */
export const MIN_CORPUS_PAGES = 15;
/** The serialized DOM of one page is capped at this many bytes before it is stored. Real shop and news pages reach 2.3 MB of DOM (the frame.work configurator), and a cut DOM breaks the replay's fidelity for everything past the cut, so the cap sits above that. Gzip keeps the committed files small. */
export const HTML_CAP = 4 * 1024 * 1024;
/** The visible text of one page is capped at this many characters before it is stored. */
export const TEXT_CAP = 200 * 1024;
export const HTML_TRUNCATION_MARK = '<!-- tarka-corpus: html truncated at the size cap -->';
export const TEXT_TRUNCATION_MARK = '[tarka-corpus: text truncated at the size cap]';

/** A drop of a page's text length or element count beyond this share of the baseline fails the replay. */
export const BASELINE_DROP_TOLERANCE = 0.05;

export const MANIFEST_FILE = 'manifest.json';
export const EXPECTATIONS_FILE = 'expectations.json';
export const BASELINE_FILE = 'baseline.json';

/**
 * Splits a whitespace-delimited flag string (such as process.env.CHROMIUM_ARGS) into an array
 * of arguments suitable for Puppeteer's args option.
 */
export function parseChromiumArgs(raw = process.env.CHROMIUM_ARGS) {
  if (typeof raw !== 'string') return [];
  return raw.trim().split(/\s+/).filter(Boolean);
}

// ---------------------------------------------------------------------------------------------
// Scrubbing: personal data never reaches the committed corpus.
// ---------------------------------------------------------------------------------------------

const EMAIL_LIKE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// A phone-like or otherwise personal digit run: 9 or more digits, optionally grouped by
// spaces, dashes, dots or slashes. Prices (1.399,00), order numbers (42) and model names
// (16) stay untouched.
const LONG_DIGIT_RUN = /(?:\+?\d[\d\s./-]{8,}\d)/g;
// Long opaque secrets in URLs or page text: JWT-shaped values, and pure-alphanumeric runs of
// 32 or more characters (api keys, hashes, base64 blobs). Slugs and ids with dashes or dots
// do not match, so real addresses and product paths survive.
const TOKEN_LIKE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b|\b[A-Za-z0-9]{32,}\b/g;
// Query parameters that carry session or identity state.
const SENSITIVE_PARAMS = /^(?:session|sessionid|sid|token|auth|apikey|api_key|key|nonce|state|code|access_token|refresh_token|sso|phpsessid|jsessionid)$/i;

/** Replaces email addresses, phone-like digit runs and opaque tokens with markers. */
export function scrubPersonalData(text) {
  return String(text || '')
    .replace(EMAIL_LIKE, '[email]')
    .replace(LONG_DIGIT_RUN, (m) => (m.replace(/\D/g, '').length >= 9 ? '[number]' : m))
    .replace(TOKEN_LIKE, '[token]');
}

/** Keeps only the path and the query parameters that carry no session state. */
export function scrubUrl(url) {
  try {
    const parsed = new URL(url);
    const kept = [];
    for (const [key, value] of parsed.searchParams) {
      if (!SENSITIVE_PARAMS.test(key)) kept.push(`${key}=${value}`);
    }
    return `${parsed.origin}${parsed.pathname}${kept.length ? `?${kept.join('&')}` : ''}`;
  } catch {
    return String(url || '');
  }
}

// ---------------------------------------------------------------------------------------------
// Size caps and the static replay form of a page.
// ---------------------------------------------------------------------------------------------

/** Cuts `text` so the result (mark included) stays within `max`, and appends `mark` when it did cut. */
export function capWithMark(text, max, mark) {
  const s = String(text || '');
  if (s.length <= max) return s;
  const keep = Math.max(0, max - mark.length - 1);
  return `${s.slice(0, keep)}\n${mark}`;
}

/**
 * The same cap in UTF-8 bytes (the audit measures bytes, and a page full of non-ASCII text is
 * more bytes than characters). The cut never lands inside a multi-byte character.
 */
export function capWithMarkBytes(text, maxBytes, mark) {
  const s = String(text || '');
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return s;
  const markBytes = Buffer.byteLength(mark, 'utf8');
  let keep = maxBytes - markBytes - 1;
  while (keep > 0 && (buf[keep] & 0xc0) === 0x80) keep--;
  return `${buf.subarray(0, keep).toString('utf8')}\n${mark}`;
}

/**
 * Removes every script tag (inline and external) and every inline event handler attribute,
 * so the replay serves a static page: the recorded DOM as it was captured, with no page
 * script able to mutate it again (hydration would make the replay nondeterministic).
 */
export function stripScripts(html) {
  return String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*\/?>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
}

// ---------------------------------------------------------------------------------------------
// Corpus files.
// ---------------------------------------------------------------------------------------------

/** The three files of one recorded page, by page name. */
export function pageFilePaths(dir, name) {
  return {
    html: path.join(dir, `${name}.html.gz`),
    text: path.join(dir, `${name}.txt`),
    meta: path.join(dir, `${name}.json`)
  };
}

/** Reads one recorded page: the gunzipped DOM, the visible text and the metadata. */
export function readCorpusPage(dir, name) {
  const files = pageFilePaths(dir, name);
  const html = zlib.gunzipSync(fs.readFileSync(files.html)).toString('utf8');
  const text = fs.readFileSync(files.text, 'utf8');
  const meta = JSON.parse(fs.readFileSync(files.meta, 'utf8'));
  return { name, html, text, meta, files };
}

export function loadManifest(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_FILE), 'utf8'));
}

export function loadExpectations(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, EXPECTATIONS_FILE), 'utf8'));
}

export function loadBaseline(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, BASELINE_FILE), 'utf8'));
}

// ---------------------------------------------------------------------------------------------
// Expectations: the hand-written assertions the replay runs per page.
// ---------------------------------------------------------------------------------------------

const EXPECTATION_TYPES = new Set(['page-text-contains', 'full-text-contains', 'element-label-matches', 'element-count-at-least']);

/** Checks one page's expectations against its snapshot. Returns a list of problems (empty means pass). */
export function evaluateExpectations(expectations, snapshot) {
  const problems = [];
  const pageText = String(snapshot.pageText || '');
  const fullText = String(snapshot.fullText || '');
  const elementsText = String(snapshot.elementsText || '');
  for (const exp of expectations || []) {
    if (!exp || !EXPECTATION_TYPES.has(exp.type)) {
      problems.push(`unknown expectation type ${JSON.stringify(exp && exp.type)}`);
      continue;
    }
    if (exp.type === 'page-text-contains' || exp.type === 'full-text-contains') {
      const where = exp.type === 'page-text-contains' ? pageText : fullText;
      if (!where.toLowerCase().includes(String(exp.value).toLowerCase())) {
        problems.push(`${exp.type === 'page-text-contains' ? 'page text' : 'full page text'} does not contain ${JSON.stringify(exp.value)}`);
      }
    } else if (exp.type === 'element-label-matches') {
      let re;
      try {
        re = new RegExp(exp.regex, 'i');
      } catch (err) {
        problems.push(`element-label-matches regex is invalid: ${err.message}`);
        continue;
      }
      if (!re.test(elementsText)) {
        problems.push(`no element label matches /${exp.regex}/i in the element list`);
      }
    } else if (exp.type === 'element-count-at-least') {
      const count = (elementsText.match(/^\[\d+\]/gm) || []).length;
      if (!(count >= exp.min)) {
        problems.push(`element list holds ${count} entries, expected at least ${exp.min}`);
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// The baseline alarm.
// ---------------------------------------------------------------------------------------------

/**
 * Compares the replay's per-page counts against the stored baseline. A drop beyond the
 * tolerance (extracted text length or element count) is the alarm; growth is fine, because
 * real content may grow, while a silent loss is what the extractor defects looked like.
 */
export function baselineProblems(current, baseline, tolerance = BASELINE_DROP_TOLERANCE) {
  const problems = [];
  const pages = (baseline && baseline.pages) || {};
  for (const [name, now] of Object.entries(current || {})) {
    const before = pages[name];
    if (!before || typeof before.textLength !== 'number' || typeof before.elementCount !== 'number') {
      problems.push({ page: name, problem: 'the baseline has no entry for this page (run the replay with --update-baseline after a corpus refresh)' });
      continue;
    }
    if (now.textLength < before.textLength * (1 - tolerance)) {
      problems.push({ page: name, problem: `extracted text length dropped to ${now.textLength} chars, baseline ${before.textLength} (more than ${Math.round(tolerance * 100)}% lost)` });
    }
    if (now.elementCount < before.elementCount * (1 - tolerance)) {
      problems.push({ page: name, problem: `element count dropped to ${now.elementCount}, baseline ${before.elementCount} (more than ${Math.round(tolerance * 100)}% lost)` });
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// The audit: what `npm test` runs against the committed corpus.
// ---------------------------------------------------------------------------------------------

/**
 * Audits the corpus without a browser: the manifest, the recorded files, the size caps, the
 * personal-data scrub, the expectations and the baseline must all agree. Returns
 * { pages, problems } where problems is a list of { page?, problem }. `requireBaseline` is
 * false for the replay's preflight (the first replay run creates the baseline) and true for
 * the committed-corpus audit in `npm test`.
 */
export function auditCorpus(dir = CORPUS_DIR, { requireBaseline = true } = {}) {
  const problems = [];
  let manifest;
  try {
    manifest = loadManifest(dir);
  } catch (err) {
    return { pages: [], problems: [{ problem: `${MANIFEST_FILE} is missing or unreadable: ${err.message}` }] };
  }
  const pages = (manifest.pages || []).map((p) => p.name);

  const recorded = [];
  for (const page of manifest.pages || []) {
    const files = pageFilePaths(dir, page.name);
    if (!fs.existsSync(files.html) || !fs.existsSync(files.text) || !fs.existsSync(files.meta)) {
      problems.push({ page: page.name, problem: 'no recorded files for this manifest page (run the recorder)' });
      continue;
    }
    let pageData;
    try {
      pageData = readCorpusPage(dir, page.name);
    } catch (err) {
      problems.push({ page: page.name, problem: `recorded files are unreadable: ${err.message}` });
      continue;
    }
    recorded.push(page.name);
    if (Buffer.byteLength(pageData.html, 'utf8') > HTML_CAP) {
      problems.push({ page: page.name, problem: `serialized DOM is larger than the ${HTML_CAP} byte cap` });
    }
    if (pageData.text.length > TEXT_CAP) {
      problems.push({ page: page.name, problem: `visible text is larger than the ${TEXT_CAP} character cap` });
    }
    if (!pageData.meta || !pageData.meta.url || !pageData.meta.capturedAt) {
      problems.push({ page: page.name, problem: 'metadata lacks url or capturedAt' });
    } else if (EMAIL_LIKE.source && new RegExp(EMAIL_LIKE.source).test(scrubUrl(pageData.meta.url))) {
      problems.push({ page: page.name, problem: 'the recorded url still holds an email address' });
    }
    const scrubbed = scrubPersonalData(pageData.text);
    const emailHit = new RegExp(EMAIL_LIKE.source).exec(scrubbed);
    if (emailHit) {
      problems.push({ page: page.name, problem: `the stored visible text still holds what looks like an email address (${emailHit[0]})` });
    }
  }

  if (recorded.length < MIN_CORPUS_PAGES) {
    problems.push({ problem: `the corpus holds ${recorded.length} recorded pages, at least ${MIN_CORPUS_PAGES} are required` });
  }

  let expectations;
  try {
    expectations = loadExpectations(dir);
  } catch (err) {
    problems.push({ problem: `${EXPECTATIONS_FILE} is missing or unreadable: ${err.message}` });
  }
  if (expectations) {
    for (const [name, list] of Object.entries(expectations.pages || {})) {
      if (!recorded.includes(name)) problems.push({ page: name, problem: 'expectations reference a page that is not recorded' });
      if (!Array.isArray(list) || list.length === 0) problems.push({ page: name, problem: 'expectations for this page are empty' });
      for (const exp of list || []) {
        if (!exp || !EXPECTATION_TYPES.has(exp.type)) problems.push({ page: name, problem: `unknown expectation type ${JSON.stringify(exp && exp.type)}` });
        else if (exp.type === 'element-count-at-least' ? typeof exp.min !== 'number' : !(exp.value || exp.regex)) problems.push({ page: name, problem: `expectation ${exp.type} has no ${exp.type === 'element-count-at-least' ? 'min' : 'value or regex'}` });
      }
    }
    if (!Object.keys(expectations.pages || {}).length) problems.push({ problem: 'expectations.json defines no page expectations' });
  }

  let baseline;
  try {
    baseline = loadBaseline(dir);
  } catch (err) {
    if (requireBaseline) problems.push({ problem: `${BASELINE_FILE} is missing or unreadable: ${err.message}` });
  }
  if (baseline && requireBaseline) {
    // The per-page entry check only applies when the audit demands a usable baseline (the
    // committed-corpus audit and every replay that compares against it). The replay's
    // --update-baseline preflight runs with requireBaseline false, because that run writes
    // the entries itself; a fresh corpus must not block its own first baseline update.
    for (const name of recorded) {
      const entry = (baseline.pages || {})[name];
      if (!entry || typeof entry.textLength !== 'number' || typeof entry.elementCount !== 'number') {
        problems.push({ page: name, problem: 'the baseline has no textLength/elementCount entry for this page' });
      }
    }
  }

  return { pages: recorded, problems };
}
