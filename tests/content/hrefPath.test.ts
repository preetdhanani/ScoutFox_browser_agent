// Links on the same site say which page they open, so identical labels can be told apart
// (frame.work lists five "Configure now" links; only the path says which laptop each is for).
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeHrefPath, HREF_PATH_LIMIT } from '../../src/content/perception.ts';
import { linkNotOpenedNote, rankElementLines } from '../../src/background/mcp/server.ts';

const HERE = 'https://frame.work/de/en';

test('a same-site link gives its path and query, a link to this page gives nothing', () => {
  assert.equal(computeHrefPath('/de/en/laptop16', HERE), '/de/en/laptop16');
  assert.equal(computeHrefPath('https://frame.work/de/en/products/x?sku=1#top', HERE), '/de/en/products/x?sku=1');
  assert.equal(computeHrefPath('#main', HERE), undefined, 'an anchor on this page');
  assert.equal(computeHrefPath('/de/en', HERE), undefined, 'the page itself');
  assert.equal(computeHrefPath('', HERE), undefined);
  assert.equal(computeHrefPath(`/${'a'.repeat(200)}`, HERE)!.length, HREF_PATH_LIMIT, 'a long path is cut');
});

test('find picks the Laptop 16 link among identical "Configure now" labels by its path', () => {
  const lines = [
    '[22] a "Configure now" (href="/de/en/products/laptop13pro-diy-intel-ultra-3/configuration/new")',
    '[29] a "Configure now" (href="/de/en/products/laptop12-diy-intel-series3/configuration/new") [off-screen]',
    '[33] a "Configure now" (href="/de/en/products/laptop16-diy-amd-ai300/configuration/new") [off-screen]',
    '[34] a "Learn more" (href="/de/en/laptop16") [off-screen]'
  ].join('\n');
  assert.deepEqual(rankElementLines(lines, 'Framework Laptop 16 Configure now')[0], lines.split('\n')[2]);
  assert.deepEqual(rankElementLines(lines, 'Framework Laptop 16 Learn more')[0], lines.split('\n')[3]);
});

test('a click on a same-site link that left the tab where it was says so, with the link path', () => {
  const note = linkNotOpenedNote('[33] a "Configure now" (href="/de/en/laptop16") [off-screen]');
  assert.match(note, /did not open its page \(\/de\/en\/laptop16\)/);
  assert.match(note, /cookie or consent banner/);
  assert.equal(linkNotOpenedNote('[6] button[button] "Warenkorb (0)"'), '', 'a button is not a link: nothing to say');
  assert.equal(linkNotOpenedNote('[7] a "Docs" (domain="docs.example.com")'), '', 'an off-site link has no path');
  assert.equal(linkNotOpenedNote(''), '');
});
