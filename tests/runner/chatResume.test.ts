/**
 * A chat that can be reopened and resumed: the runner saves it into Recent tasks and takes it back
 * (src/background/runner/AgentRunner.ts, chatSaver.ts, runSnapshot.ts).
 *
 * What these tests hold on to:
 *   1. The runner is the one writer of a chat: while a run goes it saves at most once every 3 s
 *      (with status "running"), and a state the run rests in at once.
 *   2. A turn's closing row keeps what the run collected: its records, and for an unfinished turn
 *      its plan and last page. Only the last closing row keeps records in a stored history.
 *   3. LOAD_CHAT: refused while a task runs; the saved history, plan and title become the runner's,
 *      a chat saved while running gets the "closed" interrupted row with its records and plan, the
 *      snapshot is written, and later saves go to the same entry (one Recent tasks entry).
 *   4. New chat starts a new chat id, so the old entry is never written again.
 *   5. A run the worker died under keeps its records and plan on the interrupted row.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRunner } from '../../src/background/runner/AgentRunner.ts';
import { ChatSaver, CHAT_SAVE_THROTTLE_MS } from '../../src/background/runner/chatSaver.ts';
import { CLOSED_TEXT, fitSnapshot, restoredRun, runSnapshotKey, type RunSnapshot } from '../../src/background/runner/runSnapshot.ts';
import { STOPPED_TEXT } from '../../src/background/mcp/historyEntries.ts';
import { chatKey, type SavedSession } from '../../src/shared/storage.ts';
import { fakeChrome } from '../helpers/fakeChrome.ts';
import { createFakeStorage } from '../helpers/fakeStorageSession.ts';
import { cdp } from '../../src/background/browser/cdp.ts';

let nextTab = 8100;
const RECORDS = [{ name: 'A', url: 'https://a.example' }];
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function setup(t: any) {
  const store = createFakeStorage();
  const restore = fakeChrome({ storage: store, tabs: true, dom: true }).install();
  t.after(restore);
  t.mock.method(cdp, 'detach', async () => {});
  const runner = new AgentRunner(nextTab++, 'default');
  const local = () => store.snapshot().local as Record<string, any>;
  return { runner, store, local };
}

test('the chat saver writes a running chat at most once per window, and a resting one at once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const writes: SavedSession[] = [];
  const saver = new ChatSaver(async (chat) => { writes.push(chat); });
  let n = 0;
  const build = () => ({ id: 'c', task: `state ${++n}` });
  saver.save(build);
  saver.save(build);
  saver.save(build);
  assert.equal(writes.length, 0, 'nothing before the window ends');
  t.mock.timers.tick(CHAT_SAVE_THROTTLE_MS);
  await Promise.resolve();
  assert.equal(writes.length, 1, 'one write for the window');
  assert.equal(writes[0].task, 'state 1', 'built when the write went out: the newest state');
  saver.save(build, true);
  await Promise.resolve();
  assert.equal(writes.length, 2, 'a resting state goes out at once');
  saver.save(build);
  saver.discard();
  t.mock.timers.tick(CHAT_SAVE_THROTTLE_MS);
  await Promise.resolve();
  assert.equal(writes.length, 2, 'a discarded save is never made');
});

test('the runner saves the chat while it runs, with status, and at once when it ends', async (t) => {
  const { runner, local } = setup(t);
  await runner.restorePromise;
  runner.currentTask = 'Make the file';
  runner.setRunStatus('running');
  runner.recordEntry({ type: 'user_goal', turn: 1, prompt: 'Make the file', timestamp: '', isNewRun: true });
  runner.setPlanSteps([{ text: 'Read', status: 'completed' }, { text: 'Save', status: 'pending' }]);
  runner.noteRunData({ records: RECORDS, pageUrl: 'https://page.example/' });
  runner.recordEntry({ type: 'agent_response', step: 1, thought: '', action: { action: 'read_page' } as any, rawResponse: '{}' });
  await settle();
  assert.equal(local()[chatKey(runner.chatId)], undefined, 'a running chat waits for its window');
  // The browser closes here: the throttled save is what is left of the run.
  await (runner as any).chatSaver.flush();
  const running = local()[chatKey(runner.chatId)];
  assert.equal(running.status, 'running');
  assert.equal(running.task, 'Make the file');
  assert.deepEqual(running.records, RECORDS, 'the records of the run that goes ride along');
  assert.equal(running.pageUrl, 'https://page.example/');

  runner.stop();
  await settle();
  const ended = local()[chatKey(runner.chatId)];
  assert.equal(ended.status, 'stopped', 'saved at once when the run rests');
  assert.equal(ended.records, undefined, 'an ended run keeps its records on its closing row');
  const closing = ended.history.at(-1);
  assert.equal(closing.type, 'partial_result');
  assert.equal(closing.answer, STOPPED_TEXT);
  assert.deepEqual(closing.records, RECORDS);
  assert.deepEqual(closing.plan, [{ text: 'Read', status: 'completed' }, { text: 'Save', status: 'pending' }]);
  assert.equal(closing.pageUrl, 'https://page.example/');
  assert.deepEqual(local()['sf:chats'].map((c: any) => c.id), [runner.chatId], 'one entry in Recent tasks');
});

test('a stored history keeps records only on its last closing row', () => {
  const snap = (history: any[]): RunSnapshot => ({ status: 'idle', task: '', history, planSteps: [], stepCount: 0, pauseReason: null, stateVersion: 1, savedAt: 0 });
  const fitted = fitSnapshot(snap([
    { type: 'user_goal', turn: 1, prompt: 'a' }, { type: 'finish', answer: 'x', records: RECORDS },
    { type: 'user_goal', turn: 2, prompt: 'b' }, { type: 'partial_result', answer: 'y', table: null, reason: 'stopped', records: RECORDS }
  ]));
  assert.equal((fitted.history[1] as any).records, undefined, 'an earlier turn handed its records over in its file');
  assert.deepEqual((fitted.history[3] as any).records, RECORDS);
});

test('a run the worker died under keeps its records and plan on the interrupted row', () => {
  const run = restoredRun({
    status: 'running', task: 't', history: [{ type: 'user_goal', turn: 1, prompt: 't' } as any], planSteps: [{ text: 'Read', status: 'completed' }],
    stepCount: 0, pauseReason: null, stateVersion: 3, savedAt: 0, records: RECORDS, pageUrl: 'https://p.example/'
  });
  const row = run.history.at(-1) as any;
  assert.equal(row.reason, 'interrupted');
  assert.deepEqual(row.records, RECORDS);
  assert.deepEqual(row.plan, [{ text: 'Read', status: 'completed' }]);
  assert.equal(row.pageUrl, 'https://p.example/');
  assert.deepEqual(run.records, [], 'the records moved onto the row');
});

/** A chat saved while its run went, as a closed browser leaves it. */
async function seedCutOffChat(id = 'chat_saved_1') {
  const chat: SavedSession = {
    id, task: 'Make the file', timestamp: 't', model: 'lisa-pro', provider: 'lisa', status: 'running',
    history: [
      { type: 'user_goal', turn: 1, prompt: 'Make the file', timestamp: '', isNewRun: true },
      { type: 'agent_response', step: 1, thought: '', action: { action: 'save_data', count: 1 }, rawResponse: '{}' },
      { type: 'execution_result', step: 1, success: true, message: 'Saved 1 new record (1 in total).' }
    ],
    planSteps: [{ text: 'Save', status: 'in_progress' }],
    records: RECORDS,
    pageUrl: 'https://page.example/'
  };
  await new Promise<void>((resolve) => chrome.storage.local.set({ [chatKey(id)]: chat, 'sf:chats': [{ id, task: chat.task }] }, () => resolve()));
  return chat;
}

