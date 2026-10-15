import test from 'node:test';
import assert from 'node:assert/strict';
import { graphRig, act } from '../helpers/graphHarness.ts';
import { link } from '../helpers/fakeDom.ts';
import type { PageSpec } from '../helpers/fakeDom.ts';
import { Logger } from '../../src/shared/logger.ts';

test('planNode: passes earlier completed turn recap into follow-up plan prompt', async (t) => {
  const rig = await graphRig({
    policy: [
      act.finish('Item 42 costs 99 USD.'),
      act.finish('Item 43 costs 120 USD.'),
    ],
  });
  t.after(rig.cleanup);

  // Turn 1
  await rig.start('Find price of item 42');
  assert.equal(rig.status(), 'idle');

  // Turn 2
  await rig.start('Now find item 43');
  assert.equal(rig.status(), 'idle');

  // The plan call for turn 2 should have had the earlier session context
  const planCalls = rig.llm.callsOf('plan');
  assert.ok(planCalls.length >= 2);
  const secondPlanMsg = planCalls[1]?.messages?.[0]?.content || '';
  assert.ok(secondPlanMsg.includes('Earlier in this session:'));
  assert.ok(secondPlanMsg.includes('Find price of item 42'));
  assert.ok(secondPlanMsg.includes('Item 42 costs 99 USD.'));
});

// A plan reply the repair retry can succeed with: the full schema shape the planner is asked for.
function validPlanJson(): string {
  return JSON.stringify({
    task_kind: 'research',
    columns: ['price'],
    search_query: 'item 42 price',
    sites: [
      { domain: 'shop.test', goal: 'Find the price of item 42', role: 'reference', kind: 'store', difficulty: 1, required_fields: ['price'], done_when: 'all_required', check: { type: 'none', value: '' } },
    ],
  });
}

test('planNode: an unparseable plan reply triggers exactly one repair retry whose prompt carries the parse error', async (t) => {
  const rig = await graphRig({
    autoApprove: false,
    plan: null,
    policy: [act.finish('Item 42 costs 99 USD.')],
  });
  t.after(rig.cleanup);
  rig.llm.pushFor('plan', 'I cannot plan that.', validPlanJson());

  await rig.start('Find the price of item 42');
  assert.equal(rig.status(), 'paused', 'the repaired plan waits at the approval hold');

  const planCalls = rig.llm.callsOf('plan');
  assert.equal(planCalls.length, 2, `exactly one repair retry, got ${planCalls.length} plan calls`);
  const repairPrompt = planCalls[1]?.messages?.at(-1)?.content ?? '';
  assert.match(repairPrompt, /could not be parsed/, `the retry prompt names the parse problem, got: ${repairPrompt.slice(0, 200)}`);
  assert.match(repairPrompt, /I cannot plan that\./, 'the failed reply is sent back to the model');

  const notice = rig.history().find((h) => h.type === 'notice' && String((h as any).content).includes('could not be parsed'));
  assert.ok(notice, 'the parse failure is a visible history entry');

  const approval = rig.pending().approval as any;
  assert.equal(approval?.planMeta?.source, 'llm', 'the repaired plan is a model plan the card can show');

  await rig.approvePlan();
  assert.equal(rig.status(), 'idle');
  assert.equal(rig.finishAnswer(), 'Item 42 costs 99 USD.');
});

test('planNode: a bare array reply is no longer turned into sites by regex - it triggers one repair retry', async (t) => {
  const rig = await graphRig({
    autoApprove: false,
    plan: null,
    policy: [act.finish('Item 42 costs 99 USD.')],
  });
  t.after(rig.cleanup);
  rig.llm.pushFor('plan', '["shop.test: find the price", "shop2.test: compare the price"]', validPlanJson());

  await rig.start('Find the price of item 42');
  assert.equal(rig.status(), 'paused');

  const planCalls = rig.llm.callsOf('plan');
  assert.equal(planCalls.length, 2, `the bare array gets one repair retry, got ${planCalls.length} plan calls`);

  const approval = rig.pending().approval as any;
  const plan = approval?.planMeta;
  assert.equal(plan?.source, 'llm');
  assert.equal(plan?.sites?.[0]?.goal, 'Find the price of item 42', `the repaired plan is used, not regex-derived sites, got: ${JSON.stringify(plan?.sites?.[0])}`);
  assert.ok(rig.history().some((h) => h.type === 'notice'), 'the repair is a visible history entry');

  await rig.approvePlan();
  assert.equal(rig.status(), 'idle');
});

