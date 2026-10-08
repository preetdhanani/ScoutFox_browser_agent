/**
 * The deadline and the abort of a model call (llm/deadline.ts), against a local server that answers slowly.
 *
 * Five real clients are covered: ChatOpenAICompletions (openai), ChatAnthropic, Gemini in streaming mode, ChatOllama
 * and AgentRouter (ChatAnthropic first). Each of them throws its own error when a request is aborted (the openai and
 * Anthropic SDKs throw APIUserAbortError, "Request was aborted."), so what is checked is what generateCompletion makes of it:
 *   - the deadline gives a ProviderTimeoutError, and it does NOT abort the task's own signal
 *   - a Pause or Stop (a signal aborted with the tagged reason) gives the fixed "cancelled" text, and is never
 *     mistaken for a timeout
 *   - any other abort of the task's signal comes back as that signal's own reason
 *   - in every case the request is REALLY cancelled: the server sees the client hang up
 *   - no timer and no listener is left behind, on any path
 * Then the same rules are checked on withDeadline alone, with a call that ignores its signal.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import {
  CANCELLED_BEFORE_DISPATCH_MESSAGE,
  CANCELLED_MESSAGE,
  ProviderTimeoutError,
  isUserAbort,
  userAbortReason,
  withDeadline
} from '../../src/background/llm/deadline.ts';
import { generateCompletion } from '../../src/background/llm/index.ts';
import type { LlmSettings } from '../../src/background/llm/types.ts';
import { redirectFetch, startSlowServer } from '../helpers/slowServer.ts';
import type { SlowServer } from '../helpers/slowServer.ts';

const MESSAGES = [{ role: 'user', content: 'hi' }];
const TIMEOUT_MS = 500;
/** The deadline text for TIMEOUT_MS, which rounds to one second. */
const timeoutText = (provider: string) =>
  `Provider [${provider}] did not respond within 1s. The request was abandoned - check that the provider is reachable, or raise llmTimeoutMs in settings.`;

const PROVIDERS = [
  { name: 'openai', host: null, settings: { provider: 'openai', apiKey: 'sk-test-123', model: 'gpt-4o-mini' } },
  { name: 'anthropic', host: 'https://api.anthropic.com', settings: { provider: 'anthropic', apiKey: 'sk-ant-test-123', model: 'claude-3-5-sonnet-20241022' } },
  { name: 'gemini', host: 'https://generativelanguage.googleapis.com', settings: { provider: 'gemini', apiKey: 'AIza-test-123', model: 'gemini-1.5-flash' } },
  { name: 'ollama', host: null, settings: { provider: 'ollama', model: 'qwen3.5:9b' } },
  { name: 'agent_router', host: null, settings: { provider: 'agent_router', apiKey: 'sk-test-123', model: 'claude-3-5-sonnet' } }
] as const;

interface Fixture {
  name: string;
  server: SlowServer;
  settings: LlmSettings;
}

/** One slow server per provider, and the providers with a fixed host pointed at theirs. */
async function fixtures(t: { after: (fn: () => void) => void }, options: { holdMs?: number } = {}): Promise<Fixture[]> {
  const list = await Promise.all(PROVIDERS.map(async (provider) => {
    const server = await startSlowServer(t, options);
    const settings: LlmSettings = { ...provider.settings, llmTimeoutMs: TIMEOUT_MS, ...(provider.host ? {} : { baseUrl: server.base }) };
    return { name: provider.name, host: provider.host, server, settings };
  }));
  redirectFetch(t, Object.fromEntries(list.flatMap((f) => (f.host ? [[f.host, f.server.base]] : []))));
  return list.map(({ name, server, settings }) => ({ name, server, settings }));
}

