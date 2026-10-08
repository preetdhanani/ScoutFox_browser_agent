// src/background/agent/budget.ts
// Step and token budget computation for LangGraph orchestrator and worker.
// Erasable TypeScript (no enums, no parameter properties).

export type SiteKind = 'store' | 'listing' | 'search' | 'page';
export type MeterMode = 'normal' | 'warn' | 'harvest' | 'end';

export const BASE_STEPS: Record<SiteKind, number> = {
  page: 6,
  search: 8,
  listing: 10,
  store: 12,
};

export const DIFFICULTY_MULTIPLIERS: Record<number, number> = {
  1: 1.0,
  2: 1.5,
  3: 2.0,
};

export function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

/**
 * Computes base steps for a site before effort level multiplier:
 * clamp(BASE[kind] * DIFFICULTY[difficulty], 4, 30).
 */
export function computeSiteBase(kind: SiteKind, difficulty: number = 1): number {
  const base = BASE_STEPS[kind] ?? BASE_STEPS.page;
  const diffMult = DIFFICULTY_MULTIPLIERS[difficulty] ?? 1.0;
  return clamp(Math.round(base * diffMult), 4, 30);
}

/**
 * Computes site step allocation with effort level multiplier (default Medium = 2).
 */
export function computeSiteAlloc(base: number, multiplier: number = 2): number {
  return Math.max(4, Math.round(base * multiplier));
}

/**
 * Computes orchestrator working total and reserve:
 * workingTotal = sum(site allocations) / (1 - reservePct).
 */
export function computeWorkingTotal(
  siteAllocs: number[],
  reservePct: number = 0.15
): { workingTotal: number; reserve: number; sumAllocs: number } {
  const sumAllocs = siteAllocs.reduce((a, b) => a + b, 0);
  const pct = clamp(reservePct, 0, 0.5);
  const workingTotal = Math.round(sumAllocs / (1 - pct));
  const reserve = workingTotal - sumAllocs;
  return { workingTotal, reserve, sumAllocs };
}

/**
 * Computes usable step budget left:
 * hardCap - used - reserve.
 */
export function computeUsableBudget(hardCap: number, used: number, reserve: number): number {
  return Math.max(0, hardCap - used - reserve);
}

/**
 * Evaluates meter mode based on used steps vs site allocation:
 * - < 60%: 'normal'
 * - 60% <= used < 80%: 'warn'
 * - 80% <= used < 95%: 'harvest'
 * - >= 95%: 'end'
 */
export function evaluateMeterMode(used: number, alloc: number): MeterMode {
  if (alloc <= 0) return 'end';
  const ratio = used / alloc;
  if (ratio < 0.6) return 'normal';
  if (ratio < 0.8) return 'warn';
  if (ratio < 0.95) return 'harvest';
  return 'end';
}

/**
 * Determines if a site can draw from the slack pool when reaching 95% budget:
 * Allowed once if progress was made within the last 5 steps.
 * Draws up to 25% of the site's original allocation.
 */
export function calculateSlackDraw(
  slackPool: number,
  alloc: number,
  lastProgressStep: number,
  currentStep: number,
  alreadyDrawn: boolean
): number {
  if (alreadyDrawn || slackPool <= 0) return 0;
  const progressRecent = (currentStep - lastProgressStep) <= 5;
  if (!progressRecent) return 0;

  const maxDraw = Math.max(1, Math.round(alloc * 0.25));
  return Math.min(slackPool, maxDraw);
}