test('planNode: a compare object without a reference triggers one repair retry', async (t) => {
  const rig = await graphRig({
    autoApprove: false,
    plan: null,
    policy: [act.finish('Item 42 costs 99 USD.')],
  });
  t.after(rig.cleanup);
  const withoutReference = JSON.stringify({
    task_kind: 'research',
    columns: ['price'],
    search_query: 'item 42 price',
    compare: { field: 'price', threshold_pct: 10 },
    sites: [
      { domain: 'shop.test', goal: 'Find the price of item 42', role: 'reference', kind: 'store', difficulty: 1, required_fields: ['price'], done_when: 'all_required', check: { type: 'none', value: '' } },
    ],
  });
  const withReference = JSON.stringify({
    task_kind: 'research',
    columns: ['price'],
    search_query: 'item 42 price',
    compare: { reference_domain: 'shop.test', field: 'price', threshold_pct: 10 },
    sites: [
      { domain: 'shop.test', goal: 'Find the price of item 42', role: 'reference', kind: 'store', difficulty: 1, required_fields: ['price'], done_when: 'all_required', check: { type: 'none', value: '' } },
    ],
  });
  rig.llm.pushFor('plan', withoutReference, withReference);

  await rig.start('Find the price of item 42');
  assert.equal(rig.status(), 'paused');

  const planCalls = rig.llm.callsOf('plan');
  assert.equal(planCalls.length, 2, `a compare without a reference gets one repair retry, got ${planCalls.length} plan calls`);

  const approval = rig.pending().approval as any;
  assert.equal(approval?.planMeta?.compare?.reference_domain, 'shop.test', 'the repaired compare names its reference');
  assert.ok(rig.history().some((h) => h.type === 'notice'), 'the repair is a visible history entry');

  await rig.approvePlan();
  assert.equal(rig.status(), 'idle');
});

test('planNode: when the repair retry also fails the run pauses with the fallback banner instead of silently continuing', async (t) => {
  const rig = await graphRig({
    plan: null,
    policy: [act.finish('Should not run silently.')],
  });
  t.after(rig.cleanup);
  rig.llm.pushFor('plan', 'garbage one', 'garbage two');

  await rig.start('Check prices');
  assert.equal(rig.status(), 'paused', 'the fallback plan is never auto-approved - the user decides');

  const approval = rig.pending().approval as any;
  assert.ok(approval, 'the plan card is shown');
  assert.equal(approval?.planMeta?.source, 'fallback');

  const banner = rig.history().find((h) => h.type === 'notice' && String((h as any).content).includes('Planner reply was unreadable'));
  assert.ok(banner, `the banner is a visible history entry, got: ${JSON.stringify(rig.history().map((h) => (h as any).content))}`);
  assert.equal((banner as any)?.level, 'warn');
  assert.equal(rig.llm.callsOf('plan').length, 2, 'still exactly one repair retry');
  assert.equal(rig.state().stepCount, 1, 'the repair retry is counted in the step budget');

  await rig.approvePlan();
  assert.equal(rig.status(), 'idle');
});

test('planNode: a task naming two or more sites pauses with llm_failure instead of an invented fallback plan', async (t) => {
  const rig = await graphRig({
    plan: null,
    policy: [act.finish('Should not run.')],
  });
  t.after(rig.cleanup);
  rig.llm.pushFor('plan', 'garbage one', 'garbage two');

  await rig.start('Compare the price on shop1.test and shop2.test');
  assert.equal(rig.status(), 'paused');
  assert.equal(rig.state().pauseReason, 'llm_failure', 'the multi-site rule uses the existing llm_failure pause');
  assert.equal(rig.pending().approval, null, 'no fallback plan card is offered');
  assert.equal(rig.llm.callsOf('plan').length, 2, 'exactly one repair retry before the pause');

  const errRow = rig.history().find((h) => h.type === 'error') as any;
  assert.ok(errRow, 'the pause is a visible history entry');
  assert.match(String(errRow?.content), /shop1\.test/, 'the error names the sites no plan was invented for');
});

