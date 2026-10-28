/**
 * The repeat guard of the tool loop (src/background/mcp/progress.ts): what makes two steps the
 * same, when a step changed nothing, when the per-tool hint comes, and when the one reflection
 * note is due. Pure code, so every rule is checked here without a browser.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ProgressTracker,
  REFLECTION_THRESHOLD,
  REFLECTION_WINDOW,
  REPEAT_HINT_PREFIX,
  repeatHint,
  stepKey
} from '../../src/background/mcp/progress.ts';
import { observationLine, SAME_PICTURE_NOTE, SAME_TEXT_NOTE } from '../../src/background/mcp/server.ts';
import { PLAN_FIRST_TEXT } from '../../src/background/mcp/client.ts';

/** The server's own quiet observation, so the tracker is checked against the real wording. */
const QUIET = observationLine({
  base: true, url: 'https://a.test/', urlChanged: false, focus: null, focusChanged: false,
  scroll: { x: 0, y: 0 }, scrollChanged: false, container: null, textHash: 'h', textChanged: false,
  added: '', removed: '', changedChars: 0
} as any);
const CHANGED = observationLine({
  base: true, url: 'https://a.test/', urlChanged: false, focus: null, focusChanged: false,
  scroll: { x: 0, y: 0 }, scrollChanged: false, container: null, textHash: 'h2', textChanged: true,
  added: 'Saved', removed: '', changedChars: 5
} as any);
const deadClick = `Clicked element [3]\n${QUIET}`;

test('stepKey: the reason is ignored, coordinates snap to 24 px, element ids are normalized', () => {
  assert.equal(stepKey('click', { x: 700, y: 410, reason: 'a' }), stepKey('click', { x: 705, y: 405, reason: 'b' }));
  assert.notEqual(stepKey('click', { x: 700, y: 420 }), stepKey('click', { x: 760, y: 420 }));
  assert.equal(stepKey('click', { element_id: '7' }), stepKey('click', { element_id: 7 }));
  assert.equal(stepKey('click', { element_id: 'None', x: 10, y: 10 }), stepKey('click', { x: 10, y: 10 }));
  assert.equal(stepKey('find', { query: '  Export   CSV ' }), stepKey('find', { query: 'Export CSV' }));
  assert.notEqual(stepKey('read_page', { part: 1 }), stepKey('read_page', { part: 2 }));
  assert.notEqual(stepKey('click', { element_id: 3 }), stepKey('scroll', { element_id: 3 }));
});

test('the second identical no-progress step gets the per-tool hint, the first does not', () => {
  const t = new ProgressTracker();
  assert.equal(t.record('click', { element_id: 3 }, deadClick).hint, null);
  const second = t.record('click', { element_id: 3, reason: 'again' }, deadClick);
  assert.ok(second.hint?.startsWith(REPEAT_HINT_PREFIX));
  assert.match(second.hint!, /press_key select_all, then type without element_id/);
  assert.equal(second.repeats, 2);
});

test('a step that changed something never gets a hint, even when repeated', () => {
  const t = new ProgressTracker();
  for (let i = 0; i < 5; i++) {
    const note = t.record('click', { element_id: 3 }, `Clicked element [3]\n${CHANGED}`);
    assert.equal(note.hint, null);
    assert.equal(note.reflect, false);
  }
});

test('per-tool hints: scroll that did not move, repeated read, repeated screenshot', () => {
  const t = new ProgressTracker();
  t.record('scroll', { direction: 'down' }, 'Did not move: the page did not scroll.');
  assert.match(t.record('scroll', { direction: 'down' }, 'Did not move: the page did not scroll.').hint || '', /element_id of the panel.*PageDown/);
  assert.equal(t.record('read_page', {}, 'Page text').hint, null);
  assert.match(t.record('read_page', {}, `${SAME_TEXT_NOTE}\nPage text`).hint || '', /read_page \{part\}.*element_id.*find/);
  assert.equal(t.record('take_screenshot', {}, 'Captured').hint, null);
  assert.match(t.record('take_screenshot', {}, `${SAME_PICTURE_NOTE} Captured`).hint || '', /picture did not change.*act/i);
  assert.match(repeatHint('navigate', 2), /choose another tool/);
});

