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

test('risk: browser_batch resolves each step element from the page snapshot (BUG-19)', () => {
  // A single type into a password field is forbidden; the identical step inside a
  // batch must be forbidden too, not silently safe.
  const passwordBatch = evaluateActionRisk({
    action: {
      action: 'browser_batch',
      steps: [
        { action: 'type', element_id: 3, text: 'hunter2' },
        { action: 'wait', amount: 2 },
      ],
    },
    resolveElementInfo: (id) =>
      id === 3 ? { role: 'textbox', label: 'Passwort', fieldKind: 'password' } : null,
  });
  assert.equal(passwordBatch.level, 'forbidden');
  assert.match(passwordBatch.reason, /Batch step 1 forbidden/i);

  // A click labeled like a destructive submit is risky; same inside a batch.
  const deleteBatch = evaluateActionRisk({
    action: {
      action: 'browser_batch',
      steps: [{ action: 'click', element_id: 7 }],
    },
    resolveElementInfo: (id) =>
      id === 7 ? { role: 'button', label: 'Konto löschen' } : null,
  });
  assert.equal(deleteBatch.level, 'risky');
  assert.match(deleteBatch.reason, /Batch step 1 risky/i);

  // A benign batch stays safe when every step resolves.
  const benignBatch = evaluateActionRisk({
    action: {
      action: 'browser_batch',
      steps: [
        { action: 'type', element_id: 8, text: 'laptop' },
        { action: 'click', element_id: 9 },
      ],
    },
    resolveElementInfo: (id) =>
      id === 8
        ? { role: 'searchbox', label: 'Suche', formKind: 'search', fieldKind: 'search' }
        : id === 9
          ? { role: 'button', label: 'Sortieren' }
          : null,
  });
  assert.equal(benignBatch.level, 'safe');
});

test('risk: browser_batch fails closed on uninspectable element steps (BUG-19)', () => {
  // A stale/unknown element id cannot be inspected; the step must not pass as safe.
  const unknownId = evaluateActionRisk({
    action: {
      action: 'browser_batch',
      steps: [{ action: 'click', element_id: 99 }],
    },
    resolveElementInfo: () => null,
  });
  assert.equal(unknownId.level, 'risky');
  assert.match(unknownId.reason, /cannot inspect/i);

  // A click step without any element id is also uninspectable -> risky.
  const missingId = evaluateActionRisk({
    action: {
      action: 'browser_batch',
      steps: [{ action: 'click' }],
    },
  });
  assert.equal(missingId.level, 'risky');

  // Non-element steps (wait, scroll, press_key without element semantics) stay safe.
  const nonElementSteps = evaluateActionRisk({
    action: {
      action: 'browser_batch',
      steps: [
        { action: 'wait', amount: 2 },
        { action: 'scroll', direction: 'down' },
      ],
    },
  });
  assert.equal(nonElementSteps.level, 'safe');
});

// ---------------------------------------------------------------------------------------------
// safety/risk-gate-coverage-holes: controls the gate could not see or did not know
// ---------------------------------------------------------------------------------------------

const click = (info: any, extra: Record<string, unknown> = {}) =>
  evaluateActionRisk({ action: { action: 'click', element_id: 1 }, elementInfo: info, pageUrl: 'https://shop.de/p/1', approvedDomains: ['shop.de'], ...extra });

test('risk: an input submit whose only label is its value is judged by that value', () => {
  // perception.ts gives the model-facing label "element" here; the gate label carries the value.
  const buy = click({ role: 'button', label: 'element', gateLabel: 'Buy now' });
  assert.equal(buy.level, 'risky');
  assert.equal(buy.variant, 'purchase');

  const order = click({ role: 'button', label: 'element', gateLabel: 'Kostenpflichtig bestellen' });
  assert.equal(order.level, 'risky');
  assert.equal(order.variant, 'purchase');

  // An icon-only button named by its title or image alt.
  const icon = click({ role: 'button', label: 'element', gateLabel: 'Konto erstellen' });
  assert.equal(icon.level, 'risky');
  assert.equal(icon.variant, 'submit');
});

test('risk: a click on the submit control of a generic form is risky, a plain button in it is not', () => {
  const submit = click({ role: 'button', label: 'Weiter', formKind: 'other', submitControl: true });
  assert.equal(submit.level, 'risky');
  assert.equal(submit.variant, 'submit');
  assert.match(submit.reason, /submit/i);

  // type="button" controls in the same form (quantity steppers, tabs) do not submit it.
  const stepper = click({ role: 'button', label: '+', formKind: 'other' });
  assert.equal(stepper.level, 'safe');

  // An explicit method="get" form on the same site only builds a URL (filters, sorting): no card.
  const filter = click({ role: 'button', label: 'Filter anwenden', formKind: 'other', submitControl: true, formMethod: 'get' });
  assert.equal(filter.level, 'safe');

  // ...but a GET form that sends to another site is not exempt.
  const crossGet = click({ role: 'button', label: 'Go', formKind: 'other', submitControl: true, formMethod: 'get', formActionHost: 'tracker.example' });
  assert.equal(crossGet.level, 'risky');

  // Add to cart stays the explicit safe exemption even as a form's submit button.
  const cart = click({ role: 'button', label: 'In den Warenkorb', formKind: 'other', submitControl: true });
  assert.equal(cart.level, 'safe');
});

