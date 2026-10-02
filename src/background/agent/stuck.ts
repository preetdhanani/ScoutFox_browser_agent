// src/background/agent/stuck.ts
// Loop detection and unchanged DOM detection for LangGraph verify/recover nodes.
// Erasable TypeScript (no enums, no parameter properties).

import type { PageSig } from '../graph/workerState.ts';

export interface ActionRecord {
  url: string;
  signature: string; // e.g. "click|12|" or "navigate||https://example.com"
}

export interface StuckCheckResult {
  isStuck: boolean;
  reason?: 'repeated_action' | 'unchanged_page' | null;
  detail?: string;
  signatureToBan?: string | null;
}

/**
 * Checks whether the worker is stuck in an action loop or unchanged DOM state.
 * Stuck condition 1: The last 3 executed actions have identical action signatures.
 * Stuck condition 2: The URL, interactiveHash, and textHash did not change across the last 3 actions.
 */
export function detectStuck(
  recentActions: ActionRecord[],
  pageSigs: PageSig[]
): StuckCheckResult {
  // Check 1: 3 identical action signatures in a row
  if (recentActions.length >= 3) {
    const last3 = recentActions.slice(-3);
    const sig0 = last3[0].signature;
    if (sig0 && last3.every((a) => a.signature === sig0)) {
      return {
        isStuck: true,
        reason: 'repeated_action',
        detail: `The same action was executed 3 times in a row (${sig0}).`,
        signatureToBan: sig0
      };
    }
  }

  // Check 2: 3 consecutive executed actions where URL, interactiveHash, and textHash did not change
  if (pageSigs.length >= 3) {
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
