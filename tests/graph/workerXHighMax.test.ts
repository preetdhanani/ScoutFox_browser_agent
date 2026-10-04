import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkerGraph, buildSiteOut } from '../../src/background/graph/worker.ts';
import { runtimeRegistry, type RunRuntime } from '../../src/background/runner/runtimeRegistry.ts';
import type { SiteIn, WorkerStateT } from '../../src/background/graph/workerState.ts';
import { MemorySaver } from '@langchain/langgraph';
import { Command } from '@langchain/langgraph';

function createMockRuntime(threadId: string, overrides: Partial<RunRuntime> = {}): RunRuntime {
  let llmCount = 0;
  const mockRuntime: RunRuntime = {
    threadId,
    ownerTabId: 101,
    bootId: 'boot-test-xhigh-max',
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
    settings: async () => ({
      provider: 'mock',
      model: 'mock-model',
      maxSteps: 250,
      customPrompts: {},
    } as any),
    llm: {
      complete: async () => {
        llmCount++;
        return {
          text: '{"thought": "Reflecting on progress: found 1/2 fields", "strategy": "search navigation menu"}',
          provider: 'mock',
          model: 'mock-model',
          meta: {},
          usage: { tokensIn: 50, tokensOut: 20 },
        };
      },
    },
    browser: {
      tabInfo: async () => ({
        url: 'https://shop.test/item',
        title: 'Shop Item Page',
        windowId: 1,
        groupId: 0,
        status: 'complete',
      }),
      snapshot: async () => ({
        docId: 'doc-xhigh-1',
        tabId: 101,
        url: 'https://shop.test/item',
        domain: 'shop.test',
        title: 'Shop Item Page',
        scrollY: 0,
        pageHeight: 1000,
        viewportHeight: 800,
        elementCount: 5,
        refs: [1, 2],
        elementsText: '[1] button "Search"\n[2] text "Item Details"',
        elementInfo: {
          '1': { role: 'button', label: 'Search' },
          '2': { role: 'text', label: 'Item Details' },
        },
        pageText: 'Item Details Price is 499 EUR',
        capturedAt: Date.now(),
      }),
      pageSig: async () => null,
      execute: async () => ({ success: true, mode: 'synthetic' } as any),
      navigate: async () => {},
      reload: async () => {},
      goBack: async () => {},
      waitForTabComplete: async () => {},
      waitDomQuiet: async () => {},
      cdp: {
        ensureAttached: async () => ({ mode: 'synthetic', reason: null }),
        detachAll: async () => {},
      },
      clearBadges: async () => {},
      isTabInScope: async () => true,
    },
    journal: {
      get: async () => null,
      begin: async () => {},
      finish: async () => {},
      clearRun: async () => {},
    },
    net: {
      marker: () => 'marker-1',
      read: () => '[]',
    },
    emit: {
      enterNode: () => {},
      setPhase: () => {},
    },
    clock: {
      now: () => Date.now(),
      sleep: async () => {},
    },
    ...overrides,
  };

  runtimeRegistry.set(mockRuntime);
  return mockRuntime;
}

function makeSiteIn(overrides: Partial<SiteIn['site']> = {}, profileOverrides: any = {}): SiteIn {
  return {
    site: {
      id: 'site-xhigh-1',
      name: 'Shop XHigh',
      domain: 'shop.test',
      goal: 'Find price and specs',
      goalKind: 'collect' as any,
      startUrl: 'https://shop.test/item',
      role: 'reference',
      kind: 'store',
      difficulty: 2,
      namedByUser: true,
      criteria: {
        fields: [{ name: 'price', required: true }],
        doneWhen: 'all_required',
      },
      ...overrides,
    },
    index: 1,
    total: 1,
    task: 'Collect price',
    taskKind: 'research',
    columns: ['price'],
    priceLike: true,
    compare: null,
    profile: {
      level: 'xhigh',
      multiplier: 4,
      reflect: 'mid_site',
      softCapAsk: true,
      blockedLadder: ['reload', 'wait_short', 'alt_search', 'alternate_entry', 'ask_user'],
      reservePct: 0.1,
      ...profileOverrides,
    } as any,
    tier: 'large',
    limits: { maxSteps: 250 } as any,
    runId: 'run-xhigh-1',
    alloc: 20,
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
  };
}

