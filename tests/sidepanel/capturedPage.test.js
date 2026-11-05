/**
 * The captured page of an action group: the last picture a turn took, as a thumbnail at the end of
 * the collapsed group's head, and at full width under "Captured page" at the top of an opened,
 * finished group.
 *
 * What these tests hold on to:
 *   1. A collapsed group's head carries a thumbnail slot of the turn's LAST picture, hidden from
 *      screen readers; the head's label says the group has a captured page.
 *   2. A finished group's body starts with "Captured page" and that picture; its row slot is left
 *      out, so it is not shown twice. An earlier picture keeps its row slot.
 *   3. A live group has no section (its rows keep their pictures, nothing jumps), and its thumbnail
 *      follows the newest picture.
 *   4. Each picture has two elements in the cache, the picture and its thumbnail: the section and
 *      the head never take one element from each other, and nothing is cloned per render.
 *   5. A picture that is no longer kept: no thumbnail (its slot is removed), and the section says so.
 *   6. The stylesheet sizes the thumbnail (44 x 28), hides it in an open group, and caps the large
 *      picture at 220 px, with theme tokens only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

let slots = [];
globalThis.window = { addEventListener() {} };
globalThis.document = { readyState: 'loading', addEventListener() {}, getElementById: () => null, querySelectorAll: () => slots };

const { renderTurns, attachShotSlots, shotCache, shotGone, lastShotOf, buildTurns } = await import('../../sidepanel/sidepanel.js');
const CSS = fs.readFileSync(new URL('../../sidepanel/sidepanel.css', import.meta.url), 'utf8');

/** A turn that took two pictures, then finished. */
function history({ finished = true, first = 'shot-1', last = 'shot-2' } = {}) {
  const rows = [
    { type: 'user_goal', turn: 1, prompt: 'Look twice', isNewRun: true },
    { type: 'agent_response', step: 1, thought: '', action: { action: 'take_screenshot' }, rawResponse: '{}' },
    { type: 'execution_result', step: 1, success: true, message: 'Captured', imageId: first, imageWidth: 1200, imageHeight: 800 },
    { type: 'agent_response', step: 2, thought: '', action: { action: 'take_screenshot' }, rawResponse: '{}' },
    { type: 'execution_result', step: 2, success: true, message: 'Captured', imageId: last, imageWidth: 1000, imageHeight: 500 }
  ];
  if (finished) rows.push({ type: 'finish', answer: 'Seen.', outcome: 'done' });
  return rows;
}

const render = (rows, status) => renderTurns(rows, status, '', null, null, null, null, null, null, null);
const count = (html, re) => (html.match(re) || []).length;

test('the last picture of a turn is its captured page', () => {
  const [turn] = buildTurns(history());
  assert.deepEqual(lastShotOf(turn), { imageId: 'shot-2', width: 1000, height: 500 });
  const [none] = buildTurns([{ type: 'user_goal', turn: 1, prompt: 'x' }, { type: 'agent_response', step: 1, action: { action: 'read_page' } }]);
  assert.equal(lastShotOf(none), null);
});

test('a collapsed group shows the captured page as a thumbnail in its head, named in its label', () => {
  const html = render(history(), 'idle');
  assert.match(html, /<div class="act-group">/, 'a finished group is collapsed');
  const head = /<button class="act-head"[^>]*>[\s\S]*?<\/button>/.exec(html)[0];
  assert.match(head, /aria-label="2 actions, with a captured page"/);
  assert.match(head, /<span class="act-head-thumb" data-thumb="shot-2" aria-hidden="true"><\/span>/);
});

test('a finished group starts with "Captured page" and leaves that picture out of its row', () => {
  const html = render(history(), 'idle');
  const body = /<div class="act-body"[^>]*>([\s\S]*)<\/div>\s*<\/div>/.exec(html)[1];
  assert.ok(body.trimStart().startsWith('<div class="act-captured"><div class="act-captured-label">Captured page</div>'), 'the section comes first');
  assert.match(body, /class="act-shot-slot act-captured-slot" data-shot="shot-2" data-w="1000" data-h="500" style="aspect-ratio: 1000 \/ 500"/);
  assert.equal(count(html, /data-shot="shot-2"/g), 1, 'the last picture is shown once, in the section');
  assert.equal(count(html, /data-shot="shot-1"/g), 1, 'the earlier picture keeps its row slot');
});

