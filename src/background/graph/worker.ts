// src/background/graph/worker.ts
// Site worker subgraph: isolated context for browsing a single site.
// Communicates with orchestrator strictly via SiteIn (input) and SiteOut (output).
// Erasable TypeScript (no enums, no parameter properties).

import { END, START, StateGraph, type BaseCheckpointSaver } from '@langchain/langgraph/web';
import { WorkerState, type PageSig, type PageSnapshot, type PendingAction, type PriceCandidate, type SiteIn, type SiteOut, type WorkerHold, type WorkerStateT, type WorkerUpdate } from './workerState.ts';
import {
  WORKER_ROUTE_MAPS,
  meterRouter,
  blockedRouter,
  policyRouter,
  riskRouter,
  workerHoldRouter,
  verifyRouter,
  recoverRouter,
  recordRouter
} from './routes.ts';
import { defineNode, getRuntime } from '../runner/runtimeRegistry.ts';
import { Logger } from '../../shared/logger.ts';
import { interruptWithConfig } from './interrupt.ts';
import { parseModelReply, type ParseResult } from '../agent/parse.ts';
import { findTopLevelObjects } from '../agent/repairJson.ts';
import { ACTION_VERBS, REGISTRY, verbsFor, type PolicyMode } from '../agent/actions.ts';
import { toPerceiveError } from '../browser/snapshot.ts';
import { buildPolicySchema } from '../agent/schemas.ts';
import { evaluateMeterMode, calculateSlackDraw } from '../agent/budget.ts';
import { classifyPageType } from '../agent/pageType.ts';
import { evaluatePageVerdict, executeBlockedLadder } from '../agent/blockedPolicy.ts';
import { detectStuck } from '../agent/stuck.ts';
import { recordFailure, isSignatureBanned } from '../agent/failureMemory.ts';
import { createFinding, parsePrice, deduplicateFindings, findingsContentSignature, isAutoValueField, FINDING_QUALITY_RANK } from '../agent/findings.ts';
import { evaluateSiteCriteria } from '../agent/criteria.ts';
import { buildPolicySystemPrompt, buildPolicyUserMessage, MEMORY_BUDGET, PAGE_TEXT_BUDGET } from '../agent/prompts.ts';
import { formatRecentSteps, formatOneShotContext, buildStepRecord } from '../agent/memory.ts';
import { evaluateActionRisk } from '../agent/risk.ts';
import { systemAction } from '../agent/systemAction.ts';
import { callWithRetry } from '../agent/recovery.ts';
import { coerceAnswerText } from '../agent/outcome.ts';
import { EvidenceLedger, normalizeUrlForMatch, siteOf, type EvidenceInput } from '../agent/evidence.ts';
import {
  annotateAnswer,
  auditAnswer,
  buildEvidenceReport,
  describeEvidenceForPrompt,
  formatSendBack,
  namedSources,
  prepareAnswer,
} from '../agent/answerAudit.ts';
import { decideOnFailedAudit, type GateContext, type GateDecision } from '../agent/finishPolicy.ts';
import {
  NO_SEND_BACK_ACKNOWLEDGED,
  NO_SEND_BACK_OUT_OF_STEPS,
  NO_SEND_BACK_PLAIN_TEXT,
  answerAcknowledgesEveryGap,
  auditRecordOf,
  evidenceFromActionResult,
  gateClampLog,
  gateContextOf,
  honestPlanStatuses,
  noteTypedText,
  resolveGateDecision,
  withoutAcknowledgedGaps,
  withoutTypedText,
} from '../agent/planEvidence.ts';
import type { BlockedSource, HistoryEntry, StepFailure, VisitedEntry } from './state.ts';

/**
 * The site's full evidence ledger: the folded base (meter folds ledgerPrior +
 * the accumulated events into `evidenceBase` once the raw event list grows,
 * BUG-23) plus whatever raw events are not folded yet. Every consumer that used
 * to rebuild from `siteIn.ledgerPrior` + `state.evidenceEvents` alone lost the
 * earliest events of a long site to the 100-event cap.
 */
function workerLedger(state: WorkerStateT): EvidenceLedger {
  const ledger = EvidenceLedger.fromSnapshot(state.evidenceBase ?? state.siteIn?.ledgerPrior ?? null);
  for (const ev of state.evidenceEvents ?? []) ledger.record(ev);
  return ledger;
}

// Matches a whole amount next to its currency ("1.399,00 EUR", "€ 49.99"), so the
// candidate value is the full number, not only the digit that touches the symbol.
const PRICE_PATTERN = /[€$£¥₹]\s?\d[\d.,]*|\d[\d.,]*\s?(?:[€$£¥₹]|EUR\b|USD\b|GBP\b)/gi;

/** Counts price-looking spans in page text and returns the first three as candidates. */
export function extractPriceCandidates(pageText: string): { priceHits: number; priceCandidates: PriceCandidate[] } {
  const priceMatches = pageText.match(PRICE_PATTERN);
  const priceHits = priceMatches ? priceMatches.length : 0;
  const priceCandidates: PriceCandidate[] = [];
  if (priceMatches && priceMatches.length > 0) {
    for (let i = 0; i < Math.min(priceMatches.length, 3); i++) {
      const match = priceMatches[i];
      const idx = pageText.indexOf(match);
      if (idx >= 0) {
        const snippet = pageText.slice(Math.max(0, idx - 20), Math.min(pageText.length, idx + match.length + 30)).replace(/\s+/g, ' ').trim();
        const val = parsePrice(match.replace(/[.,]+$/, '')).amount ?? 0;
        const curr = match.match(/[€$£¥₹]|EUR|USD|GBP/i)?.[0] || '$';
        priceCandidates.push({
          id: `p${i + 1}`,
          text: match,
          value: val,
          currency: curr,
          context: snippet
        });
      }
    }
  }
  return { priceHits, priceCandidates };
}

/** How many pages a site remembers as "do not extract here". */
const SUPPRESS_EXTRACT_MAX = 20;

/**
 * The key a page is remembered by in `siteRun.suppressExtract`. The page hash covers only the first 2000 characters of the
 * page text (no URL, no elements), so two pages with the same long menu share it; the URL tells them apart. '' for a page
 * with no hash (nothing is remembered then).
 */
export function extractKeyOf(page: { url?: string; hash?: string } | null | undefined): string {
  return page?.hash ? `${page.url ?? ''}|${page.hash}` : '';
}

/**
 * True when the site's result is a WRITTEN answer (not column values to save): its goal kind is answer, or the whole
 * task is an answer task. Used for what the site's RESULT is: whether a finish may end a prose reply, and whether an
 * empty answer may end the site. Which verbs the site is OFFERED is the narrower question of its goal kind alone (schemas.ts
 * and prompts.ts), and recordFindingMisfit uses that one: a collect site of an answer task still offers record_finding.
 */
export function isAnswerSite(siteIn: Pick<SiteIn, 'taskKind' | 'site'> | null | undefined): boolean {
  return siteIn?.site?.goalKind === 'answer' || siteIn?.taskKind === 'answer';
}

/**
 * The text the model gets when it sends `record_finding` to a site that does not offer it, or null when the reply fits.
 * The offer is decided by the goal kind (schemas.ts and prompts.ts use the same): only a collect site saves findings.
 * An answer site has no required fields, so an accepted record_finding there ended the site "done" with no answer at
 * all, and the card said "(The model did not provide an answer.)". The text names the way to end THIS site in THIS
 * mode: answer mode ends with finish, the browse mode of an answer site with subgoal_done (its summary is the answer).
 */
export function recordFindingMisfit(action: unknown, goalKind: string, mode: string): string | null {
  if (action !== 'record_finding' || goalKind === 'collect') return null;
  if (goalKind === 'answer' && mode === 'answer') {
    return 'The action "record_finding" is not available here: this step writes the answer, it does not record values. Reply with {"action":"finish","answer":"<the full answer as text>"}.';
  }
  if (goalKind === 'answer') {
    return 'The action "record_finding" is not available for this site: its result is a written answer, not saved values. Reply with {"action":"subgoal_done","summary":"<the full answer as text>","evidence":"<exact text from the page>"}.';
  }
  return 'The action "record_finding" is not available for this site: it is an action step, not a lookup. Do the action, then reply with {"action":"subgoal_done","summary":"<what you did>","evidence":"<what the page now shows>"}.';
}

export function buildSiteOut(state: WorkerStateT): SiteOut {
  const r = state.siteRun;
  let status = r?.exit?.status;
  if (!status) {
    if (r?.criteriaMet) status = 'done';
    else if (state.ctl?.stopRequested) status = 'stopped';
    else status = 'partial';
  }

  // A fatal perceive error (tab closed, tab left the ScoutFox group) means the
  // whole run cannot go on - it must surface as a failed site with the fatal
  // kind, not as a fake "partial / Site finished" row (BUG-24).
  const perceiveFatal = state.perceiveError?.fatal === true
    ? ((state.perceiveError.kind === 'tab_gone' || state.perceiveError.kind === 'out_of_scope')
        ? state.perceiveError.kind
        : undefined)
    : undefined;
  if (perceiveFatal && status !== 'stopped' && status !== 'done') {
    status = 'failed';
  }

  return {
    siteId: state.siteIn?.site?.id ?? 's1',
    status,
    fatal: r?.exit?.fatal ?? perceiveFatal,
    criteriaMet: r?.criteriaMet ?? false,
    reason: perceiveFatal ? (state.perceiveError!.message || 'Site failed') : (r?.exit?.reason ?? (status === 'done' ? 'All criteria met' : 'Site finished')),
    findings: r?.findings ?? [],
    blocked: r?.blockedNew ?? [],
    visited: r?.visited ?? [],
    approvedDomains: r?.approvedNew ?? [],
    used: r?.used ?? 0,
    extendedBy: r?.extendedBy ?? 0,
    systemActions: r?.systemActions ?? 0,
    parseErrors: r?.parseErrors ?? 0,
    everParsedOk: r?.everParsedOk ?? false,
    modelCalls: r?.modelCalls ?? 0,
    failures: r?.failureMemory ?? [],
    anomalies: r?.anomalies ?? [],
    userAnswered: (r?.userAnswers?.length ?? 0) > 0,
    notes: '',
    finalAnswer: r?.finalAnswer,
    summaryReport: r?.summaryReport,
    cdp: r?.cdp ?? { mode: 'off', reason: null, sticky: false },
    activeTabId: r?.tabId ?? null,
    evidenceEvents: state.evidenceEvents ?? [],
    // The full folded ledger of this site (ledgerPrior + every event, capped by
    // the ledger itself) - the raw event list alone is capped at 100 and would
    // lose the earliest pages of a long site (BUG-23).
    evidenceBase: workerLedger(state).toSnapshot(),
    lastRefusedFinish: r?.lastRefusedFinish,
    finishSendBacks: r?.finishSendBacks ?? 0,
  };
}

// ---------------------------------------------------------------------------------------------
// Helper: Simple String Hash (FNV-1a 32-bit)
// ---------------------------------------------------------------------------------------------
function hashString(str: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 16777619) >>> 0;
  }
  return h.toString(16);
}

// ---------------------------------------------------------------------------------------------
// Worker Node Definitions
// ---------------------------------------------------------------------------------------------

