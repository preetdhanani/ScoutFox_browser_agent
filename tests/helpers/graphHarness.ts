/**
 * graphHarness - the REAL AgentRunner (and so the real orchestrator and worker graphs, the real
 * checkpoint saver and the real BrowserPort) over fakeChrome, fakeDom, fakeStorageSession and the
 * port() stand-in of fakeLlm, on a zero clock.
 *
 * It is what tests/runner/agentRunner.test.ts composes by hand, with the parts a graph test always
 * needs added: a scripted model keyed by node, a way to drive a run to its end or to the hold it
 * stops at, answers to questions and approvals, stop, and a restart of the worker over the same
 * storage.
 *
 * Example:
 *   import { graphRig, act } from './helpers/graphHarness.ts';
 *
 *   const rig = await graphRig({ policy: [act.scroll('down', 300), act.finish('Item 42 costs 99 USD.')] });
 *   t.after(rig.cleanup);
 *   await rig.start('Find the price of item 42');   // returns when the run is idle or stopped at a hold
 *   rig.status();                                    // 'idle'
 *   rig.finishAnswer();                              // 'Item 42 costs 99 USD.'
 *   rig.site.actions;                                // what reached the page: the scroll
 *   rig.llm.callsOf('policy')[0]?.system;            // what the policy node told the model
 *   rig.assertClean();                               // no chrome, dom or llm test mistake happened
 *
 * Driving. Every method that can start work (start, resume, answer, approvePlan, confirm, challenge,
 * continueBudget, pause, stop) returns only when the run has SETTLED: the drive loop of the runner is
 * over and everything fakeChrome had queued has run. So after `await rig.start()` the run is idle,
 * stopped, or paused at a hold, and rig.pending() says which hold. To look at a run in flight, do not
 * await start(): `const run = rig.start('...'); await rig.waitForCall('policy'); rig.pause(); await run;`
 *
 * Pause in flight. With the runner's autoApprovePlan (the default here, true) the status stays
 * 'running' through the plan hold: deriveStatus() decides the auto-approval before it writes any status
 * (it used to write 'paused' first and never undo it, so the panel showed Resume for the whole run;
 * tests/runner/autoApproveStatus.test.ts pins that). To pause a run that is in flight, either way works:
 * `const run = rig.start(...); await rig.waitForCall('policy'); rig.runner.pause(); await run;` then
 * `await rig.resume()`; or use `autoApprove: false` and approve the plan by hand, like a card would:
 * `await rig.start(...)` (stops at the plan hold), `const run = rig.approvePlan();`
 * `await rig.waitForCall('policy'); rig.runner.pause(); await run;`.
 *
 * Content script. fakeDom builds the snapshot WITHOUT `refs`, and perceive builds the page's element
 * ids from `snapshot.refs ?? []`, so a `click` or `type` with an element id is rejected today and
 * never reaches the page (finding F1 of docs/p8-plan.md, fixed in Stage 1b). scroll, navigate,
 * go_back, press_key, wait and finish do not need ids and run through the real BrowserPort.
 *
 * The script. The model replies come from rig.llm (a fakeLlm). The graph options give the ordered
 * queues per node: `policy: [...]` and `reflect: [...]`. A plan reply is pushed for every start()
 * (the default plan is one reference site on shop.test, see shopPlan(); pass `plan` to start() for
 * another one, or null for none). More replies later: rig.push(...) for the policy node,
 * rig.llm.pushFor('reflect', ...) for any other. A call the script has no reply for is a loud test
 * mistake (rig.assertClean() throws) - it never gets a default answer.
 *
 * THE CLOCK (what is the seam). AgentRunner builds runtime.clock inside its constructor with Date.now
 * and a setTimeout sleep, and has NO constructor option for another clock. The seam that exists is
 * that the runtime it registers in runtimeRegistry is a plain object whose `clock` member is not
 * read-only and is read by the nodes at call time (getRuntime(config).clock). So the harness replaces
 * `runtimeRegistry.get(threadId).clock` with zeroClock() right after the constructor, before any
 * task starts. What is MISSING in src/ is therefore only a `clock` option on the AgentRunner
 * constructor (a one line change); nothing here needs it. What the zero clock does NOT reach, because
 * that code never asks runtime.clock, is listed in docs/p8-ledger.md (timing seams): the 30 minute
 * pause timer, waitForTabComplete's timeout, the 30 ms and 50 ms click delays in browser/input.ts,
 * the real timers of the debugger code, and the 6 s and 3 s waits of the blocked ladder on a challenge
 * page (worker.ts passes executeBlockedLadder no sleep). fakeChrome navigations finish by themselves,
 * so those do not delay a test unless it asks for a hung one or a challenge page.
 *
 * Restart. rig.restart() is a worker restart of a settled run (idle, stopped or paused at a hold; it
 * throws when a drive is still in flight): the old chrome is killed, a new fakeChrome is built
 * over the SAME storage (with the tabs and groups the old one had), a new AgentRunner starts over it
 * with the same model script, and its restore is awaited. Until Stage 3b makes the runner write
 * sf:meta from notifyStateChange, nothing in production writes it, so restore finds nothing. For now
 * restart() calls runner.persistState() by hand first, exactly like tests/runner/agentRunner.test.ts
 * ("restoreState across simulated service worker restart"). Pass { persist: false } to see what
 * production does today (a restart that forgets the run).
 */