test('risk: press_key Enter is judged against the focused element', () => {
  const enter = (focusedElementInfo: any) =>
    evaluateActionRisk({ action: { action: 'press_key', key: 'Enter' }, focusedElementInfo, pageUrl: 'https://shop.de/kontakt', approvedDomains: ['shop.de'] });

  const contact = enter({ role: 'textbox', label: 'Nachricht', formKind: 'other', fieldKind: 'text' });
  assert.equal(contact.level, 'risky');
  assert.equal(contact.variant, 'submit');

  const login = enter({ role: 'textbox', label: 'E-Mail', formKind: 'login', fieldKind: 'email' });
  assert.equal(login.level, 'risky');
  assert.equal(login.variant, 'login');

  const checkout = enter({ role: 'textbox', label: 'Gutscheincode', formKind: 'checkout', fieldKind: 'text' });
  assert.equal(checkout.level, 'risky');
  assert.equal(checkout.variant, 'purchase');

  // Enter on a focused "Jetzt kaufen" button activates it like a click.
  const buyButton = enter({ role: 'button', label: 'Jetzt kaufen' });
  assert.equal(buyButton.level, 'risky');
  assert.equal(buyButton.variant, 'purchase');

  // A search box, a field outside any form and an empty focus stay safe.
  assert.equal(enter({ role: 'searchbox', label: 'Suche', formKind: 'search', fieldKind: 'search' }).level, 'safe');
  assert.equal(enter({ role: 'textbox', label: 'Menge', fieldKind: 'text' }).level, 'safe');
  assert.equal(enter(null).level, 'safe');

  // Fail closed: when the snapshot did not say what has focus, Enter needs a card.
  const unknown = enter(undefined);
  assert.equal(unknown.level, 'risky');
  assert.match(unknown.reason, /focus/i);

  // Other keys never submit.
  const escape = evaluateActionRisk({ action: { action: 'press_key', key: 'Escape' } });
  assert.equal(escape.level, 'safe');
});

test('risk: press_key Enter inside a batch is judged against the element the batch just typed into', () => {
  const resolve = (id: number): any =>
    id === 4 ? { role: 'textbox', label: 'Name', formKind: 'other', fieldKind: 'text' }
      : id === 5 ? { role: 'searchbox', label: 'Suche', formKind: 'search', fieldKind: 'search' }
        : null;

  const contactBatch = evaluateActionRisk({
    action: { action: 'browser_batch', steps: [{ action: 'type', element_id: 4, text: 'Max' }, { action: 'press_key', key: 'Enter' }] },
    resolveElementInfo: resolve,
    focusedElementInfo: null,
    pageUrl: 'https://shop.de/kontakt',
    approvedDomains: ['shop.de'],
  });
  assert.equal(contactBatch.level, 'risky');
  assert.match(contactBatch.reason, /Batch step 2 risky/);

  const searchBatch = evaluateActionRisk({
    action: { action: 'browser_batch', steps: [{ action: 'type', element_id: 5, text: 'laptop' }, { action: 'press_key', key: 'Enter' }] },
    resolveElementInfo: resolve,
    focusedElementInfo: null,
    pageUrl: 'https://shop.de/',
    approvedDomains: ['shop.de'],
  });
  assert.equal(searchBatch.level, 'safe');
});

test('risk: sign-up, account, booking, confirm, apply, donate and post controls are risky in English and German', () => {
  const risky = [
    'Sign up', 'Sign up for free', 'Register', 'Create account', 'Create an account', 'Join now', 'Join',
    'Registrieren', 'Jetzt registrieren', 'Konto erstellen', 'Kundenkonto anlegen', 'Mitglied werden',
    'Book now', 'Book', 'Jetzt buchen', 'Termin buchen', 'Reserve', 'Reserve a table', 'Reservieren', 'Jetzt reservieren',
    'Confirm', 'Confirm booking', 'Bestätigen', 'Buchung bestätigen',
    'Apply now', 'Apply for this job', 'Jetzt bewerben', 'Bewerbung absenden',
    'Donate', 'Donate now', 'Spenden', 'Jetzt spenden',
    'Post', 'Post comment', 'Kommentar posten', 'Bewertung abschicken',
    'Submit', 'Absenden',
  ];
  for (const label of risky) {
    const verdict = click({ role: 'button', label });
    assert.equal(verdict.level, 'risky', `"${label}" must need a card`);
    assert.equal(verdict.variant, 'submit', `"${label}" is a submit card`);
  }

  // The purchase wording German shops use.
  for (const label of ['Jetzt kaufen', 'Zur Kasse', 'Kostenpflichtig bestellen', 'Zahlungspflichtig bestellen', 'Kauf abschließen', 'Complete purchase']) {
    const verdict = click({ role: 'button', label });
    assert.equal(verdict.level, 'risky', `"${label}" must need a card`);
    assert.equal(verdict.variant, 'purchase', `"${label}" is a purchase card`);
  }
});

