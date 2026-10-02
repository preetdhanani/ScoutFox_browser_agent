import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeChrome } from '../helpers/fakeChrome.ts';
import { createFakeStorage } from '../helpers/fakeStorageSession.ts';
import { fakeDom, link } from '../helpers/fakeDom.ts';
import { AgentRunner } from '../../src/background/runner/AgentRunner.ts';
import type { LlmPort } from '../../src/background/runner/runtimeRegistry.ts';

const LIST_URL = 'https://shop.test/items';
const PRODUCT_URL = 'https://shop.test/items/42';

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

  const site = fakeDom({
    pages: [
      {
        url: LIST_URL,
        title: 'Items List',
        text: ['Item 42 available for 99 USD'],
        elements: [link('Item 42 Details', PRODUCT_URL)],
      },
      {
        url: PRODUCT_URL,
        title: 'Item 42 Details',
        text: ['Price: 99 USD', 'In Stock'],
        elements: [link('Back', LIST_URL)],
      },
    ],
  });

  const fc = fakeChrome({
    tabs: { list: [{ id: 101, windowId: 1, url: LIST_URL }] },
    tabGroups: true,
    storage: store,
    dom: true,
  });

  site.attach(fc, 101);
  const restoreChrome = fc.install();

  return {
    store,
    fc,
    site,
    cleanup: () => {
      restoreChrome();
    },
  };
}

test('AgentRunner - claimForTask admission, rejection and release', async (t) => {
  const env = setupEnvironment();
  t.after(env.cleanup);

  const runner = new AgentRunner(101, 1);
  await runner.restorePromise;

  // First claim succeeds
  const firstClaim = runner.claimForTask();
  assert.equal(firstClaim.success, true);

  // Second claim while claimed is rejected
  const secondClaim = runner.claimForTask();
  assert.equal(secondClaim.success, false);
  assert.match(secondClaim.error ?? '', /already active/);

  // Release claim enables claiming again
  runner.releaseTaskClaim();
  const thirdClaim = runner.claimForTask();
  assert.equal(thirdClaim.success, true);
  runner.releaseTaskClaim();

  // Paused status rejects claims
  runner.status = 'paused';
  const pausedClaim = runner.claimForTask();
  assert.equal(pausedClaim.success, false);

  runner.status = 'idle';
  runner.dispose();
});

test('AgentRunner - Public API surface parity and getters', async (t) => {
  const env = setupEnvironment();
  t.after(env.cleanup);

  const runner = new AgentRunner(101, 1);
  await runner.restorePromise;

  assert.equal(runner.sessionId, 101);
  assert.equal(runner.ownerTabId, 101);
  assert.equal(runner.threadId, '101');
  assert.equal(runner.getStatus(), 'idle');
  assert.deepEqual(runner.getHistory(), []);

  // State update callback
  let stateReceived: Record<string, any> | null = null;
  runner.setStateChangeCallback((state) => {
    stateReceived = state;
  });

  const state = runner.getState();
  assert.equal(state.status, 'idle');
  assert.equal(state.stepCount, 0);
  assert.equal(typeof state.stateVersion, 'number');
  assert.equal(typeof state.bootId, 'string');

  // Network buffering
  runner.recordNetworkRequest(101, { url: 'https://api.test', method: 'GET' });
  assert.equal(runner.networkBuffers.get(101)?.length, 1);

  // ensureScoutFoxGroup creates a tab group
  const groupId = await runner.ensureScoutFoxGroup(101, 1);
  assert.ok(groupId !== null);
  assert.equal(runner.groupIdForWindow(1), groupId);

  // Clear history resets state
  runner.stepCount = 3;
  runner.currentTask = 'old task';
  runner.clearHistory();
  assert.equal(runner.currentTask, '');
  assert.equal(runner.status, 'idle');
  assert.deepEqual(runner.history, []);
  assert.ok(stateReceived !== null);

  runner.dispose();
});

function createScriptedLlm(scriptedReplies: string[] | string): LlmPort {
  const replies = Array.isArray(scriptedReplies) ? scriptedReplies : [scriptedReplies];
  let mockCallIndex = 0;
  return {
    complete: async (req) => {
      if (req.node === 'plan') {
        return {
          text: JSON.stringify({
            taskKind: 'action',
            sites: [{ id: 's1', name: 'shop.test', domain: 'shop.test', role: 'reference', kind: 'page', goal: 'Do task' }],
          }),
          provider: 'openrouter',
          model: 'test-model',
          meta: {},
        };
      }
      const reply = replies[mockCallIndex++] ?? JSON.stringify({ action: 'finish', answer: 'Finished.' });
      return {
        text: reply,
        provider: 'openrouter',
        model: 'test-model',
        meta: {},
      };
    },
  };
}

test('AgentRunner - startTask lifecycle: plan auto-approved, worker execution, finish', async (t) => {
  const env = setupEnvironment();
  t.after(env.cleanup);

  const scriptedReplies = [
    // Step 1: policy node chooses to click item 42
    JSON.stringify({ action: 'click', element_id: 1, reason: 'Open item details' }),
    // Step 2: policy node finishes with answer
    JSON.stringify({ action: 'finish', answer: 'Item 42 costs 99 USD.' }),
  ];

  const mockLlm = createScriptedLlm(scriptedReplies);

  const runner = new AgentRunner(101, 1, undefined, mockLlm);
  await runner.restorePromise;

  const statesEmitted: string[] = [];
  runner.setStateChangeCallback((state) => {
    if (state.currentPhase) statesEmitted.push(state.currentPhase);
  });

  const startRes = await runner.startTask('Find item 42 price', 101);
  assert.equal(startRes.success, true);
  assert.equal(runner.status, 'idle');

  // Finish history entry must be present
  const finish = runner.history.find((h) => h.type === 'finish');
  assert.ok(finish, 'Finish history entry exists');
  assert.equal(finish?.answer, 'Item 42 costs 99 USD.');

  runner.dispose();
});

