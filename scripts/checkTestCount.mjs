#!/usr/bin/env node
// Enforces the test-count floor in tests/test-count-floor.json (BUG-47).
//
// The floor file used to be pure decoration: nothing compared its number to
// the real suite, so a refactor that deleted a hundred tests still passed
// while the file looked like protection. This script runs the same suite npm
// test runs, parses the node --test summary, and fails when the count drops
// below the floor.
//
// Usage:
//   node scripts/checkTestCount.mjs             fail if the count < floor
//   node scripts/checkTestCount.mjs --update    also raise the floor to the
//                                               actual count (never lowers it)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FLOOR_FILE = path.join(ROOT, 'tests', 'test-count-floor.json');

const update = process.argv.includes('--update');

const res = spawnSync(
  'node',
  ['--test', '--test-reporter=tap', 'tests/**/*.test.js', 'tests/**/*.test.ts'],
  { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 * 1024 * 1024 }
);

// TAP summary lines: "# tests 3350", "# pass 3349", "# fail 1".
const tap = `${res.stdout}\n${res.stderr}`;
const match = tap.match(/^# tests (\d+)\s*$/m);
if (!match) {
  console.error('checkTestCount: could not find "# tests <n>" in the node --test summary.');
  console.error(tap.slice(-2000));
  process.exit(2);
}
const actual = Number(match[1]);

const floorData = JSON.parse(fs.readFileSync(FLOOR_FILE, 'utf8'));
const floor = Number(floorData.floor);
if (!Number.isFinite(floor)) {
  console.error(`checkTestCount: ${path.relative(ROOT, FLOOR_FILE)} has no numeric "floor".`);
  process.exit(2);
}

if (actual < floor) {
  console.error(`checkTestCount: FAILED - the suite has ${actual} tests, below the floor of ${floor}.`);
  console.error('A change deleted tests. Restore them or consciously lower the floor in tests/test-count-floor.json.');
  process.exit(1);
}

if (update && actual > floor) {
  fs.writeFileSync(FLOOR_FILE, `${JSON.stringify({ floor: actual }, null, 2)}\n`);
  console.log(`checkTestCount: floor raised ${floor} -> ${actual}`);
} else if (actual > floor) {
  console.log(`checkTestCount: ${actual} tests (floor ${floor}). Run "npm run check:tests -- --update" to raise the floor.`);
} else {
  console.log(`checkTestCount: ${actual} tests, floor ${floor} - ok.`);
}
process.exit(0);
