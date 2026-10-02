// src/background/graph/orchestrator.ts
// Orchestrator graph (StateGraph API, '@langchain/langgraph/web').
// Manages high-level plan, profile, site scheduling, and outcomes across sites.
import { END, START, StateGraph, type BaseCheckpointSaver } from '@langchain/langgraph/web';
import {
  AgentState,
  DEFAULT_LIMITS,
  type AgentStateT,
  type AgentUpdate,
  type BlockedSource,
  type Finding,
  type FindingsTable,
  type HistoryEntry,
  type Offer,
  type PlanMeta,
  type SiteSpec,
  type SiteSummary,
} from './state.ts';
import type { SiteIn } from './workerState.ts';
import { ORCHESTRATOR_ROUTE_MAPS, planRouter, holdRouter, schedRouter, summaryRouter, reflectRouter, compileRouter } from './routes.ts';
import { defineNode, getRuntime } from '../runner/runtimeRegistry.ts';
import { buildWorkerGraph, buildSiteOut } from './worker.ts';
import { interruptWithConfig } from './interrupt.ts';
import { buildGraphPlanSchema } from '../agent/schemas.ts';
import { computeSiteBase, computeSiteAlloc, computeWorkingTotal, computeUsableBudget } from '../agent/budget.ts';
import { deduplicateFindings, compileTruthTable, renderTruthTableMarkdown } from '../agent/findings.ts';
import { buildPlanSystemPrompt, buildPlanUserMessage } from '../agent/prompts.ts';

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

  let currentDomain = 'this_page';
  let currentUrl = tabInfo?.url ?? '';
  if (tabInfo?.url) {
    try {
      currentDomain = new URL(tabInfo.url).hostname;
    } catch {}
  }

  const system = buildPlanSystemPrompt('initial');
  const userMessage = buildPlanUserMessage({
    task: state.task,
    tabTitle: tabInfo?.title,
    tabUrl: currentUrl,
  });

  const schema = buildGraphPlanSchema({ mode: 'initial' });
  const stepSignal = runtime.control.stepSignal();
  let parsedPlan: any = null;

  try {
    const res = await runtime.llm.complete({
      node: 'plan',
      mode: 'initial',
      role: 'planner',
      system,
      messages: [{ role: 'user', content: userMessage }],
      schema,
      signal: stepSignal,
    });

    const replyText = res.text || '';
    const cleaned = replyText.replace(/<(?:think|thought|reasoning)>[\s\S]*?<\/(?:think|thought|reasoning)>/gi, '').trim();
    const fenceMatch = cleaned.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i);
    const jsonStr = fenceMatch ? fenceMatch[1] : (cleaned.match(/\{[\s\S]*\}/)?.[0] ?? '');
    if (jsonStr) {
      parsedPlan = JSON.parse(jsonStr);
    }
  } catch {
    parsedPlan = null;
  }

  let planMeta: PlanMeta;
  if (parsedPlan && Array.isArray(parsedPlan.sites) && parsedPlan.sites.length > 0) {
    const taskKind = parsedPlan.task_kind || parsedPlan.taskKind || 'research';
    const columns: string[] = Array.isArray(parsedPlan.columns)
      ? parsedPlan.columns.map((c: string) => String(c).toLowerCase().replace(/[^a-z0-9_]/g, '_')).slice(0, 5)
      : ['value'];
    const priceLike = columns.some((c) => /price|cost|preis|shipping/i.test(c));

    const sites: SiteSpec[] = parsedPlan.sites.slice(0, 4).map((s: any, idx: number) => {
      const id = `s${idx + 1}`;
      const domain = s.domain || currentDomain;
      const goalKind = s.goalKind || s.goal_kind || (taskKind === 'action' ? 'do' : 'collect');
      const rawDoneWhen = s.done_when || s.doneWhen || s.criteria?.doneWhen || s.criteria?.done_when || s.criteria?.type;
      const doneWhen: 'all_required' | 'any' | 'predicate' =
        rawDoneWhen === 'predicate' || rawDoneWhen === 'any' || rawDoneWhen === 'all_required'
          ? rawDoneWhen
          : (goalKind === 'do' ? 'predicate' : 'all_required');

      let predicate: Predicate | undefined = undefined;
      if (s.predicate?.type && s.predicate?.value) {
        predicate = s.predicate;
      } else if (s.criteria?.predicate?.type && s.criteria?.predicate?.value) {
        predicate = s.criteria.predicate;
      } else if (s.check && s.check.type && s.check.type !== 'none' && s.check.value) {
        predicate = { type: s.check.type, value: String(s.check.value) };
      }

      const rawFields = s.required_fields || s.requiredFields || s.fields || s.criteria?.fields;
      let fields: Array<{ name: string; required: boolean }>;
      if (Array.isArray(rawFields) && rawFields.length > 0) {
        fields = rawFields.map((f: any) => {
          if (typeof f === 'string') {
            return { name: f.toLowerCase().replace(/[^a-z0-9_]/g, '_'), required: true };
          }
          return {
            name: String(f.name || 'value').toLowerCase().replace(/[^a-z0-9_]/g, '_'),
            required: f.required !== false,
          };
        });
      } else if (doneWhen === 'predicate') {
        fields = [];
      } else {
        fields = columns.map((col) => ({ name: col, required: true }));
      }

      return {
        id,
        name: s.name || domain,
        domain,
        goal: s.goal || state.task,
        goalKind,
        startUrl: s.startUrl || s.url || (idx === 0 && currentUrl.startsWith('http') ? currentUrl : undefined),
        searchQuery: s.searchQuery || s.search_query || `${parsedPlan.search_query || parsedPlan.searchQuery || state.task} site:${domain}`,
        role: idx === 0 ? 'reference' : (s.role || 'compare'),
        kind: s.kind || 'store',
        difficulty: (s.difficulty === 1 || s.difficulty === 2 || s.difficulty === 3) ? s.difficulty : 1,
        namedByUser: true,
        criteria: {
          fields,
          doneWhen,
          ...(predicate ? { predicate } : {}),
        },
      };
    });

    planMeta = {
      version: 1,
      taskKind,
      columns,
      priceLike,
      searchQuery: parsedPlan.search_query || parsedPlan.searchQuery || state.task.slice(0, 40),
      compare: parsedPlan.compare,
      sites,
      source: 'llm',
    };
  } else {
    // Deterministic fallback
    const implicitSite: SiteSpec = {
      id: 's1',
      name: currentDomain,
      domain: currentDomain,
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

    planMeta = {
      version: 1,
      taskKind: 'research',
      columns: ['value'],
      priceLike: false,
      searchQuery: state.task.slice(0, 40),
      sites: [implicitSite],
      source: 'fallback',
    };
  }

  const siteMap: Record<string, { status: 'pending'; criteriaMet: false }> = {};
  const approved = new Set<string>(state.approvedDomains ?? []);
  for (const s of planMeta.sites) {
    siteMap[s.id] = { status: 'pending', criteriaMet: false };
    if (s.domain && s.domain !== 'this_page') {
      approved.add(s.domain);
    }
  }

  return {
    planMeta,
    sites: { $set: siteMap },
    approvedDomains: Array.from(approved),
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
  const level = state.effort?.level ?? 'medium';
  const multiplier = state.effortProfile?.multiplier ?? (level === 'max' ? 3 : level === 'medium' ? 2 : 1);
  const reservePct = state.effortProfile?.reservePct ?? 0.15;
  const sites = state.planMeta?.sites ?? [];

  // Compute base for each site
  const siteBases = sites.map((s) => computeSiteBase(s.kind, s.difficulty));
  const siteAllocsUnscaled = siteBases.map((b) => computeSiteAlloc(b, multiplier));
  const totalBase = siteAllocsUnscaled.reduce((a, b) => a + b, 0);

  // Compute pool available for sites = hardCap * (1 - reservePct)
  const maxPool = Math.round(hardCap * (1 - reservePct));

  // If totalBase > maxPool, scale down; otherwise keep base
  const scale = totalBase > maxPool && totalBase > 0 ? maxPool / totalBase : 1;
  const siteBudgetMap: Record<string, { base: number; alloc: number; used: number; extended: boolean }> = {};
  const siteAllocs: number[] = [];

  for (let i = 0; i < sites.length; i++) {
    const s = sites[i];
    const base = siteBases[i];
    const alloc = Math.max(1, Math.round(siteAllocsUnscaled[i] * scale));
    siteAllocs.push(alloc);
    siteBudgetMap[s.id] = {
      base,
      alloc,
      used: 0,
      extended: false,
    };
  }

  const { workingTotal, reserve } = computeWorkingTotal(siteAllocs, reservePct);

  const budget = {
    hardCap,
    workingTotal,
    reserve,
    slack: 0,
    used: 0,
    sites: siteBudgetMap,
  };

  return {
    budget,
    phase: 'sites',
  };
});

