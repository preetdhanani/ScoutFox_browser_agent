// src/background/graph/worker.ts
// Site worker subgraph: isolated context for browsing a single site.
// Communicates with orchestrator strictly via SiteIn (input) and SiteOut (output).
// Erasable TypeScript (no enums, no parameter properties).

import { END, START, StateGraph, type BaseCheckpointSaver } from '@langchain/langgraph/web';
import { WorkerState, type PageSig, type PendingAction, type PriceCandidate, type SiteOut, type WorkerHold, type WorkerStateT, type WorkerUpdate } from './workerState.ts';
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
import { parseModelReply } from '../agent/parse.ts';
import { ACTION_VERBS } from '../agent/actions.ts';
import { buildPolicySchema } from '../agent/schemas.ts';
import { evaluateMeterMode, calculateSlackDraw } from '../agent/budget.ts';
import { classifyPageType } from '../agent/pageType.ts';
import { evaluatePageVerdict, executeBlockedLadder } from '../agent/blockedPolicy.ts';
import { detectStuck } from '../agent/stuck.ts';
import { recordFailure, isSignatureBanned } from '../agent/failureMemory.ts';
import { createFinding, deduplicateFindings } from '../agent/findings.ts';
import { evaluateSiteCriteria } from '../agent/criteria.ts';
import { buildPolicySystemPrompt, buildPolicyUserMessage } from '../agent/prompts.ts';
import { evaluateActionRisk } from '../agent/risk.ts';
import type { BlockedSource, HistoryEntry, StepFailure } from './state.ts';

