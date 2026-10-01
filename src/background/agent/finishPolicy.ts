/**
 * agent/finishPolicy.ts
 *
 * What the harness does when the model's final answer fails the audit (agent/answerAudit.ts).
 *
 * The audit only FINDS problems: a link the model never opened, a source it never visited, a number
 * no page showed. This file decides what to DO about them. It is the one place where "how strict
 * should ScoutFox be" is a product choice and not a check, so it is kept tiny and separate.
 *
 * All three outcomes keep the same promise: a failed answer never reaches the user as a plain,
 * confirmed "Done". There is deliberately no 'accept' outcome, so no policy written here can
 * bring the original problem back (the "idealo.de and geizhals.de" answer that was never researched).
 *
 *   send_back  Do not finish. Tell the model exactly what was wrong and let it keep working.
 *              Costs one model call per send-back, and a small model may just repeat itself.
 *   annotate   Finish, but mark the answer unverified: made-up links are cut out of it and a
 *              code-written "what could not be verified" section is added. The model's own
 *              wording stays, so the parts that were real are not thrown away.
 *   replace    Finish with an answer written by code only: the pages that were really read and the
 *              numbers that were really found on them. The model's own text is dropped.
 *
 * The engine calls this only when the audit found at least one lie or gap (never for an answer
 * that passed, and never for soft notes alone, which are shown but do not change the answer).
 */

export type GateDecision = 'send_back' | 'annotate' | 'replace';

export interface GateContext {
  /** Plainly false claims: a made-up link, numbers for a source never opened, a number no page showed. Never negative. */
  lieCount: number;
  /** Named sources that no page was read from, where the answer does not claim data for them. The model can still fix this by going there. Never negative. */
  gapCount: number;
  /** How many times this run's finish was already sent back to the model (0 on the first attempt). */
  sendBacks: number;
  /** Steps left before the step cap. A send-back costs at least one. */
  stepsLeft: number;
}

/**
 * Picks what happens to a failed answer.
 *
 * The engine guarantees that `lieCount + gapCount >= 1` when it calls this.
 */
export function decideOnFailedAudit(ctx: GateContext): GateDecision {
  // TODO(human): decide the policy. This starter keeps the harness safe until you choose:
  // up to 2 send-backs, then annotate. Things to weigh: how many send-backs a small local model
  // can use (it often repeats itself), whether made-up links (cheap to cut out) deserve a send-back
  // at all, whether a run that has exhausted its send-backs should keep the model's words
  // ('annotate') or drop them ('replace'), and what to do when stepsLeft is too small to retry.
  const MAX_SEND_BACKS = 2;
  if (ctx.sendBacks >= MAX_SEND_BACKS || ctx.stepsLeft < 2) return 'annotate';
  return 'send_back';
}
