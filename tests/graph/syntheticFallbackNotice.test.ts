// tests/graph/syntheticFallbackNotice.test.ts
// cdp-synthetic-fallback: when input drops from trusted CDP events to synthetic DOM events, the
// model and the user used to hear nothing: the step record had no via, StepFailure.fallbackUsed
// was never set, and no panel notice appeared. These tests pin the three signals.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkerGraph } from '../../src/background/graph/worker.ts';
import { runtimeRegistry, type RunRuntime } from '../../src/background/runner/runtimeRegistry.ts';
import type { SiteIn, WorkerStateT } from '../../src/background/graph/workerState.ts';

const PAGE_TEXT = 'Item 42 details. In Stock. Ships in three days.';

function createMockRuntime(threadId: string, executeResults: Array<Record<string, unknown>>, replies: string[]): RunRuntime {
  let executeCall = 0;
  let llmCallCount = 0;
  const mockRuntime: RunRuntime = {
    threadId,
    ownerTabId: 101,
    bootId: 'boot-test-synthetic',
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
        const text = replies[Math.min(llmCallCount, replies.length - 1)];
        llmCallCount++;
        return { text, provider: 'mock', model: 'mock-model', meta: {}, usage: { tokensIn: 50, tokensOut: 20 } };
      },
    },
    browser: {
      tabInfo: async () => ({
        url: 'https://shop.test/items',
        title: 'Items List',
        windowId: 1,
        groupId: 0,
        status: 'complete',
      }),
      snapshot: async () => ({
        docId: 'doc-shop',
        tabId: 101,
        url: 'https://shop.test/items',
        domain: 'shop.test',
        title: 'Items List',
        scrollY: 0,
        pageHeight: 1000,
        viewportHeight: 800,
        elementCount: 2,
        refs: [1, 2],
        elementsText: '[1] link "Item 42 Details"\n[2] text "Price: 99 USD"',
        elementInfo: {
          '1': { role: 'link', label: 'Item 42 Details' },
          '2': { role: 'text', label: 'Price: 99 USD' },
        },
        pageText: PAGE_TEXT,
        capturedAt: Date.now(),
      }),
      pageSig: async () => null,
      execute: async () => {
        const result = executeResults[Math.min(executeCall, executeResults.length - 1)];
        executeCall++;
        return result as any;
      },
      navigate: async () => {},
      reload: async () => {},
      goBack: async () => {},
      waitForTabComplete: async () => {},
      waitDomQuiet: async () => {},
      cdp: {
        ensureAttached: async () => ({ mode: 'cdp', reason: null }),
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
      marker: () => 'marker-synthetic',
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
  };
  return mockRuntime;
}

function shopSiteIn(overrides: Partial<SiteIn> = {}): SiteIn {
  return {
    site: {
      id: 's1',
      name: 'shop.test',
      domain: 'shop.test',
      goal: 'Find the price of item 42',
      goalKind: 'collect',
      startUrl: 'https://shop.test/items',
      role: 'reference',
      kind: 'page',
      difficulty: 1,
      namedByUser: true,
      criteria: {
        fields: [{ name: 'price', required: true }],
        doneWhen: 'all_required',
      },
    },
    index: 1,
    total: 1,
    task: 'Find the price of item 42 on shop.test',
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
    runId: 'run-synthetic-notice',
    alloc: 20,
    slackAvailable: 0,
    hardCapLeft: 200,
    stepBase: 0,
    systemActionBase: 0,
    parseErrorsBase: 0,
    everParsedOk: false,
    tabId: 101,
    cdp: { mode: 'cdp', reason: null, sticky: false },
    approvedDomains: ['shop.test'],
    blocked: [],
    visitedRecent: [],
    findingsLines: [],
    earlierSites: [],
    recap: [],
    priorFindings: [],
    ...overrides,
  } as SiteIn;
}

const clickReply = '{"thought": "Open the product page", "action": "click", "element_id": 1, "reason": "Open it"}';
const finishReply = '{"thought": "Done", "action": "finish", "answer": "The price is 99 USD."}';

test('syntheticFallbackNotice: one panel notice per site when input drops to synthetic, and the step record says via synthetic', async () => {
  const threadId = 'test-synthetic-notice';
  const rt = createMockRuntime(
    threadId,
    [
      { success: true, via: 'synthetic', effect: 'none', message: 'Clicked element [1]', syntheticReason: 'debugger could not attach: not permitted' },
      { success: true, via: 'synthetic', effect: 'none', message: 'Clicked element [1]', syntheticReason: 'debugger could not attach: not permitted' },
    ],
    [clickReply, clickReply, finishReply]
  );
  runtimeRegistry.set(rt);

  try {
    const worker = buildWorkerGraph();
    const finalState = await worker.invoke(
      { siteIn: shopSiteIn() },
      { configurable: { thread_id: threadId } }
    ) as WorkerStateT;

            const notices = finalState.history.filter((h: any) => h.type === 'notice' && h.kind === 'cdp');
    assert.equal(notices.length, 1, `exactly one downgrade notice per site, got ${notices.length}`);
    assert.match(String((notices[0] as any)?.content), /Using page-level clicks/);
    assert.match(String((notices[0] as any)?.content), /debugger could not attach/);

    const clickRecords = finalState.steps.filter((s: any) => s.verb === 'click');
    assert.ok(clickRecords.length >= 1);
    for (const rec of clickRecords) {
      assert.equal(rec.via, 'synthetic', 'the step record carries via');
      assert.match(rec.line, /synthetic: debugger could not attach/, `the model-visible step line names the synthetic reason, got: ${rec.line}`);
    }

    // The site cdp state flipped to synthetic and sticks, so later steps stay quiet.
    assert.equal(finalState.siteRun?.cdp.mode, 'synthetic');
    assert.equal(finalState.siteRun?.cdp.sticky, true);
  } finally {
    runtimeRegistry.delete(threadId);
  }
});

test('syntheticFallbackNotice: a failed synthetic action sets StepFailure.fallbackUsed', async () => {
  const threadId = 'test-synthetic-fallback-used';
  const rt = createMockRuntime(
    threadId,
    [
      { success: false, via: 'synthetic', effect: 'none', error: 'Synthetic action execution failed.', syntheticReason: 'debugger could not attach: not permitted' },
    ],
    [clickReply, finishReply]
  );
  runtimeRegistry.set(rt);

  try {
    const worker = buildWorkerGraph();
    const finalState = await worker.invoke(
      { siteIn: shopSiteIn() },
      { configurable: { thread_id: threadId } }
    ) as WorkerStateT;

    const failure = finalState.siteRun?.failureMemory?.[0];
    assert.ok(failure, 'the failed click is in the failure memory');
    assert.equal(failure.fallbackUsed, 'synthetic', 'the failure record says the input was synthetic');
  } finally {
    runtimeRegistry.delete(threadId);
  }
});
