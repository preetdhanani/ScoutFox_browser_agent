import test from 'node:test';
import assert from 'node:assert/strict';
import { Command } from '@langchain/langgraph/web';
import { buildOrchestratorGraph } from '../../src/background/graph/orchestrator.ts';
import { runtimeRegistry, type RunRuntime } from '../../src/background/runner/runtimeRegistry.ts';
import { SessionStorageSaver } from '../../src/background/checkpoint/SessionStorageSaver.ts';
import { createFakeStorage } from '../helpers/fakeStorageSession.ts';

function createMockRuntime(threadId: string, overrides: Partial<RunRuntime> = {}): RunRuntime {
  let llmCount = 0;
  let currentUrl = 'https://frame.work/products/laptop';

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
      complete: async (req: any) => {
        llmCount++;
        if (req.node === 'plan') {
          return {
            text: JSON.stringify({
              taskKind: 'research',
              searchQuery: 'framework laptop price',
              columns: ['price'],
              priceLike: true,
              compare: {
                reference_domain: 'frame.work',
                field: 'price',
                threshold_pct: 10,
              },
              sites: [
                {
                  id: 's1',
                  name: 'Framework Store',
                  domain: 'frame.work',
                  startUrl: 'https://frame.work/products/laptop',
                  goal: 'Find laptop price',
                  role: 'reference',
                  kind: 'store',
                  difficulty: 2,
                  fields: ['price'],
                  maxBudgetPct: 0.5,
                  criteria: { type: 'all_required', fields: ['price'] },
                },
                {
                  id: 's2',
                  name: 'Idealo Compare',
                  domain: 'idealo.de',
                  startUrl: 'https://idealo.de/framework',
                  goal: 'Compare laptop price',
                  role: 'compare',
                  kind: 'search',
                  difficulty: 1,
                  fields: ['price'],
                  maxBudgetPct: 0.5,
                  criteria: { type: 'all_required', fields: ['price'] },
                },
              ],
            }),
            provider: 'mock',
            model: 'mock-model',
            meta: {},
            usage: { tokensIn: 100, tokensOut: 150 },
          };
        }

        // Worker policy calls
        if (req.messages.some((m: any) => m.content.includes('idealo.de, compare'))) {
          return {
            text: JSON.stringify({
              thought: 'Found Framework price on Idealo comparison site',
              action: 'record_finding',
              field: 'price',
              value: '1.150,00 EUR',
              confidence: 'high',
            }),
            provider: 'mock',
            model: 'mock-model',
            meta: {},
            usage: { tokensIn: 50, tokensOut: 20 },
          };
        }

        return {
          text: JSON.stringify({
            thought: 'Found Framework base price on official store',
            action: 'record_finding',
            field: 'price',
            value: '1.000,00 EUR',
            confidence: 'high',
          }),
          provider: 'mock',
          model: 'mock-model',
          meta: {},
          usage: { tokensIn: 50, tokensOut: 20 },
        };
      },
    },
    browser: {
      tabInfo: async () => ({
        url: currentUrl,
        title: 'Framework Laptop Store',
        windowId: 1,
        groupId: 0,
        status: 'complete',
      }),
      snapshot: async () => {
        let domain = 'frame.work';
        try {
          domain = new URL(currentUrl).hostname;
        } catch {}
        return {
          docId: 'doc-123',
          tabId: 101,
          url: currentUrl,
          domain,
          title: 'Store Product Page',
          scrollY: 0,
          pageHeight: 1000,
          viewportHeight: 800,
          elementCount: 20,
          elements: [
            { id: 1, tag: 'h1', text: 'Store' },
            { id: 2, tag: 'p', text: 'Framework Laptop Base Price: 1.000,00 EUR. Idealo offers 1.150,00 EUR' },
          ],
          pageText: 'Framework Laptop Base Price: 1.000,00 EUR. Idealo offers 1.150,00 EUR. Detailed product listings and shopping options.',
          rawHtml: '<!DOCTYPE html><html><head><title>Store Product Page</title></head><body><h1>Store</h1><p>Framework Laptop Base Price: 1.000,00 EUR. Idealo offers 1.150,00 EUR. Detailed product listings and shopping options.</p></body></html>',
        };
      },
      pageSig: async () => ({
        sig: {
          url: currentUrl,
          title: 'Store Product Page',
          elementCount: 20,
          interactiveHash: 'hash-interactive',
          textHash: 'hash-text',
          scrollY: 0,
        },
        priceHits: 1,
        found: ['1.000,00 EUR'],
      }),
      execute: async () => ({
        success: true,
        via: 'synthetic',
        effect: 'dom_changed',
      }),
      navigate: async (_tabId: number, url: string) => {
        currentUrl = url;
      },
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
      marker: () => 'm:1',
      read: () => '',
    },
    emit: {
      enterNode: () => {},
      setPhase: () => {},
    },
    clock: {
      now: () => 1700000000000,
      sleep: async () => {},
    },
    ...overrides,
  };

  runtimeRegistry.set(mockRuntime);
  return mockRuntime;
}

