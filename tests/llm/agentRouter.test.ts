/**
 * AgentRouter (llm/agentRouter.ts): ChatAnthropic first, ChatOpenAICompletions as the fallback, joined by hand.
 *
 * The requests are built by the real clients and captured with a fetch spy. What is pinned:
 *   - both requests carry exactly the headers the old hand-written fetch sent, the Claude CLI wire image: nothing
 *     the SDKs add on their own (accept, x-stainless-*) gets through. The URLs and the bodies are the old ones
 *     plus the harmless stream:false, and the fallback has no max tokens.
 *   - the rules of the old code: a 401, or a body that says unauthorized_client_error, an abort and a network
 *     error end the call with no second request; any other HTTP error, an empty 200 and a 200 that is not an
 *     Anthropic reply go on to the fallback; the fallback throws its own error; the first error is logged
 *     instead of lost.
 *   - the error texts, all behind "AgentRouter API connection error: " as the old client threw them, and the
 *     missing-key text, checked before anything is built.
 *   - the key never shows up in a text, even when the server echoes it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Logger } from '../../src/shared/logger.ts';
import { userAbortReason } from '../../src/background/llm/deadline.ts';
import { callAgentRouter } from '../../src/background/llm/agentRouter.ts';
import { agentRouterHeaders } from '../../src/background/llm/models.ts';
import type { LlmSettings } from '../../src/background/llm/types.ts';
import { hangUntilAborted, jsonResponse, settledWithin, spyFetch, textReply, waitForRequests } from '../helpers/llmWire.ts';
import type { SentRequest } from '../helpers/llmWire.ts';

const KEY = 'sk-test-agentrouter-123';
const SETTINGS: LlmSettings = { provider: 'agent_router', apiKey: KEY, model: 'claude-3-5-sonnet', baseUrl: 'https://agentrouter.org/v1' };
const TURNS = [
  { role: 'user', content: 'hello' },
  { role: 'assistant', content: 'prev' },
  { role: 'user', content: 'next' }
];

/** The wire image, written out: what the old client sent on both endpoints (Content-Type included), as lower-case names. */
const WIRE_HEADERS = {
  'content-type': 'application/json',
  authorization: `Bearer ${KEY}`,
  'x-api-key': KEY,
  'user-agent': 'claude-cli/2.1.158 (external, sdk-cli)',
  'x-app': 'cli',
  'anthropic-version': '2023-06-01',
  'anthropic-beta': 'claude-code-20250219,interleaved-thinking-2025-05-14',
  'anthropic-dangerous-direct-browser-access': 'true'
};

type T = { after: (fn: () => void) => void };
type Maker = (request: SentRequest) => Response | Promise<Response>;

const isMessages = (request: SentRequest) => new URL(request.url).pathname.endsWith('/messages');
const emptyMessages = () => jsonResponse({ id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
const emptyCompletion = () => jsonResponse({ id: 'c1', object: 'chat.completion', created: 1, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }] });

/** Answers the Messages endpoint with `first` and the Chat Completions endpoint with `second` (a normal reply when it is left out). */
function endpoints(t: T, first: Maker, second: Maker = (request) => textReply(request.url)): SentRequest[] {
  return spyFetch(t, (request) => (isMessages(request) ? first(request) : second(request)));
}

const ask = (settings: Partial<LlmSettings> = {}, options: Parameters<typeof callAgentRouter>[3] = {}) =>
  callAgentRouter({ ...SETTINGS, ...settings }, TURNS, 'SYS', options);

async function logsOf(run: () => Promise<unknown>): Promise<string[]> {
  const from = Logger.getLogsHistory().length;
  await run().catch(() => {});
  return Logger.getLogsHistory().slice(from).map((entry) => `${entry.level} ${entry.module} ${entry.message}${entry.data ? ` | ${entry.data}` : ''}`);
}

// ---------------------------------------------------------------------------------------------
// The requests
// ---------------------------------------------------------------------------------------------

