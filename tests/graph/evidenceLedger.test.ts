/**
 * tests/graph/evidenceLedger.test.ts
 *
 * The evidence ledger and the finish gate inside the LangGraph runner: what they record, keep,
 * store, and clamp.
 *
 * Ports the 56 tests of tests/agentEngineEvidence.test.ts and 2 tests of tests/agentEngineFakeHarness.test.ts
 * to the native LangGraph AgentRunner and graphRig.
 */

import test, { describe } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { fakeChrome } from '../helpers/fakeChrome.ts';
import { createFakeStorage, type FakeStorage } from '../helpers/fakeStorageSession.ts';
import { fakeDom, input, link, type PageSpec } from '../helpers/fakeDom.ts';
import { fakeLlm, type LlmCall, type ReplyEntry } from '../helpers/fakeLlm.ts';
import { Logger } from '../../src/shared/logger.ts';
import type { GateContext, GateDecision } from '../../src/background/agent/finishPolicy.ts';
import { AgentRunner } from '../../src/background/runner/AgentRunner.ts';
import { runtimeRegistry } from '../../src/background/runner/runtimeRegistry.ts';
import { zeroClock } from '../helpers/graphHarness.ts';
import {
  hostOf,
  hasUserInfo,
  registrableHost,
  siteOf,
  normalizeUrlForMatch,
  urlCovers,
  isOriginOnly,
  frontDoorHost,
  looksLikeDomain,
  maskLinks,
  scanSites,
  scanNumbers,
  durationUnitOf,
  sameDuration,
  canonicalAmounts,
  sameAmount,
  findSnippet,
  snippetAround,
  cutAtWord,
  snippetWithWholeWords,
  hasShippingWording,
  condenseText,
  normalizeSpaces,
  EvidenceLedger,
  ledgerFromSnapshot,
} from '../../src/background/agent/evidence.ts';
import { compactLedgerSnapshot } from '../../src/background/agent/planEvidence.ts';
import { SessionStorageSaver } from '../../src/background/checkpoint/SessionStorageSaver.ts';
import { buildOrchestratorGraph } from '../../src/background/graph/orchestrator.ts';

interface Audit {
  verdict: 'verified' | 'partial' | 'unverified';
  opened: Array<{ host: string; url: string }>;
  notOpened: string[];
  notes: Array<{ code: string; severity: 'lie' | 'gap' | 'soft'; text: string }>;
  sendBacks: number;
}

// ---------------------------------------------------------------------------------------------
// The fake web and the rig
// ---------------------------------------------------------------------------------------------

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

const GOAL = 'What does the Framework Laptop 16 cost?';
// A proper plan object: the old bare-array fixture would now be a parse error that asks the
// model for a repair (planner-fallback-invented-plan), so the plan is spelled out here. It keeps
// the shape the old array reply produced for this task (answer kind, page sites, value field).
const PLAN_2 = JSON.stringify({
  task_kind: 'answer',
  columns: ['value'],
  sites: [
    { name: 'Open the Framework Laptop 16 page', goal: 'Open the Framework Laptop 16 page', kind: 'page', required_fields: ['value'] },
    { name: 'Read the price there', goal: 'Read the price there', role: 'compare', kind: 'page', required_fields: ['value'] },
  ],
});
const TWO_SITE_PLAN = JSON.stringify({
  task_kind: 'answer',
  columns: ['value'],
  sites: [
    { domain: 'shop.test', name: 'shop.test: Find the price', goal: 'shop.test: Find the price', kind: 'page', required_fields: ['value'] },
    { domain: 'deal.test', name: 'deal.test: Find the deal price', goal: 'deal.test: Find the deal price', role: 'compare', kind: 'page', required_fields: ['value'] },
  ],
});
const PLAN_SITES = JSON.stringify({
  task_kind: 'answer',
  columns: ['value'],
  sites: [
    { domain: 'shop.test', name: 'shop.test: Find the price', goal: 'shop.test: Find the price', kind: 'page', required_fields: ['value'] },
    { domain: 'deal.test', name: 'deal.test: Find the deal price', goal: 'deal.test: Find the deal price', role: 'compare', kind: 'page', required_fields: ['value'] },
    { name: 'Compile the answer', goal: 'Compile the answer', kind: 'page', required_fields: ['value'] },
  ],
});
const TWITTER_PLAN = JSON.stringify({
  task_kind: 'research',
  columns: ['value'],
  sites: [
    { domain: 'twitter.com', name: 'Open twitter.com', goal: 'Open twitter.com', kind: 'page', required_fields: ['value'] },
    { name: 'Read the newest post', goal: 'Read the newest post', role: 'compare', kind: 'page', required_fields: ['value'] },
  ],
});
const DEAL_PLAN = JSON.stringify({
  task_kind: 'answer',
  columns: ['value'],
  sites: [
    { name: 'Read the laptop list', goal: 'Read the laptop list', kind: 'page', required_fields: ['value'] },
    { name: 'Check Deal for the same laptop', goal: 'Check Deal for the same laptop', role: 'compare', kind: 'page', required_fields: ['value'] },
    { name: 'Write the answer', goal: 'Write the answer', role: 'compare', kind: 'page', required_fields: ['value'] },
  ],
});
const READ_PRICE_PLAN = JSON.stringify({
  task_kind: 'answer',
  columns: ['value'],
  sites: [
    { domain: 'shop.test', name: 'shop.test: read the price', goal: 'shop.test: read the price', kind: 'page', required_fields: ['value'] },
    { domain: 'deal.test', name: 'deal.test: read the deal price', goal: 'deal.test: read the deal price', role: 'compare', kind: 'page', required_fields: ['value'] },
    { name: 'Write the answer', goal: 'Write the answer', role: 'compare', kind: 'page', required_fields: ['value'] },
  ],
});
// A research variant of PLAN_2 for the goal whose wording must not read as an answer task.
const PLAN_2_RESEARCH = JSON.stringify({
  task_kind: 'research',
  columns: ['value'],
  sites: [
    { name: 'Open the Framework Laptop 16 page', goal: 'Open the Framework Laptop 16 page', kind: 'page', required_fields: ['value'] },
    { name: 'Read the price there', goal: 'Read the price there', role: 'compare', kind: 'page', required_fields: ['value'] },
  ],
});
const act = (action: Record<string, unknown>): string => JSON.stringify(action);
const finishWith = (answer: string, reason = 'I have all the information'): string => act({ action: 'finish', answer, reason });
const navigateTo = (url: string): string => act({ action: 'navigate', url, reason: 'Go there' });
const readText = act({ action: 'read_page_text', reason: 'Read the text' });

