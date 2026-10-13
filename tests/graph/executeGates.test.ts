import test from 'node:test';
import assert from 'node:assert/strict';
import { act, graphRig, shopPages } from '../helpers/graphHarness.ts';
import { link } from '../helpers/fakeDom.ts';

test('executeGates: navigating to restricted URL is blocked before tab ever leaves page', async (t) => {
  const rig = await graphRig({
    policy: [
      act.navigate('chrome://settings'),
      act.finish('Done after blocked navigation.'),
    ],
  });
  t.after(rig.cleanup);

  await rig.start('Check settings');
  // First paused at confirm hold for unapproved domain
  assert.equal(rig.status(), 'paused');
  assert.ok(rig.pending().confirm);

  // Once confirmed, the background restricted gate blocks the action
  await rig.confirm('approve');
  assert.equal(rig.status(), 'idle');

  const execResults = rig.entries('execution_result');
  assert.ok(execResults.length >= 1);
  const navResult = execResults[0] as any;
  assert.equal(navResult.success, false);
  assert.equal(navResult.via, 'background');
  assert.match(navResult.error || '', /chrome:\/\/settings/);
  rig.assertClean();
});

test('executeGates: non-http(s) navigation target is rejected by protocol gate', async (t) => {
  const rig = await graphRig({
    policy: [
      act.navigate('file:///etc/passwd'),
      act.finish('Done after rejected protocol.'),
    ],
  });
  t.after(rig.cleanup);

  const result = await rig.start('Read local file');
  assert.equal(result.success, true);

  const execResults = rig.entries('execution_result');
  assert.ok(execResults.length >= 1);
  const navResult = execResults[0] as any;
  assert.equal(navResult.success, false);
  assert.equal(navResult.via, 'background');
  assert.match(navResult.error || '', /cannot read file:|Navigate target must be http or https/);
  rig.assertClean();
});

test('executeGates: risk gate pauses at confirm hold when navigating to unapproved external domain', async (t) => {
  const rig = await graphRig({
    pages: [
      ...shopPages(),
      {
        url: 'https://unapproved-foreign.com/store',
        title: 'Foreign Store',
        text: ['Welcome to foreign store'],
        elements: [link('Home', 'https://unapproved-foreign.com/store')],
      },
    ],
    policy: [
      act.navigate('https://unapproved-foreign.com/store'),
      act.finish('Finished after confirmation.'),
    ],
  });
  t.after(rig.cleanup);

  await rig.start('Visit external store');
  assert.equal(rig.status(), 'paused');
  assert.ok(rig.pending().confirm, 'navigation to unapproved domain triggered confirm hold');

  await rig.confirm('approve');
  assert.equal(rig.status(), 'idle');
  assert.equal(rig.finishAnswer(), 'Finished after confirmation.');
  rig.assertClean();
});

test('executeGates: risk gate pauses at confirm hold for execute_js on large tier model', async (t) => {
  const rig = await graphRig({
    chrome: { scripting: { executeScript: [{ result: { __scoutfoxOk: true, value: 'Items List' } }] } },
    settings: { modelTier: 'large' },
    policy: [
      act.executeJs('return document.title;', 'Get page title'),
      act.finish('Finished after JS execution.'),
    ],
  });
  t.after(rig.cleanup);

  await rig.start('Run code on page');
  assert.equal(rig.status(), 'paused');
  assert.ok(rig.pending().confirm, 'execute_js triggered confirm hold');

  await rig.confirm('approve');
  assert.equal(rig.status(), 'idle');
  assert.equal(rig.finishAnswer(), 'Finished after JS execution.');
  rig.assertClean();
});

test('executeGates: javascript: pseudo-protocol navigation is rejected by protocol gate', async (t) => {
  const rig = await graphRig({
    policy: [
      act.navigate('javascript:alert(1)'),
      act.finish('Done after rejected javascript URI.'),
    ],
  });
  t.after(rig.cleanup);

  const result = await rig.start('Run javascript URI');
  assert.equal(result.success, true);

  const execResults = rig.entries('execution_result');
  assert.ok(execResults.length >= 1);
  const navResult = execResults[0] as any;
  assert.equal(navResult.success, false);
  assert.match(navResult.error || '', /Navigate target must be http or https/i);
});

