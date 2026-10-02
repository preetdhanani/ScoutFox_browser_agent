import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePredicate, evaluateSiteCriteria } from '../../src/background/agent/criteria.ts';
import type { Finding, SiteSpec } from '../../src/background/graph/state.ts';

test('criteria: evaluatePredicate handles url_contains, text_present, and element_text_present', () => {
  const ctx = {
    url: 'https://example.com/checkout/success',
    pageText: 'Thank you for your order! Your confirmation number is 98765.',
    elementTexts: ['Order Summary', 'Print Receipt']
  };

  assert.equal(evaluatePredicate({ type: 'url_contains', value: 'success' }, ctx), true);
  assert.equal(evaluatePredicate({ type: 'url_contains', value: 'cart' }, ctx), false);

  assert.equal(evaluatePredicate({ type: 'text_present', value: 'confirmation number' }, ctx), true);
  assert.equal(evaluatePredicate({ type: 'text_present', value: 'out of stock' }, ctx), false);

  assert.equal(evaluatePredicate({ type: 'element_text_present', value: 'Print Receipt' }, ctx), true);
  assert.equal(evaluatePredicate({ type: 'element_text_present', value: 'Cancel Order' }, ctx), false);
});

test('criteria: evaluateSiteCriteria all_required verifies all mandatory fields', () => {
  const site: SiteSpec = {
    id: 's1',
    name: 'frame.work',
    domain: 'frame.work',
    goal: 'Find price and shipping',
    goalKind: 'collect',
    role: 'reference',
    kind: 'store',
    difficulty: 1,
    namedByUser: true,
    criteria: {
      fields: [
        { name: 'price', required: true },
        { name: 'shipping', required: true }
      ],
      doneWhen: 'all_required'
    }
  };

  const fPrice: Finding = {
    id: 'f1', siteId: 's1', field: 'price', value: '1.599 EUR', valueRaw: '1.599 EUR',
    url: 'https://store.com', capturedAt: '2026-10-02T12:00:00Z', docId: 'd', step: 1, pageTitle: '',
    evidence: { source: 'text', snippet: '' },
    quality: 'verified', checks: ['value_on_page', 'domain_matches', 'currency_ok', 'title_matches']
  };

  // Only price -> missing shipping -> partial
  const res1 = evaluateSiteCriteria(site, [fPrice]);
  assert.equal(res1.met, false);
  assert.equal(res1.status, 'partial');
  assert.ok(res1.reason.includes('shipping'));

  // Both price and shipping -> done
  const fShipping: Finding = { ...fPrice, id: 'f2', field: 'shipping', value: '0 EUR' };
  const res2 = evaluateSiteCriteria(site, [fPrice, fShipping]);
  assert.equal(res2.met, true);
  assert.equal(res2.status, 'done');
});

test('criteria: evaluateSiteCriteria doneWhen predicate', () => {
  const site: SiteSpec = {
    id: 's1',
    name: 'store',
    domain: 'store.com',
    goal: 'Add item to cart',
    goalKind: 'do',
    role: 'other',
    kind: 'page',
    difficulty: 1,
    namedByUser: true,
    criteria: {
      fields: [],
      doneWhen: 'predicate',
      predicate: { type: 'text_present', value: 'Added to cart' }
    }
  };

  const resMatch = evaluateSiteCriteria(site, [], { url: '', pageText: 'Item Added to cart successfully' });
  assert.equal(resMatch.met, true);
  assert.equal(resMatch.status, 'done');

  const resNoMatch = evaluateSiteCriteria(site, [], { url: '', pageText: 'Loading product...' });
  assert.equal(resNoMatch.met, false);
  assert.equal(resNoMatch.status, 'partial');
});
