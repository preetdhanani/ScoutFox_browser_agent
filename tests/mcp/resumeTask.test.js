/**
 * The checks of the real-model resume task (web-resume-chat in tests/mcp/tasks.mjs). The task needs
 * LISA; these pure parts are pinned here so a broken check cannot pass a wrong run.
 *
 * What these tests hold on to:
 *   1. The task: turn 1 is the certifications file task, stopped with a click after its first
 *      save_data or second step; then New chat, the chat reopened from Recent tasks, and "resume"
 *      typed in the composer. Turn 1 must end stopped; the resume must hand over the right file.
 *   2. The stop point: two action rows, or a save_data call, whichever comes first.
 *   3. The resume request check: the chain, the stopped turn's goal, every plan step and the tool of
 *      every step must be in the first user message. A request without the chain (what Prit saw)
 *      fails, and so does one that lost a plan step or a step.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CREDENTIALS, CREDENTIALS_PROMPT, TASKS, resumeRequestProblems, stopPointReached } from './tasks.mjs';

const task = TASKS['web-resume-chat'];

test('the resume task: a stopped file task, New chat, reopened, then "resume" typed like a user', () => {
  assert.equal(task.page, 'credentials.html');
  assert.equal(task.web, true);
  assert.equal(task.prompt, CREDENTIALS_PROMPT);
  assert.equal(task.expectOutcome, 'partial_result');
  assert.equal(task.expectFinishOutcome, null);
  assert.deepEqual(
    { stop: task.followUp.stopAfterSteps, newChat: task.followUp.newChat, reopen: task.followUp.reopen, typed: task.followUp.typed, holds: task.followUp.holdsStoppedTurn, prompt: task.followUp.prompt },
    { stop: 2, newChat: true, reopen: true, typed: true, holds: true, prompt: 'resume' }
  );
  const stopped = { outcome: 'partial_result', rows: [{ type: 'partial_result', reason: 'stopped' }] };
  assert.equal(task.check(stopped), true);
  assert.equal(task.check({ outcome: 'finish', rows: [{ type: 'finish' }] }), false, 'a turn 1 that finished is not the case');
  const file = JSON.stringify(CREDENTIALS.map(([name, issued, url]) => ({ name, issued, url })));
  assert.equal(task.followUp.check({ files: [{ name: 'certifications.json', content: file }] }), true);
  assert.equal(task.followUp.check({ files: [] }), false, 'no file, no pass (the resume CV answer Prit got)');
  assert.equal(task.followUp.check({ files: [{ name: 'c.json', content: JSON.stringify([{ name: 'x' }]) }] }), false);
});

test('the stop point is two steps or the first save_data call', () => {
  const row = (action) => ({ type: 'agent_response', action: { action } });
  assert.equal(stopPointReached([row('read_page')], 2), false);
  assert.equal(stopPointReached([row('read_page'), { type: 'execution_result' }, row('scroll')], 2), true);
  assert.equal(stopPointReached([row('save_data')], 2), true);
  assert.equal(stopPointReached([{ type: 'user_goal' }], 2), false);
});

test('the resume request must hold the chain, the goal, the plan and the steps of the stopped turn', () => {
  const stopped = { plan: [{ text: 'Read the page' }, { text: 'Save every certificate' }], steps: [{ action: { action: 'read_page' } }, { action: { action: 'save_data' } }] };
  const good = [
    'EARLIER IN THIS CHAT (for context; the task below is the current one):',
    'Turn 1 (stopped, unfinished)',
    `You asked: ${CREDENTIALS_PROMPT}`,
    'Plan:\n1 [done] Read the page\n2 [ ] Save every certificate',
    'Last steps:\n- read_page -> ok: text\n- save_data count=10 -> ok: Saved 10',
    'TASK: resume'
  ].join('\n');
  assert.deepEqual(resumeRequestProblems(stopped, CREDENTIALS_PROMPT, good), []);
  // What Prit saw: no chain at all.
  assert.match(resumeRequestProblems(stopped, CREDENTIALS_PROMPT, 'TASK: resume\n\nCURRENT PAGE: x').join(), /carries no chain/);
  assert.match(resumeRequestProblems(stopped, CREDENTIALS_PROMPT, good.replace('2 [ ] Save every certificate', '')).join(), /1 of the 2 plan step/);
  assert.match(resumeRequestProblems(stopped, CREDENTIALS_PROMPT, good.replace('- save_data count=10', '- other')).join(), /save_data missing/);
  assert.match(resumeRequestProblems(stopped, CREDENTIALS_PROMPT, good.replace(CREDENTIALS_PROMPT, 'x')).join(), /goal of the stopped turn/);
  // A stopped turn with no plan is checked on its goal and steps.
  assert.deepEqual(resumeRequestProblems({ plan: [], steps: stopped.steps }, CREDENTIALS_PROMPT, good), []);
});
