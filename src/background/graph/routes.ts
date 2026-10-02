// src/background/graph/routes.ts
// Pure router functions and declared route maps for the Orchestrator and Worker graphs.
// Every addConditionalEdges call specifies its declared route map so compiledGraph.getGraph()
// can inspect all edges statically.
import { END } from '@langchain/langgraph/web';
import type { AgentStateT } from './state.ts';
import type { WorkerStateT } from './workerState.ts';

// ---------------------------------------------------------------------------------------------
// Orchestrator Route Maps & Routers
// ---------------------------------------------------------------------------------------------

export const ORCHESTRATOR_ROUTE_MAPS = {
  plan: {
    finalize: 'finalize',
    hold: 'hold',
    alloc: 'alloc',
  },
  hold: {
    alloc: 'alloc',
    plan: 'plan',
    sched: 'sched',
    reflect: 'reflect',
    compile: 'compile',
    finalize: 'finalize',
  },
  sched: {
    finalize: 'finalize',
    hold: 'hold',
    compile: 'compile',
    site: 'site',
  },
  summary: {
    finalize: 'finalize',
    reflect: 'reflect',
  },
  reflect: {
    finalize: 'finalize',
    hold: 'hold',
    plan: 'plan',
    compile: 'compile',
    sched: 'sched',
  },
  compile: {
    offer: 'offer',
    finalize: 'finalize',
  },
} as const;

export function planRouter(state: AgentStateT): keyof typeof ORCHESTRATOR_ROUTE_MAPS.plan {
  if (state.ctl?.stopRequested) return 'finalize';
  if (state.ctl?.pauseRequested || state.lastDecision?.kind === 'llm_failed') return 'hold';

  const plan = state.planMeta ?? (state as any).plan;
  // Initial plan vs revise
  if (!state.planPrev || plan?.version === 1) {
    return 'hold'; // approve_plan
  }

  // Revise mode
  const addedDomain = plan?.sites?.some(
    (s: any) => !state.approvedDomains?.includes(s.domain),
  );
  if (addedDomain) {
    return 'hold';
  }
  return 'alloc';
}

export function holdRouter(state: AgentStateT): keyof typeof ORCHESTRATOR_ROUTE_MAPS.hold {
  if (state.ctl?.stopRequested) return 'finalize';
  if (state.resumeRoute) {
    return state.resumeRoute;
  }
  return 'finalize';
}

export function schedRouter(state: AgentStateT): keyof typeof ORCHESTRATOR_ROUTE_MAPS.sched {
  if (state.ctl?.stopRequested) return 'finalize';
  if (state.ctl?.pauseRequested) return 'hold';

  const hardCap = state.limits?.maxSteps ?? 250;
  const used = state.budget?.used ?? 0;
  const reserve = state.budget?.reserve ?? 0;
  const usableBudget = hardCap - used - reserve;

  if (usableBudget <= 0) {
    return 'compile';
  }

  const hasPendingSite = Object.values(state.sites ?? {}).some(
    (s) => s.status === 'pending',
  );

  if (!hasPendingSite && !state.siteIn) {
    return 'compile';
  }

  if (state.siteIn === null) {
    return 'compile';
  }

  return 'site';
}

export function summaryRouter(state: AgentStateT): keyof typeof ORCHESTRATOR_ROUTE_MAPS.summary {
  if (state.ctl?.stopRequested || state.siteOut?.status === 'stopped') {
    return 'finalize';
  }
  return 'reflect';
}

export function reflectRouter(state: AgentStateT): keyof typeof ORCHESTRATOR_ROUTE_MAPS.reflect {
  if (state.ctl?.stopRequested) return 'finalize';
  if (state.ctl?.pauseRequested || state.lastDecision?.kind === 'llm_failed') return 'hold';

  const decision = state.reflectResult?.decision ?? 'continue';
  if (decision === 'replan') {
    const replanCount = state.replan?.count ?? 0;
    const profile = state.effortProfile ?? (state as any).profile;
    const maxReplans = profile?.maxReplans ?? 0;
    const reserve = state.budget?.reserve ?? 0;
    if (replanCount < maxReplans && reserve > 0) {
      return 'plan';
    }
    return 'sched'; // Turn invalid replan into continue
  }

  if (decision === 'stop_early') {
    return 'compile';
  }

  return 'sched';
}

export function compileRouter(state: AgentStateT): keyof typeof ORCHESTRATOR_ROUTE_MAPS.compile {
  const summaries = state.siteSummaries ?? [];
  const sites = Object.values(state.sites ?? {});
  const hasPartialOrStuck =
    summaries.some((s) => s.status === 'partial' || s.status === 'stuck') ||
    sites.some((s) => s.status === 'partial' || s.status === 'stuck');

  return hasPartialOrStuck ? 'offer' : 'finalize';
}

// ---------------------------------------------------------------------------------------------
// Worker Route Maps & Routers
// ---------------------------------------------------------------------------------------------

