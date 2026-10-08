/**
 * Quota handling in SessionStorageSaver. chrome.storage.session has 10 MB, and a set() that would
 * go over fails as a whole. On such an error the saver cuts the thread to 1 checkpoint per
 * namespace and retries once; a second failure throws the design's text. Above 8 MB after a put it
 * logs [CHECKPOINT_QUOTA] and cuts the idle threads.
 *
 * Sizes are made relative to what is stored (bytesInUse plus a margin), so no test depends on
 * hand-counted bytes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { INTERRUPT } from '@langchain/langgraph-checkpoint';
import { Logger } from '../../src/shared/logger.ts';
import { STORAGE_FULL_MESSAGE, SessionStorageSaver, type SessionArea } from '../../src/background/checkpoint/SessionStorageSaver.ts';
import { cfg, checkpointId, putStep, rig } from '../helpers/checkpointFixtures.ts';

const id = checkpointId;

/** Fail after a while instead of hanging the run when the awaited thing never settles (a lock that is never released). */
function within<T>(ms: number, work: Promise<T>): Promise<T> {
  return Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms).unref())]);
}
const big = (n: number, size = 4000): string => `${n}:`.padEnd(size, 'x');

type Rig = ReturnType<typeof rig>;
const ixOf = (r: Rig, thread: string) => r.store.session.data()[`sf:lg:ix:${thread}`] as { ns: Record<string, { ids: string[] }> };

async function bigStep(r: Rig, thread: string, ns: string, n: number): Promise<void> {
  await putStep(r.saver, thread, ns, n, { big: big(n) }, { big: n }, ['big']);
}

test('the full-storage text is the design\'s text', () => {
  assert.equal(STORAGE_FULL_MESSAGE, 'Session storage is full - stop other ScoutFox tabs or clear this session.');
});

test('quota: a put that does not fit prunes the thread to 1 checkpoint per namespace and retries once', async () => {
  const r = rig();
  // Another thread (must stay as it is), and a worker namespace with a pending interrupt (its newest checkpoint and writes must stay).
  for (let n = 1; n <= 3; n++) await putStep(r.saver, 'other', '', n, { v: n }, { v: n }, ['v']);
  for (let n = 1; n <= 2; n++) await putStep(r.saver, 't1', 'site:a', n, { w: n }, { w: n }, ['w']);
  await r.saver.putWrites(cfg('t1', 'site:a', id(2)), [[INTERRUPT, { value: 'ask the user' }]], 'hold-task');
  for (let n = 1; n <= 3; n++) await bigStep(r, 't1', '', n);

  r.store.session.quotaBytes = r.store.session.bytesInUse() + 1500;
  await assert.rejects(() => r.conn.session.set({ probe: 'x'.repeat(4000) }), /quota/i, 'control: the store is really this tight');
  assert.ok(ixOf(r, 't1').ns[''].ids.length === 3);

  await bigStep(r, 't1', '', 4); // does not fit next to three big checkpoints

  assert.deepEqual(ixOf(r, 't1').ns[''].ids, [id(4)], 'the root namespace ends with its newest checkpoint only');
  assert.deepEqual(ixOf(r, 't1').ns['site:a'].ids, [id(2)], 'the worker namespace is cut to its newest checkpoint');
  assert.deepEqual((await r.saver.getTuple(cfg('t1', 'site:a')))?.pendingWrites, [['hold-task', INTERRUPT, { value: 'ask the user' }]], 'the pending writes of the newest checkpoint stay');
  assert.equal((await r.saver.getTuple(cfg('t1')))?.checkpoint.channel_values.big, big(4));
  assert.deepEqual(r.store.session.keys().filter((key) => key.startsWith('sf:lg:b:t1:root:big:')), ['sf:lg:b:t1:root:big:4'], 'older blobs were collected with their checkpoints');
  assert.equal(ixOf(r, 'other').ns[''].ids.length, 3, 'another thread is not cut');
  assert.ok(r.store.session.bytesInUse() <= r.store.session.quotaBytes);
});

