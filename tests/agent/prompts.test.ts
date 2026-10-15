import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPlanSystemPrompt,
  buildPlanUserMessage,
  buildPolicySystemPrompt,
  buildPolicyUserMessage
} from '../../src/background/agent/prompts.ts';

test('prompts: buildPlanSystemPrompt produces valid initial and revise instructions', () => {
  const initial = buildPlanSystemPrompt('initial');
  assert.ok(initial.includes('task_kind'));
  assert.ok(initial.includes('columns'));
  assert.ok(initial.includes('sites'));

  const revise = buildPlanSystemPrompt('revise');
  assert.ok(revise.includes('drop'));
  assert.ok(revise.includes('add'));
  assert.ok(revise.includes('order'));
});

test('prompts: buildPlanUserMessage includes task and tab info', () => {
  const msg = buildPlanUserMessage({
    task: 'Compare laptop prices',
    tabTitle: 'Google',
    tabUrl: 'https://google.com'
  });
  assert.ok(msg.includes('Task: Compare laptop prices'));
  assert.ok(msg.includes('Current tab: Google (https://google.com)'));
});

test('prompts: buildPolicySystemPrompt covers all modes', () => {
  const extract = buildPolicySystemPrompt('extract', 'small', ['price', 'shipping']);
  assert.ok(extract.includes('record_finding {price, shipping}'));
  assert.ok(extract.includes('continue_browsing'));

  const harvest = buildPolicySystemPrompt('harvest', 'small', ['price']);
  assert.ok(harvest.includes('step budget for this site is almost used up'));
  assert.ok(harvest.includes('record_finding {price}'));

  const answer = buildPolicySystemPrompt('answer', 'small');
  assert.ok(answer.includes('finish {answer}'));

  const browse = buildPolicySystemPrompt('browse', 'small', ['price'], true, 'collect');
  assert.ok(browse.includes('click {element_id}'));
  assert.ok(browse.includes('record_finding'));
});

test('prompts: buildPolicyUserMessage shows the TABS line with owner and working tab', () => {
  const base = {
    task: 'Find Framework price',
    siteIndex: 1,
    totalSites: 1,
    domain: 'frame.work',
    role: 'reference',
    goal: 'Find price of laptop',
    usedSteps: 1,
    allocSteps: 10,
    meterMode: 'normal' as const,
    pageTitle: 'Framework Shop',
    pageUrl: 'https://frame.work',
    pageType: 'product',
    scrollY: 0,
    pageText: 'Framework Laptop 16 ab 1.599 EUR',
    elementsText: '[1] button "Buy"'
  };
  const split = buildPolicyUserMessage({ ...base, tabsLine: 'TABS: owner tab 101, working tab 700' });
  assert.ok(split.includes('TABS: owner tab 101, working tab 700'), 'the step message names the owner and the working tab');
  // The line sits before the page blocks, so the mock and the models read it as its own block.
  assert.ok(split.indexOf('TABS:') < split.indexOf('CURRENT PAGE:'));

  const same = buildPolicyUserMessage({ ...base, tabsLine: 'TABS: owner tab 101 (also the working tab)' });
  assert.ok(same.includes('TABS: owner tab 101 (also the working tab)'));

  const none = buildPolicyUserMessage(base);
  assert.ok(!none.includes('TABS:'), 'without tab facts the line stays out');
});

test('prompts: buildPolicyUserMessage injects budget and failure memory', () => {
  const msg = buildPolicyUserMessage({
    task: 'Find Framework price',
    siteIndex: 1,
    totalSites: 2,
    domain: 'frame.work',
    role: 'reference',
    goal: 'Find price of laptop',
    columns: ['price'],
    usedSteps: 15,
    allocSteps: 20,
    meterMode: 'warn',
    findingsLines: ['- frame.work: pending'],
    failures: [
      { step: 1, action: { verb: 'click', elementId: 12, label: '[12]' }, url: 'https://frame.work', kind: 'covered', detail: 'Cookie banner', count: 2 }
    ],
    bannedSignatures: ['click|12|'],
    pageTitle: 'Framework Shop',
    pageUrl: 'https://frame.work',
    pageType: 'product',
    scrollY: 100,
    pageText: 'Framework Laptop 16 ab 1.599 EUR',
    elementsText: '[1] button "Buy"'
  });

  assert.ok(msg.includes('TASK: Find Framework price'));
  assert.ok(msg.includes('BUDGET: 15 of 20 steps used on this site. Save what you find soon.'));
  assert.ok(msg.includes('ALREADY TRIED AND FAILED ON THIS SITE:'));
  assert.ok(msg.includes('(x2, blocked by ScoutFox)'));
  assert.ok(msg.includes('CURRENT PAGE: "Framework Shop" - https://frame.work (product)'));
});

