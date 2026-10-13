import test from 'node:test';
import assert from 'node:assert/strict';
import { MemorySaver } from '@langchain/langgraph/web';
import { buildWorkerGraph } from '../../src/background/graph/worker.ts';
import { registerMockRuntime } from '../helpers/mockRuntime.ts';

test('circuit breaker records parse error, performs 1000ms clock backoff, and sets pendingCorrection', async (t) => {
  const threadId = 'test-breaker-single-parse-error';
  const sleeps: number[] = [];

  registerMockRuntime(
    threadId,
    {
      settings: async () => ({ provider: 'openrouter', model: 'mock-model' } as any),
      clock: {
        now: () => Date.now(),
        sleep: async (ms: number) => {
          sleeps.push(ms);
        },
      },
      llm: {
        complete: (async () => ({
          text: 'invalid non-json response that cannot be parsed',
        } as any)) as any,
      },
    },
    t
  );

  const graph = buildWorkerGraph(new MemorySaver());
  const config = { configurable: { thread_id: threadId } };

  // Run one step to trigger perceive and policy
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

  assert.ok(sleeps.includes(1000), 'Breaker must backoff 1000ms on runtime clock');
  assert.equal(out.siteRun?.consecutiveParseErrors, 3, 'Loop stops after 3 parse errors');
  assert.equal(out.siteRun?.everParsedOk, undefined);
  assert.equal(out.siteRun?.exit?.fatal, 'model_unusable');
});

