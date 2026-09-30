/**
 * The error texts of the LLM layer (llm/errors.ts), on the errors that the real SDKs throw.
 *
 * The texts are the ones apiClients.js always produced, for example
 * "OpenRouter API connection error: OpenRouter API Error (500): <body>". What changed is where they come from:
 * LangChain and the SDKs throw errors with a `status`, and errors.ts maps them back. Two parts:
 *   - end to end: each provider answers an HTTP error, or fails to connect, through the real client, and the
 *     text that reaches the caller is compared word for word with today's
 *   - the functions on their own, on made-up errors, for the shapes a server can send that a test cannot
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { GEMINI_EMPTY_TEXT, assertApiKey, describeFailure, statusOf, wrapFailure } from '../../src/background/llm/errors.ts';
import { callProvider, generateCompletion } from '../../src/background/llm/index.ts';
import type { LlmSettings } from '../../src/background/llm/types.ts';
import { jsonResponse, spyFetch, textReply } from '../helpers/llmWire.ts';

const MESSAGES = [{ role: 'user', content: 'hi' }];
const KEY = 'sk-test-1234567890';

const OPENAI_URL = 'https://api.openai.com/v1';
const SETTINGS: Record<string, LlmSettings> = {
  openrouter: { provider: 'openrouter', apiKey: KEY, model: 'anthropic/claude-3.5-sonnet' },
  openai: { provider: 'openai', apiKey: KEY, model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com' },
  keyless: { provider: 'openai_compatible', model: 'local', baseUrl: 'http://localhost:1234' },
  anthropic: { provider: 'anthropic', apiKey: KEY, model: 'claude-3-5-sonnet-20241022' },
  gemini: { provider: 'gemini', apiKey: KEY, model: 'gemini-1.5-flash' }
};

const failureOf = (promise: Promise<unknown>) => promise.then(() => assert.fail('the call was expected to fail'), (error: Error) => error);
const fail = (name: string) => failureOf(generateCompletion(SETTINGS[name], MESSAGES, 'system'));
const textResponse = (text: string, status: number) => new Response(text, { status, headers: { 'content-type': 'text/plain' } });

// ---------------------------------------------------------------------------------------------
// Missing keys: today's exact texts, before any request
// ---------------------------------------------------------------------------------------------

test('a missing key fails with today\'s text before any request is made', async (t) => {
  const sent = spyFetch(t);
  const expected: Record<string, RegExp> = {
    openrouter: /^OpenRouter API Key is missing\. Please enter your OpenRouter API Key in Settings and click Save Settings\.$/,
    anthropic: /^Anthropic Claude API Key is missing\. Please enter your API Key in Settings\.$/,
    gemini: /^Google Gemini API Key is missing\. Please enter your Gemini API Key in the Settings tab and click Save Settings\.$/
  };
  for (const [name, pattern] of Object.entries(expected)) {
    const error = await failureOf(generateCompletion({ ...SETTINGS[name], apiKey: '' }, MESSAGES, 'system'));
    assert.match(error.message, pattern, name);
    // A key that is only saved for the provider counts, and one with spaces around it is trimmed to nothing.
    const blank = await failureOf(generateCompletion({ ...SETTINGS[name], apiKey: '   ', providerConfigs: {} }, MESSAGES, 'system'));
    assert.match(blank.message, pattern, `${name}: a blank key is a missing key`);
  }
  assert.equal(sent.length, 0, 'no request');
});

test('the OpenAI family has no missing-key check: a keyless server is served', async (t) => {
  const sent = spyFetch(t);
  for (const provider of ['openai', 'openai_compatible']) {
    sent.length = 0;
    assert.equal(await generateCompletion({ provider, model: 'local', baseUrl: 'http://localhost:1234' }, MESSAGES, 'system'), '{"action":"done"}', provider);
    assert.equal(sent.length, 1, provider);
    assert.equal(sent[0].headers.authorization, undefined, `${provider}: no Authorization header`);
  }
});

test('assertApiKey passes a key and, for the OpenAI family, an empty one', () => {
  assert.doesNotThrow(() => assertApiKey('openrouter', KEY));
  assert.doesNotThrow(() => assertApiKey('openai', ''));
  assert.doesNotThrow(() => assertApiKey('openai_compatible', ''));
  assert.throws(() => assertApiKey('anthropic', ''), /Anthropic Claude API Key is missing/);
});

// ---------------------------------------------------------------------------------------------
// HTTP errors, through the real clients
// ---------------------------------------------------------------------------------------------

test('openrouter: 401 has the fixed authentication text, other statuses carry the raw body', async (t) => {
  let reply = () => jsonResponse({ error: { message: 'No auth credentials found' } }, 401);
  const sent = spyFetch(t, () => reply());
  assert.equal((await fail('openrouter')).message,
    'OpenRouter API connection error: OpenRouter API Authentication Error (401): Invalid or missing API key. Please check your key in Settings.');

  reply = () => textResponse('{"error":{"message":"Provider returned error","code":502}}', 502);
  assert.equal((await fail('openrouter')).message,
    'OpenRouter API connection error: OpenRouter API Error (502): {"error":{"message":"Provider returned error","code":502}}');
  assert.equal(sent.length, 2, 'one request per call: nothing retries under callWithRetry');
});

test('openai: the status and the raw body of any answer, whatever its shape', async (t) => {
  const cases: Array<[string, Response, string]> = [
    ['an OpenAI-shaped error', textResponse('{"error":{"message":"Incorrect API key provided","type":"invalid_request_error","code":"invalid_api_key"}}', 401),
      '{"error":{"message":"Incorrect API key provided","type":"invalid_request_error","code":"invalid_api_key"}}'],
    ['a vLLM-shaped error with no "error" member', textResponse('{"object":"error","message":"The model `x` does not exist.","type":"NotFoundError","code":404}', 404),
      '{"object":"error","message":"The model `x` does not exist.","type":"NotFoundError","code":404}'],
    ['a FastAPI-shaped error', textResponse('{"detail":"Not Found"}', 404), '{"detail":"Not Found"}'],
    ['a plain text body', textResponse('upstream connect error', 503), 'upstream connect error'],
    ['pretty printed JSON', textResponse('{\n  "error": {\n    "message": "rate limited"\n  }\n}\n', 429), '{\n  "error": {\n    "message": "rate limited"\n  }\n}\n'],
    ['an empty body', textResponse('', 500), '']
  ];
  let next = cases[0];
  const sent = spyFetch(t, () => next[1].clone());
  for (next of cases) {
    sent.length = 0;
    const status = next[1].status;
    assert.equal((await fail('openai')).message, `API connection error (${OPENAI_URL}): API Error (${status}): ${next[2]}`, next[0]);
    assert.equal(sent.length, 1, `${next[0]}: one request`);
  }
});

test('the OpenAI family names its own base URL, with /v1', async (t) => {
  spyFetch(t, () => textResponse('nope', 500));
  assert.equal((await fail('keyless')).message, 'API connection error (http://localhost:1234/v1): API Error (500): nope');
  const groq = await failureOf(generateCompletion({ provider: 'openai_compatible', apiKey: KEY, baseUrl: 'https://api.groq.com/openai/v1/' }, MESSAGES, 'system'));
  assert.equal(groq.message, 'API connection error (https://api.groq.com/openai/v1): API Error (500): nope');
});

test('anthropic: the status and the body of the error', async (t) => {
  const body = '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}';
  const sent = spyFetch(t, () => textResponse(body, 401));
  assert.equal((await fail('anthropic')).message, `Anthropic API Error: Anthropic API error (401): ${body}`);
  assert.equal(sent.length, 1, 'one request');

  spyFetch(t, () => textResponse('Bad gateway', 502));
  assert.equal((await fail('anthropic')).message, 'Anthropic API Error: Anthropic API error (502): Bad gateway');
});

test('gemini: the status and the message of the error', async (t) => {
  const sent = spyFetch(t, () => textResponse('{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}', 400));
  assert.equal((await fail('gemini')).message, 'Gemini API Error: Gemini API Error (400): API key not valid. Please pass a valid API key.');
  assert.equal(sent.length, 1, 'one request');

  spyFetch(t, () => textResponse('{"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota).","status":"RESOURCE_EXHAUSTED"}}', 429));
  assert.equal((await fail('gemini')).message, 'Gemini API Error: Gemini API Error (429): Resource has been exhausted (e.g. check quota).');
});

test('no error text carries the API key, also when the server sends it back', async (t) => {
  const echo = `Incorrect API key provided: ${KEY}. You can find your API key at https://platform.openai.com/account/api-keys.`;
  spyFetch(t, () => textResponse(JSON.stringify({ error: { message: echo } }), 401));
  for (const name of ['openrouter', 'openai', 'anthropic', 'gemini']) {
    const error = await fail(name);
    assert.doesNotMatch(error.message, new RegExp(KEY), name);
  }
  const openai = await fail('openai');
  assert.match(openai.message, /Incorrect API key provided: \[redacted\]\./, 'the rest of the text stays');
});

// ---------------------------------------------------------------------------------------------
// No answer at all, and answers the client cannot read
// ---------------------------------------------------------------------------------------------

test('a network failure shows the fetch error, as it always did', async (t) => {
  spyFetch(t, () => { throw new TypeError('Failed to fetch'); });
  assert.equal((await fail('openrouter')).message, 'OpenRouter API connection error: Failed to fetch');
  assert.equal((await fail('openai')).message, `API connection error (${OPENAI_URL}): Failed to fetch`);
  assert.equal((await fail('anthropic')).message, 'Anthropic API Error: Failed to fetch');
  assert.equal((await fail('gemini')).message, 'Gemini API Error: Failed to fetch');
});

/** Answers that are successful for HTTP and no chat reply for any of the four clients. */
const UNREADABLE_BODIES: Array<[string, () => Response, string]> = [
  ['an {"error": ...} object, as OpenRouter sends when an upstream provider fails', () => jsonResponse({ error: { message: 'Upstream provider returned 502', code: 502 } }), '{"error":{"message":"Upstream provider returned 502","code":502}}'],
  ['a completion with no choices', () => jsonResponse({ id: 'x', choices: [] }), '{"id":"x","choices":[]}'],
  ['an empty object', () => jsonResponse({}), '{}'],
  ['the HTML page of a proxy', () => new Response('<html><body>Sign in to the network</body></html>', { status: 200, headers: { 'content-type': 'text/html' } }), '<html><body>Sign in to the network</body></html>'],
  ['an empty body', () => new Response('', { status: 200, headers: { 'content-type': 'application/json' } }), '(empty body)']
];

