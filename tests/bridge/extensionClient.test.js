// Tests for the extension-side bridge client (src/background/bridge/wsClient.ts): URL
// validation, settings-driven start/stop, alarm registration, and the stop-bridge-runs-on-
// disconnect rule. The WebSocket global is faked, so no real sockets are opened.

import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeClient, validatedUrl } from '../../src/background/bridge/wsClient.ts';
import { fakeChrome } from '../helpers/fakeChrome.ts';

/** A scripted fake of the WebSocket global: records instances, lets tests drive events. */
function installFakeWebSocket() {
  const sockets = [];
  class FakeWebSocket {
    static OPEN = 1;
    readyState = 0;
    sent = [];
    constructor(url) {
      this.url = url;
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
      sockets.push(this);
    }
    send(data) {
      this.sent.push(data);
    }
    close() {
      if (this.readyState === 1 && this.onclose) this.onclose();
      this.readyState = 3;
    }
    // Test helpers:
    open() {
      this.readyState = 1;
      if (this.onopen) this.onopen();
    }
    deliver(data) {
      if (this.onmessage) this.onmessage({ data });
    }
  }
  const previous = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket;
  return {
    sockets,
    restore() {
      globalThis.WebSocket = previous;
    },
  };
}

function makeHost(overrides = {}) {
  const calls = { stopBridgeRuns: 0, started: [], stopped: [] };
  return {
    calls,
    getSettings: overrides.getSettings ?? (async () => ({ bridge: { enabled: true, url: 'ws://127.0.0.1:7877', token: 'tok' } })),
    listSessions: overrides.listSessions ?? (() => []),
    onStartTask: async (p) => {
      calls.started.push(p);
      return { ok: true, data: {} };
    },
    onStopTask: async (p) => {
      calls.stopped.push(p);
      return { ok: true, data: {} };
    },
    onGetState: async () => ({ ok: true, data: {} }),
    stopBridgeRuns: () => {
      calls.stopBridgeRuns += 1;
    },
    onBridgeFrame: () => {},
    onBridgeConnected: (send) => {
      calls.sender = send;
    },
  };
}

test('validatedUrl accepts only ws://127.0.0.1:<port>', () => {
  assert.equal(validatedUrl('ws://127.0.0.1:7877'), 'ws://127.0.0.1:7877/');
  assert.equal(validatedUrl('ws://127.0.0.1:7877/ws'), 'ws://127.0.0.1:7877/ws');
  assert.equal(validatedUrl('ws://localhost:7877'), null, 'localhost is ambiguous (IPv6 dual stack)');
  assert.equal(validatedUrl('ws://0.0.0.0:7877'), null);
  assert.equal(validatedUrl('wss://127.0.0.1:7877'), null, 'the bridge speaks plain ws on loopback');
  assert.equal(validatedUrl('https://127.0.0.1:7877'), null);
  assert.equal(validatedUrl('ws://evil.example:7877'), null);
  assert.equal(validatedUrl('ws://127.0.0.1'), null, 'no port');
  assert.equal(validatedUrl('not a url'), null);
});

test('sync connects when enabled and sends hello with the token on the URL', async () => {
  const fc = fakeChrome({ storage: true, alarms: true });
  const restoreChrome = fc.install();
  const fakeWs = installFakeWebSocket();
  let client;
  try {
    const host = makeHost();
    client = new BridgeClient(host);
    await client.sync();
    assert.equal(fakeWs.sockets.length, 1);
    const socket = fakeWs.sockets[0];
    assert.ok(socket.url.includes('ws://127.0.0.1:7877'), socket.url);
    assert.ok(socket.url.includes('token=tok'), 'the token rides the query');

    socket.open();
    assert.ok(client.isConnected());
    const hello = socket.sent.map((s) => JSON.parse(s)).find((f) => f.type === 'hello');
    assert.ok(hello, 'hello was sent on open');
    assert.equal(hello.payload.proto, 1);
    assert.ok(Array.isArray(hello.payload.sessions));
  } finally {
    if (client) client.dispose();
    fakeWs.restore();
    restoreChrome();
  }
});

