import test from 'node:test';
import assert from 'node:assert/strict';
import { compileNode } from '../../src/background/graph/orchestrator.ts';
import { NO_ANSWER_GIVEN, coerceAnswerText, buildFinishEntry, buildMaxStepsEntry } from '../../src/background/agent/outcome.ts';
import { registerMockRuntime } from '../helpers/mockRuntime.ts';

test('buildFinishEntry correctly flags unconfirmed prose and defaults empty answers', () => {
  const realFinish = buildFinishEntry({ action: 'finish', answer: 'The price is $120.' });
  assert.equal(realFinish.answer, 'The price is $120.');
  assert.equal(realFinish.unconfirmed, undefined);

  const emptyFinish = buildFinishEntry({ action: 'finish' });
  assert.equal(emptyFinish.answer, NO_ANSWER_GIVEN);
  assert.notEqual(emptyFinish.answer, 'Task completed successfully.');

  const proseFinish = buildFinishEntry({
    action: 'finish',
    answer: 'I found the item at 40 euros.',
    autoWrapped: true,
  });
  assert.equal(proseFinish.answer, 'I found the item at 40 euros.');
  assert.equal(proseFinish.unconfirmed, true);
});

test('buildMaxStepsEntry produces an honest error entry naming the step cap', () => {
  const entry = buildMaxStepsEntry(15);
  assert.equal(entry.type, 'error');
  assert.match(entry.content, /15/);
  assert.match(entry.content, /reached the maximum allowed steps/);

  const keptEntry = buildMaxStepsEntry(20, { answerKept: true });
  assert.equal(keptEntry.type, 'error');
  assert.match(keptEntry.content, /20/);
  assert.match(keptEntry.content, /answer was sent back/);
});

test('compileNode records error entry when hardCap is exceeded, never a fake finish', async (t) => {
  const threadId = 'test-compile-max-steps-outcome';
  registerMockRuntime(threadId, {}, t);
  const config = { configurable: { thread_id: threadId } };

  const state: any = {
    task: 'Find price',
    limits: { maxSteps: 5, maxSeconds: 60, maxSites: 3 },
    budget: { allocated: 5, used: 6, reserve: 0, sites: { s1: 6 } },
    sites: {
      s1: { id: 's1', domain: 'shop.test', status: 'running', alloc: 5, used: 6 },
    },
    siteOut: {
      siteId: 's1',
      status: 'partial',
      fatal: 'hard_cap',
      used: 6,
      findings: [],
      parseErrors: 0,
    },
  };

  const update = await compileNode(state, config);
  assert.equal(update.endReason, 'max_steps');

  const historyEntries = update.history as any[];
  const finishEntries = historyEntries?.filter((h) => h.type === 'finish');
  assert.equal(finishEntries?.length ?? 0, 0, 'Must never produce a finish entry when exceeding max steps');

  const errorEntry = historyEntries?.find((h) => h.type === 'error');
  assert.ok(errorEntry, 'Must produce an error entry on max steps exhaustion');
  assert.match(errorEntry.content, /5/);
  assert.match(errorEntry.content, /reached the maximum allowed steps/);
});

test('compileNode reports finish without an answer honestly using NO_ANSWER_GIVEN', async (t) => {
  const threadId = 'test-compile-no-answer-honesty';
  registerMockRuntime(threadId, {}, t);
  const config = { configurable: { thread_id: threadId } };

  const state: any = {
    task: 'Find price',
    limits: { maxSteps: 10, maxSeconds: 60, maxSites: 3 },
    budget: { allocated: 10, used: 2, reserve: 0, sites: { s1: 2 } },
    sites: {
      s1: { id: 's1', domain: 'shop.test', status: 'done', alloc: 10, used: 2 },
    },
    siteOut: {
      siteId: 's1',
      status: 'done',
      used: 2,
      findings: [],
      parseErrors: 0,
      finalAnswer: { text: '', unconfirmed: false },
    },
  };

  const update = await compileNode(state, config);
  assert.equal(update.endReason, 'all_subgoals_done');

  const historyEntries = update.history as any[];
  const finishEntry = historyEntries?.find((h) => h.type === 'finish');
  assert.ok(finishEntry);
  assert.notEqual(finishEntry.answer, 'Task completed successfully.');
  assert.equal(finishEntry.answer, NO_ANSWER_GIVEN);
  assert.equal(finishEntry.unconfirmed, undefined);
});

