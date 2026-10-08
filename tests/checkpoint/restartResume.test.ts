/**
 * SessionStorageSaver under real LangGraph graphs, across a simulated service-worker restart: the
 * first "worker" pauses at an interrupt and dies (its connection is killed), and a new one - a new
 * saver, a newly compiled graph, only the storage in common - resumes it with Command({resume}).
 * In a flat graph and in a subgraph (the design's `site` wrapper around a worker graph).
 *
 * Imports only the /web entry of LangGraph, like the service worker does.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Annotation, Command, END, START, StateGraph } from '@langchain/langgraph/web';
import { SessionStorageSaver } from '../../src/background/checkpoint/SessionStorageSaver.ts';
import { createFakeStorage, type FakeStorage, type StorageConnection } from '../helpers/fakeStorageSession.ts';
import { keysOfThread, threadCfg, writtenKeys } from '../helpers/checkpointFixtures.ts';
import { buildFlatGraph, buildNestedGraph, flatCalls, nestedCalls } from '../helpers/holdGraphs.ts';

const THREAD = '7';
const RUN = { configurable: { thread_id: THREAD }, durability: 'sync' as const };

/** A new "worker": its own connection to the shared store and its own saver. */
function boot(store: FakeStorage): { conn: StorageConnection; saver: SessionStorageSaver } {
  const conn = store.connect();
  return { conn, saver: new SessionStorageSaver(conn.session) };
}

const interruptValues = (snapshot: { tasks: Array<{ interrupts: Array<{ value?: unknown }> }> }) => snapshot.tasks.flatMap((task) => task.interrupts.map((entry) => entry.value));

// ---------------------------------------------------------------------------------------------
// Flat graph
// ---------------------------------------------------------------------------------------------

test('flat graph: after a worker restart the same interrupt is there and Command({resume}) finishes the run', async () => {
  const store = createFakeStorage();
  const first = boot(store);
  const graph1 = buildFlatGraph(first.saver, flatCalls());
  await graph1.invoke({}, RUN);
  const idBefore = interruptValues(await graph1.getState(RUN));
  assert.deepEqual(idBefore, [{ question: 'approve?' }]);
  first.conn.kill();

  const second = boot(store);
  const calls = flatCalls();
  const graph2 = buildFlatGraph(second.saver, calls);
  const paused = await graph2.getState(RUN);
  assert.deepEqual(paused.next, ['hold']);
  assert.deepEqual(paused.values.log, ['a']);
  assert.deepEqual(interruptValues(paused), [{ question: 'approve?' }]);

  const done = await graph2.invoke(new Command({ resume: 'yes' }), RUN);
  assert.deepEqual(done.log, ['a', 'hold:yes', 'c']);
  assert.equal(done.count, 111);
  assert.deepEqual(calls, { a: 0, holdAfterInterrupt: 1, c: 1 }, 'the new worker did not run node a again');
  assert.deepEqual((await graph2.getState(RUN)).next, []);
});

test('flat graph: the interrupt survives a second restart too, and the interrupt id does not change', async () => {
  const store = createFakeStorage();
  const first = boot(store);
  await buildFlatGraph(first.saver).invoke({}, RUN);
  first.conn.kill();

  const second = boot(store);
  const snapshot2 = await buildFlatGraph(second.saver).getState(RUN);
  second.conn.kill();

  const third = boot(store);
  const graph3 = buildFlatGraph(third.saver);
  const snapshot3 = await graph3.getState(RUN);
  assert.deepEqual(snapshot3.tasks.map((task) => task.interrupts), snapshot2.tasks.map((task) => task.interrupts));
  assert.equal(snapshot3.tasks[0].interrupts[0].id !== undefined, true);
  const done = await graph3.invoke(new Command({ resume: 'later' }), RUN);
  assert.deepEqual(done.log, ['a', 'hold:later', 'c']);
});

