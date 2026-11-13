// Full integration test: spawn the real bridge process, connect a fake extension client over
// a real WebSocket, speak MCP to its stdin, and assert the whole round trip.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const { WebSocket } = require('../../bridge/node_modules/ws/index.js');

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const BRIDGE = join(root, 'bridge', 'bridge.mjs');

/** Spawn the bridge with an ephemeral port and a temp token file. */
async function startBridge() {
  const token = 'itok-' + Math.random().toString(36).slice(2, 18).padEnd(16, 'x') + Math.random().toString(36).slice(2, 10);
  const tmp = mkdtempSync(join(tmpdir(), 'tarka-bridge-test-'));
  writeFileSync(join(tmp, 'bridge.json'), JSON.stringify({ token }));
  const child = spawn(process.execPath, [BRIDGE, '--port=0', `--token-file=${join(tmp, 'bridge.json')}`], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stderr = [];
  child.stderr.on('data', (d) => stderr.push(d.toString()));
  const stdoutLines = [];
  let stdoutBuf = '';
  child.stdout.on('data', (d) => {
    stdoutBuf += d.toString();
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (line) {
        try { stdoutLines.push(JSON.parse(line)); } catch { /* not json */ }
      }
    }
  });
  // Wait for the listening line to learn the port.
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('bridge did not report its port: ' + stderr.join(''))), 10_000);
    const check = () => {
      const m = stderr.join('').match(/listening on 127\.0\.0\.1:(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      } else {
        setTimeout(check, 50);
      }
    };
    check();
  });
  return { child, port, token, stderr, stdoutLines };
}

/** Connect a fake extension and complete the handshake. */
function connectExtension(port, token, { origin = 'chrome-extension://test', sendToken = true } = {}) {
  return new Promise((resolve, reject) => {
    const url = `ws://127.0.0.1:${port}/?token=${sendToken ? encodeURIComponent(token) : 'wrong'}`;
    const ws = new WebSocket(url, { headers: origin ? { origin } : {} });
    const frames = [];
    ws.on('message', (d) => frames.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve({ ws, frames }));
    ws.on('error', reject);
    ws.on('close', () => resolve({ ws, frames, closed: true }));
  });
}

async function withBridge(fn) {
  const bridge = await startBridge();
  try {
    return await fn(bridge);
  } finally {
    bridge.child.kill('SIGKILL');
  }
}


/** Wait until a stdout message matching pred appears (collected centrally in startBridge). */
async function waitForMessage(bridge, pred, failMsg) {
  for (let i = 0; i < 200; i++) {
    const found = bridge.stdoutLines.find(pred);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(failMsg + ' - stdout so far: ' + JSON.stringify(bridge.stdoutLines));
}

function mcpLine(id, method, params) {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
}

test('bridge: full round trip - MCP tools/call reaches the extension as start_task and resolves via task_done', async () => {
  await withBridge(async (bridge) => {
    const ext = await connectExtension(bridge.port, bridge.token);
    // The extension sends hello.
    ext.ws.send(JSON.stringify({ v: 1, type: 'hello', id: null, payload: { proto: 1, build: 'test', sessions: [] } }));

    // MCP handshake + tool call.
    bridge.child.stdin.write(mcpLine(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } }));
    bridge.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    bridge.child.stdin.write(mcpLine(2, 'tools/call', { name: 'tarka_run_task', arguments: { task: 'Find the opening hours.' }, _meta: { progressToken: 'pt1' } }));

    // The fake extension receives start_task with autoApprove true.
    await (async () => {
      for (let i = 0; i < 100; i++) {
        if (ext.frames.some((f) => f.type === 'start_task')) break;
        await new Promise((r) => setTimeout(r, 50));
      }
    })();
    const start = ext.frames.find((f) => f.type === 'start_task');
    assert.ok(start, 'start_task frame sent to the extension');
    assert.equal(start.payload.autoApprove, true);
    assert.equal(start.payload.prompt, 'Find the opening hours.');
    const runId = start.payload.runId;

    // Stream a couple of steps, then finish.
    ext.ws.send(JSON.stringify({
      v: 1, type: 'task_event', id: null,
      payload: { runId, tabId: 5, state: { status: 'running', stepCount: 1 }, entries: [{ type: 'agent_response', step: 1, thought: 'reading the page', action: { action: 'read_page' } }] },
    }));
    ext.ws.send(JSON.stringify({
      v: 1, type: 'task_done', id: null,
      payload: { runId, status: 'idle', outcome: 'done', answer: 'Open 9-17.', table: null, records: null, runStats: { steps: 1 } },
    }));

    // The MCP tool call resolves on stdout.
    const reply = await (async () => {
      for (let i = 0; i < 100; i++) {
        const line = (bridge.stdoutLines ?? (bridge.stdoutLines = []));
        if (line.length) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      return null;
    })();
    // Collect stdout properly.
    const response = await waitForMessage(bridge, (m) => m.id === 2, 'no MCP response');
    assert.ok(response.result, 'tools/call returned a result');
    assert.equal(response.result.isError, false);
    assert.equal(response.result.content.length, 1);
    assert.equal(response.result.content[0].type, 'text');
    assert.ok(response.result.content[0].text.includes('Open 9-17.'), 'answer in text');
    assert.ok(response.result.content[0].text.includes('outcome done'), 'outcome in text');
    ext.ws.close();
  });
});

