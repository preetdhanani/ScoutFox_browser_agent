/**
 * llm/errors.ts - today's user-facing error texts, on top of what LangChain and the SDKs throw.
 *
 * The side panel, the retry loop and the users' bug reports all know the old texts, for example
 * "OpenRouter API connection error: OpenRouter API Error (500): <body>", so they stay word for word.
 * What changed is where the pieces come from. The old code had the Response in its hand. Now the
 * SDKs throw errors, and this file reads them by `status` (or `status_code`), which every HTTP error has
 * and no network error has. One more error has a status: an UnreadableReplyError, for a 200 that the client
 * could not read (factory.ts makes it), so that such an answer is worded like an HTTP error, with the server's text.
 *
 * A failure has two texts, both kept from the old code:
 *   describeFailure: the provider's own words, what the old code logged as "Failed request to ..."
 *   wrapFailure:     the same behind the provider's "connection error" prefix, what it threw
 * Ollama and AgentRouter have their own functions at the end of the file, because their texts and rules differ
 * (a 404 is a model to pull, a 403 is OLLAMA_ORIGINS, and AgentRouter's first call may be followed by a fallback).
 */
import type { ChatProvider } from './types.ts';

/**
 * The texts of a missing key, checked before any request is built. The OpenAI family has no such check: a keyless
 * local server is fine. Ollama has no key at all.
 */
const MISSING_KEY: Partial<Record<ChatProvider | 'agent_router', string>> = {
  openrouter: 'OpenRouter API Key is missing. Please enter your OpenRouter API Key in Settings and click Save Settings.',
  anthropic: 'Anthropic Claude API Key is missing. Please enter your API Key in Settings.',
  gemini: 'Google Gemini API Key is missing. Please enter your Gemini API Key in the Settings tab and click Save Settings.',
  agent_router: 'AgentRouter API Key is missing. Please enter your AgentRouter API Key in Settings and click Save Settings.'
};

/** What a Gemini reply with no text has always been reported as, also when LangChain cannot read the reply at all. */
export const GEMINI_EMPTY_TEXT = 'Gemini API returned an empty text response.';

/** Throws today's missing-key text. This runs before the model is built, so no request can have been made. */
export function assertApiKey(provider: ChatProvider | 'agent_router', apiKey: string): void {
  const text = MISSING_KEY[provider];
  if (text && !apiKey) throw new Error(text);
}

export interface FailureContext {
  /** The OpenAI-style base URL (with /v1). Only the OpenAI family names it in its text. */
  baseUrl?: string;
  /** The key of the call. It is taken out of every text, in case a server echoes it back. */
  apiKey?: string;
  /** The raw text of the last error response, when the fetch wrapper of the factory saw one. */
  rawBody?: string;
}

/** The HTTP status of an error from an SDK, or undefined for anything that is not an HTTP answer (a network error, an abort). */
export function statusOf(error: unknown): number | undefined {
  const e = error as { status?: unknown; status_code?: unknown } | null | undefined;
  const status = Number(e?.status ?? e?.status_code);
  return Number.isInteger(status) && status >= 100 ? status : undefined;
}

/** Shorter keys are left alone: replacing "k" in a test key would mangle the text. */
const MIN_SCRUBBED_KEY_LENGTH = 8;

/** `text` with the API key taken out, in case a server echoes it back (into an error text, a log line, a trace). */
export function scrubKey(text: string, apiKey: string | undefined): string {
  return apiKey && apiKey.length >= MIN_SCRUBBED_KEY_LENGTH ? text.split(apiKey).join('[redacted]') : text;
}

/**
 * The server answered with a success status, but the client could not read the body as a chat reply: an
 * {"error": ...} object in a 200 (OpenRouter does this when an upstream provider fails), "choices": [], a proxy's
 * HTML page. The SDKs fail with an internal TypeError that has no status, which would read as "no answer at all".
 * This error carries the status of the answer, so every function below words it like any HTTP error, with the
 * server's own text (the raw body comes in through the failure context) and not the TypeError's.
 */
export class UnreadableReplyError extends Error {
  readonly status: number;

  constructor(status: number, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'UnreadableReplyError';
    this.status = status;
  }
}

/** How much of an unreadable body goes into an error text: a proxy's HTML page can be long. */
const UNREADABLE_BODY_LIMIT = 600;

function excerpt(body: string | undefined): string {
  const text = (body ?? '').trim();
  if (!text) return '(empty body)';
  return text.length > UNREADABLE_BODY_LIMIT ? `${text.slice(0, UNREADABLE_BODY_LIMIT)} ...` : text;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Text the Google SDK puts in front of every message: "[GoogleGenerativeAI Error]: Error fetching from <url>: ". */
const GEMINI_FETCH_PREFIX = /^\[GoogleGenerativeAI Error\]: Error fetching from \S+?: /;
/** ... and the "[400 Bad Request] " that follows it on an HTTP error. The status text is kept in the group. */
const GEMINI_STATUS_PREFIX = /^\[\d+ ?([^\]]*)\] ?/;

