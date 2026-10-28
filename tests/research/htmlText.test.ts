import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeEntities, htmlTitle, htmlToText } from '../../src/background/research/htmlText.ts';

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