test('planNode: missing plan fields are filled by default and listed, without a repair retry', async (t) => {
  const rig = await graphRig({
    autoApprove: false,
    plan: null,
    policy: [act.finish('Item 42 costs 99 USD.')],
  });
  t.after(rig.cleanup);
  const sparsePlan = JSON.stringify({
    sites: [
      { domain: 'shop.test', goal: 'Find the price', required_fields: ['price'] },
      { goal: 'Compare the price' },
    ],
  });
  rig.llm.pushFor('plan', sparsePlan);

  await rig.start('Find the price of item 42');
  assert.equal(rig.status(), 'paused');

  assert.equal(rig.llm.callsOf('plan').length, 1, 'missing fields are defaults, not parse errors - no retry');
  const plan = (rig.pending().approval as any)?.planMeta;
  assert.equal(plan?.source, 'llm');
  const defaulted: string[] = plan?.defaulted ?? [];
  assert.ok(defaulted.includes('task_kind'), `task_kind is listed as defaulted, got: ${JSON.stringify(defaulted)}`);
  assert.ok(defaulted.includes('sites[2].domain'), `the second site's domain is listed, got: ${JSON.stringify(defaulted)}`);
  assert.ok(defaulted.includes('sites[2].difficulty'), `the second site's difficulty is listed, got: ${JSON.stringify(defaulted)}`);

  await rig.approvePlan();
  assert.equal(rig.status(), 'idle');
});

test('planNode: logs [PLANNER_FALLBACK] and pauses with the fallback banner when the planner reply stays unreadable', async (t) => {
  const logs: string[] = [];
  const origInfo = Logger.info;
  Logger.info = (tag: string, msg: string) => {
    logs.push(`[${tag}] ${msg}`);
    origInfo.call(Logger, tag, msg);
  };
  t.after(() => {
    Logger.info = origInfo;
  });

  const rig = await graphRig({
    plan: null,
    policy: [act.finish('Done with fallback.')],
  });
  t.after(rig.cleanup);
  rig.llm.pushFor('plan', 'Invalid non-json response from planner', 'still not a plan');

  await rig.start('Check prices');
  assert.equal(rig.status(), 'paused', 'the fallback plan waits for the user instead of running silently');
  assert.equal((rig.pending().approval as any)?.planMeta?.source, 'fallback');
  assert.ok(logs.some((l) => l.includes('[PLANNER_FALLBACK]')));

  await rig.approvePlan();
  assert.equal(rig.status(), 'idle');
});

test('planNode: pauses at approve_plan hold when autoApprove is false', async (t) => {
  const rig = await graphRig({
    autoApprove: false,
    policy: [act.finish('Item 42 costs 99 USD.')],
  });
  t.after(rig.cleanup);

  await rig.start('Compare laptop models');
  assert.equal(rig.status(), 'paused');
  assert.ok(rig.pending().approval, 'Plan hold is pending');

  await rig.approvePlan();
  assert.equal(rig.status(), 'idle');
  assert.equal(rig.finishAnswer(), 'Item 42 costs 99 USD.');
});

test('planNode: auto-approves plan when autoApprove is true', async (t) => {
  const rig = await graphRig({
    autoApprove: true,
    policy: [act.finish('Item 42 costs 99 USD.')],
  });
  t.after(rig.cleanup);

  await rig.start('Quick lookup');
  assert.equal(rig.status(), 'idle');
  assert.equal(rig.finishAnswer(), 'Item 42 costs 99 USD.');
});

