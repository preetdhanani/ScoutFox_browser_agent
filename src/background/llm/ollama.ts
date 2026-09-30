/**
 * llm/ollama.ts - Ollama through ChatOllama, one new model per call.
 *
 * Local models need considerably more scaffolding than hosted ones. Three settings here are the difference
 * between a 9B model driving the browser and it doing nothing at all:
 *
 *   think:false  - every current local agent model (qwen3.x, gemma3/4, deepseek-r1) ships with reasoning ON.
 *                  Ollama routes that reasoning into `message.thinking` and leaves `message.content` empty until
 *                  it finishes. A 9B model can spend 30s+ deliberating over a 120-element page and still be
 *                  mid-thought when num_predict runs out, yielding an empty answer. We do our own reasoning in
 *                  the prompt, so native thinking buys nothing and costs the entire step. Not every model
 *                  accepts the flag, so a rejection is remembered (per worker) and the call retried once
 *                  without it.
 *   num_ctx      - Ollama defaults to a 4096-token context REGARDLESS of what the model supports (qwen3.5:9b
 *                  advertises 262144). A page snapshot plus history overflows that easily, and llama.cpp
 *                  truncates from the FRONT, which silently deletes the system prompt and the goal, so the
 *                  model no longer knows it is a browser agent or what it was asked to do. Nothing is logged
 *                  when this happens; the output just turns to garbage.
 *   format       - constrains decoding at the sampler. This is far more reliable than asking a small model to
 *                  emit JSON and then repairing the result, and it removes the prose-before-JSON failure mode
 *                  entirely. options.schema (the action or plan schema from agent/schemas.ts) goes further than
 *                  options.json's format:"json": the model can only produce a known action with its required
 *                  fields. A server older than 0.5 rejects a schema, so the call is retried once with
 *                  format:"json" and that server is remembered.
 *
 * What ChatOllama does that the old fetch code did not:
 *   - It always streams (NDJSON) and joins the chunks itself, so a request is a stream that ends when the
 *     model is done. That is fine for the deadline, which covers the whole reply, as before.
 *   - Its abort is broken (spike, docs/langgraph-design.md "Early check results"): the client makes its own
 *     AbortController and only looks at the call's signal between chunks, so an aborted call could resolve with
 *     empty text after the model had finished. The fetch wrapper below merges the call's signal into every
 *     request, and one model per call means the client's own abort() can only ever cancel this call.
 *
 * The request is the old one plus stream:true, and its headers are the old one's (Content-Type only): the
 * client's User-Agent and Accept are removed in the wrapper.
 */
import { ChatOllama } from '@langchain/ollama';
import type { BaseMessage } from '@langchain/core/messages';
import { Logger } from '../../shared/logger.ts';
import { describeOllamaFailure, statusOf } from './errors.ts';
import { toLangChainMessages, watchFetch } from './factory.ts';
import { baseUrlOf, modelOf } from './settings.ts';
import type { ChatTurn, CompletionOptions, LlmSettings } from './types.ts';

const DEFAULT_BASE_URL = 'http://localhost:11434';
const DEFAULT_MODEL = 'qwen2.5:14b';
const DEFAULT_NUM_CTX = 8192;

/** Models that rejected the `think` field once. Remembered, so the retry is paid at most once per model per worker lifetime. */
const THINK_UNSUPPORTED = new Set<string>();

/**
 * Ollama servers (by base URL) that rejected a JSON schema in `format`. Servers older than 0.5 only know
 * format:"json"; they get that instead, so an old install keeps working. Remembered like the think fallback.
 */
const SCHEMA_UNSUPPORTED = new Set<string>();

/** Forgets what was learned about servers and models. For tests: the sets live as long as the worker does. */
export function resetOllamaCaches(): void {
  THINK_UNSUPPORTED.clear();
  SCHEMA_UNSUPPORTED.clear();
}

/** How much of a reply is read to see whether its first line is an Ollama line: a line longer than this is not one. */
const FIRST_LINE_LIMIT = 4096;

/**
 * Is this first line of a 200 reply something other than an Ollama chat line? A chat line is an object with a `message`
 * object, and a streamed error is an object with an `error` TEXT. Anything else that parses as JSON (an OpenAI-shaped
 * {"choices": []}, an {"error": {...}} object) is what another server answers. A line that is not JSON is left to the client.
 */
