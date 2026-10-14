/**
 * tests/agent/promptMemoryBlocks.test.ts
 *
 * The memory blocks of the policy user message (memory-blocks-not-rendered): EARLIER IN THIS
 * SESSION, FINDINGS FROM AN EARLIER TASK, DO NOT OPEN, VISITED and EARLIER SITES. The orchestrator
 * built them for every site, but buildPolicyUserMessage had no parameter for any of them, so a
 * follow-up like "now add it to the cart" reached the model with no referent and site 2 never
 * heard what site 1 found or which domains are blocked. One test per section, then the trim order
 * under the tier's character budget.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPolicyUserMessage,
  MEMORY_BUDGET,
  MEMORY_CAPS,
  type PolicyUserMessageParams,
} from '../../src/background/agent/prompts.ts';

function base(extra: Partial<PolicyUserMessageParams> = {}): PolicyUserMessageParams {
  return {
    task: 'now add it to the cart',
    siteIndex: 2,
    totalSites: 3,
    domain: 'idealo.de',
    role: 'compare',
    goal: 'Find the price of the Framework Laptop 16 on idealo.de',
    usedSteps: 1,
    allocSteps: 20,
    meterMode: 'normal',
    pageTitle: 'idealo',
    pageUrl: 'https://www.idealo.de/',
    pageType: 'other',
    scrollY: 0,
    pageText: 'Preisvergleich',
    elementsText: '[1] link "Suche"',
    ...extra,
  };
}

/** The text of one section: from its header to the next blank line. */
function section(msg: string, header: string): string | null {
  const at = msg.indexOf(`${header}`);
  if (at < 0) return null;
  const end = msg.indexOf('\n\n', at);
  return end < 0 ? msg.slice(at) : msg.slice(at, end);
}

const RECAP_OLD = '- Asked: "What does the Framework Laptop 13 cost?"\n  Result: The Framework Laptop 13 costs 999,00 EUR.';
const RECAP_NEW = '- Asked: "What does the Framework Laptop 16 cost?"\n  Result: The Framework Laptop 16 costs 1.399,00 EUR on shop.test.';

test('EARLIER IN THIS SESSION: the latest finished task (goal and result) is shown right after the task', () => {
  const msg = buildPolicyUserMessage(base({ recap: [RECAP_OLD, RECAP_NEW] }));
  const block = section(msg, 'EARLIER IN THIS SESSION');
  assert.ok(block, `the section exists:\n${msg}`);
  assert.match(block!, /What does the Framework Laptop 16 cost\?/);
  assert.match(block!, /1\.399,00 EUR on shop\.test/);
  assert.match(block!, /Framework Laptop 13/, 'an older finished task is shown too while the budget allows');
  assert.ok(msg.indexOf('EARLIER IN THIS SESSION') < msg.indexOf('CURRENT SITE'), 'the referent comes before the site');
});

test('EARLIER IN THIS SESSION: one very long recap entry is cut with a visible note', () => {
  const long = `- Asked: "${'x'.repeat(2000)}"\n  Result: ok`;
  const msg = buildPolicyUserMessage(base({ recap: [long] }));
  const block = section(msg, 'EARLIER IN THIS SESSION')!;
  assert.ok(block.length < MEMORY_CAPS.recapEntry + 200, `capped (${block.length})`);
  assert.match(block, /\[truncated, \d+ of \d+ chars\]/);
});

test('FINDINGS FROM AN EARLIER TASK: the prior-task findings are labelled as not this task\'s evidence', () => {
  const msg = buildPolicyUserMessage(base({
    priorFindings: ['[turn 1, shop.test] price: 1.399,00 EUR (https://shop.test/laptop)'],
  }));
  const block = section(msg, 'FINDINGS FROM AN EARLIER TASK');
  assert.ok(block, `the section exists:\n${msg}`);
  assert.match(block!, /not evidence for this task/i);
  assert.match(block!, /\[turn 1, shop\.test\] price: 1\.399,00 EUR \(https:\/\/shop\.test\/laptop\)/);
});

test('FINDINGS FROM AN EARLIER TASK: only the newest lines are kept, with a note of how many are left out', () => {
  const many = Array.from({ length: 30 }, (_, i) => `[turn 1, shop.test] price_${i}: ${i},00 EUR`);
  const msg = buildPolicyUserMessage(base({ priorFindings: many }));
  const block = section(msg, 'FINDINGS FROM AN EARLIER TASK')!;
  assert.match(block, /price_29: 29,00 EUR/, 'the newest is kept');
  assert.doesNotMatch(block, /price_0: /, 'the oldest is left out');
  assert.match(block, /older findings? not shown/);
});

test('DO NOT OPEN: every blocked domain with its URL', () => {
  const msg = buildPolicyUserMessage(base({
    blocked: [{ domain: 'geizhals.de', url: 'https://geizhals.de/?fs=laptop' }],
  }));
  const block = section(msg, 'DO NOT OPEN');
  assert.ok(block, `the section exists:\n${msg}`);
  assert.match(block!, /geizhals\.de \(https:\/\/geizhals\.de\/\?fs=laptop\)/);
});