test('executeGates: chrome-extension:// URL navigation is rejected by restricted URL gate', async (t) => {
  const rig = await graphRig({
    policy: [
      act.navigate('chrome-extension://abcdefghijklmnop/options.html'),
      act.finish('Done after rejected chrome-extension URI.'),
    ],
  });
  t.after(rig.cleanup);

  await rig.start('Open extension options');
  if (rig.status() === 'paused' && rig.pending().confirm) {
    await rig.confirm('approve');
  }
  assert.equal(rig.status(), 'idle');

  const execResults = rig.entries('execution_result');
  assert.ok(execResults.length >= 1);
  const navResult = execResults[0] as any;
  assert.equal(navResult.success, false);
  assert.match(navResult.error || '', /chrome-extension:\/\//);
});

test('executeGates: data: URI navigation is rejected by protocol gate', async (t) => {
  const rig = await graphRig({
    policy: [
      act.navigate('data:text/html,<h1>Hello</h1>'),
      act.finish('Done after rejected data URI.'),
    ],
  });
  t.after(rig.cleanup);

  await rig.start('Open data URI');
  assert.equal(rig.status(), 'idle');

  const execResults = rig.entries('execution_result');
  assert.ok(execResults.length >= 1);
  const navResult = execResults[0] as any;
  assert.equal(navResult.success, false);
  assert.match(navResult.error || '', /cannot read data:|Navigate target must be http or https/i);
});

test('executeGates: user denial on confirm hold informs model and allows alternative action', async (t) => {
  const rig = await graphRig({
    pages: [
      ...shopPages(),
      {
        url: 'https://unapproved-foreign.com/store',
        title: 'Foreign Store',
        text: ['Welcome to foreign store'],
        elements: [link('Home', 'https://unapproved-foreign.com/store')],
      },
    ],
    policy: [
      act.navigate('https://unapproved-foreign.com/store'),
      act.finish('Finished after user denied navigation.'),
    ],
  });
  t.after(rig.cleanup);

  await rig.start('Visit external store');
  assert.equal(rig.status(), 'paused');
  assert.ok(rig.pending().confirm);

  await rig.confirm('reject');
  assert.equal(rig.status(), 'idle');
  assert.equal(rig.finishAnswer(), 'Finished after user denied navigation.');
});

test('executeGates: user confirm with remember site permits subsequent navigation to same domain without hold', async (t) => {
  const rig = await graphRig({
    pages: [
      ...shopPages(),
      {
        url: 'https://partner.com/deal1',
        title: 'Deal 1',
        text: ['Deal 1'],
        elements: [link('Deal 2', 'https://partner.com/deal2')],
      },
    ],
    policy: [
      act.navigate('https://partner.com/deal1'),
      act.finish('Visited partner deal.'),
    ],
  });
  t.after(rig.cleanup);

  await rig.start('Visit partner deals');
  assert.equal(rig.status(), 'paused');
  assert.ok(rig.pending().confirm);

  // Approve with remember: 'site'
  await rig.confirm('approve', 'site');
  assert.equal(rig.status(), 'idle');
  assert.equal(rig.finishAnswer(), 'Visited partner deal.');
});

test('executeGates: about:blank navigation target is rejected by protocol gate', async (t) => {
  const rig = await graphRig({
    policy: [
      act.navigate('about:blank'),
      act.finish('Done after about:blank.'),
    ],
  });
  t.after(rig.cleanup);

  await rig.start('Open blank page');
  assert.equal(rig.status(), 'idle');

  const execResults = rig.entries('execution_result');
  assert.ok(execResults.length >= 1);
  const navResult = execResults[0] as any;
  assert.equal(navResult.success, false);
  assert.match(navResult.error || '', /cannot read about:blank|Navigate target must be http or https/i);
});

test('executeGates: view-source: URI is rejected by protocol gate', async (t) => {
  const rig = await graphRig({
    policy: [
      act.navigate('view-source:https://shop.test/items'),
      act.finish('Done after view-source.'),
    ],
  });
  t.after(rig.cleanup);

  await rig.start('View page source');
  assert.equal(rig.status(), 'idle');

  const execResults = rig.entries('execution_result');
  assert.ok(execResults.length >= 1);
  const navResult = execResults[0] as any;
  assert.equal(navResult.success, false);
  assert.match(navResult.error || '', /cannot read view-source:|Navigate target must be http or https/i);
});

test('executeGates: http target within approved domain executes without triggering confirm hold', async (t) => {
  const rig = await graphRig({
    pages: shopPages(),
    policy: [
      act.navigate('https://shop.test/items'),
      act.finish('Checked items.'),
    ],
  });
  t.after(rig.cleanup);

  await rig.start('Browse items');
  // shop.test is the initial page domain, approved by plan approval
  assert.equal(rig.status(), 'idle');
  assert.equal(rig.finishAnswer(), 'Checked items.');
  rig.assertClean();
});
