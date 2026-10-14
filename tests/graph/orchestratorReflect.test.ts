// tests/graph/orchestratorReflect.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { Command } from '@langchain/langgraph/web';
import { buildOrchestratorGraph } from '../../src/background/graph/orchestrator.ts';
import { runtimeRegistry, type RunRuntime } from '../../src/background/runner/runtimeRegistry.ts';
import { SessionStorageSaver } from '../../src/background/checkpoint/SessionStorageSaver.ts';
import { createFakeStorage } from '../helpers/fakeStorageSession.ts';
import { previousTurnsSummary } from '../../src/background/agent/previousTurns.ts';
import { graphRig, act, shopPages } from '../helpers/graphHarness.ts';

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

const THREE_SITE_PLAN = {
  taskKind: 'research',
  searchQuery: 'framework laptop price',
  columns: ['price'],
  priceLike: true,
  sites: [
    { id: 's1', name: 'Framework Store', domain: 'frame.work', startUrl: 'https://frame.work/products/laptop', goal: 'Find laptop price', role: 'reference', kind: 'store', difficulty: 1 },
    { id: 's2', name: 'Competitor Store', domain: 'competitor.test', startUrl: 'https://competitor.test/laptop', goal: 'Find competitor price', role: 'compare', kind: 'store', difficulty: 2 },
    { id: 's3', name: 'Third Store', domain: 'third.test', startUrl: 'https://third.test/laptop', goal: 'Find third price', role: 'compare', kind: 'store', difficulty: 2 },
  ],
};

// A stop_early while planned sites are still pending is not a success: the skipped sites were never
// checked, so the run must end as a partial result that names them, never as a "Done" finish entry.
test('orchestratorReflect: stop_early with pending sites ends as a partial result that names the skipped sites', async (t) => {
  const threadId = 'test-reflect-stop-early';
  createMockRuntime(threadId, {
    customPlan: THREE_SITE_PLAN,
    reflectReply: { decision: 'stop_early', reason: 'The reference price is enough' },
  });
  t.after(() => runtimeRegistry.delete(threadId));

  const fakeStorage = createFakeStorage();
  const saver = new SessionStorageSaver(fakeStorage.connect().session as any);
  const graph = buildOrchestratorGraph(saver);
  const config = { configurable: { thread_id: threadId } };

  let step = await graph.invoke(
    {
      task: 'Compare laptop price across sites',
      effort: { requested: 'medium', level: 'medium', suggestedBy: 'user' },
    },
    config,
  );
  if (step.pendingHold?.kind === 'approve_plan') {
    step = await graph.invoke(new Command({ resume: { kind: 'approve' } }), config);
  }

  assert.equal(step.runStatus, 'idle');
  assert.equal(step.reflectResult?.decision, 'stop_early');
  assert.ok(!step.history.some((h: any) => h.type === 'finish'), 'a stop_early with pending sites must never write a finish entry');
  assert.ok(!step.history.some((h: any) => /Task completed early/.test(String(h.answer ?? h.content ?? ''))));
  const last = step.history.at(-1) as any;
  assert.equal(last?.type, 'partial_result', JSON.stringify(last)?.slice(0, 300));
  assert.equal(last.reason, 'stopped_early');
  assert.match(last.answer, /^Stopped early: The reference price is enough/);
  assert.match(last.answer, /competitor\.test/);
  assert.match(last.answer, /third\.test/);
  assert.deepEqual(last.skippedSites.map((s: any) => s.siteId), ['s2', 's3']);
  assert.equal(step.finalAnswer?.partial, true);
  assert.equal(step.endReason, 'stopped_early');
  // The pending sites are marked skipped with the reason, as the design doc says.
  assert.equal(step.sites.s2.status, 'skipped');
  assert.equal(step.sites.s3.status, 'skipped');
  assert.match(String(step.sites.s2.reason), /The reference price is enough/);
  // Their table rows say they were not checked, instead of "not found".
  const rowS2 = last.table?.rows.find((r: any) => r.siteId === 's2');
  assert.equal(rowS2?.status, 'skipped');
  assert.match(last.answer, /\*\*competitor\.test\*\* \(compare\) \| not checked/);
  // The next-turn recap does not call the run completed.
  const recap = previousTurnsSummary([{ type: 'user_goal', turn: 1, prompt: 'Compare laptop price across sites', timestamp: '', isNewRun: true }, ...step.history]);
  assert.match(recap.join('\n'), /did not finish - partial/);
});

