import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStepRecord,
  formatStepRecord,
  formatRecentSteps,
  formatOneShotContext,
  formatUserAnswers,
  formatPendingCorrection,
} from '../../src/background/agent/memory.ts';
import type { StepRecord } from '../../src/background/graph/workerState.ts';

test('memory: formatStepRecord uses line if present, else formats step and effect', () => {
  const custom: StepRecord = {
    step: 12,
    node: 'policy',
    url: 'https://shop.test',
    verb: 'click',
    line: '#12 click [88] "Alle Angebote" -> no visible change',
    outcome: 'no_effect',
    detail: 'no visible change',
  };
  assert.equal(formatStepRecord(custom), '#12 click [88] "Alle Angebote" -> no visible change');

  const fallback: StepRecord = {
    step: 5,
    node: 'policy',
    url: 'https://shop.test',
    verb: 'scroll',
    line: '',
    outcome: 'ok',
    detail: 'scrolled down',
  };
  assert.equal(formatStepRecord(fallback), '#5 scroll -> scrolled down');
});

test('memory: buildStepRecord generates accurate one-liners for page actions', () => {
  const clickRec = buildStepRecord({
    step: 12,
    node: 'policy',
    verb: 'click',
    elementId: 88,
    label: 'Alle Angebote',
    url: 'https://shop.test',
    effect: 'none',
    success: true,
  });
  assert.equal(clickRec.line, '#12 click [88] "Alle Angebote" -> no visible change');
  assert.equal(clickRec.outcome, 'no_effect');

  const navRec = buildStepRecord({
    step: 1,
    node: 'policy',
    verb: 'navigate',
    url: 'https://shop.test/catalog',
    effect: 'url_changed',
    success: true,
  });
  assert.equal(navRec.line, '#1 navigate "https://shop.test/catalog" -> URL changed');
  assert.equal(navRec.outcome, 'ok');

  const typeRec = buildStepRecord({
    step: 2,
    node: 'policy',
    verb: 'type',
    elementId: 10,
    label: 'Search',
    effect: 'value_set',
    success: true,
  });
  assert.equal(typeRec.line, '#2 type [10] "Search" -> value entered');

  const failRec = buildStepRecord({
    step: 3,
    node: 'policy',
    verb: 'click',
    elementId: 99,
    success: false,
    error: 'Element not interactable',
  });
  assert.ok(failRec.line.includes('#3 click [99] -> failed: Element not interactable'));
  assert.equal(failRec.outcome, 'failed');
});

test('memory: formatRecentSteps returns up to limit one-liners', () => {
  const records: StepRecord[] = [];
  for (let i = 1; i <= 8; i++) {
    records.push(
      buildStepRecord({
        step: i,
        node: 'policy',
        verb: 'click',
        elementId: i,
        effect: i % 2 === 0 ? 'dom_changed' : 'none',
        success: true,
      })
    );
  }

  const recent = formatRecentSteps(records, 5);
  assert.equal(recent.length, 5);
  assert.equal(recent[0], '#4 click [4] -> page updated');
  assert.equal(recent[4], '#8 click [8] -> page updated');

  assert.deepEqual(formatRecentSteps([]), []);
});

test('memory: formatOneShotContext formats tool output once', () => {
  const empty = formatOneShotContext(null);
  assert.equal(empty, null);

  const emptyText = formatOneShotContext({ label: 'Page Text', text: '', step: 1 });
  assert.equal(emptyText, null);

  const pageText = formatOneShotContext({
    label: 'Page Text',
    text: 'Full extracted text of the product specs.',
    step: 4,
  });
  assert.equal(pageText, '[Page Text]:\nFull extracted text of the product specs.');
});

test('memory: formatUserAnswers formats answer into expected prompt guidance', () => {
  const answers = ['The delivery zip code is 10115.'];
  const formatted = formatUserAnswers(answers);
  assert.equal(formatted.length, 1);
  assert.equal(
    formatted[0],
    'You asked a question and the user answered: "The delivery zip code is 10115.". Continue the task using this answer.'
  );

  const historyItems = [
    { type: 'user_answer' as const, content: 'Blue color preferred' },
  ];
  const fromHistory = formatUserAnswers(historyItems);
  assert.equal(fromHistory.length, 1);
  assert.equal(
    fromHistory[0],
    'You asked a question and the user answered: "Blue color preferred". Continue the task using this answer.'
  );
});

test('memory: formatPendingCorrection prefixes correction', () => {
  assert.equal(formatPendingCorrection(''), '');
  assert.equal(
    formatPendingCorrection('Element ID 999 is invalid.'),
    'CORRECTION: Element ID 999 is invalid.'
  );
});
