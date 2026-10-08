import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractCleanHostname,
  isDomainApproved,
  isSafeSearchEngine,
  evaluateActionRisk,
} from '../../src/background/agent/risk.ts';

test('risk: extractCleanHostname normalizes URLs and strips userinfo/ports', () => {
  assert.equal(extractCleanHostname('https://shop.example.com/checkout'), 'shop.example.com');
  assert.equal(extractCleanHostname('http://shop.example.com:8080/cart'), 'shop.example.com');
  assert.equal(extractCleanHostname('https://user:password@evil.com/login'), 'evil.com');
  assert.equal(extractCleanHostname('HTTPS://IDEALO.DE/PRODUKT'), 'idealo.de');
  assert.equal(extractCleanHostname('geizhals.de.'), 'geizhals.de');
  assert.equal(extractCleanHostname(''), null);
  assert.equal(extractCleanHostname(null as any), null);
});

test('risk: isDomainApproved checks exact and subdomain matches', () => {
  const approved = ['example.com', 'shop.de'];
  assert.equal(isDomainApproved('example.com', approved), true);
  assert.equal(isDomainApproved('sub.example.com', approved), true);
  assert.equal(isDomainApproved('nested.sub.example.com', approved), true);
  assert.equal(isDomainApproved('shop.de', approved), true);

  assert.equal(isDomainApproved('notexample.com', approved), false);
  assert.equal(isDomainApproved('evil-example.com', approved), false);
  assert.equal(isDomainApproved('example.com.evil.com', approved), false);
});

test('risk: isSafeSearchEngine identifies safe ladder engines', () => {
  assert.equal(isSafeSearchEngine('google.com'), true);
  assert.equal(isSafeSearchEngine('www.google.de'), true);
  assert.equal(isSafeSearchEngine('duckduckgo.com'), true);
  assert.equal(isSafeSearchEngine('evilgoogle.com'), false);
});

test('risk: Forbidden credentials and OTP fields', () => {
  const passwordVerdict = evaluateActionRisk({
    action: { action: 'type', element_id: 1, text: 'secret123' },
    elementInfo: { role: 'textbox', label: 'Password', fieldKind: 'password' },
  });
  assert.equal(passwordVerdict.level, 'forbidden');
  assert.match(passwordVerdict.reason, /sensitive fields/i);

  const ccVerdict = evaluateActionRisk({
    action: { action: 'type', element_id: 2, text: '123' },
    elementInfo: { role: 'textbox', label: 'CVV', fieldKind: 'cc' },
  });
  assert.equal(ccVerdict.level, 'forbidden');

  const otpVerdict = evaluateActionRisk({
    action: { action: 'type', element_id: 3, text: '654321' },
    elementInfo: { role: 'textbox', label: 'SMS Code', fieldKind: 'otp' },
  });
  assert.equal(otpVerdict.level, 'forbidden');
});

test('risk: Add to cart is safe', () => {
  const germanCart = evaluateActionRisk({
    action: { action: 'click', element_id: 5 },
    elementInfo: { role: 'button', label: 'In den Warenkorb' },
  });
  assert.equal(germanCart.level, 'safe');

  const englishCart = evaluateActionRisk({
    action: { action: 'click', element_id: 6 },
    elementInfo: { role: 'button', label: 'Add to Cart' },
  });
  assert.equal(englishCart.level, 'safe');
});

test('risk: Search box with submit is safe', () => {
  const searchVerdict = evaluateActionRisk({
    action: { action: 'type', element_id: 7, text: 'laptop', submit: true },
    elementInfo: { role: 'searchbox', label: 'Suche', formKind: 'search', fieldKind: 'search' },
  });
  assert.equal(searchVerdict.level, 'safe');
});

test('risk: Purchase actions in German and English are risky', () => {
  const germanBuy = evaluateActionRisk({
    action: { action: 'click', element_id: 8 },
    elementInfo: { role: 'button', label: 'Jetzt kaufen' },
  });
  assert.equal(germanBuy.level, 'risky');
  assert.equal(germanBuy.variant, 'purchase');

  const germanKasse = evaluateActionRisk({
    action: { action: 'click', element_id: 9 },
    elementInfo: { role: 'button', label: 'Zur Kasse gehen' },
  });
  assert.equal(germanKasse.level, 'risky');
  assert.equal(germanKasse.variant, 'purchase');

  const englishCheckout = evaluateActionRisk({
    action: { action: 'click', element_id: 10 },
    elementInfo: { role: 'button', label: 'Proceed to Checkout' },
  });
  assert.equal(englishCheckout.level, 'risky');
  assert.equal(englishCheckout.variant, 'purchase');

  // Any click on checkout page
  const pageCheckout = evaluateActionRisk({
    action: { action: 'click', element_id: 11 },
    elementInfo: { role: 'button', label: 'Continue' },
    pageType: 'checkout',
  });
  assert.equal(pageCheckout.level, 'risky');
  assert.equal(pageCheckout.variant, 'purchase');

  // Any click in checkout form on non-checkout page
  const formCheckout = evaluateActionRisk({
    action: { action: 'click', element_id: 11 },
    elementInfo: { role: 'button', label: 'Continue', formKind: 'checkout' },
    pageType: 'store',
  });
  assert.equal(formCheckout.level, 'risky');
  assert.equal(formCheckout.variant, 'purchase');
});

