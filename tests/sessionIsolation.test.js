/**
 * Tests for the per-TAB session model: each tab gets its own independent ScoutFox session (own
 * tab group, own history, own running task, own Stop/Pause), reopening the panel on a tab
 * reflects that tab's current session rather than resetting it, and the agent can only read/act
 * on tabs inside its OWN group - zero access outside it.
 *
 * Per tab, not per window, so two tabs side by side in the SAME window are as independent as two
 * tabs in different windows. That is the point of the model: start a task in one tab, open
 * another tab and start something completely unrelated, and neither disturbs the other.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { routerRig } from './helpers/routerRig.ts';
import { SHOP_LIST_URL, act, shopPages, shopPlan } from './helpers/shopPages.ts';
import { AgentRunner } from '../src/background/runner/AgentRunner.ts';

test('two tabs in the SAME window get fully independent sessions', async (t) => {
  const rig = await routerRig({
    tabs: [
      { id: 101, url: SHOP_LIST_URL, windowId: 1, active: true },
      { id: 102, url: SHOP_LIST_URL, windowId: 1, active: false },
    ],
    pages: shopPages(),
    llm: {
      plan: [shopPlan()],
      policy: [act.finish('done')],
    },
  });
  t.after(rig.cleanup);

  const portA = await rig.connect(101, { fresh: true });
  const portB = await rig.connect(102, { fresh: true });

  assert.deepEqual(portA.lastState()?.history, []);
  assert.deepEqual(portB.lastState()?.history, []);

  const startRes = await rig.startTask(101, 'task for tab 101 only');
  assert.equal(startRes?.success, true);
  assert.equal(startRes?.tabId, 101, 'a task must run in the tab whose panel started it, never a neighbouring tab');

  const stateA = await rig.state(101);
  const stateB = await rig.state(102);

  assert.equal(stateA.task, 'task for tab 101 only', 'tab 101\'s own session must show the task it started');
  assert.ok(!stateB.task,
    'tab 102\'s session must be completely untouched - same window, but a different session entirely');
  assert.notEqual(stateA.bootId, undefined);

  portA.disconnect();
  portB.disconnect();
});

test('two tabs in DIFFERENT windows are independent too, with their own tab groups', async (t) => {
  const rig = await routerRig({
    tabs: [
      { id: 201, url: SHOP_LIST_URL, windowId: 2, active: true },
      { id: 301, url: SHOP_LIST_URL, windowId: 3, active: true },
    ],
    pages: shopPages(),
    llm: {
      plan: [shopPlan()],
      policy: [act.finish('done')],
    },
    chrome: { windows: true },
  });
  t.after(rig.cleanup);

  const portA = await rig.connect(201, { fresh: true });
  const portB = await rig.connect(301, { fresh: true });

  await rig.startTask(201, 'window 2 task');
  await rig.startTask(301, 'window 3 task');

  const stateA = await rig.state(201);
  const stateB = await rig.state(301);

  assert.equal(stateA.task, 'window 2 task');
  assert.equal(stateB.task, 'window 3 task');
  assert.notEqual(stateA.scoutFoxGroupId, stateB.scoutFoxGroupId,
    'each session must get its OWN tab group, never a shared one - and a Chrome group cannot span windows anyway');

  portA.disconnect();
  portB.disconnect();
});

test('reopening the panel on a tab reflects that tab\'s current session, not a reset', async (t) => {
  const rig = await routerRig({
    tabs: [{ id: 401, url: SHOP_LIST_URL, windowId: 4, active: true }],
    pages: shopPages(),
    llm: {
      plan: [shopPlan()],
      policy: [act.finish('done')],
    },
  });
  t.after(rig.cleanup);

  const port1 = await rig.connect(401, { fresh: true });
  await rig.startTask(401, 'a real task');

  port1.disconnect();

  const port2 = await rig.connect(401, { fresh: true });
  const reopened = port2.lastState();
  assert.equal(reopened?.task, 'a real task',
    'reopening the panel on a tab must show the session that is actually there, not silently reset it');

  port2.disconnect();
});

test('a brand new tab opening the extension starts its own blank session', async (t) => {
  const rig = await routerRig({
    tabs: [
      { id: 501, url: SHOP_LIST_URL, windowId: 5, active: true },
      { id: 502, url: SHOP_LIST_URL, windowId: 5, active: false },
    ],
    pages: shopPages(),
    llm: {
      plan: [shopPlan()],
      policy: [act.finish('done')],
    },
  });
  t.after(rig.cleanup);

  const portExisting = await rig.connect(501, { fresh: true });
  await rig.startTask(501, 'existing tab task');

  const portNew = await rig.connect(502, { fresh: true });
  assert.deepEqual(portNew.lastState()?.history, [],
    'a brand new tab opening the extension must start blank, not see the neighbouring tab\'s session');
  assert.ok(!portNew.lastState()?.task);

  portExisting.disconnect();
  portNew.disconnect();
});

test('the hard access wall: a session cannot read a tab outside its own ScoutFox group', async (t) => {
  const rig = await routerRig({
    tabs: [
      { id: 1001, url: 'https://example.com/mine', windowId: 10, groupId: 7000 },
      { id: 1002, url: 'https://example.com/theirs', windowId: 11, groupId: 8000 },
    ],
  });
  t.after(rig.cleanup);

  const runnerA = new AgentRunner(1001, 10);
  await runnerA.restorePromise;
  runnerA.scoutFoxGroupIds.set(10, 7000);

  assert.equal(await runnerA.runtime.browser.isTabInScope(1001), true, 'a tab inside this session\'s own group must be in scope');
  assert.equal(await runnerA.runtime.browser.isTabInScope(1002), false, 'a tab in a DIFFERENT group must never be in scope');

  await assert.rejects(
    () => runnerA.runtime.browser.snapshot(1002, { docId: '1' }),
    /outside this session's ScoutFox group/,
    'acting on a tab outside this session\'s group must be refused outright, not silently succeed'
  );
});

test('closing a tab ends its session and forgets its persisted state', async (t) => {
  const rig = await routerRig({
    tabs: [{ id: 601, url: SHOP_LIST_URL, windowId: 6, active: true }],
    pages: shopPages(),
    llm: {
      plan: [shopPlan()],
      policy: [act.finish('done')],
    },
  });
  t.after(rig.cleanup);

  const port = await rig.connect(601, { fresh: true });
  await rig.startTask(601, 'about to close');

  port.disconnect();

  rig.fc.tabs.close(601);
  await rig.settle();

  rig.fc.tabs.add({ id: 601, url: SHOP_LIST_URL, windowId: 6, active: true });
  const portAfter = await rig.connect(601, { fresh: true });
  assert.ok(!portAfter.lastState()?.task,
    'a new tab reusing that id must not inherit the closed session');
  portAfter.disconnect();
});
