/**
 * The answer text of the finish card: formatMarkdownText in sidepanel/sidepanel.js.
 *
 * The model's answer used to be shown as pre-wrapped text with **bold** and "- item" bullets.
 * That left "## Prices found" as raw hashes and a GitHub pipe table as rows of "|" (which a
 * sans-serif font makes look like a capital I). The renderer now has two parts: the legacy one,
 * untouched, for an answer without a heading or a table, and a blocks renderer (headings, pipe
 * tables, lists that hang, paragraphs) for an answer that has one.
 *
 * What these tests hold on to, in order of importance:
 *   1. Nothing the model writes ever becomes markup. Every tag in the output is one the renderer
 *      wrote, from a constant, and every character of model text is escaped. Checked on
 *      hostile text and on thousands of random documents, with a strict tokenizer rather than
 *      a search for known attack strings.
 *   2. An answer WITHOUT a heading or a table renders byte for byte as it did before. The
 *      oracle is a copy of the old function, below, compared on a corpus of more than 100
 *      answers and on random text.
 *   3. Nothing the model wrote is lost or invented: the letters and digits that go in come out.
 *   4. A 500-row table and a 50 000 character line render in milliseconds.
 *   5. The table, the heading and the list have the stylesheet rules they need (scroll inside
 *      the card, borders from the theme, hanging indent).
 *
 * How it runs: sidepanel.js is a browser module that touches window and document once at load,
 * so a small stub is enough to import it and call the pure string builders. No DOM is built.
 * What Chromium paints (the width of a wide table, the scrollbar, the heading sizes) is not
 * covered here: that needs a look in a browser.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

globalThis.window = { addEventListener() {} };
globalThis.document = { readyState: 'loading', addEventListener() {}, getElementById: () => null };

const { formatMarkdownText, hasMarkdownBlocks, legacyBullets, splitTableRow, renderFinishCard } = await import('../sidepanel/sidepanel.js');

// ---------------------------------------------------------------------------------------------
// The oracle: the function as it was before the blocks renderer, copied verbatim.
// ---------------------------------------------------------------------------------------------

function oldEscapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function oldFormatMarkdownText(text) {
  if (!text) return '';
  let str = oldEscapeHtml(text);
  str = str.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  str = str.replace(/^[\s]*[-*]\s+(.*)$/gm, '• $1');
  return str;
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** A small seeded generator: the fuzz tests are the same on every run and on every machine. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The only tags and attributes the renderer may write. A value holds letters, digits, dash and space.
const TAG = /<(\/?)(div|span|strong|table|thead|tbody|tr|th|td|ul|ol|li)((?: (?:class|role|aria-level|aria-label|aria-hidden|tabindex|scope)="[A-Za-z0-9 -]*")*)>/g;
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"' };

/**
 * The strict check behind every safety test. All allowed tags are cut out; what is left is text,
 * and text may not hold a "<", a ">" or a quote, and every "&" must start one of the four
 * entities escapeHtml writes. The tags that were cut out must also nest properly.
 * Nothing in here looks for a known attack string: anything the renderer did not write fails.
 */
