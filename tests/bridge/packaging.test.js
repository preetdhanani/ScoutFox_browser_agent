// Packaging guard: the bridge companion process and the test harness must never enter the
// shipped extension (dist/ or the zip). The build only packs src/, sidepanel/, content/ and
// public/; this test fails if someone wires bridge/ or tests/ into the build.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

test('public/ contains no bridge files', () => {
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
  const files = walk(join(root, 'public')).map((p) => p.toLowerCase());
  const offenders = files.filter((p) => p.includes('bridge'));
  assert.deepEqual(offenders, [], 'bridge files must not be in public/');
});

test('vite.config.mjs lists no bridge entry', () => {
  const cfg = readFileSync(join(root, 'vite.config.mjs'), 'utf8');
  assert.equal(/bridge/i.test(cfg), false, 'vite config must not reference the bridge');
});

test('dist/ (if present) contains no bridge or tests files', () => {
  const dist = join(root, 'dist');
  if (!existsSync(dist)) return;
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
  const files = walk(dist).map((p) => p.toLowerCase());
  const offenders = files.filter((p) => p.includes('/bridge/') || p.includes('tests/'));
  assert.deepEqual(offenders, [], 'dist/ must not contain bridge or test files');
});
