// src/background/graph/orchestrator.ts
// Orchestrator graph (StateGraph API, '@langchain/langgraph/web').
// Manages high-level plan, profile, site scheduling, and outcomes across sites.
import { END, START, StateGraph, type BaseCheckpointSaver } from '@langchain/langgraph/web';
import { AgentState, DEFAULT_LIMITS, type AgentStateT, type AgentUpdate, type HistoryEntry, type PlanMeta, type SiteSpec } from './state.ts';
import { ORCHESTRATOR_ROUTE_MAPS, planRouter, holdRouter, schedRouter, summaryRouter, reflectRouter, compileRouter } from './routes.ts';
import { defineNode, getRuntime } from '../runner/runtimeRegistry.ts';
import { buildWorkerGraph, buildSiteOut } from './worker.ts';
import { interruptWithConfig } from './interrupt.ts';

// ---------------------------------------------------------------------------------------------
// Orchestrator Node Definitions
// ---------------------------------------------------------------------------------------------

const intakeNode = defineNode<AgentStateT, Partial<AgentUpdate>>('orchestrator', 'intake', (state, config) => {
  const runtime = getRuntime(config);
  const task = state.task;
  const userGoalEntry: HistoryEntry = {
    type: 'user_goal',
    turn: (state.turnIndex ?? 0) + 1,
    prompt: task,
    timestamp: new Date(runtime.clock.now()).toISOString(),
    isNewRun: true,
  };

  return {
    turnIndex: (state.turnIndex ?? 0) + 1,
    runId: `run_${runtime.clock.now()}`,
    tier: 'small',
    limits: state.limits ?? DEFAULT_LIMITS,
    runStatus: 'running',
    phase: 'plan',
    stepCount: 0,
    systemActionCount: 0,
    parseErrorsThisTurn: 0,
    everParsedOk: false,
    history: [userGoalEntry],
  };
});

const profileNode = defineNode<AgentStateT, Partial<AgentUpdate>>('orchestrator', 'profile', (state) => {
  const level = state.effort?.level ?? 'medium';
  const profile = {
    level,
    multiplier: 2,
    retriesPerAction: 1,
    altStrategy: false,
    verifyMode: 'url' as const,
    blockedLadder: ['reload' as const, 'mark' as const],
    reflect: 'site_end' as const,
    maxReplans: 1,
    evidence: 'snippet' as const,
    reservePct: 0.15,
    useModelOverrides: false,
    softCapAsk: false,
  };

  return {
    effort: { requested: state.effort?.requested ?? 'auto', level, suggestedBy: 'default' },
    effortProfile: profile,
  };
});

const planNode = defineNode<AgentStateT, Partial<AgentUpdate>>('orchestrator', 'plan', async (state, config) => {
  const runtime = getRuntime(config);
  const activeTabId = runtime.tabs.activeTabId ?? runtime.ownerTabId;
  const tabInfo = await runtime.browser.tabInfo(activeTabId).catch(() => null);

  let domain = 'this_page';
  if (tabInfo?.url) {
    try {
      domain = new URL(tabInfo.url).hostname;
    } catch {
      // Keep default
    }
  }

  const implicitSite: SiteSpec = {
    id: 's1',
    name: domain,
    domain,
    goal: state.task,
    goalKind: 'collect',
    role: 'reference',
    kind: 'page',
    difficulty: 1,
    namedByUser: true,
    criteria: {
      fields: [{ name: 'value', required: true }],
      doneWhen: 'all_required',
    },
  };

  const plan: PlanMeta = {
    version: 1,
    taskKind: 'research',
    columns: ['value'],
    priceLike: false,
    searchQuery: state.task.slice(0, 40),
    sites: [implicitSite],
    source: 'fallback',
  };

  return {
    planMeta: plan,
    sites: { $set: { s1: { status: 'pending', criteriaMet: false } } },
    approvedDomains: [domain],
    phase: 'approve',
    pendingHold: { kind: 'approve_plan' },
  };
});

const holdNode = defineNode<AgentStateT, Partial<AgentUpdate>>('orchestrator', 'hold', (state, config) => {
  const resume = interruptWithConfig<any, any>(config, state.pendingHold ?? { kind: 'approve_plan' });

  if (resume?.kind === 'approve') {
    return { resumeRoute: 'alloc' };
  }
  if (resume?.kind === 'reject') {
    return { resumeRoute: 'finalize', endReason: 'plan_rejected' };
  }
  if (resume?.kind === 'stop') {
    return { resumeRoute: 'finalize', endReason: 'stopped' };
  }
  return { resumeRoute: state.resumeRoute ?? 'sched' };
});

