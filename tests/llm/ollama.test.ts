/**
 * Ollama through ChatOllama (llm/ollama.ts), on the real client, against a fetch spy that answers the way Ollama does
 * (NDJSON, because ChatOllama always streams).
 *
 * What is pinned, and where it came from:
 *   - the request: the old one (model, messages, format, think:false, num_ctx, num_predict, temperature) plus
 *     stream:true, with the old header (Content-Type only). P0a made the schema the `format`, and P2 must not lose it.
 *   - the fallbacks of P0a: a model that rejects `think` is retried once without it, a server older than 0.5 that
 *     rejects a schema is retried once with format "json", and both are remembered, per model and per server.
 *   - the reply: an empty `content` falls back to the reasoning text, and the truncation, context-pressure and empty
 *     warnings keep their tags.
 *   - the error texts: cannot connect (with the OLLAMA_ORIGINS hint), 404 (ollama pull), 403 (new), and the rest.
 *   - the client's own abort is broken (spike), so a call that was aborted must never come back as a short reply.
 * Deadline and Pause against a server that never answers are in deadline.test.ts and pause.test.ts.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import assert from 'node:assert/strict';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { Logger } from '../../src/shared/logger.ts';
import { buildActionSchema, buildPlanSchema } from '../../src/background/agent/schemas.ts';
import { callOllama, resetOllamaCaches } from '../../src/background/llm/ollama.ts';
import type { LlmSettings } from '../../src/background/llm/types.ts';
import { hangUntilAborted, ollamaReply, spyFetch, waitForRequests } from '../helpers/llmWire.ts';
import type { SentRequest } from '../helpers/llmWire.ts';

test.beforeEach(() => resetOllamaCaches());

const SETTINGS: LlmSettings = { provider: 'ollama', model: 'qwen3.5:9b', baseUrl: 'http://localhost:11434', ollamaNumCtx: 8192, ollamaNumPredict: 1024, temperature: 0.1 };
const TURNS = [
  { role: 'user', content: 'hello' },
  { role: 'assistant', content: 'prev' },
  { role: 'user', content: 'next' }
];
const ACTION_SCHEMA = buildActionSchema();
const OLLAMA_ORIGINS_TEXT = 'Ollama refused the request from the extension (HTTP 403). Start Ollama with OLLAMA_ORIGINS="chrome-extension://*" (or "*").';

type T = { after: (fn: () => void) => void };

/** Answers each request from a queue of reply makers (the last one repeats). A maker runs per request, because a Response body is read once. */
function queue(t: T, makers: Array<(request: SentRequest) => Response>): SentRequest[] {
  let next = 0;
  return spyFetch(t, (request) => makers[Math.min(next++, makers.length - 1)](request));
}

const ok = (content: string) => () => ollamaReply({ content });
const httpError = (status: number, text: string) => () => new Response(text, { status });

const ask = (settings: Partial<LlmSettings> = {}, options: Parameters<typeof callOllama>[3] = {}) =>
  callOllama({ ...SETTINGS, ...settings }, TURNS, 'SYS', options);

/** Log lines written while `run` ran, as "LEVEL Module message". */
async function logsOf(run: () => Promise<unknown>): Promise<string[]> {
  const from = Logger.getLogsHistory().length;
  await run().catch(() => {});
  return Logger.getLogsHistory().slice(from).map((entry) => `${entry.level} ${entry.module} ${entry.message}`);
}

// ---------------------------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------------------------

test('the request is the old one plus stream:true: the schema as format, think:false, the options, the turns after the system prompt', async (t) => {
  const sent = spyFetch(t);
  const text = await ask({}, { json: true, schema: ACTION_SCHEMA });

  assert.equal(text, '{"action":"done"}', 'the streamed pieces are joined');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, 'POST');
  assert.equal(sent[0].url, 'http://localhost:11434/api/chat');
  assert.deepEqual(sent[0].body, {
    model: 'qwen3.5:9b',
    messages: [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'prev' },
      { role: 'user', content: 'next' }
    ],
    format: ACTION_SCHEMA,
    think: false,
    options: { num_ctx: 8192, num_predict: 1024, temperature: 0.1 },
    stream: true
  });
});

