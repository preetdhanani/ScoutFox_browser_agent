// src/background/graph/workerState.ts
// Private state of the site worker subgraph. It is checkpointed in the worker's own namespace
// and dropped when the site ends. The orchestrator never reads it: the site wrapper passes
// siteIn in and builds siteOut (plus the new history rows) from the worker's final state.
import { Annotation } from '@langchain/langgraph/web';
import { last, list, MAX_HISTORY, MAX_STEP_RECORDS, MAX_TRAIL } from './state.ts';
import type { ConfirmDetail } from '../agent/risk.ts';
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
import type { EvidenceInput, LedgerSnapshot } from '../agent/evidence.ts';

/** One finished site of this task in the EARLIER SITES block; the trim keeps only head (agent/prompts.ts). */
export interface EarlierSite {
  head: string;                          // 'frame.work (reference): done, 3 values saved in 6 steps'
  notes: string;                         // the site's summary notes; the prompt cuts them to 120 chars
}

export interface SiteIn {                // written by sched; read-only in the worker
  site: SiteSpec; index: number; total: number;          // 'site 2 of 3'
  task: string; taskKind: PlanMeta['taskKind']; columns: string[]; priceLike: boolean;
  compare: PlanMeta['compare'] | null;
  profile: EffortProfile; tier: ModelTier; limits: Limits; runId: string;
  allowExecuteJs?: boolean;              // the Settings opt-in at turn start; missing = off (execute_js not offered)
  alloc: number; slackAvailable: number; hardCapLeft: number;   // budget units
  stepBase: number; systemActionBase: number; parseErrorsBase: number; everParsedOk: boolean;
  tabId: number; cdp: CdpState;
  approvedDomains: string[];
  blocked: BlockedSource[];              // DO NOT OPEN; risk refuses to open them (blockedTargetOf in worker.ts)
  visitedRecent: VisitedEntry[];         // the last 10 of this task by lastStep, all sites
  findingsLines: string[];               // the FINDINGS block, one line per site
  earlierSites: EarlierSite[];           // one per finished site of this task, from siteSummaries
  recap: string[];                       // earlier turns (agent/previousTurns.ts)
  priorFindings: string[];               // the previous research task, one line per finding (priorFindingLine: "[turn N, site] field: value (url)")
  ledgerPrior?: LedgerSnapshot;
  planTexts?: string[];
}

// ---------- perception ----------
export interface ElementInfo {           // CODE, from the content script, for risk (never shown as JSON)
  role: string; label: string;
  formKind?: 'search' | 'login' | 'checkout' | 'other';
  fieldKind?: 'password' | 'cc' | 'otp' | 'email' | 'address' | 'search' | 'text';
  hrefDomain?: string;                   // registrable domain of a link target
  gateLabel?: string;                    // risk gate only: visible text + accessible name, when it adds to label
  submitControl?: boolean;               // clicking it submits its form
  formActionHost?: string;               // the form sends to this other host
  formMethod?: 'get';                    // the form says method="get"
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
  focused?: ElementInfo | null;          // what has focus (press_key acts on it); null none, missing = not reported
  pageText: string;                      // today's extractor, max 4500 chars
  verdict: PageVerdict; verdictReason: string | null;
  pageType: PageType;                    // CODE heuristic (agent/pageType.ts)
  sig: PageSig;
  diffLine: string | null;               // CODE: 'URL same, 14 new elements, text changed, listing -> product'
  priceHits: number;
  priceCandidates: PriceCandidate[];     // CODE: max 8, deduped by value, 60 chars of context each
  consentHint: string | null;            // 'A cookie banner is open; [12] "Nur notwendige" closes it.'
  hash: string;                          // fnv1a of the first 2000 characters of the page text (no url, no elements); suppressExtract keys it with the url
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

export interface OneShot { label: string; text: string; step: number; note?: string } // read_page_text or tool output, shown once in full; note = which part of the page text it is (and the stop hint)

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
  via?: 'cdp' | 'synthetic' | 'background' | 'state';   // the input path the action ran through
  syntheticReason?: string;              // why the input dropped to synthetic DOM events
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
  signature: string;                     // 'verb|target|url|extra', the same key the stuck check and the bans use (actionSignature.ts)
  journalKey: string;                    // '<runId>:<step>'
  risk: { level: 'safe' | 'risky' | 'forbidden';
          variant?: 'submit' | 'purchase' | 'login' | 'form' | 'navigate' | 'script'; reason: string; targetDomain?: string };
}

