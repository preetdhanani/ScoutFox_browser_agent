/**
 * llm/types.ts - the shapes that cross the boundary of the llm layer.
 *
 * Callers (the old engine today, the graph's LlmPort later) hand in plain settings and plain
 * { role, content } turns and get a string back. Nothing LangChain-shaped leaks out of llm/.
 */
import type { Callbacks } from '@langchain/core/callbacks/manager';

/** One turn as the engine keeps it. Only 'user' and 'assistant' occur; anything else is read as 'user'. */
export interface ChatTurn {
  role: string;
  content: string;
}

/** What a provider needs from the settings. The stored `Settings` fits, and so does a partial test object. */
export interface LlmSettings {
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  providerConfigs?: Record<string, { baseUrl?: string; apiKey?: string; model?: string } | undefined>;
  temperature?: number;
  llmTimeoutMs?: number;
  /** Anthropic and AgentRouter max_tokens. No settings screen sets it, so it is 8192 unless someone stored a value. */
  maxTokens?: number;
  /** Ollama only: the context window (num_ctx). Ollama's own default is 4096, so ScoutFox always sends one (8192). */
  ollamaNumCtx?: number;
  /** Ollama only: the generation cap (num_predict). Not sent when it is missing or not above 0. */
  ollamaNumPredict?: number;
}

export interface CompletionOptions {
  /** The task's abort signal (Pause and Stop). Null or absent: the call only has its own deadline. */
  signal?: AbortSignal | null;
  /** The caller wants JSON. Only Ollama acts on it (format "json"); the cloud providers get no format field. */
  json?: boolean;
  /** JSON schema for constrained decoding. Only Ollama acts on it (format: the schema); the cloud providers get nothing. */
  schema?: object | null;
  /** Forwarded into model.invoke for opt-in tracing, because there is no AsyncLocalStorage parent lookup. */
  callbacks?: Callbacks;
}

/**
 * The providers that are one plain chat-model call (factory.ts). `ollama` (ollama.ts) and `agent_router`
 * (agentRouter.ts) have their own modules, because each has its own fallbacks and error rules.
 */
export type ChatProvider = 'openrouter' | 'openai' | 'openai_compatible' | 'anthropic' | 'gemini';

export function isChatProvider(provider: string): provider is ChatProvider {
  return provider === 'openrouter' || provider === 'openai' || provider === 'openai_compatible' || provider === 'anthropic' || provider === 'gemini';
}
