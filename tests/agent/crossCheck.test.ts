import test from 'node:test';
import assert from 'node:assert/strict';
import { compileTruthTable } from '../../src/background/agent/findings.ts';
import type { Finding, SiteSpec } from '../../src/background/graph/state.ts';

const sites: SiteSpec[] = [
  {
    id: 's1',
    name: 'Official Store',
    domain: 'official.test',
    goal: 'Find price and availability',
    goalKind: 'collect',
    role: 'reference',
    kind: 'store',
    difficulty: 1,
    namedByUser: true,
    criteria: {
      fields: [
        { name: 'price', required: true },
        { name: 'status', required: true },
      ],
      doneWhen: 'all_required',
    },
  },
  {
    id: 's2',
    name: 'Reseller Shop',
    domain: 'reseller.test',
    goal: 'Find price and availability',
    goalKind: 'collect',
    role: 'compare',
    kind: 'store',
    difficulty: 1,
    namedByUser: true,
    criteria: {
      fields: [
        { name: 'price', required: true },
        { name: 'status', required: true },
      ],
      doneWhen: 'all_required',
    },
  },
];

test('cross_check_key: flags numeric variance > 20% and downgrades quality to unverified', () => {
  const findings: Finding[] = [
    {
      id: 'f1',
      siteId: 's1',
      field: 'price',
      valueRaw: '100 EUR',
      value: 100,
      url: 'https://official.test',
      capturedAt: '2026-10-04T12:00:00Z',
      docId: 'd1',
      step: 1,
      evidence: { source: 'text', snippet: '100 EUR' },
      quality: 'verified',
      checks: ['value_on_page'],
    },
    {
      id: 'f2',
      siteId: 's2',
      field: 'price',
      valueRaw: '135 EUR', // +35% variance (> 20%)
      value: 135,
      url: 'https://reseller.test',
      capturedAt: '2026-10-04T12:05:00Z',
      docId: 'd2',
      step: 3,
      evidence: { source: 'text', snippet: '135 EUR' },
      quality: 'verified',
      checks: ['value_on_page'],
    },
  ];

  const table = compileTruthTable(sites, findings, null, 'cross_check_key');

  const cell1 = table.rows[0].cells.price;
  const cell2 = table.rows[1].cells.price;

  assert.ok(cell1);
  assert.ok(cell2);
  assert.equal(cell1?.quality, 'verified');
  assert.equal(cell2?.quality, 'unverified', 'Deviating finding should be downgraded to unverified');
  assert.ok(cell2?.flag?.includes('disputed'), 'Deviating finding should have disputed flag');
  assert.ok(table.rows[1].flags.some(f => f.includes('disputed')));
});

test('cross_check_key: preserves verified quality when variance <= 20%', () => {
  const findings: Finding[] = [
    {
      id: 'f1',
      siteId: 's1',
      field: 'price',
      valueRaw: '100 EUR',
      value: 100,
      url: 'https://official.test',
      capturedAt: '2026-10-04T12:00:00Z',
      docId: 'd1',
      step: 1,
      evidence: { source: 'text', snippet: '100 EUR' },
      quality: 'verified',
      checks: ['value_on_page'],
    },
    {
      id: 'f2',
      siteId: 's2',
      field: 'price',
      valueRaw: '110 EUR', // +10% variance (<= 20%)
      value: 110,
      url: 'https://reseller.test',
      capturedAt: '2026-10-04T12:05:00Z',
      docId: 'd2',
      step: 3,
      evidence: { source: 'text', snippet: '110 EUR' },
      quality: 'verified',
      checks: ['value_on_page'],
    },
  ];

  const table = compileTruthTable(sites, findings, null, 'cross_check_key');

  const cell1 = table.rows[0].cells.price;
  const cell2 = table.rows[1].cells.price;

  assert.equal(cell1?.quality, 'verified');
  assert.equal(cell2?.quality, 'verified');
  assert.ok(!cell2?.flag?.includes('disputed'));
});

test('cross_check_all: flags text mismatch across sites and downgrades quality', () => {
  const findings: Finding[] = [
    {
      id: 'f1',
      siteId: 's1',
      field: 'status',
      valueRaw: 'In Stock',
      value: 'In Stock',
      url: 'https://official.test',
      capturedAt: '2026-10-04T12:00:00Z',
      docId: 'd1',
      step: 1,
      evidence: { source: 'text', snippet: 'In Stock' },
      quality: 'verified',
      checks: ['value_on_page'],
    },
    {
      id: 'f2',
      siteId: 's2',
      field: 'status',
      valueRaw: 'Discontinued', // Text mismatch
      value: 'Discontinued',
      url: 'https://reseller.test',
      capturedAt: '2026-10-04T12:05:00Z',
      docId: 'd2',
      step: 3,
      evidence: { source: 'text', snippet: 'Discontinued' },
      quality: 'verified',
      checks: ['value_on_page'],
    },
  ];

  const table = compileTruthTable(sites, findings, null, 'cross_check_all');

  const cell1 = table.rows[0].cells.status;
  const cell2 = table.rows[1].cells.status;

  assert.equal(cell1?.quality, 'unverified');
  assert.equal(cell2?.quality, 'unverified');
  assert.ok(cell1?.flag?.includes('disputed (mismatch)'));
  assert.ok(cell2?.flag?.includes('disputed (mismatch)'));
});
