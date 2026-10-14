// Risk Gate evaluation engine.
// Erasable TypeScript (no enums, no parameter properties).

import type { ElementInfo } from '../graph/workerState.ts';
import { siteOf } from './evidence.ts';
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
  /**
   * Resolves an element id against the page snapshot. Used by the browser_batch
   * recursion: model-produced batch steps never carry their own elementInfo, so
   * the caller must resolve each step's element the same way it does for the
   * top-level action, or the rules that depend on elementInfo (password fields,
   * risky labels, login/submit detection) are blind inside every batch.
   */
  resolveElementInfo?: (elementId: number) => ElementInfo | null | undefined;
  /**
   * The element that has focus, which is what press_key acts on (it has no element id). Null: nothing has focus.
   * Undefined: the snapshot did not say, so an Enter fails closed to risky.
   */
  focusedElementInfo?: ElementInfo | null;
}

/**
 * Batch steps that act on a page element. If one of these arrives without any
 * inspectable element info, the verdict fails closed to risky: a prompt-injected
 * page must not be able to slip an action past the gate by omitting context.
 */
const ELEMENT_TARGETING_VERBS = new Set(['click', 'type', 'select_option']);

/** Focus roles the content script reports when it cannot read the focused element (a frame, or an error). */
const UNREADABLE_FOCUS_ROLES = new Set(['iframe', 'unknown']);

/** Roles that Enter activates like a click when they have focus. */
const ACTIVATED_BY_ENTER_ROLES = new Set(['button', 'link', 'menuitem']);

/**
 * A link label longer than this many words is a product or article title, not a control: it opens a page. Its
 * words ("... günstig kaufen bei uns") do not make it a purchase. Buttons are never exempt.
 */
const TITLE_LINK_MIN_WORDS = 9;

/** Words that make a control commit something for the user: send, delete, register, book, donate, post. */
const SUBMIT_WORDS: string[] = [
  ...(RISK_DATA.submitWords || []),
  ...(RISK_DATA.accountWords || []),
  ...(RISK_DATA.commitWords || []),
];

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

    // Word boundary match, for phrases too: "book a" must not match "notebook ansehen".
    const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(^|[^a-z0-9äöüß])${escaped}([^a-z0-9äöüß]|$)`, 'i');
    if (regex.test(lower)) return true;
  }
  return false;
}

/**
 * Whether one of the labels is exactly one of the words, ignoring case, spacing and decoration around it
 * ("Confirm ›"). For words that are a control only when they are the whole label: "Book" but not "E-Book Reader",
 * "Confirm" but not "Confirm my choices".
 */
function isExactlyAnyWord(labels: string[], words: string[]): boolean {
  const wanted = new Set(words.map((w) => w.toLowerCase().trim()).filter(Boolean));
  return labels.some((l) => {
    const core = l.toLowerCase().replace(/^[^a-z0-9äöüß]+|[^a-z0-9äöüß]+$/g, '').replace(/\s+/g, ' ');
    return wanted.has(core);
  });
}

/** Whether the form host is another site than the page (no page URL: it cannot be shown to be the same). */
function isCrossSiteForm(formActionHost: string | undefined, pageUrl: string): boolean {
  if (!formActionHost) return false;
  const pageSite = siteOf(pageUrl);
  return !pageSite || siteOf(`https://${formActionHost}`) !== pageSite;
}

/**
 * Evaluates the risk of a proposed action according to ScoutFox Risk Gate rules.
 */
