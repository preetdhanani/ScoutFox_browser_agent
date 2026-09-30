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
  answer?: string;
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

/** Builds the history entry for an explicit `finish` action. */
export function buildFinishEntry(actionObj: FinishAction): FinishEntry {
  const entry: FinishEntry = { type: 'finish', answer: actionObj.answer || NO_ANSWER_GIVEN };
  if (actionObj.autoWrapped) entry.unconfirmed = true;
  return entry;
}

/** Builds the history entry for hitting the step ceiling without the model ever calling finish. */
export function buildMaxStepsEntry(maxSteps: number): MaxStepsEntry {
  return {
    type: 'error',
    content: `Stopped without finishing - reached the maximum allowed steps (${maxSteps}) before the task called finish.`
  };
}
