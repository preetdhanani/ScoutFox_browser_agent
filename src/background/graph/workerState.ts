// src/background/graph/workerState.ts
// Private state of the site worker subgraph. It is checkpointed in the worker's own namespace
// and dropped when the site ends. The orchestrator never reads it: the site wrapper passes
// siteIn in and builds siteOut (plus the new history rows) from the worker's final state.
import { Annotation } from '@langchain/langgraph/web';
import { last, list, MAX_HISTORY, MAX_STEP_RECORDS, MAX_TRAIL } from './state.ts';
import type {
  BlockedSource,
  CdpState,
  ControlSnapshot,
  EffortProfile,
  FinalAnswer,
  Finding,
  HistoryEntry,
  Limits,
  ModelTier,
  PageType,
  PageVerdict,
  PlanMeta,
  PolicyMode,
  SiteSpec,
  SiteStatus,
  StepFailure,
  TrailEntry,
  VisitedEntry,
} from './state.ts';
import type { ExecResult } from '../runner/runtimeRegistry.ts';

export interface SiteIn {                // written by sched; read-only in the worker
  site: SiteSpec; index: number; total: number;          // 'site 2 of 3'
  task: string; taskKind: PlanMeta['taskKind']; columns: string[]; priceLike: boolean;
  compare: PlanMeta['compare'] | null;
  profile: EffortProfile; tier: ModelTier; limits: Limits; runId: string;
  alloc: number; slackAvailable: number; hardCapLeft: number;   // budget units
  stepBase: number; systemActionBase: number; parseErrorsBase: number; everParsedOk: boolean;
  tabId: number; cdp: CdpState;
  approvedDomains: string[];
  blocked: BlockedSource[];              // DO NOT OPEN
  visitedRecent: VisitedEntry[];         // the last 10, all sites
  findingsLines: string[];               // the FINDINGS block, one line per site
  earlierSites: string[];                // one line per finished site, from siteSummaries
  recap: string[];                       // earlier turns (agent/previousTurns.ts)
  priorFindings: string[];               // the previous research turn, one line per site
}

// ---------- perception ----------
export interface ElementInfo {           // CODE, from the content script, for risk (never shown as JSON)
  role: string; label: string;
  formKind?: 'search' | 'login' | 'checkout' | 'other';
  fieldKind?: 'password' | 'cc' | 'otp' | 'email' | 'address' | 'search' | 'text';
  hrefDomain?: string;                   // registrable domain of a link target
}

export interface PageSig {
  url: string; title: string; elementCount: number;
  interactiveHash: string;               // hash of role + label of the visible interactive elements
  textHash: string;                      // hash of the normalised main text (first 2,000 chars)
  scrollY: number; pageType: PageType;
}

export interface PriceCandidate { id: string; text: string; value: number; currency: string; context: string }

export interface PageSnapshot {
  docId: string;                         // per-document nonce from the content-script world
  tabId: number; url: string; domain: string; title: string;
  scrollY: number; pageHeight: number; viewportHeight: number;
  elementCount: number;                  // interactive elements found before the list cap
  refs: number[];                        // stable ids listed by the content script = the validation set
  shownRefs: number[];                   // ids rendered in this step's prompt (the small tier shows fewer)
  elementsText: string;                  // today's line format with stable ids, max 120 lines
  elementInfo: Record<string, ElementInfo>; // key = String(stable id)
  pageText: string;                      // today's extractor, max 4500 chars
  verdict: PageVerdict; verdictReason: string | null;
  pageType: PageType;                    // CODE heuristic (agent/pageType.ts)
  sig: PageSig;
  diffLine: string | null;               // CODE: 'URL same, 14 new elements, text changed, listing -> product'
  priceHits: number;
  priceCandidates: PriceCandidate[];     // CODE: max 8, deduped by value, 60 chars of context each
  consentHint: string | null;            // 'A cookie banner is open; [12] "Nur notwendige" closes it.'
  hash: string;                          // fnv1a(url + elementsText + pageText), for suppressExtract
  frames: { total: number; crossOrigin: number };
  step: number;
  capturedBootId: string;                // worker incarnation that read the page
  capturedAt: number;                    // ms epoch; policy re-reads pages older than 90 s
}

