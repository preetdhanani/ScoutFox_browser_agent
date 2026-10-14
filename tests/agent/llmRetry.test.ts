import test from 'node:test';
import assert from 'node:assert/strict';
import { MemorySaver } from '@langchain/langgraph/web';
import {
  LLM_MAX_ATTEMPTS,
  LLM_RETRY_BASE_DELAY_MS,
  LLM_RETRY_JITTER_RATIO,
  LLM_RETRY_MAX_DELAY_MS,
  callWithRetry
} from '../../src/background/agent/recovery.ts';
import { ProviderError } from '../../src/background/llm/errors.ts';
import { buildWorkerGraph } from '../../src/background/graph/worker.ts';
import { buildOrchestratorGraph } from '../../src/background/graph/orchestrator.ts';
import { registerMockRuntime } from '../helpers/mockRuntime.ts';

test('callWithRetry retries transient errors with clock sleep and respects maxAttempts', async () => {
  let attempts = 0;
  const sleeps: number[] = [];
  const fakeSleep = async (ms: number) => {
    sleeps.push(ms);
  };

  const res = await callWithRetry(
    async (attempt) => {
      attempts = attempt;
      if (attempt < 3) throw new Error(`failure ${attempt}`);
      return 'success';
    },
    {
      maxAttempts: 3,
      baseDelayMs: 300,
      jitterRatio: 0,
      sleep: fakeSleep,
    }
  );

  assert.equal(res, 'success');
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [300, 600]);
});

test('callWithRetry aborts immediately without further retries when isAbort is true', async () => {
  let attempts = 0;
  const abortErr = new Error('abort');

  await assert.rejects(
    async () => {
      await callWithRetry(
        async () => {
          attempts++;
          throw abortErr;
        },
        {
          maxAttempts: 3,
          isAbort: (err) => err === abortErr,
        }
      );
    },
    (err: any) => err === abortErr
  );

  assert.equal(attempts, 1);
});

test('worker policyNode retries transient LLM failure and finishes cleanly', async (t) => {
  const threadId = 'test-worker-llm-retry-transient';
  let calls = 0;

  registerMockRuntime(
    threadId,
    {
      settings: async () => ({ provider: 'openrouter', model: 'mock-model' } as any),
      llm: {
        complete: (async () => {
          calls++;
          if (calls < 3) {
            throw new Error('transient network drop');
          }
          return {
            text: JSON.stringify({ action: 'finish', answer: 'Found product' }),
          } as any;
        }) as any,
      },
    },
    t
  );

  const graph = buildWorkerGraph(new MemorySaver());
  const config = { configurable: { thread_id: threadId } };

  const out = await graph.invoke(
    {
      siteIn: {
        site: {
          id: 's1',
          name: 'Shop',
          domain: 'shop.test',
          startUrl: 'https://shop.test',
          goal: 'Find price',
          role: 'reference',
          kind: 'store',
          difficulty: 1,
        },
        index: 1,
        total: 1,
        task: 'Find price',
        tier: 'small',
        alloc: 10,
        runId: 'run-1',
      } as any,
    },
    config
  );

  assert.equal(calls, 3);
  assert.equal(out.siteRun?.criteriaMet, true);
  assert.equal(out.siteRun?.exit?.status, 'done');
  assert.equal(out.history?.filter((h) => h.type === 'error').length, 0);
});

