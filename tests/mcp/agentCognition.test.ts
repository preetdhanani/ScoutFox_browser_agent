/**
 * What the agent knows about its own run: the run state each request ends with, the records it
 * saved, the files it hands over, the stall count, and the context compaction.
 *
 * The case these exist for: asked for a JSON file of the certifications on a profile page, a run
 * read 74 elements one by one and never finished. It could not see where the links went, it had
 * no record of what it had found, nothing told it that it was not moving, and it had no way to
 * hand over a file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFinishFiles,
  compactToolResults,
  COMPACTED_PREFIX,
  COMPACT_AT,
  COMPACT_KEEP,
  FILES_MAX_CHARS,
  formatRunState,
  jsonProblem,
  loggableArguments,
  RECORDS_MAX,
  recordsCsv,
  RUN_STATE_PREFIX,
  saveRecords,
  withRunState,
  type Message
} from '../../src/background/mcp/client.ts';
import { ProgressTracker, STALL_AT } from '../../src/background/mcp/progress.ts';

// ---- the run state --------------------------------------------------------------------------

test('the run state says the goal, the plan with its marks, what was saved and the steps', () => {
  const text = formatRunState({
    task: 'Make me a JSON file of the certifications',
    planSteps: [{ text: 'Read', status: 'completed' }, { text: 'Save', status: 'pending' }],
    records: [{ name: 'A', url: 'https://a.example' }, { name: 'B', url: '' }],
    step: 7,
    maxSteps: 250,
    sinceProgress: 3
  });
  assert.equal(text, [
    `${RUN_STATE_PREFIX} Goal: Make me a JSON file of the certifications`,
    'Plan: 1 [done] Read; 2 [ ] Save',
    'Collected: 2 records (fields: name, url; empty: url in 1)',
    'Steps: 7 of 250. Steps since the last progress: 3.'
  ].join('\n'));
});

test('the run state rides on the last message, never as a message of its own', () => {
  const history: Message[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'TASK: x' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'read_page', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'Page text' }
  ];
  const out = withRunState(history, '[Run state] Goal: x');
  assert.equal(out.length, history.length, 'no message is added');
  assert.equal(out[3].content, 'Page text\n\n[Run state] Goal: x');
  assert.equal(history[3].content, 'Page text', 'the stored history is untouched');
  const picture: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'cap' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }] }];
  const withPicture = withRunState(picture, '[Run state] Goal: y');
  assert.deepEqual((withPicture[0].content as any[]).map((b) => b.type), ['text', 'image_url', 'text'], 'a picture message gets a text block');
});

// ---- save_data ------------------------------------------------------------------------------

test('save_data keeps each record once and says what is new, what is saved and what is empty', () => {
  const store: Array<Record<string, unknown>> = [];
  const first = saveRecords(store, { records: [{ name: 'A', url: 'u1' }, { name: 'B', url: '' }] });
  assert.equal(first.saved, 2);
  assert.equal(first.text, 'Saved 2 new records (2 in total). Fields: name, url. Empty: url in 1 record.');
  const again = saveRecords(store, { records: [{ url: 'u1', name: 'A' }, { name: 'C', url: 'u3' }] });
  assert.equal(again.saved, 1, 'the same record with its fields in another order is not saved twice');
  assert.match(again.text, /^Saved 1 new record \(3 in total\)\. 1 was already saved\./);
  assert.equal(store.length, 3);
});

test('save_data refuses what is not a list of records, and what would pass the caps', () => {
  const store: Array<Record<string, unknown>> = [];
  assert.equal(saveRecords(store, {}).isError, true);
  assert.equal(saveRecords(store, { records: ['a'] }).isError, true);
  assert.equal(saveRecords(store, { records: [{}] }).isError, true);
  const many = Array.from({ length: RECORDS_MAX + 1 }, (_, i) => ({ i }));
  const out = saveRecords(store, { records: many });
  assert.equal(out.isError, true);
  assert.equal(store.length, 0, 'nothing of a refused call is saved');
  assert.equal(saveRecords(store, { records: [{ text: 'x'.repeat(210_000) }] }).isError, true);
});

// ---- the files of a finish ------------------------------------------------------------------

test('records_file writes the saved records as JSON or CSV', () => {
  const records = [{ name: 'A, Inc.', url: 'https://a.example' }, { name: 'B "quoted"', issued: 'Oct 2026' }];
  const json = buildFinishFiles({ records_file: 'certs.json' }, records);
  assert.ok(Array.isArray(json));
  assert.equal(json[0].mime, 'application/json');
  assert.deepEqual(JSON.parse(json[0].content), records);
  const csv = buildFinishFiles({ records_file: 'certs.csv' }, records);
  assert.ok(Array.isArray(csv));
  assert.equal(csv[0].content, recordsCsv(records));
  assert.equal(csv[0].content, 'name,url,issued\n"A, Inc.",https://a.example,\n"B ""quoted""",,Oct 2026');
});

test('a finish file that cannot be opened is refused with the reason', () => {
  assert.match(String(buildFinishFiles({ records_file: 'certs.json' }, [])), /needs saved records/);
  assert.match(String(buildFinishFiles({ records_file: '../x.json' }, [{ a: 1 }])), /must be a file name/);
  assert.match(String(buildFinishFiles({ records_file: 'x.exe' }, [{ a: 1 }])), /ending in \.json or \.csv/);
  assert.match(String(buildFinishFiles({ files: [{ name: 'a.json', content: '[1,]' }] }, [])), /files\[0\] \(a\.json\) is not valid JSON/);
  assert.match(String(buildFinishFiles({ files: [{ name: 'a.md', content: 'x'.repeat(FILES_MAX_CHARS + 1) }] }, [])), /at most 20 KB/);
  assert.match(String(buildFinishFiles({ files: [{ name: 'a.md', content: 'x' }, { name: 'A.md', content: 'y' }] }, [])), /same name/);
  assert.match(String(buildFinishFiles({ files: [1, 2, 3, 4] }, [])), /at most 3 files/);
  assert.deepEqual(buildFinishFiles({ answer: 'no files' }, []), []);
  // Nothing a system would run or a browser would render is offered, whatever a page talked the model into.
  for (const name of ['report.hta', 'run.bat', 'x.sh', 'page.html', 'pic.svg', '..json', ' .csv']) {
    assert.match(String(buildFinishFiles({ files: [{ name, content: 'x' }] }, [])), /must be a plain file name/, name);
  }
});

test('a JSON problem names the line', () => {
  assert.equal(jsonProblem('{"a": 1}'), null);
  // The line when the runtime names a position, else the runtime's own words.
  assert.match(String(jsonProblem('[\n  {"a": 1},\n]')), /line 3|Unexpected token/);
});

test('the log keeps the size of a file, never its content', () => {
  const logged = loggableArguments('finish', { answer: 'a', outcome: 'done', files: [{ name: 'a.json', content: '[1,2,3]' }] });
  assert.deepEqual(logged.files, [{ name: 'a.json', chars: 7 }]);
  assert.deepEqual(loggableArguments('read_page', { part: 2 }), { part: 2 });
});

// ---- task progress and stalls ---------------------------------------------------------------

test('reading element after element is a stall: the first gets a note, a second one ends the run', () => {
  const tracker = new ProgressTracker();
  const stalls: number[] = [];
  for (let i = 1; i <= STALL_AT * 2; i++) {
    stalls.push(tracker.record('read_page', { element_id: i }, `Text of element [${i}] (part 1 of 1):\nLabel ${i}`, { url: 'https://p.test/' }).stall);
  }
  assert.equal(stalls.indexOf(1), STALL_AT - 1, 'the first stall comes with the STALL_AT-th step');
  assert.equal(stalls.filter((s) => s === 1).length, 1);
  assert.equal(stalls[STALL_AT * 2 - 1], 2, 'a second stall in a row is the end');
});

test('new data, a finished plan step, a page change or a new part of a page is progress', () => {
  const tracker = new ProgressTracker();
  const quiet = () => tracker.record('find', { query: 'x' }, '[1] link "x"', { url: 'https://p.test/' });
  for (let i = 0; i < STALL_AT - 1; i++) quiet();
  assert.equal(tracker.stepsSinceProgress, STALL_AT - 1);
  tracker.record('save_data', { records: [{ a: 1 }] }, 'Saved 1 new record (1 in total).', { taskProgress: true });
  assert.equal(tracker.stepsSinceProgress, 0, 'saved data resets the count');
  quiet();
  tracker.record('update_plan', { done: [1] }, 'Plan updated.', { taskProgress: true });
  assert.equal(tracker.stepsSinceProgress, 0, 'a finished plan step resets it');
  quiet();
  tracker.record('read_page', { part: 1 }, 'Page text (part 1 of 2)', { url: 'https://p.test/' });
  assert.equal(tracker.stepsSinceProgress, 0, 'a part of a page not read before is progress');
  tracker.record('read_page', { part: 1 }, 'Page text (part 1 of 2) again', { url: 'https://p.test/' });
  assert.equal(tracker.stepsSinceProgress, 1, 'the same part again is not');
  tracker.record('click', { element_id: 3 }, 'Clicked\nObservation: text in view changed (+"Added"); url unchanged', { url: 'https://p.test/' });
  assert.equal(tracker.stepsSinceProgress, 0, 'a click that changed the page is progress');
  tracker.record('click', { element_id: 3 }, 'Clicked\nObservation: nothing in view changed; focus unchanged; url unchanged', { url: 'https://p.test/' });
  assert.equal(tracker.stepsSinceProgress, 1, 'a quiet click is not');
  tracker.record('web_search', { query: 'a' }, 'Web search (a)', {});
  assert.equal(tracker.stepsSinceProgress, 0, 'a new search is progress');
  tracker.record('fetch_url', { url: 'https://x.test/' }, 'Fetched https://x.test/', {});
  tracker.record('fetch_url', { url: 'https://x.test/' }, 'Fetched https://x.test/', {});
  assert.equal(tracker.stepsSinceProgress, 1, 'the same fetch again is not');
  tracker.record('update_plan', { done: [1] }, 'Plan updated.', { taskProgress: false });
  assert.equal(tracker.stepsSinceProgress, 2, 'a mark that finishes nothing counts toward a stall');
  tracker.record('save_data', { records: [{ a: 1 }] }, 'Saved 0 new records (1 in total).', { taskProgress: false });
  assert.equal(tracker.stepsSinceProgress, 3, 'records that were all saved before count toward a stall too');
  tracker.record('read_page', { part: 3 }, 'Page text', { url: 'https://p.test/', neutral: true });
  assert.equal(tracker.stepsSinceProgress, 3, 'a re-read of a shortened result neither counts nor resets');
});

// ---- context compaction ---------------------------------------------------------------------

/** A history of n rounds, each one read whose result is long. */
function rounds(n: number): Message[] {
  const history: Message[] = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'TASK: x' }];
  for (let i = 1; i <= n; i++) {
    history.push({ role: 'assistant', content: '', tool_calls: [{ id: `c${i}`, function: { name: 'read_page', arguments: JSON.stringify({ part: i }) } }] });
    history.push({ role: 'tool', tool_call_id: `c${i}`, content: `Page text (part ${i} of 40):\nUntrusted content from p.test\n${'body '.repeat(100)}` });
  }
  return history;
}

