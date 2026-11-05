// src/background/types.ts
// Consolidated type definitions extracted from graph/state.ts, graph/workerState.ts,
// and agent/finishPolicy.ts. These are the only types still referenced by the
// simplified MCP-based runner (AgentRunner.ts, runtimeRegistry.ts, execute.ts,
// actionJournal.ts, snapshot.ts).
//
// Erasable TypeScript only (no enums, no parameter properties).

import type { EffortLevel } from './llm/effort.ts';

// ---------- small unions ----------
export type RunStatus = 'idle' | 'running' | 'paused' | 'stopped' | 'error';
export type ModelTier = 'small' | 'large';
export type Level = 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type PolicyMode = 'browse' | 'extract' | 'answer' | 'harvest';
export type GoalKind = 'collect' | 'do' | 'answer';
export type PageVerdict = 'ok' | 'challenge' | 'error_page';
export type PageType =
  | 'listing' | 'product' | 'search' | 'login' | 'checkout' | 'cart'
  | 'error' | 'challenge' | 'cookie_wall' | 'other';
export type Effect =
  | 'url_changed' | 'dom_changed' | 'value_set' | 'focus_changed' | 'none' | 'unknown';

/**
 * What an action did to the page, as facts the content script measured around it (the effect
 * probe in content/content.js). `null` in a "changed" field means it could not be measured: an
 * effect that cannot be measured is reported as unknown, never as changed.
 */
export interface EffectDetail {
  /** False when the page had no baseline to compare with (a new document after the action). */
  base: boolean;
  url: string;
  urlChanged: boolean | null;
  /** The focused element after the action; null when nothing has focus. */
  focus: { label: string; editable: boolean; caretLine: string | null; text: string | null } | null;
  focusChanged: boolean | null;
  scroll: { x: number; y: number };
  scrollChanged: boolean | null;
  /** The scroll container of the focused element (or of the viewport centre), measured before and after. */
  container: { label: string; top: number; moved: number | null } | null;
  textHash: string;
  textChanged: boolean | null;
  /** The visible lines that appeared and went away, cut to 400 characters together. */
  added: string;
  removed: string;
  /** How many characters of visible text appeared plus went away, before the cut. */
  changedChars: number;
}

/** A modifier key held with press_key. */
export type KeyModifier = 'ctrl' | 'shift' | 'alt' | 'meta';
export type EndReason =
  | 'all_subgoals_done' | 'goal_achieved' | 'partial' | 'unverified' | 'stopped_early'
  | 'no_subgoal_completed' | 'max_steps' | 'model_unusable' | 'dom_error'
  | 'plan_rejected' | 'stopped' | 'interrupted' | 'closed' | 'error';

// Orchestrator / worker node names (kept as type unions only)
export type OrchestratorNode =
  | 'intake' | 'profile' | 'plan' | 'hold' | 'alloc' | 'sched' | 'site'
  | 'summary' | 'reflect' | 'compile' | 'offer' | 'finalize';
export type WorkerNode =
  | 'open' | 'perceive' | 'meter' | 'blocked' | 'policy' | 'risk' | 'hold'
  | 'execute' | 'verify' | 'recover' | 'record' | 'worker_reflect';
export type NodeName = OrchestratorNode | WorkerNode;

// ---------- JSON-safe reducer envelopes ----------
export type ListUpdate<T> = T[] | { $reset: T[] };
export type MapUpdate<V> = { $set: Record<string, V | null> } | { $reset: Record<string, V> };

// ---------- effort ----------
export interface EffortProfile {
  level: Level;
  multiplier: number;
  retriesPerAction: number;
  altStrategy: boolean;
  verifyMode: 'url' | 'url+dom' | 'goal';
  blockedLadder: string[];
  reflect: 'off' | 'site_end' | 'site_end_and_failure' | 'mid_site';
  maxReplans: number;
  evidence: string;
  reservePct: number;
  useModelOverrides: boolean;
  softCapAsk: boolean;
  searchDepth?: number;
  maxSites?: number;
  stepBudgetPerSite?: number;
  tokenBudgetPerSite?: number;
  reflectMode?: string;
  workerPlanning?: boolean;
  replanBudgetPerSite?: number;
  replanMaxRounds?: number;
  screenshotMode?: string;
}
/**
 * The effort of the running task: how hard the MODEL thinks (llm/effort.ts), never how many steps
 * it takes. `level` is what the task runs with; `requested` is what the composer sent.
 */