test('quota: after a retry the thread keeps working and grows back to 3 checkpoints', async () => {
  const r = rig();
  for (let n = 1; n <= 3; n++) await bigStep(r, 't1', '', n);
  r.store.session.quotaBytes = r.store.session.bytesInUse() + 1500;
  await bigStep(r, 't1', '', 4);
  r.store.session.quotaBytes = 10 * 1024 * 1024;
  await bigStep(r, 't1', '', 5);
  await bigStep(r, 't1', '', 6);
  assert.deepEqual(ixOf(r, 't1').ns[''].ids, [id(6), id(5), id(4)]);
});

test('quota: when it still does not fit, the put throws the design\'s text and the thread stays consistent', async () => {
  const r = rig();
  await bigStep(r, 't1', '', 1);
  r.store.session.quotaBytes = r.store.session.bytesInUse() + 500;
  const before = r.store.session.data();

  await assert.rejects(
    () => bigStep(r, 't1', '', 2),
    (error: Error) => {
      assert.equal(error.message, 'Session storage is full - stop other ScoutFox tabs or clear this session.');
      assert.match((error.cause as Error).message, /quota/i, 'the storage error is kept as the cause');
      return true;
    }
  );
  assert.deepEqual(r.store.session.data(), before, 'nothing was half-written and the old head is still there');
  assert.equal((await r.saver.getTuple(cfg('t1')))?.checkpoint.id, id(1));
  assert.equal((await r.saver.getTuple(cfg('t1')))?.checkpoint.channel_values.big, big(1));
});

test('quota: a failed retry still leaves every namespace with its newest checkpoint, complete', async () => {
  const r = rig();
  for (let n = 1; n <= 3; n++) await bigStep(r, 't1', '', n);
  await putStep(r.saver, 't1', 'site:a', 1, { w: 'small' }, { w: 1 }, ['w']);
  r.store.session.quotaBytes = r.store.session.bytesInUse() + 200;

  await assert.rejects(() => putStep(r.saver, 't1', '', 4, { big: big(4, 30_000) }, { big: 4 }, ['big']), new RegExp(STORAGE_FULL_MESSAGE));

  assert.deepEqual(ixOf(r, 't1').ns[''].ids, [id(3)], 'cut to the head');
  assert.deepEqual(ixOf(r, 't1').ns['site:a'].ids, [id(1)]);
  const head = await r.saver.getTuple(cfg('t1'));
  assert.equal(head?.checkpoint.channel_values.big, big(3), 'the head is whole: its blob was not collected');
  assert.equal((await r.saver.getTuple(cfg('t1', 'site:a')))?.checkpoint.channel_values.w, 'small');
  // The thread can go on once there is room again.
  r.store.session.quotaBytes = 10 * 1024 * 1024;
  await bigStep(r, 't1', '', 4);
  assert.deepEqual(ixOf(r, 't1').ns[''].ids, [id(4), id(3)]);
});

test('quota: an error that is not about quota is thrown as it is, with no pruning', async () => {
  const r = rig();
  for (let n = 1; n <= 3; n++) await bigStep(r, 't1', '', n);
  const removed: unknown[] = [];
  const broken: SessionArea = {
    get: (keys) => r.conn.session.get(keys),
    set: async () => {
      throw new Error('boom: the storage API is unavailable');
    },
    remove: async (keys) => {
      removed.push(keys);
    },
    getKeys: () => r.conn.session.getKeys(),
  };
  const saver = new SessionStorageSaver(broken);
  await assert.rejects(() => putStep(saver, 't1', '', 4, { big: big(4) }, { big: 4 }, ['big']), /boom: the storage API is unavailable/);
  await assert.rejects(() => saver.putWrites(cfg('t1', '', id(3)), [['x', 1]], 'task'), /boom/);
  assert.deepEqual(removed, [], 'nothing was pruned');
  assert.equal(ixOf(r, 't1').ns[''].ids.length, 3);
});