const openNode = defineNode<WorkerStateT, Partial<WorkerUpdate>>('worker', 'open', async (state, config) => {
  const runtime = getRuntime(config);
  const siteIn = state.siteIn;
  if (!siteIn) throw new Error('Worker open: siteIn is required');

  const tabId = siteIn.tabId;
  const inScope = await runtime.browser.isTabInScope(tabId);
  if (!inScope) {
    return {
      perceiveError: {
        message: `Tab ${tabId} is outside the ScoutFox group`,
        terminal: true,
        fatal: true,
        kind: 'out_of_scope',
        tries: 1,
      },
    };
  }

  // Ensure CDP attached if available
  const attachRes = await systemAction(runtime, tabId, 'attach');
  const cdpRes = {
    mode: attachRes.ok ? ('cdp' as const) : ('synthetic' as const),
    reason: attachRes.error ?? null,
  };

  // Navigate to startUrl if specified and tab is not there yet
  if (siteIn.site.startUrl) {
    const tab = await runtime.browser.tabInfo(tabId);
    if (!tab?.url?.startsWith(siteIn.site.startUrl)) {
      await systemAction(runtime, tabId, 'navigate', siteIn.site.startUrl);
    }
  }

    const goalKind = siteIn.site.goalKind ?? 'collect';
    const initialMode: PolicyMode = 'browse';

    const initialSiteRun = state.siteRun
    ? { ...state.siteRun, cdp: { mode: cdpRes.mode, reason: cdpRes.reason, sticky: false } }
    : {
        siteId: siteIn.site.id,
        spec: siteIn.site,
        tabId,
        alloc: siteIn.alloc,
        used: 0,
        extendedBy: 0,
        meterMode: 'normal' as const,
        mode: initialMode,
        pageSigs: [],
        actionSigs: [],
        failureMemory: [],
        banned: [],
        blockedHits: 0,
        ladder: { waits: 0, reloads: 0, searchTried: false, searchEngine: null },
        stuckLevel: 0 as const,
        userAnswers: [],
        findings: [],
        criteriaMet: false,
        suppressExtract: [],
        visited: [],
        blockedNew: [],
        approvedNew: [],
        anomalies: [],
        lastProgressStep: 0,
        noProgressRecords: 0,
        consecutiveParseErrors: 0,
        parseErrors: 0,
        everParsedOk: siteIn.everParsedOk,
        systemActions: 0,
        modelCalls: 0,
        cdp: { mode: cdpRes.mode, reason: cdpRes.reason, sticky: false },
      };

  return { siteRun: initialSiteRun };
});

const perceiveNode = defineNode<WorkerStateT, Partial<WorkerUpdate>>('worker', 'perceive', async (state, config) => {
  const runtime = getRuntime(config);
  const activeTabId = runtime.tabs.activeTabId;
  const tabId = activeTabId ?? state.siteRun?.tabId ?? state.siteIn?.tabId;
  if (tabId === undefined) throw new Error('Worker perceive: tabId is required');

  let siteRun = state.siteRun;
  if (siteRun && activeTabId && siteRun.tabId !== activeTabId) {
    siteRun = { ...siteRun, tabId: activeTabId };
  }

  if (state.perceiveError && (state.perceiveError.tries ?? 0) > 0) {
    await runtime.clock.sleep(250 * state.perceiveError.tries);
  }

  const settings = await runtime.settings().catch(() => null);
  const showBadges = settings?.showElementBadges ?? true;

  let rawSnapshot: any = null;
  try {
    rawSnapshot = await runtime.browser.snapshot(tabId, { showBadges, maxElements: 120 });
  } catch (err: any) {
    const perceiveErr = toPerceiveError(err, (state.perceiveError?.tries ?? 0) + 1);

    let systemActions = siteRun?.systemActions ?? 0;
    if (!perceiveErr.terminal && perceiveErr.tries < 3) {
      systemActions++;
      // Re-inject content scripts and wait 400 ms
      await systemAction(runtime, tabId, 'reinject').catch(() => {});
      await runtime.clock.sleep(400);

      // If restricted or unreadable on an in-scope tab, recover navigation to startUrl (or go_forward if last was go_back)
      const inScope = await runtime.browser.isTabInScope(tabId).catch(() => false);
      if (inScope && (perceiveErr.kind === 'restricted' || perceiveErr.kind === 'unreadable')) {
        const lastActionVerb = (state.lastExec?.action as any)?.action;
        if (lastActionVerb === 'go_back') {
          const prevUrl = state.page?.url || state.siteIn?.site?.startUrl;
          if (prevUrl) {
            await systemAction(runtime, tabId, 'navigate', prevUrl).catch(() => {});
          }
        } else if (state.siteIn?.site?.startUrl) {
          await systemAction(runtime, tabId, 'navigate', state.siteIn.site.startUrl).catch(() => {});
        }
      }
    }

    return {
      perceiveError: perceiveErr,
      siteRun: siteRun ? { ...siteRun, systemActions } : null,
    };
  }

  const snapshot = rawSnapshot?.data && typeof rawSnapshot.data === 'object'
    ? { ...rawSnapshot.data, docId: rawSnapshot.docId ?? rawSnapshot.data.docId }
    : (rawSnapshot ?? {});

  const pageText = snapshot.pageText ?? snapshot.elementsText ?? (snapshot.rawHtml ? snapshot.rawHtml.replace(/<[^>]+>/g, ' ') : '');
  const { priceHits, priceCandidates } = extractPriceCandidates(pageText);

  // Verdict and page type classification
  const verdict = evaluatePageVerdict({
    url: snapshot.url ?? '',
    title: snapshot.title ?? '',
    pageText,
    elementCount: snapshot.elementCount ?? snapshot.refs?.length ?? 0
  });

  const pageType = classifyPageType({
    verdict,
    url: snapshot.url ?? '',
    title: snapshot.title ?? '',
    elementInfo: snapshot.elementInfo ?? {},
    priceHits,
    elementCount: snapshot.elementCount ?? 0
  });

  // Compute hashes for PageSig
  const textHash = hashString((pageText || '').slice(0, 2000));
  const interactiveHash = hashString((snapshot.elementsText || '').slice(0, 2000));

  const scrollY = snapshot.scrollState?.scrollY ?? snapshot.scrollY ?? 0;
  const pageHeight = snapshot.scrollState?.pageHeight ?? snapshot.pageHeight ?? 1000;
  const viewportHeight = snapshot.scrollState?.viewportHeight ?? snapshot.viewportHeight ?? 800;

  const currentSig: PageSig = {
    url: snapshot.url ?? '',
    title: snapshot.title ?? '',
    elementCount: snapshot.elementCount ?? snapshot.refs?.length ?? 0,
    interactiveHash,
    textHash,
    scrollY,
    pageType
  };

  // Compute diff line against previous page signature
  let diffLine: string | null = null;
  const prevSig = state.page?.sig;
  if (prevSig) {
    const urlChanged = prevSig.url !== currentSig.url ? 'URL changed' : 'URL same';
    const countDiff = currentSig.elementCount - prevSig.elementCount;
    const elemChange = countDiff !== 0 ? `${Math.abs(countDiff)} ${countDiff > 0 ? 'new' : 'fewer'} elements` : 'same elements';
    const textChanged = prevSig.textHash !== currentSig.textHash ? 'text changed' : 'text same';
    const typeChange = prevSig.pageType !== currentSig.pageType ? `${prevSig.pageType} -> ${currentSig.pageType}` : currentSig.pageType;
    diffLine = `${urlChanged}, ${elemChange}, ${textChanged}, page type ${typeChange}`;
  }

  const page = {
    docId: snapshot.docId ?? 'doc-1',
    tabId,
    url: snapshot.url ?? '',
    domain: snapshot.domain ?? '',
    title: snapshot.title ?? '',
    scrollY,
    pageHeight,
    viewportHeight,
    elementCount: snapshot.elementCount ?? snapshot.refs?.length ?? 0,
    refs: snapshot.refs ?? [],
    shownRefs: snapshot.shownRefs ?? snapshot.refs ?? [],
    elementsText: snapshot.elementsText ?? '',
    elementInfo: snapshot.elementInfo ?? {},
    ...(snapshot.focused !== undefined ? { focused: snapshot.focused } : {}),
    pageText,
    verdict,
    verdictReason: verdict !== 'ok' ? `Page classified as ${verdict}` : null,
    pageType,
    sig: currentSig,
    diffLine,
    priceHits,
    priceCandidates,
    consentHint: null,
    hash: textHash,
    frames: { total: 1, crossOrigin: 0 },
    step: (state.siteRun?.used ?? 0) + 1,
    capturedBootId: runtime.bootId,
    capturedAt: runtime.clock.now(),
  };

  const stepStartEntry: HistoryEntry = {
    type: 'step_start',
    step: page.step,
    url: page.url,
    pageTitle: page.title,
    elementCount: page.elementCount,
    siteId: state.siteIn?.site?.id,
    mode: state.siteRun?.mode ?? 'browse',
  };

  // A second perceive of the SAME page at the SAME step (the reload rung of the blocked ladder, a
  // recover that loops back) wrote an exact copy of the row the panel already had. The copy is pure
  // noise in the history the panel shows and the prompts read, so it is not appended when the last
  // row is this very step_start. Any field that differs (a new step number, a new title after the
  // reload let the real page through) makes it a genuine row again.
  const lastHistoryEntry = state.history?.[state.history.length - 1] as HistoryEntry | undefined;
  const isDuplicateStepStart = Boolean(
    lastHistoryEntry
    && lastHistoryEntry.type === 'step_start'
    && lastHistoryEntry.step === stepStartEntry.step
    && lastHistoryEntry.url === stepStartEntry.url
    && lastHistoryEntry.pageTitle === stepStartEntry.pageTitle
    && lastHistoryEntry.elementCount === stepStartEntry.elementCount
    && lastHistoryEntry.siteId === stepStartEntry.siteId
    && lastHistoryEntry.mode === stepStartEntry.mode
  );

  Logger.info('Worker', `[DOM_SNAPSHOT_INPUT] Tab [${tabId}] "${page.title}" (${page.url}) - ${page.elementCount} elements.`);

  const elements = typeof snapshot.elementsText === 'string'
    ? snapshot.elementsText.replace(/ value="[\s\S]*?"\)/g, ')')
    : '';
  const fullText = [snapshot.pageText, elements].filter((t: any) => typeof t === 'string' && t !== '').join('\n');
  const via: string[] = [];
  if (runtime.navigatedFrom) {
    const landed = siteOf(snapshot.url ?? '');
    const { site, before } = runtime.navigatedFrom;
    if (!(landed === before && landed !== site)) {
      if (landed !== '' && landed !== site) via.push(site);
      runtime.navigatedFrom = null;
    }
  }
  const cleanText = withoutTypedText(fullText, runtime.typedTexts ?? []);
  const evidenceEvent: EvidenceInput = {
    step: (state.siteIn?.stepBase ?? 0) + (state.siteRun?.used ?? 0),
    kind: 'page',
    url: snapshot.url ?? '',
    title: snapshot.title ?? '',
    text: cleanText,
    via,
  };

  const prevLedger = workerLedger(state);
  if (!prevLedger.wasVisited(evidenceEvent.url)) {
    Logger.info('Worker', `[EVIDENCE_RECORDED] page read on ${siteOf(evidenceEvent.url) || '(no site)'}: ${evidenceEvent.url}`);
  }

  return {
    page,
    perceiveError: null,
    // From state.siteRun, not the local copy: a successful read never wrote the tab switch above, and still does not.
    ...(state.siteRun ? { siteRun: { ...state.siteRun, visited: withVisit(state.siteRun.visited ?? [], page, state.siteRun.siteId, evidenceEvent.step + 1) } } : {}),
    history: isDuplicateStepStart ? [] : [stepStartEntry],
    evidenceEvents: [evidenceEvent],
  };
});

