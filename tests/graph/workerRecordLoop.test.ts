// tests/graph/workerRecordLoop.test.ts
// The summarize loop: a collect site whose columns are prose (title, summary) can never pass the
// word-for-word page check with a model-written summary, so every record_finding used to be
// dropped silently and the model repeated the same round until the step budget ran out. These
// tests pin the three behaviors that end that loop: a correction the model actually sees, a
// no-progress backstop that ends the site, and the loose prose check that lets a faithful summary
// through (as 'unverified') so the site can finish.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkerGraph, buildSiteOut } from '../../src/background/graph/worker.ts';
import { runtimeRegistry, type RunRuntime } from '../../src/background/runner/runtimeRegistry.ts';
import type { SiteIn, WorkerStateT } from '../../src/background/graph/workerState.ts';

// A Hacker-News-like front page. Every word the "faithful" summary of test 2 uses must be here;
// the invented summary of test 1 must share almost none of its long words with this text.
const HN_PAGE = 'Hacker News. new links. past. comments. login. '
  + 'GLM-Legal: Advancing Agentic Legal Intelligence. '
  + 'The Making Of Super Mario 64: full Giles Goddard interview. '
  + 'A Modern Web App in C. '
  + 'Show HN: PS2 games statically recompiled to WebAssembly. '
  + 'Fingerprints are the new cookies. '
  + 'Secret of Orange Cats Revealed After 60-Year Search. '
  + 'Z.ai introduces GLM-Legal, a legal AI model designed for agentic legal work. '
  + 'It achieves a 19.2 percent all-pass rate on Harvey LAB benchmarks. '
  + '42 points by user 3 hours ago. save. hide. share.';

// The summary the stuck model kept re-sending: well-phrased, but about a page it never read.
const INVENTED_SUMMARY = 'Underwater basket weaving societies expand across Atlantic harbor towns, a new demographic analysis finds';

