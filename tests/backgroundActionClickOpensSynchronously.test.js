/**
 * Regression test for a real production bug this session introduced and the user reported
 * immediately: clicking the extension's toolbar icon stopped opening the side panel at all.
 *
 * Chrome's user-gesture rule for chrome.sidePanel.open(): it must be called SYNCHRONOUSLY,
 * within the same tick as the click event, with nothing awaited beforehand. Crossing even one
 * await loses the gesture context, and open() then rejects - silently, since the call site
 * here is a fire-and-forget .catch(). Confirmed against multiple Chromium bug reports
 * describing this exact failure mode:
 * https://issues.chromium.org/issues/355266358
 * https://github.com/GoogleChrome/chrome-extensions-samples/issues/1001
 *
 * The prior version of the click handler awaited agentEngine.ensureScoutFoxGroup(tab.id)
 * BEFORE calling chrome.sidePanel.open() - exactly the pattern that breaks this. This test
 * asserts the ordering directly: open() must appear before any await in the handler's actual
 * execution, not just "eventually get called".
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { routerRig } from './helpers/routerRig.ts';

test('chrome.sidePanel.open() is invoked synchronously by the click handler, not after an await', async (t) => {
  const rig = await routerRig({
    tabs: [{ id: 100, url: 'https://example.com/a', windowId: 1, active: true }]
  });
  t.after(rig.cleanup);

  // Call the listener exactly as Chrome does: synchronously, from this line. If the handler
  // itself awaits anything before calling open(), that call will not have happened yet by
  // the time this synchronous line returns - proving the bug this test guards against.
  rig.fc.action.click(rig.fc.tabs.get(100));

  const openCallHappenedSynchronously = rig.fc.callsTo('sidePanel.open').some((c) => c.args[0]?.tabId === 100);
  assert.equal(openCallHappenedSynchronously, true,
    'chrome.sidePanel.open() must be called in the same synchronous tick as the click - ' +
    'awaiting anything (ensureScoutFoxGroup, a storage read, tabs.group) before it loses ' +
    'Chrome\'s user-gesture window and open() then fails silently, breaking "click the icon to open the extension" entirely');

  assert.ok(rig.fc.callsTo('sidePanel.open').length >= 1);
});

test('the tab is still enabled for the panel, just not on open()\'s critical path', async (t) => {
  const rig = await routerRig({
    tabs: [{ id: 100, url: 'https://example.com/a', windowId: 1, active: true }]
  });
  t.after(rig.cleanup);

  await rig.clickIcon(rig.fc.tabs.get(100));

  const enableCall = rig.fc.callsTo('sidePanel.setOptions').find((c) => c.args[0]?.tabId === 100 && c.args[0]?.enabled === true);
  assert.ok(enableCall, 'the tab must still be enabled for the panel, just not on open()\'s critical path');
  assert.equal(rig.fc.tabs.get(100)?.groupId, -1,
    'and no group is created on click at all any more - which also means nothing async is left that could tempt someone to await it before open()');
});