/**
 * This site's visited pages with the page just read added (or its entry moved to this step). The only writer of
 * siteRun.visited; summary merges it into state.visited, and the next site's VISITED block reads it from there.
 * step is the task-wide step of the read (siteIn.stepBase + steps used on this site + 1).
 */
export function withVisit(visited: VisitedEntry[], page: Pick<PageSnapshot, 'url' | 'domain' | 'title' | 'verdict' | 'pageType'>, siteId: string, step: number): VisitedEntry[] {
  const key = normalizeUrlForMatch(page.url);
  if (!key) return visited;
  const at = visited.findIndex((v) => normalizeUrlForMatch(v.url) === key);
  const prev = at >= 0 ? visited[at] : null;
  const entry: VisitedEntry = {
    url: page.url, domain: page.domain || siteOf(page.url), title: page.title, siteId,
    firstStep: prev?.firstStep ?? step, lastStep: step, visits: (prev?.visits ?? 0) + 1,
    verdict: page.verdict, pageType: page.pageType,
  };
  const rest = at >= 0 ? visited.filter((_, i) => i !== at) : visited;
  return [...rest, entry].slice(-MAX_SITE_VISITED);
}

/** The most visited pages a site keeps; the prompt shows the last 10 and summary caps the run map at MAX_VISITED. */
const MAX_SITE_VISITED = 50;

const meterNode = defineNode<WorkerStateT, Partial<WorkerUpdate>>('worker', 'meter', (state) => {
  const siteRun = state.siteRun;
  if (!siteRun) return {};

  const alloc = siteRun.alloc ?? 10;
  const used = siteRun.used ?? 0;
  const rawMode = evaluateMeterMode(used, alloc);
  const meterMode: 'normal' | 'warn' | 'harvest' = rawMode === 'end' ? 'harvest' : rawMode;

  let newAlloc = alloc;
  let extendedBy = siteRun.extendedBy ?? 0;
  let exit = siteRun.exit;
  let mode = siteRun.mode;

  // Check soft cap hold for Max level
  const profile = state.siteIn?.profile;
  const softCapAsk = Boolean(profile?.softCapAsk);
  let pendingHold = state.pendingHold;
  let softCapReached = siteRun.softCapReached ?? false;

  // Check 95% threshold and slack pool
  if (alloc > 0 && used >= Math.floor(alloc * 0.95)) {
    const slackAvailable = state.siteIn?.slackAvailable ?? 0;
    const draw = calculateSlackDraw(slackAvailable, alloc, siteRun.lastProgressStep, used, extendedBy > 0);
    if (draw > 0) {
      newAlloc = alloc + draw;
      extendedBy = draw;
    } else if (!exit && (!softCapAsk || softCapReached) && used >= alloc) {
      exit = { status: 'partial', reason: 'Step budget exhausted on this site' };
    }
  }

  if (softCapAsk && alloc > 0 && used >= alloc && !softCapReached) {
    const limits = state.siteIn?.limits;
    const maxSteps = limits?.maxSteps ?? 250;
    if (used < maxSteps) {
      pendingHold = {
        kind: 'continue_budget',
        domain: state.siteIn?.site?.domain ?? 'unknown',
        stepsUsed: used,
        reserveBudget: Math.max(10, Math.round((state.siteIn?.alloc ?? 20) * (state.siteIn?.profile?.reservePct ?? 0.15))),
      };
      softCapReached = true;
      exit = undefined;
    }
  }

  if (rawMode === 'end' && !exit && !pendingHold) {
    exit = { status: 'partial', reason: 'Step budget exhausted on this site' };
  }

  // Policy mode resolution (answer, harvest, extract, browse)
  const goalKind = state.siteIn?.site?.goalKind ?? 'collect';
  // Answer sites browse while budget remains (so they can scroll, navigate or click their way to
  // the content) and switch to answer mode for the final synthesis. Browse mode offers them
  // `subgoal_done {summary, evidence}` (the summary is the answer, see the record node), answer mode
  // offers `finish`. The parser also accepts a `finish` in browse mode for an answer site (the worker
  // adds it to the verbs), so a one-page answer site can end on the spot.
  if (goalKind === 'answer' && (meterMode === 'harvest' || rawMode === 'end')) {
    mode = 'answer';
  } else if (goalKind === 'collect' && (meterMode === 'harvest' || rawMode === 'end')) {
    mode = 'harvest';
  } else if (
    goalKind === 'collect' &&
    state.siteIn?.columns?.some((c) => /price|cost|preis|shipping/i.test(c)) &&
    (state.page?.priceHits ?? 0) > 0 &&
    // A search results page lists the prices of many products and needs a click to get anywhere: extract mode has no click,
    // and a price recorded there belongs to the wrong product. (A listing with 4+ prices, such as an offers table, still extracts.)
    state.page?.pageType !== 'search' &&
    (!state.page?.domain || !state.siteIn?.site?.domain || state.page.domain.includes(state.siteIn.site.domain) || state.siteIn.site.domain.includes(state.page.domain)) &&
    !(state.siteRun?.suppressExtract ?? []).includes(extractKeyOf(state.page))
  ) {
    mode = 'extract';
  } else {
    mode = 'browse';
  }

  return {
    siteRun: {
      ...siteRun,
      alloc: newAlloc,
      extendedBy,
      meterMode,
      mode,
      softCapReached,
      exit
    },
    pendingHold,
    // BUG-23: fold the raw evidence events accumulated so far into the
    // self-capping base ledger. The raw list resets; rebuilds read base + the
    // few events appended after this fold, so the 100-event cap can no longer
    // evict the site's earliest pages from the finish audit's view.
    ...(((state.evidenceEvents?.length ?? 0) > 0) ? {
      evidenceBase: workerLedger(state).toSnapshot(),
      evidenceEvents: { $reset: [] } as any,
    } : {}),
  };
});

const blockedNode = defineNode<WorkerStateT, Partial<WorkerUpdate>>('worker', 'blocked', async (state, config) => {
  const runtime = getRuntime(config);
  const siteRun = state.siteRun;
  if (!siteRun) return {};

  const tabId = siteRun.tabId;
  const verdict = state.page?.verdict ?? 'challenge';
  const rungs = state.siteIn?.profile?.blockedLadder ?? ['reload', 'mark'];
  const hits = (siteRun.blockedHits ?? 0) + 1;

  const res = await executeBlockedLadder(hits, rungs, verdict, {
    tabId,
    domain: state.siteIn?.site?.domain ?? 'unknown',
    searchQuery: state.siteIn?.site?.goal,
    browser: runtime.browser,
    sleep: (ms) => runtime.clock.sleep(ms, runtime.control.stepSignal()),
    systemAction: (tId, kind, u, o) => systemAction(runtime, tId, kind, u, o),
  });

  let exit = siteRun.exit;
  let pendingHold = state.pendingHold;
  const blockedNew = [...(siteRun.blockedNew ?? [])];

  if (res.actionTaken === 'ask_user') {
    pendingHold = {
      kind: 'challenge_help',
      domain: state.siteIn?.site?.domain ?? 'unknown',
      url: state.page?.url ?? '',
      reason: res.reason,
    };
  } else if (res.shouldExitBlocked) {
    exit = { status: 'blocked', reason: res.reason };
    const domain = state.siteIn?.site?.domain;
    if (domain && !blockedNew.some((b) => b.domain === domain)) {
      blockedNew.push({
        domain,
        kind: verdict === 'challenge' ? 'challenge' : 'error_page',
        reason: res.reason,
        url: state.page?.url ?? '',
        step: siteRun.used ?? 0,
        tries: hits
      });
    }
  }

  return {
    siteRun: {
      ...siteRun,
      blockedHits: hits,
      blockedNew,
      exit
    },
    pendingHold
  };
});

