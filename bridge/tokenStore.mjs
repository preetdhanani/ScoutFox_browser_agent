/**
 * The shared bridge token: kept in ~/.tarka/bridge.json (mode 0600) so it survives across
 * bridge restarts and the extension only has to be configured once. Never printed to stdout
 * (the MCP stream); callers log it to stderr themselves on first creation.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export function tokenFilePath(override = null) {
  return override ?? join(homedir(), '.tarka', 'bridge.json');
}

/** Read the persisted token, creating one on first run. Returns { token, created }. */
export function loadOrCreateToken(overridePath = null) {
  const path = tokenFilePath(overridePath);
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed && typeof parsed.token === 'string' && parsed.token.length >= 16) {
      return { token: parsed.token, created: false };
    }
  } catch {
    // Missing or unreadable: fall through and create a fresh one.
  }
  const token = randomBytes(24).toString('base64url');
  writeToken(path, token);
  return { token, created: true };
}

function writeToken(path, token) {
  mkdirSync(dirname2(path), { recursive: true });
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify({ token }, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
  try {
    // An existing file keeps its old mode through rename; enforce 0600 either way.
    if ((statSync(path).mode & 0o777) !== 0o600) chmodSync(path, 0o600);
  } catch {
    // Best effort: the rename already created it with 0600 on a fresh file.
  }
}

function dirname2(p) {
  const idx = p.lastIndexOf('/');
  return idx > 0 ? p.slice(0, idx) : '.';
}