const shortened = (history: Message[]) => history.filter((m) => m.role === 'tool' && String(m.content).startsWith(COMPACTED_PREFIX)).length;

test('no result is shortened until COMPACT_AT rounds; then all but the last COMPACT_KEEP are', () => {
  assert.equal(shortened(compactToolResults(rounds(COMPACT_AT)).history), 0);
  const { history, compacted } = compactToolResults(rounds(COMPACT_AT + 1));
  assert.equal(shortened(history), COMPACT_AT + 1 - COMPACT_KEEP);
  assert.equal(compacted.size, COMPACT_AT + 1 - COMPACT_KEEP, 'the shortened calls are named for the stall count');
  const first = history.find((m) => m.role === 'tool')!;
  assert.equal(first.content, `${COMPACTED_PREFIX} Page text (part 1 of 40): Run the call again if you need it in full.`, 'only the head stays, never a cut envelope');
});

test('the compaction moves in blocks, so the shortened prefix stays the same between them', () => {
  const at = (n: number) => shortened(compactToolResults(rounds(n)).history);
  const counts = Array.from({ length: 14 }, (_, i) => at(COMPACT_AT + 1 + i));
  const block = COMPACT_AT - COMPACT_KEEP;
  assert.deepEqual(counts.slice(0, block), Array(block).fill(COMPACT_AT + 1 - COMPACT_KEEP), 'one block keeps the same prefix');
  assert.equal(counts[block], COMPACT_AT + 1 - COMPACT_KEEP + block, 'the next block shortens the next rounds');
});

test('the compaction keeps every message and the tool-call pairing', () => {
  const before = rounds(20);
  const { history } = compactToolResults(before);
  assert.equal(history.length, before.length);
  history.forEach((m, i) => {
    assert.equal(m.role, before[i].role);
    assert.equal(m.tool_call_id, before[i].tool_call_id);
  });
  assert.equal(before.filter((m) => String(m.content).startsWith(COMPACTED_PREFIX)).length, 0, 'the stored history is untouched');
});