test('compileNode flags unconfirmed prose finishes correctly', async (t) => {
  const threadId = 'test-compile-unconfirmed-prose-honesty';
  registerMockRuntime(threadId, {}, t);
  const config = { configurable: { thread_id: threadId } };

  const state: any = {
    task: 'Find price',
    limits: { maxSteps: 10, maxSeconds: 60, maxSites: 3 },
    budget: { allocated: 10, used: 2, reserve: 0, sites: { s1: 2 } },
    sites: {
      s1: { id: 's1', domain: 'shop.test', status: 'done', alloc: 10, used: 2 },
    },
    siteOut: {
      siteId: 's1',
      status: 'done',
      used: 2,
      findings: [],
      parseErrors: 0,
      finalAnswer: { text: 'I found the laptop is 1200 USD.', unconfirmed: true },
    },
  };

  const update = await compileNode(state, config);
  assert.equal(update.endReason, 'all_subgoals_done');

  const historyEntries = update.history as any[];
  const finishEntry = historyEntries?.find((h) => h.type === 'finish');
  assert.ok(finishEntry);
  assert.equal(finishEntry.answer, 'I found the laptop is 1200 USD.');
  assert.equal(finishEntry.unconfirmed, true);
});

test('compileNode does not invent finish entry when model is unusable', async (t) => {
  const threadId = 'test-compile-model-unusable-honesty';
  registerMockRuntime(threadId, {}, t);
  const config = { configurable: { thread_id: threadId } };

  const state: any = {
    task: 'Find price',
    limits: { maxSteps: 10, maxSeconds: 60, maxSites: 3 },
    budget: { allocated: 10, used: 0, reserve: 0, sites: { s1: 0 } },
    sites: {
      s1: { id: 's1', domain: 'shop.test', status: 'failed', alloc: 10, used: 0 },
    },
    siteOut: {
      siteId: 's1',
      status: 'failed',
      fatal: 'model_unusable',
      used: 0,
      findings: [],
      parseErrors: 3,
    },
  };

  const update = await compileNode(state, config);
  assert.equal(update.endReason, 'model_unusable');

  const historyEntries = update.history as any[];
  const finishEntries = historyEntries?.filter((h) => h.type === 'finish');
  assert.equal(finishEntries?.length ?? 0, 0, 'Never invent a finish entry on model unusable');
});

test('coerceAnswerText converts arrays and objects into formatted strings safely', () => {
  const arrText = coerceAnswerText(['apple', 'banana']);
  assert.equal(arrText, 'apple\nbanana');

  const objText = coerceAnswerText({ price: 100 });
  assert.match(objText, /"price": 100/);

  const numText = coerceAnswerText(1299);
  assert.equal(numText, '1299');

  assert.equal(coerceAnswerText(null), '');
  assert.equal(coerceAnswerText(undefined), '');
});

test('buildFinishEntry converts non-string answer values or defaults to NO_ANSWER_GIVEN', () => {
  const numEntry = buildFinishEntry({ action: 'finish', answer: 1299 as any });
  assert.equal(numEntry.answer, '1299');

  const nullEntry = buildFinishEntry({ action: 'finish', answer: null as any });
  assert.equal(nullEntry.answer, NO_ANSWER_GIVEN);

  const emptyEntry = buildFinishEntry({ action: 'finish', answer: '' });
  assert.equal(emptyEntry.answer, NO_ANSWER_GIVEN);
});

test('buildMaxStepsEntry formats clean human-readable content without answerKept', () => {
  const entry = buildMaxStepsEntry(10);
  assert.equal(entry.type, 'error');
  assert.match(entry.content, /reached the maximum allowed steps \(10\)/);
  assert.doesNotMatch(entry.content, /answer was sent back/);
});