function isForeignLine(line: string): boolean {
  if (!line) return false;
  try {
    const data = JSON.parse(line) as { message?: unknown; error?: unknown } | null;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return true;
    return typeof data.error === 'string' ? false : !(data.message && typeof data.message === 'object');
  } catch {
    return false;
  }
}

/**
 * The same response, with its first line looked at on the way to the client. When a server that is not Ollama
 * answers 200 with something else, the client fails with an internal TypeError ("reading 'content'") or with
 * "[object Object]", and neither says that the server answered. The line is what the error text needs.
 */
function watchFirstLine(response: Response, onForeignLine: (line: string) => void): Response {
  if (!response.body) return response;
  const decoder = new TextDecoder();
  let head = '';
  let checked = false;
  const look = (final: boolean) => {
    if (checked) return;
    const end = head.indexOf('\n');
    if (end === -1 && head.length < FIRST_LINE_LIMIT && !final) return;
    checked = true;
    const line = (end === -1 ? head : head.slice(0, end)).trim();
    if (isForeignLine(line)) onForeignLine(line);
  };
  const tap = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      if (checked) return;
      head += decoder.decode(chunk, { stream: true });
      look(false);
    },
    flush() {
      head += decoder.decode();
      look(true);
    }
  });
  return new Response(response.body.pipeThrough(tap), { status: response.status, statusText: response.statusText, headers: response.headers });
}

/**
 * The fetch of one ChatOllama. It puts the call's signal on every request (the mandatory part, see the top of the
 * file), takes out the client's User-Agent and Accept so the request has the header the old one had, and keeps the
 * raw text of an error response (the client keeps only the `error` member of a JSON body). `onFetchError` sees what
 * fetch rejected with, which is how a dead server is told from an {"error": ...} line in the stream, and
 * `onForeignLine` sees a first line that is not an Ollama line, which is how a server that is not Ollama is told from both.
 */
function callFetch(
  callSignal: AbortSignal | undefined,
  capture: typeof fetch,
  onFetchError: (error: unknown) => void,
  onForeignLine: (line: string) => void
): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const signals = [init.signal, callSignal].filter((signal): signal is AbortSignal => !!signal);
    const headers = new Headers(init.headers);
    headers.delete('user-agent');
    headers.delete('accept');
    let response: Response;
    try {
      response = await capture(input, { ...init, headers, signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0] });
    } catch (error) {
      onFetchError(error);
      throw error;
    }
    return response.ok ? watchFirstLine(response, onForeignLine) : response;
  }) as typeof fetch;
}

/**
 * One chat completion from Ollama. Returns the reply text; when the model left `content` empty and put its answer
 * into the reasoning field (a thinking model cut off mid-thought), that text, which the parser can still recover.
 * `options.signal` cancels the request itself. Errors have the old texts (errors.ts).
 */
