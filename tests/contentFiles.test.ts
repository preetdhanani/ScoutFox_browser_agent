import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ISOLATED_CONTENT_FILES, MAIN_CONTENT_FILES, ALL_FRAMES_ISOLATED_FILES, CONTENT_SCRIPT_FILES, NET_RECORDER_FILE, NET_RELAY_FILE } from '../src/background/browser/contentFiles.ts';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

test('contentFiles.ts aliases match primary lists', () => {
  assert.deepEqual(CONTENT_SCRIPT_FILES, ISOLATED_CONTENT_FILES);
  assert.equal(NET_RECORDER_FILE, MAIN_CONTENT_FILES[0]);
  assert.equal(NET_RELAY_FILE, ALL_FRAMES_ISOLATED_FILES[0]);
});

test('public/manifest.json content_scripts agree with contentFiles.ts lists', () => {
  const manifestPath = path.join(ROOT, 'public', 'manifest.json');
  assert.ok(fs.existsSync(manifestPath), 'manifest.json must exist');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  const scripts = manifest.content_scripts as Array<{ js?: string[]; world?: string }>;
  assert.ok(Array.isArray(scripts), 'manifest.content_scripts must be an array');

  const isolatedEntry = scripts.find((s) => !s.world || s.world === 'ISOLATED');
  assert.ok(isolatedEntry, 'isolated content scripts entry must exist');
  assert.deepEqual(isolatedEntry.js, [...ISOLATED_CONTENT_FILES]);

  const mainEntry = scripts.find((s) => s.world === 'MAIN');
  assert.ok(mainEntry, 'MAIN world content scripts entry must exist');
  assert.deepEqual(mainEntry.js, [...MAIN_CONTENT_FILES]);

  // The per-frame relay (BUG-45): an isolated entry injected into every frame.
  const relayEntry = scripts.find((s) => (!s.world || s.world === 'ISOLATED') && s !== isolatedEntry);
  assert.ok(relayEntry, 'the all-frames relay entry must exist');
  assert.deepEqual(relayEntry.js, [...ALL_FRAMES_ISOLATED_FILES]);
});

test('vite.config.mjs CONTENT_ENTRIES outputs agree with contentFiles.ts lists', async () => {
  // @ts-expect-error vite.config.mjs is untyped ESM
  const { CONTENT_ENTRIES } = (await import('../vite.config.mjs')) as unknown as {
    CONTENT_ENTRIES: Array<{ input: string; output: string }>;
  };
  const outputs = CONTENT_ENTRIES.map((e) => e.output);
  const expected = [...ISOLATED_CONTENT_FILES, ...MAIN_CONTENT_FILES, ...ALL_FRAMES_ISOLATED_FILES];
  assert.deepEqual(outputs.sort(), expected.sort());
});

test('dist/content files agree with contentFiles.ts when dist/content exists', () => {
  const distContent = path.join(ROOT, 'dist', 'content');
  if (!fs.existsSync(distContent)) return;

  const filesOnDisk = fs.readdirSync(distContent)
    .filter((f) => f.endsWith('.js') && !f.endsWith('.map'))
    .map((f) => `content/${f}`);

  const expected = [...ISOLATED_CONTENT_FILES, ...MAIN_CONTENT_FILES, ...ALL_FRAMES_ISOLATED_FILES];
  assert.deepEqual(filesOnDisk.sort(), expected.sort());
});
