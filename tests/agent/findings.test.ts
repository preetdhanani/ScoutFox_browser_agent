import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractSnippet,
  parsePrice,
  createFinding,
  deduplicateFindings,
  proseMatch,
  findingsContentSignature,
  isAutoValueField,
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


test('findings: proseMatch accepts page-grounded prose and rejects invented or short values', () => {
  const pageText = 'Hacker News. A Modern Web App in C. The Making Of Super Mario 64: full Giles Goddard interview. Secret of Orange Cats Revealed After 60-Year Search. 42 points. save. hide.';

  // A written-up summary whose long words are on the page: accepted, with a page snippet.
  const grounded = proseMatch(pageText, 'A modern web app in C, plus the making of Super Mario 64 and the secret of orange cats revealed');
  assert.ok(grounded);
  assert.ok(grounded.ratio >= 0.7);
  assert.ok(grounded.snippet.length > 0);

  // Mostly invented content: rejected.
  assert.equal(proseMatch(pageText, 'Underwater basket weaving societies expand across Atlantic harbor towns, a demographic analysis finds'), null);

  // Too few long words to judge: stays on the strict path.
  assert.equal(proseMatch(pageText, 'Hacker News'), null);

  // Word boundaries: "assembly" does not match inside "WebAssembly", so only 4 of the 5 long
  // words hit - if boundaries were ignored the ratio would be 1.
  const boundary = proseMatch('WebAssembly static recompilation modern analysis', 'web modern analysis recompilation static assembly');
  assert.ok(boundary);
  assert.equal(boundary.ratio, 0.8);
});

test('findings: createFinding records grounded prose only when allowProseMatch is set, never for money fields', () => {
  const pageText = 'Hacker News. A Modern Web App in C. The Making Of Super Mario 64: full Giles Goddard interview. Secret of Orange Cats Revealed After 60-Year Search.';
  const base = {
    siteId: 's1',
    url: 'https://news.ycombinator.test/',
    title: 'Hacker News',
    docId: 'd1',
    step: 1,
    capturedAt: '2026-10-12T18:41:00Z',
    pageText,
    domain: 'news.ycombinator.test',
  };
  const summary = 'A modern web app in C, plus the making of Super Mario 64 and the full Giles Goddard interview, and the secret of orange cats revealed';

  // Strict default: the summary is not word-for-word on the page, so it is dropped.
  assert.equal(createFinding({ ...base, field: 'summary', rawValue: summary }), null);

  // With the prose check allowed it is recorded, but flagged unverified.
  const loose = createFinding({ ...base, field: 'summary', rawValue: summary, allowProseMatch: true });
  assert.ok(loose);
  assert.equal(loose!.quality, 'unverified');
  assert.ok(loose!.checks.includes('value_on_page'));
  assert.ok(loose!.checks.includes('value_loose_match'));

  // A money field never gets the loose path, even with allowProseMatch.
  assert.equal(createFinding({ ...base, field: 'price', rawValue: '1.299,00 EUR', allowProseMatch: true }), null);

  // A verbatim value verifies as before.
  const exact = createFinding({ ...base, field: 'title', rawValue: 'A Modern Web App in C', allowProseMatch: true });
  assert.ok(exact);
  assert.equal(exact!.quality, 'verified');
});

test('findings: findingsContentSignature ignores finding ids but reacts to value and quality changes', () => {
  const finding = (over: Partial<Finding>): Finding => ({
    id: 'f1', siteId: 's1', field: 'summary', valueRaw: 'same text', value: 'same text',
    url: 'https://x.test', capturedAt: '2026-10-12T18:41:00Z', step: 1, pageTitle: 'X',
    evidence: { source: 'text', snippet: '' }, quality: 'unverified', checks: ['value_on_page'],
    ...over,
  } as Finding);

  const base = [finding({})];
  assert.equal(findingsContentSignature(base), findingsContentSignature([finding({ id: 'f2' })]));
  assert.notEqual(findingsContentSignature(base), findingsContentSignature([finding({ valueRaw: 'other text' })]));
  assert.notEqual(findingsContentSignature(base), findingsContentSignature([finding({ quality: 'verified' })]));
  assert.notEqual(findingsContentSignature(base), findingsContentSignature([...base, finding({ id: 'f3', field: 'price' })]));
});

test('findings: isAutoValueField recognizes only exact page-address column names', () => {
  // Auto-value: the address of the page the agent is on, recorded by the engine itself.
  assert.equal(isAutoValueField('url'), true);
  assert.equal(isAutoValueField('link'), true);
  assert.equal(isAutoValueField('href'), true);
  assert.equal(isAutoValueField('page_url'), true);
  assert.equal(isAutoValueField('site_url'), true);
  // Collectable data columns a plan may genuinely ask the model to gather.
  assert.equal(isAutoValueField('article_urls'), false);
  assert.equal(isAutoValueField('links'), false);
  assert.equal(isAutoValueField('github_link'), false);
  assert.equal(isAutoValueField('buy_url'), false);
  assert.equal(isAutoValueField('deep_link'), false);
  assert.equal(isAutoValueField('product_url'), false);
  assert.equal(isAutoValueField('url_status'), false);
  assert.equal(isAutoValueField('title'), false);
  assert.equal(isAutoValueField('summary'), false);
});

