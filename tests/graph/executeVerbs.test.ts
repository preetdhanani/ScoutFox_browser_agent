import test from 'node:test';
import assert from 'node:assert/strict';
import { act, graphRig, shopPages, SHOP_PRODUCT_URL, SHOP_LIST_URL } from '../helpers/graphHarness.ts';
import { link } from '../helpers/fakeDom.ts';

test('executeVerbs: click executes on page and follows link', async (t) => {
  const rig = await graphRig({
    policy: [
      act.click(1, 'Open product details'),
      act.finish('Product details viewed.'),
    ],
  });
  t.after(rig.cleanup);

  const res = await rig.start('Open item 42');
  assert.equal(res.success, true);
  assert.equal(rig.finishAnswer(), 'Product details viewed.');

  const actions = rig.site.actions.filter((a) => a.payload?.action === 'click');
  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.payload?.element_id, 1);
  rig.assertClean();
});

test('executeVerbs: scroll executes on page', async (t) => {
  const rig = await graphRig({
    policy: [
      act.scroll('down', 250),
      act.finish('Scrolled down.'),
    ],
  });
  t.after(rig.cleanup);

  const res = await rig.start('Scroll page');
  assert.equal(res.success, true);
  assert.equal(rig.finishAnswer(), 'Scrolled down.');

  const actions = rig.site.actions.filter((a) => a.payload?.action === 'scroll');
  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.payload?.direction, 'down');
  rig.assertClean();
});

test('executeVerbs: press_key dispatches key to page', async (t) => {
  const rig = await graphRig({
    policy: [
      act.pressKey('Enter', 'Press enter'),
      act.finish('Key pressed.'),
    ],
  });
  t.after(rig.cleanup);

  const res = await rig.start('Press enter key');
  assert.equal(res.success, true);
  assert.equal(rig.finishAnswer(), 'Key pressed.');

  const actions = rig.site.actions.filter((a) => a.payload?.action === 'press_key');
  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.payload?.key, 'Enter');
  rig.assertClean();
});

test('executeVerbs: wait executes on clock', async (t) => {
  const rig = await graphRig({
    policy: [
      act.wait(2, 'Wait 2 seconds'),
      act.finish('Waited.'),
    ],
  });
  t.after(rig.cleanup);

  const res = await rig.start('Wait on page');
  assert.equal(res.success, true);
  assert.equal(rig.finishAnswer(), 'Waited.');

  // BUG-36: wait runs in the BACKGROUND on the runtime clock (clamped to 1..5 s
  // and interruptible by the step signal), not as a content-side action.
  const actions = rig.site.actions.filter((a) => a.payload?.action === 'wait');
  assert.equal(actions.length, 0, 'the wait must not be dispatched to the page anymore');
  assert.deepEqual(rig.clock.sleeps, [2000], `the wait slept on the clock, got ${JSON.stringify(rig.clock.sleeps)}`);
  rig.assertClean();
});

test('executeVerbs: read_page_text extracts page content', async (t) => {
  const rig = await graphRig({
    policy: [
      act.readPageText('Read full page text'),
      act.finish('Page read.'),
    ],
  });
  t.after(rig.cleanup);

  const res = await rig.start('Read item page');
  assert.equal(res.success, true);
  assert.equal(rig.finishAnswer(), 'Page read.');

  const actions = rig.site.actions.filter((a) => a.payload?.action === 'read_page_text');
  assert.equal(actions.length, 1);
  rig.assertClean();
});

test('executeVerbs: navigate loads target page and reports url_changed', async (t) => {
  const rig = await graphRig({
    policy: [
      act.navigate(SHOP_PRODUCT_URL, 'Go directly to item 42'),
      act.finish('Item 42 loaded.'),
    ],
  });
  t.after(rig.cleanup);

  const res = await rig.start('Navigate to item');
  assert.equal(res.success, true);
  assert.equal(rig.finishAnswer(), 'Item 42 loaded.');

  const exec = rig.entries('execution_result')[0] as any;
  assert.equal(exec?.success, true);
  assert.equal(exec?.via, 'background');
  assert.equal(exec?.effect, 'url_changed');
  rig.assertClean();
});

test('executeVerbs: go_back navigates back to previous page', async (t) => {
  const rig = await graphRig({
    policy: [
      act.navigate(SHOP_PRODUCT_URL, 'Go to item 42'),
      act.goBack('Return to list'),
      act.finish('Returned to list.'),
    ],
  });
  t.after(rig.cleanup);

  const res = await rig.start('Visit and go back');
  assert.equal(res.success, true);
  assert.equal(rig.finishAnswer(), 'Returned to list.');

  const execs = rig.entries('execution_result');
  assert.ok(execs.length >= 2);
  const backExec = (execs.find((e: any) => e.step === 2) || execs[1]) as any;
  assert.ok(backExec);
  assert.equal(backExec?.success, true);
  assert.equal(backExec?.via, 'background');
  rig.assertClean();
});

test('executeVerbs: execute_js executes in MAIN world on large tier', async (t) => {
  const rig = await graphRig({
    chrome: { scripting: { executeScript: { __scoutfoxOk: true, value: 'Item 42 Price' } } },
    settings: { modelTier: 'large' },
    policy: [
      act.executeJs("return document.querySelector('.price').textContent", 'Extract price'),
      act.finish('Price extracted via JS.'),
    ],
  });
  t.after(rig.cleanup);

  await rig.start('Extract price with JS');
  assert.equal(rig.status(), 'paused');
  assert.ok(rig.pending().confirm);

  await rig.confirm('approve');
  assert.equal(rig.status(), 'idle');
  assert.equal(rig.finishAnswer(), 'Price extracted via JS.');

  const exec = rig.entries('execution_result')[0] as any;
  assert.ok(exec);
  assert.equal(exec?.success, true);
  assert.equal(exec?.via, 'background');
  rig.assertClean();
});

test('executeVerbs: open_window opens second window and tab', async (t) => {
  const rig = await graphRig({
    chrome: { windows: true },
    settings: { modelTier: 'large' },
    policy: [
      act.openWindow(SHOP_PRODUCT_URL, 'Open in new window'),
      act.finish('Window opened.'),
    ],
  });
  t.after(rig.cleanup);

  const res = await rig.start('Open comparison window');
  assert.equal(res.success, true);
  assert.equal(rig.finishAnswer(), 'Window opened.');

  const exec = rig.entries('execution_result')[0] as any;
  assert.ok(exec);
  assert.equal(exec?.success, true);
  assert.equal(exec?.via, 'background');
  assert.equal(exec?.effect, 'url_changed');
  rig.assertClean();
});

test('executeVerbs: browser_batch runs multiple steps deterministically', async (t) => {
  const rig = await graphRig({
    settings: { modelTier: 'large' },
    policy: [
      act.browserBatch([
        { action: 'scroll', direction: 'down' },
        { action: 'wait', amount: 1 },
      ], 'Scroll and wait'),
      act.finish('Batch complete.'),
    ],
  });
  t.after(rig.cleanup);

  const res = await rig.start('Run batch actions');
  assert.equal(res.success, true);
  assert.equal(rig.finishAnswer(), 'Batch complete.');

  const exec = rig.entries('execution_result')[0] as any;
  assert.ok(exec);
  assert.equal(exec?.success, true);
  rig.assertClean();
});