export interface ExecRecord { step: number; action: PageAction; signature: string; sigBefore: PageSig;
  result: ExecResult | null; discarded: boolean }

export interface VerifyResult { outcome: 'ok' | 'no_effect' | 'failed' | 'stuck';
  goal: 'closer' | 'same' | 'away' | null; detail: string }

export type WorkerHold =                 // worker hold kinds; challenge_help and continue_budget added in P7b
  | { kind: 'confirm_action'; variant: 'submit' | 'purchase' | 'login' | 'form' | 'navigate' | 'script';
      actionSummary: string; elementLabel: string; pageUrl: string; reason: string; targetDomain?: string;
      detail?: ConfirmDetail }           // what the card shows: typed text, code, link and form hosts (agent/risk.ts)
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
  actionSigs: string[];                  // the last 5 action signatures (actionSignature.ts), compared by field, never by substring
  failureMemory: StepFailure[];          // max 6, deduplicated by signature and kind, with count
  banned: string[];                      // action signatures that code rejects on this site
  blockedHits: number;                   // challenge and error-page hits on this site
  ladder: { waits: number; reloads: number; searchTried: boolean; searchEngine: 'google' | 'duckduckgo' | null };
  stuckLevel: 0 | 1 | 2 | 3;
  readPartNext?: number;                 // the part index the next full-page read returns (paged read_page_text)
  readPartKey?: string;                  // 'url|textHash' of the page the last full-page read happened on
  pendingAction?: PendingAction;         // with its risk classification and journal key
  userAnswers: string[];
  strategyHint?: string;
  findings: Finding[];                   // this site's accepted findings
  criteriaMet: boolean;
  suppressExtract: string[];             // pages (url|hash) where the model chose continue_browsing in extract mode, max 20
  visited: VisitedEntry[];               // this site's visits; summary merges them
  blockedNew: BlockedSource[];           // domains this site marked blocked
  approvedNew: string[];                 // domains the user allowed with remember:'site'
  anomalies: string[];
  lastProgressStep: number;              // a new finding or a page-type step forward (slack rule)
  noProgressRecords: number;             // barren rounds in a row: a record_finding that changed no finding value, or an empty answer on an answer site
  consecutiveParseErrors: number; parseErrors: number; everParsedOk: boolean;
  systemActions: number; modelCalls: number; tokensIn?: number; tokensOut?: number;
  cdp: CdpState;
  syntheticNoticed?: boolean;            // the one-per-site panel notice about synthetic input was emitted
  finalAnswer?: FinalAnswer;             // answer sites
  summaryReport?: string;                // a collect site's subgoal_done summary when it recorded nothing; never routes the run
  exit?: { status: SiteStatus; reason: string; fatal?: 'model_unusable' | 'dom_error' | 'hard_cap' | 'tab_gone' | 'out_of_scope' };
  midSiteReflected?: boolean;
  softCapReached?: boolean;
  finishSendBacks?: number;
  lastRefusedFinish?: any;
}

export interface SiteOut {               // built by the site wrapper from the worker's final state
  siteId: string; status: SiteStatus; criteriaMet: boolean; reason: string;
  fatal?: 'model_unusable' | 'dom_error' | 'hard_cap' | 'tab_gone' | 'out_of_scope';
  findings: Finding[]; blocked: BlockedSource[]; visited: VisitedEntry[]; approvedDomains: string[];
  used: number; extendedBy: number; systemActions: number; parseErrors: number; everParsedOk: boolean;
  modelCalls: number; tokensIn?: number; tokensOut?: number;
  failures: StepFailure[]; anomalies: string[]; userAnswered: boolean; notes: string;
  finalAnswer?: FinalAnswer; cdp: CdpState; activeTabId: number | null;
  summaryReport?: string;                // see SiteRun.summaryReport
  evidenceEvents?: EvidenceInput[];
  evidenceBase?: LedgerSnapshot | null;
  lastRefusedFinish?: any;
  finishSendBacks?: number;
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
  evidenceEvents: list<EvidenceInput>(100),
  // The ledger folded from ledgerPrior + every evidence event of this site so
  // far. The 100-event cap evicts the earliest events on long sites, which used
  // to make the finish audit see early-opened pages as never opened (BUG-23);
  // meter folds the accumulated events into this self-capping snapshot, so the
  // rebuilds below never depend on the capped list alone.
  evidenceBase: last<LedgerSnapshot | null>(() => null),
});
export type WorkerStateT = typeof WorkerState.State;
export type WorkerUpdate = typeof WorkerState.Update;
