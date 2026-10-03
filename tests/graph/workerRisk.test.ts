import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkerGraph } from '../../src/background/graph/worker.ts';
import { runtimeRegistry, type RunRuntime } from '../../src/background/runner/runtimeRegistry.ts';
import type { SiteIn, WorkerStateT } from '../../src/background/graph/workerState.ts';
import { MemorySaver } from '@langchain/langgraph';
import { Command } from '@langchain/langgraph';

function createMockRuntime(threadId: string, overrides: Partial<RunRuntime> = {}): RunRuntime {
  const mockRuntime: RunRuntime = {
    threadId,
    ownerTabId: 101,
    bootId: 'boot-test-risk',
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
      complete: async () => ({
        text: '{"thought": "test", "action": "click", "elementId": 1}',
        provider: 'mock',
        model: 'mock-model',
        meta: {},
        usage: { tokensIn: 50, tokensOut: 20 },
      }),
    },
    browser: {
      tabInfo: async () => ({
        url: 'https://shop.test/checkout',
        title: 'Checkout Page',
        windowId: 1,
        groupId: 0,
        status: 'complete',
      }),
      snapshot: async () => ({
        docId: 'doc-risk-1',
        tabId: 101,
        url: 'https://shop.test/checkout',
        domain: 'shop.test',
        title: 'Checkout Page',
        scrollY: 0,
        pageHeight: 1000,
        viewportHeight: 800,
        elementCount: 5,
        refs: [1, 2],
        elementsText: '[1] button "Pay Now"\n[2] input password',
        elementInfo: {
          '1': { role: 'button', label: 'Pay Now', formKind: 'purchase' },
          '2': { role: 'input', label: 'Password', fieldKind: 'password' },
        },
        pageText: 'Checkout Pay Now',
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

function makeSiteIn(overrides: Partial<SiteIn['site']> = {}): SiteIn {
  return {
    site: {
      id: 'site-1',
      name: 'Shop',
      domain: 'shop.test',
      goal: 'Buy item',
      goalKind: 'action' as any,
      startUrl: 'https://shop.test/checkout',
      role: 'reference',
      kind: 'store',
      difficulty: 1,
      namedByUser: true,
      criteria: {
        fields: [],
        doneWhen: 'all_required',
      },
      ...overrides,
    },
    index: 1,
    total: 1,
    task: 'Purchase test',
    taskKind: 'action',
    columns: [],
    priceLike: false,
    compare: null,
    profile: { level: 'medium' } as any,
    tier: 'small',
    limits: { maxSteps: 250 } as any,
    runId: 'run-test-risk',
    alloc: 10,
    slackAvailable: 0,
    hardCapLeft: 200,
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

test('worker risk gate - intercepts risky purchase action into pendingHold', async () => {
  const threadId = 'test-worker-risk-intercept';
  createMockRuntime(threadId);

  const checkpointer = new MemorySaver();
  const graph = buildWorkerGraph(checkpointer);
  const siteIn = makeSiteIn();

  const cfg = { configurable: { thread_id: threadId } };
  await graph.invoke({ siteIn }, cfg);

  const state = await graph.getState(cfg);
  assert.ok(state.tasks.some(t => t.interrupts && t.interrupts.length > 0), 'Should have interrupt');
  
  const hold = (state.values as WorkerStateT).pendingHold;
  assert.ok(hold, 'Should set pendingHold');
  assert.equal(hold?.kind, 'confirm_action');
  assert.equal(hold?.variant, 'purchase');
});

test('worker risk gate - resuming pendingHold with approve routes to execute', async () => {
  const threadId = 'test-worker-risk-approve';
  let callCount = 0;
  createMockRuntime(threadId, {
    llm: {
      complete: async () => {
        callCount++;
        if (callCount === 1) {
          return {
            text: '{"thought": "test", "action": "click", "elementId": 1}',
            provider: 'mock',
            model: 'mock-model',
            meta: {},
          };
        }
        return {
          text: '{"thought": "done", "action": "subgoal_done", "subgoal": "checkout"}',
          provider: 'mock',
          model: 'mock-model',
          meta: {},
        };
      },
    },
  });

  const checkpointer = new MemorySaver();
  const graph = buildWorkerGraph(checkpointer);
  const siteIn = makeSiteIn();

  const cfg = { configurable: { thread_id: threadId } };
  await graph.invoke({ siteIn }, cfg);

  // Resume with approve
  await graph.invoke(new Command({ resume: { kind: 'approve' } }), cfg);
  const state = await graph.getState(cfg);

  const workerState = state.values as WorkerStateT;
  assert.equal(workerState.pendingHold, null, 'pendingHold should be cleared');
  assert.ok(workerState.lastExec, 'Action should have executed');
});

test('worker risk gate - resuming pendingHold with approve and remember saves domain', async () => {
  const threadId = 'test-worker-risk-remember';
  let callCount = 0;
  createMockRuntime(threadId, {
    llm: {
      complete: async () => {
        callCount++;
        if (callCount === 1) {
          return {
            text: '{"thought": "nav", "action": "navigate", "url": "https://external-pay.com/pay"}',
            provider: 'mock',
            model: 'mock-model',
            meta: {},
          };
        }
        return {
          text: '{"thought": "done", "action": "subgoal_done", "subgoal": "checkout"}',
          provider: 'mock',
          model: 'mock-model',
          meta: {},
        };
      },
    },
  });

  const checkpointer = new MemorySaver();
  const graph = buildWorkerGraph(checkpointer);
  const siteIn = makeSiteIn();

  const cfg = { configurable: { thread_id: threadId } };
  await graph.invoke({ siteIn }, cfg);

  // Resume with remember: 'site'
  await graph.invoke(new Command({ resume: { kind: 'approve', remember: 'site' } }), cfg);
  const state = await graph.getState(cfg);
  const workerState = state.values as WorkerStateT;

  assert.ok(workerState.siteRun, 'siteRun should be populated');
  assert.ok(workerState.siteRun.approvedNew.includes('external-pay.com'), 'Should record external-pay.com in approvedNew');
});

test('worker risk gate - resuming pendingHold with reject sets denied failure and bans action', async () => {
  const threadId = 'test-worker-risk-reject';
  let callCount = 0;
  createMockRuntime(threadId, {
    llm: {
      complete: async () => {
        callCount++;
        if (callCount === 1) {
          return {
            text: '{"thought": "test", "action": "click", "elementId": 1}',
            provider: 'mock',
            model: 'mock-model',
            meta: {},
          };
        }
        return {
          text: '{"thought": "done", "action": "subgoal_done", "subgoal": "checkout"}',
          provider: 'mock',
          model: 'mock-model',
          meta: {},
        };
      },
    },
  });

  const checkpointer = new MemorySaver();
  const graph = buildWorkerGraph(checkpointer);
  const siteIn = makeSiteIn();

  const cfg = { configurable: { thread_id: threadId } };
  await graph.invoke({ siteIn }, cfg);

  // Resume with reject
  await graph.invoke(new Command({ resume: { kind: 'reject' } }), cfg);
  const state = await graph.getState(cfg);
  const workerState = state.values as WorkerStateT;

  assert.equal(workerState.pendingHold, null);
  assert.ok(workerState.siteRun, 'siteRun should be populated');
  assert.ok(workerState.siteRun.banned.length > 0, 'Denied action should be added to banned set');
});

test('worker risk gate - forbidden action routes to recover and bans signature without retry', async () => {
  const threadId = 'test-worker-risk-forbidden';
  let callCount = 0;
  createMockRuntime(threadId, {
    llm: {
      complete: async () => {
        callCount++;
        if (callCount === 1) {
          return {
            text: '{"thought": "type password", "action": "type", "elementId": 2, "text": "secret123"}',
            provider: 'mock',
            model: 'mock-model',
            meta: {},
          };
        }
        return {
          text: '{"thought": "done", "action": "subgoal_done", "subgoal": "checkout"}',
          provider: 'mock',
          model: 'mock-model',
          meta: {},
        };
      },
    },
  });

  const checkpointer = new MemorySaver();
  const graph = buildWorkerGraph(checkpointer);
  const siteIn = makeSiteIn({ goal: 'Type password' });

  const cfg = { configurable: { thread_id: threadId } };
  await graph.invoke({ siteIn }, cfg);
  const state = await graph.getState(cfg);
  const workerState = state.values as WorkerStateT;

  assert.ok(workerState.siteRun, 'siteRun should be populated');
  assert.ok(workerState.siteRun.banned.length > 0, 'Forbidden action should be banned');
  assert.equal(workerState.pendingHold, null, 'Forbidden actions should never enter hold');
});

test('worker risk gate - reject after prior execution bans denied action, not prior executed action', async () => {
  const threadId = 'test-worker-risk-reject-prior-exec';
  let callCount = 0;
  createMockRuntime(threadId, {
    llm: {
      complete: async () => {
        callCount++;
        if (callCount === 1) {
          return {
            text: '{"thought": "nav", "action": "navigate", "url": "https://external-pay.com/pay"}',
            provider: 'mock',
            model: 'mock-model',
            meta: {},
          };
        }
        if (callCount === 2) {
          return {
            text: '{"thought": "pay", "action": "click", "elementId": 1}',
            provider: 'mock',
            model: 'mock-model',
            meta: {},
          };
        }
        return {
          text: '{"thought": "done", "action": "subgoal_done", "subgoal": "checkout"}',
          provider: 'mock',
          model: 'mock-model',
          meta: {},
        };
      },
    },
  });

  const checkpointer = new MemorySaver();
  const graph = buildWorkerGraph(checkpointer);
  const siteIn = makeSiteIn();

  const cfg = { configurable: { thread_id: threadId } };
  await graph.invoke({ siteIn }, cfg);

  await graph.invoke(new Command({ resume: { kind: 'approve' } }), cfg);
  await graph.invoke(new Command({ resume: { kind: 'reject' } }), cfg);

  const state = await graph.getState(cfg);
  const workerState = state.values as WorkerStateT;

  assert.ok(workerState.siteRun, 'siteRun should be populated');
  assert.ok(workerState.siteRun.banned.includes('click|1|'), 'Denied action [1] must be banned');
  assert.ok(!workerState.siteRun.banned.some(sig => sig.includes('navigate')), 'Prior executed navigate must not be banned');
});