test('worker mid-site reflection - triggers at 50% budget when profile has mid_site reflection', async () => {
  const threadId = 'test-worker-midsite-reflect';
  let reflectCalled = false;
  createMockRuntime(threadId, {
    llm: {
      complete: async ({ role, system }: any) => {
        if (role === 'reflect' || (system && system.includes('supervisor'))) {
          reflectCalled = true;
          return {
            text: 'I have checked the main page but need to navigate to specifications.',
            provider: 'mock',
            model: 'mock-model',
            meta: {},
          };
        }
        return {
          text: '{"thought": "Look at specs", "action": "subgoal_done", "subgoal": "price found"}',
          provider: 'mock',
          model: 'mock-model',
          meta: {},
        };
      },
    },
  });

  try {
    const checkpointer = new MemorySaver();
    const worker = buildWorkerGraph(checkpointer);
    const siteIn = makeSiteIn({}, { reflect: 'mid_site' });

    // Start with used = 10 (which is >= 20 * 0.5), midSiteReflected = false
    const cfg = { configurable: { thread_id: threadId } };
    const finalState = await worker.invoke(
      {
        siteIn,
        siteRun: {
          siteId: 'site-xhigh-1',
          spec: siteIn.site,
          tabId: 101,
          alloc: 20,
          used: 10,
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
      cfg
    ) as WorkerStateT;

    assert.ok(reflectCalled, 'Mid-site reflection prompt should be called');
    assert.equal(finalState.siteRun?.midSiteReflected, true, 'midSiteReflected flag should be set');
    // Verify reflection did not increment action step count
    assert.ok((finalState.siteRun?.used ?? 0) <= 12, 'Action step count should not be wasted on reflection');
  } finally {
    runtimeRegistry.delete(threadId);
  }
});

test('worker human challenge hold - holds and resumes to perceive on resolved', async () => {
  const threadId = 'test-worker-challenge-hold';
  createMockRuntime(threadId, {
    browser: {
      tabInfo: async () => ({
        url: 'https://shop.test/captcha',
        title: 'Attention Required! | Cloudflare',
        windowId: 1,
        groupId: 0,
        status: 'complete',
      }),
      snapshot: async () => ({
        docId: 'doc-cf-1',
        tabId: 101,
        url: 'https://shop.test/captcha',
        domain: 'shop.test',
        title: 'Attention Required! | Cloudflare',
        scrollY: 0,
        pageHeight: 600,
        viewportHeight: 600,
        elementCount: 1,
        refs: [1],
        elementsText: '[1] checkbox "Verify you are human"',
        elementInfo: { '1': { role: 'checkbox', label: 'Verify you are human' } },
        pageText: 'Please verify you are a human to continue to shop.test. Cloudflare Ray ID: 12345',
        capturedAt: Date.now(),
      }),
      pageSig: async () => null,
      execute: async () => ({ success: true, mode: 'synthetic' } as any),
      navigate: async () => {},
      reload: async () => {},
      goBack: async () => {},
      waitForTabComplete: async () => {},
      waitDomQuiet: async () => {},
      cdp: {
        ensureAttached: async () => ({ mode: 'synthetic', reason: null }),
        detachAll: async () => {},
      },
      clearBadges: async () => {},
      isTabInScope: async () => true,
    },
  });

  try {
    const checkpointer = new MemorySaver();
    const worker = buildWorkerGraph(checkpointer);
    const siteIn = makeSiteIn({}, {
      blockedLadder: ['ask_user'],
    });

    const cfg = { configurable: { thread_id: threadId } };
    await worker.invoke({ siteIn }, cfg);

    const state = await worker.getState(cfg);
    assert.ok(state.tasks.some(t => t.interrupts && t.interrupts.length > 0), 'Should interrupt on challenge hold');
    const hold = (state.values as WorkerStateT).pendingHold;
    assert.ok(hold, 'Should have pendingHold');
    assert.equal(hold?.kind, 'challenge_help');
    assert.equal(hold?.domain, 'shop.test');

    // Resume with 'resolved'
    let perceiveCalledAfterResume = false;
    createMockRuntime(threadId, {
      browser: {
        tabInfo: async () => ({
          url: 'https://shop.test/item',
          title: 'Shop Item Page',
          windowId: 1,
          groupId: 0,
          status: 'complete',
        }),
        snapshot: async () => {
          perceiveCalledAfterResume = true;
          return {
            docId: 'doc-resumed-1',
            tabId: 101,
            url: 'https://shop.test/item',
            domain: 'shop.test',
            title: 'Shop Item Page',
            scrollY: 0,
            pageHeight: 800,
            viewportHeight: 800,
            elementCount: 1,
            refs: [1],
            elementsText: '[1] text "Price: 100 EUR"',
            elementInfo: { '1': { role: 'text', label: 'Price: 100 EUR' } },
            pageText: 'Price: 100 EUR',
            capturedAt: Date.now(),
          };
        },
        pageSig: async () => null,
        execute: async () => ({ success: true, mode: 'synthetic' } as any),
        navigate: async () => {},
        reload: async () => {},
        goBack: async () => {},
        waitForTabComplete: async () => {},
        waitDomQuiet: async () => {},
        cdp: {
          ensureAttached: async () => ({ mode: 'synthetic', reason: null }),
          detachAll: async () => {},
        },
        clearBadges: async () => {},
        isTabInScope: async () => true,
      },
      llm: {
        complete: async () => ({
          text: '{"thought": "Challenge solved, done", "action": "subgoal_done", "subgoal": "done"}',
          provider: 'mock',
          model: 'mock-model',
          meta: {},
        }),
      },
    });

    await worker.invoke(new Command({ resume: { action: 'resolved' } }), cfg);
    const postState = await worker.getState(cfg);
    assert.equal((postState.values as WorkerStateT).pendingHold, null, 'pendingHold should be cleared after resolution');
    assert.ok(perceiveCalledAfterResume, 'Worker should re-perceive page after challenge resolution');
  } finally {
    runtimeRegistry.delete(threadId);
  }
});

test('worker soft budget cap hold - pauses at budget cap and extends on continue', async () => {
  const threadId = 'test-worker-budget-hold';
  createMockRuntime(threadId);

  try {
    const checkpointer = new MemorySaver();
    const worker = buildWorkerGraph(checkpointer);
    const siteIn = makeSiteIn({}, { softCapAsk: true });

    const cfg = { configurable: { thread_id: threadId } };
    // Start with used = 20, alloc = 20, slackAvailable = 0, softCapReached = false
    await worker.invoke(
      {
        siteIn,
        siteRun: {
          siteId: 'site-xhigh-1',
          spec: siteIn.site,
          tabId: 101,
          alloc: 20,
          used: 20,
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
          midSiteReflected: true,
          softCapReached: false,
        } as any,
      },
      cfg
    );

    const state = await worker.getState(cfg);
    assert.ok(state.tasks.some(t => t.interrupts && t.interrupts.length > 0), 'Should interrupt on continue_budget hold');
    const hold = (state.values as WorkerStateT).pendingHold;
    assert.ok(hold, 'Should have pendingHold');
    assert.equal(hold?.kind, 'continue_budget');
    assert.equal(hold?.stepsUsed, 20);

    // Resume with continue and 10 additional steps
    await worker.invoke(new Command({ resume: { action: 'continue', additionalSteps: 10 } }), cfg);
    const postState = await worker.getState(cfg);
    const values = postState.values as WorkerStateT;
    assert.equal(values.pendingHold, null, 'pendingHold should be cleared');
    assert.equal(values.siteRun?.softCapReached, true, 'softCapReached should be marked true');
    assert.equal(values.siteRun?.alloc, 30, 'alloc should be extended by 10 steps');
  } finally {
    runtimeRegistry.delete(threadId);
  }
});

test('worker soft budget cap hold - finishes site when resumed with finish', async () => {
  const threadId = 'test-worker-budget-finish';
  createMockRuntime(threadId);

  try {
    const checkpointer = new MemorySaver();
    const worker = buildWorkerGraph(checkpointer);
    const siteIn = makeSiteIn({}, { softCapAsk: true });

    const cfg = { configurable: { thread_id: threadId } };
    await worker.invoke(
      {
        siteIn,
        siteRun: {
          siteId: 'site-xhigh-1',
          spec: siteIn.site,
          tabId: 101,
          alloc: 20,
          used: 20,
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
          midSiteReflected: true,
          softCapReached: false,
        } as any,
      },
      cfg
    );

    const state = await worker.getState(cfg);
    assert.ok(state.tasks.some(t => t.interrupts && t.interrupts.length > 0));

    // Resume with finish
    const finalState = await worker.invoke(new Command({ resume: { kind: 'finish' } }), cfg) as WorkerStateT;
    const out = buildSiteOut(finalState);
    assert.equal(out.status, 'partial');
    assert.ok(out.reason.includes('soft cap'));
  } finally {
    runtimeRegistry.delete(threadId);
  }
});

test('worker challenge help hold - exits site with partial status when resumed with skip', async () => {
  const threadId = 'test-worker-challenge-skip';
  createMockRuntime(threadId);

  try {
    const checkpointer = new MemorySaver();
    const worker = buildWorkerGraph(checkpointer);
    const siteIn = makeSiteIn({}, {
      blockedLadder: ['ask_user'],
    });

    const cfg = { configurable: { thread_id: threadId } };
    await worker.invoke({ siteIn }, cfg);

    const state = await worker.getState(cfg);
    assert.ok(state.tasks.some(t => t.interrupts && t.interrupts.length > 0));
    const hold = (state.values as WorkerStateT).pendingHold;
    assert.equal(hold?.kind, 'challenge_help');

    // Resume with 'skip'
    const finalState = await worker.invoke(new Command({ resume: { kind: 'skip' } }), cfg) as WorkerStateT;
    const out = buildSiteOut(finalState);
    assert.equal(out.status, 'partial');
    assert.ok(out.reason.includes('skipped'));
  } finally {
    runtimeRegistry.delete(threadId);
  }
});

test('worker soft budget cap hold - allows reaching alloc at 95% budget when softCapAsk enabled', async () => {
  const threadId = 'test-worker-budget-95-percent';
  createMockRuntime(threadId);

  try {
    const checkpointer = new MemorySaver();
    const worker = buildWorkerGraph(checkpointer);
    const siteIn = makeSiteIn({}, { softCapAsk: true });

    const cfg = { configurable: { thread_id: threadId } };
    // Start with used = 19, alloc = 20 (95% budget)
    await worker.invoke(
      {
        siteIn,
        siteRun: {
          siteId: 'site-xhigh-1',
          spec: siteIn.site,
          tabId: 101,
          alloc: 20,
          used: 19,
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
          midSiteReflected: true,
          softCapReached: false,
        } as any,
      },
      cfg
    );

    const state = await worker.getState(cfg);
    const values = state.values as WorkerStateT;
    assert.notEqual(values.siteRun?.exit?.status, 'partial');
  } finally {
    runtimeRegistry.delete(threadId);
  }
});

