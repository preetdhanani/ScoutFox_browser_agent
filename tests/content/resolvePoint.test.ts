import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const DOM_COMPRESSOR_SRC = fs.readFileSync(new URL('../../content/domCompressor.js', import.meta.url), 'utf8');

function loadCompressor(interactiveEls: any[], attachedSet: Set<any>) {
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
  const fn = new Function('window', 'document', 'Node', 'CSS', `${DOM_COMPRESSOR_SRC}\nreturn window.domCompressorInstance;`);
  return fn(fakeWindow, fakeDocument, fakeNode, fakeCSS);
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
  assert.match(res.error, /Document navigated/);
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
  assert.match(res.error, /no longer attached/);
});

test('Hit-testing acceptance logic correctly validates target points', () => {
  function isAcceptedHit(target: any, hit: any) {
    if (!hit || !target) return false;
    if (hit === target) return true;
    if (typeof target.contains === 'function' && target.contains(hit)) return true;
    if (typeof hit.contains === 'function' && hit.contains(target)) return true;
    if (hit.shadowRoot && typeof hit.shadowRoot.contains === 'function' && hit.shadowRoot.contains(target)) return true;
    if (hit.tagName === 'IFRAME') return true;
    return false;
  }

  const targetBtn = {
    tagName: 'BUTTON',
    contains: (child: any) => child === innerSpan
  };
  const innerSpan = {
    tagName: 'SPAN',
    contains: () => false
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
});
