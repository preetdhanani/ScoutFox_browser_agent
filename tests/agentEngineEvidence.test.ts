/**
 * The evidence ledger and the finish gate inside the real engine: what they record, keep, store and
 * clamp. The incident itself is replayed in tests/agentEngineFinishGate.test.ts; the pure rules are in
 * tests/agent/planEvidence.test.ts. This file covers what only the engine can show:
 *
 *   - what goes into the ledger (a snapshot, and the text results of read_page_text, execute_js and
 *     read_network_requests, under the URL the tab was on) and what never does (the model's own words,
 *     a literal handed back by execute_js);
 *   - that the ledger is kept for the session, stored compactly with it, restored from an older session
 *     that has none, and cleared by New Session;
 *   - the clamps around the finish policy (4 send-backs, no step left, a policy that throws or answers
 *     nonsense, a plain-text reply) and that a refused finish reaches the model as itself;
 *   - the log tags Prit reads, and the step message block;
 *   - the honest plan the model is shown, and the recap a later turn gets.
 *
 * The rig is the one of the gate test: the real AgentEngine on fakeChrome, fakeDom and a scripted model.
 */

import test, { describe } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { fakeChrome } from './helpers/fakeChrome.ts';
import { createFakeStorage } from './helpers/fakeStorageSession.ts';
import type { FakeStorage } from './helpers/fakeStorageSession.ts';
import { fakeDom, input, link } from './helpers/fakeDom.ts';
import type { PageSpec } from './helpers/fakeDom.ts';
import { fakeLlm } from './helpers/fakeLlm.ts';
import type { LlmCall, ReplyEntry } from './helpers/fakeLlm.ts';
import { Logger } from '../src/shared/logger.ts';
import type { GateContext, GateDecision } from '../src/background/agent/finishPolicy.ts';

