// BUG-24 regression: a fatal perceive error (tab closed, tab out of scope) used
// to be swallowed - every remaining site still ran a perceive/LLM cycle against
// the dead tab and the run report filled up with fake "partial / Site finished"
// rows. buildSiteOut now maps the fatal perceive error into the site exit
// (status 'failed', fatal kind), the reflect fast-path stops the run, and the
// remaining sites are never scheduled.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkerGraph, buildSiteOut } from '../../src/background/graph/worker.ts';
import { buildOrchestratorGraph } from '../../src/background/graph/orchestrator.ts';
import { runtimeRegistry, type RunRuntime } from '../../src/background/runner/runtimeRegistry.ts';
import type { SiteIn, WorkerStateT } from '../../src/background/graph/workerState.ts';
import { MemorySaver } from '@langchain/langgraph';
import { SessionStorageSaver } from '../../src/background/checkpoint/SessionStorageSaver.ts';
import { createFakeStorage, type FakeStorage } from '../helpers/fakeStorageSession.ts';
import { fakeDom, link, type PageSpec } from '../helpers/fakeDom.ts';
import { fakeChrome } from '../helpers/fakeChrome.ts';
import { fakeLlm } from '../helpers/fakeLlm.ts';
import { graphRig, act } from '../helpers/graphHarness.ts';
import { Logger } from '../../src/shared/logger.ts';

const LIST = 'https://shop.test/laptops';
const PRODUCT = 'https://shop.test/item-1';

function createMockRuntime(threadId: string, overrides: Partial<RunRuntime> = {}): RunRuntime {
  const mockRuntime: RunRuntime = {
    threadId,
    ownerTabId: 101,
    bootId: 'boot-test-tab-gone',
    control: {
      pauseRequested: false,
      stopRequested: false,
      stepSignal: () => new AbortController().signal,
      abortStep: () => {},
      isUserAbort: () => false,
      snapshot: () => ({ stopRequested: false, pauseRequested: false, stepRequested: false }),
    } as any,
    tabs: { activeTabId: 101 },
    windowId: 1,
    scoutFoxGroupIds: new Map(),
    attachedTabIds: new Set(),
    resumedAfterRestart: false,
    settings: async () => ({ provider: 'mock', model: 'mock-model', maxSteps: 250, customPrompts: {} } as any),
    llm: { complete: async () => ({ text: '', provider: 'mock', model: 'mock-model', meta: {} }) },
    browser: {
      tabInfo: async () => ({ url: 'https://shop.test/item', title: 'Item', windowId: 1, groupId: 0, status: 'complete' }),
      snapshot: async () => { throw new Error('Tab 101 no longer exists'); },
      pageSig: async () => null,
      execute: async () => ({ success: true, mode: 'synthetic' } as any),
      navigate: async () => {},
      reload: async () => {},
      goBack: async () => {},
      waitForTabComplete: async () => {},
      waitDomQuiet: async () => {},
      cdp: { ensureAttached: async () => ({ mode: 'synthetic', reason: null }), detachAll: async () => {} },
      clearBadges: async () => {},
      isTabInScope: async () => true,
    },
    journal: { get: async () => null, begin: async () => {}, finish: async () => {}, clearRun: async () => {} },
    net: { marker: () => 'marker-1', read: () => '[]' },
    emit: { enterNode: () => {}, setPhase: () => {} },
    clock: { now: () => Date.now(), sleep: async () => {} },
    ...overrides,
  } as unknown as RunRuntime;

  runtimeRegistry.set(mockRuntime);
  return mockRuntime;
}

