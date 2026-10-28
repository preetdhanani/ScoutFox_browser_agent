import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const CONTENT_SRC = fs.readFileSync(new URL('../../content/content.js', import.meta.url), 'utf8');

function setupEnvironment({ status = 'Kernel idle - tick 1', statusBox = { left: 600, top: 10, width: 160, height: 20 } } = {}) {
  let messageListener: any = null;

  const chrome = {
    runtime: {
      onMessage: {
        addListener: (fn: any) => {
          messageListener = fn;
        }
      }
    }
  };

  const document: any = {
    title: 'Test Page Title',
    body: {
      innerText: 'Framework Laptop 16 ab 1.599,00 EUR. Free shipping in Germany.'
    },
    querySelectorAll: (sel: string) => {
      return [
        {
          tagName: 'BUTTON',
          offsetParent: {},
          offsetWidth: 100,
          offsetHeight: 30,
          getAttribute: (attr: string) => (attr === 'role' ? 'button' : null),
          innerText: 'Buy Now'
        },
        {
          tagName: 'A',
          offsetParent: {},
          offsetWidth: 50,
          offsetHeight: 20,
          getAttribute: (attr: string) => (attr === 'role' ? 'link' : null),
          innerText: 'Specs',
          getBoundingClientRect: () => ({ left: 10, top: 40, width: 50, height: 20, right: 60, bottom: 60 })
        },
        {
          // A live kernel status a person can click, whose text changes all the time.
          tagName: 'BUTTON',
          offsetParent: {},
          offsetWidth: statusBox.width,
          offsetHeight: statusBox.height,
          getAttribute: (attr: string) => (attr === 'role' ? 'button' : null),
          innerText: status,
          getBoundingClientRect: () => ({ ...statusBox, right: statusBox.left + statusBox.width, bottom: statusBox.top + statusBox.height })
        }
      ];
    }
  };

  const window: any = {
    location: { href: 'https://example.com/product' },
    scrollY: 150,
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener: () => {},
    removeEventListener: () => {},
    getComputedStyle: () => ({ pointerEvents: 'auto' }),
    domCompressor: {
      extractPageText: () => 'Framework Laptop 16 ab 1.599,00 EUR. Free shipping in Germany.'
    }
  };

  // Run content.js script in sandbox
  const fn = new Function('window', 'document', 'chrome', CONTENT_SRC);
  fn(window, document, chrome);

  return {
    dispatchMessage: (action: string, payload?: any): Promise<any> => {
      return new Promise((resolve) => {
        messageListener({ action, payload }, {}, (res: any) => resolve(res));
      });
    }
  };
}

test('GET_PAGE_SIG: computes valid PageSig with hashes and priceHits', async () => {
  const env = setupEnvironment();
  const res = await env.dispatchMessage('GET_PAGE_SIG', { words: ['laptop', 'shipping', 'nonexistent'] });

  assert.equal(res.success, true);
  const data = res.data;
  assert.equal(data.url, 'https://example.com/product');
  assert.equal(data.title, 'Test Page Title');
  assert.equal(data.scrollY, 150);
  assert.equal(typeof data.interactiveHash, 'string');
  assert.equal(typeof data.textHash, 'string');
  assert.ok(data.interactiveHash.length > 0);
  assert.ok(data.textHash.length > 0);
  assert.equal(data.priceHits, 1);
  assert.deepEqual(data.visibleWords, ['laptop', 'shipping']);
});

test('GET_PAGE_SIG: hashes stay stable across identical DOM content', async () => {
  const env1 = setupEnvironment();
  const res1 = await env1.dispatchMessage('GET_PAGE_SIG');

  const env2 = setupEnvironment();
  const res2 = await env2.dispatchMessage('GET_PAGE_SIG');

  assert.equal(res1.data.interactiveHash, res2.data.interactiveHash);
  assert.equal(res1.data.textHash, res2.data.textHash);
});

test('GET_PAGE_SIG: the layout hash ignores text that changes in place, and sees a control that moved', async () => {
  // A coordinate click relies on where the controls are, not on what they say: a ticking kernel
  // status must not make a screenshot "out of date", a control that moved must.
  const tick1 = (await setupEnvironment({ status: 'Kernel idle - tick 1' }).dispatchMessage('GET_PAGE_SIG')).data;
  const tick2 = (await setupEnvironment({ status: 'Kernel busy - tick 2' }).dispatchMessage('GET_PAGE_SIG')).data;
  assert.equal(typeof tick1.layoutHash, 'string');
  assert.equal(tick1.layoutHash, tick2.layoutHash, 'only the text changed');
  assert.notEqual(tick1.interactiveHash, tick2.interactiveHash, 'the label hash does see the text');
  const moved = (await setupEnvironment({ statusBox: { left: 600, top: 200, width: 160, height: 20 } }).dispatchMessage('GET_PAGE_SIG')).data;
  assert.notEqual(moved.layoutHash, tick1.layoutHash, 'a control that moved changes the layout');
});