test('the wire image in models.ts is the one this file pins', () => {
  assert.deepEqual(agentRouterHeaders(KEY), {
    Authorization: WIRE_HEADERS.authorization,
    'x-api-key': KEY,
    'User-Agent': WIRE_HEADERS['user-agent'],
    'x-app': 'cli',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': WIRE_HEADERS['anthropic-beta'],
    'anthropic-dangerous-direct-browser-access': 'true'
  });
});

test('the Messages request goes to <base>/v1/messages with exactly the old headers, and the old body plus stream:false', async (t) => {
  const sent = spyFetch(t);
  assert.equal(await ask(), '{"action":"done"}');

  assert.equal(sent.length, 1, 'a good answer needs no second request');
  assert.equal(sent[0].method, 'POST');
  assert.equal(sent[0].url, 'https://agentrouter.org/v1/messages');
  assert.deepEqual(sent[0].headers, WIRE_HEADERS, 'no accept, no x-stainless-*, no dangerously-allow-browser');
  assert.deepEqual(sent[0].body, {
    model: 'claude-3-5-sonnet',
    system: 'SYS',
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'prev' },
      { role: 'user', content: 'next' }
    ],
    max_tokens: 8192,
    temperature: 0.1,
    stream: false
  });
});

test('the Chat Completions request goes to <base>/v1/chat/completions with the same headers, the old body plus stream:false, and no max tokens', async (t) => {
  const sent = endpoints(t, () => jsonResponse({ error: { message: 'no such route' } }, 404));
  assert.equal(await ask(), '{"action":"done"}');

  assert.equal(sent.length, 2);
  assert.equal(sent[1].method, 'POST');
  assert.equal(sent[1].url, 'https://agentrouter.org/v1/chat/completions');
  assert.deepEqual(sent[1].headers, WIRE_HEADERS, 'the User-Agent and the rest are set per call, on top of the nulls that remove the SDK\'s own');
  assert.deepEqual(sent[1].body, {
    model: 'claude-3-5-sonnet',
    messages: [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'prev' },
      { role: 'user', content: 'next' }
    ],
    temperature: 0.1,
    stream: false
  });
});

test('the base URL is optional, trimmed, and always ends in /v1 for both endpoints', async (t) => {
  for (const baseUrl of [undefined, '', '  https://router.example.com  ', 'https://router.example.com/', 'https://router.example.com/v1', 'https://router.example.com/v1/']) {
    const sent = endpoints(t, () => new Response('nope', { status: 500 }));
    await ask({ baseUrl });
    const host = baseUrl && baseUrl.trim() ? 'https://router.example.com' : 'https://agentrouter.org';
    assert.deepEqual(sent.map((request) => request.url), [`${host}/v1/messages`, `${host}/v1/chat/completions`], JSON.stringify(baseUrl));
  }
});

test('the model, the temperature and the max tokens are the settings\', with the old defaults', async (t) => {
  const sent = endpoints(t, () => new Response('nope', { status: 500 }));
  await ask({ model: '  deepseek-r1 ', temperature: 0, maxTokens: 2048 });
  assert.equal(sent[0].body.model, 'deepseek-r1');
  assert.equal(sent[0].body.temperature, 0, 'a temperature of 0 is not replaced by the default');
  assert.equal(sent[0].body.max_tokens, 2048);
  assert.equal(sent[1].body.model, 'deepseek-r1');
  assert.equal(sent[1].body.temperature, 0);
  assert.ok(!('max_tokens' in sent[1].body), 'the fallback has no max tokens');

  sent.length = 0;
  await ask({ model: '', temperature: undefined, maxTokens: 0 });
  assert.equal(sent[0].body.model, 'claude-3-5-sonnet');
  assert.equal(sent[0].body.temperature, 0.1);
  assert.equal(sent[0].body.max_tokens, 8192);
});

