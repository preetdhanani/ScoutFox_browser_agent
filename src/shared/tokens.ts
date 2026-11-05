/**
 * shared/tokens.ts - token counts as the chat context meter reads and writes them.
 *
 * Pure, no chrome APIs: the background (usage estimates, the context window) and the side panel
 * (the ring, the card, the Settings field) both import it, so the two never word a number apart.
 */

/** What an image block counts as in an estimate. A real provider counts a page picture in this range. */
export const IMAGE_TOKENS = 1500;

/** Characters per token for an estimate: the usual rule of thumb for English text and JSON. */
export const CHARS_PER_TOKEN = 4;

/** Tokens of a text, estimated from its length. */
export function estimateTextTokens(text: string): number {
  return Math.ceil(String(text ?? '').length / CHARS_PER_TOKEN);
}

/**
 * The prompt tokens of a request, estimated: the text of every message (and of its tool calls),
 * IMAGE_TOKENS per picture, and the tool schemas the request offers.
 */
export function estimatePromptTokens(messages: any[], tools: any[] = []): number {
  let chars = 0;
  let images = 0;
  for (const message of messages || []) {
    const content = message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'image_url') images += 1;
        else if (typeof block?.text === 'string') chars += block.text.length;
      }
    } else if (content !== undefined && content !== null) {
      chars += String(content).length;
    }
    if (Array.isArray(message?.tool_calls) && message.tool_calls.length) chars += JSON.stringify(message.tool_calls).length;
  }
  if (tools && tools.length) chars += JSON.stringify(tools).length;
  return Math.ceil(chars / CHARS_PER_TOKEN) + images * IMAGE_TOKENS;
}

/**
 * A token count as a person types it: "200000", "200K", "200k", "1.5M" or "1M" (K is a thousand,
 * M a million). Spaces, commas and underscores between digits are ignored. Returns null for
 * anything else, and for a value that is not a whole number above zero.
 */
export function parseTokenCount(text: string): number | null {
  const raw = String(text ?? '').trim().replace(/[\s,_]/g, '');
  const m = /^(\d+(?:\.\d+)?)([kKmM]?)$/.exec(raw);
  if (!m) return null;
  const unit = m[2].toLowerCase() === 'k' ? 1_000 : m[2].toLowerCase() === 'm' ? 1_000_000 : 1;
  const value = Math.round(Number(m[1]) * unit);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * A token count for the panel: "950", "31.2K", "200K", "1.5M". A power-of-two window reads the way
 * its model card names it (262144 is "256K", 1048576 is "1M"); any other number is in thousands.
 */
export function formatTokens(n: number): string {
  const v = Math.max(0, Math.round(Number(n) || 0));
  if (v >= 1024 && v % 1_048_576 === 0) return `${v / 1_048_576}M`;
  if (v >= 1024 && v % 1024 === 0 && v < 1_048_576) return `${v / 1024}K`;
  if (v >= 1_000_000) return `${trimmed(v / 1_000_000)}M`;
  if (v >= 1_000) return `${trimmed(v / 1_000)}K`;
  return String(v);
}

/** One decimal, without a trailing ".0". */
function trimmed(x: number): string {
  const one = Math.round(x * 10) / 10;
  return Number.isInteger(one) ? String(one) : one.toFixed(1);
}

/** The fields a model-list entry may carry its context window in, in the order they are read. */
export const CONTEXT_FIELDS = ['context_length', 'max_model_len', 'context_window', 'max_context_length'] as const;

/**
 * The context window a `/models` entry names, or null: `context_length` (OpenRouter, Together),
 * `max_model_len` (vLLM), `context_window` (Groq), `max_context_length` (LM Studio), or OpenRouter's
 * `top_provider.context_length`.
 */
export function contextLengthOf(entry: unknown): number | null {
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as Record<string, any>;
  for (const field of CONTEXT_FIELDS) {
    const n = Number(e[field]);
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  }
  const top = Number(e.top_provider?.context_length);
  return Number.isFinite(top) && top > 0 ? Math.round(top) : null;
}
