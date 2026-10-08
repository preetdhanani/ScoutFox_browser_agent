/**
 * Pause and Stop against a model that never answers, for every provider.
 *
 * The user presses Pause while a call is in flight. The engine aborts the step signal with a reason tagged
 * { scoutfox: 'user' }, and generateCompletion has to reject at once with the fixed text, and really cancel the
 * request (the server sees the client hang up), for each of the seven providers. Without that, Pause would look
 * like a hang for as long as the model takes, or, for ChatOllama, like an empty reply that the parser rejects
 * (its own abort is broken: docs/langgraph-design.md, "Early check results").
 *
 * Every provider gets a local server that accepts the request and never answers. openrouter, anthropic and gemini
 * talk to fixed hosts, so a fetch spy sends those hosts to the server. The limit is 2 seconds, and the calls have
 * a 30 s deadline, so only the abort can end them in time.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Logger } from '../../src/shared/logger.ts';
import { CANCELLED_MESSAGE, userAbortReason } from '../../src/background/llm/deadline.ts';
import { generateCompletion } from '../../src/background/llm/index.ts';
import type { LlmSettings } from '../../src/background/llm/types.ts';
import { hangUntilAborted, spyFetch, waitForRequests } from '../helpers/llmWire.ts';
import { redirectFetch, startSlowServer } from '../helpers/slowServer.ts';
import type { SlowServer } from '../helpers/slowServer.ts';

const MESSAGES = [{ role: 'user', content: 'hi' }];
const LIMIT_MS = 2000;

type T = { after: (fn: () => void) => void };

const PROVIDERS = [
  { name: 'ollama', host: null, settings: { provider: 'ollama', model: 'qwen3.5:9b' } },
  { name: 'openai', host: null, settings: { provider: 'openai', apiKey: 'sk-test-123', model: 'gpt-4o-mini' } },
  { name: 'openai_compatible', host: null, settings: { provider: 'openai_compatible', model: 'llama-3.3-70b-versatile' } },
  { name: 'agent_router', host: null, settings: { provider: 'agent_router', apiKey: 'sk-test-123', model: 'claude-3-5-sonnet' } },
  { name: 'openrouter', host: 'https://openrouter.ai', settings: { provider: 'openrouter', apiKey: 'sk-or-test-123', model: 'anthropic/claude-3.5-sonnet' } },
  { name: 'anthropic', host: 'https://api.anthropic.com', settings: { provider: 'anthropic', apiKey: 'sk-ant-test-123', model: 'claude-3-5-sonnet-20241022' } },
  { name: 'gemini', host: 'https://generativelanguage.googleapis.com', settings: { provider: 'gemini', apiKey: 'AIza-test-123', model: 'gemini-1.5-flash' } },
  { name: 'nvidia', host: 'https://integrate.api.nvidia.com', settings: { provider: 'nvidia', apiKey: 'nvapi-test-123', model: 'meta/llama-3.3-70b-instruct' } }
] as const;

/** A server for one provider, and the settings that lead the provider to it. */
async function serverFor(t: T, provider: (typeof PROVIDERS)[number], options: { stallAfterFirstChunk?: boolean } = {}): Promise<{ server: SlowServer; settings: LlmSettings }> {
  const server = await startSlowServer(t, options);
  if (provider.host) redirectFetch(t, { [provider.host]: server.base });
  return { server, settings: { ...provider.settings, llmTimeoutMs: 30000, ...(provider.host ? {} : { baseUrl: server.base }) } };
}

