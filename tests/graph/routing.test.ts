import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ORCHESTRATOR_ROUTE_MAPS,
  WORKER_ROUTE_MAPS,
  planRouter,
  holdRouter,
  schedRouter,
  summaryRouter,
  reflectRouter,
  compileRouter,
  meterRouter,
  blockedRouter,
  policyRouter,
  riskRouter,
  workerHoldRouter,
  verifyRouter,
  recoverRouter,
  recordRouter,
} from '../../src/background/graph/routes.ts';
import type { AgentStateT } from '../../src/background/graph/state.ts';
import type { WorkerStateT } from '../../src/background/graph/workerState.ts';

test('routes: orchestrator planRouter handles stop, pause, initial, and revise', () => {
  const base: Partial<AgentStateT> = { ctl: { stopRequested: false, pauseRequested: false } };

  // Stop branch
  assert.equal(planRouter({ ...base, ctl: { stopRequested: true, pauseRequested: false } } as AgentStateT), 'finalize');

  // Pause branch
  assert.equal(planRouter({ ...base, ctl: { stopRequested: false, pauseRequested: true } } as AgentStateT), 'hold');

  // LLM failure
  assert.equal(planRouter({ ...base, lastDecision: { kind: 'llm_failed', error: 'err', node: 'plan' } } as AgentStateT), 'hold');

  // Initial plan ready
  assert.equal(planRouter({ ...base, plan: { version: 1 } as any } as AgentStateT), 'hold');

  // Revise without new domain
  assert.equal(
    planRouter({
      ...base,
      planPrev: { version: 1 } as any,
      plan: { version: 2, sites: [{ domain: 'example.com' }] } as any,
      approvedDomains: ['example.com'],
    } as AgentStateT),
    'alloc',
  );

  // Revise with new domain
  assert.equal(
    planRouter({
      ...base,
      planPrev: { version: 1 } as any,
      plan: { version: 2, sites: [{ domain: 'new-site.com' }] } as any,
      approvedDomains: ['example.com'],
    } as AgentStateT),
    'hold',
  );
});

test('routes: orchestrator holdRouter routes by resumeRoute', () => {
  assert.equal(holdRouter({ resumeRoute: 'alloc' } as AgentStateT), 'alloc');
  assert.equal(holdRouter({ resumeRoute: 'plan' } as AgentStateT), 'plan');
  assert.equal(holdRouter({ resumeRoute: 'sched' } as AgentStateT), 'sched');
  assert.equal(holdRouter({ resumeRoute: 'reflect' } as AgentStateT), 'reflect');
  assert.equal(holdRouter({ resumeRoute: 'compile' } as AgentStateT), 'compile');
  assert.equal(holdRouter({ resumeRoute: 'finalize' } as AgentStateT), 'finalize');
  assert.equal(holdRouter({ ctl: { stopRequested: true } } as AgentStateT), 'finalize');
});

test('routes: orchestrator schedRouter routes to site, compile, or hold', () => {
  const base = {
    ctl: { stopRequested: false, pauseRequested: false },
    limits: { maxSteps: 250 },
    budget: { used: 10, reserve: 15 },
    sites: { s1: { status: 'pending' } },
  } as any;

  assert.equal(schedRouter(base), 'site');

  // Budget exhausted
  assert.equal(schedRouter({ ...base, budget: { used: 240, reserve: 15 } }), 'compile');

  // No pending site left
  assert.equal(schedRouter({ ...base, sites: { s1: { status: 'done' } } }), 'compile');

  // Pause
  assert.equal(schedRouter({ ...base, ctl: { pauseRequested: true } }), 'hold');

  // Stop
  assert.equal(schedRouter({ ...base, ctl: { stopRequested: true } }), 'finalize');
});

test('routes: orchestrator summaryRouter routes to finalize on stop, else reflect', () => {
  assert.equal(summaryRouter({ ctl: { stopRequested: true } } as AgentStateT), 'finalize');
  assert.equal(summaryRouter({ siteOut: { status: 'stopped' } } as any), 'finalize');
  assert.equal(summaryRouter({ siteOut: { status: 'done' } } as any), 'reflect');
});

test('routes: orchestrator reflectRouter routes continue, replan, stop_early', () => {
  const base = {
    ctl: { stopRequested: false, pauseRequested: false },
    reflectResult: { decision: 'continue' },
  } as any;

  assert.equal(reflectRouter(base), 'sched');

  // Stop early
  assert.equal(reflectRouter({ ...base, reflectResult: { decision: 'stop_early' } }), 'compile');

  // Valid replan
  assert.equal(
    reflectRouter({
      ...base,
      reflectResult: { decision: 'replan' },
      replan: { count: 0 },
      profile: { maxReplans: 2 },
      budget: { reserve: 10 },
    }),
    'plan',
  );

  // Invalid replan (cap reached) falls back to continue
  assert.equal(
    reflectRouter({
      ...base,
      reflectResult: { decision: 'replan' },
      replan: { count: 2 },
      profile: { maxReplans: 2 },
      budget: { reserve: 10 },
    }),
    'sched',
  );
});