test('worker policyNode pauses with llm_failure error row upon 3 failed attempts', async (t) => {
  const threadId = 'test-worker-llm-retry-exhausted';
  let calls = 0;

  registerMockRuntime(
    threadId,
    {
      settings: async () => ({ provider: 'groq', model: 'llama-3.3-70b-versatile' } as any),
      llm: {
        complete: async () => {
          calls++;
          throw new Error('Provider [groq] did not respond within 60s.');
        },
      },
    },
    t
  );

  const graph = buildWorkerGraph(new MemorySaver());
  const config = { configurable: { thread_id: threadId } };

  const out = await graph.invoke(
    {
      siteIn: {
        site: {
          id: 's1',
          name: 'Shop',
          domain: 'shop.test',
          startUrl: 'https://shop.test',
          goal: 'Find price',
          role: 'reference',
          kind: 'store',
          difficulty: 1,
        },
        index: 1,
        total: 1,
        task: 'Find price',
        tier: 'small',
        alloc: 10,
        runId: 'run-1',
      } as any,
    },
    config
  );

  assert.equal(calls, LLM_MAX_ATTEMPTS);
  assert.equal(out.pendingHold?.kind, 'paused');
  assert.equal(out.pendingHold?.reason, 'llm_failure');

  const errRow = out.history?.find((h) => h.type === 'error');
  assert.ok(errRow);
  assert.match(errRow.content, /LLM Connection Error \(groq\)/);
  assert.match(errRow.content, new RegExp(`after ${LLM_MAX_ATTEMPTS} attempts`));
  assert.match(errRow.content, /Task paused at step 0 - click Resume to try again/);
  assert.equal(out.siteRun?.used ?? 0, 0, 'Does not increment step count on pause');
});

test('orchestrator planNode pauses with llm_failure error row upon exhaustion', async (t) => {
  const threadId = 'test-orch-plan-llm-exhausted';
  let calls = 0;

  registerMockRuntime(
    threadId,
    {
      settings: async () => ({ provider: 'nvidia', model: 'meta/llama-3.3-70b-instruct' } as any),
      llm: {
        complete: (async (req: any) => {
          if (req.node === 'plan') {
            calls++;
            throw new Error('NVIDIA API connection error: 503 Service Unavailable');
          }
          return { text: '{}' } as any;
        }) as any,
      },
    },
    t
  );

  const graph = buildOrchestratorGraph(new MemorySaver());
  const config = { configurable: { thread_id: threadId } };

  const out = await graph.invoke(
    {
      task: 'Compare monitor prices',
    },
    config
  );

  assert.equal(calls, LLM_MAX_ATTEMPTS);
  assert.equal(out.pendingHold?.kind, 'paused');
  assert.equal(out.pendingHold?.reason, 'llm_failure');
  assert.equal(out.resumeRoute, 'plan');

  const errRow = out.history?.find((h) => h.type === 'error');
  assert.ok(errRow);
  assert.match(errRow.content, /LLM Connection Error \(nvidia\)/);
  assert.match(errRow.content, new RegExp(`after ${LLM_MAX_ATTEMPTS} attempts`));
  assert.match(errRow.content, /Task paused at step 0 - click Resume to try again/);
});

test('worker policyNode fails fast on a 401 with an authentication pause message and no retry', async (t) => {
  const threadId = 'test-worker-llm-401-fail-fast';
  let calls = 0;

  registerMockRuntime(
    threadId,
    {
      settings: async () => ({ provider: 'openai', model: 'gpt-4o-mini' } as any),
      llm: {
        complete: (async () => {
          calls++;
          throw new ProviderError('API connection error (https://api.openai.com/v1): API Error (401): Incorrect API key provided.', { status: 401, kind: 'auth' });
        }) as any,
      },
    },
    t
  );

  const graph = buildWorkerGraph(new MemorySaver());
  const config = { configurable: { thread_id: threadId } };

  const out = await graph.invoke(
    {
      siteIn: {
        site: {
          id: 's1',
          name: 'Shop',
          domain: 'shop.test',
          startUrl: 'https://shop.test',
          goal: 'Find price',
          role: 'reference',
          kind: 'store',
          difficulty: 1,
        },
        index: 1,
        total: 1,
        task: 'Find price',
        tier: 'small',
        alloc: 10,
        runId: 'run-1',
      } as any,
    },
    config
  );

  assert.equal(calls, 1, 'a refused key is never retried');
  assert.equal(out.pendingHold?.kind, 'paused');
  assert.equal(out.pendingHold?.reason, 'llm_failure');

  const errRow = out.history?.find((h) => h.type === 'error');
  assert.ok(errRow);
  assert.match(errRow.content, /LLM Authentication Error \(openai\)/);
  assert.match(errRow.content, /check your provider settings|API key/i);
  assert.doesNotMatch(errRow.content, /after \d+ attempts/, 'the exhausted-attempts wording is for retried errors only');
  assert.match(errRow.content, /Task paused at step 0 - click Resume to try again/);
});

