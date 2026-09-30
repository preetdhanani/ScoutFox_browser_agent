/**
 * The API key never leaves the llm layer except on the wire to its own provider.
 *
 * The error texts of errors.ts are scrubbed since P2-2, and the Logger lines are made of those texts. What this file
 * adds is the other exit: the callbacks. `config.callbacks` goes into model.invoke for opt-in tracing (LangSmith), and
 * LangChain hands the callbacks the whole model (`handleChatModelStart`: its kwargs, its call options), every
 * message and every error, unchanged. A tracer posts all of that to a server. So a key must not be in the options of a
 * model (AgentRouter's wire image, which carries the key, used to be in defaultHeaders and in the call's headers), and
 * an error must not carry a key that the server echoed back in its body (the SDK builds its message from that body).
 *
 * The server here echoes the headers it got, which is the worst case, on every provider and for every kind of answer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { LangChainTracer } from '@langchain/core/tracers/tracer_langchain';
import { awaitAllCallbacks } from '@langchain/core/callbacks/promises';
import { Client } from 'langsmith';
import { generateCompletion } from '../../src/background/llm/index.ts';
import type { LlmSettings } from '../../src/background/llm/types.ts';
import { installFetch, jsonResponse, textReply } from '../helpers/llmWire.ts';

const KEY = 'FAKEKEY-SECRET-0123456789abcdef';
const MESSAGES = [{ role: 'user', content: 'hi' }];

type T = { after: (fn: () => void) => void };
type Mode = 'ok' | 'http 401' | 'http 500' | 'network';

const PROVIDERS: Array<[string, LlmSettings]> = [
  ['openai', { provider: 'openai', apiKey: KEY }],
  ['openai_compatible', { provider: 'openai_compatible', apiKey: KEY }],
  ['openrouter', { provider: 'openrouter', apiKey: KEY }],
  ['anthropic', { provider: 'anthropic', apiKey: KEY }],
  ['gemini', { provider: 'gemini', apiKey: KEY }],
  ['agent_router', { provider: 'agent_router', apiKey: KEY }]
];

/** Every value that a callback was given, as text. Errors and headers do not serialize by themselves, so they are opened up. */
function textOf(value: unknown): string {
  const seen = new WeakSet();
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item instanceof Error) return { ...item, name: item.name, message: item.message, stack: item.stack, cause: item.cause };
    if (item instanceof Headers) return Object.fromEntries(item.entries());
    if (typeof item === 'object' && item) {
      if (seen.has(item)) return '[circular]';
      seen.add(item);
    }
    return item;
  }) ?? '';
}

/** Records the arguments of every event that a model raises. */
class Spy extends BaseCallbackHandler {
  name = 'key-spy';
  readonly seen: Array<{ event: string; text: string }> = [];

  constructor() {
    super();
    for (const event of ['handleLLMStart', 'handleChatModelStart', 'handleLLMEnd', 'handleLLMError', 'handleLLMNewToken']) {
      (this as unknown as Record<string, unknown>)[event] = (...args: unknown[]) => { this.seen.push({ event, text: textOf(args) }); };
    }
  }
}

/** A server that answers `mode`, and puts the headers of the request into the body of its error, as a debugging proxy does. */
function echoServer(t: T, mode: Mode): void {
  installFetch(t, (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (mode === 'network') throw new TypeError(`fetch failed for ${url}`);
    if (mode === 'ok') return textReply(url);
    const status = mode === 'http 401' ? 401 : 500;
    const echoed = JSON.stringify(Object.fromEntries(new Headers(init?.headers).entries()));
    // Google's SDK reads error.message, Anthropic's and OpenAI's the error object.
    return jsonResponse({ error: { code: status, message: `bad key, headers were ${echoed} and url ${url}`, type: 'authentication_error' } }, status);
  }) as typeof fetch);
}

for (const [name, settings] of PROVIDERS) {
  for (const mode of ['ok', 'http 401', 'http 500', 'network'] as Mode[]) {
    test(`${name}, ${mode}: no callback is given the key, not in the model's options, the messages, the output or an error`, async (t) => {
      echoServer(t, mode);
      const spy = new Spy();
      await generateCompletion(settings, MESSAGES, 'SYS', { callbacks: [spy] }).catch(() => {});
      await awaitAllCallbacks();

      assert.ok(spy.seen.some((entry) => entry.event === 'handleChatModelStart'), 'the spy saw the call (otherwise this test proves nothing)');
      for (const { event, text } of spy.seen) assert.ok(!text.includes(KEY), `${event} was given the key: ...${text.slice(Math.max(0, text.indexOf(KEY) - 80), text.indexOf(KEY) + 50)}`);
      if (mode === 'http 401' || mode === 'http 500') {
        const errors = spy.seen.filter((entry) => entry.event === 'handleLLMError');
        assert.ok(errors.length >= 1, 'the error reached the callbacks');
        assert.ok(errors.some((entry) => entry.text.includes('[redacted]')), 'and it carried the echo, with the key taken out (otherwise the server echoed nothing)');
      }
    });
  }
}

test('a real tracer sends no key to the LangSmith server, on the AgentRouter path that used to carry it and on the others', async (t) => {
  const posted: string[] = [];
  installFetch(t, (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('https://smith.test')) {
      let body = init?.body;
      if (body && typeof body !== 'string') body = new TextDecoder().decode(body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer()));
      posted.push(`${url} ${String(body ?? '')}`);
      return Response.json({});
    }
    return textReply(url);
  }) as typeof fetch);

  for (const [name, settings] of PROVIDERS.filter(([provider]) => ['agent_router', 'anthropic', 'openai'].includes(provider))) {
    const client = new Client({ apiUrl: 'https://smith.test', apiKey: 'lsv2-fake', autoBatchTracing: false });
    const tracer = new LangChainTracer({ projectName: 'scoutfox', client });
    await generateCompletion(settings, MESSAGES, 'SYS', { callbacks: [tracer] });
    await awaitAllCallbacks();
    await client.awaitPendingTraceBatches();
    assert.ok(posted.length > 0, `${name}: the tracer posted its run (otherwise this test proves nothing)`);
  }
  assert.ok(posted.some((entry) => /"name":"ChatAnthropic"|ChatAnthropic/.test(entry)), 'the AgentRouter run was traced');
  for (const entry of posted) assert.ok(!entry.includes(KEY), `a request to LangSmith carries the key: ${entry.slice(0, 200)}`);
});
