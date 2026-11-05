/**
 * The chain of an unfinished turn (src/background/mcp/chatChain.ts): what a "resume" needs to go on.
 *
 * What these tests hold on to:
 *   1. A turn that ended unfinished (a Stop, an interruption, a closed browser, a partial result)
 *      carries its plan with done marks, the number of saved records and their fields, its last
 *      page, and its last 6 steps (each result cut to 160 characters), all inside the envelope.
 *   2. A turn that finished, or failed, carries none of it.
 *   3. The chain's header says what to do with "resume": carry on, do not start over.
 *   4. Only the records of an unfinished LAST turn are restorable; after a finished turn a
 *      follow-up starts with none.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAIN_HEADER, CHAIN_RESUME_RULE, CHAIN_RESUME_STEPS, CHAIN_STEP_RESULT_CHARS, chainBlock, chainTurns, restorableRecords
} from '../../src/background/mcp/chatChain.ts';
import { UNTRUSTED_END, UNTRUSTED_PREFIX } from '../../src/background/mcp/untrusted.ts';
import type { HistoryEntry } from '../../src/background/types.ts';

const goal = (turn: number, prompt: string): HistoryEntry => ({ type: 'user_goal', turn, prompt, timestamp: '10:00', isNewRun: true });
const act = (n: number, action: Record<string, unknown>): HistoryEntry => ({ type: 'agent_response', step: n, thought: '', action: action as any, rawResponse: '{}' });
const ok = (n: number, message: string): HistoryEntry => ({ type: 'execution_result', step: n, success: true, message });

const RECORDS = [{ name: 'A', issued: 'Oct 2026', url: 'https://a.example' }, { name: 'B', issued: 'Sep 2026', url: 'https://b.example' }];

function stoppedChat(reason: 'stopped' | 'interrupted' | 'closed' | 'partial' = 'stopped', steps = 2): HistoryEntry[] {
  const rows: HistoryEntry[] = [goal(1, 'Make me a JSON file of the certifications on this page.')];
  for (let i = 1; i <= steps; i++) {
    rows.push(act(i, i === steps ? { action: 'save_data', count: 2 } : { action: 'read_page', part: i }));
    rows.push(ok(i, i === steps ? 'Saved 2 new records (2 in total).' : `${'x'.repeat(300)} page ${i}`));
  }
  rows.push({
    type: 'partial_result', answer: 'The run was stopped before it finished.', table: null, reason,
    records: RECORDS, plan: [{ text: 'Read the page', status: 'completed' }, { text: 'Save every certificate', status: 'in_progress' }, { text: 'Write the JSON file', status: 'pending' }],
    pageUrl: 'http://127.0.0.1:8765/credentials.html'
  });
  return rows;
}

const insideEnvelope = (block: string) => {
  const start = block.indexOf(UNTRUSTED_PREFIX);
  return block.slice(start, block.indexOf(UNTRUSTED_END, start));
};

test('a stopped turn carries its plan, records, last page and last steps, inside the envelope', () => {
  const block = chainBlock(stoppedChat());
  assert.match(block, /Turn 1 \(stopped, unfinished\)/);
  const inside = insideEnvelope(block);
  assert.match(inside, /Where it stopped:/);
  assert.match(inside, /Plan:\n1 \[done\] Read the page\n2 \[ \] Save every certificate\n3 \[ \] Write the JSON file/);
  assert.match(inside, /Saved records: 2 \(fields: name, issued, url\)/);
  assert.match(inside, /Last page: http:\/\/127\.0\.0\.1:8765\/credentials\.html/);
  assert.match(inside, /Last steps:\n- read_page part=1 -> ok: x+/);
  assert.match(inside, /- save_data count=2 -> ok: Saved 2 new records \(2 in total\)\./);
});

test('the last steps are the last 6, each result cut to 160 characters', () => {
  const [turn] = chainTurns(stoppedChat('stopped', 9));
  assert.equal(turn.resume!.steps.length, CHAIN_RESUME_STEPS);
  assert.match(turn.resume!.steps[0], /^- read_page part=4 /, 'the oldest steps are left out');
  const long = turn.resume!.steps[0];
  const result = long.slice(long.indexOf('-> ok: ') + '-> ok: '.length);
  assert.ok(result.length <= CHAIN_STEP_RESULT_CHARS, `the result is cut (${result.length})`);
});

test('interrupted, closed and partial turns are unfinished too; finished and failed turns carry none of it', () => {
  for (const reason of ['interrupted', 'closed', 'partial'] as const) {
    assert.ok(chainTurns(stoppedChat(reason))[0].resume, reason);
  }
  assert.equal(chainTurns(stoppedChat('closed'))[0].outcome, 'stopped', 'a closed browser reads as stopped');
  const done: HistoryEntry[] = [goal(1, 'Count them'), act(1, { action: 'read_page' }), ok(1, 'read'), { type: 'finish', answer: '10', outcome: 'done', records: RECORDS }];
  assert.equal(chainTurns(done)[0].resume, undefined);
  assert.doesNotMatch(chainBlock(done), /Where it stopped/);
  const failed: HistoryEntry[] = [goal(1, 'Count them'), act(1, { action: 'read_page' }), { type: 'error', content: 'boom' }];
  assert.equal(chainTurns(failed)[0].resume, undefined);
  // A turn whose rows simply end (the history was cut while it ran) is unfinished: it has steps to show.
  const cut: HistoryEntry[] = [goal(1, 'Count them'), act(1, { action: 'read_page' }), ok(1, 'read')];
  assert.match(chainBlock(cut), /Last steps:\n- read_page -> ok: read/);
});

test('the header tells the model to carry on an unfinished task when asked to resume', () => {
  assert.equal(CHAIN_RESUME_RULE, 'If the user asks to resume or continue, carry on the last unfinished task from where it stopped; do not start it over.');
  assert.ok(CHAIN_HEADER.startsWith('EARLIER IN THIS CHAT'));
  assert.ok(chainBlock(stoppedChat()).startsWith(`EARLIER IN THIS CHAT (for context; the task below is the current one):\n${CHAIN_RESUME_RULE}\n\n`));
});

test('only an unfinished last turn has records to restore', () => {
  const restored = restorableRecords(stoppedChat());
  assert.deepEqual(restored, { turn: 1, records: RECORDS });
  assert.notEqual(restored!.records[0], RECORDS[0], 'a copy, not the rows of the history');
  const afterFinish: HistoryEntry[] = [...stoppedChat(), goal(2, 'Make it again'), { type: 'finish', answer: 'Here.', outcome: 'done', records: RECORDS }];
  assert.equal(restorableRecords(afterFinish), null, 'a finished turn after it: an unrelated follow-up starts empty');
  const noRecords = stoppedChat().map((r) => (r.type === 'partial_result' ? { ...r, records: [] } : r));
  assert.equal(restorableRecords(noRecords), null);
  assert.equal(restorableRecords([]), null);
});
