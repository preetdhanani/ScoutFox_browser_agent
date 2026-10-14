/**
 * src/shared/clip.ts: the one helper every text cap goes through, so a cut text always says it was cut, how much
 * of it is shown, how big the whole is, and how to see more (silent-truncation-no-marker ticket).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { clipWithNote, cutPoint, splitIntoParts } from '../../src/shared/clip.ts';

const lines = (n: number, prefix = 'Line') => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1} of the text`).join('\n');

test('clipWithNote: a text that fits is returned unchanged', () => {
  assert.equal(clipWithNote('hello world', 50), 'hello world');
  assert.equal(clipWithNote('a'.repeat(50), 50), 'a'.repeat(50));
});

test('clipWithNote: a cut text ends with a note naming the shown and the full size and the hint', () => {
  const text = lines(100);
  const clipped = clipWithNote(text, 500, { what: 'page text', hint: 'call read_page_text to read the rest' });
  const [, shown, total] = clipped.match(/\n\[page text truncated: showing (\d+) of (\d+) characters - call read_page_text to read the rest\]$/) ?? [];
  assert.ok(shown, clipped.slice(-200));
  assert.equal(Number(total), text.length);
  assert.ok(Number(shown) <= 500);
  assert.equal(clipped.slice(0, Number(shown)), text.slice(0, Number(shown)));
});

test('clipWithNote: the cut is at a line boundary, else at a space, else hard', () => {
  const text = lines(100);
  const body = clipWithNote(text, 500).split('\n[')[0];
  assert.ok(text.startsWith(`${body}\n`), 'the cut ends a whole line');
  const words = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
  const wordBody = clipWithNote(words, 300).split('\n[')[0];
  assert.ok(words.startsWith(`${wordBody} `), 'a one-line text is cut at a space');
  const solid = 'x'.repeat(1000);
  assert.equal(clipWithNote(solid, 300).split('\n[')[0], 'x'.repeat(300));
});

test('clipWithNote: a text that is already a cut keeps the full size of the original', () => {
  const text = lines(400);
  const first = clipWithNote(text, 4500, { what: 'page text' });
  const second = clipWithNote(first, 3000, { what: 'page text', hint: 'read more' });
  assert.match(second, new RegExp(`showing \\d+ of ${text.length} characters - read more\\]$`));
  assert.equal(second.match(/truncated:/g)?.length, 1, 'one note, not two');
  // A cut text that already fits the new cap still carries the note.
  const fits = clipWithNote(first, 9000, { what: 'page text' });
  assert.match(fits, new RegExp(`showing \\d+ of ${text.length} characters\\]$`));
  // A text given with its full size (a window of a longer page) is marked even when it fits.
  assert.match(clipWithNote('short window', 100, { total: 5000 }), /\n\[text truncated: showing 12 of 5000 characters\]$/);
});

test('clipWithNote: the inline form stays on one line', () => {
  const error = `Element not interactable: ${'detail '.repeat(40)}`.trim();
  const clipped = clipWithNote(error, 80, { inline: true });
  assert.doesNotMatch(clipped, /\n/);
  assert.match(clipped, new RegExp(` \\[truncated, \\d+ of ${error.length} chars\\]$`));
  assert.ok(clipped.startsWith('Element not interactable'));
});

test('cutPoint and splitIntoParts: the parts cover the whole text at line boundaries', () => {
  const text = lines(600);
  assert.ok(cutPoint(text, 3000) <= 3000);
  const parts = splitIntoParts(text, 3000);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.end - p.start <= 3000);
  assert.equal(parts.map((p) => text.slice(p.start, p.end)).join('\n'), text);
  assert.equal(parts[0].start, 0);
  assert.equal(parts[parts.length - 1].end, text.length);
  assert.deepEqual(splitIntoParts('', 3000), [{ start: 0, end: 0 }]);
});