test('a stored max tokens of any size is sent: the SDK\'s guard against requests that could take over 10 minutes does not apply', async (t) => {
  const sent = spyFetch(t);
  for (const maxTokens of [22000, 64000]) {
    assert.equal(await ask({ maxTokens }), '{"action":"done"}', String(maxTokens));
    assert.equal(sent.at(-1)!.body.max_tokens, maxTokens);
  }
});

test('the key: the top-level key wins, the saved key is the fallback, both are trimmed, and the wire carries it twice', async (t) => {
  const sent = spyFetch(t);
  await ask({ apiKey: '  sk-top-key-123 \n', providerConfigs: { agent_router: { apiKey: 'sk-saved-key-123' } } });
  assert.equal(sent[0].headers['x-api-key'], 'sk-top-key-123');
  assert.equal(sent[0].headers.authorization, 'Bearer sk-top-key-123');

  await ask({ apiKey: '', providerConfigs: { agent_router: { apiKey: 'sk-saved-key-123' } } });
  assert.equal(sent[1].headers['x-api-key'], 'sk-saved-key-123');
  assert.equal(sent[1].headers.authorization, 'Bearer sk-saved-key-123');
});

test('every turn that is not the assistant\'s is sent as the user\'s, and the system prompt is not a message', async (t) => {
  const sent = spyFetch(t);
  await callAgentRouter(SETTINGS, [{ role: 'system', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'tool', content: 'c' }], 'SYS');
  assert.deepEqual(sent[0].body.messages.map((m: { role: string }) => m.role), ['user', 'assistant', 'user']);
  assert.equal(sent[0].body.system, 'SYS');
});

test('a model is built for every call: two calls do not share a client or a key', async (t) => {
  const sent = spyFetch(t);
  await ask({ apiKey: 'sk-first-key-123' });
  await ask({ apiKey: 'sk-second-key-123', baseUrl: 'http://localhost:9999' });
  assert.equal(sent[0].headers['x-api-key'], 'sk-first-key-123');
  assert.equal(sent[1].headers['x-api-key'], 'sk-second-key-123');
  assert.equal(sent[1].url, 'http://localhost:9999/v1/messages');
});

// ---------------------------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------------------------

test('a good answer from the Messages endpoint is logged as the old code did and needs no fallback', async (t) => {
  spyFetch(t);
  const logs = await logsOf(() => ask());
  assert.match(logs.find((line) => /\[NETWORK\]/.test(line)) ?? '', /^INFO ApiClients \[NETWORK\] 200 OK \(\d+ms\) - Retrieved output from AgentRouter \(claude-3-5-sonnet\), length: 17 chars$/);
});

test('a 401 ends the call with the authentication text and no second request', async (t) => {
  const body = '{"error":{"type":"authentication_error","message":"invalid x-api-key"}}';
  const sent = endpoints(t, () => new Response(body, { status: 401, headers: { 'content-type': 'application/json' } }));
  await assert.rejects(ask(), { message: `AgentRouter API connection error: AgentRouter Authentication Error (401): ${body}` });
  assert.equal(sent.length, 1, 'the fallback would be refused too');
});

test('a body that says unauthorized_client_error is an authentication failure on any status, and needs no fallback either', async (t) => {
  for (const status of [400, 403, 500]) {
    const body = '{"error":{"type":"unauthorized_client_error","message":"unauthorized client detected"}}';
    const sent = endpoints(t, () => new Response(body, { status }));
    await assert.rejects(ask(), { message: `AgentRouter API connection error: AgentRouter Authentication Error (401): ${body}` }, `status ${status}`);
    assert.equal(sent.length, 1, `status ${status}: one request`);
  }
});

test('a network error ends the call with the fetch error and no second request', async (t) => {
  for (const failure of [new TypeError('fetch failed'), new Error('fetch failed ECONNREFUSED')]) {
    const sent = spyFetch(t, () => { throw failure; });
    await assert.rejects(ask(), { message: `AgentRouter API connection error: ${failure.message}` });
    assert.equal(sent.length, 1, failure.message);
  }
});

