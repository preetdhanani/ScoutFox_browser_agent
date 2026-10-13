/**
 * Extract mode is the small, focused mode for a page that shows the price the task asks for: it offers record_finding,
 * mark_not_found, continue_browsing, scroll, read_page_text and ask_user, and NO click or navigate.
 *
 * Two ways it trapped a run (found by the e2e baseline, `cheapest-offer`):
 *   - on a SEARCH results page (many products, many prices, a click needed to get anywhere);
 *   - after the model said `continue_browsing` ("this page is not for extracting"): the meter recomputes the mode on
 *     every loop and reads siteRun.suppressExtract, but nothing ever wrote it, so the model stayed in extract mode, with
 *     no way to leave the page, until the step budget ran out.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { graphRig, act } from '../helpers/graphHarness.ts';
import { link } from '../helpers/fakeDom.ts';
import { extractKeyOf } from '../../src/background/graph/worker.ts';
import type { PageSpec } from '../helpers/fakeDom.ts';

const CONTINUE = JSON.stringify({ action: 'continue_browsing', reason: 'this page only lists products' });
const NOT_FOUND = JSON.stringify({ action: 'mark_not_found', reason: 'no price for the product here' });

const plan = JSON.stringify({
  task_kind: 'research',
  columns: ['price'],
  search_query: 'laptop',
  sites: [{ domain: 'shop.test', goal: 'Find the price of the laptop', role: 'reference', kind: 'store', difficulty: 1, required_fields: ['price'], done_when: 'all_required', check: { type: 'none', value: '' } }],
});

const page = (url: string): PageSpec[] => [{
  url,
  title: 'Laptops - Shop',
  text: ['Laptop Pro', '1.399,00 EUR', 'Laptop Air', '999,00 EUR'],
  // One link: a page with no element and little text is a blank page to the blocked policy.
  elements: [link('Laptop Pro details', 'https://shop.test/laptop-pro-details')],
}];

async function run(url: string, policy: string[]) {
  const rig = await graphRig({ pages: page(url), startUrl: url, plan, policy });
  return rig;
}

const modesOf = (rig: Awaited<ReturnType<typeof run>>): string[] => (rig.entries('agent_response') as Array<{ mode?: string }>).map((e) => String(e.mode));

test('a price page is read in extract mode (the mode still exists)', async (t) => {
  const rig = await run('https://shop.test/laptop-pro', [NOT_FOUND]);
  t.after(rig.cleanup);
  await rig.start('Find the price of the laptop');
  assert.deepEqual(modesOf(rig), ['extract']);
});

test('a search results page is NOT read in extract mode (browse mode has click and navigate)', async (t) => {
  const rig = await run('https://shop.test/search?q=laptop', [act.scroll(), NOT_FOUND]);
  t.after(rig.cleanup);
  await rig.start('Find the price of the laptop');
  assert.equal(modesOf(rig)[0], 'browse');
  const system = String((rig.llm.callsOf('policy')[0] as any)?.system ?? '');
  assert.match(system, /click \{element_id\}/, 'the model is offered click on a search page');
});

test('continue_browsing in extract mode stops extract mode on that page (suppressExtract is written)', async (t) => {
  const rig = await run('https://shop.test/laptop-pro', [CONTINUE, act.scroll(), NOT_FOUND]);
  t.after(rig.cleanup);
  await rig.start('Find the price of the laptop');
  const modes = modesOf(rig);
  assert.equal(modes[0], 'extract');
  assert.equal(modes[1], 'browse', `after continue_browsing the same page is browsed, not extracted (modes: ${modes.join(' > ')})`);
});

test('suppressExtract is keyed per PAGE: the same text on another URL is another page', () => {
  // The page hash covers only the first 2000 characters of text (no URL, no elements), so two pages with one long menu
  // share it. A page the model said "continue" on must not switch extract mode off for the whole site.
  const a = extractKeyOf({ url: 'https://shop.test/laptop-pro', hash: 'abc123' });
  const b = extractKeyOf({ url: 'https://shop.test/laptop-air', hash: 'abc123' });
  assert.notEqual(a, b);
  assert.equal(a, extractKeyOf({ url: 'https://shop.test/laptop-pro', hash: 'abc123' }), 'the same page gives the same key');
  assert.notEqual(a, extractKeyOf({ url: 'https://shop.test/laptop-pro', hash: 'def456' }), 'the same URL with other text is another page state');
  assert.equal(extractKeyOf({ url: 'https://shop.test/x' }), '', 'a page with no hash is not remembered');
  assert.equal(extractKeyOf(null), '');
});
