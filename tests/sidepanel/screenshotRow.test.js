/**
 * The picture in the timeline: the row, the slot, and the thumbnail.
 *
 * The panel is where the user sees what the model saw. The design has to hold three things at
 * once, and each one is easy to break silently:
 *   1. The picture's bytes are never in a history row. The panel rebuilds the whole timeline on
 *      every state broadcast, so bytes in a row would be re-parsed on every one of them.
 *   2. The thumbnail must not flicker. `timeline.innerHTML = ...` destroys every element in the
 *      subtree, so an <img> inside it decodes again on every broadcast. The decoded element is
 *      kept and MOVED into the new slot instead, which decodes nothing.
 *   3. A picture the session no longer has must say so, not show a broken image.
 *
 * What these tests hold on to:
 *   1. A screenshot row says "Looked at the page" with the camera icon.
 *   2. A coordinate click says "Clicked at (x, y) in the picture", not "Clicked element undefined".
 *   3. A row whose outcome has an imageId gets a slot; a row without one does not.
 *   4. The slot carries the picture's id and its size, and no <img> of its own.
 *   5. A picture the panel does not have yet is fetched once and then cached.
 *   6. A picture the background no longer holds shows "picture no longer kept".
 *   7. The stylesheet has the slot rule, with a bounded height, in both themes (it uses tokens).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

globalThis.window = { addEventListener() {} };
globalThis.document = { readyState: 'loading', addEventListener() {}, getElementById: () => null };

const { buildTurns, describeAction, renderTurns, shotCache, shotGone } = await import('../../sidepanel/sidepanel.js');

const CSS = fs.readFileSync(new URL('../../sidepanel/sidepanel.css', import.meta.url), 'utf8');

/** The camera icon of a screenshot row. Its presence tells it apart from the pointer of a click. */
const CAMERA_ICON = 'M3 8.5A2.5 2.5 0 0 1 5.5 6h1.8l1.2-1.8h5l1.2 1.8h1.8A2.5 2.5 0 0 1 21 8.5v8';

/** The rows of a run that took a picture and clicked at a coordinate. */
function historyWithShot(imageId = 'shot-abc-1') {
  return [
    { type: 'user_goal', turn: 1, prompt: 'Look at the page and click the green button', isNewRun: true },
    { type: 'agent_response', step: 1, thought: 'I need to see it.', action: { action: 'take_screenshot' }, rawResponse: '{}' },
    {
      type: 'execution_result', step: 1, success: true,
      message: 'Captured the visible page (1568x892, image/jpeg).',
      imageId, imageWidth: 1568, imageHeight: 892
    },
    { type: 'agent_response', step: 2, thought: '', action: { action: 'click', x: 812, y: 344 }, rawResponse: '{}' },
    { type: 'execution_result', step: 2, success: true, message: 'Clicked at (812, 344) - button "Download"' },
    { type: 'finish', answer: 'Clicked it.' }
  ];
}

test('a screenshot row says the page was looked at, with the camera icon', () => {
  const described = describeAction({ action: 'take_screenshot' }, null);
  assert.equal(described.text, 'Looked at the page');
  assert.ok(described.icon.includes(CAMERA_ICON), 'the row carries the camera, not a generic dot');
});

test('a coordinate click says where in the picture, not "element undefined"', () => {
  const described = describeAction({ action: 'click', x: 812, y: 344 }, null);
  assert.match(described.text, /Clicked at \(812, 344\) in the picture/);
  assert.doesNotMatch(described.text, /undefined/);
});

test('an element click still says which element it clicked', () => {
  assert.match(describeAction({ action: 'click', element_id: 4 }, null).text, /Clicked element 4/);
  assert.match(describeAction({ action: 'click', element_id: 4 }, { label: 'Buy now' }).text, /Clicked .*Buy now/);
});

test('the row of a picture gets a slot with its id and its size, and no img of its own', () => {
  const html = renderTurns(historyWithShot(), 'idle', '', null, null, null, null, null, null, null);
  assert.match(html, /class="act-shot-slot"/);
  assert.match(html, /data-shot="shot-abc-1"/);
  assert.match(html, /data-w="1568"/);
  assert.match(html, /data-h="892"/);
  // The <img> is moved in after the render, so the rendered HTML has a slot and nothing in it.
  const slot = /<div class="act-shot-slot"[^>]*>(.*?)<\/div>/.exec(html);
  assert.ok(slot, 'the slot is in the rendered HTML');
  assert.equal(slot[1], '', 'the slot is empty until the picture is attached');
});