function assertSafeMarkup(html, label = '') {
  const stack = [];
  html.replace(TAG, (whole, closing, name) => {
    if (closing) assert.equal(stack.pop(), name, `${label}: </${name}> closes the wrong tag in ${html.slice(0, 200)}`);
    else stack.push(name);
    return '';
  });
  assert.deepEqual(stack, [], `${label}: unclosed tags in ${html.slice(0, 200)}`);
  const text = html.replace(TAG, '');
  assert.ok(!/[<>"]/.test(text), `${label}: a raw < > or quote in the text of ${html.slice(0, 300)}`);
  for (const match of text.matchAll(/&/g)) {
    assert.ok(/^&(amp|lt|gt|quot);/.test(text.slice(match.index)), `${label}: a raw & at ${match.index} in ${text.slice(Math.max(0, match.index - 20), match.index + 20)}`);
  }
}

/** The text a reader sees: the tags cut out, the four entities turned back. */
function visibleText(html) {
  return html.replace(TAG, '').replace(/&(amp|lt|gt|quot);/g, (entity) => ENTITIES[entity]);
}

function alphanumerics(text) {
  const counts = {};
  for (const ch of text.match(/[A-Za-z0-9]/g) || []) counts[ch] = (counts[ch] || 0) + 1;
  return counts;
}

function timed(fn) {
  const start = performance.now();
  const result = fn();
  return { ms: performance.now() - start, result };
}
const FAST_MS = 500;

const classesOf = (html) => new Set([...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean));
const count = (html, needle) => html.split(needle).length - 1;

// ---------------------------------------------------------------------------------------------
// The incident answer (tests/e2e/lib/mockOllama.mjs writes the same text)
// ---------------------------------------------------------------------------------------------

const URL_A = 'http://shop-a.test:8765/shop-a.html?product=framework-laptop-16-diy-edition&configuration=ryzen7-7840hs-16gb-ddr5-512gb-nvme-windows11pro&session=3f9a1c7e5b2d4a60918e7c3b5d1f2a4e';
const FACTS_A = ['- **Price**: 1.389,00 EUR', '- **Shipping**: 6,90 EUR', '- **Delivery**: Lieferung in 3-4 Werktagen', `- **URL**: ${URL_A}`];
const FACTS_B = ['- **Price**: 1.329,00 EUR', '- **Shipping**: 4,90 EUR', '- **Delivery**: 2-3 Werktage', '- **URL**: [link removed: never opened]'];
const TABLE = ['| Source | Price | Shipping | Delivery |', '|--------|-------|----------|----------|', '| shop-a.test | 1.389,00 EUR | 6,90 EUR | Lieferung in 3-4 Werktagen |', '| shop-b.test | 1.329,00 EUR | 4,90 EUR | 2-3 Werktage |'];
const INCIDENT = ['## Prices found', '', '### shop-a.test', ...FACTS_A, '', '### shop-b.test', ...FACTS_B, '', ...TABLE].join('\n');
const INCIDENT_HONEST = ['## Prices found', '', '### shop-a.test', ...FACTS_A, '', '### shop-b.test', 'Not checked. I did not open shop-b.test, so I have no price, shipping or delivery for it.'].join('\n');

// ---------------------------------------------------------------------------------------------
// 1. An answer without a heading or a table renders as it always did
// ---------------------------------------------------------------------------------------------

/** More than 100 answers that have no heading and no table, by hand. */
const PLAIN = [
  // the incident answer, without its headings and its table
  FACTS_A.join('\n'),
  FACTS_B.join('\n'),
  ['shop-a.test', ...FACTS_A, '', 'shop-b.test', ...FACTS_B].join('\n'),
  'Not checked. I did not open shop-b.test, so I have no price, shipping or delivery for it.',
  ['shop-a.test', ...FACTS_A, '', 'shop-b.test', 'Not checked. I did not open shop-b.test, so I have no price, shipping or delivery for it.'].join('\n'),
  ['Prices found', '', 'shop-a.test', ...FACTS_A].join('\n'),
  `- **URL**: ${URL_A}`,
  URL_A,
  // prose
  'The Framework Laptop 16 costs 1.389,00 EUR at shop-a.test.',
  'One line.',
  'Two lines.\nSecond line.',
  'Paragraph one.\n\nParagraph two.\n\n\nParagraph three after two blank lines.',
  '   indented prose',
  '\tTabbed prose',
  'Trailing newline\n',
  '\nLeading newline',
  '\n\n\nOnly after blank lines',
  'CRLF line one\r\nCRLF line two\r\n',
  'Old Mac line one\rold Mac line two',
  'Unicode: Größe, Lieferung für 3-4 Werktage, 価格 ¥12,800, emoji 🙂 and a zero-width\u200bjoiner.',
  'Line separator\u2028inside and paragraph separator\u2029inside.',
  'Non-breaking\u00a0space and a no-break bullet:\u00a0- item',
  'Done.',
  'Yes',
  '0',
  '42',
  ' ',
  '  \n  ',
  // bold
  'All good **now**',
  '**Price**: 10 EUR',
  '**a** **b** **c**',
  '**unclosed bold',
  'closed **x** and **unclosed',
  '****',
  '** **',
  '**',
  '*single star* text',
  '***triple***',
  '**bold\nacross lines**',
  'Price: **1.389,00 EUR**, shipping: **6,90 EUR**.',
  // bullets, in all their forms
  '- one',
  '- one\n- two\n- three',
  '* one\n* two',
  '- **Price**: 10\n- **Shipping**: 2',
  'Intro:\n- a\n- b\nOutro.',
  'Intro:\n\n- a\n- b\n\nOutro.',
  'Intro:\n\n\n- a\n\n\n- b',
  '  - indented bullet\n    - more indented',
  '\t- tab bullet',
  '-no space after dash',
  '*no space after star',
  '-\nnext line after a bare dash',
  '- \n',
  '- a\n-\n- c',
  '* * *',
  '- - -',
  '--- not a rule',
  '---',
  '***',
  '+ plus is not a bullet',
  '• already a bullet\n• another',
  '- a\r\n- b\r\n',
  '- a\r\n\r\n- b',
  '- a\u2028- b',
  '-\u00a0nbsp after dash',
  '- -5 degrees',
  'Temperature: -5 to -10 degrees',
  'A list:\n1. first\n2. second\n3. third',
  '1) first\n2) second',
  // hashes that are not headings
  'issue #12 is open',
  'C# and F# are languages',
  '#1 ranking',
  '#hashtag',
  '#',
  '# ',
  '##',
  '####### seven hashes',
  '    # four spaces of indent is code, not a heading',
  '\t# a tab of indent',
  'price:\n#not-a-heading\n#1 too',
  '## ',
  // pipes that are not tables
  'a | b | c',
  '| a | b |',
  '|',
  '||',
  '|---|---|',
  'x | y\nno delimiter row below',
  'cost | 10\n---',
  '| a | b |\n|---|\n| 1 | 2 |',
  'Header without a pipe\n|---|---|',
  'a | b\nc | d',
  // html and markup-looking text
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  'a < b and c > d & e "quoted"',
  '[click](javascript:alert(1))',
  '[ok](https://a.test/x) and <https://b.test>',
  '`code` and ```fence```\n```\nblock\n```',
  '> quote\n> more quote',
  '![image](http://a.test/x.png)',
  'Dollar signs $1 and $& and $` in the text',
  '&lt;already escaped&gt; &amp; &quot;',
  // long and odd
  'a'.repeat(5000),
  'word '.repeat(2000),
  ('- item\n').repeat(300),
  '\n'.repeat(300),
  ' \n'.repeat(300),
  '**x** '.repeat(500),
  ('line\n\n').repeat(200)
];

/** Random plain answers: lines from a pool that holds no heading and no table, put together by a seeded generator. */
function generatedPlain(total) {
  const pool = [
    'Plain sentence about prices.', 'The price is 1.389,00 EUR.', '  indented line', '\tabs line', '',
    '- bullet item', '* star item', '  - nested item', '- **Bold**: value', '-no space', '*no space',
    '1. numbered', '2) numbered paren', '• bullet sign', 'issue #12', 'C# language', '#1 thing', '#tag', '#######',
    '    # four spaces', 'a | b | c', '| a | b |', 'x | y', '**bold** text', '**unclosed', 'two ** stars ** here',
    '<b>html-looking</b>', 'a < b > c', '&amp; & "q"', '[l](javascript:x)', 'http://a.test/x?y=1&z=2',
    '---', '***', '* * *', '- - -', '-', '- ', ' ', '   ', 'end.', 'Größe für Lieferung', '🙂 emoji', '`code`'
  ];
  const random = mulberry32(20260930);
  const out = [];
  let attempts = 0;
  while (out.length < total && attempts < total * 20) {
    attempts++;
    const lines = Array.from({ length: 1 + Math.floor(random() * 12) }, () => pool[Math.floor(random() * pool.length)]);
    const eol = ['\n', '\n', '\n', '\r\n'][Math.floor(random() * 4)];
    const text = lines.join(eol) + (random() < 0.2 ? eol : '');
    if (!hasMarkdownBlocks(text)) out.push(text);
  }
  return out;
}

test('the corpus holds more than 100 answers, each without a heading or a table', () => {
  const generated = generatedPlain(150);
  assert.ok(PLAIN.length >= 100, `${PLAIN.length} hand-written answers`);
  assert.equal(generated.length, 150);
  assert.ok(PLAIN.length + generated.length >= 250);
  assert.equal(new Set(PLAIN).size, PLAIN.length, 'no duplicate in the hand-written corpus');
  for (const text of PLAIN) assert.equal(hasMarkdownBlocks(text), false, `was taken for a heading or a table: ${JSON.stringify(text.slice(0, 80))}`);
  // The filter of the generated corpus is not hiding a heading: none of those answers has a line that looks like one.
  for (const text of generated) assert.ok(!/^ {0,3}#{1,6}[ \t]+\S/m.test(text), JSON.stringify(text));
});

test('differential: an answer without a heading or a table is rendered byte for byte as before (hand-written corpus)', () => {
  for (const text of PLAIN) {
    assert.equal(formatMarkdownText(text), oldFormatMarkdownText(text), JSON.stringify(text.slice(0, 120)));
  }
});

test('differential: the same on 150 generated answers, with LF and CRLF line ends', () => {
  for (const text of generatedPlain(150)) {
    assert.equal(formatMarkdownText(text), oldFormatMarkdownText(text), JSON.stringify(text));
  }
});

test('differential: the rewritten bullet scan is the old regex on random text, quirks included', () => {
  // Not filtered: any string at all, with the characters that matter for the regex (whitespace of every kind,
  // the four line terminators, both bullet characters, letters). The old regex runs on the output of the old bold step.
  const alphabet = [' ', ' ', '\n', '\n', '\r', '\r\n', '\t', '\u2028', '\u2029', '\u00a0', '\u3000', '\ufeff', '-', '-', '*', '*', 'a', 'b', '1', '•', '<', '$'];
  const random = mulberry32(7);
  const regex = /^[\s]*[-*]\s+(.*)$/gm;
  for (let i = 0; i < 40000; i++) {
    const length = Math.floor(random() * 28);
    let text = '';
    for (let j = 0; j < length; j++) text += alphabet[Math.floor(random() * alphabet.length)];
    assert.equal(legacyBullets(text), text.replace(regex, '• $1'), JSON.stringify(text));
  }
});

test('differential: random text from markdown-looking pieces is the old output whenever it has no heading or table', () => {
  const pieces = ['#', '# ', '##', ' ', '\t', '|', '\\|', '---', '|---|', ':-:', '- ', '* ', '• ', '1. ', '**', '*', '<', '>', '"', '&', 'a', 'word', '7', '\n', '\n', '\n', '\n\n', '\r\n', '[x](y)', '`'];
  const random = mulberry32(99);
  let plain = 0;
  for (let i = 0; i < 6000; i++) {
    let text = '';
    const length = 1 + Math.floor(random() * 40);
    for (let j = 0; j < length; j++) text += pieces[Math.floor(random() * pieces.length)];
    if (hasMarkdownBlocks(text)) continue;
    plain++;
    assert.equal(formatMarkdownText(text), oldFormatMarkdownText(text), JSON.stringify(text));
  }
  assert.ok(plain > 1500, `${plain} of the random texts were plain: the test does compare something`);
});

test('falsy and non-string input behaves as before', () => {
  for (const value of [undefined, null, '', 0, false, NaN]) assert.equal(formatMarkdownText(value), oldFormatMarkdownText(value));
  for (const value of [5, 12.5, true, ['a', 'b'], { toString: () => '- x **y**' }]) {
    assert.equal(formatMarkdownText(value), oldFormatMarkdownText(value));
  }
});

test('the finish card of an answer without a heading is the old card, byte for byte', () => {
  const card = renderFinishCard({ turn: 1, answer: 'All good **now**\n- one\n- two', audit: null, answerUnconfirmed: false });
  assert.match(card, /<div class="finish-body">All good <strong>now<\/strong>\n• one\n• two<\/div><\/div>$/);
});

// ---------------------------------------------------------------------------------------------
// 2. Headings
// ---------------------------------------------------------------------------------------------

const heading = (level, text) => `<div class="md-h md-h${level}" role="heading" aria-level="${level}">${text}</div>`;
const doc = (...parts) => `<div class="md-doc">${parts.join('')}</div>`;

test('ATX headings, level 1 to 6, become block headings', () => {
  for (let level = 1; level <= 6; level++) {
    assert.equal(formatMarkdownText(`${'#'.repeat(level)} Prices found`), doc(heading(level, 'Prices found')));
  }
});

test('what is not a heading stays text: seven hashes, no space, a bare hash, four spaces of indent', () => {
  for (const text of ['####### seven', '#hashtag', '#', '# ', '    # indented four', '\t# tab']) {
    assert.equal(hasMarkdownBlocks(text), false, text);
  }
  // Up to three spaces of indent, a tab after the hashes, and a closing run of hashes are all headings.
  assert.equal(formatMarkdownText('   ## Three spaces'), doc(heading(2, 'Three spaces')));
  assert.equal(formatMarkdownText('##\tTab'), doc(heading(2, 'Tab')));
  assert.equal(formatMarkdownText('## Title ##'), doc(heading(2, 'Title')));
  assert.equal(formatMarkdownText('## Title ####   '), doc(heading(2, 'Title')));
  assert.equal(formatMarkdownText('## C#'), doc(heading(2, 'C#')), 'a hash that is part of the title stays');
  assert.equal(formatMarkdownText('#   Spaced   title  '), doc(heading(1, 'Spaced   title')));
  assert.equal(hasMarkdownBlocks('## ###'), false, 'a heading with no title is not one');
});

test('a heading is inline-formatted and escaped', () => {
  assert.equal(formatMarkdownText('## **Bold** <b>tag</b>'), doc(heading(2, '<strong>Bold</strong> &lt;b&gt;tag&lt;/b&gt;')));
});

test('the incident answer: headings, lists that hang, and a real table', () => {
  const html = formatMarkdownText(INCIDENT);
  assertSafeMarkup(html, 'incident');
  assert.ok(html.startsWith(`<div class="md-doc">${heading(2, 'Prices found')}${heading(3, 'shop-a.test')}<ul class="md-list" role="list">`));
  assert.equal(count(html, 'class="md-h '), 3);
  assert.equal(count(html, '<ul class="md-list"'), 2);
  assert.equal(count(html, '<li class="md-li">'), 8);
  assert.equal(count(html, '<table class="md-table">'), 1);
  assert.equal(count(html, '<tr>'), 3, 'the header row and two body rows');
  assert.ok(!html.includes('##') && !html.includes('|---'), 'no raw markdown left');
  assert.ok(html.includes(`<span class="md-li-text"><strong>URL</strong>: ${URL_A.replace(/&/g, '&amp;')}</span>`), 'the long URL is text, not a link');
  // A short cell is kept on one line (md-nw); the long delivery text wraps at its spaces.
  assert.ok(html.includes('<td class="md-nw">shop-a.test</td><td class="md-nw">1.389,00 EUR</td><td class="md-nw">6,90 EUR</td><td>Lieferung in 3-4 Werktagen</td>'));
  assert.ok(html.includes('<th class="md-nw" scope="col">Shipping</th>'));
  assert.ok(!html.includes('<a '), 'no link is rendered');
  // The model's words are all there, and no other.
  assert.deepEqual(alphanumerics(visibleText(html)), alphanumerics(INCIDENT));

  const honest = formatMarkdownText(INCIDENT_HONEST);
  assertSafeMarkup(honest, 'honest');
  assert.ok(honest.includes('<div class="md-p">Not checked. I did not open shop-b.test, so I have no price, shipping or delivery for it.</div>'));
  assert.deepEqual(alphanumerics(visibleText(honest)), alphanumerics(INCIDENT_HONEST));
});

// ---------------------------------------------------------------------------------------------
// 3. Tables
// ---------------------------------------------------------------------------------------------

const table = (head, rows) => `<div class="md-table-wrap" role="region" aria-label="Table" tabindex="0"><table class="md-table"><thead><tr>${head}</tr></thead>${rows ? `<tbody>${rows}</tbody>` : ''}</table></div>`;

test('a pipe table is a real <table>, in a wrapper that scrolls', () => {
  const html = formatMarkdownText('| Source | Price |\n|---|--:|\n| shop-a.test | **1,00** |');
  assert.equal(html, doc(table(
    '<th class="md-nw" scope="col">Source</th><th class="md-al-r md-nw" scope="col">Price</th>',
    '<tr><td class="md-nw">shop-a.test</td><td class="md-al-r md-nw"><strong>1,00</strong></td></tr>'
  )));
  assertSafeMarkup(html);
});

test('alignment colons are tolerated and become a class: left, centre, right', () => {
  const html = formatMarkdownText('| a | b | c | d |\n|:--|:-:|--:|---|\n| 1 | 2 | 3 | 4 |');
  assert.equal(count(html, 'md-al-c'), 2, 'one header cell and one body cell');
  assert.equal(count(html, 'md-al-r'), 2);
  assert.ok(html.includes('<th class="md-nw" scope="col">a</th><th class="md-al-c md-nw" scope="col">b</th><th class="md-al-r md-nw" scope="col">c</th><th class="md-nw" scope="col">d</th>'));
  // Spaces inside the delimiter row and a single dash are fine too.
  assert.ok(formatMarkdownText('| a | b |\n| :-: | -: |\n| 1 | 2 |').includes('md-al-c'));
  assert.ok(formatMarkdownText('| a | b |\n|-|-|\n| 1 | 2 |').includes('<table'));
});

test('an escaped pipe stays in its cell; an unescaped one splits, also inside backticks', () => {
  const html = formatMarkdownText('| a \\| b | c |\n|---|---|\n| x \\| y | z |');
  assert.ok(html.includes('<th class="md-nw" scope="col">a | b</th><th class="md-nw" scope="col">c</th>'));
  assert.ok(html.includes('<td class="md-nw">x | y</td><td class="md-nw">z</td>'));
  assert.deepEqual(splitTableRow('| a \\| b | c |'), ['a | b', 'c']);
  assert.deepEqual(splitTableRow('a|b|c'), ['a', 'b', 'c']);
  assert.deepEqual(splitTableRow('| a || c |'), ['a', '', 'c']);
  assert.deepEqual(splitTableRow('| a | b \\|'), ['a', 'b |'], 'an escaped last pipe is content, not the closing pipe');
  assert.deepEqual(splitTableRow('\\|\\|'), ['||']);
  assert.deepEqual(splitTableRow('a\\||b'), ['a|', 'b']);
  assert.deepEqual(splitTableRow('|'), ['']);
  // GitHub splits at a pipe inside a code span as well: a model that wants the pipe has to escape it.
  const code = formatMarkdownText('| cmd | note |\n|---|---|\n| `a|b` | ok |');
  assert.ok(code.includes('<td class="md-nw">`a</td><td class="md-nw">b` | ok</td>'));
  const escaped = formatMarkdownText('| cmd | note |\n|---|---|\n| `a\\|b` | ok |');
  assert.ok(escaped.includes('<td class="md-nw">`a|b`</td><td class="md-nw">ok</td>'));
});

test('ragged rows: a short row is padded, a long row is folded into the last cell, nothing is dropped', () => {
  const html = formatMarkdownText('| a | b | c |\n|---|---|---|\n| 1 |\n| 1 | 2 | 3 | 4 | 5 |\n| x | y | z |');
  assert.ok(html.includes('<tr><td class="md-nw">1</td><td></td><td></td></tr>'), 'an empty cell has no class');
  assert.ok(html.includes('<tr><td class="md-nw">1</td><td class="md-nw">2</td><td class="md-nw">3 | 4 | 5</td></tr>'));
  assert.ok(html.includes('<tr><td class="md-nw">x</td><td class="md-nw">y</td><td class="md-nw">z</td></tr>'));
  assert.equal(count(html, '<tr>'), 4);
  assert.deepEqual(alphanumerics(visibleText(html)), alphanumerics('| a | b | c |\n|---|---|---|\n| 1 |\n| 1 | 2 | 3 | 4 | 5 |\n| x | y | z |'));
});

test('a header-only table, a one-column table, and a table without outer pipes', () => {
  const nw = (tag, text) => `<${tag} class="md-nw"${tag === 'th' ? ' scope="col"' : ''}>${text}</${tag}>`;
  assert.equal(formatMarkdownText('| a | b |\n|---|---|'), doc(table(`${nw('th', 'a')}${nw('th', 'b')}`, '')));
  assert.equal(
    formatMarkdownText('| only |\n|---|\n| 1 |\n| 2 |'),
    doc(table(nw('th', 'only'), `<tr>${nw('td', '1')}</tr><tr>${nw('td', '2')}</tr>`))
  );
  assert.equal(
    formatMarkdownText('a | b\n--|--\n1 | 2'),
    doc(table(`${nw('th', 'a')}${nw('th', 'b')}`, `<tr>${nw('td', '1')}${nw('td', '2')}</tr>`))
  );
  // Leading and trailing spaces, tabs, and CRLF line ends do not matter.
  assert.equal(
    formatMarkdownText('  | a | b |  \r\n  |---|---|  \r\n\t| 1 | 2 |\t\r\n'),
    doc(table(`${nw('th', 'a')}${nw('th', 'b')}`, `<tr>${nw('td', '1')}${nw('td', '2')}</tr>`))
  );
});

test('a cell of 16 characters or less stays on one line, a longer one wraps at its spaces', () => {
  const sixteen = 'a'.repeat(16);
  const html = formatMarkdownText(`| ${sixteen} | ${sixteen}x |\n|---|---|\n| shop-a.test | Lieferung in 3-4 Werktagen |`);
  assert.ok(html.includes(`<th class="md-nw" scope="col">${sixteen}</th><th scope="col">${sixteen}x</th>`));
  assert.ok(html.includes('<td class="md-nw">shop-a.test</td><td>Lieferung in 3-4 Werktagen</td>'));
  assert.match(MD_CSS, /\.md-table \.md-nw \{ white-space: nowrap; \}/);
});

test('what is not a table stays text: no delimiter row, the wrong number of cells, no pipe, a title with ---', () => {
  for (const text of [
    '| a | b |\n| 1 | 2 |', '| a | b |\n|---|\n| 1 | 2 |', '| a |\n|---|---|\n| 1 |', 'a b\n|---|---|', '| a | b |\n---',
    'Title\n---', 'a | b\n- | x', '| a | b |\n|-x-|---|\n| 1 | 2 |', 'only one line | with pipes'
  ]) {
    assert.equal(hasMarkdownBlocks(text), false, JSON.stringify(text));
    assert.equal(formatMarkdownText(text), oldFormatMarkdownText(text), JSON.stringify(text));
  }
  // A table wider than 40 columns is text, so a hostile row cannot make a huge DOM.
  const wide = (n) => `${Array.from({ length: n }, (_, i) => `c${i}`).join('|')}\n${Array.from({ length: n }, () => '-').join('|')}\n`;
  assert.equal(hasMarkdownBlocks(wide(40)), true);
  assert.equal(hasMarkdownBlocks(wide(41)), false);
});

test('a table ends at a blank line, a heading, a list item or a line without a pipe', () => {
  const head = '| a | b |\n|---|---|\n| 1 | 2 |\n';
  const ends = {
    blank: `${head}\nAfter the table.`,
    heading: `${head}## Next`,
    item: `${head}- note: x | y`,
    noPipe: `${head}Text right under the table.`
  };
  for (const [name, text] of Object.entries(ends)) {
    const html = formatMarkdownText(text);
    assertSafeMarkup(html, name);
    assert.equal(count(html, '<tr>'), 2, `${name}: the header and one body row`);
  }
  assert.ok(formatMarkdownText(ends.blank).endsWith('<div class="md-p">After the table.</div></div>'));
  assert.ok(formatMarkdownText(ends.heading).endsWith(`${heading(2, 'Next')}</div>`));
  assert.ok(formatMarkdownText(ends.item).includes('<ul class="md-list" role="list"><li class="md-li"><span class="md-mark" aria-hidden="true">•</span><span class="md-li-text">note: x | y</span>'));
  assert.ok(formatMarkdownText(ends.noPipe).endsWith('<div class="md-p">Text right under the table.</div></div>'));
  // A row whose first cell is a lone dash is a row, not a list item, when it starts with a pipe.
  assert.equal(count(formatMarkdownText(`${head}| - | 5 |`), '<tr>'), 3);
});

test('two tables in one answer, and a table between paragraphs', () => {
  const html = formatMarkdownText('Before.\n\n| a |\n|---|\n| 1 |\n\nBetween.\n\n| b | c |\n|---|---|\n| 2 | 3 |\n\nAfter.');
  assertSafeMarkup(html);
  assert.equal(count(html, '<table '), 2);
  assert.ok(html.startsWith('<div class="md-doc"><div class="md-p">Before.</div><div class="md-table-wrap"'));
  assert.ok(html.includes('</div><div class="md-p">Between.</div><div class="md-table-wrap"'));
  assert.ok(html.endsWith('<div class="md-p">After.</div></div>'));
});

test('a cell can hold bold, empty text and every hostile character, all escaped', () => {
  const html = formatMarkdownText('| a | b |\n|---|---|\n| **x** | <b>"q"</b> & more |\n|  |  |');
  assert.ok(html.includes('<td class="md-nw"><strong>x</strong></td><td>&lt;b&gt;&quot;q&quot;&lt;/b&gt; &amp; more</td>'));
  assert.ok(html.includes('<tr><td></td><td></td></tr>'));
  assertSafeMarkup(html);
});

// ---------------------------------------------------------------------------------------------
// 4. Lists (in the blocks renderer) and paragraphs
// ---------------------------------------------------------------------------------------------

const item = (text, { marker = '•', depth = 0 } = {}) =>
  `<li class="md-li${depth ? ` md-d${depth}` : ''}"><span class="md-mark" aria-hidden="true">${marker}</span><span class="md-li-text">${text}</span></li>`;
const ul = (...items) => `<ul class="md-list" role="list">${items.join('')}</ul>`;
const ol = (...items) => `<ol class="md-list" role="list">${items.join('')}</ol>`;

test('a list hangs: the bullet has its own column, continuation lines belong to the item', () => {
  const html = formatMarkdownText('# T\n- one\n  continued\nlazy continuation\n- two\n* three\n• four');
  assert.equal(html, doc(heading(1, 'T'), ul(item('one\ncontinued\nlazy continuation'), item('two'), item('three'), item('four'))));
});

test('numbered lists keep their own numbers; "2019. It rained" inside a paragraph is prose', () => {
  assert.equal(
    formatMarkdownText('# T\n1. first\n2) second\n10. tenth'),
    doc(heading(1, 'T'), ol(item('first', { marker: '1.' }), item('second', { marker: '2)' }), item('tenth', { marker: '10.' })))
  );
  assert.equal(
    formatMarkdownText('# T\nIn the year\n2019. It rained a lot.'),
    doc(heading(1, 'T'), '<div class="md-p">In the year\n2019. It rained a lot.</div>')
  );
  // "1." does start a list after a paragraph line; so does a bullet.
  assert.ok(formatMarkdownText('# T\nSteps:\n1. open\n2. read').includes(ol(item('open', { marker: '1.' }), item('read', { marker: '2.' }))));
  assert.ok(formatMarkdownText('# T\nSteps:\n- open').includes(ul(item('open'))));
  // A bullet list followed by a numbered one is two lists.
  assert.ok(formatMarkdownText('# T\n- a\n1. b').endsWith(`${ul(item('a'))}${ol(item('b', { marker: '1.' }))}</div>`));
});

test('nesting by indent (two spaces a level, three levels at most), and a blank line ends a list', () => {
  const html = formatMarkdownText('# T\n- a\n  - b\n    - c\n          - deep\n\n- d');
  assert.equal(html, doc(heading(1, 'T'), ul(item('a'), item('b', { depth: 1 }), item('c', { depth: 2 }), item('deep', { depth: 3 })), ul(item('d'))));
});

test('an item needs a space and a text; a bare dash is prose', () => {
  const html = formatMarkdownText('# T\n-no space\n- \n-\n- x');
  assert.equal(html, doc(heading(1, 'T'), '<div class="md-p">-no space\n- \n-</div>', ul(item('x'))));
});

test('paragraphs: single line breaks are kept inside, a blank line starts the next paragraph', () => {
  assert.equal(
    formatMarkdownText('# T\nline one\nline **two**\n\n\nsecond paragraph'),
    doc(heading(1, 'T'), '<div class="md-p">line one\nline <strong>two</strong></div>', '<div class="md-p">second paragraph</div>')
  );
  // Unbalanced bold stays as typed, and never reaches across lines.
  assert.ok(formatMarkdownText('# T\n**open\nclose**').includes('<div class="md-p">**open\nclose**</div>'));
  assert.ok(formatMarkdownText('# T\na **b** c **d').includes('a <strong>b</strong> c **d'));
});

test('a model that uses only a table as its answer gets just the table', () => {
  const html = formatMarkdownText(TABLE.join('\n'));
  assert.ok(html.startsWith('<div class="md-doc"><div class="md-table-wrap"') && html.endsWith('</table></div></div>'));
});

// ---------------------------------------------------------------------------------------------
// 5. Hostile input
// ---------------------------------------------------------------------------------------------

const HOSTILE = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<svg/onload=alert(1)>',
  '"><script>alert(1)</script>',
  "'><img src=x onerror=alert(1)>",
  '</div></div><div class="evil">x</div>',
  '</table></div><script>1</script>',
  '<a href="javascript:alert(1)">x</a>',
  '[x](javascript:alert(1))',
  '[x](data:text/html;base64,PHNjcmlwdD4=)',
  '<iframe src=//evil.test></iframe>',
  '&lt;script&gt;alert(1)&lt;/script&gt;',
  '&#60;script&#62;',
  '<!-- comment --> <![CDATA[x]]>',
  '<style>*{display:none}</style>',
  'javascript:alert(1)',
  '\u0000<b>\u0000',
  '<b onmouseover=alert(1)>hover</b>',
  '**<img src=x onerror=alert(1)>**',
  '| <img src=x onerror=alert(1)> |',
  '`<script>`'
];

/** The same hostile text in every place the renderer puts model text. */
function hostileDocs(payload) {
  return [
    `# ${payload}`,
    `## a\n${payload}`,
    `# t\n- ${payload}`,
    `# t\n1. ${payload}`,
    `# t\n- a\n  ${payload}`,
    `# t\n${payload}\nsecond line`,
    `| ${payload} | b |\n|---|---|\n| ${payload} | ${payload} |`,
    `| a | b |\n|---|---|\n| 1 | 2 | ${payload} |`,
    `| a | b |\n|---|---|\n| ${payload} |`,
    `| a |\n|---|\n${payload} | x`,
    `| a |\n|---|\n| **${payload}** |`,
    `# t\n**${payload}**`,
    `# t\n${payload}`,
    `${payload}\n# t`
  ];
}

test('hostile text in a heading, a list item, a paragraph or a table cell is shown as text, never as markup', () => {
  for (const payload of HOSTILE) {
    for (const text of hostileDocs(payload)) {
      const html = formatMarkdownText(text);
      assertSafeMarkup(html, JSON.stringify(text));
      assert.ok(!html.includes('<script') && !html.includes('<img') && !html.includes('<iframe') && !html.includes('<svg') && !html.includes('<style') && !html.includes('<a '), JSON.stringify(text));
    }
  }
});

test('hostile text in a legacy answer is shown as text too', () => {
  for (const payload of HOSTILE) {
    if (hasMarkdownBlocks(payload)) continue;
    const html = formatMarkdownText(payload);
    assertSafeMarkup(html, payload);
  }
  assert.equal(formatMarkdownText('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
});

test('the escaped text is exactly what the model wrote: entities are not decoded, a pipe inside escaped text is text', () => {
  const html = formatMarkdownText('# t\n&lt;b&gt; &amp; &#60;\n\n| a | b |\n|---|---|\n| &lt;x|y&gt; | 2 |');
  assert.ok(html.includes('&amp;lt;b&amp;gt; &amp;amp; &amp;#60;'), html);
  // "|" inside the text splits the cell (it is not escaped with a backslash); both halves stay escaped.
  assert.ok(html.includes('<td class="md-nw">&amp;lt;x</td><td class="md-nw">y&amp;gt; | 2</td>'), html);
  assertSafeMarkup(html);
});

test('links are never rendered: a markdown link, a javascript: address and a bare URL are all text', () => {
  const text = '# t\n[click](javascript:alert(1)) and [ok](https://a.test/x) and http://b.test/y and <https://c.test>\n\n| l |\n|---|\n| [x](javascript:1) |';
  const html = formatMarkdownText(text);
  assert.ok(!html.includes('<a ') && !html.includes('href') && !html.includes('target='));
  assert.ok(html.includes('[click](javascript:alert(1))'));
  assert.ok(html.includes('http://b.test/y'));
  assertSafeMarkup(html);
});

test('unbalanced and odd markdown neither throws nor breaks the markup', () => {
  const odd = [
    '# ', '#', '##', '|', '||', '|||', '| | |\n|-|-|', '|\n|-|', '| a\n|---', 'a |\n--|', '| a |\n|---|\n|', '| a |\n|---|\n\\|',
    '**', '****', '** **', '**a', 'a**', '**a** **b', '\\', '\\\\|', '\\|\\|\\|', ':--:', '|:-:|\n|:-:|', '- ', '* ', '1.', '1. ', '1.\n2.',
    '# **unclosed', '# a | b\n|-|-|', '# t\n- **x', '# t\n|a|\n|-|\n|**b|', '`', '```', '# t\n```\n# in fence\n```', '\u0000', '\ud800', '\udc00x',
    '# ' + '#'.repeat(100), '#'.repeat(7) + ' x\n# y', '\r', '\r\r\n\n# t\r', '\u2028# t', '# t\u2028- a\u2029- b'
  ];
  for (const text of odd) {
    const html = formatMarkdownText(text);
    assertSafeMarkup(html, JSON.stringify(text));
    assert.deepEqual(alphanumerics(visibleText(html)), alphanumerics(text), JSON.stringify(text));
  }
});

test('extremely long cells, headings and items keep the markup valid', () => {
  const big = 'x'.repeat(200000);
  for (const text of [
    `# ${big}`, `# t\n- ${big}`, `| a |\n|---|\n| ${big} |`, `| ${big} |\n|---|\n| 1 |`, `# t\n${big}`,
    `| a | b |\n|---|---|\n| ${big} | ${big} |`
  ]) {
    const html = formatMarkdownText(text);
    assertSafeMarkup(html);
    assert.ok(html.includes(big));
  }
});

// Random documents built from markdown pieces and attack pieces: the two properties that matter most, on all of them.
const FUZZ_PIECES = [
  '#', '##', '###', '# ', '## ', ' ', '  ', '\t', '|', '|', '|', '\\|', '\\', '---', '-', '|---|---|', ':--:', '--:', '- ', '* ', '• ', '1. ', '2) ', '**', '*',
  '<', '>', '"', "'", '&', '&lt;', '&amp;', '`', 'a', 'B', '7', 'word', 'prices', '<script>alert(1)</script>', '<img src=x onerror=alert(1)>',
  'javascript:alert(1)', '[x](javascript:alert(1))', 'http://a.test/x?y=1&z=2', '\n', '\n', '\n', '\n\n', '\r\n', '\u2028', '\u00a0',
  '| a | b |\n|---|---|\n| 1 | 2 |\n', '| a |\n|:-:|\n', 'x | y\n--|--\n1 | 2\n', '## Title\n', '- item\n  more\n'
];

test('fuzz: 8000 random documents are safe, lose nothing, and are the old output when they have no heading or table', () => {
  const random = mulberry32(31337);
  let blocks = 0;
  let plain = 0;
  for (let i = 0; i < 8000; i++) {
    let text = '';
    const length = 1 + Math.floor(random() * 50);
    for (let j = 0; j < length; j++) text += FUZZ_PIECES[Math.floor(random() * FUZZ_PIECES.length)];
    const html = formatMarkdownText(text);
    assertSafeMarkup(html, JSON.stringify(text));
    assert.deepEqual(alphanumerics(visibleText(html)), alphanumerics(text), `something was lost or made up: ${JSON.stringify(text)}`);
    if (hasMarkdownBlocks(text)) {
      blocks++;
      assert.ok(html.startsWith('<div class="md-doc">') && html.endsWith('</div>'));
    } else {
      plain++;
      assert.equal(html, oldFormatMarkdownText(text), JSON.stringify(text));
    }
  }
  assert.ok(blocks > 1500 && plain > 500, `${blocks} documents took the blocks path and ${plain} the legacy path`);
});

// ---------------------------------------------------------------------------------------------
// 6. Speed
// ---------------------------------------------------------------------------------------------

test('a 500-row table renders fast, and so does a 5000-row one', () => {
  const rows = (n) => Array.from({ length: n }, (_, i) => `| shop-${i}.test | ${i},99 EUR | **${i % 7},90 EUR** | Lieferung in ${i % 5}-${i % 5 + 2} Werktagen |`);
  const source = (n) => [...TABLE.slice(0, 2), ...rows(n)].join('\n');
  const small = timed(() => formatMarkdownText(source(500)));
  assert.equal(count(small.result, '<tr>'), 501);
  assertSafeMarkup(small.result);
  assert.ok(small.ms < FAST_MS, `500 rows took ${small.ms.toFixed(1)} ms`);
  const big = timed(() => formatMarkdownText(`# Prices\n\n${source(5000)}\n\nDone.`));
  assert.equal(count(big.result, '<tr>'), 5001);
  assert.ok(big.ms < 4 * FAST_MS, `5000 rows took ${big.ms.toFixed(1)} ms`);
});

test('a line of 50 000 characters renders fast, whatever it is made of, alone and inside a document with blocks', () => {
  const shapes = {
    letters: 'a'.repeat(50000),
    words: 'word '.repeat(10000),
    bold: '**x** '.repeat(8000),
    openBold: '**a '.repeat(12500),
    stars: '*'.repeat(50000),
    spaces: `${' '.repeat(50000)}x`,
    pipes: '|'.repeat(50000),
    pipeCells: '| a '.repeat(12500),
    escapedPipes: '\\|'.repeat(25000),
    hashes: '#'.repeat(50000),
    hashWords: `# ${'x '.repeat(25000)}`,
    hashTail: `# a${' '.repeat(25000)}b${'#'.repeat(25000)}`,
    dashes: '-'.repeat(50000),
    dashSpace: '- '.repeat(25000),
    numbers: '1. '.repeat(16000),
    colons: ':-'.repeat(25000),
    tags: '<b>'.repeat(16000),
    ampersands: '&'.repeat(50000)
  };
  for (const [name, line] of Object.entries(shapes)) {
    for (const [where, wrap] of [
      ['alone', (s) => s],
      ['under a heading', (s) => `# Title\n${s}`],
      ['as a list item', (s) => `# t\n- ${s}`],
      ['as a header row', (s) => `| ${s} |\n|---|\n| 1 |`],
      ['as a body row', (s) => `| a | b |\n|---|---|\n${s}`],
      ['under a table', (s) => `| a |\n|---|\n| 1 |\n${s}`]
    ]) {
      const text = wrap(line);
      const run = timed(() => formatMarkdownText(text));
      assertSafeMarkup(run.result, `${name} ${where}`);
      assert.ok(run.ms < FAST_MS, `${name} ${where} took ${run.ms.toFixed(1)} ms`);
    }
  }
});

test('the legacy path is fast on long runs of blank lines (the old regex took almost 3 seconds on 50 000)', () => {
  // Each expected output is what the old regex makes of it, worked out by hand: a run of blank lines is kept,
  // and a bullet after it eats the blank lines in front of it (the quirk the rewrite keeps).
  const cases = [
    ['\n'.repeat(50000), '\n'.repeat(50000)],
    [' \n'.repeat(25000), ' \n'.repeat(25000)],
    ['\r\n'.repeat(25000), '\r\n'.repeat(25000)],
    [`${'\n'.repeat(50000)}- x`, '• x'],
    [`- a${'\n'.repeat(50000)}- b`, '• a\n• b'],
    [`${'\t\n'.repeat(25000)}* z`, '• z']
  ];
  for (const [text, expected] of cases) {
    const run = timed(() => formatMarkdownText(text));
    assert.equal(run.result, expected, JSON.stringify(text.slice(0, 12)));
    assert.ok(run.ms < FAST_MS, `${JSON.stringify(text.slice(0, 12))}... took ${run.ms.toFixed(1)} ms`);
  }
  // The same answers at a size where the old function is quick: identical output.
  for (const text of ['\n'.repeat(3000), ' \n'.repeat(1500), `${'\n'.repeat(3000)}- x`, `- a${'\n'.repeat(3000)}- b`]) {
    assert.equal(formatMarkdownText(text), oldFormatMarkdownText(text));
  }
});

test('a document with 20 000 short lines, and one with 20 000 list items, render fast', () => {
  const lines = timed(() => formatMarkdownText(`# t\n${Array.from({ length: 20000 }, (_, i) => `line ${i}`).join('\n')}`));
  assert.ok(lines.ms < FAST_MS, `${lines.ms.toFixed(1)} ms`);
  const items = timed(() => formatMarkdownText(`# t\n${Array.from({ length: 20000 }, (_, i) => `- item **${i}**`).join('\n')}`));
  assert.equal(count(items.result, '<li '), 20000);
  assert.ok(items.ms < FAST_MS, `${items.ms.toFixed(1)} ms`);
  const plain = timed(() => formatMarkdownText(Array.from({ length: 20000 }, (_, i) => `- item **${i}**`).join('\n')));
  assert.ok(plain.ms < FAST_MS, `${plain.ms.toFixed(1)} ms`);
});

// ---------------------------------------------------------------------------------------------
// 7. The stylesheet
// ---------------------------------------------------------------------------------------------

const CSS = fs.readFileSync(new URL('../sidepanel/sidepanel.css', import.meta.url), 'utf8');
const MD_CSS = CSS.slice(CSS.indexOf('/* ---- Markdown blocks in the answer'), CSS.indexOf('/* Input Panel */'));

function ruleOf(selector) {
  const match = MD_CSS.replace(/\/\*[^]*?\*\//g, '').match(new RegExp(`(?:^|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\>]/g, '\\$&')}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `no rule for ${selector}`);
  return match[1];
}

test('the stylesheet has a rule for every class the blocks renderer writes', () => {
  const html = formatMarkdownText([
    INCIDENT, '# a\n## b\n### c\n#### d\n##### e\n###### f', '| a | b | c |\n|:-|:-:|-:|\n| 1 | 2 | 3 |',
    '# t\n- a\n  - b\n    - c\n      - d\n1. x', 'p\n# t\nsecond'
  ].join('\n\n'));
  const classes = classesOf(html);
  for (const name of ['md-doc', 'md-h', 'md-h1', 'md-h6', 'md-p', 'md-list', 'md-li', 'md-d1', 'md-d3', 'md-mark', 'md-li-text', 'md-table-wrap', 'md-table', 'md-al-c', 'md-al-r']) {
    assert.ok(classes.has(name), `the sample never writes .${name}`);
  }
  for (const name of classes) assert.ok(MD_CSS.includes(`.${name}`), `.${name} has no rule`);
});

test('a wide table scrolls inside its box and never widens the card', () => {
  const wrap = ruleOf('.md-table-wrap');
  assert.match(wrap, /overflow-x:\s*auto;/);
  assert.match(wrap, /max-width:\s*100%;/);
  assert.match(wrap, /white-space:\s*normal;/, 'pre-wrap is for paragraphs, not for cells');
  assert.match(ruleOf('.md-table'), /width:\s*100%;/);
  assert.match(ruleOf('.md-table'), /border-collapse:\s*collapse;/);
  // The card text may break a word anywhere; a table must not (a header cut into "Shippin" and "g"): it wraps at spaces
  // and a word wider than the card makes the wrapper scroll.
  assert.match(ruleOf('.md-table'), /word-break:\s*normal;/);
  assert.match(ruleOf('.md-table'), /overflow-wrap:\s*break-word;/);
  assert.ok(!/anywhere/.test(ruleOf('.md-table')) && !/min-width/.test(MD_CSS.slice(MD_CSS.indexOf('.md-table {'), MD_CSS.indexOf('.md-table .md-al-r'))), 'no anywhere and no cell floor in the table rules');
  assert.match(CSS.slice(CSS.indexOf('.finish-body {'), CSS.indexOf('}', CSS.indexOf('.finish-body {'))), /min-width:\s*0;/);
});

test('table borders and cell padding come from the theme: no fixed colour anywhere in the markdown rules', () => {
  assert.match(ruleOf('.md-table-wrap'), /border:\s*1px solid var\(--border-strong\);/);
  assert.match(MD_CSS, /\.md-table th,\s*\.md-table td \{[^}]*padding:\s*5px 8px;[^}]*border-top:\s*1px solid var\(--border\);/);
  assert.match(MD_CSS, /\.md-table td \+ td \{ border-left: 1px solid var\(--border\); \}/);
  assert.match(ruleOf('.md-table thead th'), /background:\s*var\(--surface\);/);
  assert.ok(!/#[0-9a-f]{3,8}\b|rgba?\(|hsl/i.test(MD_CSS), 'every colour is a theme variable, so both themes get it');
  // The variables exist in the light block and in both dark blocks.
  for (const variable of [...new Set([...MD_CSS.matchAll(/var\((--[a-z-]+)\)/g)].map((m) => m[1]))].filter((name) => !name.startsWith('--font'))) {
    assert.ok(CSS.split(`${variable}:`).length - 1 >= 3, `${variable} is defined in all three theme blocks`);
  }
});

test('a list hangs: the bullet is its own column and the text column is what wraps', () => {
  assert.match(ruleOf('.md-li'), /display:\s*flex;/);
  assert.match(ruleOf('.md-mark'), /flex:\s*0 0 auto;/);
  assert.match(ruleOf('.md-li-text'), /min-width:\s*0;/);
  assert.match(ruleOf('.md-li-text'), /overflow-wrap:\s*anywhere;/);
  assert.match(ruleOf('.md-li-text'), /white-space:\s*pre-wrap;/, 'the line breaks of a continuation are kept');
});

test('headings are modest: nothing above 14px, and the sizes do not grow from level 4 on', () => {
  const size = (level) => parseFloat(MD_CSS.match(new RegExp(`\\.md-h${level}(?:, \\.md-h\\d)* \\{ font-size: ([\\d.]+)px; \\}`))[1]);
  const sizes = [1, 2, 3, 4].map(size);
  assert.deepEqual(sizes, [14, 13, 12.5, 12]);
  assert.ok(Math.max(...sizes) <= 14);
  assert.match(MD_CSS, /\.md-h4, \.md-h5, \.md-h6 \{ font-size: 12px; \}/);
});
