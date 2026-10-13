/**
 * Regression tests for a real user report: a task ran to completion ("Opened google.com",
 * "finish") while the user sat watching a tab where nothing happened.
 *
 * getActiveTab()'s old third fallback searched the window for any scriptable tab and ran
 * against the FIRST one in tab-strip order, without ever activating it. So clicking the icon
 * on chrome://newtab (an entirely ordinary starting point) handed the agent whatever unrelated
 * tab the user happened to have open - their mail, a half-filled form - and drove it invisibly,
 * several positions away in the strip.
 *
 * Now: the session's own tab if it can be scripted; else, if it is an empty new-tab page, that
 * same tab navigated in place; else a fresh tab opened immediately to the right of it. An
 * unrelated tab the user opened for their own purposes is never commandeered.
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { routerRig } from './helpers/routerRig.ts';
import { fakeLlm } from './helpers/fakeLlm.ts';
import { act, shopPlan } from './helpers/graphHarness.ts';
import { button } from './helpers/fakeDom.ts';

const fl = fakeLlm((call) => {
  if (call?.role === 'planner' || call?.node === 'plan' || call?.systemPrompt?.includes('plan')) {
    const raw = typeof call?.messages?.at(-1)?.content === 'string' ? call.messages.at(-1).content : '';
    const match = raw.match(/https?:\/\/([^/\s"':]+)/);
    const domain = match ? match[1] : 'google.com';
    return shopPlan([{ id: 's1', name: domain, domain, role: 'reference', kind: 'page', goal: 'Do task' }]);
  }
  return act.finish('done');
});

const rig = await routerRig({
  tabs: [
    { id: 100, url: 'chrome://settings/', index: 0, windowId: 1, active: true },
    { id: 200, url: 'https://mail.example.com/inbox', index: 1, windowId: 1, active: false },
  ],
  pages: [
    { url: 'https://www.google.com', text: ['Google Search Engine Page with content and options.'], elements: [button('Search')] },
    { url: 'https://mail.example.com/inbox', text: ['Inbox Page with email list.'], elements: [button('Compose')] },
    { url: 'https://example.com/work', text: ['Work Page with active project dashboard.'], elements: [button('Action')] },
  ],
  llm: fl,
});

after(rig.cleanup);

test('a restricted focused tab gets a fresh tab beside it - never the user\'s unrelated tab', async () => {
  const panelPort = await rig.connect(100, { fresh: true });
  const beforeCreate = rig.fc.callsTo('tabs.create').length;

  const res = await rig.startTask(100, 'find something');

  assert.equal(res?.success, true, 'the task must start');
  assert.notEqual(res?.tabId, 200,
    'the user\'s own unrelated tab must never be commandeered for automation - that was the ' +
    'old [TAB_SUBSTITUTED] behaviour, and it ran invisibly in a tab they were not even looking at');

  const creates = rig.fc.callsTo('tabs.create').slice(beforeCreate);
  assert.equal(creates.length, 1, 'exactly one fresh tab must be opened for the task');
  const created = creates[0]?.args[0];

  assert.equal(created?.active, false,
    'the automation tab must be created in the background, so it can be grouped and have the panel enabled on it before it comes to the front');

  const activated = rig.fc.callsTo('tabs.update').find((c) => c.args[0] === res?.tabId && c.args[1]?.active === true);
  assert.ok(activated,
    'the automation tab must still be brought to the front afterwards, or the run is invisible - deferring the activation must not mean skipping it');

  const handoff = panelPort.received.find((m) => m?.type === 'PANEL_HANDOFF');
  assert.ok(handoff, 'the submitting panel must be asked to follow the run onto the new tab');
  assert.deepEqual(handoff?.payload, { tabId: res?.tabId, fromTabId: 100 },
    'the handoff must name the new tab, and the panel that submitted the task - only that panel holds the gesture');

  assert.equal(created?.index, 1,
    'the fresh tab must open immediately to the RIGHT of the focused tab (index 0), not appended to the far end of the strip');
  assert.equal(created?.windowId, 1, 'it must open in the requesting panel\'s own window');
  assert.equal(rig.fc.tabs.get(res?.tabId)?.url, 'https://www.google.com', 'the task must run in that fresh tab');
  assert.equal(res?.tabUrl, 'https://www.google.com',
    'the panel must be told where the run started - a tab fresh out of tabs.create has only pendingUrl, which showed up as "unknown URL"');

  await rig.waitForStatus(100, 'idle');
});

test('a session whose own tab is scriptable uses it as-is, with no new tab opened', async () => {
  rig.fc.tabs.add({ id: 300, url: 'https://example.com/work', index: 2, windowId: 1, active: true });
  await rig.connect(300);

  const beforeCreate = rig.fc.callsTo('tabs.create').length;

  const res = await rig.startTask(300, 'work on this page');

  assert.equal(res?.success, true, 'the task must start');
  assert.equal(res?.tabId, 300,
    'a session runs in ITS OWN tab - the one its panel is attached to and the user is looking at');

  const creates = rig.fc.callsTo('tabs.create').slice(beforeCreate);
  assert.equal(creates.length, 0, 'no extra tab should be opened when the session\'s own tab already works');

  await rig.waitForStatus(300, 'idle');
});

test('a session never reaches into a tab belonging to a different session', async () => {
  rig.fc.tabs.activate(300);
  await rig.settle();

  const beforeCreate = rig.fc.callsTo('tabs.create').length;

  const res = await rig.startTask(100, 'carry on');

  assert.equal(res?.success, true, 'the task must start');
  assert.notEqual(res?.tabId, 300, 'another session\'s tab must never be commandeered, focused or not');
  assert.notEqual(res?.tabId, 200, 'and neither must a tab the user opened for themselves');

  await rig.waitForStatus(100, 'idle');
});

test('a follow-up task continues in the tab the run already moved into', async () => {
  const sessionTabs = rig.fc.tabs.list().filter((t) => t.groupId > 0);
  assert.ok(sessionTabs.length > 0, 'sanity check: the first run put at least one tab in the group');

  const beforeCreate = rig.fc.callsTo('tabs.create').length;

  const res = await rig.startTask(100, 'and now the next thing');

  assert.equal(res?.success, true, 'the task must start');
  assert.ok(rig.fc.tabs.get(res?.tabId)?.groupId > 0,
    'the reused tab must be one inside this session\'s own ScoutFox group, not an arbitrary window tab');

  const creates = rig.fc.callsTo('tabs.create').slice(beforeCreate);
  assert.equal(creates.length, 0, 'no new tab is needed when the session already owns a scriptable one');

  await rig.waitForStatus(100, 'idle');
});

test('an empty new-tab page is reused in place - no second tab, so the side panel stays open', async () => {
  rig.fc.tabs.add({ id: 400, url: 'chrome://newtab/', index: 3, windowId: 2, active: true });
  await rig.connect(400);

  const beforeCreate = rig.fc.callsTo('tabs.create').length;

  const res = await rig.startTask(400, 'find something');

  assert.equal(res?.success, true, 'the task must start');
  assert.equal(res?.tabId, 400, 'the task must run in the new-tab page the panel is attached to');

  const creates = rig.fc.callsTo('tabs.create').slice(beforeCreate);
  assert.equal(creates.length, 0, 'no second tab may be opened for an empty page');
  assert.equal(rig.fc.tabs.get(400)?.url, 'https://www.google.com', 'the empty tab must be navigated in place');
  assert.ok(rig.fc.tabs.get(400)?.groupId > 0, 'the reused tab must join this session\'s ScoutFox group');

  await rig.waitForStatus(400, 'idle');
});
