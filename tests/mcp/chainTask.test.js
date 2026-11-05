/**
 * The checks of the real-model chain task (web-chat-chain in tests/mcp/tasks.mjs) and the call
 * record field it reads (firstUserText in tests/mcp/callRecord.mjs). The task itself needs LISA;
 * these pure parts are pinned here so a broken check cannot pass a wrong run.
 *
 * What these tests hold on to:
 *   1. The follow-up answer must be 70, with no other number than the 10 and the 7 it comes from.
 *   2. A follow-up that reads or looks at the page is caught (read_page, get_page_elements, find,
 *      take_screenshot), and research or actions are not mistaken for reads.
 *   3. The call record keeps the first user message (where the chain is), without the run state.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CHAIN_FOLLOW_UP_PROMPT, TASKS, pageReadSteps } from './tasks.mjs';
import { buildCallRecord, firstUserTextOf } from './callRecord.mjs';

const task = TASKS['web-chat-chain'];

test('the chain task: turn 1 on credentials.html, a Compact, then turn 2 on notebook.html with the exact prompt', () => {
  assert.equal(task.page, 'credentials.html');
  assert.equal(task.web, true);
  assert.equal(task.followUp.compact, true);
  assert.equal(task.followUp.navigate, 'notebook.html');
  assert.equal(task.followUp.noReads, true);
  assert.equal(CHAIN_FOLLOW_UP_PROMPT, 'Take the number of certifications you gave me in your last answer, multiply it by 7, and reply with the result only.');
  assert.equal(task.followUp.prompt, CHAIN_FOLLOW_UP_PROMPT);
  assert.equal(task.check({ answer: 'The page lists 10 certifications.' }), true);
  assert.equal(task.check({ answer: 'The page lists 9 certifications.' }), false);
});

test('the follow-up answer must be 70, and nothing else', () => {
  const ok = (answer) => task.followUp.check({ answer });
  for (const right of ['70', '**70**', 'The result is 70.', '70 (10 x 7)']) assert.equal(ok(right), true, right);
  for (const wrong of ['71', '700', '70 or 84', 'seventy', '', '7']) assert.equal(ok(wrong), false, wrong);
});

test('a follow-up that reads or looks at the page is caught', () => {
  const steps = (actions) => ({ steps: actions.map((action, i) => ({ step: i + 1, action: { action } })) });
  assert.deepEqual(pageReadSteps(steps(['update_plan', 'finish'])), []);
  assert.deepEqual(pageReadSteps(steps(['web_search', 'scroll', 'finish'])), []);
  for (const read of ['read_page', 'get_page_elements', 'find_elements', 'take_screenshot']) {
    assert.equal(pageReadSteps(steps([read, 'finish'])).length, 1, read);
  }
});

test('the call record keeps the first user message, where the chain is, without the run state', () => {
  const messages = [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: 'EARLIER IN THIS CHAT (for context; the task below is the current one):\n\nSummary of 1 earlier turn: 10.\n\nTASK: x\n\n[Run state] Goal: x' },
    { role: 'user', content: [{ type: 'text', text: 'a picture' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAA' } }] }
  ];
  assert.equal(firstUserTextOf(messages), 'EARLIER IN THIS CHAT (for context; the task below is the current one):\n\nSummary of 1 earlier turn: 10.\n\nTASK: x');
  assert.equal(firstUserTextOf([{ role: 'system', content: 'only' }]), '');
  const record = buildCallRecord({ n: 1, status: 200, ms: 5, requestBytes: 10, responseBytes: 10, sent: { model: 'm', messages, tools: [{}] }, got: {} });
  assert.match(record.firstUserText, /^EARLIER IN THIS CHAT/);
});
