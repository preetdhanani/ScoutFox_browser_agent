// src/background/agent/profile.ts
// Effort profile loader and heuristic level inference.
// Erasable TypeScript (no enums, no parameter properties).

import type { Level, EffortProfile } from '../graph/state.ts';
import EFFORT_MATRIX_DATA from '../../../shared/effort.json' with { type: 'json' };

export interface EffortSuggestion {
  level: Level;
  reason: string;
}

const COMPARISON_KEYWORDS = /\b(compare|cheapest|best price|lowest price|across|all stores|diff|vs|versus|find every|comprehensive|deep search|multi-site)\b/i;
const EXHAUSTIVE_KEYWORDS = /\b(exhaustive|exhaustively|deepest|maximum effort|every single|all possible|ultra|highest effort)\b/i;
const SIMPLE_KEYWORDS = /\b(what is|who is|quick|simple|current time|weather in|just find|read page|summarize this page)\b/i;

/**
 * Load the raw effort matrix from shared/effort.json.
 */
export function loadEffortMatrix(): Record<string, EffortProfile> {
  return (EFFORT_MATRIX_DATA.levels ?? {}) as Record<string, EffortProfile>;
}

/**
 * Get an EffortProfile by level ('auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max').
 * Falls back to 'medium' if unspecified, unknown, or not yet activated.
 */
export function getEffortProfile(level?: Level | string | null): EffortProfile {
  const matrix = loadEffortMatrix();
  const normalized = (level ?? '').toLowerCase() as Level;

  if (matrix[normalized]) {
    return matrix[normalized];
  }

  return matrix[EFFORT_MATRIX_DATA.defaultLevel as Level] ?? matrix.medium;
}

/**
 * Suggest an effort level based on task prompt text and optional site count.
 */
export function suggestEffortLevel(task: string, siteCount?: number): EffortSuggestion {
  const trimmed = (task || '').trim();

  if (EXHAUSTIVE_KEYWORDS.test(trimmed)) {
    return {
      level: 'max',
      reason: 'Task keywords suggest exhaustive deep research or maximum effort.',
    };
  }

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

export interface PlanEstimate {
  estimatedSteps: number;
  estimatedSeconds: number;
  reserveSteps: number;
  estimatedStepsPerSite: number;
}

/**
 * Calculate step and duration estimates for a plan given an effort profile and site count.
 */
export function calculatePlanEstimate(
  profile: EffortProfile,
  siteCount: number
): PlanEstimate {
  const count = Math.max(1, siteCount);
  const stepsPerSite = profile.stepBudgetPerSite ?? Math.round(15 * (profile.multiplier || 1));
  const totalSiteSteps = count * stepsPerSite;
  const reservePct = profile.reservePct ?? 0.15;
  const reserveSteps = Math.round(totalSiteSteps * reservePct);
  const estimatedSteps = totalSiteSteps + reserveSteps;

  const secPerSite = profile.level === 'max' ? 120 : profile.level === 'xhigh' ? 90 : profile.level === 'high' ? 60 : profile.level === 'low' ? 15 : 30;
  const estimatedSeconds = count * secPerSite;

  return {
    estimatedSteps,
    estimatedSeconds,
    reserveSteps,
    estimatedStepsPerSite: stepsPerSite,
  };
}

