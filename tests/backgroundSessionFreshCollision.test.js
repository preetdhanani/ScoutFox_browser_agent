/**
 * Regression test for a real production bug: a completed run's results were wiped roughly
 * 15-30s after finishing, with no user action.
 *
 * Root cause, traced from the actual service-worker log: chrome.tabs.onCreated auto-enables
 * the side panel for every tab it auto-groups into the ScoutFox tab group (background.js's
 * TAB_SANDBOX handler). When the agent's own navigation opened a second tab and that tab
 * became active, Chrome loaded a genuinely separate side-panel DOCUMENT for it - its own JS
 * realm, with its own honest hasConnectedBefore=false. That document's first connection named
 * itself '_fresh', which onConnect's SESSION_FRESH check (in place at the time) trusted at
 * face value and cleared the shared runner history - wiping the result the FIRST,
 * still-open panel was showing.
 *
 * That auto-clear-on-fresh-open mechanism has since been removed entirely: reopening the panel
 * on a session that already has history - by any port, in any count - always reflects it rather
 * than auto-clearing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { routerRig } from './helpers/routerRig.ts';
import { SHOP_LIST_URL, act, shopPages, shopPlan } from './helpers/graphHarness.ts';

const ANSWER = 'The answer the user is currently reading.';

test('a second panel connecting fresh does not wipe a session the first panel is still showing', async (t) => {
  const rig = await routerRig({
    tabs: [{ id: 100, url: SHOP_LIST_URL, windowId: 1, active: true }],
    pages: shopPages(),
    llm: {
      plan: [shopPlan()],
      policy: [act.finish(ANSWER)],
    },
  });
  t.after(rig.cleanup);

  const port1 = await rig.connect(100);
  await rig.startTask(100, 'a task the user just ran');
  await rig.waitForStatus(100, 'idle');

  const baseline = port1.lastState();
  assert.ok(baseline, 'port1 must receive an initial STATE_UPDATE on connect');
  const baselineHistory = Array.isArray(baseline?.['history']) ? baseline['history'] : [];
  assert.ok(baselineHistory.length > 0,
    'the restored session must still hold the real history before the second panel connects');

  // Port 2: a second, genuinely new panel document connecting fresh
  const port2 = await rig.connect(100, { fresh: true });

  const afterPort2 = port1.lastState();
  const afterHistory = Array.isArray(afterPort2?.['history']) ? afterPort2['history'] : [];
  assert.deepEqual(afterHistory, baselineHistory,
    'a second panel opening fresh while the first is still connected must not clear the shared session');

  port1.disconnect();
  port2.disconnect();
});

test('a solitary fresh open ALSO reflects the existing session, not just a collision with a second panel', async (t) => {
  const rig = await routerRig({
    tabs: [{ id: 100, url: SHOP_LIST_URL, windowId: 1, active: true }],
    pages: shopPages(),
    llm: {
      plan: [shopPlan()],
      policy: [act.finish(ANSWER)],
    },
  });
  t.after(rig.cleanup);

  const initial = await rig.connect(100);
  await rig.startTask(100, 'a task the user just ran');
  await rig.waitForStatus(100, 'idle');
  const finishedHistory = Array.isArray(initial.lastState()?.['history']) ? initial.lastState()['history'] : [];
  assert.ok(finishedHistory.length > 0);
  initial.disconnect();

  const port = await rig.connect(100, { fresh: true });
  const msg = port.lastState();
  const msgHistory = Array.isArray(msg?.['history']) ? msg['history'] : [];
  assert.deepEqual(msgHistory, finishedHistory,
    'reopening the panel - even solitary, even naming itself fresh - must reflect the session that is actually there');

  port.disconnect();
});
