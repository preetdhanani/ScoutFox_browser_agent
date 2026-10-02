// src/background/graph/state.ts
// Orchestrator state (StateGraph API, '@langchain/langgraph/web').
// Every field is JSON-safe, because it is checkpointed to chrome.storage.session.
// NOT in state: API keys, settings, AbortControllers, network ring buffers, element WeakRefs,
// CDP sessions. They live in the per-thread RunRuntime (src/background/runner/runtimeRegistry.ts).
// The site worker's private state is in workerState.ts; only siteIn and siteOut cross the border.
// Erasable TypeScript only (no enums, no parameter properties), so node --test can strip types.
import { Annotation } from '@langchain/langgraph/web';
import type { SiteIn, SiteOut } from './workerState.ts';

export const MAX_HISTORY = 400;        // same cap as today, enforced by the reducer on every write
export const MAX_STEP_RECORDS = 200;   // model-facing memory records per site (worker)
export const MAX_VISITED = 150;
export const MAX_TRAIL = 32;           // live graph view: last node transitions, per graph
export const RAW_RESPONSE_CAP = 2000;  // the full raw output still goes to Logger [LLM_RAW_OUTPUT]
export const MAX_SITES = 8;            // per turn: up to 6 from the first plan, the rest from revisions
export const MAX_FAILURE_MEMORY = 6;   // per site
export const MAX_FINDINGS = 200;       // per turn, including superseded ones

// ---------- small unions ----------
export type RunStatus = 'idle' | 'running' | 'paused' | 'stopped';
export type ModelTier = 'small' | 'large';
export type Level = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type OrchestratorNode =
  | 'intake' | 'profile' | 'plan' | 'hold' | 'alloc' | 'sched' | 'site'
  | 'summary' | 'reflect' | 'compile' | 'offer' | 'finalize';
export type WorkerNode =
  | 'open' | 'perceive' | 'meter' | 'blocked' | 'policy' | 'risk' | 'hold'
  | 'execute' | 'verify' | 'recover' | 'record';
export type NodeName = OrchestratorNode | WorkerNode;
export type LlmNode = 'plan' | 'policy' | 'reflect';
export type PolicyMode = 'browse' | 'extract' | 'answer' | 'harvest';
export type GoalKind = 'collect' | 'do' | 'answer';   // CODE: from plan.taskKind (a sub-goal kind in Revision 1)
export type SiteStatus =
  | 'pending' | 'running' | 'done' | 'partial' | 'blocked' | 'stuck' | 'failed' | 'stopped'
  | 'not_found' | 'unverified' | 'skipped';
export type PageVerdict = 'ok' | 'challenge' | 'error_page';
export type PageType =
  | 'listing' | 'product' | 'search' | 'login' | 'checkout' | 'cart'
  | 'error' | 'challenge' | 'cookie_wall' | 'other';
export type Effect = 'url_changed' | 'dom_changed' | 'value_set' | 'focus_changed' | 'none' | 'unknown';
export type EndReason =
  | 'all_subgoals_done' | 'partial' | 'unverified' | 'stopped_early' | 'no_subgoal_completed'
  | 'max_steps' | 'model_unusable' | 'dom_error' | 'plan_rejected' | 'stopped' | 'error';

// ---------- JSON-safe reducer envelopes (pending writes must serialize) ----------
export type ListUpdate<T> = T[] | { $reset: T[] };
export function cappedList<T>(cap: number) {
  return (cur: T[], upd: ListUpdate<T>): T[] => {
    const next = Array.isArray(upd) ? cur.concat(upd) : upd.$reset.slice();
    return next.length > cap ? next.slice(next.length - cap) : next;
  };
}
export type MapUpdate<V> = { $set: Record<string, V | null> } | { $reset: Record<string, V> };
export function mergeMap<V>(cap = Number.POSITIVE_INFINITY, age?: (v: V) => number) {
  return (cur: Record<string, V>, upd: MapUpdate<V>): Record<string, V> => {
    if ('$reset' in upd) return { ...upd.$reset };
    const out: Record<string, V> = { ...cur };
    for (const [k, v] of Object.entries(upd.$set)) {
      if (v === null) delete out[k]; else out[k] = v;
    }
    const keys = Object.keys(out);
    if (age && keys.length > cap) {
      keys.sort((a, b) => age(out[a]) - age(out[b]));
      for (const k of keys.slice(0, keys.length - cap)) delete out[k];
    }
    return out;
  };
}
export const last = <T>(init: () => T) =>
  Annotation<T>({ reducer: (_prev: T, next: T) => next, default: init });
