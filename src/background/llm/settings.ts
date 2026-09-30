/**
 * llm/settings.ts - how a provider reads the settings it was handed.
 *
 * The rules are the ones apiClients.js always had: the top-level key wins over the key saved for the
 * provider, and every value is trimmed. Base URLs get a trailing slash removed, and OpenAI-style ones
 * end in /v1.
 */
import type { LlmSettings } from './types.ts';

/** A provider that accepts the connection and never answers is cut off after this long. */
export const DEFAULT_LLM_TIMEOUT_MS = 120000;

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
  return (settings.apiKey || settings.providerConfigs?.[provider]?.apiKey || '').trim();
}

/** The base URL from the settings, trimmed, or '' when there is none. */
export function baseUrlOf(settings: LlmSettings): string {
  return (settings.baseUrl || '').trim();
}

/** The model from the settings, trimmed, or '' when there is none (the caller picks the provider's default). */
export function modelOf(settings: LlmSettings): string {
  return (settings.model || '').trim();
}

/** Strip a trailing slash and guarantee the base URL ends with /v1. */
export function withV1(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/$/, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

/** LangChain's own default is 4096, which is too little for a page's worth of actions, so Anthropic-style calls always send one. */
const DEFAULT_MAX_TOKENS = 8192;

/** max_tokens of an Anthropic-style call: settings.maxTokens when it is a positive number (also as text), else 8192. */
export function maxTokensOf(settings: LlmSettings): number {
  return Number(settings.maxTokens) > 0 ? Number(settings.maxTokens) : DEFAULT_MAX_TOKENS;
}

export function timeoutMsOf(settings: LlmSettings): number {
  const ms = Number(settings.llmTimeoutMs) > 0 ? Number(settings.llmTimeoutMs) : DEFAULT_LLM_TIMEOUT_MS;
  return Math.min(ms, MAX_TIMER_MS);
}
