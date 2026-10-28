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
  // The floor was 3446 when the LangGraph-era engine was the one under test. Commit 87367c0
  // replaced that engine with the MCP one and deleted the ~35k lines of tests that came with
  // it, so the floor was guarding a suite that no longer existed. It was lowered on 2026-10-20
  // to the real count of the suite that is here now, and the MCP engine's own modules each
  // have a test file of their own (tests/mcp/, tests/runner/).
  //
  // This number is a second lock on the same thing the floor file locks, so it has to move
  // with it. A lower number here than in the floor file would let the floor file be lowered
  // again and again without anybody noticing.
  const floor = data.floor;
  assert.ok(floor >= 1195, `floor (${floor}) must be >= 1195`);
  // The floor used to be decoration: nothing compared it to the real count
  // (BUG-47). The checker parses the node --test summary and fails on a drop;
  // these asserts keep it wired.
  const checker = fs.readFileSync(path.join(ROOT, 'scripts', 'checkTestCount.mjs'), 'utf8');
  assert.match(checker, /# tests (\d+)/, 'the checker must parse the node --test summary');
  assert.match(checker, /process\.exit\(1\)/, 'the checker must fail when the count drops');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['check:tests'], 'node scripts/checkTestCount.mjs', 'the floor check must stay wired into npm scripts');
  // The floor check must run in CI, not only on a developer's machine: a floor that nobody
  // checks is decoration again.
  const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(ci, /npm run check:tests/, 'the floor check must run in CI');
});

test('6. the pre-MCP action registry and the verbs no MCP tool reaches stay deleted', () => {
  // shared/ held the old engine's action registry, risk words and challenge rules; nothing read
  // them after the MCP engine replaced it. execute_js, open_window, read_network_requests and
  // browser_batch were branches of execute.ts that no tool reached, and the content script's
  // synthetic press_key was a fallback the CDP-only press_key no longer takes.
  const deletedPaths = [
    'shared',
    'src/background/browser/batch.ts',
    'src/background/browser/executeJs.ts',
    'src/background/browser/windows.ts'
  ];
  for (const rel of deletedPaths) {
    assert.equal(fs.existsSync(path.join(ROOT, rel)), false, `dead path must not come back: ${rel}`);
  }

  const banned: Array<[RegExp, string]> = [
    [/\bexecute_js\b|\bexecuteJs\b|\ballowExecuteJs\b/, 'execute_js'],
    [/\bopen_window\b|\bopenNewWindow\b/, 'open_window'],
    [/\bread_network_requests\b|\breadNetworkRequests\b/, 'read_network_requests'],
    [/\bbrowser_batch\b|\brunBatch\b|\bdoBrowserBatch\b/, 'browser_batch'],
    [/\bdoPressKey\b/, 'the synthetic doPressKey'],
    [/\bexecuteActionOnTab\b|\bsetTabAdoptedCallback\b/, 'the runner execute wiring'],
    [/shared\/(?:actions|risk|challenge-rules)\.json/, 'the shared/ registry files']
  ];
  const dirs = ['src', 'sidepanel', 'content', 'scripts'].map((d) => path.join(ROOT, d));
  const files = dirs.flatMap((d) => walk(d));
  const violations: string[] = [];
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    for (const [re, what] of banned) {
      // storage.ts drops an old stored allowExecuteJs flag on read: the one place the name may stay.
      if (what === 'execute_js' && file.endsWith(path.join('src', 'shared', 'storage.ts'))) continue;
      if (re.test(content)) violations.push(`${path.relative(ROOT, file)}: ${what}`);
    }
  }
  assert.deepEqual(violations, [], 'removed legacy verbs and helpers must not come back');

  // The worker's executeAction must not grow a branch for a verb no tool sends.
  const execute = fs.readFileSync(path.join(ROOT, 'src', 'background', 'browser', 'execute.ts'), 'utf8');
  assert.doesNotMatch(execute, /verb === '(?:execute_js|open_window|read_network_requests|browser_batch)'/);
  // The content executor has no press_key case: press_key is a trusted CDP key press or nothing.
  const actions = fs.readFileSync(path.join(ROOT, 'src', 'content', 'actions.ts'), 'utf8');
  assert.doesNotMatch(actions, /case 'press_key'|case 'keypress'|case 'browser_batch'/);
});
