// Tests for the bridge wire protocol, through the bridge copy (bridge/protocol.mjs). The
// extension mirror (src/background/bridge/protocol.ts) must behave identically; a spot-check
// of the TS copy runs the same assertions against it where a TS loader is available.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFrame, encodeFrame, bridgeEntry, historyDelta, PROTOCOL_VERSION, MAX_STRING_CHARS } from '../../bridge/protocol.mjs';

test('parseFrame accepts a well-formed envelope', () => {
  const frame = parseFrame(encodeFrame('start_task', { prompt: 'x' }, 'm1'));
  assert.ok(frame);
  assert.equal(frame.type, 'start_task');
  assert.equal(frame.id, 'm1');
  assert.deepEqual(frame.payload, { prompt: 'x' });
  assert.equal(frame.v, PROTOCOL_VERSION);
});

test('parseFrame rejects malformed and unknown frames', () => {
  assert.equal(parseFrame('not json'), null);
  assert.equal(parseFrame('[]'), null);
  assert.equal(parseFrame(null), null);
  assert.equal(parseFrame({ v: 2, type: 'ping', id: null, payload: {} }), null, 'wrong protocol version');
  assert.equal(parseFrame({ v: 1, type: 'nope', id: null, payload: {} }), null, 'unknown type');
  assert.ok(parseFrame({ v: 1, type: 'ping', payload: {} }), 'a missing id is accepted (events have none)');
  assert.equal(parseFrame({ v: 1, type: 'ping', id: null }), null, 'missing payload');
  assert.equal(parseFrame({ v: 1, type: 'ping', id: null, payload: [] }), null, 'array payload');
});

test('parseFrame accepts every declared type and null ids for events', () => {
  for (const type of ['hello', 'result', 'task_event', 'task_done', 'history_reset', 'start_task', 'stop_task', 'get_state', 'ping']) {
    assert.ok(parseFrame({ v: 1, type, id: null, payload: {} }), type);
  }
});

test('bridgeEntry drops rawResponse and image fields', () => {
  const out = bridgeEntry({
    type: 'agent_response',
    step: 3,
    thought: 'clicking the button',
    action: { action: 'click', element_id: 7 },
    rawResponse: { huge: 'model dump that must not cross the wire' },
    imageId: 'img_1',
    imageWidth: 800,
    imageHeight: 600,
  });
  assert.equal(out.rawResponse, undefined);
  assert.equal(out.imageId, undefined);
  assert.equal(out.imageWidth, undefined);
  assert.equal(out.imageHeight, undefined);
  assert.equal(out.thought, 'clicking the button');
  assert.deepEqual(out.action, { action: 'click', element_id: 7 });
});

test('bridgeEntry truncates long strings and survives a 900 KB entry', () => {
  const big = 'x'.repeat(900 * 1024);
  const out = bridgeEntry({ type: 'execution_result', message: big, nested: { deep: big } });
  assert.equal(out.message.length, MAX_STRING_CHARS + 1, 'truncated to the cap plus the ellipsis');
  assert.equal(out.nested.deep.length, MAX_STRING_CHARS + 1);
});

test('bridgeEntry keeps small values intact', () => {
  const entry = { type: 'finish', answer: 'done', outcome: 'done', table: { columns: ['a'], rows: [[1]] } };
  assert.deepEqual(bridgeEntry(entry), entry);
});

test('historyDelta sends only the new slice', () => {
  const history = [{ type: 'user_goal' }, { type: 'agent_response' }, { type: 'execution_result' }];
  const delta = historyDelta(history, 1);
  assert.equal(delta.reset, false);
  assert.equal(delta.entries.length, 2);
  assert.deepEqual(delta.entries[0], { type: 'agent_response' });
});

test('historyDelta reports empty when nothing is new', () => {
  const delta = historyDelta([{ type: 'user_goal' }], 1);
  assert.equal(delta.reset, false);
  assert.deepEqual(delta.entries, []);
});

test('historyDelta signals a reset when the history shrank (clearHistory, loadChat, trim)', () => {
  assert.deepEqual(historyDelta([], 5), { reset: true });
  assert.deepEqual(historyDelta([{ type: 'user_goal' }], 5), { reset: true });
});

test('chat_compacted appended entries do NOT trigger a reset (compaction appends, never shrinks)', () => {
  const history = [{ type: 'user_goal' }, { type: 'chat_compacted', summary: 'earlier turns summarized' }];
  const delta = historyDelta(history, 1);
  assert.equal(delta.reset, false);
  assert.equal(delta.entries.length, 1);
  assert.equal(delta.entries[0].type, 'chat_compacted');
});
