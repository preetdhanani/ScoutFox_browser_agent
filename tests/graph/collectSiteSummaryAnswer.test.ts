// tests/graph/collectSiteSummaryAnswer.test.ts
// The live failure: a collect site ended with a subgoal_done summary and nothing recorded, and the
// engine threw the summary away: no findings, no finalAnswer, and the card showed "(The model did
// not provide an answer.)" over a run the log called a success. The summary is now kept as the
// site's summaryReport, which compile shows when there is no real answer and no table, marked
// unconfirmed because no recorded finding backs it.
//
// The task here is an ACTION ask on purpose: "Search Google for <roundup noun>" is now planned as
// an answer site by the search-ask override (see planNode.test.ts), so that path has its own test.

import test from 'node:test';
import assert from 'node:assert/strict';
import { graphRig, act } from '../helpers/graphHarness.ts';
import { link } from '../helpers/fakeDom.ts';
import { NO_ANSWER_GIVEN } from '../../src/background/agent/outcome.ts';

const pages = [{
  url: 'https://shop.test/item',
  title: 'Framework Laptop 16 DIY Edition - Shop',
  text: ['Framework Laptop 16 DIY Edition', 'In stock'],
  elements: [link('Add to cart', 'https://shop.test/cart')],
}];

const openPlan = JSON.stringify({
  task_kind: 'action',
  columns: [],
  sites: [{
    domain: 'shop.test',
    goal: 'Open the Framework Laptop 16 listing',
    role: 'reference',
    kind: 'page',
    difficulty: 1,
    done_when: 'predicate',
    predicate: { type: 'url_contains', value: 'shop.test' },
  }],
});

const TASK = 'Open the Framework Laptop 16 listing on shop.test';
const SUMMARY = 'Opened the Framework Laptop 16 listing; the product page with the price is displayed.';

test('a collect site that ends with a summary and nothing recorded shows the summary, not the no-answer placeholder', async (t) => {
  const rig = await graphRig({ pages, startUrl: pages[0].url, plan: openPlan, policy: [act.subgoalDone(SUMMARY)] });
  t.after(rig.cleanup);
  await rig.start(TASK);

  assert.equal(rig.status(), 'idle');
  const answer = rig.finishAnswer() ?? '';
  assert.notEqual(answer, NO_ANSWER_GIVEN, 'the card must not say the model gave no answer');
  assert.ok(answer.includes('the product page with the price is displayed'), `the summary is the answer, got: ${answer}`);

  const finishEntries = rig.entries('finish') as Array<{ unconfirmed?: boolean; answer?: string }>;
  assert.equal(finishEntries.length, 1);
  assert.equal(finishEntries[0].unconfirmed, true, 'a collect-site summary has no recorded finding behind it');

  const ends = rig.entries('site_end') as Array<{ status: string }>;
  assert.equal(ends.length, 1);
  assert.equal(ends[0].status, 'done');
});
