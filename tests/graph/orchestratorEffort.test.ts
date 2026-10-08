// tests/graph/orchestratorEffort.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { Command } from '@langchain/langgraph/web';
import { buildOrchestratorGraph } from '../../src/background/graph/orchestrator.ts';
import { runtimeRegistry, type RunRuntime } from '../../src/background/runner/runtimeRegistry.ts';
import { SessionStorageSaver } from '../../src/background/checkpoint/SessionStorageSaver.ts';
import { createFakeStorage } from '../helpers/fakeStorageSession.ts';

function createMockRuntime(threadId: string, customPlan?: any): RunRuntime {
  const mockRuntime: RunRuntime = {
    threadId,
    ownerTabId: 201,
    bootId: 'boot-effort-1',
    control: {
      pauseRequested: false,
      stopRequested: false,
      stepSignal: () => new AbortController().signal,
      abortStep: () => {},
      isUserAbort: () => false,
      snapshot: () => ({ stopRequested: false, pauseRequested: false, stepRequested: false }),
    } as any,
    tabs: { activeTabId: 201 },
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
    clock: {
      now: () => 1700000000000,
      sleep: async () => {},
    },
    llm: {
      complete: async (req: any) => {
        if (req.node === 'plan') {
          return {
            text: JSON.stringify(customPlan ?? {
              taskKind: 'research',
              searchQuery: 'framework laptop price',
              columns: ['price'],
              priceLike: true,
              sites: [
                {
                  id: 's1',
                  name: 'Framework Store',
                  domain: 'frame.work',
                  startUrl: 'https://frame.work/products/laptop',
                  goal: 'Find laptop price',
                  role: 'reference',
                  kind: 'store',
                  difficulty: 1,
                },
                {
                  id: 's2',
                  name: 'Competitor Store',
                  domain: 'competitor.test',
                  startUrl: 'https://competitor.test/laptop',
                  goal: 'Find competitor price',
                  role: 'compare',
                  kind: 'store',
                  difficulty: 2,
                }
              ]
            })
          };
        }
        // Policy replies: record finding on s1, record finding on s2
        return {
          text: JSON.stringify({
            action: 'record_finding',
            field: 'price',
            value: '1.200 EUR',
            reason: 'Observed price on page'
          })
        };
      }
    } as any,
    browser: {
      tabInfo: async () => ({ id: 201, url: 'https://frame.work', title: 'Framework Laptop' }),
      pageSig: async () => ({
        sig: {
          url: 'https://frame.work',
          title: 'Framework Laptop',
          elementCount: 15,
          interactiveHash: 'hash-interactive',
          textHash: 'hash-text',
          scrollY: 0,
        },
        priceHits: 1,
        found: ['1.200 EUR'],
      }),
      snapshot: async () => ({
        docId: 'doc-123',
        tabId: 201,
        url: 'https://frame.work',
        domain: 'frame.work',
        title: 'Framework Laptop',
        scrollY: 0,
        pageHeight: 1000,
        viewportHeight: 800,
        elementCount: 15,
        elements: [
          { id: 1, tag: 'h1', text: 'Framework Laptop' },
          { id: 2, tag: 'p', text: 'Price: 1.200 EUR' },
        ],
        pageText: 'Framework Laptop Price: 1.200 EUR',
        rawHtml: '<html><body>Framework Laptop Price: 1.200 EUR</body></html>',
      }),
      execute: async () => ({
        success: true,
        via: 'synthetic',
        effect: 'dom_changed',
      }),
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
    } as any,
    journal: {
      get: async () => null,
      begin: async () => {},
      finish: async () => {},
      clearRun: async () => {},
    },
    net: {
      marker: () => 'm:1',
      read: () => '',
    },
    emit: {
      enterNode: () => {},
      setPhase: () => {},
    },
  };

  runtimeRegistry.set(mockRuntime);
  return mockRuntime;
}

test('orchestratorEffort: executes with Low effort profile and multiplier 1x', async (t) => {
  const threadId = 'test-effort-low';
  createMockRuntime(threadId);
  t.after(() => runtimeRegistry.delete(threadId));

  const fakeStorage = createFakeStorage();
  const saver = new SessionStorageSaver(fakeStorage.connect().session as any);
  const graph = buildOrchestratorGraph(saver);

  const cfg = { configurable: { thread_id: threadId }, streamMode: 'values' as const };

  // Turn start with requested effort 'low'
  const stream1 = await graph.stream({
    task: 'Check laptop price quickly',
    effort: { requested: 'low', level: 'low', suggestedBy: 'user' },
    limits: { maxSteps: 100, maxSystemActions: 100, maxParseErrorsPerTurn: 100, maxConsecutiveParseErrors: 3 },
  }, cfg);

  for await (const chunk of stream1) {
    // Drive past plan approval
  }

  // Resume past plan approval hold
  const stream2 = await graph.stream(new Command({ resume: { kind: 'approve' } }), cfg);
  let finalState: any = null;
  for await (const chunk of stream2) {
    finalState = chunk;
  }

  assert.equal(finalState.effort?.level, 'low');
  assert.equal(finalState.effortProfile?.multiplier, 1);
  assert.deepEqual(finalState.effortProfile?.blockedLadder, ['mark']);

  // Low profile base allocations (store diff 1 base 12 * 1 = 12, store diff 2 base 18 * 1 = 18)
  assert.equal(finalState.budget.sites['s1'].alloc, 12);
  assert.equal(finalState.budget.sites['s2'].alloc, 18);

  // RunStats check
  assert.ok(finalState.runStats, 'runStats should be populated');
  assert.equal(finalState.runStats.level, 'low');
  assert.equal(finalState.runStats.sitesDone, 2);
  assert.ok(finalState.runStats.elapsedMs >= 0);
});