export interface PerceiveError {
  message: string; terminal: boolean;
  fatal: boolean;                        // tab_gone or out_of_scope: the whole run cannot go on
  kind: 'tab_gone' | 'out_of_scope' | 'restricted' | 'unreadable'; tries: number;
}

export interface OneShot { label: string; text: string; step: number } // read_page_text or tool output, shown once in full

// ---------- memory records (model-facing) ----------
export interface StepRecord {
  step: number | null;                   // null = a system or user event between model steps
  node: 'policy' | 'system' | 'user';
  mode?: PolicyMode;
  url: string;
  verb: string | null;
  line: string;                          // CODE one-liner: '#12 click [88] "Alle Angebote" -> no visible change'
  outcome: 'ok' | 'failed' | 'no_effect' | 'rejected' | 'parse_error' | 'system' | 'user';
  detail: string;                        // max 300 chars
}

// ---------- actions (canonical verbs come from shared/actions.json) ----------
export interface NetFilter { status?: 'error' | 'success'; since?: 'last_action'; urlContains?: string }

export type BatchStep = {
  action: 'click' | 'type' | 'scroll' | 'press_key' | 'wait';
  element_id?: number; text?: string; submit?: boolean;
  direction?: 'up' | 'down'; key?: string; seconds?: number;
};

export type PageAction =
  | { action: 'click'; element_id: number }
  | { action: 'type'; element_id: number; text: string; submit: boolean }
  | { action: 'scroll'; direction: 'up' | 'down' }   // code picks the amount (0.8 x viewport)
  | { action: 'navigate'; url: string }
  | { action: 'go_back' } | { action: 'go_forward' }
  | { action: 'press_key'; key: string }
  | { action: 'wait'; seconds: number }
  | { action: 'read_page_text' }
  | { action: 'execute_js'; code: string }                                                      // large tier
  | { action: 'read_network_requests'; filter?: NetFilter; includeBody?: boolean; limit?: number } // large tier
  | { action: 'browser_batch'; steps: BatchStep[]; stopOnError?: boolean }                       // large tier
  | { action: 'open_window'; url?: string };                                                     // large tier

export type StateAction =
  | { action: 'record_finding'; values: Record<string, string> } // the parser folds the column fields into values
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

export interface PendingAction {         // written by risk
  action: PageAction;
  signature: string;                     // 'verb|target|url', the same key the stuck check and the bans use
  journalKey: string;                    // '<runId>:<step>'
  risk: { level: 'safe' | 'risky' | 'forbidden';
          variant?: 'submit' | 'purchase' | 'login' | 'form' | 'navigate'; reason: string; targetDomain?: string };
}

export interface ExecRecord { step: number; action: PageAction; signature: string; sigBefore: PageSig;
  result: ExecResult | null; discarded: boolean }

export interface VerifyResult { outcome: 'ok' | 'no_effect' | 'failed' | 'stuck';
  goal: 'closer' | 'same' | 'away' | null; detail: string }

export type WorkerHold =                 // worker hold kinds; challenge_help and continue_budget added in P7b
  | { kind: 'confirm_action'; variant: 'submit' | 'purchase' | 'login' | 'form' | 'navigate';
      actionSummary: string; elementLabel: string; pageUrl: string; reason: string; targetDomain?: string }
  | { kind: 'ask_user'; question: string }
  | { kind: 'paused'; reason: 'user' | 'llm_failure'; error?: string }
  | { kind: 'challenge_help'; reason: string; domain: string; url: string }
  | { kind: 'continue_budget'; domain: string; stepsUsed: number; reserveBudget: number };

