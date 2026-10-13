// src/background/agent/answerValue.ts
// Turns a STRUCTURED final answer into Markdown the side panel can render. A model that answers a list question
// ("top trending repositories") with JSON often sends an array of objects:
//   [{"repo": "debpalash/VoiceStudio", "stars": "62,532", "forks": "6,974"}, ...]
// and coerceAnswerText (outcome.ts) used to print that as indented JSON. A Markdown table is what the card shows well
// (it has its own scroll box for wide tables, see .md-table-wrap in sidepanel.css).
// Pure: no state, no logging, erasable TypeScript. Must never throw.

/**
 * The Markdown table for an answer that is a non-empty array of flat objects (every value a string, number, boolean or
 * null), or null for anything else, which keeps the caller's old text for that value.
 *
 * The contract is narrow on purpose: arrays of strings and plain objects are NOT handled here (their old text is
 * pinned by tests/agent/outcomes.test.ts and tests/agent/outcome.test.ts).
 *
 * TODO(human): implement the table. Decisions that are yours to make (a few lines each):
 *   - the column set and order (the keys of the first row? the union of all rows, in order of first appearance?);
 *   - a row that lacks a key: an empty cell, or a dash;
 *   - a cell value with a pipe character or a line break, which would break the Markdown row;
 *   - a very long value, or a very large array (the card has a size limit, see MAX_ANSWER_CHARS in answerAudit.ts).
 */
export function answerValueToMarkdown(_value: unknown): string | null {
  return null;
}
