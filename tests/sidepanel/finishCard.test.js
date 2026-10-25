/**
 * The card of a finished run: renderFinishCard in sidepanel/sidepanel.js.
 *
 * The card is the last thing a user reads. It says "Done" with a green tick when the task went
 * through, and it must not say that when the task did not. A run whose click never reached the
 * page can end with an honest answer ("the click failed: ..."), and the answer being honest does
 * not make the run a success: the card is a red one, because the task did not go through.
 *
 * Before this, the only thing that made the card a failure was a "MOCK-FAIL:" prefix in the
 * answer, which is a marker of the mock LLM. A real run whose step failed still showed a green
 * "Done", so the panel told the user the opposite of what the engine had just recorded.
 *
 * What these tests hold on to:
 *   1. A turn with a failed step shows "Failed", never "Done", and never the green tick icon.
 *   2. A turn with only successful steps still shows the green "Done" card, unchanged.
 *   3. The same holds for a card with an audit: a verified answer is a claim about the answer, not
 *      about the run, so a failed step still wins over "Done".
 *   4. A run that ended before it finished (partial_result) is still a partial card, never a
 *      failed one, even when a step of it failed.
 *   5. buildTurns marks a turn as failed when an execution_result says the step failed.
 *   6. The stylesheet has a rule for the failed card, so it really is red and not just a word.
 *
 * How it runs: sidepanel.js is a browser module that touches window and document once at load,
 * so a small stub is enough to import it and call the pure string builders. No DOM is built.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

globalThis.window = { addEventListener() {} };
globalThis.document = { readyState: 'loading', addEventListener() {}, getElementById: () => null };

const { buildTurns, renderFinishCard } = await import('../../sidepanel/sidepanel.js');

const CSS = fs.readFileSync(new URL('../../sidepanel/sidepanel.css', import.meta.url), 'utf8');

/** The green tick of a Done card. Its absence is what tells the two cards apart in the markup. */
const GREEN_TICK = 'M8.5 12.5l2.3 2.3L16 10';
/** The warning triangle of a Failed card. */
const WARNING_TRIANGLE = 'M12 3L2 20h20L12 3z';

// ---------------------------------------------------------------------------------------------
// The history a run leaves behind
// ---------------------------------------------------------------------------------------------

/**
 * The rows of a run: a goal, the steps, and the answer.
 * @param {{steps: Array<{action: string, success: boolean, error?: string}>, answer: string, audit?: object|null}} spec
 */
function historyOf({ steps, answer, audit = null }) {
  const rows = [{ type: 'user_goal', turn: 1, prompt: 'Click the button', isNewRun: true }];
  steps.forEach((step, i) => {
    rows.push({
      type: 'agent_response',
      step: i + 1,
      thought: '',
      action: { action: step.action, element_id: 1 },
      rawResponse: '{}'
    });
    rows.push(
      step.success
        ? { type: 'execution_result', step: i + 1, success: true, message: 'ok' }
        : { type: 'execution_result', step: i + 1, success: false, error: step.error || 'Element [1] no longer resolvable in DOM.' }
    );
  });
  rows.push(audit ? { type: 'finish', answer, audit } : { type: 'finish', answer });
  return rows;
}

/** The card of a run, from the rows it left behind. */
function cardOf(spec) {
  const turns = buildTurns(historyOf(spec));
  return renderFinishCard(turns[turns.length - 1]);
}

// ---------------------------------------------------------------------------------------------
// 1. A failed step is a failed run
// ---------------------------------------------------------------------------------------------

test('a run whose click never reached the page shows Failed, not Done', () => {
  const card = cardOf({
    steps: [{ action: 'get_page_elements', success: true }, { action: 'click', success: false }],
    answer: 'The click failed: Error: Element [999] is no longer attached to the document.'
  });

  assert.match(card, /class="finish-card failed"/, 'the card is a failed card');
  assert.match(card, /> Failed</, 'the title says Failed');
  assert.doesNotMatch(card, /Done/, 'and it does not say Done anywhere');
  assert.ok(!card.includes(GREEN_TICK), 'the green tick of a Done card is not in it');
  assert.ok(card.includes(WARNING_TRIANGLE), 'the warning triangle is in it');
});

test('the answer of a failed run is still shown', () => {
  const card = cardOf({
    steps: [{ action: 'click', success: false }],
    answer: 'The click failed: Error: Element [999] is no longer attached to the document.'
  });

  assert.match(card, /The click failed: Error: Element \[999\] is no longer attached to the document\./);
});

// ---------------------------------------------------------------------------------------------
// 2. A clean run is unchanged
// ---------------------------------------------------------------------------------------------

test('a run whose steps all went through still shows the green Done card', () => {
  const card = cardOf({
    steps: [{ action: 'get_page_elements', success: true }, { action: 'click', success: true }],
    answer: 'The price is 1.399,00 EUR.'
  });

  assert.match(card, /class="finish-card"/, 'the card is a plain finish card');
  assert.doesNotMatch(card, /finish-card failed/, 'and not a failed one');
  assert.match(card, /> Done</, 'the title says Done');
  assert.ok(card.includes(GREEN_TICK), 'with the green tick');
});

test('the failed answer marker still makes the card a failed one', () => {
  // The mock marker, which was the only failure signal before. It must keep working.
  const card = cardOf({
    steps: [{ action: 'click', success: true }],
    answer: 'MOCK-FAIL: the page said no.'
  });

  assert.match(card, /class="finish-card failed"/);
  assert.match(card, /> Failed</);
});

