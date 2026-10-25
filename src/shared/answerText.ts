// src/shared/answerText.ts
// Turns a model's answer into the text a person reads.
//
// A model sometimes answers with a JSON object instead of prose, for example
// {"subgoal_done": {"summary": "...", "evidence": "..."}}. Rendered as-is, that is a wall of
// braces in the answer card: the user reads machine output where they expected a sentence.
//
// This module pulls the readable part out of such an answer. It is deliberately small and has
// no imports, so the side panel and the background can both use it: the background fixes the
// answer before it is stored, and the panel fixes the ones that older builds already stored.
//
// The rule that matters: an answer that is NOT JSON is never touched. Prose that happens to
// contain a brace must stay exactly as the model wrote it.

/** The fields a structured answer is read from, in the order they are preferred. */
const SUMMARY_FIELDS = ['summary', 'answer', 'text', 'result', 'content'] as const;

/** The fields that hold supporting material, shown apart from the answer itself. */
const EVIDENCE_FIELDS = ['evidence', 'details', 'reasoning', 'notes'] as const;

/** How long the answer part of a structured answer may be before it is cut short. */
const MAX_ANSWER_CHARS = 4000;

/** How long one evidence part may be. */
const MAX_EVIDENCE_CHARS = 2000;

export interface ExtractedAnswer {
  /** The text to show as the answer. */
  text: string;
  /** The supporting material, if the answer had any. */
  evidence: string;
  /** True when the answer was a JSON object and something was pulled out of it. */
  wasJson: boolean;
}

/**
 * True when the text looks like a JSON object.
 *
 * Only the shape matters here, not whether it parses: a truncated JSON blob from a model that
 * ran out of tokens is still something to pull a summary out of, and JSON.parse would throw on
 * it. The caller gets the failure back as "this is JSON" and falls back to the raw text.
 */
export function looksLikeJsonObject(text: string): boolean {
  const t = String(text || '').trim();
  if (!t.startsWith('{')) return false;
  // A brace at the start and a brace at the end: a JSON object, not a paragraph that happens
  // to mention one.
  return t.endsWith('}');
}

/**
 * The readable part of a model answer.
 *
 * A plain answer comes back unchanged. A JSON answer comes back as its summary field, with the
 * evidence fields kept apart so the panel can show them in a collapsed section.
 */
export function extractReadableAnswer(raw: string): ExtractedAnswer {
  const text = String(raw || '');
  if (!looksLikeJsonObject(text)) {
    return { text, evidence: '', wasJson: false };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not valid JSON after all. Showing it as it is beats showing nothing.
    return { text, evidence: '', wasJson: false };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { text, evidence: '', wasJson: false };
  }

  // The model often wraps the real answer one level down, in a single key: {"subgoal_done":
  // {...}}. Unwrap it, but only when the wrapper holds exactly one key that is itself an object.
  const body = unwrap(parsed);

  const summary = firstString(body, SUMMARY_FIELDS);
  if (!summary) {
    // A JSON object with no field we know how to read. Pretty-print it, so it is at least
    // readable, and say so by leaving the raw text in place.
    return { text: JSON.stringify(body, null, 2), evidence: '', wasJson: true };
  }

  const evidence = firstString(body, EVIDENCE_FIELDS);
  return { text: summary, evidence, wasJson: true };
}

/**
 * Unwraps a single-key wrapper object.
 *
 * {"subgoal_done": {...}} -> {...}. A wrapper that holds more than one key is not unwrapped: the
 * model put several things in it, and picking one would throw the rest away.
 */
function unwrap(obj: Record<string, any>): Record<string, any> {
  const keys = Object.keys(obj);
  if (keys.length !== 1) return obj;
  const only = obj[keys[0]];
  if (!only || typeof only !== 'object' || Array.isArray(only)) return obj;
  // A wrapper around a wrapper is unwrapped once more: the model nests as deep as it likes.
  return unwrap(only);
}

/** The first of the given fields that holds a non-empty string. */
function firstString(obj: Record<string, any>, fields: readonly string[]): string {
  for (const field of fields) {
    const value = obj[field];
    if (typeof value === 'string' && value.trim()) {
      return cap(value.trim(), field === 'evidence' || field === 'details' ? MAX_EVIDENCE_CHARS : MAX_ANSWER_CHARS);
    }
    // A field that holds a list of strings is read as its lines: a model that answers with
    // {"summary": ["a", "b"]} meant two sentences.
    if (Array.isArray(value) && value.length && value.every((v) => typeof v === 'string')) {
      const joined = value.map((v) => String(v).trim()).filter(Boolean).join('\n');
      if (joined) return cap(joined, MAX_ANSWER_CHARS);
    }
  }
  return '';
}

/** Cuts a text short, with a mark that says it was cut. */
function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