interface Audit {
  verdict: 'verified' | 'partial' | 'unverified';
  opened: Array<{ host: string; url: string }>;
  notOpened: string[];
  notes: Array<{ code: string; severity: 'lie' | 'gap' | 'soft'; text: string }>;
  sendBacks: number;
}
interface Entry {
  kind: 'page' | 'text' | 'js' | 'network';
  url: string;
  host: string;
  text: string;
}
/** The members of the old JavaScript engine that this file uses. */
interface LegacyEngine {
  status: string;
  stepCount: number;
  history: Array<Record<string, any>>;
  planSteps: Array<{ text: string; status: string }>;
  currentTask: string | null;
  finishPolicy: (ctx: GateContext) => GateDecision;
  evidence: {
    size: number;
    entries: Entry[];
    hasOpened(host: string): boolean;
    record(input: { step: number; kind: string; url: string; title?: string; text: string }): unknown;
  };
  restorePromise: Promise<void>;
  startTask(prompt: string, tabId: number): Promise<void>;
  clearHistory(): void;
  persistState(): Promise<void>;
  previousTurnsSummary(): string[];
  recordNetworkRequest(tabId: number, req: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------------------------
// The fake web and the rig
// ---------------------------------------------------------------------------------------------

// The old engine is plain JavaScript with no declarations. A variable specifier keeps tsc from looking for them.
const ENGINE_MODULE = '../background/agentEngine.js';
const CLIENTS_MODULE = '../background/apiClients.js';

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
const PLAN_2 = '["Open the Framework Laptop 16 page", "Read the price there"]';
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

/** Storage with the extension's settings in it. A test that restores a session passes its own store to rig(), built with the same call. */
function newStore(maxSteps = 12, session: Record<string, unknown> = {}): FakeStorage {
  return createFakeStorage({
    local: { data: { agent_settings: { provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'test-model', maxSteps, actionDelayMs: 1 } } },
    session: { data: session },
  });
}

interface RunOptions {
  goal?: string;
  script: ReplyEntry[];
  start?: string;
  maxSteps?: number;
  /** The decision of the finish policy. When given, the engine's own policy is replaced. */
  policy?: (ctx: GateContext) => GateDecision;
  /** The results of chrome.scripting.executeScript (for execute_js). */
  scripting?: unknown[];
  /** Shared storage, so a second engine can restore what the first stored. */
  store?: FakeStorage;
  /** Called before the task starts, with the engine. */
  prepare?: (engine: LegacyEngine) => void;
  /** Ids of tabs that do not exist yet but will, each answered by the same fake site (a window the model opens). */
  laterTabs?: number[];
  /** The fake web, when a test needs pages of its own. */
  pages?: PageSpec[];
  /** Where a navigation really ends up (a redirect): typed URL to landing URL. */
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
  const { ApiClients } = await import(CLIENTS_MODULE);
  const restoreLlm = llm.install(ApiClients);
  const { AgentEngine } = (await import(ENGINE_MODULE)) as { AgentEngine: new () => LegacyEngine };
  const engine = new AgentEngine();
  await engine.restorePromise;
  t.after(() => {
    restoreLlm();
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
  return { site, fc, llm, engine, store, policyCalls, AgentEngine };
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

/** The message the model was given at call `i` of the script (call 0 is the planner). */
const stepMessage = (llm: { calls: LlmCall[] }, i: number): string => llm.calls[i]?.messages.at(-1)?.content ?? '';

const finishes = (engine: LegacyEngine): Array<{ answer: string; audit?: Audit; unconfirmed?: true }> => engine.history.filter((h) => h.type === 'finish') as never;
const refusals = (engine: LegacyEngine): Array<Record<string, any>> => engine.history.filter((h) => h.type === 'execution_result' && h.finishRefused);
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

  test('the model\'s own words are not evidence: a price that is only in its reason is still flagged', async (t) => {
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

    // The second turn starts on the same tab. Its own reads add to the ledger; nothing is reset by startTask.
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

    const stored = (store.snapshot().session.agent_sessions as Record<string, any>).default;
    assert.equal(stored.evidence.v, 1);
    assert.ok(stored.evidence.entries.length >= 2);
    assert.ok(stored.evidence.entries.every((e: Record<string, unknown>) => ['step', 'kind', 'url', 'title', 'text', 'links'].every((k) => k in e)));

    // A new engine on the same storage: what the old one read is still "opened".
    const again = new world.AgentEngine();
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

    const stored = (store.snapshot().session.agent_sessions as Record<string, any>).default;
    const bytes = JSON.stringify(stored.evidence).length;
    assert.ok(bytes < 80_000, `${bytes} bytes of ledger are stored`);
    // The newest page of each of the seven sites is in it.
    const hosts = new Set(stored.evidence.entries.map((e: { url: string }) => new URL(e.url).hostname));
    for (let i = 0; i < 7; i++) assert.ok(hosts.has(`site${i}.test`), `site${i}.test`);
  });

  test('a session stored before the audit existed has no ledger: it restores as an empty one', async (t) => {
    const store = newStore(12, {
      agent_sessions: {
        default: { history: [{ type: 'user_goal', turn: 1, prompt: 'old task' }], planSteps: [], task: 'old task', stepCount: 3, status: 'idle', currentPlanIndex: 0, activeTabId: 101, stateVersion: 4, scoutFoxGroupId: null },
      },
    });
    const world = await rig(t, { store, script: [] });

    assert.equal(world.engine.currentTask, 'old task', 'the session itself was restored');
    assert.equal(world.engine.evidence.size, 0);
    assert.equal(world.engine.evidence.hasOpened('shop.test'), false);
  });

  test('a session that read nothing is stored without a ledger key, as it always was', async (t) => {
    const store = newStore();
    const world = await rig(t, { store, script: [] });
    await world.engine.persistState();
    await world.fc.settle();
    const stored = (store.snapshot().session.agent_sessions as Record<string, any> | undefined)?.default;
    assert.ok(stored, 'persisted');
    assert.equal('evidence' in stored, false);
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
      script: ['["shop.test: Find the price", "deal.test: Find the deal price"]', honest, honest],
    });

    assert.equal(policyCalls.length, 2, 'asked about both finishes');
    assert.equal(refusals(engine).length, 1, 'the lazy first one was refused: the model is told once to go and open it');
    const [entry] = finishes(engine);
    assert.equal(finishes(engine).length, 1);
    assert.equal(entry?.audit?.verdict, 'partial');
    assert.equal(entry?.audit?.sendBacks, 1);
    assert.equal(entry?.answer, 'shop.test: EUR 1.399,00. deal.test: not checked, I never opened it.', 'and the honest answer is left as it is');
    // Nothing went wrong here: the answer is accepted as it is. That is an INFO line of its own, not a clamp with a warning, and it
    // does not say "annotate" (no banner was added and no word of the answer changed).
    const accepted = Logger.getLogsHistory().filter((e) => e.message.startsWith('[FINISH_ACCEPTED_PARTIAL]'));
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0]?.level, 'INFO');
    assert.equal(accepted[0]?.message, '[FINISH_ACCEPTED_PARTIAL] The answer already says which sites were not checked (after 1 send-back), so it is accepted as it is with verdict partial.');
    assert.ok(!hasLog('[FINISH_POLICY_CLAMPED]'), 'it is not reported as a clamp');
    assert.deepEqual(Logger.getLogsHistory().filter((e) => e.level !== 'INFO' && e.message.startsWith('[FINISH')).map((e) => e.message), [], 'no warning of the gate');
    llm.assertDrained();
  });