test('LOAD_CHAT is refused while a task runs', async (t) => {
  const { runner } = setup(t);
  await seedCutOffChat();
  runner.setRunStatus('running');
  const res = await runner.loadChat('chat_saved_1');
  assert.equal(res.success, false);
  assert.match(res.error || '', /Stop the task/);
  assert.equal(runner.history.length, 0, 'nothing was taken over');
  runner.setRunStatus('idle');
  const missing = await runner.loadChat('chat_gone');
  assert.equal(missing.success, false);
  assert.match(missing.error || '', /no longer saved/);
});

test('LOAD_CHAT takes the saved chat over: history, plan, an interrupted row for a cut-off run, the snapshot, one entry', async (t) => {
  const { runner, store, local } = setup(t);
  await runner.restorePromise;
  await seedCutOffChat();
  (runner as any).findings = [{ x: 1 }];
  const res = await runner.loadChat('chat_saved_1');
  assert.equal(res.success, true);
  assert.equal(runner.chatId, 'chat_saved_1');
  assert.equal(runner.status, 'idle');
  assert.deepEqual(runner.planSteps, [{ text: 'Save', status: 'in_progress' }]);
  assert.deepEqual(runner.findings, [], 'what belonged to the chat on screen is gone');
  const row = runner.history.at(-1) as any;
  assert.deepEqual({ type: row.type, answer: row.answer, reason: row.reason }, { type: 'partial_result', answer: CLOSED_TEXT, reason: 'closed' });
  assert.deepEqual(row.records, RECORDS);
  assert.deepEqual(row.plan, [{ text: 'Save', status: 'in_progress' }]);
  assert.equal(row.pageUrl, 'https://page.example/');
  assert.equal(runner.getState().chatId, 'chat_saved_1', 'the panel learns which chat it shows');
  await settle(400);
  const snapshot = store.snapshot().session[runSnapshotKey(runner.threadId)] as any;
  assert.ok(snapshot, 'the snapshot is written for a worker restart');
  assert.equal(snapshot.chatId, 'chat_saved_1');
  // The interrupted row is saved back to the same entry, and the chat is not cut off any more.
  const saved = local()[chatKey('chat_saved_1')];
  assert.equal(saved.status, 'idle');
  assert.equal(saved.history.at(-1).reason, 'closed');
  assert.equal(local()['sf:chats'].length, 1, 'still one entry');
  // Opened again it is not cut off a second time.
  await runner.loadChat('chat_saved_1');
  assert.equal(runner.history.filter((r) => r.type === 'partial_result').length, 1);
});

test('New chat starts a new chat id: the old entry is not written again', async (t) => {
  const { runner, local } = setup(t);
  await runner.restorePromise;
  await seedCutOffChat();
  await runner.loadChat('chat_saved_1');
  await settle();
  const before = JSON.stringify(local()[chatKey('chat_saved_1')]);
  runner.clearHistory();
  assert.notEqual(runner.chatId, 'chat_saved_1');
  runner.recordEntry({ type: 'user_goal', turn: 1, prompt: 'Something else', timestamp: '', isNewRun: true });
  runner.setRunStatus('idle');
  await settle();
  assert.equal(JSON.stringify(local()[chatKey('chat_saved_1')]), before, 'the old chat is untouched');
  assert.ok(local()[chatKey(runner.chatId)], 'the new chat has its own entry');
});
