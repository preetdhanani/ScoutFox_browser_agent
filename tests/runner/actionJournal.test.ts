/**
 * The action journal: SessionActionJournal in src/background/runner/actionJournal.ts.
 *
 * The journal is what stops a click from firing twice. It lives in chrome.storage.session, so
 * it survives the service worker being killed between the moment an action was dispatched and
 * the moment its result came back. A worker that comes back, sees the action in the journal and
 * finds the result, does not send it again.
 *
 * What these tests hold on to:
 *   1. A dispatched action is remembered, and its result is remembered with it.
 *   2. The journal says which boot dispatched the action, so a worker from a different boot can
 *      tell that the action is not its own.
 *   3. Only the last two entries are kept: the journal is a safety net for the action in flight,
 *      not a history.
 *   4. Clearing a run removes exactly that run's entries and leaves the others alone.
 *   5. A storage area that throws does not take the run down with it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { SessionActionJournal } from '../../src/background/runner/actionJournal.ts';
import type { StorageSessionArea } from '../../src/background/runner/actionJournal.ts';
import type { ExecResult } from '../../src/background/runner/runtimeRegistry.ts';
import type { PageAction } from '../../src/background/types.ts';

const CLICK: PageAction = { action: 'click', element_id: 3 };

function execResult(over: Partial<ExecResult> = {}): ExecResult {
  return { success: true, via: 'cdp', effect: 'url_changed', ...over } as ExecResult;
}

/** An area that remembers what it was given, so a test can look at the stored shape. */
function fakeArea(): StorageSessionArea & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    data,
    async get(keys?: string | string[] | null) {
      const list = keys == null ? Object.keys(data) : Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const key of list) if (key in data) out[key] = data[key];
      return out;
    },
    async set(items: Record<string, unknown>) { Object.assign(data, items); },
    async remove(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    }
  };
}

test('a dispatched action is remembered, with the boot that dispatched it', async () => {
  const area = fakeArea();
  const journal = new SessionActionJournal('thread-1', 'boot-1', area);

  await journal.begin('run-1:1', CLICK);

  const entry = await journal.get('run-1:1');
  assert.ok(entry, 'the action is in the journal');
  assert.equal(entry.bootId, 'boot-1');
  assert.equal(entry.result, null, 'and it has no result yet');
  assert.ok(entry.dispatchedAt > 0, 'and it says when it went out');
});

test('the result of an action is remembered with it', async () => {
  const area = fakeArea();
  const journal = new SessionActionJournal('thread-1', 'boot-1', area);

  await journal.begin('run-1:1', CLICK);
  await journal.finish('run-1:1', execResult({ success: true, message: 'clicked' }));

  const entry = await journal.get('run-1:1');
  assert.ok(entry);
  assert.equal(entry.result?.success, true);
  assert.equal(entry.result?.message, 'clicked');
});

test('an action that is not in the journal is not in it', async () => {
  const journal = new SessionActionJournal('thread-1', 'boot-1', fakeArea());
  assert.equal(await journal.get('run-1:9'), null);
});

test('a failed action keeps its error, so the worker can say what went wrong', async () => {
  const area = fakeArea();
  const journal = new SessionActionJournal('thread-1', 'boot-1', area);

  await journal.begin('run-1:1', CLICK);
  await journal.finish('run-1:1', execResult({ success: false, error: 'Element [3] is not on the page.' }));

  const entry = await journal.get('run-1:1');
  assert.equal(entry?.result?.success, false);
  assert.equal(entry?.result?.error, 'Element [3] is not on the page.');
});

test('a second dispatch of the same key replaces the first, it does not pile up', async () => {
  const area = fakeArea();
  const journal = new SessionActionJournal('thread-1', 'boot-2', area);

  await journal.begin('run-1:1', CLICK);
  await journal.begin('run-1:1', CLICK);

  const stored = area.data['sf:journal:thread-1'] as any[];
  assert.equal(stored.length, 1, 'the key is in the journal once');
  assert.equal(stored[0].bootId, 'boot-2', 'and it carries the newest boot');
});

test('only the last two entries are kept: the journal is a net for the action in flight', async () => {
  const area = fakeArea();
  const journal = new SessionActionJournal('thread-1', 'boot-1', area);

  await journal.begin('run-1:1', CLICK);
  await journal.begin('run-1:2', CLICK);
  await journal.begin('run-1:3', CLICK);

  const stored = area.data['sf:journal:thread-1'] as any[];
  assert.equal(stored.length, 2);
  assert.deepEqual(stored.map((e) => e.key), ['run-1:2', 'run-1:3']);
});

test('clearing a run removes that run and leaves the other runs alone', async () => {
  const area = fakeArea();
  const journal = new SessionActionJournal('thread-1', 'boot-1', area);

  await journal.begin('run-1:1', CLICK);
  await journal.begin('run-1:2', CLICK);
  await journal.begin('run-2:1', CLICK);

  await journal.clearRun('run-1');

  assert.equal(await journal.get('run-1:1'), null, 'run-1 is gone');
  assert.equal(await journal.get('run-1:2'), null, 'all of run-1 is gone');
  assert.ok(await journal.get('run-2:1'), 'run-2 is still there');
});

test('two threads keep two journals, so one run does not see the other', async () => {
  const area = fakeArea();
  const one = new SessionActionJournal('thread-1', 'boot-1', area);
  const two = new SessionActionJournal('thread-2', 'boot-1', area);

  await one.begin('run-1:1', CLICK);

  assert.ok(await one.get('run-1:1'), 'the journal of the thread has it');
  assert.equal(await two.get('run-1:1'), null, 'the other thread does not');
});

test('a storage area that throws does not take the run down', async () => {
  // The journal is a safety net. If storage is broken, the run must still go on: a thrown
  // error here would abort a run over a bookkeeping problem.
  const broken: StorageSessionArea = {
    async get() { throw new Error('storage is gone'); },
    async set() { throw new Error('storage is gone'); },
    async remove() { throw new Error('storage is gone'); }
  };
  const journal = new SessionActionJournal('thread-1', 'boot-1', broken);

  await journal.begin('run-1:1', CLICK);
  await journal.finish('run-1:1', execResult());
  await journal.clearRun('run-1');

  assert.equal(await journal.get('run-1:1'), null, 'and the journal is simply empty');
});

test('a journal with no storage area works, it just remembers nothing', async () => {
  // No chrome.storage.session (a unit test, a browser without the permission): the journal must
  // still answer, with nothing in it.
  const journal = new SessionActionJournal('thread-1', 'boot-1');
  await journal.begin('run-1:1', CLICK);
  assert.equal(await journal.get('run-1:1'), null);
});