const allocNode = defineNode<AgentStateT, Partial<AgentUpdate>>('orchestrator', 'alloc', (state) => {
  const hardCap = state.limits?.maxSteps ?? 250;
  const reservePct = state.effortProfile?.reservePct ?? 0.15;
  const reserve = Math.round(hardCap * reservePct);
  const usable = hardCap - reserve;

  const budget = {
    hardCap,
    workingTotal: hardCap,
    reserve,
    slack: 0,
    used: 0,
    sites: {
      s1: { base: usable, alloc: usable, used: 0, extended: false },
    },
  };

  return {
    budget,
    phase: 'sites',
  };
});

const schedNode = defineNode<AgentStateT, Partial<AgentUpdate>>('orchestrator', 'sched', (state, config) => {
  const runtime = getRuntime(config);
  const site = state.planMeta?.sites?.find((s) => {
    const currentStatus = state.sites?.[s.id]?.status;
    return !currentStatus || currentStatus === 'pending';
  });
  if (!site) {
    return { siteIn: null, activeSiteId: null };
  }

  const hardCap = state.limits?.maxSteps ?? 250;
  const used = state.budget?.used ?? 0;
  const reserve = state.budget?.reserve ?? 0;
  const hardCapLeft = hardCap - used - reserve;

  const siteIn = {
    site,
    index: 1,
    total: 1,
    task: state.task,
    taskKind: state.planMeta!.taskKind,
    columns: state.planMeta!.columns,
    priceLike: state.planMeta!.priceLike,
    compare: null,
    profile: state.effortProfile!,
    tier: state.tier,
    limits: state.limits,
    runId: state.runId,
    alloc: state.budget.sites[site.id]?.alloc ?? hardCapLeft,
    slackAvailable: state.budget.slack,
    hardCapLeft,
    stepBase: state.stepCount,
    systemActionBase: state.systemActionCount,
    parseErrorsBase: state.parseErrorsThisTurn,
    everParsedOk: state.everParsedOk,
    tabId: runtime.tabs.activeTabId ?? runtime.ownerTabId,
    cdp: state.cdp,
    approvedDomains: state.approvedDomains,
    blocked: Object.values(state.blocked ?? {}),
    visitedRecent: Object.values(state.visited ?? {}).slice(-10),
    findingsLines: [],
    earlierSites: [],
    recap: [],
    priorFindings: [],
  };

  return {
    activeSiteId: site.id,
    siteIn,
    sites: { $set: { [site.id]: { status: 'running', criteriaMet: false } } },
  };
});

export function createSiteNode(workerGraph: ReturnType<typeof buildWorkerGraph>) {
  return defineNode<AgentStateT, Partial<AgentUpdate>>('orchestrator', 'site', async (state, config) => {
    if (!state.siteIn) throw new Error('Orchestrator site: siteIn is required');
    const out = await workerGraph.invoke({ siteIn: state.siteIn }, config);
    const siteOut = buildSiteOut(out);
    return {
      siteOut,
      history: out.history ?? [],
    };
  });
}

const summaryNode = defineNode<AgentStateT, Partial<AgentUpdate>>('orchestrator', 'summary', (state) => {
  const siteOut = state.siteOut;
  if (!siteOut) return {};

  const siteId = siteOut.siteId;
  const siteEndEntry: HistoryEntry = {
    type: 'site_end',
    siteId,
    site: siteId,
    status: siteOut.status,
    reason: siteOut.reason,
    findings: siteOut.findings.length,
    stepsUsed: siteOut.used,
  };

  const summary = {
    siteId,
    status: siteOut.status,
    criteriaMet: siteOut.criteriaMet,
    findings: siteOut.findings.length,
    blockers: [],
    stepsUsed: siteOut.used,
    failures: siteOut.failures,
    anomalies: siteOut.anomalies,
    userAnswered: siteOut.userAnswered,
    notes: siteOut.notes,
  };

  const currentUsed = state.budget?.used ?? 0;
  const newBudget = state.budget
    ? {
        ...state.budget,
        used: currentUsed + siteOut.used,
      }
    : state.budget;

  return {
    sites: {
      $set: {
        [siteId]: {
          status: siteOut.status,
          criteriaMet: siteOut.criteriaMet,
          reason: siteOut.reason,
        },
      },
    },
    siteSummaries: [summary],
    siteIn: null,
    budget: newBudget,
    stepCount: (state.stepCount ?? 0) + siteOut.used,
    systemActionCount: (state.systemActionCount ?? 0) + siteOut.systemActions,
    history: [siteEndEntry],
  };
});

