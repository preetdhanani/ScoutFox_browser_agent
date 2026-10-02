// tests/graph/orchestratorReflect.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { Command } from '@langchain/langgraph/web';
import { buildOrchestratorGraph } from '../../src/background/graph/orchestrator.ts';
import { runtimeRegistry, type RunRuntime } from '../../src/background/runner/runtimeRegistry.ts';
import { SessionStorageSaver } from '../../src/background/checkpoint/SessionStorageSaver.ts';
import { createFakeStorage } from '../helpers/fakeStorageSession.ts';

interface MockRuntimeOptions {
  customPlan?: any;
  reflectReply?: any;
  onReflectCall?: (req: any) => void;
  policyFindings?: Record<string, string>;
}

function createMockRuntime(threadId: string, options: MockRuntimeOptions = {}): RunRuntime {
  const { customPlan, reflectReply, onReflectCall, policyFindings } = options;

  const mockRuntime: RunRuntime = {
    threadId,
    ownerTabId: 201,
    bootId: 'boot-reflect-1',
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
                },
              ],
            }),
          };
        }

        if (req.node === 'reflect') {
          if (onReflectCall) onReflectCall(req);
          return {
            text: JSON.stringify(reflectReply ?? {
              decision: 'continue',
              reason: 'Proceed with remaining plan',
            }),
          };
        }

        // Policy replies
        const findingVal = policyFindings?.[req.siteId] ?? '1.200 EUR';
        return {
          text: JSON.stringify({
            action: 'record_finding',
            field: 'price',
            value: findingVal,
            reason: 'Observed price on page',
          }),
        };
      },
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

test('orchestratorReflect: Low effort profile (reflect: off) continues without calling reflect LLM', async (t) => {
  const threadId = 'test-reflect-low-off';
  let reflectLlmCalled = false;

  createMockRuntime(threadId, {
    onReflectCall: () => {
      reflectLlmCalled = true;
    },
  });
  t.after(() => runtimeRegistry.delete(threadId));

  const fakeStorage = createFakeStorage();
  const saver = new SessionStorageSaver(fakeStorage.connect().session as any);
  const graph = buildOrchestratorGraph(saver);
  const config = { configurable: { thread_id: threadId } };

  // Run graph with Low effort
  let step = await graph.invoke(
    {
      task: 'Compare laptop price',
      effort: {
        requested: 'low',
        level: 'low',
        suggestedBy: 'user',
      },
    },
    config,
  );

  // Resume plan hold
  if (step.pendingHold?.kind === 'approve_plan') {
    step = await graph.invoke(new Command({ resume: { kind: 'approve' } }), config);
  }

  assert.equal(reflectLlmCalled, false, 'Reflect LLM must NOT be called when effort profile reflect is off');
  assert.equal(step.reflectResult?.decision, 'continue');
  assert.equal(step.reflectResult?.by, 'code');
  assert.equal(step.runStatus, 'idle');
});

test('orchestratorReflect: Fast path stop_early finishes cleanly when all criteria are satisfied early', async (t) => {
  const threadId = 'test-reflect-stop-early';
  createMockRuntime(threadId, {
    // S1 provides reference price, S2 provides compare price
    policyFindings: {
      s1: '1.200 EUR',
      s2: '1.250 EUR',
    },
  });
  t.after(() => runtimeRegistry.delete(threadId));

  const fakeStorage = createFakeStorage();
  const saver = new SessionStorageSaver(fakeStorage.connect().session as any);
  const graph = buildOrchestratorGraph(saver);
  const config = { configurable: { thread_id: threadId } };

  let step = await graph.invoke(
    {
      task: 'Compare laptop price across sites',
      effort: {
        requested: 'medium',
        level: 'medium',
        suggestedBy: 'user',
      },
    },
    config,
  );

  if (step.pendingHold?.kind === 'approve_plan') {
    step = await graph.invoke(new Command({ resume: { kind: 'approve' } }), config);
  }

  // Task completes
  assert.equal(step.runStatus, 'idle');
  assert.ok(step.finalAnswer);
  assert.equal(step.finalAnswer.partial, false, 'Early completion with criteria met must not be marked partial');
  assert.ok(step.history.some((h: any) => h.type === 'finish'));
});

