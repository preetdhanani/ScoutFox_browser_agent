/**
 * The token usage of a model call, for the context meter.
 *
 * What these tests hold on to:
 *   1. Each wire shape is read: OpenAI's usage.prompt_tokens / completion_tokens, Ollama's
 *      prompt_eval_count / eval_count, LangChain's usage_metadata. A reply without one gives none
 *      (never zeros, which would read as an empty context).
 *   2. The tool paths hand the usage back on the reply (OpenAI-compatible and Ollama), and the
 *      prompt path (Gemini) gets it from LangChain.
 *   3. The MCP client's callUsage: the reported number, the estimate when none came (marked
 *      estimated), and for Ollama the larger of the two, since Ollama leaves its cached prefix out.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { callProviderWithTools, usageOfMessage, usageOfOllama, usageOfOpenAI } from '../../src/background/llm/index.ts';
import { callUsage } from '../../src/background/mcp/client.ts';
import { estimatePromptTokens } from '../../src/shared/tokens.ts';
import { jsonResponse, spyFetch } from '../helpers/llmWire.ts';

const TOOLS = [{ name: 'navigate', description: 'Go to a URL', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } }];
const MESSAGES = [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'Open example.com' }];

test('each wire shape of usage is read, and a reply without one gives none', () => {
  assert.deepEqual(usageOfOpenAI({ usage: { prompt_tokens: 1200, completion_tokens: 40 } }), { promptTokens: 1200, outputTokens: 40 });
  assert.deepEqual(usageOfOllama({ prompt_eval_count: 900, eval_count: 12 }), { promptTokens: 900, outputTokens: 12 });
  assert.deepEqual(usageOfMessage({ usage_metadata: { input_tokens: 77, output_tokens: 5, total_tokens: 82 } }), { promptTokens: 77, outputTokens: 5 });
  assert.equal(usageOfOpenAI({ choices: [] }), undefined);
  assert.equal(usageOfOpenAI({ usage: {} }), undefined);
  assert.equal(usageOfOllama({ message: {} }), undefined);
  assert.equal(usageOfMessage({ content: 'hi' }), undefined);
  assert.deepEqual(usageOfOpenAI({ usage: { prompt_tokens: 10 } }), { promptTokens: 10, outputTokens: 0 }, 'no completion count is 0 output');
});

test('the OpenAI-compatible tool path hands the usage back on the reply', async (t) => {
  spyFetch(t, () => jsonResponse({
    choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3456, completion_tokens: 21 }
  }));
  const reply = await callProviderWithTools('openrouter', { provider: 'openrouter', apiKey: 'sk-test', model: 'm' }, MESSAGES, '', { tools: TOOLS });
  assert.deepEqual(reply.usage, { promptTokens: 3456, outputTokens: 21 });
});

test('the OpenAI-compatible tool path has no usage when the server sends none', async (t) => {
  spyFetch(t, () => jsonResponse({ choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }] }));
  const reply = await callProviderWithTools('openrouter', { provider: 'openrouter', apiKey: 'sk-test', model: 'm' }, MESSAGES, '', { tools: TOOLS });
  assert.equal(reply.usage, undefined);
});

test('the Ollama tool path hands back prompt_eval_count and eval_count', async (t) => {
  spyFetch(t, (request) => (request.url.endsWith('/api/show')
    ? jsonResponse({ capabilities: ['completion', 'tools'] })
    : jsonResponse({ message: { role: 'assistant', content: 'ok' }, done: true, prompt_eval_count: 812, eval_count: 9 })));
  const reply = await callProviderWithTools('ollama', { provider: 'ollama', baseUrl: 'http://ollama.test:11434', model: 'usage-test-model' }, MESSAGES, '', { tools: TOOLS });
  assert.deepEqual(reply.usage, { promptTokens: 812, outputTokens: 9 });
});

test('the prompt path (Gemini) takes the usage LangChain reports', async (t) => {
  const stream = `data: ${JSON.stringify({
    candidates: [{ content: { role: 'model', parts: [{ text: 'All done.' }] }, index: 0, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 640, candidatesTokenCount: 4, totalTokenCount: 644 }
  })}\r\n\r\n`;
  spyFetch(t, () => new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
  const reply = await callProviderWithTools('gemini', { provider: 'gemini', apiKey: 'AIza-test', model: 'gemini-1.5-flash' }, MESSAGES, '', { tools: TOOLS });
  assert.equal(reply.usage?.promptTokens, 640);
  assert.equal(reply.usage?.outputTokens, 4);
});

test('callUsage: the reported prompt, the estimate when none came, and for Ollama the larger of the two', () => {
  const sent = { messages: [{ role: 'system', content: 'x'.repeat(8000) }], tools: TOOLS };
  const estimate = estimatePromptTokens(sent.messages, sent.tools);
  assert.deepEqual(callUsage({ text: 'hi', usage: { promptTokens: 5000, outputTokens: 7 } }, sent, 'openrouter'), { promptTokens: 5000, outputTokens: 7, estimated: false });
  const none = callUsage({ text: 'hi' }, sent, 'openrouter');
  assert.equal(none.promptTokens, estimate);
  assert.equal(none.estimated, true);
  // Ollama counted only the part it did not have cached: the estimate of what was sent is larger.
  const cached = callUsage({ text: 'hi', usage: { promptTokens: 30, outputTokens: 2 } }, sent, 'ollama');
  assert.equal(cached.promptTokens, estimate);
  assert.equal(cached.estimated, true);
  const whole = callUsage({ text: 'hi', usage: { promptTokens: estimate + 500, outputTokens: 2 } }, sent, 'ollama');
  assert.deepEqual(whole, { promptTokens: estimate + 500, outputTokens: 2, estimated: false });
  // Another provider's own count is trusted as it is, even below the estimate.
  assert.equal(callUsage({ text: 'hi', usage: { promptTokens: 30, outputTokens: 2 } }, sent, 'openrouter').promptTokens, 30);
});