test('quota: putWrites that does not fit prunes the thread and retries once', async () => {
  const r = rig();
  for (let n = 1; n <= 3; n++) await bigStep(r, 't1', '', n);
  r.store.session.quotaBytes = r.store.session.bytesInUse() + 300;

  await r.saver.putWrites(cfg('t1', '', id(3)), [[INTERRUPT, { value: 'y'.repeat(3000) }]], 'hold-task');

  assert.deepEqual(ixOf(r, 't1').ns[''].ids, [id(3)]);
  const head = await r.saver.getTuple(cfg('t1'));
  assert.deepEqual(head?.pendingWrites, [['hold-task', INTERRUPT, { value: 'y'.repeat(3000) }]]);
  assert.equal(head?.checkpoint.channel_values.big, big(3));
});

test('quota: putWrites that still does not fit throws the design\'s text', async () => {
  const r = rig();
  await bigStep(r, 't1', '', 1);
  r.store.session.quotaBytes = r.store.session.bytesInUse() + 100;
  await assert.rejects(() => r.saver.putWrites(cfg('t1', '', id(1)), [[INTERRUPT, 'z'.repeat(3000)]], 'hold-task'), new RegExp(STORAGE_FULL_MESSAGE));
  assert.deepEqual((await r.saver.getTuple(cfg('t1')))?.pendingWrites, []);
});

// ---------------------------------------------------------------------------------------------
// Above 8 MB
// ---------------------------------------------------------------------------------------------

const FILLER_BYTES = 8_400_000; // above 8 MiB (8,388,608), below the 10 MB quota

function quiet(t: { mock: { method: (object: object, name: string, impl: () => void) => unknown } }): void {
  t.mock.method(console, 'warn', () => {});
}

test('above 8 MB after a put: it logs [CHECKPOINT_QUOTA] and cuts idle threads to 1 checkpoint per namespace, but not the thread that wrote', async (t) => {
  quiet(t);
  const r = rig();
  for (let n = 1; n <= 3; n++) {
    await putStep(r.saver, 'idle', '', n, { v: n }, { v: n }, ['v']);
    await putStep(r.saver, 'idle', 'site:a', n, { v: n }, { v: n }, ['v']);
  }
  await r.saver.putWrites(cfg('idle', 'site:a', id(3)), [[INTERRUPT, 'paused worker']], 'hold');
  Logger.clearLogs();
  await putStep(r.saver, 'active', '', 1, { v: 1 }, { v: 1 }, ['v']);
  assert.equal(Logger.getLogsHistory().some((entry) => entry.message.includes('[CHECKPOINT_QUOTA]')), false, 'nothing is logged below 8 MB');
  assert.equal(ixOf(r, 'idle').ns[''].ids.length, 3);

  r.store.session.seed({ filler: 'x'.repeat(FILLER_BYTES) });
  await putStep(r.saver, 'active', '', 2, { v: 2 }, { v: 2 }, ['v']);
  await putStep(r.saver, 'active', '', 3, { v: 3 }, { v: 3 }, ['v']);
  await putStep(r.saver, 'active', '', 4, { v: 4 }, { v: 4 }, ['v']);

  const logged = Logger.getLogsHistory().filter((entry) => entry.message.includes('[CHECKPOINT_QUOTA]'));
  assert.ok(logged.length >= 1);
  assert.equal(logged[0].level, 'WARN');
  assert.equal(logged[0].module, 'Checkpoint');
  assert.deepEqual(ixOf(r, 'idle').ns[''].ids, [id(3)], 'the idle thread is cut to 1 per namespace');
  assert.deepEqual(ixOf(r, 'idle').ns['site:a'].ids, [id(3)]);
  assert.deepEqual((await r.saver.getTuple(cfg('idle', 'site:a')))?.pendingWrites, [['hold', INTERRUPT, 'paused worker']], 'a paused worker stays resumable');
  assert.deepEqual(ixOf(r, 'active').ns[''].ids, [id(4), id(3), id(2)], 'the thread that just wrote keeps its 3');
  assert.ok(r.store.session.has('filler'), 'only checkpoint keys are ever removed');
});