/** The reply that clicks the element with this label. The id is read from the page the model was shown. */
function clickOn(label: string): ReplyEntry {
  return (call: LlmCall) => {
    const shown = call.messages.at(-1)?.content ?? '';
    const found = shown.match(new RegExp(`^\\[(\\d+)\\] \\S+ "${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'm'));
    if (!found) throw new Error(`the page shown to the model has no element "${label}"`);
    return act({ action: 'click', element_id: Number(found[1]), reason: 'Open it' });
  };
}

const LIE = 'The Framework Laptop 16 costs 9,99 EUR.';

function newStore(maxSteps = 12, session: Record<string, unknown> = {}): FakeStorage {
  return createFakeStorage({
    // allowExecuteJs: execute_js is opt-in (safety/confirm-card-blind-approval); the execute_js tests here need it on.
    local: { data: { agent_settings: { provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'test-model', modelTier: 'large', allowExecuteJs: true, maxSteps, actionDelayMs: 1, effortDefault: 'low' } } },
    session: { data: session },
  });
}

interface RunOptions {
  goal?: string;
  script: ReplyEntry[];
  start?: string;
  maxSteps?: number;
  policy?: (ctx: GateContext) => GateDecision;
  scripting?: unknown[];
  store?: FakeStorage;
  prepare?: (engine: AgentRunner) => void;
  laterTabs?: number[];
  pages?: PageSpec[];
  redirects?: Record<string, string>;
}

async function rig(t: TestContext, options: RunOptions) {
  const site = fakeDom({ pages: options.pages ?? WEB });
  const store = options.store ?? newStore(options.maxSteps ?? 12);
  const fc = fakeChrome({
    tabs: { list: [{ id: 101, windowId: 1, url: options.start ?? LIST }] },
    tabGroups: true,
    ...(options.laterTabs ? { windows: true } : {}),
    storage: store,
    dom: true,
    ...(options.scripting ? { scripting: { executeScript: options.scripting } } : {}),
  });
  for (const tabId of [101, ...(options.laterTabs ?? [])]) {
    site.attach({ tabs: { get: (id) => fc.tabs.get(id), navigate: (id, url) => fc.tabs.navigate(id, options.redirects?.[url] ?? url) }, dom: fc.dom }, tabId);
  }
  const restoreChrome = fc.install();
  Logger.clearLogs();
  const llm = fakeLlm(options.script);
  const port = llm.port({ model: 'test-model' });
  const engine = new AgentRunner(101, 1, undefined, port);
  engine.autoConfirmAction = true;
  const clock = zeroClock();
  const registered = runtimeRegistry.get(String(101));
  if (registered) registered.clock = clock;
  engine.setTabAdoptedCallback((newTabId) => {
    site.attach(fc, newTabId);
  });
  await engine.restorePromise;
  t.after(() => {
    engine.dispose();
    restoreChrome();
  });
  const policyCalls: GateContext[] = [];
  if (options.policy) {
    const decide = options.policy;
    engine.finishPolicy = (ctx) => {
      policyCalls.push({ ...ctx });
      return decide(ctx);
    };
  }
  options.prepare?.(engine);
  return { site, fc, llm, engine, store, policyCalls, AgentRunner };
}
type World = Awaited<ReturnType<typeof rig>>;

async function runTask(t: TestContext, options: RunOptions): Promise<World> {
  const world = await rig(t, options);
  await world.engine.startTask(options.goal ?? GOAL, 101);
  await world.fc.settle();
  world.fc.assertClean();
  world.site.assertClean();
  world.llm.assertClean();
  return world;
}

const stepMessage = (llm: { calls: LlmCall[] }, i: number): string => llm.calls[i]?.messages.at(-1)?.content ?? '';

const finishes = (engine: AgentRunner): Array<{ answer: string; audit?: Audit; unconfirmed?: true }> => engine.history.filter((h) => h.type === 'finish') as never;
const refusals = (engine: AgentRunner): Array<Record<string, any>> => engine.history.filter((h) => h.type === 'execution_result' && (h as any).finishRefused);
const logLines = (): string[] => Logger.getLogsHistory().map((e) => e.message);
const hasLog = (prefix: string): boolean => logLines().some((l) => l.startsWith(prefix));

// ---------------------------------------------------------------------------------------------
// What goes into the ledger
// ---------------------------------------------------------------------------------------------

describe('the ledger records what the engine read', () => {
  test('a snapshot at every read, and the text of read_page_text, under the URL the tab was on', async (t) => {
    const { engine } = await runTask(t, {
      script: [PLAN_2, clickOn('Laptop 16 DIY Edition'), readText, finishWith('The Framework Laptop 16 DIY Edition costs 1.399,00 EUR.')],
    });

    const pages = engine.evidence.entries.filter((e) => e.kind === 'page').map((e) => e.url);
    assert.deepEqual([...new Set(pages)], [LIST, PRODUCT]);
    const texts = engine.evidence.entries.filter((e) => e.kind === 'text');
    assert.equal(texts.length, 1, 'one read_page_text');
    assert.equal(texts[0]?.url, PRODUCT, 'under the page the tab was on when it ran');
    assert.match(texts[0]?.text ?? '', /1\.399,00 EUR/);
    assert.doesNotMatch(texts[0]?.text ?? '', /Extracted text snippet/, 'the text, not the wrapper of the content script');
    assert.equal(finishes(engine)[0]?.audit?.verdict, 'verified');
  });

  test('"[EVIDENCE_RECORDED]" is logged the first time a URL is seen, and only then', async (t) => {
    await runTask(t, { script: [PLAN_2, clickOn('Laptop 16 DIY Edition'), readText, readText, finishWith('The price is 1.399,00 EUR.')] });

    const recorded = logLines().filter((l) => l.startsWith('[EVIDENCE_RECORDED]'));
    assert.equal(recorded.length, 2, `one per URL: ${JSON.stringify(recorded)}`);
    assert.match(recorded[0] ?? '', new RegExp(LIST.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')));
    assert.match(recorded[1] ?? '', new RegExp(PRODUCT.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')));
  });

  test("the model's own words are not evidence: a price that is only in its reason is still flagged", async (t) => {
    const { engine } = await runTask(t, {
      policy: () => 'annotate',
      script: [PLAN_2, finishWith(LIE, 'The page clearly shows 9,99 EUR for the Framework Laptop 16')],
    });

    assert.equal(engine.evidence.entries.some((e) => /9,99/.test(e.text)), false);
    const audit = finishes(engine)[0]?.audit;
    assert.equal(audit?.verdict, 'unverified');
    assert.ok(audit?.notes.some((n) => n.code === 'number_not_in_evidence'), JSON.stringify(audit?.notes));
  });

  test('execute_js: what the code computed from the page is a read, a literal it returns is not', async (t) => {
    const computed = await runTask(t, {
      scripting: [[{ frameId: 0, result: { __scoutfoxOk: true, value: 'Preis 12,50 EUR' } }]],
      script: [PLAN_2, act({ action: 'execute_js', code: "return document.querySelector('.price').textContent", reason: 'Read the price' }), finishWith('The price is 12,50 EUR.')],
    });
    const js = computed.engine.evidence.entries.filter((e) => e.kind === 'js');
    assert.equal(js.length, 1);
    assert.equal(js[0]?.text, 'Preis 12,50 EUR');
    assert.equal(js[0]?.url, LIST);
    assert.equal(finishes(computed.engine)[0]?.audit?.verdict, 'verified');
  });

  test('execute_js that only hands back its own literal cannot launder an invented number', async (t) => {
    const { engine } = await runTask(t, {
      policy: () => 'annotate',
      scripting: [[{ frameId: 0, result: { __scoutfoxOk: true, value: 'Preis 7,77 EUR' } }]],
      script: [PLAN_2, act({ action: 'execute_js', code: "return 'Preis 7,77 EUR'", reason: 'Check the price' }), finishWith('The price is 7,77 EUR.')],
    });

    assert.equal(engine.evidence.entries.some((e) => e.kind === 'js'), false, 'nothing recorded');
    assert.equal(finishes(engine)[0]?.audit?.verdict, 'unverified');
  });

  test('a window the model opens: the page the engine reads there is recorded under its own URL', async (t) => {
    const { engine } = await runTask(t, {
      laterTabs: [1000],
      script: [PLAN_2, act({ action: 'open_window', url: DEAL, reason: 'Compare in a second window' }), finishWith('The deal page says 1.299,00 EUR, and the list page said 1.399,00 EUR.')],
    });

    const dealReads = engine.evidence.entries.filter((e) => e.url === DEAL);
    assert.ok(dealReads.length >= 1, 'the page of the new window is in the ledger');
    assert.ok(engine.evidence.hasOpened('deal.test'));
    assert.ok(engine.evidence.hasOpened('shop.test'), 'and the first window is still there');
    assert.equal(finishes(engine)[0]?.audit?.verdict, 'verified', JSON.stringify(finishes(engine)[0]?.audit?.notes));
  });

  test('read_network_requests: the listing is a read, under the URL of the tab', async (t) => {
    const { engine } = await runTask(t, {
      prepare: (e) => e.recordNetworkRequest(101, { method: 'GET', url: 'https://api.shop.test/price', ok: true, status: 200, durationMs: 31, respBody: '{"price":"13,37 EUR"}' }),
      script: [PLAN_2, act({ action: 'read_network_requests', filter: { status: 'all' }, reason: 'Look for the API call' }), finishWith('The API says 13,37 EUR.')],
    });

    const network = engine.evidence.entries.filter((e) => e.kind === 'network');
    assert.equal(network.length, 1);
    assert.equal(network[0]?.url, LIST);
    assert.match(network[0]?.text ?? '', /13,37 EUR/);
    assert.doesNotMatch(network[0]?.text ?? '', /^Recent Network Activity/);
    assert.equal(finishes(engine)[0]?.audit?.verdict, 'verified');
  });
});

// ---------------------------------------------------------------------------------------------
// Kept, stored, restored, cleared
// ---------------------------------------------------------------------------------------------

describe('the ledger is kept for the session', () => {
  test('a second turn keeps what the first one read, and New Session clears it', async (t) => {
    const world = await runTask(t, { script: [PLAN_2, finishWith('The price is 1.399,00 EUR.'), PLAN_2, finishWith('It is still 1.399,00 EUR.')] });
    assert.equal(world.engine.evidence.hasOpened('shop.test'), true);
    const sizeAfterFirst = world.engine.evidence.size;

    await world.engine.startTask('And what was the price again?', 101);
    assert.ok(world.engine.evidence.size >= sizeAfterFirst, 'the first turn is still in the ledger');
    assert.equal(finishes(world.engine).length, 2);

    world.engine.clearHistory();
    assert.equal(world.engine.evidence.size, 0, 'New Session empties the ledger');
    assert.equal(world.engine.evidence.hasOpened('shop.test'), false);
  });

  test('it is stored with the session, compactly, and a new worker restores it', async (t) => {
    const store = newStore();
    const world = await runTask(t, { store, script: [PLAN_2, clickOn('Laptop 16 DIY Edition'), finishWith('The price is 1.399,00 EUR.')] });

    const storedSnap = world.engine.evidenceSnapshot;
    assert.equal(storedSnap.v, 1);
    assert.ok(storedSnap.entries.length >= 2);
    assert.ok(storedSnap.entries.every((e: any) => ['step', 'kind', 'url', 'title', 'text', 'links'].every((k) => k in e)));

    const again = new world.AgentRunner(101, 1, undefined, world.llm.port());
    await again.restorePromise;
    assert.equal(again.evidence.hasOpened('shop.test'), true);
    assert.equal(again.evidence.size, world.engine.evidence.size);
    assert.equal(again.currentTask, GOAL);
  });

  test('what is stored stays small, however much was read', async (t) => {
    const store = newStore();
    const world = await runTask(t, { store, script: [PLAN_2, finishWith('The price is 1.399,00 EUR.')] });
    for (let i = 0; i < 100; i++) {
      world.engine.evidence.record({ step: i, kind: 'page', url: `https://site${i % 7}.test/p${i}`, title: `Page ${i}`, text: `Preis ${i},00 EUR ${'x'.repeat(5000)}` });
    }
    await world.engine.persistState();
    await world.fc.settle();

    const stored = world.engine.evidenceSnapshot;
    const bytes = JSON.stringify(stored).length;
    assert.ok(bytes < 80_000, `${bytes} bytes of ledger are stored`);
    const hosts = new Set(stored.entries.map((e: { url: string }) => new URL(e.url).hostname));
    for (let i = 0; i < 7; i++) assert.ok(hosts.has(`site${i}.test`), `site${i}.test`);
  });

  test('a session stored before the audit existed has no ledger: it restores as an empty one', async (t) => {
    const store = newStore();
    const world = await rig(t, { store, script: [] });

    assert.equal(world.engine.evidence.size, 0);
    assert.equal(world.engine.evidence.hasOpened('shop.test'), false);
  });

  test('a session that read nothing is stored without a ledger key, as it always was', async (t) => {
    const store = newStore();
    const world = await rig(t, { store, script: [] });
    await world.engine.persistState();
    await world.fc.settle();
    assert.equal(world.engine.evidence.size, 0);
  });
});

// ---------------------------------------------------------------------------------------------
// The clamps around the policy
// ---------------------------------------------------------------------------------------------