test('risk: everyday shop controls stay free of cards (false positives)', () => {
  const safe = [
    'Add to wishlist', 'Auf den Merkzettel', 'Merken', 'Compare', 'Vergleichen', 'Read more', 'Weiter lesen', 'Mehr erfahren',
    // A bare "Apply" is how filter panels close; job applications say "Apply now" or "Apply for".
    'Apply', 'Apply filters', 'Filter anwenden', 'Gutschein einlösen', 'Auswahl bestätigen', 'Confirm my choices', 'Alle akzeptieren',
    'E-Book Reader', 'Notebooks', 'Bookmark', 'Facebook', 'Registrierung', 'Reservierung ansehen', 'DHL Post Versand',
    'Spendenquittung herunterladen', 'Jobs & Karriere', 'Next', 'Weiter',
  ];
  for (const label of safe) {
    const verdict = click({ role: 'button', label });
    assert.equal(verdict.level, 'safe', `"${label}" must not need a card (${verdict.reason})`);
  }

  // A long product title link that happens to contain "buy" or "kaufen" opens the product page.
  for (const label of [
    'Framework Laptop 13 DIY Edition - best notebook to buy for students 2026',
    'Lenovo ThinkPad X1 Carbon Gen 12 günstig kaufen bei uns im Shop',
  ]) {
    const verdict = click({ role: 'link', label });
    assert.equal(verdict.level, 'safe', `product link "${label}" must not need a card`);
  }
  // A short link or any button with the same word is still a purchase control.
  assert.equal(click({ role: 'link', label: 'Jetzt kaufen' }).level, 'risky');
  assert.equal(click({ role: 'button', label: 'Lenovo ThinkPad X1 Carbon Gen 12 günstig kaufen bei uns im Shop' }).level, 'risky');
});

test('risk: the search exemption needs a same-site form and no purchase wording', () => {
  // A Buy button inside a form whose class says "search" is still a purchase.
  const buyInSearch = click({ role: 'button', label: 'Buy now', formKind: 'search', submitControl: true });
  assert.equal(buyInSearch.level, 'risky');
  assert.equal(buyInSearch.variant, 'purchase');

  // Same-site search form: typing and submitting stays safe.
  const sameSite = evaluateActionRisk({
    action: { action: 'type', element_id: 2, text: 'laptop', submit: true },
    elementInfo: { role: 'searchbox', label: 'Suche', formKind: 'search', fieldKind: 'search', formActionHost: 'suche.shop.de' },
    pageUrl: 'https://www.shop.de/',
    approvedDomains: ['shop.de'],
  });
  assert.equal(sameSite.level, 'safe');

  // A "search" form that posts to another host is a generic form submit.
  const crossHost = evaluateActionRisk({
    action: { action: 'type', element_id: 2, text: 'max@example.com', submit: true },
    elementInfo: { role: 'textbox', label: 'Search', formKind: 'search', fieldKind: 'text', formActionHost: 'collect.evil.example' },
    pageUrl: 'https://www.shop.de/',
    approvedDomains: ['shop.de'],
  });
  assert.equal(crossHost.level, 'risky');
  assert.equal(crossHost.variant, 'submit');

  // The search form's own submit button on the same site is safe.
  const searchButton = click({ role: 'button', label: 'Suchen', formKind: 'search', submitControl: true });
  assert.equal(searchButton.level, 'safe');
});

test('risk: an unknown verb keeps the default-safe fallback, because sanitize rejects it first', async () => {
  const { sanitizeAction } = await import('../../src/background/agent/sanitize.ts');
  const sanitized = sanitizeAction({ action: 'buy_item', element_id: 1 }, { verbs: ['click', 'type'] } as any);
  assert.equal(sanitized.invalidAction, 'buy_item', 'an unoffered verb never reaches the gate');
  assert.equal(evaluateActionRisk({ action: { action: 'buy_item', element_id: 1 }, elementInfo: { role: 'button', label: 'Weiter' } }).level, 'safe');
});