test('circuit breaker trips modelUnusable when 3 consecutive parse errors occur before any good parse', async (t) => {
  const threadId = 'test-breaker-unusable';
  let calls = 0;
  const sleeps: number[] = [];

  registerMockRuntime(
    threadId,
    {
      settings: async () => ({ provider: 'ollama', model: 'deepseek-r1:8b' } as any),
      clock: {
        now: () => Date.now(),
        sleep: async (ms: number) => {
          sleeps.push(ms);
        },
      },
      llm: {
        complete: (async () => {
          calls++;
          return { text: 'malformed output' } as any;
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
  assert.equal(out.siteRun?.consecutiveParseErrors, 3);
  assert.equal(out.siteRun?.exit?.fatal, 'model_unusable');
  assert.equal(out.siteRun?.exit?.status, 'failed');

  const stopError: any = out.history?.find((h) => h.type === 'error' && /Stopped early/i.test((h as any).content));
  assert.ok(stopError, 'Must record Stopped early error row');
  assert.match(stopError.content, /deepseek-r1:8b/);
  assert.match(stopError.content, /failed to produce a usable action 3 times in a row/);
});

test('circuit breaker resets consecutiveParseErrors to 0 and clears pendingCorrection after a good parse', async (t) => {
  const threadId = 'test-breaker-recovery';
  let calls = 0;
  const userMessages: string[] = [];

  registerMockRuntime(
    threadId,
    {
      settings: async () => ({ provider: 'openrouter', model: 'mock-model' } as any),
      llm: {
        complete: (async (req: any) => {
          calls++;
          userMessages.push(req.messages[0].content);
          if (calls === 1) {
            return { text: '{"action": "unknown_verb"}' } as any;
          }
          return { text: '{"action": "finish", "answer": "The item costs 1.599 EUR"}' } as any;
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
  assert.equal(out.siteRun?.consecutiveParseErrors, 0);
  assert.equal(out.siteRun?.everParsedOk, true);
  assert.equal(out.pendingCorrection, null);
  assert.equal(out.siteRun?.criteriaMet, true);
  assert.equal(out.siteRun?.exit?.status, 'done');

  // Verify correction was delivered to prompt 2
  assert.ok(userMessages.length >= 2);
  assert.match(userMessages[1], /Unknown action "unknown_verb"/);
});

test('circuit breaker closes site without modelUnusable when 3 parse errors occur after site had parsed ok', async (t) => {
  const threadId = 'test-breaker-close-site';
  let calls = 0;

  registerMockRuntime(
    threadId,
    {
      settings: async () => ({ provider: 'openrouter', model: 'mock-model' } as any),
      llm: {
        complete: (async () => {
          calls++;
          if (calls === 1) {
            // First call succeeds
            return { text: '{"action": "scroll", "direction": "down"}' } as any;
          }
          // Subsequent calls fail to parse
          return { text: 'gibberish non-json' } as any;
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

  assert.equal(calls, 4); // 1 good + 3 parse errors
  assert.equal(out.siteRun?.everParsedOk, true);
  assert.equal(out.siteRun?.exit?.fatal, undefined, 'Must not be fatal modelUnusable');
  assert.equal(out.siteRun?.exit?.status, 'failed');
  assert.match(out.siteRun?.exit?.reason ?? '', /Too many consecutive rejected replies \(3\)/);
});

test('circuit breaker handles empty response string as parse error', async (t) => {
  const threadId = 'test-breaker-empty-response';
  let calls = 0;

  registerMockRuntime(
    threadId,
    {
      settings: async () => ({ provider: 'ollama', model: 'qwen3.5:9b' } as any),
      llm: {
        complete: (async () => {
          calls++;
          return { text: '' } as any;
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
  assert.equal(out.siteRun?.consecutiveParseErrors, 3);
  assert.equal(out.siteRun?.exit?.fatal, 'model_unusable');
  const errEntry = out.history?.find((h) => h.type === 'error');
  assert.ok(errEntry);
  assert.match(errEntry.content, /qwen3\.5:9b/);
});

test('circuit breaker recovers if valid action is returned on the third attempt', async (t) => {
  const threadId = 'test-breaker-recovery-attempt-3';
  let calls = 0;

  registerMockRuntime(
    threadId,
    {
      settings: async () => ({ provider: 'openrouter', model: 'mock-model' } as any),
      llm: {
        complete: (async () => {
          calls++;
          if (calls < 3) return { text: 'bad json' } as any;
          return { text: '{"action":"finish","answer":"Recovered on 3rd"}' } as any;
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
  assert.equal(out.siteRun?.consecutiveParseErrors, 0);
  assert.equal(out.siteRun?.everParsedOk, true);
  assert.equal(out.siteRun?.criteriaMet, true);
});

test('circuit breaker handles non-object JSON (array of primitives) as parse error', async (t) => {
  const threadId = 'test-breaker-array-json';
  let calls = 0;

  registerMockRuntime(
    threadId,
    {
      settings: async () => ({ provider: 'ollama', model: 'mistral:7b' } as any),
      llm: {
        complete: (async () => {
          calls++;
          return { text: '["one", "two", "three"]' } as any;
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
  assert.equal(out.siteRun?.exit?.fatal, 'model_unusable');
});

test('circuit breaker treats unknown action verbs as parse errors', async (t) => {
  const threadId = 'test-breaker-unknown-verb';
  let calls = 0;

  registerMockRuntime(
    threadId,
    {
      settings: async () => ({ provider: 'ollama', model: 'llama3:8b' } as any),
      llm: {
        complete: (async () => {
          calls++;
          return { text: '{"action":"magic_spell","target":1}' } as any;
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
  assert.equal(out.siteRun?.consecutiveParseErrors, 3);
});

test('circuit breaker accumulates 1000ms sleep on each consecutive parse error', async (t) => {
  const threadId = 'test-breaker-sleep-accum';
  const sleeps: number[] = [];

  registerMockRuntime(
    threadId,
    {
      settings: async () => ({ provider: 'ollama', model: 'test' } as any),
      clock: {
        now: () => Date.now(),
        sleep: async (ms: number) => { sleeps.push(ms); },
      },
      llm: {
        complete: (async () => ({ text: 'bad' } as any)) as any,
      },
    },
    t
  );

  const graph = buildWorkerGraph(new MemorySaver());
  const config = { configurable: { thread_id: threadId } };

  await graph.invoke(
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

  assert.ok(sleeps.length >= 2);
  assert.ok(sleeps.every((ms) => ms === 1000));
});

test('circuit breaker passes pendingCorrection detailing missing action field', async (t) => {
  const threadId = 'test-breaker-pending-corr';
  let calls = 0;
  const prompts: string[] = [];

  registerMockRuntime(
    threadId,
    {
      settings: async () => ({ provider: 'openrouter', model: 'mock' } as any),
      llm: {
        complete: (async (req: any) => {
          calls++;
          prompts.push(req.messages[0].content);
          if (calls === 1) return { text: '{"foo":"bar"}' } as any;
          return { text: '{"action":"finish","answer":"done"}' } as any;
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
  assert.ok(prompts.length >= 2);
  assert.match(prompts[1], /Your reply was not an action/i);
});

test('circuit breaker handles truncated JSON in markdown code fence', async (t) => {
  const threadId = 'test-breaker-truncated-fence';
  let calls = 0;

  registerMockRuntime(
    threadId,
    {
      settings: async () => ({ provider: 'ollama', model: 'qwen2.5:7b' } as any),
      llm: {
        complete: (async () => {
          calls++;
          return { text: '```json\n{"action":"click", "element_id":\n' } as any;
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
  assert.equal(out.siteRun?.consecutiveParseErrors, 3);
});

test('circuit breaker does not increment step counter on parse errors', async (t) => {
  const threadId = 'test-breaker-no-step-increment';

  registerMockRuntime(
    threadId,
    {
      settings: async () => ({ provider: 'openrouter', model: 'mock' } as any),
      llm: {
        complete: (async () => ({ text: 'bad json' } as any)) as any,
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

  assert.equal(out.siteRun?.used ?? 0, 0, 'Parse error must not burn step allocation');
});

test('circuit breaker handles boolean JSON output as parse error', async (t) => {
  const threadId = 'test-breaker-boolean-json';
  let calls = 0;

  registerMockRuntime(
    threadId,
    {
      settings: async () => ({ provider: 'openrouter', model: 'mock' } as any),
      llm: {
        complete: (async () => {
          calls++;
          return { text: 'true' } as any;
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
  assert.equal(out.siteRun?.consecutiveParseErrors, 3);
});

test('circuit breaker handles primitive number output as parse error', async (t) => {
  const threadId = 'test-breaker-number-json';
  let calls = 0;

  registerMockRuntime(
    threadId,
    {
      settings: async () => ({ provider: 'openrouter', model: 'mock' } as any),
      llm: {
        complete: (async () => {
          calls++;
          return { text: '42' } as any;
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
  assert.equal(out.siteRun?.consecutiveParseErrors, 3);
});
