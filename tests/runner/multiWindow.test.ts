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

test('multiWindow: groupIdForWindow returns null for unassociated windowId', async (t) => {
  const env = setupRunnerEnvironment();
  t.after(env.uninstall);
  t.after(env.fc.kill);

  const runner = new AgentRunner(101, 1);
  await runner.restorePromise;

  await runner.ensureScoutFoxGroup(101, 1);
  assert.equal(runner.groupIdForWindow(9999), null);
});