test('VISITED: the last 10 pages, sorted by lastStep (newest last)', () => {
  const visited = Array.from({ length: 14 }, (_, i) => ({
    url: `https://shop.test/p${i}`, title: `Page ${i}`, verdict: 'ok' as const, lastStep: 100 - i,
  }));
  const msg = buildPolicyUserMessage(base({ visited }));
  const block = section(msg, 'VISITED');
  assert.ok(block, `the section exists:\n${msg}`);
  const urls = [...block!.matchAll(/https:\/\/shop\.test\/p(\d+)/g)].map((m) => Number(m[1]));
  assert.equal(urls.length, MEMORY_CAPS.visitedLines);
  // lastStep = 100 - i, so p13 is the oldest and p0 the newest; the 10 newest are p9..p0, in lastStep order.
  assert.deepEqual(urls, [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
});

test('EARLIER SITES: status plus the notes, cut to 120 characters with a note', () => {
  const msg = buildPolicyUserMessage(base({
    earlierSites: [{ head: 'frame.work (reference): done, 1 value saved in 4 steps', notes: `Price found on the product page. ${'n'.repeat(300)}` }],
  }));
  const block = section(msg, 'EARLIER SITES');
  assert.ok(block, `the section exists:\n${msg}`);
  assert.match(block!, /frame\.work \(reference\): done, 1 value saved in 4 steps - Price found/);
  assert.match(block!, /\[truncated, \d+ of \d+ chars\]/);
  const line = block!.split('\n')[1];
  assert.ok(line.length < 'frame.work (reference): done, 1 value saved in 4 steps'.length + MEMORY_CAPS.earlierSiteNote + 60, line);
});

test('no memory section is shown when there is nothing to show', () => {
  const msg = buildPolicyUserMessage(base());
  for (const header of ['EARLIER IN THIS SESSION', 'FINDINGS FROM AN EARLIER TASK', 'DO NOT OPEN', 'VISITED', 'EARLIER SITES']) {
    assert.equal(msg.includes(header), false, `${header} is left out when empty`);
  }
});

test('trim order under the small budget: EARLIER SITES notes go first, then older recap lines, then older prior findings; the rest is kept', () => {
  const recap = Array.from({ length: 4 }, (_, i) => `- Asked: "Task number ${i} ${'q'.repeat(150)}"\n  Result: ${'r'.repeat(280)}`);
  const earlierSites = Array.from({ length: 4 }, (_, i) => ({ head: `site${i}.test (compare): partial, 0 values saved in 9 steps`, notes: 'z'.repeat(200) }));
  const priorFindings = Array.from({ length: 12 }, (_, i) => `[turn 1, shop.test] field_${i}: ${'v'.repeat(100)}`);
  const visited = Array.from({ length: 10 }, (_, i) => ({ url: `https://shop.test/page/${i}`, title: `Page ${i}`, verdict: 'ok' as const, lastStep: i }));
  const blocked = [{ domain: 'geizhals.de', url: 'https://geizhals.de/' }];

  const msg = buildPolicyUserMessage(base({ recap, earlierSites, priorFindings, visited, blocked, memoryBudget: MEMORY_BUDGET.small }));

  // 1. EARLIER SITES lines are cut to their status part.
  const sites = section(msg, 'EARLIER SITES')!;
  assert.match(sites, /site3\.test \(compare\): partial, 0 values saved in 9 steps/);
  assert.doesNotMatch(sites, /zzz/, 'the notes were trimmed first');
  // 3. Older recap lines go; the most recent finished task is never trimmed.
  const recapBlock = section(msg, 'EARLIER IN THIS SESSION')!;
  assert.match(recapBlock, /Task number 3/, 'the latest finished task is kept');
  assert.doesNotMatch(recapBlock, /Task number 0/, 'the oldest finished task was trimmed');
  assert.match(recapBlock, /earlier tasks? not shown/);
  // Never trimmed: DO NOT OPEN and VISITED.
  assert.match(section(msg, 'DO NOT OPEN')!, /geizhals\.de/);
  assert.equal([...section(msg, 'VISITED')!.matchAll(/https:\/\/shop\.test\/page\//g)].length, 10);
  // The trimmable memory fits the budget.
  const memory = ['EARLIER IN THIS SESSION', 'FINDINGS FROM AN EARLIER TASK', 'EARLIER SITES']
    .map((h) => section(msg, h) ?? '').join('\n\n');
  assert.ok(memory.length <= MEMORY_BUDGET.small, `trimmable memory ${memory.length} <= ${MEMORY_BUDGET.small}`);
});

test('the large budget keeps what the small one trims', () => {
  const recap = [RECAP_OLD, RECAP_NEW];
  const earlierSites = [{ head: 'frame.work (reference): done, 1 value saved in 4 steps', notes: 'Price on the product page' }];
  const msg = buildPolicyUserMessage(base({ recap, earlierSites, memoryBudget: MEMORY_BUDGET.large }));
  assert.match(msg, /Framework Laptop 13/);
  assert.match(msg, /Price on the product page/);
});
