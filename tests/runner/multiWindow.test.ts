import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeChrome } from '../helpers/fakeChrome.ts';
import { createFakeStorage } from '../helpers/fakeStorageSession.ts';
import { fakeDom, link } from '../helpers/fakeDom.ts';
import { AgentRunner } from '../../src/background/runner/AgentRunner.ts';

const LIST_URL = 'https://shop.test/items';
const COMPARE_URL = 'https://shop.test/compare';

function setupRunnerEnvironment() {
  const store = createFakeStorage({
    local: {
      data: {
        agent_settings: {
          provider: 'openrouter',
          model: 'test-model',
          modelTier: 'large',
        },
      },
    },
  });

  const site = fakeDom({
    pages: [
      {
        url: LIST_URL,
        title: 'Items List',
        text: ['Item 42 available for 99 USD'],
        elements: [link('Compare', COMPARE_URL)],
      },
      {
        url: COMPARE_URL,
        title: 'Comparison',
        text: ['Compare products side by side'],
        elements: [],
      },
    ],
  });

  const fc = fakeChrome({
    tabs: { list: [{ id: 101, windowId: 1, url: LIST_URL }] },
    tabGroups: true,
    windows: true,
    storage: store,
    dom: true,
  });

  site.attach(fc, 101);
  const uninstall = fc.install();

  return { store, site, fc, uninstall };
}

test('multiWindow: openNewWindow creates a new window, groups its tab separately, and keeps the session', async (t) => {
  const env = setupRunnerEnvironment();
  t.after(env.uninstall);
  t.after(env.fc.kill);

  const runner = new AgentRunner(101, 1);
  await runner.restorePromise;

  // Establish initial group in window 1
  const origGroup = await runner.ensureScoutFoxGroup(101, 1);
  assert.ok(origGroup);
  assert.equal(runner.groupIdForWindow(1), origGroup);

  let adopted: { newTabId: number; newWindowId: number } | null = null;
  runner.setTabAdoptedCallback((newTabId, newWindowId) => {
    adopted = { newTabId, newWindowId };
    env.site.attach(env.fc, newTabId);
  });

  const res = await runner.openNewWindow(COMPARE_URL);
  assert.equal(res.success, true);
  assert.ok(res.windowId);
  assert.ok(res.tabId);
  assert.deepEqual(adopted, { newTabId: res.tabId, newWindowId: res.windowId });

  assert.equal(runner.activeTabId, res.tabId);
  const newWinGroup = runner.groupIdForWindow(res.windowId);
  assert.ok(newWinGroup);
  assert.notEqual(newWinGroup, origGroup);
  assert.equal(runner.ownerTabId, 101);
});

test('multiWindow: tabs created later in the new window join that window group', async (t) => {
  const env = setupRunnerEnvironment();
  t.after(env.uninstall);
  t.after(env.fc.kill);

  const runner = new AgentRunner(101, 1);
  await runner.restorePromise;

  const origGroup = await runner.ensureScoutFoxGroup(101, 1);
  const res = await runner.openNewWindow(COMPARE_URL);
  assert.equal(res.success, true);
  const newWindowId = res.windowId!;

  // Add another tab in the new window
  const secondTab = env.fc.tabs.add({ windowId: newWindowId, url: 'https://shop.test/item-b' });
  const groupForSecond = await runner.ensureScoutFoxGroup(secondTab.id, newWindowId);

  assert.equal(groupForSecond, runner.groupIdForWindow(newWindowId));
  assert.notEqual(groupForSecond, origGroup);
});

test('multiWindow: all window group IDs are tracked in scoutFoxGroupIds', async (t) => {
  const env = setupRunnerEnvironment();
  t.after(env.uninstall);
  t.after(env.fc.kill);

  const runner = new AgentRunner(101, 1);
  await runner.restorePromise;

  await runner.ensureScoutFoxGroup(101, 1);
  const res = await runner.openNewWindow(COMPARE_URL);
  assert.equal(res.success, true);

  assert.equal(runner.scoutFoxGroupIds.size, 2);
  assert.ok(runner.scoutFoxGroupIds.has(1));
  assert.ok(runner.scoutFoxGroupIds.has(res.windowId!));

  await runner.persistState();
  assert.ok(runner.scoutFoxGroupIds.has(1));
});

test('multiWindow: openNewWindow preserves existing session task prompt and state', async (t) => {
  const env = setupRunnerEnvironment();
  t.after(env.uninstall);
  t.after(env.fc.kill);

  const runner = new AgentRunner(101, 1);
  await runner.restorePromise;

  (runner as any).currentTask = 'Find best deals on laptops';
  (runner as any).history = [{ type: 'user_goal', prompt: 'Find best deals on laptops' }];

  const res = await runner.openNewWindow(COMPARE_URL);
  assert.equal(res.success, true);
  assert.equal((runner as any).currentTask, 'Find best deals on laptops');
  assert.equal((runner as any).history.length, 1);
  assert.equal(runner.ownerTabId, 101);
});

test('multiWindow: groupIdForWindow returns null for unassociated windowId', async (t) => {
  const env = setupRunnerEnvironment();
  t.after(env.uninstall);
  t.after(env.fc.kill);

  const runner = new AgentRunner(101, 1);
  await runner.restorePromise;

  await runner.ensureScoutFoxGroup(101, 1);
  assert.equal(runner.groupIdForWindow(9999), null);
});

test('multiWindow: multiple windows each have distinct ScoutFox group ids', async (t) => {
  const env = setupRunnerEnvironment();
  t.after(env.uninstall);
  t.after(env.fc.kill);

  const runner = new AgentRunner(101, 1);
  await runner.restorePromise;

  const group1 = await runner.ensureScoutFoxGroup(101, 1);
  const res1 = await runner.openNewWindow(COMPARE_URL);
  assert.equal(res1.success, true);
  const group2 = runner.groupIdForWindow(res1.windowId!);

  const res2 = await runner.openNewWindow(LIST_URL);
  assert.equal(res2.success, true);
  const group3 = runner.groupIdForWindow(res2.windowId!);

  assert.notEqual(group1, group2);
  assert.notEqual(group2, group3);
  assert.notEqual(group1, group3);
  assert.equal(runner.scoutFoxGroupIds.size, 3);
});

test('multiWindow: windows.create rejection returns failure result cleanly', async (t) => {
  const env = setupRunnerEnvironment();
  t.after(env.uninstall);
  t.after(env.fc.kill);

  const runner = new AgentRunner(101, 1);
  await runner.restorePromise;

  const origCreate = (globalThis as any).chrome.windows.create;
  (globalThis as any).chrome.windows.create = () => {
    throw new Error('Window creation denied');
  };

  try {
    const res = await runner.openNewWindow(COMPARE_URL);
    assert.equal(res.success, false);
    assert.match(res.error ?? '', /Window creation denied/);
  } finally {
    (globalThis as any).chrome.windows.create = origCreate;
  }
});

