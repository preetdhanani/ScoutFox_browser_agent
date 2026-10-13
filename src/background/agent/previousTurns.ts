// src/background/agent/previousTurns.ts
// Summaries of previous turns for multi-turn sessions and follow-up prompts.
import type { HistoryEntry } from '../graph/state.ts';

export const PREVIOUS_TURNS_LIMIT = 4;

/**
 * Returns the history slice starting from the latest 'user_goal' entry.
 */
export function currentTurnHistory(history: readonly HistoryEntry[]): HistoryEntry[] {
  if (!history || history.length === 0) return [];
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].type === 'user_goal') return history.slice(i);
  }
  return history.slice();
}

/**
 * Compact recap of earlier COMPLETED turns, so a follow-up has context without replaying
 * every step of every previous task into the prompt.
 *
 * Handles:
 * - finish entries (with optional unconfirmed and audit-verdict tags)
 * - partial_result entries (tagged as '(did not finish - partial)')
 * - 280-character answer truncation
 */
export function previousTurnsSummary(
  history: readonly HistoryEntry[],
  limit = PREVIOUS_TURNS_LIMIT
): string[] {
  if (!history || history.length === 0) return [];
  const lines: string[] = [];
  let goal: string | null = null;

  for (const item of history) {
    if (item.type === 'user_goal') {
      goal = item.prompt;
    } else if (item.type === 'finish' && goal) {
      const answer = String(item.answer || '').replace(/\s+/g, ' ').slice(0, 280);
      let verdict = '';
      const audit = (item as any).audit;
      if (audit && audit.verdict && audit.verdict !== 'verified') {
        verdict = ` (${audit.verdict}: not everything in it was checked against pages that were read)`;
      } else if (item.unconfirmed === true) {
        verdict = ' (unconfirmed)';
      }
      lines.push(`- Asked: "${goal}"\n  Result${verdict}: ${answer}`);
      goal = null;
    } else if (item.type === 'partial_result' && goal) {
      const answer = String(item.answer || '').replace(/\s+/g, ' ').slice(0, 280);
      lines.push(`- Asked: "${goal}"\n  Result (did not finish - partial): ${answer}`);
      goal = null;
    }
  }

  return lines.slice(-limit);
}

/**
 * Returns the most recent completed turn goal and answer for the plan user prompt.
 */
export function lastCompletedTurn(
  history: readonly HistoryEntry[]
): { goal: string; answer: string } | null {
  if (!history || history.length === 0) return null;

  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    if (item.type === 'finish' || item.type === 'partial_result') {
      const answer = String(item.answer || '').replace(/\s+/g, ' ').slice(0, 280);
      for (let j = i - 1; j >= 0; j--) {
        if (history[j].type === 'user_goal') {
          return {
            goal: (history[j] as any).prompt || '',
            answer,
          };
        }
      }
    }
  }

  return null;
}