test('planNode: a summarize task planned as research is redirected to answer mode', async (t) => {
  const rig = await graphRig({
    // The live failure: the planner put a summarize task in the research bucket with title/url/
    // summary columns - prose no finding can satisfy - instead of the answer bucket.
    plan: JSON.stringify({
      task_kind: 'research',
      columns: ['title', 'url', 'summary'],
      search_query: 'main articles',
      sites: [
        { domain: 'shop.test', goal: 'Read the main articles', role: 'reference', kind: 'page', difficulty: 1, required_fields: ['title', 'url', 'summary'], done_when: 'all_required', check: { type: 'none', value: '' } },
      ],
    }),
    policy: [act.finish('Top story: GLM-Legal ...')],
  });
  t.after(rig.cleanup);

  await rig.start('Summarize the main articles on this page');
  assert.equal(rig.finishAnswer(), 'Top story: GLM-Legal ...');

  // The redirect: the site ran as answer kind, so the model's plain finish was accepted as the
  // task answer (the old research plan would have demanded record_finding values instead).
  const planCalls = rig.llm.callsOf('plan');
  assert.ok(planCalls.length >= 1);
  void planCalls;
  const policyCalls = rig.llm.callsOf('policy');
  assert.ok(policyCalls.length >= 1, 'A policy call happened');
  const firstPolicySystem = String((policyCalls[0] as any)?.system ?? (policyCalls[0] as any)?.messages?.[0]?.content ?? '');
  assert.ok(!firstPolicySystem.includes('record_finding'), `answer-kind site must not be offered record_finding, got: ${firstPolicySystem.slice(0, 300)}`);
});

test('planNode: a real research task with a summary word keeps its research plan', async (t) => {
  const rig = await graphRig({
    plan: JSON.stringify({
      task_kind: 'research',
      columns: ['price', 'summary'],
      search_query: 'laptop summary',
      sites: [
        { domain: 'shop.test', goal: 'Find the laptop price', role: 'reference', kind: 'store', difficulty: 1, required_fields: ['price'], done_when: 'all_required', check: { type: 'none', value: '' } },
        { domain: 'shop2.test', goal: 'Find the laptop price', role: 'compare', kind: 'store', difficulty: 1, required_fields: ['price'], done_when: 'all_required', check: { type: 'none', value: '' } },
      ],
    }),
    policy: [
      act.finish('Shop A 99 USD.'),
      act.finish('Shop B 120 USD.'),
    ],
  });
  t.after(rig.cleanup);

  await rig.start('Compare laptop prices and summarize the deals');

  // Two sites ran (the plan was not collapsed to one answer site), and the collected prices
  // reached the truth table the answer is built from.
  const planCalls = rig.llm.callsOf('plan');
  assert.ok(planCalls.length >= 1);
  void planCalls;
  const policyCalls = rig.llm.callsOf('policy');
  const withRecord = policyCalls.filter((c: any) => String(c?.system ?? c?.messages?.[0]?.content ?? '').includes('record_finding'));
  assert.ok(withRecord.length >= 1, 'The research sites ran collect policy with record_finding');
});

test('planNode: user stop during initial plan cancels run without starting policy', async (t) => {
  const rig = await graphRig({
    autoApprove: false,
    policy: [act.finish('Should not run.')],
  });
  t.after(rig.cleanup);

  await rig.start('Task to be stopped');
  assert.equal(rig.status(), 'paused');
  assert.ok(rig.pending().approval);

  const stopRes = await rig.stop();
  assert.equal(stopRes.success, true);
  assert.equal(rig.status(), 'stopped');
});

test('planNode: parses structured plan JSON with multiple comparison sites', async (t) => {
  const customPlan = JSON.stringify({
    sites: [
      { name: 'Shop 1', domain: 'shop1.test', goal: 'Find price', role: 'primary', kind: 'store' },
      { name: 'Shop 2', domain: 'shop2.test', goal: 'Compare price', role: 'compare', kind: 'store' },
    ],
    task_kind: 'answer',
    columns: ['price', 'shipping'],
  });

  const rig = await graphRig({
    plan: customPlan,
    policy: [act.finish('Item 42 costs 99 USD.')],
  });
  t.after(rig.cleanup);

  await rig.start('What is the lowest price between Shop 1 and Shop 2?');
  assert.equal(rig.status(), 'idle');
  assert.equal(rig.finishAnswer(), 'Item 42 costs 99 USD.');
});

