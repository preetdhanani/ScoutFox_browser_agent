// src/background/agent/stuck.ts
// Loop detection and unchanged DOM detection for LangGraph verify/recover nodes.
// Erasable TypeScript (no enums, no parameter properties).

import type { PageSig } from '../graph/workerState.ts';

export interface ActionRecord {
  url: string;
  signature: string; // e.g. "click|12|" or "scroll|||down", built by actionSignature.ts
}

export interface StuckCheckOptions {
  /** True when the last action was a full-page read whose part note says it returned new text. */
  readNewText?: boolean;
}

export interface StuckCheckResult {
  isStuck: boolean;
  reason?: 'repeated_action' | 'unchanged_page' | null;
  detail?: string;
  signatureToBan?: string | null;
}

/**
 * True when the two page signatures describe different page states: another URL, another scroll
 * position, or another element or text hash. This is the progress signal the stuck level decays on.
 */
export function pageSignatureChanged(before: PageSig, after: PageSig): boolean {
  return before.url !== after.url
    || before.scrollY !== after.scrollY
    || before.interactiveHash !== after.interactiveHash
    || before.textHash !== after.textHash;
}

/**
 * True when every signature in the list describes the same page state. An empty hash proves
 * nothing, so a list with an empty element or text hash never counts as unchanged.
 */
function pageSigsUnchanged(sigs: PageSig[]): boolean {
  if (sigs.length < 2) return false;
  const first = sigs[0];
  if (first.interactiveHash === '' || first.textHash === '') return false;
  return sigs.every((s) => !pageSignatureChanged(first, s));
}

/**
 * One stuck level lower, floored at 0. Progress heals the stuck counter, replacing the old
 * reset-only-at-site-open behaviour where stuckLevel never decreased inside a site run.
 */
export function decayStuckLevel(level: number): 0 | 1 | 2 | 3 {
  return Math.max(0, level - 1) as 0 | 1 | 2 | 3;
}

/**
 * Checks whether the worker is stuck in an action loop or unchanged DOM state.
 * Stuck condition 1: the last 3 executed actions have identical action signatures and the page
 * did not change under them (a scroll or a typed query that moves the page is progress, not a loop).
 * Stuck condition 2: the URL, interactiveHash, and textHash did not change across the last 3 actions.
 * A read that returned new text (a paging read) is exempt from both checks.
 */
export function detectStuck(
  recentActions: ActionRecord[],
  pageSigs: PageSig[],
  opts: StuckCheckOptions = {},
): StuckCheckResult {
  // Check 1: 3 identical action signatures in a row on an unchanged page
  if (!opts.readNewText && recentActions.length >= 3 && pageSigs.length >= 3) {
    const last3 = recentActions.slice(-3);
    const sig0 = last3[0].signature;
    if (sig0 && last3.every((a) => a.signature === sig0) && pageSigsUnchanged(pageSigs.slice(-3))) {
      return {
        isStuck: true,
        reason: 'repeated_action',
        detail: `The same action was executed 3 times in a row (${sig0}).`,
        signatureToBan: sig0
      };
    }
  }

  // Check 2: 3 consecutive executed actions where URL, interactiveHash, and textHash did not change
  if (!opts.readNewText && pageSigs.length >= 3) {
    const last3 = pageSigs.slice(-3);
    const first = last3[0];
    const sameUrl = last3.every((s) => s.url === first.url);
    const sameInteractive = last3.every((s) => s.interactiveHash === first.interactiveHash && s.interactiveHash !== '');
    const sameText = last3.every((s) => s.textHash === first.textHash && s.textHash !== '');

    if (sameUrl && sameInteractive && sameText) {
      const lastActionSig = recentActions.length > 0 ? recentActions[recentActions.length - 1].signature : null;
      return {
        isStuck: true,
        reason: 'unchanged_page',
        detail: 'The page content and interactive elements did not change after 3 consecutive actions.',
        signatureToBan: lastActionSig
      };
    }
  }

  return { isStuck: false, reason: null, detail: '', signatureToBan: null };
}

export type StuckEscalation = 'warn_and_ban' | 'switch_strategy_or_partial' | 'end_stuck';

/**
 * Escalates based on stuck level (1, 2, or 3):
 * 1: warn & ban signature
 * 2: switch strategy (or exit partial at Medium/Low)
 * 3: end stuck
 */
export function getStuckEscalation(level: number, effortLevel: string = 'medium'): StuckEscalation {
  if (level <= 1) return 'warn_and_ban';
  if (level === 2) return 'switch_strategy_or_partial';
  return 'end_stuck';
}
