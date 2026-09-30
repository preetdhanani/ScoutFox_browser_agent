/**
 * Unit tests for agent/recovery.ts in isolation - no chrome mock, no engine, no timers beyond
 * its own short backoff. See tests/agentEngineLlmRetry.test.js for the wired-in behaviour
 * (retry-then-pause on exhaustion, resumable from the same step).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { callWithRetry, LLM_MAX_ATTEMPTS, LLM_RETRY_BASE_DELAY_MS } from '../../src/background/agent/recovery.ts';

test('callWithRetry returns the first successful attempt without retrying', async () => {
  let calls = 0;
  const result = await callWithRetry(async () => { calls++; return 'ok'; });
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

test('callWithRetry retries a failing attempt and returns once one succeeds', async () => {
  let calls = 0;
  const result = await callWithRetry(async (n) => {
    calls++;
    if (n < 3) throw new Error(`transient failure ${n}`);
    return 'recovered';
  });
  assert.equal(result, 'recovered');
  assert.equal(calls, 3);
});

test('callWithRetry throws the last error once maxAttempts is exhausted', async () => {
  let calls = 0;
  await assert.rejects(
    () => callWithRetry(async () => { calls++; throw new Error('permanent failure'); }),
    /permanent failure/
  );
  assert.equal(calls, LLM_MAX_ATTEMPTS, `must try exactly ${LLM_MAX_ATTEMPTS} times, not loop forever`);
});

test('callWithRetry never retries when isAbort classifies the error as a user action', async () => {
  let calls = 0;
  await assert.rejects(
    () => callWithRetry(
      async () => { calls++; throw new Error('LLM request cancelled (task stopped or paused).'); },
      { isAbort: () => true }
    ),
    /cancelled/
  );
  assert.equal(calls, 1, 'a user abort must not be retried, even once');
});

test('callWithRetry stops before the next attempt when shouldContinue turns false', async () => {
  let calls = 0;
  let allowContinue = true;
  await assert.rejects(
    () => callWithRetry(
      async () => {
        calls++;
        allowContinue = false; // simulate Pause/Stop landing right after this attempt fails
        throw new Error('connection reset');
      },
      { shouldContinue: () => allowContinue }
    ),
    /connection reset/
  );
  assert.equal(calls, 1, 'must not start a second attempt once shouldContinue says stop');
});

test('callWithRetry calls onRetry with the attempt number and computed delay before each backoff', async () => {
  const seen: { attempt: number; message: string; delayMs: number }[] = [];
  let calls = 0;
  await callWithRetry(
    async (n) => { calls++; if (n < 2) throw new Error('flaky'); return 'ok'; },
    { onRetry: (attempt, err, delayMs) => seen.push({ attempt, message: (err as Error).message, delayMs }) }
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0].attempt, 1);
  assert.equal(seen[0].message, 'flaky');
  assert.equal(seen[0].delayMs, LLM_RETRY_BASE_DELAY_MS * 1);
});
