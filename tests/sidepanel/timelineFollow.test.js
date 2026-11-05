/**
 * Following the run in the timeline (sidepanel/sidepanel.js), driven through the panel's own
 * listeners over the fake DOM.
 *
 * What these tests hold on to:
 *   1. Content that grows keeps the view at the bottom: a render, however tall, follows, and a step
 *      picture that attaches later follows too (the lost 80 px of the old "near the bottom" rule).
 *   2. A reader's own scroll up (a wheel up, then the scroll it makes) stops following: the next
 *      render keeps their place.
 *   3. While following is off, "Jump to latest" shows only once new content arrived; a click
 *      scrolls down and follows again.
 *   4. Scrolling back to within 80 px of the bottom follows again; a scroll the reader did not make
 *      (content moved it) never stops following.
 *   5. A new task, New chat and an opened chat follow from the start.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { install, settle } from './fakePanelDom.js';

const { getEl } = install();
const { renderState, initTimelineInteraction, initEventListeners, loadSettings, attachShotPicture, isFollowingTimeline, setFollowTimeline } = await import('../../sidepanel/sidepanel.js');
initEventListeners();
await loadSettings();
initTimelineInteraction();

const timeline = getEl('timeline');
const jump = getEl('btnJumpLatest');
timeline.clientHeight = 400;
timeline.scrollTop = 0;
timeline.scrollHeight = 400;

let version = 0;
let steps = 0;
/** A running state with one more step row each time: the content grows. */
function grow() {
  steps += 1;
  const history = [{ type: 'user_goal', turn: 1, prompt: 'Read it', timestamp: '10:00', isNewRun: true }];
  for (let i = 1; i <= steps; i++) {
    history.push({ type: 'agent_response', step: i, thought: '', action: { action: 'scroll', direction: 'down' }, rawResponse: '{}' });
    history.push({ type: 'execution_result', step: i, success: true, message: 'ok' });
  }
  timeline.scrollHeight = 400 + steps * 120;
  version += 1;
  renderState({ status: 'running', task: 'Read it', history, planSteps: [], stepCount: steps, stateVersion: version, bootId: 'boot-follow' });
}
const bottom = () => timeline.scrollHeight - timeline.clientHeight;
const readerScrollsTo = async (top, deltaY = -120) => {
  await timeline.dispatchEvent({ type: 'wheel', deltaY });
  timeline.scrollTop = top;
  await timeline.dispatchEvent({ type: 'scroll' });
};

test('content that grows keeps the view at the bottom', () => {
  setFollowTimeline(true);
  grow();
  grow();
  assert.ok(timeline.scrollTop >= bottom(), `at the bottom (${timeline.scrollTop} of ${bottom()})`);
  // The old rule measured "near the bottom" before the rewrite: a picture that grew the content by
  // more than 80 px since the last render left the view behind for good.
  timeline.scrollHeight += 300;
  grow();
  assert.ok(timeline.scrollTop >= bottom(), 'still at the bottom after a jump in height');
  assert.equal(jump.hidden, true, 'no Jump button while following');
});

test('a picture that attaches while following scrolls to the bottom', () => {
  setFollowTimeline(true);
  timeline.scrollTop = bottom();
  timeline.scrollHeight += 180; // the picture's height arrives after the render
  const slot = { getAttribute: () => '600', style: {}, innerHTML: '', appendChild() {} };
  attachShotPicture(slot, { naturalWidth: 600, naturalHeight: 600, setAttribute() {} }, 'data:image/jpeg;base64,AAA');
  assert.ok(timeline.scrollTop >= bottom(), 'the view moved down with the picture');
});

test('a reader who scrolls up stops following, and the Jump button shows once something new came', async () => {
  setFollowTimeline(true);
  grow();
  await readerScrollsTo(100);
  assert.equal(isFollowingTimeline(), false, 'following stopped');
  assert.equal(jump.hidden, true, 'nothing new yet: no Jump button');
  grow();
  assert.equal(timeline.scrollTop, 100, 'the reader keeps their place');
  assert.equal(jump.hidden, false, 'new content below: Jump to latest shows');
  await jump.dispatchEvent('click');
  assert.equal(isFollowingTimeline(), true, 'the click follows again');
  assert.equal(jump.hidden, true);
  assert.ok(timeline.scrollTop >= bottom(), 'and scrolls down');
});

test('coming back near the bottom follows again; a scroll the reader did not make never stops it', async () => {
  grow();
  await readerScrollsTo(50);
  assert.equal(isFollowingTimeline(), false);
  await readerScrollsTo(bottom() - 40, 120);
  assert.equal(isFollowingTimeline(), true, 'within 80 px of the bottom follows again');
  await settle(700); // past the time a gesture of the reader counts
  timeline.scrollTop = 20; // moved by content, with no gesture of the reader
  await timeline.dispatchEvent({ type: 'scroll' });
  assert.equal(isFollowingTimeline(), true, 'a scroll the reader did not make leaves following on');
  // Keys typed in the composer never reach the timeline: only the timeline's own keys count.
  await getEl('taskInput').dispatchEvent({ type: 'keydown', key: 'ArrowUp' });
  timeline.scrollTop = 30;
  await timeline.dispatchEvent({ type: 'scroll' });
  assert.equal(isFollowingTimeline(), true);
  await timeline.dispatchEvent({ type: 'keydown', key: 'PageUp' });
  timeline.scrollTop = 10;
  await timeline.dispatchEvent({ type: 'scroll' });
  assert.equal(isFollowingTimeline(), false, 'a PageUp in the timeline is the reader scrolling');
});

test('New chat follows from the start', async () => {
  grow();
  await readerScrollsTo(10);
  assert.equal(isFollowingTimeline(), false);
  await getEl('btnNewChat').dispatchEvent('click');
  assert.equal(isFollowingTimeline(), true);
});
