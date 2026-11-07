/**
 * The runner metadata: SessionRunnerMeta in src/background/runner/runnerMeta.ts.
 *
 * The metadata is what the runner knows about itself between service worker cold boots: the
 * Tarka tab groups it owns, the tab aliases, which tabs it had attached, and where it paused.
 * It lives in chrome.storage.session, so it is written often (the group map changes on every
 * tab move) but not on every change: writes are throttled, and the LAST payload is the one that
 * gets written.
 *
 * What these tests hold on to:
 *   1. What was written can be read back.
 *   2. A write inside the throttle window is not lost: the newest payload is what lands (BUG-41).
 *   3. A write outside the throttle window goes out at once.
 *   4. An immediate write cancels a pending throttled one, so the newer value wins.
 *   5. Clearing removes the metadata and the pending write.
 *   6. A storage area that throws does not take the run down with it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

import { SessionRunnerMeta } from '../../src/background/runner/runnerMeta.ts';
import type { StorageSessionArea } from '../../src/background/runner/actionJournal.ts';
import type { RunnerMeta } from '../../src/background/runner/runnerMeta.ts';

/** An area that remembers what it was given, so a test can look at the stored shape. */
function fakeArea(): StorageSessionArea & { data: Record<string, unknown>; writes: number } {
  const data: Record<string, unknown> = {};
  return {
    data,
    writes: 0,
    async get(keys?: string | string[] | null) {
      const list = keys == null ? Object.keys(data) : Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const key of list) if (key in data) out[key] = data[key];
      return out;
    },
    async set(items: Record<string, unknown>) { this.writes += 1; Object.assign(data, items); },
    async remove(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    }
  };
}

function meta(stateVersion: number, groupId: number): RunnerMeta {
  return {
    stateVersion,
    tarkaGroupIds: [[1, groupId]],
    aliases: [],
    attachedTabIds: [],
    pauseDetach: null,
    lastBeatAt: 0
  };
}

test('what was written can be read back', async () => {
  const area = fakeArea();
  const runnerMeta = new SessionRunnerMeta('thread-1', area);

  await runnerMeta.writeImmediate(meta(7, 42));

  const read = await runnerMeta.read();
  assert.ok(read, 'the metadata is there');
  assert.equal(read.stateVersion, 7);
  assert.deepEqual(read.tarkaGroupIds, [[1, 42]]);
});

test('nothing stored reads as nothing, not as a crash', async () => {
  const runnerMeta = new SessionRunnerMeta('thread-1', fakeArea());
  assert.equal(await runnerMeta.read(), null);
});

test('a write inside the throttle window is not lost: the newest payload is what lands', async () => {
  // BUG-41: the throttled write used to close over the FIRST captured payload, so a later
  // update inside the window was dropped and storage kept a stale group map.
  const area = fakeArea();
  const runnerMeta = new SessionRunnerMeta('thread-1', area);

  runnerMeta.scheduleWrite(meta(1, 10));
  runnerMeta.scheduleWrite(meta(2, 20));
  runnerMeta.scheduleWrite(meta(3, 30));

  await sleep(320);

  const read = await runnerMeta.read();
  assert.ok(read, 'the metadata landed');
  assert.equal(read.stateVersion, 3, 'and it is the newest one, not the first');
  assert.deepEqual(read.tarkaGroupIds, [[1, 30]]);
});

test('the first write goes out at once, because nothing was written before it', async () => {
  const area = fakeArea();
  const runnerMeta = new SessionRunnerMeta('thread-1', area);

  runnerMeta.scheduleWrite(meta(1, 10));
  await sleep(20);

  const read = await runnerMeta.read();
  assert.ok(read, 'the metadata landed without waiting for the window');
  assert.equal(read.stateVersion, 1);
});

test('an immediate write cancels a pending throttled one, so the newer value wins', async () => {
  const area = fakeArea();
  const runnerMeta = new SessionRunnerMeta('thread-1', area);

  runnerMeta.scheduleWrite(meta(1, 10));
  await runnerMeta.writeImmediate(meta(2, 20));

  await sleep(320);

  const read = await runnerMeta.read();
  assert.ok(read);
  assert.equal(read.stateVersion, 2, 'the pending write did not overwrite the immediate one');
});

test('clearing removes the metadata', async () => {
  const area = fakeArea();
  const runnerMeta = new SessionRunnerMeta('thread-1', area);

  await runnerMeta.writeImmediate(meta(7, 42));
  await runnerMeta.clear();

  assert.equal(await runnerMeta.read(), null);
});

test('clearing drops the pending write too, so a cleared state does not come back', async () => {
  const area = fakeArea();
  const runnerMeta = new SessionRunnerMeta('thread-1', area);

  runnerMeta.scheduleWrite(meta(1, 10));
  await runnerMeta.clear();

  await sleep(320);

  assert.equal(await runnerMeta.read(), null, 'the pending write did not land after the clear');
});

test('a storage area that throws does not take the run down', async () => {
  const broken: StorageSessionArea = {
    async get() { throw new Error('storage is gone'); },
    async set() { throw new Error('storage is gone'); },
    async remove() { throw new Error('storage is gone'); }
  };
  const runnerMeta = new SessionRunnerMeta('thread-1', broken);

  await runnerMeta.writeImmediate(meta(7, 42));
  runnerMeta.scheduleWrite(meta(8, 43));
  await sleep(320);
  await runnerMeta.clear();

  assert.equal(await runnerMeta.read(), null, 'and the metadata is simply empty');
});

test('a runner with no storage area works, it just remembers nothing', async () => {
  // No chrome.storage.session (a unit test, a browser without the permission): the metadata must
  // still answer, with nothing in it.
  const runnerMeta = new SessionRunnerMeta('thread-1');
  await runnerMeta.writeImmediate(meta(7, 42));
  assert.equal(await runnerMeta.read(), null);
});