test('compileNode records partial_result when site status is partial', async (t) => {
  const threadId = 'test-compile-partial-status';
  registerMockRuntime(threadId, {}, t);
  const config = { configurable: { thread_id: threadId } };

  const state: any = {
    task: 'Collect catalog',
    limits: { maxSteps: 10, maxSeconds: 60, maxSites: 2 },
    budget: { allocated: 10, used: 4, reserve: 0, sites: { s1: 4 } },
    sites: {
      s1: { id: 's1', domain: 'shop.test', status: 'partial', alloc: 5, used: 4 },
    },
    siteOut: {
      siteId: 's1',
      status: 'partial',
      used: 4,
      findings: [{ id: 'f1', name: 'Item', value: '10' }],
      parseErrors: 0,
    },
  };

  const update = await compileNode(state, config);
  assert.equal(update.endReason, 'stopped_early');
  const partial = (update.history as any[])?.find((h) => h.type === 'partial_result');
  assert.ok(partial);
});

test('compileNode preserves audit verdict in finish history entry', async (t) => {
  const threadId = 'test-compile-audit-verdict';
  registerMockRuntime(threadId, {}, t);
  const config = { configurable: { thread_id: threadId } };

  const state: any = {
    task: 'Find price',
    limits: { maxSteps: 10, maxSeconds: 60, maxSites: 1 },
    budget: { allocated: 10, used: 2, reserve: 0, sites: { s1: 2 } },
    sites: {
      s1: { id: 's1', domain: 'shop.test', status: 'done', alloc: 10, used: 2 },
    },
    siteOut: {
      siteId: 's1',
      status: 'done',
      used: 2,
      findings: [],
      parseErrors: 0,
      finalAnswer: { text: 'Price is $100', unconfirmed: false, audit: { verdict: 'verified', lies: [], gaps: [] } },
    },
  };

  const update = await compileNode(state, config);
  const finish = (update.history as any[])?.find((h) => h.type === 'finish');
  assert.ok(finish);
  assert.equal(finish.audit?.verdict, 'verified');
});

test('compileNode records budget_exhausted when budget is fully depleted', async (t) => {
  const threadId = 'test-compile-budget-exhausted';
  registerMockRuntime(threadId, {}, t);
  const config = { configurable: { thread_id: threadId } };

  const state: any = {
    task: 'Find price',
    limits: { maxSteps: 10, maxSeconds: 60, maxSites: 2 },
    budget: { allocated: 10, used: 10, reserve: 0, sites: { s1: 10 } },
    sites: {
      s1: { id: 's1', domain: 'shop.test', status: 'running', alloc: 10, used: 10 },
    },
    siteOut: {
      siteId: 's1',
      status: 'partial',
      fatal: 'budget_exhausted',
      used: 10,
      findings: [],
      parseErrors: 0,
    },
  };

  const update = await compileNode(state, config);
  assert.equal(update.endReason, 'max_steps');
  const errEntry = (update.history as any[])?.find((h) => h.type === 'error');
  assert.ok(errEntry);
  assert.match(errEntry.content, /maximum allowed steps/);
});

test('compileNode handles user_stop endReason without inventing a finish card', async (t) => {
  const threadId = 'test-compile-user-stop-honesty';
  registerMockRuntime(threadId, {}, t);
  const config = { configurable: { thread_id: threadId } };

  const state: any = {
    task: 'Find price',
    limits: { maxSteps: 10, maxSeconds: 60, maxSites: 1 },
    budget: { allocated: 10, used: 1, reserve: 0, sites: { s1: 1 } },
    sites: {
      s1: { id: 's1', domain: 'shop.test', status: 'running', alloc: 10, used: 1 },
    },
    siteOut: {
      siteId: 's1',
      status: 'failed',
      fatal: 'stopped',
      used: 1,
      findings: [],
      parseErrors: 0,
    },
  };

  const update = await compileNode(state, config);
  assert.equal(update.endReason, 'stopped_early');
  const finishEntries = (update.history as any[])?.filter((h) => h.type === 'finish');
  assert.equal(finishEntries?.length ?? 0, 0);
});

