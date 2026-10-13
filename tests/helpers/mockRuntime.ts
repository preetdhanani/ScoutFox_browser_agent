/**
 * mockRuntime - one RunRuntime for the graph tests that call buildWorkerGraph() or
 * buildOrchestratorGraph() directly.
 *
 * Six graph tests (workerRisk, workerLongHorizon, workerXHighMax, orchestratorEffort,
 * orchestratorLongHorizon, orchestratorReflect) each hand-roll a 90 to 150 line copy of
 * createMockRuntime(). This is the shared version, so a new graph test does not add a seventh. The
 * six are not migrated yet: it is a helper first, and the old copies keep working as they are.
 *
 * What it gives:
 *   createMockRuntime(threadId, overrides?)   a complete RunRuntime. Nothing is registered.
 *   registerMockRuntime(threadId, overrides?, t?)   the same, put in runtimeRegistry (the nodes look it
 *                                             up by thread id). Pass the test context and the entry is
 *                                             deleted again when the test ends.
 *   mockSnapshot(overrides?)                  the page the default browser.snapshot() answers with.
 *   mockPlanReply(sites?)                     the plan text the default llm answers a plan call with.
 *
 * Example:
 *   const rt = registerMockRuntime('thread-1', {
 *     llm: fakeLlm().port({ queues: { policy: [JSON.stringify({ action: 'click', element_id: 1 })] } }),
 *     browser: { execute: async () => ({ success: false, error: 'boom', via: 'synthetic', effect: 'none' }) },
 *   }, t);
 *   const graph = buildWorkerGraph(new MemorySaver());
 *
 * Overrides: a top-level member replaces the default (llm, settings, windowId, ownerTabId, ...). The
 * members that are objects of functions (browser, control, net, emit, clock, journal) are PARTIAL: give
 * only the methods you change and the others keep their defaults. browser.cdp is replaced as a whole.
 *
 * The defaults (every one of them deterministic, no timers, no network):
 *   llm        a plan call gets a one-site plan (shop.test), a policy call gets a finish, a reflect
 *              call THROWS (there is no neutral reflect reply, so give llm when the run reflects).
 *   browser    one page, https://shop.test/item, three elements; execute() succeeds with a DOM change;
 *              waits resolve at once; every tab is in scope.
 *   control    real flags: pauseRequested and stopRequested can be set and snapshot() reports them.
 *              stepSignal() is a fresh signal, already aborted when a flag is set.
 *   clock      now() is fixed at 1_700_000_000_000 and sleep() resolves at once.
 *   journal    in memory.
 */

import { runtimeRegistry } from '../../src/background/runner/runtimeRegistry.ts';
import type { ActionJournal, BrowserPort, ExecResult, LlmPort, RunControl, RunRuntime } from '../../src/background/runner/runtimeRegistry.ts';
import type { Settings } from '../../src/shared/storage.ts';

export const MOCK_NOW = 1_700_000_000_000;

export type MockRuntimeOverrides = Omit<Partial<RunRuntime>, 'browser' | 'control' | 'net' | 'emit' | 'clock' | 'journal'> & {
  browser?: Partial<BrowserPort>;
  control?: Partial<RunControl>;
  net?: Partial<RunRuntime['net']>;
  emit?: Partial<RunRuntime['emit']>;
  clock?: Partial<RunRuntime['clock']>;
  journal?: Partial<ActionJournal>;
};

/** The part of a node:test context that registerMockRuntime needs. */
export interface AfterHook {
  after(fn: () => void | Promise<void>): void;
}

/** The plan text for one or more sites. The default is one reference site on shop.test. */
export function mockPlanReply(sites?: Array<Record<string, unknown>>): string {
  return JSON.stringify({
    taskKind: 'action',
    sites: sites ?? [{ id: 's1', name: 'Shop', domain: 'shop.test', startUrl: 'https://shop.test/item', role: 'reference', kind: 'page', goal: 'Do the task' }],
  });
}

/** What browser.snapshot() answers by default (the shape worker.ts perceive reads). */
export function mockSnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    docId: 'doc-mock-1',
    tabId: 101,
    url: 'https://shop.test/item',
    domain: 'shop.test',
    title: 'Shop Item Page',
    scrollY: 0,
    pageHeight: 1000,
    viewportHeight: 800,
    elementCount: 3,
    refs: [1, 2, 3],
    elementsText: '[1] button "Buy"\n[2] link "Details"\n[3] text "1.599 EUR"',
    elementInfo: {
      '1': { role: 'button', label: 'Buy' },
      '2': { role: 'link', label: 'Details' },
      '3': { role: 'text', label: '1.599 EUR' },
    },
    pageText: 'Welcome to the shop. The item costs 1.599 EUR and is in stock today.',
    capturedAt: MOCK_NOW,
    ...overrides,
  };
}