test('AgentRunner - pause and stop lifecycle', async (t) => {
  const env = setupEnvironment();
  t.after(env.cleanup);

  const runner = new AgentRunner(101, 1);
  await runner.restorePromise;

  // Test pause when not running does not crash
  runner.pause();
  assert.equal(runner.status, 'idle');

  // Test pause while running
  runner.status = 'running';
  runner.pause();
  assert.equal(runner.status, 'paused');
  assert.equal(runner.pauseReason, 'user');
  assert.equal(runner.claimForTask().success, false);

  // Test stop
  const stopRes = runner.stop();
  assert.equal(stopRes.success, true);
  assert.equal(runner.status, 'stopped');

  runner.dispose();
});

test('AgentRunner - restoreState across simulated service worker restart', async (t) => {
  const env = setupEnvironment();
  t.after(env.cleanup);

  // Instance 1: start and run a task that writes checkpoints to shared fake storage
  const mockLlm = createScriptedLlm(JSON.stringify({ action: 'finish', answer: 'Completed task.' }));

  const runner1 = new AgentRunner(101, 1, undefined, mockLlm);
  await runner1.restorePromise;
  await runner1.ensureScoutFoxGroup(101, 1);
  const groupId = runner1.scoutFoxGroupId;

  await runner1.startTask('Task to checkpoint', 101);
  assert.equal(runner1.status, 'idle');
  await runner1.persistState();

  // Instance 2: new runner on same tabId simulates worker restart
  const runner2 = new AgentRunner(101, 1);
  await runner2.restorePromise;

  assert.equal(runner2.scoutFoxGroupId, groupId);
  assert.equal(runner2.currentTask, 'Task to checkpoint');
  assert.ok(runner2.history.length > 0);

  // forgetSession clears thread data
  await AgentRunner.forgetSession(101);

  runner1.dispose();
  runner2.dispose();
});

test('AgentRunner - ask_user interrupt and answerQuestion resume', async (t) => {
  const env = setupEnvironment();
  t.after(env.cleanup);

  const scriptedReplies = [
    JSON.stringify({ action: 'ask_user', question: 'Which color do you prefer?' }),
    JSON.stringify({ action: 'finish', answer: 'Found blue item.' }),
  ];

  const mockLlm = createScriptedLlm(scriptedReplies);

  const runner = new AgentRunner(101, 1, undefined, mockLlm);
  await runner.restorePromise;

  await runner.startTask('Find item', 101);
  assert.equal(runner.status, 'paused');
  assert.equal(runner.pendingQuestion, 'Which color do you prefer?');

  const answerRes = runner.answerQuestion('Blue');
  assert.equal(answerRes.success, true);
  assert.equal(runner.pendingQuestion, null);

  while (runner.getStatus() === 'running') {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(runner.status, 'idle');
  const userAnswer = runner.history.find((h) => h.type === 'user_answer');
  assert.ok(userAnswer);
  assert.equal((userAnswer as any).content, 'Blue');

  runner.dispose();
});

test('AgentRunner - stop while paused at interrupt', async (t) => {
  const env = setupEnvironment();
  t.after(env.cleanup);

  const mockLlm = createScriptedLlm(JSON.stringify({ action: 'ask_user', question: 'Need input' }));

  const runner = new AgentRunner(101, 1, undefined, mockLlm);
  await runner.restorePromise;

  await runner.startTask('Task asking question', 101);
  assert.equal(runner.status, 'paused');
  assert.equal(runner.pendingQuestion, 'Need input');

  const stopRes = runner.stop();
  assert.equal(stopRes.success, true);

  while (runner.getStatus() === 'running') {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(runner.status, 'stopped');
  runner.dispose();
});

test('AgentRunner - clearHistory deletes checkpoints in SessionStorageSaver', async (t) => {
  const env = setupEnvironment();
  t.after(env.cleanup);

  const mockLlm = createScriptedLlm(JSON.stringify({ action: 'finish', answer: 'Finished 1.' }));

  const runner = new AgentRunner(101, 1, undefined, mockLlm);
  await runner.restorePromise;

  await runner.startTask('Task 1', 101);
  assert.equal(runner.status, 'idle');
  assert.ok(runner.history.length > 0);

  runner.clearHistory();
  assert.equal(runner.status, 'idle');
  assert.deepEqual(runner.history, []);
  assert.equal(runner.currentTask, '');

  const mockLlm2 = createScriptedLlm(JSON.stringify({ action: 'finish', answer: 'Finished 2.' }));

  const runner2 = new AgentRunner(101, 1, undefined, mockLlm2);
  await runner2.restorePromise;

  await runner2.startTask('Task 2', 101);
  assert.equal(runner2.status, 'idle');
  assert.equal(runner2.currentTask, 'Task 2');

  const finishes = runner2.history.filter((h) => h.type === 'finish');
  assert.equal(finishes.length, 1);
  assert.equal((finishes[0] as any).answer, 'Finished 2.');

  runner.dispose();
  runner2.dispose();
});