test('a 200 that the client cannot read as a chat reply says so and shows what the server said, not an internal TypeError', async (t) => {
  const wrapped: Record<string, (body: string) => string> = {
    openrouter: (body) => `OpenRouter API connection error: OpenRouter API Error (200): not a chat reply: ${body}`,
    openai: (body) => `API connection error (${OPENAI_URL}): API Error (200): not a chat reply: ${body}`,
    keyless: (body) => `API connection error (http://localhost:1234/v1): API Error (200): not a chat reply: ${body}`,
    anthropic: (body) => `Anthropic API Error: Anthropic API error (200): not a chat reply: ${body}`
  };
  let next = UNREADABLE_BODIES[0];
  const sent = spyFetch(t, () => next[1]());
  for (next of UNREADABLE_BODIES) {
    for (const [name, text] of Object.entries(wrapped)) {
      sent.length = 0;
      const error = await fail(name);
      assert.equal(error.message, text(next[2]), `${name}: ${next[0]}`);
      assert.doesNotMatch(error.message, /Cannot read properties|undefined|Unexpected/, `${name}: no internal text`);
      assert.equal(sent.length, 1, `${name}: one request`);
    }
  }
});

test('an unreadable body is shown up to 600 characters', async (t) => {
  const body = `{"error":"${'x'.repeat(5000)}"}`;
  spyFetch(t, () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }));
  const message = (await fail('openai')).message;
  assert.equal(message, `API connection error (${OPENAI_URL}): API Error (200): not a chat reply: ${body.slice(0, 600)} ...`);
});

