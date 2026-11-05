/**
 * LOAD_CHAT through the background router: a chat from Recent tasks becomes a tab's live chat.
 *
 * What these tests hold on to:
 *   1. A finished task is saved into Recent tasks by the background (the panel writes nothing).
 *   2. LOAD_CHAT is refused while another tab holds the same chat: two runners saving one chat
 *      would wipe each other's turns.
 *   3. Once the other tab let go (New chat), the chat opens in this tab, its history is the
 *      runner's own, and the next task gets its turns in the chain and saves to the same entry.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { routerRig } from '../helpers/routerRig.ts';
import { cdp } from '../../src/background/browser/cdp.ts';
import { chatKey } from '../../src/shared/storage.ts';

const finish = (answer: string) => JSON.stringify({ action: 'finish', answer, outcome: 'done' });

test('a chat opens in another tab only once the tab that holds it let go, and goes on there', async (t) => {
  t.mock.method(cdp, 'detach', async () => {});
  const rig = await routerRig({
    tabs: [{ id: 100, url: 'https://example.com/a', windowId: 1, active: true }, { id: 200, url: 'https://example.com/b', windowId: 1 }],
    llm: { policy: [finish('The page lists 10 certifications.'), finish('70')] }
  });
  t.after(rig.cleanup);
  const firstUserOf = (body: any) => String((body?.messages || []).find((m: any) => m.role === 'user')?.content || '');

  await rig.startTask(100, 'How many certifications does this page list?');
  await rig.waitForStatus(100, 'idle');
  const chatId = (await rig.state(100))['chatId'];
  assert.match(String(chatId), /^chat_/);
  await new Promise((r) => setTimeout(r, 50));
  const saved = await new Promise<any>((resolve) => chrome.storage.local.get([chatKey(chatId), 'sf:chats'], resolve));
  assert.ok(saved[chatKey(chatId)], 'the background saved the chat');
  assert.equal(saved[chatKey(chatId)].task, 'How many certifications does this page list?');

  const refused = await rig.send({ action: 'LOAD_CHAT', tabId: 200, payload: { sessionId: chatId } });
  assert.equal(refused.success, false);
  assert.match(String(refused.error), /open in another tab/);

  await rig.send({ action: 'CLEAR_HISTORY', tabId: 100 });
  const opened = await rig.send({ action: 'LOAD_CHAT', tabId: 200, payload: { sessionId: chatId } });
  assert.equal(opened.success, true, JSON.stringify(opened));
  const state = await rig.state(200);
  assert.equal(state['chatId'], chatId);
  assert.ok(state['history'].some((r: any) => r.type === 'user_goal' && /certifications/.test(r.prompt)));

  const before = rig.httpCalls.length;
  await rig.startTask(200, 'Multiply it by 7.');
  await rig.waitForStatus(200, 'idle');
  const request = rig.httpCalls.slice(before).find((c) => c.url.endsWith('/chat/completions'))?.body;
  assert.match(firstUserOf(request), /The page lists 10 certifications\./, 'the reopened chat is in the chain');
  await new Promise((r) => setTimeout(r, 50));
  const index = await new Promise<any>((resolve) => chrome.storage.local.get(['sf:chats'], resolve));
  assert.equal(index['sf:chats'].filter((c: any) => c.id === chatId).length, 1, 'still one entry for the chat');
  assert.equal(index['sf:chats'][0].id, chatId, 'and it is the newest');
});
