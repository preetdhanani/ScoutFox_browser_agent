/**
 * What every provider sends for the settings it is given, through the real LangChain clients (llm/factory.ts),
 * captured with a fetch spy: which URL, which key, which model, temperature and turns. The headers of the OpenAI
 * family are pinned in openaiHeaders.test.ts, Anthropic's in anthropicHeaders.test.ts, and Gemini's in gemini.test.ts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { generateCompletion } from '../../src/background/llm/index.ts';
import type { LlmSettings } from '../../src/background/llm/types.ts';
import { spyFetch } from '../helpers/llmWire.ts';

const TURNS = [
  { role: 'user', content: 'hello' },
  { role: 'assistant', content: 'prev' },
  { role: 'user', content: 'next' }
];

async function urlOf(t: { after: (fn: () => void) => void }, settings: LlmSettings) {
  const sent = spyFetch(t);
  await generateCompletion(settings, TURNS, 'SYS');
  return sent[0].url;
}

test('openai: the base URL is optional, and always ends in /v1/chat/completions', async (t) => {
  const key = { apiKey: 'sk-test-123' };
  assert.equal(await urlOf(t, { provider: 'openai', ...key }), 'https://api.openai.com/v1/chat/completions');
  assert.equal(await urlOf(t, { provider: 'openai', ...key, baseUrl: 'https://api.openai.com' }), 'https://api.openai.com/v1/chat/completions');
  assert.equal(await urlOf(t, { provider: 'openai', ...key, baseUrl: 'https://proxy.test/v1/' }), 'https://proxy.test/v1/chat/completions');
  assert.equal(await urlOf(t, { provider: 'openai', ...key, baseUrl: ' https://proxy.test ' }), 'https://proxy.test/v1/chat/completions', 'trimmed');
});

test('openai_compatible: Groq is the default server, and any other server is used as given', async (t) => {
  const key = { apiKey: 'gsk-test-123' };
  assert.equal(await urlOf(t, { provider: 'openai_compatible', ...key }), 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(await urlOf(t, { provider: 'openai_compatible', ...key, baseUrl: 'http://localhost:1234' }), 'http://localhost:1234/v1/chat/completions');
  assert.equal(await urlOf(t, { provider: 'openai_compatible', baseUrl: 'http://192.168.1.20:8000/v1' }), 'http://192.168.1.20:8000/v1/chat/completions', 'no key at all');
});

test('openrouter: the base URL of the settings is not used', async (t) => {
  const key = { apiKey: 'sk-or-test-123' };
  assert.equal(await urlOf(t, { provider: 'openrouter', ...key }), 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(await urlOf(t, { provider: 'openrouter', ...key, baseUrl: 'https://evil.example/v1' }), 'https://openrouter.ai/api/v1/chat/completions');
});

test('the default model of each provider, and the model of the settings (trimmed)', async (t) => {
  const sent = spyFetch(t);
  const modelSent = async (settings: LlmSettings) => {
    await generateCompletion({ apiKey: 'sk-test-123', ...settings }, TURNS, 'SYS');
    const request = sent.at(-1)!;
    return request.body.model ?? request.url.match(/models\/([^:]+):/)?.[1];
  };
  assert.equal(await modelSent({ provider: 'openrouter' }), 'anthropic/claude-3.5-sonnet');
  assert.equal(await modelSent({ provider: 'openai' }), 'gpt-4o-mini');
  assert.equal(await modelSent({ provider: 'openai_compatible' }), 'gpt-4o-mini', 'as before: only the settings screen defaults it to a Groq model');
  assert.equal(await modelSent({ provider: 'anthropic' }), 'claude-3-5-sonnet-20241022');
  assert.equal(await modelSent({ provider: 'gemini' }), 'gemini-1.5-flash');
  assert.equal(await modelSent({ provider: 'openai', model: '  gpt-4o  ' }), 'gpt-4o');
  assert.equal(await modelSent({ provider: 'openai', model: '   ' }), 'gpt-4o-mini', 'a blank model is no model');
});

test('the key: the top-level key wins, the saved key is the fallback, and both are trimmed', async (t) => {
  const sent = spyFetch(t);
  const bearer = async (settings: LlmSettings) => {
    await generateCompletion({ provider: 'openai', ...settings }, TURNS, 'SYS');
    return sent.at(-1)!.headers.authorization;
  };
  const saved = { openai: { apiKey: 'sk-saved' } };
  assert.equal(await bearer({ apiKey: 'sk-top', providerConfigs: saved }), 'Bearer sk-top');
  assert.equal(await bearer({ apiKey: '', providerConfigs: saved }), 'Bearer sk-saved');
  assert.equal(await bearer({ providerConfigs: saved }), 'Bearer sk-saved');
  assert.equal(await bearer({ apiKey: '  sk-top \n' }), 'Bearer sk-top');
  assert.equal(await bearer({ providerConfigs: { anthropic: { apiKey: 'sk-other' } } }), undefined, 'the key of another provider is not sent');
});

test('the temperature is the settings\' own, 0 included, and 0.1 when there is none', async (t) => {
  const sent = spyFetch(t);
  for (const provider of ['openrouter', 'openai', 'openai_compatible', 'anthropic']) {
    await generateCompletion({ provider, apiKey: 'sk-test-123' }, TURNS, 'SYS');
    assert.equal(sent.at(-1)!.body.temperature, 0.1, `${provider}: default`);
    await generateCompletion({ provider, apiKey: 'sk-test-123', temperature: 0 }, TURNS, 'SYS');
    assert.equal(sent.at(-1)!.body.temperature, 0, `${provider}: zero is kept`);
    await generateCompletion({ provider, apiKey: 'sk-test-123', temperature: 0.7 }, TURNS, 'SYS');
    assert.equal(sent.at(-1)!.body.temperature, 0.7, `${provider}: 0.7`);
  }
});

test('the OpenAI family sends the turns as they are, after the system prompt', async (t) => {
  const sent = spyFetch(t);
  await generateCompletion({ provider: 'openrouter', apiKey: 'sk-or-test-123' }, TURNS, 'SYS');
  assert.deepEqual(sent[0].body.messages, [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'prev' },
    { role: 'user', content: 'next' }
  ]);
});

test('json and schema ask for nothing from the cloud providers: no format, no response_format, no schema', async (t) => {
  const sent = spyFetch(t);
  const schema = { type: 'object', oneOf: [{ properties: { action: { const: 'click' } } }] };
  for (const provider of ['openrouter', 'openai', 'openai_compatible', 'anthropic', 'gemini']) {
    await generateCompletion({ provider, apiKey: 'sk-test-123' }, TURNS, 'SYS', { json: true, schema });
    const request = sent.at(-1)!;
    assert.doesNotMatch(JSON.stringify(request.body), /oneOf|response_format|"format"|responseSchema|responseMimeType|tools/, provider);
  }
});

test('one call is one request, whatever the provider answers', async (t) => {
  const sent = spyFetch(t, () => new Response('overloaded', { status: 529 }));
  for (const provider of ['openrouter', 'openai', 'openai_compatible', 'anthropic', 'gemini']) {
    sent.length = 0;
    await assert.rejects(generateCompletion({ provider, apiKey: 'sk-test-123' }, TURNS, 'SYS'));
    assert.equal(sent.length, 1, `${provider}: LangChain's own 6 retries are off, callWithRetry is the only retry layer`);
  }
});

test('a chat model is built for every call: two calls do not share a client', async (t) => {
  const sent = spyFetch(t);
  await generateCompletion({ provider: 'openai', apiKey: 'sk-first-key' }, TURNS, 'SYS');
  await generateCompletion({ provider: 'openai', apiKey: 'sk-second-key', baseUrl: 'http://localhost:9999' }, TURNS, 'SYS');
  assert.equal(sent[0].headers.authorization, 'Bearer sk-first-key');
  assert.equal(sent[1].headers.authorization, 'Bearer sk-second-key');
  assert.equal(sent[1].url, 'http://localhost:9999/v1/chat/completions');
});

test('callbacks in the options are handed to the model, for opt-in tracing', async (t) => {
  spyFetch(t);
  for (const provider of ['openai', 'anthropic', 'gemini']) {
    const started: string[] = [];
    const handler = BaseCallbackHandler.fromMethods({
      handleChatModelStart: (llm) => { started.push(String(llm.id.at(-1))); }
    });
    await generateCompletion({ provider, apiKey: 'sk-test-123' }, TURNS, 'SYS', { callbacks: [handler] });
    assert.equal(started.length, 1, `${provider}: the handler saw the call`);
  }
});
