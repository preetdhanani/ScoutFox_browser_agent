// src/background/mcp/historyEntries.ts
// Pure helpers that turn MCP tool calls into the side panel's HistoryEntry rows.
//
// No chrome APIs and no imports from the background runtime: the e2e mock's self-test
// (tests/e2e/lib/mockOllama.selftest.mjs) imports this file to build the same rows the
// client builds, so it must stay dependency-free.

import type { HistoryEntry } from '../types.ts';

/** The parsed arguments of one tool call of the LLM. */
export interface ToolCallInput {
  name: string;
  args: Record<string, any>;
}

/**
 * A tool call of the MCP vocabulary as the action object the side panel's describeAction()
 * already renders ("Clicked 'In den Warenkorb'", "Read page text", ...). Returns null for
 * update_plan, which is shown as the plan checklist, not as an action row.
 * An unknown tool name passes through as its own name, so a new tool is never invisible.
 */
export function mapToolToAction(name: string, args: Record<string, any> | null): Record<string, unknown> | null {
  const a = args || {};
  switch (name) {
    case 'get_page_text':
    case 'read_page_text':
      return { action: 'read_page_text' };
    case 'get_page_elements':
      return { action: 'get_page_elements' };
    case 'find':
      return { action: 'find_elements', query: a.query };
    case 'click':
      // A coordinate click has no element id. Keeping the coordinates on the action is what lets
      // the panel say "Clicked at (x, y) in the picture" instead of "Clicked element undefined".
      return a.x !== undefined && a.y !== undefined
        ? { action: 'click', x: a.x, y: a.y }
        : { action: 'click', element_id: a.element_id };
    case 'take_screenshot':
      return { action: 'take_screenshot' };
    case 'render_table':
      return { action: 'render_table', columns: a.columns, rows: a.rows };
    case 'type':
      return { action: 'type', element_id: a.element_id, text: a.text };
    case 'scroll':
      return { action: 'scroll', direction: a.direction };
    case 'navigate':
      return { action: 'navigate', url: a.url };
    case 'wait':
      return { action: 'wait', amount: a.amount };
    case 'go_back':
      return { action: 'go_back' };
    case 'go_forward':
      return { action: 'go_forward' };
    case 'update_plan':
      return null;
    case 'finish':
      return { action: 'finish' };
    default:
      return { action: name };
  }
}

// A tool result in the timeline is a summary, never the full page text. Long enough to say
// what came back, short enough that a row stays one line.
const RESULT_SUMMARY_MAX = 200;

/** The text an execution_result row shows for one tool result. */
export function summarizeToolResult(text: string): string {
  const t = String(text || '');
  return t.length <= RESULT_SUMMARY_MAX ? t : `${t.slice(0, RESULT_SUMMARY_MAX - 1)}…`;
}

export function userGoalEntry(turn: number, prompt: string): HistoryEntry {
  return { type: 'user_goal', turn, prompt, timestamp: new Date().toLocaleTimeString(), isNewRun: true };
}

export function agentResponseEntry(
  step: number,
  thought: string,
  action: Record<string, unknown> | null,
  rawResponse: string
): HistoryEntry {
  return { type: 'agent_response', step, thought, action, rawResponse };
}

export function executionResultEntry(step: number, success: boolean, message: string, table?: any): HistoryEntry {
  const entry: any = success
    ? { type: 'execution_result', step, success: true, message }
    : { type: 'execution_result', step, success: false, error: message };
  if (table) entry.table = table;
  return entry;
}

/**
 * The row of a step that took a picture. The row carries the text and the id, never the bytes:
 * the panel rebuilds the timeline from the history on every broadcast, so a base64 JPEG in a row
 * would be re-parsed on every one of them.
 */
export function screenshotResultEntry(
  step: number,
  success: boolean,
  message: string,
  image?: { imageId: string; imageWidth: number; imageHeight: number }
): HistoryEntry {
  const base = executionResultEntry(step, success, message);
  if (!image) return base;
  return { ...base, imageId: image.imageId, imageWidth: image.imageWidth, imageHeight: image.imageHeight } as HistoryEntry;
}

export function errorEntry(content: string): HistoryEntry {
  return { type: 'error', content };
}

/**
 * The finish row of the timeline.
 *
 * `evidence` is the supporting material of a structured answer, kept apart from the answer
 * itself so the panel can show it in a collapsed section instead of in the middle of the text
 * the user reads.
 */
export function finishEntry(answer: string, evidence = '', table?: any): HistoryEntry {
  const entry: any = evidence ? { type: 'finish', answer, evidence } : { type: 'finish', answer };
  if (table) entry.table = table;
  return entry;
}