test('prompts: buildPolicySystemPrompt uses wait {amount} and press_key keys without Space', () => {
  const prompt = buildPolicySystemPrompt('browse', 'small', ['price'], true, 'collect');
  assert.ok(prompt.includes('wait {amount} - 1 to 5, only while the page is still loading'));
  assert.ok(!prompt.includes('wait {seconds}'));
  assert.ok(prompt.includes('press_key {key} - Enter, Escape, Tab, ArrowDown, ArrowUp, ArrowLeft, ArrowRight, PageDown, PageUp, Home, End, Backspace, Delete'));
  assert.ok(!prompt.includes('Backspace, Space'));
});

test('prompts: buildPolicySystemPrompt includes large tier actions when tier is large', () => {
  // execute_js is opt-in (safety/confirm-card-blind-approval), so this asks for it.
  const prompt = buildPolicySystemPrompt('browse', 'large', ['price'], true, 'collect', { allowExecuteJs: true });
  assert.ok(prompt.includes('execute_js {code}'));
  assert.ok(prompt.includes('read_network_requests {filter, includeBody, limit}'));
  assert.ok(prompt.includes('browser_batch {steps, stopOnError}'));
  assert.ok(prompt.includes('open_window {url}'));
});

test('prompts: the large tier prompt leaves out execute_js unless the setting allows it', () => {
  const prompt = buildPolicySystemPrompt('browse', 'large', ['price'], true, 'collect');
  assert.ok(!prompt.includes('execute_js'));
  assert.ok(prompt.includes('browser_batch {steps, stopOnError}'));
  assert.ok(prompt.includes('read_network_requests'));
  // The setting cannot give a small model a large tier verb.
  assert.ok(!buildPolicySystemPrompt('browse', 'small', ['price'], true, 'collect', { allowExecuteJs: true }).includes('execute_js'));
});

test('prompts: buildPolicySystemPrompt excludes large tier actions when tier is small', () => {
  const prompt = buildPolicySystemPrompt('browse', 'small', ['price'], true, 'collect');
  assert.ok(!prompt.includes('execute_js'));
  assert.ok(!prompt.includes('browser_batch'));
  assert.ok(!prompt.includes('open_window'));
});

test('prompts: buildPolicySystemPrompt uses subgoal_done for non-collect goalKind', () => {
  const prompt = buildPolicySystemPrompt('browse', 'small', [], false, 'do');
  assert.ok(prompt.includes('subgoal_done {summary, evidence}'));
  assert.ok(!prompt.includes('record_finding'));
});

test('prompts: buildPolicySystemPrompt uses subgoal_done for an answer site in browse mode', () => {
  const prompt = buildPolicySystemPrompt('browse', 'small', [], false, 'answer');
  assert.ok(prompt.includes('subgoal_done {summary, evidence}'), 'an answer site browsing first ends with subgoal_done');
  assert.ok(!prompt.includes('record_finding'));
});

test('prompts: buildPlanUserMessage renders earlier session goal and answer when present', () => {
  const msg = buildPlanUserMessage({
    task: 'Find the lowest price',
    tabTitle: 'Shop',
    tabUrl: 'https://shop.test',
    earlierSessionGoal: 'Look up item 42',
    earlierSessionAnswer: 'Item 42 was 99 USD',
  });
  assert.ok(msg.includes('Earlier in this session:'));
  assert.ok(msg.includes('- Asked: "Look up item 42"'));
  assert.ok(msg.includes('Result: Item 42 was 99 USD'));
});

test('prompts: buildPlanUserMessage works when tabTitle and tabUrl are absent', () => {
  const msg = buildPlanUserMessage({ task: 'Inspect widgets' });
  assert.equal(msg, 'Task: Inspect widgets');
});

test('prompts: buildPolicyUserMessage renders harvest budget when meterMode is harvest', () => {
  const msg = buildPolicyUserMessage({
    task: 'Harvest details',
    siteIndex: 1,
    totalSites: 1,
    domain: 'store.test',
    role: 'primary',
    goal: 'Extract phone number',
    usedSteps: 9,
    allocSteps: 10,
    meterMode: 'harvest',
    pageTitle: 'Contact',
    pageUrl: 'https://store.test/contact',
    pageType: 'page',
    scrollY: 0,
    pageText: 'Phone: 555-1234',
    elementsText: '[1] text "555-1234"',
  });
  assert.ok(msg.includes('BUDGET: Only 1 steps left on this site: save what this page shows now.'));
});

test('prompts: buildPolicyUserMessage includes price candidates formatted with currency and value', () => {
  const msg = buildPolicyUserMessage({
    task: 'Check price',
    siteIndex: 1,
    totalSites: 1,
    domain: 'shop.test',
    role: 'primary',
    goal: 'Find price',
    usedSteps: 1,
    allocSteps: 10,
    meterMode: 'normal',
    pageTitle: 'Item',
    pageUrl: 'https://shop.test/item',
    pageType: 'product',
    scrollY: 0,
    pageText: 'Item 42',
    elementsText: '',
    priceCandidates: [
      { id: '[1]', text: '$99.00', value: 99, currency: '$', context: 'Main offer' },
      'stringCandidate',
    ],
  });
  assert.ok(msg.includes('PRICE CANDIDATES:'));
  assert.ok(msg.includes('[1] $99.00 ($99) - "Main offer"'));
  assert.ok(msg.includes('stringCandidate'));
});