async function waitForRequest(server: SlowServer): Promise<void> {
  const start = Date.now();
  while (server.requests.length === 0) {
    if (Date.now() - start > 2000) throw new Error('the request never reached the server');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const failureOf = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error);

/**
 * Counts the timers of llm/deadline.ts that are set and not yet fired or cleared, while the test runs. Timers that
 * other code sets (the HTTP client keeps its own keep-alive timers) are not ours to clear, so they are not counted.
 */
function trackTimers(t: { after: (fn: () => void) => void }): Set<unknown> {
  const live = new Set<unknown>();
  const { setTimeout: realSet, clearTimeout: realClear } = globalThis;
  globalThis.setTimeout = ((callback: () => void, ms?: number, ...args: unknown[]) => {
    const handle = realSet(() => { live.delete(handle); callback(); }, ms, ...args);
    if (/llm\/deadline\.ts/.test(new Error().stack ?? '')) live.add(handle);
    return handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle: Parameters<typeof clearTimeout>[0]) => { live.delete(handle); realClear(handle); }) as typeof clearTimeout;
  t.after(() => { globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear; });
  return live;
}

// ---------------------------------------------------------------------------------------------
// Through the real chat models
// ---------------------------------------------------------------------------------------------

test('the deadline ends the call with ProviderTimeoutError, cancels the request, and leaves the task signal alone', async (t) => {
  const all = await fixtures(t);
  const started = Date.now();
  await Promise.all(all.map(async ({ name, server, settings }) => {
    const task = new AbortController();
    const error = await failureOf(generateCompletion(settings, MESSAGES, 'system', { signal: task.signal }));

    assert.ok(error instanceof ProviderTimeoutError, `${name}: got ${String(error)}`);
    assert.equal((error as Error).message, timeoutText(name));
    assert.doesNotMatch((error as Error).message, /abort/i, `${name}: the old engine reads "abort" in a text as a user Stop`);
    assert.equal(task.signal.aborted, false, `${name}: the deadline must not abort the task's own signal, the engine reads it to tell a Stop from a failure`);
    assert.equal(server.requests.length, 1, `${name}: one request, no retry`);
    await server.waitForHangUp(0);
  }));
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= TIMEOUT_MS - 50 && elapsed < 5000, `the deadline fired after ${elapsed} ms`);
});

test('the deadline works without a task signal too', async (t) => {
  const all = await fixtures(t);
  await Promise.all(all.map(async ({ name, server, settings }) => {
    const error = await failureOf(generateCompletion(settings, MESSAGES, 'system'));
    assert.ok(error instanceof ProviderTimeoutError, `${name}: got ${String(error)}`);
    await server.waitForHangUp(0);
  }));
});

test('a Stop or Pause (the tagged reason) gives the cancelled text, is not a timeout, and cancels the request', async (t) => {
  const all = await fixtures(t);
  const started = Date.now();
  await Promise.all(all.map(async ({ name, server, settings }) => {
    const task = new AbortController();
    const call = failureOf(generateCompletion({ ...settings, llmTimeoutMs: 30000 }, MESSAGES, 'system', { signal: task.signal }));
    await waitForRequest(server);
    task.abort(userAbortReason('stopped by user'));

    const error = await call;
    assert.ok(!(error instanceof ProviderTimeoutError), `${name}: a user abort is not a timeout`);
    assert.equal((error as Error).message, CANCELLED_MESSAGE, name);
    await server.waitForHangUp(0);
  }));
  assert.ok(Date.now() - started < 5000, 'the abort ended the calls at once, not at their 30 s deadline');
});

test('an abort that is not tagged as the user\'s comes back as its own reason, not as a timeout and not as a Stop', async (t) => {
  const all = await fixtures(t);
  await Promise.all(all.map(async ({ name, server, settings }) => {
    const task = new AbortController();
    const call = failureOf(generateCompletion({ ...settings, llmTimeoutMs: 30000 }, MESSAGES, 'system', { signal: task.signal }));
    await waitForRequest(server);
    const reason = new Error('the step timed out after 2s');
    task.abort(reason);

    const error = await call;
    assert.equal(error, reason, `${name}: the reason itself, so a caller can tell it from a user Stop by the tag`);
    await server.waitForHangUp(0);
  }));
});

