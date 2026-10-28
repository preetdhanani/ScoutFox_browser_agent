import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_DEPTH, overDepthRanges, parseHtml } from '../../src/background/research/htmlDocument.ts';
import { htmlToText } from '../../src/background/research/htmlText.ts';

const MB2 = 2 * 1024 * 1024;

/** The depth of the deepest element in the parsed tree. */
function treeDepth(html: string): number {
  let max = 0;
  const todo: Array<[any, number]> = [[parseHtml(html), 0]];
  while (todo.length) {
    const [node, depth] = todo.pop() as [any, number];
    if (depth > max) max = depth;
    for (const child of node.childNodes ?? []) todo.push([child, depth + 1]);
  }
  return max;
}

test('a page under the depth cap is parsed as it is: nothing is cut', () => {
  assert.deepEqual(overDepthRanges('<div><p>a<div>b</div></p></div>'), []);
  // Implied end tags are followed: 2,000 unclosed <p>, <li> or <dd> are siblings, not nesting.
  for (const tag of ['p', 'li', 'dd']) assert.deepEqual(overDepthRanges(`<ul><dl>${`<${tag}>x`.repeat(2000)}</dl></ul>`), [], tag);
  assert.deepEqual(overDepthRanges('<p>x<div>y</div>'.repeat(2000)), []);
  // A <div> inside a script string or an attribute is not an element.
  assert.deepEqual(overDepthRanges(`<script>${'"<div>"'.repeat(2000)}</script><p title="${'<div>'.repeat(2000)}">x</p>`), []);
});

test('nesting deeper than the cap is flattened, and the text inside is kept', () => {
  const html = `${'<div>'.repeat(MAX_DEPTH + 300)}deep text${'</div>'.repeat(MAX_DEPTH + 300)}<p>after</p>`;
  assert.ok(treeDepth(html) <= MAX_DEPTH + 4, `tree depth ${treeDepth(html)}`);
  assert.equal(htmlToText(html), 'deep text\nafter');
});

test('2 MB of hostile nesting parses in linear time (no element costs more than the cap)', () => {
  const hostile: Record<string, string> = {
    'nested div': '<div>'.repeat(MB2 / 5),
    'nested table': '<table><tr><td>'.repeat(MB2 / 15),
    'nested list': '<ul><li><ol><li>'.repeat(MB2 / 16),
    'nested inline': '<b><a><font>'.repeat(MB2 / 12),
    'nested svg': '<svg><g>'.repeat(MB2 / 8),
    'span then div': '<span><div>'.repeat(MB2 / 11)
  };
  for (const [name, html] of Object.entries(hostile)) {
    const start = performance.now();
    htmlToText(html);
    const ms = performance.now() - start;
    // About 0.2 s on a laptop; without the cap the first case alone runs for minutes.
    assert.ok(ms < 3000, `${name}: ${Math.round(ms)} ms`);
  }
});

test('only htmlDocument.ts imports parse5, so the parser stays behind one small API', () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|js|mjs)$/.test(name)) files.push(path);
    }
  };
  walk('src');
  const importers = files.filter((f) => /from ['"]parse5['"]/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(importers, [join('src', 'background', 'research', 'htmlDocument.ts')]);
});
