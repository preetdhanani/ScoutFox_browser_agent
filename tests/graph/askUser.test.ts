import test from 'node:test';
import assert from 'node:assert/strict';
import { graphRig, act } from '../helpers/graphHarness.ts';

test('askUser: ask_user pauses graph with pending question and resumes on answer', async () => {
  const rig = await graphRig({
    policy: [
      act.askUser('What is the preferred color?'),
      act.finish('Found the requested blue model.'),
    ],
  });

  try {
    const run = rig.start('Find laptop on sale');
    await rig.waitForCall('policy');
    await run;

    // Paused at ask_user hold
    assert.equal(rig.status(), 'paused');
    assert.equal(rig.pending().question, 'What is the preferred color?');

    // Answer the question
    await rig.answer('Blue');

    // Task finishes
    assert.equal(rig.status(), 'idle');
    assert.equal(rig.finishAnswer(), 'Found the requested blue model.');

    // History contains user_answer
    const userAnswers = rig.entries('user_answer');
    assert.equal(userAnswers.length, 1);
    assert.equal((userAnswers[0] as any).content, 'Blue');

    // Policy prompt received the answer in userAnswers block
    const policyCalls = rig.llm.callsOf('policy');
    assert.equal(policyCalls.length, 2);
    const secondPrompt = policyCalls[1]?.messages?.[0]?.content || '';
    assert.ok(secondPrompt.includes('You asked a question and the user answered: "Blue". Continue the task using this answer.'));
  } finally {
    await rig.cleanup();
  }
});

test('askUser: answerQuestion refuses when nothing is pending', async () => {
  const rig = await graphRig({ policy: [act.finish('done')] });
  try {
    const res = rig.runner.answerQuestion('some answer');
    assert.equal(res.success, false);
    assert.match(res.error || '', /no pending question/i);
  } finally {
    await rig.cleanup();
  }
});

test('askUser: answerQuestion refuses an empty answer without disturbing pending question', async () => {
  const rig = await graphRig({
    policy: [
      act.askUser('Which account?'),
      act.finish('done'),
    ],
  });
  try {
    const run = rig.start('Task');
    await rig.waitForCall('policy');
    await run;

    assert.equal(rig.status(), 'paused');
    assert.equal(rig.pending().question, 'Which account?');

    const res = rig.runner.answerQuestion('   ');
    assert.equal(res.success, false);
    assert.equal(rig.pending().question, 'Which account?');
  } finally {
    await rig.stop();
    await rig.cleanup();
  }
});

test('askUser: plain Resume clears pending question', async () => {
  const rig = await graphRig({
    policy: [
      act.askUser('Which account?'),
      act.finish('proceeded without an answer'),
    ],
  });
  try {
    const run = rig.start('Task');
    await rig.waitForCall('policy');
    await run;

    assert.equal(rig.status(), 'paused');
    assert.equal(rig.pending().question, 'Which account?');

    const res = await rig.resume();
    assert.equal(res.success, true);

    assert.equal(rig.status(), 'idle');
    assert.equal(rig.pending().question, null);
  } finally {
    await rig.cleanup();
  }
});

test('askUser: answering resumes the run and model receives the answer', async () => {
  const rig = await graphRig({
    policy: [
      act.askUser('Which account should I use?'),
      act.finish('Used the primary account, done.'),
    ],
  });
  try {
    const run = rig.start('Account task');
    await rig.waitForCall('policy');
    await run;

    assert.equal(rig.status(), 'paused');
    assert.equal(rig.pending().question, 'Which account should I use?');

    const res = await rig.answer('the primary one');
    assert.equal(res.success, true);

    assert.equal(rig.status(), 'idle');
    assert.equal(rig.finishAnswer(), 'Used the primary account, done.');
    const userAnswers = rig.entries('user_answer');
    assert.equal(userAnswers.length, 1);
    assert.equal((userAnswers[0] as any).content, 'the primary one');
  } finally {
    await rig.cleanup();
  }
});
