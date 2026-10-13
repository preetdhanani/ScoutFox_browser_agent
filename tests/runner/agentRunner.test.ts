import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeChrome } from '../helpers/fakeChrome.ts';
import { createFakeStorage } from '../helpers/fakeStorageSession.ts';
import { fakeDom, link } from '../helpers/fakeDom.ts';
import { AgentRunner } from '../../src/background/runner/AgentRunner.ts';
import { Logger } from '../../src/shared/logger.ts';
import { runtimeRegistry, type LlmPort } from '../../src/background/runner/runtimeRegistry.ts';

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
    scripting: { executeScript: () => [{ result: true }] },
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

test('AgentRunner - requestedEffort and effortDefault settings integration', async (t) => {
  const env = setupEnvironment();
  t.after(env.cleanup);

  const mockLlm = createScriptedLlm(JSON.stringify({ action: 'finish', answer: 'Done.' }));

  const runner = new AgentRunner(101, 1, undefined, mockLlm);
  await runner.restorePromise;

  // 1. Explicit requestedEffort: 'high'
  await runner.startTask('Search products', 101, 'high');
  assert.equal(runner.status, 'idle');
  assert.equal(runner.getState().effort?.requested, 'high');
  assert.equal(runner.getState().effort?.level, 'high');
  assert.equal(runner.getState().effort?.suggestedBy, 'user');

  // 2. Default from storage settings: 'low'
  await env.store.connect().local.set({
    agent_settings: {
      provider: 'openrouter',
      model: 'test-model',
      effortDefault: 'low',
    },
  });

  const runner2 = new AgentRunner(102, 1, undefined, mockLlm);
  await runner2.restorePromise;

  await runner2.startTask('Quick search', 102);
  assert.equal(runner2.status, 'idle');
  assert.equal(runner2.getState().effort?.requested, 'low');
  assert.equal(runner2.getState().effort?.level, 'low');
  assert.equal(runner2.getState().effort?.suggestedBy, 'default');

  runner.dispose();
  runner2.dispose();
});

test('AgentRunner - startTask writes the [START_TASK] line that the e2e smoke harness cuts the run log at', async (t) => {
  const env = setupEnvironment();
  t.after(env.cleanup);

  const runner = new AgentRunner(101, 1, undefined, createScriptedLlm(JSON.stringify({ action: 'finish', answer: 'Done.' })));
  await runner.restorePromise;
  Logger.clearLogs();

  // An empty prompt is refused before anything starts, so it writes no marker.
  const refused = await runner.startTask('   ', 101);
  assert.equal(refused.success, false);
  assert.deepEqual(Logger.getLogsHistory().filter((entry) => entry.message.includes('[START_TASK]')), []);

  const started = await runner.startTask('Find item 42 price', 101);
  assert.equal(started.success, true);
  const markers = Logger.getLogsHistory().filter((entry) => entry.message.includes('[START_TASK]'));
  assert.equal(markers.length, 1);
  assert.equal(markers[0].level, 'INFO');
  assert.equal(markers[0].module, 'AgentRunner');
  // tests/e2e/smoke.mjs (logsOfRun) looks for exactly this text, with the tab id of the task.
  assert.equal(markers[0].message, '[START_TASK] Starting task on tab [101].');

  runner.dispose();
});

test('AgentRunner - snapshot throws when content script returns success false or empty response', async (t) => {
  const env = setupEnvironment();
  t.after(env.cleanup);

  const runner = new AgentRunner(101, 1);
  await runner.restorePromise;
  const runtime = runtimeRegistry.get(String(101))!;
  assert.ok(runtime);

  const originalSendMessage = globalThis.chrome.tabs.sendMessage;
  (globalThis.chrome.tabs as any).sendMessage = (_tabId: number, _msg: any, cb: (res: any) => void) => {
    cb({ success: false, error: 'Target frame detached' });
  };

  await assert.rejects(
    async () => runtime.browser.snapshot(101, { showBadges: true, maxElements: 100 }),
    /Target frame detached/
  );

  (globalThis.chrome.tabs as any).sendMessage = (_tabId: number, _msg: any, cb: (res: any) => void) => {
    cb(null);
  };

  await assert.rejects(
    async () => runtime.browser.snapshot(101, { showBadges: false, maxElements: 100 }),
    /No response from content script/
  );

  (globalThis.chrome.tabs as any).sendMessage = originalSendMessage;
  runner.dispose();
});

test('AgentRunner - browser.execute handles navigate with URL comparison and rejects non-http targets', async (t) => {
  const env = setupEnvironment();
  t.after(env.cleanup);

  const runner = new AgentRunner(101, 1);
  await runner.restorePromise;
  const runtime = runtimeRegistry.get(String(101))!;
  assert.ok(runtime);

  // 1. Non-http/https target rejected
  const fileRes = await runtime.browser.execute(101, { action: 'navigate', url: 'file:///etc/passwd' } as any, { docId: 'doc-1', mode: 'synthetic' });
  assert.equal(fileRes.success, false);
  assert.equal(fileRes.via, 'background');
  assert.match(fileRes.error || '', /Navigate target must be http or https|cannot read file:/);

  const chromeRes = await runtime.browser.execute(101, { action: 'navigate', url: 'chrome://settings' } as any, { docId: 'doc-1', mode: 'synthetic' });
  assert.equal(chromeRes.success, false);
  assert.equal(chromeRes.via, 'background');

  // 2. Navigate to different URL reports url_changed
  const navRes = await runtime.browser.execute(101, { action: 'navigate', url: PRODUCT_URL } as any, { docId: 'doc-1', mode: 'synthetic' });
  assert.equal(navRes.success, true);
  assert.equal(navRes.via, 'background');
  assert.equal(navRes.effect, 'url_changed');
  assert.equal(navRes.urlAfter, PRODUCT_URL);

  // 3. Navigate to same URL reports honest none
  const sameRes = await runtime.browser.execute(101, { action: 'navigate', url: PRODUCT_URL } as any, { docId: 'doc-1', mode: 'synthetic' });
  assert.equal(sameRes.success, true);
  assert.equal(sameRes.via, 'background');
  assert.equal(sameRes.effect, 'none');

  runner.dispose();
});

test('AgentRunner - waitForTabComplete respects AbortSignal', async (t) => {
  const env = setupEnvironment();
  t.after(env.cleanup);

  const runner = new AgentRunner(101, 1);
  await runner.restorePromise;

  const controller = new AbortController();
  controller.abort();

  const start = Date.now();
  await runner.waitForTabComplete(101, 5000, controller.signal);
  const duration = Date.now() - start;
  assert.ok(duration < 100, `Expected instant return on aborted signal, took ${duration}ms`);

  runner.dispose();
});
