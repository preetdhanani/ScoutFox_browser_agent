/**
 * Regression test: buildStepMessage() never included planSteps at all, even though it is
 * computed once per task (generatePlan) and shown in the side panel's own progress bar. The
 * model choosing the actual next action never saw the plan it was supposedly following, or how
 * many steps remained - "the model can still emit a finish and the panel will render it as
 * Done" while having lost track of a plan it was never shown in the first place.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

global.chrome = {
  storage: { local: { get: (keys, cb) => cb({}), set: (data, cb) => cb && cb() } },
  tabs: { get: (id, cb) => cb({ id, groupId: -1, url: 'https://example.com' }), query: async () => [] }
};

const { AgentEngine } = await import('../background/agentEngine.js');

const SNAPSHOT = {
  title: 'Test Page',
  url: 'https://example.com',
  scrollState: { scrollY: 0, pageHeight: 1000, viewportHeight: 800 },
  pageText: 'hello',
  elementsText: '[1] button "Go"'
};

test('buildStepMessage includes the plan and progress, when one exists', () => {
  const engine = new AgentEngine();
  engine.currentTask = 'do a thing';
  engine.stepCount = 2;
  engine.planSteps = [
    { id: 1, text: 'Navigate to the page', status: 'completed' },
    { id: 2, text: 'Fill out the form', status: 'in_progress' },
    { id: 3, text: 'Submit', status: 'pending' }
  ];

  const msg = engine.buildStepMessage(SNAPSHOT, 25);

  assert.match(msg, /Navigate to the page/);
  assert.match(msg, /Fill out the form/);
  assert.match(msg, /Submit/);
  assert.match(msg, /2\/25/, 'must show current progress against the actual step budget');
  assert.match(msg, /\[x\].*Navigate/, 'a completed step must be visibly marked done');
  assert.match(msg, /\[>\].*Fill out the form/, 'the in-progress step must be visibly distinguished from pending ones');
});

test('buildStepMessage omits the plan section entirely when there is no plan', () => {
  const engine = new AgentEngine();
  engine.currentTask = 'do a thing';
  engine.planSteps = [];

  const msg = engine.buildStepMessage(SNAPSHOT, 25);
  assert.doesNotMatch(msg, /Plan \(/);
});
