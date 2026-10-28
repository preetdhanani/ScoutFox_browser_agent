/**
 * Local proxy in front of a real OpenAI-compatible model server for the smoke run (NVIDIA NIM,
 * LISA, any other profile of lib/providers.mjs).
 *
 * The extension is configured with this proxy as its base URL. The proxy adds the real key (read
 * from the environment by the profile) to every request on the way out, so the key never enters
 * the extension's settings, the temp browser profile or a screenshot: the extension only holds a
 * placeholder. The request path is forwarded unchanged, so the extension builds the same URLs it
 * builds for the real server (a base URL of <proxy>/api gives <proxy>/api/chat/completions).
 *
 * It also records every chat completions call in the same shape as the Ollama proxy and the
 * offline mock (see callRecord.mjs), so the report counts model calls and tokens the same way in
 * every mode. OpenAI's `usage` and `finish_reason` are mapped onto Ollama's names for that record.
 */
import http from 'node:http';
import { buildCallRecord } from '../../mcp/callRecord.mjs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

/** The placeholder key the extension is given. The proxy replaces it with the real one. */
export const PLACEHOLDER_KEY = 'local-proxy-placeholder-key';

/** An OpenAI /chat/completions answer in the shape callRecord reads (Ollama's field names). */
export function asCallRecordReply(body) {
  if (!body || typeof body !== 'object') return {};
  if (body.error) return { error: typeof body.error === 'string' ? body.error : (body.error.message || JSON.stringify(body.error)) };
  const choice = body.choices?.[0] || {};
  const message = choice.message || {};
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  // The record's `content` is what the model said; a tool call is said as its name and arguments.
  const said = message.content || toolCalls.map((call) => `${call.function?.name}(${call.function?.arguments || ''})`).join(' ');
  return {
    message: { content: said || '' },
    prompt_eval_count: body.usage?.prompt_tokens ?? null,
    eval_count: body.usage?.completion_tokens ?? null,
    done_reason: choice.finish_reason ?? null
  };
}

/** A chat call, whatever mount path the server uses (/v1/chat/completions, /api/chat/completions). */
function isChatCall(url) {
  return /\/chat\/completions(\?|$)/.test(url || '');
}

/**
 * Starts the proxy. `target` is the server's origin (its paths come from the extension's
 * requests), `apiKey` the real key, `label` names the server in errors.
 */
export function startKeyProxy({ host = '127.0.0.1', port = 11435, target, apiKey, label = 'model server', onCall = () => {} } = {}) {
  if (!target) throw new Error(`startKeyProxy needs the ${label} address`);
  if (!apiKey) throw new Error(`startKeyProxy needs the ${label} API key`);
  const upstreamBase = target.replace(/\/+$/, '');
  const calls = [];

  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS).end();
      return;
    }

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const reqBody = Buffer.concat(chunks);

    // Abort the upstream call when the extension gives up (Pause or Stop abort the fetch).
    const upstreamAbort = new AbortController();
    res.on('close', () => { if (!res.writableEnded) upstreamAbort.abort(); });

    const startedAt = Date.now();
    let upstream;
    try {
      upstream = await fetch(upstreamBase + req.url, {
        method: req.method,
        headers: {
          ...(req.headers['content-type'] ? { 'Content-Type': req.headers['content-type'] } : {}),
          Accept: 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: reqBody.length ? reqBody : undefined,
        signal: upstreamAbort.signal
      });
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'text/plain', ...CORS }).end(`proxy error (${label}): ${err.message}`);
      return;
    }
    const respBody = Buffer.from(await upstream.arrayBuffer());

    if (isChatCall(req.url)) {
      let sent = {};
      let got = {};
      try { sent = JSON.parse(reqBody.toString('utf8')); } catch { /* not JSON */ }
      try { got = asCallRecordReply(JSON.parse(respBody.toString('utf8'))); } catch { got = { error: respBody.toString('utf8').slice(0, 500) }; }
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
