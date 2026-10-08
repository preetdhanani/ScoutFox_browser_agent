/**
 * src/background/agent/planEvidence.ts in isolation: the pure rules the engine uses to wire the answer
 * audit into its loop. The engine itself is tested end to end in tests/agentEngineFinishGate.test.ts
 * (the incident replay) and tests/agentEngineEvidence.test.ts (the ledger, the clamps, the step message).
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_SEND_BACKS,
  NO_SEND_BACK_ACKNOWLEDGED,
  NO_SEND_BACK_OUT_OF_STEPS,
  NO_SEND_BACK_PLAIN_TEXT,
  PERSIST_MAX_CHARS,
  PERSIST_MAX_ENTRIES,
  PERSIST_MAX_VISITS,
  PERSIST_TEXT_CHARS,
  auditRecordOf,
  compactLedgerSnapshot,
  evidenceFromActionResult,
  finishedPlanStatuses,
  gateClampLog,
  gateContextOf,
  honestPlanStatuses,
  planNamesSites,
  resolveGateDecision,
  stepSites,
  unopenedSitesOf,
  answerAcknowledgesEveryGap,
  withoutAcknowledgedGaps
} from '../../src/background/agent/planEvidence.ts';
import type { PlanStatus } from '../../src/background/agent/planEvidence.ts';
import { EvidenceLedger, siteOf } from '../../src/background/agent/evidence.ts';
import { annotateAnswer, auditAnswer } from '../../src/background/agent/answerAudit.ts';
import type { AnswerAudit } from '../../src/background/agent/answerAudit.ts';
import type { GateContext } from '../../src/background/agent/finishPolicy.ts';

/** A ledger in which a page of each of these URLs was read. */
function ledgerOf(urls: string[], text = 'page text'): EvidenceLedger {
  const ledger = new EvidenceLedger();
  urls.forEach((url, i) => ledger.record({ step: i + 1, kind: 'page', url, title: `Page ${i + 1}`, text }));
  return ledger;
}

const INCIDENT_PLAN = [
  'frame.work: Find the Framework Laptop 16 base config price in the DE store',
  "idealo.de: Find the same config's price, shipping and delivery estimate",
  "geizhals.de: Find the same config's price, shipping and delivery estimate",
  'Compile the table, flag prices that differ by more than 5%, and cite each URL'
];

// ---------------------------------------------------------------------------------------------
// Honest plan
// ---------------------------------------------------------------------------------------------

describe('honestPlanStatuses', () => {
  /** What the engine computed before the audit: steps before the position completed, that one in progress, the rest pending. */
  const oldRule = (n: number, index: number): PlanStatus[] =>
    Array.from({ length: n }, (_, i): PlanStatus => (i < index ? 'completed' : i === index ? 'in_progress' : 'pending'));

  test('a plan that names no site gets exactly the old statuses, for every length and position', () => {
    const empty = new EvidenceLedger();
    for (let n = 1; n <= 7; n++) {
      const texts = Array.from({ length: n }, (_, i) => `Step ${i + 1}: do the thing`);
      for (let index = 0; index < n; index++) {
        assert.deepEqual(honestPlanStatuses(texts, index, empty), oldRule(n, index), `n=${n} index=${index}`);
      }
    }
  });

  test('the incident: the position ran ahead to the last step, but only frame.work was read', () => {
    const ledger = ledgerOf(['https://www.google.com/', 'https://frame.work/de/en/products/laptop16-amd-ai300/configuration/new']);
    assert.deepEqual(honestPlanStatuses(INCIDENT_PLAN, 3, ledger), ['completed', 'in_progress', 'pending', 'pending']);
  });

  test('the marker goes to the first step that is not completed, not to the step the position is on', () => {
    const ledger = ledgerOf(['https://frame.work/x', 'https://geizhals.de/y']);
    // idealo.de (step 2) was never read: it is the open one, although the position is already at the end.
    assert.deepEqual(honestPlanStatuses(INCIDENT_PLAN, 3, ledger), ['completed', 'in_progress', 'completed', 'pending']);
  });

  test('a step for a site that was read stays pending until the position reaches it', () => {
    const ledger = ledgerOf(['https://frame.work/x', 'https://idealo.de/y']);
    assert.deepEqual(honestPlanStatuses(INCIDENT_PLAN, 1, ledger), ['completed', 'in_progress', 'pending', 'pending']);
  });

  test('every site read and the position at the last step: all but the last step are completed', () => {
    const ledger = ledgerOf(['https://frame.work/x', 'https://www.idealo.de/y', 'https://geizhals.de/z']);
    assert.deepEqual(honestPlanStatuses(INCIDENT_PLAN, 3, ledger), ['completed', 'completed', 'completed', 'in_progress']);
  });

  test('a step that names two sites is completed only when both were read', () => {
    const texts = ['Compare idealo.de and geizhals.de', 'Write the table'];
    assert.deepEqual(honestPlanStatuses(texts, 1, ledgerOf(['https://idealo.de/a'])), ['in_progress', 'pending']);
    assert.deepEqual(honestPlanStatuses(texts, 1, ledgerOf(['https://idealo.de/a', 'https://geizhals.de/b'])), ['completed', 'in_progress']);
  });

  test('www and a subdomain are the same site as the plan writes it', () => {
    const texts = ['Open www.idealo.de and search', 'Read the result'];
    assert.deepEqual(honestPlanStatuses(texts, 1, ledgerOf(['https://idealo.de/'])), ['completed', 'in_progress']);
    assert.deepEqual(honestPlanStatuses(texts, 1, ledgerOf(['https://m.idealo.de/'])), ['completed', 'in_progress']);
  });

  test('a page of a different site does not count, and an empty plan or odd step text does not throw', () => {
    assert.deepEqual(honestPlanStatuses(['idealo.de: price'], 1, ledgerOf(['https://frame.work/'])), ['in_progress']);
    assert.deepEqual(honestPlanStatuses([], 0, new EvidenceLedger()), []);
    assert.doesNotThrow(() => honestPlanStatuses([undefined as unknown as string, null as unknown as string, ''], 2, new EvidenceLedger()));
  });
});

