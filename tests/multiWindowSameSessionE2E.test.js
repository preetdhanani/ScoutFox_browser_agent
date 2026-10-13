/**
 * Phase 2 of the per-window session work, end-to-end: a real task chooses "open_window" (via a
 * stubbed LLM response, everything else genuinely real - START_TASK, the real runLoop,
 * executeActionOnTab, openNewWindow, background.js's onWindowOpenedCallback wiring), and a
 * second panel opening in the resulting new window reflects the SAME session rather than
 * starting a blank one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { routerRig } from './helpers/routerRig.ts';
import { act, shopPages, shopPlan, SHOP_LIST_URL } from './helpers/graphHarness.ts';
import { link } from './helpers/fakeDom.ts';

const COMPARE_URL = 'https://shop.test/compare';

test('a real task opening a window keeps it in the SAME session, observable end-to-end', async (t) => {
  const rig = await routerRig({
    tabs: [{ id: 101, url: SHOP_LIST_URL, windowId: 1, active: true }],
    settings: { modelTier: 'large' },
    pages: [
      ...shopPages(),
      {
        url: COMPARE_URL,
        title: 'Comparison Window',
        text: ['Comparison details.'],
        elements: [link('Back to Shop', SHOP_LIST_URL)],
      },
    ],
    llm: {
      plan: [shopPlan()],
      policy: [
        act.openWindow(COMPARE_URL, 'Open comparison in second window'),
        act.finish('done comparing'),
      ],
    },
    chrome: { windows: true },
  });
  t.after(rig.cleanup);

  const portA = await rig.connect(101, { fresh: true });
  const windowIdsBefore = new Set(rig.fc.tabs.list().map((t) => t.windowId));

  const startRes = await rig.startTask(101, 'compare two pages side by side');
  assert.equal(startRes?.success, true);
  await rig.waitForStatus(101, 'idle');

  const stateA = await rig.state(101);
  assert.equal(stateA.task, 'compare two pages side by side');
  assert.ok(stateA.history.some((h) => h.type === 'finish'), 'the task must have actually completed');
  assert.ok(stateA.history.some((h) => (h.action && h.action.action === 'open_window') || (h.type === 'execution_result' && (h.effect === 'url_changed' || h.via === 'background'))),
    'the open_window step must be recorded in this SAME session\'s history');

  const newWindowTab = rig.fc.tabs.list().find((t) => !windowIdsBefore.has(t.windowId));
  assert.ok(newWindowTab, 'openNewWindow must have actually created a new window with a tab in it');

  const portB = await rig.connect(newWindowTab.id, { fresh: true });
  const reflected = portB.lastState();
  assert.equal(reflected?.['task'], 'compare two pages side by side',
    'the new window\'s own panel must show the SAME session\'s task, not a blank one - the tab the run moved into was adopted into this session, which is what keeps one run one run');
  assert.ok(reflected?.['history']?.some((h) => h.type === 'finish'),
    'and the same completed history - this is what "stays part of the same session" means observably');

  portA.disconnect();
  portB.disconnect();
});

test('closing only the tab the run moved into does not end the session while its owner tab stays open', async (t) => {
  const rig = await routerRig({
    tabs: [{ id: 201, url: SHOP_LIST_URL, windowId: 2, active: true }],
    settings: { modelTier: 'large' },
    pages: [
      ...shopPages(),
      {
        url: COMPARE_URL,
        title: 'Comparison Window',
        text: ['Comparison details.'],
        elements: [link('Back to Shop', SHOP_LIST_URL)],
      },
    ],
    llm: {
      plan: [shopPlan()],
      policy: [
        act.openWindow(COMPARE_URL, 'Open comparison in second window'),
        act.finish('done comparing 2'),
      ],
    },
    chrome: { windows: true },
  });
  t.after(rig.cleanup);

  const portA = await rig.connect(201, { fresh: true });
  const windowIdsBefore = new Set(rig.fc.tabs.list().map((t) => t.windowId));

  await rig.startTask(201, 'another comparison task');
  await rig.waitForStatus(201, 'idle');

  const newWindowTab = rig.fc.tabs.list().find((t) => !windowIdsBefore.has(t.windowId));
  assert.ok(newWindowTab);

  rig.fc.tabs.close(newWindowTab.id);
  await rig.settle();

  const state = await rig.state(201);
  assert.equal(state.task, 'another comparison task',
    'closing a tab the run merely visited must not tear down the session that owns it');

  portA.disconnect();
});