function createMockRuntime(threadId: string, replyText: string | ((round: number) => string)): RunRuntime {
  let llmCallCount = 0;
  const mockRuntime: RunRuntime = {
    threadId,
    ownerTabId: 101,
    bootId: 'boot-test-record',
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
        const text = typeof replyText === 'function' ? replyText(llmCallCount) : replyText;
        return { text, provider: 'mock', model: 'mock-model', meta: {}, usage: { tokensIn: 50, tokensOut: 20 } };
      },
    },
    browser: {
      tabInfo: async () => ({
        url: 'https://news.ycombinator.test/',
        title: 'Hacker News',
        windowId: 1,
        groupId: 0,
        status: 'complete',
      }),
      snapshot: async () => ({
        docId: 'doc-hn',
        tabId: 101,
        url: 'https://news.ycombinator.test/',
        domain: 'news.ycombinator.test',
        title: 'Hacker News',
        scrollY: 0,
        pageHeight: 1000,
        viewportHeight: 800,
        elementCount: 8,
        refs: [1, 2, 3],
        elementsText: '[1] link "A Modern Web App in C"\n[2] text "42 points"',
        elementInfo: {
          '1': { role: 'link', label: 'A Modern Web App in C' },
          '2': { role: 'text', label: '42 points' },
        },
        pageText: HN_PAGE,
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
      marker: () => 'marker-record',
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
  (mockRuntime as any).__llmCallCount = () => llmCallCount;
  return mockRuntime;
}

function proseSiteIn(overrides: Partial<SiteIn> = {}): SiteIn {
  return {
    site: {
      id: 's1',
      name: 'Hacker News',
      domain: 'news.ycombinator.test',
      goal: 'Summarize the main articles',
      goalKind: 'collect',
      startUrl: 'https://news.ycombinator.test/',
      role: 'reference',
      kind: 'page',
      difficulty: 1,
      namedByUser: true,
      criteria: {
        fields: [
          { name: 'title', required: true },
          { name: 'summary', required: true },
        ],
        doneWhen: 'all_required',
      },
    },
    index: 1,
    total: 1,
    task: 'Summarize the main articles on news.ycombinator.test',
    taskKind: 'research',
    columns: ['title', 'summary'],
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
    runId: 'run-record-loop',
    alloc: 20,
    slackAvailable: 0,
    hardCapLeft: 200,
    stepBase: 0,
    systemActionBase: 0,
    parseErrorsBase: 0,
    everParsedOk: false,
    tabId: 101,
    cdp: { mode: 'synthetic', reason: null, sticky: false },
    approvedDomains: ['news.ycombinator.test'],
    blocked: [],
    visitedRecent: [],
    findingsLines: [],
    earlierSites: [],
    recap: [],
    priorFindings: [],
    ...overrides,
  } as SiteIn;
}

const recordFindingReply = (values: Record<string, string>) =>
  `{"thought": "Saving what I see", "action": "record_finding", "values": ${JSON.stringify(values)}}`;

// The live failure: the model records the same article round after round, re-phrasing the summary
// each time and re-sending a url it cannot save. Every round looked like progress because the
// reword changed the finding's valueRaw, so the corrections never fired and the site spun.
const REWORDED_SUMMARIES = [
  'Z.ai introduces GLM-Legal, a legal AI model for agentic legal work with a 19.2% all-pass rate on Harvey LAB.',
  'GLM-Legal is a legal AI model for agentic legal work, scoring 19.2% all-pass on Harvey LAB, Z.ai introduces it.',
  'Z.ai presents GLM-Legal as an agentic legal work model with a 19.2% all-pass rate on Harvey LAB.',
];

test('workerRecordLoop: rewording the same summary every round is churn - dropped, corrected, and the site ends partial', async () => {
  const threadId = 'test-record-loop-reword';
  const rt = createMockRuntime(threadId, (round: number) => recordFindingReply({
    title: 'A Modern Web App in C',
    url: 'https://z.ai/blog/glm-legal',
    summary: REWORDED_SUMMARIES[Math.min(round - 1, REWORDED_SUMMARIES.length - 1)],
  }));
  runtimeRegistry.set(rt);

  try {
    const worker = buildWorkerGraph();
    // "points" is required but never sent by the model, so the site stays open and the churn
    // rounds actually happen (with title+summary alone the site would complete in round 1).
    const siteIn = proseSiteIn({ columns: ['title', 'url', 'summary', 'points'] });
    siteIn.site.criteria = {
      fields: [
        { name: 'title', required: true },
        { name: 'url', required: true },
        { name: 'summary', required: true },
        { name: 'points', required: true },
      ],
      doneWhen: 'all_required',
    };

    const finalState = await worker.invoke(
      { siteIn },
      { configurable: { thread_id: threadId } }
    ) as WorkerStateT;

    assert.ok(finalState.siteRun);
    // Round 1 saved title + summary (progress, url skipped as an auto-value). Rounds 2-4 reword
    // the same content: all churn, streak 3 ends the site instead of the step budget.
    assert.equal(finalState.siteRun.used, 4);
    assert.equal((rt as any).__llmCallCount(), 4);
    assert.equal(finalState.siteRun.exit?.status, 'partial');

    const title = finalState.siteRun.findings.find((f) => f.field === 'title');
    const summary = finalState.siteRun.findings.find((f) => f.field === 'summary');
    assert.ok(title && summary);
    // No url finding was ever created - the engine records the page url itself.
    assert.ok(!finalState.siteRun.findings.some((f) => f.field === 'url'));

    // The churn rounds said so, naming the fields.
    assert.ok(finalState.pendingCorrection!.includes('already saved'));
    assert.ok(finalState.pendingCorrection!.includes('summary'));
  } finally {
    runtimeRegistry.delete(threadId);
  }
});

test('workerRecordLoop: a url column never becomes a model value and never blocks completion', async () => {
  const threadId = 'test-record-loop-url-column';
  const rt = createMockRuntime(threadId, recordFindingReply({
    title: 'A Modern Web App in C',
    summary: 'A modern web app in C, plus the making of Super Mario 64 and the full Giles Goddard interview, and the secret of orange cats revealed',
  }));
  runtimeRegistry.set(rt);

  try {
    const worker = buildWorkerGraph();
    // The plan gave url a required field; the site must still complete when title+summary are in.
    const siteIn = proseSiteIn({ columns: ['title', 'url', 'summary'] });
    siteIn.site.criteria = {
      fields: [
        { name: 'title', required: true },
        { name: 'url', required: true },
        { name: 'summary', required: true },
      ],
      doneWhen: 'all_required',
    };

    const finalState = await worker.invoke(
      { siteIn },
      { configurable: { thread_id: threadId } }
    ) as WorkerStateT;

    assert.ok(finalState.siteRun);
    assert.equal(finalState.siteRun.exit?.status, 'done');
    assert.equal(finalState.siteRun.findings.filter((f) => f.field === 'url').length, 0);
    assert.equal((rt as any).__llmCallCount(), 1);
  } finally {
    runtimeRegistry.delete(threadId);
  }
});

test('workerRecordLoop: an invented summary is rejected with a visible correction, and the site ends after 3 barren rounds instead of looping', async () => {
  const threadId = 'test-record-loop-invented';
  const rt = createMockRuntime(threadId, recordFindingReply({
    title: 'Hacker News front page digest of stories',
    summary: INVENTED_SUMMARY,
  }));
  runtimeRegistry.set(rt);

  try {
    const worker = buildWorkerGraph();
    const finalState = await worker.invoke(
      { siteIn: proseSiteIn() },
      { configurable: { thread_id: threadId } }
    ) as WorkerStateT;

    // The backstop, not the budget, ended the site.
    assert.ok(finalState.siteRun);
    assert.equal(finalState.siteRun.used, 3);
    assert.equal((rt as any).__llmCallCount(), 3);
    assert.equal(finalState.siteRun.findings.length, 0);
    assert.equal(finalState.siteRun.exit?.status, 'partial');
    assert.ok(finalState.siteRun.exit?.reason.includes('record_finding'));

    // The model was told, every round, in the correction channel.
    assert.ok(finalState.pendingCorrection);
    assert.ok(finalState.pendingCorrection!.includes('not saved'));
    assert.ok(finalState.pendingCorrection!.includes('summary'));

    const failedResults = finalState.history.filter((h: any) => h.type === 'execution_result' && h.success === false);
    assert.equal(failedResults.length, 3);
  } finally {
    runtimeRegistry.delete(threadId);
  }
});

test('workerRecordLoop: a faithful summary records as unverified via the loose page check and completes the site', async () => {
  const threadId = 'test-record-loop-faithful';
  const rt = createMockRuntime(threadId, recordFindingReply({
    title: 'A Modern Web App in C',
    summary: 'A modern web app in C, plus the making of Super Mario 64 and the full Giles Goddard interview, and the secret of orange cats revealed',
  }));
  runtimeRegistry.set(rt);

  try {
    const worker = buildWorkerGraph();
    const finalState = await worker.invoke(
      { siteIn: proseSiteIn() },
      { configurable: { thread_id: threadId } }
    ) as WorkerStateT;

    assert.ok(finalState.siteRun);
    // One record round, both fields in, site done.
    assert.equal((rt as any).__llmCallCount(), 1);
    assert.equal(finalState.siteRun.findings.length, 2);
    assert.equal(finalState.siteRun.criteriaMet, true);
    assert.equal(finalState.siteRun.exit?.status, 'done');

    const title = finalState.siteRun.findings.find((f) => f.field === 'title');
    const summary = finalState.siteRun.findings.find((f) => f.field === 'summary');
    assert.ok(title && summary);
    // The verbatim title verifies fully; the written-up summary stays flagged unverified.
    assert.equal(title.quality, 'verified');
    assert.equal(summary.quality, 'unverified');
    assert.ok(summary.checks.includes('value_on_page'));
    assert.ok(summary.checks.includes('value_loose_match'));
    assert.ok(summary.evidence.snippet.length > 0);

    const out = buildSiteOut(finalState);
    assert.equal(out.status, 'done');
    assert.equal(out.findings.length, 2);
  } finally {
    runtimeRegistry.delete(threadId);
  }
});

test('workerRecordLoop: mixed rounds count as no progress once nothing changes - verbatim title saved once, hallucinated price rejected, site ends partial', async () => {
  const threadId = 'test-record-loop-mixed';
  const rt = createMockRuntime(threadId, recordFindingReply({
    title: 'A Modern Web App in C',
    price: '999 EUR',
  }));
  runtimeRegistry.set(rt);

  try {
    const worker = buildWorkerGraph();
    // A price column makes the site price-like, so the price field always needs an exact match.
    const siteIn = proseSiteIn({
      columns: ['title', 'price'],
      priceLike: true,
      task: 'Name the top article and its price',
    });
    siteIn.site.criteria = {
      fields: [
        { name: 'title', required: true },
        { name: 'price', required: true },
      ],
      doneWhen: 'all_required',
    };

    const finalState = await worker.invoke(
      { siteIn },
      { configurable: { thread_id: threadId } }
    ) as WorkerStateT;

    assert.ok(finalState.siteRun);
    // Round 1 saved the title (progress). Rounds 2-4 changed nothing: streak 3 ends the site.
    assert.equal((rt as any).__llmCallCount(), 4);
    assert.equal(finalState.siteRun.used, 4);
    assert.equal(finalState.siteRun.findings.length, 1);
    assert.equal(finalState.siteRun.findings[0].field, 'title');
    assert.equal(finalState.siteRun.findings[0].quality, 'verified');
    assert.equal(finalState.siteRun.exit?.status, 'partial');

    // The re-record rounds said so, with the missing field named.
    assert.ok(finalState.pendingCorrection!.includes('already saved'));
    assert.ok(finalState.pendingCorrection!.includes('price'));

    const failedResults = finalState.history.filter((h: any) => h.type === 'execution_result' && h.success === false);
    assert.equal(failedResults.length, 3);
  } finally {
    runtimeRegistry.delete(threadId);
  }
});

test('workerRecordLoop: a url-only round gets the truthful auto-recorded correction, counts as no progress, and the site ends partial', async () => {
  const threadId = 'test-record-loop-url-only';
  const rt = createMockRuntime(threadId, recordFindingReply({
    url: 'https://z.ai/blog/glm-legal',
  }));
  runtimeRegistry.set(rt);

  try {
    const worker = buildWorkerGraph();
    // The model sends only a url - the engine records that itself, so every round is barren.
    const siteIn = proseSiteIn({ columns: ['url', 'title', 'summary'] });
    siteIn.site.criteria = {
      fields: [
        { name: 'url', required: true },
        { name: 'title', required: true },
        { name: 'summary', required: true },
      ],
      doneWhen: 'all_required',
    };

    const finalState = await worker.invoke(
      { siteIn },
      { configurable: { thread_id: threadId } }
    ) as WorkerStateT;

    assert.ok(finalState.siteRun);
    // The round counts toward the no-progress streak: 3 barren rounds end the site, not the budget.
    assert.equal(finalState.siteRun.used, 3);
    assert.equal((rt as any).__llmCallCount(), 3);
    assert.equal(finalState.siteRun.findings.length, 0);
    assert.equal(finalState.siteRun.exit?.status, 'partial');

    // The correction is truthful: url is recorded automatically, not "not shown".
    assert.ok(finalState.pendingCorrection);
    assert.ok(finalState.pendingCorrection!.includes('recorded automatically'));
    assert.ok(finalState.pendingCorrection!.includes('url'));
    assert.ok(!finalState.pendingCorrection!.includes('not shown'));

    const failedResults = finalState.history.filter((h: any) => h.type === 'execution_result' && h.success === false);
    assert.equal(failedResults.length, 3);
  } finally {
    runtimeRegistry.delete(threadId);
  }
});
