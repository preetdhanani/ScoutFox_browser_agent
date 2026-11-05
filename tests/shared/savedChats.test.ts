/**
 * Recent tasks in storage (src/shared/storage.ts): each chat under its own key, plus a small index.
 *
 * What these tests hold on to:
 *   1. A saved chat is its own key (sf:chat:<id>) and the index lists it newest first, without its
 *      rows: a save writes one chat, not all fifty.
 *   2. Saving the same chat again replaces it and moves it to the top: a resumed chat stays one entry.
 *   3. The old list (saved_sessions, one array of whole chats) is read once and moved: each chat to
 *      its own key, the index written, the old array removed.
 *   4. Deleting a chat removes its key (and the records its rows keep) and its index entry.
 *   5. Past MAX_SAVED_CHATS the oldest chats go, with their keys.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const data: Record<string, unknown> = {};
globalThis.chrome = {
  storage: {
    local: {
      get: (keys: string[], cb: (items: Record<string, unknown>) => void) => {
        const out: Record<string, unknown> = {};
        for (const k of keys) if (data[k] !== undefined) out[k] = structuredClone(data[k]);
        cb(out);
      },
      set: (items: Record<string, unknown>, cb?: () => void) => { Object.assign(data, structuredClone(items)); cb?.(); },
      remove: (keys: string[], cb?: () => void) => { for (const k of keys) delete data[k]; cb?.(); }
    }
  }
} as unknown as typeof chrome;

const { Storage, CHAT_INDEX_KEY, LEGACY_SESSIONS_KEY, MAX_SAVED_CHATS, chatKey } = await import('../../src/shared/storage.ts');

const clear = () => { for (const k of Object.keys(data)) delete data[k]; };
const goal = (prompt: string) => ({ type: 'user_goal', turn: 1, prompt, timestamp: '10:00', isNewRun: true });

test('a saved chat is its own key, and the index lists it newest first without its rows', async () => {
  clear();
  await Storage.saveChat({ id: 'c1', task: 'Task 1', history: [goal('Task 1')], planSteps: [], status: 'idle' });
  await Storage.saveChat({ id: 'c2', task: 'Task 2', history: [goal('Task 2')], planSteps: [], status: 'running', records: [{ name: 'a' }], pageUrl: 'https://x.test/' });
  const index = await Storage.getSessions();
  assert.deepEqual(index.map((s) => s.id), ['c2', 'c1']);
  assert.equal('history' in index[0], false, 'the index has no rows');
  assert.equal('records' in index[0], false, 'nor records');
  assert.equal('pageUrl' in index[0], false, 'nor the page');
  assert.equal(index[0].status, 'running');
  const chat = await Storage.getChat('c2');
  assert.equal(chat?.history?.length, 1);
  assert.deepEqual(chat?.records, [{ name: 'a' }]);
  assert.ok(data[chatKey('c1')] && data[chatKey('c2')], 'each chat has its own key');
  assert.equal(await Storage.getChat('nope'), null);
});

test('saving a chat again replaces it and moves it to the top: one entry per chat', async () => {
  clear();
  await Storage.saveChat({ id: 'a', task: 'A', history: [goal('A')] });
  await Storage.saveChat({ id: 'b', task: 'B', history: [goal('B')] });
  await Storage.saveChat({ id: 'a', task: 'A', history: [goal('A'), goal('resume')] });
  const index = await Storage.getSessions();
  assert.deepEqual(index.map((s) => s.id), ['a', 'b']);
  assert.equal((await Storage.getChat('a'))?.history?.length, 2);
});

test('the old saved_sessions list is moved once: each chat to its own key, then removed', async () => {
  clear();
  data[LEGACY_SESSIONS_KEY] = [
    { id: 'old1', task: 'Old 1', timestamp: 't1', model: 'm', history: [goal('Old 1')], planSteps: [] },
    { id: 'old2', task: 'Old 2', timestamp: 't2', model: 'm', history: [goal('Old 2')], planSteps: [] }
  ];
  const index = await Storage.getSessions();
  assert.deepEqual(index.map((s) => s.id), ['old1', 'old2'], 'the order is kept');
  assert.equal(data[LEGACY_SESSIONS_KEY], undefined, 'the old array is gone');
  assert.deepEqual((data[CHAT_INDEX_KEY] as any[]).map((s) => s.id), ['old1', 'old2']);
  assert.equal((await Storage.getChat('old2'))?.task, 'Old 2');
});

test('deleting a chat removes its key and its index entry', async () => {
  clear();
  await Storage.saveChat({ id: 'keep', task: 'Keep', history: [goal('Keep')] });
  await Storage.saveChat({ id: 'gone', task: 'Gone', history: [goal('Gone')], records: [{ secret: 'x' }] });
  const after = await Storage.deleteSession('gone');
  assert.deepEqual(after.map((s) => s.id), ['keep']);
  assert.equal(data[chatKey('gone')], undefined, 'the chat and its records are removed');
  assert.equal(await Storage.getChat('gone'), null);
});

test('past the cap the oldest chats go, with their keys', async () => {
  clear();
  for (let i = 0; i <= MAX_SAVED_CHATS; i++) await Storage.saveChat({ id: `c${i}`, task: `T${i}`, history: [goal(`T${i}`)] });
  const index = await Storage.getSessions();
  assert.equal(index.length, MAX_SAVED_CHATS);
  assert.equal(index[0].id, `c${MAX_SAVED_CHATS}`);
  assert.equal(data[chatKey('c0')], undefined, 'the oldest chat\'s key is removed');
  assert.ok(data[chatKey('c1')]);
});