/** The standard reason phrases of the statuses that a proxy or a front end answers with. HTTP/2 has no phrase, so a response can have none. */
const REASON_PHRASES: Record<number, string> = {
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 408: 'Request Timeout', 429: 'Too Many Requests',
  500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout'
};

/**
 * What Gemini said about an HTTP error. The SDK keeps only `error.message` of a JSON body and drops any other body
 * (an HTML 503 of a proxy, a text), so the tail can be empty. The reason phrase stands in for it then: the one the
 * response had ("Service Unavailable"), or the standard one for the status. The SDK does not let a caller reach the
 * raw body: it calls the global fetch, so there is no fetch of ours to keep it.
 */
function geminiBodyOf(error: unknown): string {
  const rest = messageOf(error).replace(GEMINI_FETCH_PREFIX, '');
  const tail = rest.replace(GEMINI_STATUS_PREFIX, '');
  if (tail.trim()) return tail;
  const status = statusOf(error);
  return rest.match(GEMINI_STATUS_PREFIX)?.[1]?.trim() || (status === undefined ? '' : REASON_PHRASES[status] ?? '');
}

/**
 * The body of an HTTP error response. The OpenAI SDK does not keep the raw text of a JSON body (it keeps
 * `error.error` only, and a server that answers {"detail": "..."} leaves "status code (no body)"), so the
 * factory's fetch wrapper hands over the raw text. Without it, the SDK's own message is used: "<status> <text>",
 * and LangChain adds a troubleshooting link to 401 and 429 that the old texts did not have.
 */
function bodyOf(provider: ChatProvider | 'agent_router', error: unknown, ctx: { rawBody?: string }): string {
  if (error instanceof UnreadableReplyError) return `not a chat reply: ${excerpt(ctx.rawBody)}`;
  if (provider === 'gemini') return geminiBodyOf(error);
  if (ctx.rawBody) return ctx.rawBody;
  const body = messageOf(error).replace(/^\d{3} /, '').replace(/\n\nTroubleshooting URL: \S+\n?$/, '');
  return body === 'status code (no body)' ? '' : body;
}

/** What went wrong when no HTTP answer came: the fetch error's own text, as the old code showed it. */
function detailOf(provider: ChatProvider | 'agent_router', error: unknown): string {
  if (provider === 'gemini') return messageOf(error).replace(GEMINI_FETCH_PREFIX, '');
  // The OpenAI and Anthropic SDKs say "Connection error." and keep the real reason ("Failed to fetch") in the cause.
  const cause = (error as { cause?: unknown } | null | undefined)?.cause;
  return cause instanceof Error && cause.message ? cause.message : messageOf(error);
}

/** The provider's own words for the failure, without the connection-error prefix. */
export function describeFailure(provider: ChatProvider, error: unknown, ctx: FailureContext = {}): string {
  const status = statusOf(error);
  let text: string;
  if (status === undefined) {
    text = detailOf(provider, error);
  } else if (provider === 'openrouter') {
    text = status === 401
      ? 'OpenRouter API Authentication Error (401): Invalid or missing API key. Please check your key in Settings.'
      : `OpenRouter API Error (${status}): ${bodyOf(provider, error, ctx)}`;
  } else if (provider === 'anthropic') {
    text = `Anthropic API error (${status}): ${bodyOf(provider, error, ctx)}`;
  } else if (provider === 'gemini') {
    text = `Gemini API Error (${status}): ${bodyOf(provider, error, ctx)}`;
  } else {
    text = `API Error (${status}): ${bodyOf(provider, error, ctx)}`;
  }
  return scrubKey(text, ctx.apiKey);
}

/** The text that is thrown to the caller: `inner` behind the provider's own prefix. */
export function wrapFailure(provider: ChatProvider, inner: string, ctx: FailureContext = {}): string {
  switch (provider) {
    case 'openrouter': return `OpenRouter API connection error: ${inner}`;
    case 'anthropic': return `Anthropic API Error: ${inner}`;
    case 'gemini': return `Gemini API Error: ${inner}`;
    default: return `API connection error (${ctx.baseUrl}): ${inner}`;
  }
}

// ---------------------------------------------------------------------------------------------
// Ollama
// ---------------------------------------------------------------------------------------------