test('a reply whose body never arrives is a network failure, not an unreadable reply', async (t) => {
  spyFetch(t, () => new Response(new ReadableStream({ pull(controller) { controller.error(new TypeError('terminated')); } }), { status: 200, headers: { 'content-type': 'application/json' } }));
  for (const name of ['openrouter', 'openai', 'anthropic']) {
    const error = await fail(name);
    assert.match(error.message, /terminated/, name);
    assert.doesNotMatch(error.message, /not a chat reply/, name);
  }
});

test('a call that was cancelled is never reported as an unreadable reply, even when the answer had come in before the cancel was seen', async (t) => {
  // A fetch that ignores the signal, and a task that is stopped while the answer is on its way: the client fails with its
  // own abort error, which has no status, and an answer whose body was read. That is a cancel, not "not a chat reply".
  for (const name of ['openai', 'anthropic']) {
    const task = new AbortController();
    spyFetch(t, (request) => { task.abort(new Error('the task was stopped')); return textReply(request.url); });
    const error = await callProvider(SETTINGS[name].provider as string, SETTINGS[name], MESSAGES, 'system', { signal: task.signal }).then(() => null, (e: Error) => e);
    if (error) assert.doesNotMatch(error.message, /not a chat reply/, name);
  }
});

test('a server that answers in the legacy completion shape, choices[0].text, is read as it always was', async (t) => {
  spyFetch(t, () => jsonResponse({ id: 'c1', object: 'text_completion', choices: [{ index: 0, text: 'from text field', finish_reason: 'stop' }] }));
  for (const name of ['openrouter', 'openai', 'keyless']) {
    assert.equal(await generateCompletion(SETTINGS[name], MESSAGES, 'system'), 'from text field', name);
  }
});