test('worker policyNode keeps user-visible retry rows for the backoff waits it made', async (t) => {
  const threadId = 'test-worker-llm-retry-notices';
  let calls = 0;

  registerMockRuntime(
    threadId,
    {
      settings: async () => ({ provider: 'openrouter', model: 'mock-model' } as any),
      llm: {
        complete: (async () => {
          calls++;
          throw new ProviderError('OpenRouter API Error (503): upstream overloaded', { status: 503, kind: 'transient' });
        }) as any,
      },
    },
    t
  );

  const graph = buildWorkerGraph(new MemorySaver());
  const config = { configurable: { thread_id: threadId } };

  const out = await graph.invoke(
    {
      siteIn: {
        site: {
          id: 's1',
          name: 'Shop',
          domain: 'shop.test',
          startUrl: 'https://shop.test',
          goal: 'Find price',
          role: 'reference',
          kind: 'store',
          difficulty: 1,
        },
        index: 1,
        total: 1,
        task: 'Find price',
        tier: 'small',
        alloc: 10,
        runId: 'run-1',
      } as any,
    },
    config
  );

  assert.equal(calls, LLM_MAX_ATTEMPTS);
  const notices: any[] = (out.history ?? []).filter((h: any) => h.type === 'notice' && h.kind === 'llm_retry');
  assert.equal(notices.length, LLM_MAX_ATTEMPTS - 1, 'one row per backoff wait');
  assert.match(notices[0].content, /Retrying LLM call in \d+ s \(attempt 2 of 5\)/);
  assert.match(notices.at(-1)!.content, new RegExp(`\\(attempt ${LLM_MAX_ATTEMPTS} of ${LLM_MAX_ATTEMPTS}\\)`));
});

test('callWithRetry backs off exponentially: baseDelayMs doubled per attempt, capped', async () => {
  const delays: number[] = [];
  const fakeSleep = async (ms: number) => { delays.push(ms); };

  await assert.rejects(
    async () => {
      await callWithRetry(
        async (attempt) => {
          throw new Error(`fail ${attempt}`);
        },
        {
          maxAttempts: 4,
          baseDelayMs: 100,
          jitterRatio: 0,
          sleep: fakeSleep,
        }
      );
    },
    /fail 4/
  );

  assert.deepEqual(delays, [100, 200, 400]);
});

test('callWithRetry fails fast on permanent provider errors: no retry for auth, bad request or context overflow', async () => {
  const permanent = [
    new ProviderError('OpenRouter API Authentication Error (401): Invalid or missing API key.', { status: 401, kind: 'auth' }),
    new ProviderError('API Error (400): model gpt-nope does not exist', { status: 400, kind: 'bad_request' }),
    new ProviderError('This model\'s maximum context length is 8192 tokens.', { kind: 'context' })
  ];
  for (const err of permanent) {
    let calls = 0;
    await assert.rejects(
      () => callWithRetry(async () => { calls++; throw err; }, { sleep: async () => {} }),
      (e) => e === err
    );
    assert.equal(calls, 1, `${err.name} kind ${err.kind}: a permanent error must not be retried`);
  }
});

test('callWithRetry retries a 503 with exponential backoff and jitter up to the configured budget', async () => {
  const sleeps: number[] = [];
  let calls = 0;
  await assert.rejects(
    () => callWithRetry(
      async () => { calls++; throw new ProviderError('503 Service Unavailable', { status: 503, kind: 'transient' }); },
      { sleep: async (ms) => { sleeps.push(ms); } }
    ),
    /503/
  );
  assert.equal(calls, LLM_MAX_ATTEMPTS, 'a transient outage is retried up to the full budget');
  assert.equal(sleeps.length, LLM_MAX_ATTEMPTS - 1);
  for (let i = 0; i < sleeps.length; i++) {
    const pure = LLM_RETRY_BASE_DELAY_MS * 2 ** i;
    assert.ok(sleeps[i] >= pure, `delay ${i} (${sleeps[i]} ms) must be at least the exponential step (${pure} ms)`);
    const bound = Math.min(pure * (1 + LLM_RETRY_JITTER_RATIO), LLM_RETRY_MAX_DELAY_MS);
    assert.ok(sleeps[i] <= bound, `delay ${i} (${sleeps[i]} ms) must stay within the jittered cap (${bound} ms)`);
  }
});

