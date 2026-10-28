import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DDG_HTML_ENDPOINT,
  parseDuckDuckGoHtml,
  parseSearxngJson,
  resultCount,
  searxngSearchUrl,
  unwrapDuckDuckGoLink,
  webSearch
} from '../../src/background/research/search.ts';
import { UNTRUSTED_END, UNTRUSTED_PREFIX } from '../../src/background/mcp/untrusted.ts';
import { DEFAULT_RESEARCH } from '../../src/shared/storage.ts';
import { stubFetch } from './stubFetch.ts';

const SAMPLES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'research');
const sample = (name: string) => fs.readFileSync(path.join(SAMPLES, name), 'utf8');
const DDG = { ...DEFAULT_RESEARCH };
const SEARX = { enabled: true, backend: 'searxng' as const, searxngUrl: 'https://searx.example/' };

test('unwrapDuckDuckGoLink reads the real address out of the /l/?uddg= redirect and drops DuckDuckGo-only links', () => {
  assert.equal(unwrapDuckDuckGoLink('//duckduckgo.com/l/?uddg=https%3A%2F%2Fgithub.com%2Follama%2Follama%2Freleases&rut=abc'), 'https://github.com/ollama/ollama/releases');
  assert.equal(unwrapDuckDuckGoLink('https://ollama.com/download/linux'), 'https://ollama.com/download/linux');
  assert.equal(unwrapDuckDuckGoLink('https://duckduckgo.com/y.js?ad_domain=x.com'), '', 'an ad stays on DuckDuckGo and is dropped');
  assert.equal(unwrapDuckDuckGoLink('//duckduckgo.com/l/?uddg=javascript%3Aalert(1)'), '');
});

test('parseDuckDuckGoHtml reads the saved results page: no ad, no duplicate, titles and snippets as text', () => {
  const { results, challenge, noResults } = parseDuckDuckGoHtml(sample('ddg-results.html'));
  assert.equal(challenge, false);
  assert.equal(noResults, false);
  assert.deepEqual(results.map((r) => r.url), [
    'https://github.com/ollama/ollama/releases',
    'https://github.com/ollama/ollama/blob/main/docs/linux.md',
    'https://ollama.com/download/linux'
  ]);
  assert.equal(results[0].title, 'Releases · ollama/ollama · GitHub');
  assert.match(results[0].snippet, /Assets: ollama-linux-amd64\.tar\.zst, ollama-darwin\.tgz & more\./);
  assert.match(results[1].snippet, /ollama-linux-amd64\.tar\.zst \| sudo tar x --zstd/);
});

test('parseDuckDuckGoHtml knows the bot check page, and reads no results out of it', () => {
  const parsed = parseDuckDuckGoHtml(sample('ddg-challenge.html'));
  assert.equal(parsed.challenge, true);
  assert.deepEqual(parsed.results, []);
});

test('parseSearxngJson reads the saved answer: http(s) only, no duplicates, snippets as text', () => {
  const results = parseSearxngJson(sample('searxng.json'));
  assert.deepEqual(results.map((r) => r.url), [
    'https://github.com/ollama/ollama/releases',
    'https://github.com/ollama/ollama/blob/main/docs/linux.md',
    'https://ollama.com/download/linux'
  ]);
  assert.equal(results[1].snippet, 'Manual install & upgrade: curl -fsSL https://ollama.com/download/ollama-linux-amd64.tar.zst');
  assert.throws(() => parseSearxngJson('<html>no json</html>'), /JSON format/);
});

test('searxngSearchUrl builds /search?q=&format=json from a base URL, with or without /search', () => {
  assert.deepEqual(searxngSearchUrl('https://searx.example/', 'a b'), { url: 'https://searx.example/search?q=a+b&format=json' });
  assert.deepEqual(searxngSearchUrl('https://searx.example/sub/search', 'x'), { url: 'https://searx.example/sub/search?q=x&format=json' });
  assert.match((searxngSearchUrl('searx.example', 'x') as any).error, /not usable/);
});

