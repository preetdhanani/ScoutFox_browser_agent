/**
 * agent/outcome.ts
 *
 * Ends a run honestly. Two separate places used to end a run by lying about it:
 *
 * 1. Reaching maxSteps pushed a {type:'finish'} history entry. The panel renders every
 *    'finish' identically - a green "Done" card - and previousTurnsSummary() re-injects it
 *    into the NEXT turn's prompt as a completed task. An unfinished run must never look like a
 *    finished one, so this is now type:'error' instead; the panel's own "did not finish" logic
 *    (buildTurns/renderTurns in sidepanel.js, keyed on `!turn.answer`) already does the right
 *    thing the moment this stops masquerading as an answer - nothing there needed to change.
 * 2. parseResponse's freeform-prose guardrail (stage 6) turns any garbled non-JSON reply into
 *    an invented {action:'finish'}. It still has to end the run - the model has nothing
 *    parseable left to say - but it must not claim a deliberate, confirmed completion. Its
 *    action object carries `autoWrapped: true` (agentEngine.js parseResponse), and this module
 *    turns that into an `unconfirmed` flag on the history entry so the panel can say so instead
 *    of showing the same "Done" card as a real finish.
 */

/** The part of a parsed `finish` action that this module reads. */
export interface FinishAction {
  action?: string;
  /** A string as asked for; anything else is turned into text by coerceAnswerText. */
  answer?: unknown;
  autoWrapped?: boolean;
}

export interface FinishEntry {
  type: 'finish';
  answer: string;
  unconfirmed?: true;
}

export interface MaxStepsEntry {
  type: 'error';
  content: string;
}

// What an honest finish says when the model called `finish` but gave no answer at all, instead
// of the previous invented "Task completed successfully." (which was true by assertion, not by
// anything the model actually reported).
export const NO_ANSWER_GIVEN = '(The model did not provide an answer.)';

/**
 * The text of a final answer. The prompt asks for a string, but nothing checks the type of a reply field yet, and a
 * cloud model may answer with a list of table rows or an object. The panel shows String(answer), and the audit must
 * check exactly what is shown and stored, so it is turned into text once, here: a list becomes its items on separate
 * lines, an object becomes indented JSON, anything else its String form. Nothing throws.
 */
export function coerceAnswerText(answer: unknown): string {
  if (typeof answer === 'string') return answer;
  if (answer === null || answer === undefined) return '';
  try {
    if (Array.isArray(answer)) return answer.map((item) => (typeof item === 'string' ? item : coerceAnswerText(item))).join('\n');
    if (typeof answer === 'object') return JSON.stringify(answer, null, 2) ?? '';
    return String(answer);
  } catch {
    return '';
  }
}

/** Builds the history entry for an explicit `finish` action. */
export function buildFinishEntry(actionObj: FinishAction): FinishEntry {
  const entry: FinishEntry = { type: 'finish', answer: coerceAnswerText(actionObj.answer) || NO_ANSWER_GIVEN };
  if (actionObj.autoWrapped) entry.unconfirmed = true;
  return entry;
}

/**
 * Builds the history entry for hitting the step ceiling without the model ever calling finish. When the run ran out of
 * steps after its finish was sent back (`answerKept`), the answer it gave is shown above this entry, marked by the
 * audit, and this entry says why the run stopped.
 */
export function buildMaxStepsEntry(maxSteps: number, options: { answerKept?: boolean } = {}): MaxStepsEntry {
  if (options.answerKept) {
    return {
      type: 'error',
      content: `Stopped at the maximum allowed steps (${maxSteps}): the model's answer was sent back and there was no step left to correct it. The last answer it gave is shown above, marked by ScoutFox.`
    };
  }
  return {
    type: 'error',
    content: `Stopped without finishing - reached the maximum allowed steps (${maxSteps}) before the task called finish.`
  };
}
