import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkerGraph, buildSiteOut } from '../../src/background/graph/worker.ts';
import { runtimeRegistry, type RunRuntime } from '../../src/background/runner/runtimeRegistry.ts';
import type { SiteIn, WorkerStateT } from '../../src/background/graph/workerState.ts';

function createMockRuntime(threadId: string, overrides: Partial<RunRuntime> = {}): RunRuntime {
  let llmCallCount = 0;
  const mockRuntime: RunRuntime = {
    threadId,
    ownerTabId: 101,
    bootId: 'boot-test-1',
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
        llmCallCount++;
        return {
          text: '{"thought": "Found the price", "action": "record_finding", "values": {"price": "1.599 EUR"}}',
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
        docId: 'doc-123',
        tabId: 101,
        url: 'https://shop.test/item',
        domain: 'shop.test',
        title: 'Shop Item Page',
        scrollY: 0,
        pageHeight: 1000,
        viewportHeight: 800,
        elementCount: 5,
        refs: [1, 2, 3],
        elementsText: '[1] button "Buy"\n[2] text "1.599 EUR"',
        elementInfo: {
          '1': { role: 'button', label: 'Buy' },
          '2': { role: 'text', label: '1.599 EUR' },
        },
        pageText: 'Welcome to Shop Test. Framework 16 price is 1.599 EUR in stock today.',
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

  return mockRuntime;
}

test('workerLongHorizon: executes browse -> perceive -> policy -> record_finding -> criteria met', async () => {
  const threadId = 'test-worker-flow-1';
  const rt = createMockRuntime(threadId);
  runtimeRegistry.set(rt);

  try {
    const worker = buildWorkerGraph();

    const siteIn: SiteIn = {
      site: {
        id: 's1',
        name: 'Shop Test',
        domain: 'shop.test',
        goal: 'Find price for item',
        goalKind: 'collect',
        startUrl: 'https://shop.test/item',
        role: 'reference',
        kind: 'store',
        difficulty: 1,
        namedByUser: true,
        criteria: {
          fields: [{ name: 'price', required: true }],
          doneWhen: 'all_required',
        },
      },
      index: 1,
      total: 1,
      task: 'Find Framework Laptop 16 price',
      taskKind: 'research',
      columns: ['price'],
      priceLike: true,
      compare: null,
      profile: {
        level: 'Balanced',
        maxStepsPerSite: 20,
        verifyLevel: 'light',
        blockedLadder: ['reload', 'mark'],
        reflectPolicy: 'never',
      } as any,
      tier: 'small',
      limits: { maxSteps: 250 } as any,
      runId: 'run-test-1',
      alloc: 20,
      slackAvailable: 10,
      hardCapLeft: 200,
      stepBase: 0,
      systemActionBase: 0,
      parseErrorsBase: 0,
      everParsedOk: false,
      tabId: 101,
      cdp: { mode: 'synthetic', reason: null, sticky: false },
      approvedDomains: ['shop.test'],
      blocked: [],
      visitedRecent: [],
      findingsLines: [],
      earlierSites: [],
      recap: [],
      priorFindings: [],
    };

    const finalState = await worker.invoke(
      { siteIn },
      { configurable: { thread_id: threadId } }
    ) as WorkerStateT;

    assert.ok(finalState.siteRun);
    assert.equal(finalState.siteRun.criteriaMet, true);
    assert.equal(finalState.siteRun.findings.length, 1);
    assert.equal(finalState.siteRun.findings[0].field, 'price');
    assert.equal(finalState.siteRun.findings[0].quality, 'verified');
    assert.ok(finalState.siteRun.findings[0].evidence.snippet.includes('1.599 EUR'));

    const out = buildSiteOut(finalState);
    assert.equal(out.siteId, 's1');
    assert.equal(out.status, 'done');
    assert.equal(out.criteriaMet, true);
    assert.equal(out.findings.length, 1);
  } finally {
    runtimeRegistry.delete(threadId);
  }
});

test('workerLongHorizon: meterNode draws slack and switches to harvest when approaching budget', async () => {
  const threadId = 'test-worker-budget-1';
  let llmPromptSeen = '';
  const rt = createMockRuntime(threadId, {
    llm: {
      complete: async (call) => {
        llmPromptSeen = call.messages?.[0]?.content ?? '';
        return {
          text: '{"thought": "Harvesting remaining info", "action": "record_finding", "values": {"price": "1.599 EUR"}}',
          provider: 'mock',
          model: 'mock-model',
          meta: {},
        };
      },
    },
  });
  runtimeRegistry.set(rt);

  try {
    const worker = buildWorkerGraph();

    const siteIn: SiteIn = {
      site: {
        id: 's2',
        name: 'Shop Test 2',
        domain: 'shop.test',
        goal: 'Find price for item',
        goalKind: 'collect',
        startUrl: 'https://shop.test/item',
        role: 'reference',
        kind: 'store',
        difficulty: 1,
        namedByUser: true,
        criteria: {
          fields: [{ name: 'price', required: true }],
          doneWhen: 'all_required',
        },
      },
      index: 1,
      total: 1,
      task: 'Find Framework Laptop 16 price',
      taskKind: 'research',
      columns: ['price'],
      priceLike: true,
      compare: null,
      profile: {
        level: 'Balanced',
        maxStepsPerSite: 10,
        verifyLevel: 'light',
        blockedLadder: ['reload', 'mark'],
        reflectPolicy: 'never',
      } as any,
      tier: 'small',
      limits: { maxSteps: 250 } as any,
      runId: 'run-test-1',
      alloc: 10,
      slackAvailable: 5,
      hardCapLeft: 100,
      stepBase: 0,
      systemActionBase: 0,
      parseErrorsBase: 0,
      everParsedOk: false,
      tabId: 101,
      cdp: { mode: 'synthetic', reason: null, sticky: false },
      approvedDomains: ['shop.test'],
      blocked: [],
      visitedRecent: [],
      findingsLines: [],
      earlierSites: [],
      recap: [],
      priorFindings: [],
    };

    // Pre-populate siteRun with used = 10 (at 100% of alloc) and progress
    const finalState = await worker.invoke(
      {
        siteIn,
        siteRun: {
          siteId: 's2',
          spec: siteIn.site,
          tabId: 101,
          alloc: 10,
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
          lastProgressStep: 9, // fresh progress within 3 steps
          consecutiveParseErrors: 0,
          parseErrors: 0,
          everParsedOk: true,
          systemActions: 0,
          modelCalls: 1,
          cdp: { attached: false, mode: 'synthetic', cdpUrl: null },
        } as any,
      },
      { configurable: { thread_id: threadId } }
    ) as WorkerStateT;

    assert.ok(finalState.siteRun);
    // Slack should have been drawn: 10 + 3 = 13 alloc
    assert.equal(finalState.siteRun.extendedBy, 3);
    assert.equal(finalState.siteRun.alloc, 13);
  } finally {
    runtimeRegistry.delete(threadId);
  }
});

test('workerLongHorizon: challenge page triggers blockedNode and ladder escalation', async () => {
  const threadId = 'test-worker-blocked-1';
  let reloaded = false;
  const rt = createMockRuntime(threadId, {
    browser: {
      tabInfo: async () => ({
        url: 'https://protected.test/item',
        title: 'Just a moment...',
        windowId: 1,
        groupId: 0,
        status: 'complete',
      }),
      snapshot: async () => ({
        docId: 'doc-challenge',
        tabId: 101,
        url: 'https://protected.test/item',
        domain: 'protected.test',
        title: 'Just a moment...',
        scrollY: 0,
        pageHeight: 500,
        viewportHeight: 500,
        elementCount: 2,
        refs: [1],
        elementsText: '[1] text "Verifying you are human"',
        elementInfo: { '1': { role: 'text', label: 'Verifying you are human' } },
        pageText: 'Checking your browser before accessing protected.test.',
        capturedAt: Date.now(),
      }),
      pageSig: async () => null,
      execute: async () => ({ success: true, mode: 'synthetic' } as any),
      navigate: async () => {},
      reload: async () => {
        reloaded = true;
      },
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
  runtimeRegistry.set(rt);

  try {
    const worker = buildWorkerGraph();

    const siteIn: SiteIn = {
      site: {
        id: 's3',
        name: 'Protected Site',
        domain: 'protected.test',
        goal: 'Find price for item',
        goalKind: 'collect',
        startUrl: 'https://protected.test/item',
        role: 'reference',
        kind: 'store',
        difficulty: 2,
        namedByUser: true,
        criteria: {
          fields: [{ name: 'price', required: true }],
          doneWhen: 'all_required',
        },
      },
      index: 1,
      total: 1,
      task: 'Find price',
      taskKind: 'research',
      columns: ['price'],
      priceLike: true,
      compare: null,
      profile: {
        level: 'Balanced',
        maxStepsPerSite: 10,
        verifyLevel: 'light',
        blockedLadder: ['reload', 'mark'],
        reflectPolicy: 'never',
      } as any,
      tier: 'small',
      limits: { maxSteps: 250 } as any,
      runId: 'run-test-1',
      alloc: 10,
      slackAvailable: 0,
      hardCapLeft: 100,
      stepBase: 0,
      systemActionBase: 0,
      parseErrorsBase: 0,
      everParsedOk: false,
      tabId: 101,
      cdp: { mode: 'synthetic', reason: null, sticky: false },
      approvedDomains: ['protected.test'],
      blocked: [],
      visitedRecent: [],
      findingsLines: [],
      earlierSites: [],
      recap: [],
      priorFindings: [],
    };

    // Pre-populate with blockedHits = 2, so next hit becomes 3 and routes to end_blocked
    const finalState = await worker.invoke(
      {
        siteIn,
        siteRun: {
          siteId: 's3',
          spec: siteIn.site,
          tabId: 101,
          alloc: 10,
          used: 2,
          extendedBy: 0,
          meterMode: 'normal',
          mode: 'browse',
          pageSigs: [],
          actionSigs: [],
          failureMemory: [],
          banned: [],
          blockedHits: 2,
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
          everParsedOk: false,
          systemActions: 0,
          modelCalls: 0,
          cdp: { attached: false, mode: 'synthetic', cdpUrl: null },
        } as any,
      },
      { configurable: { thread_id: threadId } }
    ) as WorkerStateT;

    assert.ok(finalState.siteRun);
    assert.equal(finalState.siteRun.blockedHits, 3);
    const out = buildSiteOut(finalState);
    assert.equal(out.status, 'blocked');
    assert.equal(out.blocked.length, 1);
    assert.equal(out.blocked[0].domain, 'protected.test');
  } finally {
    runtimeRegistry.delete(threadId);
  }
});

test('workerLongHorizon: a repeated perceive of the same page does not append a duplicate step_start row', async () => {
  // The e2e bot-check run showed the same step_start row twice: the reload rung of the blocked
  // ladder sends the worker back to perceive, and the second read of the still-challenged page
  // (same URL, same title, same step number, because no step was used) appended an exact copy.
  const threadId = 'test-worker-stepstart-dedupe';
  let snapshotCount = 0;
  const rt = createMockRuntime(threadId, {
    browser: {
      tabInfo: async () => ({
        url: 'https://protected.test/item',
        title: 'Just a moment...',
        windowId: 1,
        groupId: 0,
        status: 'complete',
      }),
      snapshot: async () => {
        snapshotCount++;
        return {
          docId: 'doc-challenge',
          tabId: 101,
          url: 'https://protected.test/item',
          domain: 'protected.test',
          title: 'Just a moment...',
          scrollY: 0,
          pageHeight: 500,
          viewportHeight: 500,
          elementCount: 2,
          refs: [1],
          elementsText: '[1] text "Verifying you are human"',
          elementInfo: { '1': { role: 'text', label: 'Verifying you are human' } },
          pageText: 'Checking your browser before accessing protected.test.',
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
  });
  runtimeRegistry.set(rt);

  try {
    const worker = buildWorkerGraph();
    const siteIn: SiteIn = {
      site: {
        id: 's3',
        name: 'Protected Site',
        domain: 'protected.test',
        goal: 'Find price for item',
        goalKind: 'collect',
        startUrl: 'https://protected.test/item',
        role: 'reference',
        kind: 'store',
        difficulty: 2,
        namedByUser: true,
        criteria: {
          fields: [{ name: 'price', required: true }],
          doneWhen: 'all_required',
        },
      },
      index: 1,
      total: 1,
      task: 'Find price',
      taskKind: 'research',
      columns: ['price'],
      priceLike: true,
      compare: null,
      profile: {
        level: 'Balanced',
        maxStepsPerSite: 10,
        verifyLevel: 'light',
        blockedLadder: ['reload', 'mark'],
        reflectPolicy: 'never',
      } as any,
      tier: 'small',
      limits: { maxSteps: 250 } as any,
      runId: 'run-test-1',
      alloc: 10,
      slackAvailable: 0,
      hardCapLeft: 100,
      stepBase: 0,
      systemActionBase: 0,
      parseErrorsBase: 0,
      everParsedOk: false,
      tabId: 101,
      cdp: { mode: 'synthetic', reason: null, sticky: false },
      approvedDomains: ['protected.test'],
      blocked: [],
      visitedRecent: [],
      findingsLines: [],
      earlierSites: [],
      recap: [],
      priorFindings: [],
    };

    const finalState = await worker.invoke(
      {
        siteIn,
        siteRun: {
          siteId: 's3',
          spec: siteIn.site,
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
          everParsedOk: false,
          systemActions: 0,
          modelCalls: 0,
          cdp: { attached: false, mode: 'synthetic', cdpUrl: null },
        } as any,
      },
      { configurable: { thread_id: threadId } }
    ) as WorkerStateT;

    // Both perceive rounds ran (reload rung, then the mark rung), but the panel history holds
    // the row of the page only once.
    assert.equal(snapshotCount, 2, 'the worker perceived the challenged page twice');
    const stepStartRows = (finalState.history ?? []).filter((h: any) => h.type === 'step_start');
    assert.equal(stepStartRows.length, 1, `expected one step_start row, got ${stepStartRows.length}`);

    const out = buildSiteOut(finalState);
    assert.equal(out.status, 'blocked');
  } finally {
    runtimeRegistry.delete(threadId);
  }
});

test('workerLongHorizon: a step_start row with new facts is kept even when it repeats', async () => {
  // The guard must only swallow EXACT copies. When the reload let the real page through, the new
  // title and element count are progress the panel must show.
  const threadId = 'test-worker-stepstart-progress';
  let snapshotCount = 0;
  const rt = createMockRuntime(threadId, {
    browser: {
      tabInfo: async () => ({
        url: 'https://protected.test/item',
        title: 'Just a moment...',
        windowId: 1,
        groupId: 0,
        status: 'complete',
      }),
      snapshot: async () => {
        snapshotCount++;
        const passed = snapshotCount > 1;
        return {
          docId: 'doc-challenge',
          tabId: 101,
          url: 'https://protected.test/item',
          domain: 'protected.test',
          title: passed ? 'Shop Item Page' : 'Just a moment...',
          scrollY: 0,
          pageHeight: 500,
          viewportHeight: 500,
          elementCount: passed ? 14 : 2,
          refs: [1],
          elementsText: passed ? '[1] text "Framework Laptop 16"' : '[1] text "Verifying you are human"',
          elementInfo: passed
            ? { '1': { role: 'text', label: 'Framework Laptop 16' } }
            : { '1': { role: 'text', label: 'Verifying you are human' } },
          pageText: passed ? 'Framework Laptop 16 for 1.399,00 EUR.' : 'Checking your browser before accessing protected.test.',
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
  });
  runtimeRegistry.set(rt);

  try {
    const worker = buildWorkerGraph();
    const siteIn: SiteIn = {
      site: {
        id: 's3',
        name: 'Protected Site',
        domain: 'protected.test',
        goal: 'Find price for item',
        goalKind: 'collect',
        startUrl: 'https://protected.test/item',
        role: 'reference',
        kind: 'store',
        difficulty: 2,
        namedByUser: true,
        criteria: {
          fields: [{ name: 'price', required: true }],
          doneWhen: 'all_required',
        },
      },
      index: 1,
      total: 1,
      task: 'Find price',
      taskKind: 'research',
      columns: ['price'],
      priceLike: true,
      compare: null,
      profile: {
        level: 'Balanced',
        maxStepsPerSite: 10,
        verifyLevel: 'light',
        blockedLadder: ['reload', 'mark'],
        reflectPolicy: 'never',
      } as any,
      tier: 'small',
      limits: { maxSteps: 250 } as any,
      runId: 'run-test-1',
      alloc: 10,
      slackAvailable: 0,
      hardCapLeft: 100,
      stepBase: 0,
      systemActionBase: 0,
      parseErrorsBase: 0,
      everParsedOk: false,
      tabId: 101,
      cdp: { mode: 'synthetic', reason: null, sticky: false },
      approvedDomains: ['protected.test'],
      blocked: [],
      visitedRecent: [],
      findingsLines: [],
      earlierSites: [],
      recap: [],
      priorFindings: [],
    };

    const finalState = await worker.invoke(
      {
        siteIn,
        siteRun: {
          siteId: 's3',
          spec: siteIn.site,
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
          everParsedOk: false,
          systemActions: 0,
          modelCalls: 0,
          cdp: { attached: false, mode: 'synthetic', cdpUrl: null },
        } as any,
      },
      { configurable: { thread_id: threadId } }
    ) as WorkerStateT;

    const stepStartRows = (finalState.history ?? []).filter((h: any) => h.type === 'step_start');
    for (let i = 1; i < stepStartRows.length; i++) {
      const a = stepStartRows[i - 1];
      const b = stepStartRows[i];
      const identical = (a as any).step === (b as any).step && (a as any).url === (b as any).url && (a as any).pageTitle === (b as any).pageTitle
        && (a as any).elementCount === (b as any).elementCount && (a as any).siteId === (b as any).siteId && (a as any).mode === (b as any).mode;
      assert.ok(!identical, `history holds two identical consecutive step_start rows at positions ${i - 1}/${i}`);
    }
    assert.ok(stepStartRows.some((r: any) => r.pageTitle === 'Shop Item Page'), 'the passed page appears in the history');
  } finally {
    runtimeRegistry.delete(threadId);
  }
});

// ---------------------------------------------------------------------------
// W2-2 in-run memory window (ticket p1-context-memory-in-run-memory-window)
// ---------------------------------------------------------------------------

function w2SiteIn(overrides: Partial<SiteIn> = {}): SiteIn {
  return {
    site: {
      id: 's9',
      name: 'Shop Test',
      domain: 'shop.test',
      goal: 'Find the price for item',
      goalKind: 'collect',
      startUrl: 'https://shop.test/item',
      role: 'reference',
      kind: 'store',
      difficulty: 1,
      namedByUser: true,
      criteria: { fields: [{ name: 'value', required: true }], doneWhen: 'all_required' },
    },
    index: 1,
    total: 1,
    task: 'Find the price for item',
    taskKind: 'research',
    columns: ['value'],
    priceLike: false,
    compare: null,
    profile: {
      level: 'Balanced',
      maxStepsPerSite: 20,
      verifyLevel: 'light',
      blockedLadder: ['reload', 'mark'],
      reflectPolicy: 'never',
    } as any,
    tier: 'small',
    limits: { maxSteps: 250 } as any,
    runId: 'run-w2-2',
    alloc: 20,
    slackAvailable: 0,
    hardCapLeft: 200,
    stepBase: 0,
    systemActionBase: 0,
    parseErrorsBase: 0,
    everParsedOk: false,
    tabId: 101,
    cdp: { mode: 'synthetic', reason: null, sticky: false },
    approvedDomains: ['shop.test'],
    blocked: [],
    visitedRecent: [],
    findingsLines: [],
    earlierSites: [],
    recap: [],
    priorFindings: [],
    ...overrides,
  };
}

function w2Snapshot(url: string, pageText: string): any {
  return {
    docId: 'doc-w2',
    tabId: 101,
    url,
    domain: 'shop.test',
    title: 'Shop Item Page',
    scrollY: 0,
    pageHeight: 1000,
    viewportHeight: 800,
    elementCount: 3,
    refs: [1, 2, 3],
    elementsText: '[1] button "Filter A"\n[2] button "Filter B"\n[3] text "note"',
    elementInfo: {
      '1': { role: 'button', label: 'Filter A' },
      '2': { role: 'button', label: 'Filter B' },
      '3': { role: 'text', label: 'note' },
    },
    pageText,
    capturedAt: Date.now(),
  };
}

function w2ReadOneShot(part: number, ofParts: number): any {
  const note = `${ofParts * 3000} chars, part ${part} of ${ofParts}, chars ${part * 3000 + 1}-${(part + 1) * 3000}`;
  return {
    label: `Page Text (${note})`,
    text: `READCHUNK-${part}-MARKER the shrine chamber detail lives in this part of the text.`,
    note,
    step: 0,
  };
}

function reply(text: string): any {
  return { text, provider: 'mock', model: 'mock-model', meta: {} };
}

test('workerLongHorizon W2-2: the step 12 prompt folds older site steps into one line and keeps earlier read chunks', async () => {
  for (const tier of ['small', 'large'] as const) {
    const threadId = `test-worker-fold-${tier}`;
    const prompts: Array<{ system: string; user: string }> = [];
    let call = 0;
    let reads = 0;
    let currentUrl = 'https://shop.test/item';
    const rt = createMockRuntime(threadId, {
      llm: {
        complete: async (c: any) => {
          call++;
          prompts.push({ system: String(c?.system ?? ''), user: String(c?.messages?.[0]?.content ?? '') });
          if (call <= 12) return reply('{"action": "read_page_text"}');
          if (call === 13) return reply('{"action": "navigate", "url": "https://shop.test/other"}');
          if (call === 14) return reply('{"action": "read_page_text"}');
          return reply('{"action": "mark_not_found", "reason": "not on this site"}');
        },
      },
      browser: {
        tabInfo: async () => ({ url: currentUrl, title: 'Shop Item Page', windowId: 1, groupId: 0, status: 'complete' }),
        snapshot: async () => w2Snapshot(currentUrl, 'Welcome to Shop Test. The item is in stock today.'),
        pageSig: async () => null,
        execute: async (_tabId: number, action: any) => {
          if (action?.action === 'read_page_text') {
            reads++;
            return { success: true, via: 'cdp', effect: 'none', oneShot: w2ReadOneShot(reads, 30) };
          }
          if (action?.action === 'navigate') {
            currentUrl = String(action.url ?? currentUrl);
            return { success: true, via: 'background', effect: 'url_changed' };
          }
          return { success: true, via: 'cdp', effect: 'none' };
        },
        navigate: async () => {},
        reload: async () => {},
        goBack: async () => {},
        waitForTabComplete: async () => {},
        waitDomQuiet: async () => {},
        cdp: { ensureAttached: async () => ({ mode: 'synthetic', reason: null }), detachAll: async () => {} },
        clearBadges: async () => {},
        isTabInScope: async () => true,
      },
    });
    runtimeRegistry.set(rt);

    try {
      const worker = buildWorkerGraph();
      await worker.invoke({ siteIn: w2SiteIn({ tier }) }, { configurable: { thread_id: threadId }, recursionLimit: 400 });

      // The 12th policy call: 11 step records exist, so the steps older than the
      // tier window (6 small, 10 large) must be folded into one digest line.
      const step12 = prompts[11];
      assert.ok(step12, `the worker made at least 12 policy calls (tier ${tier}, made ${prompts.length})`);
      assert.ok(step12.user.includes('EARLIER ON THIS SITE'), `step 12 prompt has no fold line (tier ${tier}):\n${step12.user.slice(-2000)}`);
      if (tier === 'small') assert.ok(step12.user.includes('5x read_page_text'), 'the fold line counts the older read_page_text steps');

      // The recent-steps window scales with the tier.
      const recentBlock = step12.user.split('RECENT STEPS:\n')[1]?.split('\n\n')[0] ?? '';
      const stepLines = recentBlock.split('\n').filter((l) => l.startsWith('#'));
      assert.equal(stepLines.length, tier === 'small' ? 6 : 10, `recent steps window for tier ${tier}`);

      // The reads of this page stay available as the TEXT YOU READ block: at call 12 the
      // one-shot shows chunk 11, so the block must hold chunks 9 and 10.
      assert.ok(step12.user.includes('TEXT YOU READ'), 'the step 12 prompt has a TEXT YOU READ block');
      assert.ok(step12.user.includes('READCHUNK-9-MARKER'), 'chunk 9 is still readable at step 12');
      assert.ok(step12.user.includes('READCHUNK-10-MARKER'), 'chunk 10 is still readable at step 12');

      // After the navigate the page changed, so the block and its chunks are gone.
      const afterNav = prompts[13];
      assert.ok(afterNav, 'the worker made at least 14 policy calls');
      assert.ok(!afterNav.user.includes('TEXT YOU READ'), 'the TEXT YOU READ block cleared after the page changed');
      assert.ok(!afterNav.user.includes('READCHUNK-9-MARKER'), 'the old chunk text is gone after the page changed');
    } finally {
      runtimeRegistry.delete(threadId);
    }
  }
});

test('workerLongHorizon W2-2: answer mode answers from the TEXT YOU READ block when the fact was read in an earlier chunk', async () => {
  const threadId = 'test-worker-answer-chunks';
  const prompts: Array<{ system: string; user: string }> = [];
  let call = 0;
  let reads = 0;
  const rt = createMockRuntime(threadId, {
    llm: {
      complete: async (c: any) => {
        call++;
        prompts.push({ system: String(c?.system ?? ''), user: String(c?.messages?.[0]?.content ?? '') });
        if (call <= 3) return reply('{"action": "read_page_text"}');
        return reply('{"thought": "I read the fact in an earlier chunk", "action": "finish", "answer": "The shrine chamber lies deep under the terrace."}');
      },
    },
    browser: {
      tabInfo: async () => ({ url: 'https://shop.test/item', title: 'Shop Item Page', windowId: 1, groupId: 0, status: 'complete' }),
      snapshot: async () => w2Snapshot('https://shop.test/item', 'Welcome to Shop Test. The item is in stock today.'),
      pageSig: async () => null,
      execute: async (_tabId: number, action: any) => {
        if (action?.action === 'read_page_text') {
          reads++;
          return { success: true, via: 'cdp', effect: 'none', oneShot: w2ReadOneShot(reads, 30) };
        }
        return { success: true, via: 'cdp', effect: 'none' };
      },
      navigate: async () => {},
      reload: async () => {},
      goBack: async () => {},
      waitForTabComplete: async () => {},
      waitDomQuiet: async () => {},
      cdp: { ensureAttached: async () => ({ mode: 'synthetic', reason: null }), detachAll: async () => {} },
      clearBadges: async () => {},
      isTabInScope: async () => true,
    },
  });
  runtimeRegistry.set(rt);

  try {
    const worker = buildWorkerGraph();
    const siteRun = {
      siteId: 's9',
      spec: w2SiteIn().site,
      tabId: 101,
      alloc: 40,
      used: 33,
      extendedBy: 0,
      meterMode: 'normal' as const,
      mode: 'browse' as const,
      pageSigs: [],
      actionSigs: [],
      failureMemory: [],
      banned: [],
      blockedHits: 0,
      ladder: { waits: 0, reloads: 0, searchTried: false, searchEngine: null },
      stuckLevel: 0 as const,
      userAnswers: [],
      findings: [],
      criteriaMet: false,
      suppressExtract: [],
      visited: [],
      blockedNew: [],
      approvedNew: [],
      anomalies: [],
      lastProgressStep: 30,
      noProgressRecords: 0,
      consecutiveParseErrors: 0,
      parseErrors: 0,
      everParsedOk: true,
      systemActions: 0,
      modelCalls: 0,
      cdp: { mode: 'synthetic', reason: null, sticky: false },
    } as any;

    await worker.invoke({ siteIn: w2SiteIn({ site: { ...w2SiteIn().site, goalKind: 'answer' }, taskKind: 'answer', columns: [], priceLike: false }), siteRun }, { configurable: { thread_id: threadId }, recursionLimit: 200 });

    // The 4th policy call decides the finish: the one-shot holds chunk 3, so the fact read in
    // chunk 1 must come from the TEXT YOU READ block.
    const finishCall = prompts[3];
    assert.ok(finishCall, `the worker made at least 4 policy calls (made ${prompts.length})`);
    assert.ok(finishCall.system.includes("Answer the user's task"), 'the finish call ran in answer mode');
    assert.ok(finishCall.user.includes('TEXT YOU READ'), 'the answer-mode prompt has a TEXT YOU READ block');
    assert.ok(finishCall.user.includes('READCHUNK-1-MARKER'), 'the chunk 1 fact is available in the answer-mode context');
    assert.ok(finishCall.user.includes('READCHUNK-2-MARKER'), 'the chunk 2 text is available in the answer-mode context');
  } finally {
    runtimeRegistry.delete(threadId);
  }
});

test('workerLongHorizon W2-2: an A-B-A-B click alternation raises the stuck warning and ends before the cap', async () => {
  const threadId = 'test-worker-alternation';
  let call = 0;
  let snaps = 0;
  const rt = createMockRuntime(threadId, {
    llm: {
      complete: async () => {
        call++;
        const id = call % 2 === 1 ? 1 : 2;
        return reply(`{"thought": "try the other filter", "action": "click", "element_id": ${id}}`);
      },
    },
    browser: {
      tabInfo: async () => ({ url: 'https://shop.test/item', title: 'Shop Item Page', windowId: 1, groupId: 0, status: 'complete' }),
      snapshot: async () => {
        snaps++;
        // Every click has an effect, so the page text alternates and the unchanged-page
        // checks never fire; only the alternation check can catch this loop.
        const text = snaps % 2 === 1 ? 'The list shows the unfiltered offers.' : 'The list shows the filtered offers.';
        return w2Snapshot('https://shop.test/item', text);
      },
      pageSig: async () => null,
      execute: async () => ({ success: true, via: 'cdp', effect: 'dom_changed' }),
      navigate: async () => {},
      reload: async () => {},
      goBack: async () => {},
      waitForTabComplete: async () => {},
      waitDomQuiet: async () => {},
      cdp: { ensureAttached: async () => ({ mode: 'synthetic', reason: null }), detachAll: async () => {} },
      clearBadges: async () => {},
      isTabInScope: async () => true,
    },
  });
  runtimeRegistry.set(rt);

  try {
    const worker = buildWorkerGraph();
    const finalState = await worker.invoke({ siteIn: w2SiteIn() }, { configurable: { thread_id: threadId }, recursionLimit: 200 }) as WorkerStateT;

    const failures = finalState.siteRun?.failureMemory ?? [];
    assert.ok(
      failures.some((f) => String(f.detail).includes('alternat')),
      `the alternation loop raised the stuck warning (failures: ${JSON.stringify(failures)})`
    );
    assert.ok(finalState.siteRun?.banned?.includes('click|1|'), 'the first alternating signature is banned');
    assert.ok(finalState.siteRun?.banned?.includes('click|2|'), 'the second alternating signature is banned');
    assert.ok(finalState.siteRun?.exit, 'the site ended instead of running to the cap');
    assert.ok((finalState.siteRun?.used ?? 0) < 20, `the site ended before the cap (used ${finalState.siteRun?.used})`);
  } finally {
    runtimeRegistry.delete(threadId);
  }
});