test('an abort ends the call with no second request', async (t) => {
  const task = new AbortController();
  const sent = spyFetch(t, hangUntilAborted);
  const call = ask({}, { signal: task.signal });
  await waitForRequests(sent);
  task.abort(new Error('the task was stopped'));

  assert.equal(await settledWithin(call), 'rejected', 'the call ended at once');
  await assert.rejects(call, /^Error: AgentRouter API connection error: /);
  assert.equal(sent.length, 1, 'no fallback for a call that was cancelled');
  assert.equal(sent[0].signal!.aborted, true);
});

test('any other HTTP error goes to the fallback, whose answer is the result', async (t) => {
  for (const status of [400, 403, 404, 408, 422, 429, 500, 502, 503, 529]) {
    const sent = endpoints(t, () => new Response('upstream said no', { status }));
    assert.equal(await ask(), '{"action":"done"}', `status ${status}`);
    assert.deepEqual(sent.map((request) => new URL(request.url).pathname), ['/v1/messages', '/v1/chat/completions'], `status ${status}`);
  }
});

/** Bodies that a 200 of the Messages endpoint can have and ChatAnthropic cannot read: the server did answer. */
const NOT_ANTHROPIC: Array<[string, () => Response]> = [
  ['an {"error": ...} object', () => jsonResponse({ error: { message: 'model not on messages', type: 'invalid_request_error' } })],
  ['an {"type": "error"} object', () => jsonResponse({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })],
  ['an empty object', () => jsonResponse({})],
  ['the HTML page of a proxy', () => new Response('<html>hi</html>', { status: 200, headers: { 'content-type': 'text/html' } })],
  ['an empty body', () => new Response('', { status: 200, headers: { 'content-type': 'application/json' } })]
];

test('a 200 that ChatAnthropic cannot read goes to the fallback: the server answered, so it is not a network error', async (t) => {
  for (const [name, first] of NOT_ANTHROPIC) {
    const sent = endpoints(t, first);
    assert.equal(await ask(), '{"action":"done"}', name);
    assert.deepEqual(sent.map((request) => new URL(request.url).pathname), ['/v1/messages', '/v1/chat/completions'], name);
  }
});

test('the failure of such a 200 is logged with the server\'s own words, not an internal TypeError', async (t) => {
  endpoints(t, () => jsonResponse({ error: { message: 'model not on messages' } }));
  const logs = await logsOf(() => ask());
  const first = logs.find((line) => /Messages endpoint failed/.test(line));
  assert.ok(first, logs.join('\n'));
  assert.match(first, /\| AgentRouter API Error \(200\): not a chat reply: \{"error":\{"message":"model not on messages"\}\}$/);
  assert.equal(logs.filter((line) => /^ERROR/.test(line)).length, 0, 'the fallback worked');
});

test('a 200 of the Messages endpoint in the OpenAI shape is read as it was, with no second request', async (t) => {
  const shapes: Array<[string, object, string]> = [
    ['a string message', { id: 'c1', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'from-messages-openai-shape' }, finish_reason: 'stop' }] }, 'from-messages-openai-shape'],
    ['message parts with a text', { choices: [{ message: { role: 'assistant', content: [{ type: 'text', text: 'part one ' }, { type: 'text', text: 'part two' }] } }] }, 'part one part two'],
    ['the legacy text field', { choices: [{ index: 0, text: 'from-text-field' }] }, 'from-text-field']
  ];
  for (const [name, body, expected] of shapes) {
    const sent = endpoints(t, () => jsonResponse(body));
    let text = '';
    const logs = await logsOf(async () => { text = await ask(); });
    assert.equal(text, expected, name);
    assert.equal(sent.length, 1, `${name}: one request`);
    assert.match(logs.find((line) => /\[NETWORK\]/.test(line)) ?? '', /^INFO ApiClients \[NETWORK\] 200 OK \(\d+ms\) - Retrieved output from AgentRouter \(claude-3-5-sonnet\), length: \d+ chars$/, name);
  }
});

