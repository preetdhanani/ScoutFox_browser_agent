/**
 * An answer site (a roundup or a summary: the result is a WRITTEN answer) has no required fields, so its criteria are
 * always met. Two replies used to end it "done" with nothing to show, and the card said
 * "(The model did not provide an answer.)":
 *   - `record_finding`, which the site never offers but the state-verb fast path accepted;
 *   - an empty `subgoal_done` / `finish`.
 * Both are now barren rounds with a correction that names the way to end THAT site in THAT mode.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { graphRig, act } from '../helpers/graphHarness.ts';
import { link } from '../helpers/fakeDom.ts';
import type { PageSpec } from '../helpers/fakeDom.ts';
import { NO_ANSWER_GIVEN } from '../../src/background/agent/outcome.ts';
import { isAnswerSite, recordFindingMisfit } from '../../src/background/graph/worker.ts';

const LIST = '1. debpalash / VoiceStudio - 61,949 stars\n2. acme / other-repo - 12,345 stars';
const PACKED = JSON.stringify({ action: 'record_finding', repository: 'debpalash / VoiceStudio; acme / other-repo', stars: '61,949; 12,345' });

const pages: PageSpec[] = [{
  url: 'https://github.test/trending/python',
  title: 'Trending Python repositories on GitHub today',
  text: ['debpalash / VoiceStudio', '61,949 stars', 'acme / other-repo', '12,345 stars', 'Trending repositories on GitHub today'],
  elements: [link('debpalash / VoiceStudio', 'https://github.test/debpalash/VoiceStudio')],
}];

/** The roundup plan of the live failure: research columns, one site, planned as an answer site by the override. */
const roundupPlan = JSON.stringify({
  task_kind: 'research',
  columns: ['repository', 'stars'],
  search_query: 'trending python repositories',
  sites: [{ domain: 'github.test', goal: 'Find the top trending Python repositories', role: 'reference', kind: 'page', difficulty: 1, required_fields: ['repository', 'stars'], done_when: 'all_required', check: { type: 'none', value: '' } }],
});

const TASK = 'Find top trending repositories on GitHub for python';

async function roundupRig(t: { after: (fn: () => void | Promise<void>) => void }, policy: string[]) {
  const rig = await graphRig({ pages, startUrl: pages[0].url, plan: roundupPlan, policy });
  t.after(rig.cleanup);
  return rig;
}

const userMessageOf = (rig: Awaited<ReturnType<typeof roundupRig>>, call: number): string => String((rig.llm.callsOf('policy')[call] as any)?.messages?.[0]?.content ?? '');

test('record_finding on an answer site is rejected with the way to end the site, and the next reply ends it with a real answer', async (t) => {
  const rig = await roundupRig(t, [PACKED, act.subgoalDone(LIST)]);
  await rig.start(TASK);

  assert.equal(rig.status(), 'idle');
  const answer = rig.finishAnswer() ?? '';
  assert.notEqual(answer, NO_ANSWER_GIVEN, 'the card must not say the model gave no answer');
  assert.ok(answer.includes('debpalash / VoiceStudio'), `the second reply is the answer, got: ${answer}`);

  const second = userMessageOf(rig, 1);
  assert.match(second, /"record_finding" is not available for this site/, 'the model was told why');
  assert.match(second, /subgoal_done/, 'and how to end a browse-mode answer site');
  assert.ok(!/Reply with a single JSON object containing an "action" key and nothing else/.test(second), 'the generic parser suffix is not added to the worker\'s own text');
  // The rejected reply is a row of the run with no action, like any rejected reply.
  const responses = rig.entries('agent_response') as Array<{ action: unknown }>;
  assert.equal(responses[0]?.action, null);
});

test('three record_finding replies close the site as failed, and the run does NOT stop as model_unusable', async (t) => {
  const rig = await roundupRig(t, [PACKED, PACKED, PACKED]);
  await rig.start(TASK);

  assert.equal(rig.status(), 'idle');
  const stoppedEarly = (rig.entries('error') as Array<{ content?: string }>).filter((e) => /Stopped early/.test(String(e.content)));
  assert.equal(stoppedEarly.length, 0, 'a valid reply for the wrong site is not "the model is unusable"');
  const ends = rig.entries('site_end') as Array<{ status: string; reason?: string }>;
  assert.equal(ends.length, 1);
  assert.equal(ends[0].status, 'failed');
  assert.match(String(ends[0].reason), /Too many consecutive rejected replies/);
});

test('an empty subgoal_done on an answer site is a barren round, not a silent "done"', async (t) => {
  const rig = await roundupRig(t, [act.subgoalDone('', ''), act.subgoalDone(LIST)]);
  await rig.start(TASK);

  assert.equal(rig.status(), 'idle');
  const answer = rig.finishAnswer() ?? '';
  assert.notEqual(answer, NO_ANSWER_GIVEN);
  assert.ok(answer.includes('acme / other-repo'), `the second reply is the answer, got: ${answer}`);
  assert.match(userMessageOf(rig, 1), /had no answer in it/);
  assert.equal(rig.llm.callsOf('policy').length, 2);
});