export function buildSiteOut(state: WorkerStateT): SiteOut {
  const r = state.siteRun;
  let status = r?.exit?.status;
  if (!status) {
    if (r?.criteriaMet) status = 'done';
    else if (state.ctl?.stopRequested) status = 'stopped';
    else status = 'partial';
  }

  return {
    siteId: state.siteIn?.site?.id ?? 's1',
    status,
    criteriaMet: r?.criteriaMet ?? false,
    reason: r?.exit?.reason ?? (status === 'done' ? 'All criteria met' : 'Site finished'),
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
    cdp: r?.cdp ?? { mode: 'off', reason: null, sticky: false },
    activeTabId: r?.tabId ?? null,
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
  const cdpRes = await runtime.browser.cdp.ensureAttached(tabId);

  // Navigate to startUrl if specified and tab is not there yet
  if (siteIn.site.startUrl) {
    const tab = await runtime.browser.tabInfo(tabId);
    if (!tab?.url?.startsWith(siteIn.site.startUrl)) {
      await runtime.browser.navigate(tabId, siteIn.site.startUrl);
      await runtime.browser.waitForTabComplete(tabId, 5000).catch(() => {});
    }
  }

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
        mode: 'browse' as const,
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
  const tabId = state.siteRun?.tabId ?? state.siteIn?.tabId;
  if (tabId === undefined) throw new Error('Worker perceive: tabId is required');

  let rawSnapshot: any = null;
  try {
    rawSnapshot = await runtime.browser.snapshot(tabId, { showBadges: true, maxElements: 120 });
  } catch (err: any) {
    return {
      perceiveError: {
        message: err.message ?? 'Failed to take DOM snapshot',
        terminal: false,
        fatal: false,
        kind: 'unreadable',
        tries: (state.perceiveError?.tries ?? 0) + 1,
      },
    };
  }

  const snapshot = rawSnapshot?.data && typeof rawSnapshot.data === 'object'
    ? { ...rawSnapshot.data, docId: rawSnapshot.docId ?? rawSnapshot.data.docId }
    : (rawSnapshot ?? {});

  const pageText = snapshot.pageText ?? snapshot.elementsText ?? (snapshot.rawHtml ? snapshot.rawHtml.replace(/<[^>]+>/g, ' ') : '');
  const priceMatches = pageText.match(/[€$£¥₹]\s?\d|\d\s?(?:[€$£¥₹]|EUR\b|USD\b|GBP\b)/gi);
  const priceHits = priceMatches ? priceMatches.length : 0;

  // Extract top price candidate snippets
  const priceCandidates: PriceCandidate[] = [];
  if (priceMatches && priceMatches.length > 0) {
    for (let i = 0; i < Math.min(priceMatches.length, 3); i++) {
      const match = priceMatches[i];
      const idx = pageText.indexOf(match);
      if (idx >= 0) {
        const snippet = pageText.slice(Math.max(0, idx - 20), Math.min(pageText.length, idx + match.length + 30)).replace(/\s+/g, ' ').trim();
        const numMatch = match.replace(/[^0-9.,]/g, '').replace(',', '.');
        const val = parseFloat(numMatch) || 0;
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

  const currentSig: PageSig = {
    url: snapshot.url ?? '',
    title: snapshot.title ?? '',
    elementCount: snapshot.elementCount ?? snapshot.refs?.length ?? 0,
    interactiveHash,
    textHash,
    scrollY: snapshot.scrollY ?? 0,
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
    scrollY: snapshot.scrollY ?? 0,
    pageHeight: snapshot.pageHeight ?? 1000,
    viewportHeight: snapshot.viewportHeight ?? 800,
    elementCount: snapshot.elementCount ?? snapshot.refs?.length ?? 0,
    refs: snapshot.refs ?? [],
    shownRefs: snapshot.shownRefs ?? snapshot.refs ?? [],
    elementsText: snapshot.elementsText ?? '',
    elementInfo: snapshot.elementInfo ?? {},
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

  return {
    page,
    perceiveError: null,
    history: [stepStartEntry],
  };
});

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
    } else if (!exit && (!softCapAsk || softCapReached)) {
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

  // Switch mode to harvest if in collect goal and budget warn/harvest
  if (state.siteIn?.site?.goalKind === 'collect' && (meterMode === 'harvest' || rawMode === 'end')) {
    mode = 'harvest';
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
    pendingHold
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
    browser: runtime.browser
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
  const siteRun = state.siteRun;
  const page = state.page;
  if (!siteIn || !siteRun || !page) throw new Error('Worker policy: missing state context');

  const mode = siteRun.mode ?? 'browse';
  const tier = siteIn.tier ?? 'small';
  const columns = siteIn.columns ?? [];
  const priceLike = siteIn.priceLike ?? false;
  const goalKind = siteIn.site?.goalKind ?? 'collect';

  const systemPrompt = buildPolicySystemPrompt(mode, tier, columns, priceLike, goalKind);
  const userMessage = buildPolicyUserMessage({
    task: siteIn.task,
    siteIndex: siteIn.index,
    totalSites: siteIn.total,
    domain: siteIn.site.domain,
    role: siteIn.site.role,
    goal: siteIn.site.goal,
    columns,
    usedSteps: siteRun.used,
    allocSteps: siteRun.alloc,
    meterMode: siteRun.meterMode,
    findingsLines: siteIn.findingsLines,
    failures: siteRun.failureMemory,
    bannedSignatures: siteRun.banned,
    diffLine: page.diffLine,
    pageTitle: page.title,
    pageUrl: page.url,
    pageType: page.pageType,
    scrollY: page.scrollY,
    pageText: page.pageText,
    elementsText: page.elementsText,
    priceCandidates: page.priceCandidates,
    correction: siteRun.strategyHint,
  });

  const schema = buildPolicySchema({ mode, tier, columns, priceLike, goalKind });
  const stepSignal = runtime.control.stepSignal();
  let replyText = '';

  try {
    const res = await runtime.llm.complete({
      node: 'policy',
      mode,
      role: 'policy',
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
      schema,
      signal: stepSignal,
    });
    replyText = res.text;
  } catch (err: any) {
    if (runtime.control.isUserAbort(err, stepSignal)) {
      return { lastDecision: { kind: 'aborted', mode } };
    }
    return {
      lastDecision: {
        kind: 'llm_failed',
        error: err.message ?? 'LLM request failed',
        mode,
      },
    };
  }

  let decision: any;
  const stateVerbs = ['record_finding', 'subgoal_done', 'continue_browsing', 'mark_not_found', 'mark_blocked'];

  // Check if reply matches a graph state action JSON
  const cleaned = replyText.replace(/<(?:think|thought|reasoning)>[\s\S]*?<\/(?:think|thought|reasoning)>/gi, '').trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i);
  let rawJson: any = null;
  try {
    if (fenceMatch) {
      rawJson = JSON.parse(fenceMatch[1]);
    } else {
      const objMatch = cleaned.match(/\{[\s\S]*\}/);
      if (objMatch) {
        rawJson = JSON.parse(objMatch[0]);
      }
    }
  } catch {}

  let thought = rawJson?.thought ?? '';
  let action: any = null;

  if (rawJson && stateVerbs.includes(rawJson.action)) {
    action = rawJson;
    decision = {
      kind: 'state',
      action,
      thought,
      mode,
      via: 'json',
    };
  } else {
    const parsed = parseModelReply(replyText, {
      verbs: ACTION_VERBS,
      refs: page.refs ? new Set(page.refs) : undefined,
    });
    thought = parsed.thought ?? thought;

    if (parsed.action) {
      action = parsed.action as any;
      const sig = `${action.action}|${action.element_id ?? ''}|${action.url ?? ''}`;

      // Enforce banned signatures
      if (isSignatureBanned(siteRun.banned ?? [], sig)) {
        decision = {
          kind: 'parse_error',
          error: `Action "${sig}" was previously tried and banned. You must choose a different action.`,
          mode,
          closeSite: false,
          modelUnusable: false,
        };
      } else if (action.action === 'ask_user') {
        decision = {
          kind: 'ask',
          question: action.question ?? 'The agent needs more information.',
          mode,
        };
      } else if (['click', 'type', 'scroll', 'navigate', 'go_back', 'go_forward', 'press_key', 'wait'].includes(action.action)) {
        decision = {
          kind: 'page',
          action,
          thought,
          mode,
          via: 'json',
        };
      } else {
        // State actions: finish, etc.
        decision = {
          kind: 'state',
          action,
          thought,
          mode,
          via: 'json',
        };
      }
    } else {
      decision = {
        kind: 'parse_error',
        error: parsed.error ?? 'Unrecognized action format',
        mode,
        closeSite: false,
        modelUnusable: false,
      };
    }
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

  const evalResult = evaluateActionRisk({
    action,
    elementInfo,
    pageType: state.page?.pageType,
    pageUrl: state.page?.url,
    approvedDomains: [currentDomain, ...approvedDomains],
  });
  const signature = `${action.action}|${action.element_id ?? ''}|${action.url ?? ''}`;

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

  return {
    lastExec: {
      step: (state.siteRun?.used ?? 0) + 1,
      action: pending.action,
      signature: pending.signature,
      sigBefore: state.page!.sig,
      result,
      discarded: false,
    },
    history: [execResultEntry],
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
      if (effect !== 'value_set' && effect !== 'dom_changed') outcome = 'failed';
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

const recordNode = defineNode<WorkerStateT, Partial<WorkerUpdate>>('worker', 'record', (state) => {
  if (state.lastDecision?.kind !== 'state') return {};
  const action = state.lastDecision.action as any;
  const siteRun = state.siteRun;
  const siteIn = state.siteIn;
  const page = state.page;
  if (!siteRun || !siteIn || !page) return {};

  // 1. finish
  if (action.action === 'finish') {
    return {
      siteRun: {
        ...siteRun,
        criteriaMet: true,
        exit: { status: 'done', reason: action.answer || 'Goal achieved' },
        finalAnswer: { text: action.answer, unconfirmed: false, table: null, partial: false },
      },
    };
  }

  // 2. record_finding
  if (action.action === 'record_finding') {
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
    let anyRecorded = false;

    for (const col of keysToCheck) {
      const rawVal = vals[col];
      if (rawVal && typeof rawVal === 'string' && rawVal.toLowerCase() !== 'not shown') {
        const finding = createFinding({
          siteId: siteIn.site.id,
          field: col,
          rawValue: rawVal,
          url: page.url,
          title: page.title,
          docId: page.docId,
          step: (siteRun.used ?? 0) + 1,
          capturedAt: Date.now(),
          pageText: page.pageText,
          domain: siteIn.site.domain
        });
        if (finding) {
          currentFindings = deduplicateFindings(currentFindings, finding);
          anyRecorded = true;
        }
      }
    }

    const criteriaRes = evaluateSiteCriteria(siteIn.site, currentFindings);
    const exit = criteriaRes.met ? { status: 'done' as const, reason: criteriaRes.reason } : siteRun.exit;

    return {
      siteRun: {
        ...siteRun,
        used: (siteRun.used ?? 0) + 1,
        findings: currentFindings,
        criteriaMet: criteriaRes.met,
        lastProgressStep: anyRecorded ? (siteRun.used ?? 0) + 1 : siteRun.lastProgressStep,
        exit
      }
    };
  }

  // 3. subgoal_done
  if (action.action === 'subgoal_done') {
    const criteriaRes = evaluateSiteCriteria(siteIn.site, siteRun.findings ?? [], {
      url: page.url,
      pageText: page.pageText,
      elementTexts: [page.elementsText]
    });
    return {
      siteRun: {
        ...siteRun,
        used: (siteRun.used ?? 0) + 1,
        criteriaMet: criteriaRes.met,
        exit: { status: criteriaRes.status, reason: action.summary || criteriaRes.reason }
      }
    };
  }

  // 4. continue_browsing
  if (action.action === 'continue_browsing') {
    return {
      siteRun: {
        ...siteRun,
        used: (siteRun.used ?? 0) + 1,
        mode: 'browse'
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