describe('finishedPlanStatuses', () => {
  test('steps for sites nobody read are skipped, every other step is completed', () => {
    const ledger = ledgerOf(['https://frame.work/x']);
    assert.deepEqual(finishedPlanStatuses(INCIDENT_PLAN, ledger), ['completed', 'skipped', 'skipped', 'completed']);
  });

  test('an honest full run completes every step', () => {
    const ledger = ledgerOf(['https://frame.work/x', 'https://idealo.de/y', 'https://geizhals.de/z']);
    assert.deepEqual(finishedPlanStatuses(INCIDENT_PLAN, ledger), ['completed', 'completed', 'completed', 'completed']);
  });

  test('a plan that names no site is completed as before, whatever was read', () => {
    assert.deepEqual(finishedPlanStatuses(['Read the page', 'Summarize'], new EvidenceLedger()), ['completed', 'completed']);
    assert.deepEqual(finishedPlanStatuses([], new EvidenceLedger()), []);
  });
});

describe('unopenedSitesOf and planNamesSites', () => {
  test('list the named sites that were not read', () => {
    const ledger = ledgerOf(['https://frame.work/x']);
    assert.deepEqual(unopenedSitesOf(INCIDENT_PLAN[0] ?? '', ledger), []);
    assert.deepEqual(unopenedSitesOf(INCIDENT_PLAN[1] ?? '', ledger), ['idealo.de']);
    assert.deepEqual(unopenedSitesOf('Compare idealo.de with geizhals.de', ledger), ['idealo.de', 'geizhals.de']);
    assert.deepEqual(unopenedSitesOf('Read the page', ledger), []);
  });

  // A cloud planner writes an array of strings and is never asked for domains: "Check Idealo for the same configuration".
  const CLOUD_PLAN = [
    'Open the Framework DE store and find the Laptop 16 base config price',
    'Check Idealo for the same configuration',
    'Check Geizhals for the same configuration',
    'Compile the comparison table with URLs'
  ];
  const GOAL_SITES = ['frame.work', 'idealo.de', 'geizhals.de'];

  test('a step that calls a goal site by its brand names that site (only when the goal names it)', () => {
    assert.deepEqual(stepSites('Check Idealo for the same configuration', GOAL_SITES), ['idealo.de']);
    assert.deepEqual(stepSites('Check Geizhals for the same configuration', GOAL_SITES), ['geizhals.de']);
    assert.deepEqual(stepSites('Check Idealo for the same configuration'), [], 'without the goal there is no site to map the brand to');
    assert.deepEqual(stepSites('Open the Framework DE store and find the price', GOAL_SITES), [], '"frame" is a common word: frame.work is only known by its domain');
    assert.deepEqual(stepSites('Compile the comparison table with URLs', GOAL_SITES), []);
    assert.deepEqual(stepSites('idealo.de: check the brand Idealo', GOAL_SITES), ['idealo.de'], 'a domain and its brand in one step are one site');
    assert.deepEqual(stepSites(undefined as never, GOAL_SITES), []);
  });

  test('the incident with a cloud plan: the Idealo and Geizhals steps are not complete before those sites were read', () => {
    const ledger = ledgerOf(['https://frame.work/x']);
    assert.deepEqual(unopenedSitesOf(CLOUD_PLAN[1] ?? '', ledger, GOAL_SITES), ['idealo.de']);
    assert.equal(planNamesSites(CLOUD_PLAN), false, 'without the goal the plan names nothing');
    assert.equal(planNamesSites(CLOUD_PLAN, GOAL_SITES), true);
    assert.deepEqual(honestPlanStatuses(CLOUD_PLAN, 3, ledger, GOAL_SITES), ['completed', 'in_progress', 'pending', 'pending']);
    assert.deepEqual(finishedPlanStatuses(CLOUD_PLAN, ledger, GOAL_SITES), ['completed', 'skipped', 'skipped', 'completed']);
    const all = ledgerOf(['https://frame.work/x', 'https://www.idealo.de/y', 'https://geizhals.de/z']);
    assert.deepEqual(finishedPlanStatuses(CLOUD_PLAN, all, GOAL_SITES), ['completed', 'completed', 'completed', 'completed']);
  });

  test('planNamesSites is true for the incident plan and false for a generic one', () => {
    assert.equal(planNamesSites(INCIDENT_PLAN), true);
    assert.equal(planNamesSites(['Analyze page state', 'Execute targeted web actions, e.g. clicks', 'Extract relevant information']), false);
    assert.equal(planNamesSites([]), false);
  });
});