test('above 8 MB: the log line comes once per crossing, not on every put', async (t) => {
  quiet(t);
  const r = rig();
  const count = () => Logger.getLogsHistory().filter((entry) => entry.message.includes('[CHECKPOINT_QUOTA]')).length;
  Logger.clearLogs();
  r.store.session.seed({ filler: 'x'.repeat(FILLER_BYTES) });
  for (let n = 1; n <= 4; n++) await putStep(r.saver, 't1', '', n, { v: n }, { v: n }, ['v']);
  assert.equal(count(), 1, 'four puts above the limit, one log line');

  await r.conn.session.remove('filler');
  await putStep(r.saver, 't1', '', 5, { v: 5 }, { v: 5 }, ['v']);
  assert.equal(count(), 1, 'back under the limit: nothing new');

  r.store.session.seed({ filler: 'x'.repeat(FILLER_BYTES) });
  await putStep(r.saver, 't1', '', 6, { v: 6 }, { v: 6 }, ['v']);
  assert.equal(count(), 2, 'a new crossing logs again');
});

test('above 8 MB: a thread with a call in flight is not cut', async (t) => {
  quiet(t);
  const r = rig();
  // One saver whose read of busy's write key waits until the test lets it go, so busy's lock is held.
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const gated: SessionArea = {
    get: async (keys) => {
      if (typeof keys === 'string' && keys.startsWith('sf:lg:w:busy:')) await gate;
      return r.conn.session.get(keys);
    },
    set: (items) => r.conn.session.set(items),
    remove: (keys) => r.conn.session.remove(keys),
    getKeys: () => r.conn.session.getKeys(),
    getBytesInUse: (keys) => r.conn.session.getBytesInUse(keys),
  };
  const saver = new SessionStorageSaver(gated);
  for (let n = 1; n <= 3; n++) {
    await putStep(saver, 'busy', '', n, { v: n }, { v: n }, ['v']);
    await putStep(saver, 'idle', '', n, { v: n }, { v: n }, ['v']);
  }
  r.store.session.seed({ filler: 'x'.repeat(FILLER_BYTES) });

  const inFlight = saver.putWrites(cfg('busy', '', id(3)), [['x', 1]], 'task'); // waits at the gate, holding busy's lock
  await within(2000, putStep(saver, 'active', '', 1, { v: 1 }, { v: 1 }, ['v'])); // must not wait for busy's lock
  assert.equal(ixOf(r, 'busy').ns[''].ids.length, 3, 'busy had a call in flight, so it was not idle');
  assert.equal(ixOf(r, 'idle').ns[''].ids.length, 1, 'while the idle thread was cut');
  release();
  await inFlight;
  assert.deepEqual((await saver.getTuple(cfg('busy')))?.pendingWrites, [['task', 'x', 1]]);
});

test('above 8 MB: an area without getBytesInUse is never cut', async (t) => {
  quiet(t);
  const r = rig();
  const noBytes: SessionArea = {
    get: (keys) => r.conn.session.get(keys),
    set: (items) => r.conn.session.set(items),
    remove: (keys) => r.conn.session.remove(keys),
    getKeys: () => r.conn.session.getKeys(),
  };
  const saver = new SessionStorageSaver(noBytes);
  for (let n = 1; n <= 3; n++) await putStep(saver, 'idle', '', n, { v: n }, { v: n }, ['v']);
  r.store.session.seed({ filler: 'x'.repeat(FILLER_BYTES) });
  Logger.clearLogs();
  await putStep(saver, 'active', '', 1, { v: 1 }, { v: 1 }, ['v']);
  assert.equal(ixOf(r, 'idle').ns[''].ids.length, 3);
  assert.equal(Logger.getLogsHistory().length, 0);
});