test('a 200 that says unauthorized_client_error is not a refusal: only an error status is, as before, so it goes to the fallback', async (t) => {
  const body = '{"error":{"type":"unauthorized_client_error","message":"unauthorized client detected"}}';
  const sent = endpoints(t, () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }));
  assert.equal(await ask(), '{"action":"done"}');
  assert.equal(sent.length, 2);
});

test('a fallback that answers 200 with something that is no chat reply fails with what the server said', async (t) => {
  const sent = endpoints(t, () => new Response('down', { status: 503 }), () => jsonResponse({ error: { message: 'no such model' } }));
  await assert.rejects(ask(), { message: 'AgentRouter API connection error: AgentRouter API Error (200): not a chat reply: {"error":{"message":"no such model"}}' });
  assert.equal(sent.length, 2);
});

test('the fallback reads the legacy completion shape, choices[0].text', async (t) => {
  endpoints(t, () => new Response('down', { status: 503 }), () => jsonResponse({ choices: [{ index: 0, text: 'legacy text' }] }));
  assert.equal(await ask(), 'legacy text');
});

test('a reply whose body never arrives is a network error: no second request', async (t) => {
  const sent = endpoints(t, () => new Response(new ReadableStream({ pull(controller) { controller.error(new TypeError('terminated')); } }), { status: 200, headers: { 'content-type': 'application/json' } }));
  await assert.rejects(ask(), { message: /^AgentRouter API connection error: .*terminated/ });
  assert.equal(sent.length, 1);
});

test('a Pause, a Stop or the deadline is not logged as a failed request: generateCompletion reports it once', async (t) => {
  for (const reason of [userAbortReason('paused by user'), new Error('the deadline')]) {
    const task = new AbortController();
    const sent = spyFetch(t, hangUntilAborted);
    let failed: unknown;
    const logs = await logsOf(async () => {
      const call = ask({}, { signal: task.signal }).catch((error) => { failed = error; });
      await waitForRequests(sent);
      task.abort(reason);
      await call;
    });
    assert.ok(failed, 'the call rejected');
    assert.deepEqual(logs.filter((line) => /^ERROR/.test(line)), [], 'no ERROR line');
  }
});

test('the first error is logged, not lost, and the fallback\'s success is logged as such', async (t) => {
  endpoints(t, () => jsonResponse({ error: { type: 'overloaded_error', message: 'Overloaded' } }, 529));
  const logs = await logsOf(() => ask());

  const first = logs.find((line) => /Messages endpoint failed/.test(line));
  assert.ok(first, logs.join('\n'));
  assert.match(first, /^WARN AgentRouterClient \[NETWORK\] Messages endpoint failed, trying the chat completions endpoint \| AgentRouter API Error \(529\): .*Overloaded/);
  assert.match(logs.find((line) => /completions fallback/.test(line)) ?? '', /^INFO ApiClients \[NETWORK\] 200 OK \(\d+ms\) - Retrieved output via completions fallback, length: 17 chars$/);
  assert.equal(logs.filter((line) => /^ERROR/.test(line)).length, 0, 'a fallback that worked is not an error');
});

test('a 200 with no text is logged as [PAYLOAD_WARN] and goes to the fallback', async (t) => {
  const sent = endpoints(t, emptyMessages);
  let text = '';
  const logs = await logsOf(async () => { text = await ask(); });

  assert.equal(text, '{"action":"done"}');
  assert.equal(sent.length, 2);
  assert.match(logs.find((line) => /\[PAYLOAD_WARN\]/.test(line)) ?? '', /^WARN ApiClients \[PAYLOAD_WARN\] Messages endpoint returned 200 OK but text content was empty\. Payload: \{"content":\[\],"stop_reason":"end_turn"\}$/);
});