const MOCK_SETTINGS = { provider: 'mock', model: 'mock-model', maxSteps: 250, customPrompts: {} } as unknown as Settings;

function defaultLlm(): LlmPort {
  return {
    complete: async (req) => {
      if (req.node === 'reflect') {
        throw new Error('mockRuntime: the default llm has no reflect reply - pass llm (e.g. fakeLlm().port({ queues: { reflect: [...] } })) for a run that reflects');
      }
      return {
        text: req.node === 'plan' ? mockPlanReply() : JSON.stringify({ thought: 'done', action: 'finish', answer: 'Mock answer.' }),
        provider: 'mock',
        model: 'mock-model',
        meta: {},
        usage: { tokensIn: 50, tokensOut: 20 },
      };
    },
  };
}

function defaultControl(): RunControl {
  let pauseRequested = false;
  let stopRequested = false;
  const control: RunControl = {
    get pauseRequested() {
      return pauseRequested;
    },
    set pauseRequested(value: boolean) {
      pauseRequested = value;
    },
    get stopRequested() {
      return stopRequested;
    },
    set stopRequested(value: boolean) {
      stopRequested = value;
    },
    stepSignal: () => {
      const controller = new AbortController();
      if (pauseRequested || stopRequested) controller.abort({ scoutfox: 'user', reason: stopRequested ? 'user_stop' : 'user_pause' });
      return controller.signal;
    },
    abortStep: (reason) => {
      if (reason === 'user_pause') pauseRequested = true;
      if (reason === 'user_stop') stopRequested = true;
    },
    isUserAbort: (_err, signal) => {
      const reason = signal?.aborted ? (signal.reason as { scoutfox?: string } | null) : null;
      return Boolean(reason && typeof reason === 'object' && reason.scoutfox === 'user');
    },
    snapshot: () => ({ pauseRequested, stopRequested }),
  };
  return control;
}

function defaultBrowser(): BrowserPort {
  const exec: ExecResult = { success: true, message: 'Done.', via: 'synthetic', effect: 'dom_changed' };
  return {
    tabInfo: async () => ({ url: 'https://shop.test/item', title: 'Shop Item Page', windowId: 1, groupId: 0, status: 'complete' }),
    snapshot: async () => mockSnapshot(),
    pageSig: async () => null,
    execute: async () => ({ ...exec }),
    navigate: async () => {},
    reload: async () => {},
    goBack: async () => {},
    waitForTabComplete: async () => {},
    waitDomQuiet: async () => {},
    cdp: {
      ensureAttached: async () => ({ mode: 'synthetic' as const, reason: null }),
      detachAll: async () => {},
    },
    clearBadges: async () => {},
    isTabInScope: async () => true,
  };
}

function defaultJournal(): ActionJournal {
  const entries = new Map<string, { dispatchedAt: number; bootId: string; result: ExecResult | null }>();
  return {
    get: async (key) => entries.get(key) ?? null,
    begin: async (key) => {
      entries.set(key, { dispatchedAt: MOCK_NOW, bootId: 'boot-mock', result: null });
    },
    finish: async (key, result) => {
      const entry = entries.get(key);
      if (entry) entry.result = result;
    },
    clearRun: async () => {
      entries.clear();
    },
  };
}

export function createMockRuntime(threadId: string, overrides: MockRuntimeOverrides = {}): RunRuntime {
  const { browser, control, net, emit, clock, journal, ...top } = overrides;
  const ownerTabId = top.ownerTabId ?? 101;
  const runtime: RunRuntime = {
    threadId,
    ownerTabId,
    bootId: 'boot-mock',
    tabs: { activeTabId: ownerTabId },
    windowId: 1,
    scoutFoxGroupIds: new Map(),
    attachedTabIds: new Set(),
    resumedAfterRestart: false,
    settings: async () => ({ ...MOCK_SETTINGS }),
    llm: defaultLlm(),
    ...top,
    // Object.assign, not a spread: the flags are accessors, and a spread would freeze them as plain values.
    control: Object.assign(defaultControl(), control),
    browser: { ...defaultBrowser(), ...browser },
    journal: { ...defaultJournal(), ...journal },
    net: { marker: () => (runtime as any)?._systemActionMarker ?? 'marker-1', read: () => '[]', ...net },
    emit: { enterNode: () => {}, setPhase: () => {}, ...emit },
    clock: { now: () => MOCK_NOW, sleep: async () => {}, ...clock },
  };
  return runtime;
}

export function registerMockRuntime(threadId: string, overrides: MockRuntimeOverrides = {}, t?: AfterHook): RunRuntime {
  const runtime = createMockRuntime(threadId, overrides);
  runtimeRegistry.set(runtime);
  t?.after(() => runtimeRegistry.delete(threadId));
  return runtime;
}