test('the only header is the old one: the client\'s User-Agent and Accept are taken out', async (t) => {
  const sent = spyFetch(t);
  await ask();
  assert.deepEqual(sent[0].headers, { 'content-type': 'application/json' });
});

test('the plan schema goes out as the format too', async (t) => {
  const sent = spyFetch(t);
  await ask({}, { json: true, schema: buildPlanSchema() });
  assert.deepEqual(sent[0].body.format, buildPlanSchema());
});

test('format: the schema wins over json, json alone is "json", and neither sends no format at all', async (t) => {
  const sent = spyFetch(t);
  await ask({}, { json: true, schema: ACTION_SCHEMA });
  await ask({}, { schema: ACTION_SCHEMA });
  await ask({}, { json: true });
  await ask({}, {});
  await ask({}, { json: false, schema: null });
  assert.deepEqual(sent.map((request) => request.body.format), [ACTION_SCHEMA, ACTION_SCHEMA, 'json', undefined, undefined]);
  assert.ok(!('format' in sent[3].body), 'the key is not in the body');
});

test('defaults: localhost, qwen2.5:14b, a context window of 8192, no num_predict, temperature 0.1', async (t) => {
  const sent = spyFetch(t);
  await callOllama({ provider: 'ollama' }, TURNS, 'SYS');
  assert.equal(sent[0].url, 'http://localhost:11434/api/chat');
  assert.equal(sent[0].body.model, 'qwen2.5:14b');
  assert.deepEqual(sent[0].body.options, { num_ctx: 8192, temperature: 0.1 });
  assert.equal(sent[0].body.think, false);
});

test('the base URL and the model are trimmed, a trailing slash goes, and a blank one is the default', async (t) => {
  const sent = spyFetch(t);
  await ask({ baseUrl: '  http://192.168.1.20:11434/  ', model: '  llama3.1:8b ' });
  assert.equal(sent[0].url, 'http://192.168.1.20:11434/api/chat');
  assert.equal(sent[0].body.model, 'llama3.1:8b');

  await ask({ baseUrl: '   ', model: '   ' });
  assert.equal(sent[1].url, 'http://localhost:11434/api/chat');
  assert.equal(sent[1].body.model, 'qwen2.5:14b');
});

test('num_ctx is the setting when it is a positive number (also as text), else 8192; num_predict is sent only when positive', async (t) => {
  const sent = spyFetch(t);
  const optionsFor = async (settings: Record<string, unknown>) => {
    await ask(settings as Partial<LlmSettings>);
    return sent.at(-1)!.body.options;
  };
  assert.equal((await optionsFor({ ollamaNumCtx: 32768 })).num_ctx, 32768);
  assert.equal((await optionsFor({ ollamaNumCtx: '4096' })).num_ctx, 4096);
  for (const bad of [0, -5, 'nonsense', null, undefined]) assert.equal((await optionsFor({ ollamaNumCtx: bad })).num_ctx, 8192, String(bad));

  assert.equal((await optionsFor({ ollamaNumPredict: 256 })).num_predict, 256);
  assert.equal((await optionsFor({ ollamaNumPredict: '512' })).num_predict, 512);
  for (const bad of [0, -1, 'nonsense', null, undefined]) assert.ok(!('num_predict' in await optionsFor({ ollamaNumPredict: bad })), `no num_predict for ${String(bad)}`);
});

test('the temperature is the settings\' own, 0 included', async (t) => {
  const sent = spyFetch(t);
  await ask({ temperature: 0 });
  await ask({ temperature: 0.7 });
  await ask({ temperature: undefined });
  assert.deepEqual(sent.map((request) => request.body.options.temperature), [0, 0.7, 0.1]);
});

test('a model is built for every call: the next call reads the settings again', async (t) => {
  const sent = spyFetch(t);
  await ask({ model: 'first:1b', baseUrl: 'http://one.test:11434', ollamaNumCtx: 4096 });
  await ask({ model: 'second:2b', baseUrl: 'http://two.test:11434', ollamaNumCtx: 16384 });
  assert.deepEqual(sent.map((request) => [request.url, request.body.model, request.body.options.num_ctx]), [
    ['http://one.test:11434/api/chat', 'first:1b', 4096],
    ['http://two.test:11434/api/chat', 'second:2b', 16384]
  ]);
});

