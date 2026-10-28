/**
 * Tiny static file server for tests/fixtures/site. Node's http module only, so the smoke run
 * needs no extra dependency for it.
 *
 * Two small rules make it stand in for an API (the research fixture's SearXNG endpoint):
 *   - a path with no file behind it, but a .json file of the same name, is that JSON
 *     (/research/search?q=..&format=json is research/search.json, whatever the query);
 *   - in a .json file, __ORIGIN__ is the origin the request came to (http://docs.lantern.test:8765),
 *     so the addresses it lists work under any host name and port.
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.sh': 'text/x-sh; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

export function startFixtureServer({ root, host = '127.0.0.1', port = 8765 }) {
  const server = http.createServer(async (req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const file = path.resolve(root, rel);
    // Never serve anything outside the fixture folder.
    if (!file.startsWith(path.resolve(root) + path.sep)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    try {
      const served = path.extname(file) ? file : await readFile(`${file}.json`).then(() => `${file}.json`, () => file);
      let body = await readFile(served);
      if (path.extname(served) === '.json') body = Buffer.from(body.toString('utf8').replaceAll('__ORIGIN__', `http://${req.headers.host}`));
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(served)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve({ server, origin: `http://${host}:${server.address().port}` }));
  });
}
