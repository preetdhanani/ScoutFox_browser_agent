/**
 * tests/graph/turnReset.test.ts
 *
 * A new task on the same tab/thread must start from a clean per-turn state: the
 * previous turn's reflect decision, plan revision, budget spend and refused
 * finish must not leak into it (BUG-17, BUG-18, BUG-25).
 *
 * The stale state is seeded straight into the graph checkpoint with updateState -
 * exactly the shape the pre-fix code left behind at the end of a turn - and the
 * next startTask must clear it in intake.
 */

import test, { describe } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { fakeChrome } from '../helpers/fakeChrome.ts';
import { createFakeStorage, type FakeStorage } from '../helpers/fakeStorageSession.ts';
import { fakeDom, input, link, type PageSpec } from '../helpers/fakeDom.ts';
import { fakeLlm, type LlmScript } from '../helpers/fakeLlm.ts';
import { Logger } from '../../src/shared/logger.ts';
import { AgentRunner } from '../../src/background/runner/AgentRunner.ts';
import { SessionStorageSaver } from '../../src/background/checkpoint/SessionStorageSaver.ts';
import { buildOrchestratorGraph, carryPriorFindings, priorFindingLine } from '../../src/background/graph/orchestrator.ts';
import { graphRig, act as rigAct, type GraphRig } from '../helpers/graphHarness.ts';

const LIST = 'https://shop.test/laptops';
const PRODUCT = 'https://shop.test/laptops/16';
const DEAL = 'https://deal.test/offer';

const WEB: PageSpec[] = [
  {
    url: LIST,
    title: 'Laptops - Shop',
    text: [{ heading: 'Laptops' }, 'Framework Laptop 16 ab 1.399,00 EUR'],
    elements: [link('Laptop 16 DIY Edition', PRODUCT), link('Deal of the day', DEAL)],
  },
  {
    url: PRODUCT,
    title: 'Laptop 16 DIY Edition - Shop',
    text: [{ heading: 'Laptop 16 DIY Edition' }, 'Preis 1.399,00 EUR', 'Versand kostenlos'],
    elements: [link('Back to the laptops', LIST)],
  },
  {
    url: DEAL,
    title: 'Deal of the day - Deals',
    text: [{ heading: 'Deal of the day' }, 'Nur heute 1.299,00 EUR'],
    elements: [link('Back to the laptops', LIST)],
  },
];

const GOAL1 = 'What does the Framework Laptop 16 cost?';
const GOAL2 = 'What does the deal of the day cost?';
// Proper plan objects: the old bare-array fixtures would now be a parse error that asks the
// model for a repair (planner-fallback-invented-plan), so the plans are spelled out here. They
// keep the shape the old array replies produced for these tasks (answer kind, page sites, value field).
const PLAN_1 = JSON.stringify({
  task_kind: 'answer',
  columns: ['value'],
  sites: [
    { name: 'Open the Framework Laptop 16 page', goal: 'Open the Framework Laptop 16 page', kind: 'page', required_fields: ['value'] },
    { name: 'Read the price there', goal: 'Read the price there', role: 'compare', kind: 'page', required_fields: ['value'] },
  ],
});
const PLAN_2 = JSON.stringify({
  task_kind: 'answer',
  columns: ['value'],
  sites: [
    { name: 'Open the deal of the day', goal: 'Open the deal of the day', kind: 'page', required_fields: ['value'] },
  ],
});
const act = (action: Record<string, unknown>): string => JSON.stringify(action);
const finishWith = (answer: string): string => act({ action: 'finish', answer, reason: 'I have all the information' });