// ---------------------------------------------------------------------------------------------
// What the engine read
// ---------------------------------------------------------------------------------------------

describe('evidenceFromActionResult', () => {
  test('read_page_text: the text inside the wrapper of the content script, not the wrapper', () => {
    const message = 'Extracted text snippet (27 chars):\n"""\nPreis: 2.189,00 EUR\nVersand 4,99 EUR\n"""';
    assert.deepEqual(evidenceFromActionResult({ action: 'read_page_text' }, { success: true, message }), { kind: 'text', text: 'Preis: 2.189,00 EUR\nVersand 4,99 EUR' });
    assert.deepEqual(evidenceFromActionResult({ action: 'extract_page_text' }, { success: true, message }), { kind: 'text', text: 'Preis: 2.189,00 EUR\nVersand 4,99 EUR' });
  });

  test('read_page_text: a message in another shape is kept as it is, and an empty one is nothing', () => {
    assert.deepEqual(evidenceFromActionResult({ action: 'read_page_text' }, { success: true, message: 'some text 4,99 EUR' }), { kind: 'text', text: 'some text 4,99 EUR' });
    assert.equal(evidenceFromActionResult({ action: 'read_page_text' }, { success: true, message: 'Extracted text snippet (0 chars):\n"""\n\n"""' }), null);
    assert.equal(evidenceFromActionResult({ action: 'read_page_text' }, { success: true }), null);
  });

  test('execute_js: what the code computed from the page is a read', () => {
    assert.deepEqual(evidenceFromActionResult({ action: 'execute_js', code: "return document.querySelector('.price').textContent" }, { success: true, result: '2.189,00 EUR' }), { kind: 'js', text: '2.189,00 EUR' });
    assert.deepEqual(evidenceFromActionResult({ action: 'execute_js', code: 'return 1 + 1' }, { success: true, result: 2 }), { kind: 'js', text: '2' });
  });

  test('execute_js: a result that is only the code\'s own literal is not evidence (it would launder an invented number)', () => {
    const code = "return 'idealo.de costs 2.189,00 EUR, shipping 4,99 EUR'";
    assert.equal(evidenceFromActionResult({ action: 'execute_js', code }, { success: true, result: 'idealo.de costs 2.189,00 EUR, shipping 4,99 EUR' }), null);
    assert.equal(evidenceFromActionResult({ action: 'execute_js', code: 'return ["2.189,00 EUR"]' }, { success: true, result: '["2.189,00 EUR"]' }), null);
    assert.equal(evidenceFromActionResult({ action: 'execute_js', code: 'return {a: "x"}' }, { success: true, result: '{"a": "x"}' }), null, 'quotes and spaces do not matter');
  });

  test('execute_js: no value, a navigation or a failure is nothing', () => {
    for (const result of ['undefined', 'null', 'navigation triggered', '', '   ', undefined, null]) {
      assert.equal(evidenceFromActionResult({ action: 'execute_js', code: 'return x' }, { success: true, result }), null, String(result));
    }
    assert.equal(evidenceFromActionResult({ action: 'execute_js', code: 'return x' }, { success: false, result: '2.189,00 EUR' }), null);
  });

  test('read_network_requests: the listing without its heading; "no requests" is nothing', () => {
    const listing = '[GET] https://api.shop.test/price -> 200 (31ms)\n  resp: {"price":"2.189,00 EUR"}';
    assert.deepEqual(evidenceFromActionResult({ action: 'read_network_requests' }, { success: true, message: `Recent Network Activity:\n${listing}` }), { kind: 'network', text: listing });
    assert.equal(evidenceFromActionResult({ action: 'read_network_requests' }, { success: true, message: 'Recent Network Activity:\n(No network requests captured matching filter criteria)' }), null);
  });

  test('every other action, a failed result and garbage give nothing, and nothing throws', () => {
    for (const action of ['click', 'type', 'navigate', 'scroll', 'browser_batch', 'wait', 'finish', 'ask_user']) {
      assert.equal(evidenceFromActionResult({ action }, { success: true, message: 'Price 2.189,00 EUR' }), null, action);
    }
    assert.equal(evidenceFromActionResult({ action: 'read_page_text' }, { success: false, message: 'Price 2.189,00 EUR' }), null);
    assert.equal(evidenceFromActionResult(null, { success: true }), null);
    assert.equal(evidenceFromActionResult({ action: 'read_page_text' }, null), null);
    assert.equal(evidenceFromActionResult(undefined, undefined), null);
    assert.equal(evidenceFromActionResult({ action: 'read_page_text' }, { success: true, message: 42 }), null);
  });
});

// ---------------------------------------------------------------------------------------------
// A small persisted ledger
// ---------------------------------------------------------------------------------------------

