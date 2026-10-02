import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractSnippet,
  parsePrice,
  createFinding,
  deduplicateFindings,
  compileTruthTable,
  renderTruthTableMarkdown
} from '../../src/background/agent/findings.ts';
import type { Finding, SiteSpec } from '../../src/background/graph/state.ts';

test('findings: extractSnippet finds value and captures surrounding context', () => {
  const pageText = 'Welcome to the shop. The Framework Laptop 16 is available now ab 1.599,00 EUR with free shipping. Buy today.';
  const snippet = extractSnippet(pageText, '1.599,00 EUR');

  assert.ok(snippet.includes('1.599,00 EUR'));
  assert.ok(snippet.includes('Framework Laptop 16'));
});

test('findings: parsePrice extracts numeric amount and currency', () => {
  assert.deepEqual(parsePrice('1.599,00 EUR'), { amount: 1599, currency: 'EUR' });
  assert.deepEqual(parsePrice('$1,499.99'), { amount: 1499.99, currency: '$' });
  assert.deepEqual(parsePrice('free'), { amount: null, currency: null });
});

test('findings: createFinding validates presence on page', () => {
  const params = {
    siteId: 's1',
    field: 'price',
    rawValue: '1.599,00 EUR',
    url: 'https://frame.work/de/shop',
    title: 'Framework Shop',
    docId: 'doc-1',
    step: 3,
    capturedAt: Date.now(),
    pageText: 'Price is 1.599,00 EUR today.',
    domain: 'frame.work'
  };

  const finding = createFinding(params);
  assert.ok(finding);
  assert.equal(finding?.value, 1599);
  assert.equal(finding?.valueRaw, '1.599,00 EUR');
  assert.equal(finding?.quality, 'verified');
  assert.ok(finding?.evidence.snippet.includes('1.599,00 EUR'));

  // Missing on page returns null
  const missing = createFinding({ ...params, rawValue: '999,00 EUR' });
  assert.equal(missing, null);
});

test('findings: deduplicateFindings replaces older finding and records supersedes', () => {
  const f1: Finding = {
    id: 'f1',
    siteId: 's1',
    field: 'price',
    valueRaw: '1.599,00 EUR',
    value: '1.599,00 EUR',
    url: 'u1',
    capturedAt: '2026-10-02T12:00:00Z',
    docId: 'd1',
    step: 1,
    pageTitle: 't1',
    evidence: { source: 'text', snippet: 'snip1' },
    quality: 'unverified',
    checks: ['value_on_page', 'domain_matches', 'currency_ok', 'title_matches']
  };

  const f2: Finding = {
    ...f1,
    id: 'f2',
    valueRaw: '1.499,00 EUR',
    value: '1.499,00 EUR',
    quality: 'verified'
  };

  const dedupe = deduplicateFindings([f1], f2);
  assert.equal(dedupe.length, 1);
  assert.equal(dedupe[0].id, 'f2');
  assert.equal(dedupe[0].supersedes, 'f1');
});

test('findings: compileTruthTable and renderTruthTableMarkdown', () => {
  const sites: SiteSpec[] = [
    {
      id: 's1',
      name: 'frame.work',
      domain: 'frame.work',
      goal: 'Find price',
      goalKind: 'collect',
      role: 'reference',
      kind: 'store',
      difficulty: 1,
      namedByUser: true,
      criteria: { fields: [{ name: 'price', required: true }], doneWhen: 'all_required' }
    },
    {
      id: 's2',
      name: 'idealo.de',
      domain: 'idealo.de',
      goal: 'Compare price',
      goalKind: 'collect',
      role: 'compare',
      kind: 'listing',
      difficulty: 2,
      namedByUser: true,
      criteria: { fields: [{ name: 'price', required: true }], doneWhen: 'all_required' }
    }
  ];

  const findings: Finding[] = [
    {
      id: 'f1',
      siteId: 's1',
      field: 'price',
      valueRaw: '1.000,00 EUR',
      value: '1.000,00 EUR',
      url: 'https://frame.work',
      capturedAt: '2026-10-02T12:00:00Z',
      docId: 'd1',
      step: 1,
      pageTitle: 'Framework',
      evidence: { source: 'text', snippet: '1000' },
      quality: 'verified',
      checks: ['value_on_page', 'domain_matches', 'currency_ok', 'title_matches']
    },
    {
      id: 'f2',
      siteId: 's2',
      field: 'price',
      valueRaw: '1.150,00 EUR',
      value: '1.150,00 EUR',
      url: 'https://idealo.de',
      capturedAt: '2026-10-02T12:01:00Z',
      docId: 'd2',
      step: 4,
      pageTitle: 'Idealo',
      evidence: { source: 'text', snippet: '1150' },
      quality: 'verified',
      checks: ['value_on_page', 'domain_matches', 'currency_ok', 'title_matches']
    }
  ];

  const table = compileTruthTable(sites, findings, { reference_domain: 'frame.work', field: 'price', threshold_pct: 10 });
  assert.equal(table.rows.length, 2);
  assert.equal(table.rows[1].cells.price?.flag, '+15.0% vs reference');

  const md = renderTruthTableMarkdown(table);
  assert.ok(md.includes('[1.000,00 EUR](https://frame.work)'));
  assert.ok(md.includes('[1.150,00 EUR](https://idealo.de) (+15.0% vs reference)'));
});

test('findings: compileTruthTable handles missing or string criteria fields safely', () => {
  const sites: any[] = [
    {
      id: 's1',
      domain: 'action.test',
      criteria: { doneWhen: 'predicate' },
    },
    {
      id: 's2',
      domain: 'store.test',
      criteria: { fields: ['price', 'shipping'], doneWhen: 'all_required' },
    },
  ];

  const table = compileTruthTable(sites, []);
  assert.equal(table.columns.length, 2);
  assert.ok(table.columns.includes('price'));
  assert.ok(table.columns.includes('shipping'));
  assert.equal(table.rows.length, 2);
});

