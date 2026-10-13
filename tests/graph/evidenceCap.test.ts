// BUG-23 regression: the 100-event evidence cap used to evict the earliest
// pages of a long site, so the finish audit rebuilt its ledger from the capped
// tail and treated pages the agent really opened as never opened (needless
// send-backs on long High/Max sites). meter now folds the accumulated events
// into the self-capping `evidenceBase` ledger every cycle; the finish audit
// reads base + the few unfolded events, so the first-opened page is credited.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkerGraph } from '../../src/background/graph/worker.ts';
import { runtimeRegistry, type RunRuntime } from '../../src/background/runner/runtimeRegistry.ts';
import type { SiteIn, WorkerStateT } from '../../src/background/graph/workerState.ts';
import { MemorySaver } from '@langchain/langgraph';
import { EvidenceLedger } from '../../src/background/agent/evidence.ts';

const FINISH_AFTER_SNAPSHOTS = 110; // ~2-3 events per cycle, so the raw list passes the 100 cap

function page(call: number): { url: string; title: string; pageText: string } {
  if (call <= 1) {
    return { url: 'https://prices.test/item', title: 'Price List', pageText: 'Price list page with the item prices' };
  }
  return { url: `https://shop.test/page-${call}`, title: `Page ${call}`, pageText: `Page ${call} filler text without numbers` };
}

function createMockRuntime(threadId: string): { runtime: RunRuntime; snaps: { count: number } } {
  const snaps = { count: 0 };
  const mockRuntime: RunRuntime = {
    threadId,
    ownerTabId: 101,
    bootId: 'boot-test-evidence-cap',
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
      complete: async () => ({ text: '', provider: 'mock', model: 'mock-model', meta: {}, usage: { tokensIn: 1, tokensOut: 1 } }),
    },
    browser: {
      tabInfo: async () => ({ url: page(snaps.count).url, title: page(snaps.count).title, windowId: 1, groupId: 0, status: 'complete' }),
      snapshot: async () => {
        snaps.count++;
        const snap = page(snaps.count);
        return {
          docId: `doc-${snaps.count}`,
          tabId: 101,
          url: snap.url,
          domain: snaps.count <= 1 ? 'prices.test' : 'shop.test',
          title: snap.title,
          scrollY: snaps.count * 10,
          pageHeight: 100000,
          viewportHeight: 800,
          elementCount: 2,
          refs: [1],
          elementsText: '[1] text "filler"',
          elementInfo: { '1': { role: 'text', label: 'filler' } },
          pageText: snap.pageText,
          capturedAt: Date.now(),
        } as any;
      },
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
  } as unknown as RunRuntime;

  runtimeRegistry.set(mockRuntime);
  return { runtime: mockRuntime, snaps };
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
    profile: {
      level: 'high',
      multiplier: 3,
      reflect: 'off',
      softCapAsk: false,
      blockedLadder: ['reload', 'mark'],
      reservePct: 0.1,
    } as any,
    tier: 'large',
    limits: { maxSteps: 250 } as any,
    runId: 'run-cap-1',
    alloc: 200,
    slackAvailable: 0,
    hardCapLeft: 400,
    stepBase: 0,
    systemActionBase: 0,
    parseErrorsBase: 0,
    everParsedOk: true,
    tabId: 101,
    cdp: { mode: 'synthetic' } as any,
    approvedDomains: ['shop.test', 'prices.test'],
    blocked: [],
    visitedRecent: [],
    findingsLines: [],
    earlierSites: [],
    recap: [],
    priorFindings: [],
    planTexts: ['Find the price'],
  };
}

test('a finish after more than 100 evidence events still credits the first-opened page (BUG-23)', async () => {
  const threadId = 'test-evidence-cap';
  const { runtime, snaps } = createMockRuntime(threadId);
  let calls = 0;
  runtime.llm.complete = async () => {
    calls++;
    if (snaps.count < FINISH_AFTER_SNAPSHOTS) {
      // Rotate three distinct signatures so the repeated-action stuck detector
      // (3 identical signatures in a row) does not end the site early.
      const pick = calls % 3;
      const action = pick === 0
        ? '{"action": "scroll", "direction": "down", "reason": "walk the list"}'
        : pick === 1
          ? '{"action": "read_page_text", "reason": "read the page"}'
          : '{"action": "wait", "ms": 10, "reason": "let it settle"}';
      return { text: action, provider: 'mock', model: 'mock-model', meta: {}, usage: { tokensIn: 10, tokensOut: 5 } } as any;
    }
    return { text: '{"action": "finish", "answer": "The price list is on https://prices.test/item.", "reason": "found it"}', provider: 'mock', model: 'mock-model', meta: {}, usage: { tokensIn: 10, tokensOut: 5 } } as any;
  };

  try {
    const worker = buildWorkerGraph(new MemorySaver());
    const siteIn = makeSiteIn();
    const cfg = { configurable: { thread_id: threadId }, recursionLimit: 800 };
    const finalState = (await worker.invoke(
      {
        siteIn,
        siteRun: {
          siteId: 's1',
          spec: siteIn.site,
          tabId: 101,
          alloc: 200,
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

    // The scenario really passed the cap.
    assert.ok(snaps.count >= FINISH_AFTER_SNAPSHOTS, `the site took ${snaps.count} snapshots`);
    assert.ok((finalState.evidenceEvents?.length ?? 0) <= 100, 'the raw event list is still capped');
    assert.ok((finalState.evidenceEvents?.length ?? 0) < snaps.count, 'most events were folded into the base');

    // The folded base kept the first-opened page (its raw events were evicted
    // from the capped list pre-fix).
    const base = EvidenceLedger.fromSnapshot(finalState.evidenceBase ?? null);
    assert.ok(base.wasVisited('https://prices.test/item'), 'the first-opened page is still in the folded ledger');

    // The finish audit therefore verified the answer instead of refusing it as
    // a claim about a site that was (supposedly) never opened.
    assert.equal(finalState.siteRun?.exit?.status, 'done', JSON.stringify(finalState.siteRun?.exit));
    assert.equal(finalState.siteRun?.exit?.reason, 'The price list is on https://prices.test/item.');
    assert.equal(finalState.siteRun?.lastRefusedFinish ?? null, null, JSON.stringify(finalState.siteRun?.lastRefusedFinish));
  } finally {
    runtimeRegistry.delete(threadId);
  }
});
