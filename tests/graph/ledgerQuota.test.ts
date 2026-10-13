/**
 * tests/graph/ledgerQuota.test.ts
 *
 * Verifies that the graph ledger state and checkpoints remain well under the 2 MB design quota:
 * 1. reduceEvidence enforces caps (MAX_VISITS 400, MAX_ENTRIES 60, MAX_TOTAL_CHARS 150_000) under heavy load.
 * 2. SessionStorageSaver prunes obsolete checkpoints and version blobs, bounding thread storage.
 * 3. summaryNode clears siteIn to null, avoiding duplicate state across site transitions.
 * 4. compactLedgerSnapshot provides a lightweight transfer format for siteIn.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EvidenceLedger, MAX_ENTRIES, MAX_TOTAL_CHARS, MAX_VISITS } from '../../src/background/agent/evidence.ts';
import type { EvidenceInput, LedgerSnapshot } from '../../src/background/agent/evidence.ts';
import { compactLedgerSnapshot } from '../../src/background/agent/planEvidence.ts';
import { reduceEvidence } from '../../src/background/graph/state.ts';
import type { AgentStateT, HistoryEntry, VisitedEntry } from '../../src/background/graph/state.ts';
import { summaryNode } from '../../src/background/graph/orchestrator.ts';
import { runtimeRegistry, type RunRuntime } from '../../src/background/runner/runtimeRegistry.ts';
import type { SiteOut } from '../../src/background/graph/workerState.ts';
import { checkpointId, putStep, rig } from '../helpers/checkpointFixtures.ts';

test('ledger quota: reduceEvidence enforces caps under a heavy event stream', () => {
  let snap: LedgerSnapshot = EvidenceLedger.fromSnapshot(null).toSnapshot();

  // Feed 500 events across 50 hosts with large text blocks
  for (let i = 1; i <= 500; i++) {
    const hostIndex = i % 50;
    const host = `store-${hostIndex}.example.com`;
    const url = `https://${host}/products/item-${i}`;
    const text = `Product ${i} details: Price is EUR ${100 + i}.00. `.padEnd(2000, 'x');

    const event: EvidenceInput = {
      step: i,
      kind: 'page',
      url,
      title: `Store ${hostIndex} - Item ${i}`,
      text,
      links: [`https://${host}/cart`, `https://${host}/help`],
    };

    snap = reduceEvidence(snap, event);
  }

  const visitCount = snap.visits?.length ?? 0;
  assert.ok(visitCount <= MAX_VISITS, `visits (${visitCount}) must be <= ${MAX_VISITS}`);
  assert.ok(snap.entries.length <= MAX_ENTRIES, `entries (${snap.entries.length}) must be <= ${MAX_ENTRIES}`);

  let totalChars = 0;
  for (const entry of snap.entries) {
    totalChars += entry.text.length;
  }
  assert.ok(totalChars <= MAX_TOTAL_CHARS, `totalChars (${totalChars}) must be <= ${MAX_TOTAL_CHARS}`);

  const serialized = JSON.stringify(snap);
  // Snapshot size should be comfortably below 400 KB
  assert.ok(serialized.length < 400_000, `Serialized snapshot size (${serialized.length}) must be < 400,000 bytes`);
});

test('ledger quota: compactLedgerSnapshot creates a compact summary without heavy page texts', () => {
  const ledger = new EvidenceLedger();
  for (let i = 1; i <= 300; i++) {
    const host = `vendor-${i % 20}.test`;
    ledger.record({
      step: i,
      kind: 'page',
      url: `https://${host}/page-${i}`,
      title: `Page ${i} Title`.padEnd(50, ' '),
      text: `Listing description for item ${i} with price USD ${50 + i}.00 and specifications. `.padEnd(2000, 'y'),
      links: [`https://${host}/home`, `https://${host}/item-${i}/buy`],
    });
  }

  const fullSnap = ledger.toSnapshot();
  const compact = compactLedgerSnapshot(fullSnap);

  const fullSize = JSON.stringify(fullSnap).length;
  const compactSize = JSON.stringify(compact).length;

  assert.ok(fullSize > 100_000, `Full snapshot size (${fullSize}) contains substantive content`);
  assert.ok(compactSize < fullSize, `Compact snapshot size (${compactSize}) must be smaller than full (${fullSize})`);
  assert.ok(compact.visits && compact.visits.length <= 100, 'Visits must be capped to 100');
  assert.ok(compact.entries.length <= 40, 'Entries must be capped to 40');
});

test('ledger quota: summaryNode clears siteIn to null to prevent unbounded memory growth', async () => {
  const threadId = 't-test-summary';
  const mockRuntime = {
    threadId,
    ownerTabId: 201,
    bootId: 'boot-summary-1',
    control: {
      pauseRequested: false,
      stopRequested: false,
      stepSignal: () => new AbortController().signal,
      abortStep: () => {},
      isUserAbort: () => false,
      snapshot: () => ({ stopRequested: false, pauseRequested: false, stepRequested: false }),
    },
    tabs: { activeTabId: 201 },
    windowId: 1,
    scoutFoxGroupIds: new Map(),
    attachedTabIds: new Set<number>(),
    resumedAfterRestart: false,
    settings: async () => ({}),
    clock: { now: () => Date.now(), sleep: async () => {} },
    llm: { complete: async () => ({ text: '' }) },
    emit: {
      enterNode: () => {},
      historyEntry: () => {},
      notifyChange: () => {},
    },
  } as unknown as RunRuntime;
  runtimeRegistry.set(mockRuntime);

  try {
    const mockVisited: VisitedEntry[] = [
      {
        url: 'https://example.com/p1',
        domain: 'example.com',
        title: 'P1',
        siteId: 'site-a',
        firstStep: 1,
        lastStep: 1,
        visits: 1,
        verdict: 'ok',
        pageType: 'listing',
      },
    ];

    const mockState: Partial<AgentStateT> = {
      siteIn: {
        site: { id: 'site-a', domain: 'example.com', kind: 'listing', goal: 'Find prices' } as any,
        ledgerPrior: undefined,
        planTexts: [],
      } as any,
      siteOut: {
        siteId: 'site-a',
        status: 'done',
        criteriaMet: true,
        reason: 'Extracted price successfully',
        findings: [{ id: 'f1', site: 'site-a', data: { price: 'EUR 199' } } as any],
        blocked: [],
        visited: mockVisited,
        approvedDomains: ['example.com'],
        used: 3,
        extendedBy: 0,
        systemActions: 0,
        parseErrors: 0,
        everParsedOk: true,
        modelCalls: 3,
        failures: [],
        anomalies: [],
        userAnswered: false,
        notes: 'ok',
        cdp: { mode: 'off', reason: null, sticky: false },
        activeTabId: null,
      } as SiteOut,
      findings: [],
      approvedDomains: [],
      budget: {
        hardCap: 50,
        workingTotal: 30,
        reserve: 10,
        slack: 0,
        used: 0,
        sites: { 'site-a': { base: 10, alloc: 10, used: 0, extended: false } },
      },
      stepCount: 0,
    };

    const update = await summaryNode(mockState as AgentStateT, { configurable: { thread_id: threadId } });

    assert.equal(update.siteIn, null, 'summaryNode must explicitly set siteIn to null');
    assert.equal((update.sites as any)?.['$set']?.['site-a']?.status, 'done');
  } finally {
    runtimeRegistry.delete(threadId);
  }
});

test('ledger quota: SessionStorageSaver keeps storage well under 2 MB with full ledger and 3-checkpoint pruning', async () => {
  const r = rig();
  const thread = 'thread-p8-quota';

  // Build a realistic capped ledger
  let ledgerSnap: LedgerSnapshot = EvidenceLedger.fromSnapshot(null).toSnapshot();
  for (let i = 1; i <= 200; i++) {
    const host = `site-${i % 25}.org`;
    ledgerSnap = reduceEvidence(ledgerSnap, {
      step: i,
      kind: 'page',
      url: `https://${host}/item-${i}`,
      title: `Item ${i}`,
      text: `Item ${i} specs and details`.padEnd(1500, 'z'),
      links: [`https://${host}/details`],
    });
  }

  const mockHistory: HistoryEntry[] = [];
  for (let i = 1; i <= 50; i++) {
    mockHistory.push({
      type: 'agent_response',
      step: i,
      thought: `Thinking about step ${i}`,
      action: { action: 'click', element_id: i },
      rawResponse: `{"thought": "Step ${i}", "action": "click", "element_id": ${i}}`,
      mode: 'browse',
    });
  }

  // Simulate 8 sequential checkpoints for this thread in root namespace
  for (let step = 1; step <= 8; step++) {
    const channelValues = {
      evidence: ledgerSnap,
      history: mockHistory,
      stepCount: step,
      runId: 'run-1',
    };
    const versions = {
      evidence: step,
      history: step,
      stepCount: step,
      runId: 1,
    };
    await putStep(r.saver, thread, '', step, channelValues, versions, ['evidence', 'history', 'stepCount', 'runId']);
  }

  const ix = r.store.session.data()[`sf:lg:ix:${thread}`] as { ns: Record<string, { ids: string[] }> };
  assert.ok(ix, 'Index must exist');
  assert.deepEqual(ix.ns[''].ids, [checkpointId(8), checkpointId(7), checkpointId(6)], 'Pruning must keep only 3 newest checkpoints');

  const bytesInUse = r.store.session.bytesInUse();
  const twoMegabytes = 2 * 1024 * 1024;

  assert.ok(
    bytesInUse < twoMegabytes,
    `Total session storage used (${bytesInUse} bytes) must be well under 2 MB (${twoMegabytes} bytes)`
  );
  // In practice, with 3 checkpoints and deduped/pruned blobs, it should be well below 1.5 MB
  assert.ok(bytesInUse < 1_500_000, `Storage (${bytesInUse} bytes) is safely below 1.5 MB`);
});
