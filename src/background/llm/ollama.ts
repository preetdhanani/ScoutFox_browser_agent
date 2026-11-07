/**
 * llm/ollama.ts - Ollama through native HTTP fetch, one call per request.
 *
 * Local models need considerably more scaffolding than hosted ones:
 *   think:false  - suppresses native thinking on reasoning models (we prompt our own thinking).
 *   num_ctx      - uses effective context window to prevent silent truncation.
 *   format       - constrains decoding at the sampler (JSON or schema).
 */
import { Logger } from '../../shared/logger.ts';
import { ProviderError, classifyProviderFailure, describeOllamaFailure, statusOf } from './errors.ts';
import { baseUrlOf, modelOf } from './settings.ts';
import { getEffectiveContextWindow } from './models.ts';
import { usageOfOllama } from './usage.ts';
import { toOllamaMessage } from './index.ts';
import type { ChatTurn, CompletionOptions, LlmSettings } from './types.ts';

const DEFAULT_BASE_URL = 'http://localhost:11434';
const DEFAULT_MODEL = 'qwen2.5:14b';

const THINK_UNSUPPORTED = new Set<string>();
const SCHEMA_UNSUPPORTED = new Set<string>();

export function resetOllamaCaches(): void {
  THINK_UNSUPPORTED.clear();
  SCHEMA_UNSUPPORTED.clear();
}

const FIRST_LINE_LIMIT = 4096;

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

function retryAfterMsOf(response: Response): number | undefined {
  const msText = response.headers.get('retry-after-ms');
  const ms = Number(msText);
  if (msText?.trim() && Number.isFinite(ms) && ms >= 0) return ms;
  const seconds = response.headers.get('retry-after');
  const n = Number(seconds);
  if (seconds?.trim() && Number.isFinite(n) && n >= 0) return n * 1000;
  return undefined;
}