test('callbacks in the options are handed to the model, for opt-in tracing', async (t) => {
  spyFetch(t);
  const started: string[] = [];
  const handler = BaseCallbackHandler.fromMethods({ handleChatModelStart: (llm) => { started.push(String(llm.id.at(-1))); } });
  await ask({}, { callbacks: [handler] });
  assert.deepEqual(started, ['ChatOllama']);
});

test('one call is one request, whatever Ollama answers (no LangChain retries)', async (t) => {
  const sent = queue(t, [httpError(500, 'internal boom')]);
  await assert.rejects(ask());
  assert.equal(sent.length, 1);
});

// ---------------------------------------------------------------------------------------------
// think and schema fallbacks
// ---------------------------------------------------------------------------------------------

test('a model that rejects think is retried once without it, keeps the schema, logs [OLLAMA_THINK], and is remembered', async (t) => {
  const sent = queue(t, [httpError(400, '{"error":"\\"no-think:1b\\" does not support thinking"}'), ok('{"action":"go_back"}')]);
  const settings = { model: 'no-think:1b' };
  let text = '';
  const logs = await logsOf(async () => { text = await ask(settings, { json: true, schema: ACTION_SCHEMA }); });

  assert.equal(text, '{"action":"go_back"}');
  assert.equal(sent.length, 2);
  assert.equal(sent[0].body.think, false);
  assert.ok(!('think' in sent[1].body), 'the retry drops the field entirely');
  assert.deepEqual(sent[1].body.format, ACTION_SCHEMA, 'dropping think must not drop the schema');
  assert.equal(logs.filter((line) => /\[OLLAMA_THINK\]/.test(line)).length, 1);
  assert.match(logs.find((line) => /\[OLLAMA_THINK\]/.test(line))!, /^INFO ApiClients .*\[no-think:1b\]/);

  await ask(settings, { json: true, schema: ACTION_SCHEMA });
  assert.equal(sent.length, 3, 'the next call pays for nothing: one request');
  assert.ok(!('think' in sent[2].body), 'and it sends no think from the start');

  await ask({ model: 'other:1b' });
  assert.equal(sent.at(-1)!.body.think, false, 'another model is asked with think:false again');
});

test('a server that rejects a schema gets format "json" once, keeps think:false, logs [OLLAMA_SCHEMA], and is remembered per server', async (t) => {
  const oldServer = { baseUrl: 'http://old-ollama.test:11434' };
  const sent = queue(t, [
    httpError(400, '{"error":"json: cannot unmarshal object into Go struct field ChatRequest.format of type string"}'),
    ok('{"action":"scroll","direction":"down"}')
  ]);
  let text = '';
  const logs = await logsOf(async () => { text = await ask(oldServer, { json: true, schema: ACTION_SCHEMA }); });

  assert.equal(text, '{"action":"scroll","direction":"down"}');
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0].body.format, ACTION_SCHEMA);
  assert.equal(sent[1].body.format, 'json', 'the retry falls back to plain JSON mode');
  assert.equal(sent[1].body.think, false, 'the retry keeps think:false');
  assert.equal(logs.filter((line) => /^WARN ApiClients \[OLLAMA_SCHEMA\]/.test(line)).length, 1);

  await ask({ baseUrl: 'http://old-ollama.test:11434/' }, { json: true, schema: ACTION_SCHEMA });
  assert.equal(sent.length, 3, 'the next call, also with a trailing slash, does not pay for the retry again');
  assert.equal(sent[2].body.format, 'json');

  await ask({ baseUrl: 'http://new-ollama.test:11434' }, { json: true, schema: ACTION_SCHEMA });
  assert.deepEqual(sent.at(-1)!.body.format, ACTION_SCHEMA, 'another server still gets the schema');
});