import { fakeChrome } from './fakeChrome.ts';
import type { FakeChrome, FakeChromeOptions } from './fakeChrome.ts';
import { createFakeStorage } from './fakeStorageSession.ts';
import type { FakeStorage } from './fakeStorageSession.ts';
import { fakeDom, link } from './fakeDom.ts';
import type { FakeDom, PageSpec } from './fakeDom.ts';
import { fakeLlm } from './fakeLlm.ts';
import type { FakeLlm, PortNode, ReplyEntry } from './fakeLlm.ts';
export type { FakeLlm, PortNode, ReplyEntry };
import { AgentRunner } from '../../src/background/runner/AgentRunner.ts';
import { runtimeRegistry } from '../../src/background/runner/runtimeRegistry.ts';
import type { LlmPort, RunRuntime } from '../../src/background/runner/runtimeRegistry.ts';
import type { HistoryEntry } from '../../src/background/graph/state.ts';
import type { GateContext, GateDecision } from '../../src/background/agent/finishPolicy.ts';

// ---------------------------------------------------------------------------------------------
// Defaults: a two page shop, a one site plan, and the replies a policy node gives
// ---------------------------------------------------------------------------------------------

export const SHOP_LIST_URL = 'https://shop.test/items';
export const SHOP_PRODUCT_URL = 'https://shop.test/items/42';

/** The default site: a list page with a link to the product page (element 1), and the product page with a link back. */
export function shopPages(): PageSpec[] {
  return [
    {
      url: SHOP_LIST_URL,
      title: 'Items List',
      text: ['Item 42 available for 99 USD', 'Item 43 available for 120 USD'],
      elements: [link('Item 42 Details', SHOP_PRODUCT_URL)],
    },
    {
      url: SHOP_PRODUCT_URL,
      title: 'Item 42 Details',
      text: ['Price: 99 USD', 'In Stock'],
      elements: [link('Back', SHOP_LIST_URL)],
    },
  ];
}

/** A plan reply of one reference site. The default for every start(). */
export function shopPlan(sites?: Array<Record<string, unknown>>): string {
  return JSON.stringify({
    taskKind: 'action',
    sites: sites ?? [{ id: 's1', name: 'shop.test', domain: 'shop.test', role: 'reference', kind: 'page', goal: 'Do task' }],
  });
}

export const act = {
  click: (elementId: number, reason = 'Open it'): string => JSON.stringify({ action: 'click', element_id: elementId, reason }),
  finish: (answer: string): string => JSON.stringify({ action: 'finish', answer }),
  subgoalDone: (summary: string, evidence = 'the text is on the page'): string => JSON.stringify({ action: 'subgoal_done', summary, evidence }),
  askUser: (question: string): string => JSON.stringify({ action: 'ask_user', question }),
  scroll: (direction: 'up' | 'down' = 'down', amount = 300): string => JSON.stringify({ action: 'scroll', direction, amount }),
  navigate: (url: string, reason = 'Navigate'): string => JSON.stringify({ action: 'navigate', url, reason }),
  goBack: (reason = 'Go back'): string => JSON.stringify({ action: 'go_back', reason }),
  goForward: (reason = 'Go forward'): string => JSON.stringify({ action: 'go_forward', reason }),
  type: (elementId: number, text: string, submit = false, reason = 'Type text'): string => JSON.stringify({ action: 'type', element_id: elementId, text, submit, reason }),
  pressKey: (key: string, reason = 'Press key'): string => JSON.stringify({ action: 'press_key', key, reason }),
  wait: (amount = 1, reason = 'Wait'): string => JSON.stringify({ action: 'wait', amount, reason }),
  readPageText: (reason = 'Read page text'): string => JSON.stringify({ action: 'read_page_text', reason }),
  executeJs: (code: string, reason = 'Run code'): string => JSON.stringify({ action: 'execute_js', code, reason }),
  openWindow: (url: string, reason = 'Open window'): string => JSON.stringify({ action: 'open_window', url, reason }),
  readNetworkRequests: (filter: Record<string, any> = {}, reason = 'Read requests'): string => JSON.stringify({ action: 'read_network_requests', filter, reason }),
  browserBatch: (steps: any[], reason = 'Run batch'): string => JSON.stringify({ action: 'browser_batch', steps, reason }),
};

