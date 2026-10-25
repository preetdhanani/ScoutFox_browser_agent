/**
 * The plan in the timeline: the manual-approve card and the live checklist.
 *
 * What these tests hold on to:
 *   1. The Approve/Cancel card shows once, under the live turn only. A session with an earlier
 *      turn must not repeat the card (and its buttons) under every past turn.
 *   2. A turn that is not live never shows the card, even if a stale pendingApproval is passed.
 *   3. The plan checklist (state.planSteps) is drawn inside the live turn's action group, with
 *      "step X of Y" in the header. Only 'completed' moves the counter.
 *   4. A finished run hides the checklist, except when a step was skipped (it has to say so).
 *   5. The stylesheet still has the checklist rules.
 *
 * sidepanel.js touches window and document once at load, so a small stub is enough to import it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

globalThis.window = { addEventListener() {} };
globalThis.document = { readyState: 'loading', addEventListener() {}, getElementById: () => null };

const { renderTurns } = await import('../../sidepanel/sidepanel.js');

const CSS = fs.readFileSync(new URL('../../sidepanel/sidepanel.css', import.meta.url), 'utf8');

/** Two runs: the first finished, the second is live and has done one action. */
function twoRuns() {
  return [
    { type: 'user_goal', turn: 1, prompt: 'First task', timestamp: '10:00:00', isNewRun: true },
    { type: 'agent_response', step: 1, thought: '', action: { action: 'scroll', direction: 'down' }, rawResponse: '{}' },
    { type: 'execution_result', step: 1, success: true, message: 'Scrolled' },
    { type: 'finish', answer: 'Done with the first.' },
    { type: 'user_goal', turn: 2, prompt: 'Second task', timestamp: '10:05:00', isNewRun: true },
    { type: 'agent_response', step: 2, thought: '', action: { action: 'scroll', direction: 'down' }, rawResponse: '{}' },
    { type: 'execution_result', step: 2, success: true, message: 'Scrolled' }
  ];
}

const APPROVAL = { plan: ['Open the shop', 'Read the price'] };

function count(html, needle) {
  return html.split(needle).length - 1;
}

/** The markup of each turn, in order. */
function turnsOf(html) {
  return html.split('<div class="turn">').slice(1);
}

test('the plan approval card shows once, under the live turn only', () => {
  const html = renderTurns(twoRuns(), 'paused', '', null, APPROVAL);
  assert.equal(count(html, 'class="plan-approval-card"'), 1, 'one card, not one per turn');
  const turns = turnsOf(html);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].includes('plan-approval-card'), false, 'the finished turn has no card');
  assert.equal(turns[1].includes('plan-approval-card'), true, 'the live turn has the card');
});

test('a run that is not live never shows the approval card', () => {
  for (const status of ['idle', 'stopped', 'error', 'completed']) {
    const html = renderTurns(twoRuns(), status, '', null, APPROVAL);
    assert.equal(html.includes('plan-approval-card'), false, status);
  }
});

test('the approval card still shows when the hold comes before any history', () => {
  const html = renderTurns([], 'paused', '', null, APPROVAL);
  assert.equal(count(html, 'class="plan-approval-card"'), 1);
});

test('the live turn draws the plan checklist and says which step it is on', () => {
  const planSteps = [
    { text: 'Open the shop', status: 'completed' },
    { text: 'Read the price', status: 'in_progress' },
    { text: 'Compare <b>offers</b>', status: 'pending' }
  ];
  const html = renderTurns(twoRuns(), 'running', '', null, null, null, null, null, null, null, planSteps);
  const turns = turnsOf(html);
  assert.equal(turns[0].includes('act-plan'), false, 'a finished turn has no checklist');
  assert.match(turns[1], /class="act-plan"/);
  assert.match(turns[1], /act-plan-row completed/);
  assert.match(turns[1], /act-plan-row in_progress/);
  assert.match(turns[1], /act-plan-row pending/);
  assert.match(turns[1], /Compare &lt;b&gt;offers&lt;\/b&gt;/, 'step text is escaped');
  assert.match(turns[1], /Working · step 2 of 3 · 1 action/);
});

test('a skipped step does not move the counter and says "not checked"', () => {
  const planSteps = [
    { text: 'Read shop A', status: 'skipped' },
    { text: 'Read shop B', status: 'in_progress' }
  ];
  const html = renderTurns(twoRuns(), 'running', '', null, null, null, null, null, null, null, planSteps);
  assert.match(html, /Working · step 1 of 2/);
  assert.match(html, /act-plan-row skipped/);
  assert.match(html, /not checked/);
});

test('the checklist shows before the first action of a live run', () => {
  const history = [{ type: 'user_goal', turn: 1, prompt: 'Go', timestamp: '10:00:00', isNewRun: true }];
  const html = renderTurns(history, 'running', '', null, null, null, null, null, null, null, [{ text: 'Open the page', status: 'in_progress' }]);
  assert.match(html, /class="act-plan"/);
  assert.match(html, /Working · step 1 of 1 · 0 actions/);
});

test('while the plan card is up, the checklist does not repeat it', () => {
  const planSteps = [{ text: 'Open the shop', status: 'pending' }, { text: 'Read the price', status: 'pending' }];
  const html = renderTurns(twoRuns(), 'paused', '', null, APPROVAL, null, null, null, null, null, planSteps);
  assert.equal(count(html, 'class="plan-approval-card"'), 1);
  assert.equal(html.includes('class="act-plan"'), false);
  assert.equal(/step \d+ of/.test(html), false);
});

test('a finished run hides the checklist unless a step was skipped', () => {
  const done = [{ text: 'Open the shop', status: 'completed' }];
  const idle = renderTurns(twoRuns(), 'idle', '', null, null, null, null, null, null, null, done);
  assert.equal(idle.includes('act-plan'), false);

  const skipped = [{ text: 'Read shop A', status: 'skipped' }, { text: 'Read shop B', status: 'completed' }];
  const idleSkipped = renderTurns(twoRuns(), 'idle', '', null, null, null, null, null, null, null, skipped);
  assert.equal(turnsOf(idleSkipped)[1].includes('act-plan-row skipped'), true);
  assert.equal(turnsOf(idleSkipped)[0].includes('act-plan'), false);
});

test('the stylesheet has the checklist rules', () => {
  for (const sel of ['.act-plan {', '.act-plan-row {', '.act-plan-row.completed', '.act-plan-row.skipped', '.plan-skip-note']) {
    assert.ok(CSS.includes(sel), sel);
  }
});
