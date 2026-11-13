/**
 * The bridge's WebSocket server: binds 127.0.0.1 only, and validates every upgrade request
 * before a socket is established:
 *   - Origin must start with chrome-extension:// (browser security guarantees web pages cannot
 *     forge this header, so this blocks cross-site WebSocket hijacking from web origins);
 *   - the ?token= query must equal the shared token (other installed extensions share the origin
 *     prefix, so the token is the real gate); failures get HTTP 403/401, never a socket.
 *
 * ws runs in noServer mode so OUR upgrade handler runs first: with { server } ws registers its
 * own upgrade listener and completes the handshake before any check of ours could run.
 */

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

export function startWsServer({ port, token, log }) {
  const listeners = [];
  const httpServer = createServer((req, res) => {
    // Plain HTTP requests are never part of the protocol.
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const origin = String(req.headers.origin ?? '');
    if (!origin.startsWith('chrome-extension://')) {
      log(`rejected connection from origin "${origin || '(none)'}"`);
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const sentToken = url.searchParams.get('token') ?? '';
    if (sentToken !== token) {
      log('rejected connection: bad or missing token');
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      for (const listener of listeners) listener(ws);
    });
  });

  return new Promise((resolve, reject) => {
    httpServer.once('error', (err) => reject(err));
    httpServer.listen(port, '127.0.0.1', () => {
      resolve({
        port: httpServer.address().port,
        onConnection(listener) {
          listeners.push(listener);
        },
        close() {
          wss.close();
          httpServer.close();
        },
      });
    });
  });
}