export interface OllamaFailureContext {
  /** The chat endpoint, for the cannot-connect text: <base>/api/chat. */
  url: string;
  model: string;
  /** The raw text of the error response, when the fetch wrapper of ollama.ts saw one. */
  rawBody?: string;
  /** The error is what fetch itself rejected with (nobody answered), as the fetch wrapper of ollama.ts saw it. */
  fetchFailed?: boolean;
  /** The first line of a 200 reply that is not an Ollama chat line (a server that is not Ollama), as ollama.ts saw it. */
  foreignLine?: string;
}

/**
 * The ollama client throws `new Error(line.error)` (a plain Error, no status) when the stream carries an
 * {"error": "..."} line after the reply began, for example a model runner that died halfway. It is the only
 * plain Error that comes out of a call whose fetch worked: a failed body read is a TypeError, and an abort is a DOMException.
 */
function isStreamedError(error: unknown, ctx: OllamaFailureContext): boolean {
  return !ctx.fetchFailed && error instanceof Error && Object.getPrototypeOf(error) === Error.prototype;
}

/**
 * The text of a failed Ollama call, as the old client threw it: the 404 and the connection texts are kept word for
 * word, other HTTP errors are "Ollama API error (status): <raw body>", and 403 is new. Ollama answers 403 to any
 * Origin it does not trust, and a chrome-extension:// origin is not trusted unless OLLAMA_ORIGINS says so.
 */
export function describeOllamaFailure(error: unknown, ctx: OllamaFailureContext): string {
  const status = statusOf(error);
  if (status === 404) return `Model "${ctx.model}" not found in Ollama. Please run "ollama pull ${ctx.model}" in terminal.`;
  if (status === 403) return 'Ollama refused the request from the extension (HTTP 403). Start Ollama with OLLAMA_ORIGINS="chrome-extension://*" (or "*").';
  if (status !== undefined) return `Ollama API error (${status}): ${ctx.rawBody ?? messageOf(error)}`;
  // The server answered, so "cannot connect" would be wrong. What the client choked on is the internal TypeError of
  // reading `message` off something that is not a chat line, or "[object Object]" for an error that is not text.
  if (ctx.foreignLine !== undefined) return `Ollama at ${ctx.url} answered, but not with a chat reply: ${excerpt(ctx.foreignLine)}. Check that the base URL is an Ollama server, for example http://localhost:11434.`;
  if (isStreamedError(error, ctx)) return `Ollama API error: ${messageOf(error)}`;
  return `Cannot connect to Ollama at ${ctx.url}. Ensure Ollama is running ('OLLAMA_ORIGINS="*" ollama serve'). Details: ${messageOf(error)}`;
}

// ---------------------------------------------------------------------------------------------
// AgentRouter
// ---------------------------------------------------------------------------------------------

/** The old status-401 check, also true for a body that carries this marker on another status. */
const AGENT_ROUTER_AUTH_MARKER = 'unauthorized_client_error';

/**
 * True when the primary call was refused for its credentials: no fallback can help, and the fallback would be refused too.
 * An answer with a success status that could not be read was not a refusal, whatever its body says, as in the old code.
 */
export function isAgentRouterAuthFailure(error: unknown, rawBody: string | undefined): boolean {
  if (error instanceof UnreadableReplyError) return false;
  return statusOf(error) === 401 || (rawBody ?? '').includes(AGENT_ROUTER_AUTH_MARKER);
}

/** What went wrong when AgentRouter's primary call was refused for its credentials, as the old client threw it. */
export function agentRouterAuthText(error: unknown, ctx: { rawBody?: string; apiKey?: string } = {}): string {
  return scrubKey(`AgentRouter Authentication Error (401): ${bodyOf('agent_router', error, ctx)}`, ctx.apiKey);
}

/**
 * The provider's own words for a failed AgentRouter request (a network failure, or an HTTP error of the fallback),
 * as the old client built them, without the "connection error" prefix that wrapAgentRouterFailure adds.
 */
export function describeAgentRouterFailure(error: unknown, ctx: { rawBody?: string; apiKey?: string } = {}): string {
  const status = statusOf(error);
  const text = status === undefined ? detailOf('agent_router', error) : `AgentRouter API Error (${status}): ${bodyOf('agent_router', error, ctx)}`;
  return scrubKey(text, ctx.apiKey);
}

/** The text that is thrown to the caller. The old client put this prefix on everything, its own errors included. */
export function wrapAgentRouterFailure(inner: string): string {
  return `AgentRouter API connection error: ${inner}`;
}

/** Both AgentRouter endpoints answered 200 with no text. `payload` is what the model answered, for the report. */
export function agentRouterEmptyText(payload: unknown, apiKey?: string): string {
  return scrubKey(`AgentRouter returned empty content. Response payload: ${JSON.stringify(payload)}`, apiKey);
}
