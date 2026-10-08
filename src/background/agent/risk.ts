// Risk Gate evaluation engine.
// Erasable TypeScript (no enums, no parameter properties).

import type { ElementInfo } from '../graph/workerState.ts';
import RISK_DATA from '../../../shared/risk.json' with { type: 'json' };

export type RiskLevel = 'safe' | 'risky' | 'forbidden';

export type RiskVariant = 'purchase' | 'login' | 'submit' | 'form' | 'navigate';

export interface ActionRiskVerdict {
  level: RiskLevel;
  variant?: RiskVariant;
  reason: string;
  actionSummary: string;
  elementLabel?: string;
  targetDomain?: string;
}

export interface RiskEvaluationInput {
  action: {
    action: string;
    element_id?: number;
    url?: string;
    text?: string;
    submit?: boolean;
    key?: string;
    [key: string]: any;
  };
  elementInfo?: ElementInfo | null;
  pageType?: string | null;
  pageUrl?: string;
  approvedDomains?: string[];
}

/**
 * Extracts and normalizes the hostname from a URL string.
 * Strips port numbers, userinfo, and trailing dots.
 */
export function extractCleanHostname(urlOrHost: string): string | null {
  if (!urlOrHost || typeof urlOrHost !== 'string') return null;
  const trimmed = urlOrHost.trim();
  if (!trimmed) return null;

  try {
    const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed);
    const candidate = hasScheme ? trimmed : `https://${trimmed}`;
    const parsed = new URL(candidate);
    const hostname = parsed.hostname.toLowerCase().replace(/\.+$/, '');
    return hostname || null;
  } catch {
    return null;
  }
}

/**
 * Checks whether candidateHost is approved or covered by an approved domain wildcard/parent.
 */
export function isDomainApproved(candidateHost: string, approvedDomains: string[]): boolean {
  if (!candidateHost) return false;
  const cleanCandidate = candidateHost.toLowerCase();

  for (const approved of approvedDomains) {
    const cleanApproved = approved.toLowerCase().trim();
    if (!cleanApproved) continue;

    if (cleanCandidate === cleanApproved) return true;
    if (cleanCandidate.endsWith(`.${cleanApproved}`)) return true;
  }
  return false;
}

/**
 * Checks whether candidateHost belongs to a known safe search engine.
 */
export function isSafeSearchEngine(candidateHost: string): boolean {
  if (!candidateHost) return false;
  const clean = candidateHost.toLowerCase();
  const searchEngines: string[] = RISK_DATA.safeSearchEngines || [];

  for (const se of searchEngines) {
    if (clean === se || clean.endsWith(`.${se}`)) return true;
  }
  return false;
}

/**
 * Determines whether a label contains any word from a target word list.
 * Matches on word boundaries or exact phrases.
 */
function containsAnyWord(text: string, words: string[]): boolean {
  if (!text) return false;
  const lower = text.toLowerCase().trim();

  for (const word of words) {
    const w = word.toLowerCase().trim();
    if (!w) continue;

    // Direct substring or word boundary match
    if (w.includes(' ')) {
      if (lower.includes(w)) return true;
    } else {
      const regex = new RegExp(`(^|[^a-z0-9äöüß])${w}([^a-z0-9äöüß]|$)`, 'i');
      if (regex.test(lower)) return true;
    }
  }
  return false;
}

/**
 * Evaluates the risk of a proposed action according to ScoutFox Risk Gate rules.
 */
