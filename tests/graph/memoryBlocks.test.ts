/**
 * tests/graph/memoryBlocks.test.ts
 *
 * The memory blocks reach the worker's policy prompt in a real run (memory-blocks-not-rendered).
 * The orchestrator filled siteIn with recap, earlierSites, visitedRecent, blocked and priorFindings,
 * but the worker never passed them on, visitedRecent had no writer, and a domain another site had
 * marked blocked was only "forbidden" in words nobody showed. These runs go through the whole
 * runner (fake chrome, fake page, fake model) and read the prompts the model really got.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { link, type PageSpec } from '../helpers/fakeDom.ts';
import { graphRig, act, type GraphRig } from '../helpers/graphHarness.ts';
import { blockedTargetOf, doNotOpen } from '../../src/background/graph/worker.ts';

const SHOP_HOME = 'https://shop.test/';
const SHOP_LAPTOP = 'https://shop.test/laptop';
const WALL_HOME = 'https://wall.test/';
const WALL_OTHER = 'https://wall.test/other';

const PAGES: PageSpec[] = [
  {
    url: SHOP_HOME,
    title: 'Welcome - Shop',
    text: [{ heading: 'Welcome to the shop' }, 'Browse our laptops'],
    elements: [link('Laptops', SHOP_LAPTOP)],
  },
  {
    url: SHOP_LAPTOP,
    title: 'Framework Laptop 16 - Shop',
    text: [{ heading: 'Framework Laptop 16' }, 'Preis 1.399,00 EUR', 'In den Warenkorb'],
    elements: [link('Back to the shop', SHOP_HOME)],
  },
  {
    url: WALL_HOME,
    title: 'Please log in - Wall',
    text: [{ heading: 'Log in to see prices' }, 'Members only'],
    elements: [link('Other page', WALL_OTHER)],
  },
  {
    url: WALL_OTHER,
    title: 'Other - Wall',
    text: [{ heading: 'Other' }, 'Still members only'],
    elements: [link('Home', WALL_HOME)],
  },
];

const researchPlan = (sites: Array<{ domain: string; goal: string; startUrl: string }>): string => JSON.stringify({
  task_kind: 'research',
  columns: ['price'],
  search_query: 'laptop price',
  sites: sites.map((s, i) => ({
    domain: s.domain,
    goal: s.goal,
    startUrl: s.startUrl,
    role: i === 0 ? 'reference' : 'compare',
    kind: 'store',
    difficulty: 1,
    required_fields: ['price'],
    done_when: 'all_required',
    check: { type: 'none', value: '' },
  })),
});

const WALL_SITE = { domain: 'wall.test', goal: 'Find the price of the Framework Laptop 16 on wall.test', startUrl: WALL_HOME };
const SHOP_SITE = { domain: 'shop.test', goal: 'Find the price of the Framework Laptop 16 on shop.test', startUrl: SHOP_HOME };
const recordPrice = (value: string): string => JSON.stringify({ action: 'record_finding', values: { price: value }, reason: 'The price is on the page' });
const markBlocked = (reason: string): string => JSON.stringify({ action: 'mark_blocked', reason });

function prompts(rig: GraphRig): string[] {
  return rig.llm.callsOf('policy').map((c: any) => String(c.messages?.at(-1)?.content ?? ''));
}

function section(msg: string, header: string): string | null {
  const at = msg.indexOf(header);
  if (at < 0) return null;
  const end = msg.indexOf('\n\n', at);
  return end < 0 ? msg.slice(at) : msg.slice(at, end);
}

describe('memory blocks in the worker prompt (memory-blocks-not-rendered)', () => {
  test('site 2 sees site 1\'s outcome, the pages already visited and site 1\'s blocked domain, and code refuses to open it', async (t) => {
    const rig = await graphRig({ pages: PAGES, startUrl: SHOP_HOME, plan: null, settings: { modelTier: 'small' } });
    t.after(rig.cleanup);

    rig.push(
      markBlocked('Login wall, prices are for members only'),             // s1 wall.test
      act.navigate(WALL_OTHER, 'Try the other page of wall.test'),       // s2: a blocked domain
      act.navigate(SHOP_LAPTOP, 'Open the laptop page'),                 // s2
      recordPrice('1.399,00 EUR'),                                       // s2
    );
    await rig.start('Compare the Framework Laptop 16 price on wall.test and shop.test', {
      effort: 'low',
      plan: researchPlan([WALL_SITE, SHOP_SITE]),
    });
    assert.equal(rig.status(), 'idle', `the run finished (last=${JSON.stringify(rig.history().at(-1)).slice(0, 300)})`);

    const shown = prompts(rig);
    assert.equal(shown.length, 4, `four policy calls: ${shown.length}`);
    const site2First = shown[1];
    assert.match(site2First, /CURRENT SITE \(2 of 2, shop\.test/);

    const earlier = section(site2First, 'EARLIER SITES');
    assert.ok(earlier, `site 2's prompt has EARLIER SITES:\n${site2First}`);
    assert.match(earlier!, /wall\.test \(reference\): blocked/);
    assert.match(earlier!, /Login wall/);

    const doNotOpen = section(site2First, 'DO NOT OPEN');
    assert.ok(doNotOpen, `site 2's prompt has DO NOT OPEN:\n${site2First}`);
    assert.match(doNotOpen!, /wall\.test/);

    const visited = section(site2First, 'VISITED');
    assert.ok(visited, `site 2's prompt has VISITED:\n${site2First}`);
    const order = [...visited!.matchAll(/https:\/\/(wall|shop)\.test\/\S*/g)].map((m) => m[0]);
    assert.deepEqual(order, [WALL_HOME, SHOP_HOME], 'the pages of both sites, in the order they were visited');

    // The navigation to the blocked domain is refused by code: the page is never opened, and the
    // next prompt lists the refusal as a failed action.
    assert.equal(rig.site.reads.some((r: any) => String(r.url ?? '').startsWith(WALL_OTHER)), false, 'wall.test/other was never read');
    assert.match(shown[2], /ALREADY TRIED AND FAILED ON THIS SITE:[\s\S]*wall\.test\/other/);
    assert.match(shown[2], /blocked/i);
    rig.assertClean();
  });

  test('a follow-up task under the small-tier budget sees the previous task\'s goal, result and findings', async (t) => {
    const rig = await graphRig({ pages: PAGES, startUrl: SHOP_HOME, plan: null, settings: { modelTier: 'small' } });
    t.after(rig.cleanup);

    // Turn 1: the price on shop.test.
    rig.push(recordPrice('1.399,00 EUR'));
    await rig.start('What does the Framework Laptop 16 cost on shop.test?', { effort: 'low', plan: researchPlan([{ ...SHOP_SITE, startUrl: SHOP_LAPTOP }]) });
    assert.equal(rig.status(), 'idle', `turn 1 finished (last=${JSON.stringify(rig.history().at(-1)).slice(0, 300)})`);
    const turn1Calls = rig.llm.callsOf('policy').length;

    // Turn 2: the follow-up has no referent of its own.
    rig.push(act.subgoalDone('Added the laptop to the cart', 'In den Warenkorb'));
    await rig.start('now add it to the cart', {
      effort: 'low',
      plan: JSON.stringify({ taskKind: 'action', sites: [{ id: 's1', name: 'shop.test', domain: 'shop.test', role: 'reference', kind: 'page', goal: 'Add the laptop to the cart', startUrl: SHOP_LAPTOP }] }),
    });
    if (rig.status() !== 'idle') await rig.stop();

    const followUp = prompts(rig)[turn1Calls];
    assert.ok(followUp, 'turn 2 made a policy call');
    assert.match(followUp, /TASK: now add it to the cart/);
    const recap = section(followUp, 'EARLIER IN THIS SESSION');
    assert.ok(recap, `the follow-up prompt has the previous task:\n${followUp}`);
    assert.match(recap!, /What does the Framework Laptop 16 cost on shop\.test\?/);
    assert.match(recap!, /1\.399,00 EUR/);
    const prior = section(followUp, 'FINDINGS FROM AN EARLIER TASK');
    assert.ok(prior, `the follow-up prompt has the earlier task's findings:\n${followUp}`);
    assert.match(prior!, /\[turn 1, shop\.test\] price: 1\.399,00 EUR/);
    rig.assertClean();
  });
});

