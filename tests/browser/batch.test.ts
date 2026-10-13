import test from 'node:test';
import assert from 'node:assert/strict';
import { runBatch } from '../../src/background/browser/batch.ts';

test('runBatch - rejects empty steps array', async () => {
  const result = await runBatch(101, { steps: [] }, {
    dispatch: async () => ({ success: true }),
    currentUrl: async () => 'https://example.com',
  });

  assert.equal(result.success, false);
  assert.equal(result.completed, 0);
  assert.match(result.error || '', /non-empty "steps" array/);
});

test('runBatch - rejects more than 8 steps limit', async () => {
  const steps = Array.from({ length: 9 }, (_, i) => ({ action: 'click', element_id: i }));
  const result = await runBatch(101, { steps }, {
    dispatch: async () => ({ success: true }),
    currentUrl: async () => 'https://example.com',
  });

  assert.equal(result.success, false);
  assert.equal(result.total, 9);
  assert.match(result.error || '', /exceeds maximum allowed 8 steps limit/);
});

test('runBatch - rejects forbidden verbs immediately', async () => {
  const dispatched: any[] = [];
  const result = await runBatch(
    101,
    {
      steps: [
        { action: 'click', element_id: 1 },
        { action: 'navigate', url: 'https://evil.com' },
        { action: 'click', element_id: 2 },
      ],
    },
    {
      dispatch: async (_, p) => {
        dispatched.push(p);
        return { success: true };
      },
      currentUrl: async () => 'https://example.com',
    }
  );

  assert.equal(result.success, false);
  assert.equal(result.completed, 1);
  assert.equal(result.abortedAt, 1);
  assert.equal(dispatched.length, 1);
  assert.match(result.error || '', /forbidden inside browser_batch/);
});

test('runBatch - preserves shorthand target element ids such as { click: 12 }', async () => {
  const dispatched: any[] = [];
  const result = await runBatch(
    101,
    {
      steps: [
        { click: 12 },
        { type: 'hello', element_id: 15 },
        { scroll: 'down' },
      ],
    },
    {
      dispatch: async (_, p) => {
        dispatched.push(p);
        return { success: true };
      },
      currentUrl: async () => 'https://example.com',
    }
  );

  assert.equal(result.success, true);
  assert.equal(result.completed, 3);
  assert.equal(dispatched[0].action, 'click');
  assert.equal(dispatched[0].element_id, 12);
  assert.equal(dispatched[1].action, 'type');
  assert.equal(dispatched[1].element_id, 15);
  assert.equal(dispatched[2].action, 'scroll');
});

test('runBatch - stops on first error when stopOnError is true', async () => {
  const dispatched: any[] = [];
  const result = await runBatch(
    101,
    {
      steps: [
        { action: 'click', element_id: 1 },
        { action: 'click', element_id: 2 },
        { action: 'click', element_id: 3 },
      ],
      stopOnError: true,
    },
    {
      dispatch: async (_, p) => {
        dispatched.push(p);
        if (p.element_id === 2) {
          return { success: false, error: 'Element obscured' };
        }
        return { success: true };
      },
      currentUrl: async () => 'https://example.com',
    }
  );

  assert.equal(result.success, false);
  assert.equal(result.completed, 1);
  assert.equal(result.abortedAt, 1);
  assert.equal(dispatched.length, 2);
  assert.match(result.error || '', /Element obscured/);
});

test('runBatch - continues on error when stopOnError is false', async () => {
  const dispatched: any[] = [];
  const result = await runBatch(
    101,
    {
      steps: [
        { action: 'click', element_id: 1 },
        { action: 'click', element_id: 2 },
        { action: 'click', element_id: 3 },
      ],
      stopOnError: false,
    },
    {
      dispatch: async (_, p) => {
        dispatched.push(p);
        if (p.element_id === 2) {
          return { success: false, error: 'Element obscured' };
        }
        return { success: true };
      },
      currentUrl: async () => 'https://example.com',
    }
  );

  assert.equal(result.success, false);
  assert.equal(result.completed, 2);
  assert.equal(dispatched.length, 3);
  assert.equal(result.results.length, 3);
  assert.equal(result.results[1].ok, false);
  assert.equal(result.results[2].ok, true);
});

test('runBatch - aborts early when stopRequested or pauseRequested is set', async () => {
  const dispatched: any[] = [];
  let stopFlag = false;

  const result = await runBatch(
    101,
    {
      steps: [
        { action: 'click', element_id: 1 },
        { action: 'click', element_id: 2 },
      ],
    },
    {
      dispatch: async (_, p) => {
        dispatched.push(p);
        stopFlag = true;
        return { success: true };
      },
      currentUrl: async () => 'https://example.com',
      control: {
        get stopRequested() {
          return stopFlag;
        },
      },
    }
  );

  assert.equal(result.completed, 1);
  assert.equal(result.terminatedBy, 'stop');
  assert.equal(dispatched.length, 1);
});

test('runBatch - terminates early on unexpected page navigation', async () => {
  const dispatched: any[] = [];
  let current = 'https://example.com/step1';

  const result = await runBatch(
    101,
    {
      steps: [
        { action: 'click', element_id: 1 },
        { action: 'click', element_id: 2 },
      ],
    },
    {
      dispatch: async (_, p) => {
        dispatched.push(p);
        current = 'https://example.com/step2';
        return { success: true };
      },
      currentUrl: async () => current,
    }
  );

  assert.equal(result.completed, 1);
  assert.equal(result.terminatedBy, 'navigation');
  assert.equal(dispatched.length, 1);
});
