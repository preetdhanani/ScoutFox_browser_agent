/**
 * The context meter of the composer (sidepanel/contextMeter.js) and the "Chat compacted" divider
 * of the timeline (sidepanel/sidepanel.js).
 *
 * What these tests hold on to:
 *   1. The ring fills by used / window, is neutral below 70%, amber from 70% and red from 90%, and
 *      its label says "Context: 12% of 256K used". An empty chat is 0% with no arc.
 *   2. The card names the model and the window with its source, shows the bar of this chat with
 *      "31.2K of 256K" and the percent, says "Estimated" when the count is one, says that earlier
 *      answers are sent, and has Compact and the way to Settings.
 *   3. Compact is off while a task runs, when there is no earlier turn, while it is compacting, and
 *      for a saved chat from Recent tasks (whose ring is off too).
 *   4. The divider is its own item between turns: not a run, no steps, never the live turn, and it
 *      holds the summary in a section the reader opens.
 *   5. The new rules are built from theme tokens only, so they read in light and dark.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CHAIN_NOTE, contextCardHtml, contextWindowHint, levelOf, meterView, percentText, ringSvg } from '../../sidepanel/contextMeter.js';

globalThis.window = { addEventListener() {} };
globalThis.document = { readyState: 'loading', addEventListener() {}, getElementById: () => null };
const { renderTurns, buildTurns } = await import('../../sidepanel/sidepanel.js');

const CSS = fs.readFileSync(new URL('../../sidepanel/sidepanel.css', import.meta.url), 'utf8');
const HTML = fs.readFileSync(new URL('../../sidepanel/sidepanel.html', import.meta.url), 'utf8');

const ctx = (over = {}) => ({ used: 31_200, window: 262144, windowSource: 'default', estimated: false, summarizedTurns: 0, hasEarlierTurn: true, compacting: false, ...over });

test('the ring fills by the share of the window, with the colour of its level and a label', () => {
  const v = meterView(ctx());
  assert.equal(v.pctText, '12%');
  assert.equal(v.level, 'ok');
  assert.equal(v.label, 'Context: 12% of 256K used');
  const ring = ringSvg(v);
  assert.match(ring, /width="16" height="16"/);
  assert.match(ring, /class="ctx-ring ctx-ok"/);
  const dash = /stroke-dasharray="([\d.]+) ([\d.]+)"/.exec(ring);
  assert.ok(dash, 'the arc has a length');
  assert.ok(Math.abs(Number(dash[1]) / Number(dash[2]) - 31_200 / 262144) < 0.01, 'the arc is the share of the circle');

  assert.equal(levelOf(69.9), 'ok');
  assert.equal(levelOf(70), 'warn');
  assert.equal(levelOf(90), 'high');
  assert.match(ringSvg(meterView(ctx({ used: 190_000 }))), /ctx-warn/, 'amber from 70%');
  assert.match(ringSvg(meterView(ctx({ used: 240_000 }))), /ctx-high/, 'red from 90%');
  assert.equal(meterView(ctx({ used: 999_999 })).pct, 100, 'never past full');
});

test('an empty chat is 0% with no arc; a tiny share says "<1%"', () => {
  const v = meterView(ctx({ used: 0, hasEarlierTurn: false }));
  assert.equal(v.label, 'Context: 0% of 256K used');
  assert.match(ringSvg(v), /class="ctx-ring-arc"[^>]* hidden/, 'no arc is drawn');
  assert.equal(percentText(0.3), '<1%');
  assert.equal(meterView(null).label, 'Context: 0% of 256K used', 'no state yet is an empty meter');
});

test('the card: model, window and its source, the bar with the numbers, the note, Compact and Settings', () => {
  const html = contextCardHtml(meterView(ctx({ estimated: true }), { model: 'lisa-pro' }));
  assert.match(html, /Context · <span class="ctx-model">lisa-pro<\/span>/);
  assert.match(html, /256K, default/);
  assert.match(html, /This chat/);
  assert.match(html, /31\.2K of 256K · 12%/);
  assert.match(html, /class="ctx-bar-fill ctx-ok" style="width:11\.9%"/);
  assert.match(html, /aria-valuenow="12"/);
  assert.match(html, /Estimated/);
  assert.ok(html.includes(CHAIN_NOTE));
  assert.match(CHAIN_NOTE, /earlier answers of this chat are sent with each new request/i);
  assert.match(html, /data-ctx="compact"[^>]*>Compact chat</);
  assert.doesNotMatch(html, /data-ctx="compact" disabled/);
  assert.match(html, /data-ctx="settings"[^>]*>Set the window in Settings</);

  const reported = contextCardHtml(meterView(ctx({ estimated: false })));
  assert.doesNotMatch(reported, /Estimated/, 'a count the provider reported is not called an estimate');
  assert.match(contextCardHtml(meterView(ctx({ windowSource: 'provider', window: 131072 }))), /128K, from the provider/);
  assert.match(contextCardHtml(meterView(ctx({ windowSource: 'user', window: 1_000_000 }))), /1M, set by you/);
  assert.match(contextCardHtml(meterView(ctx({ summarizedTurns: 3 }))), /3 earlier turns are sent as a summary/);
  assert.match(contextCardHtml(meterView(ctx(), { model: '<b>x</b>' })), /&lt;b&gt;x&lt;\/b&gt;/, 'the model name is escaped');
});

test('Compact is off while a task runs, with no earlier turn, and while compacting', () => {
  const off = (view) => /data-ctx="compact" disabled/.test(contextCardHtml(view));
  assert.equal(off(meterView(ctx())), false);
  assert.equal(off(meterView(ctx(), { busy: true })), true);
  assert.match(meterView(ctx(), { busy: true }).compactTitle, /Stop the task/);
  assert.equal(off(meterView(ctx({ hasEarlierTurn: false }))), true);
  assert.equal(off(meterView(ctx({ compacting: true }))), true);
  assert.match(contextCardHtml(meterView(ctx({ compacting: true }))), /Compacting…/);
  assert.equal(off(meterView(ctx(), { pending: true })), true, 'off while this panel waits for the answer');
});

test('the Settings line says the window, where it comes from, and that it is num_ctx for Ollama', () => {
  assert.match(contextWindowHint({ tokens: 262144, source: 'default' }, 'lisa'), /^Now 256K \(default\)\. Takes 200000, 200K or 1M\./);
  assert.match(contextWindowHint({ tokens: 32768, source: 'provider' }, 'ollama'), /Now 32K \(from the provider\)[\s\S]*num_ctx/);
  assert.doesNotMatch(contextWindowHint(null, 'openrouter'), /num_ctx|Now/);
});

test('the composer has the ring before the effort button, and Settings has the window field', () => {
  assert.ok(HTML.indexOf('id="btnContext"') > 0 && HTML.indexOf('id="btnContext"') < HTML.indexOf('id="btnEffort"'), 'the ring comes before the effort');
  assert.match(HTML, /id="contextMenu"[^>]*role="dialog"[^>]*hidden/);
  assert.match(HTML, /id="contextWindowInput"/);
});

/** Two runs with a Compact between them; the second is live. */
function compactedChat() {
  return [
    { type: 'user_goal', turn: 1, prompt: 'How many certifications?', timestamp: '10:00:00', isNewRun: true },
    { type: 'agent_response', step: 1, thought: '', action: { action: 'read_page' }, rawResponse: '{}' },
    { type: 'execution_result', step: 1, success: true, message: 'read' },
    { type: 'finish', answer: 'The page lists 10 certifications.', outcome: 'done' },
    { type: 'chat_compacted', summary: 'The user asked how many certifications the page lists <b>10</b>.', summarizedTurns: 1, timestamp: '10:01:00' },
    { type: 'user_goal', turn: 2, prompt: 'Multiply it by 7', timestamp: '10:02:00', isNewRun: true },
    { type: 'agent_response', step: 1, thought: '', action: { action: 'scroll', direction: 'down' }, rawResponse: '{}' }
  ];
}

