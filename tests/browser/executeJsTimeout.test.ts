import test from 'node:test';
import assert from 'node:assert/strict';
import { executeJs } from '../../src/background/browser/executeJs.ts';

/** A chrome.scripting whose executeScript never answers, after running `onCall`. */
function hangingChrome(onCall: () => void = () => {}) {
  let calls = 0;
  (globalThis as any).chrome = {
    scripting: {
      executeScript: () => {
        calls += 1;
        onCall();
        return new Promise(() => {});
      }
    }
  };
  return { calls: () => calls };
}

test('the timeout message names the timer that was actually used', async () => {
  const original = (globalThis as any).chrome;
  try {
    hangingChrome();
    const res = await executeJs(101, 'while(true){}', { timeoutMs: 30 });
    assert.equal(res.ok, false);
    assert.match(res.error || '', /timed out after 30ms/);
    assert.doesNotMatch(res.error || '', /5000ms/);
  } finally {
    (globalThis as any).chrome = original;
  }
});

test('a signal that aborts while the script is being injected is noticed, not left to the timer', async () => {
  const original = (globalThis as any).chrome;
  try {
    const controller = new AbortController();
    hangingChrome(() => controller.abort('user pressed stop'));
    const started = Date.now();
    const res = await executeJs(101, 'return 1', { timeoutMs: 2000, signal: controller.signal });
    assert.equal(res.ok, false);
    assert.match(res.error || '', /user pressed stop/);
    assert.ok(Date.now() - started < 1000, 'the abort ends the call, not the 2 s timer');
  } finally {
    (globalThis as any).chrome = original;
  }
});

test('an already-aborted signal is refused before anything is injected', async () => {
  const original = (globalThis as any).chrome;
  try {
    const controller = new AbortController();
    controller.abort();
    const chromeState = hangingChrome();
    const res = await executeJs(101, 'return 1', { timeoutMs: 2000, signal: controller.signal });
    assert.equal(res.ok, false);
    assert.equal(chromeState.calls(), 0, 'no script ran');
  } finally {
    (globalThis as any).chrome = original;
  }
});