// ---------------------------------------------------------------------------------------------
// 3. With an audit
// ---------------------------------------------------------------------------------------------

const VERIFIED_AUDIT = {
  verdict: 'verified',
  opened: [{ host: 'shop.test', url: 'https://shop.test/item' }],
  notOpened: [],
  notes: [],
  sendBacks: 0
};

test('a verified answer with a failed step is still a failed card', () => {
  // The audit says the answer is backed by what the model read. That is a claim about the answer,
  // not about the run: the run failed, so the card says so.
  const card = cardOf({
    steps: [{ action: 'click', success: false }],
    answer: 'The price is 1.399,00 EUR.',
    audit: VERIFIED_AUDIT
  });

  assert.match(card, /class="finish-card failed"/);
  assert.match(card, /> Failed</);
  assert.doesNotMatch(card, /> Done</);
});

test('a verified answer with only successful steps is still a Done card', () => {
  const card = cardOf({
    steps: [{ action: 'click', success: true }],
    answer: 'The price is 1.399,00 EUR.',
    audit: VERIFIED_AUDIT
  });

  assert.doesNotMatch(card, /finish-card failed/);
  assert.match(card, /> Done</);
});

// ---------------------------------------------------------------------------------------------
// 4. A partial run is a partial run
// ---------------------------------------------------------------------------------------------

test('a run that ended before it finished stays a partial card, even when a step failed', () => {
  const rows = historyOf({
    steps: [{ action: 'click', success: false }],
    answer: 'Task was stopped by user.'
  });
  rows[rows.length - 1] = { type: 'partial_result', answer: 'Task was stopped by user.', reason: 'stopped' };

  const turns = buildTurns(rows);
  const card = renderFinishCard(turns[turns.length - 1]);

  assert.match(card, /finish-card partial/, 'the card is a partial card');
  assert.doesNotMatch(card, /finish-card failed/, 'and not a failed one');
  assert.doesNotMatch(card, /> Done</);
});

// ---------------------------------------------------------------------------------------------
// 5. buildTurns marks the failure
// ---------------------------------------------------------------------------------------------

test('buildTurns marks a turn as failed when a step failed, and not otherwise', () => {
  const failed = buildTurns(historyOf({
    steps: [{ action: 'click', success: false }],
    answer: 'It failed.'
  }));
  assert.equal(failed[0].failed, true);

  const clean = buildTurns(historyOf({
    steps: [{ action: 'click', success: true }],
    answer: 'It worked.'
  }));
  assert.equal(clean[0].failed, false);
});

test('an error entry also marks the turn as failed', () => {
  const rows = historyOf({ steps: [{ action: 'click', success: true }], answer: 'It worked.' });
  rows.splice(2, 0, { type: 'error', content: 'the model request failed' });

  const turns = buildTurns(rows);
  assert.equal(turns[0].failed, true);
});

// ---------------------------------------------------------------------------------------------
// 6. The card really is red
// ---------------------------------------------------------------------------------------------

test('the stylesheet has a rule for the failed card', () => {
  assert.ok(CSS.includes('.finish-card.failed'), '.finish-card.failed has no rule');
  assert.match(
    CSS,
    /\.finish-card\.failed\s*\{[^}]*border-left-color:\s*var\(--danger\)/,
    'the failed card does not get the danger edge'
  );
  assert.match(
    CSS,
    /\.finish-card\.failed \.finish-title svg\s*\{[^}]*color:\s*var\(--danger\)/,
    'the icon of the failed card is not in the danger colour'
  );
});

// ---------------------------------------------------------------------------------------------
// 7. An answer that is a JSON object is read as prose
// ---------------------------------------------------------------------------------------------

test('an answer that is a JSON object shows the sentence inside it, not the JSON', () => {
  // The engine pulls the readable part out before it stores the answer, but a session saved by
  // an older build still holds the raw JSON. The card has to cope with it on its own.
  const card = cardOf({
    steps: [{ action: 'read_page_text', success: true }],
    answer: JSON.stringify({
      subgoal_done: {
        summary: 'The Framework Laptop 16 costs 1.399,00 EUR.',
        evidence: 'The price line on the page reads "ab 1.399,00 EUR".'
      }
    })
  });

  assert.match(card, /The Framework Laptop 16 costs 1\.399,00 EUR\./, 'the sentence is there');
  assert.doesNotMatch(card, /subgoal_done/, 'the wrapper is not');
  assert.doesNotMatch(card, /"summary"/, 'and neither is the raw JSON');
  assert.doesNotMatch(card, /\{/, 'no braces are shown to the user at all');
});

test('the evidence of a JSON answer is shown in a section of its own', () => {
  const card = cardOf({
    steps: [{ action: 'read_page_text', success: true }],
    answer: JSON.stringify({
      summary: 'The price is 1.399,00 EUR.',
      evidence: 'The price line on the page reads "ab 1.399,00 EUR".'
    })
  });

  assert.match(card, /answer-evidence/, 'there is an evidence section');
  assert.match(card, />Evidence</, 'and it says what it is');
  assert.match(card, /The price line on the page reads/, 'the evidence is in it');
});

test('a plain answer is shown exactly as it is', () => {
  const card = cardOf({
    steps: [{ action: 'read_page_text', success: true }],
    answer: 'The price is 1.399,00 EUR.'
  });

  assert.match(card, /The price is 1\.399,00 EUR\./);
  assert.doesNotMatch(card, /answer-evidence/, 'and there is no evidence section for it');
});
