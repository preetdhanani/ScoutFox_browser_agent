/**
 * Recent tasks in the panel: the list, and opening a chat from it.
 *
 * The background saves every chat (AgentRunner is the single writer, see tests/runner/chatResume.test.ts);
 * the panel lists the saved chats, opens one, and deletes one, and never writes a chat itself.
 *
 * What these tests hold on to:
 *   1. The panel never writes a chat, whatever states it renders (a run that ends, a repeated
 *      broadcast): two writers would race and a resumed chat would split into two entries.
 *   2. The chat on screen is the runner's chatId: the list marks that entry.
 *   3. Opening a chat sends LOAD_CHAT with its id, so the runner takes it as the live chat; a
 *      refusal (a task is running) is said in a toast and the chat on screen stays.
 *   4. The list escapes every stored field it puts into markup (timestamp, model, id).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { install, settle } from './fakePanelDom.js';

const { getEl, storage, sent } = install();

const { receiveState, initEventListeners, loadSettings, loadSelectedSession } = await import('../../sidepanel/sidepanel.js');

initEventListeners();
await loadSettings();

let version = 0;
function stateOf(status, prompt, chatId = 'chat_live') {
  const history = [{ type: 'user_goal', turn: 1, prompt, timestamp: '10:00:00', isNewRun: true },
    { type: 'agent_response', step: 1, thought: '', action: { action: 'scroll', direction: 'down' }, rawResponse: '{}' }];
  if (status !== 'running') history.push({ type: 'finish', answer: `Answer for ${prompt}` });
  version += 1;
  return { status, task: prompt, history, planSteps: [], stepCount: 1, stateVersion: version, bootId: 'boot-sessions', chatId };
}

const chatKeys = () => Object.keys(storage.data).filter((k) => k.startsWith('sf:chat'));

test('the panel never writes a chat, whatever it renders', async () => {
  for (const k of Object.keys(storage.data)) if (k.startsWith('sf:chat') || k === 'saved_sessions') delete storage.data[k];
  receiveState(stateOf('running', 'A run'));
  receiveState(stateOf('idle', 'A run'));
  receiveState(stateOf('idle', 'A run'));
  await settle(10);
  assert.deepEqual(chatKeys(), [], 'no sf:chat key and no index were written by the panel');
  assert.equal(storage.data.saved_sessions, undefined);
});

test('the chat on screen is the runner\'s chatId, and the list marks it', async () => {
  storage.data['sf:chats'] = [{ id: 'chat_a', task: 'A', timestamp: 't', model: 'm' }, { id: 'chat_b', task: 'B', timestamp: 't', model: 'm' }];
  receiveState(stateOf('idle', 'B', 'chat_b'));
  getEl('historyDrawer').style.display = 'none';
  await getEl('btnToggleHistory').dispatchEvent('click');
  await settle(10);
  const html = getEl('historySessionsList').innerHTML;
  assert.match(html, /history-session-item active" data-id="chat_b"/);
  assert.doesNotMatch(html, /history-session-item active" data-id="chat_a"/);
});

test('opening a chat sends LOAD_CHAT with its id', async () => {
  sent.length = 0;
  const res = await loadSelectedSession('chat_a');
  assert.equal(res.success, true);
  const load = sent.find((m) => m.action === 'LOAD_CHAT');
  assert.ok(load, 'LOAD_CHAT was sent');
  assert.deepEqual(load.payload, { sessionId: 'chat_a' });
  assert.equal(getEl('historyDrawer').style.display, 'none', 'the drawer closes');
});

test('a refused LOAD_CHAT is said in a toast, and the chat on screen stays', async () => {
  receiveState(stateOf('idle', 'B', 'chat_b'));
  const real = globalThis.chrome.runtime.sendMessage;
  globalThis.chrome.runtime.sendMessage = (msg, cb) => {
    sent.push(msg);
    cb?.(msg.action === 'LOAD_CHAT' ? { success: false, error: 'Stop the task before you open another chat.' } : { success: true });
  };
  const shown = [];
  const container = getEl('toastContainer');
  const append = container.appendChild.bind(container);
  container.appendChild = (el) => { shown.push(el.textContent); return append(el); };
  try {
    const res = await loadSelectedSession('chat_a');
    assert.equal(res.success, false);
    assert.ok(shown.some((t) => /Stop the task/.test(t)), 'the refusal is shown');
    await getEl('btnToggleHistory').dispatchEvent('click');
    await getEl('btnToggleHistory').dispatchEvent('click');
    await settle(10);
    assert.match(getEl('historySessionsList').innerHTML, /history-session-item active" data-id="chat_b"/, 'the chat on screen is still the marked one');
  } finally {
    globalThis.chrome.runtime.sendMessage = real;
    container.appendChild = append;
  }
});

test('the Recent tasks list escapes the stored timestamp, model and id', async () => {
  storage.data['sf:chats'] = [{
    id: 'x" onmouseover="alert(1)',
    task: 'Task <b>1</b>',
    timestamp: '<img src=x onerror=alert(1)>',
    model: '<script>alert(2)</script>',
    provider: 'openai'
  }];
  getEl('historyDrawer').style.display = 'none';
  await getEl('btnToggleHistory').dispatchEvent('click');
  await settle(10);
  const html = getEl('historySessionsList').innerHTML;
  assert.equal(html.includes('<img'), false, 'timestamp is escaped');
  assert.equal(html.includes('<script>'), false, 'model is escaped');
  assert.equal(html.includes('" onmouseover="'), false, 'id is escaped in the data attributes');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
});