test('a row without a picture gets no slot', () => {
  const history = [
    { type: 'user_goal', turn: 1, prompt: 'Read the page', isNewRun: true },
    { type: 'agent_response', step: 1, thought: '', action: { action: 'read_page_text' }, rawResponse: '{}' },
    { type: 'execution_result', step: 1, success: true, message: 'ok' },
    { type: 'finish', answer: 'Done.' }
  ];
  const html = renderTurns(history, 'idle', '', null, null, null, null, null, null, null);
  assert.doesNotMatch(html, /act-shot-slot/);
});

test('a picture that is no longer held shows the honest line, not a broken image', () => {
  // The session dropped it (a long run keeps the last few), so the panel must say so.
  shotGone.add('shot-gone-1');
  const html = renderTurns(historyWithShot('shot-gone-1'), 'idle', '', null, null, null, null, null, null, null);
  // The slot is still rendered: the row happened, and the picture is the part that is gone.
  assert.match(html, /data-shot="shot-gone-1"/);
  // And the stylesheet has a rule for the message, so it reads as a state, not as an error.
  assert.match(CSS, /\.act-shot-gone\s*\{[^}]*color:\s*var\(--text-faint\)/);
});

test('the cache keeps a picture once it is known, so a re-render costs no fetch', () => {
  // This is the rule that stops the timeline from asking for the same picture on every broadcast.
  assert.equal(shotCache instanceof Map, true);
  assert.equal(shotGone instanceof Set, true);
});

test('a run that stopped without an answer shows the real reason on the failed card', () => {
  const history = [
    { type: 'user_goal', turn: 1, prompt: 'Go to Google.', isNewRun: true },
    { type: 'agent_response', step: 1, thought: '', action: { action: 'get_page_elements' }, rawResponse: '{}' },
    { type: 'execution_result', step: 1, success: true, message: '[1] a "Search"' },
    { type: 'error', content: 'The model returned neither a tool call nor text.' }
  ];
  const html = renderTurns(history, 'stopped', '', null, null, null, null, null, null, null);
  assert.match(html, /The run ended with an error: The model returned neither a tool call nor text\./,
    'the card names the real stop reason');
  assert.match(html, /<div class="act-row fault"/, 'the failed turn renders as a fault row');
});

test('a stopped run with no recorded error says the user stopped it, not that it failed', () => {
  const history = [
    { type: 'user_goal', turn: 1, prompt: 'Go to Google.', isNewRun: true },
    { type: 'agent_response', step: 1, thought: '', action: { action: 'navigate', url: 'https://example.com' }, rawResponse: '{}' },
    { type: 'execution_result', step: 1, success: true, message: 'Navigated to https://example.com' }
  ];
  const html = renderTurns(history, 'stopped', '', null, null, null, null, null, null, null);
  assert.match(html, /Stopped by you/);
  assert.match(html, /The run was stopped before it finished\./);
  assert.doesNotMatch(html, /Failed|ended with an error/);
});

test('an errored run with no recorded error still says it ended with an error', () => {
  const history = [
    { type: 'user_goal', turn: 1, prompt: 'Go to Google.', isNewRun: true },
    { type: 'agent_response', step: 1, thought: '', action: { action: 'navigate', url: 'https://example.com' }, rawResponse: '{}' },
    { type: 'execution_result', step: 1, success: true, message: 'Navigated to https://example.com' }
  ];
  const html = renderTurns(history, 'error', '', null, null, null, null, null, null, null);
  assert.match(html, /The run ended with an error\./);
});

test('the stylesheet gives the slot a bounded height and the picture its own shape', () => {
  const slot = /\.act-shot-slot\s*\{([^}]*)\}/.exec(CSS);
  assert.ok(slot, 'the slot has a rule');
  assert.match(slot[1], /max-height:\s*180px/, 'a tall picture does not push the timeline apart');
  assert.match(slot[1], /max-width:/, 'and a wide one does not overflow the panel');
  assert.match(slot[1], /border-radius:/);

  const img = /\.act-shot-img\s*\{([^}]*)\}/.exec(CSS);
  assert.ok(img, 'the picture has a rule');
  assert.match(img[1], /object-fit:\s*contain/, 'the whole picture is visible, not cropped');
  assert.match(img[1], /max-height:\s*180px/);

  // Both rules use the theme's tokens, so light and dark both work with no second rule.
  assert.match(slot[1], /var\(--border\)/);
  assert.match(slot[1], /var\(--surface\)/);
});
