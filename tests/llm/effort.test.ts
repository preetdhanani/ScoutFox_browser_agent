/**
 * The model's reasoning effort: src/background/llm/effort.ts and the tool-call wire in llm/index.ts.
 *
 * Before this, the composer's effort reached AgentRunner.startTask and was never read: every
 * request went out with no reasoning field, whatever the user picked. These tests pin:
 *   1. which provider + model takes which dialect, and that a custom endpoint takes none;
 *   2. the exact request fields of every level in every dialect;
 *   3. what the endpoints report (OpenRouter, Gemini, Anthropic, Ollama) wins over the built-in list;
 *   4. a refused field or value never ends a run: the round is sent again, learned or without it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyEffortPatch,
  nearestSupportedLevel,
  clearEffortCache,
  effortPatch,
  effortSupportOf,
  geminiThinkingConfig,
  learnValuesFromError,
  nativeValue,
  normalizeEffort,
  ollamaThink,
  oneLevelLower,
  readOllamaShow,
  rememberAnthropicList,
  rememberGeminiList,
  rememberOpenRouterList,
  resolveEffortSupport
} from '../../src/background/llm/effort.ts';
import { callProviderWithTools } from '../../src/background/llm/index.ts';
import { fetchAvailableModels } from '../../src/background/llm/models.ts';
import { jsonResponse, spyFetch } from '../helpers/llmWire.ts';

const TOOLS = [{ name: 'finish', description: 'Done', inputSchema: { type: 'object', properties: { answer: { type: 'string' } } } }];
const HISTORY = [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'Go' }];

const openaiReply = (message: Record<string, unknown> = { content: 'ok' }) => jsonResponse({ choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: 'stop' }] });

const NEMOTRON = { provider: 'nvidia', apiKey: 'nvapi-test', model: 'nvidia/nemotron-3.5-super-vl-120b-a12b' };

test.beforeEach(() => clearEffortCache());

test('levels: the old xhigh is max, unknown is auto, and a routine step is one level less but never below low', () => {
  assert.equal(normalizeEffort('xhigh'), 'max');
  assert.equal(normalizeEffort('HIGH'), 'high');
  assert.equal(normalizeEffort('bogus'), 'auto');
  assert.equal(normalizeEffort(undefined), 'auto');
  assert.equal(oneLevelLower('max'), 'high');
  assert.equal(oneLevelLower('medium'), 'low');
  assert.equal(oneLevelLower('low'), 'low');
  assert.equal(oneLevelLower('off'), 'off');
  assert.equal(oneLevelLower('auto'), 'auto');
});

test('a custom endpoint never takes an effort, even with a model name the built-in list knows', () => {
  const settings = {
    provider: 'my-gw',
    model: 'gpt-5.5',
    customProviders: { 'my-gw': { id: 'my-gw', displayName: 'Gateway', protocol: 'openai', baseUrl: 'https://gw.example/v1', keyMode: 'key', models: [] } }
  } as any;
  const support = effortSupportOf(settings);
  assert.equal(support.dialect, 'none');
  assert.deepEqual(support.levels, ['auto']);
  assert.match(support.note, /not sent to custom endpoints/);
  // The built-in "OpenAI compatible" provider pointed at a server ScoutFox does not know is the same.
  assert.equal(effortSupportOf({ provider: 'openai_compatible', baseUrl: 'http://localhost:8000/v1', model: 'qwen3-32b' }).dialect, 'none');
  assert.equal(effortSupportOf({ provider: 'openai_compatible', baseUrl: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b' }).dialect, 'openai', 'Groq is known');
  assert.equal(effortSupportOf({ provider: 'openai_compatible', model: 'openai/gpt-oss-120b' }).dialect, 'none', 'no base URL: the host is not known, so nothing is assumed');
});

test('the built-in list: each provider and model family gets its dialect and the levels it can take', () => {
  const of = (settings: any) => effortSupportOf(settings);
  assert.equal(of(NEMOTRON).dialect, 'nemotron');
  assert.deepEqual(of(NEMOTRON).levels, ['auto', 'off', 'low', 'medium', 'high', 'max']);
  assert.equal(of({ provider: 'nvidia', model: 'meta/llama-3.3-70b-instruct' }).dialect, 'none');
  assert.equal(of({ provider: 'nvidia', model: 'openai/gpt-oss-120b' }).dialect, 'openai');
  assert.deepEqual(of({ provider: 'nvidia', model: 'openai/gpt-oss-120b' }).levels, ['auto', 'low', 'medium', 'high'], 'gpt-oss cannot stop thinking and has nothing above high');
  assert.equal(of({ provider: 'openai', model: 'gpt-4o-mini' }).dialect, 'none');
  assert.deepEqual(of({ provider: 'openai', model: 'o3' }).levels, ['auto', 'low', 'medium', 'high']);
  assert.deepEqual(of({ provider: 'openai', model: 'gpt-5' }).levels, ['auto', 'off', 'low', 'medium', 'high'], 'gpt-5: off is minimal');
  assert.deepEqual(of({ provider: 'openai', model: 'gpt-5.5' }).levels, ['auto', 'off', 'low', 'medium', 'high', 'max']);
  assert.equal(of({ provider: 'anthropic', model: 'claude-sonnet-4-5-20250929' }).dialect, 'anthropic-budget');
  assert.equal(of({ provider: 'anthropic', model: 'claude-opus-5-5' }).dialect, 'anthropic-adaptive');
  assert.equal(of({ provider: 'anthropic', model: 'claude-opus-4-7' }).dialect, 'anthropic-adaptive');
  assert.equal(of({ provider: 'anthropic', model: 'claude-3-5-sonnet-20241022' }).dialect, 'none');
  assert.equal(of({ provider: 'gemini', model: 'gemini-2.5-flash' }).dialect, 'gemini-budget');
  assert.deepEqual(of({ provider: 'gemini', model: 'gemini-2.5-pro' }).levels, ['auto', 'low', 'medium', 'high', 'max'], '2.5 Pro cannot stop thinking');
  assert.equal(of({ provider: 'gemini', model: 'gemini-3-pro' }).dialect, 'gemini-level');
  assert.equal(of({ provider: 'gemini', model: 'gemini-1.5-flash' }).dialect, 'none');
  assert.equal(of({ provider: 'ollama', model: 'gpt-oss:20b' }).dialect, 'ollama-level');
  assert.equal(of({ provider: 'ollama', model: 'llama3.1:8b' }).dialect, 'none');
  assert.equal(of({ provider: 'agent_router', model: 'claude-3-5-sonnet' }).dialect, 'none');
});

test('a level maps onto the values a model accepts: same value, else the nearest, max is the strongest, off is none or minimal', () => {
  assert.equal(nativeValue('medium', ['low', 'medium', 'high']), 'medium');
  assert.equal(nativeValue('max', ['low', 'medium', 'high']), 'high');
  assert.equal(nativeValue('max', ['none', 'low', 'medium', 'high', 'xhigh']), 'xhigh');
  assert.equal(nativeValue('off', ['low', 'medium', 'high']), null);
  assert.equal(nativeValue('off', ['minimal', 'low']), 'minimal');
  assert.equal(nativeValue('off', ['none', 'minimal', 'low']), 'none');
  assert.equal(nativeValue('medium', ['low', 'high']), 'low', 'a tie takes the weaker one');
  assert.equal(nativeValue('auto', ['low']), null);
});

test('the request fields of every dialect', () => {
  assert.deepEqual(effortPatch('nemotron', 'medium').set, { chat_template_kwargs: { enable_thinking: true }, reasoning_budget: 4096 });
  assert.deepEqual(effortPatch('nemotron', 'off').set, { chat_template_kwargs: { enable_thinking: false } });
  assert.deepEqual(effortPatch('nemotron', 'auto').set, {}, 'auto sends nothing');
  assert.deepEqual(effortPatch('none', 'high').set, {});
  assert.deepEqual(effortPatch('openai', 'high', ['low', 'medium', 'high']).set, { reasoning_effort: 'high' });
  assert.deepEqual(effortPatch('openai', 'off', ['low', 'medium', 'high']).set, {}, 'a level the model has no value for sends nothing');
  assert.deepEqual(effortPatch('anthropic-budget', 'low').set, { thinking: { type: 'enabled', budget_tokens: 1024 } });
  assert.deepEqual(effortPatch('anthropic-budget', 'low').remove, ['temperature']);
  assert.deepEqual(effortPatch('anthropic-adaptive', 'high', ['low', 'medium', 'high', 'xhigh', 'max']).set, { thinking: { type: 'adaptive' }, output_config: { effort: 'high' } });
  assert.deepEqual(effortPatch('anthropic-adaptive', 'off').set, { thinking: { type: 'disabled' } });
  assert.deepEqual(effortPatch('openrouter', 'max', ['low', 'medium', 'high']).set, { reasoning: { effort: 'high' } });
  assert.deepEqual(effortPatch('openrouter', 'off', ['none', 'low']).set, { reasoning: { effort: 'none' } });
  assert.equal(ollamaThink('ollama-bool', 'off'), false);
  assert.equal(ollamaThink('ollama-bool', 'max'), true);
  assert.equal(ollamaThink('ollama-bool', 'auto'), undefined);
  assert.equal(ollamaThink('ollama-level', 'max', ['low', 'medium', 'high']), 'high');
  assert.equal(ollamaThink('ollama-level', 'off', ['low', 'medium', 'high']), 'low');
  assert.deepEqual(geminiThinkingConfig('gemini-budget', 'off'), { thinkingBudget: 0 });
  assert.deepEqual(geminiThinkingConfig('gemini-budget', 'high'), { thinkingBudget: 12000 });
  assert.deepEqual(geminiThinkingConfig('gemini-level', 'medium'), { thinkingLevel: 'MEDIUM' });
  assert.equal(geminiThinkingConfig('gemini-level', 'auto'), undefined);
});

test('a budget raises max_tokens above it, and auto leaves the body alone', () => {
  const base = { model: 'm', temperature: 0.1, max_tokens: 8192 };
  const nemotron = applyEffortPatch(base, effortPatch('nemotron', 'max'));
  assert.equal(nemotron.max_tokens, 32000, 'the budget plus room for the answer, capped at 32000');
  assert.equal(applyEffortPatch(base, effortPatch('nemotron', 'low')).max_tokens, 1024 + 8192);
  assert.equal(nemotron.temperature, 0.1);
  assert.equal(applyEffortPatch(base, effortPatch('nemotron', 'auto')), base, 'auto leaves the body as it was');
});

test('wire: NVIDIA Nemotron gets enable_thinking and a reasoning budget, and its reasoning_content comes back for the log', async (t) => {
  const sent = spyFetch(t, () => openaiReply({ content: 'ok', reasoning_content: 'I should finish.' }));
  const reply = await callProviderWithTools('nvidia', NEMOTRON, HISTORY, '', { tools: TOOLS, effort: 'low' });
  const body = sent[0].body;
  assert.deepEqual(body.chat_template_kwargs, { enable_thinking: true });
  assert.equal(body.reasoning_budget, 1024);
  assert.equal(body.max_tokens, 1024 + 8192);
  assert.equal(reply.reasoning, 'I should finish.');
  assert.equal(reply.effortSent?.dialect, 'nemotron');
  assert.deepEqual(reply.effortSent?.fields, { chat_template_kwargs: { enable_thinking: true }, reasoning_budget: 1024 });

  sent.length = 0;
  const auto = await callProviderWithTools('nvidia', NEMOTRON, HISTORY, '', { tools: TOOLS });
  for (const field of ['chat_template_kwargs', 'reasoning_budget', 'reasoning_effort']) assert.equal(field in sent[0].body, false, `auto sends no ${field}`);
  assert.equal(auto.effortSent, null);
});

test('wire: a custom endpoint gets no reasoning field at any level', async (t) => {
  const sent = spyFetch(t, () => openaiReply());
  const settings = {
    provider: 'my-gw',
    model: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
    apiKey: 'k',
    customProviders: { 'my-gw': { id: 'my-gw', displayName: 'Gateway', protocol: 'openai', baseUrl: 'https://gw.example/v1', keyMode: 'key', models: [] } }
  } as any;
  const reply = await callProviderWithTools('my-gw', settings, HISTORY, '', { tools: TOOLS, effort: 'max' });
  for (const field of ['chat_template_kwargs', 'reasoning_budget', 'reasoning_effort', 'thinking', 'reasoning', 'output_config']) {
    assert.equal(field in sent[0].body, false, `no ${field}`);
  }
  assert.equal(sent[0].body.max_tokens, 8192);
  assert.equal(reply.effortSent, null);
});

test('wire: OpenAI reasoning models get reasoning_effort, no temperature, and max_completion_tokens', async (t) => {
  const sent = spyFetch(t, () => openaiReply());
  await callProviderWithTools('openai', { provider: 'openai', apiKey: 'sk', model: 'o3' }, HISTORY, '', { tools: TOOLS, effort: 'medium' });
  const body = sent[0].body;
  assert.equal(body.reasoning_effort, 'medium');
  assert.equal('temperature' in body, false);
  assert.equal('max_tokens' in body, false);
  assert.equal(body.max_completion_tokens, 8192);

  sent.length = 0;
  await callProviderWithTools('openai', { provider: 'openai', apiKey: 'sk', model: 'gpt-4o-mini' }, HISTORY, '', { tools: TOOLS, effort: 'high' });
  assert.equal('reasoning_effort' in sent[0].body, false, 'a model that cannot reason gets nothing');
  assert.equal(sent[0].body.temperature, 0.1);
});

test('wire: a 400 that lists the accepted values is learned, the round is sent again with one of them, and later calls use it', async (t) => {
  let calls = 0;
  const sent = spyFetch(t, () => {
    calls += 1;
    return calls === 1
      ? jsonResponse({ message: 'unknown variant `xhigh`, expected one of `none`, `low`, `medium`, `high`', code: 400 }, 400)
      : openaiReply();
  });
  const settings = { provider: 'openai', apiKey: 'sk', model: 'gpt-5.9-preview' };
  const reply = await callProviderWithTools('openai', settings, HISTORY, '', { tools: TOOLS, effort: 'max' });
  assert.equal(sent[0].body.reasoning_effort, 'xhigh');
  assert.equal(sent[1].body.reasoning_effort, 'high', 'max is now the strongest accepted value');
  assert.equal(reply.effortSent?.fields.reasoning_effort, 'high');
  assert.deepEqual(effortSupportOf(settings).levels, ['auto', 'off', 'low', 'medium', 'high']);
});

test('wire: a 400 that refuses the field sends the round again without it, and the model never gets it again', async (t) => {
  let calls = 0;
  const sent = spyFetch(t, () => {
    calls += 1;
    return calls === 1 ? jsonResponse({ message: 'Validation: Unsupported parameter(s): `reasoning_budget`', code: 400 }, 400) : openaiReply();
  });
  const reply = await callProviderWithTools('nvidia', NEMOTRON, HISTORY, '', { tools: TOOLS, effort: 'high' });
  assert.equal(sent.length, 2);
  assert.equal('reasoning_budget' in sent[1].body, false);
  assert.equal(reply.effortSent, null);
  assert.equal(effortSupportOf(NEMOTRON).source, 'learned');

  await callProviderWithTools('nvidia', NEMOTRON, HISTORY, '', { tools: TOOLS, effort: 'high' });
  assert.equal(sent.length, 3, 'one request: nothing to refuse any more');
  assert.equal('reasoning_budget' in sent[2].body, false);
});

test('wire: a 400 about something else is not taken for a refused effort', async (t) => {
  const sent = spyFetch(t, () => jsonResponse({ message: 'Invalid image', code: 400 }, 400));
  await assert.rejects(callProviderWithTools('nvidia', NEMOTRON, HISTORY, '', { tools: TOOLS, effort: 'high' }), /API error: 400/);
  assert.equal(sent.length, 1);
  assert.equal(effortSupportOf(NEMOTRON).source, 'registry');
});

test('wire: Ollama gets think from /api/show, and a model that refuses it gets the round again without it', async (t) => {
  const sent = spyFetch(t, (request) => {
    if (request.url.endsWith('/api/show')) return jsonResponse({ capabilities: ['completion', 'tools', 'thinking'] });
    if (request.body?.think !== undefined && request.body.model === 'old:1b') return jsonResponse({ error: '"old:1b" does not support thinking' }, 400);
    return jsonResponse({ message: { role: 'assistant', content: 'ok', thinking: 'hmm' }, done: true });
  });
  const reply = await callProviderWithTools('ollama', { provider: 'ollama', model: 'qwen3:8b', baseUrl: 'http://localhost:11434' }, HISTORY, '', { tools: TOOLS, effort: 'off' });
  const chat = sent.filter((r) => r.url.endsWith('/api/chat'));
  assert.equal(chat[0].body.think, false);
  assert.equal(reply.reasoning, 'hmm');
  assert.equal(reply.effortSent?.dialect, 'ollama-bool');

  const old = await callProviderWithTools('ollama', { provider: 'ollama', model: 'old:1b', baseUrl: 'http://localhost:11434' }, HISTORY, '', { tools: TOOLS, effort: 'high' });
  const oldChat = sent.filter((r) => r.url.endsWith('/api/chat') && r.body.model === 'old:1b');
  assert.equal(oldChat.length, 2);
  assert.equal(oldChat[0].body.think, true);
  assert.equal('think' in oldChat[1].body, false);
  assert.equal(old.effortSent, null);
});

test('an Ollama model that only switches thinking offers Auto, Off and Medium: four levels sending think:true would be a lie', async (t) => {
  spyFetch(t, () => jsonResponse({ capabilities: ['completion', 'tools', 'thinking'], thinking: { values: [true, false] } }));
  const support = await resolveEffortSupport({ provider: 'ollama', model: 'qwen3:8b' });
  assert.equal(support.dialect, 'ollama-bool');
  assert.deepEqual(support.levels, ['auto', 'off', 'medium']);
});

test('discovery: Ollama /api/show thinking.values decides the dialect and the levels', async () => {
  assert.deepEqual(readOllamaShow({ capabilities: ['thinking'], thinking: { values: ['low', 'medium', 'high'] } }, 'gpt-oss:20b'), { reasoning: true, dialect: 'ollama-level', values: ['low', 'medium', 'high'] });
  assert.deepEqual(readOllamaShow({ thinking: { values: [true, false] } }, 'qwen3'), { reasoning: true, dialect: 'ollama-bool' });
  assert.deepEqual(readOllamaShow({ thinking: { values: [false] } }, 'llama'), { reasoning: false });
  assert.deepEqual(readOllamaShow({ capabilities: ['completion', 'tools'] }, 'llama'), { reasoning: false });
  assert.equal(readOllamaShow({}, 'x'), null, 'an old server says nothing');
});

test('discovery: an Ollama model that reports no thinking takes no effort, even when the list would guess one', async (t) => {
  spyFetch(t, () => jsonResponse({ capabilities: ['completion', 'tools'] }));
  const support = await resolveEffortSupport({ provider: 'ollama', model: 'gpt-oss:20b' });
  assert.equal(support.dialect, 'none');
  assert.equal(support.source, 'endpoint');
});

test('discovery: OpenRouter, Gemini and Anthropic model lists say which models reason and with which values', () => {
  rememberOpenRouterList({ provider: 'openrouter' }, [
    { id: 'meta/llama-3', supported_parameters: ['tools'] },
    { id: 'deepseek/r1', supported_parameters: ['tools', 'reasoning'], reasoning: { supported_efforts: ['low', 'medium', 'high'] } }
  ]);
  assert.equal(effortSupportOf({ provider: 'openrouter', model: 'meta/llama-3' }).dialect, 'none');
  assert.deepEqual(effortSupportOf({ provider: 'openrouter', model: 'deepseek/r1' }).levels, ['auto', 'low', 'medium', 'high']);

  rememberGeminiList({ provider: 'gemini' }, [{ name: 'models/gemini-2.5-flash', thinking: true }, { name: 'models/gemini-2.0-flash', thinking: false }]);
  assert.equal(effortSupportOf({ provider: 'gemini', model: 'gemini-2.5-flash' }).source, 'endpoint');
  assert.equal(effortSupportOf({ provider: 'gemini', model: 'gemini-2.0-flash' }).dialect, 'none');

  rememberAnthropicList({ provider: 'anthropic' }, [
    { id: 'claude-x-adaptive', capabilities: { thinking: { supported: true, types: { adaptive: { supported: true } } }, effort: { low: { supported: true }, high: { supported: true }, max: { supported: true } } } },
    { id: 'claude-x-budget', capabilities: { thinking: { supported: true, types: { enabled: { supported: true } } } } },
    { id: 'claude-x-plain', capabilities: { thinking: { supported: false } } }
  ]);
  const adaptive = effortSupportOf({ provider: 'anthropic', model: 'claude-x-adaptive' });
  assert.equal(adaptive.dialect, 'anthropic-adaptive');
  assert.deepEqual(adaptive.levels, ['auto', 'off', 'low', 'high', 'max'], 'only the effort values the model lists, plus off (thinking disabled)');
  assert.equal(effortSupportOf({ provider: 'anthropic', model: 'claude-x-budget' }).dialect, 'anthropic-budget');
  assert.equal(effortSupportOf({ provider: 'anthropic', model: 'claude-x-plain' }).dialect, 'none');
});

test('discovery: the OpenRouter model fetch records reasoning support on the way', async (t) => {
  spyFetch(t, () => jsonResponse({ data: [{ id: 'x/thinker', supported_parameters: ['reasoning'] }, { id: 'x/plain', supported_parameters: ['tools'] }] }));
  await fetchAvailableModels({ provider: 'openrouter', apiKey: 'or' }, true);
  assert.equal(effortSupportOf({ provider: 'openrouter', model: 'x/thinker' }).source, 'endpoint');
  assert.equal(effortSupportOf({ provider: 'openrouter', model: 'x/plain' }).dialect, 'none');
});

test('learnValuesFromError reads the NIM wording and ignores a text without a list', () => {
  const settings = { provider: 'nvidia', model: 'x/y' };
  assert.equal(learnValuesFromError(settings, 'openai', 'unknown variant `zzz`, expected one of `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`', 'zzz'), true);
  assert.deepEqual(effortSupportOf(settings).levels, ['auto', 'off', 'low', 'medium', 'high', 'max']);
  assert.equal(learnValuesFromError(settings, 'openai', 'Unsupported parameter(s): `reasoning_effort`', 'low'), false);
  // An "expected one of" about another field (tool_choice) is not the model's effort values.
  const other = { provider: 'nvidia', model: 'x/z' };
  assert.equal(learnValuesFromError(other, 'openai', 'tool_choice: unknown variant `any`, expected one of `none`, `auto`', 'low'), false);
  assert.equal(effortSupportOf(other).source, 'none');
});

test('wire: Gemini gets generationConfig.thinkingConfig', async (t) => {
  const sent = spyFetch(t, () => new Response(
    `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'done' }] }, index: 0 }] })}\r\n\r\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  ));
  const reply = await callProviderWithTools('gemini', { provider: 'gemini', apiKey: 'AIza', model: 'gemini-2.5-flash' }, HISTORY, '', { tools: TOOLS, effort: 'high' });
  assert.deepEqual(sent[0].body.generationConfig.thinkingConfig, { thinkingBudget: 12000 });
  assert.deepEqual(reply.effortSent?.fields, { thinkingConfig: { thinkingBudget: 12000 } });
});

test('Max never asks for more than 32000 tokens, the cap of Claude Opus 4', () => {
  const body = applyEffortPatch({ model: 'm', temperature: 0.1, max_tokens: 8192 }, effortPatch('anthropic-budget', 'max'));
  assert.equal(body.max_tokens, 32000);
  assert.ok((body.thinking as any).budget_tokens < (body.max_tokens as number), 'the budget stays below max_tokens');
});

test('wire: a token limit raised by the effort and refused sends the round again without the effort', async (t) => {
  let calls = 0;
  const sent = spyFetch(t, () => (++calls === 1 ? jsonResponse({ error: { message: 'max_tokens: 32000 > 16000, which is the maximum allowed' } }, 400) : openaiReply()));
  await callProviderWithTools('nvidia', NEMOTRON, HISTORY, '', { tools: TOOLS, effort: 'max' });
  assert.equal(sent.length, 2);
  assert.equal(sent[1].body.max_tokens, 8192);
  assert.equal('reasoning_budget' in sent[1].body, false);
});

test('wire: a 400 that only mentions reasoning_details is not a refused effort', async (t) => {
  const sent = spyFetch(t, () => jsonResponse({ message: 'messages[2].reasoning_details is not allowed' }, 400));
  await assert.rejects(callProviderWithTools('openrouter', { provider: 'openrouter', apiKey: 'or', model: 'x/y' }, HISTORY, '', { tools: TOOLS, effort: 'high' }));
  assert.equal(sent.length, 1, 'no retry: the effort was not what was refused');
});

test('wire: OpenRouter reasoning_details go back to OpenRouter only', async (t) => {
  const history = [...HISTORY, { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'finish', arguments: '{}' } }], reasoning_details: [{ type: 'reasoning.text', text: 'x' }] }, { role: 'tool', tool_call_id: 'c1', content: 'ok' }];
  const sent = spyFetch(t, () => openaiReply());
  await callProviderWithTools('openrouter', { provider: 'openrouter', apiKey: 'or', model: 'x/y' }, history, '', { tools: TOOLS });
  assert.ok(sent[0].body.messages.some((m: any) => Array.isArray(m.reasoning_details)));
  await callProviderWithTools('nvidia', NEMOTRON, history, '', { tools: TOOLS });
  assert.ok(sent[1].body.messages.every((m: any) => !('reasoning_details' in m)), 'NIM refuses unknown message fields');
});

test('wire: a level the model does not offer is sent as the nearest one it does (Off on Gemini 2.5 Pro is Low)', async (t) => {
  const sent = spyFetch(t, () => new Response(
    `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'done' }] }, index: 0 }] })}\r\n\r\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  ));
  await callProviderWithTools('gemini', { provider: 'gemini', apiKey: 'AIza', model: 'gemini-2.5-pro' }, HISTORY, '', { tools: TOOLS, effort: 'off' });
  assert.deepEqual(sent[0].body.generationConfig.thinkingConfig, { thinkingBudget: 1024 }, 'never thinkingBudget 0, which 2.5 Pro refuses');
});

test('wire: Gemini that refuses the thinkingConfig gets the round again without it', async (t) => {
  let calls = 0;
  const sent = spyFetch(t, () => (++calls === 1
    ? jsonResponse({ error: { code: 400, message: 'Thinking level is not supported for this model.', status: 'INVALID_ARGUMENT' } }, 400)
    : new Response(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'done' }] }, index: 0 }] })}\r\n\r\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } })));
  const reply = await callProviderWithTools('gemini', { provider: 'gemini', apiKey: 'AIza', model: 'gemini-3-flash' }, HISTORY, '', { tools: TOOLS, effort: 'high' });
  assert.equal(sent.length, 2);
  assert.equal(sent[1].body.generationConfig?.thinkingConfig, undefined);
  assert.equal(reply.effortSent, null);
});

test('wire: OpenAI reasoning models never get a temperature, not even on Auto', async (t) => {
  const sent = spyFetch(t, () => openaiReply());
  await callProviderWithTools('openai', { provider: 'openai', apiKey: 'sk', model: 'gpt-5.5' }, HISTORY, '', { tools: TOOLS });
  assert.equal('temperature' in sent[0].body, false);
  assert.equal('max_tokens' in sent[0].body, false);
  assert.equal(sent[0].body.max_completion_tokens, 8192);
});

test('a level that thinks is never sent as Off: Low on an on/off model is Medium (on), not Off', () => {
  assert.equal(nearestSupportedLevel('low', ['auto', 'off', 'medium']), 'medium');
  assert.equal(nearestSupportedLevel('max', ['auto', 'off', 'medium']), 'medium');
  assert.equal(nearestSupportedLevel('off', ['auto', 'low', 'medium', 'high']), 'low', 'Off on a model that cannot stop thinking is its lowest level');
  assert.equal(nearestSupportedLevel('high', ['auto', 'off']), 'auto', 'a thinking level is never Off: with nothing else, nothing is sent');
  assert.equal(nearestSupportedLevel('high', ['auto']), 'auto');
});
