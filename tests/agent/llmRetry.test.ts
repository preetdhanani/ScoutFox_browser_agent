import test from 'node:test';
import assert from 'node:assert/strict';
import { MemorySaver } from '@langchain/langgraph/web';
import { callWithRetry } from '../../src/background/agent/recovery.ts';
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

  assert.equal(calls, 3);
  assert.equal(out.pendingHold?.kind, 'paused');
  assert.equal(out.pendingHold?.reason, 'llm_failure');

  const errRow = out.history?.find((h) => h.type === 'error');
  assert.ok(errRow);
  assert.match(errRow.content, /LLM Connection Error \(groq\)/);
  assert.match(errRow.content, /after 3 attempts/);
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

  assert.equal(calls, 3);
  assert.equal(out.pendingHold?.kind, 'paused');
  assert.equal(out.pendingHold?.reason, 'llm_failure');
  assert.equal(out.resumeRoute, 'plan');

  const errRow = out.history?.find((h) => h.type === 'error');
  assert.ok(errRow);
  assert.match(errRow.content, /LLM Connection Error \(nvidia\)/);
  assert.match(errRow.content, /after 3 attempts/);
  assert.match(errRow.content, /Task paused at step 0 - click Resume to try again/);
});

test('callWithRetry uses linear delay: baseDelayMs * attempt', async () => {
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
          sleep: fakeSleep,
        }
      );
    },
    /fail 4/
  );

  assert.deepEqual(delays, [100, 200, 300]);
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
