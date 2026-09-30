/**
 * Pruning in SessionStorageSaver: per namespace the newest 3 checkpoints stay, older cp and w keys
 * go, and so does every blob version that no kept checkpoint refers to (in the same batch). The
 * pending writes of the newest checkpoint of every namespace are never pruned. A finished worker
 * namespace is deleted as a whole with deleteNamespace().
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { INTERRUPT } from '@langchain/langgraph-checkpoint';
import { cfg, checkpointId, keysOfThread, putStep, rig, threadCfg } from '../helpers/checkpointFixtures.ts';
import type { SessionStorageSaver } from '../../src/background/checkpoint/SessionStorageSaver.ts';

const id = checkpointId;
type Saver = SessionStorageSaver;

/**
 * Checkpoint n of a namespace: `history` changes on every put, `plan` only on the first, `budget`
 * on every even put. So the versions are history n, plan 1, budget floor(n / 2) (none before n = 2).
 */
async function stepN(saver: Saver, thread: string, ns: string, n: number): Promise<void> {
  const values: Record<string, unknown> = { history: `history ${n}`, plan: 'the plan' };
  const versions: Record<string, number> = { history: n, plan: 1 };
  const changed = ['history'];
  if (n === 1) changed.push('plan');
  if (n >= 2) {
    values.budget = `budget ${Math.floor(n / 2)}`;
    versions.budget = Math.floor(n / 2);
    if (n % 2 === 0) changed.push('budget');
  }
  await putStep(saver, thread, ns, n, values, versions, changed);
}

const ixOf = (store: ReturnType<typeof rig>['store'], thread: string) =>
  store.session.data()[`sf:lg:ix:${thread}`] as { ns: Record<string, { ids: string[]; parents: Record<string, string> }> };

// ---------------------------------------------------------------------------------------------
// Keep 3 per namespace
// ---------------------------------------------------------------------------------------------

test('pruning: a namespace keeps its newest 3 checkpoints and the index says so', async () => {
  const { store, saver } = rig();
  for (let n = 1; n <= 6; n++) await stepN(saver, 't1', '', n);

  assert.deepEqual(ixOf(store, 't1').ns[''].ids, [id(6), id(5), id(4)]);
  assert.deepEqual(ixOf(store, 't1').ns[''].parents, { [id(6)]: id(5), [id(5)]: id(4), [id(4)]: id(3) }, 'the parent of an oldest kept checkpoint stays as a plain id');
  const checkpointKeys = store.session.keys().filter((key) => key.startsWith('sf:lg:cp:'));
  assert.deepEqual(checkpointKeys, [4, 5, 6].map((n) => `sf:lg:cp:t1:root:${id(n)}`));
  assert.equal(await saver.getTuple(cfg('t1', '', id(3))), undefined, 'a pruned checkpoint is gone');
  assert.equal((await saver.getTuple(cfg('t1')))?.checkpoint.id, id(6));
});

test('pruning: nothing is pruned below 3 checkpoints', async () => {
  const { store, saver } = rig();
  await stepN(saver, 't1', '', 1);
  await stepN(saver, 't1', '', 2);
  await stepN(saver, 't1', '', 3);
  assert.deepEqual(ixOf(store, 't1').ns[''].ids, [id(3), id(2), id(1)]);
  assert.equal(store.session.keys().filter((key) => key.startsWith('sf:lg:cp:')).length, 3);
});

test('pruning: blob versions that no kept checkpoint refers to are removed in the same batch', async () => {
  const { store, saver, host } = rig();
  for (let n = 1; n <= 6; n++) await stepN(saver, 't1', '', n);

  // Kept: checkpoints 4, 5, 6 -> history 4, 5, 6; plan 1 (shared by all); budget 2 (cps 4 and 5) and 3 (cp 6).
  assert.deepEqual(
    store.session.keys().filter((key) => key.startsWith('sf:lg:b:')),
    [
      'sf:lg:b:t1:root:budget:2',
      'sf:lg:b:t1:root:budget:3',
      'sf:lg:b:t1:root:history:4',
      'sf:lg:b:t1:root:history:5',
      'sf:lg:b:t1:root:history:6',
      'sf:lg:b:t1:root:plan:1',
    ],
    'history 1-3 and budget 1 are garbage collected; plan 1 stays because it is still referenced'
  );
  // The whole store: index, 3 checkpoints, 6 blobs.
  assert.equal(store.session.keys().length, 1 + 3 + 6);

  // The 6th put wrote its new keys with one set and removed the dropped ones with one remove.
  const removes = host.calls.filter((call) => call.api === 'storage.session.remove');
  assert.deepEqual([...(removes[removes.length - 1].args[0] as string[])].sort(), [
    'sf:lg:b:t1:root:budget:1', // only checkpoint 3 (and older) used budget 1
    'sf:lg:b:t1:root:history:3',
    `sf:lg:cp:t1:root:${id(3)}`,
    `sf:lg:w:t1:root:${id(3)}`,
  ]);
  // Every kept checkpoint still rebuilds its full channel_values.
  assert.deepEqual((await saver.getTuple(cfg('t1', '', id(4))))?.checkpoint.channel_values, { history: 'history 4', plan: 'the plan', budget: 'budget 2' });
  assert.deepEqual((await saver.getTuple(cfg('t1', '', id(6))))?.checkpoint.channel_values, { history: 'history 6', plan: 'the plan', budget: 'budget 3' });
});

