/**
 * Regression test for a real bug the user reported directly ("still can't open it"),
 * introduced alongside the side-panel-scoping fix in 80c4df1.
 *
 * The click handler required isValidWebTab(tab) before doing ANYTHING - including calling
 * chrome.sidePanel.setOptions()/open(). isValidWebTab exists to decide whether a tab can be
 * SCRIPTED for automation (content-script injection), not whether the panel UI can be shown.
 * A brand new browser tab opens on chrome://newtab/, which isValidWebTab rejects - so clicking
 * the toolbar icon while sitting on an entirely ordinary, freshly-opened tab did nothing at
 * all: setOptions and open() never even ran.
 *
 * Fix: enable + open the panel unconditionally on the clicked tab. isValidWebTab now only
 * gates ensureScoutFoxGroup (automation sandboxing), which is the thing it actually needs to
 * gate.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { routerRig } from './helpers/routerRig.ts';

test('clicking the icon on a restricted tab (chrome://newtab) still opens the panel', async (t) => {
  const rig = await routerRig({
    tabs: [{ id: 100, url: 'chrome://newtab/', windowId: 1, active: true }]
  });
  t.after(rig.cleanup);

  await rig.clickIcon();

  assert.equal(rig.fc.sidePanel.optionsFor(100)?.['enabled'], true,
    'the panel must be enabled for the clicked tab even when it cannot be automated - the user should always be able to open and SEE the extension');
  assert.deepEqual(rig.fc.sidePanel.opened.map((o) => o['tabId']), [100],
    'chrome.sidePanel.open() must still be called for a restricted tab, or clicking the icon on a fresh browser tab does nothing at all');
});

test('clicking the icon on chrome://newtab opens the panel and creates NO group', async (t) => {
  const rig = await routerRig({
    tabs: [{ id: 100, url: 'chrome://newtab/', windowId: 1, active: true }]
  });
  t.after(rig.cleanup);

  await rig.clickIcon();

  assert.equal(rig.fc.sidePanel.optionsFor(100)?.['enabled'], true, 'the panel must be enabled for the clicked tab');
  assert.equal(rig.fc.tabs.get(100)?.groupId, -1,
    'opening the panel must not box the user\'s tab into a group - the group belongs to a task, and no task has been given yet');
});

test('clicking the icon on a Chrome Web Store tab opens the panel and creates NO group', async (t) => {
  const rig = await routerRig({
    tabs: [{ id: 300, url: 'https://chromewebstore.google.com/detail/foo', windowId: 1, active: true }]
  });
  t.after(rig.cleanup);

  await rig.clickIcon();

  assert.deepEqual(rig.fc.sidePanel.opened.map((o) => o['tabId']), [300], 'the panel must still open on a Web Store tab');
  assert.equal(rig.fc.tabs.get(300)?.groupId, -1, 'and still no group, for the same reason');
});

test('clicking the icon on a file:// tab opens the panel and creates NO group', async (t) => {
  const rig = await routerRig({
    tabs: [{ id: 400, url: 'file:///Users/me/notes.txt', windowId: 1, active: true }]
  });
  t.after(rig.cleanup);

  await rig.clickIcon();

  assert.deepEqual(rig.fc.sidePanel.opened.map((o) => o['tabId']), [400], 'the panel must still open on a file:// tab');
  assert.equal(rig.fc.tabs.get(400)?.groupId, -1, 'and still no group, for the same reason');
});

test('a normal, scriptable tab is treated exactly the same - panel yes, group no', async (t) => {
  const rig = await routerRig({
    tabs: [{ id: 200, url: 'https://example.com/a', windowId: 1, active: true }]
  });
  t.after(rig.cleanup);

  await rig.clickIcon();

  assert.deepEqual(rig.fc.sidePanel.opened.map((o) => o['tabId']), [200], 'a normal tab must still open the panel');
  assert.equal(rig.fc.tabs.get(200)?.groupId, -1,
    'whether a page can be scripted has no bearing on this - clicking the icon never groups anything, so a scriptable tab is left alone too');
});
