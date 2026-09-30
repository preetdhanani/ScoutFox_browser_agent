/**
 * The interrupt shim, in Node with the /web entry of LangGraph (which, like the MV3 service worker,
 * has no AsyncLocalStorage). The stock interrupt() cannot find its node config there, and
 * interruptWithConfig() can, in a flat graph and inside a subgraph. It also guards the pinned
 * versions, because the shim uses two internal Symbol.for keys.
 *
 * Only /web is imported (never '@langchain/langgraph'), because the main entry installs an
 * AsyncLocalStorage and the stock interrupt() would then work in Node.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Annotation, Command, END, MemorySaver, START, StateGraph, interrupt } from '@langchain/langgraph/web';
import { interruptWithConfig } from '../../src/background/graph/interrupt.ts';
import { buildFlatGraph, buildNestedGraph, flatCalls, nestedCalls } from '../helpers/holdGraphs.ts';

const ALS_KEY = Symbol.for('ls:tracing_async_local_storage');
const slots = globalThis as Record<symbol, unknown>;
const THREAD = { configurable: { thread_id: 'shim' }, durability: 'sync' as const };
const OUTSIDE = /Called interrupt\(\) outside the context of a graph/;

// ---------------------------------------------------------------------------------------------
// The stock interrupt() fails, the shim works
// ---------------------------------------------------------------------------------------------

test('the stock interrupt() throws outside a graph run in Node', () => {
  assert.equal(Object.hasOwn(slots, ALS_KEY), false, 'no AsyncLocalStorage is installed by the /web entry');
  assert.throws(() => interrupt('question'), OUTSIDE);
});

test('the stock interrupt() also throws inside a node of a running graph, because there is no AsyncLocalStorage', async () => {
  const State = Annotation.Root({ answer: Annotation<string>() });
  const plain = new StateGraph(State)
    .addNode('hold', async () => ({ answer: String(interrupt({ question: 'approve?' })) }))
    .addEdge(START, 'hold')
    .addEdge('hold', END)
    .compile({ checkpointer: new MemorySaver() });
  await assert.rejects(() => plain.invoke({}, { configurable: { thread_id: 'plain' } }), OUTSIDE);
});

test('flat graph: the shim pauses at the interrupt and Command({resume}) continues from it', async () => {
  const calls = flatCalls();
  const graph = buildFlatGraph(new MemorySaver(), calls);

  await graph.invoke({}, THREAD);
  const paused = await graph.getState(THREAD);
  assert.deepEqual(paused.next, ['hold']);
  assert.deepEqual(paused.values.log, ['a']);
  assert.equal(paused.tasks.length, 1);
  assert.equal(paused.tasks[0].name, 'hold');
  assert.deepEqual(paused.tasks[0].interrupts.map((entry) => entry.value), [{ question: 'approve?' }]);

  const done = await graph.invoke(new Command({ resume: 'yes' }), THREAD);
  assert.deepEqual(done.log, ['a', 'hold:yes', 'c']);
  assert.equal(done.count, 111);
  assert.deepEqual(await graph.getState(THREAD).then((snapshot) => snapshot.next), []);
  // The hold re-ran on resume, but only the code after the interrupt did work; earlier nodes were not run again.
  assert.deepEqual(calls, { a: 1, holdAfterInterrupt: 1, c: 1 });
});

test('subgraph: the shim inside the worker pauses the whole thread and Command({resume}) through the parent continues the worker', async () => {
  const calls = nestedCalls();
  const graph = buildNestedGraph(new MemorySaver(), calls);

  await graph.invoke({}, THREAD);
  const paused = await graph.getState(THREAD, { subgraphs: true });
  assert.deepEqual(paused.next, ['site']);
  const site = paused.tasks[0];
  assert.equal(site.name, 'site');
  assert.deepEqual(site.interrupts.map((entry) => entry.value), [{ question: 'which offer?' }], 'the worker interrupt surfaces through the site task');
  // The worker's private channels live in the worker, never in the parent state.
  assert.deepEqual(Object.keys(paused.values).sort(), ['log', 'results']);

  const done = await graph.invoke(new Command({ resume: 'offer 2' }), THREAD);
  assert.deepEqual(done.results, ['shop-a|open>hold:offer 2']);
  assert.deepEqual(done.log, ['plan', 'site', 'summary']);
  assert.deepEqual(Object.keys(done).sort(), ['log', 'results'], 'the parent state has none of the worker channels afterwards');
  // `site` runs again on resume, and its invoke() picks the worker up from its checkpoint: open ran once.
  assert.deepEqual(calls, { plan: 1, site: 2, open: 1, holdAfterInterrupt: 1, summary: 1 });
});

test('subgraph: the worker state and its interrupt are saved in the worker namespace, not in the parent one', async () => {
  const saver = new MemorySaver();
  const graph = buildNestedGraph(saver);
  await graph.invoke({}, THREAD);

  const namespaces = new Set<string>();
  for await (const tuple of saver.list({ configurable: { thread_id: 'shim' } })) namespaces.add(String(tuple.config.configurable?.checkpoint_ns));
  const workerNamespaces = [...namespaces].filter((ns) => ns !== '');
  assert.equal(workerNamespaces.length, 1, `one worker namespace next to the root: ${[...namespaces].map((ns) => JSON.stringify(ns)).join(', ')}`);
  assert.match(workerNamespaces[0], /^site:/);

  const isInterrupt = ([, channel]: [string, string, unknown]) => channel === '__interrupt__';
  const worker = await saver.getTuple({ configurable: { thread_id: 'shim', checkpoint_ns: workerNamespaces[0] } });
  assert.deepEqual(worker?.checkpoint.channel_values.steps, ['open']);
  assert.equal(worker?.checkpoint.channel_values.page, 'page of shop-a');
  assert.equal(worker?.pendingWrites?.filter(isInterrupt).length, 1);
  const root = await saver.getTuple({ configurable: { thread_id: 'shim', checkpoint_ns: '' } });
  assert.equal(root?.checkpoint.channel_values.steps, undefined);
  // The root checkpoint carries the interrupt of its `site` task as well, so the parent pauses.
  assert.equal(root?.pendingWrites?.filter(isInterrupt).length, 1);
});

// ---------------------------------------------------------------------------------------------
// The one-shot slot is put back exactly
// ---------------------------------------------------------------------------------------------

test('the shim leaves no trace: the slot is absent again after a pause and after a resume', async () => {
  const seen: Array<boolean | string> = [];
  const State = Annotation.Root({ answer: Annotation<string>() });
  const graph = new StateGraph(State)
    .addNode('hold', async (_state, config) => {
      try {
        const answer = interruptWithConfig<string, string>(config, 'question');
        seen.push(`after return, slot present: ${Object.hasOwn(slots, ALS_KEY)}`);
        return { answer };
      } catch (error) {
        seen.push(`after throw, slot present: ${Object.hasOwn(slots, ALS_KEY)}`);
        throw error;
      }
    })
    .addEdge(START, 'hold')
    .addEdge('hold', END)
    .compile({ checkpointer: new MemorySaver() });

  await graph.invoke({}, THREAD);
  await graph.invoke(new Command({ resume: 'ok' }), THREAD);
  assert.deepEqual(seen, ['after throw, slot present: false', 'after return, slot present: false']);
  assert.equal(Object.hasOwn(slots, ALS_KEY), false);
  assert.throws(() => interrupt('x'), OUTSIDE, 'a stock interrupt() outside a graph still throws afterwards');
});

test('the shim puts back the store it found (the same object), also when the interrupt throws', async () => {
  const found = { getStore: () => undefined, run: (_store: unknown, callback: () => unknown) => callback(), enterWith() {} };
  slots[ALS_KEY] = found;
  try {
    const seen: unknown[] = [];
    const State = Annotation.Root({ answer: Annotation<string>() });
    const graph = new StateGraph(State)
      .addNode('hold', async (_state, config) => {
        try {
          return { answer: interruptWithConfig<string, string>(config, 'question') };
        } finally {
          seen.push(slots[ALS_KEY]);
        }
      })
      .addEdge(START, 'hold')
      .addEdge('hold', END)
      .compile({ checkpointer: new MemorySaver() });

    await graph.invoke({}, THREAD);
    await graph.invoke(new Command({ resume: 'ok' }), THREAD);
    assert.equal(seen.length, 2);
    assert.ok(seen.every((slot) => slot === found));
    assert.equal(slots[ALS_KEY], found);
  } finally {
    delete slots[ALS_KEY];
  }
});

test('the shim only hands out the config it was given, for the duration of the call', () => {
  // No graph, no checkpointer in this config: the stock interrupt() finds the config (so it gets past
  // "outside the context of a graph") and then reports the next missing piece.
  assert.throws(() => interruptWithConfig({ configurable: {} }, 'x'), /No checkpointer set/);
  assert.equal(Object.hasOwn(slots, ALS_KEY), false);
  assert.throws(() => interruptWithConfig({}, 'x'), /No configurable found in config/);
  assert.equal(Object.hasOwn(slots, ALS_KEY), false);
});

// ---------------------------------------------------------------------------------------------
// The pinned versions
// ---------------------------------------------------------------------------------------------

const ROOT = join(import.meta.dirname, '..', '..');
const readJson = (file: string) => JSON.parse(readFileSync(join(ROOT, file), 'utf8')) as Record<string, any>;
const LANGCHAIN_PACKAGES = ['@langchain/langgraph', '@langchain/core', '@langchain/langgraph-checkpoint'];

test('package.json pins the LangGraph packages exactly, and the installed versions are the pinned ones', () => {
  const manifest = readJson('package.json');
  for (const name of LANGCHAIN_PACKAGES) {
    const pinned = manifest.dependencies[name] as string;
    assert.match(pinned, /^\d+\.\d+\.\d+$/, `${name} must be an exact version, not a range (got ${pinned})`);
    const installed = readJson(`node_modules/${name}/package.json`).version;
    assert.equal(installed, pinned, `${name}: installed ${installed}, pinned ${pinned} - the shim needs re-checking when this changes`);
  }
});

test('one copy of @langchain/core is installed (overrides), because the shim and interrupt() must share its singletons', () => {
  const manifest = readJson('package.json');
  assert.equal(manifest.overrides['@langchain/core'], '$@langchain/core');
  for (const name of LANGCHAIN_PACKAGES.filter((entry) => entry !== '@langchain/core')) {
    assert.equal(existsSync(join(ROOT, 'node_modules', name, 'node_modules', '@langchain', 'core')), false, `${name} has its own copy of @langchain/core`);
  }
});
