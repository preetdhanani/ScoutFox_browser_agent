/**
 * Regression test for a real Chrome API limitation reported directly by the user: the side
 * panel kept showing on every tab, not just the one it was opened on.
 *
 * manifest.json declares side_panel.default_path, which registers the panel GLOBALLY on
 * every tab as Chrome's fallback. The per-tab enable/disable calls this file already made
 * (onConnect, onCreated, onActivated) are not enough to override that global default on their own.
 * Fix: disable the panel EVERYWHERE at startup (no tabId = global), and stop relying on
 * openPanelOnActionClick's auto-open. Flipping it to false makes onClicked fire, and its handler
 * enables the panel for ONLY the clicked tab first.
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { routerRig } from './helpers/routerRig.ts';

const rig = await routerRig({
  tabs: [
    { id: 100, url: 'https://example.com/a', windowId: 1, active: true },
    { id: 200, url: 'https://example.com/b', windowId: 1, active: false },
  ],
});
after(rig.cleanup);

test('the panel is disabled globally at startup, not left on the manifest default for every tab', () => {
  const globalDisable = rig.fc.callsTo('sidePanel.setOptions').find((c) => c.args[0]?.tabId === undefined && c.args[0]?.enabled === false);
  assert.ok(globalDisable,
    'boot must explicitly disable the panel everywhere - this is what overrides the manifest\'s global default_path fallback');
});

test('openPanelOnActionClick is off, so action.onClicked actually fires', () => {
  const behaviorCall = rig.fc.callsTo('sidePanel.setPanelBehavior').find((c) => c.args[0]?.openPanelOnActionClick === false);
  assert.ok(behaviorCall,
    'openPanelOnActionClick:true makes chrome.action.onClicked never fire at all, by Chrome\'s own design - the per-tab enable-on-click logic below would be permanently dead code');
});

test('clicking the toolbar icon enables the panel for ONLY that tab', async () => {
  const beforeCount = rig.fc.callsTo('sidePanel.setOptions').length;
  await rig.clickIcon(rig.fc.tabs.get(100));

  const newCalls = rig.fc.callsTo('sidePanel.setOptions').slice(beforeCount);
  const enableCall = newCalls.find((c) => c.args[0]?.tabId === 100 && c.args[0]?.enabled === true);
  assert.ok(enableCall, 'the clicked tab must be explicitly enabled');
  assert.equal(rig.fc.tabs.get(100)?.groupId, -1,
    'but it must NOT be grouped - opening the panel is not asking for work, and the group is a sandbox marker for a running task');

  const tab200EverEnabled = newCalls.some((c) => c.args[0]?.tabId === 200 && c.args[0]?.enabled === true);
  assert.equal(tab200EverEnabled, false,
    'an unrelated tab must never be enabled just because a different tab\'s icon was clicked');
});

test('switching to a tab with no session hides the panel there', async () => {
  const beforeCount = rig.fc.callsTo('sidePanel.setOptions').length;
  rig.fc.tabs.activate(200);
  await rig.settle();

  const newCalls = rig.fc.callsTo('sidePanel.setOptions').slice(beforeCount);
  const disableCall = newCalls.find((c) => c.args[0]?.tabId === 200 && c.args[0]?.enabled === false);
  assert.ok(disableCall,
    'tab 200 has no session of its own, so the panel must not follow the user there - this is what keeps two tabs independent');
});

test('switching back to the tab that HAS the session re-enables the panel there', async () => {
  const beforeCount = rig.fc.callsTo('sidePanel.setOptions').length;
  rig.fc.tabs.activate(100);
  await rig.settle();

  const newCalls = rig.fc.callsTo('sidePanel.setOptions').slice(beforeCount);
  const enableCall = newCalls.find((c) => c.args[0]?.tabId === 100 && c.args[0]?.enabled === true);
  assert.ok(enableCall, 'the tab the user opened ScoutFox on must always get its panel back');
});

test('a tab that never opened ScoutFox is hidden, not left to the manifest default', async () => {
  rig.fc.tabs.add({ id: 999, url: 'https://example.com/c', windowId: 1, active: false });
  const beforeCount = rig.fc.callsTo('sidePanel.setOptions').length;
  rig.fc.tabs.activate(999);
  await rig.settle();

  const newCalls = rig.fc.callsTo('sidePanel.setOptions').slice(beforeCount);
  const disableCall = newCalls.find((c) => c.args[0]?.tabId === 999 && c.args[0]?.enabled === false);
  assert.ok(disableCall,
    'a tab with no session must have the panel explicitly disabled, or the manifest default shows it everywhere');
});