test('sync disconnects when the setting turns off and clears the alarm', async () => {
  const fc = fakeChrome({ storage: true, alarms: true });
  const restoreChrome = fc.install();
  const fakeWs = installFakeWebSocket();
  let client;
  try {
    let bridge = { enabled: true, url: 'ws://127.0.0.1:7877', token: 'tok' };
    const host = makeHost({ getSettings: async () => ({ bridge }) });
    client = new BridgeClient(host);
    await client.sync();
    const socket = fakeWs.sockets[0];
    socket.open();
    assert.ok(client.isConnected());
    // The alarm was created while enabled (fakeChrome API calls settle asynchronously).
    await fc.settle();
    assert.ok(fc.alarms.list().some((a) => a.name === 'tarka_bridge'), 'the alarm exists while enabled');

    bridge = { enabled: false, url: 'ws://127.0.0.1:7877', token: 'tok' };
    await client.sync();
    assert.equal(client.isConnected(), false);
    await fc.settle();
    assert.equal(fc.alarms.list().some((a) => a.name === 'tarka_bridge'), false, 'the alarm is cleared when disabled');
  } finally {
    if (client) client.dispose();
    fakeWs.restore();
    restoreChrome();
  }
});

test('a bridge-started run is stopped when the socket closes mid-run; the alarm exists while enabled', async () => {
  const fc = fakeChrome({ storage: true, alarms: true });
  const restoreChrome = fc.install();
  const fakeWs = installFakeWebSocket();
  let client;
  try {
    const host = makeHost();
    client = new BridgeClient(host);
    await client.sync();
    const socket = fakeWs.sockets[0];
    socket.open();
    assert.ok(client.isConnected());
    assert.ok(fc.alarms.list().some((a) => a.name === 'tarka_bridge'), 'the reconnect alarm is registered while enabled');

    socket.close();
    assert.equal(host.calls.stopBridgeRuns, 1, 'bridge-sourced runs are stopped on disconnect');
    assert.equal(client.isConnected(), false);
  } finally {
    if (client) client.dispose();
    fakeWs.restore();
    restoreChrome();
  }
});

test('bridge requests are answered as result frames with the request id', async () => {
  const fc = fakeChrome({ storage: true, alarms: true });
  const restoreChrome = fc.install();
  const fakeWs = installFakeWebSocket();
  let client;
  try {
    const host = makeHost();
    client = new BridgeClient(host);
    await client.sync();
    const socket = fakeWs.sockets[0];
    socket.open();

    socket.deliver(JSON.stringify({ v: 1, type: 'start_task', id: 'm1', payload: { runId: 'r1', prompt: 'do a thing', autoApprove: true } }));
    await new Promise((r) => setTimeout(r, 10));
    const reply = socket.sent.map((s) => JSON.parse(s)).find((f) => f.type === 'result' && f.id === 'm1');
    assert.ok(reply, 'a result frame came back');
    assert.equal(reply.payload.ok, true);
    assert.deepEqual(host.calls.started[0], { runId: 'r1', prompt: 'do a thing', autoApprove: true });
  } finally {
    if (client) client.dispose();
    fakeWs.restore();
    restoreChrome();
  }
});

test('a malformed or unknown frame is ignored, not thrown on', async () => {
  const fc = fakeChrome({ storage: true, alarms: true });
  const restoreChrome = fc.install();
  const fakeWs = installFakeWebSocket();
  let client;
  try {
    const host = makeHost();
    client = new BridgeClient(host);
    await client.sync();
    const socket = fakeWs.sockets[0];
    socket.open();
    assert.doesNotThrow(() => {
      socket.deliver('not json');
      socket.deliver(JSON.stringify({ v: 9, type: 'ping', id: null, payload: {} }));
      socket.deliver(JSON.stringify({ v: 1, type: 'mystery', id: null, payload: {} }));
    });
  } finally {
    if (client) client.dispose();
    fakeWs.restore();
    restoreChrome();
  }
});