test('both fallbacks can happen in one call, and a third failure is an error', async (t) => {
  const sent = queue(t, [httpError(400, 'model does not support think'), httpError(422, 'invalid schema in format'), ok('done')]);
  assert.equal(await ask({ model: 'both:1b', baseUrl: 'http://both.test:11434' }, { json: true, schema: ACTION_SCHEMA }), 'done');
  assert.deepEqual(sent.map((request) => [request.body.think, typeof request.body.format === 'string' ? request.body.format : 'schema']), [
    [false, 'schema'], [undefined, 'schema'], [undefined, 'json']
  ]);

  const three = queue(t, [httpError(400, 'think?'), httpError(400, 'grammar?'), httpError(400, 'still not right')]);
  await assert.rejects(ask({ model: 'never:1b', baseUrl: 'http://never.test:11434' }, { json: true, schema: ACTION_SCHEMA }), { message: 'Ollama API error (400): still not right' });
  assert.equal(three.length, 3, 'two retries at most');
});

test('a 400 that names neither think nor a schema is an error at once, and so is one that names think when think is not sent', async (t) => {
  const sent = queue(t, [httpError(400, 'invalid options')]);
  await assert.rejects(ask({}, { json: true, schema: ACTION_SCHEMA }), { message: 'Ollama API error (400): invalid options' });
  assert.equal(sent.length, 1);

  // A schema is not the problem when none was sent, and think is not the problem once it is off.
  const plain = queue(t, [httpError(400, 'unknown field format')]);
  await assert.rejects(ask({ model: 'json-only:1b' }, { json: true }), { message: 'Ollama API error (400): unknown field format' });
  assert.equal(plain.length, 1, 'format "json" is not a schema: no retry');

  resetOllamaCaches();
  const again = queue(t, [httpError(400, 'does not support think'), httpError(400, 'does not support think again')]);
  await assert.rejects(ask({ model: 'twice:1b' }), { message: 'Ollama API error (400): does not support think again' });
  assert.equal(again.length, 2, 'think is dropped once, and a second complaint about it is not retried');
});

test('the words that trigger a fallback are matched in any case', async (t) => {
  const thinking = queue(t, [httpError(400, 'THINKING is not supported by this model'), ok('one')]);
  assert.equal(await ask({ model: 'shouting:1b' }), 'one');
  assert.equal(thinking.length, 2);

  const schema = queue(t, [httpError(422, 'Invalid Schema in Format'), ok('two')]);
  assert.equal(await ask({ baseUrl: 'http://shouting.test:11434' }, { json: true, schema: ACTION_SCHEMA }), 'two');
  assert.equal(schema[1].body.format, 'json');
});

test('only a 400 or a 422 is looked at: a 500 that mentions think is an error', async (t) => {
  const sent = queue(t, [httpError(500, 'think failed')]);
  await assert.rejects(ask(), { message: 'Ollama API error (500): think failed' });
  assert.equal(sent.length, 1);
});

// ---------------------------------------------------------------------------------------------
// The reply
// ---------------------------------------------------------------------------------------------

test('content is the answer, whole, however the stream cut it into pieces', async (t) => {
  const long = JSON.stringify({ action: 'finish', answer: 'x'.repeat(500) });
  queue(t, [ok(long)]);
  assert.equal(await ask(), long);
});

test('an empty content falls back to the reasoning text, so the JSON a thinking model was building is not lost', async (t) => {
  queue(t, [() => ollamaReply({ content: '', thinking: '{"action":"click","element_id":3}', doneReason: 'length' })]);
  assert.equal(await ask(), '{"action":"click","element_id":3}');

  queue(t, [() => ollamaReply({ content: '  \n', thinking: '{"action":"go_back"}' })]);
  assert.equal(await ask(), '{"action":"go_back"}', 'whitespace is empty');
});

test('content wins over the reasoning text when both are there', async (t) => {
  queue(t, [() => ollamaReply({ content: '{"action":"scroll","direction":"down"}', thinking: 'let me think about it' })]);
  assert.equal(await ask(), '{"action":"scroll","direction":"down"}');
});