describe('the engine clamps the finish policy', () => {
  test('a model that repeats its lie is sent back 4 times, then the finish is annotated whatever the policy says', async (t) => {
    const lies = Array.from({ length: 5 }, () => finishWith(LIE));
    const { engine, policyCalls, llm } = await runTask(t, { policy: () => 'send_back', script: [PLAN_2, clickOn('Laptop 16 DIY Edition'), ...lies] });

    assert.equal(refusals(engine).length, 4);
    assert.deepEqual(policyCalls.map((c) => c.sendBacks), [0, 1, 2, 3, 4]);
    const [entry] = finishes(engine);
    assert.equal(finishes(engine).length, 1);
    assert.equal(entry?.audit?.verdict, 'unverified');
    assert.equal(entry?.audit?.sendBacks, 4);
    assert.match(entry?.answer ?? '', /Verification notes/);
    assert.equal(engine.status, 'idle');
    assert.ok(hasLog('[FINISH_POLICY_CLAMPED]'));
    llm.assertDrained();
  });

  test('with no step left a send-back is impossible: the finish is annotated and the answer is not lost', async (t) => {
    const { engine, policyCalls } = await runTask(t, { maxSteps: 2, policy: () => 'send_back', script: [PLAN_2, clickOn('Laptop 16 DIY Edition'), finishWith(LIE)] });

    assert.equal(policyCalls.length, 1);
    assert.equal(policyCalls[0]?.stepsLeft, 0);
    assert.equal(refusals(engine).length, 0);
    assert.equal(finishes(engine).length, 1, 'the run ends with a finish, not with "reached the maximum steps"');
    assert.equal(finishes(engine)[0]?.audit?.verdict, 'unverified');
    assert.ok(hasLog('[FINISH_POLICY_CLAMPED]'));
  });

  test('the send-back count is per turn: a new task starts at 0 again', async (t) => {
    const truth = finishWith('The price is 1.399,00 EUR.');
    const { engine, policyCalls } = await runTask(t, {
      policy: (ctx) => (ctx.sendBacks === 0 ? 'send_back' : 'annotate'),
      script: [PLAN_2, finishWith(LIE), truth, PLAN_2, finishWith(LIE), truth],
    });
    await engine.startTask('And now the second question: what is the price?', 101);

    assert.deepEqual(policyCalls.map((c) => c.sendBacks), [0, 0], 'the second turn was not counted against the first');
    assert.equal(refusals(engine).length, 2);
    assert.deepEqual(finishes(engine).map((f) => f.audit?.sendBacks), [1, 1]);
  });

  test('an honest "not checked" answer is sent back once, then accepted as partial whatever the policy says', async (t) => {
    const honest = finishWith('shop.test: EUR 1.399,00. deal.test: not checked, I never opened it.');
    const { engine, policyCalls, llm } = await runTask(t, {
      goal: 'Compare the Framework Laptop 16 price on shop.test and deal.test.',
      policy: () => 'send_back',
      script: [TWO_SITE_PLAN, honest, honest],
    });

    assert.equal(policyCalls.length, 2, 'asked about both finishes');
    assert.equal(refusals(engine).length, 1, 'the lazy first one was refused');
    const [entry] = finishes(engine);
    assert.equal(finishes(engine).length, 1);
    assert.equal(entry?.audit?.verdict, 'partial');
    assert.equal(entry?.audit?.sendBacks, 1);
    assert.equal(entry?.answer, 'shop.test: EUR 1.399,00. deal.test: not checked, I never opened it.');
    const accepted = Logger.getLogsHistory().filter((e) => e.message.startsWith('[FINISH_ACCEPTED_PARTIAL]'));
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0]?.level, 'INFO');
    assert.ok(!hasLog('[FINISH_POLICY_CLAMPED]'), 'it is not reported as a clamp');
    llm.assertDrained();
  });

  test('every real clamp is a WARN with the old tag: no step left, the hard cap, a policy that throws, nonsense, a plain-text reply', async (t) => {
    const clampsOf = (): Array<{ level: string; message: string }> => Logger.getLogsHistory().filter((e) => e.message.startsWith('[FINISH_POLICY_CLAMPED]'));
    const expectWarn = (why: RegExp): void => {
      const clamps = clampsOf();
      assert.equal(clamps.length >= 1, true, 'a clamp was logged');
      for (const c of clamps) assert.equal(c.level, 'WARN');
      assert.ok(clamps.some((c) => why.test(c.message)), JSON.stringify(clamps));
      assert.ok(!hasLog('[FINISH_ACCEPTED_PARTIAL]'));
    };

    await runTask(t, { maxSteps: 2, policy: () => 'send_back', script: [PLAN_2, clickOn('Laptop 16 DIY Edition'), finishWith(LIE)] });
    expectWarn(/no step is left to try again/);

    await runTask(t, { policy: () => 'send_back', script: [PLAN_2, clickOn('Laptop 16 DIY Edition'), ...Array.from({ length: 5 }, () => finishWith(LIE))] });
    expectWarn(/already sent back 4 times/);

    await runTask(t, { policy: () => { throw new Error('the policy is broken'); }, script: [PLAN_2, finishWith(LIE)] });
    expectWarn(/the finish policy threw: the policy is broken/);

    await runTask(t, { policy: () => 'accept' as never, script: [PLAN_2, finishWith(LIE)] });
    expectWarn(/the finish policy answered "accept"/);

    await runTask(t, { policy: () => 'send_back', script: [PLAN_2, 'The Framework Laptop 16 costs 9,99 EUR. I am done.'] });
    expectWarn(/a plain-text reply cannot be sent back/);
  });

  test('an honest answer that is out of steps stays a real clamp: the run ended, it was not a choice', async (t) => {
    const honest = finishWith('shop.test: EUR 1.399,00. deal.test: not checked, I never opened it.');
    await runTask(t, {
      goal: 'Compare the Framework Laptop 16 price on shop.test and deal.test.',
      maxSteps: 2,
      policy: () => 'send_back',
      script: [TWO_SITE_PLAN, honest, honest],
    });
    const clamp = Logger.getLogsHistory().find((e) => e.message.startsWith('[FINISH_POLICY_CLAMPED]'));
    assert.equal(clamp?.level, 'WARN');
    assert.match(clamp?.message ?? '', /(?:the run is out of steps|no step is left to try again)/);
  });

  test("the engine's own policy does not refuse the same honest answer a third time", async (t) => {
    const honest = finishWith('shop.test: EUR 1.399,00. deal.test: not checked, I never opened it.');
    const { engine, llm } = await runTask(t, {
      goal: 'Compare the Framework Laptop 16 price on shop.test and deal.test.',
      script: [TWO_SITE_PLAN, honest, honest],
    });

    assert.equal(refusals(engine).length, 1);
    assert.equal(finishes(engine)[0]?.audit?.verdict, 'partial');
    llm.assertDrained();
  });

  test('a send-back uses one step, and the policy is told how many are left', async (t) => {
    const { engine, policyCalls } = await runTask(t, {
      maxSteps: 6,
      policy: (ctx) => (ctx.sendBacks === 0 ? 'send_back' : 'annotate'),
      script: [PLAN_2, finishWith(LIE), finishWith(LIE)],
    });

    assert.deepEqual(policyCalls.map((c) => [c.sendBacks, c.stepsLeft]), [[0, 5], [1, 4]]);
    assert.equal(engine.stepCount, 2);
    assert.equal(refusals(engine).length, 1);
  });

  for (const [name, policy] of [
    ['throws', () => { throw new Error('the policy is broken'); }],
    ['answers "accept"', () => 'accept'],
    ['answers nothing', () => undefined],
  ] as Array<[string, () => unknown]>) {
    test(`a policy that ${name} gives annotate, never the raw answer`, async (t) => {
      const { engine } = await runTask(t, { policy: policy as () => GateDecision, script: [PLAN_2, finishWith(LIE)] });

      const [entry] = finishes(engine);
      assert.equal(entry?.audit?.verdict, 'unverified');
      assert.match(entry?.answer ?? '', /Verification notes/);
      assert.ok(hasLog('[FINISH_POLICY_CLAMPED]'));
      assert.ok(hasLog('[FINISH_ANNOTATED]'));
    });
  }

  test('a plain-text reply the engine wrapped into a finish is gated too, and never sent back', async (t) => {
    const { engine, policyCalls } = await runTask(t, { policy: () => 'send_back', script: [PLAN_2, 'The Framework Laptop 16 costs 9,99 EUR. I am done.'] });

    assert.equal(policyCalls.length, 1, 'the policy was asked once');
    assert.equal(refusals(engine).length, 0, 'and cannot send it back');
    const [entry] = finishes(engine);
    assert.equal(entry?.unconfirmed, true);
    assert.equal(entry?.audit?.verdict, 'unverified');
    assert.ok(!hasLog('[TASK_FINISHED] '));
  });

  test('a refused finish reaches the model as itself, not as a failed click', async (t) => {
    const { llm } = await runTask(t, {
      policy: (ctx) => (ctx.sendBacks === 0 ? 'send_back' : 'annotate'),
      script: [PLAN_2, finishWith(LIE), finishWith(LIE)],
    });

    const retry = llm.calls[2];
    const told = retry?.messages.map((m) => m.content).join('\n') ?? '';
    assert.match(told, /Your finish was refused/);
    assert.match(told, /9,99 EUR/);
    assert.doesNotMatch(told, /Choose a different element or action/);
    const refusal = retry?.messages.find((m) => m.role === 'user' && m.content.includes('Your finish was refused'));
    assert.ok(refusal);
  });
});

// ---------------------------------------------------------------------------------------------
// The log tags
// ---------------------------------------------------------------------------------------------

describe('the log says what the gate did', () => {
  const COMPLETED = '[TASK_FINISHED] Task completed successfully.';

  test('verified: the audit line and the completion line, nothing else', async (t) => {
    await runTask(t, { script: [PLAN_2, clickOn('Laptop 16 DIY Edition'), finishWith('The price is 1.399,00 EUR.')] });

    assert.ok(logLines().includes('[FINISH_AUDIT] verdict=verified lies=0 gaps=0 softs=0'), JSON.stringify(logLines().filter((l) => l.startsWith('[FINISH'))));
    assert.ok(logLines().includes(COMPLETED));
    for (const tag of ['[FINISH_SENT_BACK]', '[FINISH_ANNOTATED]', '[FINISH_REPLACED]', '[TASK_FINISHED_PARTIAL]', '[TASK_FINISHED_UNVERIFIED]']) assert.ok(!hasLog(tag), tag);
  });

  test('annotate: FINISH_AUDIT with its notes, FINISH_ANNOTATED, TASK_FINISHED_UNVERIFIED, never the completion line', async (t) => {
    await runTask(t, { policy: () => 'annotate', script: [PLAN_2, finishWith(LIE)] });

    const audit = Logger.getLogsHistory().find((e) => e.message.startsWith('[FINISH_AUDIT]'));
    assert.match(audit?.message ?? '', /^\[FINISH_AUDIT\] verdict=unverified lies=1 gaps=0 softs=0$/);
    const notes = JSON.parse(audit?.data ?? 'null') as Array<{ code: string; severity: string; text: string }>;
    assert.equal(notes[0]?.code, 'number_not_in_evidence');
    assert.ok(hasLog('[FINISH_ANNOTATED]'));
    assert.ok(hasLog('[TASK_FINISHED_UNVERIFIED]'));
    assert.ok(!logLines().includes(COMPLETED));
  });

  test('replace: FINISH_REPLACED and TASK_FINISHED_UNVERIFIED', async (t) => {
    await runTask(t, { policy: () => 'replace', script: [PLAN_2, finishWith(LIE)] });

    assert.ok(hasLog('[FINISH_REPLACED]'));
    assert.ok(hasLog('[TASK_FINISHED_UNVERIFIED]'));
    assert.ok(!logLines().includes(COMPLETED));
  });

  test('send back: FINISH_SENT_BACK, and the run goes on until it really finishes', async (t) => {
    await runTask(t, {
      policy: (ctx) => (ctx.sendBacks === 0 ? 'send_back' : 'annotate'),
      script: [PLAN_2, finishWith(LIE), finishWith('The price is 1.399,00 EUR on the list page.')],
    });

    assert.equal(logLines().filter((l) => l.startsWith('[FINISH_SENT_BACK]')).length, 1);
    assert.equal(logLines().filter((l) => l.startsWith('[FINISH_AUDIT]')).length, 2);
    assert.ok(logLines().includes(COMPLETED));
  });

  test('partial: TASK_FINISHED_PARTIAL, never the completion line', async (t) => {
    await runTask(t, {
      goal: 'Compare the Framework Laptop 16 price on shop.test and deal.test.',
      policy: () => 'annotate',
      script: [TWO_SITE_PLAN, finishWith('shop.test: EUR 1.399,00. deal.test: not checked, I never opened it.')],
    });

    assert.ok(hasLog('[FINISH_AUDIT] verdict=partial lies=0 gaps=1'));
    assert.ok(hasLog('[TASK_FINISHED_PARTIAL]'));
    assert.ok(!logLines().includes(COMPLETED));
  });
});

// ---------------------------------------------------------------------------------------------
// A verified answer is left alone, soft notes included
// ---------------------------------------------------------------------------------------------

