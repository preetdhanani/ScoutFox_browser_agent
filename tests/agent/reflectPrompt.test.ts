// tests/agent/reflectPrompt.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildReflectSystemPrompt,
  buildReflectUserMessage,
  parseReflectResponse,
  isValidExternalUrl,
  getHighestSiteIndex,
} from '../../src/background/agent/reflectPrompt.ts';
import type { SiteSpec } from '../../src/background/graph/state.ts';

const mockSites: SiteSpec[] = [
  {
    id: 's1',
    name: 'Framework Store',
    domain: 'frame.work',
    goal: 'Find laptop price',
    goalKind: 'collect',
    role: 'reference',
    kind: 'store',
    difficulty: 1,
    namedByUser: true,
    criteria: { fields: [{ name: 'price', required: true }], doneWhen: 'all_required' },
  },
  {
    id: 's2',
    name: 'Competitor Store',
    domain: 'competitor.test',
    goal: 'Find competitor price',
    goalKind: 'collect',
    role: 'compare',
    kind: 'store',
    difficulty: 2,
    namedByUser: true,
    criteria: { fields: [{ name: 'price', required: true }], doneWhen: 'all_required' },
  },
];

test('reflectPrompt: buildReflectSystemPrompt and UserMessage build structured context', () => {
  const sys = buildReflectSystemPrompt();
  assert.ok(sys.includes('reflection supervisor'));
  assert.ok(sys.includes('decision: "continue" | "stop_early" | "replan"'));

  const userMsg = buildReflectUserMessage({
    task: 'Compare prices of framework laptop',
    planMeta: {
      version: 1,
      taskKind: 'research',
      columns: ['price'],
      priceLike: true,
      searchQuery: 'framework laptop price',
      source: 'llm',
      sites: mockSites,
    },
    siteSummaries: [
      {
        siteId: 's1',
        status: 'done',
        criteriaMet: true,
        findings: 1,
        blockers: [],
        stepsUsed: 12,
        failures: [],
        anomalies: [],
        userAnswered: false,
        notes: 'Price found',
      },
    ],
    findings: [
      {
        id: 'f1',
        siteId: 's1',
        field: 'price',
        valueRaw: '1.200 EUR',
        value: 1200,
        url: 'https://frame.work',
        capturedAt: '2026-10-02T12:00:00Z',
        step: 5,
        docId: 'doc1',
        evidence: { snippet: '1.200 EUR', source: 'text' },
        checks: ['value_on_page'],
        quality: 'verified',
      },
    ],
    blocked: {},
    pendingSites: [mockSites[1]],
    reserveSteps: 15,
    replanCount: 0,
    maxReplans: 1,
  });

  assert.ok(userMsg.includes('Original Task: "Compare prices of framework laptop"'));
  assert.ok(userMsg.includes('Completed / Processed Sites:'));
  assert.ok(userMsg.includes('Site [s1]: status=done'));
  assert.ok(userMsg.includes('Collected Findings:'));
  assert.ok(userMsg.includes('Remaining Pending Sites:'));
  assert.ok(userMsg.includes('Site [s2]'));
});

test('reflectPrompt: URL validation rejects restricted and invalid schemes', () => {
  assert.equal(isValidExternalUrl('https://example.com/item'), true);
  assert.equal(isValidExternalUrl('http://insecure.test/page'), true);

  assert.equal(isValidExternalUrl('chrome://settings'), false);
  assert.equal(isValidExternalUrl('chrome-extension://abcdef/sidepanel.html'), false);
  assert.equal(isValidExternalUrl('file:///etc/passwd'), false);
  assert.equal(isValidExternalUrl('javascript:alert(1)'), false);
  assert.equal(isValidExternalUrl('about:blank'), false);
  assert.equal(isValidExternalUrl('not a url'), false);
});

test('reflectPrompt: getHighestSiteIndex extracts maximum index', () => {
  assert.equal(getHighestSiteIndex(mockSites), 2);
  assert.equal(getHighestSiteIndex([]), 0);
  assert.equal(getHighestSiteIndex([{ id: 's5' } as any, { id: 's2' } as any]), 5);
});

test('reflectPrompt: parseReflectResponse handles continue and stop_early', () => {
  const cont = parseReflectResponse('{"decision": "continue", "reason": "Proceed with s2"}', mockSites);
  assert.equal(cont.decision, 'continue');
  assert.equal(cont.reason, 'Proceed with s2');

  const early = parseReflectResponse('{"decision": "stop_early", "reason": "Target price acquired"}', mockSites);
  assert.equal(early.decision, 'stop_early');
  assert.equal(early.reason, 'Target price acquired');

  const malformed = parseReflectResponse('Random junk that is not json', mockSites);
  assert.equal(malformed.decision, 'continue');
  assert.ok(malformed.reason.includes('Failed to parse'));
});

test('reflectPrompt: parseReflectResponse sanitizes replan drops and additions', () => {
  const rawLlmResponse = JSON.stringify({
    decision: 'replan',
    reason: 's2 is competitor shop with bad reputation, try alt shop',
    changes: 'Drop s2, add alternate shop',
    drop_sites: ['s2', 's999'], // s999 does not exist
    add_sites: [
      {
        name: 'Alternate Store',
        domain: 'altstore.de',
        startUrl: 'https://altstore.de/laptop',
        goal: 'Find laptop price on alt store',
        role: 'compare',
        kind: 'store',
        difficulty: 2,
      },
      {
        name: 'Evil Hack Site',
        domain: 'bad.test',
        startUrl: 'chrome://bookmarks', // Restricted scheme
        goal: 'Steal data',
      },
    ],
  });

  const replan = parseReflectResponse(rawLlmResponse, mockSites, 4);
  assert.equal(replan.decision, 'replan');
  assert.deepEqual(replan.dropSites, ['s2']); // s999 filtered out

  assert.equal(replan.addSites?.length, 2);
  const altStore = replan.addSites?.[0];
  assert.equal(altStore?.id, 's3'); // Monotonic ID after s2
  assert.equal(altStore?.domain, 'altstore.de');
  assert.equal(altStore?.startUrl, 'https://altstore.de/laptop');

  const evilSite = replan.addSites?.[1];
  assert.equal(evilSite?.id, 's4');
  assert.equal(evilSite?.domain, 'bad.test');
  assert.equal(evilSite?.startUrl, undefined); // Restricted startUrl stripped
});

test('reflectPrompt: parseReflectResponse clamps site additions to maxSites', () => {
  const raw = JSON.stringify({
    decision: 'replan',
    reason: 'Add many sites',
    add_sites: [
      { domain: 'one.test' },
      { domain: 'two.test' },
      { domain: 'three.test' },
      { domain: 'four.test' },
    ],
  });

  // mockSites has 2 sites, maxSites is 3 -> can only add 1 site
  const replan = parseReflectResponse(raw, mockSites, 3);
  assert.equal(replan.addSites?.length, 1);
  assert.equal(replan.addSites?.[0].domain, 'one.test');
});
