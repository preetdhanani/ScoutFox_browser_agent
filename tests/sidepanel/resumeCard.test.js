/**
 * Resume on an Interrupted or Stopped card (sidepanel/sidepanel.js).
 *
 * What these tests hold on to:
 *   1. The newest turn of a resting chat that was stopped, interrupted (a worker restart) or cut off
 *      (a closed browser) has a Resume button on its card; a finished turn, an earlier turn and a
 *      live run have none.
 *   2. A cut-off chat reads "Interrupted" with its own reason.
 *   3. A click on Resume sends the task "Resume the unfinished task." in the same chat, exactly like
 *      typing it and pressing Send.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { install, settle } from './fakePanelDom.js';

const { getEl, sent } = install();
const { renderTurns, initTimelineInteraction, initEventListeners, loadSettings, RESUME_PROMPT } = await import('../../sidepanel/sidepanel.js');
initEventListeners();
await loadSettings();
initTimelineInteraction();

const goal = (turn) => ({ type: 'user_goal', turn, prompt: `Goal ${turn}`, timestamp: '', isNewRun: true });
const ended = (reason) => ({ type: 'partial_result', answer: 'The run was stopped before it finished.', table: null, reason });
const render = (history, status = 'idle') => renderTurns(history, status, '', null, null, null, null, null, null, null);
const resumes = (html) => (html.match(/data-resume="1"/g) || []).length;

test('a stopped, interrupted or cut-off newest turn offers Resume; nothing else does', () => {
  for (const reason of ['stopped', 'interrupted', 'closed']) {
    assert.equal(resumes(render([goal(1), ended(reason)])), 1, reason);
  }
  assert.equal(resumes(render([goal(1), { type: 'finish', answer: 'Done.', outcome: 'done' }])), 0, 'a finished turn');
  assert.equal(resumes(render([goal(1), ended('max_steps')])), 0, 'a run that used its steps is not cut off');
  assert.equal(resumes(render([goal(1), ended('stopped'), goal(2), { type: 'finish', answer: 'ok', outcome: 'done' }])), 0, 'an earlier turn');
  assert.equal(resumes(render([goal(1), ended('stopped'), goal(2)], 'running')), 0, 'a live run');
  // The synthetic card of a run stopped with no row of its own is the newest turn too.
  assert.equal(resumes(render([goal(1), { type: 'agent_response', step: 1, thought: '', action: { action: 'read_page' } }], 'stopped')), 1);
});

test('a chat cut off by a closed browser reads Interrupted, with its own reason', () => {
  const html = render([goal(1), { type: 'partial_result', answer: 'The run was cut off when the browser or panel closed. The steps so far are kept; resume the task to continue.', table: null, reason: 'closed' }]);
  assert.match(html, /Interrupted/);
  assert.match(html, /cut off when the browser or panel closed/);
});

test('Resume sends the same request as typing it', async () => {
  sent.length = 0;
  const target = { closest: (sel) => (sel === '[data-resume]' ? { getAttribute: () => '1' } : null) };
  await getEl('timeline').dispatchEvent({ type: 'click', target });
  await settle(20);
  const start = sent.find((m) => m.action === 'START_TASK');
  assert.ok(start, 'a task was started');
  assert.equal(start.payload.prompt, RESUME_PROMPT);
  assert.equal(RESUME_PROMPT, 'Resume the unfinished task.');
});
