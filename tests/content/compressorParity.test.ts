import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMCompressor } from '../../src/content/domCompressor.ts';
import { collapseRepeatedRuns, capPageText } from '../../src/content/pageText.ts';
import { withGlobals } from '../helpers/contentGlobals.ts';

test('DOMCompressor produces correct snapshot keys and elements list', () => {
  const fakeDoc = {
    title: 'Test Store',
    contentType: 'text/html',
    documentElement: { scrollHeight: 1200 },
    querySelectorAll: () => [],
    querySelector: () => null,
    getElementById: () => null,
    contains: () => true
  };
  const fakeWin = {
    location: { href: 'https://store.example.com/item', hostname: 'store.example.com' },
    scrollY: 100,
    innerHeight: 800,
    innerWidth: 1024
  };

  const compressor = new DOMCompressor();
  const snapshot = withGlobals({ document: fakeDoc, window: fakeWin }, () => compressor.getSnapshot());

  assert.equal(snapshot.title, 'Test Store');
  assert.equal(snapshot.url, 'https://store.example.com/item');
  assert.equal(snapshot.domain, 'store.example.com');
  assert.deepEqual(snapshot.scrollState, { scrollY: 100, pageHeight: 1200, viewportHeight: 800 });
  assert.equal(snapshot.elementCount, 0);
  assert.deepEqual(snapshot.refs, []);
  assert.deepEqual(snapshot.shownRefs, []);
  assert.deepEqual(snapshot.elementInfo, {});
  assert.equal(typeof snapshot.pageText, 'string');
});

test('empty-page-text tamper seam: overriding extractPageText is honored by getSnapshot', () => {
  const fakeDoc = {
    title: 'Tamper Page',
    documentElement: { scrollHeight: 500 },
    querySelectorAll: () => [],
    querySelector: () => null,
    getElementById: () => null,
    contains: () => true
  };
  const fakeWin = {
    location: { href: 'https://example.com', hostname: 'example.com' },
    scrollY: 0,
    innerHeight: 600
  };

  const compressor = new DOMCompressor();
  // Simulate tamper script behavior (e.g. extensionCopy.mjs empty-page-text)
  compressor.extractPageText = () => '';

  const snapshot = withGlobals({ document: fakeDoc, window: fakeWin }, () => compressor.getSnapshot());
  assert.equal(snapshot.pageText, '', 'tamper override of extractPageText must be reflected in snapshot');
});

test('collapseRepeatedRuns collapses repeated identical runs and leaves short runs alone', () => {
  const threeUnits = 'Item In Stock. Item In Stock. Item In Stock.';
  assert.equal(collapseRepeatedRuns(threeUnits), threeUnits, 'three identical units are not collapsed');

  const fourUnits = 'Item In Stock. Item In Stock. Item In Stock. Item In Stock.';
  const collapsed = collapseRepeatedRuns(fourUnits);
  assert.match(collapsed, /repeated 4 times/);

  const priceRun = '$10.00 $20.00 $30.00 $40.00';
  assert.equal(collapseRepeatedRuns(priceRun), priceRun, 'price runs must not be dropped or collapsed');
});

test('capPageText applies cap and appends truncation marker', () => {
  const shortText = 'hello world';
  assert.equal(capPageText(shortText, 50), 'hello world');

  const longText = 'a'.repeat(100);
  const capped = capPageText(longText, 50);
  assert.equal(capped.slice(0, 50), 'a'.repeat(50));
  assert.match(capped, /\[page text truncated at 50 characters\]/);
});

test('resolveElementWithStatus detects navigated document and detached element', () => {
  const compressor = new DOMCompressor();
  const initialDocId = compressor.docId;

  const staleResult = compressor.resolveElementWithStatus(1, 'previous-doc-id');
  assert.equal(staleResult.success, false);
  assert.equal(staleResult.stale, true);
  assert.match(staleResult.error || '', /Document navigated/);

  const missingResult = compressor.resolveElementWithStatus(999, initialDocId);
  assert.equal(missingResult.success, false);
  assert.equal(missingResult.stale, true);
  assert.match(missingResult.error || '', /no longer attached/);
});
