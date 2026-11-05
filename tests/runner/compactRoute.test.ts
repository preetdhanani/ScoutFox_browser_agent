/**
 * COMPACT_CHAT through the background router, and the chain a follow-up task is sent.
 *
 * What these tests hold on to:
 *   1. A follow-up task in the same tab and chat gets the earlier turn at the top of its first
 *      request, and every state carries the context meter's numbers.
 *   2. COMPACT_CHAT is a tab action: it compacts the chat of that tab, and the next task starts
 *      from the summary instead of the turns it stands for.
 *   3. COMPACT_CHAT is refused while a task runs, so a Compact can never race a run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRunner } from '../../src/background/runner/AgentRunner.ts';
import { routerRig } from '../helpers/routerRig.ts';
import { act } from '../helpers/shopPages.ts';
import { cdp } from '../../src/background/browser/cdp.ts';
import { CHAIN_HEADER } from '../../src/background/mcp/chatChain.ts';

const finish = (answer: string) => JSON.stringify({ action: 'finish', answer, outcome: 'done' });

test('a follow-up task gets the earlier turn, and after COMPACT_CHAT it gets the summary instead', async (t) => {
  t.mock.method(cdp, 'detach', async () => {});
  /** The first user message of each request the extension sent, as text. */
  const firstUserOf = (body: any) => String((body?.messages || []).find((m: any) => m.role === 'user')?.content || '');
  /** The body of the first model request from position `from` on. */
  const modelRequestFrom = (from: number) => rig.httpCalls.slice(from).find((c) => c.url.endsWith('/chat/completions'))?.body;
  const rig = await routerRig({
    tabs: [{ id: 100, url: 'https://example.com/a', windowId: 1, active: true }],
    llm: {
      policy: [
        finish('The page lists 10 certifications.'),
        finish('70'),
        finish('140')
      ]
    }
  });
  t.after(rig.cleanup);
  t.mock.method(AgentRunner.prototype, 'summarizeChat', async () => 'SUMMARY: the page lists 10 certifications; 10 times 7 is 70.');

  await rig.startTask(100, 'How many certifications does this page list?');
  await rig.waitForStatus(100, 'idle');
  const afterFirst = await rig.state(100);
  assert.ok(afterFirst['context'], 'the state carries the context meter');
  assert.ok(afterFirst['context'].used > 0, 'a chat with a turn counts more than nothing');
  assert.equal(afterFirst['context'].hasEarlierTurn, true);

  const beforeSecond = rig.httpCalls.length;
  await rig.startTask(100, 'Multiply it by 7.');
  await rig.waitForStatus(100, 'idle');
  const firstMessages = [firstUserOf(modelRequestFrom(beforeSecond))];
  assert.ok(firstMessages[0].startsWith(CHAIN_HEADER), 'the follow-up starts with the chain');
  assert.match(firstMessages[0], /The page lists 10 certifications\./);

  const compacted = await rig.send({ action: 'COMPACT_CHAT', tabId: 100 });
  assert.equal(compacted.success, true, JSON.stringify(compacted));
  const state = await rig.state(100);
  const row = state['history'].find((r: any) => r.type === 'chat_compacted');
  assert.ok(row, 'the chat_compacted row is in the history');
  assert.equal(row.summarizedTurns, 2);
  assert.equal(state['context'].summarizedTurns, 2);

  const beforeThird = rig.httpCalls.length;
  await rig.startTask(100, 'And by 14?');
  await rig.waitForStatus(100, 'idle');
  firstMessages.push(firstUserOf(modelRequestFrom(beforeThird)));
  assert.match(firstMessages[1], /Summary of 2 earlier turns/);
  assert.match(firstMessages[1], /SUMMARY: the page lists 10 certifications/);
  assert.doesNotMatch(firstMessages[1], /Turn 1 \(done\)/, 'the summarized turns are not sent again');
  const goals = (await rig.state(100))['history'].filter((r: any) => r.type === 'user_goal').map((r: any) => r.turn);
  assert.deepEqual(goals, [1, 2, 3]);
});

test('COMPACT_CHAT is refused while a task runs', async (t) => {
  t.mock.method(cdp, 'detach', async () => {});
  let release!: (text: string) => void;
  const held = new Promise<string>((resolve) => { release = resolve; });
  const rig = await routerRig({
    tabs: [{ id: 100, url: 'https://example.com/a', windowId: 1, active: true }],
    llm: { policy: [finish('first'), () => held] }
  });
  t.after(rig.cleanup);
  const summarize = t.mock.method(AgentRunner.prototype, 'summarizeChat', async () => 'S');
  await rig.startTask(100, 'One');
  await rig.waitForStatus(100, 'idle');
  await rig.startTask(100, 'Two');
  await rig.waitForStatus(100, 'running');
  const refused = await rig.send({ action: 'COMPACT_CHAT', tabId: 100 });
  assert.equal(refused.success, false);
  assert.match(refused.error, /Stop the task/);
  assert.equal(summarize.mock.callCount(), 0, 'the model was not asked for a summary');
  release(act.wait(1));
  await rig.send({ action: 'STOP_TASK', tabId: 100 });
  await rig.settle();
});

test('no task starts while a Compact is being written: COMPACT_CHAT holds the task claim', async (t) => {
  t.mock.method(cdp, 'detach', async () => {});
  const rig = await routerRig({
    tabs: [{ id: 100, url: 'https://example.com/a', windowId: 1, active: true }],
    llm: { policy: [finish('first')] }
  });
  t.after(rig.cleanup);
  let release!: (text: string) => void;
  t.mock.method(AgentRunner.prototype, 'summarizeChat', () => new Promise<string>((resolve) => { release = resolve; }));
  await rig.startTask(100, 'One');
  await rig.waitForStatus(100, 'idle');
  const compacting = rig.send({ action: 'COMPACT_CHAT', tabId: 100 });
  await rig.settle();
  const started = await rig.send({ action: 'START_TASK', tabId: 100, payload: { prompt: 'Two', autoApprove: true } });
  assert.equal(started.success, false, 'START_TASK is refused while the summary is written');
  release('S');
  assert.equal((await compacting).success, true);
  assert.equal((await rig.send({ action: 'COMPACT_CHAT', tabId: 100 })).success, false, 'nothing new to compact');
});
