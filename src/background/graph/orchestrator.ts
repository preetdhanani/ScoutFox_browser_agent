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
  type EndReason,
  type Offer,
  MAX_SITES,
  type PlanMeta,
  type Predicate,
  type RunStats,
  type SiteSpec,
  type SiteSummary,
  type TaskKind,
} from './state.ts';
import type { SiteIn } from './workerState.ts';
import { ORCHESTRATOR_ROUTE_MAPS, planRouter, holdRouter, schedRouter, summaryRouter, reflectRouter, compileRouter } from './routes.ts';
import { defineNode, getRuntime } from '../runner/runtimeRegistry.ts';
import { buildWorkerGraph, buildSiteOut } from './worker.ts';
import { interruptWithConfig } from './interrupt.ts';
import { buildGraphPlanSchema } from '../agent/schemas.ts';
import { computeSiteBase, computeSiteAlloc, computeWorkingTotal, computeUsableBudget } from '../agent/budget.ts';
import { deduplicateFindings, compileTruthTable, renderTruthTableMarkdown, isAutoValueField } from '../agent/findings.ts';
import { buildPlanSystemPrompt, buildPlanUserMessage } from '../agent/prompts.ts';
import { getEffortProfile, suggestEffortLevel, calculatePlanEstimate } from '../agent/profile.ts';
import { buildReflectSystemPrompt, buildReflectUserMessage, parseReflectResponse } from '../agent/reflectPrompt.ts';
import { previousTurnsSummary, lastCompletedTurn } from '../agent/previousTurns.ts';
import { Logger } from '../../shared/logger.ts';
import { resolveModelTier } from '../agent/tier.ts';
import { callWithRetry } from '../agent/recovery.ts';
import { buildFinishEntry, buildMaxStepsEntry, NO_ANSWER_GIVEN, coerceAnswerText } from '../agent/outcome.ts';
import { EvidenceLedger } from '../agent/evidence.ts';
import { auditAnswer, prepareAnswer, annotateAnswer } from '../agent/answerAudit.ts';
import { auditRecordOf, compactLedgerSnapshot } from '../agent/planEvidence.ts';

// ---------------------------------------------------------------------------------------------
// Orchestrator Node Definitions
// ---------------------------------------------------------------------------------------------

/**
 * True for a task that asks for prose about a page (summarize, explain, describe, ...). The
 * planner prompt says "summarized or explained" means answer, but small models still plan
 * "Summarize the main articles on news.ycombinator.com" as research with title/summary columns -
 * a findings table no model can fill (a written summary is not on the page), which used to end
 * in a record_finding loop. Used as the fallback classifier and as the override below.
 */
const ANSWER_TASK_PATTERN = /\b(summar(y|ize)|summaries|tl;?dr|explain|describe|tell me about|what is|what are|who is|where is|when did|why is|how does|read(ing)? this page)\b/i;

const QUESTION_START_PATTERN = /^(what|who|where|when|why|how|is|are|can|does|do|did)\b/i;

export function isAnswerLikeTask(task: string): boolean {
  if (!task) return false;
  return ANSWER_TASK_PATTERN.test(task) || QUESTION_START_PATTERN.test(task.trim());
}

// A roundup ask ("top trending repositories", "top 5 articles", "list the headlines") is
// research in the planner's vocabulary but is really a prose answer about one page. The findings
// engine keeps ONE finding per field per site, so a collect site for such a task is "done" after
// the first row and the run ends with the truth table only - the bug where "Find top trending
// repositories on GitHub for python" returned a single repository and "(The model did not provide
// an answer.)". These are planned as answer sites instead, so the model reads the page and calls
// finish with the summary.
const ROUNDUP_NOUN_PATTERN = /\b(repositor(?:y|ies)|repos?|projects?|packages?|librar(?:y|ies)|frameworks?|tools?|articles?|stories|story|headlines?|items?|results?|posts?|models?|plugins?|extensions?|channels?|courses?|books?|papers?)\b/i;
const ROUNDUP_LEAD_PATTERN = /\b(top\s*\d*|trending|most\s+(?:popular|starred|forked|active)|best|list\s+of|roundup|ranked)\b/i;

/** True for a list/roundup ask over the current page's items. */
export function isRoundupTask(task: string): boolean {
  if (!task) return false;
  if (!ROUNDUP_NOUN_PATTERN.test(task)) return false;
  if (ROUNDUP_LEAD_PATTERN.test(task)) return true;
  return /\b(list|show|give|tell)\b[\s\S]{0,30}\b(all|the)\b/i.test(task);
}

/**
 * Redirects a planner output to answer mode when the task is clearly a prose ask on one site:
 * an explicit summarize/explain verb (or a list/roundup ask), no price-like columns, and no
 * second site. Strict on purpose - a real research task keeps its research plan even when the
 * wording happens to include one of the verbs. Only research plans are redirected; the planner's
 * own action/answer choices always stand.
 */