test('prompts: buildPolicyUserMessage includes correction when provided', () => {
  const msg = buildPolicyUserMessage({
    task: 'Find item',
    siteIndex: 1,
    totalSites: 1,
    domain: 'shop.test',
    role: 'primary',
    goal: 'Find item',
    usedSteps: 2,
    allocSteps: 10,
    meterMode: 'normal',
    pageTitle: 'Shop',
    pageUrl: 'https://shop.test',
    pageType: 'listing',
    scrollY: 0,
    pageText: '',
    elementsText: '',
    correction: 'Element 4 is not clickable, choose element 5 instead.',
  });
  assert.ok(msg.includes('CORRECTION: Element 4 is not clickable, choose element 5 instead.'));
});

test('prompts: buildPolicyUserMessage includes userAnswers and oneShotContext when provided', () => {
  const msg = buildPolicyUserMessage({
    task: 'Book ticket',
    siteIndex: 1,
    totalSites: 1,
    domain: 'book.test',
    role: 'primary',
    goal: 'Select date',
    usedSteps: 3,
    allocSteps: 10,
    meterMode: 'normal',
    pageTitle: 'Booking',
    pageUrl: 'https://book.test',
    pageType: 'listing',
    scrollY: 0,
    pageText: '',
    elementsText: '',
    userAnswers: ['I prefer aisle seat', 'Flight at 10 AM'],
    oneShotContext: 'ONESHOT: Here is an example interaction.',
  });
  assert.ok(msg.includes('You asked a question and the user answered: "I prefer aisle seat".'));
  assert.ok(msg.includes('You asked a question and the user answered: "Flight at 10 AM".'));
  assert.ok(msg.includes('ONESHOT: Here is an example interaction.'));
});

test('prompts: buildPolicyUserMessage shows the recent steps the caller passes (the tier window caps upstream)', () => {
  const recent = ['step 1', 'step 2', 'step 3', 'step 4', 'step 5', 'step 6', 'step 7'];
  const msg = buildPolicyUserMessage({
    task: 'Walkthrough',
    siteIndex: 1,
    totalSites: 1,
    domain: 'test.com',
    role: 'primary',
    goal: 'Walkthrough',
    usedSteps: 7,
    allocSteps: 20,
    meterMode: 'normal',
    pageTitle: 'Test',
    pageUrl: 'https://test.com',
    pageType: 'listing',
    scrollY: 0,
    pageText: '',
    elementsText: '',
    recentSteps: recent,
  });
  assert.ok(msg.includes('RECENT STEPS:'));
  // The tier window (RECENT_STEPS_WINDOW) caps the lines in the worker, so the prompt shows
  // every line the caller formatted instead of a second hard cut at 5.
  assert.ok(msg.includes('step 1'));
  assert.ok(msg.includes('step 7'));
});


// silent-truncation-no-marker: the PAGE TEXT block re-sliced the text to 3000 characters, so a 3000-4500 text was
// cut with no marker at all, and the content script's own marker after 4500 was sliced off. The model then took
// the head of a long page for the whole page.
function pageTextMessage(pageText: string, pageTextBudget?: number): string {
  return buildPolicyUserMessage({
    task: 't', siteIndex: 1, totalSites: 1, domain: 'shop.test', role: 'reference', goal: 'g',
    usedSteps: 0, allocSteps: 10, meterMode: 'normal',
    pageTitle: 'P', pageUrl: 'https://shop.test', pageType: 'other', scrollY: 0,
    pageText, elementsText: '', ...(pageTextBudget ? { pageTextBudget } : {}),
  });
}
const pageBlock = (msg: string) => msg.split('PAGE TEXT:\n"""\n')[1].split('\n"""')[0];
const pageLines = (n: number) => Array.from({ length: n }, (_, i) => `Row ${i + 1}: some product text here`).join('\n');

test('prompts: a 4000-character page text that does not fit the budget ends with a truncation note', () => {
  const text = pageLines(200).slice(0, 4000);
  assert.equal(text.length, 4000);
  const block = pageBlock(pageTextMessage(text));
  assert.match(block, /\[page text truncated: showing \d+ of 4000 characters - [^\]]*read_page_text[^\]]*\]$/);
});

test('prompts: a 9000-character page text, already cut by the content script, keeps a note with the full size', async () => {
  const { capPageText } = await import('../../src/content/pageText.ts');
  const full = pageLines(400).slice(0, 9000);
  const block = pageBlock(pageTextMessage(capPageText(full)));
  assert.match(block, /\[page text truncated: showing \d+ of 9000 characters - [^\]]*\]$/);
  assert.equal(block.match(/truncated/g)?.length, 1);
});

test('prompts: the page-text budget is a parameter, and a text within it is shown whole with no note', () => {
  const text = pageLines(200).slice(0, 4000);
  const block = pageBlock(pageTextMessage(text, 4500));
  assert.equal(block, text);
});
