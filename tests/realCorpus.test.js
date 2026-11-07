/**
 * The real-page corpus helpers (tests/e2e/lib/realCorpus.mjs) and the corpus itself
 * (tests/fixtures/real). These tests run in `npm test` with no browser: they pin the pure
 * logic (scrubbing, caps, expectations, baseline alarm) and audit the committed corpus, so
 * a corpus page that loses its files, grows past its size cap or carries personal data
 * fails the normal suite and not only the nightly replay.
 *
 * The corpus audit is also the negative control for the ticket's test-first rule: before the
 * recorder and the corpus existed, every assertion here failed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  MIN_CORPUS_PAGES,
  HTML_CAP,
  TEXT_CAP,
  scrubPersonalData,
  scrubUrl,
  capWithMark,
  capWithMarkBytes,
  stripScripts,
  evaluateExpectations,
  baselineProblems,
  auditCorpus,
  parseChromiumArgs,
  CORPUS_DIR
} from './e2e/lib/realCorpus.mjs';

test('scrubPersonalData replaces email addresses', () => {
  const out = scrubPersonalData('contact jane.doe@example.com or sales@example.co.uk today');
  assert.ok(!/@/.test(out.replace(/\s+/g, ' ')) || !/[\w.]+@[\w.]+\.\w{2,}/.test(out), `email survived: ${out}`);
  assert.ok(out.includes('[email]'));
  assert.ok(out.includes('contact') && out.includes('today'));
});

test('scrubPersonalData replaces phone-like and long digit runs', () => {
  const out = scrubPersonalData('call +49 170 1234567 or 0170123456789 now');
  assert.ok(!/170\s?1234567/.test(out), `phone survived: ${out}`);
  assert.ok(out.includes('[number]'));
});

test('scrubPersonalData keeps prices and short numbers', () => {
  const out = scrubPersonalData('price 1.399,00 EUR, order 42, model 16');
  assert.equal(out, 'price 1.399,00 EUR, order 42, model 16');
});

test('scrubUrl strips session-like query parameters and keeps the rest', () => {
  const out = scrubUrl('https://example.com/p?a=1&sessionid=abc&token=xyz&q=laptop');
  assert.ok(out.includes('a=1'));
  assert.ok(out.includes('q=laptop'));
  assert.ok(!/sessionid|token=/.test(out));
});

test('capWithMark truncates at the cap and marks it', () => {
  const out = capWithMark('x'.repeat(100), 50, '[cut]');
  assert.ok(out.length <= 50 + '[cut]'.length + 1);
  assert.ok(out.endsWith('[cut]'));
  assert.equal(capWithMark('short', 50, '[cut]'), 'short');
});

test('capWithMarkBytes keeps multi-byte text within the byte cap', () => {
  const text = 'ä'.repeat(400000); // 2 bytes per character in UTF-8
  const out = capWithMarkBytes(text, 1000, '[ende]');
  assert.ok(Buffer.byteLength(out, 'utf8') <= 1000, `byte length ${Buffer.byteLength(out, 'utf8')}`);
  assert.ok(out.endsWith('[ende]'));
  assert.ok(!out.includes('\uFFFD'), 'the cut landed inside a multi-byte character');
  assert.equal(capWithMarkBytes('kurz', 1000, '[ende]'), 'kurz');
});

test('stripScripts removes inline and external script tags', () => {
  const html = '<html><head><script src="https://cdn.example/x.js"></script><script>var a = 1;</script></head><body><p>hi</p><script>bad()</script></body></html>';
  const out = stripScripts(html);
  assert.ok(!/<script/i.test(out));
  assert.ok(out.includes('<p>hi</p>'));
});

test('evaluateExpectations passes a snapshot that has the line and the button', () => {
  const problems = evaluateExpectations([
    { type: 'page-text-contains', value: 'Free shipping on orders over 199 EUR' },
    { type: 'element-label-matches', regex: 'add to cart|in den warenkorb' }
  ], {
    pageText: 'Free shipping on orders over 199 EUR applies.',
    fullText: 'Free shipping on orders over 199 EUR applies.',
    elementsText: '[3] button[button] "Add to cart"'
  });
  assert.deepEqual(problems, []);
});

test('evaluateExpectations reports a missing shipping line and a missing buy button', () => {
  // The shape of the old defect: the shipping line was dropped from the page text, so the
  // expectation must fail against a snapshot that lost it.
  const problems = evaluateExpectations([
    { type: 'page-text-contains', value: 'Free shipping on orders over 199 EUR' },
    { type: 'element-label-matches', regex: 'add to cart|in den warenkorb' }
  ], {
    pageText: 'Some other text without the line.',
    fullText: 'Some other text without the line.',
    elementsText: '[1] a "Home"'
  });
  assert.equal(problems.length, 2);
  assert.match(problems[0], /shipping|Free shipping/i);
  assert.match(problems[1], /element|button/i);
});

test('evaluateExpectations reads full-text-contains from the full text and counts elements', () => {
  const ok = evaluateExpectations([
    { type: 'full-text-contains', value: 'deep in the page' },
    { type: 'element-count-at-least', min: 5 }
  ], { pageText: 'head only', fullText: 'head only ... deep in the page', elementsText: '[1] a\n[2] a\n[3] a\n[4] a\n[5] a' });
  assert.deepEqual(ok, []);
  const bad = evaluateExpectations([{ type: 'element-count-at-least', min: 5 }], { pageText: '', fullText: '', elementsText: '[1] a' });
  assert.equal(bad.length, 1);
});

test('baselineProblems passes on equal or grown counts and fails on a drop', () => {
  const baseline = { pages: { p: { textLength: 10000, elementCount: 200 } } };
  assert.deepEqual(baselineProblems({ p: { textLength: 10000, elementCount: 210 } }, baseline), []);
  assert.deepEqual(baselineProblems({ p: { textLength: 12000, elementCount: 300 } }, baseline), []);
  const dropped = baselineProblems({ p: { textLength: 8000, elementCount: 150 } }, baseline);
  assert.equal(dropped.length, 2);
  assert.match(dropped[0].problem, /text/);
  assert.match(dropped[1].problem, /element/);
});

test('baselineProblems reports a page the baseline does not cover', () => {
  const problems = baselineProblems({ p: { textLength: 10, elementCount: 1 }, q: { textLength: 10, elementCount: 1 } }, { pages: { p: { textLength: 10, elementCount: 1 } } });
  assert.equal(problems.length, 1);
  assert.match(problems[0].problem, /baseline/);
  assert.equal(problems[0].page, 'q');
});

test('auditCorpus with requireBaseline false tolerates a baseline without entries (the first --update-baseline run)', () => {
  // The replay's preflight runs the audit with requireBaseline false before it writes the
  // baseline, so a complete corpus whose baseline file exists but holds no page entries yet
  // must not block its own first baseline update. The corpus itself must still be complete:
  // the min-pages and expectations checks apply in preflight mode too, so the fixture builds
  // a full corpus (MIN_CORPUS_PAGES minimal pages) and only leaves the baseline empty.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-audit-'));
  try {
    const names = Array.from({ length: MIN_CORPUS_PAGES }, (_, i) => `page-${i + 1}`);
    for (const name of names) {
      fs.writeFileSync(path.join(dir, `${name}.html.gz`), zlib.gzipSync('<html><body><p>plain text</p></body></html>'));
      fs.writeFileSync(path.join(dir, `${name}.txt`), 'plain text');
      fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({ url: `https://example.test/${name}`, capturedAt: '2026-10-15T00:00:00.000Z' }));
    }
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ pages: names.map((name) => ({ name })) }));
    fs.writeFileSync(path.join(dir, 'expectations.json'), JSON.stringify({ pages: { 'page-1': [{ type: 'page-text-contains', value: 'plain text' }] } }));
    fs.writeFileSync(path.join(dir, 'baseline.json'), JSON.stringify({ pages: {} }));
    const audit = auditCorpus(dir, { requireBaseline: false });
    assert.deepEqual(audit.problems, []);
    const strict = auditCorpus(dir, { requireBaseline: true });
    assert.equal(strict.problems.length, MIN_CORPUS_PAGES, `every recorded page needs a baseline entry, got: ${JSON.stringify(strict.problems)}`);
    assert.ok(strict.problems.every((p) => /baseline/.test(p.problem)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the committed corpus is complete, capped and free of personal data', () => {
  const audit = auditCorpus(CORPUS_DIR);
  const summary = audit.problems.map((p) => p.page ? `${p.page}: ${p.problem}` : p.problem).join('; ');
  assert.ok(audit.problems.length === 0, `corpus audit problems: ${summary || '(none)'}`);
  assert.ok(audit.pages.length >= MIN_CORPUS_PAGES, `only ${audit.pages.length} recorded pages, expected at least ${MIN_CORPUS_PAGES}`);
  assert.ok(fs.existsSync(CORPUS_DIR));
});

test('parseChromiumArgs returns empty array on empty, whitespace, null, or non-string input', () => {
  assert.deepEqual(parseChromiumArgs(''), []);
  assert.deepEqual(parseChromiumArgs('   '), []);
  assert.deepEqual(parseChromiumArgs(' \t \n '), []);
  assert.deepEqual(parseChromiumArgs(null), []);
  assert.deepEqual(parseChromiumArgs(undefined), []);
  assert.deepEqual(parseChromiumArgs(123), []);
});

test('parseChromiumArgs splits flags and strips extra whitespace', () => {
  assert.deepEqual(parseChromiumArgs('--no-sandbox'), ['--no-sandbox']);
  assert.deepEqual(
    parseChromiumArgs('  --no-sandbox   --disable-dev-shm-usage  --disable-gpu  '),
    ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  );
});

test('parseChromiumArgs reads process.env.CHROMIUM_ARGS by default', () => {
  const prev = process.env.CHROMIUM_ARGS;
  try {
    process.env.CHROMIUM_ARGS = '--no-sandbox --disable-dev-shm-usage';
    assert.deepEqual(parseChromiumArgs(), ['--no-sandbox', '--disable-dev-shm-usage']);
    delete process.env.CHROMIUM_ARGS;
    assert.deepEqual(parseChromiumArgs(), []);
  } finally {
    if (prev !== undefined) process.env.CHROMIUM_ARGS = prev;
    else delete process.env.CHROMIUM_ARGS;
  }
});
