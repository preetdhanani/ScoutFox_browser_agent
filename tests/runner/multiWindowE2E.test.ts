import test from 'node:test';
import assert from 'node:assert/strict';
import { act, graphRig, shopPages, SHOP_PRODUCT_URL, SHOP_LIST_URL } from '../helpers/graphHarness.ts';
import { link } from '../helpers/fakeDom.ts';

const COMPARE_URL = 'https://shop.test/compare';

test('multiWindowE2E: a real task opening a window keeps it in the SAME session end-to-end', async (t) => {
  const rig = await graphRig({
    chrome: { windows: true },
    settings: { modelTier: 'large' },
    pages: [
      ...shopPages(),
      {
        url: COMPARE_URL,
        title: 'Comparison Window',
        text: ['Item 42 comparison details.'],
        elements: [link('Back to Shop', SHOP_LIST_URL)],
      },
    ],
    policy: [
      act.openWindow(COMPARE_URL, 'Open comparison in second window'),
      act.finish('Comparison complete across both windows.'),
    ],
  });
  t.after(rig.cleanup);

  const res = await rig.start('Compare items in a new window');
  assert.equal(res.success, true);
  assert.equal(rig.finishAnswer(), 'Comparison complete across both windows.');

  // The runner tracks two distinct window groups in one session
  const runner = rig.runner;
  const origGroup = runner.groupIdForWindow(1);
  assert.ok(origGroup);

  const windowGroups = Array.from(runner.scoutFoxGroupIds.keys());
  assert.equal(windowGroups.length, 2);
  const secondWindowId = windowGroups.find((w) => w !== 1);
  assert.ok(secondWindowId);
  const secondGroup = runner.groupIdForWindow(secondWindowId);
  assert.ok(secondGroup);
  assert.notEqual(secondGroup, origGroup);

  // Active tab points to the new window's tab
  assert.ok(runner.activeTabId);
  assert.notEqual(runner.activeTabId, 101);

  // Unified history contains open_window execution result and final finish
  const history = rig.history();
  const openExec = history.find((h: any) => h.type === 'execution_result' && h.via === 'background');
  assert.ok(openExec);
  assert.equal((openExec as any).effect, 'url_changed');

  rig.assertClean();
});

test('multiWindowE2E: closing only the tab the run moved into keeps the session alive on owner tab', async (t) => {
  const rig = await graphRig({
    chrome: { windows: true },
    settings: { modelTier: 'large' },
    pages: [
      ...shopPages(),
      {
        url: COMPARE_URL,
        title: 'Comparison Window',
        text: ['Item 42 comparison details.'],
        elements: [link('Back to Shop', SHOP_LIST_URL)],
      },
    ],
    policy: [
      act.openWindow(COMPARE_URL, 'Open comparison in second window'),
      act.finish('Done comparing.'),
    ],
  });
  t.after(rig.cleanup);

  await rig.start('Open window and finish');
  const runner = rig.runner;
  assert.equal(rig.status(), 'idle');
  assert.equal(rig.finishAnswer(), 'Done comparing.');

  // When the new tab is removed, ownerTabId is still intact
  const movedTabId = runner.activeTabId!;
  assert.ok(movedTabId);
  rig.fc.tabs.close(movedTabId);

  // The runner's owner tab is still 101
  assert.equal(runner.ownerTabId, 101);
  assert.equal(runner.getStatus(), 'idle');
  rig.assertClean();
});