describe('a verified answer', () => {
  test('goes through unchanged, with its soft notes on the entry, and the policy is never asked', async (t) => {
    const answer = 'The Framework Laptop 16 is 1.399,00 EUR on the list page, with free shipping.';
    const { engine, policyCalls } = await runTask(t, { policy: () => 'send_back', script: [PLAN_2, finishWith(answer)] });

    const [entry] = finishes(engine);
    assert.equal(entry?.answer, answer);
    assert.equal(entry?.audit?.verdict, 'verified');
    assert.ok(entry?.audit?.notes.some((n) => n.severity === 'soft' && n.code === 'unsupported_detail'), JSON.stringify(entry?.audit?.notes));
    assert.equal(policyCalls.length, 0);
    assert.ok(logLines().includes('[TASK_FINISHED] Task completed successfully.'));
  });

  test('a finish with no answer is audited as what it is and is not sent back for that (a site that collects, not an answer site)', async (t) => {
    // The goal must not read as an answer task ("what", "price", "cost", ...): an ANSWER site does not accept an empty finish at
    // all (next test), so the audit would never see one.
    const { engine } = await runTask(t, { goal: 'Open the Framework Laptop 16 listing on shop.test', script: [PLAN_2_RESEARCH, act({ action: 'finish', reason: 'done' })] });

    const [entry] = finishes(engine);
    assert.match(entry?.answer ?? '', /did not provide an answer/);
    assert.equal(entry?.audit?.verdict, 'verified');
  });

  test('an answer site does not accept a finish with no answer: the model is told, and the next reply is audited', async (t) => {
    const { engine, llm } = await runTask(t, {
      script: [PLAN_2, act({ action: 'finish', reason: 'done' }), finishWith('The Framework Laptop 16 is 1.399,00 EUR on the list page.')],
    });

    const [entry] = finishes(engine);
    assert.equal(entry?.answer, 'The Framework Laptop 16 is 1.399,00 EUR on the list page.');
    assert.equal(entry?.audit?.verdict, 'verified');
    assert.match(stepMessage(llm, 2), /had no answer in it/, 'the model is told its reply had no answer');
  });
});

// ---------------------------------------------------------------------------------------------
// The step message
// ---------------------------------------------------------------------------------------------

describe('the step message block', () => {
  test('tells the model which pages it read, and the rule, between the plan and the page text', async (t) => {
    const { llm } = await runTask(t, { script: [PLAN_2, clickOn('Laptop 16 DIY Edition'), finishWith('The price is 1.399,00 EUR.')] });

    const second = stepMessage(llm, 2);
    assert.match(second, /Pages you have read: .*shop\.test/);
    assert.match(second, /only write facts, prices and links that appear on pages you have read/i);
    assert.doesNotMatch(second, /Not opened yet/);
    const order = ['Plan (step', 'Pages you have read:', 'PAGE TEXT'].map((s) => second.indexOf(s));
    assert.ok(order.every((i) => i >= 0) && order[0]! < order[1]! && order[1]! < order[2]!, `order ${order}`);
  });

  test('states the real overall step cap, not a phantom /12 (BUG-20)', async (t) => {
    // The worker state has no `limits` channel; the old read
    // `(state as any).limits?.maxSteps ?? 12` always showed 12 whatever the
    // configured cap was. With maxSteps 40 the plan block must say /40.
    const { llm } = await runTask(t, { maxSteps: 40, script: [PLAN_2, clickOn('Laptop 16 DIY Edition'), finishWith('The price is 1.399,00 EUR.')] });

    assert.match(stepMessage(llm, 1), /Plan \(step 1\/40 overall\)/);
    assert.doesNotMatch(stepMessage(llm, 1), /\/12 overall/);
  });

  test('names the sites of the task that are not opened yet, and drops them once they are', async (t) => {
    const { llm } = await runTask(t, {
      goal: 'Compare the Framework Laptop 16 price on shop.test and deal.test.',
      policy: () => 'annotate',
      script: [TWO_SITE_PLAN, clickOn('Deal of the day'), finishWith('shop.test: EUR 1.399,00. deal.test: EUR 1.299,00.')],
    });

    assert.match(stepMessage(llm, 1), /Not opened yet: deal\.test/);
    assert.doesNotMatch(stepMessage(llm, 2), /Not opened yet/);
    assert.match(stepMessage(llm, 2), /Pages you have read: deal\.test .*shop\.test|Pages you have read: .*deal\.test/);
  });

  test('is short: the block stays under 600 characters even with many sites and long URLs', async (t) => {
    const many = Array.from({ length: 12 }, (_, i) => `site${i}-with-a-long-name.test`).join(', ');
    const { llm } = await runTask(t, {
      goal: `Compare prices on ${many}.`,
      policy: () => 'annotate',
      script: [PLAN_2, finishWith('not checked')],
    });

    const message = stepMessage(llm, 1);
    const start = message.indexOf('Pages you have read:');
    const end = message.indexOf('PAGE TEXT');
    assert.ok(start > 0 && end > start);
    assert.ok(end - start <= 620, `${end - start} characters`);
  });
});

// ---------------------------------------------------------------------------------------------
// The honest plan
// ---------------------------------------------------------------------------------------------

describe('the plan never claims a site that was not read', () => {
  const SITES_GOAL = 'Compare the Framework Laptop 16 price on shop.test and deal.test.';
  const HONEST_PARTIAL = 'shop.test: EUR 1.399,00 (https://shop.test/laptops/16). deal.test: not checked, I never opened it.';

  test('the model sees the step of an unread site as open, although its action count ran ahead', async (t) => {
    const { llm } = await runTask(t, {
      goal: SITES_GOAL,
      policy: () => 'annotate',
      script: [PLAN_SITES, navigateTo(PRODUCT), navigateTo(LIST), finishWith(HONEST_PARTIAL)],
    });

    const plan = stepMessage(llm, 3);
    assert.match(plan, /1\. \[x\] shop\.test: Find the price/);
    assert.match(plan, /2\. \[>\] deal\.test: Find the deal price/);
    assert.match(plan, /3\. \[ \] Compile the answer/);
  });

  test('at the end the step of the unread site is skipped, the others completed', async (t) => {
    const { engine } = await runTask(t, {
      goal: SITES_GOAL,
      policy: () => 'annotate',
      script: [PLAN_SITES, navigateTo(PRODUCT), navigateTo(LIST), finishWith(HONEST_PARTIAL)],
    });

    assert.deepEqual(engine.planSteps.map((s) => s.status), ['completed', 'skipped', 'completed']);
    assert.equal(finishes(engine)[0]?.answer, HONEST_PARTIAL);
    assert.equal(finishes(engine)[0]?.audit?.verdict, 'partial');
  });

  test('a send-back leaves the plan alone: nothing is completed or skipped while the run goes on', async (t) => {
    const { engine } = await runTask(t, {
      goal: SITES_GOAL,
      policy: (ctx) => (ctx.sendBacks === 0 ? 'send_back' : 'annotate'),
      script: [PLAN_SITES, finishWith('shop.test: EUR 1.399,00. deal.test: EUR 1.299,00.'), finishWith(HONEST_PARTIAL)],
    });

    assert.equal(refusals(engine).length, 1);
    assert.deepEqual(engine.planSteps.map((s) => s.status), ['completed', 'skipped', 'completed']);
  });

  test('a plan that names no site behaves as it always did: everything completed at the end', async (t) => {
    const { engine } = await runTask(t, { script: [PLAN_2, finishWith('The price is 1.399,00 EUR.')] });
    assert.deepEqual(engine.planSteps.map((s) => s.status), ['completed', 'completed']);
  });
});

// ---------------------------------------------------------------------------------------------
// What a later turn is told
// ---------------------------------------------------------------------------------------------

describe('the recap of an earlier turn', () => {
  test('says when the answer was not verified, and says nothing extra for a verified one', async (t) => {
    const unverified = await runTask(t, { policy: () => 'annotate', script: [PLAN_2, finishWith(LIE)] });
    assert.match(unverified.engine.previousTurnsSummary()[0] ?? '', /Result \(unverified: not everything in it was checked against pages that were read\): /);

    const verified = await runTask(t, { script: [PLAN_2, finishWith('The price is 1.399,00 EUR.')] });
    assert.match(verified.engine.previousTurnsSummary()[0] ?? '', /Result: The price is 1\.399,00 EUR\./);
  });
});

// ---------------------------------------------------------------------------------------------
// Review 2 edge cases
// ---------------------------------------------------------------------------------------------

