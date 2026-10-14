import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPriceCandidates } from '../../src/background/graph/worker.ts';

test('a German amount before its currency code is read whole, not as the last digit', () => {
  const { priceHits, priceCandidates } = extractPriceCandidates('Framework Laptop 16 ab 1.399,00 EUR inkl. MwSt.');
  assert.equal(priceHits, 1);
  assert.equal(priceCandidates[0].text, '1.399,00 EUR');
  assert.equal(priceCandidates[0].value, 1399);
  assert.equal(priceCandidates[0].currency, 'EUR');
});

test('symbol-first amounts and sentence punctuation parse to the full value', () => {
  const { priceCandidates } = extractPriceCandidates('Now € 49.99, was $1,299.00. Shipping 4,95 €.');
  assert.deepEqual(priceCandidates.map(c => c.value), [49.99, 1299, 4.95]);
});

test('no price on the page gives no candidates', () => {
  assert.deepEqual(extractPriceCandidates('Free shipping on all orders'), { priceHits: 0, priceCandidates: [] });
});
