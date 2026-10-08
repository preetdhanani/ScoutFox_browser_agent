import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeChrome } from '../helpers/fakeChrome.ts';
import { createFakeStorage } from '../helpers/fakeStorageSession.ts';
import { fakeDom, link } from '../helpers/fakeDom.ts';
import { AgentRunner } from '../../src/background/runner/AgentRunner.ts';

function setupEnvironment() {
  const store = createFakeStorage({
    local: {
      data: {
        agent_settings: {
          provider: 'openrouter',
          baseUrl: 'https://openrouter.ai/api/v1',
          model: 'test-model',
          maxSteps: 5,
          actionDelayMs: 1,
        },
      },
    },
  });

  const fc = fakeChrome({
    tabs: { list: [{ id: 101, windowId: 1, url: 'https://test.local' }] },
    tabGroups: true,
    storage: store,
    dom: true,
  });

  const restoreChrome = fc.install();

  return {
    store,
    fc,
    cleanup: () => {
      restoreChrome();
    },
  };
}

test('AgentRunner - LangGraph state fields: findings, pendingApproval, pendingConfirm, graphLocation', async (t) => {
  const env = setupEnvironment();
  t.after(env.cleanup);

  const runner = new AgentRunner(101, 1);
  await runner.restorePromise;

  assert.equal(runner.autoApprovePlan, true, 'autoApprovePlan should default to true for test runner');
  assert.deepEqual(runner.findings, [], 'findings should default to empty array');
  assert.equal(runner.pendingApproval, null, 'pendingApproval should default to null');
  assert.equal(runner.pendingConfirm, null, 'pendingConfirm should default to null');
  assert.equal(runner.graphLocation.phase, 'Starting', 'graphLocation.phase should default to Starting');

  // Verify getState includes all fields
  const state = runner.getState();
  assert.deepEqual(state.findings, []);
  assert.equal(state.pendingApproval, null);
  assert.equal(state.pendingConfirm, null);
  assert.deepEqual(state.graphLocation, { phase: 'Starting' });

  // Simulate findings update
  runner.findings = [{ id: 'f1', field: 'price', value: '$100' }];
  const updatedState = runner.getState();
  assert.equal(updatedState.findings.length, 1);
  assert.equal(updatedState.findings[0].value, '$100');

  // Clear history resets findings
  runner.clearHistory();
  assert.deepEqual(runner.findings, [], 'clearHistory should reset findings');
  assert.equal(runner.getState().findings.length, 0);

  runner.dispose();
});

test('AgentRunner - approvePlan clears pendingApproval and drives graph', async (t) => {
  const env = setupEnvironment();
  t.after(env.cleanup);

  const runner = new AgentRunner(101, 1);
  await runner.restorePromise;

  // Set pending approval
  runner.status = 'paused';
  runner.pendingApproval = {
    kind: 'approve_plan',
    planMeta: { version: 1, sites: [], columns: [] },
  };

  let drivenInput: any = null;
  (runner as any).drive = async (cmd: any) => {
    drivenInput = cmd;
  };

  await runner.approvePlan({ level: 'high' });

  assert.equal(runner.pendingApproval, null, 'approvePlan should clear pendingApproval');
  assert.equal(runner.status, 'running', 'approvePlan should set status to running');
  assert.ok(drivenInput, 'Should call drive with Command');
  assert.equal(drivenInput?.resume?.kind, 'approve');

  runner.dispose();
});

test('AgentRunner - confirmAction clears pendingConfirm and drives graph with decision', async (t) => {
  const env = setupEnvironment();
  t.after(env.cleanup);

  const runner = new AgentRunner(101, 1);
  await runner.restorePromise;

  // Test approve decision with remember domain
  runner.status = 'paused';
  runner.pendingConfirm = {
    kind: 'confirm_action',
    variant: 'purchase',
    targetDomain: 'shop.test',
  };

  let drivenInput: any = null;
  (runner as any).drive = async (cmd: any) => {
    drivenInput = cmd;
  };

  await runner.confirmAction('approve', 'site');

  assert.equal(runner.pendingConfirm, null, 'confirmAction should clear pendingConfirm');
  assert.equal(runner.status, 'running');
  assert.equal(drivenInput?.resume?.kind, 'approve');
  assert.equal(drivenInput?.resume?.remember, 'site');

  // Test reject decision
  runner.status = 'paused';
  runner.pendingConfirm = {
    kind: 'confirm_action',
    variant: 'navigate',
  };

  await runner.confirmAction('reject');

  assert.equal(runner.pendingConfirm, null, 'confirmAction should clear pendingConfirm on reject');
  assert.equal(runner.status, 'running');
  assert.equal(drivenInput?.resume?.kind, 'reject');

  runner.dispose();
});

test('AgentRunner - resolveChallenge clears pendingChallengeHelp and drives graph with decision', async (t) => {
  const env = setupEnvironment();
  t.after(env.cleanup);

  const runner = new AgentRunner(101, 1);
  await runner.restorePromise;

  // Test resolved decision
  runner.status = 'paused';
  runner.pendingChallengeHelp = {
    kind: 'challenge_help',
    domain: 'shop.test',
    url: 'https://shop.test/captcha',
    reason: 'Cloudflare challenge',
  };

  let drivenInput: any = null;
  (runner as any).drive = async (cmd: any) => {
    drivenInput = cmd;
  };

  await runner.resolveChallenge('resolved');

  assert.equal(runner.pendingChallengeHelp, null, 'resolveChallenge should clear pendingChallengeHelp');
  assert.equal(runner.status, 'running');
  assert.equal(drivenInput?.resume?.kind, 'resolved');

  // Test skip decision
  runner.status = 'paused';
  runner.pendingChallengeHelp = {
    kind: 'challenge_help',
    domain: 'shop.test',
  };

  await runner.resolveChallenge('skip');

  assert.equal(runner.pendingChallengeHelp, null, 'resolveChallenge should clear pendingChallengeHelp on skip');
  assert.equal(runner.status, 'running');
  assert.equal(drivenInput?.resume?.kind, 'skip');

  runner.dispose();
});

test('AgentRunner - continueBudget clears pendingContinueBudget and drives graph with decision', async (t) => {
  const env = setupEnvironment();
  t.after(env.cleanup);

  const runner = new AgentRunner(101, 1);
  await runner.restorePromise;

  // Test continue decision with additional steps
  runner.status = 'paused';
  runner.pendingContinueBudget = {
    kind: 'continue_budget',
    domain: 'shop.test',
    stepsUsed: 25,
    reserveBudget: 10,
  };

  let drivenInput: any = null;
  (runner as any).drive = async (cmd: any) => {
    drivenInput = cmd;
  };

  await runner.continueBudget('continue', 10);

  assert.equal(runner.pendingContinueBudget, null, 'continueBudget should clear pendingContinueBudget');
  assert.equal(runner.status, 'running');
  assert.equal(drivenInput?.resume?.kind, 'continue');
  assert.equal(drivenInput?.resume?.additionalSteps, 10);

  // Test finish decision
  runner.status = 'paused';
  runner.pendingContinueBudget = {
    kind: 'continue_budget',
    domain: 'shop.test',
    stepsUsed: 25,
  };

  await runner.continueBudget('finish');

  assert.equal(runner.pendingContinueBudget, null, 'continueBudget should clear pendingContinueBudget on finish');
  assert.equal(runner.status, 'running');
  assert.equal(drivenInput?.resume?.kind, 'finish');

  runner.dispose();
});
