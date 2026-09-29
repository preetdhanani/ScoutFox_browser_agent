/**
 * Local proxy in front of Ollama for the smoke run.
 *
 * Ollama answers 403 to any request whose Origin it does not trust, and a chrome-extension://
 * origin is not trusted unless OLLAMA_ORIGINS is set when the server starts. We must not
 * restart the user's Ollama server, so the extension talks to this proxy instead: it drops the
 * Origin header, adds CORS headers and forwards to the real server.
 *
 * It also records every /api/chat call (request size, format, think flag, and Ollama's own
 * prompt_eval_count and eval_count), which is how the smoke run counts model calls and tokens.
 * The record has the same shape as the one the offline mock keeps (see callRecord.mjs).
 */
import http from 'node:http';
import { buildCallRecord } from './callRecord.mjs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

export function startOllamaProxy({ host = '127.0.0.1', port = 11435, target = 'http://127.0.0.1:11434', onCall = () => {} } = {}) {
  const calls = [];

  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS).end();
      return;
    }

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const reqBody = Buffer.concat(chunks);

    // Abort the upstream call when the extension gives up (Pause or Stop abort the fetch),
    // so Ollama does not keep generating for a reply nobody reads.
    const upstreamAbort = new AbortController();
    res.on('close', () => { if (!res.writableEnded) upstreamAbort.abort(); });

    const startedAt = Date.now();
    let upstream;
    try {
      upstream = await fetch(target + req.url, {
        method: req.method,
        headers: req.headers['content-type'] ? { 'Content-Type': req.headers['content-type'] } : {},
        body: reqBody.length ? reqBody : undefined,
        signal: upstreamAbort.signal
      });
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'text/plain', ...CORS }).end(`proxy error: ${err.message}`);
      return;
    }
    const respBody = Buffer.from(await upstream.arrayBuffer());

    if (req.url.startsWith('/api/chat')) {
      let sent = {};
      let got = {};
      try { sent = JSON.parse(reqBody.toString('utf8')); } catch { /* not JSON */ }
      try { got = JSON.parse(respBody.toString('utf8')); } catch { /* not JSON */ }
      const call = buildCallRecord({
        n: calls.length + 1,
        status: upstream.status,
        ms: Date.now() - startedAt,
        requestBytes: reqBody.length,
        responseBytes: respBody.length,
        sent,
        got
      });
      calls.push(call);
      onCall(call);
    }

    res.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') || 'application/json',
      ...CORS
    });
    res.end(respBody);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve({ server, calls, url: `http://${host}:${server.address().port}` }));
  });
}
