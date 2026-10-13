import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeChrome } from '../helpers/fakeChrome.ts';
import { createFakeStorage } from '../helpers/fakeStorageSession.ts';
import { fakeDom, link } from '../helpers/fakeDom.ts';
import { AgentRunner } from '../../src/background/runner/AgentRunner.ts';
import { SessionStorageSaver } from '../../src/background/checkpoint/SessionStorageSaver.ts';
import { buildOrchestratorGraph } from '../../src/background/graph/orchestrator.ts';
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

/**
 * An LLM that answers the planner, then blocks inside the first policy call until
 * its signal is aborted - so a runner.stop() lands mid-site, inside the worker.
 */
function midSiteStopLlm(): { port: LlmPort; reachedPolicy: Promise<void> } {
  let resolveReached: () => void = () => {};
  const reachedPolicy = new Promise<void>((resolve) => {
    resolveReached = resolve;
  });
  const port: LlmPort = {
    complete: async (req: any) => {
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
      resolveReached();
      await new Promise<void>((_, reject) => {
        req.signal?.addEventListener('abort', () => reject(new Error('Aborted')));
      });
      throw new Error('unreachable');
    },
  };
  return { port, reachedPolicy };
}

test('AgentRunner - stop mid-site writes the stopped partial_result and does not resurrect (BUG-16)', async (t) => {
  const env = setupEnvironment();
  t.after(env.cleanup);

  const saver = new SessionStorageSaver(env.store.connect().session);
  const { port, reachedPolicy } = midSiteStopLlm();

  const runner = new AgentRunner(101, 1, saver, port);
  await runner.restorePromise;

  const startPromise = runner.startTask('Find item 42 price', 101);
  await reachedPolicy;
  runner.stop();
  await startPromise;

  assert.equal(runner.status, 'stopped');

  // 1. The stopped partial_result must exist in the history.
  const partial = runner.history.find((h: any) => h.type === 'partial_result');
  assert.ok(partial, 'a partial_result history entry exists after a mid-site stop');
  assert.equal((partial as any).reason, 'stopped');

  // 2. The graph finished: the checkpoint has no pending next tasks.
  const graph = buildOrchestratorGraph(saver);
  const state = await graph.getState({ configurable: { thread_id: '101' } }, { subgraphs: true });
  assert.deepEqual(state.next ?? [], [], 'checkpoint has no pending tasks after the stop finalization');
  assert.equal((state.values as any)?.endReason, 'stopped');

  // 3. The interrupted site is not stuck at "running".
  const sites = (state.values as any)?.sites ?? {};
  for (const s of Object.values<any>(sites)) {
    assert.notEqual(s.status, 'running', 'no site is left in status running after a stop');
  }

  // 4. A worker restart must not resurrect the explicitly stopped run as paused,
  //    and the restored history keeps the stopped partial_result.
  const runner2 = new AgentRunner(101, 1, saver);
  await runner2.restorePromise;
  assert.equal(runner2.getStatus(), 'stopped', `a restart must not resurrect a stopped run, got ${runner2.getStatus()}`);
  assert.ok(
    runner2.history.some((h: any) => h.type === 'partial_result' && h.reason === 'stopped'),
    'the restored history still carries the stopped partial_result',
  );

  runner.dispose();
  runner2.dispose();
});

test('AgentRunner - stop clears the hold mirrors and a new task starts without them (BUG-35)', async (t) => {
  const env = setupEnvironment();
  t.after(env.cleanup);

  const askLlm: LlmPort = {
    complete: async (req: any) => {
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
      return {
        text: JSON.stringify({ action: 'ask_user', question: 'Which one?' }),
        provider: 'openrouter',
        model: 'test-model',
        meta: {},
      };
    },
  };

  const runner = new AgentRunner(101, 1, undefined, askLlm);
  await runner.restorePromise;

  await runner.startTask('Task asking question', 101);
  assert.equal(runner.status, 'paused');
  assert.equal(runner.pendingQuestion, 'Which one?');

  const stopRes = runner.stop();
  assert.equal(stopRes.success, true);
  assert.equal(runner.status, 'stopped');
  // Every hold mirror must be cleared with the stop.
  assert.equal(runner.pendingQuestion, null);
  assert.equal(runner.pendingApproval, null);
  assert.equal(runner.pendingConfirm, null);
  assert.equal(runner.pendingChallengeHelp, null);
  assert.equal(runner.pendingContinueBudget, null);

  // A new task on the same tab starts without inheriting any hold card.
  const finishLlm = createFinishLlm();
  runner.setLlmPort(finishLlm);
  await runner.startTask('Second task', 101);
  assert.equal(runner.status, 'idle');
  assert.equal(runner.pendingQuestion, null);
  assert.equal(runner.pendingApproval, null);
  assert.equal(runner.pendingConfirm, null);
  assert.equal(runner.pendingChallengeHelp, null);
  assert.equal(runner.pendingContinueBudget, null);

  runner.dispose();
});

/** A minimal LLM that plans one site and immediately finishes. */
function createFinishLlm(): LlmPort {
  return {
    complete: async (req: any) => {
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
      return {
        text: JSON.stringify({ action: 'finish', answer: 'Done.' }),
        provider: 'openrouter',
        model: 'test-model',
        meta: {},
      };
    },
  };
}
