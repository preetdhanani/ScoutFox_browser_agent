import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DOMCompressor } from '../../src/content/domCompressor.ts';
import { withGlobals } from '../helpers/contentGlobals.ts';

// The hit-test lives INLINE in the shipping content script (content/content.js);
// the port-time copy src/content/point.ts was dead code that had already drifted
// from it, so it was deleted (BUG-30). This test evaluates the real shipping
// bytes, so a change to the live hit-test logic is caught here.
const CONTENT_SRC = fs.readFileSync(new URL('../../content/content.js', import.meta.url), 'utf8');
const HIT_TEST_START = CONTENT_SRC.indexOf('function isAcceptedHit');
const HIT_TEST_END = CONTENT_SRC.indexOf('function hashString');
assert.ok(HIT_TEST_START > 0 && HIT_TEST_END > HIT_TEST_START, 'content.js no longer has the expected isAcceptedHit block - update this test');
// The live function reads the global `window` for getComputedStyle; the sandbox
// provides the small slice of it the function uses (the browser contract).
const fakeWindowForHitTest = {
  getComputedStyle: (hit: any) => ({ pointerEvents: hit?.style?.pointerEvents ?? 'auto' }),
};
const liveIsAcceptedHit = new Function('window', `${CONTENT_SRC.slice(HIT_TEST_START, HIT_TEST_END)}; return isAcceptedHit;`)(fakeWindowForHitTest) as (target: any, hit: any) => boolean;

function createEnv(interactiveEls: any[], attachedSet: Set<any>) {
  const fakeWindow: any = {
    location: { href: 'https://example.com', hostname: 'example.com' },
    crypto: {
      getRandomValues: (arr: Uint32Array) => {
        for (let i = 0; i < arr.length; i++) {
          arr[i] = Math.floor(Math.random() * 0xffffffff);
        }
        return arr;
      }
    }
  };
  const fakeDocument: any = {
    title: 'Test Page',
    contentType: 'text/html',
    documentElement: { scrollHeight: 1000 },
    body: { innerText: '', textContent: '', querySelectorAll: () => [] },
    querySelector: () => null,
    querySelectorAll: (sel: string) => (sel.includes('a[href]') ? interactiveEls : []),
    contains: (el: any) => attachedSet.has(el)
  };
  const fakeNode = { ELEMENT_NODE: 1 };
  const fakeCSS = { escape: (s: string) => s };
  return { fakeWindow, fakeDocument, fakeNode, fakeCSS };
}

function loadCompressor(interactiveEls: any[], attachedSet: Set<any>) {
  const env = createEnv(interactiveEls, attachedSet);
  const compressor = new DOMCompressor();
  return {
    getSnapshot: () =>
      withGlobals(
        { window: env.fakeWindow, document: env.fakeDocument, Node: env.fakeNode, CSS: env.fakeCSS },
        () => compressor.getSnapshot()
      ),
    get docId() {
      return compressor.docId;
    },
    resolveElementWithStatus: (id: any, expectedDocId?: string) =>
      withGlobals(
        { window: env.fakeWindow, document: env.fakeDocument, Node: env.fakeNode, CSS: env.fakeCSS },
        () => compressor.resolveElementWithStatus(id, expectedDocId)
      )
  };
}

function makeButton(id: string) {
  return {
    tagName: 'BUTTON',
    nodeType: 1,
    id,
    getAttribute: () => null,
    innerText: 'Submit',
    checkVisibility: () => true,
    getBoundingClientRect: () => ({ width: 50, height: 20 }),
    setAttribute: () => {}
  };
}

test('DOMCompressor maintains stable docId for same page and distinct docId on new page load', () => {
  const btn = makeButton('b1');
  const attached = new Set([btn]);
  const compressor1 = loadCompressor([btn], attached);

  compressor1.getSnapshot();
  const docId1 = compressor1.docId;
  assert.ok(typeof docId1 === 'string' && docId1.length > 0, 'docId must be non-empty string');

  compressor1.getSnapshot();
  const docId1Repeat = compressor1.docId;
  assert.equal(docId1, docId1Repeat, 'docId must be stable across multiple snapshots on the same document');

  // New page load initializes a fresh compressor
  const compressor2 = loadCompressor([btn], attached);
  compressor2.getSnapshot();
  const docId2 = compressor2.docId;
  assert.notEqual(docId1, docId2, 'docId must be distinct across different page loads');
});

test('resolveElementWithStatus resolves active element when docId matches', () => {
  const btn = makeButton('b1');
  const attached = new Set([btn]);
  const compressor = loadCompressor([btn], attached);

  compressor.getSnapshot();
  const docId = compressor.docId;

  const res = compressor.resolveElementWithStatus(1, docId);
  assert.equal(res.success, true);
  assert.equal(res.element, btn);
});

