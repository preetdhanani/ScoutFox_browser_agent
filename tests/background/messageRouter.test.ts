/**
 * Comprehensive integration tests for the background service worker message router (routeMessage).
 * Tests all routes, payloads, responses, and error fallbacks.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { routerRig } from '../helpers/routerRig.ts';
import { SHOP_LIST_URL, act, shopPages, shopPlan } from '../helpers/graphHarness.ts';
import { Logger } from '../../src/shared/logger.ts';

test('routeMessage: handles CLIENT_ERROR and logs error to Logger', async (t) => {
  const rig = await routerRig();
  t.after(rig.cleanup);

  Logger.clearLogs();
  const res = await rig.send({
    action: 'CLIENT_ERROR',
    payload: { source: 'sidepanel_ui', message: 'Something went wrong', stack: 'Error: Something\n  at foo.js:1' },
  });

  assert.equal(res?.success, true);
  const logs = Logger.getLogsHistory();
  const found = logs.find((l) => l.level === 'ERROR' && l.message.includes('Something went wrong'));
  assert.ok(found, 'CLIENT_ERROR must be recorded in background Logger history');
});

test('routeMessage: handles NET_REQUEST_RECORDED with sender tab and fallback', async (t) => {
  const rig = await routerRig({
    tabs: [{ id: 100, url: SHOP_LIST_URL, windowId: 1, active: true }],
  });
  t.after(rig.cleanup);

  await rig.connect(100);

  // With sender tab
  const resWithTab = await rig.send(
    { action: 'NET_REQUEST_RECORDED', payload: { url: 'https://api.test/data', method: 'GET' } },
    { tab: { id: 100 } }
  );
  assert.equal(resWithTab?.success, true);

  // Without sender tab fallback
  const resNoTab = await rig.send({
    action: 'NET_REQUEST_RECORDED',
    payload: { url: 'https://api.test/fallback', method: 'POST' },
  });
  assert.equal(resNoTab?.success, true);
});

test('routeMessage: handles FETCH_MODELS with successful listing', async (t) => {
  const rig = await routerRig();
  t.after(rig.cleanup);

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      data: [{ id: 'mock-model-1' }, { id: 'mock-model-2' }],
    }),
  })) as any;
  t.after(() => { globalThis.fetch = origFetch; });

  const res = await rig.send({
    action: 'FETCH_MODELS',
    payload: { provider: 'openrouter', forceRefresh: true },
  });

  assert.equal(res?.success, true);
  assert.deepEqual(res?.models, ['mock-model-1', 'mock-model-2']);
});

test('routeMessage: handles FETCH_MODELS with error and fallback models', async (t) => {
  const rig = await routerRig();
  t.after(rig.cleanup);

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('API down'); }) as any;
  t.after(() => { globalThis.fetch = origFetch; });

  // When network fetch fails, fetchAvailableModels falls back to default provider models
  const res = await rig.send({
    action: 'FETCH_MODELS',
    payload: { provider: 'openai', apiKey: 'test-key', forceRefresh: true },
  });

  assert.equal(res?.success, true);
  assert.ok(Array.isArray(res?.models));
  assert.ok(res.models.length > 0);
  assert.ok(res.models.includes('gpt-4o-mini'));

  // When fetchAvailableModels rejects (e.g. invalid null payload), error response is returned
  const resErr = await rig.send({
    action: 'FETCH_MODELS',
    payload: null,
  });

  // A payload that is not settings at all (null) cannot name a provider, so the error response
  // carries no invented fallback list: featere/custom-endpoint removed the old default arm of
  // getFallbackModels, which put Gemini's ids in the picker of a provider nobody asked about.
  assert.equal(resErr?.success, false);
  assert.ok(resErr?.error);
  assert.deepEqual(resErr?.models, []);
});

test('routeMessage: handles PAUSE_TASK, RESUME_TASK, and STOP_TASK lifecycle', async (t) => {
  let finishTask: (() => void) | undefined;
  const hangingPromise = new Promise((resolve) => { finishTask = resolve as () => void; });

  const rig = await routerRig({
    tabs: [{ id: 100, url: SHOP_LIST_URL, windowId: 1, active: true }],
    pages: shopPages(),
    llm: {
      plan: [shopPlan()],
      policy: [
        async () => {
          await hangingPromise;
          return act.finish('done');
        },
      ],
    },
  });
  t.after(async () => {
    finishTask?.();
    await rig.cleanup();
  });

  await rig.connect(100);

  // Idle session pause/resume reports failure
  const pauseIdle = await rig.send({ action: 'PAUSE_TASK', tabId: 100 });
  assert.equal(pauseIdle?.success, false);

  const resumeIdle = await rig.send({ action: 'RESUME_TASK', tabId: 100 });
  assert.equal(resumeIdle?.success, false);

  // Start task and let it enter running state
  await rig.startTask(100, 'long running task');
  await rig.waitForStatus(100, 'running');

  // Pause
  const pauseRes = await rig.send({ action: 'PAUSE_TASK', tabId: 100 });
  assert.equal(pauseRes?.success, true);
  await rig.waitForStatus(100, 'paused');

  // Resume
  const resumeRes = await rig.send({ action: 'RESUME_TASK', tabId: 100 });
  assert.equal(resumeRes?.success, true);
  await rig.waitForStatus(100, 'running');

  // Stop
  const stopRes = await rig.send({ action: 'STOP_TASK', tabId: 100 });
  assert.equal(stopRes?.success, true);
  await rig.waitForStatus(100, 'stopped');
});

test('routeMessage: handles ANSWER_QUESTION when question pending and when none pending', async (t) => {
  const QUESTION = 'What is your username?';
  const rig = await routerRig({
    tabs: [{ id: 100, url: SHOP_LIST_URL, windowId: 1, active: true }],
    pages: shopPages(),
    llm: {
      plan: [shopPlan()],
      policy: [
        act.askUser(QUESTION),
        act.finish('done'),
      ],
    },
  });
  t.after(rig.cleanup);

  await rig.connect(100);

  // When none pending
  const noQRes = await rig.send({
    action: 'ANSWER_QUESTION',
    tabId: 100,
    payload: { answer: 'admin' },
  });
  assert.equal(noQRes?.success, false);

  // Start task to trigger question
  await rig.startTask(100, 'login task');
  await rig.waitForStatus(100, 'paused');

  // Answering valid question
  const ansRes = await rig.send({
    action: 'ANSWER_QUESTION',
    tabId: 100,
    payload: { answer: 'alice' },
  });
  assert.equal(ansRes?.success, true);
  await rig.waitForStatus(100, 'idle');
});

test('routeMessage: handles APPROVE_PLAN through AgentRunner', async (t) => {
  const rig = await routerRig({
    tabs: [{ id: 100, url: SHOP_LIST_URL, windowId: 1, active: true }],
    pages: shopPages(),
    llm: {
      plan: [shopPlan()],
      policy: [act.finish('done')],
    },
  });
  t.after(rig.cleanup);

  await rig.connect(100);

  // Start without autoApprove so it holds at plan approval
  await rig.send({
    action: 'START_TASK',
    tabId: 100,
    payload: { prompt: 'plan test', autoApprove: false },
  });
  await rig.waitForStatus(100, 'paused');

  const appRes = await rig.send({
    action: 'APPROVE_PLAN',
    tabId: 100,
    payload: { approved: true },
  });
  assert.equal(appRes?.success, true);
  await rig.waitForStatus(100, 'idle');
});

test('routeMessage: START_TASK without autoApprove auto-approves the plan and runs to idle', async (t) => {
  const rig = await routerRig({
    tabs: [{ id: 100, url: SHOP_LIST_URL, windowId: 1, active: true }],
    pages: shopPages(),
    llm: {
      plan: [shopPlan()],
      policy: [act.finish('done')],
    },
  });
  t.after(rig.cleanup);

  await rig.connect(100);

  // The side panel never sends autoApprove. The plan must approve itself: no APPROVE_PLAN is
  // sent here, and the run must reach idle on its own (the old router default held it at the
  // Plan Approval card).
  const res = await rig.send({
    action: 'START_TASK',
    tabId: 100,
    payload: { prompt: 'auto-approve test' },
  });
  assert.equal(res?.success, true);
  const st = await rig.waitForStatus(100, 'idle');
  assert.equal(st.pendingApproval, null);
});
test('routeMessage: handles CONFIRM_ACTION, RESOLVE_CHALLENGE, CONTINUE_BUDGET, and CLEAR_HISTORY', async (t) => {
  const rig = await routerRig({
    tabs: [{ id: 100, url: SHOP_LIST_URL, windowId: 1, active: true }],
    pages: shopPages(),
    llm: {
      plan: [shopPlan()],
      policy: [act.finish('done')],
    },
  });
  t.after(rig.cleanup);

  await rig.connect(100);
  await rig.startTask(100, 'dummy task');
  await rig.waitForStatus(100, 'idle');

  // CONFIRM_ACTION
  const confRes = await rig.send({
    action: 'CONFIRM_ACTION',
    tabId: 100,
    payload: { decision: 'approve', remember: 'site' },
  });
  assert.equal(confRes?.success, true);

  // RESOLVE_CHALLENGE
  const challRes = await rig.send({
    action: 'RESOLVE_CHALLENGE',
    tabId: 100,
    payload: { action: 'resolved' },
  });
  assert.equal(challRes?.success, true);

  // CONTINUE_BUDGET
  const budRes = await rig.send({
    action: 'CONTINUE_BUDGET',
    tabId: 100,
    payload: { action: 'continue', additionalSteps: 5 },
  });
  assert.equal(budRes?.success, true);

  // CLEAR_HISTORY
  const clrRes = await rig.send({
    action: 'CLEAR_HISTORY',
    tabId: 100,
  });
  assert.equal(clrRes?.success, true);
  const state = await rig.state(100);
  assert.deepEqual(state.history, []);
  assert.ok(!state.task);
});

test('routeMessage: handles unknown action with structured error response', async (t) => {
  const rig = await routerRig();
  t.after(rig.cleanup);

  const res = await rig.send({
    action: 'UNSUPPORTED_ACTION_XYZ',
    tabId: 100,
  });

  assert.equal(res?.success, false);
  assert.match(res?.error, /Unknown action: UNSUPPORTED_ACTION_XYZ/);
});
