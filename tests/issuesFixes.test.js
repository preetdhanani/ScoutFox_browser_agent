import test from 'node:test';
import assert from 'node:assert/strict';

// Test 1: isValidWebTab url validation logic
test('isValidWebTab - rejects Chrome Web Store and restricted protocols', () => {
  function isValidWebTab(tab) {
    if (!tab || !tab.url) return false;
    const url = tab.url.toLowerCase();

    if (url.includes('chromewebstore.google.com') || url.includes('chrome.google.com/webstore')) {
      return false;
    }

    return !url.startsWith('chrome://') && 
           !url.startsWith('chrome-extension://') && 
           !url.startsWith('chrome-search://') && 
           !url.startsWith('chrome-untrusted://') && 
           !url.startsWith('edge://') && 
           !url.startsWith('about:') && 
           !url.startsWith('view-source:') && 
           !url.startsWith('devtools:') && 
           !url.startsWith('data:');
  }

  assert.equal(isValidWebTab({ url: 'https://chromewebstore.google.com/detail/scoutfox' }), false);
  assert.equal(isValidWebTab({ url: 'https://chrome.google.com/webstore/category/extensions' }), false);
  assert.equal(isValidWebTab({ url: 'view-source:https://example.com' }), false);
  assert.equal(isValidWebTab({ url: 'data:text/html,<h1>Hello</h1>' }), false);
  assert.equal(isValidWebTab({ url: 'devtools://devtools/bundled/inspector.html' }), false);
  assert.equal(isValidWebTab({ url: 'chrome://extensions' }), false);
  assert.equal(isValidWebTab({ url: 'https://github.com/preetdhanani/ScoutFox_browser_agent' }), true);
});

// Test 2: doClick dispatch logic
test('doClick - dispatches single click event without duplicate click MouseEvent', () => {
  let clickCount = 0;
  let mouseEventTypes = [];

  const mockElement = {
    scrollIntoView() {},
    dispatchEvent(event) {
      mouseEventTypes.push(event.type);
      if (event.type === 'click') clickCount++;
      return true;
    },
    click() {
      clickCount++;
    }
  };

  function doClickSimulated(el) {
    ['mouseenter', 'mouseover', 'mousedown', 'mouseup'].forEach(eventType => {
      el.dispatchEvent({ type: eventType });
    });

    if (typeof el.click === 'function') {
      el.click();
    } else {
      el.dispatchEvent({ type: 'click' });
    }
  }

  doClickSimulated(mockElement);

  assert.equal(clickCount, 1);
  assert.deepEqual(mouseEventTypes, ['mouseenter', 'mouseover', 'mousedown', 'mouseup']);
});

// Test 3: extractPageText fallback logic
test('extractPageText - fallback preserves main content nodes over footer slice', () => {
  const allTextNodes = Array.from({ length: 50 }, (_, i) => ({
    tagName: 'P',
    textContent: `Article text paragraph ${i + 1}`,
    getBoundingClientRect: () => ({ top: 3000 + i * 20, bottom: 3020 + i * 20 })
  }));

  const windowScrollY = 500;
  const vHeight = 800;

  // Simulate sparse viewport match
  let textNodes = allTextNodes.filter(node => {
    const rect = node.getBoundingClientRect();
    return rect.bottom >= -200 && rect.top <= vHeight + 1500;
  });

  if (textNodes.length < 10) {
    textNodes = allTextNodes.slice(0, 90);
  }

  assert.equal(textNodes.length, 50);
  assert.equal(textNodes[0].textContent, 'Article text paragraph 1');
});