test('a signal that is already aborted fails before any request is made', async (t) => {
  const all = await fixtures(t);
  for (const { name, server, settings } of all) {
    const stopped = new AbortController();
    stopped.abort(userAbortReason('paused by user'));
    const error = await failureOf(generateCompletion(settings, MESSAGES, 'system', { signal: stopped.signal }));
    assert.equal((error as Error).message, CANCELLED_BEFORE_DISPATCH_MESSAGE, name);

    const plain = new AbortController();
    plain.abort();
    assert.equal(await failureOf(generateCompletion(settings, MESSAGES, 'system', { signal: plain.signal })), plain.signal.reason, `${name}: an untagged abort is its own reason`);
    assert.equal(server.requests.length, 0, `${name}: nothing reached the server`);
  }
});

test('a reply that arrives in time is returned, and the deadline does not fire afterwards', async (t) => {
  const all = await fixtures(t, { holdMs: 20 });
  const task = new AbortController();
  await Promise.all(all.map(async ({ name, server, settings }) => {
    assert.equal(await generateCompletion(settings, MESSAGES, 'system', { signal: task.signal }), '{"action":"done"}', name);
    assert.equal(server.requests[0].answered, true, name);
    assert.equal(server.requests[0].hungUp, false, `${name}: nothing was cancelled`);
  }));
  await new Promise((resolve) => setTimeout(resolve, TIMEOUT_MS + 100));
  assert.equal(task.signal.aborted, false, 'the timer was cleared, so nothing fires after the call');
});

test('no timer and no listener is left behind on any path of a real call', async (t) => {
  const live = trackTimers(t);
  const before = live.size;
  const task = new AbortController();

  // The step signal is shared by every call of a task. Nothing may pile up on it.
  const listenersOnTask = () => getEventListeners(task.signal, 'abort').length;

  const fast = await fixtures(t, { holdMs: 0 });
  for (const { settings } of fast) await generateCompletion(settings, MESSAGES, 'system', { signal: task.signal });
  assert.equal(live.size, before, 'after replies: no timer left');
  assert.equal(listenersOnTask(), 0, 'after replies: no listener on the task signal');

  const slow = await fixtures(t);
  for (const { settings } of slow) {
    assert.ok(await failureOf(generateCompletion(settings, MESSAGES, 'system', { signal: task.signal })) instanceof ProviderTimeoutError);
  }
  assert.equal(live.size, before, 'after deadlines: no timer left');
  assert.equal(listenersOnTask(), 0, 'after deadlines: no listener on the task signal');

  for (const { server, settings } of slow) {
    const stopper = new AbortController();
    const call = failureOf(generateCompletion({ ...settings, llmTimeoutMs: 30000 }, MESSAGES, 'system', { signal: stopper.signal }));
    await waitForRequest(server);
    stopper.abort(userAbortReason('stopped by user'));
    await call;
    assert.equal(getEventListeners(stopper.signal, 'abort').length, 0, 'after a Stop: no listener on the aborted signal');
  }
  assert.equal(live.size, before, 'after Stops: no timer left (the 30 s deadline was cleared)');
});

// ---------------------------------------------------------------------------------------------
// withDeadline alone
// ---------------------------------------------------------------------------------------------

/** A call that never finishes and never looks at its signal, like a client that ignores the abort. */
const ignoresItsSignal = () => new Promise<string>(() => {});

test('withDeadline: control comes back at the deadline even when the call ignores its signal', async () => {
  const started = Date.now();
  const error = await failureOf(withDeadline({ provider: 'x', timeoutMs: 100 }, ignoresItsSignal));
  assert.ok(error instanceof ProviderTimeoutError);
  assert.ok(Date.now() - started < 1000);
});

test('withDeadline: control comes back at a Stop even when the call ignores its signal', async () => {
  const task = new AbortController();
  const call = failureOf(withDeadline({ provider: 'x', timeoutMs: 30000, signal: task.signal }, ignoresItsSignal));
  task.abort(userAbortReason('paused by user'));
  assert.equal(((await call) as Error).message, CANCELLED_MESSAGE);
});

