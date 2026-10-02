// src/background/agent/profile.ts
// Effort profile loader, heuristic level inference, and budget overage calculations.
// Erasable TypeScript (no enums, no parameter properties).

import type { Level, EffortProfile } from '../graph/state.ts';
import EFFORT_MATRIX_DATA from '../../../shared/effort.json' with { type: 'json' };

export interface OverBudgetEvaluation {
  isOverBudget: boolean;
  deficit: number;
  scale: number;
  choices: Array<'drop_sites' | 'raise_cap' | 'shrink' | 'lower_level'>;
}

export interface PlanEstimate {
  estimatedSteps: number;
  estimatedSeconds: number;
  reserveSteps: number;
  estimatedStepsPerSite: number;
}

export interface EffortSuggestion {
  level: Level;
  reason: string;
}

const COMPARISON_KEYWORDS = /\b(compare|cheapest|best price|lowest price|across|all stores|diff|vs|versus|find every|comprehensive|deep search|multi-site)\b/i;
const SIMPLE_KEYWORDS = /\b(what is|who is|quick|simple|current time|weather in|just find|read page|summarize this page)\b/i;

/**
 * Load the raw effort matrix from shared/effort.json.
 */
export function loadEffortMatrix(): Record<string, EffortProfile> {
  return (EFFORT_MATRIX_DATA.levels ?? {}) as Record<string, EffortProfile>;
}

/**
 * Get an EffortProfile by level ('low' | 'medium' | 'high').
 * Falls back to 'medium' if unspecified, unknown, or not yet activated.
 */
export function getEffortProfile(level?: Level | string | null): EffortProfile {
  const matrix = loadEffortMatrix();
  const normalized = (level ?? '').toLowerCase() as Level;

  if (matrix[normalized]) {
    return matrix[normalized];
  }

  // Graceful fallback for xhigh / max until P7b
  if (normalized === 'xhigh' || normalized === 'max') {
    const high = matrix.high ?? matrix.medium;
    return {
      ...high,
      level: normalized,
      multiplier: normalized === 'max' ? 8 : 4,
      reservePct: 0.10,
    };
  }

  return matrix[EFFORT_MATRIX_DATA.defaultLevel as Level] ?? matrix.medium;
}

/**
 * Suggest an effort level based on task prompt text and optional site count.
 */
export function suggestEffortLevel(task: string, siteCount?: number): EffortSuggestion {
  const trimmed = (task || '').trim();

  if (siteCount !== undefined && siteCount >= 4) {
    return {
      level: 'high',
      reason: 'Task spans 4 or more target sites, suggesting thorough investigation.',
    };
  }

  if (COMPARISON_KEYWORDS.test(trimmed)) {
    return {
      level: 'high',
      reason: 'Task keywords suggest comparison, price checking, or comprehensive search.',
    };
  }

  if (SIMPLE_KEYWORDS.test(trimmed) && (siteCount === undefined || siteCount <= 1)) {
    return {
      level: 'low',
      reason: 'Task keywords suggest a brief single-source lookup.',
    };
  }

  return {
    level: 'medium',
    reason: 'Standard balanced execution profile.',
  };
}

/**
 * Evaluate whether planned allocations exceed the hard cap limit.
 */
export function detectOverBudget(hardCap: number, workingTotal: number): OverBudgetEvaluation {
  const isOverBudget = workingTotal > hardCap && hardCap > 0;
  const deficit = isOverBudget ? workingTotal - hardCap : 0;
  const scale = isOverBudget ? hardCap / workingTotal : 1.0;
  const choices: Array<'drop_sites' | 'raise_cap' | 'shrink' | 'lower_level'> = isOverBudget
    ? ['drop_sites', 'raise_cap', 'shrink', 'lower_level']
    : [];

  return {
    isOverBudget,
    deficit,
    scale,
    choices,
  };
}

/**
 * Calculate step and duration estimates for a plan given an effort profile and site count.
 */
export function calculatePlanEstimate(
  profile: EffortProfile,
  siteCount: number,
  basePerSite = 10
): PlanEstimate {
  const validSiteCount = Math.max(1, siteCount);
  const multiplier = profile.multiplier || 1;
  const reservePct = profile.reservePct ?? 0.15;

  const estimatedStepsPerSite = Math.round(basePerSite * multiplier);
  const totalSiteSteps = estimatedStepsPerSite * validSiteCount;
  const reserveSteps = Math.round(totalSiteSteps * reservePct);
  const estimatedSteps = totalSiteSteps + reserveSteps;

  const secPerSite = profile.level === 'high' ? 60 : profile.level === 'low' ? 15 : 30;
  const estimatedSeconds = validSiteCount * secPerSite;

  return {
    estimatedSteps,
    estimatedSeconds,
    reserveSteps,
    estimatedStepsPerSite,
  };
}