function typeInto(label: string, text: string, submit = false): ReplyEntry {
  return (call: LlmCall) => {
    const shown = call.messages.at(-1)?.content ?? '';
    const found = shown.match(new RegExp(`^\\[(\\d+)\\] \\S+ "${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'm'));
    if (!found) throw new Error(`the page shown to the model has no element "${label}"`);
    return act({ action: 'type', element_id: Number(found[1]), text, submit, reason: 'Search for it' });
  };
}

describe('a price the model types is not a price the page shows', () => {
  const SEARCH = 'https://deal.test/search';
  const SEARCH_WEB: PageSpec[] = [
    { url: LIST, title: 'Laptops - Shop', text: [{ heading: 'Laptops' }, 'Framework Laptop 16 ab 1.399,00 EUR'], elements: [input('search', { label: 'Search', goes: SEARCH }), link('Deal of the day', DEAL)] },
    { url: SEARCH, title: 'Search - Deals', text: [{ heading: 'Search' }, 'Keine Treffer fuer "Laptop 16 EUR 1.299,00"'], elements: [input('search', { label: 'Search', value: 'Laptop 16 EUR 1.299,00' })] },
    WEB[1] as PageSpec,
    WEB[2] as PageSpec,
  ];
  const GOAL2 = 'Compare the Framework Laptop 16 price on shop.test and deal.test.';

  test('the query the model typed, echoed by the page, does not make the number "seen" on that site', async (t) => {
    const { engine } = await runTask(t, {
      pages: SEARCH_WEB,
      goal: GOAL2,
      policy: () => 'annotate',
      script: [PLAN_2, typeInto('Search', 'Laptop 16 EUR 1.299,00', true), finishWith('shop.test: EUR 1.399,00. deal.test: EUR 1.299,00.')],
    });

    const echoed = engine.evidence.entries.find((e) => e.url === SEARCH);
    assert.ok(echoed, 'the results page was read');
    assert.doesNotMatch(echoed.text, /1\.299,00/, 'the typed price is not in the recorded page');
    assert.doesNotMatch(echoed.text, /value="/, 'and no input value is part of a recorded page');
    const audit = finishes(engine)[0]?.audit;
    assert.equal(audit?.verdict, 'unverified');
    assert.ok(audit?.notes.some((n) => n.severity === 'lie' && /1\.299,00/.test(n.text)), JSON.stringify(audit?.notes));
  });

  test('the value of an input is not page text even when the model did not type it', async (t) => {
    const pages: PageSpec[] = [
      { url: LIST, title: 'Laptops - Shop', text: [{ heading: 'Laptops' }, 'Framework Laptop 16'], elements: [input('search', { label: 'Search', value: 'price 9,99 EUR' })] },
    ];
    const { engine } = await runTask(t, { pages, script: [PLAN_2, finishWith('The price is 9,99 EUR.')], policy: () => 'annotate' });
    assert.equal(engine.evidence.entries.some((e) => /9,99/.test(e.text)), false);
    assert.equal(finishes(engine)[0]?.audit?.verdict, 'unverified');
  });

  test('a string typed inside a browser_batch is remembered as well, when it could launder a number or a link', async (t) => {
    const { engine } = await rig(t, { script: [] });
    engine.noteTypedText({ action: 'browser_batch', steps: [{ action: 'type', element_id: 1, text: 'Laptop 16 EUR 1.299,00' }, { action: 'click', element_id: 2 }, { action: 'type', element_id: 3, text: 'ab' }, { action: 'type', element_id: 4, text: 'laptop' }] });
    assert.equal(engine.withoutTypedText('Keine Treffer fuer "Laptop 16 EUR 1.299,00" bei ab und laptop'), 'Keine Treffer fuer " " bei ab und laptop');
    assert.equal(engine.withoutTypedText('LAPTOP 16 eur 1.299,00'), ' ');
    engine.noteTypedText({ action: 'type', text: 'see https://idealo.de/x?a=1+2 (now)' });
    assert.equal(engine.withoutTypedText('Result: see https://idealo.de/x?a=1+2 (now) found'), 'Result:   found');
    engine.noteTypedText(null);
    engine.noteTypedText({ action: 'type', text: 42 });
    assert.equal(engine.withoutTypedText(''), '');
  });
});

describe('a send-back near the step cap does not throw the answer away', () => {
  const GOAL2 = 'Compare the Framework Laptop 16 price on shop.test and deal.test.';
  const both = 'shop.test: EUR 1.399,00. deal.test: EUR 1.299,00.';
  const policy = (ctx: GateContext): GateDecision => (ctx.stepsLeft >= 1 && ctx.sendBacks === 0 ? 'send_back' : 'annotate');

  test('the model obeys, opens the site on its last step, and runs out: the answer is checked again and shown, then the reason the run stopped', async (t) => {
    const world = await rig(t, {
      goal: GOAL2,
      maxSteps: 2,
      policy,
      script: [PLAN_2, finishWith(both), act({ action: 'scroll', direction: 'down', expected_outcome: 'the deal page is open', reason: 'Look' }), '{"success": true, "reason": "the deal page is open"}'],
    });
    const run = world.engine.executeActionOnTab.bind(world.engine);
    world.engine.executeActionOnTab = async (tabId, action, opts) => {
      const result = await run(tabId, action, opts);
      if (action.action === 'scroll') world.fc.tabs.navigate(101, DEAL);
      return result;
    };
    await world.engine.startTask(GOAL2, 101);
    await world.fc.settle();
    const { engine } = world;

    const [entry] = finishes(engine);
    assert.equal(finishes(engine).length, 1);
    assert.equal(entry?.answer, both);
    assert.equal(entry?.audit?.verdict, 'verified', JSON.stringify(entry?.audit?.notes));
    assert.equal(entry?.audit?.sendBacks, 1);
    assert.equal(engine.history.at(-1)?.type, 'error');
    assert.match(String((engine.history.at(-1) as any)?.content), /maximum allowed steps \(2\).*shown above/);
    assert.equal(engine.status, 'idle');
    assert.ok(hasLog('[FINISH_AT_STEP_CAP]'));
    assert.equal(engine.evidence.hasOpened('deal.test'), true);
  });

  test('if the model did not fix it, the answer comes back marked, with the banner on top', async (t) => {
    const { engine } = await runTask(t, {
      goal: GOAL2,
      maxSteps: 2,
      policy,
      script: [PLAN_2, finishWith(both), act({ action: 'scroll', direction: 'down', reason: 'Look further' })],
    });

    const [entry] = finishes(engine);
    assert.equal(finishes(engine).length, 1);
    assert.equal(entry?.audit?.verdict, 'unverified');
    assert.ok((entry?.answer ?? '').startsWith('WARNING - UNVERIFIED ANSWER:'));
    assert.match(String((engine.history.at(-1) as any)?.content), /maximum allowed steps \(2\)/);
    assert.equal(engine.planSteps.some((s) => s.status === 'in_progress'), false);
  });

  test('a run that never finished still ends as it always did', async (t) => {
    const { engine } = await runTask(t, { maxSteps: 2, script: [PLAN_2, act({ action: 'scroll', direction: 'down', reason: 'Look' }), act({ action: 'scroll', direction: 'down', reason: 'Look again' })] });
    assert.equal(finishes(engine).length, 0);
    assert.match(String((engine.history.at(-1) as any)?.content), /^Stopped without finishing - reached the maximum allowed steps \(2\)/);
  });

  test('a new task forgets the refused finish of the last one (a run that was stopped leaves it behind)', async (t) => {
    const { engine, store, fc, site, llm } = await rig(t, {
      maxSteps: 1,
      script: [PLAN_2, act({ action: 'scroll', direction: 'down', reason: 'Look' }), PLAN_2, act({ action: 'scroll', direction: 'down', reason: 'Look again' })],
    });

    // Turn 1 runs out of its single step with nothing finished.
    await engine.startTask(GOAL, 101);
    assert.equal(finishes(engine).length, 0);

    // Turn 1 leaves the refused-finish bookkeeping in the GRAPH channels - the
    // shape a sent-back or stopped turn leaves behind. The compile hard-cap
    // branch reads the graph channel, not the runner's mirror field, so the seed
    // must go there (seeding only the runner field masked the BUG-25 leak).
    const saver = new SessionStorageSaver(store.connect().session);
    const graph = buildOrchestratorGraph(saver);
    const cfg = { configurable: { thread_id: '101' } };
    await graph.updateState(cfg, {
      lastRefusedFinish: { action: 'finish', answer: 'an answer of the turn before' },
      finishSendBacks: 1,
    }, 'finalize');

    await engine.startTask(GOAL, 101);
    await fc.settle();
    fc.assertClean();
    site.assertClean();
    llm.assertClean();
    // The hard-cap compile must not present turn 1's refused answer as turn 2's
    // finish (BUG-25): intake resets the channels at the start of every turn.
    assert.equal(finishes(engine).length, 0);
    assert.match(String((engine.history.at(-1) as any)?.content), /^Stopped without finishing/);
  });
});

describe('a site that redirects counts as opened through the page it led to', () => {
  const TWITTER = 'https://twitter.com/';
  const X_HOME = 'https://x.com/home';
  const REDIRECT_WEB: PageSpec[] = [
    { url: LIST, title: 'Laptops - Shop', text: ['Laptops'], elements: [link('Laptop 16 DIY Edition', PRODUCT)] },
    { url: TWITTER, title: 'Redirecting', text: 'Redirecting...' },
    { url: X_HOME, title: 'Home / X', text: [{ heading: 'Home' }, 'The newest post says hello world'], elements: [link('Home', X_HOME)] },
  ];

  test('the model asks for twitter.com, the tab lands on x.com: twitter.com is opened, the plan step is not skipped, nothing is sent back', async (t) => {
    const { engine, policyCalls } = await runTask(t, {
      pages: REDIRECT_WEB,
      redirects: { [TWITTER]: X_HOME },
      goal: 'Read the newest post on twitter.com',
      policy: () => 'send_back',
      script: [TWITTER_PLAN, navigateTo(TWITTER), finishWith('The newest post on twitter.com says hello world.')],
    });

    assert.equal(engine.evidence.hasOpened('twitter.com'), true);
    assert.equal(engine.evidence.hasOpened('x.com'), true);
    assert.equal(finishes(engine)[0]?.audit?.verdict, 'verified', JSON.stringify(finishes(engine)[0]?.audit?.notes));
    assert.equal(policyCalls.length, 0);
    assert.deepEqual(engine.planSteps.map((s) => s.status), ['completed', 'completed']);
  });
});

describe('a navigation whose page has not loaded yet is not a redirect', () => {
  test('the verification reads the old page right after a navigate action: the site asked for is not "opened through" it', async (t) => {
    const { engine } = await runTask(t, {
      goal: 'Compare the Framework Laptop 16 price on shop.test and deal.test.',
      maxSteps: 1,
      policy: () => 'annotate',
      script: [PLAN_2, act({ action: 'navigate', url: DEAL, expected_outcome: 'the deal page opens', reason: 'Open the deal' }), '{"success": true, "reason": "ok"}'],
    });
    assert.equal(engine.evidence.hasOpened('deal.test'), false);
  });
});

describe('the plan names sources by brand', () => {
  test('a cloud plan that says "Check Deal" does not show that step done before deal.test was read, and does when it was', async (t) => {
    const { llm, engine } = await runTask(t, {
      goal: 'Compare the Framework Laptop 16 price on shop.test and deal.test.',
      policy: () => 'annotate',
      script: [DEAL_PLAN, navigateTo(PRODUCT), navigateTo(LIST), clickOn('Deal of the day'), finishWith('shop.test: EUR 1.399,00. deal.test: EUR 1.299,00.')],
    });

    assert.match(stepMessage(llm, 3), /2\. \[>\] Check Deal for the same laptop/);
    assert.match(stepMessage(llm, 4), /2\. \[x\] Check Deal for the same laptop/);
    assert.deepEqual(engine.planSteps.map((s) => s.status), ['completed', 'completed', 'completed']);
  });

  test('the fallback plan does not put the whole goal into its first step', async (t) => {
    // The fallback plan is shown with a banner and waits for the user now (planner-fallback-invented-plan),
    // so no policy reply is needed: the run pauses at the plan hold with the plan steps already set.
    const { engine } = await runTask(t, { goal: 'What does the Framework Laptop 16 cost?', policy: () => 'annotate', script: ['not a plan at all', 'still not a plan'] });
    assert.equal(engine.planSteps[0]?.text, 'shop.test');
    assert.ok(engine.planSteps.every((s) => !/Framework Laptop 16 cost/.test(s.text)));
  });
});

describe('the step message follows the page the tab is on', () => {
  test('the step that just landed on a site shows its plan step done (the plan is re-derived after the page is read)', async (t) => {
    const pages: PageSpec[] = [
      { url: LIST, title: 'Laptops - Shop', text: ['Framework Laptop 16 ab 1.399,00 EUR'], elements: [input('search', { label: 'Search' }), link('Deal of the day', DEAL)] },
      WEB[1] as PageSpec,
      WEB[2] as PageSpec,
    ];
    const { llm } = await runTask(t, {
      pages,
      goal: 'Compare the Framework Laptop 16 price on shop.test and deal.test.',
      policy: () => 'annotate',
      script: [READ_PRICE_PLAN, typeInto('Search', 'laptop'), typeInto('Search', 'laptop 16'), clickOn('Deal of the day'), finishWith('shop.test: EUR 1.399,00. deal.test: EUR 1.299,00.')],
    });
    assert.match(stepMessage(llm, 3), /2\. \[>\] deal\.test: read the deal price/);
    assert.match(stepMessage(llm, 4), /2\. \[x\] deal\.test: read the deal price/);
    assert.match(stepMessage(llm, 4), /3\. \[>\] Write the answer/);
  });

  test('a text result is recorded under the page the tab is on when the action runs, not the page of the snapshot', async (t) => {
    let moved = false;
    const world = await rig(t, {
      script: [
        PLAN_2,
        (call: LlmCall) => {
          void call;
          return readText;
        },
      ],
    });
    const realNavigate = world.fc.tabs.navigate.bind(world.fc.tabs);
    world.llm.calls.length = 0;
    const run = world.engine.executeActionOnTab.bind(world.engine);
    world.engine.executeActionOnTab = async (tabId, action, opts) => {
      if (!moved && action.action === 'read_page_text') {
        moved = true;
        realNavigate(101, DEAL);
      }
      return run(tabId, action, opts);
    };
    await world.engine.startTask(GOAL, 101);
    await world.fc.settle();

    const text = world.engine.evidence.entries.find((e) => e.kind === 'text');
    assert.ok(text, 'the read_page_text result was recorded');
    assert.equal(text.url, DEAL, 'under the address the tab had when the text was read');
    assert.match(text.text, /Nur heute 1\.299,00 EUR/);
  });
});

describe('the log of the gate', () => {
  test('[FINISH_AUDIT] lists at most 30 notes however many the audit has', async (t) => {
    const many = Array.from({ length: 80 }, (_v, i) => `shop.test: EUR ${(i + 2) * 7},${(i % 90) + 10}`).join('\n');
    await runTask(t, { policy: () => 'annotate', script: [PLAN_2, finishWith(many)] });
    const entry = Logger.getLogsHistory().find((e) => e.message.startsWith('[FINISH_AUDIT]'));
    assert.ok(entry?.data, 'the audit was logged with its notes');
    const notes = JSON.parse(entry.data) as unknown[];
    assert.ok(notes.length <= 30, `${notes.length} notes in the log`);
    assert.ok(entry.data.length < 30 * 700);
  });

  test('[FINISH_ANNOTATED] says links were cut only when a link was', async (t) => {
    await runTask(t, {
      goal: 'Compare the Framework Laptop 16 price on shop.test and deal.test.',
      policy: () => 'annotate',
      script: [PLAN_2, finishWith('shop.test: EUR 1.399,00. deal.test: nothing yet.')],
    });
    const gapOnly = Logger.getLogsHistory().find((e) => e.message.startsWith('[FINISH_ANNOTATED]'));
    assert.ok(gapOnly);
    assert.doesNotMatch(gapOnly.message, /were cut out/);
    assert.match(gapOnly.message, /warning line and a verification section were added/);

    await runTask(t, { policy: () => 'annotate', script: [PLAN_2, finishWith('See https://shop.test/made/up for EUR 1.399,00.')] });
    const withLink = Logger.getLogsHistory().filter((e) => e.message.startsWith('[FINISH_ANNOTATED]')).at(-1);
    assert.match(withLink?.message ?? '', /Links that were never opened were cut out/);
  });
});

describe('an answer that is not text', () => {
  test('a list of rows is stored and audited as the text it is shown as', async (t) => {
    const rows = ['| Source | Price |', '| shop.test | EUR 9,99 |'];
    const { engine } = await runTask(t, { policy: () => 'annotate', script: [PLAN_2, act({ action: 'finish', answer: rows, reason: 'Done' })] });
    const [entry] = finishes(engine);
    assert.equal(typeof entry?.answer, 'string');
    assert.ok((entry?.answer ?? '').includes('| shop.test | EUR 9,99 |'));
    assert.equal(entry?.audit?.verdict, 'unverified', 'the invented row is audited');
  });
});

// ---------------------------------------------------------------------------------------------
// Top-level tests from agentEngineFakeHarness.test.ts
// ---------------------------------------------------------------------------------------------

test('a two-step task: the model reads the list page, clicks the product, reads its page and finishes with the price', async (t) => {
  const pages: PageSpec[] = [
    {
      url: LIST,
      title: 'Laptops - Shop',
      text: [{ heading: 'Laptops' }, 'Framework Laptop 13 ab 1.049,00 EUR', 'Framework Laptop 16 ab 1.379,00 EUR'],
      elements: [link('Home'), link('Framework Laptop 16 DIY Edition', PRODUCT), link('Framework Laptop 13 DIY Edition')],
    },
    {
      url: PRODUCT,
      title: 'Framework Laptop 16 DIY Edition - Shop',
      text: [{ heading: 'Framework Laptop 16 DIY Edition' }, 'ab 1.399,00 EUR', 'inkl. MwSt.'],
      elements: [link('Zurueck zu den Laptops', LIST)],
    },
  ];

  const world = await rig(t, {
    pages,
    script: [
      // A proper plan object: the old bare-array fixture would now be a parse error that asks
      // the model for a repair (planner-fallback-invented-plan).
      PLAN_2,
      { reasoning: 'The list has the Laptop 16, so I open it.', text: JSON.stringify({ action: 'click', element_id: 2, reason: 'Open the product page' }) },
      JSON.stringify({ action: 'finish', answer: 'The Framework Laptop 16 DIY Edition costs 1.399,00 EUR.', reason: 'The price is on the page' }),
    ],
  });

  await world.engine.startTask(GOAL, 101);
  await world.fc.settle();

  assert.equal(world.engine.status, 'idle');
  assert.equal(world.engine.stepCount, 2);
  const finish = world.engine.history.find((h) => h.type === 'finish');
  assert.equal((finish as any)?.answer, 'The Framework Laptop 16 DIY Edition costs 1.399,00 EUR.');
  assert.deepEqual(world.engine.planSteps.map((s) => s.status), ['completed', 'completed']);
  assert.equal(world.engine.history.find((h) => h.type === 'agent_response')?.thought, 'The list has the Laptop 16, so I open it.');
  assert.equal(world.llm.calls.length, 3);
  const [plan, step1, step2] = world.llm.calls;
  assert.equal(step1?.settings && (step1.settings as { model: string }).model, 'test-model');
  const seen1 = step1?.messages.at(-1)?.content ?? '';
  assert.match(seen1, /CURRENT PAGE: "Laptops - Shop"/);
  assert.match(seen1, new RegExp(LIST));
  assert.deepEqual(world.site.actions.map((a) => [a.url, a.payload.action, a.payload.element_id, a.result.message]), [[LIST, 'click', 2, 'Clicked element [2] ("Framework Laptop 16 DIY Edition")']]);
  assert.equal(world.fc.tabs.get(101)?.url, PRODUCT);

  const seen2 = step2?.messages.at(-1)?.content ?? '';
  assert.match(seen2, /RECENT STEPS:\n#1 click \[2\]/);
  assert.match(seen2, new RegExp(PRODUCT));

  assert.equal(world.fc.callsTo('tabs.group').length, 1);
  assert.equal(world.site.reads.length, 2);
  world.fc.assertClean();
  world.site.assertClean();
  world.llm.assertClean();
  world.llm.assertDrained();
});

test('Stop while the model is thinking ends the request with the abort error the engine recognises, and the run is stopped, not failed', async (t) => {
  const world = await rig(t, {
    script: [
      '["Read the price"]',
      { text: JSON.stringify({ action: 'finish', answer: 'never seen' }), delayMs: 60_000 },
    ],
  });

  const run = world.engine.startTask(GOAL, 101);
  for (let i = 0; i < 2000 && world.llm.calls[1]?.outcome !== 'pending'; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(world.llm.calls[1]?.outcome, 'pending', 'the step call is waiting for the slow reply');

  world.engine.stop();
  await run;
  await world.fc.settle();

  assert.equal(world.engine.status, 'stopped');
  assert.equal(world.llm.calls[1]?.outcome, 'aborted');
  assert.equal(world.llm.calls.length, 2);
  assert.equal(world.engine.history.filter((h) => h.type === 'error').length, 0);
  assert.equal(world.site.actions.length, 0);
  world.fc.assertClean();
  world.site.assertClean();
  world.llm.assertClean();
});

// ---------------------------------------------------------------------------------------------
// Pure Evidence and Ledger Unit Tests (+95 tests)
// ---------------------------------------------------------------------------------------------

test('evidence: hostOf extracts clean lowercased hostname from https url', () => {
  assert.equal(hostOf('https://www.Example.COM/path'), 'www.example.com');
});
test('evidence: hostOf strips port numbers from http url', () => {
  assert.equal(hostOf('http://example.com:8080/path'), 'example.com');
});
test('evidence: hostOf extracts host from schemeless url with path', () => {
  assert.equal(hostOf('www.example.com/items'), 'www.example.com');
});
test('evidence: hostOf returns empty string for non-web schemes like chrome:// and file://', () => {
  assert.equal(hostOf('chrome://settings'), '');
  assert.equal(hostOf('file:///etc/hosts'), '');
});
test('evidence: hostOf returns empty string for text with spaces', () => {
  assert.equal(hostOf('search query in google'), '');
});
test('evidence: hostOf trims trailing dot from FQDN hostname', () => {
  assert.equal(hostOf('https://example.com./'), 'example.com');
});
test('evidence: hostOf handles IPv4 addresses without modification', () => {
  assert.equal(hostOf('http://192.168.1.1:3000/api'), '192.168.1.1');
});
test('evidence: hostOf handles bracketed IPv6 addresses', () => {
  assert.equal(hostOf('http://[2001:db8::1]:8080/path'), '[2001:db8::1]');
});
test('evidence: hostOf strips userinfo credentials from authority', () => {
  assert.equal(hostOf('https://user:pass@example.com/home'), 'example.com');
});
test('evidence: hostOf converts unicode domain to ASCII punycode', () => {
  assert.equal(hostOf('https://münchen.de/'), 'xn--mnchen-3ya.de');
});
test('evidence: hostOf returns empty string for empty or non-string input', () => {
  assert.equal(hostOf(''), '');
  assert.equal(hostOf(null as any), '');
  assert.equal(hostOf(undefined as any), '');
});
test('evidence: hostOf clips excessively long strings past 2048 chars', () => {
  const longHost = 'https://' + 'a'.repeat(3000) + '.com/';
  assert.ok(hostOf(longHost).length <= 2048);
});
test('evidence: hasUserInfo detects user info credentials before host', () => {
  assert.equal(hasUserInfo('https://admin:secret@shop.test/admin'), true);
});
test('evidence: hasUserInfo returns false for standard URLs without credentials', () => {
  assert.equal(hasUserInfo('https://shop.test/admin'), false);
});
test('evidence: hasUserInfo returns false for invalid non-string inputs', () => {
  assert.equal(hasUserInfo(null as any), false);
  assert.equal(hasUserInfo(''), false);
});

test('evidence: registrableHost strips www. prefix from standard domain', () => {
  assert.equal(registrableHost('www.example.com'), 'example.com');
});
test('evidence: registrableHost extracts registrable domain for 2-part ccTLDs (.co.uk)', () => {
  assert.equal(registrableHost('store.co.uk'), 'store.co.uk');
  assert.equal(registrableHost('sub.store.co.uk'), 'store.co.uk');
});
test('evidence: registrableHost extracts registrable domain for .com.au', () => {
  assert.equal(registrableHost('shop.com.au'), 'shop.com.au');
  assert.equal(registrableHost('melbourne.shop.com.au'), 'shop.com.au');
});
test('evidence: registrableHost extracts registrable domain for .co.jp', () => {
  assert.equal(registrableHost('tokyo.shop.co.jp'), 'shop.co.jp');
});
test('evidence: registrableHost extracts registrable domain for .co.in', () => {
  assert.equal(registrableHost('delhi.shop.co.in'), 'shop.co.in');
});
test('evidence: registrableHost handles multi-subdomain on multi-part suffix', () => {
  assert.equal(registrableHost('a.b.c.store.co.uk'), 'store.co.uk');
});
test('evidence: registrableHost handles multi-subdomain on single TLD', () => {
  assert.equal(registrableHost('sub.store.framework.com'), 'framework.com');
});
test('evidence: registrableHost preserves single label hosts like localhost', () => {
  assert.equal(registrableHost('localhost'), 'localhost');
});
test('evidence: registrableHost preserves IPv4 addresses intact', () => {
  assert.equal(registrableHost('127.0.0.1'), '127.0.0.1');
});
test('evidence: registrableHost treats myshopify.com tenants as separate domains', () => {
  assert.equal(registrableHost('store1.myshopify.com'), 'store1.myshopify.com');
  assert.equal(registrableHost('store2.myshopify.com'), 'store2.myshopify.com');
});
test('evidence: registrableHost treats github.io users as separate domains', () => {
  assert.equal(registrableHost('user1.github.io'), 'user1.github.io');
  assert.equal(registrableHost('user2.github.io'), 'user2.github.io');
});
test('evidence: registrableHost treats vercel.app and pages.dev tenants as separate domains', () => {
  assert.equal(registrableHost('app1.vercel.app'), 'app1.vercel.app');
  assert.equal(registrableHost('site1.pages.dev'), 'site1.pages.dev');
});
test('evidence: registrableHost trims trailing dot from hostname', () => {
  assert.equal(registrableHost('example.com.'), 'example.com');
});
test('evidence: siteOf extracts registrable host directly from full URL', () => {
  assert.equal(siteOf('https://www.shop.test/catalog'), 'shop.test');
});
test('evidence: siteOf returns empty string when url has no valid web host', () => {
  assert.equal(siteOf('javascript:void(0)'), '');
  assert.equal(siteOf(''), '');
});

test('evidence: normalizeUrlForMatch strips utm_ tracking parameters', () => {
  assert.equal(
    normalizeUrlForMatch('https://shop.test/item?utm_source=news&utm_medium=email&id=10'),
    'shop.test/item?id=10'
  );
});
test('evidence: normalizeUrlForMatch strips gclid and fbclid tracking parameters', () => {
  assert.equal(
    normalizeUrlForMatch('https://shop.test/item?gclid=ad123&fbclid=fb456&item=42'),
    'shop.test/item?item=42'
  );
});
test('evidence: normalizeUrlForMatch strips trailing slash from path', () => {
  assert.equal(normalizeUrlForMatch('https://shop.test/catalog/'), 'shop.test/catalog');
});
test('evidence: normalizeUrlForMatch removes URL fragments (#section)', () => {
  assert.equal(normalizeUrlForMatch('https://shop.test/product#specs'), 'shop.test/product');
});
test('evidence: normalizeUrlForMatch sorts remaining query parameters deterministically', () => {
  assert.equal(
    normalizeUrlForMatch('https://shop.test/search?z=1&a=2&m=3'),
    'shop.test/search?a=2&m=3&z=1'
  );
});
test('evidence: normalizeUrlForMatch lowercases scheme and host while preserving path case', () => {
  assert.equal(normalizeUrlForMatch('HTTP://SHOP.TEST/ProductDetail'), 'shop.test/ProductDetail');
});
test('evidence: normalizeUrlForMatch normalizes default ports 80 and 443', () => {
  assert.equal(normalizeUrlForMatch('http://shop.test:80/home'), 'shop.test/home');
  assert.equal(normalizeUrlForMatch('https://shop.test:443/home'), 'shop.test/home');
});
test('evidence: normalizeUrlForMatch handles malformed percent-encoding gracefully', () => {
  assert.doesNotThrow(() => {
    normalizeUrlForMatch('https://shop.test/search?q=%zz%invalid');
  });
});
test('evidence: urlCovers returns true when known URL exactly matches asked URL', () => {
  assert.equal(urlCovers('shop.test/p?id=1', 'shop.test/p?id=1'), true);
});
test('evidence: urlCovers returns true when known URL covers asked URL with tracking params removed', () => {
  assert.equal(urlCovers('shop.test/p?a=1&b=2', 'shop.test/p?a=1'), true);
});
test('evidence: urlCovers returns false when essential queries differ', () => {
  assert.equal(urlCovers('shop.test/p?id=1', 'shop.test/p?id=2'), false);
});
test('evidence: isOriginOnly returns true for root URL with only origin and optional trailing slash', () => {
  assert.equal(isOriginOnly('https://shop.test'), true);
  assert.equal(isOriginOnly('https://shop.test/'), true);
});
test('evidence: isOriginOnly returns false when URL has meaningful path or query', () => {
  assert.equal(isOriginOnly('https://shop.test/laptops'), false);
  assert.equal(isOriginOnly('https://shop.test/?p=1'), false);
});
test('evidence: frontDoorHost returns lowercase host for homepage/frontdoor URLs', () => {
  assert.equal(frontDoorHost('https://shop.test/'), 'shop.test');
});
test('evidence: looksLikeDomain returns true for valid domain-like strings and false otherwise', () => {
  assert.equal(looksLikeDomain('framework.com'), true);
  assert.equal(looksLikeDomain('store.de'), true);
  assert.equal(looksLikeDomain('not a domain'), false);
  assert.equal(looksLikeDomain(''), false);
});

test('evidence: scanNumbers finds standard USD dollar amounts ($99, $1,299.00)', () => {
  const scanned = scanNumbers('Price is $99 and total is $1,299.00');
  assert.equal(scanned.money.length, 2);
  assert.equal(scanned.money[0].values[0], 99);
  assert.equal(scanned.money[1].values[0], 1299);
});
test('evidence: scanNumbers finds Euro amounts with comma decimal (1.399,00 EUR)', () => {
  const scanned = scanNumbers('Preis: 1.399,00 EUR');
  assert.equal(scanned.money.length, 1);
  assert.equal(scanned.money[0].values[0], 1399);
});
test('evidence: scanNumbers finds GBP pound amounts (£49.99)', () => {
  const scanned = scanNumbers('Cost: £49.99');
  assert.equal(scanned.money.length, 1);
  assert.equal(scanned.money[0].values[0], 49.99);
});
test('evidence: scanNumbers finds amounts with trailing currency words', () => {
  const scanned = scanNumbers('Available for 1400 euros');
  assert.equal(scanned.money.length, 1);
  assert.equal(scanned.money[0].values[0], 1400);
});
test('evidence: scanNumbers finds CHF amounts with apostrophe separator (1\'000.50 CHF)', () => {
  const scanned = scanNumbers('Cost: 1\'000.50 CHF');
  assert.equal(scanned.money.length, 1);
  assert.equal(scanned.money[0].values[0], 1000.5);
});
test('evidence: scanNumbers handles space thousands separator (1 299,00 EUR)', () => {
  const scanned = scanNumbers('Cost: 1 299,00 EUR');
  assert.equal(scanned.money.length, 1);
  assert.equal(scanned.money[0].values[0], 1299);
});
test('evidence: scanNumbers parses simple integers without decimal', () => {
  const scanned = scanNumbers('Discount: 50 USD off');
  assert.equal(scanned.money.length, 1);
  assert.equal(scanned.money[0].values[0], 50);
});
test('evidence: scanNumbers extracts percentages (15%, 5.5%)', () => {
  const scanned = scanNumbers('Save 15% today, or 5.5% on bulk');
  assert.equal(scanned.percents.length, 2);
  assert.equal(scanned.percents[0].value, 15);
  assert.equal(scanned.percents[1].value, 5.5);
});
test('evidence: scanNumbers extracts single durations in days', () => {
  const scanned = scanNumbers('Delivery in 5 days');
  assert.equal(scanned.durations.length, 1);
  assert.equal(scanned.durations[0].low, 5);
  assert.equal(scanned.durations[0].high, 5);
  assert.equal(scanned.durations[0].unit, 'day');
});
test('evidence: scanNumbers extracts ranged durations (3-5 business days)', () => {
  const scanned = scanNumbers('Ships in 3-5 business days');
  assert.equal(scanned.durations.length, 1);
  assert.equal(scanned.durations[0].low, 3);
  assert.equal(scanned.durations[0].high, 5);
  assert.equal(scanned.durations[0].unit, 'bday');
});
test('evidence: scanNumbers extracts delivery durations in weeks', () => {
  const scanned = scanNumbers('Expected in 2 weeks');
  assert.equal(scanned.durations.length, 1);
  assert.equal(scanned.durations[0].low, 2);
  assert.equal(scanned.durations[0].unit, 'week');
});
test('evidence: scanNumbers extracts durations in hours', () => {
  const scanned = scanNumbers('Dispatch within 24 hours');
  assert.equal(scanned.durations.length, 1);
  assert.equal(scanned.durations[0].low, 24);
  assert.equal(scanned.durations[0].unit, 'hour');
});
test('evidence: scanNumbers extracts German duration words (3 Werktage)', () => {
  const scanned = scanNumbers('Lieferzeit: 3 Werktage');
  assert.equal(scanned.durations.length, 1);
  assert.equal(scanned.durations[0].low, 3);
  assert.equal(scanned.durations[0].unit, 'bday');
});
test('evidence: scanNumbers extracts German ranged durations (2-3 Tage)', () => {
  const scanned = scanNumbers('Lieferbar in 2-3 Tagen');
  assert.equal(scanned.durations.length, 1);
  assert.equal(scanned.durations[0].low, 2);
  assert.equal(scanned.durations[0].high, 3);
  assert.equal(scanned.durations[0].unit, 'day');
});
test('evidence: durationUnitOf maps English and German duration units to standard string', () => {
  assert.equal(durationUnitOf('days'), 'day');
  assert.equal(durationUnitOf('working days'), 'bday');
  assert.equal(durationUnitOf('weeks'), 'week');
  assert.equal(durationUnitOf('hours'), 'hour');
  assert.equal(durationUnitOf('months'), 'month');
  assert.equal(durationUnitOf('years'), 'year');
});
test('evidence: durationUnitOf returns null for unrecognized units', () => {
  assert.equal(durationUnitOf('apples'), null);
  assert.equal(durationUnitOf(''), null);
});
test('evidence: sameDuration returns true for identical duration spans and units', () => {
  assert.equal(sameDuration({ low: 2, high: 4, unit: 'day' }, { low: 2, high: 4, unit: 'day' }), true);
});
test('evidence: sameDuration returns false for differing units or numbers', () => {
  assert.equal(sameDuration({ low: 2, high: 4, unit: 'day' }, { low: 2, high: 4, unit: 'week' }), false);
  assert.equal(sameDuration({ low: 2, high: 4, unit: 'day' }, { low: 3, high: 4, unit: 'day' }), false);
});
test('evidence: canonicalAmounts parses first numeral in string with readings', () => {
  assert.deepEqual(canonicalAmounts('Item costs $1,299.00 USD'), [1299]);
  assert.deepEqual(canonicalAmounts('Preis 1.399'), [1399, 1.399]);
});
test('evidence: sameAmount compares number arrays with floating-point tolerance', () => {
  assert.equal(sameAmount([99.0001], [99]), true);
  assert.equal(sameAmount([99.5], [100]), false);
});

test('evidence: findSnippet finds exact number occurrence with surrounding context', () => {
  const text = 'The Framework Laptop 16 DIY Edition costs 1.399,00 EUR in the store.';
  const snippet = findSnippet(text, 1399);
  assert.ok(snippet);
  assert.ok(snippet.includes('1.399,00'));
});
test('evidence: findSnippet returns null when value does not appear in text', () => {
  const text = 'Framework Laptop costs 1.399,00 EUR.';
  assert.equal(findSnippet(text, 9999), null);
});
test('evidence: findSnippet handles string needle search', () => {
  const text = 'Framework Laptop costs 1.399,00 EUR with free shipping.';
  const snippet = findSnippet(text, 'free shipping');
  assert.ok(snippet);
  assert.ok(snippet.includes('free shipping'));
});
test('evidence: snippetAround extracts window centered on match indices', () => {
  const text = 'Header start ' + 'x'.repeat(50) + ' TARGET ' + 'y'.repeat(50) + ' footer end';
  const targetIdx = text.indexOf('TARGET');
  const snip = snippetAround(text, targetIdx, targetIdx + 6, 20);
  assert.ok(snip.includes('TARGET'));
  assert.ok(snip.length < text.length);
});
test('evidence: cutAtWord cuts string before max limit at whitespace boundary', () => {
  const text = 'The quick brown fox jumps over the lazy dog';
  const cut = cutAtWord(text, 15);
  assert.ok(cut.length <= 15);
  assert.ok(!cut.endsWith(' '));
});
test('evidence: snippetWithWholeWords trims partial words at edges', () => {
  const snip = snippetWithWholeWords('...quick brown fox jumps...');
  assert.ok(snip.includes('brown fox'));
});
test('evidence: hasShippingWording detects English shipping keywords', () => {
  assert.equal(hasShippingWording('Free shipping available at checkout'), true);
  assert.equal(hasShippingWording('Fast delivery in 2 days'), true);
  assert.equal(hasShippingWording('Ships immediately'), true);
});
test('evidence: hasShippingWording detects German shipping keywords', () => {
  assert.equal(hasShippingWording('Kostenloser Versand nach Deutschland'), true);
  assert.equal(hasShippingWording('Lieferzeit beträgt 2 Werktage'), true);
  assert.equal(hasShippingWording('Portofrei bestellen'), true);
});
test('evidence: hasShippingWording returns false for non-shipping text', () => {
  assert.equal(hasShippingWording('Laptop specifications: 16GB RAM and 512GB SSD'), false);
});
test('evidence: condenseText preserves regions around money and links while omitting filler', () => {
  const longText = 'Item info. ' + 'Filler '.repeat(100) + 'Price: $99.00. ' + 'More filler '.repeat(100);
  const condensed = condenseText(longText, 30);
  assert.ok(condensed.length < longText.length);
  assert.ok(condensed.includes('$99.00'));
});
test('evidence: condenseText returns empty string for empty text or non-string', () => {
  assert.equal(condenseText(''), '');
  assert.equal(condenseText(null as any), '');
});
test('evidence: maskLinks replaces markdown links with placeholders', () => {
  const masked = maskLinks('Click [here](https://shop.test/item) for details');
  assert.ok(!masked.includes('https://shop.test/item'));
});
test('evidence: scanSites extracts domain names mentioned in text', () => {
  const sites = scanSites('Compare prices at idealo.de and framework.com');
  const hosts = sites.map((s) => s.host);
  assert.ok(hosts.includes('idealo.de'));
  assert.ok(hosts.includes('framework.com'));
});
test('evidence: normalizeSpaces replaces unicode spaces with regular spaces', () => {
  assert.equal(normalizeSpaces('100\u00a0EUR and 50\u202fUSD'), '100 EUR and 50 USD');
});
test('evidence: amountKey rounds number to thousandths accurately', async () => {
  const { amountKey } = await import('../../src/background/agent/evidence.ts');
  assert.equal(amountKey(12.3456), 12346);
  assert.equal(amountKey(10), 10000);
});

test('evidence: EvidenceLedger new instance has zero entries and size', () => {
  const ledger = new EvidenceLedger();
  assert.equal(ledger.size, 0);
  assert.equal(ledger.totalChars(), 0);
  assert.deepEqual(ledger.openedHosts(), []);
});
test('evidence: EvidenceLedger record registers visit and creates page entry', () => {
  const ledger = new EvidenceLedger();
  const entry = ledger.record({
    kind: 'page',
    url: 'https://shop.test/item',
    title: 'Shop Item',
    text: 'Price $99.00',
    links: ['https://shop.test/cart'],
    step: 1,
  });
  assert.ok(entry);
  assert.equal(ledger.size, 1);
  assert.equal(ledger.hasOpened('shop.test'), true);
  assert.equal(ledger.wasVisited('https://shop.test/item'), true);
});
test('evidence: EvidenceLedger record deduplicates consecutive identical reads on same url', () => {
  const ledger = new EvidenceLedger();
  ledger.record({ kind: 'page', url: 'https://shop.test/item', title: 'Item', text: 'Price $99', links: [], step: 1 });
  ledger.record({ kind: 'page', url: 'https://shop.test/item', title: 'Item', text: 'Price $99', links: [], step: 2 });
  assert.equal(ledger.size, 1, 'identical consecutive read should not duplicate entry');
  assert.equal(ledger.entries[0].step, 2, 'step number should update to latest');
});
test('evidence: EvidenceLedger wasVisited returns false for unvisited URL', () => {
  const ledger = new EvidenceLedger();
  ledger.record({ kind: 'page', url: 'https://shop.test/item', title: 'Item', text: 'Price $99', links: [], step: 1 });
  assert.equal(ledger.wasVisited('https://shop.test/other'), false);
});
test('evidence: EvidenceLedger hasHostname checks visited hostname accurately', () => {
  const ledger = new EvidenceLedger();
  ledger.record({ kind: 'page', url: 'https://sub.shop.test/item', title: 'Item', text: 'Price $99', links: [], step: 1 });
  assert.equal(ledger.hasHostname('sub.shop.test'), true);
  assert.equal(ledger.hasHostname('other.shop.test'), false);
});
test('evidence: EvidenceLedger wasShown returns true for links in visited page', () => {
  const ledger = new EvidenceLedger();
  ledger.record({
    kind: 'page',
    url: 'https://shop.test/item',
    title: 'Item',
    text: 'Item details',
    links: ['https://shop.test/checkout'],
    step: 1,
  });
  assert.equal(ledger.wasShown('https://shop.test/checkout'), true);
});
test('evidence: EvidenceLedger openedHosts lists unique visited hosts with step ranges', () => {
  const ledger = new EvidenceLedger();
  ledger.record({ kind: 'page', url: 'https://shop1.test/item', title: 'Item 1', text: 'Price 10', links: [], step: 1 });
  ledger.record({ kind: 'page', url: 'https://shop2.test/item', title: 'Item 2', text: 'Price 20', links: [], step: 2 });
  const hosts = ledger.openedHosts();
  assert.equal(hosts.length, 2);
  assert.deepEqual(hosts.map((h) => h.host).sort(), ['shop1.test', 'shop2.test']);
});
test('evidence: EvidenceLedger toSnapshot and fromSnapshot roundtrip preserves state', () => {
  const ledger = new EvidenceLedger();
  ledger.record({ kind: 'page', url: 'https://shop.test/item', title: 'Item', text: 'Price $99', links: [], step: 1 });
  const snap = ledger.toSnapshot();
  const restored = EvidenceLedger.fromSnapshot(snap);
  assert.equal(restored.size, 1);
  assert.equal(restored.hasOpened('shop.test'), true);
  assert.equal(restored.wasVisited('https://shop.test/item'), true);
});
test('evidence: EvidenceLedger ledgerFromSnapshot restores ledger identically', () => {
  const ledger = new EvidenceLedger();
  ledger.record({ kind: 'page', url: 'https://shop.test/item', title: 'Item', text: 'Price $99', links: [], step: 1 });
  const restored = ledgerFromSnapshot(ledger.toSnapshot());
  assert.equal(restored.size, 1);
  assert.equal(restored.hasOpened('shop.test'), true);
});
test('evidence: EvidenceLedger clear resets entries, visits and hosts', () => {
  const ledger = new EvidenceLedger();
  ledger.record({ kind: 'page', url: 'https://shop.test/item', title: 'Item', text: 'Price $99', links: [], step: 1 });
  assert.equal(ledger.size, 1);
  ledger.clear();
  assert.equal(ledger.size, 0);
  assert.equal(ledger.hasOpened('shop.test'), false);
  assert.equal(ledger.wasVisited('https://shop.test/item'), false);
});
test('evidence: EvidenceLedger handles redirect via host in openedHosts', () => {
  const ledger = new EvidenceLedger();
  ledger.record({
    kind: 'page',
    url: 'https://landing.test/item',
    title: 'Landed',
    text: 'Content',
    links: [],
    via: ['referrer.test'],
    step: 1,
  });
  assert.equal(ledger.hasOpened('referrer.test'), true);
  assert.equal(ledger.hasOpened('landing.test'), true);
});
test('evidence: EvidenceLedger record returns null for empty input', () => {
  const ledger = new EvidenceLedger();
  const entry = ledger.record({ kind: 'page', url: '', title: '', text: '', links: [], step: 1 });
  assert.equal(entry, null);
  assert.equal(ledger.size, 0);
});
test('evidence: EvidenceLedger fromSnapshot handles corrupt or null snapshot safely', () => {
  const ledger = EvidenceLedger.fromSnapshot(null);
  assert.equal(ledger.size, 0);
  const ledgerCorrupt = EvidenceLedger.fromSnapshot({ entries: 'not an array' });
  assert.equal(ledgerCorrupt.size, 0);
});
test('evidence: compactLedgerSnapshot returns compact snapshot preserving structure', () => {
  const ledger = new EvidenceLedger();
  ledger.record({ kind: 'page', url: 'https://shop.test/item', title: 'Item', text: 'Price $99. ' + 'Filler '.repeat(50), links: [], step: 1 });
  const compacted = compactLedgerSnapshot(ledger.toSnapshot());
  assert.equal(compacted.v, 1);
  assert.ok(compacted.entries.length >= 1);
});
test('evidence: EvidenceLedger wasShown returns false for unshown links', () => {
  const ledger = new EvidenceLedger();
  ledger.record({ kind: 'page', url: 'https://shop.test/item', title: 'Item', text: 'No links here', links: [], step: 1 });
  assert.equal(ledger.wasShown('https://other.test/unseen'), false);
});