test('orchestratorEffort: executes with High effort profile and multiplier 3x', async (t) => {
  const threadId = 'test-effort-high';
  createMockRuntime(threadId);
  t.after(() => runtimeRegistry.delete(threadId));

  const fakeStorage = createFakeStorage();
  const saver = new SessionStorageSaver(fakeStorage.connect().session as any);
  const graph = buildOrchestratorGraph(saver);

  const cfg = { configurable: { thread_id: threadId }, streamMode: 'values' as const };

  const stream1 = await graph.stream({
    task: 'Deep search prices',
    effort: { requested: 'high', level: 'high', suggestedBy: 'user' },
    limits: { maxSteps: 300, maxSystemActions: 300, maxParseErrorsPerTurn: 300, maxConsecutiveParseErrors: 3 },
  }, cfg);

  for await (const chunk of stream1) {}

  const stream2 = await graph.stream(new Command({ resume: { kind: 'approve' } }), cfg);
  let finalState: any = null;
  for await (const chunk of stream2) {
    finalState = chunk;
  }

  assert.equal(finalState.effort?.level, 'high');
  assert.equal(finalState.effortProfile?.multiplier, 3);
  assert.deepEqual(finalState.effortProfile?.blockedLadder, ['reload', 'search', 'mark']);

  // High profile base allocations (store diff 1 base 12 * 3 = 36, store diff 2 base 18 * 3 = 54)
  assert.equal(finalState.budget.sites['s1'].alloc, 36);
  assert.equal(finalState.budget.sites['s2'].alloc, 54);

  assert.ok(finalState.runStats);
  assert.equal(finalState.runStats.level, 'high');
});

test('orchestratorEffort: auto effort infers High level from comparison task prompt', async (t) => {
  const threadId = 'test-effort-auto';
  createMockRuntime(threadId);
  t.after(() => runtimeRegistry.delete(threadId));

  const fakeStorage = createFakeStorage();
  const saver = new SessionStorageSaver(fakeStorage.connect().session as any);
  const graph = buildOrchestratorGraph(saver);

  const cfg = { configurable: { thread_id: threadId }, streamMode: 'values' as const };

  const stream1 = await graph.stream({
    task: 'Compare the cheapest price across all stores',
    effort: { requested: 'auto', level: 'medium', suggestedBy: 'default' },
  }, cfg);

  for await (const chunk of stream1) {}

  const stream2 = await graph.stream(new Command({ resume: { kind: 'approve' } }), cfg);
  let finalState: any = null;
  for await (const chunk of stream2) {
    finalState = chunk;
  }

  assert.equal(finalState.effort?.level, 'high');
  assert.equal(finalState.effort?.suggestedBy, 'heuristic');
  assert.equal(finalState.effortProfile?.multiplier, 3);
});

test('orchestratorEffort: over-budget gracefully scales allocations down under hardCap', async (t) => {
  const threadId = 'test-effort-overbudget';
  // Create 4 sites with difficulty 3 (store diff 3 base 24 * 3 = 72 per site -> 288 total base)
  const manySites = [1, 2, 3, 4].map((i) => ({
    id: `s${i}`,
    name: `Store ${i}`,
    domain: `store${i}.test`,
    startUrl: `https://store${i}.test`,
    goal: `Find item ${i}`,
    role: i === 1 ? 'reference' : 'compare',
    kind: 'store',
    difficulty: 3,
  }));

  createMockRuntime(threadId, {
    taskKind: 'research',
    searchQuery: 'many sites',
    columns: ['price'],
    sites: manySites,
  });
  t.after(() => runtimeRegistry.delete(threadId));

  const fakeStorage = createFakeStorage();
  const saver = new SessionStorageSaver(fakeStorage.connect().session as any);
  const graph = buildOrchestratorGraph(saver);

  const cfg = { configurable: { thread_id: threadId }, streamMode: 'values' as const };

  // Hard cap set to only 50 steps
  const stream1 = await graph.stream({
    task: 'Deep search across many stores',
    effort: { requested: 'high', level: 'high', suggestedBy: 'user' },
    limits: { maxSteps: 50, maxSystemActions: 50, maxParseErrorsPerTurn: 50, maxConsecutiveParseErrors: 3 },
  }, cfg);

  for await (const chunk of stream1) {}

  const stream2 = await graph.stream(new Command({ resume: { kind: 'approve' } }), cfg);
  let finalState: any = null;
  for await (const chunk of stream2) {
    finalState = chunk;
  }

  const budget = finalState.budget;
  assert.ok(budget, 'budget should be created');
  assert.equal(budget.hardCap, 50);

  // Total allocated to all sites + reserve must be <= 50
  assert.ok(budget.workingTotal <= 50, `workingTotal (${budget.workingTotal}) must be <= hardCap (50)`);

  // Each site must still have at least 1 step allocated
  for (const s of manySites) {
    assert.ok(budget.sites[s.id].alloc >= 1, `Site ${s.id} should receive at least 1 step`);
  }
});