export interface EffortChoice {
  requested: EffortLevel;
  level: EffortLevel;
  suggestedBy: 'user' | 'heuristic' | 'default';
}

// ---------- limits ----------
export interface Limits {
  maxSteps: number;
  maxSystemActions: number;
  maxParseErrorsPerTurn: number;
  maxConsecutiveParseErrors: number;
}

// ---------- run stats ----------
export interface RunStats {
  level: Level;
  modelCalls: number;
  stepsUsed: number;
  tokensIn?: number;
  tokensOut?: number;
  sitesDone: number;
  sitesPartial: number;
  elapsedMs: number;
}

// ---------- plan and sites ----------
export type Predicate =
  | { type: 'url_contains'; value: string }
  | { type: 'text_present'; value: string }
  | { type: 'element_text_present'; value: string };

export interface SiteSpec {
  id: string;
  name: string;
  domain: string;
  goal: string;
  goalKind: GoalKind;
  startUrl?: string;
  searchQuery?: string;
  role: 'reference' | 'compare' | 'other';
  kind: 'store' | 'listing' | 'search' | 'page';
  difficulty: 1 | 2 | 3;
  namedByUser: boolean;
  criteria: {
    fields: Array<{ name: string; required: boolean }>;
    doneWhen: 'all_required' | 'any' | 'predicate';
    predicate?: Predicate;
  };
}

export type TaskKind = 'research' | 'action' | 'answer';

export interface PlanMeta {
  version: number;
  taskKind: TaskKind;
  columns: string[];
  priceLike: boolean;
  searchQuery: string;
  compare?: { referenceSiteId: string; field: string; thresholdPct: number };
  sites: SiteSpec[];
  source: 'llm' | 'fallback';
  defaulted?: string[];
}

// ---------- findings ----------
export interface Finding {
  id: string;
  siteId: string;
  field: string;
  valueRaw: string;
  value: string | number;
  unit?: string;
  currency?: string;
  url: string;
  capturedAt: string;
  step: number;
  pageTitle?: string;
  docId: string;
  evidence: { snippet: string; selector?: string; source: 'text' | 'element' };
  checks: string[];
  quality: 'verified' | 'single_source' | 'unverified';
  supersedes?: string;
}

export interface StepFailure {
  step: number;
  kind: 'not_found' | 'stale_id' | 'covered' | 'no_effect' | 'timeout' | 'nav_error'
    | 'blocked' | 'denied' | 'policy' | 'parse' | 'away';
  action: { verb: string; elementId?: number; label?: string; url?: string };
  url: string;
  detail: string;
  fallbackUsed?: 'synthetic';
  count: number;
}

export interface BlockedSource {
  domain: string;
  kind: 'challenge' | 'error_page' | 'model_reported' | 'search_engine' | 'restricted';
  reason: string;
  url: string;
  step: number;
  tries: number;
}

// ---------- control / human in the loop ----------
export interface ControlSnapshot { pauseRequested: boolean; stopRequested: boolean }
export interface TrailEntry { node: NodeName; step: number; at: number }

export type Hold =
  | { kind: 'approve_plan' }
  | { kind: 'continue_budget'; used: number; workingTotal: number }
  | { kind: 'paused'; reason: 'user' | 'llm_failure'; error?: string };

export type ResumeValue =
  | { kind: 'approve'; level?: Level; dropSiteIds?: string[]; overBudget?: 'shrink' | 'raise_cap'; remember?: 'site' }
  | { kind: 'reject' }
  | { kind: 'answer'; text: string }
  | { kind: 'resume' }
  | { kind: 'stop' };

export type OrchestratorOutcome =
  | { kind: 'llm_failed'; error: string; node: 'plan' | 'reflect' }
  | { kind: 'aborted'; node: 'plan' | 'reflect' };

