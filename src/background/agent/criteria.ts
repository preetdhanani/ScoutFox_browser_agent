// src/background/agent/criteria.ts
// Success criteria and DOM predicate evaluation for LangGraph sites.
// Erasable TypeScript (no enums, no parameter properties).

import type { Finding, Predicate, SiteSpec } from '../graph/state.ts';
import { isAutoValueField } from './findings.ts';

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
  // Auto-value fields (url, link, ...) are recorded by the engine on every finding, so code never
  // demands them from the model: demanding them made a site with a url column unsatisfiable, and
  // an unsatisfiable site is what kept the summarize loop spinning.
  // When every field is auto-value there is nothing for the model to collect on this page.
  // Ending the site honestly beats a vacuous "All required fields found" with zero findings.
  const requiredFieldNames = criteria.fields
    .filter((f) => f.required && !isAutoValueField(f.name))
    .map((f) => f.name);
  if (requiredFieldNames.length === 0) {
    const nonAuto = criteria.fields.filter((f) => !isAutoValueField(f.name));
    if (nonAuto.length > 0) {
      requiredFieldNames.push(nonAuto[0].name);
    } else if (criteria.fields.length > 0) {
      return {
        met: true,
        status: 'done',
        reason: 'Only auto-recorded fields (link/URL) were required - there was nothing to collect from this page'
      };
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
