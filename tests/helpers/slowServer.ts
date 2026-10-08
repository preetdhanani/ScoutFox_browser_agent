/**
 * slowServer - a local HTTP server that takes its time, for tests of deadlines and aborts.
 *
 * It accepts a request, reads the body, and then waits `holdMs` before it answers with a provider-shaped reply
 * (the default is never). For every request it remembers whether the CLIENT hung up before the answer went
 * out. That is the proof that a request was really cancelled: a client that only stopped waiting keeps the
 * socket open.
 *
 * Example:
 *   const server = await startSlowServer(t);              // never answers
 *   server.base;                                          // 'http://127.0.0.1:53211'
 *   await server.waitForHangUp(0);                        // resolves when the first request's socket closed early
 *   server.requests[0].hungUp;                            // true
 *   const fast = await startSlowServer(t, { holdMs: 0 }); // answers at once, with the text '{"action":"done"}'
 *   const stall = await startSlowServer(t, { stallAfterFirstChunk: true }); // sends the first piece of a streamed reply, then stalls
 *
 * Anthropic and Gemini talk to fixed hosts, so a test points them here by rewriting the URL in a fetch spy
 * (redirectFetch below), while openai and openai_compatible only need `baseUrl: server.base`.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { installFetch, textReply } from './llmWire.ts';

export interface HeldRequest {
  method: string;
  url: string;
  body: string;
  /** The client closed the connection before the server had answered. */
  hungUp: boolean;
  answered: boolean;
}

export interface SlowServer {
  base: string;
  requests: HeldRequest[];
  /** Resolves once request `index` was hung up on by the client, and rejects after `timeoutMs`. */
  waitForHangUp(index: number, timeoutMs?: number): Promise<void>;
}

export interface SlowServerOptions {
  holdMs?: number;
  replyText?: string;
  /**
   * Answer a streamed endpoint (Ollama's /api/chat, Gemini's streamGenerateContent) with its status line and the
   * first piece of the reply, and then never finish it: a model that started answering and got stuck.
   */
  stallAfterFirstChunk?: boolean;
}

export async function startSlowServer(
  t: { after: (fn: () => void) => void },
  { holdMs = Infinity, replyText = '{"action":"done"}', stallAfterFirstChunk = false }: SlowServerOptions = {}
): Promise<SlowServer> {
  const requests: HeldRequest[] = [];
  const server = http.createServer((req, res) => {
    const entry: HeldRequest = { method: String(req.method), url: String(req.url), body: '', hungUp: false, answered: false };
    requests.push(entry);
    res.on('close', () => { if (!res.writableFinished) entry.hungUp = true; });
    req.on('data', (chunk) => { entry.body += chunk; });
    req.on('end', async () => {
      if (stallAfterFirstChunk) {
        const reply = textReply(`http://127.0.0.1${entry.url}`, replyText);
        const text = await reply.text();
        // Ollama sends one JSON object per line, Gemini one event, and both are complete before the next begins.
        const firstPiece = entry.url.includes(':streamGenerateContent') ? text : text.slice(0, text.indexOf('\n') + 1);
        res.writeHead(reply.status, Object.fromEntries(reply.headers));
        res.write(firstPiece);
        return;
      }
      if (holdMs === Infinity) return;
      setTimeout(async () => {
        if (res.destroyed) return;
        const reply = textReply(`http://127.0.0.1${entry.url}`, replyText);
        res.writeHead(reply.status, Object.fromEntries(reply.headers));
        res.end(await reply.text());
        entry.answered = true;
      }, holdMs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });

  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    async waitForHangUp(index, timeoutMs = 2000) {
      const start = Date.now();
      while (!requests[index]?.hungUp) {
        if (Date.now() - start > timeoutMs) throw new Error(`the client did not hang up on request ${index} within ${timeoutMs} ms (requests seen: ${requests.length})`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
  };
}

/** Replaces globalThis.fetch until the test ends: a URL that starts with a key of `hosts` is sent to its value instead. */
export function redirectFetch(t: { after: (fn: () => void) => void }, hosts: Record<string, string>): void {
  const current = globalThis.fetch;
  installFetch(t, ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const from = Object.keys(hosts).find((host) => url.startsWith(host));
    return current(from ? hosts[from] + url.slice(from.length) : url, init);
  }) as typeof fetch);
}