function overridePlanToAnswer(state: AgentStateT, plan: PlanMeta | null): PlanMeta | null {
  if (!plan || plan.taskKind !== 'research') return plan;
  const task = state.task || '';
  const summaryAsk = /\b(summar(y|ize)|summaries|tl;?dr|explain|describe)\b/i.test(task);
  const roundup = isRoundupTask(task);
  if (!summaryAsk && !roundup) return plan;
  if (plan.priceLike) return plan;
  if (plan.sites.length > 1) return plan;
  // A roundup plan may carry non-prose columns (repository, stars); the model still answers in
  // prose, so the prose-column check only guards the plain summarize path.
  if (!roundup) {
    const proseColumns = plan.columns.filter((c) => !isAutoValueField(c));
    if (!proseColumns.every((c) => /summary|description|content|text|answer|value|title/.test(c))) return plan;
  }
  Logger.info('Orchestrator', `[PLAN_KIND_OVERRIDE] "${task.slice(0, 60)}" is a prose ask - planning it as answer instead of research.`);
  return {
    ...plan,
    taskKind: 'answer',
    sites: plan.sites.map((s) => ({
      ...s,
      goalKind: 'answer' as const,
      criteria: {
        ...s.criteria,
        fields: [],
        doneWhen: 'all_required' as const,
      },
    })),
  };
}

const intakeNode = defineNode<AgentStateT, Partial<AgentUpdate>>('orchestrator', 'intake', async (state, config) => {
  const runtime = getRuntime(config);
  const task = state.task;
  const now = runtime.clock?.now ? runtime.clock.now() : Date.now();
  const userGoalEntry: HistoryEntry = {
    type: 'user_goal',
    turn: (state.turnIndex ?? 0) + 1,
    prompt: task,
    timestamp: new Date(now).toISOString(),
    isNewRun: true,
  };

  const settings = await runtime.settings().catch(() => null);
  const tier = settings ? await resolveModelTier(settings) : 'small';
  const defaultMax = typeof settings?.maxSteps === 'number' && settings.maxSteps > 0 ? settings.maxSteps : DEFAULT_LIMITS.maxSteps;
  const limits = {
    ...DEFAULT_LIMITS,
    ...(state.limits ?? {}),
    maxSteps: state.limits?.maxSteps ?? defaultMax,
  };

  return {
    turnIndex: (state.turnIndex ?? 0) + 1,
    turnStartedAt: now,
    runId: `run_${now}`,
    tier,
    limits,
    runStatus: 'running',
    phase: 'plan',
    stepCount: 0,
    systemActionCount: 0,
    parseErrorsThisTurn: 0,
    everParsedOk: false,
    history: [userGoalEntry],
    // Per-turn reset list (BUG-17, BUG-18, BUG-25): a new task on the same
    // tab/thread must not inherit the previous turn's reflect decision, plan
    // revision, spend or refused-finish bookkeeping. Without this, a stale
    // 'replan' decision hijacks the next task's plan (the planner is never
    // called), allocNode starts revision mode on the old budget, and compile can
    // present the previous turn's refused answer. siteOut is reset so compile's
    // stopped branch cannot fire from the previous turn's stopped site.
    reflectResult: null,
    planPrev: null,
    sites: { $reset: {} },
    budget: { hardCap: 0, workingTotal: 0, reserve: 0, slack: 0, used: 0, sites: {} },
    lastRefusedFinish: null,
    finishSendBacks: 0,
    siteOut: null,
  };
});

const profileNode = defineNode<AgentStateT, Partial<AgentUpdate>>('orchestrator', 'profile', (state) => {
  const requested = state.effort?.requested ?? 'auto';
  let level = state.effort?.level ?? 'medium';
  let suggestedBy = state.effort?.suggestedBy ?? 'default';

  if (requested === 'auto') {
    const suggestion = suggestEffortLevel(state.task);
    level = suggestion.level;
    suggestedBy = 'heuristic';
  } else if (requested) {
    level = requested;
    suggestedBy = state.effort?.suggestedBy ?? 'user';
  }

  const profile = getEffortProfile(level);

  return {
    effort: { requested, level, suggestedBy },
    effortProfile: profile,
  };
});

