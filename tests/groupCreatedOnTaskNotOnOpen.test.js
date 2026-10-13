/**
 * Regression test for a direct user request: "it should not be like, if I open the extension
 * then instantly it makes a group - rather, as soon as I give it a task, then it should make a
 * group."
 *
 * Opening the panel is not asking for work. Grouping on open reorganised the tab strip - moving
 * the tab, colouring it, boxing it - just for looking at the extension. The ScoutFox group is a
 * sandbox marker showing which tabs the agent may touch, so it only means anything once there
 * is something to sandbox.
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { routerRig } from './helpers/routerRig.ts';
import { SHOP_LIST_URL, act, shopPages, shopPlan } from './helpers/graphHarness.ts';

const TAB = 100;

const rig = await routerRig({
  tabs: [{ id: TAB, url: SHOP_LIST_URL, groupId: -1, windowId: 1, active: true, index: 0 }],
  pages: shopPages(),
  llm: {
    plan: [shopPlan()],
    policy: [act.finish('done')],
  },
});
after(rig.cleanup);

test('opening the panel creates a session but NO tab group', async () => {
  await rig.clickIcon(rig.fc.tabs.get(TAB));

  assert.equal(rig.fc.tabs.get(TAB)?.groupId, -1,
    'the user asked for the extension, not for work - their tab must be left exactly where and how it was');

  const state = await rig.state(TAB);
  assert.ok(state, 'a session must exist for the clicked tab');
  assert.equal(state.scoutFoxGroupId, null, 'and it must not have a group yet');
});

test('giving it a task is what creates the group', async () => {
  const res = await rig.startTask(TAB, 'now actually do something');
  assert.equal(res?.success, true, 'the task must start');

  assert.ok(rig.fc.tabs.get(TAB)?.groupId > 0,
    'once there is a task, the tab is sandboxed into a ScoutFox group - that is when the marker means something');

  const state = await rig.state(TAB);
  assert.ok(state.scoutFoxGroupId, 'and the session must report the group it created');
});