export function evaluateActionRisk(input: RiskEvaluationInput): ActionRiskVerdict {
  const { action, elementInfo, pageType, pageUrl = '', approvedDomains = [] } = input;
  const actionVerb = action.action;
  const label = (elementInfo?.label || '').trim();
  const formKind = elementInfo?.formKind;
  const fieldKind = elementInfo?.fieldKind;

  const actionSummary = describeAction(action, elementInfo);

  // 1. FORBIDDEN: Typing into credentials/OTP fields
  if (actionVerb === 'type') {
    const isForbiddenField =
      fieldKind === 'password' ||
      fieldKind === 'cc' ||
      fieldKind === 'otp' ||
      RISK_DATA.forbiddenFieldKinds.includes(fieldKind || '');

    if (isForbiddenField) {
      return {
        level: 'forbidden',
        reason: 'Typing into sensitive fields (password, credit card, or one-time code) is restricted to the user.',
        actionSummary,
        elementLabel: label || undefined,
      };
    }
  }

  // 2. SAFE EXEMPTION: Add to cart is explicitly safe
  const isAddToCart =
    containsAnyWord(label, ['in den warenkorb', 'add to cart', 'in shopping cart', 'zum warenkorb hinzufügen']) &&
    !containsAnyWord(label, ['kasse', 'checkout', 'jetzt kaufen', 'buy now']);

  if (isAddToCart) {
    return {
      level: 'safe',
      reason: 'Add-to-cart actions are safe browsing operations.',
      actionSummary,
      elementLabel: label || undefined,
    };
  }

  // 3. SAFE EXEMPTION: Search box with submit is always safe
  if (formKind === 'search' || fieldKind === 'search') {
    return {
      level: 'safe',
      reason: 'Search forms and queries are safe operations.',
      actionSummary,
      elementLabel: label || undefined,
    };
  }

  // 4. RISKY: Purchase / Checkout
  const isCheckoutPage = pageType === 'checkout';
  const isCheckoutForm = formKind === 'checkout';
  const isCheckoutContext = isCheckoutPage || isCheckoutForm;
  const hasPurchaseWords = containsAnyWord(label, RISK_DATA.purchaseWords || []);

  if (actionVerb === 'click' && (hasPurchaseWords || isCheckoutContext)) {
    return {
      level: 'risky',
      variant: 'purchase',
      reason: isCheckoutContext
        ? (isCheckoutPage ? 'Action targets an active checkout or payment page.' : 'Action targets a checkout or payment form.')
        : `Element label contains purchase or order words ("${label}").`,
      actionSummary,
      elementLabel: label || undefined,
    };
  }

  if (isCheckoutContext && (actionVerb === 'type' || actionVerb === 'select_option' || action.submit || (actionVerb === 'press_key' && action.key === 'Enter'))) {
    return {
      level: 'risky',
      variant: 'purchase',
      reason: isCheckoutPage
        ? 'Modifying form fields on an active checkout page.'
        : 'Modifying form fields in a checkout or payment form.',
      actionSummary,
      elementLabel: label || undefined,
    };
  }

  // 5. RISKY: Login
  const isLoginPage = pageType === 'login';
  const isLoginForm = formKind === 'login';

  if ((isLoginPage || isLoginForm) && (actionVerb === 'click' || action.submit || actionVerb === 'press_key' && action.key === 'Enter')) {
    return {
      level: 'risky',
      variant: 'login',
      reason: isLoginPage
        ? 'Submitting an action on a login page.'
        : 'Submitting a user authentication form.',
      actionSummary,
      elementLabel: label || undefined,
    };
  }

  // 6. RISKY: Submit (delete, send, publish, subscribe, or other non-search form submit)
  const isSubmitForm = formKind === 'other' && (action.submit || (actionVerb === 'press_key' && action.key === 'Enter'));
  const hasSubmitWords = actionVerb === 'click' && containsAnyWord(label, RISK_DATA.submitWords || []);

  if (isSubmitForm || hasSubmitWords) {
    return {
      level: 'risky',
      variant: 'submit',
      reason: hasSubmitWords
        ? `Element label contains submission or destructive keywords ("${label}").`
        : 'Submitting an external web form.',
      actionSummary,
      elementLabel: label || undefined,
    };
  }

  // 7. RISKY: Form entry with personal data (email, address)
  if (actionVerb === 'type' && (fieldKind === 'email' || fieldKind === 'address')) {
    return {
      level: 'risky',
      variant: 'form',
      reason: `Typing personal data into an ${fieldKind} input field.`,
      actionSummary,
      elementLabel: label || undefined,
    };
  }

  // 8. RISKY: Navigation to unapproved external domains
  let candidateNavDomain: string | null = null;

  if (actionVerb === 'navigate' || actionVerb === 'open_window') {
    if (action.url) {
      candidateNavDomain = extractCleanHostname(action.url);
    }
  } else if (actionVerb === 'click') {
    if (elementInfo?.hrefDomain) {
      candidateNavDomain = extractCleanHostname(elementInfo.hrefDomain);
    }
  }

  if (candidateNavDomain) {
    const isApproved = isDomainApproved(candidateNavDomain, approvedDomains);
    const isSearch = isSafeSearchEngine(candidateNavDomain);

    if (!isApproved && !isSearch) {
      return {
        level: 'risky',
        variant: 'navigate',
        reason: `Navigating outside approved domains to "${candidateNavDomain}".`,
        actionSummary,
        elementLabel: label || undefined,
        targetDomain: candidateNavDomain,
      };
    }
  }

  // Also check if current page is on an unapproved domain (e.g. after a script redirect)
  if (pageUrl) {
    const currentHost = extractCleanHostname(pageUrl);
    if (currentHost && !isDomainApproved(currentHost, approvedDomains) && !isSafeSearchEngine(currentHost)) {
      if (actionVerb === 'click' || actionVerb === 'type') {
        return {
          level: 'risky',
          variant: 'navigate',
          reason: `Action on an unapproved external domain "${currentHost}".`,
          actionSummary,
          elementLabel: label || undefined,
          targetDomain: currentHost,
        };
      }
    }
  }

  // 9. SAFE: All other actions
  return {
    level: 'safe',
    reason: 'Standard browsing action.',
    actionSummary,
    elementLabel: label || undefined,
  };
}

function describeAction(action: any, elementInfo?: ElementInfo | null): string {
  const verb = action.action || 'action';
  const label = elementInfo?.label ? `"${elementInfo.label}"` : '';
  const idStr = action.element_id !== undefined ? `[${action.element_id}]` : '';

  if (verb === 'click') {
    return `Click ${label || idStr || 'element'}`.trim();
  }
  if (verb === 'type') {
    const textPreview = action.text ? `"${action.text.slice(0, 20)}"` : '';
    return `Type ${textPreview} into ${label || idStr || 'field'}`.trim();
  }
  if (verb === 'navigate') {
    return `Navigate to ${action.url || 'URL'}`;
  }
  if (verb === 'open_window') {
    return `Open window at ${action.url || 'URL'}`;
  }
  if (verb === 'scroll') {
    return `Scroll ${action.direction || 'down'}`;
  }
  return `${verb} ${label || idStr}`.trim();
}