test('above 8 MB: a failing getBytesInUse does not fail the put', async (t) => {
  quiet(t);
  const r = rig();
  const flaky: SessionArea = {
    get: (keys) => r.conn.session.get(keys),
    set: (items) => r.conn.session.set(items),
    remove: (keys) => r.conn.session.remove(keys),
    getKeys: () => r.conn.session.getKeys(),
    getBytesInUse: async () => {
      throw new Error('getBytesInUse failed');
    },
  };
  const saver = new SessionStorageSaver(flaky);
  await putStep(saver, 't1', '', 1, { v: 1 }, { v: 1 }, ['v']);
  assert.equal((await saver.getTuple(cfg('t1')))?.checkpoint.id, id(1));
});

test('above 8 MB: a cleanup of idle threads that fails does not fail the put that was already stored', async (t) => {
  quiet(t);
  // The checkpoint is written before the cleanup runs, so a failing cleanup must only be logged: a
  // rejected put() would make LangGraph fail the run although the checkpoint is safe.
  const r = rig();
  const nineMb = 9 * 1024 * 1024;
  const listingFails: SessionArea = {
    get: (keys) => r.conn.session.get(keys),
    set: (items) => r.conn.session.set(items),
    remove: (keys) => r.conn.session.remove(keys),
    getKeys: async () => {
      throw new Error('getKeys boom');
    },
    getBytesInUse: async () => nineMb,
  };
  const saver = new SessionStorageSaver(listingFails);
  Logger.clearLogs();
  for (let n = 1; n <= 4; n++) await putStep(saver, 't1', '', n, { v: n }, { v: n }, ['v']);
  assert.deepEqual((await saver.getTuple(cfg('t1')))?.checkpoint.id, id(4), 'every put resolved, and the newest checkpoint is stored');
  const logged = Logger.getLogsHistory().filter((entry) => entry.message.includes('[CHECKPOINT_QUOTA]'));
  assert.ok(logged.some((entry) => entry.message.includes('getKeys boom')), 'the failure is logged');
  assert.equal(logged.filter((entry) => entry.message.includes('getKeys boom')).length, 1, 'once, not on every put');
});

test('above 8 MB: one idle thread that can not be cut does not stop the others from being cut', async (t) => {
  quiet(t);
  const r = rig();
  const stuck: SessionArea = {
    get: (keys) => r.conn.session.get(keys),
    set: (items) => r.conn.session.set(items),
    remove: async (keys) => {
      if ((Array.isArray(keys) ? keys : [keys]).some((key) => key.includes(':stuck:'))) throw new Error('remove boom');
      return r.conn.session.remove(keys);
    },
    getKeys: () => r.conn.session.getKeys(),
    getBytesInUse: (keys) => r.conn.session.getBytesInUse(keys),
  };
  const saver = new SessionStorageSaver(stuck);
  for (let n = 1; n <= 3; n++) {
    await putStep(saver, 'stuck', '', n, { v: n }, { v: n }, ['v']);
    await putStep(saver, 'idle', '', n, { v: n }, { v: n }, ['v']);
  }
  r.store.session.seed({ filler: 'x'.repeat(FILLER_BYTES) });
  Logger.clearLogs();
  await putStep(saver, 'active', '', 1, { v: 1 }, { v: 1 }, ['v']);
  assert.equal((await saver.getTuple(cfg('active')))?.checkpoint.id, id(1), 'the put resolved');
  assert.deepEqual(ixOf(r, 'idle').ns[''].ids, [id(3)], 'the thread that could be cut was cut');
  assert.ok(Logger.getLogsHistory().some((entry) => entry.message.includes('[CHECKPOINT_QUOTA]') && entry.message.includes('remove boom')), 'the failure is logged');
  // The next put tries again, and a cleanup that works clears the memory of the failure.
  assert.equal((await saver.getTuple(cfg('stuck')))?.checkpoint.id, id(3), 'the stuck thread still has its newest checkpoint');
});