const schedNode = defineNode<AgentStateT, Partial<AgentUpdate>>('orchestrator', 'sched', (state, config) => {
  const runtime = getRuntime(config);
  const sites = state.planMeta?.sites ?? [];

  // Sort sites: 'reference' first, then 'compare', then 'other'
  const rolePriority: Record<string, number> = { reference: 0, compare: 1, other: 2 };
  const sortedSites = [...sites].sort((a, b) => (rolePriority[a.role] ?? 3) - (rolePriority[b.role] ?? 3));

  const site = sortedSites.find((s) => {
    const currentStatus = state.sites?.[s.id]?.status;
    return !currentStatus || currentStatus === 'pending';
  });

  if (!site) {
    return { siteIn: null, activeSiteId: null };
  }

  const hardCap = state.budget?.hardCap ?? state.limits?.maxSteps ?? 250;
  const used = state.budget?.used ?? 0;
  const reserve = state.budget?.reserve ?? 0;
  const hardCapLeft = computeUsableBudget(hardCap, used, reserve);

  // Build findingsLines from state.findings
  const findingsLines: string[] = [];
  if (state.findings && state.findings.length > 0) {
    for (const f of state.findings) {
      findingsLines.push(`- [${f.siteId}] ${f.field}: ${f.valueRaw} (${f.quality})`);
    }
  }

  const siteIndex = sites.findIndex((s) => s.id === site.id) + 1;
  const siteIn: SiteIn = {
    site,
    index: siteIndex,
    total: sites.length,
    task: state.task,
    taskKind: state.planMeta!.taskKind,
    columns: state.planMeta!.columns,
    priceLike: state.planMeta!.priceLike,
    compare: state.planMeta!.compare ?? null,
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
    findingsLines,
    earlierSites: (state.siteSummaries ?? []).map((s) => `${s.siteId}: ${s.status} (${s.findings} findings)`),
    recap: [],
    priorFindings: (state.priorFindings ?? []).map((f) => `${f.siteId}: ${f.field} = ${f.valueRaw}`),
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

  const summary: SiteSummary = {
    siteId,
    status: siteOut.status,
    criteriaMet: siteOut.criteriaMet,
    findings: siteOut.findings.length,
    blockers: siteOut.blocked.map((b) => `${b.domain}: ${b.reason} (${b.tries} tries)`),
    stepsUsed: siteOut.used,
    failures: siteOut.failures,
    anomalies: siteOut.anomalies,
    userAnswered: siteOut.userAnswered,
    notes: siteOut.reason,
  };

  // Recycle unused site allocation into slack pool
  const siteBudget = state.budget?.sites?.[siteId];
  const siteAlloc = siteBudget?.alloc ?? siteOut.used;
  const unused = Math.max(0, siteAlloc - siteOut.used);
  const currentSlack = state.budget?.slack ?? 0;
  const currentUsed = state.budget?.used ?? 0;
  const extendedBy = siteOut.extendedBy ?? 0;
  const nextSlack = Math.max(0, currentSlack - extendedBy) + unused;

  const newBudget = state.budget
    ? {
        ...state.budget,
        used: currentUsed + siteOut.used,
        slack: nextSlack,
        sites: {
          ...state.budget.sites,
          [siteId]: {
            base: siteBudget?.base ?? siteAlloc,
            alloc: siteAlloc,
            used: siteOut.used,
            extended: (siteOut.extendedBy ?? 0) > 0,
          },
        },
      }
    : state.budget;

  // Merge findings with deduplication
  let mergedFindings = [...(state.findings ?? [])];
  for (const f of siteOut.findings) {
    mergedFindings = deduplicateFindings(mergedFindings, f);
  }

  // Merge blocked sources into state.blocked map
  const blockedUpdates: Record<string, BlockedSource> = {};
  for (const b of siteOut.blocked) {
    blockedUpdates[b.domain] = b;
  }

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
    findings: mergedFindings,
    blocked: { $set: blockedUpdates },
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

  // Compile truth table if columns and sites exist
  let table: FindingsTable | null = null;
  let markdownTable = '';
  if (state.planMeta?.sites && state.planMeta.sites.length > 0 && state.findings && state.findings.length > 0) {
    const comp = state.planMeta.compare as any;
    const compareOpt = comp
      ? {
          reference_domain: comp.reference_domain || state.planMeta.sites.find((s) => s.id === comp.referenceSiteId)?.domain || state.planMeta.sites[0].domain,
          field: comp.field || 'price',
          threshold_pct: comp.threshold_pct ?? comp.thresholdPct ?? 10,
        }
      : undefined;

    table = compileTruthTable(state.planMeta.sites, state.findings ?? [], compareOpt);
    markdownTable = renderTruthTableMarkdown(table);
  }

  let endReason: any = 'stopped_early';
  let historyEntry: HistoryEntry;

  if (stopped) {
    endReason = 'stopped';
    historyEntry = {
      type: 'partial_result',
      answer: markdownTable ? `Task was stopped by user.\n\n${markdownTable}` : 'Task was stopped by user.',
      table,
      reason: 'stopped',
    };
  } else if (allDone) {
    endReason = 'all_subgoals_done';
    const baseAnswer = state.siteOut?.finalAnswer?.text ?? 'Task completed successfully.';
    const answer = markdownTable ? `${baseAnswer}\n\n${markdownTable}` : baseAnswer;
    historyEntry = {
      type: 'finish',
      answer,
      ...(table ? { table } : {}),
    };
  } else {
    endReason = 'stopped_early';
    const answer = markdownTable
      ? `Task ended without completing all goals.\n\n${markdownTable}`
      : 'Task ended without completing all goals.';
    historyEntry = {
      type: 'partial_result',
      answer,
      table,
      reason: 'stopped_early',
    };
  }

  return {
    endReason,
    finalAnswer: {
      text: historyEntry.type === 'finish' ? historyEntry.answer : (historyEntry as any).answer,
      unconfirmed: false,
      table,
      partial: !allDone,
    },
    history: [historyEntry],
  };
});

const offerNode = defineNode<AgentStateT, Partial<AgentUpdate>>('orchestrator', 'offer', (state) => {
  const sites = state.siteSummaries ?? [];
  const incompleteSites = sites.filter((s) => s.status !== 'done');
  if (incompleteSites.length === 0) return {};

  const offer: Offer = {
    partialSiteIds: incompleteSites.map((s) => s.siteId),
    suggestedLevel: 'high',
  };

  return {
    offerPayload: offer,
  };
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
