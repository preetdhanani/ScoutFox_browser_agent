/**
 * llmWire - a fetch spy and provider-shaped replies, for the tests of the LLM layer.
 *
 * The providers are LangChain chat models now, so a test can no longer hand them a stub object with `ok` and
 * `json`: the SDKs need real Response objects, and what they send (URL, headers, body) is built by them. The
 * spy replaces globalThis.fetch until the test ends, records every request as the SDK made it, and answers with
 * a real Response. Nothing touches the network.
 *
 * Example:
 *   import { spyFetch } from './helpers/llmWire.ts';
 *
 *   test('...', async (t) => {
 *     const sent = spyFetch(t);                        // every request gets a reply with the text '{"action":"done"}'
 *     await ApiClients.generateCompletion(settings, messages, 'system');
 *     sent[0].url;                                     // 'https://openrouter.ai/api/v1/chat/completions'
 *     sent[0].headers.authorization;                   // header names are lower case
 *     sent[0].body.messages[0];                        // the parsed JSON body
 *   });
 *
 *   spyFetch(t, (request) => textReply(request.url, 'hello'));   // choose the reply per request
 *   spyFetch(t, () => jsonResponse({ error: { message: 'boom' } }, 500));   // an HTTP error
 */

export interface SentRequest {
  url: string;
  method: string;
  /** Header names are lower case, whatever way the SDK wrote them. */
  headers: Record<string, string>;
  /** The JSON body, parsed. It is null when there is no body and the raw text when the body is not JSON. */
  body: any;
  /** The signal the SDK gave to fetch. */
  signal: AbortSignal | null | undefined;
}

export const DEFAULT_REPLY_TEXT = '{"action":"done"}';

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export interface OllamaReplyOptions {
  content?: string;
  /** The reasoning text of a thinking model. It arrives in `message.thinking`, before the content. */
  thinking?: string;
  doneReason?: string;
  promptEvalCount?: number;
  evalCount?: number;
}

/**
 * What Ollama answers to /api/chat, which ChatOllama always asks to stream: one JSON object per line, the content
 * in pieces (the text is cut in two, so a test sees the pieces joined), and the last line with done:true and the counts.
 */
export function ollamaReply({ content = '', thinking = '', doneReason = 'stop', promptEvalCount = 10, evalCount = 5 }: OllamaReplyOptions = {}): Response {
  const piece = (message: object) => JSON.stringify({ model: 'm', created_at: '2026-01-01T00:00:00Z', message: { role: 'assistant', ...message }, done: false });
  const half = Math.ceil(content.length / 2);
  const lines = [
    ...(thinking ? [piece({ content: '', thinking })] : []),
    ...(content ? [piece({ content: content.slice(0, half) }), ...(content.length > half ? [piece({ content: content.slice(half) })] : [])] : []),
    JSON.stringify({
      model: 'm', created_at: '2026-01-01T00:00:00Z', message: { role: 'assistant', content: '' }, done: true, done_reason: doneReason,
      total_duration: 1, load_duration: 1, prompt_eval_count: promptEvalCount, prompt_eval_duration: 1, eval_count: evalCount, eval_duration: 1
    })
  ];
  return new Response(`${lines.join('\n')}\n`, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
}

/** A successful reply whose text is `text`, in the wire format of the endpoint that `url` names. */
export function textReply(url: string, text: string = DEFAULT_REPLY_TEXT): Response {
  const path = new URL(url).pathname;
  if (path.endsWith('/messages')) {
    return jsonResponse({ id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
  }
  if (path.includes(':streamGenerateContent')) {
    const chunk = { candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP', index: 0 }] };
    return new Response(`data: ${JSON.stringify(chunk)}\r\n\r\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }
  if (path.endsWith('/api/chat')) return ollamaReply({ content: text });
  return jsonResponse({ id: 'c1', object: 'chat.completion', created: 1, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] });
}

const ORIGINAL_FETCH = Symbol.for('scoutfox.llmWire.originalFetch');
type Installed = typeof fetch & { [ORIGINAL_FETCH]?: typeof fetch };

/**
 * Puts `replacement` in place of globalThis.fetch until the test ends, then puts the REAL fetch back. Doing it
 * twice in one test is safe: the after-hooks of a test run in the order they were registered, so a spy that
 * restored "what was there before it" would leave the first spy in place for every later test.
 */
export function installFetch(t: { after: (fn: () => void) => void }, replacement: typeof fetch): void {
  const current = globalThis.fetch as Installed;
  const real = current[ORIGINAL_FETCH] ?? current;
  (replacement as Installed)[ORIGINAL_FETCH] = real;
  globalThis.fetch = replacement;
  t.after(() => { globalThis.fetch = real; });
}

/** Replaces globalThis.fetch until the test ends. Every request is recorded, and answered with `reply(request)`. */
export function spyFetch(
  t: { after: (fn: () => void) => void },
  reply: (request: SentRequest) => Response | Promise<Response> = (request) => textReply(request.url)
): SentRequest[] {
  const sent: SentRequest[] = [];
  installFetch(t, (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const text = typeof init?.body === 'string' ? init.body : '';
    let body: unknown = null;
    if (text) {
      try { body = JSON.parse(text); } catch { body = text; }
    }
    const request: SentRequest = { url, method: String(init?.method), headers: Object.fromEntries(new Headers(init?.headers).entries()), body, signal: init?.signal };
    sent.push(request);
    return reply(request);
  }) as typeof fetch);
  return sent;
}

/** Waits until the spy has seen `count` requests. A request leaves a few ticks after the call starts. */
export async function waitForRequests(sent: SentRequest[], count = 1, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (sent.length < count) {
    if (Date.now() - start > timeoutMs) throw new Error(`only ${sent.length} of ${count} requests were sent after ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** A reply that never comes: it fails only when the request's signal aborts, like a fetch to a server that never answers. */
export function hangUntilAborted(request: SentRequest): Promise<Response> {
  return new Promise((_, reject) => {
    const signal = request.signal;
    const abort = () => reject(signal?.reason ?? new DOMException('This operation was aborted', 'AbortError'));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

/** How a promise ended within `ms`: a test that would hang on a broken abort fails with 'pending' instead. */
export async function settledWithin(promise: Promise<unknown>, ms = 1000): Promise<'resolved' | 'rejected' | 'pending'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => 'resolved' as const, () => 'rejected' as const),
      new Promise<'pending'>((resolve) => { timer = setTimeout(() => resolve('pending'), ms); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