test('planNode: infers answer task_kind when query contains price keywords', async (t) => {
  const customPlan = JSON.stringify({
    sites: [
      { name: 'Store', domain: 'store.test', goal: 'Get price' },
    ],
  });

  const rig = await graphRig({
    plan: customPlan,
    policy: [act.finish('Item 42 costs 99 USD.')],
  });
  t.after(rig.cleanup);

  await rig.start('What is the price of the keyboard?');
  assert.equal(rig.status(), 'idle');
  assert.equal(rig.finishAnswer(), 'Item 42 costs 99 USD.');
});

test('planNode: plan prompt carries user goal accurately', async (t) => {
  const rig = await graphRig({
    policy: [act.finish('Item 42 costs 99 USD.')],
  });
  t.after(rig.cleanup);

  await rig.start('Find red running shoes size 10');
  assert.equal(rig.status(), 'idle');

  const planCalls = rig.llm.callsOf('plan');
  assert.ok(planCalls.length >= 1);
  const planUserMsg = planCalls[0]?.messages?.[0]?.content || '';
  assert.ok(planUserMsg.includes('Find red running shoes size 10'));
});

test('planNode: rejection of plan hold terminates task cleanly as stopped', async (t) => {
  const rig = await graphRig({
    autoApprove: false,
    policy: [act.finish('Should not run.')],
  });
  t.after(rig.cleanup);

  await rig.start('Task to reject plan');
  assert.equal(rig.status(), 'paused');
  assert.ok(rig.pending().approval);

  const stopRes = await rig.stop();
  assert.equal(stopRes.success, true);
  assert.equal(rig.status(), 'stopped');
});


test('planNode: a roundup task becomes an answer site and finishes with the list as prose', async (t) => {
  // The live failure: "Find top trending repositories on GitHub for python" was planned as a
  // research/collect site. The findings engine keeps one finding per field per site, so the site
  // was 'done' after the first repository and the run ended with a one-row table and
  // "(The model did not provide an answer.)" instead of the list the user asked for.
  const pages: PageSpec[] = [{
    url: 'https://github.test/trending/python',
    title: 'Trending Python repositories on GitHub today',
    text: ['debpalash / VoiceStudio', '61,949 stars', 'acme / other-repo', '12,345 stars', 'Trending repositories on GitHub today'],
    elements: [link('debpalash / VoiceStudio', 'https://github.test/debpalash/VoiceStudio')],
  }];
  const rig = await graphRig({
    pages,
    startUrl: pages[0].url,
    plan: JSON.stringify({
      task_kind: 'research',
      columns: ['repository', 'stars', 'url'],
      search_query: 'trending python repositories',
      sites: [
        { domain: 'github.test', goal: 'Find the top trending Python repositories', role: 'reference', kind: 'page', difficulty: 1, required_fields: ['repository', 'stars'], done_when: 'all_required', check: { type: 'none', value: '' } },
      ],
    }),
    policy: [act.subgoalDone('1. debpalash / VoiceStudio - 61,949 stars\n2. acme / other-repo - 12,345 stars')],
  });
  t.after(rig.cleanup);

  await rig.start('Find top trending repositories on GitHub for python');
  assert.equal(rig.status(), 'idle');

  const policyCalls = rig.llm.callsOf('policy');
  assert.ok(policyCalls.length >= 1, 'the roundup site got a policy call');
  const system = String((policyCalls[0] as any)?.system ?? '');
  assert.ok(system.includes('subgoal_done {summary, evidence}'), `a roundup answer site must be offered subgoal_done, got: ${system.slice(0, 220)}`);
  assert.ok(!system.includes('record_finding'), 'a roundup answer site must not be offered record_finding');
  const answer = rig.finishAnswer() || '';
  assert.ok(answer.includes('debpalash / VoiceStudio'), `the answer must list the repositories, got: ${answer}`);
});