const planNode = defineNode<AgentStateT, Partial<AgentUpdate>>('orchestrator', 'plan', async (state, config) => {
  // Revision Mode (P5c): apply reflection decision without generating plan from scratch
  if (state.planMeta !== null && state.reflectResult?.decision === 'replan') {
    const reflect = state.reflectResult;
    const oldMeta = state.planMeta;
    const dropSet = new Set(reflect.dropSites || []);
    const addSites = reflect.addSites || [];

    const sitesMapUpdates: Record<string, any> = {};
    const revisedSites: SiteSpec[] = [];

    for (const site of oldMeta.sites) {
      const siteState = state.sites?.[site.id];
      const isFinished = siteState?.status === 'done' || siteState?.status === 'partial' || siteState?.status === 'blocked';

      if (isFinished) {
        revisedSites.push(site);
      } else if (dropSet.has(site.id)) {
        sitesMapUpdates[site.id] = { status: 'skipped', criteriaMet: false };
      } else {
        revisedSites.push(site);
      }
    }

    for (const newSite of addSites) {
      revisedSites.push(newSite);
      sitesMapUpdates[newSite.id] = { status: 'pending', criteriaMet: false };
    }

    const newVersion = (oldMeta.version ?? 1) + 1;
    const newPlanMeta: PlanMeta = {
      ...oldMeta,
      version: newVersion,
      sites: revisedSites,
      source: 'llm',
    };

    const nextReplanCount = (state.replan?.count ?? 0) + 1;
    const noticeEntry: HistoryEntry = {
      type: 'notice',
      level: 'info',
      kind: 'replan',
      content: `Plan revised: ${reflect.reason}${reflect.changes ? ` (${reflect.changes})` : ''}`,
    };

    return {
      planMeta: newPlanMeta,
      planPrev: oldMeta,
      replan: {
        count: nextReplanCount,
        lastReason: reflect.reason,
      },
      sites: { $set: sitesMapUpdates },
      history: [noticeEntry],
      // The revision consumed the reflect decision - clear it so it can never
      // fire twice or leak into the next turn (BUG-17).
      reflectResult: null,
      pendingHold: {
        kind: 'approve_plan',
        planMeta: newPlanMeta,
      },
    };
  }

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

  const priorTurn = lastCompletedTurn(state.history ?? []);
  const system = buildPlanSystemPrompt('initial');
  const userMessage = buildPlanUserMessage({
    task: state.task,
    tabTitle: tabInfo?.title,
    tabUrl: currentUrl,
    earlierSessionGoal: priorTurn?.goal,
    earlierSessionAnswer: priorTurn?.answer,
  });

  const schema = buildGraphPlanSchema({ mode: 'initial' });
  const stepSignal = runtime.control.stepSignal();
  let parsedPlan: any = null;

  try {
    const res = await callWithRetry(
      () =>
        runtime.llm.complete({
          node: 'plan',
          mode: 'initial',
          role: 'planner',
          system,
          messages: [{ role: 'user', content: userMessage }],
          schema,
          signal: stepSignal,
        }),
      {
        maxAttempts: 3,
        baseDelayMs: 300,
        isAbort: (err) => runtime.control.isUserAbort(err, stepSignal),
        shouldContinue: () => !runtime.control.stopRequested && !runtime.control.pauseRequested,
        sleep: runtime.clock.sleep,
      }
    );

    const replyText = res.text || '';
    const cleaned = replyText.replace(/<(?:think|thought|reasoning)>[\s\S]*?<\/(?:think|thought|reasoning)>/gi, '').trim();
    const fenceMatch = cleaned.match(/```(?:json)?\s*([\{\[][\s\S]*?[\}\]])\s*```/i);
    const jsonStr = fenceMatch ? fenceMatch[1] : (cleaned.match(/[\{\[][\s\S]*[\}\]]/)?.[0] ?? '');
    if (jsonStr) {
      try {
        const raw = JSON.parse(jsonStr);
        if (Array.isArray(raw)) {
          const stringItems = raw.filter((item: any) => typeof item === 'string');
          if (stringItems.length > 0) {
            const sites = stringItems.map((str: string, idx: number) => {
              const domainMatch = str.match(/([a-z0-9-]+\.[a-z]{2,})/i);
              const domain = domainMatch ? domainMatch[1].toLowerCase() : currentDomain;
              return {
                id: `s${idx + 1}`,
                name: str,
                domain,
                goal: str,
                role: idx === 0 ? 'reference' : 'compare',
                kind: 'page',
              };
            });
            const isAnswerTask = /\b(what|who|where|when|why|how|price|cost|is|are|can)\b/i.test(state.task);
            parsedPlan = {
              task_kind: isAnswerTask ? 'answer' : 'research',
              sites,
            };
          }
        } else if (raw && typeof raw === 'object') {
          parsedPlan = raw;
        }
      } catch {
        parsedPlan = null;
      }
    }
  } catch (err: any) {
    if (runtime.control.isUserAbort(err, stepSignal)) {
      return { lastDecision: { kind: 'aborted', node: 'plan' } };
    }
    const settings = await runtime.settings().catch(() => null);
    const provider = settings?.provider ?? 'unknown';
    const errEntry: HistoryEntry = {
      type: 'error',
      step: state.stepCount ?? 0,
      content: `LLM Connection Error (${provider}) after 3 attempts: ${err.message}. Task paused at step ${state.stepCount ?? 0} - click Resume to try again, or check your provider settings if this keeps happening.`,
    };
    return {
      lastDecision: {
        kind: 'llm_failed',
        error: err.message ?? 'LLM request failed',
        node: 'plan',
      },
      pendingHold: {
        kind: 'paused',
        reason: 'llm_failure',
        error: err.message ?? 'LLM request failed',
      },
      history: [errEntry],
      resumeRoute: 'plan',
    };
  }

  const rawTaskKind = parsedPlan?.task_kind || parsedPlan?.taskKind;
  const taskKind: TaskKind = rawTaskKind === 'action' || rawTaskKind === 'answer' || rawTaskKind === 'research'
    ? rawTaskKind
    : isAnswerLikeTask(state.task) ? 'answer' : 'research';

  let planMeta: PlanMeta;
  if (parsedPlan && Array.isArray(parsedPlan.sites) && parsedPlan.sites.length > 0) {
    const parsedColumns: string[] = Array.isArray(parsedPlan.columns)
      ? parsedPlan.columns.map((c: string) => String(c).toLowerCase().replace(/[^a-z0-9_]/g, '_')).slice(0, 5)
      : ['value'];
    // The engine records the page url itself, so a url/link column carries no new information:
    // it would become a required field no finding can ever satisfy (a URL is not part of the
    // page text) and a schema the model is forced to fill every reply - the summarize loop's fuel.
    const columns = parsedColumns.filter((c) => !isAutoValueField(c));
    const priceLike = columns.some((c) => /price|cost|preis|shipping/i.test(c));

    const sites: SiteSpec[] = parsedPlan.sites.slice(0, 4).map((s: any, idx: number) => {
      const id = `s${idx + 1}`;
      const domain = s.domain || currentDomain;
      const goalKind = s.goalKind || s.goal_kind || (taskKind === 'action' ? 'do' : taskKind === 'answer' ? 'answer' : 'collect');
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
        // Auto-value fields (url, link, ...) are recorded by the engine itself; as a required
        // field they are unsatisfiable (a URL is not part of the page text) and were the fuel
        // of the record_finding loop (B8b in docs/p8-progress/04-bugs.md).
        fields = rawFields
          .map((f: any) => {
            if (typeof f === 'string') {
              return { name: f.toLowerCase().replace(/[^a-z0-9_]/g, '_'), required: true };
            }
            return {
              name: String(f.name || 'value').toLowerCase().replace(/[^a-z0-9_]/g, '_'),
              required: f.required !== false,
            };
          })
          .filter((f) => !isAutoValueField(f.name));
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
    Logger.info('Orchestrator', '[PLANNER_FALLBACK] Using deterministic fallback plan.');
    const implicitSite: SiteSpec = {
      id: 's1',
      name: 'Analyze the page state for the task',
      domain: currentDomain,
      goal: 'Analyze the page state for the task',
      goalKind: taskKind === 'action' ? 'do' : taskKind === 'answer' ? 'answer' : 'collect',
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
      taskKind,
      columns: ['value'],
      priceLike: false,
      searchQuery: state.task.slice(0, 40),
      sites: [implicitSite],
      source: 'fallback',
    };
  }

  // A clearly-prose research plan ("Summarize the main articles on ...") becomes answer mode -
  // without this the site ran collect policy, could never satisfy prose columns, and looped.
  planMeta = overridePlanToAnswer(state, planMeta) ?? planMeta;

  const siteMap: Record<string, { status: 'pending'; criteriaMet: false }> = {};
  const approved = new Set<string>(state.approvedDomains ?? []);
  for (const s of planMeta.sites) {
    siteMap[s.id] = { status: 'pending', criteriaMet: false };
    if (s.domain && s.domain !== 'this_page') {
      approved.add(s.domain);
    }
  }

  const profile = state.effortProfile ?? getEffortProfile(state.effort?.level);
  const budgetEstimate = calculatePlanEstimate(profile, planMeta.sites.length);

  return {
    planMeta,
    sites: { $set: siteMap },
    approvedDomains: Array.from(approved),
    phase: 'approve',
    // A fresh plan replaces any leftover reflect decision (BUG-17).
    reflectResult: null,
    pendingHold: {
      kind: 'approve_plan',
      planMeta,
      budgetEstimate,
    },
  };
});

const holdNode = defineNode<AgentStateT, Partial<AgentUpdate>>('orchestrator', 'hold', (state, config) => {
  const resume = interruptWithConfig<any, any>(config, state.pendingHold ?? { kind: 'approve_plan' });

  // A plain Resume (the panel's button, after a worker restart left a plan hold standing) on a REAL plan hold is the
  // approval. Without this it fell through to `sched`, skipped `alloc`, left the budget at 0 and the site ended at once
  // with "Step budget exhausted". Keyed on pendingHold, not on the interrupt value: this node shows
  // `{kind:'approve_plan'}` for a null pendingHold too, and that case must keep its old fall-through.
  const approvedByResume = resume?.kind === 'resume' && state.pendingHold?.kind === 'approve_plan';

  if (resume?.kind === 'approve' || approvedByResume) {
    const approved = new Set<string>(state.approvedDomains ?? []);
    if (state.planMeta?.sites) {
      for (const s of state.planMeta.sites) {
        if (s.domain && s.domain !== 'this_page') approved.add(s.domain);
      }
    }
    return {
      resumeRoute: 'alloc',
      approvedDomains: Array.from(approved),
      replan: state.replan ? { ...state.replan, approvedByUser: true } : undefined,
      pendingHold: null,
    };
  }
  if (resume?.kind === 'reject') {
    return { resumeRoute: 'finalize', endReason: 'plan_rejected', pendingHold: null };
  }
  if (resume?.kind === 'stop') {
    return { resumeRoute: 'finalize', endReason: 'stopped', pendingHold: null };
  }
  return { resumeRoute: state.resumeRoute ?? 'sched', pendingHold: null };
});

const allocNode = defineNode<AgentStateT, Partial<AgentUpdate>>('orchestrator', 'alloc', (state) => {
  const hardCap = state.limits?.maxSteps ?? 250;
  const level = state.effort?.level ?? 'medium';
  const multiplier = state.effortProfile?.multiplier ?? (level === 'max' ? 3 : level === 'medium' ? 2 : 1);
  const reservePct = state.effortProfile?.reservePct ?? 0.15;
  const sites = state.planMeta?.sites ?? [];

  // Revision Mode: retain existing budget used, slack, and finished site budgets
  if (state.planPrev !== null && state.budget) {
    const existingBudget = state.budget;
    const existingSitesMap = existingBudget.sites ?? {};
    const currentSiteIds = new Set(sites.map((s) => s.id));
    const newSiteBudgetMap: Record<string, { base: number; alloc: number; used: number; extended: boolean }> = {};
    let freedAlloc = 0;

    for (const [id, b] of Object.entries(existingSitesMap)) {
      if (currentSiteIds.has(id)) {
        newSiteBudgetMap[id] = { ...b };
      } else {
        freedAlloc += Math.max(0, b.alloc - b.used);
      }
    }

    let additionalAlloc = 0;
    for (const s of sites) {
      if (newSiteBudgetMap[s.id]) {
        continue;
      }
      const base = computeSiteBase(s.kind, s.difficulty);
      const alloc = Math.max(1, computeSiteAlloc(base, multiplier));
      additionalAlloc += alloc;
      newSiteBudgetMap[s.id] = {
        base,
        alloc,
        used: 0,
        extended: false,
      };
    }

    const currentUsed = existingBudget.used ?? 0;
    const currentSlack = existingBudget.slack ?? 0;
    const rawReserve = existingBudget.reserve ?? 0;
    const nextReserve = Math.max(0, rawReserve + freedAlloc - additionalAlloc);
    const pendingAlloc = Object.values(newSiteBudgetMap).reduce((sum, b) => sum + (b.used > 0 ? 0 : b.alloc), 0);
    const nextWorkingTotal = currentUsed + pendingAlloc + nextReserve;

    const budget = {
      ...existingBudget,
      workingTotal: Math.min(hardCap, nextWorkingTotal),
      reserve: nextReserve,
      slack: currentSlack,
      used: currentUsed,
      sites: newSiteBudgetMap,
    };

    return {
      budget,
      phase: 'sites',
    };
  }

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

  const { workingTotal: rawWorkingTotal, reserve: rawReserve } = computeWorkingTotal(siteAllocs, reservePct);
  const totalSiteAlloc = siteAllocs.reduce((a, b) => a + b, 0);
  const reserve = Math.max(0, Math.min(rawReserve, hardCap - totalSiteAlloc));
  const workingTotal = totalSiteAlloc + reserve;

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
    recap: previousTurnsSummary(state.history ?? []),
    priorFindings: (state.priorFindings ?? []).map((f) => `${f.siteId}: ${f.field} = ${f.valueRaw}`),
    ledgerPrior: compactLedgerSnapshot(state.evidence),
    planTexts: (state.planMeta?.sites ?? []).map((s) => s.goal || s.name),
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
      // The worker's folded evidence base already contains every page of this
      // site (and the compacted prior ledger); recording the raw capped event
      // list alone lost the earliest pages of long sites (BUG-23).
      evidence: siteOut.evidenceBase ? ({ $reset: siteOut.evidenceBase } as any) : (siteOut.evidenceEvents ?? []),
      history: out.history ?? [],
      ...(siteOut.lastRefusedFinish ? { lastRefusedFinish: siteOut.lastRefusedFinish } : {}),
      ...(siteOut.finishSendBacks ? { finishSendBacks: siteOut.finishSendBacks } : {}),
    };
  });
}