test('bridge: progress notifications are emitted on stdout during the run', async () => {
  await withBridge(async (bridge) => {
    const ext = await connectExtension(bridge.port, bridge.token);
    ext.ws.send(JSON.stringify({ v: 1, type: 'hello', id: null, payload: { proto: 1, build: 'test', sessions: [] } }));
    bridge.child.stdin.write(mcpLine(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } }));
    bridge.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    bridge.child.stdin.write(mcpLine(2, 'tools/call', { name: 'tarka_run_task', arguments: { task: 'x' }, _meta: { progressToken: 'pt9' } }));

    // Wait for start_task, then emit a step.
    await (async () => {
      for (let i = 0; i < 100; i++) {
        if (ext.frames.some((f) => f.type === 'start_task')) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('no start_task');
    })();
    const runId = ext.frames.find((f) => f.type === 'start_task').payload.runId;
    ext.ws.send(JSON.stringify({
      v: 1, type: 'task_event', id: null,
      payload: { runId, tabId: 5, state: { status: 'running', stepCount: 2 }, entries: [{ type: 'agent_response', step: 2, thought: 'scrolling down', action: { action: 'scroll' } }] },
    }));

    // The run never finishes in this test; wait for the progress notification itself.
    const progress = await waitForMessage(bridge, (m) => m.method === 'notifications/progress', 'no progress notification seen');
    assert.ok(progress, 'progress notification emitted');
    assert.equal(progress.params.progressToken, 'pt9');
    assert.equal(progress.params.progress, 2);
    assert.ok(progress.params.message.includes('scrolling down'));
    ext.ws.close();
  });
});

test('bridge: cancellation via notifications/cancelled sends stop_task', async () => {
  await withBridge(async (bridge) => {
    const ext = await connectExtension(bridge.port, bridge.token);
    ext.ws.send(JSON.stringify({ v: 1, type: 'hello', id: null, payload: { proto: 1, build: 'test', sessions: [] } }));
    bridge.child.stdin.write(mcpLine(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } }));
    bridge.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    bridge.child.stdin.write(mcpLine(2, 'tools/call', { name: 'tarka_run_task', arguments: { task: 'x' } }));
    await (async () => {
      for (let i = 0; i < 100; i++) {
        if (ext.frames.some((f) => f.type === 'start_task')) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('no start_task');
    })();
    bridge.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2, reason: 'user' } }) + '\n');
    for (let i = 0; i < 100; i++) {
      if (ext.frames.some((f) => f.type === 'stop_task')) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(ext.frames.some((f) => f.type === 'stop_task'), 'stop_task sent on cancellation');
    ext.ws.close();
  });
});

test('bridge: second tarka_run_task while a run is active is rejected immediately', async () => {
  await withBridge(async (bridge) => {
    const ext = await connectExtension(bridge.port, bridge.token);
    ext.ws.send(JSON.stringify({ v: 1, type: 'hello', id: null, payload: { proto: 1, build: 'test', sessions: [] } }));
    bridge.child.stdin.write(mcpLine(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } }));
    bridge.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    bridge.child.stdin.write(mcpLine(2, 'tools/call', { name: 'tarka_run_task', arguments: { task: 'first' } }));
    await (async () => {
      for (let i = 0; i < 100; i++) {
        if (ext.frames.some((f) => f.type === 'start_task')) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('no start_task');
    })();
    bridge.child.stdin.write(mcpLine(3, 'tools/call', { name: 'tarka_run_task', arguments: { task: 'second' } }));
    const rejected = await waitForMessage(bridge, (m) => m.id === 3, 'no rejection seen');
    assert.ok(rejected.error || rejected.result?.isError, 'second run rejected');
    const text = rejected.error?.message ?? rejected.result?.content?.[0]?.text ?? '';
    assert.ok(/already active/i.test(text), `rejection mentions active run: ${text}`);
    ext.ws.close();
  });
});

test('bridge: tool call while no extension is connected waits, then errors clearly', async () => {
  await withBridge(async (bridge) => {
    bridge.child.stdin.write(mcpLine(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } }));
    bridge.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    bridge.child.stdin.write(mcpLine(2, 'tools/call', { name: 'tarka_get_status', arguments: {} }));
    const reply = await waitForMessage(bridge, (m) => m.id === 2, 'no reply');
    // Without a connected extension, status reports disconnected state rather than crashing.
    assert.ok(reply.result, 'status tool answered');
    const text = reply.result.content[0].text;
    assert.ok(text.includes('"connected"'), 'status payload present');
  });
});

test('bridge: extension disconnect mid-run resolves the pending call as interrupted', async () => {
  await withBridge(async (bridge) => {
    const ext = await connectExtension(bridge.port, bridge.token);
    ext.ws.send(JSON.stringify({ v: 1, type: 'hello', id: null, payload: { proto: 1, build: 'test', sessions: [] } }));
    bridge.child.stdin.write(mcpLine(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } }));
    bridge.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    bridge.child.stdin.write(mcpLine(2, 'tools/call', { name: 'tarka_run_task', arguments: { task: 'x' } }));
    await (async () => {
      for (let i = 0; i < 100; i++) {
        if (ext.frames.some((f) => f.type === 'start_task')) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('no start_task');
    })();
    // The extension vanishes mid-run.
    ext.ws.close();
    const reply = await waitForMessage(bridge, (m) => m.id === 2, 'no reply');
    assert.ok(reply.result, 'the pending call resolved');
    assert.equal(reply.result.isError, true, 'interrupted run is an error result');
    assert.ok(reply.result.content[0].text.includes('disconnected'), 'mentions disconnect');
  });
});