describe('the cross-site blocked-domain gate (blockedTargetOf, doNotOpen)', () => {
  const blockedOf = (domain: string) => ({ domain, kind: 'model_reported' as const, reason: 'login wall', url: `https://${domain}/`, step: 1, tries: 1 });
  const none = () => null;

  test('navigate, open_window, a link click and a batch click to a blocked site are caught; www and subdomains count', () => {
    const blocked = [blockedOf('wall.test')];
    assert.equal(blockedTargetOf({ action: 'navigate', url: 'https://www.wall.test/x' }, none, blocked)?.domain, 'wall.test');
    assert.equal(blockedTargetOf({ action: 'open_window', url: 'https://shop.wall.test/' }, none, blocked)?.domain, 'wall.test');
    const links = (id: number | string) => (Number(id) === 7 ? { hrefDomain: 'wall.test' } : { hrefDomain: 'shop.test' });
    assert.equal(blockedTargetOf({ action: 'click', element_id: 7 }, links, blocked)?.domain, 'wall.test');
    assert.equal(blockedTargetOf({ action: 'click', element_id: 3 }, links, blocked), null);
    assert.equal(blockedTargetOf({ action: 'browser_batch', steps: [{ action: 'scroll' }, { action: 'click', element_id: 7 }] }, links, blocked)?.domain, 'wall.test');
    assert.equal(blockedTargetOf({ action: 'navigate', url: 'https://shop.test/' }, none, blocked), null);
  });

  test('the current site\'s own domain is never on its DO NOT OPEN list', () => {
    const siteIn = { site: { domain: 'wall.test', startUrl: 'https://wall.test/' } as any, blocked: [blockedOf('wall.test'), blockedOf('other.test')] };
    assert.deepEqual(doNotOpen(siteIn).map((b) => b.domain), ['other.test']);
  });
});