// A closed tab ends the whole run. With findings already recorded the card must still lead with the
// tab-closed reason (findings table below), never turn the fatal exit into a success.
test('orchestratorReflect: tab_gone with findings ends as a partial result with the tab-closed reason above the table', async (t) => {
  const threadId = 'test-reflect-tab-gone-findings';
  const runtime = createMockRuntime(threadId, { customPlan: THREE_SITE_PLAN });
  t.after(() => runtimeRegistry.delete(threadId));
  let lastUrl = '';
  const browser = runtime.browser as any;
  const healthySnapshot = browser.snapshot;
  browser.navigate = async (_tabId: number, url: string) => { lastUrl = url; };
  browser.snapshot = async (...args: any[]) => {
    if (lastUrl.includes('competitor.test')) throw new Error('Tab 201 no longer exists');
    return healthySnapshot(...args);
  };

  const fakeStorage = createFakeStorage();
  const saver = new SessionStorageSaver(fakeStorage.connect().session as any);
  const graph = buildOrchestratorGraph(saver);
  const config = { configurable: { thread_id: threadId } };

  let step = await graph.invoke(
    {
      task: 'Compare laptop price across sites',
      effort: { requested: 'medium', level: 'medium', suggestedBy: 'user' },
    },
    config,
  );
  if (step.pendingHold?.kind === 'approve_plan') {
    step = await graph.invoke(new Command({ resume: { kind: 'approve' } }), config);
  }

  assert.equal(step.runStatus, 'idle');
  assert.ok((step.findings ?? []).length > 0, 'site 1 must have recorded a finding');
  assert.equal(step.siteOut?.fatal, 'tab_gone');
  assert.ok(!step.history.some((h: any) => h.type === 'finish'), 'a run-fatal exit must never write a finish entry');
  const last = step.history.at(-1) as any;
  assert.equal(last?.type, 'partial_result', JSON.stringify(last)?.slice(0, 300));
  assert.match(last.answer, /^The tab was closed, so the task stopped\./);
  const tableAt = last.answer.indexOf('| Site');
  assert.ok(tableAt > 0, 'the findings table must follow the reason');
  assert.match(last.answer.slice(tableAt), /1\.200 EUR/);
  assert.match(last.answer.slice(0, tableAt), /third\.test/, 'the never-started site is named as skipped');
  assert.deepEqual(last.skippedSites.map((s: any) => s.siteId), ['s3']);
  assert.equal(step.sites.s3.status, 'skipped');
  assert.equal(step.finalAnswer?.partial, true);
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
  assert.equal(step.budget.sites?.s2, undefined, 'Dropped site s2 must be pruned from budget.sites');
  assert.ok(step.budget.sites?.s3);
  assert.ok(step.budget.reserve > 0, 'Reserve budget must not be drained to 0');
});