test('findings: deduplicateFindings replaces an equal-rank verified correction', () => {
  const first: Finding = {
    id: 'f1', siteId: 's1', field: 'price', valueRaw: '149 EUR', value: 149,
    url: 'https://x.test', capturedAt: '2026-10-12T18:41:00Z', step: 1, pageTitle: 'X',
    docId: 'd1', evidence: { source: 'text', snippet: '149 EUR' }, quality: 'verified',
    checks: ['value_on_page', 'domain_matches', 'currency_ok', 'title_matches'],
  };
  const correction: Finding = {
    ...first,
    id: 'f2',
    valueRaw: '129 EUR',
    value: 129,
    step: 2,
  };

  const deduped = deduplicateFindings([first], correction);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].id, 'f2');
  assert.equal(deduped[0].valueRaw, '129 EUR');
  assert.equal(deduped[0].supersedes, 'f1');
});

test('findings: deduplicateFindings never downgrades quality - a reworded unverified value cannot replace a verified one', () => {
  const verified: Finding = {
    id: 'f1', siteId: 's1', field: 'summary', valueRaw: 'verbatim page text here', value: 'verbatim page text here',
    url: 'https://x.test', capturedAt: '2026-10-12T18:41:00Z', step: 1, pageTitle: 'X',
    docId: 'd1', evidence: { source: 'text', snippet: 'verbatim page text here' }, quality: 'verified',
    checks: ['value_on_page', 'domain_matches', 'currency_ok', 'title_matches'],
  };
  const reword: Finding = {
    ...verified,
    id: 'f2',
    valueRaw: 'a slightly re-phrased summary of the same verbatim page text here',
    quality: 'unverified',
    checks: ['value_on_page', 'value_loose_match', 'domain_matches', 'title_matches'],
  };

  const deduped = deduplicateFindings([verified], reword);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].id, 'f1');
  assert.equal(deduped[0].quality, 'verified');

  // And a genuine upgrade still lands: an unverified value becomes verified.
  const upgraded = { ...reword, id: 'f3', quality: 'verified' as const, valueRaw: 'verbatim page text here' };
  const after = deduplicateFindings([reword], upgraded);
  assert.equal(after.length, 1);
  assert.equal(after[0].id, 'f3');
  assert.equal(after[0].quality, 'verified');
  assert.equal(after[0].supersedes, 'f2');
});

test('findings: createFinding uses the tab title as page evidence for an exact copy', () => {
  const params = {
    siteId: 's1',
    url: 'https://z.ai/blog/glm-legal',
    title: 'Everything for 99 EUR this week only!',
    docId: 'doc-1',
    step: 1,
    capturedAt: Date.now(),
    // The extractor missed the value - it is only in the tab <title>.
    pageText: 'Cookie banner. Accept all. Subscribe to our newsletter.',
    domain: 'z.ai',
    allowProseMatch: true,
  };

  // A non-strict field accepts the title as evidence for an exactly copied value.
  const finding = createFinding({ ...params, field: 'title', rawValue: 'Everything for 99 EUR this week only!' });
  assert.ok(finding);
  assert.equal(finding!.quality, 'verified');

  // A strict (money) field never verifies from the title, not even on the exact path.
  const strictMiss = createFinding({ ...params, field: 'price', rawValue: '99 EUR' });
  assert.equal(strictMiss, null);
});

test('findings: a table with no columns has one cell per row (no stray empty cell under the one-column header)', () => {
  const md = renderTruthTableMarkdown({
    columns: [],
    rows: [{ siteId: 's1', site: 'github.test', role: 'reference', status: 'done', cells: {}, note: null, flags: [] }],
    cheapest: null,
    gaps: []
  } as any);
  assert.equal(md, '| Site |\n| --- |\n| **github.test** (reference) |');
});

test('findings: a table with columns is unchanged by the row-building fix', () => {
  const md = renderTruthTableMarkdown({
    columns: ['price', 'shipping'],
    rows: [{ siteId: 's1', site: 'frame.work', role: 'reference', status: 'done', cells: { price: { value: '1.000,00 EUR', url: 'https://frame.work', quality: 'verified' } }, note: null, flags: [] }],
    cheapest: null,
    gaps: []
  } as any);
  assert.equal(md.split('\n')[2], '| **frame.work** (reference) | [1.000,00 EUR](https://frame.work) | not found |');
});