function makeSiteIn(): SiteIn {
  return {
    site: {
      id: 's1',
      name: 'Shop',
      domain: 'shop.test',
      goal: 'Find the price',
      goalKind: 'collect' as any,
      startUrl: 'https://shop.test/item',
      role: 'reference',
      kind: 'store',
      difficulty: 2,
      namedByUser: true,
      criteria: { fields: [{ name: 'price', required: true }], doneWhen: 'all_required' },
    },
    index: 1,
    total: 1,
    task: 'Collect price',
    taskKind: 'research',
    columns: ['price'],
    priceLike: true,
    compare: null,
    profile: { level: 'low', multiplier: 1, reflect: 'off', softCapAsk: false, blockedLadder: ['mark'], reservePct: 0.1 } as any,
    tier: 'large',
    limits: { maxSteps: 250 } as any,
    runId: 'run-tab-gone',
    alloc: 10,
    slackAvailable: 0,
    hardCapLeft: 100,
    stepBase: 0,
    systemActionBase: 0,
    parseErrorsBase: 0,
    everParsedOk: true,
    tabId: 101,
    cdp: { mode: 'synthetic' } as any,
    approvedDomains: ['shop.test'],
    blocked: [],
    visitedRecent: [],
    findingsLines: [],
    earlierSites: [],
    recap: [],
    priorFindings: [],
    planTexts: ['Find the price'],
  };
}

test('a tab_gone perceive error ends the site as failed with the fatal kind (BUG-24)', async () => {
  const threadId = 'test-tab-gone-worker';
  createMockRuntime(threadId);
  try {
    const worker = buildWorkerGraph(new MemorySaver());
    const cfg = { configurable: { thread_id: threadId }, recursionLimit: 100 };
    const finalState = (await worker.invoke(
      {
        siteIn: makeSiteIn(),
        siteRun: {
          siteId: 's1',
          spec: makeSiteIn().site,
          tabId: 101,
          alloc: 10,
          used: 0,
          extendedBy: 0,
          meterMode: 'normal',
          mode: 'browse',
          pageSigs: [],
          actionSigs: [],
          failureMemory: [],
          banned: [],
          blockedHits: 0,
          ladder: { waits: 0, reloads: 0, searchTried: false, searchEngine: null },
          stuckLevel: 0,
          userAnswers: [],
          findings: [],
          criteriaMet: false,
          suppressExtract: [],
          visited: [],
          blockedNew: [],
          approvedNew: [],
          anomalies: [],
          lastProgressStep: 0,
          consecutiveParseErrors: 0,
          parseErrors: 0,
          everParsedOk: true,
          systemActions: 0,
          modelCalls: 0,
          cdp: { attached: false, mode: 'synthetic', cdpUrl: null },
          midSiteReflected: false,
        } as any,
      },
      cfg,
    ) as WorkerStateT);

    const siteOut = buildSiteOut(finalState);
    assert.equal(siteOut.status, 'failed', `status was ${siteOut.status} (${siteOut.reason})`);
    assert.equal(siteOut.fatal, 'tab_gone');
    assert.match(siteOut.reason, /no longer exists/);
  } finally {
    runtimeRegistry.delete(threadId);
  }
});

// A proper plan object: the old bare-array fixture would now be a parse error that asks the
// model for a repair (planner-fallback-invented-plan), so the plan is spelled out here. It keeps
// the shape the old array reply produced for this task (research kind, page sites, value field).
const THREE_SITE_PLAN = JSON.stringify({
  task_kind: 'research',
  columns: ['value'],
  sites: [
    { domain: 'shop.test', name: 'shop.test: Find the price', goal: 'shop.test: Find the price', kind: 'page', required_fields: ['value'] },
    { domain: 'deal.test', name: 'deal.test: Find the deal', goal: 'deal.test: Find the deal', role: 'compare', kind: 'page', required_fields: ['value'] },
    { domain: 'third.test', name: 'third.test: Find the third', goal: 'third.test: Find the third', role: 'compare', kind: 'page', required_fields: ['value'] },
  ],
});

