/**
 * The side panel stylesheet and the markup it styles stay in step.
 *
 * What these tests hold on to:
 *   1. The action button in the custom provider dialog's error box (.cp-error-action) has a rule,
 *      built only from theme tokens, so it reads in light and dark.
 *   2. Rules for classes that nothing renders any more are gone: a dead rule hides real ones
 *      and makes the next change harder to judge.
 *   3. cards.js has no orphan comment naming a renderer that no longer exists.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const CSS = read('../../sidepanel/sidepanel.css');
const CARDS = read('../../sidepanel/cards.js');
const MARKUP = ['sidepanel.js', 'cards.js', 'customProvider.js', 'brand.js', 'sidepanel.html']
  .map((f) => read(`../../sidepanel/${f}`)).join('\n');

/** The body of the first rule whose selector list starts with the given selector. */
function ruleBody(selector) {
  const at = CSS.indexOf(`${selector} {`);
  if (at < 0) return null;
  return CSS.slice(CSS.indexOf('{', at) + 1, CSS.indexOf('}', at));
}

test('the error box action button has a rule built from theme tokens', () => {
  assert.ok(MARKUP.includes("'cp-error-action'"), 'the dialog still renders the button');
  const body = ruleBody('.cp-error-action');
  assert.ok(body, 'a .cp-error-action rule exists');
  const colors = body.match(/(?:color|background|border)[^:]*:\s*[^;]+/g) || [];
  assert.ok(colors.length >= 2, 'it sets its colours');
  for (const decl of colors) {
    assert.equal(/#[0-9a-f]{3,8}\b|rgb/i.test(decl), false, `uses tokens, not literal colours: ${decl}`);
  }
  assert.ok(CSS.includes('.cp-error-action:hover'), 'it has a hover state');
  assert.ok(CSS.includes('.cp-error-action:focus-visible'), 'it has a keyboard focus ring');
});

const DEAD_CLASSES = [
  'plan-estimates-row', 'btn-level-chip', 'nested-graph-strip', 'sandbox-badge', 'toggle-group',
  'version-badge', 'timeline-card', 'badge-primary', 'badge-info', 'badge-neutral',
  // Found dead along the way: the old timeline card, the old plan card, and the old toggles.
  'timeline-header', 'step-badge', 'thought-text', 'chat-header-bar', 'toggle-label',
  'plan-sites-container', 'site-goal-text', 'estimate-item', 'plan-level-picker',
  'plan-overbudget-banner', 'plan-fallback-banner'
];

test('no rule styles a class that nothing renders', () => {
  for (const cls of DEAD_CLASSES) {
    assert.equal(MARKUP.includes(cls), false, `${cls} is not rendered anywhere`);
    assert.equal(new RegExp(`\\.${cls}(?![\\w-])`).test(CSS), false, `.${cls} has no rule left`);
  }
  // Every .plan-card-* rule must match something the panel renders.
  for (const [, cls] of CSS.matchAll(/\.(plan-card-[\w-]+)/g)) {
    assert.ok(MARKUP.includes(cls), `.${cls} is rendered somewhere`);
  }
});

test('cards.js has no orphan comment for the removed plan approval renderer', () => {
  assert.equal(/Render Plan Approval Card/.test(CARDS), false);
});
