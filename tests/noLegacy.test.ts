/**
 * Permanently guards against reintroduction of legacy files, legacy identifiers,
 * and preserves the test count monotonic floor.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const THIS_FILE = fileURLToPath(import.meta.url);

function walk(dir: string, extensions: string[] = ['.ts', '.js', '.mjs', '.json', '.html']): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
      results.push(...walk(full, extensions));
    } else if (entry.isFile()) {
      if (extensions.some((ext) => entry.name.endsWith(ext))) {
        results.push(full);
      }
    }
  }
  return results;
}

test('1. legacy files and background directory do not exist on disk', () => {
  const legacyPaths = [
    path.join(ROOT, 'background', 'agentEngine.js'),
    path.join(ROOT, 'background', 'apiClients.js'),
    path.join(ROOT, 'background', 'background.js'),
    path.join(ROOT, 'background'),
    path.join(ROOT, 'content', 'net-recorder.js'),
    path.join(ROOT, 'content', 'domCompressor.js'),
    path.join(ROOT, 'content', 'actionExecutor.js'),
    path.join(ROOT, 'tests', 'fixtures', 'legacy-system-prompt.txt')
  ];
  for (const p of legacyPaths) {
    assert.equal(fs.existsSync(p), false, `legacy path must not exist: ${path.relative(ROOT, p)}`);
  }
});

test('2. no occurrences of AgentEngine identifier in src, sidepanel, or tests', () => {
  const dirs = ['src', 'sidepanel', 'tests'].map((d) => path.join(ROOT, d));
  const files = dirs.flatMap((d) => walk(d)).filter((f) => f !== THIS_FILE && !f.includes('/tests/e2e/node_modules/'));
  const violations: string[] = [];

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    // Match whole-word AgentEngine identifier (not MockAgentEngine)
    if (/\bAgentEngine\b/.test(content)) {
      violations.push(path.relative(ROOT, file));
    }
  }
  assert.deepEqual(violations, [], 'no occurrences of AgentEngine identifier allowed');
});

test('3. no occurrences of activeEngineKind or runtime reads of settings.engine', () => {
  const dirs = ['src', 'sidepanel', 'tests'].map((d) => path.join(ROOT, d));
  const files = dirs.flatMap((d) => walk(d)).filter((f) =>
    f !== THIS_FILE &&
    !f.endsWith('src/shared/storage.ts') &&
    !f.endsWith('tests/shared/storageEngineMigration.test.ts') &&
    !f.includes('/tests/e2e/node_modules/')
  );
  const violations: string[] = [];

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    if (/\bactiveEngineKind\b/.test(content) || /settings\.engine\b/.test(content)) {
      violations.push(path.relative(ROOT, file));
    }
  }
  assert.deepEqual(violations, [], 'no activeEngineKind or settings.engine reads allowed');
});

test('4. no imports referencing background/ or ../background/ in src or tests', () => {
  const dirs = ['src', 'tests'].map((d) => path.join(ROOT, d));
  const files = dirs.flatMap((d) => walk(d)).filter((f) => f !== THIS_FILE && !f.includes('/tests/e2e/node_modules/'));
  const violations: string[] = [];

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    // Match import statements referencing background/ (not src/background/)
    const importRegex = /(?:import|from)\s+['"][^'"]*?(?<!src\/)background\/(?:background\.js|agentEngine\.js|apiClients\.js|sw\.js)?['"]/g;
    if (importRegex.test(content)) {
      violations.push(path.relative(ROOT, file));
    }
  }
  assert.deepEqual(violations, [], 'no imports referencing root background/ folder');
});

test('5. tests/test-count-floor.json floor is valid and enforced by npm run check:tests', () => {
  const floorFile = path.join(ROOT, 'tests', 'test-count-floor.json');
  assert.ok(fs.existsSync(floorFile), 'tests/test-count-floor.json must exist');
  const data = JSON.parse(fs.readFileSync(floorFile, 'utf8'));
  assert.equal(typeof data.floor, 'number', 'floor must be a number');
  assert.ok(data.floor >= 3257, `floor (${data.floor}) must be >= 3257`);
  // The floor used to be decoration: nothing compared it to the real count
  // (BUG-47). The checker parses the node --test summary and fails on a drop;
  // these asserts keep it wired.
  const checker = fs.readFileSync(path.join(ROOT, 'scripts', 'checkTestCount.mjs'), 'utf8');
  assert.match(checker, /# tests (\d+)/, 'the checker must parse the node --test summary');
  assert.match(checker, /process\.exit\(1\)/, 'the checker must fail when the count drops');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['check:tests'], 'node scripts/checkTestCount.mjs', 'the floor check must stay wired into npm scripts');
});
