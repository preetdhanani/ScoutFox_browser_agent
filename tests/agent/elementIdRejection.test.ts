import test from 'node:test';
import assert from 'node:assert/strict';
import { MemorySaver } from '@langchain/langgraph/web';
import { buildWorkerGraph } from '../../src/background/graph/worker.ts';
import { registerMockRuntime } from '../helpers/mockRuntime.ts';
import { checkElementId, maxRef } from '../../src/background/agent/sanitize.ts';

test('a hallucinated element_id is never dispatched to the page and is corrected via retry', async (t) => {
  const threadId = 'test-hallucinated-element-id';
  let calls = 0;
  const dispatchedActions: any[] = [];
  const userPrompts: string[] = [];

  registerMockRuntime(
    threadId,
    {
      settings: async () => ({ provider: 'openrouter', model: 'mock-model' } as any),
      browser: {
        snapshot: async () => ({
          url: 'https://shop.test',
          title: 'Shop',
          pageText: 'Welcome to Shop',
          elementsText: '[1] <button> Home\n[2] <button> Search\n[3] <a> Details',
          refs: [1, 2, 3],
          shownRefs: [1, 2, 3],
          domain: 'shop.test',
          scrollState: { scrollY: 0, pageHeight: 1000, viewportHeight: 800 },
        }),
        execute: (async (_tabId: any, action: any) => {
          dispatchedActions.push(action);
          return {
            status: 'ok',
            effect: 'none',
            executed: [action],
            success: true,
            via: 'synthetic',
          } as any;
        }) as any,
      },
      llm: {
        complete: (async (req: any) => {
          calls++;
          userPrompts.push(req.messages[0].content);
          if (calls === 1) {
            // First attempt: hallucinated element id 99
            return {
              text: JSON.stringify({ action: 'click', element_id: 99, reason: 'hallucinated' }),
            } as any;
          }
          if (calls === 2) {
            // Second attempt: corrected element id 2
            return {
              text: JSON.stringify({ action: 'click', element_id: 2, reason: 'the real Search button' }),
            } as any;
          }
          // Third call finishes
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

  assert.equal(calls, 3, 'Model must be re-prompted after rejection, not given up on');

  // Verify that element_id 99 was never dispatched
  const dispatchedIds = dispatchedActions.map((a) => a.element_id);
  assert.ok(!dispatchedIds.includes(99), 'Hallucinated element_id 99 must never be dispatched to the browser');
  assert.ok(dispatchedIds.includes(2), 'Corrected element_id 2 must be dispatched');

  // Verify failed execution_result row with correction
  const failedExecResult = out.history?.find(
    (h) => h.type === 'execution_result' && h.success === false && /element.*\[99\]/i.test(h.error || '')
  );
  assert.ok(failedExecResult, 'Must produce a failed execution_result row naming element 99');

  // Verify prompt 2 contained the correction naming element 99
  assert.ok(userPrompts.length >= 2);
  assert.match(userPrompts[1], /Element \[99\] is not in the current element list/);
});

test('a hallucinated element_id in a browser_batch step is rejected before execution', async (t) => {
  const threadId = 'test-batch-hallucinated-element';
  let calls = 0;
  const dispatchedActions: any[] = [];

  registerMockRuntime(
    threadId,
    {
      settings: async () => ({ provider: 'openrouter', model: 'mock-model' } as any),
      browser: {
        snapshot: async () => ({
          url: 'https://shop.test',
          title: 'Shop',
          pageText: 'Welcome to Shop',
          elementsText: '[1] <input> Search\n[2] <button> Submit',
          refs: [1, 2],
          shownRefs: [1, 2],
          domain: 'shop.test',
          scrollState: { scrollY: 0, pageHeight: 1000, viewportHeight: 800 },
        }),
        execute: (async (_tabId: any, action: any) => {
          dispatchedActions.push(action);
          return { status: 'ok', effect: 'none', executed: [action], success: true, via: 'synthetic' } as any;
        }) as any,
      },
      llm: {
        complete: (async () => {
          calls++;
          if (calls === 1) {
            return {
              text: JSON.stringify({
                action: 'browser_batch',
                steps: [
                  { action: 'type', element_id: 1, text: 'shoes' },
                  { action: 'click', element_id: 99 },
                ],
              }),
            } as any;
          }
          return { text: JSON.stringify({ action: 'finish', answer: 'done' }) } as any;
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
          goal: 'Search shoes',
          role: 'reference',
          kind: 'store',
          difficulty: 1,
        },
        index: 1,
        total: 1,
        task: 'Search shoes',
        tier: 'large',
        alloc: 10,
        runId: 'run-1',
      } as any,
    },
    config
  );

  assert.equal(dispatchedActions.length, 0, 'No batch actions dispatched when any step references invalid element');
  const failedExecResult = out.history?.find(
    (h) => h.type === 'execution_result' && h.success === false && /Element \[99\]/i.test(h.error || '')
  );
  assert.ok(failedExecResult, 'Must record correction for invalid batch element ID');
});

test('checkElementId rejects negative numbers, zero, and non-integer values', () => {
  const refs = new Set([1, 2, 3]);

  assert.deepEqual(checkElementId(0, refs), { ok: false });
  assert.deepEqual(checkElementId(-1, refs), { ok: false });
  assert.deepEqual(checkElementId(2.5, refs), { ok: false });
  assert.deepEqual(checkElementId('2abc', refs), { ok: false });
  assert.deepEqual(checkElementId(NaN, refs), { ok: false });
  assert.deepEqual(checkElementId(Infinity, refs), { ok: false });
});

test('checkElementId accepts string digits and parses them as integer IDs', () => {
  const refs = new Set([1, 2, 5]);

  assert.deepEqual(checkElementId('2', refs), { ok: true, id: 2 });
  assert.deepEqual(checkElementId(' 5 ', refs), { ok: true, id: 5 });
  assert.deepEqual(checkElementId('99', refs), { ok: false });
});

test('checkElementId verifies membership against refs set when provided', () => {
  const refs = new Set([10, 20, 30]);

  assert.deepEqual(checkElementId(10, refs), { ok: true, id: 10 });
  assert.deepEqual(checkElementId(15, refs), { ok: false });
});

test('checkElementId accepts positive integers when refs set is omitted', () => {
  assert.deepEqual(checkElementId(42), { ok: true, id: 42 });
  assert.deepEqual(checkElementId(-5), { ok: false });
});

test('maxRef returns the largest ID in a refs set or 0 when empty/undefined', () => {
  assert.equal(maxRef(new Set([1, 8, 3, 42, 5])), 42);
  assert.equal(maxRef(new Set([])), 0);
  assert.equal(maxRef(undefined), 0);
});

test('a hallucinated element_id on type action is rejected without executing', async (t) => {
  const threadId = 'test-type-hallucinated-element';
  let calls = 0;
  const dispatched: any[] = [];

  registerMockRuntime(
    threadId,
    {
      settings: async () => ({ provider: 'openrouter', model: 'mock-model' } as any),
      browser: {
        snapshot: async () => ({
          url: 'https://shop.test',
          title: 'Shop',
          pageText: 'Shop',
          elementsText: '[1] <input> Search',
          refs: [1],
          shownRefs: [1],
          domain: 'shop.test',
          scrollState: { scrollY: 0, pageHeight: 1000, viewportHeight: 800 },
        }),
        execute: (async (_tabId: any, action: any) => {
          dispatched.push(action);
          return { status: 'ok', effect: 'none', executed: [action], success: true, via: 'synthetic' } as any;
        }) as any,
      },
      llm: {
        complete: (async () => {
          calls++;
          if (calls === 1) {
            return { text: JSON.stringify({ action: 'type', element_id: 88, text: 'laptop' }) } as any;
          }
          return { text: JSON.stringify({ action: 'finish', answer: 'done' }) } as any;
        }) as any,
      },
    },
    t
  );

  const graph = buildWorkerGraph(new MemorySaver());
  const config = { configurable: { thread_id: threadId } };

  await graph.invoke(
    {
      siteIn: {
        site: { id: 's1', name: 'Shop', domain: 'shop.test', startUrl: 'https://shop.test', goal: 'g', role: 'reference', kind: 'store', difficulty: 1 },
        index: 1, total: 1, task: 'g', tier: 'small', alloc: 5, runId: 'r1',
      } as any,
    },
    config
  );

  assert.equal(dispatched.length, 0);
  assert.equal(calls, 2);
});