export function evaluateActionRisk(input: RiskEvaluationInput): ActionRiskVerdict {
  const { action, pageType, pageUrl = '', approvedDomains = [], resolveElementInfo, focusedElementInfo } = input;
  const actionVerb = action.action;
  const isEnter = actionVerb === 'press_key' && action.key === 'Enter';

  // press_key has no element id: Enter acts on whatever has focus, so the gate judges that element.
  const elementInfo = input.elementInfo ?? (isEnter ? focusedElementInfo : null);
  const actionSummary = describeAction(action, elementInfo);

  // Fail closed: an Enter whose target cannot be known may submit any form on the page.
  if (isEnter && !input.elementInfo && (focusedElementInfo === undefined || UNREADABLE_FOCUS_ROLES.has(focusedElementInfo?.role ?? ''))) {
    return {
      level: 'risky',
      variant: 'submit',
      reason: 'Pressing Enter where the risk gate cannot tell which element has focus; it may submit a form.',
      actionSummary,
    };
  }

  const label = (elementInfo?.label || '').trim();
  // The gate reads the fuller gate label (visible text plus accessible name) when the content script set one.
  const gateLabel = (elementInfo?.gateLabel || label).trim();
  const gateParts = [label, ...gateLabel.split(' | ')].filter(Boolean);
  const fieldKind = elementInfo?.fieldKind;
  const crossSiteForm = isCrossSiteForm(elementInfo?.formActionHost, pageUrl);
  // A "search" form that sends to another site is a generic form: the search exemption is for the site's own search.
  const formKind = elementInfo?.formKind === 'search' && crossSiteForm ? 'other' : elementInfo?.formKind;

  // A click, or Enter on a focused button or link, activates the control.
  const activates = actionVerb === 'click' || (isEnter && !!elementInfo && (
    !!elementInfo.submitControl || ACTIVATED_BY_ENTER_ROLES.has(elementInfo.role)
  ));
  // A long link label is a title (a product, an article), not a control: its words do not gate it.
  const isTitleLink = elementInfo?.role === 'link' && !elementInfo.submitControl &&
    gateLabel.split(/\s+/).filter(Boolean).length >= TITLE_LINK_MIN_WORDS;
  const wordsApply = activates && !isTitleLink;

  // execute_js runs arbitrary page code: risky
  if (actionVerb === 'execute_js') {
    return {
      level: 'risky',
      variant: 'form',
      reason: 'Executing arbitrary JavaScript code on the page.',
      actionSummary,
    };
  }

  // browser_batch evaluates each step: most severe step decides
  if (actionVerb === 'browser_batch') {
    const steps = Array.isArray(action.steps) ? action.steps : [];
    if (steps.length === 0) {
      return {
        level: 'safe',
        reason: 'Empty batch.',
        actionSummary,
      };
    }

    let worstVerdict: ActionRiskVerdict = {
      level: 'safe',
      reason: 'Standard batch action.',
      actionSummary,
    };

    // What has focus as the batch runs: a step that types into or clicks an element moves focus there, and a later
    // press_key acts on that element, not on what had focus when the page was read.
    let focus: ElementInfo | null | undefined = focusedElementInfo;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const stepVerb = typeof step?.action === 'string' ? step.action : '';

      // A model-produced batch step never carries its own elementInfo (the step
      // schema does not define it), so resolve the step's element from the page
      // snapshot exactly like the top-level action. Without this, every rule
      // that depends on elementInfo sees null inside a batch and returns safe.
      let stepInfo: ElementInfo | null = step?.elementInfo ?? null;
      if (!stepInfo && typeof step?.element_id === 'number' && resolveElementInfo) {
        stepInfo = resolveElementInfo(step.element_id) ?? null;
      }

      // Fail closed: an element-targeting step whose element cannot be inspected
      // (unknown or stale id, or no resolver) must not classify as safe, or a
      // prompt-injected page could evade the gate by omitting the context.
      if (!stepInfo && ELEMENT_TARGETING_VERBS.has(stepVerb)) {
        const uninspectable: ActionRiskVerdict = {
          level: 'risky',
          variant: 'form',
          reason: `Batch step ${i + 1} targets an element the risk gate cannot inspect (${stepVerb || 'unknown action'}); the step needs confirmation.`,
          actionSummary,
        };
        if (worstVerdict.level !== 'risky') {
          worstVerdict = uninspectable;
        }
        focus = undefined;
        continue;
      }

      const stepVerdict = evaluateActionRisk({
        action: step,
        elementInfo: stepInfo,
        pageType,
        pageUrl,
        approvedDomains,
        resolveElementInfo,
        focusedElementInfo: focus,
      });
      if (stepInfo && (stepVerb === 'type' || stepVerb === 'click')) focus = stepInfo;

      if (stepVerdict.level === 'forbidden') {
        return {
          ...stepVerdict,
          actionSummary,
          reason: `Batch step ${i + 1} forbidden: ${stepVerdict.reason}`,
        };
      }

      if (stepVerdict.level === 'risky' && worstVerdict.level !== 'risky') {
        worstVerdict = {
          ...stepVerdict,
          actionSummary,
          reason: `Batch step ${i + 1} risky: ${stepVerdict.reason}`,
        };
      }
    }

    return worstVerdict;
  }

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
    containsAnyWord(gateLabel, ['in den warenkorb', 'add to cart', 'in shopping cart', 'zum warenkorb hinzufügen']) &&
    !containsAnyWord(gateLabel, ['kasse', 'checkout', 'jetzt kaufen', 'buy now']);

  if (isAddToCart) {
    return {
      level: 'safe',
      reason: 'Add-to-cart actions are safe browsing operations.',
      actionSummary,
      elementLabel: label || undefined,
    };
  }

  const hasPurchaseWords = wordsApply && containsAnyWord(gateLabel, RISK_DATA.purchaseWords || []);

  // 3. SAFE EXEMPTION: the site's own search box with submit is safe. Not a cross-site form (formKind is 'other'
  // then), and not a purchase control that only sits inside a form whose class or id says "search".
  if ((formKind === 'search' || (fieldKind === 'search' && !crossSiteForm)) && !hasPurchaseWords) {
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

  if (activates && (hasPurchaseWords || isCheckoutContext)) {
    return {
      level: 'risky',
      variant: 'purchase',
      reason: isCheckoutContext
        ? (isCheckoutPage ? 'Action targets an active checkout or payment page.' : 'Action targets a checkout or payment form.')
        : `Element label contains purchase or order words ("${gateLabel}").`,
      actionSummary,
      elementLabel: label || undefined,
    };
  }

  if (isCheckoutContext && (actionVerb === 'type' || actionVerb === 'select_option' || action.submit || isEnter)) {
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

  if ((isLoginPage || isLoginForm) && (actionVerb === 'click' || action.submit || isEnter)) {
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

  // 6. RISKY: Submit (delete, send, register, book, donate, post, or any other non-search form submit). A click on
  // the form's submit control submits it like Enter does. An explicit method="get" form on the same site only builds
  // a URL (filters, sorting), so it is not a submit.
  const submitsForm = action.submit || isEnter || (actionVerb === 'click' && !!elementInfo?.submitControl);
  const isGetForm = elementInfo?.formMethod === 'get' && !crossSiteForm;
  const isSubmitForm = formKind === 'other' && submitsForm && !isGetForm;
  const hasSubmitWords = wordsApply && (
    containsAnyWord(gateLabel, SUBMIT_WORDS) || isExactlyAnyWord(gateParts, RISK_DATA.exactLabelWords || [])
  );

  if (isSubmitForm || hasSubmitWords) {
    return {
      level: 'risky',
      variant: 'submit',
      reason: hasSubmitWords
        ? `Element label contains submission, account or commitment keywords ("${gateLabel}").`
        : crossSiteForm
          ? `Submitting a web form that sends to another site ("${elementInfo?.formActionHost}").`
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
  } else if (activates) {
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
  if (verb === 'execute_js') {
    return 'Execute JS';
  }
  if (verb === 'browser_batch') {
    const count = Array.isArray(action.steps) ? action.steps.length : 0;
    return `Batch (${count} steps)`;
  }
  return `${verb} ${label || idStr}`.trim();
}
