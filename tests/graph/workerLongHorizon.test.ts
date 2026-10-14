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
