/**
 * The Gemini request, built by the real ChatGoogleGenerativeAI in streaming mode and captured with a fetch spy.
 *
 * Streaming is not a choice: in non-streaming mode the client drops the abort signal, so neither Pause nor the
 * deadline could cancel the request (tests/llm/deadline.test.ts checks that it now does). Two things differ on the
 * wire from the old hand-written request, both accepted in the design: the endpoint is streamGenerateContent
 * with alt=sse, and the key travels in the x-goog-api-key header, no longer in the URL.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateCompletion } from '../../src/background/llm/index.ts';
import type { LlmSettings } from '../../src/background/llm/types.ts';
import { spyFetch } from '../helpers/llmWire.ts';

const KEY = 'AIza-test-123';
const SETTINGS: LlmSettings = { provider: 'gemini', apiKey: KEY, model: 'gemini-1.5-flash' };
const TURNS = [
  { role: 'user', content: 'hello' },
  { role: 'assistant', content: 'prev' },
  { role: 'user', content: 'next' }
];

const stream = (...chunks: string[]) => new Response(
  chunks.map((text) => `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text }] }, index: 0 }] })}\r\n\r\n`).join(''),
  { status: 200, headers: { 'content-type': 'text/event-stream' } }
);

test('the request streams from the model\'s own endpoint, and the key is a header, not part of the URL', async (t) => {
  const sent = spyFetch(t);
  await generateCompletion(SETTINGS, TURNS, 'SYS');

  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, 'POST');
  assert.equal(sent[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:streamGenerateContent?alt=sse');
  assert.doesNotMatch(sent[0].url, /key=/, 'the key is not in the URL');
  assert.equal(sent[0].headers['x-goog-api-key'], KEY);
  assert.match(sent[0].headers['content-type'], /^application\/json/);
});

test('the body has the system prompt, the turns as user and model, and the temperature', async (t) => {
  const sent = spyFetch(t);
  await generateCompletion({ ...SETTINGS, temperature: 0.3 }, TURNS, 'SYS');

  const { body } = sent[0];
  assert.equal(body.systemInstruction.parts[0].text, 'SYS');
  assert.deepEqual(body.contents, [
    { role: 'user', parts: [{ text: 'hello' }] },
    { role: 'model', parts: [{ text: 'prev' }] },
    { role: 'user', parts: [{ text: 'next' }] }
  ]);
  assert.equal(body.generationConfig.temperature, 0.3);
});

test('a temperature of 0 and the default temperature and model', async (t) => {
  const sent = spyFetch(t);
  await generateCompletion({ ...SETTINGS, temperature: 0 }, TURNS, 'SYS');
  assert.equal(sent[0].body.generationConfig.temperature, 0);

  await generateCompletion({ provider: 'gemini', apiKey: KEY }, TURNS, 'SYS');
  assert.equal(sent[1].body.generationConfig.temperature, 0.1);
  assert.match(sent[1].url, /\/models\/gemini-1\.5-flash:streamGenerateContent/, 'no model saved: the default');
});

test('the text of a streamed reply is all its chunks, joined', async (t) => {
  spyFetch(t, () => stream('{"action":', '"click",', ' "element_id": 3}'));
  assert.equal(await generateCompletion(SETTINGS, TURNS, 'SYS'), '{"action":"click", "element_id": 3}');
});

test('every turn that is not the assistant\'s is sent as the user\'s', async (t) => {
  const sent = spyFetch(t);
  await generateCompletion(SETTINGS, [{ role: 'user', content: 'a' }, { role: 'system', content: 'b' }, { role: 'assistant', content: 'c' }], 'SYS');
  assert.deepEqual(sent[0].body.contents.map((content: { role: string }) => content.role), ['user', 'user', 'model']);
});