test('pruning: a blob shared by a dropped and a kept checkpoint is kept', async () => {
  const { store, saver } = rig();
  // `shared` never changes after put 1, so every checkpoint refers to shared:1.
  for (let n = 1; n <= 5; n++) {
    await putStep(saver, 't1', '', n, { shared: 'same', own: n }, { shared: 1, own: n }, n === 1 ? ['shared', 'own'] : ['own']);
  }
  assert.ok(store.session.has('sf:lg:b:t1:root:shared:1'));
  assert.deepEqual((await saver.getTuple(cfg('t1')))?.checkpoint.channel_values, { shared: 'same', own: 5 });
  assert.deepEqual(store.session.keys().filter((key) => key.startsWith('sf:lg:b:t1:root:own:')), ['sf:lg:b:t1:root:own:3', 'sf:lg:b:t1:root:own:4', 'sf:lg:b:t1:root:own:5']);
});

test('pruning: a blob used by a dropped checkpoint and by an older kept one (not the newest) is kept', async () => {
  const { store, saver } = rig();
  // x:1 is referenced by checkpoints 1 and 2, x:2 by 3 and 4. After put 4 the kept ones are 4, 3, 2 and checkpoint 1 is dropped.
  await putStep(saver, 't1', '', 1, { x: 'first' }, { x: 1 }, ['x']);
  await putStep(saver, 't1', '', 2, { x: 'first' }, { x: 1 }, []);
  await putStep(saver, 't1', '', 3, { x: 'second' }, { x: 2 }, ['x']);
  await putStep(saver, 't1', '', 4, { x: 'second' }, { x: 2 }, []);

  assert.ok(store.session.has('sf:lg:b:t1:root:x:1'), 'checkpoint 2 is still kept and needs x:1');
  assert.equal((await saver.getTuple(cfg('t1', '', id(2))))?.checkpoint.channel_values.x, 'first');
  await putStep(saver, 't1', '', 5, { x: 'second' }, { x: 2 }, []);
  assert.equal(store.session.has('sf:lg:b:t1:root:x:1'), false, 'once checkpoint 2 is dropped too, x:1 is garbage');
  assert.ok(store.session.has('sf:lg:b:t1:root:x:2'));
});

test('pruning: a put on one namespace does not touch another, and each namespace keeps its own 3', async () => {
  const { store, saver } = rig();
  await stepN(saver, 't1', 'site:a', 1);
  await stepN(saver, 't1', 'site:a', 2);
  for (let n = 1; n <= 5; n++) await stepN(saver, 't1', '', n);
  for (let n = 1; n <= 4; n++) await stepN(saver, 't1', 'site:b', n);

  const index = ixOf(store, 't1');
  assert.deepEqual(index.ns['site:a'].ids, [id(2), id(1)], 'a namespace with 2 checkpoints keeps both');
  assert.deepEqual(index.ns[''].ids, [id(5), id(4), id(3)]);
  assert.deepEqual(index.ns['site:b'].ids, [id(4), id(3), id(2)]);
  assert.equal((await saver.getTuple(cfg('t1', 'site:a', id(1))))?.checkpoint.channel_values.history, 'history 1');
});

test('pruning: threads are independent', async () => {
  const { store, saver } = rig();
  for (let n = 1; n <= 5; n++) await stepN(saver, 'a', '', n);
  await stepN(saver, 'b', '', 1);
  await stepN(saver, 'b', '', 2);
  assert.equal(ixOf(store, 'a').ns[''].ids.length, 3);
  assert.equal(ixOf(store, 'b').ns[''].ids.length, 2);
  assert.equal(keysOfThread(store, 'b').filter((key) => key.startsWith('sf:lg:cp:')).length, 2);
});