test('resultCount is 6 by default and clamped to 1..8', () => {
  assert.equal(resultCount(undefined), 6);
  assert.equal(resultCount(3), 3);
  assert.equal(resultCount(50), 8);
  assert.equal(resultCount(0), 1);
  assert.equal(resultCount('x'), 6);
});

test('webSearch on DuckDuckGo: one GET to the HTML endpoint, no cookies, results in the untrusted envelope', async () => {
  const fetch = stubFetch({ '*': { body: sample('ddg-results.html'), type: 'text/html; charset=utf-8' } });
  const out = await webSearch({ query: 'ollama  linux amd64', max_results: 2 }, DDG, { fetchImpl: fetch.impl });
  assert.equal(out.isError, undefined);
  assert.equal(fetch.requests.length, 1);
  assert.equal(fetch.requests[0].url, `${DDG_HTML_ENDPOINT}?q=ollama%20linux%20amd64`);
  assert.equal(fetch.requests[0].init.credentials, 'omit');
  assert.equal(out.results.length, 2, 'max_results is obeyed');
  assert.match(out.text, /^Web search \(DuckDuckGo\) for "ollama linux amd64": 2 results\.\n/);
  assert.ok(out.text.includes(`${UNTRUSTED_PREFIX} web search results (DuckDuckGo)`));
  assert.ok(out.text.includes(UNTRUSTED_END));
  assert.match(out.text, /1\. Releases · ollama\/ollama · GitHub\n {3}https:\/\/github\.com\/ollama\/ollama\/releases\n/);
});

test('webSearch says so plainly when DuckDuckGo answers with its bot check, and invents nothing', async () => {
  const fetch = stubFetch({ '*': { status: 202, body: sample('ddg-challenge.html'), type: 'text/html' } });
  const out = await webSearch({ query: 'x' }, DDG, { fetchImpl: fetch.impl });
  assert.equal(out.isError, true);
  assert.deepEqual(out.results, []);
  assert.match(out.text, /bot check/);
  assert.match(out.text, /SearXNG URL in Settings > Research/);
  assert.doesNotMatch(out.text, /https?:\/\/(?!.*duckduckgo)/, 'no address is made up');
});

test('webSearch reports a DuckDuckGo HTTP error and a network failure the same honest way', async () => {
  const status = await webSearch({ query: 'x' }, DDG, { fetchImpl: stubFetch({ '*': { status: 403, body: 'no' } }).impl });
  assert.equal(status.isError, true);
  assert.match(status.text, /HTTP 403/);
  assert.match(status.text, /SearXNG URL/);
  const down = await webSearch({ query: 'x' }, DDG, { fetchImpl: stubFetch({}).impl });
  assert.equal(down.isError, true);
  assert.match(down.text, /could not be fetched/);
});

test('webSearch on SearXNG asks its JSON format and reads the results', async () => {
  const fetch = stubFetch({ 'https://searx.example/search?q=ollama&format=json': { body: sample('searxng.json'), type: 'application/json' } });
  const out = await webSearch({ query: 'ollama' }, SEARX, { fetchImpl: fetch.impl });
  assert.equal(out.isError, undefined);
  assert.equal(out.results.length, 3);
  assert.match(out.text, /^Web search \(SearXNG\) for "ollama": 3 results\./);
});

test('webSearch on SearXNG with no URL, a refused JSON format or a non-JSON answer is an error', async () => {
  const none = await webSearch({ query: 'x' }, { ...SEARX, searxngUrl: '' }, { fetchImpl: stubFetch({}).impl });
  assert.match(none.text, /no SearXNG URL is set/);
  const refused = await webSearch({ query: 'x' }, SEARX, { fetchImpl: stubFetch({ '*': { status: 403 } }).impl });
  assert.match(refused.text, /HTTP 403.*refuse the JSON format/);
  const html = await webSearch({ query: 'x' }, SEARX, { fetchImpl: stubFetch({ '*': { body: '<html></html>', type: 'text/html' } }).impl });
  assert.match(html.text, /did not answer with JSON/);
});

test('webSearch needs a query', async () => {
  const out = await webSearch({ query: '  ' }, DDG, { fetchImpl: stubFetch({}).impl });
  assert.equal(out.isError, true);
  assert.match(out.text, /needs a query/);
});
