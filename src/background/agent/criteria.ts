// src/background/agent/criteria.ts
// Success criteria and DOM predicate evaluation for LangGraph sites.
// Erasable TypeScript (no enums, no parameter properties).

import type { Finding, Predicate, SiteSpec } from '../graph/state.ts';

export interface PagePredicateContext {
  url: string;
  pageText: string;
  elementTexts?: string[];
}

export interface CriteriaEvalResult {
  met: boolean;
  status: 'done' | 'partial' | 'unverified';
  reason: string;
}

/**
 * Checks whether a single DOM predicate is satisfied.
 * Types: 'url_contains' | 'text_present' | 'element_text_present'.
 */
export function evaluatePredicate(
  predicate: Predicate,
  context: PagePredicateContext
): boolean {
  if (!predicate || !predicate.value) return false;

  const target = predicate.value.toLowerCase().trim();

  if (predicate.type === 'url_contains') {
    return (context.url || '').toLowerCase().includes(target);
  }

  if (predicate.type === 'text_present') {
    return (context.pageText || '').toLowerCase().includes(target);
  }

  if (predicate.type === 'element_text_present') {
    const list = context.elementTexts || [];
    return list.some((t) => (t || '').toLowerCase().includes(target));
  }

  return false;
}

/**
 * Evaluates whether a site's success criteria have been satisfied based on recorded findings
 * or current page predicates.
 */
export function evaluateSiteCriteria(
  site: SiteSpec,
  findings: Finding[],
  context?: PagePredicateContext
): CriteriaEvalResult {
  const criteria = site.criteria;
  const siteFindings = findings.filter((f) => f.siteId === site.id);

  if (site.goalKind === 'answer') {
    return {
      met: true,
      status: 'done',
      reason: 'Answer delivered'
    };
  }

  if (criteria.doneWhen === 'predicate') {
    if (!context) {
      return { met: false, status: 'partial', reason: 'Missing page context for predicate evaluation' };
    }
    const predicate = site.criteria.predicate;
    if (!predicate) {
      return {
        met: true,
        status: 'unverified',
        reason: 'Step completed without predicate verification'
      };
    }

    const passed = evaluatePredicate(predicate, context);
    if (passed) {
      return {
        met: true,
        status: 'done',
        reason: `Predicate "${predicate.type}: ${predicate.value}" satisfied`
      };
    }
    return {
      met: false,
      status: 'partial',
      reason: `Predicate "${predicate.type}: ${predicate.value}" not satisfied yet`
    };
  }

  if (criteria.doneWhen === 'any') {
    const hasAny = siteFindings.some((f) => f.checks.includes('value_on_page') && String(f.value).toLowerCase() !== 'not shown');
    if (hasAny) {
      return {
        met: true,
        status: 'done',
        reason: 'At least one field found'
      };
    }
    return {
      met: false,
      status: 'partial',
      reason: 'No field value recorded yet'
    };
  }

  // criteria.doneWhen === 'all_required'
  const requiredFieldNames = criteria.fields.filter((f) => f.required).map((f) => f.name);
  if (requiredFieldNames.length === 0) {
    if (criteria.fields.length > 0) {
      requiredFieldNames.push(criteria.fields[0].name);
    }
  }

  const recordedFieldNames = new Set(
    siteFindings
      .filter((f) => f.checks.includes('value_on_page') && String(f.value).toLowerCase() !== 'not shown')
      .map((f) => f.field)
  );

  const missing = requiredFieldNames.filter((name) => !recordedFieldNames.has(name));
  if (missing.length === 0) {
    return {
      met: true,
      status: 'done',
      reason: 'All required fields found'
    };
  }

  return {
    met: false,
    status: 'partial',
    reason: `Missing required fields: ${missing.join(', ')}`
  };
}