test('withDeadline: after the deadline fired, the timeout error wins over whatever the SDK threw', async () => {
  // What the openai and Anthropic SDKs do on an abort: throw their own error, not the signal's reason.
  const sdkAbort = (signal: AbortSignal) => new Promise<string>((_, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('Request was aborted.'), { name: 'APIUserAbortError' })), { once: true });
  });
  const error = await failureOf(withDeadline({ provider: 'openai', timeoutMs: 50 }, sdkAbort));
  assert.ok(error instanceof ProviderTimeoutError);
  assert.equal((error as Error).message, timeoutText('openai').replace('1s', '0s'));

  // An error from the provider with nobody aborting is not touched.
  const boom = Object.assign(new Error('502 bad gateway'), { status: 502 });
  assert.equal(await failureOf(withDeadline({ provider: 'openai', timeoutMs: 1000 }, async () => { throw boom; })), boom);
});

test('withDeadline: the timer and its listener are gone after every outcome, and a shared signal does not collect listeners', async (t) => {
  const live = trackTimers(t);
  const before = live.size;
  const task = new AbortController();
  const signals: AbortSignal[] = [];
  const outcomes: Array<(signal: AbortSignal) => Promise<string>> = [
    async (signal) => { signals.push(signal); return 'ok'; },
    async (signal) => { signals.push(signal); throw new Error('provider failed'); },
    (signal) => { signals.push(signal); return new Promise<string>(() => {}); }
  ];
  for (let round = 0; round < 50; round++) {
    for (const [index, run] of outcomes.entries()) {
      // The third outcome never answers: it ends at its deadline.
      await failureOf(withDeadline({ provider: 'x', timeoutMs: index === 2 ? 5 : 1000, signal: task.signal }, run));
    }
  }
  assert.equal(live.size, before, 'no timer left after 150 calls');
  assert.equal(getEventListeners(task.signal, 'abort').length, 0, 'no listener on the shared task signal after 150 calls');
  assert.equal(signals.length, 150);
  for (const signal of signals) assert.equal(getEventListeners(signal, 'abort').length, 0, 'no listener of withDeadline on a call signal');

  const stopped = new AbortController();
  stopped.abort(userAbortReason('stopped by user'));
  await failureOf(withDeadline({ provider: 'x', timeoutMs: 1000, signal: stopped.signal }, async () => 'never runs'));
  assert.equal(live.size, before, 'a signal that was aborted before dispatch sets no timer at all');
});

test('withDeadline: a call that was never dispatched does not run', async () => {
  const stopped = new AbortController();
  stopped.abort(userAbortReason('paused by user'));
  let ran = false;
  const error = await failureOf(withDeadline({ provider: 'x', timeoutMs: 1000, signal: stopped.signal }, async () => { ran = true; return 'x'; }));
  assert.equal(((error) as Error).message, CANCELLED_BEFORE_DISPATCH_MESSAGE);
  assert.equal(ran, false);
});

// ---------------------------------------------------------------------------------------------
// The tag
// ---------------------------------------------------------------------------------------------

test('isUserAbort reads the tag on the reason, never the text of an error', () => {
  const live = new AbortController();
  assert.equal(isUserAbort(live.signal), false, 'not aborted');
  assert.equal(isUserAbort(null), false);
  assert.equal(isUserAbort(undefined), false);

  const user = new AbortController();
  user.abort(userAbortReason('paused by user'));
  assert.equal(isUserAbort(user.signal), true);
  assert.equal((user.signal.reason as { scoutfox?: string }).scoutfox, 'user');
  assert.equal((user.signal.reason as { name?: string }).name, 'AbortError', 'still an AbortError for code that checks the name');

  const plain = new AbortController();
  plain.abort();
  assert.equal(isUserAbort(plain.signal), false, 'a plain abort() is not the user\'s');

  const timeout = new AbortController();
  timeout.abort(new Error('The operation was aborted due to timeout'));
  assert.equal(isUserAbort(timeout.signal), false, 'a text that says "aborted" proves nothing');

  const wrongTag = new AbortController();
  wrongTag.abort({ scoutfox: 'system' });
  assert.equal(isUserAbort(wrongTag.signal), false);
});
