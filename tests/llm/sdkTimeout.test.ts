/**
 * llmTimeoutMs is the only timer of a call, also above ten minutes.
 *
 * The openai and @anthropic-ai/sdk clients end a request after 10 minutes by themselves, with their own
 * "Request timed out." text, and the side panel lets a user set llmTimeoutMs to any number (a slow local model in LM
 * Studio can need an hour). Before SDK_TIMEOUT_MS was set on the models, such a call died at 10 minutes with a text
 * that has no llmTimeoutMs hint, and the old client had waited the full time.
 *
 * The clock is faked: a server that never answers, a llmTimeoutMs of 15 minutes, and the time moved by hand. After 11
 * minutes the call must still be waiting, and at 15 it must fail with the deadline's own text. (Gemini and Ollama have
 * no SDK timeout, and deadline.test.ts covers them with real short deadlines.)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateCompletion } from '../../src/background/llm/index.ts';
import type { LlmSettings } from '../../src/background/llm/types.ts';
import { hangUntilAborted, spyFetch } from '../helpers/llmWire.ts';
import type { SentRequest } from '../helpers/llmWire.ts';

const MINUTE = 60_000;
const MESSAGES = [{ role: 'user', content: 'hi' }];

type Reply = (request: SentRequest) => Response | Promise<Response>;

/** The provider, its settings, and how the server answers (it never does, unless a reply is given). */
const PROVIDERS: Array<[string, LlmSettings, Reply?]> = [
  ['openai', { provider: 'openai', apiKey: 'sk-test-123' }],
  ['openai_compatible (a slow local server)', { provider: 'openai_compatible', baseUrl: 'http://localhost:1234' }],
  ['openrouter', { provider: 'openrouter', apiKey: 'sk-or-test-123' }],
  ['anthropic', { provider: 'anthropic', apiKey: 'sk-ant-test-123' }],
  ['agent_router', { provider: 'agent_router', apiKey: 'sk-ar-test-123' }],
  ['nvidia', { provider: 'nvidia', apiKey: 'nvapi-test-123' }],
  // The Messages endpoint answers at once, and the slow one is the fallback, which is a second client with its own SDK timeout.
  ['agent_router (the fallback request)', { provider: 'agent_router', apiKey: 'sk-ar-test-123' },
    (request) => (request.url.endsWith('/messages') ? new Response('overloaded', { status: 529 }) : hangUntilAborted(request))]
];

/** Lets the promises that are ready run. setImmediate is not faked here, only setTimeout. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

for (const [name, settings, reply] of PROVIDERS) {
  test(`${name}: a llmTimeoutMs of 15 minutes is waited for, and the deadline's text ends the call`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const sent = spyFetch(t, reply ?? hangUntilAborted);

    let outcome: 'waiting' | string = 'waiting';
    const call = generateCompletion({ ...settings, llmTimeoutMs: 15 * MINUTE }, MESSAGES, 'SYS').then(
      () => { outcome = 'resolved'; },
      (error: Error) => { outcome = error.message; }
    );
    await flush();
    assert.equal(sent.length, reply ? 2 : 1, 'the request that never gets an answer is out');
    const hanging = sent[sent.length - 1];

    t.mock.timers.tick(11 * MINUTE);
    await flush();
    assert.equal(outcome, 'waiting', 'the SDK\'s own 10 minute timeout must not end the call');
    assert.equal(hanging.signal!.aborted, false, 'and must not cancel the request');

    t.mock.timers.tick(4 * MINUTE + 1);
    await flush();
    await call;
    assert.match(outcome, /Provider \[\w+\] did not respond within 900s\. The request was abandoned - check that the provider is reachable, or raise llmTimeoutMs in settings\.$/);
    assert.doesNotMatch(outcome, /Request timed out/);
    assert.equal(hanging.signal!.aborted, true, 'the deadline cancelled the request');
  });
}