describe('compactLedgerSnapshot', () => {
  const big = (n: number): string => 'x'.repeat(n);

  test('a small ledger is stored as it is', () => {
    const ledger = ledgerOf(['https://frame.work/a', 'https://idealo.de/b'], 'Preis 2.189,00 EUR');
    assert.deepEqual(compactLedgerSnapshot(ledger.toSnapshot()), ledger.toSnapshot());
  });

  test('the text of a page is cut to PERSIST_TEXT_CHARS, and a number in the kept part still grounds', () => {
    const ledger = new EvidenceLedger();
    ledger.record({ step: 1, kind: 'page', url: 'https://frame.work/a', title: 'A', text: `Preis 2.189,00 EUR ${big(5000)}` });
    const compact = compactLedgerSnapshot(ledger.toSnapshot());
    assert.equal(compact.entries.length, 1);
    assert.equal(compact.entries[0]?.text.length, PERSIST_TEXT_CHARS);
    const restored = EvidenceLedger.fromSnapshot(compact);
    assert.equal(restored.amounts('frame.work').length, 1);
  });

  test('the limits hold, the newest entries stay, and the newest page of every site always stays', () => {
    const ledger = new EvidenceLedger();
    // One page of a site read long ago, then many pages of another site.
    ledger.record({ step: 1, kind: 'page', url: 'https://geizhals.de/old', title: 'old', text: 'Versand kostenlos' });
    for (let i = 0; i < 80; i++) ledger.record({ step: i + 2, kind: 'page', url: `https://frame.work/p${i}`, title: `p${i}`, text: `Seite ${i} ${big(2500)}` });
    const snapshot = ledger.toSnapshot();
    const compact = compactLedgerSnapshot(snapshot);
    const chars = compact.entries.reduce((sum, e) => sum + e.url.length + e.title.length + e.text.length, 0);
    assert.ok(compact.entries.length <= PERSIST_MAX_ENTRIES, `${compact.entries.length} entries`);
    assert.ok(chars <= PERSIST_MAX_CHARS, `${chars} chars`);
    assert.ok(compact.entries.some((e) => e.url === 'https://geizhals.de/old'), 'the only page of geizhals.de stays');
    assert.equal(compact.entries.at(-1)?.url, 'https://frame.work/p79', 'the newest page stays');
    const restored = EvidenceLedger.fromSnapshot(compact);
    assert.equal(restored.hasOpened('geizhals.de'), true);
    assert.equal(restored.hasOpened('frame.work'), true);
  });

  test('every site that was read still counts as opened after a restart, however many there were (20 sites of 4,500 characters kept only 19)', () => {
    const ledger = new EvidenceLedger();
    for (let i = 0; i < 60; i++) ledger.record({ step: i + 1, kind: 'page', url: `https://site${i}.test/page`, title: `s${i}`, text: `Preis 2.0${i % 10}9,00 EUR ${big(4500)}` });
    const compact = compactLedgerSnapshot(ledger.toSnapshot());
    assert.ok(compact.entries.length <= PERSIST_MAX_ENTRIES, 'pages were dropped');
    const restored = EvidenceLedger.fromSnapshot(JSON.parse(JSON.stringify(compact)));
    for (let i = 0; i < 60; i++) assert.equal(restored.hasOpened(`site${i}.test`), true, `site${i}.test`);
    assert.equal(restored.wasVisited('https://site0.test/page'), true);
    assert.ok(Array.isArray(compact.visits) && (compact.visits?.length ?? 0) <= PERSIST_MAX_VISITS);
  });

  test('old pages are cut down to the lines around their numbers before a whole page is dropped, so an early price is still found', () => {
    const ledger = new EvidenceLedger();
    const prose = (n: number): string => `${'The Framework Laptop 16 is a modular laptop. '.repeat(70)}${n}`.slice(0, 2900);
    ledger.record({ step: 1, kind: 'page', url: 'https://frame.work/price', title: 'p', text: `${prose(0)} Base Pre-order EUR 2,069 ${prose(1)}` });
    for (let i = 0; i < 39; i++) ledger.record({ step: i + 2, kind: 'page', url: `https://frame.work/other${i}`, title: `o${i}`, text: prose(i) });
    const compact = compactLedgerSnapshot(ledger.toSnapshot());
    const restored = EvidenceLedger.fromSnapshot(compact);
    assert.equal(restored.amounts('frame.work').some((a) => a.value === 2069), true);
  });

  test('a page read through a redirect keeps the site it was asked for', () => {
    const ledger = new EvidenceLedger();
    ledger.record({ step: 1, kind: 'page', url: 'https://x.com/home', title: 'X', text: 'hello', via: ['twitter.com'] });
    for (let i = 0; i < 60; i++) ledger.record({ step: i + 2, kind: 'page', url: `https://filler${i}.test/x`, title: '', text: big(2500) });
    const restored = EvidenceLedger.fromSnapshot(compactLedgerSnapshot(ledger.toSnapshot()));
    assert.equal(restored.hasOpened('twitter.com'), true);
  });

  test('when every entry is the newest of its own site, the oldest goes at the cap', () => {
    const ledger = new EvidenceLedger();
    for (let i = 0; i < 50; i++) ledger.record({ step: i + 1, kind: 'page', url: `https://site${i}.test/`, title: '', text: 'x' });
    const compact = compactLedgerSnapshot(ledger.toSnapshot());
    assert.equal(compact.entries.length, PERSIST_MAX_ENTRIES);
    assert.equal(compact.entries[0]?.url, 'https://site10.test/');
  });

  test('it is idempotent, does not change its input, and survives garbage', () => {
    const ledger = new EvidenceLedger();
    for (let i = 0; i < 60; i++) ledger.record({ step: i + 1, kind: 'page', url: `https://frame.work/p${i}`, title: '', text: big(3000) });
    const snapshot = ledger.toSnapshot();
    const before = JSON.stringify(snapshot);
    const once = compactLedgerSnapshot(snapshot);
    assert.equal(JSON.stringify(snapshot), before, 'the input is left alone');
    assert.deepEqual(compactLedgerSnapshot(once), once);
    for (const garbage of [null, undefined, {}, { v: 1 }, { v: 1, entries: 'no' }, 'text', 7]) {
      assert.deepEqual(compactLedgerSnapshot(garbage as never), { v: 1, entries: [] });
    }
  });

  test('the stored copy is plain JSON', () => {
    const ledger = ledgerOf(['https://frame.work/a'], 'Preis 2.189,00 EUR');
    const compact = compactLedgerSnapshot(ledger.toSnapshot());
    assert.deepEqual(JSON.parse(JSON.stringify(compact)), compact);
  });
});