test('gemini: an empty text, a blocked reply and a reply with no candidate all say "empty text response"', async (t) => {
  const stream = (chunk: unknown) => new Response(`data: ${JSON.stringify(chunk)}\r\n\r\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const replies: Record<string, unknown> = {
    'an empty text part': { candidates: [{ content: { role: 'model', parts: [{ text: '' }] }, finishReason: 'STOP', index: 0 }] },
    'no parts': { candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP', index: 0 }] },
    'a reply blocked for safety': { candidates: [{ finishReason: 'SAFETY', index: 0 }] },
    'a prompt that was blocked': { promptFeedback: { blockReason: 'SAFETY' } }
  };
  let current: unknown;
  spyFetch(t, () => stream(current));
  for (const [name, reply] of Object.entries(replies)) {
    current = reply;
    assert.equal((await fail('gemini')).message, `Gemini API Error: ${GEMINI_EMPTY_TEXT}`, name);
  }
});

test('the other providers return an empty text as it is, as they always did', async (t) => {
  spyFetch(t, (request) => textReply(request.url, ''));
  for (const name of ['openrouter', 'openai', 'keyless', 'anthropic']) {
    assert.equal(await generateCompletion(SETTINGS[name], MESSAGES, 'system'), '', name);
  }
});

test('an unknown provider is refused with its name', async (t) => {
  const sent = spyFetch(t);
  await assert.rejects(generateCompletion({ provider: 'nope' }, MESSAGES, 'system'), /^Error: Unsupported LLM provider: nope$/);
  await assert.rejects(callProvider('nope', {}, MESSAGES, 'system'), /Unsupported LLM provider: nope/);
  // A name that is also a member of every object must not be taken for a provider that the caller serves itself.
  await assert.rejects(generateCompletion({ provider: 'constructor' }, MESSAGES, 'system'), /^Error: Unsupported LLM provider: constructor$/);
  assert.equal(sent.length, 0);
});

// ---------------------------------------------------------------------------------------------
// The functions on their own
// ---------------------------------------------------------------------------------------------

test('statusOf reads status and status_code, and nothing else', () => {
  assert.equal(statusOf({ status: 429 }), 429);
  assert.equal(statusOf({ status_code: 503 }), 503);
  assert.equal(statusOf({ status: '502' }), 502, 'a status sent as text');
  assert.equal(statusOf({ status: 429, status_code: 500 }), 429, 'status wins');
  for (const value of [new Error('x'), null, undefined, 'text', { status: 'oops' }, { status: 0 }, { status: 99 }, { status: null }, {}]) {
    assert.equal(statusOf(value), undefined, JSON.stringify(value));
  }
});

test('describeFailure and wrapFailure: the pieces of today\'s texts, one by one', () => {
  const http = (status: number, message: string) => Object.assign(new Error(message), { status });
  const ctx = { baseUrl: 'https://x.test/v1' };

  // The provider's own words, which the old code logged as "Failed request to ...".
  assert.equal(describeFailure('openrouter', http(500, '500 x'), { ...ctx, rawBody: 'raw' }), 'OpenRouter API Error (500): raw');
  assert.equal(describeFailure('openai', http(429, '429 Rate limit reached'), ctx), 'API Error (429): Rate limit reached', 'without a raw body the SDK text is used, minus the status');
  assert.equal(describeFailure('openai', http(401, '401 bad key\n\nTroubleshooting URL: https://docs.langchain.com/x/\n'), ctx), 'API Error (401): bad key', 'LangChain\'s link is not part of the old text');
  assert.equal(describeFailure('openai', http(404, '404 status code (no body)'), ctx), 'API Error (404): ');
  assert.equal(describeFailure('anthropic', http(529, '529 {"type":"error"}'), ctx), 'Anthropic API error (529): {"type":"error"}');
  assert.equal(
    describeFailure('gemini', http(403, '[GoogleGenerativeAI Error]: Error fetching from https://g.test/v1beta/models/m:streamGenerateContent?alt=sse: [403 Forbidden] denied'), ctx),
    'Gemini API Error (403): denied'
  );
  // The SDK keeps only the `message` of a JSON body, so any other body leaves the tail empty. The reason phrase stands in for it:
  // the response's own, else the standard one for the status (HTTP/2 answers have none), else nothing.
  assert.equal(describeFailure('gemini', http(500, '[GoogleGenerativeAI Error]: Error fetching from https://g.test/x: [500 Internal Server Error] '), ctx), 'Gemini API Error (500): Internal Server Error');
  assert.equal(describeFailure('gemini', http(503, '[GoogleGenerativeAI Error]: Error fetching from https://g.test/x: [503 ] '), ctx), 'Gemini API Error (503): Service Unavailable');
  assert.equal(describeFailure('gemini', http(599, '[GoogleGenerativeAI Error]: Error fetching from https://g.test/x: [599 ] '), ctx), 'Gemini API Error (599): ');
  assert.equal(describeFailure('gemini', http(502, '[GoogleGenerativeAI Error]: Error fetching from https://g.test/x: [502 Bad Gateway] upstream said no'), ctx), 'Gemini API Error (502): upstream said no', 'a message is never replaced');

  // No status: the reason behind the failure, never the generic wrapper text of the SDK.
  const connection = Object.assign(new Error('Connection error.'), { cause: new TypeError('fetch failed') });
  assert.equal(describeFailure('openai', connection), 'fetch failed');
  assert.equal(describeFailure('anthropic', connection), 'fetch failed');
  assert.equal(describeFailure('openai', new Error('Connection error.')), 'Connection error.', 'no cause, the error\'s own text');
  assert.equal(describeFailure('gemini', new Error('[GoogleGenerativeAI Error]: Error fetching from https://g.test/x: fetch failed')), 'fetch failed');
  assert.equal(describeFailure('openai', 'a string was thrown'), 'a string was thrown');

  // The wrappers.
  assert.equal(wrapFailure('openrouter', 'inner'), 'OpenRouter API connection error: inner');
  assert.equal(wrapFailure('openai', 'inner', ctx), 'API connection error (https://x.test/v1): inner');
  assert.equal(wrapFailure('openai_compatible', 'inner', ctx), 'API connection error (https://x.test/v1): inner');
  assert.equal(wrapFailure('anthropic', 'inner'), 'Anthropic API Error: inner');
  assert.equal(wrapFailure('gemini', 'inner'), 'Gemini API Error: inner');
});

test('describeFailure takes a long key out of the text and leaves a short one alone', () => {
  const error = Object.assign(new Error('401 nope'), { status: 401 });
  assert.equal(describeFailure('openai', error, { rawBody: 'bad key sk-test-1234567890 given', apiKey: 'sk-test-1234567890' }), 'API Error (401): bad key [redacted] given');
  // A key of a few characters would mangle the message, so it is not replaced (real keys are much longer).
  assert.equal(describeFailure('openai', error, { rawBody: 'bad key k given', apiKey: 'k' }), 'API Error (401): bad key k given');
});
