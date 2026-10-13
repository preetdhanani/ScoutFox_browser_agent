/**
 * Regression tests for a real user report: with ScoutFox's tab group open, opening a new tab
 * of their own next to it silently made that tab part of the automation sandbox.
 *
 * chrome.tabs.onCreated adopted EVERY newly created tab in any window that had a session:
 * it grouped the tab into the ScoutFox group, and - if a run was in progress - retargeted the
 * agent onto it 500ms later. So a tab the user opened for themselves mid-run could have the
 * agent start clicking around in it.
 *
 * Chrome sets openerTabId on a tab opened BY another tab (a target="_blank" link the agent
 * clicked, window.open from a page it drives). A tab whose opener is the very tab the agent is
 * working in is the agent's own; a Cmd+T tab carries no opener, and a link the user clicked
 * elsewhere carries that other tab. Adoption is now gated on exactly that.
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { routerRig } from './helpers/routerRig.ts';
import { SHOP_LIST_URL, act, shopPages, shopPlan } from './helpers/graphHarness.ts';

const AUTOMATED_TAB = 100;
const UNRELATED_TAB = 200;

let finishTask;
const hangingPromise = new Promise((resolve) => { finishTask = resolve; });

const rig = await routerRig({
  tabs: [
    { id: AUTOMATED_TAB, url: SHOP_LIST_URL, windowId: 1, active: true },
    { id: UNRELATED_TAB, url: 'https://mail.example.com/inbox', windowId: 1, active: false },
  ],
  pages: shopPages(),
  llm: {
    plan: [shopPlan()],
    policy: [
      async () => {
        await hangingPromise;
        return act.finish('done');
      },
    ],
  },
});

after(async () => {
  finishTask?.();
  await rig.cleanup();
});

await rig.connect(AUTOMATED_TAB);
const started = await rig.startTask(AUTOMATED_TAB, 'do a thing');
await rig.waitForStatus(AUTOMATED_TAB, 'running');

test('the run is genuinely live on the expected tab (setup sanity check)', async () => {
  assert.equal(started?.success, true, 'the task must have started');
  const state = await rig.state(AUTOMATED_TAB);
  assert.equal(state?.status, 'running', 'the adoption gate reads activeTabId on a running session');
  assert.ok(rig.fc.tabs.get(AUTOMATED_TAB)?.groupId > 0, 'the automated tab must be in the ScoutFox group');
});

test('a tab the AGENT opened (opener is the tab it drives) is adopted into the group', async () => {
  const beforeCount = rig.fc.callsTo('tabs.group').length;
  const beforeGetCount = rig.fc.callsTo('tabs.get').length;

  rig.fc.tabs.add({ id: 700, windowId: 1, url: 'https://example.com/child', openerTabId: AUTOMATED_TAB });
  await new Promise((r) => setTimeout(r, 600));
  await rig.settle();

  const grouped = rig.fc.callsTo('tabs.group').slice(beforeCount).find((c) => c.args[0]?.tabIds === 700 || (Array.isArray(c.args[0]?.tabIds) && c.args[0].tabIds.includes(700)));
  assert.ok(grouped, 'a tab opened by the page the agent is driving must join the ScoutFox group');
  const got700 = rig.fc.callsTo('tabs.get').slice(beforeGetCount).some((c) => c.args[0] === 700);
  assert.ok(got700, 'and the running agent must follow it - that is the target="_blank" case the listener exists for');
});

test('a tab the USER opened (Cmd+T, no opener) is left completely alone', async () => {
  const beforeCount = rig.fc.callsTo('tabs.group').length;
  const beforeGetCount = rig.fc.callsTo('tabs.get').length;

  rig.fc.tabs.add({ id: 800, windowId: 1, url: 'https://news.example.com' });
  await new Promise((r) => setTimeout(r, 600));
  await rig.settle();

  const grouped = rig.fc.callsTo('tabs.group').slice(beforeCount).find((c) => c.args[0]?.tabIds === 800 || (Array.isArray(c.args[0]?.tabIds) && c.args[0].tabIds.includes(800)));
  assert.equal(grouped, undefined,
    'a tab the user opened next to the group must NOT be pulled into the automation sandbox');
  assert.equal(rig.fc.tabs.get(800)?.groupId, -1, 'it must stay ungrouped and independent');
  const got800 = rig.fc.callsTo('tabs.get').slice(beforeGetCount).some((c) => c.args[0] === 800);
  assert.equal(got800, false,
    'and the running agent must never retarget onto it - it is the user\'s tab, not the agent\'s');
});

test('a tab opened from some OTHER tab of the user\'s is left alone too', async () => {
  const beforeCount = rig.fc.callsTo('tabs.group').length;
  const beforeGetCount = rig.fc.callsTo('tabs.get').length;

  rig.fc.tabs.add({ id: 900, windowId: 1, url: 'https://news.example.com/article', openerTabId: UNRELATED_TAB });
  await new Promise((r) => setTimeout(r, 600));
  await rig.settle();

  const grouped = rig.fc.callsTo('tabs.group').slice(beforeCount).find((c) => c.args[0]?.tabIds === 900 || (Array.isArray(c.args[0]?.tabIds) && c.args[0].tabIds.includes(900)));
  assert.equal(grouped, undefined,
    'an opener that is not the tab the agent is driving means the user opened it');
  assert.equal(rig.fc.tabs.get(900)?.groupId, -1, 'it must stay ungrouped and independent');
  const got900 = rig.fc.callsTo('tabs.get').slice(beforeGetCount).some((c) => c.args[0] === 900);
  assert.equal(got900, false, 'and must not steal the agent\'s target');
});

test('a window with no ScoutFox session at all is untouched', async () => {
  const beforeCount = rig.fc.callsTo('tabs.group').length;

  rig.fc.tabs.add({ id: 1000, windowId: 42, url: 'https://example.com/elsewhere', openerTabId: AUTOMATED_TAB });
  await new Promise((r) => setTimeout(r, 100));
  await rig.settle();

  const grouped = rig.fc.callsTo('tabs.group').slice(beforeCount);
  assert.equal(grouped.length, 0,
    'window 42 never opened ScoutFox, so nothing there is any of this session\'s business');
});

test('a user tab Chrome auto-added to the ScoutFox group is pulled back out', async () => {
  const scoutFoxGroupId = rig.fc.tabs.get(AUTOMATED_TAB)?.groupId;
  assert.ok(scoutFoxGroupId && scoutFoxGroupId > 0, 'sanity check: the session really does have a group to be added to');

  await rig.send({ action: 'PAUSE_TASK', tabId: AUTOMATED_TAB });
  await rig.waitForStatus(AUTOMATED_TAB, 'paused');

  const beforeCount = rig.fc.callsTo('tabs.ungroup').length;
  rig.fc.tabs.add({
    id: 1100, windowId: 1, url: 'https://news.example.com/their-own-reading',
    groupId: scoutFoxGroupId, openerTabId: AUTOMATED_TAB
  });
  await new Promise((r) => setTimeout(r, 100));
  await rig.settle();

  const ungrouped = rig.fc.callsTo('tabs.ungroup').slice(beforeCount).some((c) => c.args[0] === 1100 || (Array.isArray(c.args[0]) && c.args[0].includes(1100)));
  assert.ok(ungrouped,
    'Chrome auto-grouped the user\'s tab, so ScoutFox must actively remove it again - merely declining to group it does nothing');
  assert.equal(rig.fc.tabs.get(1100)?.groupId, -1, 'the user\'s tab must end up outside the group');
});

test('a user tab in a group of their OWN is never touched', async () => {
  const beforeCount = rig.fc.callsTo('tabs.ungroup').length;

  rig.fc.tabs.add({
    id: 1200, windowId: 1, url: 'https://news.example.com/other', groupId: 4242, openerTabId: UNRELATED_TAB
  });
  await new Promise((r) => setTimeout(r, 100));
  await rig.settle();

  const ungrouped = rig.fc.callsTo('tabs.ungroup').slice(beforeCount).some((c) => c.args[0] === 1200 || (Array.isArray(c.args[0]) && c.args[0].includes(1200)));
  assert.equal(ungrouped, false,
    'only tabs that landed in OUR group are released - a group the user built themselves is left exactly as it is');
  assert.equal(rig.fc.tabs.get(1200)?.groupId, 4242, 'their own group membership must survive untouched');
});
