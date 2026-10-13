import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONTENT_SCRIPT_FILES, NET_RECORDER_FILE } from '../../src/background/browser/contentFiles.ts';

test('contentFiles: CONTENT_SCRIPT_FILES and NET_RECORDER_FILE match public/manifest.json', () => {
  const manifestPath = join(process.cwd(), 'public', 'manifest.json');
  const manifestRaw = readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestRaw);

  assert.ok(Array.isArray(manifest.content_scripts));
  assert.ok(manifest.content_scripts.length >= 2);

  // First content script: isolated world content scripts
  const isolatedSection = manifest.content_scripts[0];
  assert.deepEqual(
    CONTENT_SCRIPT_FILES,
    isolatedSection.js,
    'CONTENT_SCRIPT_FILES must match public/manifest.json content_scripts[0].js in exact order'
  );

  // Second content script: MAIN world net-recorder
  const mainSection = manifest.content_scripts[1];
  assert.equal(mainSection.world, 'MAIN');
  assert.deepEqual(
    [NET_RECORDER_FILE],
    mainSection.js,
    'NET_RECORDER_FILE must match public/manifest.json content_scripts[1].js'
  );
});