test('no content and no reasoning is an empty text with an [OLLAMA_EMPTY] warning, not an error', async (t) => {
  queue(t, [() => ollamaReply({ content: '', doneReason: 'stop' })]);
  let text = 'unset';
  const logs = await logsOf(async () => { text = await ask(); });
  assert.equal(text, '');
  const warning = logs.find((line) => /\[OLLAMA_EMPTY\]/.test(line));
  assert.match(warning ?? '', /^WARN ApiClients \[OLLAMA_EMPTY\] Model \[qwen3\.5:9b\] returned no usable text \(done_reason=stop\)/);
});

test('done_reason "length" logs [OLLAMA_TRUNCATED] with the cap; the reply is still returned', async (t) => {
  queue(t, [() => ollamaReply({ content: '{"action":"fin', doneReason: 'length' })]);
  let text = '';
  const logs = await logsOf(async () => { text = await ask(); });
  assert.equal(text, '{"action":"fin');
  assert.match(logs.find((line) => /\[OLLAMA_TRUNCATED\]/.test(line)) ?? '', /^WARN ApiClients \[OLLAMA_TRUNCATED\] Model \[qwen3\.5:9b\] hit the 1024-token generation cap/);

  const noCap = await logsOf(() => ask({ ollamaNumPredict: 0 }));
  assert.match(noCap.find((line) => /\[OLLAMA_TRUNCATED\]/.test(line)) ?? '', /hit the generation cap mid-answer/, 'no "undefined-token" when there is no cap');
});

test('a prompt above 90% of num_ctx logs [OLLAMA_CTX_PRESSURE]; 90% and below does not', async (t) => {
  const settings = { ollamaNumCtx: 1000 };
  queue(t, [() => ollamaReply({ content: 'ok', promptEvalCount: 901 })]);
  const high = await logsOf(() => ask(settings));
  assert.match(high.find((line) => /\[OLLAMA_CTX_PRESSURE\]/.test(line)) ?? '', /^WARN ApiClients \[OLLAMA_CTX_PRESSURE\] Prompt used 901 of 1000 context tokens/);

  queue(t, [() => ollamaReply({ content: 'ok', promptEvalCount: 900 })]);
  const edge = await logsOf(() => ask(settings));
  assert.equal(edge.filter((line) => /CTX_PRESSURE/.test(line)).length, 0);
});

test('a normal reply logs the [NETWORK] line and no warning', async (t) => {
  spyFetch(t);
  const logs = await logsOf(() => ask());
  assert.equal(logs.filter((line) => /^WARN/.test(line)).length, 0, logs.join('\n'));
  assert.match(logs.find((line) => /\[NETWORK\]/.test(line)) ?? '', /^INFO ApiClients \[NETWORK\] 200 OK \(\d+ms\) - Output length: 17 chars$/);
});

// ---------------------------------------------------------------------------------------------
// The error texts
// ---------------------------------------------------------------------------------------------

test('403 says what to do about OLLAMA_ORIGINS, whatever the body is', async (t) => {
  for (const body of ['', 'Forbidden', '{"error":"forbidden"}']) {
    const sent = queue(t, [httpError(403, body)]);
    await assert.rejects(ask(), { message: OLLAMA_ORIGINS_TEXT }, `body ${JSON.stringify(body)}`);
    assert.equal(sent.length, 1);
  }
});

test('404 says which model to pull', async (t) => {
  queue(t, [httpError(404, '{"error":"model \\"nope:1b\\" not found, try pulling it first"}')]);
  await assert.rejects(ask({ model: 'nope:1b' }), { message: 'Model "nope:1b" not found in Ollama. Please run "ollama pull nope:1b" in terminal.' });
});

test('any other HTTP status is "Ollama API error (status): <the raw body>", a JSON body included', async (t) => {
  queue(t, [httpError(500, '{"error":"llama runner process has terminated"}')]);
  await assert.rejects(ask(), { message: 'Ollama API error (500): {"error":"llama runner process has terminated"}' });
  queue(t, [httpError(502, 'Bad Gateway')]);
  await assert.rejects(ask(), { message: 'Ollama API error (502): Bad Gateway' });
  queue(t, [httpError(500, '')]);
  await assert.rejects(ask(), { message: 'Ollama API error (500): ' });
});

