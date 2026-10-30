/**
 * Every message the background sends a page names its frame. Once embedded frames run a script of
 * their own (the frame agent), a message without a frameId goes to every frame of the tab and the
 * first answer wins: a child frame could answer HIDE_AGENT_UI for the top page. So each call passes
 * TOP_FRAME, or the frame or document it means.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../../src/background');

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []));
}

test('every chrome.tabs.sendMessage call in the background names its frame', () => {
  const unpinned: string[] = [];
  let calls = 0;
  for (const file of files(ROOT)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const match of src.matchAll(/chrome\.tabs\.sendMessage\(/g)) {
      calls++;
      // The call up to its callback: the frame argument comes before it.
      const call = src.slice(match.index, src.indexOf('=>', match.index));
      if (!/TOP_FRAME|options/.test(call)) unpinned.push(`${path.relative(ROOT, file)}: ${call.replace(/\s+/g, ' ').slice(0, 120)}`);
    }
  }
  assert.ok(calls >= 6, `expected the known calls, found ${calls}`);
  assert.deepEqual(unpinned, []);
});
