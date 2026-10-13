/**
 * llm/settings.ts - how a provider reads the settings it was handed.
 *
 * The rules for provider settings: the top-level key wins over the key saved for the
 * provider, and every value is trimmed. Base URLs get a trailing slash removed, and OpenAI-style ones
 * end in /v1.
 */
import type { LlmSettings } from './types.ts';

/** A provider that accepts the connection and never answers is cut off after this long. */
export const DEFAULT_LLM_TIMEOUT_MS = 120000;

/** NVIDIA NIM hosted models (often 70B+ with cold-start or queue latency) get a 300s timeout by default. */
export const DEFAULT_NVIDIA_LLM_TIMEOUT_MS = 300000;

export const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';

/** setTimeout fires at once for anything above this (a 32-bit signed integer), so a huge setting must not reach it. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * The `timeout` of the SDK clients (openai, @anthropic-ai/sdk). They end a request after 10 minutes by themselves, with
 * their own "Request timed out." text, which would cut short a llmTimeoutMs above that (a slow local model) and
 * drop its hint. The deadline (deadline.ts) is the only timer of a call, so theirs is put as far away as a timer can go.
 * Setting it also turns off the Anthropic SDK's guard against non-streaming requests that could take over 10 minutes.
 */
export const SDK_TIMEOUT_MS = MAX_TIMER_MS;

export function providerOf(settings: LlmSettings): string {
  return settings.provider || 'gemini';
}

