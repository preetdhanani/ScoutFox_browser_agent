/**
 * The Anthropic request, built by the real ChatAnthropic and captured with a fetch spy.
 *
 * Guards issue #9: the old client sent `dangerously-allow-browser`, which is the JS SDK's client OPTION name and
 * not a header. It is not in Anthropic's Access-Control-Allow-Headers, so every request failed CORS preflight
 * and the provider never completed a call. The real header is `anthropic-dangerous-direct-browser-access`.
 * ChatAnthropic sets it itself, which is what these tests pin, together with the rest of today's request.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateCompletion } from '../../src/background/llm/index.ts';
import type { LlmSettings } from '../../src/background/llm/types.ts';
import { spyFetch } from '../helpers/llmWire.ts';

const KEY = 'sk-ant-test-123';
const SETTINGS: LlmSettings = { provider: 'anthropic', apiKey: KEY, model: 'claude-3-5-sonnet-20241022' };
const TURNS = [
  { role: 'user', content: 'hello' },
  { role: 'assistant', content: 'prev' },
  { role: 'user', content: 'next' }
];

test('the request goes to /v1/messages with the four headers the old client sent', async (t) => {
  const sent = spyFetch(t);
  await generateCompletion(SETTINGS, TURNS, 'SYS');

  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, 'POST');
  assert.equal(sent[0].url, 'https://api.anthropic.com/v1/messages');
  const { headers } = sent[0];
  assert.equal(headers['x-api-key'], KEY);
  assert.equal(headers['anthropic-version'], '2023-06-01');
  assert.equal(headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.match(headers['content-type'], /^application\/json/);
  assert.equal(headers['dangerously-allow-browser'], undefined, 'the SDK option name is not a header, it fails CORS preflight');
  assert.equal(headers['authorization'], undefined, 'Anthropic takes x-api-key, not a bearer token');
  // Exactly the four, and nothing the SDK adds on its own: accept, a User-Agent and eight x-stainless-* headers
  // (os, arch, runtime, ...) that the old request did not send, and that tell a server which machine this is.
  assert.deepEqual(Object.keys(headers).sort(), ['anthropic-dangerous-direct-browser-access', 'anthropic-version', 'content-type', 'x-api-key']);
});

test('the body is the old body plus stream:false, and nothing else', async (t) => {
  const sent = spyFetch(t);
  await generateCompletion(SETTINGS, TURNS, 'SYS');

  assert.deepEqual(sent[0].body, {
    model: 'claude-3-5-sonnet-20241022',
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

test('max_tokens is 8192 unless settings.maxTokens is a positive number (LangChain\'s own default is 4096)', async (t) => {
  const sent = spyFetch(t);
  const maxTokens = async (value: unknown) => {
    await generateCompletion({ ...SETTINGS, maxTokens: value as number }, TURNS, 'SYS');
    return sent.at(-1)?.body.max_tokens;
  };
  assert.equal(await maxTokens(undefined), 8192);
  assert.equal(await maxTokens(0), 8192);
  assert.equal(await maxTokens(-5), 8192);
  assert.equal(await maxTokens('nonsense'), 8192);
  assert.equal(await maxTokens(1024), 1024);
  assert.equal(await maxTokens('2048'), 2048, 'a number saved as text');
  // The SDK refuses a non-streaming request that "may take longer than 10 minutes" (above about 21,333 tokens) unless it
  // was given a timeout. The deadline is the only timer, so the SDK gets one that never comes, and any stored value is sent.
  assert.equal(await maxTokens(22000), 22000);
  assert.equal(await maxTokens(64000), 64000);
});

test('every turn that is not the assistant\'s is sent as the user\'s, in order, and the system prompt is not a message', async (t) => {
  const sent = spyFetch(t);
  await generateCompletion(SETTINGS, [
    { role: 'user', content: 'a' },
    { role: 'system', content: 'b' },
    { role: 'assistant', content: 'c' },
    { role: 'tool', content: 'd' },
    { role: 'user', content: 'e' }
  ], 'SYS');
  assert.deepEqual(sent[0].body.messages.map((m: { role: string; content: string }) => `${m.role}:${m.content}`), ['user:a', 'user:b', 'assistant:c', 'user:d', 'user:e']);
  assert.equal(sent[0].body.system, 'SYS');
});

test('a model and a temperature from the settings are sent, and a temperature of 0 is not replaced by the default', async (t) => {
  const sent = spyFetch(t);
  await generateCompletion({ ...SETTINGS, model: 'claude-3-5-haiku-20241022', temperature: 0 }, TURNS, 'SYS');
  assert.equal(sent[0].body.model, 'claude-3-5-haiku-20241022');
  assert.equal(sent[0].body.temperature, 0);

  await generateCompletion({ ...SETTINGS, model: '' }, TURNS, 'SYS');
  assert.equal(sent[1].body.model, 'claude-3-5-sonnet-20241022', 'no model saved: the default');
});

test('the base URL of the settings is not used: the request always goes to api.anthropic.com', async (t) => {
  const sent = spyFetch(t);
  await generateCompletion({ ...SETTINGS, baseUrl: 'https://api.anthropic.com' }, TURNS, 'SYS');
  await generateCompletion({ ...SETTINGS, baseUrl: 'https://example.invalid/v1' }, TURNS, 'SYS');
  assert.deepEqual(sent.map((request) => request.url), ['https://api.anthropic.com/v1/messages', 'https://api.anthropic.com/v1/messages']);
});
