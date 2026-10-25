/**
 * The DOM quietness wait: waitForDomQuiet in src/content/domQuiet.ts.
 *
 * Between two actions the page has to settle, or the next action reads a page that is still
 * changing and acts on the wrong thing. The wait has two ends: it ends when the page has been
 * quiet for a while, and it ends at a ceiling no matter what, so a page that never stops
 * changing cannot hang the run.
 *
 * What these tests hold on to:
 *   1. A page that does not change resolves after the quiet window.
 *   2. A change restarts the wait: the page is not quiet until it has been still for the whole
 *      window.
 *   3. The ceiling holds: a page that changes forever still resolves, and does not hang.
 *   4. A document with no body, or no MutationObserver, still resolves.
 *   5. The observer is disconnected when the wait ends, so nothing keeps watching the page.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { waitForDomQuiet } from '../../src/content/domQuiet.ts';
import { withGlobals } from '../helpers/contentGlobals.ts';

/** A MutationObserver that records what it watched and whether it was disconnected. */
class FakeMutationObserver {
  static instances: FakeMutationObserver[] = [];
  observed: { target: any; options: any } | null = null;
  disconnected = false;
  private callback: () => void;

  constructor(callback: () => void) {
    this.callback = callback;
    FakeMutationObserver.instances.push(this);
  }

  observe(target: any, options: any) {
    this.observed = { target, options };
  }

  disconnect() {
    this.disconnected = true;
  }

  /** The page changed. */
  fire() {
    this.callback();
  }
}

function fakeDoc(withBody = true) {
  return {
    body: withBody ? { tagName: 'BODY' } : null
  } as unknown as Document;
}

/**
 * Awaits the wait, but gives up after a hard deadline.
 *
 * The ceiling is the thing under test, so a wait that never ends must FAIL, not hang the whole
 * suite: a hanging test tells nobody what went wrong and stops every other test from running.
 */
async function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not end within ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test('a page that does not change resolves after the quiet window', async () => {
  FakeMutationObserver.instances = [];
  const started = Date.now();

  await withGlobals({ MutationObserver: FakeMutationObserver }, () =>
    waitForDomQuiet(60, 2000, fakeDoc())
  );

  assert.ok(Date.now() - started >= 55, 'it waited for the quiet window');
  assert.equal(FakeMutationObserver.instances.length, 1, 'the page was watched');
  assert.ok(FakeMutationObserver.instances[0].observed, 'the body was observed');
});

test('a change restarts the wait: the page is not quiet until it has been still', async () => {
  FakeMutationObserver.instances = [];
  const started = Date.now();

  await withGlobals({ MutationObserver: FakeMutationObserver }, async () => {
    const done = waitForDomQuiet(80, 3000, fakeDoc());
    // The page changes twice, each time well inside the quiet window.
    setTimeout(() => FakeMutationObserver.instances[0].fire(), 30);
    setTimeout(() => FakeMutationObserver.instances[0].fire(), 70);
    await done;
  });

  const elapsed = Date.now() - started;
  // The last change was at ~70ms, so the wait cannot have ended before ~150ms.
  assert.ok(elapsed >= 140, `the wait restarted on the change (it took ${elapsed}ms)`);
});

test('the ceiling holds: a page that changes forever still resolves', async () => {
  FakeMutationObserver.instances = [];

  await withGlobals({ MutationObserver: FakeMutationObserver }, async () => {
    const done = waitForDomQuiet(1000, 120, fakeDoc());
    // A page that never stops changing: a change every 20ms, well past the ceiling.
    const spam = setInterval(() => FakeMutationObserver.instances[0]?.fire(), 20);
    try {
      // The ceiling is 120ms, so the wait must end long before the 2000ms deadline. Without a
      // ceiling this never ends, and the deadline turns that into a failure instead of a hang.
      await withDeadline(done, 2000, 'the wait');
    } finally {
      clearInterval(spam);
    }
  });
  // Reaching here is the assertion: the wait resolved instead of hanging.
  assert.ok(true, 'the wait resolved at the ceiling');
});

test('a document with no body still resolves, it does not hang', async () => {
  FakeMutationObserver.instances = [];
  const started = Date.now();

  await withGlobals({ MutationObserver: FakeMutationObserver }, () =>
    waitForDomQuiet(40, 2000, fakeDoc(false))
  );

  assert.ok(Date.now() - started >= 35, 'it waited for the quiet window');
});

test('a browser with no MutationObserver still resolves, it does not hang', async () => {
  const started = Date.now();

  await withGlobals({ MutationObserver: undefined }, () =>
    waitForDomQuiet(40, 2000, fakeDoc())
  );

  assert.ok(Date.now() - started >= 35, 'it waited for the quiet window');
});

test('the observer is disconnected when the wait ends', async () => {
  FakeMutationObserver.instances = [];

  await withGlobals({ MutationObserver: FakeMutationObserver }, () =>
    waitForDomQuiet(30, 2000, fakeDoc())
  );

  assert.equal(FakeMutationObserver.instances.length, 1);
  assert.equal(FakeMutationObserver.instances[0].disconnected, true, 'the page is not watched any more');
});

test('the observer is disconnected when the ceiling ends the wait too', async () => {
  FakeMutationObserver.instances = [];

  await withGlobals({ MutationObserver: FakeMutationObserver }, async () => {
    const done = waitForDomQuiet(5000, 60, fakeDoc());
    const spam = setInterval(() => FakeMutationObserver.instances[0]?.fire(), 20);
    try {
      await withDeadline(done, 2000, 'the wait');
    } finally {
      clearInterval(spam);
    }
  });

  assert.equal(FakeMutationObserver.instances[0].disconnected, true, 'the page is not watched any more');
});