test('a server that is not there says how to start Ollama, with the URL and the fetch error', async (t) => {
  spyFetch(t, () => { throw new TypeError('fetch failed'); });
  const expected = 'Cannot connect to Ollama at http://localhost:11434/api/chat. Ensure Ollama is running (\'OLLAMA_ORIGINS="*" ollama serve\'). Details: fetch failed';
  await assert.rejects(ask(), { message: expected });

  // The old texts were the same for any failure that was not an HTTP answer, a plain Error from fetch included.
  spyFetch(t, () => { throw new Error('fetch failed ECONNREFUSED'); });
  await assert.rejects(ask({ baseUrl: 'http://192.168.1.20:11434' }), { message: /^Cannot connect to Ollama at http:\/\/192\.168\.1\.20:11434\/api\/chat\..*Details: fetch failed ECONNREFUSED$/ });
});

test('an error line in the stream is an API error, not a connection failure', async (t) => {
  const stream = '{"model":"m","message":{"role":"assistant","content":"par"},"done":false}\n{"error":"model runner has unexpectedly stopped, this may be due to resource limitations"}\n';
  spyFetch(t, () => new Response(stream, { status: 200, headers: { 'content-type': 'application/x-ndjson' } }));
  await assert.rejects(ask(), { message: 'Ollama API error: model runner has unexpectedly stopped, this may be due to resource limitations' });
});

const NOT_OLLAMA_TEXT = (line: string) => `Ollama at http://localhost:11434/api/chat answered, but not with a chat reply: ${line}. Check that the base URL is an Ollama server, for example http://localhost:11434.`;

test('a server that answers 200 with something that is not a chat line says so, with the line, and is not a connection failure', async (t) => {
  // What a server that is not Ollama answers. The client fails with "reading 'content'" of undefined for the first two
  // and with "[object Object]" for the third, and neither says that the server answered.
  const lines = [
    '{"id":"x","object":"chat.completion","choices":[]}',
    '{"choices":[{"message":{"role":"assistant","content":"hi"}}]}',
    '{"error":{"message":"Upstream provider returned 502","code":502}}',
    '{"error":["not text"]}',
    '[1,2]',
    '"just a string"'
  ];
  for (const text of lines) {
    const sent = spyFetch(t, () => new Response(`${text}\n`, { status: 200, headers: { 'content-type': 'application/x-ndjson' } }));
    const error = await ask().then(() => assert.fail(`${text}: expected a failure`), (e: Error) => e);
    assert.equal(error.message, NOT_OLLAMA_TEXT(text), text);
    assert.doesNotMatch(error.message, /Cannot connect|\[object Object\]|Cannot read properties/, text);
    assert.equal(sent.length, 1, `${text}: one request`);
  }
});

test('the first line is looked at whole, however the stream cuts it into chunks, and without a newline at the end', async (t) => {
  const line = '{"id":"x","choices":[]}';
  const chunked = (parts: string[]) => () => {
    let next = 0;
    return new Response(new ReadableStream({
      pull(controller) {
        if (next < parts.length) controller.enqueue(new TextEncoder().encode(parts[next++]));
        else controller.close();
      }
    }), { status: 200 });
  };
  for (const parts of [[line.slice(0, 9), line.slice(9), '\n'], [line], [`${line}\n`, '{"more":"lines"}\n']]) {
    spyFetch(t, chunked(parts));
    await assert.rejects(ask(), { message: NOT_OLLAMA_TEXT(line) }, JSON.stringify(parts));
  }
});

test('a real Ollama stream is not taken for a foreign one: its chat lines and its error lines keep their own texts', async (t) => {
  // A chat line, a chat line with thinking and an empty content, and a text error line: none is foreign.
  queue(t, [ok('{"action":"done"}')]);
  assert.equal(await ask(), '{"action":"done"}');
  queue(t, [() => ollamaReply({ thinking: 'hmm', content: '' })]);
  assert.equal(await ask(), 'hmm');
  spyFetch(t, () => new Response('{"error":"model runner has unexpectedly stopped"}\n', { status: 200 }));
  await assert.rejects(ask(), { message: 'Ollama API error: model runner has unexpectedly stopped' });
});