test('orchestratorReflect: Reflect LLM failure gracefully continues existing plan without hold loop', async (t) => {
  const threadId = 'test-reflect-llm-fail';

  createMockRuntime(threadId, {
    onReflectCall: () => {
      throw new Error('LLM call timed out');
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

  if (step.pendingHold?.kind === 'approve_plan') {
    step = await graph.invoke(new Command({ resume: { kind: 'approve' } }), config);
  }

  assert.equal(step.runStatus, 'idle');
  assert.equal(step.sites?.s1?.status, 'done');
  assert.equal(step.sites?.s2?.status, 'done');
  assert.ok(step.history.some((h: any) => h.type === 'finish'));
});

// ---------------------------------------------------------------------------
// The replan add-domain gate, driven through the REAL AgentRunner.
//
// A revision that adds a domain grows the agent's scope: the runner must never
// answer that hold by itself, even with autoApprovePlan. The user gets a card
// ("The agent wants to add <domain>: <reason>") with Allow and Deny, where Deny
// continues the run on the existing plan without the new domain. A domain the
// task text itself names (or a page the run read) is grounded and needs no card.
//
// The script: s1 (a collect site) records its price and ends with subgoal_done -
// a finish on the first site would set the final answer and compile the run
// before reflect ever runs. s2 (competitor.test) exists but is unreachable (a
// 500): the site ends blocked, reflect runs, and the reflect reply replans with
// the ungrounded altshop.test.
// ---------------------------------------------------------------------------

const ALTSHOP_PAGE = {
  url: 'https://altshop.test/item',
  title: 'Alt Shop Item',
  text: ['Price: 95 USD'],
  elements: [],
};

const TWO_SITE_PLAN_REPLY = {
  text: JSON.stringify({
    taskKind: 'research',
    searchQuery: 'laptop price',
    columns: ['price'],
    sites: [
      { id: 's1', name: 'Shop', domain: 'shop.test', role: 'reference', kind: 'page', goal: 'Find the price' },
      { id: 's2', name: 'Competitor', domain: 'competitor.test', role: 'compare', kind: 'store', goal: 'Find the competitor price' },
    ],
  }),
};

const REPLAN_ADD_ALTSHOP = {
  text: JSON.stringify({
    decision: 'replan',
    reason: 'The competitor shop is unreachable, try the alternate shop',
    changes: 'Drop s2, add the alternate shop',
    drop_sites: ['s2'],
    add_sites: [
      {
        name: 'Alt Shop',
        domain: 'altshop.test',
        startUrl: 'https://altshop.test/item',
        goal: 'Find the price on the alternate shop',
        role: 'compare',
        kind: 'store',
        difficulty: 1,
      },
    ],
  }),
};

/** record_finding with a page-backed value, so s1 ends done with its criteria met. */
function recordFinding(field: string, value: string): string {
  return JSON.stringify({ action: 'record_finding', field, value });
}

const COMPETITOR_PAGE = {
  url: 'https://competitor.test/item',
  title: 'Internal Server Error',
  text: ['500 Internal Server Error - The server had an error.'],
  elements: [],
};

function replanRigOptions() {
  return {
    autoApprove: true,
    plan: TWO_SITE_PLAN_REPLY,
    reflect: [REPLAN_ADD_ALTSHOP],
    policy: [
      recordFinding('price', '99 USD'),
      act.subgoalDone('Found the price on the shop: 99 USD', 'Item 42 available for 99 USD'),
      act.navigate('https://altshop.test/item'),
      act.finish('The alt shop price is 95 USD.'),
    ],
    pages: [...shopPages(), ALTSHOP_PAGE, COMPETITOR_PAGE],
  };
}

test('orchestratorReflect: a replan that adds a domain the task never named and no page read pauses with an approval card instead of being auto-approved', async (t) => {
  const rig = await graphRig(replanRigOptions());
  t.after(rig.cleanup);

  await rig.start('Compare laptop prices', { effort: 'medium' });

  assert.equal(rig.status(), 'paused', 'a scope-growing replan must wait for the user, not be auto-approved');
  const approval = rig.pending().approval as any;
  assert.ok(approval, 'the revision hold is pending as an approval card');
  assert.equal(approval.kind, 'approve_plan');
  assert.equal(approval.planMeta?.version, 2);
  assert.deepEqual(approval.addedDomains, ['altshop.test']);
  assert.match(String(approval.replanReason), /alternate shop/);
  rig.assertClean();
});

test('orchestratorReflect: denying the add-domain card continues the run on the existing plan without the new domain', async (t) => {
  const rig = await graphRig(replanRigOptions());
  t.after(rig.cleanup);

  await rig.start('Compare laptop prices', { effort: 'medium' });
  assert.equal(rig.status(), 'paused');

  await rig.approvePlan({ decision: 'deny' });

  assert.equal(rig.status(), 'idle');
  assert.ok(rig.finishAnswer(), 'the run finished on the existing plan');
  assert.equal(rig.pending().approval, null);
  const planSteps = rig.state().planSteps as Array<{ id: string; status: string }>;
  assert.ok(!planSteps.some((s) => s.id === 's3'), 'the denied site is out of the plan');
  assert.equal(planSteps.find((s) => s.id === 's1')?.status, 'completed');
  assert.ok(
    rig.history().some((h) => h.type === 'notice' && /denied/i.test(String(h.content))),
    'the panel is told the added domain was denied',
  );
  assert.equal(rig.llm.callsOf('plan').length, 1, 'a deny never re-plans: the revision is applied by code, and so is the deny');
  rig.assertClean();
});

test('orchestratorReflect: allowing the add-domain card runs the new site', async (t) => {
  const rig = await graphRig(replanRigOptions());
  t.after(rig.cleanup);

  await rig.start('Compare laptop prices', { effort: 'medium' });
  assert.equal(rig.status(), 'paused');

  await rig.approvePlan({ decision: 'approve' });

  assert.equal(rig.status(), 'idle');
  assert.equal(rig.pending().approval, null);
  const planSteps = rig.state().planSteps as Array<{ id: string; status: string }>;
  assert.equal(planSteps.find((s) => s.id === 's3')?.status, 'completed', 'the allowed site ran');
  rig.assertClean();
});

test('orchestratorReflect: a replan may add a domain the task itself names without an extra approval card', async (t) => {
  const rig = await graphRig(replanRigOptions());
  t.after(rig.cleanup);

  const seen: string[] = [];
  rig.runner.setStateChangeCallback((state) => { seen.push(String(state.status)); });

  await rig.start('Compare laptop prices on altshop.test', { effort: 'medium' });

  assert.equal(rig.status(), 'idle');
  assert.equal(rig.pending().approval, null);
  assert.ok(!seen.includes('paused'), `a grounded added domain never pauses the run (${[...new Set(seen)].join(', ')})`);
  const planSteps = rig.state().planSteps as Array<{ id: string; status: string }>;
  assert.equal(planSteps.find((s) => s.id === 's3')?.status, 'completed', 'the grounded site ran without a card');
  rig.assertClean();
});

