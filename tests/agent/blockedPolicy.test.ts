import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePageVerdict, executeBlockedLadder } from '../../src/background/agent/blockedPolicy.ts';

test('blockedPolicy: detects bot challenges from title, url, or body', () => {
  // Title match
  assert.equal(
    evaluatePageVerdict({ url: 'https://example.com', title: 'Just a moment...', pageText: 'Please wait' }),
    'challenge'
  );
  assert.equal(
    evaluatePageVerdict({ url: 'https://example.com', title: 'Attention Required! | Cloudflare' }),
    'challenge'
  );

  // URL match
  assert.equal(
    evaluatePageVerdict({ url: 'https://example.com/cdn-cgi/challenge-platform/h/b', title: 'Loading' }),
    'challenge'
  );

  // Body match with low element count
  assert.equal(
    evaluatePageVerdict({
      url: 'https://example.com',
      title: 'Security',
      pageText: 'Checking your browser before accessing example.com. Ray ID: 12345',
      elementCount: 5
    }),
    'challenge'
  );

  // Normal page containing "access denied" in long article is ok
  assert.equal(
    evaluatePageVerdict({
      url: 'https://news.example.com/story',
      title: 'Article about cyber security',
      pageText: 'The admin saw Access denied when testing the server.'.repeat(20),
      elementCount: 50
    }),
    'ok'
  );
});

test('blockedPolicy: detects error pages', () => {
  assert.equal(
    evaluatePageVerdict({ url: 'chrome-error://chromewebdata/', title: 'Error' }),
    'error_page'
  );

  assert.equal(
    evaluatePageVerdict({
      url: 'https://example.com/missing',
      title: '404 Not Found',
      pageText: 'The requested URL was not found on this server.'
    }),
    'error_page'
  );

  assert.equal(
    evaluatePageVerdict({
      url: 'https://example.com/blank',
      title: '',
      pageText: '',
      elementCount: 0
    }),
    'error_page'
  );
});

test('blockedPolicy: ladder executes reload and mark rungs', async () => {
  const navigated: string[] = [];
  const ctx = {
    tabId: 101,
    domain: 'idealo.de',
    searchQuery: 'framework laptop 16',
    browser: {
      navigate: async (tabId: number, url: string) => { navigated.push(url); },
      reloadTab: async () => {},
      tabInfo: async () => ({ title: 'Challenge still here', url: 'https://idealo.de' }),
      waitForTabComplete: async () => {}
    },
    sleep: async () => {} // Instant sleep for tests
  };

  // Rung 1: reload
  const res1 = await executeBlockedLadder(1, ['reload', 'mark'], 'challenge', ctx);
  assert.equal(res1.actionTaken, 'reload');
  assert.equal(res1.shouldExitBlocked, false);

  // Rung 2: mark
  const res2 = await executeBlockedLadder(2, ['reload', 'mark'], 'challenge', ctx);
  assert.equal(res2.actionTaken, 'mark');
  assert.equal(res2.shouldExitBlocked, true);
});

test('blockedPolicy: ladder executes search navigation when rung is search', async () => {
  const navigated: string[] = [];
  const ctx = {
    tabId: 101,
    domain: 'geizhals.de',
    searchQuery: 'framework laptop 16',
    browser: {
      navigate: async (tabId: number, url: string) => { navigated.push(url); },
      tabInfo: async () => ({ title: 'Error', url: 'https://geizhals.de' }),
      waitForTabComplete: async () => {}
    },
    sleep: async () => {}
  };

  const res = await executeBlockedLadder(2, ['reload', 'search', 'mark'], 'error_page', ctx);
  assert.equal(res.actionTaken, 'search');
  assert.equal(res.shouldExitBlocked, false);
  assert.ok(navigated[0].includes('google.com/search?q=framework'));
});
