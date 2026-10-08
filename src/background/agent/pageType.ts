// src/background/agent/pageType.ts
// Heuristic classification of webpage types for LangGraph perception.
// Erasable TypeScript (no enums, no parameter properties).

import type { PageType, PageVerdict } from '../graph/state.ts';
import type { ElementInfo } from '../graph/workerState.ts';

export interface PageTypeInput {
  verdict?: PageVerdict | null;
  url: string;
  title: string;
  elementInfo?: Record<string, ElementInfo>;
  priceHits?: number;
  elementCount?: number;
  hasConsentDialog?: boolean;
}

const CHECKOUT_WORDS = /\b(?:checkout|kasse|zahlung|payment|bestellen)\b/i;
const CART_WORDS = /\b(?:cart|warenkorb|basket|bag)\b/i;
const SEARCH_PARAMS = /(?:[?&](?:q|query|search|k|suche)=|\/search\b|\/suche\b)/i;
const ADD_TO_CART_WORDS = /\b(?:in den warenkorb|add to cart|warenkorb|buy now|in the basket)\b/i;

/**
 * Classifies the current webpage into one of the 10 PageType categories:
 * 'listing' | 'product' | 'search' | 'login' | 'checkout' | 'cart' | 'error' | 'challenge' | 'cookie_wall' | 'other'
 */
export function classifyPageType(input: PageTypeInput): PageType {
  const { verdict, url = '', title = '', elementInfo = {}, priceHits = 0, elementCount = 0, hasConsentDialog = false } = input;

  // 1. Verdict check
  if (verdict === 'challenge') return 'challenge';
  if (verdict === 'error_page') return 'error';

  // 2. Cookie wall
  if (hasConsentDialog && elementCount <= 15) {
    return 'cookie_wall';
  }

  const elements = Object.values(elementInfo);

  // 3. Login
  const hasPasswordField = elements.some((e) => e.fieldKind === 'password' || e.role === 'password');
  const hasLoginForm = elements.some((e) => e.formKind === 'login');
  if (hasPasswordField || hasLoginForm || /\b(?:login|sign in|anmelden|einloggen)\b/i.test(title)) {
    if (hasPasswordField || hasLoginForm) return 'login';
  }

  // 4. Checkout
  const hasCheckoutForm = elements.some((e) => e.formKind === 'checkout');
  if (hasCheckoutForm || CHECKOUT_WORDS.test(url) || CHECKOUT_WORDS.test(title)) {
    return 'checkout';
  }

  // 5. Cart
  if (CART_WORDS.test(url) || CART_WORDS.test(title)) {
    return 'cart';
  }

  // 6. Search
  if (SEARCH_PARAMS.test(url) || (/\b(?:search|suche)\b/i.test(title) && priceHits === 0)) {
    return 'search';
  }

  // 7. Listing (4 or more price elements)
  if (priceHits >= 4) {
    return 'listing';
  }

  // 8. Product (main price with add to cart button)
  const hasAddToCart = elements.some((e) => ADD_TO_CART_WORDS.test(e.label || ''));
  if (priceHits >= 1 && (hasAddToCart || /\b(?:product|item|artikel|details)\b/i.test(url))) {
    return 'product';
  }

  // 9. Default
  return 'other';
}