export const WORKER_ROUTE_MAPS = {
  meter: {
    end_stopped: END,
    hold: 'hold',
    end_failed: END,
    perceive: 'perceive',
    blocked: 'blocked',
    end_partial: END,
    policy: 'policy',
  },
  blocked: {
    end_stopped: END,
    hold: 'hold',
    perceive: 'perceive',
    end_blocked: END,
  },
  policy: {
    end_stopped: END,
    hold: 'hold',
    end_failed: END,
    perceive: 'perceive',
    risk: 'risk',
    record: 'record',
  },
  risk: {
    end_stopped: END,
    hold: 'hold',
    execute: 'execute',
    recover: 'recover',
  },
  hold: {
    end_stopped: END,
    execute: 'execute',
    recover: 'recover',
    perceive: 'perceive',
  },
  verify: {
    end_stopped: END,
    hold: 'hold',
    perceive: 'perceive',
    recover: 'recover',
    end_stuck: END,
  },
  recover: {
    end_stopped: END,
    hold: 'hold',
    end_partial: END,
    perceive: 'perceive',
  },
  record: {
    end_stopped: END,
    hold: 'hold',
    end_done: END,
    end_not_found: END,
    end_blocked: END,
    end_unverified: END,
    perceive: 'perceive',
  },
} as const;

export function meterRouter(state: WorkerStateT): keyof typeof WORKER_ROUTE_MAPS.meter {
  if (state.ctl?.stopRequested) return 'end_stopped';
  if (state.ctl?.pauseRequested) return 'hold';

  if (state.perceiveError) {
    if (state.perceiveError.terminal) return 'end_failed';
    if (state.perceiveError.tries < 3) return 'perceive';
    return 'end_failed';
  }

  const verdict = state.page?.verdict;
  if (verdict === 'challenge' || verdict === 'error_page') {
    return 'blocked';
  }

  const alloc = state.siteRun?.alloc ?? 10;
  const used = state.siteRun?.used ?? 0;
  if (alloc > 0 && used >= Math.floor(alloc * 0.95)) {
    return 'end_partial';
  }

  return 'policy';
}

export function blockedRouter(state: WorkerStateT): keyof typeof WORKER_ROUTE_MAPS.blocked {
  if (state.ctl?.stopRequested) return 'end_stopped';
  if (state.ctl?.pauseRequested) return 'hold';

  const hits = state.siteRun?.blockedHits ?? 0;
  if (hits >= 3) {
    return 'end_blocked';
  }
  return 'perceive';
}

export function policyRouter(state: WorkerStateT): keyof typeof WORKER_ROUTE_MAPS.policy {
  if (state.ctl?.stopRequested) return 'end_stopped';
  if (state.ctl?.pauseRequested) return 'hold';

  const decision = state.lastDecision;
  if (!decision) return 'perceive';

  if (decision.kind === 'ask' || decision.kind === 'llm_failed') {
    return 'hold';
  }
  if (decision.kind === 'parse_error') {
    if (decision.modelUnusable || decision.closeSite) {
      return 'end_failed';
    }
    return 'perceive';
  }
  if (decision.kind === 'aborted' || decision.kind === 'stale_page') {
    return 'perceive';
  }
  if (decision.kind === 'page') {
    return 'risk';
  }
  if (decision.kind === 'state') {
    return 'record';
  }
  return 'perceive';
}

export function riskRouter(state: WorkerStateT): keyof typeof WORKER_ROUTE_MAPS.risk {
  if (state.ctl?.stopRequested) return 'end_stopped';
  if (state.ctl?.pauseRequested) return 'hold';

  const pending = state.siteRun?.pendingAction;
  if (pending?.risk?.level === 'risky') {
    return 'hold';
  }
  if (pending?.risk?.level === 'forbidden') {
    return 'recover';
  }
  return 'execute';
}

export function workerHoldRouter(state: WorkerStateT): keyof typeof WORKER_ROUTE_MAPS.hold {
  if (state.ctl?.stopRequested) return 'end_stopped';
  const route = state.resumeRoute;
  if (route === 'execute') return 'execute';
  if (route === 'recover') return 'recover';
  if (route === 'end') return 'end_stopped';
  return 'perceive';
}

export function verifyRouter(state: WorkerStateT): keyof typeof WORKER_ROUTE_MAPS.verify {
  if (state.ctl?.stopRequested) return 'end_stopped';
  if (state.ctl?.pauseRequested) return 'hold';

  const result = state.verifyResult;
  if (!result || result.outcome === 'ok') {
    return 'perceive';
  }
  if (result.outcome === 'stuck') {
    const level = state.siteRun?.stuckLevel ?? 0;
    if (level >= 3) {
      return 'end_stuck';
    }
    return 'recover';
  }
  return 'recover';
}

export function recoverRouter(state: WorkerStateT): keyof typeof WORKER_ROUTE_MAPS.recover {
  if (state.ctl?.stopRequested) return 'end_stopped';
  if (state.ctl?.pauseRequested) return 'hold';

  const stuckLevel = state.siteRun?.stuckLevel ?? 0;
  if (stuckLevel >= 2) {
    return 'end_partial';
  }
  return 'perceive';
}

export function recordRouter(state: WorkerStateT): keyof typeof WORKER_ROUTE_MAPS.record {
  if (state.ctl?.stopRequested) return 'end_stopped';
  if (state.ctl?.pauseRequested) return 'hold';

  const exit = state.siteRun?.exit;
  if (exit) {
    if (exit.status === 'done') return 'end_done';
    if (exit.status === 'not_found') return 'end_not_found';
    if (exit.status === 'blocked') return 'end_blocked';
    if (exit.status === 'unverified') return 'end_unverified';
  }

  if (state.siteRun?.criteriaMet) {
    return 'end_done';
  }

  return 'perceive';
}
