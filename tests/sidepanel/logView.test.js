/**
 * The Logs tab (sidepanel/logView.js): each entry is a sentence and its details as an expandable
 * JSON tree. The details come from the model and the page, so every key and value is escaped.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSON_STRING_PREVIEW, logEntryHtml, logMatchesFilter, renderJsonTree, treeStateKey } from '../../sidepanel/logView.js';
import { describeStep } from '../../src/shared/stepText.ts';

const toolEntry = {
  id: 'e1',
  timestamp: '10:00:01',
  level: 'INFO',
  kind: 'tool',
  module: 'Agent',
  message: 'Clicking element [12] button "Buy"',
  data: JSON.stringify({ step: 3, tool: 'click', arguments: { element_id: 12 }, result: { ok: true, text: 'Clicked' } })
};

test('an entry shows its sentence, its kind, and its details as a tree with the root open', () => {
  const html = logEntryHtml(toolEntry);
  assert.match(html, /Clicking element \[12\] button &quot;Buy&quot;/);
  assert.match(html, /class="log-kind log-kind-badge-tool">Step</);
  assert.match(html, /class="jt-toggle" data-path="\$" aria-expanded="true"/, 'the root is open');
  assert.match(html, /data-path="\$\.arguments" aria-expanded="false"/, 'deeper levels start closed');
  assert.match(html, /<span class="jt-key">"tool"<\/span>/);
  assert.match(html, /<span class="jt-str">"click"<\/span>/);
  assert.match(html, /<span class="jt-num">3<\/span>/);
  assert.match(html, /Copy JSON/);
});

test('a node the reader opened stays open on the next render', () => {
  const state = new Map([[treeStateKey('e1', '$.arguments'), true], [treeStateKey('e1', '$'), false]]);
  const html = logEntryHtml(toolEntry, { state });
  assert.match(html, /data-path="\$" aria-expanded="false"/);
  assert.match(html, /data-path="\$\.arguments" aria-expanded="true"/);
});

test('hostile text in a key, a value, the message or the module is shown as text, never as markup', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const html = logEntryHtml({
    id: '"><script>x</script>',
    timestamp: evil,
    level: 'INFO',
    kind: 'llm',
    module: evil,
    message: evil,
    data: JSON.stringify({ [evil]: evil, list: [evil], long: evil.repeat(100) })
  });
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /<script/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('a long string shows its start and a button for the rest', () => {
  const html = renderJsonTree({ text: 'a'.repeat(JSON_STRING_PREVIEW + 50) }, { entryId: 'x' });
  assert.match(html, /class="jt-more"/);
  assert.match(html, /show all 350 characters/);
  assert.match(html, /class="jt-str jt-str-full" hidden/);
});

test('details that are not JSON show as plain text; an entry without details has no tree', () => {
  assert.match(logEntryHtml({ ...toolEntry, data: 'Error: stack line' }), /<pre class="log-payload">Error: stack line<\/pre>/);
  assert.doesNotMatch(logEntryHtml({ ...toolEntry, data: null }), /class="jt"/);
});

test('the filters: All is the run without plumbing, System is the plumbing', () => {
  const debug = { level: 'DEBUG', kind: 'system', message: '[PORT_CONNECT]' };
  const sysWarn = { level: 'WARN', kind: 'system', message: 'warn' };
  const llm = { level: 'INFO', kind: 'llm' };
  const legacy = { level: 'INFO', message: '[KEEPALIVE_ON] old entry without a kind' };
  assert.equal(logMatchesFilter(debug, 'all'), false, 'ports and keepalive are not in All');
  assert.equal(logMatchesFilter(legacy, 'all'), false);
  assert.equal(logMatchesFilter(sysWarn, 'all'), true, 'a warning is');
  assert.equal(logMatchesFilter(toolEntry, 'all'), true);
  assert.equal(logMatchesFilter(toolEntry, 'agent'), true);
  assert.equal(logMatchesFilter(llm, 'llm'), true);
  assert.equal(logMatchesFilter(llm, 'agent'), false);
  assert.equal(logMatchesFilter(debug, 'system'), true);
});

test('describeStep says what the agent is doing, with the element and the reason', () => {
  assert.equal(describeStep('click', { element_id: 12, reason: 'to add it to the cart' }, '[12] button[button] "In den Warenkorb"'), 'Clicking element [12] button "In den Warenkorb" - to add it to the cart');
  assert.equal(describeStep('navigate', { url: 'https://www.python.org' }), 'Opening https://www.python.org');
  assert.equal(describeStep('click', { x: 10, y: 20 }), 'Clicking at (10, 20) on the screenshot');
  assert.equal(describeStep('type', { element_id: 3, text: 'Hof', submit: true }), 'Typing "Hof" into element [3] and submitting');
  assert.equal(describeStep('update_plan', { plan: ['a', 'b'] }), 'Planning the work in 2 steps');
  assert.equal(describeStep('something_new', {}), 'Calling something_new');
});

test('describeStep names a key press with its modifiers, and a type into the focused element', () => {
  assert.equal(describeStep('press_key', { key: 'Enter', modifiers: ['shift'] }), 'Pressing Shift+Enter');
  assert.equal(describeStep('press_key', { key: 'select_all', reason: 'select the code' }), 'Pressing select all - select the code');
  assert.equal(describeStep('type', { text: 'echo hi' }), 'Typing "echo hi" into the focused element');
  assert.equal(describeStep('type', { text: ' more', mode: 'append' }), 'Appending "more" to the focused element');
});
