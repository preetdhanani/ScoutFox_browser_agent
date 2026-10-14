// src/background/agent/memory.ts
// Model-facing memory records and prompt context blocks.
import type { StepRecord, OneShot } from '../graph/workerState.ts';
import type { HistoryEntry } from '../graph/state.ts';
import { clipWithNote } from '../../shared/clip.ts';

/** A detail in a one-line step record is cut at this many characters, with an inline marker. */
const RECORD_DETAIL_CAP = 80;
/** A read_page_text part note is longer (it carries the stop hint), so it gets more room. */
const RECORD_NOTE_CAP = 160;

/**
 * Formats a single action execution into a StepRecord one-liner.
 * Example: '#12 click [88] "Alle Angebote" -> no visible change'
 */
export function formatStepRecord(record: StepRecord): string {
  if (record.line) return record.line;
  const num = record.step !== null ? `#${record.step} ` : '';
  const verb = record.verb || 'action';
  const detail = record.detail ? ` -> ${record.detail}` : '';
  return `${num}${verb}${detail}`;
}

export interface BuildStepRecordParams {
  step: number | null;
  node: 'policy' | 'system' | 'user';
  verb: string | null;
  elementId?: number;
  label?: string;
  url?: string;
  effect?: string;
  success?: boolean;
  error?: string;
  message?: string;
  /** The part note of a read_page_text ("12000 chars, part 2 of 4, ..."), shown instead of the effect. */
  note?: string;
  /** The input path the action ran through, so the model knows when input was synthetic. */
  via?: 'cdp' | 'synthetic' | 'background' | 'state';
  /** Why the input dropped to synthetic DOM events, shown in the step line. */
  syntheticReason?: string;
}

export function buildStepRecord(params: BuildStepRecordParams): StepRecord {
  const stepNum = params.step !== null ? `#${params.step}` : '#';
  const verb = params.verb || 'action';
  const target = params.elementId !== undefined
    ? `[${params.elementId}]${params.label ? ` "${params.label}"` : ''}`
    : (params.url ? `"${params.url}"` : '');

  let effectText = 'no visible change';
  if (params.success === false) {
    effectText = params.error ? `failed: ${clipWithNote(params.error, RECORD_DETAIL_CAP, { inline: true })}` : 'failed';
  } else if (params.note) {
    effectText = `read ${clipWithNote(params.note, RECORD_NOTE_CAP, { inline: true })}`;
  } else if (params.effect === 'url_changed') {
    effectText = 'URL changed';
  } else if (params.effect === 'value_set') {
    effectText = 'value entered';
  } else if (params.effect === 'dom_changed') {
    effectText = 'page updated';
  } else if (params.message) {
    effectText = clipWithNote(params.message, RECORD_DETAIL_CAP, { inline: true });
  }

  // The model must know when the input was synthetic DOM events instead of trusted CDP
  // input, and why, or it believes a synthetic click that did nothing has progressed.
  if (params.via === 'synthetic' && params.syntheticReason) {
    const reason = clipWithNote(params.syntheticReason, RECORD_DETAIL_CAP, { inline: true });
    effectText = `${effectText} (synthetic: ${reason})`;
  }

  const line = `${stepNum} ${verb}${target ? ` ${target}` : ''} -> ${effectText}`.trim();

  let outcome: StepRecord['outcome'] = 'ok';
  if (params.success === false) outcome = 'failed';
  else if (params.effect === 'none') outcome = 'no_effect';
  else if (params.node === 'system') outcome = 'system';
  else if (params.node === 'user') outcome = 'user';

  return {
    step: params.step,
    node: params.node,
    url: params.url || '',
    verb: params.verb,
    line,
    outcome,
    detail: effectText.slice(0, 300),
    ...(params.via ? { via: params.via } : {}),
    ...(params.via === 'synthetic' && params.syntheticReason ? { syntheticReason: params.syntheticReason } : {}),
  };
}

/**
 * Returns the recent step records formatted as one-line strings for RECENT STEPS.
 */
export function formatRecentSteps(records: readonly StepRecord[], limit = 5): string[] {
  if (!records || records.length === 0) return [];
  const slice = records.slice(-limit);
  return slice.map((r) => formatStepRecord(r));
}

/**
 * Formats a OneShot context block (for read_page_text, execute_js, or network activity).
 */
export function formatOneShotContext(oneShot: OneShot | null | undefined): string | null {
  if (!oneShot || !oneShot.text) return null;
  const label = oneShot.label || 'Tool Output';
  return `[${label}]:\n${oneShot.text}`;
}

/**
 * Formats user answers from ask_user holds into guidance for the policy prompt.
 * Replaces legacy: 'You asked a question and the user answered: "<text>". Continue the task using this answer.'
 */
export function formatUserAnswers(answers: readonly (string | HistoryEntry)[]): string[] {
  if (!answers || answers.length === 0) return [];
  const lines: string[] = [];
  for (const item of answers) {
    const text = typeof item === 'string' ? item : (item.type === 'user_answer' ? item.content : '');
    if (text) {
      lines.push(`You asked a question and the user answered: "${text}". Continue the task using this answer.`);
    }
  }
  return lines;
}

/**
 * Formats pending correction text after a parse error or element ID rejection.
 */
export function formatPendingCorrection(errorText: string): string {
  if (!errorText) return '';
  return `CORRECTION: ${errorText}`;
}