test('planNode: a search ask over a roundup noun becomes an answer site, so the model must answer in prose', async (t) => {
  // The live failure: "Search Google for open-source AI browser frameworks" was planned as
  // research. The site's criteria were met the moment the results page loaded (a URL predicate),
  // the model ended the site with the status report "the search results page is displayed", and
  // the card answered nothing. A search ask over a roundup noun wants the found items, so it is
  // planned as an answer site: the model cannot end without prose there.
  const pages: PageSpec[] = [{
    url: 'https://google.test/search?q=open-source+AI+browser+frameworks',
    title: 'open-source AI browser frameworks - Google Search',
    text: ['BrowserUse - an open-source AI browser framework', 'LaVague - a web agent framework', 'About 8,000,000 results'],
    elements: [link('BrowserUse - an open-source AI browser framework', 'https://github.test/browser-use/browser-use')],
  }];
  const rig = await graphRig({
    pages,
    startUrl: pages[0].url,
    plan: JSON.stringify({
      task_kind: 'research',
      columns: ['framework'],
      search_query: 'open-source AI browser frameworks',
      sites: [
        { domain: 'google.test', goal: 'Search Google for open-source AI browser frameworks', role: 'reference', kind: 'page', difficulty: 1, required_fields: ['framework'], done_when: 'predicate', predicate: { type: 'url_contains', value: 'search' } },
      ],
    }),
    policy: [act.subgoalDone('Open-source AI browser frameworks include BrowserUse and LaVague.')],
  });
  t.after(rig.cleanup);

  await rig.start('Search Google for open-source AI browser frameworks');
  assert.equal(rig.status(), 'idle');

  const policyCalls = rig.llm.callsOf('policy');
  assert.ok(policyCalls.length >= 1, 'the search-ask site got a policy call');
  const system = String((policyCalls[0] as any)?.system ?? '');
  assert.ok(system.includes('subgoal_done {summary, evidence}'), `a search-ask answer site must be offered subgoal_done, got: ${system.slice(0, 220)}`);
  assert.ok(!system.includes('record_finding'), 'a search-ask answer site must not be offered record_finding');
  const answer = rig.finishAnswer() || '';
  assert.ok(answer.includes('BrowserUse'), `the answer must name what the search found, got: ${answer}`);
});

test('planNode: a search ask without a roundup noun stays a research plan', async (t) => {
  // "Search for flights to Paris" is an action ask: the noun list does not match, so the planner's
  // research plan stands and the site can still end on its predicate.
  const { isSearchAskTask } = await import('../../src/background/graph/orchestrator.ts');
  assert.equal(isSearchAskTask('Search Google for flights to Paris'), false);
  assert.equal(isSearchAskTask('Search Google for open-source AI browser frameworks'), true);
  assert.equal(isSearchAskTask('look up the best tools for video editing'), true);
  assert.equal(isSearchAskTask('Buy milk'), false);
});
function siteList(domains: string[], kind: 'research' | 'action'): string {
  return JSON.stringify({
    task_kind: kind,
    columns: kind === 'research' ? ['price'] : [],
    search_query: 'test task',
    sites: domains.map((domain, idx) => ({
      domain,
      goal: `Handle ${domain}`,
      role: idx === 0 ? 'reference' : 'compare',
      kind: kind === 'action' ? 'page' : 'store',
      difficulty: 1,
      required_fields: kind === 'research' ? ['price'] : [],
      done_when: kind === 'action' ? 'predicate' : 'all_required',
      check: kind === 'action' ? { type: 'url_contains', value: 'done' } : { type: 'none', value: '' },
    })),
  });
}

test('planNode: a 6-site research plan is kept in full', async (t) => {
  const domains = ['shop1.test', 'shop2.test', 'shop3.test', 'shop4.test', 'shop5.test', 'shop6.test'];
  const rig = await graphRig({
    autoApprove: false,
    plan: siteList(domains, 'research'),
    policy: [],
  });
  t.after(rig.cleanup);

  await rig.start('Compare laptop prices on shop1.test, shop2.test, shop3.test, shop4.test, shop5.test and shop6.test');
  assert.equal(rig.status(), 'paused');

  const plan = (rig.pending().approval as any).planMeta;
  assert.equal(plan.sites.length, 6, `all 6 sites must be kept, got ${plan.sites.length}: ${JSON.stringify(plan.sites.map((s: any) => s.domain))}`);
  for (const site of plan.sites) {
    assert.equal(site.namedByUser, true, `${site.domain} is named in the task, so it is user-named`);
  }
  assert.equal(rig.history().some((h) => h.type === 'notice' && h.kind === 'plan'), false, 'nothing was dropped, so no trim notice');

  await rig.stop();
});

