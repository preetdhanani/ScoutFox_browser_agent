import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPageType } from '../../src/background/agent/pageType.ts';

test('pageType: verdict maps directly to challenge and error', () => {
  assert.equal(classifyPageType({ verdict: 'challenge', url: 'https://example.com', title: 'Example' }), 'challenge');
  assert.equal(classifyPageType({ verdict: 'error_page', url: 'https://example.com', title: 'Example' }), 'error');
});

test('pageType: detects cookie_wall when consent covers page with few elements', () => {
  assert.equal(
    classifyPageType({
      url: 'https://example.com',
      title: 'Consent',
      hasConsentDialog: true,
      elementCount: 10
    }),
    'cookie_wall'
  );
});

test('pageType: detects login from password field or form', () => {
  assert.equal(
    classifyPageType({
      url: 'https://example.com/login',
      title: 'Sign in to your account',
      elementInfo: {
        e1: { role: 'textbox', label: 'Email', fieldKind: 'email' },
        e2: { role: 'textbox', label: 'Password', fieldKind: 'password' }
      }
    }),
    'login'
  );
});

test('pageType: detects checkout and cart from URL and title', () => {
  assert.equal(
    classifyPageType({
      url: 'https://store.example.com/checkout/step1',
      title: 'Kasse - Bestellen'
    }),
    'checkout'
  );

  assert.equal(
    classifyPageType({
      url: 'https://store.example.com/cart',
      title: 'Your Shopping Basket'
    }),
    'cart'
  );
});

test('pageType: detects search query parameters', () => {
  assert.equal(
    classifyPageType({
      url: 'https://search.example.com/?q=framework+laptop+16',
      title: 'Search results'
    }),
    'search'
  );
});

test('pageType: detects listing with 4+ price hits', () => {
  assert.equal(
    classifyPageType({
      url: 'https://idealo.de/category',
      title: 'Laptops im Vergleich',
      priceHits: 6
    }),
    'listing'
  );
});

test('pageType: detects product with price and add to cart button', () => {
  assert.equal(
    classifyPageType({
      url: 'https://shop.example.com/item/12345',
      title: 'Framework Laptop 16 DIY',
      priceHits: 1,
      elementInfo: {
        e1: { role: 'button', label: 'In den Warenkorb' }
      }
    }),
    'product'
  );
});

test('pageType: falls back to other', () => {
  assert.equal(
    classifyPageType({
      url: 'https://example.com/about',
      title: 'About Us'
    }),
    'other'
  );
});
