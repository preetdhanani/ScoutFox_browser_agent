/**
 * The content script entry points: src/content/actionExecutorEntry.ts and
 * src/content/domCompressorEntry.ts.
 *
 * These two files are what the browser actually injects. They do one thing: put the class and
 * a singleton on the page's window, so the background can reach them by name.
 *
 * The one rule that is easy to break and hard to notice: the injection must be SAFE TO REPEAT.
 * A content script can be injected more than once into the same page (a second injection, a
 * navigation back to a cached page, a frame that is re-attached). The second time must not build
 * a second executor: the page would then have two overlays, two listeners and two sets of
 * state, and the agent would act on whichever one the background happened to find.
 *
 * What these tests hold on to:
 *   1. The class and the singleton are on the window after the entry runs.
 *   2. The singleton is an instance of the class, and the legacy alias points at it.
 *   3. Running the entry again keeps the same singleton: it does not build a second one.
 *   4. The entry does nothing at all when there is no window.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { installGlobals } from '../helpers/contentGlobals.ts';

// The entry modules are imported with a query string, so the module cache is bypassed and the
// entry runs again against the same window. The specifier is built at runtime: TypeScript
// would try to resolve "?entry=1" as a file name and fail.
const EXECUTOR_ENTRY = new URL('../../src/content/actionExecutorEntry.ts', import.meta.url).href;
const COMPRESSOR_ENTRY = new URL('../../src/content/domCompressorEntry.ts', import.meta.url).href;

/** A window that records what was put on it. */
function fakeWindow() {
  return {} as Record<string, unknown>;
}

test('the action executor entry puts the class and a singleton on the window', async () => {
  const win = fakeWindow();
  const restore = installGlobals({ window: win });
  try {
    // The entry runs its side effect on import, so it is imported fresh for each test.
    await import(`${EXECUTOR_ENTRY}?entry=1`);
    const { ActionExecutor } = await import('../../src/content/actionExecutor.ts');

    assert.equal(win.ActionExecutor, ActionExecutor, 'the class is on the window');
    assert.ok(win.actionExecutorInstance, 'there is a singleton');
    assert.ok(win.actionExecutorInstance instanceof ActionExecutor, 'it is an ActionExecutor');
    assert.equal(win.actionExecutor, win.actionExecutorInstance, 'the legacy alias points at it');
  } finally {
    restore();
  }
});

test('the dom compressor entry puts the class and a singleton on the window', async () => {
  const win = fakeWindow();
  const restore = installGlobals({ window: win });
  try {
    await import(`${COMPRESSOR_ENTRY}?entry=1`);
    const { DOMCompressor } = await import('../../src/content/domCompressor.ts');

    assert.equal(win.DOMCompressor, DOMCompressor, 'the class is on the window');
    assert.ok(win.domCompressorInstance, 'there is a singleton');
    assert.ok(win.domCompressorInstance instanceof DOMCompressor, 'it is a DOMCompressor');
    assert.equal(win.domCompressor, win.domCompressorInstance, 'the alias points at it');
  } finally {
    restore();
  }
});

test('a second injection keeps the same singleton: it does not build a second one', async () => {
  const win = fakeWindow();
  const restore = installGlobals({ window: win });
  try {
    await import(`${EXECUTOR_ENTRY}?entry=twice`);
    const first = win.actionExecutorInstance;

    // The same entry, evaluated again against the SAME window. A fresh import would get a
    // fresh window, which proves nothing, so the module is re-evaluated with a cache-busting
    // query and the window it finds is the one above.
    await import(`${EXECUTOR_ENTRY}?entry=twice-again`);

    assert.ok(first, 'there was a singleton to begin with');
    assert.equal(win.actionExecutorInstance, first, 'the singleton is the same one');
  } finally {
    restore();
  }
});

test('the entries do nothing when there is no window', async () => {
  const restore = installGlobals({ window: undefined });
  try {
    // Neither entry may throw when there is no window (a worker, a test runner, a teardown).
    // The specifiers are built at runtime so the query string is not a path TypeScript tries
    // to resolve: the point of the query is to get a FRESH module, not a different file.
    await assert.doesNotReject(import(`${EXECUTOR_ENTRY}?entry=nowindow`));
    await assert.doesNotReject(import(`${COMPRESSOR_ENTRY}?entry=nowindow`));
  } finally {
    restore();
  }
});