test('flat graph: a node that died in the middle is re-run with invoke(null), and finished nodes are not', async () => {
  const store = createFakeStorage();
  const State = Annotation.Root({ log: Annotation<string[]>({ reducer: (left, right) => left.concat(right), default: () => [] }) });
  const counts = { a: 0, b: 0, c: 0 };
  const build = (saver: SessionStorageSaver, crash: boolean) =>
    new StateGraph(State)
      .addNode('a', async () => {
        counts.a++;
        return { log: ['a'] };
      })
      .addNode('b', async () => {
        counts.b++;
        if (crash) throw new Error('the worker was stopped in the middle of b');
        return { log: ['b'] };
      })
      .addNode('c', async () => {
        counts.c++;
        return { log: ['c'] };
      })
      .addEdge(START, 'a')
      .addEdge('a', 'b')
      .addEdge('b', 'c')
      .addEdge('c', END)
      .compile({ checkpointer: saver });

  const first = boot(store);
  await assert.rejects(() => build(first.saver, true).invoke({}, RUN), /stopped in the middle of b/);
  first.conn.kill();

  const second = boot(store);
  const graph2 = build(second.saver, false);
  assert.deepEqual((await graph2.getState(RUN)).next, ['b'], 'the checkpoint is right before the node that died');
  const done = await graph2.invoke(null, RUN);
  assert.deepEqual(done.log, ['a', 'b', 'c']);
  assert.deepEqual(counts, { a: 1, b: 2, c: 1 });
});

// ---------------------------------------------------------------------------------------------
// Subgraph
// ---------------------------------------------------------------------------------------------

test('subgraph: after a worker restart Command({resume}) through the parent continues the worker from its own checkpoint', async () => {
  const store = createFakeStorage();
  const first = boot(store);
  await buildNestedGraph(first.saver, nestedCalls()).invoke({}, RUN);
  first.conn.kill();

  const second = boot(store);
  const calls = nestedCalls();
  const graph2 = buildNestedGraph(second.saver, calls);
  const paused = await graph2.getState(RUN);
  assert.deepEqual(paused.next, ['site']);
  assert.deepEqual(interruptValues(paused), [{ question: 'which offer?' }], 'the worker interrupt surfaces through the parent after the restart');
  assert.deepEqual(Object.keys(paused.values).sort(), ['log', 'results']);

  const done = await graph2.invoke(new Command({ resume: 'offer 2' }), RUN);
  assert.deepEqual(done.results, ['shop-a|open>hold:offer 2']);
  assert.deepEqual(done.log, ['plan', 'site', 'summary']);
  assert.deepEqual(Object.keys(done).sort(), ['log', 'results'], 'the parent state has none of the worker channels');
  // The new worker re-ran `site`, and the worker inside it resumed at its hold: `open` was not run again, `plan` neither.
  assert.deepEqual(calls, { plan: 0, site: 1, open: 0, holdAfterInterrupt: 1, summary: 1 });
});

test('subgraph: the interrupt survives a second restart, and the worker lives in its own namespace of the thread', async () => {
  const store = createFakeStorage();
  const first = boot(store);
  await buildNestedGraph(first.saver).invoke({}, RUN);
  first.conn.kill();
  const second = boot(store);
  await buildNestedGraph(second.saver).getState(RUN);
  second.conn.kill();

  const workerKeys = store.session.keys().filter((key) => key.startsWith(`sf:lg:cp:${THREAD}:site%3A`));
  assert.ok(workerKeys.length >= 1, `a worker namespace key exists: ${store.session.keys().join(', ')}`);
  const index = store.session.data()[`sf:lg:ix:${THREAD}`] as { ns: Record<string, { ids: string[] }> };
  const namespaces = Object.keys(index.ns);
  assert.equal(namespaces.length, 2);
  assert.ok(namespaces.includes('') && namespaces.some((ns) => /^site:[0-9a-f-]{36}$/.test(ns)), namespaces.join(' | '));

  const third = boot(store);
  const graph3 = buildNestedGraph(third.saver);
  assert.deepEqual(interruptValues(await graph3.getState(RUN)), [{ question: 'which offer?' }]);
  const done = await graph3.invoke(new Command({ resume: 'after two restarts' }), RUN);
  assert.deepEqual(done.results, ['shop-a|open>hold:after two restarts']);
});