test('an element list or find that brings the same text again is no progress', () => {
  const t = new ProgressTracker();
  assert.equal(t.record('find', { query: 'x' }, '[1] button "X"').hint, null);
  assert.ok(t.record('find', { query: 'x' }, '[1] button "X"').hint);
  // A first error is not held against the run; the same error again is.
  const u = new ProgressTracker();
  assert.equal(u.record('click', { element_id: 9 }, 'Error: covered').hint, null);
  assert.ok(u.record('click', { element_id: 9 }, 'Error: covered').hint);
});

test(`the reflection comes after ${REFLECTION_THRESHOLD} no-progress steps within ${REFLECTION_WINDOW}, at most once per window`, () => {
  const t = new ProgressTracker();
  const notes = [];
  notes.push(t.record('get_page_elements', {}, '[3] button "Export"'));
  for (let i = 0; i < 4; i++) notes.push(t.record('click', { element_id: 3 }, deadClick));
  assert.deepEqual(notes.map((n) => n.reflect), [false, false, false, false, true]);
  // Still stuck: no second reflection until six more steps have passed.
  const more = [];
  for (let i = 0; i < 6; i++) more.push(t.record('click', { element_id: 3 }, deadClick).reflect);
  assert.deepEqual(more, [false, false, false, false, false, true]);
});

test('the window is run-wide: different stuck steps add up, progress in between dilutes them', () => {
  const t = new ProgressTracker();
  t.record('click', { x: 700, y: 420 }, deadClick);
  t.record('scroll', { direction: 'down' }, 'Did not move: x.');
  t.record('click', { element_id: 2 }, `ok\n${CHANGED}`);
  t.record('take_screenshot', {}, `${SAME_PICTURE_NOTE} Captured`);
  const fourth = t.record('press_key', { key: 'Tab' }, `Pressed Tab\n${QUIET}`);
  assert.equal(fourth.noProgressInWindow, 4);
  assert.equal(fourth.reflect, true);
  const v = new ProgressTracker();
  for (const tool of ['click', 'read_page', 'click', 'read_page', 'click', 'read_page']) {
    v.record(tool, { n: Math.random() }, tool === 'click' ? deadClick : 'new text');
  }
  assert.equal(v.record('read_page', { n: 1 }, 'fresh').reflect, false);
});

test('PLAN_FIRST refusals and update_plan never count, and update_plan does not reset the record', () => {
  const t = new ProgressTracker();
  for (let i = 0; i < 6; i++) {
    const note = t.record('click', { element_id: 3 }, PLAN_FIRST_TEXT, { planFirst: true });
    assert.equal(note.hint, null);
    assert.equal(note.reflect, false);
  }
  assert.equal(t.count, 0);
  t.record('click', { element_id: 3 }, deadClick);
  t.record('click', { element_id: 3 }, deadClick);
  t.record('update_plan', { plan: ['Try again'] }, 'Plan approved. Execute the plan step by step.');
  assert.equal(t.count, 2);
  t.record('click', { element_id: 3 }, deadClick);
  assert.equal(t.record('click', { element_id: 3 }, deadClick).reflect, true);
});

test('a wait counts only when the read after it is unchanged', () => {
  const t = new ProgressTracker();
  t.record('wait', { amount: 2 }, 'Waited 2s');
  t.record('read_page', {}, 'Page text v1');
  t.record('wait', { amount: 2 }, 'Waited 2s');
  const changed = t.record('read_page', {}, 'Page text v2');
  assert.equal(changed.noProgressInWindow, 0, 'a wait followed by new text is progress');
  t.record('wait', { amount: 2 }, 'Waited 2s');
  const same = t.record('read_page', {}, `${SAME_TEXT_NOTE}\nPage text v2`);
  assert.equal(same.noProgressInWindow, 2, 'the wait and the unchanged read both changed nothing');
  // A pending wait never counts on its own.
  const u = new ProgressTracker();
  for (let i = 0; i < 3; i++) u.record('wait', { amount: 1 }, 'Waited 1s');
  assert.equal(u.record('wait', { amount: 1 }, 'Waited 1s').noProgressInWindow, 0);
});

test('reset clears the record for a new task', () => {
  const t = new ProgressTracker();
  t.record('click', { element_id: 3 }, deadClick);
  t.reset();
  assert.equal(t.record('click', { element_id: 3 }, deadClick).hint, null);
});