test('a Pause, a Stop or the deadline is not logged as a failed connection: generateCompletion reports it once', async (t) => {
  const task = new AbortController();
  const sent = spyFetch(t, hangUntilAborted);
  let failed: unknown;
  const logs = await logsOf(async () => {
    const call = ask({}, { signal: task.signal }).catch((error) => { failed = error; });
    await waitForRequests(sent);
    task.abort(new Error('the task was stopped'));
    await call;
  });
  assert.ok(failed, 'the call rejected');
  assert.deepEqual(logs.filter((line) => /^ERROR/.test(line)), [], 'no ERROR line for a cancelled call');
});

test('a connection that drops while the reply is read is a connection failure', async (t) => {
  spyFetch(t, () => {
    let sentFirst = false;
    const body = new ReadableStream({
      pull(controller) {
        if (!sentFirst) { sentFirst = true; controller.enqueue(new TextEncoder().encode('{"model":"m","message":{"role":"assistant","content":"par"},"done":false}\n')); return; }
        controller.error(new TypeError('terminated'));
      }
    });
    return new Response(body, { status: 200 });
  });
  await assert.rejects(ask(), { message: /^Cannot connect to Ollama at http:\/\/localhost:11434\/api\/chat\..*Details: terminated$/ });
});

test('a failure is logged as [NETWORK] under OllamaClient, with the text that is thrown', async (t) => {
  queue(t, [httpError(500, 'boom')]);
  const logs = await logsOf(() => ask());
  assert.deepEqual(logs.filter((line) => /^ERROR/.test(line)), ['ERROR OllamaClient [NETWORK] Failed connection to Ollama at http://localhost:11434/api/chat Ollama API error (500): boom']);
});

// ---------------------------------------------------------------------------------------------
// Abort
// ---------------------------------------------------------------------------------------------