// ---------- panel timeline ----------
export type HistoryEntry =
  | { type: 'user_goal'; turn: number; prompt: string; timestamp: string; isNewRun: true }
  | { type: 'step_start'; step: number; url: string; pageTitle: string; elementCount: number;
      siteId?: string; mode?: PolicyMode }
  | { type: 'agent_response'; step: number; thought: string; action: Record<string, unknown> | null;
      rawResponse: string; mode?: PolicyMode }
  | { type: 'execution_result'; step: number; success: boolean; message?: string; error?: string;
      label?: string; submitted?: boolean; resultData?: unknown;
      /** The id of the picture this step produced, when it took one. The bytes never go here. */
      imageId?: string;
      /** The measured size of that picture, so the panel can size its slot before the bytes arrive. */
      imageWidth?: number; imageHeight?: number;
      via?: 'cdp' | 'synthetic' | 'background' | 'state'; effect?: Effect;
      verify?: 'ok' | 'no_effect' | 'failed' | 'stuck'; goal?: 'closer' | 'same' | 'away';
      finishRefused?: boolean }
  | { type: 'error'; step?: number; content: string }
  | { type: 'notice'; step?: number; content: string; level: 'info' | 'warn';
      kind: 'blocked' | 'site' | 'system_nav' | 'cdp' | 'restart' | 'plan' | 'effort' | 'budget'
          | 'stuck' | 'risk' | 'reflect' | 'replan' | 'llm_retry' | 'tab' }
  | { type: 'user_answer'; content: string }
  | { type: 'plan_review'; version: number; sites: any; level: Level;
      decision: 'approved' | 'rejected'; diff?: any }
  | { type: 'confirm_review'; variant: string; actionSummary: string; decision: 'approved' | 'denied';
      remembered?: true }
  | { type: 'site_end'; siteId: string; site: string; status: string; reason: string;
      findings: number; stepsUsed: number }
  | { type: 'finish'; answer: string; outcome?: 'done' | 'partial' | 'blocked'; unconfirmed?: true; partial?: true; table?: any;
      runStats?: RunStats; offer?: any; stoppedEarly?: string; findings?: Finding[];
      audit?: any; evidence?: string; files?: Array<{ name: string; mime: string; content: string }>;
      /** The run's save_data records, kept so the chat can go on from them (runSnapshot.withRunData). */
      records?: Array<Record<string, unknown>> }
  | { type: 'partial_result'; answer: string; table: any; reason: EndReason;
      runStats?: RunStats; offer?: any; findings?: Finding[];
      skippedSites?: Array<{ siteId: string; site: string; reason: string }>;
      /** What an unfinished turn leaves for a resume: its records, its plan with marks, its last page. */
      records?: Array<Record<string, unknown>>; plan?: Array<{ text: string; status: string }>; pageUrl?: string }
  /**
   * The chat was compacted (mcp/chatChain.ts): `summary` stands for every turn before this row,
   * `summarizedTurns` is how many that is, `auto` says the run did it because the chain was too long.
   */
  | { type: 'chat_compacted'; summary: string; summarizedTurns: number; auto?: boolean; timestamp: string };

// ---------- perception ----------
export interface PageSig {
  url: string; title: string; elementCount: number;
  omittedCount: number;
  interactiveHash: string;
  textHash: string;
  scrollY: number; pageType: PageType;
}

export interface PerceiveError {
  message: string; terminal: boolean;
  fatal: boolean;
  kind: 'tab_gone' | 'out_of_scope' | 'restricted' | 'unreadable'; tries: number;
}

// ---------- actions ----------
export interface OneShot { label: string; text: string; step: number; note?: string }

export interface NetFilter { status?: 'error' | 'success'; since?: 'last_action'; urlContains?: string }

export type PageAction =
  | { action: 'click'; element_id: number }
  | { action: 'click_at'; x: number; y: number }
  | { action: 'take_screenshot' }
  | { action: 'type'; element_id?: number; text: string; submit: boolean; mode?: 'replace' | 'append' }
  | { action: 'scroll'; direction: 'up' | 'down' }
  | { action: 'navigate'; url: string }
  | { action: 'go_back' } | { action: 'go_forward' }
  | { action: 'press_key'; key: string; modifiers?: KeyModifier[] }
  | { action: 'wait'; seconds: number }
  | { action: 'read_page'; part?: number; element_id?: number };