test('resolveElementWithStatus rejects stale element on docId mismatch', () => {
  const btn = makeButton('b1');
  const attached = new Set([btn]);
  const compressor = loadCompressor([btn], attached);

  compressor.getSnapshot();

  const res = compressor.resolveElementWithStatus(1, 'old-doc-id-999');
  assert.equal(res.success, false);
  assert.equal(res.stale, true);
  assert.match(res.error || '', /Document navigated/);
});

test('resolveElementWithStatus rejects element detached from document', () => {
  const btn = makeButton('b1');
  const attached = new Set([btn]);
  const compressor = loadCompressor([btn], attached);

  compressor.getSnapshot();
  const docId = compressor.docId;

  // Detach element from DOM
  attached.delete(btn);

  const res = compressor.resolveElementWithStatus(1, docId);
  assert.equal(res.success, false);
  assert.equal(res.stale, true);
  assert.match(res.error || '', /no longer attached/);
});

test('Hit-testing acceptance logic correctly validates target points (live content.js copy, BUG-30)', () => {
  const isAcceptedHit = liveIsAcceptedHit;

  const targetBtn = {
    tagName: 'BUTTON',
    contains: (child: any) => child === innerSpan,
    closest: (sel: string) => sel.includes('button') ? targetBtn : null
  };
  const innerSpan = {
    tagName: 'SPAN',
    contains: () => false,
    closest: (sel: string) => sel.includes('button') ? targetBtn : null
  };
  const siblingIcon = {
    tagName: 'SVG',
    contains: () => false,
    closest: (sel: string) => sel.includes('button') ? targetBtn : null
  };
  const parentDiv = {
    tagName: 'DIV',
    contains: (el: any) => el === targetBtn || el === innerSpan
  };
  const modalBackdrop = {
    tagName: 'DIV',
    className: 'modal-overlay',
    contains: () => false
  };
  const transparentOverlay = {
    tagName: 'DIV',
    className: 'click-shield',
    style: { pointerEvents: 'none' },
    contains: () => false
  };
  const shadowHost = {
    tagName: 'CUSTOM-BUTTON',
    shadowRoot: {
      contains: (el: any) => el === targetBtn
    }
  };
  const iframeEl = {
    tagName: 'IFRAME'
  };

  // 1. Direct hit
  assert.equal(isAcceptedHit(targetBtn, targetBtn), true);

  // 2. Inner span inside button
  assert.equal(isAcceptedHit(targetBtn, innerSpan), true);

  // 3. Parent container enclosing button
  assert.equal(isAcceptedHit(targetBtn, parentDiv), true);

  // 4. Shadow DOM host
  assert.equal(isAcceptedHit(targetBtn, shadowHost), true);

  // 5. Iframe container
  assert.equal(isAcceptedHit(targetBtn, iframeEl), true);

  // 6. Foreign obscuring element (e.g. cookie modal)
  assert.equal(isAcceptedHit(targetBtn, modalBackdrop), false);

  // 7. Sibling element sharing the same button interactive container
  assert.equal(isAcceptedHit(innerSpan, siblingIcon), true);

  // 8. Element with pointer-events: none (transparent overlay)
  assert.equal(isAcceptedHit(targetBtn, transparentOverlay), true);
});
test('a target inside nested shadow roots is not "covered" by the outer host (web-component pages)', () => {
  // bahn.de: document.elementFromPoint answers the outer host, and the target lives two shadow
  // roots down. The old check looked only one root deep and refused every click on the page.
  const target: any = { tagName: 'BUTTON', parentNode: null, contains: (n: any) => n === target, closest: () => null };
  const innerRoot: any = { host: null };
  const innerHost: any = { tagName: 'DB-BUTTON', parentNode: null, contains: (n: any) => n === innerHost, closest: () => null };
  const outerRoot: any = { host: null };
  const outerHost: any = { tagName: 'DIV', parentNode: null, contains: (n: any) => n === outerHost, closest: () => null, shadowRoot: outerRoot, style: {} };
  innerRoot.host = innerHost;
  outerRoot.host = outerHost;
  target.parentNode = innerRoot;
  target.getRootNode = () => innerRoot;
  innerRoot.parentNode = null;
  innerRoot.getRootNode = () => innerRoot;
  innerHost.parentNode = outerRoot;
  innerHost.getRootNode = () => outerRoot;
  outerRoot.getRootNode = () => outerRoot;
  outerRoot.contains = () => false;
  outerHost.getRootNode = () => ({});
  assert.equal(liveIsAcceptedHit(target, outerHost), true);
});

test('an unrelated overlay is still a cover', () => {
  const target: any = { tagName: 'BUTTON', parentNode: null, getRootNode: () => ({}), contains: (n: any) => n === target, closest: () => null };
  const overlay: any = { tagName: 'DIV', parentNode: null, getRootNode: () => ({}), contains: (n: any) => n === overlay, closest: () => null, style: {} };
  assert.equal(liveIsAcceptedHit(target, overlay), false);
});