test('routes: orchestrator compileRouter escalates partial or stuck to offer, else finalize', () => {
  assert.equal(compileRouter({ siteSummaries: [{ status: 'done' }] } as any), 'finalize');
  assert.equal(compileRouter({ siteSummaries: [{ status: 'partial' }] } as any), 'offer');
  assert.equal(compileRouter({ siteSummaries: [{ status: 'stuck' }] } as any), 'offer');
});

test('routes: worker routers route correctly and match route maps', () => {
  const base: Partial<WorkerStateT> = { ctl: { stopRequested: false, pauseRequested: false } };

  // meterRouter
  assert.equal(meterRouter({ ...base, ctl: { stopRequested: true } } as any), 'end_stopped');
  assert.equal(meterRouter({ ...base, ctl: { pauseRequested: true } } as any), 'hold');
  assert.equal(meterRouter({ ...base, perceiveError: { terminal: true } } as any), 'end_failed');
  assert.equal(meterRouter({ ...base, page: { verdict: 'challenge' } } as any), 'blocked');
  assert.equal(meterRouter({ ...base, page: { verdict: 'ok' }, siteRun: { alloc: 10, used: 2 } } as any), 'policy');

  // policyRouter
  assert.equal(policyRouter({ ...base, lastDecision: { kind: 'page' } } as any), 'risk');
  assert.equal(policyRouter({ ...base, lastDecision: { kind: 'state' } } as any), 'record');
  assert.equal(policyRouter({ ...base, lastDecision: { kind: 'ask' } } as any), 'hold');
  assert.equal(policyRouter({ ...base, lastDecision: { kind: 'parse_error', modelUnusable: true } } as any), 'end_failed');
  assert.equal(policyRouter({ ...base, lastDecision: { kind: 'parse_error', modelUnusable: false } } as any), 'perceive');

  // riskRouter
  assert.equal(riskRouter({ ...base, siteRun: { pendingAction: { risk: { level: 'safe' } } } } as any), 'execute');
  assert.equal(riskRouter({ ...base, siteRun: { pendingAction: { risk: { level: 'risky' } } } } as any), 'hold');
  assert.equal(riskRouter({ ...base, siteRun: { pendingAction: { risk: { level: 'forbidden' } } } } as any), 'recover');

  // verifyRouter
  assert.equal(verifyRouter({ ...base, verifyResult: { outcome: 'ok' } } as any), 'perceive');
  assert.equal(verifyRouter({ ...base, verifyResult: { outcome: 'failed' } } as any), 'recover');
  assert.equal(verifyRouter({ ...base, verifyResult: { outcome: 'stuck' }, siteRun: { stuckLevel: 3 } } as any), 'recover');

  // recoverRouter
  assert.equal(recoverRouter({ ...base, siteRun: { stuckLevel: 3 } } as any), 'end_stuck');
  assert.equal(recoverRouter({ ...base, siteRun: { stuckLevel: 2 } } as any), 'end_partial');
  assert.equal(recoverRouter({ ...base, siteRun: { stuckLevel: 1 } } as any), 'perceive');

  // recordRouter
  assert.equal(recordRouter({ ...base, siteRun: { criteriaMet: true } } as any), 'end_done');
  assert.equal(recordRouter({ ...base, siteRun: { exit: { status: 'not_found' } } } as any), 'end_not_found');
  assert.equal(recordRouter({ ...base, siteRun: { criteriaMet: false } } as any), 'perceive');
});

test('routes: every router return value is declared in its corresponding route map', () => {
  // Check orchestrator map keys
  assert.ok('finalize' in ORCHESTRATOR_ROUTE_MAPS.plan);
  assert.ok('hold' in ORCHESTRATOR_ROUTE_MAPS.plan);
  assert.ok('alloc' in ORCHESTRATOR_ROUTE_MAPS.plan);

  assert.ok('site' in ORCHESTRATOR_ROUTE_MAPS.sched);
  assert.ok('compile' in ORCHESTRATOR_ROUTE_MAPS.sched);

  // Check worker map keys
  assert.ok('end_stopped' in WORKER_ROUTE_MAPS.meter);
  assert.ok('policy' in WORKER_ROUTE_MAPS.meter);
  assert.ok('risk' in WORKER_ROUTE_MAPS.policy);
  assert.ok('record' in WORKER_ROUTE_MAPS.policy);
});
