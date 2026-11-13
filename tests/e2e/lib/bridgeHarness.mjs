/**
 * The bridge harness for the smoke run: spawns the real bridge process (bridge/bridge.mjs),
 * configures the extension to connect to it, and speaks MCP to its stdio.
 *
 * The bridge and its dependencies live outside tests/e2e (bridge/, with its own package.json),
 * so nothing of the harness enters dist/ or the shipped zip - the bridge is a companion tool,
 * not part of the extension.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(dirname(dirname(HERE))); // tests/e2e/lib -> repo root
const BRIDGE_ENTRY = join(REPO, 'bridge', 'bridge.mjs');
const BRIDGE_WS = join(REPO, 'bridge', 'node_modules', 'ws', 'index.js');

/** Spawn the bridge with an ephemeral port and a throwaway token file. */
export async function startBridgeForTest() {
  if (!existsSync(BRIDGE_ENTRY)) throw new Error(`the bridge entry is missing: ${BRIDGE_ENTRY}`);
  if (!existsSync(BRIDGE_WS)) throw new Error('the bridge dependencies are not installed. Run: cd bridge && npm install');
  const token = 'e2etok-' + Math.random().toString(36).slice(2, 12).padEnd(12, 'x') + Math.random().toString(36).slice(2, 10);
  const tmp = mkdtempSync(join(tmpdir(), 'tarka-e2e-bridge-'));
  writeFileSync(join(tmp, 'bridge.json'), JSON.stringify({ token }));
  const child = spawn(process.execPath, [BRIDGE_ENTRY, '--port=0', `--token-file=${join(tmp, 'bridge.json')}`], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stderr = [];
  // The stderr log survives the run (the temp dir is deleted on stop): it is the only place
  // the bridge's view of the MCP arguments and the start reply can be inspected afterwards.
  const stderrFile = join(tmpdir(), 'tarka-e2e-bridge-stderr.log');
  try { rmSync(stderrFile, { force: true }); } catch { /* best effort */ }
  child.stderr.on('data', (d) => {
    const s = d.toString();
    stderr.push(s);
    try { appendFileSync(stderrFile, s); } catch { /* best effort */ }
  });
  child.on('exit', (code) => stderr.push(`[bridge exited: ${code}]`));
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the bridge did not report its port. stderr: ${stderr.join('')}`)), 15_000);
    const check = () => {
      const m = stderr.join('').match(/listening on 127\.0\.0\.1:(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      } else if (!child.exitCode) {
        setTimeout(check, 50);
      }
    };
    check();
  });
  return {
    child,
    port,
    token,
    stderr,
    stop() {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}

/** The MCP request lines the harness writes to the bridge's stdin. */
export function mcpInitialize() {
  return JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'tarka-e2e', version: '0' } } }) + '\n'
    + JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n';
}

export function mcpCall(id, name, params, progressToken = null) {
  const request = { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: params } };
  if (progressToken !== null) request.params._meta = { progressToken };
  return JSON.stringify(request) + '\n';
}

/**
 * Talk MCP to the bridge: initialize, call tarka_run_task, and collect the streamed
 * notifications until the tool call answers. Returns { reply, notifications }.
 */
export async function mcpRunTask(bridge, { task, timeoutMs, startUrl, progressToken = 'e2e-progress' }) {
  const notifications = [];
  bridge.child.stdin.write(mcpInitialize());
  bridge.child.stdin.write(mcpCall(1, 'tarka_run_task', { task, ...(timeoutMs ? { timeoutMs } : {}), ...(startUrl ? { startUrl } : {}) }, progressToken));
  return await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`the bridge did not answer tarka_run_task in time. stderr: ${bridge.stderr.join('')}`)), timeoutMs + 60_000);
    const onOut = (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.method === 'notifications/progress') notifications.push(msg.params);
        if (msg.id === 1) {
          clearTimeout(timer);
          bridge.child.stdout.off('data', onOut);
          resolve({ reply: msg, notifications });
        }
      }
    };
    bridge.child.stdout.on('data', onOut);
  });
}