const reflectNode = defineNode<AgentStateT, Partial<AgentUpdate>>('orchestrator', 'reflect', () => {
  return {
    reflectResult: {
      decision: 'continue',
      reason: 'P4 fast path',
      changes: '',
      by: 'fast_path',
    },
  };
});

const compileNode = defineNode<AgentStateT, Partial<AgentUpdate>>('orchestrator', 'compile', (state) => {
  const sites = Object.values(state.sites ?? {});
  const allDone = sites.length > 0 && sites.every((s) => s.status === 'done');
  const stopped = state.ctl?.stopRequested || state.siteOut?.status === 'stopped';

  let endReason: any = 'stopped_early';
  let historyEntry: HistoryEntry;

  if (stopped) {
    endReason = 'stopped';
    historyEntry = {
      type: 'partial_result',
      answer: 'Task was stopped by user.',
      table: null,
      reason: 'stopped',
    };
  } else if (allDone) {
    endReason = 'all_subgoals_done';
    const answer = state.siteOut?.finalAnswer?.text ?? 'Task completed successfully.';
    historyEntry = {
      type: 'finish',
      answer,
    };
  } else {
    endReason = 'stopped_early';
    historyEntry = {
      type: 'partial_result',
      answer: 'Task ended without completing all goals.',
      table: null,
      reason: 'stopped_early',
    };
  }

  return {
    endReason,
    finalAnswer: {
      text: historyEntry.type === 'finish' ? historyEntry.answer : (historyEntry as any).answer,
      unconfirmed: false,
      table: null,
      partial: !allDone,
    },
    history: [historyEntry],
  };
});

const offerNode = defineNode<AgentStateT, Partial<AgentUpdate>>('orchestrator', 'offer', () => {
  return {};
});

const finalizeNode = defineNode<AgentStateT, Partial<AgentUpdate>>('orchestrator', 'finalize', async (state, config) => {
  const runtime = getRuntime(config);
  const activeTabId = runtime.tabs.activeTabId ?? runtime.ownerTabId;
  await runtime.browser.clearBadges(activeTabId).catch(() => {});

  const runStatus = state.ctl?.stopRequested ? 'stopped' : 'idle';
  return {
    runStatus,
    phase: 'done',
  };
});

// ---------------------------------------------------------------------------------------------
// Orchestrator Graph Builder
// ---------------------------------------------------------------------------------------------

export function buildOrchestratorGraph(checkpointer?: BaseCheckpointSaver) {
  const workerGraph = buildWorkerGraph();
  const siteNode = createSiteNode(workerGraph);

  const graph = new StateGraph(AgentState)
    .addNode('intake', intakeNode)
    .addNode('profile', profileNode)
    .addNode('plan', planNode)
    .addNode('hold', holdNode)
    .addNode('alloc', allocNode)
    .addNode('sched', schedNode)
    .addNode('site', siteNode)
    .addNode('summary', summaryNode)
    .addNode('reflect', reflectNode)
    .addNode('compile', compileNode)
    .addNode('offer', offerNode)
    .addNode('finalize', finalizeNode)
    .addEdge(START, 'intake')
    .addEdge('intake', 'profile')
    .addEdge('profile', 'plan')
    .addConditionalEdges('plan', planRouter, ORCHESTRATOR_ROUTE_MAPS.plan)
    .addConditionalEdges('hold', holdRouter, ORCHESTRATOR_ROUTE_MAPS.hold)
    .addEdge('alloc', 'sched')
    .addConditionalEdges('sched', schedRouter, ORCHESTRATOR_ROUTE_MAPS.sched)
    .addEdge('site', 'summary')
    .addConditionalEdges('summary', summaryRouter, ORCHESTRATOR_ROUTE_MAPS.summary)
    .addConditionalEdges('reflect', reflectRouter, ORCHESTRATOR_ROUTE_MAPS.reflect)
    .addConditionalEdges('compile', compileRouter, ORCHESTRATOR_ROUTE_MAPS.compile)
    .addEdge('offer', 'finalize')
    .addEdge('finalize', END);

  return graph.compile({ checkpointer });
}
