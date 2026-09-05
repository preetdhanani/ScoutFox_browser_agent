/**
 * Regression test for a closed-but-never-actually-fixed issue: background.js's isValidWebTab
 * only recognised chrome://, chrome-extension://, edge:// and about: - missing the Chrome Web
 * Store and file:/view-source:/devtools:/data: pages that agentEngine.js's own
 * describeRestrictedUrl() already covered. A tab sitting on the Web Store or a file:// page
 * slipped through as "valid", and getActiveTab() would pick it as the automation target - only
 * for script injection to fail immediately once the real run started.
 *
 * Fixed by making isValidWebTab delegate to describeRestrictedUrl instead of keeping a second,
 * independently-drifting list of restricted URL patterns.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { describeRestrictedUrl } = await import('../background/agentEngine.js');

const RESTRICTED = [
  ['chrome://extensions/', 'internal chrome:// page'],
  ['edge://settings/', 'internal edge:// page'],
  ['about:blank', 'about: page'],
  ['chrome-extension://abcdefg/page.html', 'another extension\'s page'],
  ['https://chromewebstore.google.com/detail/foo', 'Chrome Web Store (new domain)'],
  ['https://chrome.google.com/webstore/detail/foo', 'Chrome Web Store (legacy domain)'],
  ['file:///Users/me/notes.txt', 'a local file:// page'],
  ['view-source:https://example.com', 'a view-source: page'],
  ['devtools://devtools/bundled/inspector.html', 'a devtools: page'],
  ['data:text/html,<h1>hi</h1>', 'a data: URL']
];

for (const [url, label] of RESTRICTED) {
  test(`describeRestrictedUrl flags ${label} as restricted`, () => {
    assert.notEqual(describeRestrictedUrl(url), null, `${url} must be recognised as restricted`);
  });
}

test('describeRestrictedUrl does not flag an ordinary website', () => {
  assert.equal(describeRestrictedUrl('https://example.com/products'), null);
});

test('describeRestrictedUrl explains a missing URL rather than crashing', () => {
  assert.notEqual(describeRestrictedUrl(null), null);
  assert.notEqual(describeRestrictedUrl(''), null);
});