// ---------------------------------------------------------------------------------------------
// The gate's decision
// ---------------------------------------------------------------------------------------------

describe('gateContextOf', () => {
  const audit = (lies: number, gaps: number): AnswerAudit => ({ verdict: 'unverified', lies, gaps, softs: 0, notes: [], opened: [], notOpened: [], grounded: [] });

  test('carries the counts of the audit, the send-backs and the steps left', () => {
    assert.deepEqual(gateContextOf(audit(4, 1), 2, 7), { lieCount: 4, gapCount: 1, sendBacks: 2, stepsLeft: 7 });
  });

  test('never negative, never fractional, never NaN', () => {
    assert.deepEqual(gateContextOf(audit(-1, 0), -3, -5), { lieCount: 0, gapCount: 0, sendBacks: 0, stepsLeft: 0 });
    assert.deepEqual(gateContextOf(audit(Number.NaN, 2.9), Number.POSITIVE_INFINITY, 1.5), { lieCount: 0, gapCount: 2, sendBacks: 0, stepsLeft: 1 });
    assert.deepEqual(gateContextOf(undefined as never, 0, 3), { lieCount: 0, gapCount: 0, sendBacks: 0, stepsLeft: 3 });
  });
});

describe('resolveGateDecision', () => {
  const ctx = (over: Partial<GateContext> = {}): GateContext => ({ lieCount: 2, gapCount: 0, sendBacks: 0, stepsLeft: 5, ...over });
  const canSend = {};

  test('annotate and replace are used as they are, even when no send-back would be possible', () => {
    for (const decision of ['annotate', 'replace'] as const) {
      assert.deepEqual(resolveGateDecision(() => decision, ctx({ stepsLeft: 0, sendBacks: 9 }), { noSendBack: 'any reason' }), { decision, clamped: null });
    }
  });

  test('send_back is used when the model can be asked again', () => {
    assert.deepEqual(resolveGateDecision(() => 'send_back', ctx(), canSend), { decision: 'send_back', clamped: null });
    assert.deepEqual(resolveGateDecision(() => 'send_back', ctx({ stepsLeft: 1, sendBacks: MAX_SEND_BACKS - 1 }), canSend), { decision: 'send_back', clamped: null });
  });

  test('send_back becomes annotate with no step left, after MAX_SEND_BACKS, and for a reply the model cannot redo', () => {
    const noStep = resolveGateDecision(() => 'send_back', ctx({ stepsLeft: 0 }), canSend);
    assert.equal(noStep.decision, 'annotate');
    assert.match(noStep.clamped ?? '', /no step/);

    const tooMany = resolveGateDecision(() => 'send_back', ctx({ sendBacks: MAX_SEND_BACKS }), canSend);
    assert.equal(tooMany.decision, 'annotate');
    assert.match(tooMany.clamped ?? '', new RegExp(String(MAX_SEND_BACKS)));

    const prose = resolveGateDecision(() => 'send_back', ctx(), { noSendBack: 'a plain-text reply cannot be sent back' });
    assert.equal(prose.decision, 'annotate');
    assert.match(prose.clamped ?? '', /plain-text/);
  });

  test('a policy that throws, returns nonsense, or is not a function gets annotate, never the raw answer', () => {
    const cases: Array<[string, unknown]> = [
      ['throws', () => { throw new Error('boom'); }],
      ['accept', () => 'accept'],
      ['undefined', () => undefined],
      ['null', () => null],
      ['an object', () => ({ decision: 'send_back' })],
      ['upper case', () => 'SEND_BACK'],
      ['a promise', () => Promise.resolve('send_back')],
      ['not a function', 'send_back'],
      ['missing', undefined]
    ];
    for (const [name, policy] of cases) {
      const resolved = resolveGateDecision(policy, ctx(), canSend);
      assert.equal(resolved.decision, 'annotate', name);
      assert.ok(resolved.clamped, `${name} says why`);
    }
  });

  test('the policy gets a copy of the context: it cannot change what the engine later reads', () => {
    const original = ctx();
    resolveGateDecision((c: GateContext) => { c.stepsLeft = 99; c.sendBacks = -5; return 'annotate'; }, original, canSend);
    assert.deepEqual(original, ctx());
  });
});

