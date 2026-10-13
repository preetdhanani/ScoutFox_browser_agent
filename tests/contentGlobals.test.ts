import test from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals, withGlobals } from './helpers/contentGlobals.ts';

test('installGlobals installs new properties and restore deletes them', () => {
  const propName = '__sf_test_nonexistent_prop__';
  assert.equal(propName in globalThis, false);

  const restore = installGlobals({ [propName]: 42 });
  assert.equal((globalThis as Record<string, unknown>)[propName], 42);

  restore();
  assert.equal(propName in globalThis, false);
});

test('installGlobals preserves and restores pre-existing descriptors and values', () => {
  const propName = '__sf_test_existing_prop__';
  Object.defineProperty(globalThis, propName, {
    value: 'original',
    writable: true,
    configurable: true,
    enumerable: false
  });

  const originalDesc = Object.getOwnPropertyDescriptor(globalThis, propName);
  assert.equal(originalDesc?.enumerable, false);

  const restore = installGlobals({ [propName]: 'overridden' });
  assert.equal((globalThis as Record<string, unknown>)[propName], 'overridden');

  restore();
  assert.equal((globalThis as Record<string, unknown>)[propName], 'original');
  const restoredDesc = Object.getOwnPropertyDescriptor(globalThis, propName);
  assert.equal(restoredDesc?.enumerable, false);

  delete (globalThis as Record<string, unknown>)[propName];
});

test('withGlobals executes synchronously and cleans up, even on error', () => {
  const propName = '__sf_test_sync_prop__';

  const res = withGlobals({ [propName]: 'syncVal' }, () => {
    assert.equal((globalThis as Record<string, unknown>)[propName], 'syncVal');
    return 'done';
  });
  assert.equal(res, 'done');
  assert.equal(propName in globalThis, false);

  assert.throws(() => {
    withGlobals({ [propName]: 'errVal' }, () => {
      assert.equal((globalThis as Record<string, unknown>)[propName], 'errVal');
      throw new Error('sync explosion');
    });
  }, /sync explosion/);
  assert.equal(propName in globalThis, false);
});

test('withGlobals executes asynchronously and cleans up on resolve and reject', async () => {
  const propName = '__sf_test_async_prop__';

  const res = await withGlobals({ [propName]: 'asyncVal' }, async () => {
    await new Promise((r) => setTimeout(r, 5));
    assert.equal((globalThis as Record<string, unknown>)[propName], 'asyncVal');
    return 'asyncDone';
  });
  assert.equal(res, 'asyncDone');
  assert.equal(propName in globalThis, false);

  await assert.rejects(
    () => withGlobals({ [propName]: 'asyncErrVal' }, async () => {
      await new Promise((r) => setTimeout(r, 5));
      assert.equal((globalThis as Record<string, unknown>)[propName], 'asyncErrVal');
      throw new Error('async explosion');
    }),
    /async explosion/
  );
  assert.equal(propName in globalThis, false);
});

test('installGlobals restore function is idempotent', () => {
  const propName = '__sf_test_idempotent_prop__';
  const restore = installGlobals({ [propName]: 'test' });
  assert.equal((globalThis as Record<string, unknown>)[propName], 'test');

  restore();
  assert.equal(propName in globalThis, false);
  assert.doesNotThrow(() => restore());
  assert.equal(propName in globalThis, false);
});