export async function callOllama(
  settings: LlmSettings,
  messages: ChatTurn[],
  systemPrompt: string,
  options: CompletionOptions = {}
): Promise<string> {
  const baseUrl = (baseUrlOf(settings) || DEFAULT_BASE_URL).replace(/\/$/, '');
  const url = `${baseUrl}/api/chat`;
  const model = modelOf(settings) || DEFAULT_MODEL;
  const numPredict = Number(settings.ollamaNumPredict) > 0 ? Number(settings.ollamaNumPredict) : undefined;
  const signal = options.signal ?? undefined;
  const startTime = Date.now();

  const numCtx = (await getEffectiveContextWindow(settings)).tokens;

  let sendThink = !THINK_UNSUPPORTED.has(model);
  let format: string | object | undefined;
  if (options.schema && !SCHEMA_UNSUPPORTED.has(baseUrl)) format = options.schema;
  else if (options.json || options.schema) format = 'json';

  const formattedMessages: Array<{ role: string; content: string }> = [
    { role: 'system', content: systemPrompt },
    ...messages.map(toOllamaMessage)
  ];

  let rawBody: string | undefined;
  let fetchFailed = false;
  let foreignLine: string | undefined;
  let retryAfterMs: number | undefined;

  try {
    let data: any;
    for (let retries = 0; ; retries++) {
      const payload: Record<string, unknown> = {
        model,
        messages: formattedMessages,
        stream: false,
        options: {
          temperature: settings.temperature ?? 0.1,
          num_ctx: numCtx,
          ...(numPredict ? { num_predict: numPredict } : {})
        }
      };
      if (sendThink) payload.think = false;
      if (format) payload.format = format;

      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal
        });
      } catch (err) {
        fetchFailed = true;
        throw err;
      }

      if (!response.ok) {
        retryAfterMs = retryAfterMsOf(response);
        rawBody = await response.text();
        const status = response.status;
        if (retries < 2 && (status === 400 || status === 422)) {
          if (sendThink && /think/i.test(rawBody)) {
            THINK_UNSUPPORTED.add(model);
            Logger.info('ApiClients', `[OLLAMA_THINK] Model [${model}] does not accept "think" - retrying without it and skipping the flag from now on.`);
            sendThink = false;
            continue;
          }
          if (format && typeof format === 'object' && /format|schema|grammar/i.test(rawBody)) {
            SCHEMA_UNSUPPORTED.add(baseUrl);
            Logger.warn('ApiClients', `[OLLAMA_SCHEMA] Ollama at ${baseUrl} rejected a JSON schema in "format" (${rawBody.slice(0, 160)}). Retrying with format:"json" and using that from now on; update Ollama to get schema-constrained actions.`);
            format = 'json';
            continue;
          }
        }
        const error = new Error(rawBody || `Ollama API error (${response.status})`);
        Object.assign(error, { status: response.status, headers: response.headers, rawBody });
        throw error;
      }

      const text = await response.text();
      rawBody = text;
      const firstLine = text.slice(0, FIRST_LINE_LIMIT).split('\n')[0].trim();
      if (isForeignLine(firstLine)) foreignLine = firstLine;

      try {
        // Ollama streaming or non-streaming lines: parse the response
        if (text.includes('\n')) {
          const lines = text.trim().split('\n');
          let joinedContent = '';
          let joinedThinking = '';
          let lastData: any = {};
          for (const line of lines) {
            try {
              const parsed = JSON.parse(line);
              lastData = parsed;
              if (parsed.message?.content) joinedContent += parsed.message.content;
              if (parsed.message?.thinking) joinedThinking += parsed.message.thinking;
            } catch {}
          }
          data = {
            message: {
              content: joinedContent,
              thinking: joinedThinking
            },
            done_reason: lastData.done_reason,
            prompt_eval_count: lastData.prompt_eval_count,
            eval_count: lastData.eval_count
          };
        } else {
          data = JSON.parse(text);
        }
      } catch (parseError) {
        throw new Error(`Failed to parse Ollama reply: ${parseError}`);
      }
      break;
    }

    if (signal?.aborted) throw signal.reason;

    const elapsed = Date.now() - startTime;
    const usage = usageOfOllama(data);
    if (usage) options.onUsage?.(usage);

    const message = data?.message || {};
    const text = message.content || '';
    const reasoning = message.thinking || '';
    const content = text.trim() ? text : (typeof reasoning === 'string' && reasoning.trim() ? reasoning : '');

    if (data.done_reason === 'length') {
      Logger.warn('ApiClients', `[OLLAMA_TRUNCATED] Model [${model}] hit the ${numPredict === undefined ? 'generation' : `${numPredict}-token generation`} cap mid-answer. The reply is incomplete; raise ollamaNumPredict if this repeats.`);
    }
    if (typeof data.prompt_eval_count === 'number' && data.prompt_eval_count > numCtx * 0.9) {
      Logger.warn('ApiClients', `[OLLAMA_CTX_PRESSURE] Prompt used ${data.prompt_eval_count} of ${numCtx} context tokens. Ollama truncates from the front, which drops the system prompt first - raise ollamaNumCtx.`);
    }
    if (!content) {
      Logger.warn('ApiClients', `[OLLAMA_EMPTY] Model [${model}] returned no usable text (done_reason=${data.done_reason || 'unknown'}). The reply had ${text.length} content chars and ${typeof reasoning === 'string' ? reasoning.length : 0} thinking chars.`);
    }

    Logger.debug('ApiClients', `[NETWORK] 200 OK (${elapsed}ms) - Output length: ${content.length} chars`);
    return content;
  } catch (error) {
    const inner = describeOllamaFailure(error, { url, model, rawBody, fetchFailed, foreignLine });
    if (!signal?.aborted) Logger.error('OllamaClient', `[NETWORK] Failed connection to Ollama at ${url}`, inner);
    const failure = classifyProviderFailure(error);
    throw new ProviderError(inner, { status: failure.status, kind: failure.kind, retryAfterMs });
  }
}