  test('every real clamp is a WARN with the old tag: no step left, the hard cap, a policy that throws, nonsense, a plain-text reply', async (t) => {
    const clampsOf = (): Array<{ level: string; message: string }> => Logger.getLogsHistory().filter((e) => e.message.startsWith('[FINISH_POLICY_CLAMPED]'));
    const expectWarn = (why: RegExp): void => {
      const clamps = clampsOf();
      assert.equal(clamps.length >= 1, true, 'a clamp was logged');
      for (const c of clamps) assert.equal(c.level, 'WARN');
      assert.ok(clamps.some((c) => why.test(c.message)), JSON.stringify(clamps));
      assert.ok(!hasLog('[FINISH_ACCEPTED_PARTIAL]'), 'a real clamp is never reported as an answer that was accepted');
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
      script: ['["shop.test: Find the price", "deal.test: Find the deal price"]', honest, honest],
    });
    const clamp = Logger.getLogsHistory().find((e) => e.message.startsWith('[FINISH_POLICY_CLAMPED]'));
    assert.equal(clamp?.level, 'WARN');
    assert.match(clamp?.message ?? '', /(?:the run is out of steps|no step is left to try again)/);
  });

  test('the engine\'s own policy does not refuse the same honest answer a third time', async (t) => {
    const honest = finishWith('shop.test: EUR 1.399,00. deal.test: not checked, I never opened it.');
    const { engine, llm } = await runTask(t, {
      goal: 'Compare the Framework Laptop 16 price on shop.test and deal.test.',
      script: ['["shop.test: Find the price", "deal.test: Find the deal price"]', honest, honest],
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
      // The engine must survive a policy that breaks the contract, which the types would not let a policy write.
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
    assert.equal(entry?.unconfirmed, true, 'still flagged as a reply the model never declared');
    assert.equal(entry?.audit?.verdict, 'unverified');
    assert.ok(!hasLog('[TASK_FINISHED] '), 'not reported as completed');
  });

  test('a refused finish reaches the model as itself, not as a failed click', async (t) => {
    const { llm } = await runTask(t, {
      policy: (ctx) => (ctx.sendBacks === 0 ? 'send_back' : 'annotate'),
      script: [PLAN_2, finishWith(LIE), finishWith(LIE)],
    });

    const retry = llm.calls[2];
    const told = retry?.messages.map((m) => m.content).join('\n') ?? '';
    assert.match(told, /Your finish was refused/);
    assert.match(told, /9,99 EUR/, 'it names the number that no page showed');
    assert.doesNotMatch(told, /Choose a different element or action/);
    const refusal = retry?.messages.find((m) => m.role === 'user' && m.content.startsWith('Your finish was refused'));
    assert.ok(refusal, 'as a message of its own');
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
    assert.ok(logLines().includes(COMPLETED), 'the second answer was true, so it is a real completion');
  });

  test('partial: TASK_FINISHED_PARTIAL, never the completion line', async (t) => {
    await runTask(t, {
      goal: 'Compare the Framework Laptop 16 price on shop.test and deal.test.',
      policy: () => 'annotate',
      script: ['["shop.test: Find the price", "deal.test: Find the deal price"]', finishWith('shop.test: EUR 1.399,00. deal.test: not checked, I never opened it.')],
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
    // The list page says nothing about shipping: the claim is unsupported, which is a soft note and never blocks.
    const answer = 'The Framework Laptop 16 is 1.399,00 EUR on the list page, with free shipping.';
    const { engine, policyCalls } = await runTask(t, { policy: () => 'send_back', script: [PLAN_2, finishWith(answer)] });

    const [entry] = finishes(engine);
    assert.equal(entry?.answer, answer);
    assert.equal(entry?.audit?.verdict, 'verified');
    assert.ok(entry?.audit?.notes.some((n) => n.severity === 'soft' && n.code === 'unsupported_detail'), JSON.stringify(entry?.audit?.notes));
    assert.equal(policyCalls.length, 0);
    assert.ok(logLines().includes('[TASK_FINISHED] Task completed successfully.'));
  });

  test('a finish with no answer is audited as what it is and is not sent back for that', async (t) => {
    const { engine } = await runTask(t, { script: [PLAN_2, act({ action: 'finish', reason: 'done' })] });

    const [entry] = finishes(engine);
    assert.match(entry?.answer ?? '', /did not provide an answer/);
    assert.equal(entry?.audit?.verdict, 'verified', 'it claims nothing');
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
    assert.doesNotMatch(second, /Not opened yet/, 'no site is named in this task');
    const order = ['Plan (step', 'Pages you have read:', 'Webpage Visible Text Content'].map((s) => second.indexOf(s));
    assert.ok(order.every((i) => i >= 0) && order[0]! < order[1]! && order[1]! < order[2]!, `order ${order}`);
  });

  test('names the sites of the task that are not opened yet, and drops them once they are', async (t) => {
    const { llm } = await runTask(t, {
      goal: 'Compare the Framework Laptop 16 price on shop.test and deal.test.',
      policy: () => 'annotate',
      script: ['["shop.test: Find the price", "deal.test: Find the deal price"]', clickOn('Deal of the day'), finishWith('shop.test: EUR 1.399,00. deal.test: EUR 1.299,00.')],
    });

    assert.match(stepMessage(llm, 1), /Not opened yet: deal\.test/);
    assert.doesNotMatch(stepMessage(llm, 2), /Not opened yet/, 'the engine read deal.test at step 2');
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
    const end = message.indexOf('Webpage Visible Text Content');
    assert.ok(start > 0 && end > start);
    assert.ok(end - start <= 620, `${end - start} characters`);
  });
});

// ---------------------------------------------------------------------------------------------
// The honest plan
// ---------------------------------------------------------------------------------------------

describe('the plan never claims a site that was not read', () => {
  const PLAN_SITES = JSON.stringify(['shop.test: Find the price', 'deal.test: Find the deal price', 'Compile the answer']);
  const SITES_GOAL = 'Compare the Framework Laptop 16 price on shop.test and deal.test.';
  const HONEST_PARTIAL = 'shop.test: EUR 1.399,00 (https://shop.test/laptops/16). deal.test: not checked, I never opened it.';

  test('the model sees the step of an unread site as open, although its action count ran ahead', async (t) => {
    const { llm } = await runTask(t, {
      goal: SITES_GOAL,
      policy: () => 'annotate',
      script: [PLAN_SITES, navigateTo(PRODUCT), navigateTo(LIST), finishWith(HONEST_PARTIAL)],
    });

    // Two navigations: the old count would show steps 1 and 2 as done. deal.test was never read.
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
    assert.equal(finishes(engine)[0]?.answer, HONEST_PARTIAL, 'the honest answer is left as it is');
    assert.equal(finishes(engine)[0]?.audit?.verdict, 'partial');
  });

  test('a send-back leaves the plan alone: nothing is completed or skipped while the run goes on', async (t) => {
    const { engine } = await runTask(t, {
      goal: SITES_GOAL,
      policy: (ctx) => (ctx.sendBacks === 0 ? 'send_back' : 'annotate'),
      script: [PLAN_SITES, finishWith('shop.test: EUR 1.399,00. deal.test: EUR 1.299,00.'), finishWith(HONEST_PARTIAL)],
    });

    assert.equal(refusals(engine).length, 1);
    // Only the final finish settled the plan.
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
// The second review round: what the reviewers broke in the engine, each with a test that failed before the fix
// ---------------------------------------------------------------------------------------------

/** The reply that types into the input with this label (the id is read from the page the model was shown). */
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
    // A results page that keeps the query in its box and repeats it in its text, like most of them.
    { url: SEARCH, title: 'Search - Deals', text: [{ heading: 'Search' }, 'Keine Treffer fuer "Laptop 16 EUR 1.299,00"'], elements: [input('search', { label: 'Search', value: 'Laptop 16 EUR 1.299,00' })] },
    WEB[1] as PageSpec,
    WEB[2] as PageSpec
  ];
  const GOAL2 = 'Compare the Framework Laptop 16 price on shop.test and deal.test.';

  test('the query the model typed, echoed by the page, does not make the number "seen" on that site', async (t) => {
    const { engine } = await runTask(t, {
      pages: SEARCH_WEB,
      goal: GOAL2,
      policy: () => 'annotate',
      script: [PLAN_2, typeInto('Search', 'Laptop 16 EUR 1.299,00', true), finishWith('shop.test: EUR 1.399,00. deal.test: EUR 1.299,00.')]
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
      { url: LIST, title: 'Laptops - Shop', text: [{ heading: 'Laptops' }, 'Framework Laptop 16'], elements: [input('search', { label: 'Search', value: 'price 9,99 EUR' })] }
    ];
    const { engine } = await runTask(t, { pages, script: [PLAN_2, finishWith('The price is 9,99 EUR.')], policy: () => 'annotate' });
    assert.equal(engine.evidence.entries.some((e) => /9,99/.test(e.text)), false);
    assert.equal(finishes(engine)[0]?.audit?.verdict, 'unverified');
  });

  test('a string typed inside a browser_batch is remembered as well, when it could launder a number or a link', async (t) => {
    const { engine } = await rig(t, { script: [] });
    const e = engine as unknown as { noteTypedText(a: unknown): void; withoutTypedText(t: string): string };
    e.noteTypedText({ action: 'browser_batch', steps: [{ action: 'type', element_id: 1, text: 'Laptop 16 EUR 1.299,00' }, { action: 'click', element_id: 2 }, { action: 'type', element_id: 3, text: 'ab' }, { action: 'type', element_id: 4, text: 'laptop' }] });
    assert.equal(e.withoutTypedText('Keine Treffer fuer "Laptop 16 EUR 1.299,00" bei ab und laptop'), 'Keine Treffer fuer " " bei ab und laptop', 'short strings and plain words are not cut out of a page');
    assert.equal(e.withoutTypedText('LAPTOP 16 eur 1.299,00'), ' ', 'case does not matter');
    e.noteTypedText({ action: 'type', text: 'see https://idealo.de/x?a=1+2 (now)' });
    assert.equal(e.withoutTypedText('Result: see https://idealo.de/x?a=1+2 (now) found'), 'Result:   found', 'a link, with characters that mean something in a pattern');
    e.noteTypedText(null);
    e.noteTypedText({ action: 'type', text: 42 });
    assert.equal(e.withoutTypedText(''), '');
  });
});

describe('a send-back near the step cap does not throw the answer away', () => {
  const GOAL2 = 'Compare the Framework Laptop 16 price on shop.test and deal.test.';
  const both = 'shop.test: EUR 1.399,00. deal.test: EUR 1.299,00.';
  // Send back while a step is left; the clamp turns the last one into annotate.
  const policy = (ctx: GateContext): GateDecision => (ctx.stepsLeft >= 1 && ctx.sendBacks === 0 ? 'send_back' : 'annotate');

  test('the model obeys, opens the site on its last step, and runs out: the answer is checked again and shown, then the reason the run stopped', async (t) => {
    const world = await rig(t, {
      goal: GOAL2,
      maxSteps: 2,
      policy,
      // The last action has an expected outcome: the page the tab is on afterwards is read by the verification, and by nothing else.
      script: [PLAN_2, finishWith(both), act({ action: 'scroll', direction: 'down', expected_outcome: 'the deal page is open', reason: 'Look' }), '{"success": true, "reason": "the deal page is open"}']
    });
    // The tab is on the deal page when the action is done (the fake tab would only get there after the read).
    const host = world.engine as unknown as { executeActionOnTab(tabId: number, action: { action: string }): Promise<unknown> };
    const run = host.executeActionOnTab.bind(world.engine);
    host.executeActionOnTab = async (tabId, action) => {
      const result = await run(tabId, action);
      if (action.action === 'scroll') world.fc.tabs.navigate(101, DEAL);
      return result;
    };
    await world.engine.startTask(GOAL2, 101);
    await world.fc.settle();
    const { engine } = world;

    const [entry] = finishes(engine);
    assert.equal(finishes(engine).length, 1);
    assert.equal(entry?.answer, both, 'the answer the model gave, checked against the page it then opened');
    assert.equal(entry?.audit?.verdict, 'verified', JSON.stringify(entry?.audit?.notes));
    assert.equal(entry?.audit?.sendBacks, 1);
    assert.equal(engine.history.at(-1)?.type, 'error');
    assert.match(String(engine.history.at(-1)?.content), /maximum allowed steps \(2\).*shown above/);
    assert.equal(engine.status, 'idle');
    assert.ok(hasLog('[FINISH_AT_STEP_CAP]'));
    assert.equal(engine.evidence.hasOpened('deal.test'), true, 'the page of the verification step was recorded');
  });

  test('if the model did not fix it, the answer comes back marked, with the banner on top', async (t) => {
    const { engine } = await runTask(t, {
      goal: GOAL2,
      maxSteps: 2,
      policy,
      script: [PLAN_2, finishWith(both), act({ action: 'scroll', direction: 'down', reason: 'Look further' })]
    });

    const [entry] = finishes(engine);
    assert.equal(finishes(engine).length, 1, 'one finish entry, not "reached the maximum steps" alone');
    assert.equal(entry?.audit?.verdict, 'unverified');
    assert.ok((entry?.answer ?? '').startsWith('WARNING - UNVERIFIED ANSWER:'));
    assert.match(String(engine.history.at(-1)?.content), /maximum allowed steps \(2\)/);
    assert.equal(engine.planSteps.some((s) => s.status === 'in_progress'), false, 'the plan is settled');
  });

  test('a run that never finished still ends as it always did', async (t) => {
    const { engine } = await runTask(t, { maxSteps: 2, script: [PLAN_2, act({ action: 'scroll', direction: 'down', reason: 'Look' }), act({ action: 'scroll', direction: 'down', reason: 'Look again' })] });
    assert.equal(finishes(engine).length, 0);
    assert.match(String(engine.history.at(-1)?.content), /^Stopped without finishing - reached the maximum allowed steps \(2\)/);
  });

  test('a new task forgets the refused finish of the last one (a run that was stopped leaves it behind)', async (t) => {
    const { engine } = await runTask(t, {
      maxSteps: 1,
      // What a stopped turn leaves in the engine: a finish that was sent back and never settled.
      prepare: (e) => {
        (e as unknown as { lastRefusedFinish: unknown }).lastRefusedFinish = { action: 'finish', answer: 'an answer of the turn before' };
      },
      script: [PLAN_2, act({ action: 'scroll', direction: 'down', reason: 'Look' })]
    });
    assert.equal(finishes(engine).length, 0, 'the answer of the turn before is not shown in this one');
    assert.match(String(engine.history.at(-1)?.content), /^Stopped without finishing/);
  });
});

describe('a site that redirects counts as opened through the page it led to', () => {
  const TWITTER = 'https://twitter.com/';
  const X_HOME = 'https://x.com/home';
  const REDIRECT_WEB: PageSpec[] = [
    { url: LIST, title: 'Laptops - Shop', text: ['Laptops'], elements: [link('Laptop 16 DIY Edition', PRODUCT)] },
    { url: TWITTER, title: 'Redirecting', text: 'Redirecting...' },
    { url: X_HOME, title: 'Home / X', text: [{ heading: 'Home' }, 'The newest post says hello world'] }
  ];

  test('the model asks for twitter.com, the tab lands on x.com: twitter.com is opened, the plan step is not skipped, nothing is sent back', async (t) => {
    const { engine, policyCalls } = await runTask(t, {
      pages: REDIRECT_WEB,
      redirects: { [TWITTER]: X_HOME },
      goal: 'Read the newest post on twitter.com',
      policy: () => 'send_back',
      script: ['["Open twitter.com", "Read the newest post"]', navigateTo(TWITTER), finishWith('The newest post on twitter.com says hello world.')]
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
      // The fake tab lands on the deal page only after the read, so the post-action snapshot is still the list page.
      script: [PLAN_2, act({ action: 'navigate', url: DEAL, expected_outcome: 'the deal page opens', reason: 'Open the deal' }), '{"success": true, "reason": "ok"}']
    });
    assert.equal(engine.evidence.hasOpened('deal.test'), false);
  });
});

describe('the plan names sources by brand', () => {
  test('a cloud plan that says "Check Deal" does not show that step done before deal.test was read, and does when it was', async (t) => {
    const { llm, engine } = await runTask(t, {
      goal: 'Compare the Framework Laptop 16 price on shop.test and deal.test.',
      policy: () => 'annotate',
      script: ['["Read the laptop list", "Check Deal for the same laptop", "Write the answer"]', navigateTo(PRODUCT), navigateTo(LIST), clickOn('Deal of the day'), finishWith('shop.test: EUR 1.399,00. deal.test: EUR 1.299,00.')]
    });

    // After two navigations the old count had reached step 3; deal.test was not read yet.
    assert.match(stepMessage(llm, 3), /2\. \[>\] Check Deal for the same laptop/);
    // Once the tab stands on it, the very next message shows it done.
    assert.match(stepMessage(llm, 4), /2\. \[x\] Check Deal for the same laptop/);
    assert.deepEqual(engine.planSteps.map((s) => s.status), ['completed', 'completed', 'completed']);
  });

  test('the fallback plan does not put the whole goal into its first step', async (t) => {
    const { engine } = await runTask(t, { goal: 'Compare the Framework Laptop 16 price on shop.test and deal.test.', policy: () => 'annotate', script: ['not a plan at all', finishWith('shop.test: EUR 1.399,00. deal.test: not checked.')] });
    assert.equal(engine.planSteps[0]?.text, 'Analyze the page state for the task');
    assert.ok(engine.planSteps.every((s) => !/shop\.test|deal\.test/.test(s.text)));
  });
});

describe('the step message follows the page the tab is on', () => {
  test('the step that just landed on a site shows its plan step done (the plan is re-derived after the page is read)', async (t) => {
    const pages: PageSpec[] = [
      { url: LIST, title: 'Laptops - Shop', text: ['Framework Laptop 16 ab 1.399,00 EUR'], elements: [input('search', { label: 'Search' }), link('Deal of the day', DEAL)] },
      WEB[1] as PageSpec,
      WEB[2] as PageSpec
    ];
    const { llm } = await runTask(t, {
      pages,
      goal: 'Compare the Framework Laptop 16 price on shop.test and deal.test.',
      policy: () => 'annotate',
      script: ['["shop.test: read the price", "deal.test: read the deal price", "Write the answer"]', typeInto('Search', 'laptop'), typeInto('Search', 'laptop 16'), clickOn('Deal of the day'), finishWith('shop.test: EUR 1.399,00. deal.test: EUR 1.299,00.')]
    });
    // The position ran ahead (two typings, one click) while deal.test was unread: still open. Then the page is read.
    assert.match(stepMessage(llm, 3), /2\. \[>\] deal\.test: read the deal price/);
    assert.match(stepMessage(llm, 4), /2\. \[x\] deal\.test: read the deal price/);
    assert.match(stepMessage(llm, 4), /3\. \[>\] Write the answer/);
  });

  test('a text result is recorded under the page the tab is on when the action runs, not the page of the snapshot', async (t) => {
    let moved = false;
    const world = await rig(t, {
      script: [
        PLAN_2,
        // The tab leaves the page while the model is thinking (a script, a redirect, a click in another window).
        (call: LlmCall) => {
          void call;
          return readText;
        }
      ]
    });
    // Move the tab right before the action runs: the reply function of call 1 cannot reach the rig, so do it at the first action.
    const realNavigate = world.fc.tabs.navigate.bind(world.fc.tabs);
    world.llm.calls.length = 0;
    const original = world.engine as unknown as { executeActionOnTab: (tabId: number, action: { action: string }) => Promise<unknown> };
    const run = original.executeActionOnTab.bind(world.engine);
    original.executeActionOnTab = async (tabId, action) => {
      if (!moved && action.action === 'read_page_text') {
        moved = true;
        realNavigate(101, DEAL);
      }
      return run(tabId, action);
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
      script: [PLAN_2, finishWith('shop.test: EUR 1.399,00. deal.test: nothing yet.')]
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
    assert.equal(entry?.audit?.verdict, 'unverified', 'the invented row is audited, not skipped as "no claims"');
  });
});