async function waitForRequest(server: SlowServer, settleMs = 0): Promise<void> {
  const start = Date.now();
  while (server.requests.length === 0) {
    if (Date.now() - start > 2000) throw new Error('the request never reached the server');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (settleMs) await new Promise((resolve) => setTimeout(resolve, settleMs));
}

/** Aborts the way the engine's pause() and stop() do, and returns how the call ended and how long that took. */
async function abortAndTime(call: Promise<unknown>, task: AbortController, why: string) {
  const abortedAt = Date.now();
  task.abort(userAbortReason(why));
  const error = await call.then(() => null, (e: unknown) => e);
  return { error: error as Error | null, ms: Date.now() - abortedAt };
}

for (const provider of PROVIDERS) {
  for (const why of ['paused by user', 'stopped by user']) {
    test(`${provider.name}: ${why} while the model has not answered rejects at once with the cancelled text and cancels the request`, async (t) => {
      const { server, settings } = await serverFor(t, provider);
      const task = new AbortController();
      const call = generateCompletion(settings, MESSAGES, 'system', { signal: task.signal });
      call.catch(() => {});
      await waitForRequest(server);

      const { error, ms } = await abortAndTime(call, task, why);
      assert.ok(error, 'the call rejected');
      assert.equal(error.message, CANCELLED_MESSAGE);
      assert.ok(ms < LIMIT_MS, `rejected ${ms} ms after the abort`);
      await server.waitForHangUp(0);
    });
  }
}

// ChatOllama streams. Its own abort is broken: it looks at the signal between two chunks and then ends the stream
// without an error, so an abort that comes after the reply began must not hand back what has arrived so far as if it
// were the whole answer. (Gemini streams too, but its SDK leaves a rejected promise that nobody awaits when a stream
// is cut halfway, which Node's test runner reports as a failure of the test. That is in the open issues of P2-3.)
test('ollama: a Pause after the reply began to stream rejects, and does not return the first piece', async (t) => {
  const { server, settings } = await serverFor(t, PROVIDERS.find((p) => p.name === 'ollama')!, { stallAfterFirstChunk: true });
  const task = new AbortController();
  const call = generateCompletion(settings, MESSAGES, 'system', { signal: task.signal });
  call.catch(() => {});
  await waitForRequest(server, 150);

  const { error, ms } = await abortAndTime(call, task, 'paused by user');
  assert.ok(error, 'a cancelled call is not a short reply');
  assert.equal(error.message, CANCELLED_MESSAGE);
  assert.ok(ms < LIMIT_MS, `rejected ${ms} ms after the abort`);
  await server.waitForHangUp(0);
});

test('agent_router: a Pause during the fallback request cancels that request too, and starts no other', async (t) => {
  const task = new AbortController();
  const sent = spyFetch(t, (request) => (request.url.endsWith('/messages') ? new Response('overloaded', { status: 529 }) : hangUntilAborted(request)));
  const call = generateCompletion({ provider: 'agent_router', apiKey: 'sk-test-123', llmTimeoutMs: 30000 }, MESSAGES, 'system', { signal: task.signal });
  call.catch(() => {});
  await waitForRequests(sent, 2);
  assert.match(sent[1].url, /\/v1\/chat\/completions$/, 'the second request is the fallback');

  const { error, ms } = await abortAndTime(call, task, 'paused by user');
  assert.equal(error?.message, CANCELLED_MESSAGE);
  assert.ok(ms < LIMIT_MS, `rejected ${ms} ms after the abort`);
  assert.equal(sent[1].signal!.aborted, true, 'the fallback request itself was cancelled');
  assert.equal(sent.length, 2, 'nothing else was sent after the abort');
});

// A cancelled call is reported once, by generateCompletion, as [NETWORK_ABORTED] (a warning). The provider modules used to
// add an ERROR line of their own, "Failed request to ..." (for Ollama "Cannot connect to Ollama ... Details: The task was
// paused by user."), that contradicted the text that is thrown and went into the persisted logs and the bug reports.
for (const provider of PROVIDERS) {
  for (const cause of ['a Pause', 'the deadline'] as const) {
    test(`${provider.name}: ${cause} is logged once as [NETWORK_ABORTED] and never as an ERROR`, async (t) => {
      const sent = spyFetch(t, hangUntilAborted);
      const task = new AbortController();
      const from = Logger.getLogsHistory().length;
      const call = generateCompletion({ ...provider.settings, llmTimeoutMs: cause === 'the deadline' ? 100 : 30000 }, MESSAGES, 'system', { signal: task.signal });
      call.catch(() => {});
      await waitForRequests(sent);
      if (cause === 'a Pause') task.abort(userAbortReason('paused by user'));
      await assert.rejects(call);

      const lines = Logger.getLogsHistory().slice(from).map((entry) => `${entry.level} ${entry.module} ${entry.message}`);
      assert.deepEqual(lines.filter((line) => /^ERROR/.test(line)), [], 'no ERROR line');
      assert.equal(lines.filter((line) => /\[NETWORK_ABORTED\]/.test(line)).length, 1, lines.join('\n'));
    });
  }
}