test('compileNode aggregates multiple findings across sites accurately', async (t) => {
  const threadId = 'test-compile-multi-findings';
  registerMockRuntime(threadId, {}, t);
  const config = { configurable: { thread_id: threadId } };

  const state: any = {
    task: 'Find prices',
    limits: { maxSteps: 10, maxSeconds: 60, maxSites: 2 },
    budget: { allocated: 10, used: 3, reserve: 0, sites: { s1: 2, s2: 1 } },
    sites: {
      s1: { id: 's1', domain: 'shop-a.test', status: 'done', alloc: 5, used: 2 },
      s2: { id: 's2', domain: 'shop-b.test', status: 'done', alloc: 5, used: 1 },
    },
    siteOut: {
      siteId: 's2',
      status: 'done',
      used: 1,
      findings: [
        { id: 'f2', name: 'Price B', value: '50 EUR' },
      ],
      parseErrors: 0,
      finalAnswer: { text: 'Shop A has 40 EUR and Shop B has 50 EUR', unconfirmed: false },
    },
  };

  const update = await compileNode(state, config);
  assert.equal(update.endReason, 'all_subgoals_done');
  const finish = (update.history as any[])?.find((h) => h.type === 'finish');
  assert.ok(finish);
  assert.match(finish.answer, /Shop A has 40 EUR/);
});

test('buildFinishEntry preserves explicit non-empty answer without unconfirmed', () => {
  const explicit = buildFinishEntry({ action: 'finish', answer: 'Found 3 items.' });
  assert.equal(explicit.answer, 'Found 3 items.');
  assert.equal(explicit.unconfirmed, undefined);
  assert.equal(explicit.type, 'finish');
});

test('buildFinishEntry correctly handles boolean values through coercion', () => {
  const boolTrue = buildFinishEntry({ action: 'finish', answer: true as any });
  assert.equal(boolTrue.answer, 'true');

  const boolFalse = buildFinishEntry({ action: 'finish', answer: false as any });
  assert.equal(boolFalse.answer, 'false');
});

test('compileNode drops the no-answer placeholder when a filled findings table is the answer', async (t) => {
  // An extract-only run (the site ended done after record_finding, no finish action) used to show
  // "(The model did not provide an answer.)" above the very table that holds the data the user
  // asked for. The table is the answer; the placeholder only belongs when there is nothing.
  const threadId = 'test-compile-table-no-placeholder';
  registerMockRuntime(threadId, {}, t);
  const config = { configurable: { thread_id: threadId } };

  const finding = {
    id: 'f1',
    siteId: 's1',
    field: 'price',
    valueRaw: '1.399,00 EUR',
    value: '1.399,00 EUR',
    url: 'https://shop.test/item',
    capturedAt: '2026-10-13T12:00:00.000Z',
    step: 1,
    docId: 'doc-1',
    evidence: { snippet: 'ab 1.399,00 EUR inkl. MwSt.', source: 'text' as const },
    checks: ['value_on_page'],
    quality: 'verified' as const,
  };

  const state: any = {
    task: 'What is the price of the Framework Laptop 16?',
    limits: { maxSteps: 10, maxSeconds: 60, maxSites: 3 },
    budget: { allocated: 10, used: 1, reserve: 0, sites: { s1: 1 } },
    planMeta: {
      columns: ['price'],
      sites: [{ id: 's1', name: 'Framework Store', domain: 'shop.test', goal: 'Read the price', role: 'reference', kind: 'store', startUrl: 'https://shop.test/item', fields: ['price'], criteria: { fields: [{ name: 'price', required: true }], doneWhen: 'all_required' } }],
    },
    sites: {
      s1: { id: 's1', domain: 'shop.test', status: 'done', alloc: 10, used: 1 },
    },
    findings: [finding],
    siteOut: {
      siteId: 's1',
      status: 'done',
      used: 1,
      findings: [finding],
      parseErrors: 0,
    },
  };

  const update = await compileNode(state, config);
  assert.equal(update.endReason, 'all_subgoals_done');
  const finishEntry = (update.history as any[])?.find((h) => h.type === 'finish');
  assert.ok(finishEntry);
  assert.ok(!String(finishEntry.answer).includes('did not provide an answer'), `the placeholder must go when the table exists: ${finishEntry.answer}`);
  assert.match(finishEntry.answer, /1\.399,00 EUR/);
  assert.ok(finishEntry.table, 'the structured table stays on the entry');
});