test('a call that was aborted while the reply streamed is a rejection, not a short reply', async (t) => {
  // ChatOllama looks at the signal between two chunks and then ends the stream without an error. This server
  // ignores the signal, like a client that does, and finishes its answer after the abort.
  const task = new AbortController();
  const reason = new Error('the task was stopped');
  spyFetch(t, () => {
    let pulls = 0;
    const encode = (value: object) => new TextEncoder().encode(`${JSON.stringify(value)}\n`);
    const body = new ReadableStream({
      pull(controller) {
        if (pulls++ === 0) {
          controller.enqueue(encode({ model: 'm', message: { role: 'assistant', content: '{"action":' }, done: false }));
          return;
        }
        task.abort(reason);
        controller.enqueue(encode({ model: 'm', message: { role: 'assistant', content: '"finish"}' }, done: true, done_reason: 'stop' }));
        controller.close();
      }
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
  });
  await assert.rejects(ask({}, { signal: task.signal }), { message: /the task was stopped/ });
});

// ---------------------------------------------------------------------------------------------
// Over a real socket
// ---------------------------------------------------------------------------------------------
// Everything above runs on a fetch spy. These run the same client on Node's real fetch against a local server that
// talks like Ollama: a stream that arrives in pieces with pauses, real error bodies, a closed port, and a client
// that hangs up.

interface FakeOllama {
  base: string;
  requests: Array<{ headers: http.IncomingHttpHeaders; body: any; hungUp: boolean }>;
}

async function fakeOllama(t: T, respond: (request: { body: any }, res: http.ServerResponse) => void): Promise<FakeOllama> {
  const requests: FakeOllama['requests'] = [];
  const server = http.createServer((req, res) => {
    let text = '';
    req.on('data', (chunk) => { text += chunk; });
    req.on('end', () => {
      const entry = { headers: req.headers, body: JSON.parse(text), hungUp: false };
      requests.push(entry);
      res.on('close', () => { if (!res.writableFinished) entry.hungUp = true; });
      respond({ body: entry.body }, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** One NDJSON line of Ollama's stream. */
const line = (message: object, extra: object = {}) => `${JSON.stringify({ model: 'm', created_at: '2026-01-01T00:00:00Z', message: { role: 'assistant', ...message }, done: false, ...extra })}\n`;

test('a reply that streams in pieces with pauses is joined, and the request on the wire is the one described', async (t) => {
  const server = await fakeOllama(t, async (_request, res) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write(line({ content: '{"action":' }));
    await pause(30);
    res.write(line({ content: '"scroll",' }));
    await pause(30);
    res.write(line({ content: '"direction":"down"}' }));
    res.end(line({ content: '' }, { done: true, done_reason: 'stop', prompt_eval_count: 50, eval_count: 12 }));
  });
  const text = await ask({ baseUrl: server.base }, { json: true, schema: ACTION_SCHEMA });

  assert.equal(text, '{"action":"scroll","direction":"down"}');
  assert.equal(server.requests.length, 1);
  const [{ headers, body }] = server.requests;
  assert.equal(headers['content-type'], 'application/json');
  assert.doesNotMatch(String(headers['user-agent']), /ollama-js/, 'the client\'s User-Agent is not sent');
  assert.notEqual(headers.accept, 'application/json', 'the client\'s Accept is not sent');
  assert.deepEqual(body.format, ACTION_SCHEMA);
  assert.equal(body.think, false);
  assert.equal(body.stream, true);
});

test('real error answers: a JSON 400 about think is retried, 403 and 404 give their texts, and a 500 keeps its raw body', async (t) => {
  const thinkServer = await fakeOllama(t, ({ body }, res) => {
    if ('think' in body) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      res.end('{"error":"\\"real-think:1b\\" does not support thinking"}');
    } else {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.end(line({ content: 'recovered' }) + line({ content: '' }, { done: true, done_reason: 'stop' }));
    }
  });
  assert.equal(await ask({ baseUrl: thinkServer.base, model: 'real-think:1b' }), 'recovered');
  assert.deepEqual(thinkServer.requests.map((request) => 'think' in request.body), [true, false]);

  const status = async (code: number, body: string, contentType: string) => {
    const server = await fakeOllama(t, (_request, res) => { res.writeHead(code, { 'content-type': contentType }); res.end(body); });
    return ask({ baseUrl: server.base, model: 'x:1b' }).then(() => 'no error', (error: Error) => error.message);
  };
  assert.equal(await status(403, '', 'text/plain'), OLLAMA_ORIGINS_TEXT);
  assert.equal(await status(404, '{"error":"model \\"x:1b\\" not found"}', 'application/json'), 'Model "x:1b" not found in Ollama. Please run "ollama pull x:1b" in terminal.');
  assert.equal(await status(500, '{"error":"llama runner process has terminated"}', 'application/json'), 'Ollama API error (500): {"error":"llama runner process has terminated"}');
});

test('a closed port gives the cannot-connect text with the real fetch error', async (t) => {
  const server = await fakeOllama(t, () => {});
  const base = server.base;
  const closed = http.createServer();
  await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const port = (closed.address() as AddressInfo).port;
  await new Promise<void>((resolve) => closed.close(() => resolve()));
  assert.notEqual(base, `http://127.0.0.1:${port}`);

  await assert.rejects(ask({ baseUrl: `http://127.0.0.1:${port}` }), {
    message: `Cannot connect to Ollama at http://127.0.0.1:${port}/api/chat. Ensure Ollama is running ('OLLAMA_ORIGINS="*" ollama serve'). Details: fetch failed`
  });
});

test('a client that hangs up while the reply streams: the call rejects at once and the server sees the connection close', async (t) => {
  const server = await fakeOllama(t, (_request, res) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write(line({ content: '{"action":' }));
  });
  const task = new AbortController();
  const call = ask({ baseUrl: server.base }, { signal: task.signal });
  call.catch(() => {});
  await pause(100);
  const abortedAt = Date.now();
  task.abort(new Error('the task was stopped'));

  await assert.rejects(call);
  assert.ok(Date.now() - abortedAt < 1000, 'rejected at once');
  const start = Date.now();
  while (!server.requests[0].hungUp) {
    if (Date.now() - start > 2000) assert.fail('the server never saw the client hang up');
    await pause(5);
  }
});
