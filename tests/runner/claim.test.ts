import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRunner } from '../../src/background/runner/AgentRunner.ts';
import { fakeChrome } from '../helpers/fakeChrome.ts';
import { createFakeStorage } from '../helpers/fakeStorageSession.ts';

test('claim: claimForTask manages single-task claim lock and refuses concurrent claims', () => {
  const fc = fakeChrome({ storage: true });
  const restore = fc.install();
  try {
    const runner = new AgentRunner(101, 'default');

    const c1 = runner.claimForTask();
    assert.equal(c1.success, true);

    // Second claim must fail
    const c2 = runner.claimForTask();
    assert.equal(c2.success, false);
    assert.ok(c2.error?.includes('already active or paused'));

    // Release allows claiming again
    runner.releaseTaskClaim();
    const c3 = runner.claimForTask();
    assert.equal(c3.success, true);
    runner.releaseTaskClaim();
  } finally {
    restore();
  }
});

test('claim: empty or whitespace prompt releases claim so session does not wedge (D3)', async () => {
  const fc = fakeChrome({ storage: true });
  const restore = fc.install();
  try {
    const runner = new AgentRunner(102, 'default');

    // Acquire claim like background.js router does
    const claim = runner.claimForTask();
    assert.equal(claim.success, true);

    // Starting with empty prompt returns error and releases claim
    const res = await runner.startTask('', 102);
    assert.equal(res.success, false);
    assert.equal(res.error, 'Cannot start empty prompt.');

    // Next claim must succeed without being wedged
    const claimNext = runner.claimForTask();
    assert.equal(claimNext.success, true);

    // Whitespace only prompt
    const resWhitespace = await runner.startTask('   ', 102);
    assert.equal(resWhitespace.success, false);

    // Claim is again available
    const claimAfterWhitespace = runner.claimForTask();
    assert.equal(claimAfterWhitespace.success, true);
    runner.releaseTaskClaim();
  } finally {
    restore();
  }
});

test('claim: claimForTask refuses while status is running', () => {
  const fc = fakeChrome({ storage: true });
  const restore = fc.install();
  try {
    const runner = new AgentRunner(103, 'default');
    (runner as any).status = 'running';
    const c = runner.claimForTask();
    assert.equal(c.success, false);
    assert.ok(c.error?.includes('already active or paused'));
  } finally {
    restore();
  }
});

test('claim: releaseTaskClaim lets a later task start without leaking claims', () => {
  const fc = fakeChrome({ storage: true });
  const restore = fc.install();
  try {
    const runner = new AgentRunner(105, 'default');
    assert.equal(runner.claimForTask().success, true);
    runner.releaseTaskClaim();
    assert.equal(runner.claimForTask().success, true);
    runner.releaseTaskClaim();
  } finally {
    restore();
  }
});
