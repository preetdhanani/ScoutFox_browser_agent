// src/background/graph/worker.ts
// Site worker subgraph: isolated context for browsing a single site.
// Communicates with orchestrator strictly via SiteIn (input) and SiteOut (output).
import { END, START, StateGraph } from '@langchain/langgraph/web';
import { WorkerState, type SiteOut, type WorkerStateT, type WorkerUpdate } from './workerState.ts';
import { WORKER_ROUTE_MAPS, meterRouter, blockedRouter, policyRouter, riskRouter, workerHoldRouter, verifyRouter, recoverRouter, recordRouter } from './routes.ts';
import { defineNode, getRuntime } from '../runner/runtimeRegistry.ts';
import { interruptWithConfig } from './interrupt.ts';
import { parseModelReply } from '../agent/parse.ts';
import { ACTION_VERBS } from '../agent/actions.ts';
import type { HistoryEntry } from './state.ts';

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

  const initialSiteRun = {
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

  let snapshot: any = null;
  try {
    snapshot = await runtime.browser.snapshot(tabId, { showBadges: true, maxElements: 120 });
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
    pageText: snapshot.pageText ?? '',
    verdict: 'ok' as const,
    verdictReason: null,
    pageType: 'listing' as const,
    sig: {
      url: snapshot.url ?? '',
      title: snapshot.title ?? '',
      elementCount: snapshot.elementCount ?? 0,
      interactiveHash: '',
      textHash: '',
      scrollY: snapshot.scrollY ?? 0,
      pageType: 'listing' as const,
    },
    diffLine: null,
    priceHits: 0,
    priceCandidates: [],
    consentHint: null,
    hash: 'hash-1',
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
  return {};
});

const blockedNode = defineNode<WorkerStateT, Partial<WorkerUpdate>>('worker', 'blocked', (state) => {
  const currentHits = state.siteRun?.blockedHits ?? 0;
  return {
    siteRun: state.siteRun
      ? { ...state.siteRun, blockedHits: currentHits + 1 }
      : null,
  };
});

const policyNode = defineNode<WorkerStateT, Partial<WorkerUpdate>>('worker', 'policy', async (state, config) => {
  const runtime = getRuntime(config);
  const promptText = `Task: ${state.siteIn?.task}\nPage: ${state.page?.url}\nElements:\n${state.page?.elementsText ?? ''}`;

  let replyText = '';
  try {
    const res = await runtime.llm.complete({
      node: 'policy',
      mode: state.siteRun?.mode ?? 'browse',
      role: 'policy',
      system: 'You are a browser automation agent. Choose the next action as JSON.',
      messages: [{ role: 'user', content: promptText }],
      schema: null,
      signal: runtime.control.stepSignal(),
    });
    replyText = res.text;
  } catch (err: any) {
    if (runtime.control.isUserAbort(err, runtime.control.stepSignal())) {
      return { lastDecision: { kind: 'aborted', mode: state.siteRun?.mode ?? 'browse' } };
    }
    return {
      lastDecision: {
        kind: 'llm_failed',
        error: err.message ?? 'LLM request failed',
        mode: state.siteRun?.mode ?? 'browse',
      },
    };
  }

  const parsed = parseModelReply(replyText, {
    verbs: ACTION_VERBS,
    refs: state.page?.refs ? new Set(state.page.refs) : undefined,
  });
  let decision: any;

  if (parsed.action) {
    const action = parsed.action as any;
    if (action.action === 'ask_user') {
      decision = {
        kind: 'ask',
        question: action.question ?? 'The agent needs more information.',
        mode: state.siteRun?.mode ?? 'browse',
      };
    } else if (['click', 'type', 'scroll', 'navigate', 'go_back', 'go_forward', 'press_key', 'wait'].includes(action.action)) {
      decision = {
        kind: 'page',
        action,
        thought: parsed.thought ?? '',
        mode: state.siteRun?.mode ?? 'browse',
        via: 'json',
      };
    } else {
      decision = {
        kind: 'state',
        action,
        thought: parsed.thought ?? '',
        mode: state.siteRun?.mode ?? 'browse',
        via: 'json',
      };
    }
  } else {
    decision = {
      kind: 'parse_error',
      error: parsed.error ?? 'Unrecognized action format',
      mode: state.siteRun?.mode ?? 'browse',
      closeSite: false,
      modelUnusable: false,
    };
  }

  const responseEntry: HistoryEntry = {
    type: 'agent_response',
    step: (state.siteRun?.used ?? 0) + 1,
    thought: parsed.thought ?? '',
    action: parsed.action as any ?? null,
    rawResponse: replyText,
    mode: state.siteRun?.mode ?? 'browse',
  };

  return {
    lastDecision: decision,
    history: [responseEntry],
  };
});