test('Orchestrator executes multi-site plan, schedules reference site first, and recycles slack', async () => {
  const threadId = 'orch-test-multi-site';
  createMockRuntime(threadId);

  const fakeStore = createFakeStorage();
  const checkpointer = new SessionStorageSaver(fakeStore.connect().session);
  const orchestrator = buildOrchestratorGraph(checkpointer);

  const thread = { configurable: { thread_id: threadId }, durability: 'sync' as const };

  // 1. Initial invocation: runs intake -> profile -> plan -> hold (interrupt for plan approval)
  const pausedState = await orchestrator.invoke({
    task: 'Compare prices for Framework laptop between frame.work and idealo.de',
  }, thread);

  assert.equal(pausedState.phase, 'approve');
  assert.equal(pausedState.planMeta?.sites.length, 2);
  assert.equal(pausedState.planMeta?.sites[0].role, 'reference');
  assert.equal(pausedState.planMeta?.sites[0].domain, 'frame.work');
  assert.equal(pausedState.planMeta?.sites[1].role, 'compare');
  assert.equal(pausedState.planMeta?.sites[1].domain, 'idealo.de');

  // 2. Resume hold with approval
  const finalState = await orchestrator.invoke(new Command({
    resume: { kind: 'approve' },
  }), thread);

  // 3. Verify budget allocation occurred
  assert.ok(finalState.budget);
  assert.equal(finalState.budget.hardCap, 250);
  assert.ok(finalState.budget.sites['s1']);
  assert.ok(finalState.budget.sites['s2']);
  assert.ok(finalState.budget.sites['s1'].alloc > 0);
  assert.ok(finalState.budget.sites['s2'].alloc > 0);

  // 4. Verify both sites were executed and completed
  assert.equal(finalState.siteSummaries?.length, 2);
  assert.equal(finalState.siteSummaries[0].siteId, 's1');
  assert.equal(finalState.siteSummaries[0].status, 'done');
  assert.equal(finalState.siteSummaries[1].siteId, 's2');
  assert.equal(finalState.siteSummaries[1].status, 'done');

  // 5. Verify slack recycling
  assert.ok(finalState.budget.slack >= 0);

  // 6. Verify truth table and finish entry
  const lastHistory = finalState.history?.[finalState.history.length - 1];
  assert.equal(lastHistory?.type, 'finish');
  if (lastHistory?.type === 'finish') {
    assert.ok(lastHistory.table);
    assert.equal(lastHistory.table.rows.length, 2);
    // Idealo row has +15% comparison flag
    const idealoRow = lastHistory.table.rows.find((r) => r.site === 'idealo.de');
    assert.ok(idealoRow);
    assert.equal(idealoRow.cells.price?.flag, '+15.0% vs reference');
  }

  // 7. Verify endReason
  assert.equal(finalState.endReason, 'all_subgoals_done');
  assert.equal(finalState.runStatus, 'idle');
});

test('Orchestrator plan rejection terminates run with plan_rejected', async () => {
  const threadId = 'orch-test-reject';
  createMockRuntime(threadId);

  const fakeStore = createFakeStorage();
  const checkpointer = new SessionStorageSaver(fakeStore.connect().session);
  const orchestrator = buildOrchestratorGraph(checkpointer);

  const thread = { configurable: { thread_id: threadId }, durability: 'sync' as const };

  // Initial invoke runs until approve_plan interrupt
  await orchestrator.invoke({
    task: 'Search laptops',
  }, thread);

  // Reject plan
  const finalState = await orchestrator.invoke(new Command({
    resume: { kind: 'reject' },
  }), thread);

  assert.equal(finalState.endReason, 'plan_rejected');
  assert.equal(finalState.runStatus, 'idle');
});

test('Orchestrator produces offer when site ends partial', async () => {
  const threadId = 'orch-test-offer';
  createMockRuntime(threadId, {
    llm: {
      complete: async (req: any) => {
        if (req.node === 'plan') {
          return {
            text: JSON.stringify({
              taskKind: 'research',
              searchQuery: 'framework laptop price',
              columns: ['price'],
              sites: [
                {
                  id: 's1',
                  name: 'Difficult Site',
                  domain: 'diff.test',
                  startUrl: 'https://diff.test',
                  goal: 'Find price',
                  role: 'reference',
                  kind: 'store',
                  difficulty: 3,
                  fields: ['price'],
                  maxBudgetPct: 1.0,
                  criteria: { type: 'all_required', fields: ['price'] },
                },
              ],
            }),
            provider: 'mock',
            model: 'mock-model',
            meta: {},
            usage: { tokensIn: 50, tokensOut: 50 },
          };
        }

        // Return continue_browsing until budget exhausted
        return {
          text: JSON.stringify({
            thought: 'Browsing looking for price',
            action: 'continue_browsing',
            reason: 'Still searching',
          }),
          provider: 'mock',
          model: 'mock-model',
          meta: {},
          usage: { tokensIn: 20, tokensOut: 10 },
        };
      },
    },
  });

  const fakeStore = createFakeStorage();
  const checkpointer = new SessionStorageSaver(fakeStore.connect().session);
  const orchestrator = buildOrchestratorGraph(checkpointer);

  const thread = { configurable: { thread_id: threadId }, durability: 'sync' as const };

  await orchestrator.invoke({
    task: 'Find price on difficult site',
    limits: { maxSteps: 6, maxSystemActions: 6, maxParseErrorsPerTurn: 6, maxConsecutiveParseErrors: 3 },
  }, thread);

  const finalState = await orchestrator.invoke(new Command({
    resume: { kind: 'approve' },
  }), thread);

  assert.equal(finalState.siteSummaries?.[0]?.status, 'partial');
  assert.ok(finalState.offerPayload);
  assert.deepEqual(finalState.offerPayload.partialSiteIds, ['s1']);
  assert.equal(finalState.offerPayload.suggestedLevel, 'high');
});