test('pruning: putting the same checkpoint id twice does not duplicate it in the index', async () => {
  const { store, saver } = rig();
  await stepN(saver, 't1', '', 1);
  await stepN(saver, 't1', '', 2);
  await stepN(saver, 't1', '', 2);
  assert.deepEqual(ixOf(store, 't1').ns[''].ids, [id(2), id(1)]);
});

test('pruning: a checkpoint put out of order still lands in id order', async () => {
  const { store, saver } = rig();
  await stepN(saver, 't1', '', 3);
  await stepN(saver, 't1', '', 1);
  await stepN(saver, 't1', '', 2);
  assert.deepEqual(ixOf(store, 't1').ns[''].ids, [id(3), id(2), id(1)]);
  assert.equal((await saver.getTuple(cfg('t1')))?.checkpoint.id, id(3));
});

// ---------------------------------------------------------------------------------------------
// Pending writes
// ---------------------------------------------------------------------------------------------

test('pending writes: the writes of a pruned checkpoint go, the writes of every kept checkpoint stay', async () => {
  const { store, saver } = rig();
  await stepN(saver, 't1', '', 1);
  await saver.putWrites(cfg('t1', '', id(1)), [['x', 'w1']], 'task-1');
  await stepN(saver, 't1', '', 2);
  await saver.putWrites(cfg('t1', '', id(2)), [['x', 'w2']], 'task-2');
  await stepN(saver, 't1', '', 3);
  await saver.putWrites(cfg('t1', '', id(3)), [['x', 'w3']], 'task-3');
  assert.equal(store.session.keys().filter((key) => key.startsWith('sf:lg:w:')).length, 3);

  await stepN(saver, 't1', '', 4);
  assert.deepEqual(
    store.session.keys().filter((key) => key.startsWith('sf:lg:w:')),
    [`sf:lg:w:t1:root:${id(2)}`, `sf:lg:w:t1:root:${id(3)}`],
    'checkpoint 1 dropped out of the newest 3, so its writes went with it'
  );
  assert.deepEqual((await saver.getTuple(cfg('t1', '', id(3))))?.pendingWrites, [['task-3', 'x', 'w3']]);
});

test('pending writes: the interrupt of the newest checkpoint of every namespace survives pruning of the others', async () => {
  const { saver } = rig();
  // The orchestrator is paused in its `site` task, and the worker is paused in its hold.
  for (let n = 1; n <= 2; n++) await stepN(saver, 't1', '', n);
  await saver.putWrites(cfg('t1', '', id(2)), [[INTERRUPT, { value: 'site task interrupt' }]], 'site-task');
  for (let n = 1; n <= 2; n++) await stepN(saver, 't1', 'site:a', n);
  await saver.putWrites(cfg('t1', 'site:a', id(2)), [[INTERRUPT, { value: 'ask the user' }]], 'hold-task');

  // The worker keeps running (its own puts prune only the worker namespace).
  for (let n = 3; n <= 9; n++) await stepN(saver, 't1', 'site:b', n);
  await stepN(saver, 't1', 'site:a', 3);

  const root = await saver.getTuple(cfg('t1', ''));
  assert.equal(root?.checkpoint.id, id(2));
  assert.deepEqual(root?.pendingWrites, [['site-task', INTERRUPT, { value: 'site task interrupt' }]]);
  const worker = await saver.getTuple(cfg('t1', 'site:a', id(2)));
  assert.deepEqual(worker?.pendingWrites, [['hold-task', INTERRUPT, { value: 'ask the user' }]], 'still there, one checkpoint behind the head, inside the newest 3');
});

test('pending writes: a resume keeps the interrupt and the resume value on the head checkpoint through the next puts', async () => {
  const { saver } = rig();
  for (let n = 1; n <= 3; n++) await stepN(saver, 't1', '', n);
  await saver.putWrites(cfg('t1', '', id(3)), [[INTERRUPT, { value: 'q' }]], 'hold');
  await saver.putWrites(cfg('t1', '', id(3)), [['__resume__', 'yes']], '00000000-0000-0000-0000-000000000000');
  const head = await saver.getTuple(cfg('t1'));
  assert.equal(head?.pendingWrites?.length, 2);
  await stepN(saver, 't1', '', 4);
  assert.equal((await saver.getTuple(cfg('t1', '', id(3))))?.pendingWrites?.length, 2, 'the old head is still inside the newest 3');
  assert.deepEqual((await saver.getTuple(cfg('t1')))?.pendingWrites, [], 'the new head has none');
});

