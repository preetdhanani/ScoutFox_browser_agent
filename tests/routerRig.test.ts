/**
 * Tests for tests/helpers/routerRig.ts: the background router loaded over fakeChrome, with a fake
 * model injected through runtimeRegistry.
 *
 * They pin what the router tests of Stage 5a rely on: the router registers its listeners when it
 * loads, a panel gets its state, a real task runs through START_TASK on the injected model, the icon
 * click opens the panel without a group, and one rig leaves nothing behind for the next.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { ROUTER_MODULE, routerRig } from './helpers/routerRig.ts';
import { SHOP_LIST_URL, act, shopPages, shopPlan } from './helpers/shopPages.ts';
import { fakeLlm } from './helpers/fakeLlm.ts';
import { runtimeRegistry } from '../src/background/runner/runtimeRegistry.ts';

test('routerRig: the router loads on fakeChrome with its listeners registered, and answers a panel and the messages it knows', async (t) => {
  const rig = await routerRig();
  t.after(rig.cleanup);

  // Registered while the module loads (MV3 needs this: a listener added later misses the event that woke the worker).
  for (const api of ['runtime.onConnect', 'runtime.onMessage', 'action.onClicked', 'tabs.onCreated', 'tabs.onRemoved', 'tabs.onActivated', 'tabGroups.onRemoved', 'alarms.onAlarm']) {
    assert.equal(rig.fc.callsTo(`${api}.addListener`).length, 1, `${api} has one listener`);
  }
  // The panel is NOT disabled everywhere at boot. The manifest has no side_panel.default_path, so
  // there is nothing to override, and a global setOptions({enabled:false}) would make
  // sidePanel.open() fail silently (Chromium 152). The panel is enabled per tab instead.
  assert.equal(
    rig.fc.callsTo('sidePanel.setOptions').some((call: any) => call.args[0]?.enabled === false && call.args[0]?.tabId === undefined),
    false,
    'the panel is not disabled globally at boot'
  );
  assert.ok(rig.selfListeners.has('unhandledrejection'), 'the worker-level handlers are recorded');

  const panel = await rig.connect(100);
  assert.equal(panel.port.name, 'scoutfox_sidepanel:100');
  const first = panel.lastState();
  assert.equal(first?.['status'], 'idle');
  assert.deepEqual(first?.['history'], []);
  assert.equal(typeof first?.['bootId'], 'string');
  assert.equal(rig.fc.sidePanel.optionsFor(100)['enabled'], true, 'the panel is enabled for its own tab');

  assert.equal((await rig.state(100))['status'], 'idle');
  assert.deepEqual(await rig.send({ action: 'CLIENT_ERROR', payload: { source: 'test', message: 'boom' } }), { success: true });
  assert.deepEqual(await rig.send({ action: 'NOPE' }), { success: false, error: 'Unknown action: NOPE' });
  assert.deepEqual(await rig.send({ action: 'PAUSE_TASK', tabId: 100 }), { success: false, error: 'Cannot pause when status is "idle".' });
  rig.assertClean();
});

test('routerRig: START_TASK runs a real task on the injected model, and the panel and the state show the result', async (t) => {
  const rig = await routerRig({
    tabs: [{ id: 100, url: SHOP_LIST_URL, windowId: 1, active: true }],
    pages: shopPages(),
    llm: { plan: [shopPlan()], policy: [act.scroll('down', 200), act.finish('Item 42 costs 99 USD.')] },
  });
  t.after(rig.cleanup);
  const panel = await rig.connect(100);

  const started = await rig.startTask(100, 'Find the price of item 42');
  assert.equal(started.success, true);
  assert.equal(started.tabId, 100);
  const done = await rig.waitForStatus(100, 'idle');

  assert.equal(done['task'], 'Find the price of item 42');
  assert.equal(((done['history'] as Array<{ type: string; answer?: string }>).find((h) => h.type === 'finish'))?.answer, 'Item 42 costs 99 USD.');
  const pushed = panel.lastState();
  assert.equal(pushed?.['status'], 'idle');
  assert.ok((pushed?.['history'] as unknown[]).length > 0, 'the panel was pushed the history');
  // The MCP loop is one node: the plan reply, the scroll and the finish are three calls of it.
  assert.deepEqual(rig.llm.callsOf('mcp').map((c) => c.outcome), ['text', 'text', 'text']);
  assert.deepEqual(rig.site?.actions.map((a) => a.payload['action']), ['scroll'], 'the action reached the page through the router');
  assert.notEqual(rig.fc.tabs.get(100)?.groupId, -1, 'a task puts its tab in the ScoutFox group');
  assert.equal(rig.runtime(100)?.llm !== undefined, true);
  rig.llm.assertDrained();
  rig.assertClean();
});

test('routerRig: the icon click opens the panel without a group, useLlm picks a model per tab, and the next rig starts clean', async () => {
  const before = (globalThis as Record<string, unknown>)['chrome'];
  const rigA = await routerRig({ tabs: [{ id: 100, url: 'chrome://newtab/', windowId: 1, active: true }] });

  await rigA.clickIcon();
  assert.equal(rigA.fc.sidePanel.optionsFor(100)['enabled'], true);
  assert.deepEqual(rigA.fc.sidePanel.opened.map((o) => o['tabId']), [100], 'sidePanel.open was called for the clicked tab');
  assert.equal(rigA.fc.tabs.get(100)?.groupId, -1, 'opening the panel does not group the tab');

  // A model for the runner that exists, and one for a runner that does not exist yet.
  const own = fakeLlm(['own']).port();
  rigA.useLlm(100, own);
  assert.equal(rigA.runtime(100)?.llm, own);
  rigA.fc.tabs.add({ id: 200, url: 'https://example.com/b', windowId: 1 });
  const later = fakeLlm(['later']).port();
  rigA.useLlm(200, later);
  await rigA.connect(200);
  assert.equal(rigA.runtime(200)?.llm, later);
  assert.notEqual(rigA.runtime(100)?.llm, rigA.runtime(200)?.llm);
  const moduleA = rigA.module;

  await rigA.cleanup();
  assert.equal((globalThis as Record<string, unknown>)['chrome'], before, 'the chrome global is put back');
  assert.equal(runtimeRegistry.get('100'), undefined, 'and so is the registry');
  assert.equal(runtimeRegistry.get('200'), undefined);

  const rigB = await routerRig({ tabs: [{ id: 100, url: 'https://example.com/a', windowId: 1 }] });
  try {
    assert.notEqual(rigB.module, moduleA, 'a new import of the router, with its own sessions');
    const state = await rigB.state(100);
    assert.equal(state['status'], 'idle');
    assert.deepEqual(state['history'], [], 'nothing of the first rig is left');
  } finally {
    await rigB.cleanup();
  }
});

test('routerRig: the router path is one constant, and it names a file that exists', () => {
  assert.ok(existsSync(new URL(`../${ROUTER_MODULE}`, import.meta.url)), `${ROUTER_MODULE} exists`);
  const source = readFileSync(new URL('./helpers/routerRig.ts', import.meta.url), 'utf8');
  const literal = ROUTER_MODULE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.equal(source.match(new RegExp(`['"\`]${literal}['"\`]`, 'g'))?.length, 1, 'the rig names the router file in exactly one place, so the Stage 5c rename is one line');
});