test('a Pause or Stop during a backoff sleep wakes the caller at once', async () => {
  const controller = new AbortController();
  let calls = 0;
  const startedAt = Date.now();
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(
    () => callWithRetry(
      async () => { calls++; throw new Error('503 Service Unavailable'); },
      {
        signal: controller.signal,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      }
    ),
    /503/
  );
  assert.equal(calls, 1, 'no further attempt after the signal fired');
  assert.ok(Date.now() - startedAt < 1000, `the wait must end on the abort, not after the backoff (took ${Date.now() - startedAt} ms)`);
});

test('a retry-after hint from the provider is honoured as the backoff delay', async () => {
  const sleeps: number[] = [];
  let calls = 0;
  await assert.rejects(
    () => callWithRetry(
      async () => { calls++; throw new ProviderError('429 Too Many Requests', { status: 429, kind: 'rate_limit', retryAfterMs: 7000 }); },
      { maxAttempts: 2, jitterRatio: 0, sleep: async (ms) => { sleeps.push(ms); } }
    ),
    /429/
  );
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [7000], 'the provider\'s retry-after decides the wait, not the exponential step');
});

test('callWithRetry passes attempt count 1..N and returns on first success without sleep', async () => {
  const sleeps: number[] = [];
  let receivedAttempts: number[] = [];

  const res = await callWithRetry(
    async (attempt) => {
      receivedAttempts.push(attempt);
      return 'instant-win';
    },
    {
      maxAttempts: 3,
      sleep: async (ms) => { sleeps.push(ms); },
    }
  );

  assert.equal(res, 'instant-win');
  assert.deepEqual(receivedAttempts, [1]);
  assert.equal(sleeps.length, 0);
});

test('callWithRetry throws the exact final error when all attempts fail', async () => {
  let callCount = 0;
  await assert.rejects(
    async () => {
      await callWithRetry(
        async () => {
          callCount++;
          throw new Error(`err-attempt-${callCount}`);
        },
        {
          maxAttempts: 3,
          sleep: async () => {},
        }
      );
    },
    /err-attempt-3/
  );
  assert.equal(callCount, 3);
});

test('callWithRetry aborts immediately if shouldContinue returns false before next attempt', async () => {
  let shouldRun = true;
  let callCount = 0;

  await assert.rejects(
    async () => {
      await callWithRetry(
        async () => {
          callCount++;
          shouldRun = false;
          throw new Error('transient');
        },
        {
          maxAttempts: 3,
          shouldContinue: () => shouldRun,
          sleep: async () => {},
        }
      );
    },
    /transient/
  );
  assert.equal(callCount, 1);
});

test('callWithRetry stops retrying when isAbort identifies a user abort error', async () => {
  let calls = 0;
  const userStopErr = new Error('user requested stop');

  await assert.rejects(
    async () => {
      await callWithRetry(
        async () => {
          calls++;
          throw userStopErr;
        },
        {
          maxAttempts: 5,
          isAbort: (err) => err === userStopErr,
        }
      );
    },
    /user requested stop/
  );
  assert.equal(calls, 1);
});

test('callWithRetry handles zero delay gracefully without crashing', async () => {
  let calls = 0;
  const res = await callWithRetry(
    async (attempt) => {
      calls++;
      if (attempt < 2) throw new Error('fail');
      return 'ok';
    },
    {
      maxAttempts: 2,
      baseDelayMs: 0,
      sleep: async () => {},
    }
  );
  assert.equal(res, 'ok');
  assert.equal(calls, 2);
});