// ---------------------------------------------------------------------------------------------
// deleteNamespace
// ---------------------------------------------------------------------------------------------

async function withWorkers(): Promise<ReturnType<typeof rig>> {
  const r = rig();
  for (let n = 1; n <= 2; n++) await stepN(r.saver, 't1', '', n);
  for (let n = 1; n <= 3; n++) await stepN(r.saver, 't1', 'site:a', n);
  await r.saver.putWrites(cfg('t1', 'site:a', id(3)), [[INTERRUPT, 'q']], 'w-a');
  for (let n = 1; n <= 2; n++) await stepN(r.saver, 't1', 'site:a|inner:z', n);
  for (let n = 1; n <= 2; n++) await stepN(r.saver, 't1', 'site:ab', n);
  for (let n = 1; n <= 2; n++) await stepN(r.saver, 't2', 'site:a', n);
  return r;
}

test('deleteNamespace: removes the cp, b and w keys and the index entry of a finished worker namespace, and its nested namespaces', async () => {
  const { store, saver } = await withWorkers();
  const before = store.session.keys();
  assert.ok(before.some((key) => key.startsWith('sf:lg:w:t1:site%3Aa:')));

  await saver.deleteNamespace('t1', 'site:a');

  const isWorkerA = (key: string) => /^sf:lg:(cp|b|w):t1:site%3Aa(%7C[^:]*)?:/.test(key);
  assert.equal(store.session.keys().filter(isWorkerA).length, 0, 'no key of site:a or site:a|inner:z is left');
  assert.deepEqual(Object.keys(ixOf(store, 't1').ns).sort(), ['', 'site:ab'], 'site:ab is a different namespace, not a nested one');
  assert.deepEqual(store.session.keys(), before.filter((key) => !isWorkerA(key)), 'everything else is untouched');
  assert.equal(await saver.getTuple(cfg('t1', 'site:a')), undefined);
  assert.equal(await saver.getTuple(cfg('t1', 'site:a|inner:z')), undefined);
  assert.equal((await saver.getTuple(cfg('t1', 'site:ab')))?.checkpoint.id, id(2));
  assert.equal((await saver.getTuple(cfg('t1', '')))?.checkpoint.id, id(2));
  assert.equal((await saver.getTuple(cfg('t2', 'site:a')))?.checkpoint.id, id(2), 'another thread\'s namespace of the same name stays');
});

test('deleteNamespace: the parent checkpoint and its blobs are intact, and list no longer shows the namespace', async () => {
  const { saver } = await withWorkers();
  await saver.deleteNamespace('t1', 'site:a');
  const seen = new Set<string>();
  for await (const tuple of saver.list(threadCfg('t1'))) seen.add(String(tuple.config.configurable?.checkpoint_ns));
  assert.deepEqual([...seen].sort(), ['', 'site:ab']);
  assert.deepEqual((await saver.getTuple(cfg('t1')))?.checkpoint.channel_values, { history: 'history 2', plan: 'the plan', budget: 'budget 1' });
});

test('deleteNamespace: a namespace that does not exist is a no-op, and the root namespace is refused', async () => {
  const { store, saver } = await withWorkers();
  const before = store.session.keys();
  await saver.deleteNamespace('t1', 'site:none');
  await saver.deleteNamespace('nobody', 'site:a');
  assert.deepEqual(store.session.keys(), before);
  await assert.rejects(() => saver.deleteNamespace('t1', ''), /root namespace is deleted with deleteThread/);
  assert.deepEqual(store.session.keys(), before);
});

test('deleteNamespace: a namespace that was deleted can be started again', async () => {
  const { store, saver } = await withWorkers();
  await saver.deleteNamespace('t1', 'site:a');
  await stepN(saver, 't1', 'site:a', 1);
  assert.deepEqual(ixOf(store, 't1').ns['site:a'].ids, [id(1)]);
  assert.equal((await saver.getTuple(cfg('t1', 'site:a')))?.checkpoint.channel_values.history, 'history 1');
});

test('deleteNamespace: after deleteThread it does nothing (the thread is a tombstone)', async () => {
  const { store, saver } = await withWorkers();
  await saver.deleteThread('t1');
  await saver.deleteNamespace('t1', 'site:a');
  assert.deepEqual(keysOfThread(store, 't1'), []);
});