test('a live group has no section, and its thumbnail follows the newest picture', () => {
  const one = render(history({ finished: false }).slice(0, 3), 'running');
  assert.doesNotMatch(one, /act-captured/);
  assert.match(one, /data-thumb="shot-1"/);
  const two = render(history({ finished: false }), 'running');
  assert.doesNotMatch(two, /act-captured/);
  assert.match(two, /data-thumb="shot-2"/);
  assert.equal(count(two, /data-shot="shot-2"/g), 1, 'the newest picture is under its row while the turn runs');
});

/** A slot as attachShotSlots meets it in the DOM. */
function fakeSlot(cls, attrs) {
  const children = [];
  return {
    removed: false,
    innerHTML: '',
    style: {},
    children,
    classList: { contains: (c) => cls.split(' ').includes(c) },
    getAttribute: (n) => attrs[n] ?? null,
    appendChild(el) { children.push(el); return el; },
    remove() { this.removed = true; }
  };
}

test('the section and the head get their own element of the same picture', () => {
  const img = { naturalWidth: 1000, naturalHeight: 500, setAttribute() {} };
  const thumb = { setAttribute() {} };
  shotCache.set('shot-pair', { dataUrl: 'data:image/jpeg;base64,AAA', img, thumb });
  const section = fakeSlot('act-shot-slot act-captured-slot', { 'data-shot': 'shot-pair', 'data-w': '1000', 'data-h': '500' });
  const head = fakeSlot('act-head-thumb', { 'data-thumb': 'shot-pair' });
  slots = [section, head];
  attachShotSlots();
  assert.equal(section.children[0], img, 'the section holds the picture');
  assert.equal(head.children[0], thumb, 'the head holds the thumbnail');
  assert.notEqual(section.children[0], head.children[0]);
  assert.equal(thumb.alt, '', 'the thumbnail is decorative');
  // A second render takes the same two elements again: nothing is cloned or decoded per render.
  const again = [fakeSlot('act-shot-slot', { 'data-shot': 'shot-pair' }), fakeSlot('act-head-thumb', { 'data-thumb': 'shot-pair' })];
  slots = again;
  attachShotSlots();
  assert.equal(again[0].children[0], img);
  assert.equal(again[1].children[0], thumb);
  slots = [];
});

test('a picture that is no longer kept has no thumbnail, and the section says so', () => {
  shotGone.add('shot-lost');
  const head = fakeSlot('act-head-thumb', { 'data-thumb': 'shot-lost' });
  const section = fakeSlot('act-shot-slot act-captured-slot', { 'data-shot': 'shot-lost' });
  slots = [head, section];
  attachShotSlots();
  assert.equal(head.removed, true, 'the thumbnail slot is taken out');
  assert.match(section.innerHTML, /Picture no longer kept/);
  slots = [];
  const html = render(history({ last: 'shot-lost' }), 'idle');
  assert.doesNotMatch(html, /act-head-thumb/);
  assert.match(html, /Captured page<\/div><span class="act-shot-gone">Picture no longer kept<\/span>/);
});

test('the stylesheet: a 44 x 28 thumbnail that steps aside in an open group, a 220 px picture, tokens only', () => {
  const rule = (sel) => {
    const at = CSS.indexOf(`${sel} {`);
    assert.ok(at >= 0, `${sel} has a rule`);
    return CSS.slice(CSS.indexOf('{', at) + 1, CSS.indexOf('}', at));
  };
  const thumb = rule('.act-head-thumb');
  assert.match(thumb, /width:\s*44px/);
  assert.match(thumb, /height:\s*28px/);
  assert.match(thumb, /border-radius:/);
  assert.match(thumb, /border:\s*1px solid var\(--border\)/);
  assert.match(thumb, /margin-left:\s*auto/, 'at the right end of the head');
  assert.match(CSS, /\.act-group\.open \.act-head-thumb \{ display: none; \}/);
  assert.match(rule('.act-captured .act-shot-slot'), /max-height:\s*220px/);
  for (const sel of ['.act-head-thumb', '.act-captured', '.act-captured-label', '.jump-latest']) {
    assert.doesNotMatch(rule(sel), /#[0-9a-f]{3,8}\b|rgb/i, `${sel} uses theme tokens only`);
  }
});