export const summaryNode = defineNode<AgentStateT, Partial<AgentUpdate>>('orchestrator', 'summary', (state) => {
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

  // Merge newly approved domains from worker
  const currentApproved = state.approvedDomains ?? [];
  const newApproved = siteOut.approvedDomains ?? [];
  const mergedApproved = [...currentApproved];
  for (const d of newApproved) {
    if (!mergedApproved.includes(d)) {
      mergedApproved.push(d);
    }
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
    approvedDomains: mergedApproved,
    findings: mergedFindings,
    blocked: { $set: blockedUpdates },
    siteSummaries: [summary],
    siteIn: null,
    budget: newBudget,
    stepCount: (state.stepCount ?? 0) + siteOut.used,
    systemActionCount: (state.systemActionCount ?? 0) + siteOut.systemActions,
    parseErrorsThisTurn: (state.parseErrorsThisTurn ?? 0) + siteOut.parseErrors,
    history: [siteEndEntry],
  };
});

const reflectNode = defineNode<AgentStateT, Partial<AgentUpdate>>('orchestrator', 'reflect', async (state, config) => {
  const runtime = getRuntime(config);
  const profile = state.effortProfile ?? getEffortProfile(state.effort?.level);
  const reflectMode = profile.reflect ?? 'off';

  // 1. If reflection is off for this effort level, continue immediately
  if (reflectMode === 'off') {
    return {
      reflectResult: {
        decision: 'continue',
        reason: 'Reflect off for current effort level',
        changes: '',
        by: 'code',
      },
    };
  }

  // 2. Fast-path checks
  const sitesMap = state.sites ?? {};
  const pendingSites = (state.planMeta?.sites ?? []).filter((s) => sitesMap[s.id]?.status === 'pending');

  // Fast-path: run-fatal site exit
  if (
    state.siteOut?.fatal === 'model_unusable' ||
    state.siteOut?.fatal === 'dom_error' ||
    // A closed tab or a tab that left the ScoutFox group kills the whole run
    // too - the remaining sites must not each burn a perceive cycle against a
    // dead tab (BUG-24).
    state.siteOut?.fatal === 'tab_gone' ||
    state.siteOut?.fatal === 'out_of_scope'
  ) {
    return {
      reflectResult: {
        decision: 'stop_early',
        reason: `Site ended run-fatal: ${state.siteOut.fatal}`,
        changes: '',
        by: 'fast_path',
      },
    };
  }

  // Fast-path: no pending sites remain
  if (pendingSites.length === 0) {
    return {
      reflectResult: {
        decision: 'continue',
        reason: 'All planned sites complete',
        changes: '',
        by: 'fast_path',
      },
    };
  }

  // Fast-path: goal completeness check
  const columns = state.planMeta?.columns ?? [];
  const findings = state.findings ?? [];
  const foundFields = new Set(findings.map((f) => f.field));
  const allColumnsFound = columns.length > 0 && columns.every((col) => foundFields.has(col));
  const referenceDone = (state.planMeta?.sites ?? []).some((s) => s.role === 'reference' && sitesMap[s.id]?.status === 'done');

  if (allColumnsFound && referenceDone && findings.length >= 2) {
    const noticeEntry: HistoryEntry = {
      type: 'notice',
      level: 'info',
      kind: 'reflect',
      content: 'Early completion: All target findings and criteria satisfied early.',
    };
    return {
      reflectResult: {
        decision: 'stop_early',
        reason: 'All required criteria and findings collected early',
        changes: '',
        by: 'fast_path',
      },
      history: [noticeEntry],
    };
  }

  // Fast-path: replan limits reached or reserve budget depleted
  const replanCount = state.replan?.count ?? 0;
  const maxReplans = profile.maxReplans ?? 0;
  const reserve = state.budget?.reserve ?? 0;

  if (replanCount >= maxReplans || reserve <= 0) {
    return {
      reflectResult: {
        decision: 'continue',
        reason: 'Replan limit reached or reserve budget depleted',
        changes: '',
        by: 'fast_path',
      },
    };
  }

  // 3. LLM reflection
  if (!state.planMeta) {
    return {
      reflectResult: {
        decision: 'continue',
        reason: 'No planMeta found',
        changes: '',
        by: 'code',
      },
    };
  }

  const system = buildReflectSystemPrompt();
  const userMessage = buildReflectUserMessage({
    task: state.task,
    planMeta: state.planMeta,
    siteSummaries: state.siteSummaries ?? [],
    findings: state.findings ?? [],
    blocked: state.blocked ?? {},
    pendingSites,
    reserveSteps: reserve,
    replanCount,
    maxReplans,
  });

  const stepSignal = runtime.control.stepSignal();
  try {
    const res = await callWithRetry(
      () =>
        runtime.llm.complete({
          node: 'reflect',
          mode: 'initial',
          role: 'planner',
          system,
          messages: [{ role: 'user', content: userMessage }],
          schema: null,
          signal: stepSignal,
        }),
      {
        maxAttempts: 3,
        baseDelayMs: 300,
        isAbort: (err) => runtime.control.isUserAbort(err, stepSignal),
        shouldContinue: () => !runtime.control.stopRequested && !runtime.control.pauseRequested,
        sleep: runtime.clock.sleep,
      }
    );

    const reflectDecision = parseReflectResponse(res.text || '', state.planMeta.sites, MAX_SITES);

    if (reflectDecision.decision === 'replan') {
      const pendingIds = new Set(pendingSites.map((s) => s.id));
      reflectDecision.dropSites = (reflectDecision.dropSites || []).filter((id) => pendingIds.has(id));
      if (reflectDecision.dropSites.length === 0 && (!reflectDecision.addSites || reflectDecision.addSites.length === 0)) {
        return {
          reflectResult: {
            decision: 'continue',
            reason: reflectDecision.reason || 'No adjustments needed',
            changes: '',
            by: 'llm',
          },
        };
      }
    }

    return {
      reflectResult: {
        ...reflectDecision,
        by: 'llm',
      },
    };
  } catch (err: any) {
    if (runtime.control.isUserAbort(err, stepSignal)) {
      return { lastDecision: { kind: 'aborted', node: 'reflect' } };
    }
    Logger.warn('Orchestrator', `Reflect LLM call failed: ${err?.message || err}. Continuing existing plan.`);
    return {
      lastDecision: null,
      reflectResult: {
        decision: 'continue',
        reason: 'LLM reflection failed, continuing existing plan',
        changes: '',
        by: 'llm',
      },
    };
  }
});