test('worker policyNode retries process termination error as transient', async (t) => {
  const threadId = 'test-worker-runner-crash-retry';
  let calls = 0;

  registerMockRuntime(
    threadId,
    {
      settings: async () => ({ provider: 'ollama', model: 'qwen2.5:7b' } as any),
      llm: {
        complete: (async () => {
          calls++;
          if (calls === 1) {
            throw new Error('Ollama API error (500): {"error":"signal: aborted (core dumped)"}');
          }
          return {
            text: JSON.stringify({ action: 'finish', answer: 'Recovered from core dump' }),
          } as any;
        }) as any,
      },
    },
    t
  );

  const graph = buildWorkerGraph(new MemorySaver());
  const config = { configurable: { thread_id: threadId } };

  const out = await graph.invoke(
    {
      siteIn: {
        site: {
          id: 's1',
          name: 'Shop',
          domain: 'shop.test',
          startUrl: 'https://shop.test',
          goal: 'Find price',
          role: 'reference',
          kind: 'store',
          difficulty: 1,
        },
        index: 1,
        total: 1,
        task: 'Find price',
        tier: 'small',
        alloc: 10,
        runId: 'run-1',
      } as any,
    },
    config
  );

  assert.equal(calls, 2);
  assert.equal(out.siteRun?.criteriaMet, true);
  assert.equal(out.history?.filter((h) => h.type === 'error').length, 0);
});

test('callWithRetry fires onRetry callback with correct attempt, error, and delay', async () => {
  const events: any[] = [];
  const fakeSleep = async () => {};

  await callWithRetry(
    async (attempt) => {
      if (attempt < 3) throw new Error(`err-${attempt}`);
      return 'ok';
    },
    {
      maxAttempts: 3,
      baseDelayMs: 50,
      jitterRatio: 0,
      onRetry: (attempt, err, delay) => {
        events.push({ attempt, msg: (err as Error).message, delay });
      },
      sleep: fakeSleep,
    }
  );

  assert.deepEqual(events, [
    { attempt: 1, msg: 'err-1', delay: 50 },
    { attempt: 2, msg: 'err-2', delay: 100 },
  ]);
});

test('worker policyNode handles empty JSON text on transient failure gracefully', async (t) => {
  const threadId = 'test-worker-empty-json-transient';
  let calls = 0;

  registerMockRuntime(
    threadId,
    {
      settings: async () => ({ provider: 'openai', model: 'gpt-4o-mini' } as any),
      llm: {
        complete: (async () => {
          calls++;
          if (calls === 1) {
            throw new Error('502 Bad Gateway');
          }
          return {
            text: JSON.stringify({ action: 'finish', answer: 'Success on retry' }),
          } as any;
        }) as any,
      },
    },
    t
  );

  const graph = buildWorkerGraph(new MemorySaver());
  const config = { configurable: { thread_id: threadId } };

  const out = await graph.invoke(
    {
      siteIn: {
        site: {
          id: 's1',
          name: 'Shop',
          domain: 'shop.test',
          startUrl: 'https://shop.test',
          goal: 'Find price',
          role: 'reference',
          kind: 'store',
          difficulty: 1,
        },
        index: 1,
        total: 1,
        task: 'Find price',
        tier: 'small',
        alloc: 10,
        runId: 'run-1',
      } as any,
    },
    config
  );

  assert.equal(calls, 2);
  assert.equal(out.siteRun?.criteriaMet, true);
});

test('orchestrator planNode retries transient errors and succeeds on second attempt', async (t) => {
  const threadId = 'test-orch-plan-retry-success';
  let planCalls = 0;

  registerMockRuntime(
    threadId,
    {
      settings: async () => ({ provider: 'openrouter', model: 'mock-model' } as any),
      llm: {
        complete: (async (req: any) => {
          if (req.node === 'plan') {
            planCalls++;
            if (planCalls === 1) {
              throw new Error('Rate limit exceeded 429');
            }
            return {
              text: JSON.stringify({
                sites: [{ name: 'Shop', domain: 'shop.test', startUrl: 'https://shop.test', goal: 'Find', role: 'primary', kind: 'store', difficulty: 1 }],
                summary: 'plan',
              }),
            } as any;
          }
          return { text: '{}' } as any;
        }) as any,
      },
    },
    t
  );

  const graph = buildOrchestratorGraph(new MemorySaver());
  const config = { configurable: { thread_id: threadId } };

  const out = await graph.invoke(
    {
      task: 'Find keyboard price',
    },
    config
  );

  assert.equal(planCalls, 2);
  assert.ok(out.planMeta?.sites && out.planMeta.sites.length > 0);
});
