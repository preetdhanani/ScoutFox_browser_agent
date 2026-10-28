// Links on the same site say which page they open, so identical labels can be told apart
// (frame.work lists five "Configure now" links; only the path says which laptop each is for).
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeHrefPath, HREF_PATH_LIMIT } from '../../src/content/perception.ts';
import { linkNotOpenedNote } from '../../src/background/mcp/server.ts';
import { rankFindCandidates, type FindFields } from '../../src/content/domCompressor.ts';

/** A find candidate from a link's text and path, the way findElements reads one off the page. */
const link = (text: string, hrefPath: string): { item: string; fields: FindFields; inViewport: boolean; distance: number } => ({
  item: `${text} ${hrefPath}`,
  fields: { text, ariaLabel: '', placeholder: '', name: '', title: '', alt: '', hrefPath, role: 'link' },
  inViewport: false,
  distance: 100
});

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
  const links = [
    link('Configure now', '/de/en/products/laptop13pro-diy-intel-ultra-3/configuration/new'),
    link('Configure now', '/de/en/products/laptop12-diy-intel-series3/configuration/new'),
    link('Configure now', '/de/en/products/laptop16-diy-amd-ai300/configuration/new'),
    link('Learn more', '/de/en/laptop16'),
    link('Configure now', '/configurator.html?model=laptop13'),
    link('Configure now', '/configurator.html?model=laptop16')
  ];
  assert.equal(rankFindCandidates(links.slice(0, 4), 'Framework Laptop 16 Configure now')[0].item, links[2].item);
  assert.equal(rankFindCandidates(links.slice(0, 4), 'Framework Laptop 16 Learn more')[0].item, links[3].item);
  assert.equal(rankFindCandidates(links.slice(4), 'Laptop 16 Configure now')[0].item, links[5].item, 'the query part of a path counts too');
});

test('find ranks by the words of the query, so a question in words finds the element', () => {
  // Real queries from the NVIDIA runs: both found nothing as one substring, and each miss cost a
  // round and a full element list. Filler words ("link", "page") do not count, and a word finds
  // the longer word it starts ("download" finds "Downloads").
  const github = [link('Skip to content', ''), link('Code', '/microsoft/playwright'), link('Releases 182', '/microsoft/playwright/releases'), link('v1.64.1 Latest', '/microsoft/playwright/releases/tag/v1.64.1')];
  assert.equal(rankFindCandidates(github, 'Releases link or latest release')[0].item, github[2].item);
  const python = [link('Docs', '/doc/'), link('Downloads', '/downloads/'), link('All releases', '/downloads/source/')];
  assert.equal(rankFindCandidates(python, 'downloads page link')[0].item, python[1].item);
  assert.equal(rankFindCandidates(python, 'Docs')[0].item, python[0].item, 'a plain label still finds itself');
  assert.deepEqual(rankFindCandidates(python, 'checkout button'), [], 'and an absent target finds nothing');
});

test('a click on a same-site link that left the tab where it was says so, with the link path', () => {
  const note = linkNotOpenedNote('[33] a "Configure now" (href="/de/en/laptop16") [off-screen]');
  assert.match(note, /did not open its page \(\/de\/en\/laptop16\)/);
  assert.match(note, /cookie or consent banner/);
  assert.equal(linkNotOpenedNote('[6] button[button] "Warenkorb (0)"'), '', 'a button is not a link: nothing to say');
  assert.equal(linkNotOpenedNote('[7] a "Docs" (domain="docs.example.com")'), '', 'an off-site link has no path');
  assert.equal(linkNotOpenedNote(''), '');
});
