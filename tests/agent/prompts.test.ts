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