/** settings.apiKey wins if set, else the provider's own saved key. */
export function getApiKey(settings: LlmSettings, provider: string): string {
  const raw = (settings.apiKey || settings.providerConfigs?.[provider]?.apiKey || '').trim();
  return raw.replace(/^Bearer\s+/i, '').replace(/^["']|["']$/g, '').trim();
}

/** The base URL from the settings, trimmed, or '' when there is none. */
export function baseUrlOf(settings: LlmSettings): string {
  return (settings.baseUrl || '').trim();
}

/** The model from the settings, trimmed, or '' when there is none (the caller picks the provider's default). */
export function modelOf(settings: LlmSettings): string {
  return (settings.model || '').trim();
}

/** Strip trailing slashes and guarantee the base URL ends with /v1. */
export function withV1(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

/**
 * Normalizes an NVIDIA NIM base URL:
 * - Defaults to NVIDIA_BASE_URL when empty or falsy.
 * - Replaces build.nvidia.com with NVIDIA_BASE_URL.
 * - Strips trailing /chat/completions and /models endpoints.
 * - Ensures the base URL ends with /v1.
 */
export function normalizeNvidiaBaseUrl(url?: string): string {
  let base = (url || '').trim();
  if (!base || base.includes('build.nvidia.com')) {
    base = NVIDIA_BASE_URL;
  }
  base = base.replace(/\/+(?:chat\/completions|models)\/?$/i, '');
  return withV1(base);
}

// ---------------------------------------------------------------------------------------------
// Custom providers (user-added endpoints)
// ---------------------------------------------------------------------------------------------

/** Which wire dialect a user-added endpoint speaks. A property of the endpoint, not of the model behind it. */
export type ProviderProtocol = 'openai' | 'anthropic';

/** The scheme, host and port of a URL ("https://gateway.example:8443"), or null when it does not parse. */
export function endpointOriginOf(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    return new URL(url.trim()).origin;
  } catch {
    return null;
  }
}

/** The host of a URL, with a non-default port ("gateway.example", "localhost:8000"). '' when it does not parse. */
export function endpointHostOf(url: string | undefined | null): string {
  if (!url) return '';
  try {
    const parsed = new URL(url.trim());
    return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
  } catch {
    return '';
  }
}

/** Trailing endpoint paths a user may paste instead of the bare base. The same suffixes are
 * stripped for both protocols (a user who picked the wrong dialect for the URL they pasted still
 * gets a sane base, and the eventual error names the protocol that was used); what differs is
 * only the path that gets appended. */
const CUSTOM_ENDPOINT_SUFFIX = /\/+(?:chat\/completions|messages|models)\/?$/i;

function trimmedUrlBase(url: string | undefined | null): string {
  return (url || '').trim().replace(/\/+$/, '');
}

/**
 * The base URL a custom OpenAI-style client posts against ({@link customChatUrl} appends the path).
 *
 * A trailing /chat/completions or /models is stripped (users paste the full endpoint), and /v1 is
 * appended ONLY when the path is empty: a bare host gets the conventional /v1, while an explicit
 * mount path (a relay at /api/openai) is respected as typed, because `withV1` would wrongly append
 * /v1 to it. A URL already ending in a version segment is used as is.
 */
export function normalizeCustomOpenaiBase(url: string | undefined | null): string {
  const base = trimmedUrlBase(url).replace(CUSTOM_ENDPOINT_SUFFIX, '').replace(/\/+$/, '');
  let path: string;
  try {
    path = new URL(base).pathname.replace(/\/+$/, '');
  } catch {
    return base;
  }
  return path === '' ? `${base}/v1` : base;
}

/**
 * The base URL a custom Anthropic-style client is given. The Anthropic SDK appends /v1/messages to
 * the URL it is handed (see agentRouter.ts, which strips /v1 for the same reason), so a trailing
 * /v1 would produce /v1/v1/messages. A trailing /messages or /models is stripped (users paste the
 * full endpoint), then a trailing /v1 is stripped; a custom mount path is kept as typed.
 */
export function normalizeCustomAnthropicBase(url: string | undefined | null): string {
  return trimmedUrlBase(url).replace(CUSTOM_ENDPOINT_SUFFIX, '').replace(/\/+$/, '').replace(/\/v1$/i, '');
}

/** The exact URL a chat request is posted to, for the form's live preview and for the sender. */
export function customChatUrl(protocol: ProviderProtocol, baseUrl: string | undefined | null): string {
  const base = protocol === 'anthropic' ? normalizeCustomAnthropicBase(baseUrl) : normalizeCustomOpenaiBase(baseUrl);
  return protocol === 'anthropic' ? `${base}/v1/messages` : `${base}/chat/completions`;
}

/** The exact URL a model-list request is sent to, for the form's live preview and for the sender. */
export function customModelsUrl(protocol: ProviderProtocol, baseUrl: string | undefined | null): string {
  const base = protocol === 'anthropic' ? normalizeCustomAnthropicBase(baseUrl) : normalizeCustomOpenaiBase(baseUrl);
  return protocol === 'anthropic' ? `${base}/v1/models` : `${base}/models`;
}

/** LangChain's own default is 4096, which is too little for a page's worth of actions, so Anthropic-style calls always send one. */
const DEFAULT_MAX_TOKENS = 8192;

/** max_tokens of an Anthropic-style call: settings.maxTokens when it is a positive number (also as text), else 8192. */
export function maxTokensOf(settings: LlmSettings): number {
  return Number(settings.maxTokens) > 0 ? Number(settings.maxTokens) : DEFAULT_MAX_TOKENS;
}

/**
 * Resolves effective LLM timeout in milliseconds.
 * Precedence:
 * 1. Per-provider value first (providerConfigs[provider].llmTimeoutMs).
 * 2. Global value next (settings.llmTimeoutMs).
 * 3. Provider default last (DEFAULT_NVIDIA_LLM_TIMEOUT_MS for nvidia, DEFAULT_LLM_TIMEOUT_MS otherwise).
 *
 * Values above 2 ** 31 - 1 are capped to prevent setTimeout from firing immediately.
 */
export function timeoutMsOf(settings: LlmSettings): number {
  const provider = providerOf(settings);
  const defaultMs = provider === 'nvidia' ? DEFAULT_NVIDIA_LLM_TIMEOUT_MS : DEFAULT_LLM_TIMEOUT_MS;
  const configMs = Number(settings.providerConfigs?.[provider]?.llmTimeoutMs);
  // A user-added provider keeps its own timeout in its descriptor (the dialog's field); it takes
  // precedence over the global value, after the shared per-provider config, mirroring how the
  // NVIDIA per-provider timeout is honored for a built-in.
  const customMs = Number(settings.customProviders?.[provider]?.llmTimeoutMs);
  const raw = Number(settings.llmTimeoutMs);

  if (configMs > 0) {
    return Math.min(configMs, MAX_TIMER_MS);
  }

  if (customMs > 0) {
    return Math.min(customMs, MAX_TIMER_MS);
  }

  if (raw > 0) {
    return Math.min(raw, MAX_TIMER_MS);
  }

  return Math.min(defaultMs, MAX_TIMER_MS);
}

/** Where the effective timeout came from, worded for the timeout error text (B3.3): the message
 * names the value AND its source, in the same precedence order timeoutMsOf applies. */
export function timeoutSourceOf(settings: LlmSettings): string {
  const provider = providerOf(settings);
  const configMs = Number(settings.providerConfigs?.[provider]?.llmTimeoutMs);
  const customMs = Number(settings.customProviders?.[provider]?.llmTimeoutMs);
  const raw = Number(settings.llmTimeoutMs);
  if (configMs > 0) return 'the provider\'s own timeout setting';
  if (customMs > 0) return 'the provider\'s own timeout setting';
  if (raw > 0) return 'the global timeout setting';
  return provider === 'nvidia' ? 'the NVIDIA default timeout' : 'the default timeout';
}