test('an empty finish on an answer site is a barren round too, and the correction names finish', async (t) => {
  const rig = await roundupRig(t, [JSON.stringify({ action: 'finish', answer: '' }), act.finish(LIST)]);
  await rig.start(TASK);

  assert.equal(rig.status(), 'idle');
  assert.ok((rig.finishAnswer() ?? '').includes('debpalash / VoiceStudio'));
  assert.match(userMessageOf(rig, 1), /"action":"finish"/);
});

test('three empty answers end the site as partial with a reason that says so (no loop, no empty "done")', async (t) => {
  const empty = act.subgoalDone('', '');
  const rig = await roundupRig(t, [empty, empty, empty]);
  await rig.start(TASK);

  const ends = rig.entries('site_end') as Array<{ status: string; reason?: string }>;
  assert.equal(ends[0]?.status, 'partial');
  assert.match(String(ends[0]?.reason), /No answer after 3 empty replies/);
  assert.equal(rig.llm.callsOf('policy').length, 3, 'exactly three rounds, then the site ends');
});

test('an answer site is told what its answer must cover as INCLUDE IN YOUR ANSWER, a collect site keeps NEEDED', async (t) => {
  const answerRig = await roundupRig(t, [act.subgoalDone(LIST)]);
  await answerRig.start(TASK);
  const answerMsg = userMessageOf(answerRig, 0);
  assert.match(answerMsg, /INCLUDE IN YOUR ANSWER: repository, stars/);
  assert.ok(!/NEEDED:/.test(answerMsg), 'no NEEDED line on an answer site: it nudged models to record_finding');

  const collectRig = await graphRig({ pages, startUrl: pages[0].url, plan: JSON.stringify({
    task_kind: 'research', columns: ['price'], search_query: 'x',
    sites: [{ domain: 'github.test', goal: 'Read the price', role: 'reference', kind: 'store', difficulty: 1, required_fields: ['price'], done_when: 'all_required', check: { type: 'none', value: '' } }],
  }), policy: [act.scroll()] });
  t.after(collectRig.cleanup);
  await collectRig.start('Read the price of the thing on this shop');
  assert.match(userMessageOf(collectRig, 0), /NEEDED: price/);
});

test('recordFindingMisfit: only record_finding, only for sites that do not collect, with the text of the mode', () => {
  assert.equal(recordFindingMisfit('record_finding', 'collect', 'browse'), null);
  assert.equal(recordFindingMisfit('finish', 'answer', 'browse'), null);
  assert.equal(recordFindingMisfit('scroll', 'answer', 'browse'), null);
  assert.match(String(recordFindingMisfit('record_finding', 'answer', 'answer')), /"action":"finish"/);
  assert.match(String(recordFindingMisfit('record_finding', 'answer', 'browse')), /"action":"subgoal_done"/);
  assert.match(String(recordFindingMisfit('record_finding', 'do', 'browse')), /action step/);
});

test('isAnswerSite: the goal kind, or an answer task', () => {
  const site = (goalKind: string, taskKind: string) => ({ taskKind, site: { goalKind } }) as any;
  assert.equal(isAnswerSite(site('answer', 'research')), true);
  assert.equal(isAnswerSite(site('collect', 'answer')), true);
  assert.equal(isAnswerSite(site('collect', 'research')), false);
  assert.equal(isAnswerSite(site('do', 'action')), false);
  assert.equal(isAnswerSite(null), false);
});

test('an answer written as {"answer": "..."} ends an answer site with the text, not with JSON', async (t) => {
  const rig = await roundupRig(t, [JSON.stringify({ answer: LIST })]);
  await rig.start(TASK);

  assert.equal(rig.status(), 'idle');
  assert.equal(rig.finishAnswer(), LIST, 'the answer is the text of the key, braces and quotes are gone');
});

test('empty {"answer": ...} replies are barren rounds too, and a summary of only zero-width characters counts as empty', async (t) => {
  const empty = JSON.stringify({ answer: '' });
  const rig = await roundupRig(t, [empty, empty, empty]);
  await rig.start(TASK);
  const ends = rig.entries('site_end') as Array<{ status: string; reason?: string }>;
  assert.equal(ends[0]?.status, 'partial');
  assert.match(String(ends[0]?.reason), /No answer after 3 empty replies/);

  const zero = await roundupRig(t, [act.subgoalDone('\u200b', '\u200b'), act.subgoalDone(LIST)]);
  await zero.start(TASK);
  assert.equal(zero.llm.callsOf('policy').length, 2, 'the invisible summary was not accepted as an answer');
  assert.ok((zero.finishAnswer() ?? '').includes('debpalash / VoiceStudio'));
});