const riskNode = defineNode<WorkerStateT, Partial<WorkerUpdate>>('worker', 'risk', (state) => {
  if (state.lastDecision?.kind !== 'page') return {};
  const action = state.lastDecision.action;

  const pendingAction = {
    action,
    signature: `${action.action}|${(action as any).element_id ?? ''}|${(action as any).url ?? ''}`,
    journalKey: `${state.siteIn?.runId}:${(state.siteRun?.used ?? 0) + 1}`,
    risk: { level: 'safe' as const, reason: 'Allowed by default in P4' },
  };

  return {
    siteRun: state.siteRun
      ? { ...state.siteRun, pendingAction }
      : null,
  };
});

const holdNode = defineNode<WorkerStateT, Partial<WorkerUpdate>>('worker', 'hold', (state, config) => {
  const resume = interruptWithConfig<any, any>(config, state.pendingHold ?? { kind: 'paused', reason: 'user' });

  if (resume?.kind === 'approve') {
    return { resumeRoute: 'execute' };
  }
  if (resume?.kind === 'reject') {
    return { resumeRoute: 'recover' };
  }
  if (resume?.kind === 'stop') {
    return { resumeRoute: 'end' };
  }
  return { resumeRoute: 'perceive' };
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
  const outcome = success ? 'ok' : 'failed';

  const used = (state.siteRun?.used ?? 0) + 1;
  const verifyResult = {
    outcome: outcome as any,
    goal: 'closer' as const,
    detail: success ? 'Action succeeded' : 'Action had no effect or failed',
  };

  return {
    verifyResult,
    siteRun: state.siteRun
      ? { ...state.siteRun, used }
      : null,
  };
});

const recoverNode = defineNode<WorkerStateT, Partial<WorkerUpdate>>('worker', 'recover', (state) => {
  return {};
});

const recordNode = defineNode<WorkerStateT, Partial<WorkerUpdate>>('worker', 'record', (state) => {
  if (state.lastDecision?.kind !== 'state') return {};
  const action = state.lastDecision.action;

  if (action.action === 'finish') {
    return {
      siteRun: state.siteRun
        ? {
            ...state.siteRun,
            criteriaMet: true,
            exit: { status: 'done', reason: action.answer || 'Goal achieved' },
            finalAnswer: { text: action.answer, unconfirmed: false, table: null, partial: false },
          }
        : null,
    };
  }

  if (action.action === 'mark_not_found') {
    return {
      siteRun: state.siteRun
        ? { ...state.siteRun, exit: { status: 'not_found', reason: action.reason } }
        : null,
    };
  }

  if (action.action === 'mark_blocked') {
    return {
      siteRun: state.siteRun
        ? { ...state.siteRun, exit: { status: 'blocked', reason: action.reason } }
        : null,
    };
  }

  return {};
});

// ---------------------------------------------------------------------------------------------
// Worker Subgraph Builder
// ---------------------------------------------------------------------------------------------

export function buildWorkerGraph() {
  return new StateGraph(WorkerState)
    .addNode('open', openNode)
    .addNode('perceive', perceiveNode)
    .addNode('meter', meterNode)
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
    .addConditionalEdges('blocked', blockedRouter, WORKER_ROUTE_MAPS.blocked)
    .addConditionalEdges('policy', policyRouter, WORKER_ROUTE_MAPS.policy)
    .addConditionalEdges('risk', riskRouter, WORKER_ROUTE_MAPS.risk)
    .addConditionalEdges('hold', workerHoldRouter, WORKER_ROUTE_MAPS.hold)
    .addEdge('execute', 'verify')
    .addConditionalEdges('verify', verifyRouter, WORKER_ROUTE_MAPS.verify)
    .addConditionalEdges('recover', recoverRouter, WORKER_ROUTE_MAPS.recover)
    .addConditionalEdges('record', recordRouter, WORKER_ROUTE_MAPS.record)
    .compile();
}
