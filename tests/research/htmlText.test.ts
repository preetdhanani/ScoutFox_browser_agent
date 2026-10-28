import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeEntities, htmlTitle, htmlToText, readHtml } from '../../src/background/research/htmlText.ts';

test('htmlToText drops script, style, noscript, svg, head and comments, and keeps the prose', () => {
  const html = `<!doctype html><html><head><title>T</title><style>.a{color:red}</style><script>var x = "<p>secret</p>";</script></head>
<body><noscript>enable js</noscript><!-- a comment --><svg><text>chart label</text></svg><p>Hello <b>world</b>.</p></body></html>`;
  const text = htmlToText(html);
  assert.equal(text, 'Hello world.');
});

test('htmlToText puts each block on its own line and joins source line breaks inside a block', () => {
  const html = '<h1>Install   the\nCLI</h1><p>first</p><div>second<br>third</div><ul><li>one</li><li>two</li></ul>';
  assert.equal(htmlToText(html), 'Install the CLI\nfirst\nsecond\nthird\none\ntwo');
});

test('htmlToText keeps the line breaks of <pre> and the cells of a table row apart', () => {
  const html = '<pre><code>curl -fsSL https://x/install.sh | sh\nlantern --version</code></pre><table><tr><th>OS</th><th>File</th></tr><tr><td>Linux</td><td>a.tar.zst</td></tr></table>';
  assert.equal(htmlToText(html), 'curl -fsSL https://x/install.sh | sh\nlantern --version\nOS | File\nLinux | a.tar.zst');
});

test('htmlToText decodes entities after the tags are gone, so &lt;p&gt; stays text', () => {
  assert.equal(htmlToText('<p>a &lt;p&gt; tag &amp; &#39;quotes&#39; &#x2713; &nbsp;x&mdash;y</p>'), "a <p> tag & 'quotes' ✓ x-y");
});

test('htmlToText survives broken HTML: an unclosed script and a tag cut off at the end', () => {
  assert.equal(htmlToText('<p>kept</p><script>var never = 1;'), 'kept');
  assert.equal(htmlToText('<p>kept</p><a href="x'), 'kept');
});

test('htmlToText collapses long repeated runs the way a page read does', () => {
  const html = `<p>${Array.from({ length: 12 }, () => 'Add to cart').join(' ')}</p>`;
  assert.match(htmlToText(html), /repeated 12 times/);
});

test('htmlTitle reads the decoded title on one line', () => {
  assert.equal(htmlTitle('<head><title>Docs &amp;\n more</title></head>'), 'Docs & more');
  assert.equal(htmlTitle('<p>no title</p>'), '');
});

test('decodeEntities leaves an unknown or invalid reference as it is', () => {
  assert.equal(decodeEntities('&bogus; &#0; &#xD800; &amp'), '&bogus; &#0; &#xD800; &');
});

// The page is parsed the way a browser parses it (htmlDocument.ts): markup inside attributes and
// scripts is never text. The shapes below are the ones that leaked from real pages with the old
// regex tokenizer (frame.work: Stimulus data-action values; Wikipedia: data-mw JSON with <!-- -->).

test('a > inside a quoted attribute does not end the tag (Stimulus, Alpine, single quotes)', () => {
  const html = `<header data-action="click->menu#toggle keydown@window->menu#close" x-show="open > 0" title='1 > 0'>Framework Laptop 13</header>
<button data-action='turbo:before-cache@window->tooltip#teardown'>Add to cart</button>`;
  assert.equal(htmlToText(html), 'Framework Laptop 13\nAdd to cart');
});

test('a <!-- or --> inside an attribute does not start or end a comment (Wikipedia data-mw)', () => {
  const html = `<table class="infobox" data-mw='{"parts":[{"template":{"params":{"coordinates":{"wt":"\\n<!--\\n | latd = 48.8583\\n-->"}}}}]}'><tr><th>Height</th><td>330 m</td></tr></table><p>After the box.</p>`;
  assert.equal(htmlToText(html), 'Height | 330 m\nAfter the box.');
});

test('"</div>" and <!-- inside a script string do not end or leak the script', () => {
  const html = '<div>before</div><script>var a = "</div><p>leak</p>"; /* <!-- */ var b = "-->";</script><div>after</div>';
  assert.equal(htmlToText(html), 'before\nafter');
});

test('end tags are matched like a browser: </script >, </SCRIPT>, nested svg, template and noscript', () => {
  assert.equal(htmlToText('<p>a</p><script>x()</script ><p>b</p><SCRIPT>y()</SCRIPT><p>c</p>'), 'a\nb\nc');
  assert.equal(htmlToText('<p>a</p><svg><svg><text>inner</text></svg><text>outer</text></svg><p>b</p>'), 'a\nb');
  assert.equal(htmlToText('<p>a</p><template><p>later</p></template><noscript><p>enable js</p></noscript><p>b</p>'), 'a\nb');
});

test('a < that starts no tag is text, and entities are decoded exactly once', () => {
  assert.equal(htmlToText('<p>a < b and I <3 it</p>'), 'a < b and I <3 it');
  assert.equal(htmlToText('<p>write &amp;lt; for &lt;</p>'), 'write &lt; for <');
});

test('a body cut off inside an attribute drops only that tag', () => {
  assert.equal(htmlToText('<p>kept</p><p>also kept</p><a href="https://x.test/?q=1 > 2'), 'kept\nalso kept');
});

test('pinned layout: foster-parented table text, the first newline of <pre>, <textarea> line breaks', () => {
  // Text directly inside <table> is moved before the table by the parser, as in a browser.
  assert.equal(htmlToText('<table>stray<tr><td>a</td><td>b</td></tr></table>'), 'stray\na | b');
  assert.equal(htmlToText('<pre>\nline 1\nline 2</pre>'), 'line 1\nline 2');
  assert.equal(htmlToText('<textarea>one\ntwo</textarea><p>next</p>'), 'one\ntwo\nnext');
});

test('invisible characters go, dashes become "-" and typographic spaces a space, written or referenced', () => {
  assert.equal(htmlToText('<p>Eiffel­Tower Eif&shy;fel a​b x&zwj;y</p>'), 'EiffelTower Eiffel ab xy');
  assert.equal(htmlToText('<p>1889–1890 &mdash; − 5 a b</p>'), '1889-1890 - - 5 a b');
});

test('readHtml gives the title and the text from one parse; an SVG <title> is not the page title', () => {
  const read = readHtml('<html><head><title> Docs\n &amp; more</title></head><body><svg><title>icon</title></svg><h1>Hi</h1></body></html>');
  assert.deepEqual(read, { title: 'Docs & more', text: 'Hi' });
  assert.equal(readHtml('<svg><title>icon</title></svg><p>x</p>').title, '');
});