// ---------- the private site slice ----------
export interface SiteRun {               // Revision 2's siteRun; its step records are the channel 'steps'
  siteId: string; spec: SiteSpec; tabId: number;
  alloc: number; used: number; extendedBy: number;
  meterMode: 'normal' | 'warn' | 'harvest';
  mode: PolicyMode;
  pageSigs: PageSig[];                   // the last 5, for the diff and stuck detection
  actionSigs: string[];                  // the last 5 'verb|target|url', compared by field, never by substring
  failureMemory: StepFailure[];          // max 6, deduplicated by signature and kind, with count
  banned: string[];                      // action signatures that code rejects on this site
  blockedHits: number;                   // challenge and error-page hits on this site
  ladder: { waits: number; reloads: number; searchTried: boolean; searchEngine: 'google' | 'duckduckgo' | null };
  stuckLevel: 0 | 1 | 2 | 3;
  pendingAction?: PendingAction;         // with its risk classification and journal key
  userAnswers: string[];
  strategyHint?: string;
  findings: Finding[];                   // this site's accepted findings
  criteriaMet: boolean;
  suppressExtract: string[];             // page hashes where the model chose continue_browsing
  visited: VisitedEntry[];               // this site's visits; summary merges them
  blockedNew: BlockedSource[];           // domains this site marked blocked
  approvedNew: string[];                 // domains the user allowed with remember:'site'
  anomalies: string[];
  lastProgressStep: number;              // a new finding or a page-type step forward (slack rule)
  consecutiveParseErrors: number; parseErrors: number; everParsedOk: boolean;
  systemActions: number; modelCalls: number; tokensIn?: number; tokensOut?: number;
  cdp: CdpState;
  finalAnswer?: FinalAnswer;             // answer sites
  exit?: { status: SiteStatus; reason: string; fatal?: 'model_unusable' | 'dom_error' | 'hard_cap' };
  midSiteReflected?: boolean;
  softCapReached?: boolean;
}

export interface SiteOut {               // built by the site wrapper from the worker's final state
  siteId: string; status: SiteStatus; criteriaMet: boolean; reason: string;
  fatal?: 'model_unusable' | 'dom_error' | 'hard_cap';
  findings: Finding[]; blocked: BlockedSource[]; visited: VisitedEntry[]; approvedDomains: string[];
  used: number; extendedBy: number; systemActions: number; parseErrors: number; everParsedOk: boolean;
  modelCalls: number; tokensIn?: number; tokensOut?: number;
  failures: StepFailure[]; anomalies: string[]; userAnswered: boolean; notes: string;
  finalAnswer?: FinalAnswer; cdp: CdpState; activeTabId: number | null;
}

export const WorkerState = Annotation.Root({
  siteIn: last<SiteIn | null>(() => null),
  siteRun: last<SiteRun | null>(() => null),       // built by open from siteIn
  page: last<PageSnapshot | null>(() => null),     // one overwritten channel keeps checkpoints bounded
  perceiveError: last<PerceiveError | null>(() => null),
  steps: list<StepRecord>(MAX_STEP_RECORDS),        // Revision 2's siteRun.steps, as its own channel
  oneShotContext: last<OneShot | null>(() => null),
  pendingCorrection: last<string | null>(() => null),
  lastDecision: last<Decision | null>(() => null),
  lastExec: last<ExecRecord | null>(() => null),
  verifyResult: last<VerifyResult | null>(() => null),
  lastFailure: last<{ kind: StepFailure['kind']; reason: string; signature?: string } | null>(() => null),
  pendingHold: last<WorkerHold | null>(() => null),
  resumeRoute: last<'execute' | 'recover' | 'perceive' | 'end' | null>(() => null),
  ctl: last<ControlSnapshot>(() => ({ pauseRequested: false, stopRequested: false })),
  history: list<HistoryEntry>(MAX_HISTORY),        // this site's new timeline rows; the wrapper appends them
  nodeTrail: list<TrailEntry>(MAX_TRAIL),          // worker nodes of this site
});
export type WorkerStateT = typeof WorkerState.State;
export type WorkerUpdate = typeof WorkerState.Update;