test('subgraph: a finished worker namespace can be deleted while the parent keeps going, and deleteThread leaves nothing', async () => {
  const store = createFakeStorage();
  const first = boot(store);
  await buildNestedGraph(first.saver).invoke({}, RUN);
  first.conn.kill();

  const second = boot(store);
  const graph = buildNestedGraph(second.saver);
  const done = await graph.invoke(new Command({ resume: 'offer 1' }), RUN);
  assert.deepEqual(done.results, ['shop-a|open>hold:offer 1']);

  const index = store.session.data()[`sf:lg:ix:${THREAD}`] as { ns: Record<string, unknown> };
  const workerNs = Object.keys(index.ns).find((ns) => ns.startsWith('site:'));
  assert.ok(workerNs);
  await second.saver.deleteNamespace(THREAD, workerNs);
  assert.equal(store.session.keys().some((key) => key.includes('site%3A')), false, 'no key of the worker namespace is left');
  const after = await graph.getState(RUN);
  assert.deepEqual(after.next, []);
  assert.deepEqual(after.values.results, ['shop-a|open>hold:offer 1'], 'the parent state does not depend on the worker namespace');

  await second.saver.deleteThread(THREAD);
  assert.deepEqual(keysOfThread(store, THREAD), []);
  assert.deepEqual(store.session.keys(), []);
});

// ---------------------------------------------------------------------------------------------
// What the real loop hands to put()
// ---------------------------------------------------------------------------------------------

test('a real run: only the channels that changed are rewritten, and every namespace keeps at most 3 checkpoints', async () => {
  const store = createFakeStorage();
  const { conn, saver } = boot(store);
  const State = Annotation.Root({
    plan: Annotation<string>(),
    count: Annotation<number>(),
    history: Annotation<string[]>({ reducer: (left, right) => left.concat(right), default: () => [] }),
  });
  const graph = new StateGraph(State)
    .addNode('start', async () => ({ plan: 'the plan, written once', count: 0, history: ['start'] }))
    .addNode('step', async (state) => ({ count: state.count + 1, history: [`step ${state.count + 1}`] }))
    .addEdge(START, 'start')
    .addEdge('start', 'step')
    .addConditionalEdges('step', (state) => (state.count < 8 ? 'step' : END))
    .compile({ checkpointer: saver });

  const done = await graph.invoke({}, RUN);
  assert.equal(done.count, 8);
  assert.equal(done.history.length, 9);

  const written = writtenKeys(conn.host);
  const blobWrites = (channel: string) => written.filter((key) => key.startsWith(`sf:lg:b:${THREAD}:root:${channel}:`));
  assert.equal(blobWrites('plan').length, 1, 'the plan channel changed once, so its blob was written once');
  assert.equal(blobWrites('history').length, 9, 'history changed in every superstep that ran a node (start plus 8 steps)');
  assert.equal(blobWrites('count').length, 9);

  const index = store.session.data()[`sf:lg:ix:${THREAD}`] as { ns: Record<string, { ids: string[] }> };
  assert.equal(index.ns[''].ids.length, 3);
  assert.equal(store.session.keys().filter((key) => key.startsWith(`sf:lg:cp:${THREAD}:`)).length, 3);
  assert.equal(store.session.keys().filter((key) => key.startsWith(`sf:lg:b:${THREAD}:root:history:`)).length, 3, 'blob versions no kept checkpoint refers to are collected');
  assert.equal(store.session.keys().filter((key) => key.startsWith(`sf:lg:b:${THREAD}:root:plan:`)).length, 1);

  const final = await graph.getState(RUN);
  assert.equal(final.values.plan, 'the plan, written once');
  assert.equal(final.values.history.length, 9);
  const seen: number[] = [];
  for await (const snapshot of graph.getStateHistory(RUN)) seen.push(snapshot.metadata?.step ?? NaN);
  assert.deepEqual(seen, [seen[0], seen[0] - 1, seen[0] - 2], 'getStateHistory walks the 3 kept checkpoints');
});

test('a real run: list() and getTuple() are namespace-aware for the LangGraph loop, and list honours limit', async () => {
  const store = createFakeStorage();
  const first = boot(store);
  await buildNestedGraph(first.saver).invoke({}, RUN);

  const seen: string[] = [];
  for await (const tuple of first.saver.list(threadCfg(THREAD))) seen.push(String(tuple.config.configurable?.checkpoint_ns));
  assert.ok(seen.includes('') && seen.some((ns) => ns.startsWith('site:')));
  const rootOnly: string[] = [];
  for await (const tuple of first.saver.list({ configurable: { thread_id: THREAD, checkpoint_ns: '' } }, { limit: 2 })) rootOnly.push(String(tuple.config.configurable?.checkpoint_ns));
  assert.deepEqual(rootOnly, ['', '']);
});
