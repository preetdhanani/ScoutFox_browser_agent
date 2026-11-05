/**
 * llm/usage.ts - the token usage a provider reports with a reply, in one shape (TokenUsage).
 *
 * Pure: the tool paths of index.ts, the LangChain paths (index.ts callProvider, ollama.ts) and the
 * tests read the three wire shapes here. A reply without usage gives undefined, never zeros: the
 * MCP client then estimates the prompt and says it is an estimate.
 */
import type { TokenUsage } from './types.ts';

/** A count from a usage field: a whole number of zero or more, else null. */
function countOf(value: unknown): number | null {
  const n = Number(value);
  return value !== null && value !== undefined && value !== '' && Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

/** The usage of an OpenAI-shaped answer (`usage.prompt_tokens`, `usage.completion_tokens`), or undefined. */
export function usageOfOpenAI(data: any): TokenUsage | undefined {
  const prompt = countOf(data?.usage?.prompt_tokens);
  if (prompt === null) return undefined;
  return { promptTokens: prompt, outputTokens: countOf(data?.usage?.completion_tokens) ?? 0 };
}

/** The usage of an Ollama /api/chat answer (`prompt_eval_count`, `eval_count`), or undefined. */
export function usageOfOllama(data: any): TokenUsage | undefined {
  const prompt = countOf(data?.prompt_eval_count);
  if (prompt === null) return undefined;
  return { promptTokens: prompt, outputTokens: countOf(data?.eval_count) ?? 0 };
}

/** The usage LangChain puts on a reply message (`usage_metadata.input_tokens`, `output_tokens`), or undefined. */
export function usageOfMessage(message: any): TokenUsage | undefined {
  const prompt = countOf(message?.usage_metadata?.input_tokens);
  if (prompt === null) return undefined;
  return { promptTokens: prompt, outputTokens: countOf(message?.usage_metadata?.output_tokens) ?? 0 };
}
