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
import { buildOrchestratorGraph } from '../../src/background/graph/orchestrator.ts';

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
const PLAN_1 = '["Open the Framework Laptop 16 page", "Read the price there"]';
const PLAN_2 = '["Open the deal of the day"]';
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
