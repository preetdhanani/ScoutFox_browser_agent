// src/background/agent/answerJson.ts
// A model with no response schema (every custom OpenAI-style endpoint, most cloud providers) is told to reply with
// {"action": ...}, and a small one sometimes answers the question in a JSON object of its own instead:
//   {"answer": "Top repositories today: ..."}
// That reply has no "action" key, so the prose guardrail in parse.ts used to take the WHOLE raw text, braces and
// escaped newlines included, as the final answer, and the card showed JSON. This module recognises that one shape.
// Pure: no state, no logging, erasable TypeScript.

import { findTopLevelObjects, parsePartialOrTruncatedJson } from './repairJson.ts';

/** The keys that hold the answer. A reply with exactly one of them is an answer wrapper. */
const ANSWER_KEYS: readonly string[] = ['answer', 'final_answer', 'finalAnswer'];

/** Keys a model writes beside the answer that carry no data of their own. Any other key means the object is data. */
const META_KEYS: ReadonlySet<string> = new Set(['thought', 'thinking', 'reason', 'confidence']);

const FENCE = '```';

/**
 * The inside of a reply that is nothing but one code fence (an optional "json" label after the opening marks), or the
 * text itself when it is not fenced. Plain string work on purpose: the regex that says the same thing
 * (`/^```(?:json)?\s*([\s\S]*?)\s*```$/`) is quadratic on a long run of white space, and a model reply is untrusted input.
 */
function unfenced(text: string): string {
  if (text.length < 2 * FENCE.length || !text.startsWith(FENCE) || !text.endsWith(FENCE)) return text;
  let inner = text.slice(FENCE.length, text.length - FENCE.length);
  if (inner.slice(0, 4).toLowerCase() === 'json') inner = inner.slice(4);
  return inner.trim();
}

/**
 * The answer of a reply that is ONE JSON object whose only non-meta key is an answer key, or null when the reply is
 * anything else. "Anything else" is deliberate and wide, so prose is never eaten:
 *   - text before or after the object, a second object, a truncated object: not a wrapper;
 *   - a second data key (`{"answer": "...", "sources": [...]}`) or an object with no answer key
 *     (`{"name": "Framework", "input": "laptop"}`): data, not a wrapper.
 *
 * The value comes back as the model wrote it, except that:
 *   - a number or a boolean becomes its string;
 *   - null becomes '' (an answer key that says nothing);
 *   - an array or an object stays one, and the caller's coerceAnswerText turns it into text.
 * An empty string, an empty array and null are all "an empty answer": the caller must not show them as JSON.
 */
export function answerWrapperOf(text: string): { answer: unknown } | null {
  const body = unfenced(text.trim());
  if (!body.startsWith('{') || !body.endsWith('}')) return null;

  // One object that is the whole reply: the string-aware scanner, so braces inside strings do not count.
  const spans = findTopLevelObjects(body);
  if (spans.length !== 1 || !spans[0].closed || spans[0].start !== 0 || spans[0].end !== body.length) return null;

  const parsed = parsePartialOrTruncatedJson(body);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const keys = Object.keys(parsed);
  const answerKeys = keys.filter((key) => ANSWER_KEYS.includes(key));
  if (answerKeys.length !== 1) return null;
  if (keys.some((key) => key !== answerKeys[0] && !META_KEYS.has(key))) return null;

  const value: unknown = (parsed as Record<string, unknown>)[answerKeys[0]];
  if (typeof value === 'number' || typeof value === 'boolean') return { answer: String(value) };
  if (value === null || value === undefined) return { answer: '' };
  return { answer: value };
}