export const compileNode = defineNode<AgentStateT, Partial<AgentUpdate>>('orchestrator', 'compile', (state, config) => {
  const runtime = getRuntime(config);
  const sites = Object.values(state.sites ?? {});
  const nonSkippedSites = sites.filter((s: any) => s.status !== 'skipped');
  const allDone = nonSkippedSites.length > 0 && nonSkippedSites.every((s) => s.status === 'done');
  const isStopEarlySuccess = state.reflectResult?.decision === 'stop_early' && (state.findings?.length ?? 0) > 0;
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

    const evidenceMode = (state.effortProfile?.evidence ?? (state.effort as any)?.profile?.evidence) as any;
    table = compileTruthTable(state.planMeta.sites, state.findings ?? [], compareOpt, evidenceMode);
    markdownTable = renderTruthTableMarkdown(table);
  }

  const level = state.effort?.level ?? 'medium';
  const modelCalls = (state.history ?? []).filter((h) => h.type === 'agent_response' || (h as any).type === 'agent_plan').length;
  const stepsUsed = state.budget?.used ?? 0;
  const sitesList = Object.values(state.sites ?? {});
  const sitesDone = sitesList.filter((s) => s.status === 'done').length;
  const sitesPartial = sitesList.filter((s) => s.status === 'partial' || s.status === 'blocked').length;
  const now = runtime.clock?.now ? runtime.clock.now() : Date.now();
  const firstHistoryTs = (state.history?.[0] as any)?.timestamp;
  const startTs = (state.turnStartedAt && state.turnStartedAt > 0)
    ? state.turnStartedAt
    : (firstHistoryTs ? new Date(firstHistoryTs).getTime() : now);
  const elapsedMs = Math.max(0, now - (Number.isFinite(startTs) && startTs > 0 ? startTs : now));

  const runStats: RunStats = {
    level,
    modelCalls,
    stepsUsed,
    sitesDone,
    sitesPartial,
    elapsedMs,
  };

  const hardCap = state.limits?.maxSteps ?? 250;
  const isHardCap = state.siteOut?.fatal === 'hard_cap' || (state.budget?.used !== undefined && state.budget.used >= hardCap);
  const isModelUnusable = state.siteOut?.fatal === 'model_unusable';

  let endReason: EndReason = 'stopped_early';
  const historyEntries: HistoryEntry[] = [];

  if (stopped) {
    endReason = 'stopped';
    historyEntries.push({
      type: 'partial_result',
      answer: markdownTable ? `Task was stopped by user.\n\n${markdownTable}` : 'Task was stopped by user.',
      table,
      reason: 'stopped',
      findings: state.findings,
      runStats,
    });
  } else if (isModelUnusable) {
    endReason = 'model_unusable';
    if (state.findings && state.findings.length > 0) {
      historyEntries.push({
        type: 'partial_result',
        answer: markdownTable ? `Task stopped early due to unusable model replies.\n\n${markdownTable}` : 'Task stopped early due to unusable model replies.',
        table,
        reason: 'model_unusable',
        findings: state.findings,
        runStats,
      });
    }
  } else if (isHardCap && !state.siteOut?.finalAnswer) {
    endReason = 'max_steps';
    let answerKept = false;
    const lastRefused = state.lastRefusedFinish ?? state.siteOut?.lastRefusedFinish;
    const sendBacks = state.finishSendBacks ?? state.siteOut?.finishSendBacks ?? 1;
    if (lastRefused) {
      try {
        const rawAns = lastRefused.answer ?? '';
        const answer = prepareAnswer(rawAns);
        const ledger = EvidenceLedger.fromSnapshot(state.evidence);
        const planTexts = (state.planMeta?.sites ?? []).map((s) => s.goal || s.name);
        const audit = auditAnswer({ goal: state.task || '', answer, ledger, planTexts });
        const auditRec = auditRecordOf(audit, sendBacks);
        let ans: string;
        if (audit.verdict === 'verified') {
          ans = typeof answer === 'string' ? answer : JSON.stringify(answer);
        } else {
          ans = annotateAnswer(answer, audit);
        }
        if (markdownTable) ans = `${ans}\n\n${markdownTable}`;
        historyEntries.push({
          type: 'finish',
          answer: ans,
          ...(audit.verdict !== 'verified' ? { unconfirmed: true } : {}),
          audit: auditRec,
          findings: state.findings,
          runStats,
        });
        answerKept = true;
        Logger.info('Orchestrator', `[FINISH_AT_STEP_CAP] The run ran out of steps after a send-back. The model's last answer is shown, marked ${audit.verdict}.`);
      } catch (err: any) {
        Logger.warn('Orchestrator', '[FINISH_AT_STEP_CAP_ERROR] Could not keep the last refused answer', err);
      }
    }
    const maxStepsEntry = buildMaxStepsEntry(hardCap, { answerKept });
    historyEntries.push(maxStepsEntry);
    if (state.findings && state.findings.length > 0 && !answerKept) {
      historyEntries.push({
        type: 'partial_result',
        answer: markdownTable,
        table,
        reason: 'max_steps',
        findings: state.findings,
        runStats,
      });
    }
  } else if (allDone || isStopEarlySuccess || Boolean(state.siteOut?.finalAnswer)) {
    endReason = allDone ? 'all_subgoals_done' : (state.siteOut?.finalAnswer ? 'goal_achieved' : 'stopped_early');
    const defaultMsg = isStopEarlySuccess
      ? 'Task completed early with required criteria satisfied.'
      : NO_ANSWER_GIVEN;
    const rawAns = state.siteOut?.finalAnswer
      ? (state.siteOut.finalAnswer.text?.trim() ? state.siteOut.finalAnswer.text : NO_ANSWER_GIVEN)
      : defaultMsg;
    const coerced = coerceAnswerText(rawAns) || NO_ANSWER_GIVEN;
    const answer = markdownTable ? `${coerced}\n\n${markdownTable}` : coerced;
    const unconfirmed = state.siteOut?.finalAnswer?.unconfirmed === true;
    const audit = (state.siteOut?.finalAnswer as any)?.audit;
    historyEntries.push({
      type: 'finish',
      answer,
      ...(unconfirmed ? { unconfirmed: true } : {}),
      ...(audit ? { audit } : {}),
      ...(table ? { table } : {}),
      findings: state.findings,
      runStats,
    });
    if (audit?.verdict === 'partial') {
      Logger.info('Orchestrator', `[TASK_FINISHED_PARTIAL] The task ended with a partial answer: ${audit.notOpened?.length ?? 0} named site(s) were not opened.`);
    } else if (audit?.verdict === 'unverified') {
      Logger.info('Orchestrator', `[TASK_FINISHED_UNVERIFIED] The task ended with an unverified answer: ${audit.lies ?? 0} statement(s) are not backed by any page that was read.`);
    } else if (unconfirmed) {
      Logger.info('Orchestrator', '[TASK_FINISHED] Model gave a direct text answer instead of a finish action - accepted, but flagged unconfirmed.');
    } else {
      Logger.info('Orchestrator', '[TASK_FINISHED] Task completed successfully.');
    }
  } else {
    const isBlocked = state.siteOut?.status === 'blocked' || sitesList.some((s) => s.status === 'blocked');
    const blockedDomain = state.siteOut?.siteId
      ? (state.planMeta?.sites.find((s) => s.id === state.siteOut?.siteId)?.domain || state.siteIn?.site?.domain || 'unknown')
      : (state.siteIn?.site?.domain || 'unknown');
    // A run-fatal tab condition ends the whole run - say so instead of the
    // generic "ended without completing all goals" (BUG-24).
    const runFatalText = state.siteOut?.fatal === 'tab_gone'
      ? 'The tab was closed, so the task stopped.'
      : state.siteOut?.fatal === 'out_of_scope'
        ? 'The tab left the ScoutFox group, so the task stopped.'
        : null;
    endReason = isBlocked ? 'partial' : 'stopped_early';
    const hasWorkerAnswer = Boolean(state.siteOut?.finalAnswer?.text?.trim());
    const reasonText = runFatalText
      ? runFatalText
      : hasWorkerAnswer
        ? state.siteOut!.finalAnswer!.text
        : (isBlocked
            ? `Site domain ${blockedDomain} is blocked after repeated challenges or errors.`
            : 'Task ended without completing all goals.');
    const answer = markdownTable
      ? `${reasonText}\n\n${markdownTable}`
      : reasonText;
    const audit = (state.siteOut?.finalAnswer as any)?.audit;
    historyEntries.push({
      type: 'partial_result',
      answer,
      ...(audit ? { audit } : {}),
      table,
      reason: isBlocked ? 'partial' : 'stopped_early',
      findings: state.findings,
      runStats,
    });
  }

  return {
    endReason,
    finalAnswer: {
      text: historyEntries.find((h) => h.type === 'finish' || h.type === 'partial_result')?.answer ?? '',
      unconfirmed: Boolean(historyEntries.find((h) => h.type === 'finish')?.unconfirmed ?? state.siteOut?.finalAnswer?.unconfirmed ?? false),
      table,
      partial: !(allDone || isStopEarlySuccess),
    },
    runStats,
    history: historyEntries,
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
  // Detach only this session's tabs (the runtime's browser cdp facade is
  // session-scoped); the module-wide cdp.detachAll() would yank other running
  // sessions' debuggers at every task end (BUG-33).
  await runtime.browser.cdp.detachAll().catch(() => {});

  if (state.runStats) {
    Logger.info('Orchestrator', `[RUN_STATS] Task completed: level=${state.runStats.level}, steps=${state.runStats.stepsUsed}, sitesDone=${state.runStats.sitesDone}, sitesPartial=${state.runStats.sitesPartial}, elapsed=${state.runStats.elapsedMs}ms`);
  }

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
