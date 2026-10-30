/**
 * The background side of embedded frames (src/background/browser/frames.ts): finding them, reading
 * their text, and the covers for a screenshot, against a stand-in for Chrome.
 *
 * What these tests hold on to:
 *   1. A frame without the agent gets it injected once; a restricted frame never does.
 *   2. Covers go up deepest first, and a frame is confirmed only by its own answer, with the path it
 *      read then. A frame that does not answer is never confirmed (the frame above covers it).
 *   3. After the capture, a confirmed frame must still answer from the SAME document at the SAME
 *      path; a navigated or moved frame throws the picture away.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { embeddedFrames, frameIdAtPath, frameMasksHold, maskEmbeddedFrames, readFrameTexts, unmaskEmbeddedFrames, type FramePort } from '../../src/background/browser/frames.ts';

interface FakeFrame {
  frameId: number;
  documentId: string;
  path: string;
  href?: string;
  agent?: boolean;
  /** What the agent answers, by action; a missing answer is a frame that does not answer. */
  answers?: Record<string, (payload: any) => any>;
}

function fakePort(frames: FakeFrame[]) {
  const sent: Array<{ frameId: number; documentId?: string; action: string; payload: any }> = [];
  const injected: number[][] = [];
  const port: FramePort = {
    async inAllFrames() {
      return [
        { frameId: 0, documentId: 'top', result: { depth: 0, path: '', agent: false, href: 'https://shell.example/' } },
        ...frames.map((f) => ({ frameId: f.frameId, documentId: f.documentId, result: { depth: f.path.split('.').length, path: f.path, agent: f.agent !== false, href: f.href ?? 'https://lesson.example/' } }))
      ];
    },
    async injectAgent(_tabId, ids) {
      injected.push(ids);
      for (const f of frames) if (ids.includes(f.frameId)) f.agent = true;
    },
    async send(_tabId, target, message: any) {
      sent.push({ frameId: target.frameId, documentId: target.documentId, action: message.action, payload: message.payload });
      const frame = frames.find((f) => f.frameId === target.frameId && (!target.documentId || f.documentId === target.documentId));
      const answer = frame?.answers?.[message.action];
      return answer ? answer(message.payload) : null;
    }
  };
  return { port, sent, injected };
}

test('embeddedFrames leaves out the top page and injects the agent where it is missing, once', async () => {
  const frames: FakeFrame[] = [{ frameId: 5, documentId: 'd5', path: '0', agent: false }, { frameId: 6, documentId: 'd6', path: '1' }];
  const { port, injected } = fakePort(frames);
  const found = await embeddedFrames(1, port);
  assert.deepEqual(found.map((f) => [f.frameId, f.path, f.agent]), [[5, '0', true], [6, '1', true]]);
  assert.deepEqual(injected, [[5]]);
});

test('embeddedFrames never injects into a restricted frame', async () => {
  const { port, injected } = fakePort([{ frameId: 5, documentId: 'd5', path: '0', agent: false, href: 'chrome://settings/' }]);
  const found = await embeddedFrames(1, port);
  assert.deepEqual(injected, []);
  assert.equal(found[0].agent, false);
});

test('readFrameTexts keeps frames with text, by their own origin, and skips a restricted one', async () => {
  const { port } = fakePort([
    { frameId: 5, documentId: 'd5', path: '0', answers: { FRAME_TEXT: () => ({ success: true, origin: 'https://lesson.example', text: ' The lesson. ' }) } },
    { frameId: 6, documentId: 'd6', path: '1', answers: { FRAME_TEXT: () => ({ success: true, text: '', skipped: 'the frame is only 1x1' }) } },
    { frameId: 7, documentId: 'd7', path: '2' },
    { frameId: 8, documentId: 'd8', path: '3', href: 'chrome-extension://abc/x.html', answers: { FRAME_TEXT: () => ({ success: true, origin: 'x', text: 'secret' }) } }
  ]);
  assert.deepEqual(await readFrameTexts(1, port), [{ origin: 'https://lesson.example', text: 'The lesson.' }]);
});