export const list = <T>(cap: number) =>
  Annotation<T[], ListUpdate<T>>({ reducer: cappedList<T>(cap), default: () => [] });
export const map = <V>(cap?: number, age?: (v: V) => number) =>
  Annotation<Record<string, V>, MapUpdate<V>>({ reducer: mergeMap<V>(cap, age), default: () => ({}) });

// ---------- effort (shared/effort.json) ----------
export type LadderStep = 'reload' | 'search' | 'alternate_entry' | 'ask_user' | 'mark';
export interface EffortProfile {         // one level of shared/effort.json; frozen for the turn once alloc ran
  level: Level;
  multiplier: number;                    // site budget multiplier: 1, 2, 3, 4, 8
  retriesPerAction: number;              // 0, 1, 2, 3, 3
  altStrategy: boolean;                  // Max: a strategy hint after the retries (P7b)
  verifyMode: 'url' | 'url+dom' | 'goal';
  blockedLadder: LadderStep[];           // Low [mark], Medium [reload, mark], High [reload, search, mark]
  reflect: 'off' | 'site_end' | 'site_end_and_failure' | 'mid_site';
  maxReplans: number;                    // 0, 1, 2, 3, 4
  evidence: 'url' | 'snippet' | 'second_source' | 'cross_check_key' | 'cross_check_all';
  reservePct: number;                    // 0.15, 0.15, 0.12, 0.10, 0.10
  useModelOverrides: boolean;            // High and above: settings.planModel / reflectModel when set
  softCapAsk: boolean;                   // Max: ask before going on at the soft cap (P7b)
}
export interface EffortChoice {
  requested: 'auto' | Level;             // from START_TASK, else settings.effortDefault
  level: Level;
  suggestedBy: 'user' | 'heuristic' | 'default';
}
export interface RunStats {              // local only: finish card, Logs tab, [RUN_STATS]; never sent anywhere
  level: Level; modelCalls: number; stepsUsed: number; tokensIn?: number; tokensOut?: number;
  sitesDone: number; sitesPartial: number; elapsedMs: number;
}

// ---------- plan and sites ----------
export type Predicate =
  | { type: 'url_contains'; value: string }
  | { type: 'text_present'; value: string }
  | { type: 'element_text_present'; value: string };