test('risk: Login form submission is risky', () => {
  const loginVerdict = evaluateActionRisk({
    action: { action: 'click', element_id: 12 },
    elementInfo: { role: 'button', label: 'Anmelden', formKind: 'login' },
  });
  assert.equal(loginVerdict.level, 'risky');
  assert.equal(loginVerdict.variant, 'login');

  const loginPageVerdict = evaluateActionRisk({
    action: { action: 'click', element_id: 13 },
    elementInfo: { role: 'button', label: 'Submit' },
    pageType: 'login',
  });
  assert.equal(loginPageVerdict.level, 'risky');
  assert.equal(loginPageVerdict.variant, 'login');
});

test('risk: Form submission and destructive actions are risky', () => {
  const deleteBtn = evaluateActionRisk({
    action: { action: 'click', element_id: 14 },
    elementInfo: { role: 'button', label: 'Konto löschen' },
  });
  assert.equal(deleteBtn.level, 'risky');
  assert.equal(deleteBtn.variant, 'submit');

  const subscribeBtn = evaluateActionRisk({
    action: { action: 'click', element_id: 15 },
    elementInfo: { role: 'button', label: 'Newsletter abonnieren' },
  });
  assert.equal(subscribeBtn.level, 'risky');
  assert.equal(subscribeBtn.variant, 'submit');

  const otherFormSubmit = evaluateActionRisk({
    action: { action: 'type', element_id: 16, text: 'Hello', submit: true },
    elementInfo: { role: 'textbox', label: 'Feedback', formKind: 'other' },
  });
  assert.equal(otherFormSubmit.level, 'risky');
  assert.equal(otherFormSubmit.variant, 'submit');
});

test('risk: Personal data typing is risky', () => {
  const emailVerdict = evaluateActionRisk({
    action: { action: 'type', element_id: 17, text: 'user@example.com' },
    elementInfo: { role: 'textbox', label: 'E-Mail', fieldKind: 'email' },
  });
  assert.equal(emailVerdict.level, 'risky');
  assert.equal(emailVerdict.variant, 'form');

  const addressVerdict = evaluateActionRisk({
    action: { action: 'type', element_id: 18, text: 'Main Street 1' },
    elementInfo: { role: 'textbox', label: 'Lieferadresse', fieldKind: 'address' },
  });
  assert.equal(addressVerdict.level, 'risky');
  assert.equal(addressVerdict.variant, 'form');
});

test('risk: Unapproved external navigation is risky with targetDomain', () => {
  const approved = ['idealo.de'];

  // Idealo outlink ("Zum Shop" pointing to external merchant)
  const outlinkVerdict = evaluateActionRisk({
    action: { action: 'click', element_id: 19 },
    elementInfo: { role: 'link', label: 'Zum Shop', hrefDomain: 'notebooksbilliger.de' },
    approvedDomains: approved,
  });
  assert.equal(outlinkVerdict.level, 'risky');
  assert.equal(outlinkVerdict.variant, 'navigate');
  assert.equal(outlinkVerdict.targetDomain, 'notebooksbilliger.de');

  // Direct navigation to external site
  const navVerdict = evaluateActionRisk({
    action: { action: 'navigate', url: 'https://cyberport.de/laptops' },
    approvedDomains: approved,
  });
  assert.equal(navVerdict.level, 'risky');
  assert.equal(navVerdict.variant, 'navigate');
  assert.equal(navVerdict.targetDomain, 'cyberport.de');

  // Navigation to approved domain is safe
  const approvedNav = evaluateActionRisk({
    action: { action: 'navigate', url: 'https://idealo.de/preisvergleich' },
    approvedDomains: approved,
  });
  assert.equal(approvedNav.level, 'safe');

  // Navigation to search engine ladder is safe
  const searchNav = evaluateActionRisk({
    action: { action: 'navigate', url: 'https://www.google.de/search?q=framework' },
    approvedDomains: approved,
  });
  assert.equal(searchNav.level, 'safe');
});