test('maskEmbeddedFrames confirms the deepest frames first and passes their paths up', async () => {
  const ok = (path: string) => () => ({ success: true, path });
  const { port, sent } = fakePort([
    { frameId: 5, documentId: 'd5', path: '0', answers: { FRAME_MASK: ok('0') } },
    { frameId: 9, documentId: 'd9', path: '0.0', answers: { FRAME_MASK: ok('0.0') } }
  ]);
  const masks = await maskEmbeddedFrames(1, port);
  assert.deepEqual(sent.map((s) => [s.frameId, s.documentId, s.payload.shownFramePaths]), [[9, 'd9', []], [5, 'd5', ['0.0']]]);
  assert.deepEqual(masks.shownFramePaths, ['0.0', '0']);
});

test('a frame that does not answer, or answers without a path, is not confirmed', async () => {
  const { port } = fakePort([
    { frameId: 5, documentId: 'd5', path: '0' },
    { frameId: 6, documentId: 'd6', path: '1', answers: { FRAME_MASK: () => ({ success: true }) } },
    { frameId: 7, documentId: 'd7', path: '2', answers: { FRAME_MASK: () => ({ success: false, path: '2' }) } }
  ]);
  const masks = await maskEmbeddedFrames(1, port);
  assert.deepEqual(masks.shownFramePaths, []);
  assert.equal(masks.masked.length, 3, 'every frame asked is cleared afterwards');
});

test('a frame confirmed after its child was not is still asked to cover that child', async () => {
  const { port, sent } = fakePort([
    { frameId: 5, documentId: 'd5', path: '0', answers: { FRAME_MASK: () => ({ success: true, path: '0' }) } },
    { frameId: 9, documentId: 'd9', path: '0.0' }
  ]);
  const masks = await maskEmbeddedFrames(1, port);
  assert.deepEqual(sent.find((s) => s.frameId === 5)?.payload.shownFramePaths, [], 'the silent child is not in the list, so its parent covers it');
  assert.deepEqual(masks.shownFramePaths, ['0']);
});

test('frameMasksHold asks each confirmed frame in the same document, with the path it confirmed', async () => {
  const frames: FakeFrame[] = [{ frameId: 5, documentId: 'd5', path: '0', answers: { FRAME_MASK_CHECK: (p) => ({ success: p.path === '0' }) } }];
  const { port, sent } = fakePort(frames);
  const masks = { shownFramePaths: ['0'], masked: [{ frameId: 5, documentId: 'd5', path: '0' }] };
  assert.equal(await frameMasksHold(1, masks, port), true);
  assert.deepEqual(sent.map((s) => [s.documentId, s.payload]), [['d5', { path: '0' }]]);
});

test('frameMasksHold is false for a frame that navigated (its old document finds nobody)', async () => {
  const frames: FakeFrame[] = [{ frameId: 5, documentId: 'd5-new', path: '0', answers: { FRAME_MASK_CHECK: () => ({ success: true }) } }];
  const { port } = fakePort(frames);
  assert.equal(await frameMasksHold(1, { shownFramePaths: ['0'], masked: [{ frameId: 5, documentId: 'd5', path: '0' }] }, port), false);
});

test('frameMasksHold is false for a frame that says its covers no longer hold', async () => {
  const { port } = fakePort([{ frameId: 5, documentId: 'd5', path: '0', answers: { FRAME_MASK_CHECK: () => ({ success: false }) } }]);
  assert.equal(await frameMasksHold(1, { shownFramePaths: ['0'], masked: [{ frameId: 5, documentId: 'd5', path: '0' }] }, port), false);
});

test('unmaskEmbeddedFrames clears every frame that was asked, by frame id', async () => {
  const { port, sent } = fakePort([{ frameId: 5, documentId: 'd5', path: '0' }]);
  await unmaskEmbeddedFrames(1, { shownFramePaths: [], masked: [{ frameId: 5, documentId: 'd5' }] }, port);
  assert.deepEqual(sent.map((s) => [s.frameId, s.documentId, s.action]), [[5, undefined, 'FRAME_UNMASK']]);
});

test('frameIdAtPath maps a path to the frame with an agent there', async () => {
  const { port } = fakePort([{ frameId: 5, documentId: 'd5', path: '0' }, { frameId: 6, documentId: 'd6', path: '1' }]);
  assert.equal(await frameIdAtPath(1, '1', port), 6);
  assert.equal(await frameIdAtPath(1, '7', port), null);
});