describe('gateClampLog: what the engine logs when the policy could not be followed', () => {
  const ctx = (over: Partial<GateContext> = {}): GateContext => ({ lieCount: 0, gapCount: 1, sendBacks: 1, stepsLeft: 5, ...over });
  const about = { sendBacks: 1, verdict: 'partial' };
  const sendBack = () => 'send_back' as const;

  test('nothing is logged when the policy was followed', () => {
    assert.equal(gateClampLog(resolveGateDecision(sendBack, ctx({ sendBacks: 0 })), about), null);
    assert.equal(gateClampLog(resolveGateDecision(() => 'annotate', ctx()), about), null);
  });

  test('an honest answer after a send-back is accepted as it is: INFO, its own tag, and the word "annotate" is not in it', () => {
    const resolved = resolveGateDecision(sendBack, ctx(), { noSendBack: NO_SEND_BACK_ACKNOWLEDGED });
    assert.equal(resolved.decision, 'annotate', 'what the engine does with it is unchanged');
    const line = gateClampLog(resolved, about);
    assert.deepEqual(line, {
      level: 'info',
      message: '[FINISH_ACCEPTED_PARTIAL] The answer already says which sites were not checked (after 1 send-back), so it is accepted as it is with verdict partial.'
    });
    assert.doesNotMatch(line?.message ?? '', /annotat|clamp/i);
    assert.match(gateClampLog(resolved, { sendBacks: 3, verdict: 'partial' })?.message ?? '', /\(after 3 send-backs\)/);
  });

  test('every clamp that is a real problem stays a warning with the old tag, and says why', () => {
    const real: Array<[string, ReturnType<typeof resolveGateDecision>, RegExp]> = [
      ['no step left', resolveGateDecision(sendBack, ctx({ stepsLeft: 0 })), /no step is left to try again/],
      ['the hard cap', resolveGateDecision(sendBack, ctx({ sendBacks: MAX_SEND_BACKS })), new RegExp(`already sent back ${MAX_SEND_BACKS} times`)],
      ['the run is out of steps', resolveGateDecision(sendBack, ctx(), { noSendBack: NO_SEND_BACK_OUT_OF_STEPS }), /the run is out of steps/],
      ['a plain-text reply', resolveGateDecision(sendBack, ctx(), { noSendBack: NO_SEND_BACK_PLAIN_TEXT }), /plain-text reply cannot be sent back/],
      ['a policy that throws', resolveGateDecision(() => { throw new Error('boom'); }, ctx()), /the finish policy threw: boom/],
      ['a policy that answers nonsense', resolveGateDecision(() => 'accept' as never, ctx()), /the finish policy answered "accept"/],
      ['no policy', resolveGateDecision(undefined, ctx()), /not a function/]
    ];
    for (const [name, resolved, why] of real) {
      const line = gateClampLog(resolved, about);
      assert.equal(line?.level, 'warn', name);
      assert.match(line?.message ?? '', /^\[FINISH_POLICY_CLAMPED\] The finish policy could not be followed as it stood \(/, name);
      assert.match(line?.message ?? '', why, name);
      assert.doesNotMatch(line?.message ?? '', /ACCEPTED_PARTIAL|accepted as it is/, name);
    }
  });

  test('the run being out of steps is a real clamp even when the answer is an honest one', () => {
    // The engine picks ONE reason, in this order; out of steps comes first, so it is never reported as the benign case.
    const line = gateClampLog(resolveGateDecision(sendBack, ctx(), { noSendBack: NO_SEND_BACK_OUT_OF_STEPS }), about);
    assert.equal(line?.level, 'warn');
  });

  test('an honest answer on the last step is a real clamp too: no send-back was possible, so accepting it was not a choice', () => {
    // The engine flags the benign reason without looking at the steps left; the last step of a run is a finish that is not "final".
    const lastStep = resolveGateDecision(sendBack, ctx({ stepsLeft: 0 }), { noSendBack: NO_SEND_BACK_ACKNOWLEDGED });
    assert.equal(lastStep.decision, 'annotate');
    assert.equal(lastStep.clamped, 'no step is left to try again');
    const line = gateClampLog(lastStep, about);
    assert.equal(line?.level, 'warn');
    assert.match(line?.message ?? '', /^\[FINISH_POLICY_CLAMPED\] .*no step is left to try again/);
    assert.doesNotMatch(line?.message ?? '', /ACCEPTED_PARTIAL|accepted as it is/);
  });

  test('an honest answer after the hard cap of send-backs is a real clamp too, and one with steps left and the cap not reached is the benign case', () => {
    const capped = resolveGateDecision(sendBack, ctx({ sendBacks: MAX_SEND_BACKS }), { noSendBack: NO_SEND_BACK_ACKNOWLEDGED });
    assert.equal(capped.clamped, `this turn was already sent back ${MAX_SEND_BACKS} times`);
    assert.equal(gateClampLog(capped, { sendBacks: MAX_SEND_BACKS, verdict: 'partial' })?.level, 'warn');
    const benign = resolveGateDecision(sendBack, ctx({ stepsLeft: 1, sendBacks: MAX_SEND_BACKS - 1 }), { noSendBack: NO_SEND_BACK_ACKNOWLEDGED });
    assert.equal(benign.clamped, NO_SEND_BACK_ACKNOWLEDGED);
    assert.equal(gateClampLog(benign, { sendBacks: MAX_SEND_BACKS - 1, verdict: 'partial' })?.level, 'info');
  });

  test('a plain-text reply keeps its own reason when a step is left, and the policy\'s own annotate is never a clamp', () => {
    assert.equal(resolveGateDecision(sendBack, ctx(), { noSendBack: NO_SEND_BACK_PLAIN_TEXT }).clamped, NO_SEND_BACK_PLAIN_TEXT);
    assert.equal(gateClampLog(resolveGateDecision(() => 'annotate', ctx({ stepsLeft: 0 }), { noSendBack: NO_SEND_BACK_ACKNOWLEDGED }), about), null);
  });
});

describe('auditRecordOf', () => {
  test('keeps the vocabulary of the finish entry and nothing else', () => {
    const audit: AnswerAudit = {
      verdict: 'partial',
      lies: 0,
      gaps: 1,
      softs: 0,
      notes: [{ code: 'source_unchecked', severity: 'gap', text: 'idealo.de was not opened yet.', host: 'idealo.de', claims: ['x'] }],
      opened: [{ host: 'frame.work', url: 'https://frame.work/a' }],
      notOpened: ['idealo.de'],
      grounded: [{ value: 'EUR 2,069', host: 'frame.work', url: 'https://frame.work/a', snippet: 'Base EUR 2,069' }]
    };
    assert.deepEqual(auditRecordOf(audit, 2), {
      verdict: 'partial',
      opened: [{ host: 'frame.work', url: 'https://frame.work/a' }],
      notOpened: ['idealo.de'],
      notes: [{ code: 'source_unchecked', severity: 'gap', text: 'idealo.de was not opened yet.' }],
      sendBacks: 2
    });
  });

  test('a note text that is too long is cut between words and marked, never inside a number', () => {
    // 496 characters of filler, then a price that the limit of 500 would cut in the middle.
    const text = `${'a '.repeat(248)}1.329,00 EUR and more words after it`;
    const audit: AnswerAudit = {
      verdict: 'unverified', lies: 1, gaps: 0, softs: 0, grounded: [], opened: [], notOpened: [],
      notes: [{ code: 'source_not_opened', severity: 'lie', text }]
    };
    const stored = auditRecordOf(audit, 0).notes[0]?.text ?? '';
    assert.ok(stored.length <= 500, `${stored.length} characters`);
    assert.ok(stored.endsWith('...'), 'the cut is marked');
    const kept = stored.slice(0, -3);
    assert.ok(text.startsWith(kept), 'what is kept is the start of the text');
    assert.match(text.slice(kept.length), /^\s/, `the cut is between words: ...${stored.slice(-20)}`);
    assert.doesNotMatch(stored, /1\.3/, 'no piece of the price');
    // A text that fits is stored as it is.
    assert.equal(auditRecordOf({ ...audit, notes: [{ code: 'source_unchecked', severity: 'gap', text: 'x'.repeat(500) }] }, 0).notes[0]?.text, 'x'.repeat(500));
  });

  test('is small even for a huge audit, and is plain JSON', () => {
    const notes = Array.from({ length: 100 }, (_, i) => ({ code: 'number_not_in_evidence' as const, severity: 'lie' as const, text: `n${i} ${'y'.repeat(2000)}` }));
    const opened = Array.from({ length: 100 }, (_, i) => ({ host: `s${i}.test`, url: `https://s${i}.test/${'p'.repeat(2000)}` }));
    const record = auditRecordOf({ verdict: 'unverified', lies: 100, gaps: 0, softs: 0, notes, opened, notOpened: opened.map((o) => o.host), grounded: [] }, 1);
    assert.ok(JSON.stringify(record).length < 30_000, `${JSON.stringify(record).length} chars`);
    assert.deepEqual(JSON.parse(JSON.stringify(record)), record);
  });
});

// ---------------------------------------------------------------------------------------------
// Notes in the answer
// ---------------------------------------------------------------------------------------------

describe('withoutAcknowledgedGaps', () => {
  const GOAL = 'Find the price on frame.work and on idealo.de and geizhals.de.';
  const ledger = ledgerOf(['https://frame.work/p'], 'Laptop 16 base EUR 2,069');

  function auditOf(answer: string): AnswerAudit {
    return auditAnswer({ goal: GOAL, answer, ledger });
  }

  test('a site the answer itself says it did not check needs no note in the text, and the text stays as it is', () => {
    const answer = 'frame.work: EUR 2,069\n\nidealo.de: not checked. I never opened this site.\ngeizhals.de: blocked, could not open it.';
    const audit = auditOf(answer);
    assert.equal(audit.verdict, 'partial');
    assert.equal(audit.gaps, 2);
    const filtered = withoutAcknowledgedGaps(answer, audit);
    assert.equal(filtered.gaps, 0);
    assert.equal(annotateAnswer(answer, filtered), answer);
    assert.equal(audit.gaps, 2, 'the audit that goes on the entry is not touched');
    assert.equal(filtered.verdict, 'partial', 'and the verdict is not changed either');
  });

  test('a site the answer never mentions keeps its note, and the text gets the section', () => {
    const answer = 'frame.work: EUR 2,069';
    const audit = auditOf(answer);
    assert.equal(audit.gaps, 2);
    const filtered = withoutAcknowledgedGaps(answer, audit);
    assert.equal(filtered.gaps, 2);
    const annotated = annotateAnswer(answer, filtered);
    assert.ok(annotated.startsWith('PARTIAL ANSWER: not every source was checked.'), 'one warning line on top');
    assert.ok(annotated.includes(`\n\n${answer}\n\n---\n`), 'the model\'s words stay');
    assert.match(annotated, /Verdict: partial/);
    assert.match(annotated, /idealo\.de/);
    assert.match(annotated, /geizhals\.de/);
  });

  test('a mention without a word that says "not checked" is not an acknowledgement', () => {
    const answer = 'frame.work: EUR 2,069. idealo.de and geizhals.de are cheaper.';
    const audit = auditOf(answer);
    assert.equal(audit.verdict, 'partial');
    assert.equal(withoutAcknowledgedGaps(answer, audit).gaps, audit.gaps);
  });

  test('only the site on the line that says it counts: one acknowledged, one silent', () => {
    const answer = 'frame.work: EUR 2,069\nidealo.de: not checked.';
    const audit = auditOf(answer);
    const filtered = withoutAcknowledgedGaps(answer, audit);
    assert.equal(filtered.gaps, 1);
    assert.deepEqual(filtered.notes.map((n) => n.host), ['geizhals.de']);
  });

  test('with any lie in the answer nothing is removed', () => {
    const answer = 'frame.work: EUR 2,069\nidealo.de: not checked.\ngeizhals.de: EUR 1,999 at https://geizhals.de/made-up';
    const audit = auditOf(answer);
    assert.ok(audit.lies > 0);
    assert.equal(withoutAcknowledgedGaps(answer, audit), audit);
  });

  test('an audit with no gap, and odd input, come back as they are', () => {
    const clean = auditAnswer({ goal: 'What is on this page?', answer: 'frame.work: EUR 2,069', ledger });
    assert.equal(clean.verdict, 'verified');
    assert.equal(withoutAcknowledgedGaps('x', clean), clean);
    assert.doesNotThrow(() => withoutAcknowledgedGaps(undefined as never, clean));
    assert.doesNotThrow(() => withoutAcknowledgedGaps('x', undefined as never));
  });

  test('answerAcknowledgesEveryGap: true only for an honest answer that names every unchecked site as not checked', () => {
    const honest = 'frame.work: EUR 2,069\nidealo.de: not checked.\ngeizhals.de: blocked, could not open it.';
    assert.equal(answerAcknowledgesEveryGap(honest, auditOf(honest)), true);

    const half = 'frame.work: EUR 2,069\nidealo.de: not checked.';
    assert.equal(answerAcknowledgesEveryGap(half, auditOf(half)), false, 'geizhals.de is not mentioned');

    const silent = 'frame.work: EUR 2,069';
    assert.equal(answerAcknowledgesEveryGap(silent, auditOf(silent)), false);

    const lie = 'frame.work: EUR 2,069\nidealo.de: not checked.\ngeizhals.de: not checked. It costs EUR 1,999 at https://geizhals.de/made-up';
    assert.equal(answerAcknowledgesEveryGap(lie, auditOf(lie)), false, 'a lie is never acknowledged away');

    const complete = auditAnswer({ goal: 'What is on this page?', answer: 'frame.work: EUR 2,069', ledger });
    assert.equal(answerAcknowledgesEveryGap('frame.work: EUR 2,069', complete), false, 'no gap at all');
  });

  // The acknowledgement has to say that the site was not looked at, in so many words. A bare "not" says nothing about it.
  test('"do not differ", "not flagged" and "not more than" are claims about results, not acknowledgements', () => {
    for (const line of [
      'idealo.de and geizhals.de show the same price as frame.work, so they do not differ by more than 5%.',
      'idealo.de: same price as the official store, not flagged.\ngeizhals.de: same price as the official store, not flagged.',
      'idealo.de and geizhals.de: prices do not differ by more than 5% from the official store.',
      '| idealo.de | same as official | not flagged |\n| geizhals.de | same as official | not flagged |'
    ]) {
      const answer = `frame.work: EUR 2,069\n${line}`;
      const audit = auditOf(answer);
      assert.equal(audit.gaps + audit.lies > 0, true, line);
      assert.equal(answerAcknowledgesEveryGap(answer, audit), false, line);
      assert.equal(withoutAcknowledgedGaps(answer, audit).gaps, audit.gaps, line);
    }
  });

  test('the ways to say "not checked" all count, also in German and with a brand name', () => {
    const lines = [
      'idealo.de: not checked', 'I never opened idealo.de', 'I could not open idealo.de', 'idealo.de blocked me with a captcha', 'idealo.de: nicht geprüft',
      'idealo.de: übersprungen', 'Not checked: idealo.de, geizhals.de', 'Idealo: blocked', 'idealo.de: Zugriff verweigert', 'idealo.de: timed out'
    ];
    for (const line of lines) {
      const answer = `frame.work: EUR 2,069\n${line}\ngeizhals.de: skipped`;
      const filtered = withoutAcknowledgedGaps(answer, auditOf(answer));
      assert.equal(filtered.gaps, 0, line);
    }
  });

  test('the gaming lines still get the section, and a second send-back is not refused for them', () => {
    const answer = 'frame.work: EUR 2,069\nidealo.de and geizhals.de: prices do not differ by more than 5% from the official store.';
    const audit = auditOf(answer);
    const annotated = annotateAnswer(answer, withoutAcknowledgedGaps(answer, audit));
    assert.match(annotated, /Verification notes/);
    assert.match(annotated, /idealo\.de was (?:not opened yet|never opened)/);
  });

  test('siteOf agrees with the hosts the plan functions compare (a guard for the www. rule)', () => {
    assert.equal(siteOf('https://www.idealo.de/x'), 'idealo.de');
  });
});