export interface SiteSpec {              // one plan entry = one worker run
  id: string;                            // CODE: 's1'..'sN', stable for the turn
  name: string;                          // CODE: the domain, 'Step 2' or 'This page'
  domain: string;                        // registrable domain ('idealo.de')
  goal: string;                          // one sentence shown to the model
  goalKind: GoalKind;                    // CODE: from plan.taskKind
  startUrl?: string;                     // CODE-checked: http(s), describeRestrictedUrl null, not blocked
  searchQuery?: string;                  // CODE: '<plan.searchQuery> site:<domain>' for the search rung
  role: 'reference' | 'compare' | 'other';
  kind: 'store' | 'listing' | 'search' | 'page';
  difficulty: 1 | 2 | 3;                 // a hint from the model, clamped in code
  namedByUser: boolean;                  // CODE: the task names this domain, so a revise cannot drop it
  criteria: {
    fields: Array<{ name: string; required: boolean }>;  // CODE: plan.columns plus the model's required_fields
    doneWhen: 'all_required' | 'any' | 'predicate';
    predicate?: Predicate;               // do sites only; without one the site ends 'unverified'
  };
}
export interface PlanMeta {
  version: number;                       // 1, then +1 for every accepted revise
  taskKind: 'research' | 'action' | 'answer';
  columns: string[];                     // CODE-normalized: snake_case, deduped, max 5, reserved names removed
  priceLike: boolean;                    // CODE: a column is price/cost/preis -> price detector + extract mode
  searchQuery: string;                   // 2-6 words, never the whole task text
  compare?: { referenceSiteId: string; field: string; thresholdPct: number };
  sites: SiteSpec[];                     // at most MAX_SITES; finished sites are immutable
  source: 'llm' | 'fallback';
}
export interface SiteState { status: SiteStatus; criteriaMet: boolean; reason?: string }
export interface SiteSummary {           // all the orchestrator knows about a finished site
  siteId: string; status: SiteStatus; criteriaMet: boolean;
  findings: number;                      // accepted findings
  blockers: string[];                    // 'bot check page "Just a moment..." (3 tries)'
  stepsUsed: number;
  failures: StepFailure[];               // the failure memory at the end (max 6), for reflect and the rerun
  anomalies: string[];                   // CODE: currency mismatch, redirect to another domain, title mismatch, price outlier
  userAnswered: boolean;
  notes: string;                         // CODE, up to 300 chars
}
export interface Budget {
  hardCap: number;                       // limits.maxSteps, or a cap raised on the plan card for this run
  workingTotal: number;                  // sum of the site allocations plus the reserve
  reserve: number;                       // units left for reflect and plan revise calls
  slack: number;                         // unused units of finished sites
  used: number;                          // every unit spent this turn
  sites: Record<string, { base: number; alloc: number; used: number; extended: boolean }>;
}
export interface PlanView {              // payload of the approve_plan interrupt
  version: number;
  sites: Array<Pick<SiteSpec, 'id' | 'name' | 'domain' | 'goal' | 'role' | 'kind' | 'startUrl'> & { fields: string[] }>;
  columns: string[];
  searchEngines: string[];               // only used by the blocked ladder's search rung
  level: Level;
  levels: Level[];                       // the levels whose knob values are all available
  estimates: Array<{ level: Level; steps: number; seconds: number; overBudget: boolean }>;
  hardCap: number;
  overBudget: { workingTotal: number; choices: Array<'drop_sites' | 'raise_cap' | 'shrink' | 'lower_level'> } | null;
  replanDiff: { added: string[]; dropped: string[]; reordered: boolean; reason: string } | null;
}
export interface ReflectResult {
  decision: 'continue' | 'replan' | 'stop_early';
  reason: string;
  changes: string;
  by: 'llm' | 'fast_path' | 'code';
  dropSites?: string[];
  addSites?: SiteSpec[];
}

// ---------- findings with provenance ----------
export interface Finding {
  id: string; siteId: string; field: string;
  valueRaw: string; value: string | number; unit?: string; currency?: string;
  url: string; capturedAt: string; step: number; pageTitle?: string; docId: string;
  evidence: { snippet: string; selector?: string; source: 'text' | 'element' };  // snippet up to 160 chars, found by code
  checks: string[];                      // 'value_on_page', 'domain_matches', 'currency_ok', 'title_matches', 'second_source'
  quality: 'verified' | 'single_source' | 'unverified';
  supersedes?: string;                   // id of the finding this one replaced; that one stays, but is not shown
}
export interface TableCell { value: string; url: string; capturedAt: string; snippet: string; quality: Finding['quality']; flag?: string }
export interface FindingsTable {
  columns: string[];
  rows: Array<{
    siteId: string; site: string; role: SiteSpec['role'];
    status: SiteStatus | 'not_checked';
    cells: Record<string, TableCell | null>;          // every cell comes from one Finding
    note: string | null;                              // CODE caveat, e.g. 'title does not mention "Framework Laptop 16"'
    flags: string[];                                  // compare flags, e.g. 'price +6.3% vs frame.work'
  }>;
  cheapest: { site: string; price: string } | null;   // CODE: by value, same currency only
  gaps: string[];                                     // 'geizhals.de: bot check page after 3 tries'
}
export interface VisitedEntry {
  url: string; domain: string; title: string; siteId: string;
  firstStep: number; lastStep: number; visits: number; verdict: PageVerdict; pageType: PageType;
}
export interface BlockedSource {
  domain: string;
  kind: 'challenge' | 'error_page' | 'model_reported' | 'search_engine' | 'restricted';
  reason: string; url: string; step: number; tries: number;
}
export interface StepFailure {
  step: number;
  kind: 'not_found' | 'stale_id' | 'covered' | 'no_effect' | 'timeout' | 'nav_error' | 'blocked'
      | 'denied' | 'policy' | 'parse' | 'away';     // 'away' is a hint from verify, not a failure
  action: { verb: string; elementId?: number; label?: string; url?: string };
  url: string; detail: string;           // up to 140 chars
  fallbackUsed?: 'synthetic'; count: number;
}