// partial-runs-render-as-done: a step-cap run with findings used to write only the table as the
// partial_result answer, so the card never said why the run ended (the reason sat in a collapsed
// error row). The step-cap sentence now comes first, above the table.
const capFinding = {
  id: 'f1',
  siteId: 's1',
  field: 'price',
  valueRaw: '1.399,00 EUR',
  value: '1.399,00 EUR',
  url: 'https://shop.test/item',
  capturedAt: '2026-10-14T12:00:00.000Z',
  step: 1,
  docId: 'doc-1',
  evidence: { snippet: 'ab 1.399,00 EUR inkl. MwSt.', source: 'text' as const },
  checks: ['value_on_page'],
  quality: 'verified' as const,
};

function capState(extra: Record<string, unknown> = {}): any {
  return {
    task: 'What is the price of the Framework Laptop 16?',
    limits: { maxSteps: 5, maxSeconds: 60, maxSites: 3 },
    budget: { allocated: 5, used: 6, reserve: 0, sites: { s1: 6 } },
    planMeta: {
      columns: ['price'],
      sites: [{ id: 's1', name: 'Shop', domain: 'shop.test', goal: 'Read the price', role: 'reference', kind: 'store', startUrl: 'https://shop.test/item', fields: ['price'], criteria: { fields: [{ name: 'price', required: true }], doneWhen: 'all_required' } }],
    },
    sites: { s1: { id: 's1', domain: 'shop.test', status: 'running', alloc: 5, used: 6 } },
    ...extra,
  };
}

test('compileNode: a step-cap partial_result with findings says the step-cap reason above the table', async (t) => {
  const threadId = 'test-compile-step-cap-reason-first';
  registerMockRuntime(threadId, {}, t);
  const state = capState({
    findings: [capFinding],
    siteOut: { siteId: 's1', status: 'partial', fatal: 'hard_cap', used: 6, findings: [capFinding], parseErrors: 0 },
  });

  const update = await compileNode(state, { configurable: { thread_id: threadId } });
  assert.equal(update.endReason, 'max_steps');
  const partial = (update.history as any[]).find((h) => h.type === 'partial_result');
  assert.ok(partial, 'a partial_result is written');
  assert.equal(partial.reason, 'max_steps');
  const reason = buildMaxStepsEntry(5).content;
  assert.ok(String(partial.answer).startsWith(reason), `the step-cap reason comes first, got: ${partial.answer}`);
  assert.match(partial.answer, /1\.399,00 EUR/, 'the table is still there');
  assert.ok(partial.answer.indexOf(reason) < partial.answer.indexOf('|'), 'the reason is above the table');
});

test('compileNode: a step-cap partial_result from a summary report says the step-cap reason first', async (t) => {
  const threadId = 'test-compile-step-cap-summary-reason';
  registerMockRuntime(threadId, {}, t);
  const state = capState({
    findings: [],
    siteOut: { siteId: 's1', status: 'partial', fatal: 'hard_cap', used: 6, findings: [], parseErrors: 0, summaryReport: 'Opened the listing page.' },
  });

  const update = await compileNode(state, { configurable: { thread_id: threadId } });
  const partial = (update.history as any[]).find((h) => h.type === 'partial_result');
  assert.ok(partial);
  assert.equal(partial.answer, `${buildMaxStepsEntry(5).content}\n\nOpened the listing page.`);
});
