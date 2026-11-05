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
function historyOf({ steps, answer, audit = null, outcome = undefined }) {
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
  rows.push({ type: 'finish', answer, ...(audit ? { audit } : {}), ...(outcome !== undefined ? { outcome } : {}) });
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

/** The declarations of the rule whose selector list holds `selector`, or ''. */
function ruleWith(selector) {
  for (const match of CSS.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (match[1].split(',').map((part) => part.trim()).includes(selector)) return match[2];
  }
  return '';
}

test('the stylesheet colours the status line of a failed answer red, icon and words', () => {
  // The answer is not a box any more (no edge to colour): the status line carries the state.
  assert.match(ruleWith('.finish-card.failed .finish-title'), /color:\s*var\(--danger\)/, 'the words of the failed status are not red');
  assert.match(ruleWith('.finish-card.failed .finish-title svg'), /color:\s*var\(--danger\)/, 'the icon of the failed status is not red');
});

test('the answer is not a box: the card has no border and no background', () => {
  const card = ruleWith('.finish-card');
  assert.ok(card, 'there is a .finish-card rule');
  assert.ok(!/border|background/.test(card), `the card rule draws a box: ${card}`);
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

// ---------------------------------------------------------------------------------------------
// The finish outcome decides the card (done, partial, blocked); a failed step is only a note
// ---------------------------------------------------------------------------------------------

test('outcome "done" with every step through is the green Done card, with no note', () => {
  const card = cardOf({ steps: [{ action: 'read_page', success: true }], answer: 'The price is 1.399,00 EUR.', outcome: 'done' });
  assert.match(card, /class="finish-card"/);
  assert.match(card, /> Done</);
  assert.ok(card.includes(GREEN_TICK));
  assert.doesNotMatch(card, /finish-sub/, 'no note when nothing failed');
});

test('outcome "done" after a blocked search is still Done: the failed step is a quiet note, not the title', () => {
  const card = cardOf({
    steps: [{ action: 'web_search', success: false, error: 'Error: the search engine answered 429' }, { action: 'fetch_url', success: true }],
    answer: 'The archive is lantern-linux-amd64-v3.8.1.tar.zst.',
    outcome: 'done'
  });
  assert.match(card, /> Done</, 'the title follows the outcome');
  assert.doesNotMatch(card, /> Failed</, 'one blocked search does not make a correct answer "Failed"');
  assert.match(card, /class="finish-card has-sub"/);
  assert.match(card, /<div class="finish-sub">1 step failed along the way\.<\/div>/, 'the failed step is said under the title');
});

test('outcome "partial" is the amber Partly done card', () => {
  const card = cardOf({ steps: [{ action: 'read_page', success: true }, { action: 'click', success: false }, { action: 'click', success: false }], answer: 'I found the price but not the shipping cost.', outcome: 'partial' });
  assert.match(card, /class="finish-card partial has-sub"/);
  assert.match(card, /> Partly done</);
  assert.ok(!card.includes(GREEN_TICK), 'no green tick');
  assert.ok(card.includes(WARNING_TRIANGLE));
  assert.match(card, /2 steps failed along the way\./);
});

test('outcome "blocked" is Could not finish, even when no step failed (the honest "it did not work")', () => {
  const card = cardOf({
    steps: [{ action: 'click', success: true }, { action: 'click', success: true }],
    answer: 'The Download CSV button did not work: nothing on the page changed.',
    outcome: 'blocked'
  });
  assert.match(card, /class="finish-card blocked"/);
  assert.match(card, /> Could not finish</);
  assert.doesNotMatch(card, /> Done</, 'an answer that says it did not work is never Done');
  assert.ok(!card.includes(GREEN_TICK));
  assert.ok(card.includes(WARNING_TRIANGLE));
});

test('a finish with no outcome, or one the panel does not know, keeps the older card (a failed step is Failed)', () => {
  for (const outcome of [undefined, 'great', null]) {
    const card = cardOf({ steps: [{ action: 'click', success: false }], answer: 'The click failed.', outcome });
    assert.match(card, /> Failed</, String(outcome));
  }
});

test('the mock failure marker wins over any outcome', () => {
  const card = cardOf({ steps: [{ action: 'click', success: true }], answer: 'MOCK-FAIL: no script', outcome: 'done' });
  assert.match(card, /> Failed</);
});

test('the blocked status line is red too, icon and words', () => {
  for (const state of ['blocked', 'unconfirmed', 'unverified']) {
    assert.match(ruleWith(`.finish-card.${state} .finish-title`), /color:\s*var\(--danger\)/, state);
    assert.match(ruleWith(`.finish-card.${state} .finish-title svg`), /color:\s*var\(--danger\)/, state);
  }
  assert.match(ruleWith('.finish-card.partial .finish-title'), /color:\s*var\(--warning\)/);
});

// ---------------------------------------------------------------------------------------------
// Inline `code` in the answer is rendered, and stays escaped
// ---------------------------------------------------------------------------------------------

/** The body of a card: the answer as the reader sees it. */
const bodyOf = (card) => card.slice(card.indexOf('<div class="finish-body">'));

test('an answer with `backticks` shows a code span, not the backticks', () => {
  const card = cardOf({ steps: [{ action: 'read_page', success: true }], answer: 'Run `ollama --version` in ~/.local/bin.', outcome: 'done' });
  assert.match(bodyOf(card), /Run <code class="md-code">ollama --version<\/code> in ~\/\.local\/bin\./);
  assert.doesNotMatch(bodyOf(card), /`/, 'no backtick is left in the text');
});

test('code spans work in headings, list items and table cells of a structured answer too', () => {
  const card = cardOf({
    steps: [{ action: 'read_page', success: true }],
    answer: '## The `install` step\n\n- download `lantern.tar.zst`\n\n| file | needs |\n|---|---|\n| `x.tar.zst` | zstd |',
    outcome: 'done'
  });
  const body = bodyOf(card);
  assert.match(body, /The <code class="md-code">install<\/code> step/);
  assert.match(body, /download <code class="md-code">lantern\.tar\.zst<\/code>/);
  assert.match(body, /<td class="md-nw"><code class="md-code">x\.tar\.zst<\/code><\/td>/);
});

test('model text inside a code span is escaped: no tag, attribute or entity of the model gets through', () => {
  const card = cardOf({
    steps: [{ action: 'read_page', success: true }],
    answer: 'Use `<img src=x onerror="alert(1)">` and `a & b` and `**not bold**` then **bold**.',
    outcome: 'done'
  });
  const body = bodyOf(card);
  assert.match(body, /<code class="md-code">&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;<\/code>/);
  assert.match(body, /<code class="md-code">a &amp; b<\/code>/);
  assert.match(body, /<code class="md-code">\*\*not bold\*\*<\/code>/, 'a code span is never bolded');
  assert.match(body, /<strong>bold<\/strong>/, 'bold outside a code span still works');
  assert.doesNotMatch(body, /<img/);
});

test('only a single-backtick span on one line is code: fences, a lone backtick and a span across lines stay text', () => {
  for (const answer of ['a ```fence``` b', 'one ` backtick', 'start `across\nlines` end', 'empty `` pair']) {
    const card = cardOf({ steps: [{ action: 'read_page', success: true }], answer, outcome: 'done' });
    assert.doesNotMatch(card, /<code/, JSON.stringify(answer));
  }
});

test('the code span has a stylesheet rule built from theme tokens, so it reads in light and dark', () => {
  const at = CSS.indexOf('.md-code {');
  assert.ok(at >= 0, 'a .md-code rule exists');
  const body = CSS.slice(at, CSS.indexOf('}', at));
  assert.match(body, /font-family: var\(--font-mono\)/);
  assert.match(body, /background: var\(--surface\)/);
  assert.match(body, /overflow-wrap: anywhere/, 'a long path wraps inside the card');
  assert.doesNotMatch(body, /#[0-9a-f]{3,8}\b|rgb/i, 'no literal colours');
});