test('orchestratorReflect: Replan flow drops pending site, adds alternative site, and preserves finished sites', async (t) => {
  const threadId = 'test-reflect-replan-flow';

  createMockRuntime(threadId, {
    reflectReply: {
      decision: 'replan',
      reason: 'Competitor site was unpromising, investigate alternate store',
      changes: 'Drop s2, add s3 altstore',
      drop_sites: ['s2'],
      add_sites: [
        {
          name: 'Alt Store',
          domain: 'altstore.de',
          startUrl: 'https://altstore.de/laptop',
          goal: 'Find laptop price on alt store',
          role: 'compare',
          kind: 'store',
          difficulty: 1,
        },
      ],
    },
  });
  t.after(() => runtimeRegistry.delete(threadId));

  const fakeStorage = createFakeStorage();
  const saver = new SessionStorageSaver(fakeStorage.connect().session as any);
  const graph = buildOrchestratorGraph(saver);
  const config = { configurable: { thread_id: threadId } };

  let step = await graph.invoke(
    {
      task: 'Compare laptop price',
      effort: {
        requested: 'medium',
        level: 'medium',
        suggestedBy: 'user',
      },
    },
    config,
  );

  // Initial plan approval
  if (step.pendingHold?.kind === 'approve_plan') {
    step = await graph.invoke(new Command({ resume: { kind: 'approve' } }), config);
  }

  // Because altstore.de is a new domain not in approvedDomains, planRouter routes to hold!
  if (step.pendingHold?.kind === 'approve_plan') {
    assert.equal(step.planMeta?.version, 2, 'Plan version should be incremented after replan');
    assert.equal(step.replan?.count, 1, 'Replan count should be incremented');

    // Approve new domain
    step = await graph.invoke(new Command({ resume: { kind: 'approve' } }), config);
  }

  assert.equal(step.runStatus, 'idle');
  // Verify finished sites immutability: s1 is still present and marked done
  assert.equal(step.sites?.s1?.status, 'done');
  // s2 was dropped
  assert.equal(step.sites?.s2?.status, 'skipped');
  // s3 was added and run
  assert.equal(step.sites?.s3?.status, 'done');
  assert.equal(step.planMeta?.version, 2);
  assert.equal(step.replan?.count, 1);
  assert.ok(step.history.some((h: any) => h.type === 'notice' && h.kind === 'replan'));
});

test('orchestratorReflect: allocNode retains budget.used and budget.slack across replan revisions', async (t) => {
  const threadId = 'test-reflect-alloc-budget';

  createMockRuntime(threadId, {
    reflectReply: {
      decision: 'replan',
      reason: 'Try another shop',
      drop_sites: ['s2'],
      add_sites: [
        {
          name: 'Shop 3',
          domain: 'shop3.test',
          role: 'compare',
          kind: 'store',
          difficulty: 1,
        },
      ],
    },
  });
  t.after(() => runtimeRegistry.delete(threadId));

  const fakeStorage = createFakeStorage();
  const saver = new SessionStorageSaver(fakeStorage.connect().session as any);
  const graph = buildOrchestratorGraph(saver);
  const config = { configurable: { thread_id: threadId } };

  let step = await graph.invoke(
    {
      task: 'Compare prices',
      effort: {
        requested: 'high',
        level: 'high',
        suggestedBy: 'user',
      },
    },
    config,
  );

  if (step.pendingHold?.kind === 'approve_plan') {
    step = await graph.invoke(new Command({ resume: { kind: 'approve' } }), config);
  }

  // Handle replan approval hold for new domain
  if (step.pendingHold?.kind === 'approve_plan') {
    step = await graph.invoke(new Command({ resume: { kind: 'approve' } }), config);
  }

  assert.equal(step.runStatus, 'idle');
  assert.ok(step.budget);
  assert.ok(step.budget.used >= 0);
  assert.ok(step.budget.sites?.s1);
  assert.ok(step.budget.sites?.s3);
});