export type StateAction =
  | { action: 'record_finding'; values: Record<string, string> }
  | { action: 'mark_blocked'; reason: string }
  | { action: 'mark_not_found'; reason: string }
  | { action: 'continue_browsing'; reason: string }
  | { action: 'subgoal_done'; summary: string; evidence: string }
  | { action: 'finish'; answer: string; autoWrapped?: true };

export type Decision =
  | { kind: 'page'; action: PageAction; thought: string; mode: PolicyMode; via: 'json' | 'toolcall_markup' | 'text_intent' }
  | { kind: 'state'; action: StateAction; thought: string; mode: PolicyMode; via: 'json' | 'toolcall_markup' | 'prose' }
  | { kind: 'ask'; question: string; mode: PolicyMode }
  | { kind: 'parse_error'; error: string; mode: PolicyMode; closeSite: boolean; modelUnusable: boolean }
  | { kind: 'stale_page'; mode: PolicyMode }
  | { kind: 'llm_failed'; error: string; mode: PolicyMode }
  | { kind: 'aborted'; mode: PolicyMode };

export interface PendingAction {
  action: PageAction;
  signature: string;
  journalKey: string;
  risk: { level: 'safe' | 'risky' | 'forbidden';
          variant?: 'submit' | 'purchase' | 'login' | 'form' | 'navigate' | 'script'; reason: string; targetDomain?: string };
}

export interface ExecRecord { step: number; action: PageAction; signature: string; sigBefore: PageSig;
  result: any | null; discarded: boolean }

export interface VerifyResult { outcome: 'ok' | 'no_effect' | 'failed' | 'stuck';
  goal: 'closer' | 'same' | 'away' | null; detail: string }

// ---------- element info ----------
export interface ElementInfo {
  role: string; label: string;
  formKind?: 'search' | 'login' | 'checkout' | 'other';
  fieldKind?: 'password' | 'cc' | 'otp' | 'email' | 'address' | 'search' | 'text';
  hrefDomain?: string;
  gateLabel?: string;
  submitControl?: boolean;
  formActionHost?: string;
  formMethod?: 'get';
}

// ---------- site run / output ----------
export interface CdpState { mode: 'off' | 'cdp' | 'synthetic'; reason: string | null; sticky: boolean }

export interface SiteRun {
  siteId: string; spec: SiteSpec; tabId: number;
  alloc: number; used: number; extendedBy: number;
  meterMode: 'normal' | 'warn' | 'harvest';
  mode: PolicyMode;
  pageSigs: PageSig[];
  actionSigs: string[];
  failureMemory: StepFailure[];
  banned: string[];
  blockedHits: number;
  ladder: { waits: number; reloads: number; searchTried: boolean; searchEngine: 'google' | 'duckduckgo' | null };
  stuckLevel: 0 | 1 | 2 | 3;
  findings: Finding[];
}

export interface SiteOut {
  siteId: string;
  status: string;
  fatal: boolean;
  criteriaMet: boolean;
  reason: string;
  findings: Finding[];
  blocked: any[];
  visited: any[];
  approvedDomains: string[];
  used: number;
  extendedBy: number;
  systemActions: number;
  parseErrors: number;
  everParsedOk: boolean;
  modelCalls: number;
  failures: StepFailure[];
  anomalies: string[];
  userAnswered: boolean;
  finalAnswer: string | null;
  summaryReport: string | null;
  cdp: CdpState;
  activeTabId: number | null;
  evidenceEvents: any[];
  evidenceBase: any;
  lastRefusedFinish: any;
  finishSendBacks: number;
}

// ---------- finish policy ----------
export type GateDecision = 'send_back' | 'annotate' | 'replace';

export interface GateContext {
  lieCount: number;
  gapCount: number;
  sendBacks: number;
  stepsLeft: number;
}
