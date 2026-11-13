// Integration tests for the bridge's WebSocket server (bridge/wsServer.mjs):
// Origin and token enforcement on the HTTP upgrade request.

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startWsServer } from '../../bridge/wsServer.mjs';

const TOKEN = 'test-token-0123456789abcdef';
const log = () => {};

async function withServer(fn) {
  const server = await startWsServer({ port: 0, token: TOKEN, log });
  try {
    return await fn(server);
  } finally {
    server.close();
  }
}

/** Raw HTTP upgrade request; resolves with the status line. */
function rawUpgrade(port, path, headers) {
  return new Promise((resolve, reject) => {
    const key = Buffer.from('0123456789abcdef').toString('base64');
    const req = [
      `GET ${path} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      '\r\n',
    ].join('\r\n');
    const socket = net.connect(port, '127.0.0.1', () => socket.write(req));
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('rawUpgrade timed out'));
    }, 3000);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      if (buffer.includes('\r\n\r\n')) return;
      buffer += chunk;
      if (buffer.includes('\r\n\r\n')) {
        clearTimeout(timer);
        resolve({ status: buffer.split('\r\n')[0], socket });
      }
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

test('the server accepts an extension origin with the right token', async () => {
  await withServer(async (server) => {
    const { status, socket } = await rawUpgrade(server.port, `/?token=${TOKEN}`, { Origin: 'chrome-extension://abcdef' });
    assert.ok(status.includes('101'), `expected 101, got: ${status}`);
    socket.destroy();
  });
});

test('the server refuses a web origin with 403 (CSWSH defense)', async () => {
  await withServer(async (server) => {
    const { status, socket } = await rawUpgrade(server.port, `/?token=${TOKEN}`, { Origin: 'https://evil.example' });
    assert.ok(status.includes('403'), `expected 403, got: ${status}`);
    socket.destroy();
  });
});

test('the server refuses a missing origin with 403', async () => {
  await withServer(async (server) => {
    const { status, socket } = await rawUpgrade(server.port, `/?token=${TOKEN}`, {});
    assert.ok(status.includes('403'), `expected 403, got: ${status}`);
    socket.destroy();
  });
});

test('the server refuses a wrong token with 401', async () => {
  await withServer(async (server) => {
    const { status, socket } = await rawUpgrade(server.port, '/?token=wrong-token-wrong', { Origin: 'chrome-extension://abcdef' });
    assert.ok(status.includes('401'), `expected 401, got: ${status}`);
    socket.destroy();
  });
});

test('the server refuses a missing token with 401', async () => {
  await withServer(async (server) => {
    const { status, socket } = await rawUpgrade(server.port, '/', { Origin: 'chrome-extension://abcdef' });
    assert.ok(status.includes('401'), `expected 401, got: ${status}`);
    socket.destroy();
  });
});
