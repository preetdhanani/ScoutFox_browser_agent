/**
 * SessionStorageSaver on the fake chrome.storage.session: the key layout, put/getTuple/list/putWrites,
 * channel blobs (only the changed channels are written), base64 for non-JSON bytes, the per-thread
 * mutex, and deleteThread with tombstones. Pruning and quota have their own files.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { INTERRUPT } from '@langchain/langgraph-checkpoint';
import { SessionStorageSaver, type SessionArea } from '../../src/background/checkpoint/SessionStorageSaver.ts';
import { cfg, checkpointId, keysOfThread, makeCheckpoint, META, putStep, readEverything, rig, threadCfg, writtenKeys } from '../helpers/checkpointFixtures.ts';

const id = checkpointId;

// ---------------------------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------------------------

test('layout: a put writes the index, one checkpoint key and one blob per changed channel', async () => {
  const { store, saver } = rig();
  await putStep(saver, 't1', '', 1, { history: ['a'], plan: { steps: 1 } }, { history: 1, plan: 1 }, ['history', 'plan']);

  assert.deepEqual(store.session.keys(), [
    'sf:lg:b:t1:root:history:1',
    'sf:lg:b:t1:root:plan:1',
    `sf:lg:cp:t1:root:${id(1)}`,
    'sf:lg:ix:t1',
  ]);
  const data = store.session.data();
  assert.deepEqual(data['sf:lg:ix:t1'], { ns: { '': { ids: [id(1)], parents: {} } } });
  assert.deepEqual(data['sf:lg:b:t1:root:history:1'], ['json', '["a"]'], 'a JSON blob is the JSON text, not base64');
  assert.deepEqual(data['sf:lg:b:t1:root:plan:1'], ['json', '{"steps":1}']);

  const [checkpointBlob, metadataBlob, parentId] = data[`sf:lg:cp:t1:root:${id(1)}`] as [[string, string], [string, string], string | null];
  assert.equal(checkpointBlob[0], 'json');
  const storedCheckpoint = JSON.parse(checkpointBlob[1]);
  assert.equal('channel_values' in storedCheckpoint, false, 'the checkpoint blob has no channel_values');
  assert.deepEqual(storedCheckpoint.channel_versions, { history: 1, plan: 1 });
  assert.equal(storedCheckpoint.id, id(1));
  assert.deepEqual(JSON.parse(metadataBlob[1]), { source: 'loop', step: 1, parents: {} });
  assert.equal(parentId, null, 'a first checkpoint has no parent (stored as null, JSON has no undefined)');
});

test('layout: a namespace is percent-encoded in every key, and kept as it is in the index', async () => {
  const { store, saver } = rig();
  const ns = 'site:abc|open:def';
  await putStep(saver, 't1', ns, 1, { page: 'p' }, { page: 1 }, ['page']);
  await saver.putWrites(cfg('t1', ns, id(1)), [['ch', 1]], 'task-1');

  assert.deepEqual(store.session.keys(), [
    'sf:lg:b:t1:site%3Aabc%7Copen%3Adef:page:1',
    `sf:lg:cp:t1:site%3Aabc%7Copen%3Adef:${id(1)}`,
    'sf:lg:ix:t1',
    `sf:lg:w:t1:site%3Aabc%7Copen%3Adef:${id(1)}`,
  ]);
  assert.deepEqual(store.session.data()['sf:lg:ix:t1'], { ns: { [ns]: { ids: [id(1)], parents: {} } } });
  assert.deepEqual(store.session.data()[`sf:lg:w:t1:site%3Aabc%7Copen%3Adef:${id(1)}`], { 'task-1,0': ['task-1', 'ch', ['json', '1']] });
});

test('layout: the namespace "root" does not clash with the empty (orchestrator) namespace', async () => {
  const { store, saver } = rig();
  await putStep(saver, 't1', '', 1, { v: 'orchestrator' }, { v: 1 }, ['v']);
  await putStep(saver, 't1', 'root', 1, { v: 'named root' }, { v: 1 }, ['v']);

  assert.equal((await saver.getTuple(cfg('t1', '')))?.checkpoint.channel_values.v, 'orchestrator');
  assert.equal((await saver.getTuple(cfg('t1', 'root')))?.checkpoint.channel_values.v, 'named root');
  assert.equal(store.session.keys().filter((key) => key.startsWith('sf:lg:cp:')).length, 2);
  assert.ok(store.session.has(`sf:lg:cp:t1:%72oot:${id(1)}`));
});

test('layout: two threads never share a key', async () => {
  const { store, saver } = rig();
  await putStep(saver, '5', '', 1, { v: 'five' }, { v: 1 }, ['v']);
  await putStep(saver, '55', '', 1, { v: 'fifty-five' }, { v: 1 }, ['v']);
  const keys = store.session.keys();
  assert.equal(keys.filter((key) => key.includes(':5:')).length, 2, 'cp and b of thread 5');
  assert.equal(keys.filter((key) => key.includes(':55:')).length, 2, 'cp and b of thread 55');
  assert.equal((await saver.getTuple(cfg('5')))?.checkpoint.channel_values.v, 'five');
  assert.equal((await saver.getTuple(cfg('55')))?.checkpoint.channel_values.v, 'fifty-five');
});

test('a thread id with a colon is refused, because it could match another thread\'s keys', async () => {
  const { saver } = rig();
  await assert.rejects(() => putStep(saver, 'a:b', '', 1, {}, {}, []), /thread_id must be a non-empty string without ':'/);
  await assert.rejects(() => saver.getTuple(cfg('a:b')), /thread_id must be a non-empty string/);
  await assert.rejects(() => saver.deleteThread('a:b'), /thread_id must be a non-empty string/);
  await assert.rejects(() => saver.put({ configurable: {} }, makeCheckpoint(1, {}, {}), META, {}), /missing configurable.thread_id/);
});

// ---------------------------------------------------------------------------------------------
// put and getTuple
// ---------------------------------------------------------------------------------------------

test('round trip: put then getTuple returns the same checkpoint, metadata and values (Map, Set, nested data)', async () => {
  const { saver } = rig();
  const values = {
    history: [{ type: 'user', content: 'zoë 🦊' }, { type: 'action', n: 2 }],
    seen: new Set(['a', 'b']),
    byId: new Map([[1, 'x']]),
    nested: { deep: { list: [1, 2, { three: 3 }] }, nothing: null },
  };
  const versions = { history: 2, seen: 1, byId: 1, nested: 4 };
  const returned = await saver.put(cfg('t1'), makeCheckpoint(1, values, versions), { source: 'input', step: -1, parents: {} }, versions);
  assert.deepEqual(returned, { configurable: { thread_id: 't1', checkpoint_ns: '', checkpoint_id: id(1) } });

  const tuple = await saver.getTuple(cfg('t1'));
  assert.ok(tuple);
  assert.deepEqual(tuple.config, { configurable: { thread_id: 't1', checkpoint_ns: '', checkpoint_id: id(1) } });
  assert.deepEqual(tuple.checkpoint.channel_values, values);
  assert.deepEqual(tuple.checkpoint.channel_versions, versions);
  assert.equal(tuple.checkpoint.id, id(1));
  assert.equal(tuple.checkpoint.v, 4);
  assert.deepEqual(tuple.checkpoint.versions_seen, { node: versions });
  assert.deepEqual(tuple.metadata, { source: 'input', step: -1, parents: {} });
  assert.deepEqual(tuple.pendingWrites, []);
  assert.equal(tuple.parentConfig, undefined, 'a first checkpoint has no parentConfig');
});

test('getTuple: the newest checkpoint by default, a named one on request, and the parent link', async () => {
  const { saver } = rig();
  await putStep(saver, 't1', '', 1, { v: 'one' }, { v: 1 }, ['v']);
  await putStep(saver, 't1', '', 2, { v: 'two' }, { v: 2 }, ['v']);

  const newest = await saver.getTuple(cfg('t1'));
  assert.equal(newest?.checkpoint.id, id(2));
  assert.deepEqual(newest?.parentConfig, { configurable: { thread_id: 't1', checkpoint_ns: '', checkpoint_id: id(1) } });
  assert.equal(newest?.checkpoint.channel_values.v, 'two');

  const older = await saver.getTuple(cfg('t1', '', id(1)));
  assert.equal(older?.checkpoint.id, id(1));
  assert.equal(older?.checkpoint.channel_values.v, 'one', 'an older checkpoint keeps its own blob version');
  assert.equal(older?.parentConfig, undefined);

  assert.equal(await saver.getTuple(cfg('t1', '', 'no-such-id')), undefined);
  assert.equal(await saver.getTuple(cfg('unknown-thread')), undefined);
  assert.equal(await saver.getTuple({ configurable: {} }), undefined);
  assert.equal(await saver.getTuple(cfg('t1', 'site:none')), undefined);
});

test('namespaces: each namespace of a thread has its own checkpoints, and getTuple reads the one in config', async () => {
  const { saver } = rig();
  await putStep(saver, 't1', '', 1, { who: 'root' }, { who: 1 }, ['who']);
  await putStep(saver, 't1', 'site:a', 1, { who: 'worker a' }, { who: 1 }, ['who']);
  await putStep(saver, 't1', 'site:a', 2, { who: 'worker a 2' }, { who: 2 }, ['who']);

  assert.equal((await saver.getTuple(cfg('t1', '')))?.checkpoint.channel_values.who, 'root');
  assert.equal((await saver.getTuple(cfg('t1', 'site:a')))?.checkpoint.channel_values.who, 'worker a 2');
  assert.equal((await saver.getTuple(cfg('t1', 'site:a', id(1))))?.checkpoint.channel_values.who, 'worker a');
});

// ---------------------------------------------------------------------------------------------
// Blobs per channel version
// ---------------------------------------------------------------------------------------------

test('blobs: only the channels in newVersions are written, and an unchanged channel is not rewritten', async () => {
  const { store, saver, host } = rig();
  const history = Array.from({ length: 50 }, (_, index) => ({ type: 'thought', content: `turn ${index}` }));
  await putStep(saver, 't1', '', 1, { history, plan: { v: 1 }, budget: 10 }, { history: 1, plan: 1, budget: 1 }, ['history', 'plan', 'budget']);
  assert.equal(host.calls.filter((call) => call.api === 'storage.session.set').length, 1, 'one set call per put');

  // Step 2 changes only `budget`: history and plan keep their versions.
  await putStep(saver, 't1', '', 2, { history, plan: { v: 1 }, budget: 9 }, { history: 1, plan: 1, budget: 2 }, ['budget']);
  const secondSet = host.calls.filter((call) => call.api === 'storage.session.set')[1];
  assert.deepEqual(Object.keys(secondSet.args[0] as object).sort(), [`sf:lg:cp:t1:root:${id(2)}`, 'sf:lg:b:t1:root:budget:2', 'sf:lg:ix:t1'].sort());

  const historyWrites = writtenKeys(host).filter((key) => key === 'sf:lg:b:t1:root:history:1');
  assert.equal(historyWrites.length, 1, 'the history blob was written exactly once over two puts');
  assert.ok(store.session.has('sf:lg:b:t1:root:history:1'));

  // A read of either checkpoint rebuilds the full channel_values from the blobs its versions name.
  const two = await saver.getTuple(cfg('t1'));
  assert.deepEqual(two?.checkpoint.channel_values, { history, plan: { v: 1 }, budget: 9 });
  const one = await saver.getTuple(cfg('t1', '', id(1)));
  assert.deepEqual(one?.checkpoint.channel_values, { history, plan: { v: 1 }, budget: 10 });
});

test('blobs: a channel in newVersions with no value gets no blob and is left out of channel_values', async () => {
  const { store, saver } = rig();
  await putStep(saver, 't1', '', 1, { present: 1 }, { present: 1, emptied: 1 }, ['present', 'emptied']);
  assert.deepEqual(store.session.keys().filter((key) => key.startsWith('sf:lg:b:')), ['sf:lg:b:t1:root:present:1']);
  const tuple = await saver.getTuple(cfg('t1'));
  assert.deepEqual(tuple?.checkpoint.channel_values, { present: 1 });
  assert.deepEqual(tuple?.checkpoint.channel_versions, { present: 1, emptied: 1 });
});

test('blobs: without newVersions every channel is written (safe fallback)', async () => {
  const { store, saver } = rig();
  await saver.put(cfg('t1'), makeCheckpoint(1, { a: 1, b: 2 }, { a: 1, b: 1 }), META);
  assert.deepEqual(store.session.keys().filter((key) => key.startsWith('sf:lg:b:')), ['sf:lg:b:t1:root:a:1', 'sf:lg:b:t1:root:b:1']);
  assert.deepEqual((await saver.getTuple(cfg('t1')))?.checkpoint.channel_values, { a: 1, b: 2 });
});

test('bytes: non-JSON bytes round trip through base64, in channel values and in pending writes', async () => {
  const { store, saver } = rig();
  const bytes = Uint8Array.from({ length: 300 }, (_, index) => (index * 7) % 256); // covers 0..255 including 0x00 and 0xff
  bytes[0] = 0;
  bytes[1] = 255;
  await putStep(saver, 't1', '', 1, { raw: bytes, text: 'plain' }, { raw: 1, text: 1 }, ['raw', 'text']);
  await saver.putWrites(cfg('t1', '', id(1)), [['raw', bytes]], 'task-1');

  const stored = store.session.data()['sf:lg:b:t1:root:raw:1'] as [string, string];
  assert.equal(stored[0], 'b64:bytes');
  assert.equal(stored[1], Buffer.from(bytes).toString('base64'));
  assert.equal((store.session.data()['sf:lg:b:t1:root:text:1'] as [string, string])[0], 'json');

  const tuple = await saver.getTuple(cfg('t1'));
  const raw = tuple?.checkpoint.channel_values.raw;
  assert.ok(raw instanceof Uint8Array);
  assert.deepEqual([...raw], [...bytes]);
  const written = tuple?.pendingWrites?.[0];
  assert.equal(written?.[0], 'task-1');
  assert.equal(written?.[1], 'raw');
  assert.deepEqual([...(written?.[2] as Uint8Array)], [...bytes]);
});

test('bytes: a large byte value (100 KB) survives base64 in chunks', async () => {
  const { saver } = rig();
  const bytes = Uint8Array.from({ length: 100_000 }, (_, index) => (index * 31) % 256);
  await putStep(saver, 't1', '', 1, { raw: bytes }, { raw: 1 }, ['raw']);
  const raw = (await saver.getTuple(cfg('t1')))?.checkpoint.channel_values.raw as Uint8Array;
  assert.equal(raw.length, bytes.length);
  assert.ok(Buffer.from(raw).equals(Buffer.from(bytes)));
});

// ---------------------------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------------------------

async function collect(iterable: AsyncIterable<{ config: { configurable?: Record<string, unknown> } }>): Promise<string[]> {
  const out: string[] = [];
  for await (const tuple of iterable) out.push(`${tuple.config.configurable?.checkpoint_ns}#${String(tuple.config.configurable?.checkpoint_id).slice(-2)}`);
  return out;
}

async function threeAndTwo() {
  const r = rig();
  for (const n of [1, 2, 3]) {
    const metadata = { source: 'loop' as const, step: n, parents: {}, tag: n === 2 ? 'special' : 'plain' }; // LangGraph metadata may carry extra keys
    await putStep(r.saver, 't1', '', n, { v: n }, { v: n }, ['v'], metadata);
  }
  for (const n of [1, 2]) await putStep(r.saver, 't1', 'site:a', n, { v: n }, { v: n }, ['v']);
  await putStep(r.saver, 't2', '', 1, { v: 'other thread' }, { v: 1 }, ['v']);
  return r;
}

test('list: newest first, every namespace of the thread when no namespace is in the config', async () => {
  const { saver } = await threeAndTwo();
  assert.deepEqual(await collect(saver.list(threadCfg('t1'))), ['#03', '#02', '#01', 'site:a#02', 'site:a#01']);
});

test('list: config.checkpoint_ns filters by namespace, including the root namespace', async () => {
  const { saver } = await threeAndTwo();
  assert.deepEqual(await collect(saver.list(cfg('t1', ''))), ['#03', '#02', '#01']);
  assert.deepEqual(await collect(saver.list(cfg('t1', 'site:a'))), ['site:a#02', 'site:a#01']);
  assert.deepEqual(await collect(saver.list(cfg('t1', 'site:none'))), []);
});

test('list: limit, before, filter and checkpoint_id', async () => {
  const { saver } = await threeAndTwo();
  assert.deepEqual(await collect(saver.list(cfg('t1', ''), { limit: 2 })), ['#03', '#02']);
  assert.deepEqual(await collect(saver.list(cfg('t1', ''), { limit: 0 })), []);
  assert.deepEqual(await collect(saver.list(threadCfg('t1'), { limit: 4 })), ['#03', '#02', '#01', 'site:a#02'], 'limit counts across namespaces');
  assert.deepEqual(await collect(saver.list(cfg('t1', ''), { before: cfg('t1', '', id(3)) })), ['#02', '#01']);
  assert.deepEqual(await collect(saver.list(cfg('t1', ''), { before: cfg('t1', '', id(3)), limit: 1 })), ['#02']);
  assert.deepEqual(await collect(saver.list(cfg('t1', ''), { before: cfg('t1', '', id(1)) })), []);
  assert.deepEqual(await collect(saver.list(cfg('t1', ''), { filter: { tag: 'special' } })), ['#02']);
  assert.deepEqual(await collect(saver.list(cfg('t1', ''), { filter: { source: 'loop', step: 3 } })), ['#03']);
  assert.deepEqual(await collect(saver.list(cfg('t1', ''), { filter: { tag: 'nobody' } })), []);
  assert.deepEqual(await collect(saver.list(cfg('t1', '', id(2)))), ['#02']);
});

test('list: tuples carry channel values, parents and pending writes', async () => {
  const { saver } = await threeAndTwo();
  await saver.putWrites(cfg('t1', '', id(3)), [['out', 'x']], 'task-9');
  const tuples: Awaited<ReturnType<SessionStorageSaver['getTuple']>>[] = [];
  for await (const tuple of saver.list(cfg('t1', ''))) tuples.push(tuple);
  assert.deepEqual(tuples.map((tuple) => tuple?.checkpoint.channel_values.v), [3, 2, 1]);
  assert.deepEqual(tuples[0]?.pendingWrites, [['task-9', 'out', 'x']]);
  assert.equal(tuples[0]?.parentConfig?.configurable?.checkpoint_id, id(2));
  assert.equal(tuples[2]?.parentConfig, undefined);
});

test('list: without a thread it walks every thread, and it finds them with getKeys (never get(null))', async () => {
  const { saver, host } = await threeAndTwo();
  const all = await collect(saver.list({ configurable: {} }));
  assert.equal(all.length, 3 + 2 + 1);
  assert.equal(readEverything(host), false);
  assert.ok(host.calls.some((call) => call.api === 'storage.session.getKeys'));
});

// ---------------------------------------------------------------------------------------------
// putWrites
// ---------------------------------------------------------------------------------------------

test('putWrites: pending writes come back with the checkpoint, in write order', async () => {
  const { saver } = rig();
  await putStep(saver, 't1', '', 1, { v: 1 }, { v: 1 }, ['v']);
  await saver.putWrites(cfg('t1', '', id(1)), [['a', 1], ['b', { two: 2 }]], 'task-1');
  await saver.putWrites(cfg('t1', '', id(1)), [['c', 'three']], 'task-2');
  const tuple = await saver.getTuple(cfg('t1'));
  assert.deepEqual(tuple?.pendingWrites, [['task-1', 'a', 1], ['task-1', 'b', { two: 2 }], ['task-2', 'c', 'three']]);
});

test('putWrites: a regular write is kept once, an interrupt write is replaced', async () => {
  const { saver } = rig();
  await putStep(saver, 't1', '', 1, { v: 1 }, { v: 1 }, ['v']);
  const at = cfg('t1', '', id(1));
  await saver.putWrites(at, [['a', 'first']], 'task-1');
  await saver.putWrites(at, [['a', 'second']], 'task-1');
  await saver.putWrites(at, [[INTERRUPT, { value: 'old' }]], 'task-1');
  await saver.putWrites(at, [[INTERRUPT, { value: 'new' }]], 'task-1');
  const tuple = await saver.getTuple(cfg('t1'));
  assert.deepEqual(tuple?.pendingWrites, [['task-1', 'a', 'first'], ['task-1', INTERRUPT, { value: 'new' }]]);
});

test('putWrites: a checkpoint id is required', async () => {
  const { saver } = rig();
  await assert.rejects(() => saver.putWrites(cfg('t1'), [['a', 1]], 'task-1'), /missing configurable.checkpoint_id/);
  await assert.rejects(() => saver.putWrites({ configurable: { checkpoint_id: id(1) } }, [['a', 1]], 'task-1'), /missing configurable.thread_id/);
});

test('putWrites: writes belong to their namespace only', async () => {
  const { saver } = rig();
  await putStep(saver, 't1', '', 1, { v: 1 }, { v: 1 }, ['v']);
  await putStep(saver, 't1', 'site:a', 1, { v: 1 }, { v: 1 }, ['v']);
  await saver.putWrites(cfg('t1', 'site:a', id(1)), [[INTERRUPT, 'worker question']], 'task-w');
  assert.deepEqual((await saver.getTuple(cfg('t1', '')))?.pendingWrites, []);
  assert.deepEqual((await saver.getTuple(cfg('t1', 'site:a')))?.pendingWrites, [['task-w', INTERRUPT, 'worker question']]);
});

// ---------------------------------------------------------------------------------------------
// The mutex
// ---------------------------------------------------------------------------------------------

test('mutex: getTuple waits for a put that is still in flight', async () => {
  const { saver } = rig({ session: { delayMs: 4 } });
  const pending = putStep(saver, 't1', '', 1, { v: 'in flight' }, { v: 1 }, ['v']); // not awaited
  const seen = await saver.getTuple(cfg('t1'));
  assert.equal(seen?.checkpoint.channel_values.v, 'in flight');
  await pending;
});

test('mutex: getTuple waits for putWrites in flight, and list waits too', async () => {
  const { saver } = rig({ session: { delayMs: 3 } });
  await putStep(saver, 't1', '', 1, { v: 1 }, { v: 1 }, ['v']);
  const pending = saver.putWrites(cfg('t1', '', id(1)), [[INTERRUPT, 'q']], 'task-1'); // not awaited
  assert.deepEqual((await saver.getTuple(cfg('t1')))?.pendingWrites, [['task-1', INTERRUPT, 'q']]);
  await pending;
  const pendingAgain = saver.putWrites(cfg('t1', '', id(1)), [['x', 1]], 'task-2');
  const listed: number[] = [];
  for await (const tuple of saver.list(cfg('t1'))) listed.push(tuple.pendingWrites?.length ?? 0);
  assert.deepEqual(listed, [2]);
  await pendingAgain;
});

test('mutex: many concurrent puts on one thread lose nothing and keep call order', async () => {
  const { store, saver } = rig({ session: { delayMs: 1 } });
  const puts: Promise<unknown>[] = [];
  for (let n = 1; n <= 12; n++) puts.push(putStep(saver, 't1', '', n, { v: n }, { v: n }, ['v']));
  await Promise.all(puts);
  const index = store.session.data()['sf:lg:ix:t1'] as { ns: Record<string, { ids: string[]; parents: Record<string, string> }> };
  assert.deepEqual(index.ns[''].ids, [id(12), id(11), id(10)]);
  assert.deepEqual(index.ns[''].parents, { [id(12)]: id(11), [id(11)]: id(10), [id(10)]: id(9) });
  assert.equal((await saver.getTuple(cfg('t1')))?.checkpoint.channel_values.v, 12);
});

test('mutex: concurrent putWrites from many tasks all land', async () => {
  const { saver } = rig({ session: { delayMs: 1 } });
  await putStep(saver, 't1', '', 1, { v: 1 }, { v: 1 }, ['v']);
  await Promise.all(Array.from({ length: 10 }, (_, index) => saver.putWrites(cfg('t1', '', id(1)), [[`ch${index}`, index]], `task-${index}`)));
  const writes = (await saver.getTuple(cfg('t1')))?.pendingWrites ?? [];
  assert.deepEqual(writes.map((write) => write[1]), Array.from({ length: 10 }, (_, index) => `ch${index}`));
});

test('mutex: a call that fails inside the lock does not block the next one on the thread', async () => {
  const { conn } = rig();
  let failNextSet = true;
  const flaky: SessionArea = {
    get: (keys) => conn.session.get(keys),
    set: async (items) => {
      if (failNextSet) {
        failNextSet = false;
        throw new Error('boom: one failed write');
      }
      return conn.session.set(items);
    },
    remove: (keys) => conn.session.remove(keys),
    getKeys: () => conn.session.getKeys(),
  };
  const saver = new SessionStorageSaver(flaky);
  const failing = putStep(saver, 't1', '', 1, { v: 1 }, { v: 1 }, ['v']);
  const next = putStep(saver, 't1', '', 2, { v: 2 }, { v: 2 }, ['v']); // queued behind the failing one
  await assert.rejects(() => failing, /boom: one failed write/);
  await next;
  assert.equal((await saver.getTuple(cfg('t1')))?.checkpoint.id, id(2));
});

test('mutex: a thread whose lock is held does not hold up another thread', async () => {
  const { conn } = rig();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const gated: SessionArea = {
    get: async (keys) => {
      if (typeof keys === 'string' && keys.startsWith('sf:lg:ix:slow')) await gate;
      return conn.session.get(keys);
    },
    set: (items) => conn.session.set(items),
    remove: (keys) => conn.session.remove(keys),
    getKeys: () => conn.session.getKeys(),
  };
  const saver = new SessionStorageSaver(gated);
  const slow = putStep(saver, 'slow', '', 1, { v: 1 }, { v: 1 }, ['v']); // waits at the gate inside slow's lock
  const stuck = saver.getTuple(cfg('slow')); // queued behind it
  await putStep(saver, 'fast', '', 1, { v: 1 }, { v: 1 }, ['v']);
  assert.equal((await saver.getTuple(cfg('fast')))?.checkpoint.id, id(1), 'the other thread went through while slow was held');
  let stuckDone = false;
  void stuck.then(() => {
    stuckDone = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(stuckDone, false, 'a read of the held thread is still waiting');
  release();
  await slow;
  assert.equal((await stuck)?.checkpoint.id, id(1), 'and it sees the write once the lock is free');
});

// ---------------------------------------------------------------------------------------------
// deleteThread and tombstones
// ---------------------------------------------------------------------------------------------

async function populate(saver: SessionStorageSaver, store: ReturnType<typeof rig>['store'], thread: string): Promise<void> {
  await putStep(saver, thread, '', 1, { v: 1 }, { v: 1 }, ['v']);
  await putStep(saver, thread, '', 2, { v: 2 }, { v: 2 }, ['v']);
  await putStep(saver, thread, 'site:a', 1, { w: 1 }, { w: 1 }, ['w']);
  await putStep(saver, thread, 'site:a|nested:b', 1, { w: 1 }, { w: 1 }, ['w']);
  await saver.putWrites(cfg(thread, '', id(2)), [[INTERRUPT, 'q']], 'task-1');
  await saver.putWrites(cfg(thread, 'site:a', id(1)), [[INTERRUPT, 'q']], 'task-2');
  store.session.seed({ [`sf:meta:${thread}`]: { stateVersion: 3 }, [`sf:journal:${thread}`]: [{ key: 'run:1' }] });
}

test('deleteThread: removes every key of every namespace plus sf:meta and sf:journal, and nothing of other threads', async () => {
  const { store, saver } = rig();
  for (const thread of ['1', '12', '1x', 'legacy']) await populate(saver, store, thread);
  const before = { one: keysOfThread(store, '1'), twelve: keysOfThread(store, '12'), oneX: keysOfThread(store, '1x'), legacy: keysOfThread(store, 'legacy') };
  assert.ok(before.one.includes('sf:meta:1') && before.one.includes('sf:journal:1') && before.one.includes('sf:lg:ix:1'));
  assert.ok(before.one.some((key) => key.startsWith('sf:lg:cp:1:site%3Aa%7Cnested%3Ab:')), 'a nested namespace is part of the thread');

  await saver.deleteThread('1');

  assert.deepEqual(keysOfThread(store, '1'), []);
  assert.deepEqual(keysOfThread(store, '12'), before.twelve, 'thread 12 shares a prefix with thread 1 and must keep every key');
  assert.deepEqual(keysOfThread(store, '1x'), before.oneX);
  assert.deepEqual(keysOfThread(store, 'legacy'), before.legacy);
  assert.equal(store.session.keys().length, before.twelve.length + before.oneX.length + before.legacy.length);
  assert.equal(await saver.getTuple(cfg('1')), undefined);
  assert.equal((await saver.getTuple(cfg('12')))?.checkpoint.id, id(2));
  assert.equal((await saver.getTuple(cfg('12', 'site:a')))?.checkpoint.id, id(1));
});

test('deleteThread: lists keys with getKeys and never reads the whole area', async () => {
  const { store, saver, host } = rig();
  await populate(saver, store, '7');
  await populate(saver, store, '8');
  const before = keysOfThread(store, '7');
  host.calls.length = 0;
  await saver.deleteThread('7');
  assert.equal(readEverything(host), false, 'no get(null): other tabs\' checkpoints stay out of the worker');
  assert.equal(host.calls.filter((call) => call.api === 'storage.session.getKeys').length, 1);
  const removes = host.calls.filter((call) => call.api === 'storage.session.remove');
  assert.equal(removes.length, 1, 'one remove call for all the keys');
  assert.deepEqual([...(removes[0].args[0] as string[])].sort(), before);
});

test('deleteThread: works from a fresh saver with no runner and no state in memory (a worker restart)', async () => {
  const { store, saver } = rig();
  await populate(saver, store, '9');
  const after = new SessionStorageSaver(store.connect().session);
  await after.deleteThread('9');
  assert.deepEqual(store.session.keys(), []);
});

test('deleteThread: an unknown thread is a no-op, and older Chrome without getKeys still deletes only that thread', async () => {
  const { store, saver, conn } = rig();
  await populate(saver, store, '3');
  await populate(saver, store, '4');
  await saver.deleteThread('nobody');
  const before = store.session.keys();
  assert.equal(before.length > 0, true);

  const oldChrome: SessionArea = {
    get: (keys) => conn.session.get(keys),
    set: (items) => conn.session.set(items),
    remove: (keys) => conn.session.remove(keys),
  };
  await new SessionStorageSaver(oldChrome).deleteThread('3');
  assert.deepEqual(keysOfThread(store, '3'), []);
  assert.ok(keysOfThread(store, '4').length > 0);
});

test('tombstone: after deleteThread a late put and a late putWrites are ignored and leave no key', async () => {
  const { store, saver } = rig();
  await populate(saver, store, '5');
  await saver.deleteThread('5');
  assert.deepEqual(store.session.keys(), []);

  const returned = await putStep(saver, '5', '', 3, { v: 'late' }, { v: 3 }, ['v']);
  assert.deepEqual(returned, { configurable: { thread_id: '5', checkpoint_ns: '', checkpoint_id: id(3) } }, 'the caller is not told about the drop');
  await saver.putWrites(cfg('5', '', id(3)), [['late', 1]], 'task-late');
  await putStep(saver, '5', 'site:a', 3, { v: 'late' }, { v: 3 }, ['v']);
  assert.deepEqual(store.session.keys(), [], 'a closing tab\'s run cannot leave orphan keys');
  assert.equal(await saver.getTuple(cfg('5')), undefined);
});

test('tombstone: a write queued behind the delete, or in flight when it is called, is ignored too', async () => {
  const { store, saver } = rig({ session: { delayMs: 2 } });
  await putStep(saver, '6', '', 1, { v: 1 }, { v: 1 }, ['v']);
  const inFlight = putStep(saver, '6', '', 2, { v: 2 }, { v: 2 }, ['v']); // queued before the delete
  const deleting = saver.deleteThread('6');
  const behind = putStep(saver, '6', '', 3, { v: 3 }, { v: 3 }, ['v']); // queued after it
  await Promise.all([inFlight, deleting, behind]);
  assert.deepEqual(store.session.keys(), []);
});

test('tombstone: other threads are not affected by it', async () => {
  const { store, saver } = rig();
  await saver.deleteThread('5');
  await putStep(saver, '6', '', 1, { v: 1 }, { v: 1 }, ['v']);
  assert.equal((await saver.getTuple(cfg('6')))?.checkpoint.id, id(1));
  assert.equal(store.session.keys().length, 3);
});

test('tombstone: revive() lets the thread be written again (a new task on the same tab)', async () => {
  const { store, saver } = rig();
  await populate(saver, store, '5');
  await saver.deleteThread('5');
  await putStep(saver, '5', '', 1, { v: 'ignored' }, { v: 1 }, ['v']);
  assert.deepEqual(store.session.keys(), []);

  saver.revive('5');
  await putStep(saver, '5', '', 1, { v: 'fresh' }, { v: 1 }, ['v']);
  await saver.putWrites(cfg('5', '', id(1)), [[INTERRUPT, 'q']], 'task-1');
  const tuple = await saver.getTuple(cfg('5'));
  assert.equal(tuple?.checkpoint.channel_values.v, 'fresh');
  assert.deepEqual(tuple?.pendingWrites, [['task-1', INTERRUPT, 'q']]);
});

test('tombstone: deleting a thread again after a revive removes what was written since', async () => {
  const { store, saver } = rig();
  await saver.deleteThread('5');
  saver.revive('5');
  await putStep(saver, '5', '', 1, { v: 1 }, { v: 1 }, ['v']);
  await saver.deleteThread('5');
  assert.deepEqual(store.session.keys(), []);
});
