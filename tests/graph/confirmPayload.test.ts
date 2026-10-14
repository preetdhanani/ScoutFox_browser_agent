/**
 * safety/confirm-card-blind-approval, end to end through the real AgentRunner: the confirm card's payload carries
 * what the user approves (the code of execute_js), and execute_js is opt-in.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { act, graphRig } from '../helpers/graphHarness.ts';

const CODE = `const el = document.querySelector('.price'); return el ? el.textContent : "<none>";`;

test('confirmPayload: the execute_js card payload carries the full code under the script variant', async (t) => {
  const rig = await graphRig({
    chrome: { scripting: { executeScript: { __scoutfoxOk: true, value: '99 USD' } } },
    settings: { modelTier: 'large', allowExecuteJs: true },
    policy: [act.executeJs(CODE, 'Read the price'), act.finish('The price is 99 USD.')],
  });
  t.after(rig.cleanup);

  await rig.start('Read the price with a script');
  assert.equal(rig.status(), 'paused');
  const confirm = rig.pending().confirm as any;
  assert.ok(confirm, 'execute_js raised a confirm card');
  assert.equal(confirm.variant, 'script');
  assert.equal(confirm.detail?.verb, 'execute_js');
  assert.equal(confirm.detail?.code, CODE);
  assert.equal(confirm.detail?.codeLength, CODE.length);
  assert.equal(confirm.targetDomain, undefined, 'no targetDomain, so the card shows no remember checkbox');

  await rig.confirm('approve');
  assert.equal(rig.status(), 'idle');
  assert.equal(rig.finishAnswer(), 'The price is 99 USD.');
  rig.assertClean();
});

test('confirmPayload: execute_js is off by default - not offered to the model, and refused when it comes anyway', async (t) => {
  const rig = await graphRig({
    // No scripting results are scripted: a call to chrome.scripting.executeScript is a loud test mistake.
    settings: { modelTier: 'large' },
    policy: [act.executeJs(CODE, 'Read the price'), act.finish('Done without a script.')],
  });
  t.after(rig.cleanup);

  await rig.start('Read the price');
  assert.equal(rig.status(), 'idle');
  assert.equal(rig.pending().confirm, null, 'no card for an action the model was not offered');

  const first = rig.llm.callsOf('policy')[0];
  assert.ok(first, 'the policy node was called');
  assert.ok(!first.systemPrompt.includes('execute_js'), 'the prompt does not offer execute_js');
  assert.ok(!JSON.stringify(first.schema).includes('execute_js'), 'the schema does not offer execute_js');
  assert.ok(first.systemPrompt.includes('browser_batch'), 'the other large tier verbs are still offered');

  const second = rig.llm.callsOf('policy')[1];
  assert.ok(JSON.stringify(second?.messages ?? []).includes('is not available here'), 'the model is told the verb is not available');
  assert.equal(rig.finishAnswer(), 'Done without a script.');
  rig.assertClean();
});