function clickOn(label: string) {
  return (call: any) => {
    const shown = call.messages.at(-1)?.content ?? '';
    const found = shown.match(new RegExp(`^\\[(\\d+)\\] \\S+ "${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'm'));
    if (!found) throw new Error(`the page shown to the model has no element "${label}"`);
    return act({ action: 'click', element_id: Number(found[1]), reason: 'Open it' });
  };
}

async function rig(t: TestContext, script: LlmScript) {
  const site = fakeDom({ pages: WEB });
  const store: FakeStorage = createFakeStorage({
    local: { data: { agent_settings: { provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'test-model', modelTier: 'large', maxSteps: 12, actionDelayMs: 1, effortDefault: 'low' } } },
    session: { data: {} },
  });
  const fc = fakeChrome({
    tabs: { list: [{ id: 101, windowId: 1, url: LIST }] },
    tabGroups: true,
    storage: store,
    dom: true,
  });
  site.attach(fc, 101);
  const restoreChrome = fc.install();
  Logger.clearLogs();
  const llm = fakeLlm(script);
  const engine = new AgentRunner(101, 1, undefined, llm.port({ model: 'test-model' }));
  engine.autoConfirmAction = true;
  await engine.restorePromise;
  t.after(() => {
    engine.dispose();
    restoreChrome();
  });
  return { site, fc, llm, engine, store };
}

describe('per-turn state resets between two tasks on the same tab', () => {
  test('a stale replan decision, plan revision and spend from turn 1 do not hijack turn 2 (BUG-17, BUG-18, BUG-25)', async (t) => {
    // Turn 1: plan two shop.test sites, open the product page, finish verified.
    const script: LlmScript = [
      PLAN_1,
      clickOn('Laptop 16 DIY Edition'),
      finishWith('The Framework Laptop 16 costs 1.399,00 EUR.'),
      // Turn 2: a completely different task - it must get its own planner call
      // and its own fresh plan, budget and finish. The tab is still on the
      // product page, so the model first navigates back to the list.
      PLAN_2,
      act({ action: 'navigate', url: LIST, reason: 'Back to the list' }),
      clickOn('Deal of the day'),
      finishWith('The deal of the day costs 1.299,00 EUR.'),
    ];
    const { engine, store, llm } = await rig(t, script);

    await engine.startTask(GOAL1, 101);
    assert.equal(engine.status, 'idle', 'turn 1 finished');
    assert.equal(finishes(engine).length, 1);

    // Seed the per-turn channels with exactly the leftovers the pre-fix code
    // left behind at the end of a turn that did a replan: a stale replan
    // decision, the plan revision base, a nearly spent budget and a refused
    // finish. updateState as 'finalize' applies the values without triggering
    // any successor (finalize's only edge is END).
    const saver = new SessionStorageSaver(store.connect().session);
    const graph = buildOrchestratorGraph(saver);
    const cfg = { configurable: { thread_id: '101' } };
    const afterTurn1 = await graph.getState(cfg);
    const turn1Plan = (afterTurn1.values as any).planMeta;
    assert.ok(turn1Plan, 'turn 1 left a plan behind');
    await graph.updateState(cfg, {
      reflectResult: { decision: 'replan', dropSites: ['s2'], reason: 'stale decision from turn 1', changes: '', by: 'llm' },
      planPrev: turn1Plan,
      budget: { ...(turn1Plan ? (afterTurn1.values as any).budget : {}), used: 999, reserve: 0, slack: 0 },
      lastRefusedFinish: { action: 'finish', answer: 'an answer of the turn before' },
      finishSendBacks: 3,
    }, 'finalize');

    await engine.startTask(GOAL2, 101);
    assert.equal(engine.status, 'idle', `turn 2 finished (pauseReason=${(engine as any).pauseReason}, last=${JSON.stringify(engine.history.at(-1))}, logs=${Logger.getLogsHistory().slice(-6).map((e) => e.message).join(' | ')})`);

    // The planner ran again for the new task (pre-fix: 0 calls, the revision
    // branch answered the new task with turn 1's plan).
    const planCalls = llm.calls.filter((c: any) => c.node === 'plan');
    assert.equal(planCalls.length, 2, `turn 2 must call the planner once, got ${planCalls.length} total`);
    assert.match(planCalls[1].messages.at(-1)?.content ?? '', new RegExp(GOAL2.slice(0, 10)), 'the planner was asked about the new task');

    // The turn 2 finish is the new task's answer, not the seeded refused one.
    const allFinishes = finishes(engine);
    assert.equal(allFinishes.length, 2, 'turn 2 produced its own finish');
    assert.equal(allFinishes[1].answer, 'The deal of the day costs 1.299,00 EUR.');

    // The site actually ran: the stale budget did not route straight to compile.
    assert.ok((engine.budget?.used ?? 99) < 10, `turn 2 starts from a fresh budget, used=${engine.budget?.used}`);
    assert.equal(
      engine.history.some((h: any) => h.type === 'partial_result'),
      false,
      'no partial_result - the new task was not answered with a bogus partial',
    );
  });
});

function finishes(engine: AgentRunner): Array<{ answer: string }> {
  return engine.history.filter((h: any) => h.type === 'finish') as never;
}

describe('typed strings do not leak from one task into the next one', () => {
  test('task 2 still sees the price task 1 typed into the search box (BUG-26)', async (t) => {
    const PAGES: PageSpec[] = [
      {
        url: LIST,
        title: 'Items List',
        text: ['Item 42 available for 99 USD', 'Last price 2,189.00 USD'],
        elements: [input('search', { label: 'Search' }), link('Item 42 Details', PRODUCT)],
      },
    ];
    const site = fakeDom({ pages: PAGES });
    const store: FakeStorage = createFakeStorage({
      local: { data: { agent_settings: { provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'test-model', maxSteps: 12, actionDelayMs: 1, effortDefault: 'low' } } },
      session: { data: {} },
    });
    const fc = fakeChrome({
      tabs: { list: [{ id: 101, windowId: 1, url: LIST }] },
      tabGroups: true,
      storage: store,
      dom: true,
    });
    site.attach(fc, 101);
    const restoreChrome = fc.install();
    Logger.clearLogs();
    // Task 1 types the price into the search box and finishes. Task 2 reads the
    // page - which legitimately shows the same price - and finishes citing it.
    const llm = fakeLlm([
      PLAN_1,
      act({ action: 'type', element_id: 1, text: '2,189.00', reason: 'Search for it' }),
      finishWith('The search box is on the page.'),
      PLAN_2,
      act({ action: 'read_page_text', reason: 'Read the text' }),
      finishWith('The page shows Item 42 for 99 USD and a last price of 2,189.00 USD.'),
    ]);
    const engine = new AgentRunner(101, 1, undefined, llm.port({ model: 'test-model' }));
    await engine.restorePromise;
    t.after(() => {
      engine.dispose();
      restoreChrome();
    });

    await engine.startTask('Search for item 42', 101);
    assert.equal(engine.status, 'idle', `task 1 finished (pauseReason=${(engine as any).pauseReason})`);
    const { runtimeRegistry } = await import('../../src/background/runner/runtimeRegistry.ts');
    const runtime = runtimeRegistry.get('101');
    assert.ok(runtime);
    assert.ok((runtime.typedTexts ?? []).includes('2,189.00'), 'task 1 remembered the typed string');

    await engine.startTask('What does the list page show?', 101);
    assert.equal(engine.status, 'idle', `task 2 finished (pauseReason=${(engine as any).pauseReason}, hist=${engine.history.slice(-2).map((h) => JSON.stringify(h).slice(0, 140)).join(' // ')})`);

    // BUG-26: the typed strings of task 1 were reset with the new task...
    assert.deepEqual(runtime.typedTexts ?? [], [], 'typedTexts must be empty at the start of task 2');
    // ...so the price task 1 typed stays in task 2's evidence and the audit
    // verifies the answer instead of sending it back as a lie.
    assert.equal(engine.withoutTypedText('Last price 2,189.00 USD'), 'Last price 2,189.00 USD');
    const finish = finishes(engine).at(-1);
    assert.ok(finish, 'task 2 finished');
    assert.equal((finish as any)?.audit?.verdict, 'verified', JSON.stringify((finish as any)?.audit?.notes));
  });
});

// ---------------------------------------------------------------------------------------------
// per-turn-state-leak: findings, site summaries, the replan count, the blocked list and the
// domains the user approved belong to ONE task. A follow-up task on the same tab reuses the
// thread, and site ids restart at s1 with every plan, so turn 2's s1 used to inherit turn 1's s1
// value (FINDINGS block, table cell, finding URL), an offer for a site that is not in turn 2's
// plan, an old replan count, and - a safety leak - the domains approved on a confirm card in turn
// 1 ("Remember <domain> for this task"). Resuming a PAUSED run of the same task keeps all of it.
// ---------------------------------------------------------------------------------------------

const LEAK_HOME = 'https://shop.test/';
const LEAK_LAPTOP = 'https://shop.test/laptop';
const LEAK_OTHER = 'https://other.test/info';
const LEAK_DEAL = 'https://deal.test/offer';

const LEAK_PAGES: PageSpec[] = [
  {
    url: LEAK_HOME,
    title: 'Welcome - Shop',
    text: [{ heading: 'Welcome to the shop' }, 'Browse our laptops'],
    elements: [link('Laptops', LEAK_LAPTOP)],
  },
  {
    url: LEAK_LAPTOP,
    title: 'Framework Laptop 16 - Shop',
    text: [{ heading: 'Framework Laptop 16' }, 'Preis 1.399,00 EUR'],
    elements: [link('Back to the shop', LEAK_HOME)],
  },
  {
    url: LEAK_OTHER,
    title: 'Info - Other',
    text: [{ heading: 'Other site' }, 'Nothing to buy here'],
    elements: [link('Other home', 'https://other.test/')],
  },
  {
    url: LEAK_DEAL,
    title: 'Deal of the day - Deals',
    text: [{ heading: 'Deal of the day' }, 'Sold out today, come back tomorrow'],
    elements: [link('Deals home', 'https://deal.test/')],
  },
];

const researchPlan = (sites: Array<{ domain: string; goal: string; startUrl: string }>): string => JSON.stringify({
  task_kind: 'research',
  columns: ['price'],
  search_query: 'laptop price',
  sites: sites.map((s, i) => ({
    domain: s.domain,
    goal: s.goal,
    startUrl: s.startUrl,
    role: i === 0 ? 'reference' : 'compare',
    kind: 'store',
    difficulty: 1,
    required_fields: ['price'],
    done_when: 'all_required',
    check: { type: 'none', value: '' },
  })),
});

const LAPTOP_SITE = { domain: 'shop.test', goal: 'Find the price of the Framework Laptop 16', startUrl: LEAK_HOME };
const DEAL_SITE = { domain: 'deal.test', goal: 'Find the price of the deal of the day', startUrl: LEAK_DEAL };
const recordPrice = (value: string): string => JSON.stringify({ action: 'record_finding', values: { price: value }, reason: 'The price is on the page' });
const notFound = (reason: string): string => JSON.stringify({ action: 'mark_not_found', reason });

/** The checkpoint of the tab's thread, read through the runner's own graph. */
async function threadValues(rig: GraphRig): Promise<Record<string, any>> {
  const graph = (rig.runner as any).graph;
  const snap = await graph.getState({ configurable: { thread_id: String(rig.tabId) } });
  return snap.values as Record<string, any>;
}

/** Turn 1 of both tests: shop.test, a detour to other.test the user allows with "Remember for this task", then the price. */
async function runLaptopTask(rig: GraphRig, plan: string): Promise<void> {
  rig.push(rigAct.navigate(LEAK_OTHER, 'Check the other site'));
  await rig.start('What does the Framework Laptop 16 cost?', { effort: 'low', plan });
  assert.equal(rig.status(), 'paused', 'the navigation to other.test needs the user (a confirm card)');
  assert.ok(rig.pending().confirm, 'the confirm card for other.test is shown');
  rig.push(rigAct.navigate(LEAK_LAPTOP, 'Back to the laptop'), recordPrice('1.399,00 EUR'));
}

describe('a follow-up task does not inherit the previous task state (per-turn-state-leak)', () => {
  test('turn 2 with another s1 that ends not_found shows no turn 1 value, no offer, a fresh replan count and only its own domains', async (t) => {
    const rig = await graphRig({ pages: LEAK_PAGES, startUrl: LEAK_HOME, plan: null });
    t.after(rig.cleanup);

    // ---- turn 1: the user allows other.test for this task, the price is recorded on shop.test ----
    await runLaptopTask(rig, researchPlan([LAPTOP_SITE]));
    await rig.confirm('approve', 'site');
    assert.equal(rig.status(), 'idle', `turn 1 finished (last=${JSON.stringify(rig.history().at(-1)).slice(0, 200)})`);
    const turn1 = await threadValues(rig);
    assert.ok(turn1.findings.some((f: any) => f.siteId === 's1' && f.field === 'price' && /1\.399/.test(f.valueRaw)), 'turn 1 recorded the price for s1');
    assert.ok(turn1.approvedDomains.includes('other.test'), 'the remembered domain is approved for the rest of turn 1');

    // Seed the leftovers a longer turn 1 leaves behind (exactly the channel shapes, applied as
    // 'finalize' so no successor runs): a partial site summary (an offer), a used replan, a resume
    // route, an offer, and one blocked entry of every kind.
    const graph = (rig.runner as any).graph;
    const cfg = { configurable: { thread_id: String(rig.tabId) } };
    const blockedOf = (domain: string, kind: string) => ({ domain, kind, reason: `${kind} in turn 1`, url: `https://${domain}/`, step: 1, tries: 1 });
    await graph.updateState(cfg, {
      siteSummaries: [{ siteId: 's2', status: 'partial', criteriaMet: false, findings: 0, blockers: [], stepsUsed: 3, failures: [], anomalies: [], userAnswered: false, notes: 'turn 1 ran out of steps' }],
      replan: { count: 5, lastReason: 'turn 1 replan' },
      resumeRoute: 'sched',
      offerPayload: { partialSiteIds: ['s2'], suggestedLevel: 'high' },
      blocked: { $set: {
        'challenge.test': blockedOf('challenge.test', 'challenge'),
        'broken.test': blockedOf('broken.test', 'error_page'),
        'reported.test': blockedOf('reported.test', 'model_reported'),
        'google.com': blockedOf('google.com', 'search_engine'),
        'chrome.google.com': blockedOf('chrome.google.com', 'restricted'),
      } },
    }, 'finalize');

    // ---- turn 2: a different task whose s1 is deal.test; it ends not_found ----
    rig.push(rigAct.navigate(LEAK_OTHER, 'Check the other site'));
    await rig.start('What does the deal of the day cost?', { effort: 'low', plan: researchPlan([DEAL_SITE]) });

    // The domain approved on turn 1's card is gone: the same navigation asks again.
    assert.equal(rig.status(), 'paused', 'turn 1\'s "Remember other.test for this task" must not approve other.test in turn 2');
    assert.ok(rig.pending().confirm, 'turn 2 shows its own confirm card for other.test');
    rig.push(notFound('The deal is sold out, no price is shown'));
    await rig.confirm('reject');
    assert.equal(rig.status(), 'idle', `turn 2 finished (last=${JSON.stringify(rig.history().at(-1)).slice(0, 200)})`);

    // The FINDINGS block of turn 2 never carried turn 1's s1 value.
    const turn2Policy = rig.llm.callsOf('policy').slice(-2);
    for (const call of turn2Policy) {
      const shown = String((call as any).messages?.at(-1)?.content ?? '');
      assert.doesNotMatch(shown, /FINDINGS:[\s\S]*1\.399/, 'turn 1\'s s1 price must not be in turn 2\'s FINDINGS block');
    }

    // The card: a partial result with no value and no URL from turn 1.
    const lastTurn = rig.history().slice(rig.history().findLastIndex((h: any) => h.type === 'user_goal'));
    const final = lastTurn.find((h: any) => h.type === 'finish' || h.type === 'partial_result') as any;
    assert.ok(final, 'turn 2 has its own final entry');
    assert.equal(final.type, 'partial_result', 'a not_found s1 is not a "Done"');
    assert.doesNotMatch(final.answer, /1\.399/, `turn 2's answer must not show turn 1's price: ${final.answer}`);
    assert.doesNotMatch(final.answer, /shop\.test\/laptop/, 'turn 2\'s answer must not link turn 1\'s page');
    assert.deepEqual(final.findings ?? [], [], 'turn 2 recorded nothing');
    const priceCell = final.table?.rows?.find((r: any) => r.siteId === 's1')?.cells?.price ?? null;
    assert.equal(priceCell, null, 'the s1 price cell of turn 2 is empty');

    const turn2 = await threadValues(rig);
    assert.deepEqual(turn2.findings, [], 'no live finding of turn 1 is left in turn 2');
    assert.equal(turn2.offerPayload, null, 'no offer for a site that is not in turn 2\'s plan');
    assert.equal(turn2.replan.count, 0, 'the replan count starts at 0 in turn 2');
    assert.deepEqual(turn2.siteSummaries.map((s: any) => s.siteId), ['s1'], 'only turn 2\'s own site summary');
    assert.deepEqual([...turn2.approvedDomains].sort(), ['deal.test'], 'only what turn 2\'s plan grants (other.test was denied in turn 2)');
    assert.deepEqual(Object.keys(turn2.blocked).sort(), ['chrome.google.com', 'google.com'], 'only the restricted and search_engine entries outlive their task');

    // Turn 1's findings are handed to turn 2 as prior-task findings, tagged with their turn.
    assert.ok(
      turn2.priorFindings.some((f: any) => f.turn === 1 && f.field === 'price' && /1\.399/.test(f.valueRaw) && f.url === LEAK_LAPTOP),
      `turn 1's price is kept as a prior finding of turn 1: ${JSON.stringify(turn2.priorFindings)}`,
    );
    rig.assertClean();
  });

  test('resuming a paused run of the SAME task keeps the domains the user approved, the findings and the summaries', async (t) => {
    const rig = await graphRig({ pages: LEAK_PAGES, startUrl: LEAK_HOME, plan: null });
    t.after(rig.cleanup);

    // s1: the user allows other.test for this task, then the price is recorded. s2 starts with a
    // model call that is still thinking when the user pauses.
    await runLaptopTask(rig, researchPlan([LAPTOP_SITE, DEAL_SITE]));
    rig.push({ text: notFound('never used'), delayMs: 60_000 });
    const run = rig.confirm('approve', 'site');
    // waitForCall spins on setImmediate only; the navigations of s1 settle on real timers, so poll here.
    for (let waited = 0; rig.llm.callsOf('policy').length < 4; waited += 5) {
      if (waited > 30_000) throw new Error(`s2's first policy call never came (${rig.llm.callsOf('policy').length} policy calls)`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(rig.runner.pause().success, true);
    await run;
    assert.equal(rig.status(), 'paused');
    assert.equal(rig.runner.pauseReason, 'user');

    const paused = await threadValues(rig);
    assert.ok(paused.approvedDomains.includes('other.test'), 'the grant of s1 is in the run state while paused');

    // After the resume, s2 navigates to other.test: the grant from earlier in this task still holds.
    rig.push(rigAct.navigate(LEAK_OTHER, 'Check the other site'), notFound('No deal price on the other site'));
    assert.equal((await rig.resume()).success, true);
    assert.equal(rig.status(), 'idle', `the run finished without a second confirm card (pending=${JSON.stringify(rig.pending().confirm)})`);
    const lastShown = String((rig.llm.callsOf('policy').at(-1) as any)?.messages?.at(-1)?.content ?? '');
    assert.match(lastShown, /CURRENT PAGE: "Info - Other" - https:\/\/other\.test\/info/, 's2 reached other.test with no new card');

    const after = await threadValues(rig);
    assert.ok(after.approvedDomains.includes('other.test'), 'the grant survives the pause and resume');
    assert.ok(after.findings.some((f: any) => f.siteId === 's1' && /1\.399/.test(f.valueRaw)), 's1\'s finding survives the pause and resume');
    assert.deepEqual(after.siteSummaries.map((s: any) => s.siteId), ['s1', 's2'], 'both site summaries of this task');
    assert.equal(after.turnIndex, 1, 'the resume did not start a new turn');
    rig.assertClean();
  });
});

describe('the prior-task findings hand-off (priorFindings)', () => {
  const finding = (id: string, field: string, valueRaw: string, extra: Record<string, unknown> = {}): any => ({
    id, siteId: 's1', field, valueRaw, value: valueRaw, url: 'https://shop.test/laptop', capturedAt: '', step: 1, docId: 'd',
    evidence: { snippet: valueRaw, source: 'text' }, checks: [], quality: 'verified', ...extra,
  });

  test('the finished task\'s shown findings are tagged with its turn; a superseded one is dropped', () => {
    const out = carryPriorFindings({
      turnIndex: 3,
      findings: [finding('a', 'price', '1.499,00 EUR'), finding('b', 'price', '1.399,00 EUR', { supersedes: 'a' }), finding('c', 'shipping', 'kostenlos')],
      priorFindings: [{ ...finding('old', 'price', '9,99 EUR'), turn: 1 }],
    });
    assert.deepEqual(out.map((f) => [f.id, f.turn]), [['b', 3], ['c', 3]]);
    assert.equal(priorFindingLine(out[0]), '[turn 3, shop.test] price: 1.399,00 EUR (https://shop.test/laptop)');
  });

  test('a finished task with no findings keeps the research task before it', () => {
    const earlier = [{ ...finding('old', 'price', '9,99 EUR'), turn: 1 }];
    assert.deepEqual(carryPriorFindings({ turnIndex: 2, findings: [], priorFindings: earlier }), earlier);
  });

  test('the hand-off is capped, newest kept', () => {
    const many = Array.from({ length: 60 }, (_, i) => finding(`f${i}`, `field_${i}`, String(i)));
    const out = carryPriorFindings({ turnIndex: 1, findings: many, priorFindings: [] });
    assert.equal(out.length, 40);
    assert.equal(out[0].id, 'f20');
    assert.equal(out.at(-1)?.id, 'f59');
  });
});