test('a closed tab skips the remaining sites instead of running them against the dead tab (BUG-24)', async (t) => {
  const PAGES: PageSpec[] = [
    { url: LIST, title: 'Items List', text: ['Item 42 available for 99 USD'], elements: [link('Item 42 Details', PRODUCT)] },
  ];
  const site = fakeDom({ pages: PAGES });
  const store: FakeStorage = createFakeStorage({
    local: { data: { agent_settings: { provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'test-model', maxSteps: 20, actionDelayMs: 1, effortDefault: 'low' } } },
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
  const llm = fakeLlm([THREE_SITE_PLAN]);
  const { AgentRunner } = await import('../../src/background/runner/AgentRunner.ts');
  const engine = new AgentRunner(101, 1, undefined, llm.port({ model: 'test-model' }));
  await engine.restorePromise;
  t.after(() => {
    engine.dispose();
    restoreChrome();
  });

  // The tab dies the moment the run starts: every snapshot of the run fails
  // with the tab_gone message. The fake DOM stays healthy - only the runner's
  // snapshot path is killed, through the same toPerceiveError mapping.
  (engine as any).runtime.browser.snapshot = async () => {
    throw new Error('Tab 101 no longer exists');
  };

  await engine.startTask('Check three shops', 101);

  // The run ends cleanly instead of pausing on an exhausted script: sites 2-3
  // never ran, so no further policy calls were needed.
  assert.equal(engine.status, 'idle', `status ${engine.status}, pauseReason ${(engine as any).pauseReason}, tail ${Logger.getLogsHistory().slice(-3).map((e) => e.message).join(' | ')}`);
  const policyPrompts = llm.calls.filter((c: any) => c.node === 'policy');
  const askedAboutOthers = policyPrompts.filter((c: any) => /deal\.test|third\.test/.test(String(c.messages?.map((m: any) => m.content).join(' ') ?? '')));
  assert.equal(askedAboutOthers.length, 0, 'the remaining sites must never be scheduled against the dead tab');
  const last = engine.history.at(-1) as any;
  assert.equal(last?.type, 'partial_result', JSON.stringify(last)?.slice(0, 200));
  assert.match(String(last?.answer), /tab was closed/i);
});

// The other half of the tab story: the run silently follows a tab its own click opened (the 500 ms
// switch in background.ts), and when that ADOPTED tab closes itself (a self-closing OAuth or
// payment pop-up) the next perceive used to raise the run-fatal tab_gone and ended the whole run,
// although the owner tab is still there. The run must fall back to the owner tab and continue.
test('an adopted tab that closes while the owner tab lives hands the run back to the owner tab', async (t) => {
  const rig = await graphRig({
    plan: JSON.stringify({
      taskKind: 'answer',
      sites: [{ id: 's1', name: 'shop.test', domain: 'shop.test', role: 'reference', kind: 'page', goal: 'Open the payment preview and read the confirmation code' }],
    }),
    policy: [
      act.click(1, 'Open the payment preview'),
      act.subgoalDone('The confirmation code is KX-4821.', 'Confirmation code: KX-4821'),
    ],
  });
  t.after(() => rig.cleanup());

  // While the engine runs the first action (the click that opens the pop-up), the pop-up is
  // adopted, the 500 ms switch moves the run into it, and the pop-up closes itself again - all
  // before the next perceive reads a page.
  let executes = 0;
  const rt = rig.runtime;
  const origExecute = rt.browser.execute.bind(rt.browser);
  (rt.browser as any).execute = async (tabId: number, action: any, opts: any) => {
    const res = await origExecute(tabId, action, opts);
    executes++;
    if (executes === 1) {
      rig.fc.tabs.add({ id: 700, windowId: 1, url: 'https://shop.test/popup', openerTabId: 101 });
      rig.runner.activeTabId = 700; // the 500 ms adoption switch
      rig.fc.tabs.close(700);       // the self-closing pop-up is gone again
    }
    return res;
  };

  await rig.start('Open the payment preview on this page and tell me the confirmation code shown after it closes.');

  assert.equal(rig.status(), 'idle', `status ${rig.status()}`);
  assert.equal(rig.entries('partial_result').length, 0, 'the run must not end as the fatal tab-gone partial result');
  assert.match(rig.finishAnswer() ?? '', /KX-4821/, 'the run continued on the owner tab and answered');
  const tabNotices = rig.entries('notice').filter((n: any) => n.kind === 'tab');
  assert.ok(
    tabNotices.some((n: any) => /closed/i.test(String(n.content)) && /\b101\b/.test(String(n.content))),
    `no fallback notice in the history, got ${JSON.stringify(tabNotices)}`
  );
  assert.equal(rt.tabs.activeTabId, 101, 'the working tab is the owner tab again');
});
