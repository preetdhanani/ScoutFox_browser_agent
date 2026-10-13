/**
 * Regression test: a side panel that reconnects while the agent is waiting on ask_user must be
 * given the question it is waiting on.
 *
 * pendingQuestion is broadcast on every live STATE_UPDATE (notifyStateChange), but neither
 * RECONNECT path carried it: not the initial state the onConnect handler posts, nor the
 * GET_AGENT_STATE resync. A live panel was therefore fine, and a reopened one was not - it
 * rendered a run stuck at 'paused' with no question and no answer box, which the user cannot
 * clear or answer. Only Stop got them out.
 *
 * That combination is not exotic, it is the common case for this bug report: Chrome closes the
 * panel when the automation tab is activated, so by the time the agent asks anything, the panel
 * the user reopens is always a reconnected one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { routerRig } from './helpers/routerRig.ts';
import { SHOP_LIST_URL, act, shopPages, shopPlan } from './helpers/graphHarness.ts';

const QUESTION = 'Which of your two accounts should I sign in with?';

const rig = await routerRig({
  tabs: [{ id: 100, url: SHOP_LIST_URL, windowId: 1, active: true }],
  pages: shopPages(),
  llm: {
    plan: [shopPlan()],
    policy: [
      act.askUser(QUESTION),
      act.finish('done'),
    ],
  },
});

const firstPanel = await rig.connect(100);
await rig.startTask(100, 'sign me in');
await rig.waitForStatus(100, 'paused');

test('the live panel sees the question (setup sanity check)', () => {
  const live = firstPanel.lastState();
  assert.equal(live?.['status'], 'paused', 'the agent must genuinely be waiting on an answer');
  assert.equal(live?.['pendingQuestion'], QUESTION,
    'the live broadcast path already carried the question - that is why the gap went unnoticed');
});

test('a panel reconnecting mid-question is given the question', async () => {
  const reopened = await rig.connect(100);
  const initial = reopened.lastState();
  assert.equal(initial?.['status'], 'paused', 'the reopened panel must see the paused run');
  assert.equal(initial?.['pendingQuestion'], QUESTION,
    'without the question, the reopened panel renders a paused run with no answer box - a dead end the user cannot clear');
});

test('the GET_AGENT_STATE resync carries the question too', async () => {
  const state = await rig.state(100);
  assert.equal(state?.['status'], 'paused', 'the resync must agree that the run is paused');
  assert.equal(state?.['pendingQuestion'], QUESTION,
    'the resync overwrites the panel\'s view, so it must carry the question as well as the port path does');
});

test('answering it clears the question everywhere', async () => {
  const res = await rig.send({
    action: 'ANSWER_QUESTION', tabId: 100, payload: { answer: 'the work one' }
  });
  assert.equal(res?.success, true, 'the answer must be accepted');

  const state = await rig.state(100);
  assert.equal(state?.['pendingQuestion'], null,
    'once answered, the resync must stop reporting a question - a stale one would re-render the answer box');

  await rig.send({ action: 'STOP_TASK', tabId: 100 });
  await rig.cleanup();
});