const policyNode = defineNode<WorkerStateT, Partial<WorkerUpdate>>('worker', 'policy', async (state, config) => {
  const runtime = getRuntime(config);
  const siteIn = state.siteIn;
  let siteRun = state.siteRun;
  const page = state.page;
  if (!siteIn || !siteRun || !page) throw new Error('Worker policy: missing state context');

  const mode = siteRun.mode ?? 'browse';
  const tier = siteIn.tier ?? 'small';
  // Auto-value columns (url, link, ...) carry nothing the engine does not already record, and a
  // constrained grammar would otherwise REQUIRE the model to invent one every reply. Filtered at
  // the single place every mode and schema reads columns from.
  const columns = (siteIn.columns ?? []).filter((c) => !isAutoValueField(c));
  const priceLike = siteIn.priceLike ?? false;
  const goalKind = siteIn.site?.goalKind ?? 'collect';

  let netErrors: string | undefined;
  if ((siteRun.stuckLevel ?? 0) > 0 || state.verifyResult?.outcome === 'stuck') {
    const errs = runtime.net.read(runtime.tabs.activeTabId ?? siteRun.tabId, { status: 'error', since: 'last_action' }, true, 5);
    if (errs && !errs.includes('(No network requests')) {
      netErrors = errs;
      Logger.info('Worker', '[GUARDRAIL_NET_AUTO_INJECT] Auto-injected recent network request errors into user prompt.');
    }
  }

  const ledger = workerLedger(state);
  const planTexts = siteIn.planTexts ?? [];
  const evidenceBlock = describeEvidenceForPrompt(ledger, namedSources(siteIn.task, planTexts));

  let planBlock: string | undefined;
  if (planTexts.length > 0) {
    const progressIndex = Math.min(planTexts.length - 1, (siteIn.stepBase ?? 0) + (siteRun.used ?? 0));
    const statuses = honestPlanStatuses(planTexts, progressIndex, ledger, namedSources(siteIn.task, planTexts));
    const stepLines = planTexts.map((text, i) => {
      const st = statuses[i];
      const marker = st === 'completed' ? 'x' : st === 'in_progress' ? '>' : st === 'skipped' ? '-' : ' ';
      return `${i + 1}. [${marker}] ${text}`;
    });
    const stepCount = (siteIn.stepBase ?? 0) + (siteRun.used ?? 0) + 1;
    // The real overall cap lives on siteIn.limits (the worker state has no
    // `limits` channel - the old read was always undefined and the prompt showed
    // a phantom "/12" cap, see BUG-20).
    const hardCap = siteIn.limits?.maxSteps ?? 250;
    planBlock = `Plan (step ${stepCount}${hardCap ? `/${hardCap}` : ''} overall):\n${stepLines.join('\n')}`;
  }

  const systemPrompt = buildPolicySystemPrompt(mode, tier, columns, priceLike, goalKind);
  const userMessage = buildPolicyUserMessage({
    task: siteIn.task,
    siteIndex: siteIn.index,
    totalSites: siteIn.total,
    domain: siteIn.site.domain,
    role: siteIn.site.role,
    goal: siteIn.site.goal,
    columns,
    goalKind,
    usedSteps: siteRun.used,
    allocSteps: siteRun.alloc,
    meterMode: siteRun.meterMode,
    // siteIn.findingsLines is frozen at site start; this site's own findings are appended live so
    // the model sees what code actually accepted after each record_finding (positive feedback,
    // and the "already saved" correction has something to point at).
    findingsLines: Array.from(new Set([
      ...(siteIn.findingsLines ?? []),
      ...(siteRun.findings ?? []).map((f) => `- [${f.siteId}] ${f.field}: ${f.valueRaw} (${f.quality})`)
    ])),
    failures: siteRun.failureMemory,
    bannedSignatures: siteRun.banned,
    recentSteps: formatRecentSteps(state.steps ?? [], 5),
    diffLine: page.diffLine,
    pageTitle: page.title,
    pageUrl: page.url,
    pageType: page.pageType,
    scrollY: page.scrollY,
    pageText: page.pageText,
    pageTextBudget: PAGE_TEXT_BUDGET[tier],
    elementsText: page.elementsText,
    priceCandidates: page.priceCandidates,
    correction: state.pendingCorrection ?? siteRun.strategyHint,
    netErrors,
    userAnswers: siteRun.userAnswers,
    oneShotContext: formatOneShotContext(state.oneShotContext),
    evidenceBlock: evidenceBlock || undefined,
    planBlock: planBlock || undefined,
    recap: siteIn.recap,
    priorFindings: siteIn.priorFindings,
    blocked: doNotOpen(siteIn),
    visited: visitedForPrompt(siteIn.visitedRecent ?? [], siteRun.visited ?? []),
    earlierSites: siteIn.earlierSites,
    memoryBudget: MEMORY_BUDGET[tier],
  });

  const schema = buildPolicySchema({ mode, tier, columns, priceLike, goalKind });
  const stepSignal = runtime.control.stepSignal();
  let replyText = '';

  try {
    const res = await callWithRetry(
      () =>
        runtime.llm.complete({
          node: 'policy',
          mode,
          role: 'policy',
          system: systemPrompt,
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
    replyText = res.text;
    Logger.info('Worker', `[LLM_RAW_OUTPUT] ${replyText.slice(0, 500)}`);
  } catch (err: any) {
    if (runtime.control.isUserAbort(err, stepSignal)) {
      return { lastDecision: { kind: 'aborted', mode } };
    }
    const settings = await runtime.settings().catch(() => null);
    const provider = settings?.provider ?? 'unknown';
    const errEntry: HistoryEntry = {
      type: 'error',
      step: siteRun.used ?? 0,
      content: `LLM Connection Error (${provider}) after 3 attempts: ${err.message}. Task paused at step ${siteRun.used ?? 0} - click Resume to try again, or check your provider settings if this keeps happening.`,
    };
    return {
      lastDecision: {
        kind: 'llm_failed',
        error: err.message ?? 'LLM request failed',
        mode,
      },
      pendingHold: {
        kind: 'paused',
        reason: 'llm_failure',
        error: err.message ?? 'LLM request failed',
      },
      history: [errEntry],
    };
  }

  let decision: any;
  const stateVerbs = ['record_finding', 'subgoal_done', 'continue_browsing', 'mark_not_found', 'mark_blocked', 'finish'];

  // Check if reply matches a graph state action JSON
  const cleaned = replyText.replace(/<(?:think|thought|reasoning)>[\s\S]*?<\/(?:think|thought|reasoning)>/gi, '').trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i);
  let rawJson: any = null;
  try {
    if (fenceMatch) {
      rawJson = JSON.parse(fenceMatch[1]);
    } else {
      // One object per reply is the contract, but small models send a stray {"thought": ...}
      // object before or after the action object. The greedy \{[\s\S]*\} spanned BOTH objects,
      // failed to parse, and the reply fell through to parseModelReply - where the loose scan
      // picked the last object, so a valid action was once rejected as an "unrecognised" action.
      // The string-aware scanner takes the first CLOSED top-level object instead.
      for (const { start, end, closed } of findTopLevelObjects(cleaned)) {
        if (!closed) break;
        try {
          rawJson = JSON.parse(cleaned.slice(start, end));
          break;
        } catch {}
      }
    }
  } catch {}

  let thought = rawJson?.thought ?? '';
  let action: any = null;

  // A record_finding for a site that does not offer it is rejected below, like any other verb the step does not offer
  // (the state-verb fast path used to take it, and an answer site then ended "done" with no answer).
  const misfit = rawJson ? recordFindingMisfit(rawJson.action, goalKind, mode) : null;

  if (rawJson && stateVerbs.includes(rawJson.action) && !misfit) {
    action = rawJson;
    decision = {
      kind: 'state',
      action,
      thought,
      mode,
      via: 'json',
    };
    const responseEntry: HistoryEntry = {
      type: 'agent_response',
      step: (siteRun.used ?? 0) + 1,
      thought,
      action: action ?? null,
      rawResponse: replyText,
      mode,
    };
    return {
      lastDecision: decision,
      history: [responseEntry],
      pendingCorrection: null,
      oneShotContext: null,
      siteRun: {
        ...siteRun,
        consecutiveParseErrors: 0,
        everParsedOk: true,
      },
    };
  }

  const allowedVerbs = [...verbsFor(mode, tier as any)];
  if (isAnswerSite(siteIn) && !allowedVerbs.includes('finish')) {
    allowedVerbs.push('finish');
  }
  // A misfit is a valid reply to the wrong question, so it skips the parser: `record_finding` is not in the verb registry
  // and the parser would call it an unknown action, with no word on how to end this site.
  const parsed: ParseResult = misfit
    ? { thought, error: misfit, kind: 'verb_not_offered', raw: replyText }
    : parseModelReply(replyText, {
        verbs: allowedVerbs,
        refs: page.refs ? new Set(page.refs) : undefined,
        log: (level, msg) => Logger[level]('Worker', msg),
      });
  thought = parsed.thought ?? thought;

  if (parsed.action) {
    action = parsed.action as any;
    const sig = `${action.action}|${action.element_id ?? ''}|${action.url ?? ''}`;

    // Enforce banned signatures
    if (isSignatureBanned(siteRun.banned ?? [], sig)) {
      const consecutiveParseErrors = (siteRun.consecutiveParseErrors ?? 0) + 1;
      const parseErrors = (siteRun.parseErrors ?? 0) + 1;
      await runtime.clock.sleep(1000);

      const correctionText = `Action "${sig}" was previously tried and banned. You must choose a different action.`;
      const responseEntry: HistoryEntry = {
        type: 'agent_response',
        step: (siteRun.used ?? 0) + 1,
        thought,
        action: null,
        rawResponse: replyText,
        mode,
      };
      const failedExecEntry: HistoryEntry = {
        type: 'execution_result',
        step: siteRun.used ?? 0,
        success: false,
        error: correctionText,
      };

      if (consecutiveParseErrors >= 3) {
        if (!siteRun.everParsedOk) {
          const settings = await runtime.settings().catch(() => null);
          const modelName = settings?.model ?? 'unknown';
          const detail = `The model [${modelName}] failed to produce a usable action 3 times in a row. Last parser error: ${correctionText}`;
          const errorContent = `Stopped early - ${detail}`;
          const stopErrorEntry: HistoryEntry = {
            type: 'error',
            step: siteRun.used ?? 0,
            content: errorContent,
          };
          decision = {
            kind: 'parse_error',
            error: correctionText,
            mode,
            closeSite: false,
            modelUnusable: true,
          };
          return {
            lastDecision: decision,
            history: [responseEntry, failedExecEntry, stopErrorEntry],
            pendingCorrection: null,
            siteRun: {
              ...siteRun,
              consecutiveParseErrors,
              parseErrors,
              exit: { status: 'failed', reason: errorContent, fatal: 'model_unusable' },
            },
          };
        } else {
          decision = {
            kind: 'parse_error',
            error: correctionText,
            mode,
            closeSite: true,
            modelUnusable: false,
          };
          return {
            lastDecision: decision,
            history: [responseEntry, failedExecEntry],
            pendingCorrection: null,
            siteRun: {
              ...siteRun,
              consecutiveParseErrors,
              parseErrors,
              exit: { status: 'failed', reason: `Too many consecutive rejected replies (${consecutiveParseErrors})` },
            },
          };
        }
      }

      decision = {
        kind: 'parse_error',
        error: correctionText,
        mode,
        closeSite: false,
        modelUnusable: false,
      };
      return {
        lastDecision: decision,
        history: [responseEntry, failedExecEntry],
        pendingCorrection: correctionText,
        siteRun: {
          ...siteRun,
          consecutiveParseErrors,
          parseErrors,
        },
      };
    }

    // Good parse
    const pageVerbs = new Set(REGISTRY.verbs.filter((v) => v.category === 'page').map((v) => v.name));
    if (action.action === 'ask_user') {
      decision = {
        kind: 'ask',
        question: action.question ?? 'The agent needs more information.',
        mode,
      };
    } else if (pageVerbs.has(action.action)) {
      decision = {
        kind: 'page',
        action,
        thought,
        mode,
        via: 'json',
      };
    } else {
      decision = {
        kind: 'state',
        action,
        thought,
        mode,
        via: 'json',
      };
    }

    const responseEntry: HistoryEntry = {
      type: 'agent_response',
      step: (siteRun.used ?? 0) + 1,
      thought,
      action: action ?? null,
      rawResponse: replyText,
      mode,
    };

    return {
      lastDecision: decision,
      pendingHold: decision.kind === 'ask' ? { kind: 'ask_user', question: decision.question } : null,
      history: [responseEntry],
      pendingCorrection: null,
      oneShotContext: null,
      siteRun: {
        ...siteRun,
        consecutiveParseErrors: 0,
        everParsedOk: true,
      },
    };
  }

  // Parse error
  const consecutiveParseErrors = (siteRun.consecutiveParseErrors ?? 0) + 1;
  const parseErrors = (siteRun.parseErrors ?? 0) + 1;
  await runtime.clock.sleep(1000);

  const rawErr = parsed.error ?? 'Unrecognized action format';
  const correctionText = (parsed as any).kind === 'tool_call_markup' || (parsed as any).kind === 'verb_not_offered'
    ? rawErr
    : `${rawErr} Reply with a single JSON object containing an "action" key and nothing else.`;

  const responseEntry: HistoryEntry = {
    type: 'agent_response',
    step: (siteRun.used ?? 0) + 1,
    thought,
    action: null,
    rawResponse: replyText,
    mode,
  };
  const failedExecEntry: HistoryEntry = {
    type: 'execution_result',
    step: siteRun.used ?? 0,
    success: false,
    error: correctionText,
  };

  if (consecutiveParseErrors >= 3) {
    // A verb the site does not offer was still a VALID reply, so three of them close the site; they do not say the model
    // is unusable, and must not stop the whole run as "model_unusable".
    if (!siteRun.everParsedOk && parsed.kind !== 'verb_not_offered') {
      const empty = /empty output/i.test(rawErr);
      const settings = await runtime.settings().catch(() => null);
      const modelName = settings?.model ?? 'unknown';
      const detail = empty
        ? `The model [${modelName}] returned an empty response 3 times in a row. For a local model this is almost always one of: the model is a reasoning model whose output never left the thinking phase, the reply was truncated by the generation cap, or the prompt overflowed the context window. Check the [OLLAMA_*] warnings above.`
        : `The model [${modelName}] failed to produce a usable action 3 times in a row. Last parser error: ${rawErr}`;
      const errorContent = `Stopped early - ${detail}`;
      const stopErrorEntry: HistoryEntry = {
        type: 'error',
        step: siteRun.used ?? 0,
        content: errorContent,
      };

      decision = {
        kind: 'parse_error',
        error: rawErr,
        mode,
        closeSite: false,
        modelUnusable: true,
      };

      return {
        lastDecision: decision,
        history: [responseEntry, failedExecEntry, stopErrorEntry],
        pendingCorrection: null,
        siteRun: {
          ...siteRun,
          consecutiveParseErrors,
          parseErrors,
          exit: { status: 'failed', reason: errorContent, fatal: 'model_unusable' },
        },
      };
    } else {
      decision = {
        kind: 'parse_error',
        error: rawErr,
        mode,
        closeSite: true,
        modelUnusable: false,
      };

      return {
        lastDecision: decision,
        history: [responseEntry, failedExecEntry],
        pendingCorrection: null,
        siteRun: {
          ...siteRun,
          consecutiveParseErrors,
          parseErrors,
          exit: { status: 'failed', reason: `Too many consecutive rejected replies (${consecutiveParseErrors})` },
        },
      };
    }
  }

  decision = {
    kind: 'parse_error',
    error: rawErr,
    mode,
    closeSite: false,
    modelUnusable: false,
  };

  return {
    lastDecision: decision,
    history: [responseEntry, failedExecEntry],
    pendingCorrection: correctionText,
    siteRun: {
      ...siteRun,
      consecutiveParseErrors,
      parseErrors,
    },
  };
});

const riskNode = defineNode<WorkerStateT, Partial<WorkerUpdate>>('worker', 'risk', (state) => {
  if (state.lastDecision?.kind !== 'page') return {};
  const action = state.lastDecision.action as any;
  const elementId = action?.element_id;
  const elementInfo = elementId !== undefined ? state.page?.elementInfo?.[elementId] : null;

  const currentDomain = state.page?.domain || state.siteIn?.site?.domain || '';
  const approvedDomains = [
    ...(state.siteIn?.approvedDomains ?? []),
    ...(state.siteRun?.approvedNew ?? []),
  ];

  const riskVerdict = evaluateActionRisk({
    action,
    elementInfo,
    pageType: state.page?.pageType,
    pageUrl: state.page?.url,
    approvedDomains: [currentDomain, ...approvedDomains],
    // Batch steps resolve their element per step against the page snapshot
    // (BUG-19: without this, a browser_batch bypassed the whole risk gate).
    resolveElementInfo: (id) => state.page?.elementInfo?.[id] ?? null,
    // press_key acts on the focused element; undefined (not reported) makes an Enter fail closed.
    focusedElementInfo: state.page?.focused,
  });
  const signature = `${action.action}|${action.element_id ?? ''}|${action.url ?? ''}`;

  // A domain another site (or an earlier task, for the lasting kinds) marked blocked is refused here, in code: the
  // DO NOT OPEN block alone is only a request to the model. A forbidden verdict routes to recover, which bans the
  // signature and shows the refusal in ALREADY TRIED AND FAILED.
  const blockedHit = state.siteIn
    ? blockedTargetOf(action, (id) => state.page?.elementInfo?.[id] ?? null, doNotOpen(state.siteIn))
    : null;
  if (blockedHit) {
    Logger.info('Worker', `[GUARDRAIL_BLOCKED_DOMAIN] Refused ${action.action} to ${blockedHit.domain}: it is blocked (DO NOT OPEN).`);
  }
  const evalResult = blockedHit
    ? {
        ...riskVerdict,
        level: 'forbidden' as const,
        variant: undefined,
        reason: `${blockedHit.domain} is blocked (DO NOT OPEN): ${blockedHit.reason || 'an earlier site could not use it'}`,
        targetDomain: blockedHit.domain,
      }
    : riskVerdict;

  const pendingAction: PendingAction = {
    action,
    signature,
    journalKey: `${state.siteIn?.runId}:${(state.siteRun?.used ?? 0) + 1}`,
    risk: {
      level: evalResult.level,
      variant: evalResult.variant,
      reason: evalResult.reason,
      targetDomain: evalResult.targetDomain,
    },
  };

  const actionSummary = evalResult.actionSummary;
  const elementLabel = evalResult.elementLabel || (elementInfo?.label || (action.element_id !== undefined ? `#${action.element_id}` : ''));
  const pageUrl = state.page?.url || '';

  const pendingHold: WorkerHold | null = evalResult.level === 'risky'
    ? {
        kind: 'confirm_action',
        variant: evalResult.variant ?? 'form',
        actionSummary,
        elementLabel,
        pageUrl,
        reason: evalResult.reason,
        targetDomain: evalResult.targetDomain,
      }
    : null;

  const lastFailure = evalResult.level === 'forbidden'
    ? {
        kind: 'policy' as const,
        reason: evalResult.reason,
        signature,
      }
    : null;

  return {
    siteRun: state.siteRun
      ? { ...state.siteRun, pendingAction }
      : null,
    pendingHold,
    lastFailure,
  };
});

/**
 * The blocked entries this site may not open: every one in siteIn.blocked except the site's own domain. The current
 * site was scheduled by the plan the user approved, so its own domain stays usable here; its own new blocked state
 * ends the site through blocked or mark_blocked instead.
 */
export function doNotOpen(siteIn: Pick<SiteIn, 'blocked' | 'site'>): BlockedSource[] {
  const own = siteOf(`https://${siteIn.site?.domain ?? ''}`) || siteOf(siteIn.site?.startUrl ?? '');
  return (siteIn.blocked ?? []).filter((b) => b.domain && siteOf(`https://${b.domain}`) !== own);
}

/**
 * The blocked entry an action would open, or null. Checks the URL of navigate and open_window, the link target of a
 * click, and the clicks of a browser_batch. Domains are compared by site (registrable domain), so www.x.de and
 * shop.x.de both hit a block on x.de.
 */
export function blockedTargetOf(
  action: any,
  resolveElementInfo: (id: number | string) => { hrefDomain?: string } | null,
  blocked: BlockedSource[],
): BlockedSource | null {
  if (!action || blocked.length === 0) return null;
  const targets: string[] = [];
  const addClick = (id: unknown) => {
    if (id === undefined || id === null) return;
    const href = resolveElementInfo(id as number)?.hrefDomain;
    if (href) targets.push(siteOf(`https://${href}`));
  };
  if ((action.action === 'navigate' || action.action === 'open_window') && typeof action.url === 'string') targets.push(siteOf(action.url));
  if (action.action === 'click') addClick(action.element_id);
  if (action.action === 'browser_batch' && Array.isArray(action.steps)) {
    for (const step of action.steps) if (step?.action === 'click') addClick(step.element_id);
  }
  for (const target of targets) {
    if (!target) continue;
    const hit = blocked.find((b) => siteOf(`https://${b.domain}`) === target);
    if (hit) return hit;
  }
  return null;
}

/**
 * The VISITED input of the prompt: the task's earlier visits (siteIn.visitedRecent) and this site's own, one entry
 * per page (the later visit wins), in lastStep order. The prompt keeps the last 10.
 */
export function visitedForPrompt(earlier: VisitedEntry[], own: VisitedEntry[]): VisitedEntry[] {
  const byUrl = new Map<string, VisitedEntry>();
  for (const v of [...earlier, ...own]) {
    const key = normalizeUrlForMatch(v.url);
    const prev = byUrl.get(key);
    if (!prev || v.lastStep >= prev.lastStep) byUrl.set(key, v);
  }
  return [...byUrl.values()].sort((a, b) => a.lastStep - b.lastStep);
}

const holdNode = defineNode<WorkerStateT, Partial<WorkerUpdate>>('worker', 'hold', (state, config) => {
  const resume = interruptWithConfig<any, any>(config, state.pendingHold ?? { kind: 'paused', reason: 'user' });
  const resumeKind = resume?.kind || resume?.action;

  if (resumeKind === 'approve') {
    let siteRun = state.siteRun;
    if (resume.remember === 'site' && state.pendingHold?.kind === 'confirm_action') {
      const targetDomain = state.pendingHold.targetDomain;
      if (targetDomain) {
        const approvedNew = [...(siteRun?.approvedNew ?? [])];
        if (!approvedNew.includes(targetDomain)) {
          approvedNew.push(targetDomain);
        }
        siteRun = siteRun ? { ...siteRun, approvedNew } : null;
      }
    }
    return { resumeRoute: 'execute', pendingHold: null, siteRun };
  }
  if (resumeKind === 'reject') {
    const signature = state.siteRun?.pendingAction?.signature;
    return {
      resumeRoute: 'recover',
      pendingHold: null,
      lastFailure: {
        kind: 'denied',
        reason: 'Action was denied by user',
        signature,
      },
    };
  }
  if (resumeKind === 'stop') {
    return { resumeRoute: 'end', pendingHold: null };
  }
  if (resumeKind === 'answer') {
    const text = resume.text ?? '';
    const userAnswers = state.siteRun ? [...(state.siteRun.userAnswers ?? []), text] : [text];
    const answerEntry: HistoryEntry = {
      type: 'user_answer',
      content: text,
    };
    return {
      resumeRoute: 'perceive',
      siteRun: state.siteRun ? { ...state.siteRun, userAnswers } : null,
      history: [answerEntry],
      pendingHold: null,
    };
  }
  if (resumeKind === 'resolved') {
    return { resumeRoute: 'perceive', pendingHold: null };
  }
  if (resumeKind === 'skip') {
    return {
      resumeRoute: 'end',
      pendingHold: null,
      siteRun: state.siteRun
        ? {
            ...state.siteRun,
            exit: { status: 'partial', reason: 'User skipped security challenge' },
          }
        : null,
      lastFailure: {
        kind: 'blocked',
        reason: 'User skipped security challenge',
      },
    };
  }
  if (resumeKind === 'continue') {
    const extra = resume?.additionalSteps ?? (state.pendingHold?.kind === 'continue_budget' ? state.pendingHold.reserveBudget : 10);
    const newAlloc = (state.siteRun?.alloc ?? 0) + extra;
    return {
      resumeRoute: 'perceive',
      pendingHold: null,
      siteRun: state.siteRun ? { ...state.siteRun, alloc: newAlloc, softCapReached: true, exit: undefined } : null,
    };
  }
  if (resumeKind === 'finish') {
    return {
      resumeRoute: 'end',
      pendingHold: null,
      siteRun: state.siteRun
        ? {
            ...state.siteRun,
            exit: { status: 'partial', reason: 'Finished site at soft cap upon user request' },
          }
        : null,
    };
  }
  return { resumeRoute: 'perceive', pendingHold: null };
});

const executeNode = defineNode<WorkerStateT, Partial<WorkerUpdate>>('worker', 'execute', async (state, config) => {
  const runtime = getRuntime(config);
  const pending = state.siteRun?.pendingAction;
  if (!pending) throw new Error('Worker execute: no pending action');

  const tabId = state.siteRun!.tabId;
  const journalKey = pending.journalKey;

  await runtime.journal.begin(journalKey, pending.action);

  const result = await runtime.browser.execute(tabId, pending.action, {
    docId: state.page?.docId ?? 'doc-1',
    mode: 'cdp',
  });

  await runtime.journal.finish(journalKey, result);

  const execResultEntry: HistoryEntry = {
    type: 'execution_result',
    step: (state.siteRun?.used ?? 0) + 1,
    success: result.success,
    message: result.message,
    error: result.error,
    via: result.via,
    effect: result.effect,
  };

  const elementInfo = (pending.action as any)?.element_id !== undefined ? state.page?.elementInfo?.[(pending.action as any).element_id] : null;
  const stepRec = buildStepRecord({
    step: (state.siteRun?.used ?? 0) + 1,
    node: 'policy',
    verb: (pending.action as any)?.action ?? null,
    elementId: (pending.action as any)?.element_id,
    label: (result as any)?.label || elementInfo?.label,
    url: state.page?.url,
    effect: result.effect,
    success: result.success,
    error: result.error,
    message: result.message,
    note: (result as any).oneShot?.note,
  });

  Logger.info('Worker', `[ACTION_DISPATCH] ${(pending.action as any)?.action || 'action'} dispatched on tab [${tabId}].`);
  Logger.info('Worker', `[ACTION_RESULT] ${result.success ? 'Success: ' + (result.message || 'complete') : 'Failed: ' + (result.error || 'error')}`);

  noteTypedText(pending.action, runtime.typedTexts ?? []);
  if ((pending.action as any)?.action === 'navigate' && result.success !== false && typeof (pending.action as any).url === 'string' && siteOf((pending.action as any).url) !== '') {
    runtime.navigatedFrom = { site: siteOf((pending.action as any).url), before: siteOf(state.page?.url ?? '') };
  }

  const actionEvidence = evidenceFromActionResult(pending.action as any, result);
  const newEvidenceEvents: EvidenceInput[] = [];
  if (actionEvidence) {
    const tabInfo = await runtime.browser.tabInfo(tabId).catch(() => null);
    const url = tabInfo?.url || state.page?.url || '';
    const title = url === state.page?.url ? (state.page?.title || '') : (tabInfo?.title || '');
    const cleanText = withoutTypedText(actionEvidence.text, runtime.typedTexts ?? []);
    const ev: EvidenceInput = {
      step: (state.siteIn?.stepBase ?? 0) + (state.siteRun?.used ?? 0) + 1,
      kind: actionEvidence.kind as any,
      url,
      title,
      text: cleanText,
    };
    newEvidenceEvents.push(ev);
    const prevLedger = workerLedger(state);
    if (!prevLedger.wasVisited(url)) {
      Logger.info('Worker', `[EVIDENCE_RECORDED] ${actionEvidence.kind} read on ${siteOf(url) || '(no site)'}: ${url}`);
    }
  }

  if ((pending.action as any)?.expected_outcome) {
    try {
      const snap = (await runtime.browser.snapshot(tabId, { showBadges: false, maxElements: 100 }).catch(() => null)) as any;
      if (snap && snap.url) {
        const via: string[] = [];
        if (runtime.navigatedFrom) {
          const landed = siteOf(snap.url);
          const { site, before } = runtime.navigatedFrom;
          if (!(landed === before && landed !== site)) {
            if (landed !== '' && landed !== site) via.push(site);
            runtime.navigatedFrom = null;
          }
        }
        const pageEv: EvidenceInput = {
          step: (state.siteIn?.stepBase ?? 0) + (state.siteRun?.used ?? 0) + 1,
          kind: 'page',
          url: snap.url,
          title: snap.title || '',
          text: snap.pageText || '',
          via,
        };
        newEvidenceEvents.push(pageEv);
        const prevLedger = workerLedger(state);
        if (!prevLedger.wasVisited(snap.url)) {
          Logger.info('Worker', `[EVIDENCE_RECORDED] page read on ${siteOf(snap.url) || '(no site)'}: ${snap.url}`);
        }
      }
    } catch {}
  }

  const verb = (pending.action as any)?.action;
  if (['click', 'navigate'].includes(verb) || (verb === 'type' && (pending.action as any)?.submit)) {
    await runtime.browser.waitForTabComplete(tabId, 4000).catch(() => {});
  }

  return {
    lastExec: {
      step: (state.siteRun?.used ?? 0) + 1,
      action: pending.action,
      signature: pending.signature,
      sigBefore: state.page!.sig,
      result,
      discarded: false,
    },
    steps: [stepRec],
    oneShotContext: (result as any).oneShot ?? null,
    history: [execResultEntry],
    ...(newEvidenceEvents.length > 0 ? { evidenceEvents: newEvidenceEvents } : {}),
  };
});

const verifyNode = defineNode<WorkerStateT, Partial<WorkerUpdate>>('worker', 'verify', (state) => {
  const exec = state.lastExec;
  const success = exec?.result?.success ?? false;
  const action = exec?.action as any;
  const verb = action?.action ?? '';
  const effect = exec?.result?.effect ?? 'none';

  // Check expected change per verb
  let outcome: 'ok' | 'failed' | 'stuck' = success ? 'ok' : 'failed';
  if (success) {
    if (['navigate', 'go_back', 'go_forward'].includes(verb)) {
      if (effect !== 'url_changed') outcome = 'failed';
    } else if (verb === 'click') {
      if (effect === 'none') outcome = 'failed';
    } else if (verb === 'type') {
      if (effect !== 'value_set' && effect !== 'dom_changed' && effect !== 'url_changed' && effect !== 'unknown') outcome = 'failed';
    }
  }

  // Stuck detection
  const actionRecords = (state.siteRun?.actionSigs ?? []).map((sig) => ({
    url: state.page?.url ?? '',
    signature: sig
  }));
  if (exec?.signature) {
    actionRecords.push({ url: state.page?.url ?? '', signature: exec.signature });
  }

  const pageSigs = state.siteRun?.pageSigs ?? [];
  const currentSig = state.page?.sig;
  const allPageSigs = currentSig ? [...pageSigs, currentSig] : pageSigs;
  const stuckRes = detectStuck(actionRecords, allPageSigs);
  let stuckLevel = state.siteRun?.stuckLevel ?? 0;
  if (stuckRes.isStuck) {
    stuckLevel = (stuckLevel + 1) as any;
    outcome = 'stuck';
  }

  const used = (state.siteRun?.used ?? 0) + 1;
  const verifyResult = {
    outcome,
    goal: 'closer' as const,
    detail: outcome === 'ok' ? 'Action succeeded' : (stuckRes.detail || exec?.result?.message || 'Action had no effect or failed'),
  };

  const newActionSigs = exec?.signature ? [...(state.siteRun?.actionSigs ?? []), exec.signature] : (state.siteRun?.actionSigs ?? []);
  const newPageSigs = allPageSigs;

  return {
    verifyResult,
    siteRun: state.siteRun
      ? {
          ...state.siteRun,
          used,
          stuckLevel,
          noProgressRecords: 0, // an executed action is the model trying something else
          actionSigs: newActionSigs,
          pageSigs: newPageSigs
        }
      : null,
  };
});

const workerReflectNode = defineNode<WorkerStateT, Partial<WorkerUpdate>>('worker', 'worker_reflect', async (state, config) => {
  const runtime = getRuntime(config);
  const siteRun = state.siteRun;
  if (!siteRun) return {};

  const site = state.siteIn?.site;
  const goal = site?.goal ?? 'Extract information';
  const pageTitle = state.page?.title ?? '';
  const pageUrl = state.page?.url ?? '';
  const findingsCount = siteRun.findings?.length ?? 0;

  let strategyHint = siteRun.strategyHint;
  try {
    const prompt = `You are a web agent reflecting on mid-site progress.
Goal: ${goal}
Site: ${site?.domain} (${pageTitle}, ${pageUrl})
Steps used: ${siteRun.used} of ${siteRun.alloc}
Findings captured so far: ${findingsCount}
Failures encountered: ${siteRun.failureMemory?.length ?? 0}

Evaluate in 1-2 sentences: Has the current approach been effective? If not, suggest a concrete pivot (e.g., search box instead of navigation, alternative filter, or direct listing lookup).
Reply with plain text strategy guidance.`;

    const stepSignal = runtime.control.stepSignal();
    const res = await runtime.llm.complete({
      node: 'reflect',
      role: 'reflect',
      system: 'You are an autonomous web agent strategy supervisor.',
      messages: [{ role: 'user', content: prompt }],
      schema: null,
      signal: stepSignal,
    });

    if (res?.text) {
      strategyHint = res.text.trim().slice(0, 200);
    }
  } catch (err: any) {
    Logger.warn('Worker', `Worker mid-site reflect failed: ${err?.message || err}. Continuing.`);
  }

  return {
    siteRun: {
      ...siteRun,
      midSiteReflected: true,
      strategyHint: strategyHint || siteRun.strategyHint,
    }
  };
});

const recoverNode = defineNode<WorkerStateT, Partial<WorkerUpdate>>('worker', 'recover', (state) => {
  const siteRun = state.siteRun;
  if (!siteRun) return {};

  const exec = state.lastExec;
  const pending = siteRun.pendingAction;
  const lastFailure = state.lastFailure;
  const retriesPerAction = state.siteIn?.profile?.retriesPerAction ?? 1;

  const action = (lastFailure ? (pending?.action ?? exec?.action) : (exec?.action ?? pending?.action)) as any;
  const verb = action?.action ?? 'unknown';
  const target = action?.element_id ? `[${action.element_id}]` : (action?.url || '');
  const signature = (lastFailure ? (lastFailure.signature ?? pending?.signature ?? exec?.signature) : (exec?.signature ?? pending?.signature)) ?? `${verb}|${target}`;

  let kind: StepFailure['kind'] = 'no_effect';
  let detail = 'Action failed';
  let immediateBan = false;

  if (lastFailure?.kind === 'denied') {
    kind = 'denied';
    detail = lastFailure.reason || 'Action denied by user';
    immediateBan = true;
  } else if (lastFailure?.kind === 'policy') {
    kind = 'policy';
    detail = lastFailure.reason || 'Action forbidden by policy';
    immediateBan = true;
  } else if (state.verifyResult?.outcome === 'stuck') {
    kind = 'stale_id';
    detail = state.verifyResult.detail || 'Stuck in loop';
  } else if (state.verifyResult?.detail) {
    detail = state.verifyResult.detail;
  }

  const rec = recordFailure(siteRun.failureMemory ?? [], {
    verb,
    target,
    signature,
    kind,
    detail,
  }, immediateBan ? 0 : retriesPerAction);

  const banned = [...(siteRun.banned ?? [])];
  if ((immediateBan || rec.shouldBan) && !banned.includes(signature)) {
    banned.push(signature);
  }

  let strategyHint = siteRun.strategyHint;
  if (state.siteIn?.profile?.altStrategy === true && (rec.shouldBan || siteRun.stuckLevel >= 1)) {
    strategyHint = 'Prior action failed repeatedly. Try an alternate element, search box, or category navigation.';
  }

  let exit = siteRun.exit;
  if (siteRun.stuckLevel >= 3) {
    exit = { status: 'stuck', reason: 'Site is stuck after repeated failed loops' };
  } else if (siteRun.stuckLevel >= 2) {
    exit = { status: 'partial', reason: 'Unchanged page state after repeated actions' };
  }

  return {
    siteRun: {
      ...siteRun,
      failureMemory: rec.failures,
      banned,
      strategyHint,
      exit,
    },
    lastFailure: null,
  };
});

/**
 * True when two values for the same field differ only in phrasing: the newer says (nearly) the
 * same as the value already saved. Measured on the distinct long words of the smaller text, so a
 * re-phrased summary of the same article (the summarize loop reworded its summary every round to
 * manufacture progress) counts as a duplicate while a genuinely different summary does not.
 * Words are matched on word boundaries, so "GLM" never matches "GLM-Legal" and a domain appearing
 * in both texts does not make them near-duplicates on its own.
 */
function nearDuplicateValue(prevValue: string, incoming: string): boolean {
  const prevWords = new Set((prevValue.toLowerCase().match(/\p{L}{4,}/gu) ?? []));
  const newWords = [...new Set((incoming.toLowerCase().match(/\p{L}{4,}/gu) ?? []))];
  if (prevWords.size === 0 || newWords.length === 0) return prevValue.trim() === incoming.trim();
  const overlap = newWords.filter((w) => prevWords.has(w)).length;
  return overlap / newWords.length >= 0.8;
}

/**
 * The CORRECTION line the next policy prompt gets after a record_finding that saved nothing new.
 * The model never sees code's rejection otherwise, so it repeats the same record_finding forever
 * (the summarize loop: a written-up summary is never word-for-word on the page, every round drops
 * it silently, and the prompt looks identical each time). One message covers the three ways a
 * round can save nothing new: every value rejected as not-on-page, every value "not shown", or
 * every value already saved with the same content.
 */
function recordNoProgressCorrection(parts: {
  rejected: string[];
  notShown: string[];
  savedAgain: string[];
  missing: string[];
}): string {
  const list = (names: string[]) => names.join(', ');
  if (parts.savedAgain.length === 0 && parts.rejected.length === 0) {
    return 'Your record_finding saved nothing: all values were "not shown". If the page does show a value, copy its exact text from ELEMENTS; if the page truly does not have it, use mark_not_found.';
  }
  if (parts.savedAgain.length === 0) {
    const notShownPart = parts.notShown.length > 0 ? ` You wrote "not shown" for: ${list(parts.notShown)}.` : '';
    return `Your record_finding was not saved: ${list(parts.rejected)} do not appear word-for-word on this page, so code dropped them.${notShownPart} Copy the exact text of one element from ELEMENTS (not your own summary), or use read_page_text for more text, or mark_not_found if the page does not have it.`;
  }
  const again = `These values are already saved (see FINDINGS): ${list(parts.savedAgain)}. Do not record them again.`;
  const rejectedPart = parts.rejected.length > 0 ? ` Not saved (not word-for-word on the page): ${list(parts.rejected)}.` : '';
  const missingPart = parts.missing.length > 0
    ? ` Still missing: ${list(parts.missing)} - find them on this page (scroll, read_page_text) or use mark_not_found if the page does not have them.`
    : ' Everything required is saved; use continue_browsing only if more is needed.';
  return `${again}${rejectedPart}${missingPart}`;
}

/**
 * A round in which an answer site sent an EMPTY answer (a `finish` with no text, or a `subgoal_done` with no summary and
 * no evidence). An answer site has no required fields, so the criteria are always met: accepted, such a reply ended the
 * site "done" with nothing to show, and the card said "(The model did not provide an answer.)". Here it is a barren round
 * instead, the same loop guard record_finding has: the model is told what to send, the step is spent, and three rounds in
 * a row end the site as partial.
 *
 * Deliberately NOT done here: `criteriaMet` and `exit` stay as they were, or the router would end the site on them.
 * Called before the finish audit (an empty answer has no claims, so the audit would call it verified).
 */
function emptyAnswerRound(siteRun: NonNullable<WorkerStateT['siteRun']>, mode: string, verb: 'finish' | 'subgoal_done'): Partial<WorkerUpdate> {
  const used = (siteRun.used ?? 0) + 1;
  const streak = (siteRun.noProgressRecords ?? 0) + 1;
  const endSite = streak >= 3 && !siteRun.exit;
  const how = mode === 'answer' || verb === 'finish'
    ? 'Reply with {"action":"finish","answer":"<the full answer as text>"}.'
    : 'Reply with {"action":"subgoal_done","summary":"<the full answer as text>","evidence":"<exact text from the page>"}.';
  const message = `Your reply had no answer in it. Write the answer you found on the page, in full. ${how}`;
  Logger.warn('Worker', `[EMPTY_ANSWER] Round ${streak}: the answer site sent an empty ${verb}. ${message}`);
  const entry: HistoryEntry = { type: 'execution_result', step: used, success: false, via: 'state', verify: 'failed', error: message };
  return {
    pendingCorrection: message,
    history: [entry],
    siteRun: {
      ...siteRun,
      used,
      noProgressRecords: endSite ? 0 : streak,
      exit: endSite ? { status: 'partial' as const, reason: `No answer after ${streak} empty replies - stopped to avoid a loop.` } : siteRun.exit
    }
  };
}

/**
 * The finish pipeline for an answer: audit it against the pages read, ask the finish policy when it is not verified
 * (with the send-back counter and the clamps), then end the site with the answer as it is, annotated or replaced, and
 * the audit record on its finalAnswer - or refuse it with a send-back. Both ways an answer site can end go through
 * here: `finish` (answer mode) and `subgoal_done` (browse mode, the summary is the answer). Before, subgoal_done stored
 * its summary unaudited and the panel showed a summary with a number no page showed as a confirmed "Done".
 *
 * `answer` is already prepared (prepareAnswer) and not empty. `action` is the model's reply: its autoWrapped or
 * unconfirmed flag turns off the send-back and marks the answer unconfirmed. A send-back keeps the reply as
 * lastRefusedFinish with the answer under `answer`, which compile reads when the run hits the step cap.
 */
function finishThroughAudit(
  state: WorkerStateT,
  runtime: ReturnType<typeof getRuntime>,
  siteRun: NonNullable<WorkerStateT['siteRun']>,
  siteIn: NonNullable<WorkerStateT['siteIn']>,
  answer: string,
  action: any
): Partial<WorkerUpdate> {
  const refusedAction = action.action === 'finish' ? action : { ...action, answer };
  const ledger = workerLedger(state);

  const audit = auditAnswer({
    goal: siteIn.task || '',
    answer,
    ledger,
    planTexts: siteIn.planTexts ?? [],
  });

  const sendBacks = siteRun.finishSendBacks ?? 0;
  const auditRec = auditRecordOf(audit, sendBacks);
  Logger.info(
    'Worker',
    `[FINISH_AUDIT] verdict=${audit.verdict} lies=${audit.lies} gaps=${audit.gaps} softs=${audit.softs}`,
    auditRec.notes.length > 0 ? auditRec.notes.map((n: any) => ({ code: n.code, severity: n.severity, text: n.text })) : null
  );

  const updatedUsed = (siteRun.used ?? 0) + 1;

  if (audit.verdict === 'verified') {
    return {
      siteRun: {
        ...siteRun,
        used: updatedUsed,
        criteriaMet: true,
        exit: { status: 'done', reason: answer || 'Goal achieved' },
        finalAnswer: { text: answer, unconfirmed: false, table: null, partial: false, audit: auditRec },
        lastRefusedFinish: undefined,
      },
    };
  }

  const totalHardCap = (state as any).limits?.maxSteps ?? (siteIn.limits as any)?.maxSteps ?? 12;
  const currentTotalSteps = (siteIn.stepBase ?? 0) + updatedUsed;
  const stepsLeft = Math.max(0, totalHardCap - currentTotalSteps);
  const ctx = gateContextOf(audit, sendBacks, stepsLeft);
  let noSendBack: string | undefined;
  if (action.autoWrapped || (action as any).unconfirmed) noSendBack = NO_SEND_BACK_PLAIN_TEXT;
  else if (sendBacks >= 1 && answerAcknowledgesEveryGap(answer, audit)) noSendBack = NO_SEND_BACK_ACKNOWLEDGED;

  const finishPolicy = runtime.finishPolicy ?? decideOnFailedAudit;
  const resolved = resolveGateDecision(finishPolicy, ctx, { noSendBack });
  if (resolved.clamped) {
    const clampLog = gateClampLog(resolved, { sendBacks, verdict: audit.verdict });
    if (clampLog) Logger[clampLog.level === 'warn' ? 'warn' : 'info']('Worker', clampLog.message);
  }

  if (resolved.decision === 'send_back') {
    const message = formatSendBack(audit);
    Logger.info('Worker', `[FINISH_SENT_BACK] Send-back #${sendBacks + 1}: ${message.replace(/\n+/g, ' ')}`);
    const execResultFailure: HistoryEntry = {
      type: 'execution_result',
      step: updatedUsed,
      success: false,
      error: message,
      finishRefused: true,
    };
    return {
      siteRun: {
        ...siteRun,
        used: updatedUsed,
        finishSendBacks: sendBacks + 1,
        lastRefusedFinish: refusedAction,
      },
      pendingCorrection: message,
      history: [execResultFailure],
    };
  }

  // annotate or replace
  let finalAnswerText = answer;
  if (resolved.decision === 'annotate') {
    finalAnswerText = annotateAnswer(answer, withoutAcknowledgedGaps(answer, audit));
    const cutLinks = audit.notes?.some((n: any) => n.code === 'fabricated_url');
    Logger.info('Worker', `[FINISH_ANNOTATED] Finished with the model's answer marked ${audit.verdict}. ${finalAnswerText === answer ? 'The text is unchanged: it already says which sites were not checked.' : `${cutLinks ? 'Links that were never opened were cut out. ' : ''}A warning line and a verification section were added.`}`);
  } else if (resolved.decision === 'replace') {
    finalAnswerText = buildEvidenceReport(audit);
    Logger.info('Worker', '[FINISH_REPLACED] Model answer replaced with code-generated evidence report.');
  }

  const isUnconfirmed = Boolean(action.autoWrapped || (action as any).unconfirmed);
  return {
    siteRun: {
      ...siteRun,
      used: updatedUsed,
      criteriaMet: true,
      exit: { status: 'done', reason: finalAnswerText },
      finalAnswer: { text: finalAnswerText, unconfirmed: isUnconfirmed, table: null, partial: false, audit: auditRec },
      lastRefusedFinish: undefined,
    },
  };
}

const recordNode = defineNode<WorkerStateT, Partial<WorkerUpdate>>('worker', 'record', (state, config) => {
  const runtime = getRuntime(config);
  if (state.lastDecision?.kind !== 'state') return {};
  const action = state.lastDecision.action as any;
  const siteRun = state.siteRun;
  const siteIn = state.siteIn;
  const page = state.page;
  if (!siteRun || !siteIn || !page) return {};

  // 1. finish
  if (action.action === 'finish') {
    const rawAnswer = action.answer ?? '';
    const answer = prepareAnswer(rawAnswer);
    // An empty answer on an answer site is a barren round, decided before the audit looks at it.
    if (isAnswerSite(siteIn) && answer.trim() === '') return emptyAnswerRound(siteRun, siteRun.mode ?? 'browse', 'finish');
    return finishThroughAudit(state, runtime, siteRun, siteIn, answer, action);
  }

  // 2. record_finding
  if (action.action === 'record_finding') {
    const sigBefore = findingsContentSignature(siteRun.findings ?? []);
    let currentFindings = [...(siteRun.findings ?? [])];
    const rawObj = action as any;
    const vals: Record<string, any> = { ...rawObj };
    if (rawObj.field && rawObj.value !== undefined) {
      vals[rawObj.field] = rawObj.value;
    }
    if (rawObj.values && typeof rawObj.values === 'object') {
      Object.assign(vals, rawObj.values);
    }

    const columns = siteIn.columns && siteIn.columns.length > 0 ? siteIn.columns : ['price', 'shipping', 'delivery'];
    const keysToCheck = Array.from(new Set([...columns, ...Object.keys(vals).filter((k) => k !== 'action' && k !== 'thought' && k !== 'field' && k !== 'value' && k !== 'values')]));
    // Prose sites (no price columns) may record a summary whose long words are on the page;
    // money fields always need an exact page match, whatever the site is.
    const allowProseMatch = !siteIn.priceLike;
    const recordedFields: string[] = [];
    const rejectedFields: string[] = [];
    const notShownFields: string[] = [];
    const savedAgainFields: string[] = [];
    const skippedAutoFields: string[] = [];

    for (const col of keysToCheck) {
      const rawVal = vals[col];
      if (!rawVal || typeof rawVal !== 'string') continue;
      // The engine records the page url itself (every finding carries one), so a url/link column
      // never needs a model value - and can never pass the page check either, because a URL is
      // not part of the page text. Accepting it silently kept the site's criteria unsatisfiable
      // and the summarize loop alive.
      if (isAutoValueField(col)) {
        skippedAutoFields.push(col);
        continue;
      }
      if (rawVal.toLowerCase() === 'not shown') {
        notShownFields.push(col);
        continue;
      }
      const finding = createFinding({
        siteId: siteIn.site.id,
        field: col,
        rawValue: rawVal,
        url: page.url,
        title: page.title,
        docId: page.docId,
        step: (siteRun.used ?? 0) + 1,
        capturedAt: runtime.clock.now(),
        pageText: page.pageText,
        domain: siteIn.site.domain,
        allowProseMatch
      });
      if (finding) {
        // A reworded value for a field that already holds a near-identical one is churn, not a
        // new finding (the summarize loop: a slightly re-phrased summary each round defeated the
        // exact-signature check and every round looked like progress). Code drops it and reports
        // the field as already saved, so the model sees the round did nothing - unless the new
        // value verifies better than the saved one (a verbatim quote beats a loose match).
        const prev = currentFindings.find((f) => f.siteId === finding.siteId && f.field === finding.field);
        const upgrades = prev ? FINDING_QUALITY_RANK[finding.quality] > FINDING_QUALITY_RANK[prev.quality] : true;
        if (prev && !upgrades && nearDuplicateValue(prev.valueRaw, finding.valueRaw)) {
          savedAgainFields.push(col);
        } else {
          currentFindings = deduplicateFindings(currentFindings, finding);
          recordedFields.push(col);
        }
      } else {
        rejectedFields.push(col);
      }
    }

    const used = (siteRun.used ?? 0) + 1;
    const criteriaRes = evaluateSiteCriteria(siteIn.site, currentFindings);
    const exit = criteriaRes.met ? { status: 'done' as const, reason: criteriaRes.reason } : siteRun.exit;

    // Progress means the findings content changed: a new field, a changed value or a quality
    // upgrade. Re-sending the same values (new finding ids, same content) is not progress.
    const progressed = findingsContentSignature(currentFindings) !== sigBefore;

    if (progressed) {
      let correction: string | null = null;
      if (rejectedFields.length > 0) {
        correction = `Saved: ${recordedFields.join(', ')}. Not saved (not word-for-word on the page): ${rejectedFields.join(', ')} - copy those values exactly as the page shows them, or write "not shown".`;
      } else if (savedAgainFields.length > 0) {
        correction = `Saved: ${recordedFields.join(', ')}. These values are already saved (see FINDINGS) - do not record them again: ${savedAgainFields.join(', ')}.`;
      }
      return {
        ...(correction ? { pendingCorrection: correction } : {}),
        siteRun: {
          ...siteRun,
          used,
          findings: currentFindings,
          criteriaMet: criteriaRes.met,
          lastProgressStep: used,
          noProgressRecords: 0,
          exit
        }
      };
    }

    // Nothing changed: tell the model what happened (the correction is the only channel it sees)
    // and stop the site after three barren rounds - otherwise the same record_finding repeats
    // until the whole step budget is gone.
    const streak = (siteRun.noProgressRecords ?? 0) + 1;
    // Missing fields must follow the same rule as evaluateSiteCriteria: auto-value fields are
    // engine-recorded, so listing them as "Still missing" asks the model for something it can
    // never send.
    const requiredNames = (siteIn.site.criteria?.fields ?? [])
      .filter((f) => f.required && !isAutoValueField(f.name))
      .map((f) => f.name);
    const recordedNames = new Set(currentFindings.map((f) => f.field));
    const missing = requiredNames.filter((n) => !recordedNames.has(n));
    // A round whose values were all auto-value (url/link) skipped everything before saving, so
    // none of the usual buckets fired. The truthful correction is "that is recorded
    // automatically", not the false claim that every value was "not shown".
    let message: string;
    if (savedAgainFields.length === 0 && rejectedFields.length === 0 && skippedAutoFields.length > 0) {
      message = `${skippedAutoFields.join(', ')} is recorded automatically for every finding - do not send it. Save the values you see on this page (copied word-for-word), or use read_page_text for more text, or mark_not_found.`;
    } else {
      message = recordNoProgressCorrection({
        rejected: rejectedFields,
        notShown: notShownFields,
        savedAgain: savedAgainFields.length > 0 ? savedAgainFields : recordedFields,
        missing
      });
    }
    Logger.warn('Worker', `[RECORD_NO_PROGRESS] Round ${streak} on ${siteIn.site.domain} saved nothing new. ${message}`);
    const endSite = streak >= 3 && !exit;
    const historyEntry: HistoryEntry = {
      type: 'execution_result',
      step: used,
      success: false,
      via: 'state',
      verify: 'failed',
      error: message
    };
    return {
      pendingCorrection: message,
      history: [historyEntry],
      siteRun: {
        ...siteRun,
        used,
        findings: currentFindings,
        criteriaMet: criteriaRes.met,
        lastProgressStep: siteRun.lastProgressStep,
        noProgressRecords: endSite ? 0 : streak,
        exit: endSite ? { status: 'partial' as const, reason: `No savable findings after ${streak} record_finding rounds - stopped to avoid a loop.` } : exit
      }
    };
  }

  // 3. subgoal_done
  if (action.action === 'subgoal_done') {
    // An answer site's summary IS the answer: with neither a summary nor evidence there is nothing to show. This check
    // runs before the criteria, which an answer site always meets.
    // prepareAnswer strips the invisible characters (a summary of only zero-width spaces is empty, like a blank finish).
    if (isAnswerSite(siteIn) && !prepareAnswer(action.summary).trim() && !prepareAnswer(action.evidence).trim()) {
      return emptyAnswerRound(siteRun, siteRun.mode ?? 'browse', 'subgoal_done');
    }
    // An answer site ends with subgoal_done; its summary IS the answer the user asked for (the evidence when there is
    // no summary). It goes through the same audit, finish policy and send-back counter as a finish, and ends as the
    // site's finalAnswer with the audit record, or compile has nothing to show and the panel displays
    // "(The model did not provide an answer.)".
    if (isAnswerSite(siteIn)) {
      const summary = prepareAnswer(action.summary).trim();
      return finishThroughAudit(state, runtime, siteRun, siteIn, summary || prepareAnswer(action.evidence).trim(), action);
    }
    const criteriaRes = evaluateSiteCriteria(siteIn.site, siteRun.findings ?? [], {
      url: page.url,
      pageText: page.pageText,
      elementTexts: [page.elementsText]
    });
    const summaryText = coerceAnswerText(action.summary).trim() || coerceAnswerText(action.evidence).trim();
    // A collect site that ends with a summary but nothing recorded ("Search Google for X" after the
    // results page loaded) used to throw the summary away: no findings, no finalAnswer, and the card
    // showed "(The model did not provide an answer.)" over a run the log called a success. The
    // summary is kept as the site's summaryReport, which compile shows when there is no real answer
    // and no table. It must NOT become a finalAnswer: summaryRouter reads finalAnswer as "the goal
    // is achieved" and would skip every remaining site of the plan.
    const collectSummary = Boolean(summaryText) && (siteRun.findings ?? []).length === 0
      ? summaryText
      : undefined;
    return {
      siteRun: {
        ...siteRun,
        used: (siteRun.used ?? 0) + 1,
        criteriaMet: criteriaRes.met,
        ...(collectSummary ? { summaryReport: collectSummary } : {}),
        exit: { status: criteriaRes.status, reason: action.summary || criteriaRes.reason }
      }
    };
  }

  // 4. continue_browsing
  if (action.action === 'continue_browsing') {
    // "This page is not for extracting": remember the page, or the meter (which recomputes the mode on every loop and
    // reads suppressExtract) would put the model straight back into extract mode, which has no click or navigate.
    // The field was declared, initialised and read, but nothing wrote it. Deduplicated and capped: it is checkpointed state.
    const key = extractKeyOf(page);
    const suppressExtract = siteRun.mode === 'extract' && key && !(siteRun.suppressExtract ?? []).includes(key)
      ? [...(siteRun.suppressExtract ?? []), key].slice(-SUPPRESS_EXTRACT_MAX)
      : siteRun.suppressExtract;
    return {
      siteRun: {
        ...siteRun,
        used: (siteRun.used ?? 0) + 1,
        noProgressRecords: 0, // a deliberate pivot, not another blind record round
        mode: 'browse',
        suppressExtract
      }
    };
  }

  // 5. mark_not_found
  if (action.action === 'mark_not_found') {
    return {
      siteRun: {
        ...siteRun,
        used: (siteRun.used ?? 0) + 1,
        exit: { status: 'not_found', reason: action.reason }
      }
    };
  }

  // 6. mark_blocked
  if (action.action === 'mark_blocked') {
    const blockedNew = [...(siteRun.blockedNew ?? [])];
    if (siteIn.site.domain && !blockedNew.some((b) => b.domain === siteIn.site.domain)) {
      blockedNew.push({
        domain: siteIn.site.domain,
        kind: 'model_reported',
        reason: action.reason || 'Blocked',
        url: page.url,
        step: (siteRun.used ?? 0) + 1,
        tries: 1
      });
    }
    return {
      siteRun: {
        ...siteRun,
        used: (siteRun.used ?? 0) + 1,
        blockedNew,
        exit: { status: 'blocked', reason: action.reason }
      }
    };
  }

  return {};
});

// ---------------------------------------------------------------------------------------------
// Worker Subgraph Builder
// ---------------------------------------------------------------------------------------------

export function buildWorkerGraph(checkpointer?: BaseCheckpointSaver) {
  return new StateGraph(WorkerState)
    .addNode('open', openNode)
    .addNode('perceive', perceiveNode)
    .addNode('meter', meterNode)
    .addNode('worker_reflect', workerReflectNode)
    .addNode('blocked', blockedNode)
    .addNode('policy', policyNode)
    .addNode('risk', riskNode)
    .addNode('hold', holdNode)
    .addNode('execute', executeNode)
    .addNode('verify', verifyNode)
    .addNode('recover', recoverNode)
    .addNode('record', recordNode)
    .addEdge(START, 'open')
    .addEdge('open', 'perceive')
    .addEdge('perceive', 'meter')
    .addConditionalEdges('meter', meterRouter, WORKER_ROUTE_MAPS.meter)
    .addEdge('worker_reflect', 'policy')
    .addConditionalEdges('blocked', blockedRouter, WORKER_ROUTE_MAPS.blocked)
    .addConditionalEdges('policy', policyRouter, WORKER_ROUTE_MAPS.policy)
    .addConditionalEdges('risk', riskRouter, WORKER_ROUTE_MAPS.risk)
    .addConditionalEdges('hold', workerHoldRouter, WORKER_ROUTE_MAPS.hold)
    .addEdge('execute', 'verify')
    .addConditionalEdges('verify', verifyRouter, WORKER_ROUTE_MAPS.verify)
    .addConditionalEdges('recover', recoverRouter, WORKER_ROUTE_MAPS.recover)
    .addConditionalEdges('record', recordRouter, WORKER_ROUTE_MAPS.record)
    .compile(checkpointer ? { checkpointer } : undefined);
}