test('the divider is its own item between turns, with the summary in a section the reader opens', () => {
  const items = buildTurns(compactedChat());
  assert.deepEqual(items.map((i) => (i.compacted ? 'compacted' : `turn ${i.turn}`)), ['turn 1', 'compacted', 'turn 2']);
  const html = renderTurns(compactedChat(), 'running', 'Working');
  const at = (s) => html.indexOf(s);
  assert.ok(at('How many certifications?') < at('Chat compacted') && at('Chat compacted') < at('Multiply it by 7'), 'between the turns');
  assert.match(html, /<details class="compact-summary" data-compact-key="4">/, 'closed until the reader opens it');
  assert.match(html, /Summary of 1 earlier turn</);
  assert.match(html, /&lt;b&gt;10&lt;\/b&gt;/, 'the summary is escaped');
  // The live turn is the second run, not the divider: its header counts its own actions.
  assert.match(html, /Working · 1 action</);
  assert.equal((html.match(/Working ·/g) || []).length, 1);
  assert.match(html, /Run #2/);
  assert.equal((html.match(/class="turn"/g) || []).length, 2, 'two runs, the divider is not one');
});

test('an automatic Compact says so, and a stopped run after a divider still gets its own card', () => {
  const history = [...compactedChat().slice(0, 4), { ...compactedChat()[4], auto: true }];
  assert.equal(buildTurns(history).at(-1).compacted, true);
  assert.match(renderTurns(history, 'idle', ''), /Chat compacted automatically/);
  const stopped = renderTurns([...compactedChat()], 'stopped', '');
  assert.match(stopped, /Stopped by you/, 'the synthetic end card goes to the last run, not to the divider');
  assert.ok(stopped.indexOf('Stopped by you') > stopped.indexOf('Chat compacted'));
});

test('a Compact after a stopped run: the divider is last, and the stopped run keeps its one card', () => {
  const history = [
    { type: 'user_goal', turn: 1, prompt: 'Count them', timestamp: '10:00:00', isNewRun: true },
    { type: 'agent_response', step: 1, thought: '', action: { action: 'read_page' }, rawResponse: '{}' },
    { type: 'partial_result', answer: 'The run was stopped before it finished.', table: null, reason: 'stopped' },
    { type: 'chat_compacted', summary: 'Nothing was counted.', summarizedTurns: 1, timestamp: '10:03:00' }
  ];
  const html = renderTurns(history, 'stopped', '');
  assert.equal((html.match(/class="finish-card/g) || []).length, 1, 'one end card, on the run');
  assert.ok(html.indexOf('finish-card') < html.indexOf('Chat compacted'), 'the divider comes after the run');
});

test('the new rules are built from theme tokens only', () => {
  const rules = ['.composer-ring {', '.ctx-ring-arc {', '.ctx-menu {', '.ctx-bar {', '.ctx-bar-fill {', '.ctx-compact {', '.compact-tag {', '.compact-summary {', '.compact-divider::before,'];
  for (const rule of rules) {
    const at = CSS.indexOf(rule);
    assert.ok(at >= 0, `${rule} exists`);
    const body = CSS.slice(CSS.indexOf('{', at) + 1, CSS.indexOf('}', at));
    assert.equal(/#[0-9a-f]{3,8}\b|rgba?\(/i.test(body), false, `${rule} uses tokens, not literal colours`);
  }
  assert.match(CSS, /\.ctx-ring\.ctx-warn \.ctx-ring-arc \{ stroke: var\(--warning\); \}/);
  assert.match(CSS, /\.ctx-ring\.ctx-high \.ctx-ring-arc \{ stroke: var\(--danger\); \}/);
});
