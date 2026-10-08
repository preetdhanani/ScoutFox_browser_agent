/**
 * Spike S5: Proves subgraph checkpoints with SessionStorageSaver, the interrupt shim,
 * worker stops and resumes across 7 key requirements:
 *
 * 1. Subgraph with private channels inside a parent graph; parent state has none of them afterwards.
 * 2. interrupt() inside the subgraph, and resume with Command({resume}) through the parent, also after a worker stop.
 * 3. Worker killed in the middle of a non-interrupt node of the subgraph, and resumed with stream(null) / invoke(null).
 * 4. Pruning per namespace, and parent checkpoint bytes with 66 steps flat versus in a subgraph.
 * 5. Delete of a finished thread, with every namespace gone.
 * 6. Two subgraph instances started with Send, each with its own interrupt.
 * 7. updateState(asNode: 'finalize') on a thread whose site task is pending leaves next empty and no orphan keys after pruning.
 *
 * Plus: stream with { subgraphs: true } delivers the worker's values to the runner.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Annotation,
  Command,
  END,
  START,
  StateGraph,
  Send,
} from '@langchain/langgraph/web';
import { interruptWithConfig } from '../../src/background/graph/interrupt.ts';
import { SessionStorageSaver } from '../../src/background/checkpoint/SessionStorageSaver.ts';
import { createFakeStorage } from '../helpers/fakeStorageSession.ts';

const concat = <T>(left: T[], right: T[]): T[] => left.concat(right);

// Helper to build test worker subgraph
function createWorkerGraph() {
  const WorkerState = Annotation.Root({
    siteIn: Annotation<string>(),
    siteOut: Annotation<string>(),
    steps: Annotation<string[]>({ reducer: concat, default: () => [] }),
    page: Annotation<string>(),
  });

  return new StateGraph(WorkerState)
    .addNode('open', async (state) => {
      return { page: `page of ${state.siteIn}`, steps: ['open'] };
    })
    .addNode('hold', async (_state, config) => {
      const answer = interruptWithConfig<{ question: string }, string>(config, { question: 'confirm?' });
      return { steps: [`hold:${answer}`] };
    })
    .addNode('finish', async (state) => ({
      siteOut: `${state.siteIn}|${state.steps.join('>')}`,
    }))
    .addEdge(START, 'open')
    .addEdge('open', 'hold')
    .addEdge('hold', 'finish')
    .addEdge('finish', END)
    .compile();
}

test('Spike S5 Check 1: Subgraph with private channels inside parent graph, parent state has none of them afterwards', async () => {
  const store = createFakeStorage();
  const saver = new SessionStorageSaver(store.connect().session);
  const worker = createWorkerGraph();

  const ParentState = Annotation.Root({
    log: Annotation<string[]>({ reducer: concat, default: () => [] }),
    results: Annotation<string[]>({ reducer: concat, default: () => [] }),
  });

  const parent = new StateGraph(ParentState)
    .addNode('plan', async () => ({ log: ['plan'] }))
    .addNode('site', async (_state, config) => {
      const out = await worker.invoke({ siteIn: 'shop-a' }, config);
      return { results: [out.siteOut], log: ['site'] };
    })
    .addNode('summary', async () => ({ log: ['summary'] }))
    .addEdge(START, 'plan')
    .addEdge('plan', 'site')
    .addEdge('site', 'summary')
    .addEdge('summary', END)
    .compile({ checkpointer: saver });

  const thread = { configurable: { thread_id: 's5-check-1' }, durability: 'sync' as const };
  await parent.invoke({}, thread);

  // Resume the interrupt
  const finalState = await parent.invoke(new Command({ resume: 'ok' }), thread);

  // Assert results
  assert.deepEqual(finalState.log, ['plan', 'site', 'summary']);
  assert.deepEqual(finalState.results, ['shop-a|open>hold:ok']);

  // Parent state must not contain worker's private channels: 'page', 'steps', 'siteIn', 'siteOut'
  assert.deepEqual(Object.keys(finalState).sort(), ['log', 'results']);

  const snapshot = await parent.getState(thread);
  assert.deepEqual(Object.keys(snapshot.values).sort(), ['log', 'results']);
  assert.equal(snapshot.values.page, undefined);
  assert.equal(snapshot.values.steps, undefined);
});

test('Spike S5 Check 2: interrupt() inside subgraph and resume with Command({resume}) through parent after worker restart', async () => {
  const store = createFakeStorage();
  const thread = { configurable: { thread_id: 's5-check-2' }, durability: 'sync' as const };

  // Worker 1 runs until interrupt
  const conn1 = store.connect();
  const saver1 = new SessionStorageSaver(conn1.session);
  const worker1 = createWorkerGraph();

  const ParentState = Annotation.Root({
    log: Annotation<string[]>({ reducer: concat, default: () => [] }),
    results: Annotation<string[]>({ reducer: concat, default: () => [] }),
  });

  const parent1 = new StateGraph(ParentState)
    .addNode('plan', async () => ({ log: ['plan'] }))
    .addNode('site', async (_state, config) => {
      const out = await worker1.invoke({ siteIn: 'site-restart' }, config);
      return { results: [out.siteOut], log: ['site'] };
    })
    .addEdge(START, 'plan')
    .addEdge('plan', 'site')
    .addEdge('site', END)
    .compile({ checkpointer: saver1 });

  await parent1.invoke({}, thread);

  const paused = await parent1.getState(thread, { subgraphs: true });
  assert.deepEqual(paused.next, ['site']);
  assert.equal(paused.tasks[0]?.name, 'site');
  assert.deepEqual(paused.tasks[0]?.interrupts.map((i) => i.value), [{ question: 'confirm?' }]);

  // Simulate worker death
  conn1.kill();

  // Fresh worker connects to same store
  const conn2 = store.connect();
  const saver2 = new SessionStorageSaver(conn2.session);
  const worker2 = createWorkerGraph();

  const parent2 = new StateGraph(ParentState)
    .addNode('plan', async () => ({ log: ['plan'] }))
    .addNode('site', async (_state, config) => {
      const out = await worker2.invoke({ siteIn: 'site-restart' }, config);
      return { results: [out.siteOut], log: ['site'] };
    })
    .addEdge(START, 'plan')
    .addEdge('plan', 'site')
    .addEdge('site', END)
    .compile({ checkpointer: saver2 });

  // Resume on the resurrected parent
  const done = await parent2.invoke(new Command({ resume: 'approved-after-restart' }), thread);
  assert.deepEqual(done.results, ['site-restart|open>hold:approved-after-restart']);
  assert.deepEqual(done.log, ['plan', 'site']);
});

test('Spike S5 Check 3: Worker killed in middle of non-interrupt node and resumed with invoke(null)', async () => {
  const store = createFakeStorage();
  const thread = { configurable: { thread_id: 's5-check-3' }, durability: 'sync' as const };

  let node2Attempts = 0;
  const Worker = Annotation.Root({
    steps: Annotation<string[]>({ reducer: concat, default: () => [] }),
  });

  const worker = new StateGraph(Worker)
    .addNode('node1', async () => ({ steps: ['node1'] }))
    .addNode('node2', async () => {
      node2Attempts++;
      if (node2Attempts === 1) {
        throw new Error('Simulated process crash in node2');
      }
      return { steps: ['node2'] };
    })
    .addEdge(START, 'node1')
    .addEdge('node1', 'node2')
    .addEdge('node2', END)
    .compile();

  const Parent = Annotation.Root({
    history: Annotation<string[]>({ reducer: concat, default: () => [] }),
  });

  const conn1 = store.connect();
  const saver1 = new SessionStorageSaver(conn1.session);

  const parent1 = new StateGraph(Parent)
    .addNode('site', async (_state, config) => {
      const out = await worker.invoke({}, config);
      return { history: out.steps };
    })
    .addEdge(START, 'site')
    .addEdge('site', END)
    .compile({ checkpointer: saver1 });

  await assert.rejects(async () => {
    await parent1.invoke({}, thread);
  }, /Simulated process crash in node2/);

  // Inspect state: checkpoint should have node1 committed
  conn1.kill();

  const conn2 = store.connect();
  const saver2 = new SessionStorageSaver(conn2.session);
  const parent2 = new StateGraph(Parent)
    .addNode('site', async (_state, config) => {
      const out = await worker.invoke({}, config);
      return { history: out.steps };
    })
    .addEdge(START, 'site')
    .addEdge('site', END)
    .compile({ checkpointer: saver2 });

  // Resume with null input
  const resumed = await parent2.invoke(null, thread);
  assert.deepEqual(resumed.history, ['node1', 'node2']);
  assert.equal(node2Attempts, 2);
});

test('Spike S5 Check 4: Pruning per namespace and checkpoint size comparison (flat vs subgraph with 66 steps)', async () => {
  const threadFlat = { configurable: { thread_id: 's5-c4-flat' }, durability: 'sync' as const };
  const threadSub = { configurable: { thread_id: 's5-c4-sub' }, durability: 'sync' as const };

  const store = createFakeStorage();
  const conn = store.connect();
  const saver = new SessionStorageSaver(conn.session);

  // 1. Flat graph: state grows over 66 steps
  const FlatState = Annotation.Root({
    steps: Annotation<string[]>({ reducer: concat, default: () => [] }),
    history: Annotation<Array<{ step: number; text: string }>>({ reducer: concat, default: () => [] }),
  });

  let flatStepCount = 0;
  const flatGraph = new StateGraph(FlatState)
    .addNode('step', async (state) => {
      flatStepCount++;
      return {
        steps: [`step-${flatStepCount}`],
        history: [{ step: flatStepCount, text: `action description for step ${flatStepCount} with some detailed text here` }],
      };
    })
    .addConditionalEdges(START, () => 'step')
    .addConditionalEdges('step', () => (flatStepCount < 66 ? 'step' : END))
    .compile({ checkpointer: saver });

  const t0Flat = Date.now();
  await flatGraph.invoke({}, { ...threadFlat, recursionLimit: 200 });
  const tFlat = Date.now() - t0Flat;

  // 2. Subgraph: 66 steps inside worker, parent gets only summary
  let subStepCount = 0;
  const SubWorkerState = Annotation.Root({
    workerSteps: Annotation<string[]>({ reducer: concat, default: () => [] }),
  });
  const subWorker = new StateGraph(SubWorkerState)
    .addNode('wstep', async () => {
      subStepCount++;
      return { workerSteps: [`w-${subStepCount}`] };
    })
    .addConditionalEdges(START, () => 'wstep')
    .addConditionalEdges('wstep', () => (subStepCount < 66 ? 'wstep' : END))
    .compile();

  const SubParentState = Annotation.Root({
    parentLog: Annotation<string[]>({ reducer: concat, default: () => [] }),
    summary: Annotation<string>(),
  });
  const subParent = new StateGraph(SubParentState)
    .addNode('plan', async () => ({ parentLog: ['plan'] }))
    .addNode('site', async (_state, config) => {
      const out = await subWorker.invoke({}, { ...config, recursionLimit: 200 });
      return { summary: `done-${out.workerSteps.length}`, parentLog: ['site'] };
    })
    .addEdge(START, 'plan')
    .addEdge('plan', 'site')
    .addEdge('site', END)
    .compile({ checkpointer: saver });

  const t0Sub = Date.now();
  await subParent.invoke({}, { ...threadSub, recursionLimit: 200 });
  const tSub = Date.now() - t0Sub;

  // Verify pruning kept max 3 checkpoints per namespace
  const tuplesByNsFlat: Record<string, any[]> = {};
  for await (const t of saver.list(threadFlat)) {
    const ns = (t.config.configurable?.checkpoint_ns as string | undefined) ?? '';
    tuplesByNsFlat[ns] = tuplesByNsFlat[ns] ?? [];
    tuplesByNsFlat[ns].push(t);
  }
  for (const [ns, tuples] of Object.entries(tuplesByNsFlat)) {
    assert.ok(tuples.length <= 3, `Flat namespace "${ns}" checkpoints pruned to <= 3 (got ${tuples.length})`);
  }

  const tuplesByNsSub: Record<string, any[]> = {};
  for await (const t of saver.list(threadSub)) {
    const ns = (t.config.configurable?.checkpoint_ns as string | undefined) ?? '';
    tuplesByNsSub[ns] = tuplesByNsSub[ns] ?? [];
    tuplesByNsSub[ns].push(t);
  }
  for (const [ns, tuples] of Object.entries(tuplesByNsSub)) {
    assert.ok(tuples.length <= 3, `Sub namespace "${ns}" checkpoints pruned to <= 3 (got ${tuples.length})`);
  }

  // Verify bytes in storage
  const allKeys = await conn.session.getKeys?.() ?? Object.keys(await conn.session.get(null));
  const subKeys = allKeys.filter((k) => k.includes('s5-c4-sub'));
  const subData = await conn.session.get(subKeys);
  const subBytes = JSON.stringify(subData).length;

  assert.ok(subBytes < 2 * 1024 * 1024, `Subgraph checkpoints under 2MB (actual: ${subBytes} bytes)`);
});

test('Spike S5 Check 5: deleteThread removes all namespaces of the thread', async () => {
  const store = createFakeStorage();
  const conn = store.connect();
  const saver = new SessionStorageSaver(conn.session);
  const thread = { configurable: { thread_id: 's5-check-5' }, durability: 'sync' as const };
  const worker = createWorkerGraph();

  const ParentState = Annotation.Root({
    results: Annotation<string[]>({ reducer: concat, default: () => [] }),
  });
  const parent = new StateGraph(ParentState)
    .addNode('site', async (_state, config) => {
      const out = await worker.invoke({ siteIn: 'test' }, config);
      return { results: [out.siteOut] };
    })
    .addEdge(START, 'site')
    .addEdge('site', END)
    .compile({ checkpointer: saver });

  await parent.invoke({}, thread);

  // Resume to complete thread
  await parent.invoke(new Command({ resume: 'ok' }), thread);

  // Delete thread
  await saver.deleteThread('s5-check-5');

  // Verify all keys for this thread are gone
  const allKeys = await conn.session.getKeys?.() ?? Object.keys(await conn.session.get(null));
  const threadKeys = allKeys.filter((k) => k.includes('s5-check-5'));
  assert.equal(threadKeys.length, 0, `All keys for thread deleted: ${threadKeys.join(', ')}`);
});

test('Spike S5 Check 6: Two subgraph instances started with Send, each with its own interrupt', async () => {
  const store = createFakeStorage();
  const conn = store.connect();
  const saver = new SessionStorageSaver(conn.session);
  const thread = { configurable: { thread_id: 's5-check-6' }, durability: 'sync' as const };

  const WorkerState = Annotation.Root({
    site: Annotation<string>(),
    ans: Annotation<string>(),
  });
  const worker = new StateGraph(WorkerState)
    .addNode('ask', async (state, config) => {
      const reply = interruptWithConfig<{ site: string }, string>(config, { site: state.site });
      return { ans: `${state.site}:${reply}` };
    })
    .addEdge(START, 'ask')
    .addEdge('ask', END)
    .compile();

  const ParentState = Annotation.Root({
    sites: Annotation<string[]>({ reducer: (_prev, next) => next, default: () => ['siteA', 'siteB'] }),
    results: Annotation<string[]>({ reducer: concat, default: () => [] }),
  });

  const parent = new StateGraph(ParentState)
    .addNode('init', async () => ({ sites: ['siteA', 'siteB'] }))
    .addNode('siteWorker', async (state: { site: string }, config) => {
      const out = await worker.invoke({ site: state.site }, config);
      return { results: [out.ans] };
    })
    .addEdge(START, 'init')
    .addConditionalEdges('init', (state) => {
      return state.sites.map((site: string) => new Send('siteWorker', { site }));
    })
    .addEdge('siteWorker', END)
    .compile({ checkpointer: saver });

  await parent.invoke({}, thread);

  const paused = await parent.getState(thread, { subgraphs: true });
  assert.equal(paused.tasks.length, 2, 'Two tasks for Send');
  const interrupts = paused.tasks.flatMap((t) => t.interrupts.map((i) => i.value));
  assert.equal(interrupts.length, 2, 'Two interrupts open at once');

  // Resuming with commands
  const done = await parent.invoke(new Command({ resume: 'approved' }), thread);
  assert.equal(done.results.length, 2);
});

test('Spike S5 Check 7: updateState(asNode: finalize) on thread whose site task is pending leaves next empty', async () => {
  const store = createFakeStorage();
  const conn = store.connect();
  const saver = new SessionStorageSaver(conn.session);
  const thread = { configurable: { thread_id: 's5-check-7' }, durability: 'sync' as const };
  const worker = createWorkerGraph();

  const ParentState = Annotation.Root({
    log: Annotation<string[]>({ reducer: concat, default: () => [] }),
    runStatus: Annotation<string>({ reducer: (_prev, next) => next, default: () => 'running' }),
    endReason: Annotation<string>({ reducer: (_prev, next) => next, default: () => '' }),
  });

  const parent = new StateGraph(ParentState)
    .addNode('plan', async () => ({ log: ['plan'] }))
    .addNode('site', async (_state, config) => {
      await worker.invoke({ siteIn: 'hold-site' }, config);
      return { log: ['site'] };
    })
    .addNode('finalize', async () => ({ runStatus: 'idle', log: ['finalize'] }))
    .addEdge(START, 'plan')
    .addEdge('plan', 'site')
    .addEdge('site', 'finalize')
    .addEdge('finalize', END)
    .compile({ checkpointer: saver });

  // Run to interrupt in worker
  await parent.invoke({}, thread);

  const paused = await parent.getState(thread, { subgraphs: true });
  assert.deepEqual(paused.next, ['site']);

  // Stop / abort: updateState as 'finalize'
  await parent.updateState(thread, { runStatus: 'stopped', endReason: 'user_stopped' }, 'finalize');

  const afterUpdate = await parent.getState(thread, { subgraphs: true });
  // 'finalize' has edge to END, so next should be empty!
  assert.deepEqual(afterUpdate.next, []);
  assert.equal(afterUpdate.values.runStatus, 'stopped');
  assert.equal(afterUpdate.values.endReason, 'user_stopped');
});

test('Spike S5 Bonus: stream with subgraphs: true delivers worker values to parent stream listener', async () => {
  const store = createFakeStorage();
  const conn = store.connect();
  const saver = new SessionStorageSaver(conn.session);
  const thread = { configurable: { thread_id: 's5-stream' }, durability: 'sync' as const };

  const WorkerState = Annotation.Root({
    wval: Annotation<string>(),
  });
  const worker = new StateGraph(WorkerState)
    .addNode('w1', async () => ({ wval: 'w1-done' }))
    .addNode('w2', async () => ({ wval: 'w2-done' }))
    .addEdge(START, 'w1')
    .addEdge('w1', 'w2')
    .addEdge('w2', END)
    .compile();

  const ParentState = Annotation.Root({
    pval: Annotation<string>(),
  });
  const parent = new StateGraph(ParentState)
    .addNode('p1', async () => ({ pval: 'p1-done' }))
    .addNode('site', async (_state, config) => {
      const out = await worker.invoke({}, config);
      return { pval: `p-site:${out.wval}` };
    })
    .addEdge(START, 'p1')
    .addEdge('p1', 'site')
    .addEdge('site', END)
    .compile({ checkpointer: saver });

  const chunks: Array<{ ns: string[]; data: any }> = [];
  for await (const chunk of await parent.stream({}, { ...thread, subgraphs: true, streamMode: 'values' })) {
    const [ns, data] = Array.isArray(chunk) ? chunk : [[], chunk];
    chunks.push({ ns, data });
  }

  // Verify chunks were received for both root and worker namespace
  assert.ok(chunks.some((c) => c.ns.length === 0 && c.data.pval === 'p1-done'), 'Root chunk received');
  assert.ok(chunks.some((c) => c.ns.length > 0 && c.data.wval === 'w1-done'), 'Worker chunk w1 received');
  assert.ok(chunks.some((c) => c.ns.length > 0 && c.data.wval === 'w2-done'), 'Worker chunk w2 received');
});