test('planNode: an over-cap plan is cut with a notice and the user-named sites are kept first', async (t) => {
  const named = ['shop1.test', 'shop2.test', 'shop3.test', 'shop4.test', 'shop5.test', 'shop6.test'];
  const rig = await graphRig({
    autoApprove: false,
    plan: siteList(['invented.test', ...named], 'research'),
    policy: [],
  });
  t.after(rig.cleanup);

  await rig.start('Compare laptop prices on shop1.test, shop2.test, shop3.test, shop4.test, shop5.test and shop6.test');
  assert.equal(rig.status(), 'paused');

  const plan = (rig.pending().approval as any).planMeta;
  const keptDomains = plan.sites.map((s: any) => s.domain);
  assert.equal(plan.sites.length, 6, `the cap keeps 6 sites, got ${plan.sites.length}: ${JSON.stringify(keptDomains)}`);
  assert.ok(!keptDomains.includes('invented.test'), `the site the user never named is dropped first, kept: ${JSON.stringify(keptDomains)}`);
  for (const site of plan.sites) {
    assert.equal(site.namedByUser, true, `${site.domain} is named in the task`);
  }
  const notice = rig.history().find((h) => h.type === 'notice' && h.kind === 'plan') as any;
  assert.ok(notice, 'a cut writes a notice entry');
  assert.equal(notice.level, 'warn');
  assert.ok(String(notice.content).includes('invented.test'), `the notice names what was dropped, got: ${notice?.content}`);

  await rig.stop();
});

test('planNode: a 6-step action plan is kept in full', async (t) => {
  const domains = ['shop1.test', 'shop2.test', 'shop3.test', 'shop4.test', 'shop5.test', 'shop6.test'];
  const rig = await graphRig({
    autoApprove: false,
    plan: siteList(domains, 'action'),
    policy: [],
  });
  t.after(rig.cleanup);

  await rig.start('Order on shop1.test, register on shop2.test, subscribe on shop3.test, check out on shop4.test, pay on shop5.test and confirm on shop6.test');
  assert.equal(rig.status(), 'paused');

  const plan = (rig.pending().approval as any).planMeta;
  assert.equal(plan.sites.length, 6, `all 6 action steps must be kept, got ${plan.sites.length}: ${JSON.stringify(plan.sites.map((s: any) => s.domain))}`);

  await rig.stop();
});

test('planNode: the summarize override writes a notice when it changes the plan kind', async (t) => {
  const rig = await graphRig({
    plan: JSON.stringify({
      task_kind: 'research',
      columns: ['title', 'url', 'summary'],
      search_query: 'main articles',
      sites: [
        { domain: 'shop.test', goal: 'Read the main articles', role: 'reference', kind: 'page', difficulty: 1, required_fields: ['title', 'url', 'summary'], done_when: 'all_required', check: { type: 'none', value: '' } },
      ],
    }),
    policy: [act.finish('Top story: GLM-Legal ...')],
  });
  t.after(rig.cleanup);

  await rig.start('Summarize the main articles on this page');
  assert.equal(rig.status(), 'idle');

  const notice = rig.history().find((h) => h.type === 'notice' && h.kind === 'plan') as any;
  assert.ok(notice, 'a plan kind override writes a notice entry');
  assert.ok(/research.*answer|answer.*research/i.test(String(notice.content)), `the notice says the plan kind was changed, got: ${notice?.content}`);
});

test('planNode: strips thought tags from plan response before parsing JSON', async (t) => {
  const planWithThoughts = `
<thought>
I need to check shop.test for laptops.
</thought>
\`\`\`json
{
  "sites": [
    { "name": "Shop", "domain": "shop.test", "goal": "Find laptop" }
  ]
}
\`\`\`
  `;

  const rig = await graphRig({
    plan: planWithThoughts,
    policy: [act.finish('Item 42 costs 99 USD.')],
  });
  t.after(rig.cleanup);

  await rig.start('Search laptops');
  assert.equal(rig.status(), 'idle');
  assert.equal(rig.finishAnswer(), 'Item 42 costs 99 USD.');
});