// ---------- human in the loop, outcome, UI ----------
export type Hold =                       // orchestrator hold kinds
  | { kind: 'approve_plan' }             // the PlanView is built from state when the payload is made
  | { kind: 'continue_budget'; used: number; workingTotal: number }   // Max soft cap (P7b)
  | { kind: 'paused'; reason: 'user' | 'llm_failure'; error?: string };
export type ResumeValue =                // shared by both hold nodes
  | { kind: 'approve'; level?: Level; dropSiteIds?: string[]; overBudget?: 'shrink' | 'raise_cap'; remember?: 'site' }
  | { kind: 'reject' }
  | { kind: 'answer'; text: string }
  | { kind: 'resume' }
  | { kind: 'stop' };
export type OrchestratorOutcome =        // lastDecision of plan and reflect
  | { kind: 'llm_failed'; error: string; node: 'plan' | 'reflect' }
  | { kind: 'aborted'; node: 'plan' | 'reflect' };
export interface ControlSnapshot { pauseRequested: boolean; stopRequested: boolean }
export interface TrailEntry { node: NodeName; step: number; at: number }
export interface FinalAnswer { text: string; unconfirmed: boolean; table: FindingsTable | null; partial: boolean }
export interface Offer { partialSiteIds: string[]; suggestedLevel: Level }
export interface CdpState { mode: 'off' | 'cdp' | 'synthetic'; reason: string | null; sticky: boolean }

// ---------- panel timeline: today's shapes kept, new types and fields are additive ----------
export type HistoryEntry =
  | { type: 'user_goal'; turn: number; prompt: string; timestamp: string; isNewRun: true }
  | { type: 'step_start'; step: number; url: string; pageTitle: string; elementCount: number;
      siteId?: string; mode?: PolicyMode }
  | { type: 'agent_response'; step: number; thought: string; action: Record<string, unknown> | null;
      rawResponse: string; mode?: PolicyMode }
  | { type: 'execution_result'; step: number; success: boolean; message?: string; error?: string;
      label?: string; submitted?: boolean; resultData?: unknown;
      via?: 'cdp' | 'synthetic' | 'background' | 'state'; effect?: Effect;
      verify?: 'ok' | 'no_effect' | 'failed' | 'stuck'; goal?: 'closer' | 'same' | 'away' }
  | { type: 'error'; step?: number; content: string }
  | { type: 'notice'; step?: number; content: string; level: 'info' | 'warn';
      kind: 'blocked' | 'site' | 'system_nav' | 'cdp' | 'restart' | 'plan' | 'effort' | 'budget'
          | 'stuck' | 'risk' | 'reflect' | 'replan' }
  | { type: 'user_answer'; content: string }
  | { type: 'plan_review'; version: number; sites: PlanView['sites']; level: Level;
      decision: 'approved' | 'rejected'; diff?: PlanView['replanDiff'] }
  | { type: 'confirm_review'; variant: string; actionSummary: string; decision: 'approved' | 'denied';
      remembered?: true }
  | { type: 'site_end'; siteId: string; site: string; status: SiteStatus; reason: string;
      findings: number; stepsUsed: number }
  | { type: 'finish'; answer: string; unconfirmed?: true; partial?: true; table?: FindingsTable;
      runStats?: RunStats; offer?: Offer; stoppedEarly?: string }
  | { type: 'partial_result'; answer: string; table: FindingsTable | null; reason: EndReason;
      runStats?: RunStats; offer?: Offer };  // never a "Done"