export async function callOllama(settings: LlmSettings, messages: ChatTurn[], systemPrompt: string, options: CompletionOptions = {}): Promise<string> {
  const baseUrl = (baseUrlOf(settings) || DEFAULT_BASE_URL).replace(/\/$/, '');
  const url = `${baseUrl}/api/chat`;
  const model = modelOf(settings) || DEFAULT_MODEL;
  const numCtx = Number(settings.ollamaNumCtx) > 0 ? Number(settings.ollamaNumCtx) : DEFAULT_NUM_CTX;
  const numPredict = Number(settings.ollamaNumPredict) > 0 ? Number(settings.ollamaNumPredict) : undefined;
  const signal = options.signal ?? undefined;
  const turns = toLangChainMessages(messages, systemPrompt);
  const startTime = Date.now();

  let sendThink = !THINK_UNSUPPORTED.has(model);
  let format: string | object | undefined;
  if (options.schema && !SCHEMA_UNSUPPORTED.has(baseUrl)) format = options.schema;
  else if (options.json || options.schema) format = 'json';

  let reply: BaseMessage;
  let rawBody: string | undefined;
  let fetchFailed = false;
  let foreignLine: string | undefined;
  try {
    // A 400/422 can name a request field this server or model does not accept. Each known case is dropped once
    // and remembered, so only the first call pays for the retry:
    //   - older builds, and models with no reasoning mode, reject the `think` field;
    //   - servers older than 0.5 reject a JSON schema in `format` and only know "json".
    for (let retries = 0; ; retries++) {
      const errors = watchFetch();
      const chat = new ChatOllama({
        model,
        baseUrl,
        think: sendThink ? false : undefined,
        numCtx,
        numPredict,
        temperature: settings.temperature ?? 0.1,
        maxRetries: 0,
        fetch: callFetch(signal, errors.fetch, () => { fetchFailed = true; }, (line) => { foreignLine = line; })
      });
      try {
        reply = await chat.invoke(turns, { format, signal, callbacks: options.callbacks });
        break;
      } catch (error) {
        rawBody = errors.body();
        const status = statusOf(error);
        if (retries < 2 && (status === 400 || status === 422)) {
          const probe = rawBody ?? (error instanceof Error ? error.message : '');
          if (sendThink && /think/i.test(probe)) {
            THINK_UNSUPPORTED.add(model);
            Logger.info('ApiClients', `[OLLAMA_THINK] Model [${model}] does not accept "think" - retrying without it and skipping the flag from now on.`);
            sendThink = false;
            continue;
          }
          if (format && typeof format === 'object' && /format|schema|grammar/i.test(probe)) {
            SCHEMA_UNSUPPORTED.add(baseUrl);
            Logger.warn('ApiClients', `[OLLAMA_SCHEMA] Ollama at ${baseUrl} rejected a JSON schema in "format" (${probe.slice(0, 160)}). Retrying with format:"json" and using that from now on; update Ollama to get schema-constrained actions.`);
            format = 'json';
            continue;
          }
        }
        throw error;
      }
    }
    // ChatOllama ends the stream quietly when it sees the abort between two chunks, and then resolves with what it
    // has. A cancelled call must not look like a short reply.
    if (signal?.aborted) throw signal.reason;
  } catch (error) {
    const inner = describeOllamaFailure(error, { url, model, rawBody, fetchFailed, foreignLine });
    // A Pause, a Stop or the deadline is reported once, as [NETWORK_ABORTED] by generateCompletion, not as a failed connection.
    if (!signal?.aborted) Logger.error('OllamaClient', `[NETWORK] Failed connection to Ollama at ${url}`, inner);
    throw new Error(inner);
  }

  const elapsed = Date.now() - startTime;
  const text = reply.text;
  const reasoning = reply.additional_kwargs?.reasoning_content;
  const content = text.trim() ? text : (typeof reasoning === 'string' && reasoning.trim() ? reasoning : '');
  const meta = reply.response_metadata as { done_reason?: string; prompt_eval_count?: number };

  // Truncation is the most common silent failure on a local model, and Ollama reports it plainly in done_reason.
  // Surfacing it turns "the agent behaved oddly" into a one-line instruction to raise num_predict.
  if (meta.done_reason === 'length') {
    Logger.warn('ApiClients', `[OLLAMA_TRUNCATED] Model [${model}] hit the ${numPredict === undefined ? 'generation' : `${numPredict}-token generation`} cap mid-answer. The reply is incomplete; raise ollamaNumPredict if this repeats.`);
  }
  if (typeof meta.prompt_eval_count === 'number' && meta.prompt_eval_count > numCtx * 0.9) {
    Logger.warn('ApiClients', `[OLLAMA_CTX_PRESSURE] Prompt used ${meta.prompt_eval_count} of ${numCtx} context tokens. Ollama truncates from the front, which drops the system prompt first - raise ollamaNumCtx.`);
  }
  if (!content) {
    Logger.warn('ApiClients', `[OLLAMA_EMPTY] Model [${model}] returned no usable text (done_reason=${meta.done_reason || 'unknown'}). The reply had ${text.length} content chars and ${typeof reasoning === 'string' ? reasoning.length : 0} thinking chars.`);
  }

  Logger.info('ApiClients', `[NETWORK] 200 OK (${elapsed}ms) - Output length: ${content.length} chars`);
  return content;
}