test('an empty answer from the fallback too is an error with the payload', async (t) => {
  const sent = endpoints(t, emptyMessages, emptyCompletion);
  await assert.rejects(ask(), { message: 'AgentRouter API connection error: AgentRouter returned empty content. Response payload: {"content":"","stop_reason":"stop"}' });
  assert.equal(sent.length, 2);
});

test('when both endpoints fail, the error is the fallback\'s own, and the first error is in the log', async (t) => {
  endpoints(t, () => new Response('first: overloaded', { status: 529 }), () => new Response('{"detail":"second: bad gateway"}', { status: 502 }));
  let error: unknown;
  const logs = await logsOf(() => ask().catch((e) => { error = e; throw e; }));

  assert.equal((error as Error).message, 'AgentRouter API connection error: AgentRouter API Error (502): {"detail":"second: bad gateway"}', 'the fallback\'s status and its raw body');
  assert.match(logs.find((line) => /Messages endpoint failed/.test(line)) ?? '', /AgentRouter API Error \(529\): first: overloaded/);
  assert.deepEqual(logs.filter((line) => /^ERROR/.test(line)), ['ERROR AgentRouterClient [NETWORK] Failed request to AgentRouter AgentRouter API Error (502): {"detail":"second: bad gateway"}']);
});

test('a refusal by the fallback is an API error, not an authentication error: only the first call checks credentials', async (t) => {
  const sent = endpoints(t, () => new Response('down', { status: 503 }), () => new Response('{"error":"invalid key"}', { status: 401 }));
  await assert.rejects(ask(), { message: 'AgentRouter API connection error: AgentRouter API Error (401): {"error":"invalid key"}' });
  assert.equal(sent.length, 2);
});

test('a network error in the fallback is the fetch error', async (t) => {
  const sent = endpoints(t, () => new Response('down', { status: 503 }), () => { throw new TypeError('fetch failed'); });
  await assert.rejects(ask(), { message: 'AgentRouter API connection error: fetch failed' });
  assert.equal(sent.length, 2);
});

test('the raw body of an error is kept, whatever shape it has', async (t) => {
  for (const body of ['<html><title>Just a moment...</title></html>', '{"detail":"nope"}', '', 'plain text']) {
    endpoints(t, () => new Response('first', { status: 500 }), () => new Response(body, { status: 500 }));
    await assert.rejects(ask(), { message: `AgentRouter API connection error: AgentRouter API Error (500): ${body}` });
  }
});

test('the missing-key text is thrown as it always was, before anything is built or sent', async (t) => {
  const sent = spyFetch(t);
  for (const settings of [{ apiKey: '' }, { apiKey: '   ' }, { apiKey: undefined }]) {
    await assert.rejects(ask(settings), { message: 'AgentRouter API Key is missing. Please enter your AgentRouter API Key in Settings and click Save Settings.' });
  }
  assert.equal(sent.length, 0);
  // Not the key of another provider.
  await assert.rejects(ask({ apiKey: '', providerConfigs: { openrouter: { apiKey: 'sk-or-123456789' } } }), { message: /^AgentRouter API Key is missing/ });
});

test('the key is taken out of every text, also when the server echoes it back', async (t) => {
  endpoints(t, () => new Response(`bad key ${KEY}`, { status: 401 }));
  const auth = await ask().catch((e: Error) => e);
  assert.match((auth as Error).message, /Authentication Error \(401\): bad key \[redacted\]$/);

  endpoints(t, () => new Response('first', { status: 500 }), () => new Response(`Bearer ${KEY} is not allowed`, { status: 500 }));
  const api = await ask().catch((e: Error) => e);
  assert.match((api as Error).message, /API Error \(500\): Bearer \[redacted\] is not allowed$/);

  const logs = await logsOf(() => ask());
  for (const line of logs) assert.ok(!line.includes(KEY), `the key is in a log line: ${line}`);
});