const DEFAULT_SETTINGS = {
  provider: 'openrouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  model: 'test-model',
  maxSteps: 20,
  actionDelayMs: 1,
};

// ---------------------------------------------------------------------------------------------
// The zero clock
// ---------------------------------------------------------------------------------------------

type RunClock = RunRuntime['clock'];

export interface ZeroClock extends RunClock {
  /** Every sleep the code asked for, in ms, in order. */
  readonly sleeps: number[];
  /** Virtual time now, in ms. It only moves when something sleeps or the test calls advance(). */
  readonly time: number;
  advance(ms: number): void;
}

/** A clock with no timers: sleep() resolves at once and moves the virtual time by the sleep, now() reads it. */
export function zeroClock(start = 1_700_000_000_000): ZeroClock {
  let time = start;
  const sleeps: number[] = [];
  return {
    sleeps,
    get time() {
      return time;
    },
    now: () => time,
    sleep: async (ms, signal) => {
      sleeps.push(ms);
      if (signal?.aborted) return;
      time += ms;
    },
    advance: (ms) => {
      time += ms;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The rig
// ---------------------------------------------------------------------------------------------

export interface GraphRigOptions {
  /** The tab the runner owns and the task runs in. Default 101. */
  tabId?: number;
  windowId?: number;
  /** The site the fake content script serves. Default shopPages(). */
  pages?: PageSpec[];
  /** The URL the tab is on at the start. Default: the first page. */
  startUrl?: string;
  /** Merged over the default settings, stored as agent_settings. */
  settings?: Record<string, unknown>;
  /** Share one store between rigs (or seed it). Default: a new one. */
  store?: FakeStorage;
  /** Your own fake, e.g. one you also use elsewhere. Default: a new fakeLlm(). */
  llm?: FakeLlm;
  /** The ordered replies of the policy node. */
  policy?: ReplyEntry[];
  /** The ordered replies of the reflect node. */
  reflect?: ReplyEntry[];
  /** What every start() pushes for the plan call. Default shopPlan(). null: nothing is pushed, script the plan yourself. */
  plan?: ReplyEntry | null;
  /** More chrome.* namespaces, merged over { tabs, tabGroups, storage, dom }. */
  chrome?: Partial<FakeChromeOptions>;
  /** The runner's autoApprovePlan. Default true, the runner's own default; the router now defaults to true as well. */
  autoApprove?: boolean;
  /** Custom finish policy hook. */
  finishPolicy?: (ctx: GateContext) => GateDecision;
  /** Custom URL redirects: { fromUrl: toUrl }. */
  redirects?: Record<string, string>;
}

export interface StartOptions {
  /** The effort the user picked ('low', 'medium', 'high', ...). */
  effort?: string;
  /** For this start only: the plan reply to push (null: none). */
  plan?: ReplyEntry | null;
  autoApprove?: boolean;
}

export interface Pending {
  question: string | null;
  approval: unknown;
  confirm: unknown;
  challenge: unknown;
  budget: unknown;
}

type Result = { success: boolean; error?: string };

export interface GraphRig {
  readonly fc: FakeChrome;
  readonly site: FakeDom;
  readonly store: FakeStorage;
  readonly llm: FakeLlm;
  readonly clock: ZeroClock;
  /** The runner now: after restart() it is the new one. */
  readonly runner: AgentRunner;
  /** The runtime of the runner now, as registered in runtimeRegistry. */
  readonly runtime: RunRuntime;
  readonly tabId: number;

  /** Start a task and drive it until it is idle, stopped or paused at a hold. */
  start(prompt: string, options?: StartOptions): Promise<Result>;
  /** Wait until the drive loop is over and the fake chrome has nothing queued. */
  settle(): Promise<void>;
  /** Wait until the model has been called `times` times for a node (and mode), without a timer. For a run you did not await. */
  waitForCall(node: PortNode, times?: number, mode?: string): Promise<void>;
  /** Push policy replies. */
  push(...entries: ReplyEntry[]): void;

  resume(): Promise<Result>;
  answer(text: string): Promise<Result>;
  approvePlan(decision?: Record<string, unknown>): Promise<void>;
  confirm(decision: 'approve' | 'reject', remember?: 'site'): Promise<void>;
  challenge(action: 'resolved' | 'skip'): Promise<void>;
  continueBudget(action: 'continue' | 'finish', additionalSteps?: number): Promise<void>;
  pause(): Promise<Result>;
  stop(): Promise<Result>;
  /** A worker restart over the same storage. See the header comment. */
  restart(options?: { persist?: boolean; autoApprove?: boolean }): Promise<AgentRunner>;

  status(): string;
  history(): HistoryEntry[];
  /** The history entries of one type ('finish', 'user_answer', 'error', ...). */
  entries(type: string): HistoryEntry[];
  /** The answer of the finish entry, when there is one. */
  finishAnswer(): string | undefined;
  state(): Record<string, any>;
  pending(): Pending;

  /** Throws when the fake chrome, the fake page or the fake model met a test mistake. */
  assertClean(): void;
  /** Stops a run that is still going, disposes every runner, puts the chrome global back. Use t.after(rig.cleanup). */
  cleanup(): Promise<void>;
}

export async function graphRig(options: GraphRigOptions = {}): Promise<GraphRig> {
  const tabId = options.tabId ?? 101;
  const windowId = options.windowId ?? 1;
  const store = options.store ?? createFakeStorage();
  const site = fakeDom({ pages: options.pages ?? shopPages() });
  const llm = options.llm ?? fakeLlm();
  const clock = zeroClock();
  const planDefault = options.plan === undefined ? shopPlan() : options.plan;

  // The settings go in storage once; a restart sees them again because the store is shared.
  const settingsKey = 'agent_settings';
  const stored = (await store.connect().local.get(settingsKey))[settingsKey];
  if (stored === undefined) {
    await store.connect().local.set({ [settingsKey]: { ...DEFAULT_SETTINGS, ...options.settings } });
  }

  const firstUrl = options.startUrl ?? site.pages[0]?.url ?? SHOP_LIST_URL;
  const chromes: FakeChrome[] = [];
  const restores: Array<() => void> = [];
  const runners: AgentRunner[] = [];

  const queues: { policy?: ReplyEntry[]; reflect?: ReplyEntry[] } = {};
  if (options.policy) queues.policy = options.policy;
  if (options.reflect) queues.reflect = options.reflect;
  const port: LlmPort = llm.port({ queues });

  const build = (tabs: unknown[], groups: unknown[]): FakeChrome => {
    const fc = fakeChrome({
      tabs: { list: tabs as never },
      tabGroups: { list: groups as never },
      storage: store,
      dom: true,
      ...options.chrome,
    });
    chromes.push(fc);
    const redirectNav = options.redirects
      ? {
          tabs: {
            get: (id: number) => fc.tabs.get(id),
            navigate: (id: number, url: string) => fc.tabs.navigate(id, options.redirects?.[url] ?? url),
          },
          dom: fc.dom,
        }
      : fc;
    site.attach(redirectNav as any, tabId);
    restores.push(fc.install());
    return fc;
  };

  const startRunner = async (autoApproveOverride?: boolean): Promise<AgentRunner> => {
    const created = new AgentRunner(tabId, windowId, undefined, port);
    if (options.finishPolicy) created.finishPolicy = options.finishPolicy;
    runners.push(created);
    // The zero clock goes in before any task starts. See THE CLOCK in the header comment.
    const registered = runtimeRegistry.get(String(tabId));
    if (!registered) throw new Error('graphHarness: AgentRunner did not register its runtime, so the zero clock cannot be put in');
    registered.clock = clock;
    if (!('currentDrive' in created)) throw new Error('graphHarness: AgentRunner has no currentDrive any more - settle() needs a new way to know that a drive is over');
    // A restart may ask for another autoApprove than the first runner had: the runner's flag is not persisted, so a
    // restarted PRODUCTION worker starts with the default (true), whatever the run before it used. This harness applies
    // options.autoApprove again unless restart() overrides it, so pass { autoApprove: true } to restart like production.
    const autoApprove = autoApproveOverride ?? options.autoApprove;
    if (autoApprove !== undefined) created.autoApprovePlan = autoApprove;
    created.setTabAdoptedCallback((newTabId) => {
      if (fc) site.attach(fc, newTabId);
    });
    await created.restorePromise;
    return created;
  };

  let fc = build([{ id: tabId, windowId, url: firstUrl }], []);
  let runner = await startRunner();

  const driveOf = (): Promise<void> | null => (runner as unknown as { currentDrive: Promise<void> | null }).currentDrive;

  const settle = async (): Promise<void> => {
    for (let turns = 0; turns < 10_000; turns++) {
      const drive = driveOf();
      if (!drive) break;
      await drive.catch(() => {});
    }
    await fc.settle();
  };

  const pushPlan = (plan: ReplyEntry | null | undefined) => {
    const entry = plan === undefined ? planDefault : plan;
    if (entry !== null) llm.pushFor('plan', entry);
  };

  const rig: GraphRig = {
    get fc() {
      return fc;
    },
    site,
    store,
    llm,
    clock,
    get runner() {
      return runner;
    },
    get runtime() {
      const rt = runtimeRegistry.get(String(tabId));
      if (!rt) throw new Error('graphHarness: no runtime is registered (the runner was disposed)');
      return rt;
    },
    tabId,

    start: async (prompt, startOptions = {}) => {
      pushPlan(startOptions.plan);
      const result = await runner.startTask(prompt, tabId, startOptions.effort, startOptions.autoApprove);
      await settle();
      return result;
    },
    settle,
    waitForCall: async (node, times = 1, mode) => {
      for (let turns = 0; turns < 100_000; turns++) {
        if (llm.callsOf(node, mode).length >= times) return;
        await new Promise((resolve) => setImmediate(resolve));
      }
      throw new Error(`graphHarness: waited for ${times} ${node} call(s) and saw ${llm.callsOf(node, mode).length}`);
    },
    push: (...entries) => {
      llm.pushFor('policy', ...entries);
    },

    resume: async () => {
      const result = runner.resume();
      await settle();
      return result;
    },
    answer: async (text) => {
      const result = runner.answerQuestion(text);
      await settle();
      return result;
    },
    approvePlan: async (decision = {}) => {
      await runner.approvePlan(decision);
      await settle();
    },
    confirm: async (decision, remember) => {
      await runner.confirmAction(decision, remember);
      await settle();
    },
    challenge: async (action) => {
      await runner.resolveChallenge(action);
      await settle();
    },
    continueBudget: async (action, additionalSteps) => {
      await runner.continueBudget(action, additionalSteps);
      await settle();
    },
    pause: async () => {
      const result = runner.pause();
      await settle();
      return result;
    },
    stop: async () => {
      const result = runner.stop();
      await settle();
      return result;
    },

    restart: async (restartOptions = {}) => {
      if (driveOf()) throw new Error('graphHarness: restart() needs a settled run (idle, stopped, or paused at a hold). A drive is still in flight: pause or stop it first, or await the call that started it');
      // Production writes sf:meta from nowhere yet (Stage 3b changes that), so the test does it by hand.
      if (restartOptions.persist !== false) await runner.persistState();
      await settle();
      const tabs = fc.tabs.list().map((tab) => ({ ...tab }));
      const groups = fc.tabGroups.list().map((group) => ({ ...group }));
      runner.dispose();
      restores.pop()?.();
      fc.kill();
      fc = build(tabs, groups);
      runner = await startRunner(restartOptions.autoApprove);
      return runner;
    },

    status: () => runner.getStatus(),
    history: () => runner.getHistory(),
    entries: (type) => runner.getHistory().filter((entry) => entry.type === type),
    finishAnswer: () => (runner.getHistory().find((entry) => entry.type === 'finish') as { answer?: string } | undefined)?.answer,
    state: () => runner.getState(),
    pending: () => ({
      question: runner.pendingQuestion,
      approval: runner.pendingApproval,
      confirm: runner.pendingConfirm,
      challenge: runner.pendingChallengeHelp,
      budget: runner.pendingContinueBudget,
    }),

    assertClean: () => {
      for (const each of chromes) each.assertClean();
      site.assertClean();
      llm.assertClean();
    },
    cleanup: async () => {
      if (runner.getStatus() === 'running' || runner.getStatus() === 'paused') runner.stop();
      // A stop aborts the model call, so this ends by itself. The net is only for a reply function that ignores its signal and never answers.
      let net: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([settle(), new Promise<void>((resolve) => void (net = setTimeout(resolve, 5_000)))]);
      clearTimeout(net);
      for (const each of runners) each.dispose();
      for (const restore of restores.splice(0).reverse()) restore();
      for (const each of chromes) each.kill();
    },
  };
  return rig;
}
