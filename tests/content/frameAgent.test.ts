/**
 * The frame agent (src/content/frameAgent.ts) and the content helpers it brings: which frame a
 * scroll goes into (frameToScroll), how frame texts join the page text (withFrameTexts), and the
 * position rounding on high-density displays.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { answerFrameMessage, installFrameAgent, FRAME_TEXT_CAP } from '../../src/content/frameAgent.ts';
import { frameToScroll } from '../../src/content/scrollActions.ts';
import { withFrameTexts } from '../../src/content/actions.ts';
import { positionOf } from '../../src/content/scrollMeasure.ts';
import { describePointElement } from '../../src/content/screenshotPrivacy.ts';
import { BOT_CHECK_PATTERN, botCheckPointRefusal } from '../../src/background/mcp/server.ts';

const AT_BOTTOM = { top: 0, max: 0, height: 1100, atTop: true, atBottom: true };
const MIDWAY = { top: 400, max: 3000, height: 1100, atTop: false, atBottom: false };

function frameEl(rect: { left: number; top: number; width: number; height: number }, path: string | null) {
  return {
    tagName: 'IFRAME',
    path,
    clientLeft: 1,
    clientTop: 1,
    getBoundingClientRect: () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height })
  };
}

const win: any = { innerWidth: 2000, innerHeight: 1100, getComputedStyle: () => ({ paddingLeft: '0px', paddingTop: '0px' }) };
const docOf = (frames: any[]): any => ({ querySelectorAll: (s: string) => (s === 'iframe' ? frames : []) });
const pathOf = (f: any) => f.path;

test('frameToScroll: a page that cannot move hands the scroll to its large frame', () => {
  const lesson = frameEl({ left: 0, top: 92, width: 2000, height: 950 }, '0');
  assert.deepEqual(frameToScroll(docOf([lesson]), win, { direction: 'down', before: AT_BOTTOM }, pathOf), { path: '0', offset: { left: 1, top: 93 } });
});

test('frameToScroll: a page that can still move keeps the scroll', () => {
  const lesson = frameEl({ left: 0, top: 92, width: 2000, height: 950 }, '0');
  assert.equal(frameToScroll(docOf([lesson]), win, { direction: 'down', before: MIDWAY }, pathOf), null);
});

test('frameToScroll: a small frame (an ad, a widget) never takes the scroll', () => {
  const ad = frameEl({ left: 0, top: 0, width: 300, height: 250 }, '0');
  assert.equal(frameToScroll(docOf([ad]), win, { direction: 'down', before: AT_BOTTOM }, pathOf), null);
});

test('frameToScroll: a point on a frame goes into it at the same point in its own viewport', () => {
  const lesson = frameEl({ left: 100, top: 200, width: 800, height: 600 }, '1');
  assert.deepEqual(
    frameToScroll(docOf([lesson]), win, { direction: 'down', point: { x: 300, y: 500 }, hit: lesson as any, before: MIDWAY }, pathOf),
    { path: '1', offset: { left: 101, top: 201 }, point: { x: 199, y: 299 } }
  );
});

test('frameToScroll: an element id or a frame with no known path is never routed', () => {
  const lesson = frameEl({ left: 0, top: 0, width: 2000, height: 1100 }, null);
  assert.equal(frameToScroll(docOf([lesson]), win, { direction: 'down', before: AT_BOTTOM }, pathOf), null);
  assert.equal(frameToScroll(docOf([frameEl({ left: 0, top: 0, width: 2000, height: 1100 }, '0')]), win, { direction: 'down', element: {} as any, before: AT_BOTTOM }, pathOf), null);
});

test('withFrameTexts adds each frame under a heading that names its origin, and skips empty ones', () => {
  assert.equal(
    withFrameTexts('Shell', [{ origin: 'https://lesson.example', text: ' The lesson. ' }, { origin: 'x', text: '  ' }, null, { text: 'no origin' }]),
    'Shell\n\n--- Embedded frame from https://lesson.example ---\nThe lesson.'
  );
  assert.equal(withFrameTexts('Shell', undefined), 'Shell');
});

test('positionOf never reports a window position past its end (fractional scroll on a 2x display)', () => {
  const doc: any = { scrollingElement: { scrollHeight: 1792.4, clientHeight: 1100 } };
  const p = positionOf(null, doc, { scrollY: 692.5, innerHeight: 1100 } as any);
  assert.equal(p.max, 692);
  assert.equal(p.top, 692);
  assert.equal(p.atBottom, true);
});

const frameWin = (w: number, h: number): any => ({ innerWidth: w, innerHeight: h, location: { host: 'lesson.example', origin: 'https://lesson.example', protocol: 'https:' } });

test('FRAME_TEXT skips a frame too small to be content', async () => {
  const answer = await answerFrameMessage({ action: 'FRAME_TEXT' }, {} as any, frameWin(1, 1));
  assert.equal(answer.text, '');
  assert.match(answer.skipped, /1x1/);
});

test('answerFrameMessage answers only FRAME_* actions', async () => {
  assert.equal(await answerFrameMessage({ action: 'HIDE_AGENT_UI' }, {} as any, frameWin(800, 600)), null);
  assert.equal(await answerFrameMessage({ action: 'EXECUTE_ACTION' }, {} as any, frameWin(800, 600)), null);
  assert.ok(FRAME_TEXT_CAP > 0);
});

test('installFrameAgent does nothing in the top frame, and listens once in a frame', () => {
  const listeners: any[] = [];
  const chrome = { runtime: { onMessage: { addListener: (fn: any) => listeners.push(fn) } } };
  const top: any = { chrome };
  top.top = top;
  installFrameAgent(top);
  assert.equal(listeners.length, 0, 'the top frame has the full content script');
  const frame: any = { chrome, top: {} };
  installFrameAgent(frame);
  installFrameAgent(frame);
  assert.equal(listeners.length, 1);
  assert.equal(listeners[0]({ action: 'GET_DOM_SNAPSHOT' }, {}, () => {}), false, 'a message for the top frame is left alone');
});


const iframe = (attrs: Record<string, string>): any => ({
  tagName: 'IFRAME',
  className: '',
  textContent: '',
  ownerDocument: { baseURI: 'https://shell.example/course' },
  getAttribute: (name: string) => attrs[name] ?? null
});

test('a point on an embedded frame is described by its title and host', () => {
  assert.equal(describePointElement(iframe({ title: 'Lesson', src: 'https://lesson.example/x' })), 'iframe "Lesson" (lesson.example)');
});

test('a point on a CAPTCHA frame matches the bot check rule, and the refusal says why', () => {
  for (const frame of [
    iframe({ title: 'reCAPTCHA', src: 'https://www.recaptcha.net/recaptcha/api2/anchor?k=1' }),
    iframe({ src: 'https://newassets.hcaptcha.com/captcha/v1/abc' }),
    iframe({ title: 'Widget containing a Cloudflare security challenge', src: 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/x' })
  ]) {
    const what = describePointElement(frame);
    assert.ok(BOT_CHECK_PATTERN.test(what), what);
  }
  assert.ok(!BOT_CHECK_PATTERN.test(describePointElement(iframe({ title: 'Lesson', src: 'https://lesson.example/x' }))));
  assert.match(botCheckPointRefusal('iframe "reCAPTCHA"'), /^Refused: that point is on a bot check/);
});