export interface Limits {
  maxSteps: number;                  // settings.maxSteps: the "Step limit (hard cap)" for all budget units
  maxSystemActions: number;          // = maxSteps: code navigations, reloads, waits
  maxParseErrorsPerTurn: number;     // = maxSteps: parse errors do not use the budget but are bounded
  maxConsecutiveParseErrors: number; // 3, the circuit breaker as today
}
export const DEFAULT_LIMITS: Limits = {
  maxSteps: 250, maxSystemActions: 250, maxParseErrorsPerTurn: 250, maxConsecutiveParseErrors: 3,
};

export const AgentState = Annotation.Root({
  // ---- turn identity ----
  task: last<string>(() => ''),
  turnIndex: last<number>(() => 0),                 // persisted now (was lost on restart)
  runId: last<string>(() => ''),                    // uuid per turn; journal key prefix
  tier: last<ModelTier>(() => 'small'),
  limits: last<Limits>(() => DEFAULT_LIMITS),       // snapshot at turn start
  runStatus: last<RunStatus>(() => 'idle'),         // terminal status written by finalize
  phase: last<'plan' | 'approve' | 'sites' | 'done'>(() => 'done'),
  turnStartedAt: last<number>(() => 0),
  ctl: last<ControlSnapshot>(() => ({ pauseRequested: false, stopRequested: false })), // transient, see notes

  // ---- effort and budget ----
  effort: last<EffortChoice>(() => ({ requested: 'auto', level: 'medium', suggestedBy: 'default' })),
  effortProfile: last<EffortProfile | null>(() => null),
  budget: last<Budget>(() => ({ hardCap: 0, workingTotal: 0, reserve: 0, slack: 0, used: 0, sites: {} })),
  runStats: last<RunStats | null>(() => null),

  // ---- plan and sites ----
  planMeta: last<PlanMeta | null>(() => null),
  planPrev: last<PlanMeta | null>(() => null),      // the version before a revise, restored when the user keeps it
  sites: map<SiteState>(),                          // key = site id
  siteSummaries: list<SiteSummary>(MAX_SITES),
  activeSiteId: last<string | null>(() => null),
  siteIn: last<SiteIn | null>(() => null),          // written by sched: the worker's only input
  siteOut: last<SiteOut | null>(() => null),        // written by the site wrapper, read by summary
  approvedDomains: last<string[]>(() => []),        // from the approved plan; grows only through approval
  replan: last<{ count: number; lastReason?: string; approvedByUser?: boolean }>(() => ({ count: 0 })),
  reflectResult: last<ReflectResult | null>(() => null),

  // ---- long-horizon memory ----
  findings: last<Finding[]>(() => []),              // merged by summary with the dedupe key, max MAX_FINDINGS
  priorFindings: last<Finding[]>(() => []),         // the previous research turn's findings
  visited: map<VisitedEntry>(MAX_VISITED, (v) => v.lastStep), // key = normalized url
  blocked: map<BlockedSource>(),                    // key = registrable domain

  // ---- counters and LLM outcomes ----
  stepCount: last<number>(() => 0),
  systemActionCount: last<number>(() => 0),
  parseErrorsThisTurn: last<number>(() => 0),
  everParsedOk: last<boolean>(() => false),
  lastDecision: last<OrchestratorOutcome | null>(() => null),
  cdp: last<CdpState>(() => ({ mode: 'off', reason: null, sticky: false })),
  activeTabId: last<number | null>(() => null),     // copy of runtime.tabs.activeTabId, see notes

  // ---- human in the loop ----
  pendingHold: last<Hold | null>(() => null),
  resumeRoute: last<'plan' | 'alloc' | 'sched' | 'reflect' | 'compile' | 'finalize' | null>(() => null),

  // ---- outcome ----
  endReason: last<EndReason | null>(() => null),
  finalAnswer: last<FinalAnswer | null>(() => null),
  offerPayload: last<Offer | null>(() => null),

  // ---- UI-facing ----
  history: list<HistoryEntry>(MAX_HISTORY),
  nodeTrail: list<TrailEntry>(MAX_TRAIL),           // orchestrator nodes; the worker keeps its own trail
});
export type AgentStateT = typeof AgentState.State;
export type AgentUpdate = typeof AgentState.Update;
