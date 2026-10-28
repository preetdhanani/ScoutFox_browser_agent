/**
 * The history rows the side panel renders from.
 *
 * The MCP engine turns every tool call and every tool result into a row of the timeline, and the
 * panel renders exactly these shapes. So this is where the vocabulary of the panel is decided: a
 * tool that is not mapped here would either be invisible in the timeline or show as its own tool
 * name, and a result that is not shortened would put a whole page of text into one row.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  agentResponseEntry,
  errorEntry,
  executionResultEntry,
  finishEntry,
  finishOutcomeOf,
  mapToolToAction,
  screenshotResultEntry,
  summarizeToolResult,
  userGoalEntry
} from '../../src/background/mcp/historyEntries.ts';

test('mapToolToAction: the reading tools become the actions the panel already knows', () => {
  assert.deepEqual(mapToolToAction('read_page', {}), { action: 'read_page' });
  assert.deepEqual(mapToolToAction('read_page', { part: 1 }), { action: 'read_page' }, 'part 1 is the plain read');
  assert.deepEqual(mapToolToAction('read_page', { part: 3 }), { action: 'read_page', part: 3 });
  assert.deepEqual(mapToolToAction('read_page', { element_id: 7 }), { action: 'read_page', element_id: 7 });
  assert.deepEqual(mapToolToAction('get_page_elements', {}), { action: 'get_page_elements' });
});

test('mapToolToAction: the acting tools keep the arguments the panel shows', () => {
  assert.deepEqual(mapToolToAction('click', { element_id: 7 }), { action: 'click', element_id: 7 });
  assert.deepEqual(mapToolToAction('type', { element_id: 3, text: 'hello' }), { action: 'type', element_id: 3, text: 'hello' });
  assert.deepEqual(mapToolToAction('scroll', { direction: 'down' }), { action: 'scroll', direction: 'down' });
  assert.deepEqual(mapToolToAction('scroll', { direction: 'down', element_id: 4 }), { action: 'scroll', direction: 'down', element_id: 4 });
  assert.deepEqual(mapToolToAction('scroll', { direction: 'up', x: 10, y: 20 }), { action: 'scroll', direction: 'up', x: 10, y: 20 });
  assert.deepEqual(mapToolToAction('navigate', { url: 'https://example.com' }), { action: 'navigate', url: 'https://example.com' });
  assert.deepEqual(mapToolToAction('wait', { amount: 3 }), { action: 'wait', amount: 3 });
  assert.deepEqual(mapToolToAction('go_back', {}), { action: 'go_back' });
  assert.deepEqual(mapToolToAction('go_forward', {}), { action: 'go_forward' });
  assert.deepEqual(mapToolToAction('finish', {}), { action: 'finish' });
});

test('mapToolToAction: find carries the query, so the panel can say what was searched for', () => {
  assert.deepEqual(mapToolToAction('find', { query: 'download button' }), { action: 'find_elements', query: 'download button' });
});

test('mapToolToAction: the plan is not an action row, it is the plan checklist', () => {
  // update_plan writes the checklist, not a timeline row of its own. A row for it would show the
  // plan twice: once in the checklist and once in the actions.
  assert.equal(mapToolToAction('update_plan', { plan: ['a', 'b'] }), null);
});

test('mapToolToAction: a tool we do not know passes through, so a new tool is never invisible', () => {
  // The engine gets a new tool before the panel learns it. Showing the name is better than
  // dropping the row: a missing row is a run the user cannot follow.
  assert.deepEqual(mapToolToAction('some_new_tool', { x: 1 }), { action: 'some_new_tool' });
});

test('mapToolToAction: a missing argument list does not throw', () => {
  // The arguments come from the model, so they can be absent, null or the wrong shape.
  assert.deepEqual(mapToolToAction('click', null), { action: 'click', element_id: undefined });
  assert.deepEqual(mapToolToAction('find', null), { action: 'find_elements', query: undefined });
  assert.deepEqual(mapToolToAction('read_page', null), { action: 'read_page' });
});

test('summarizeToolResult: a short result is kept whole', () => {
  assert.equal(summarizeToolResult('Price: 99 USD'), 'Price: 99 USD');
  assert.equal(summarizeToolResult(''), '');
});

test('summarizeToolResult: a long result is cut to one line, with a mark that it was cut', () => {
  const long = 'x'.repeat(5000);
  const summary = summarizeToolResult(long);
  assert.ok(summary.length < 250, `the summary is ${summary.length} characters, which is too long for one row`);
  assert.ok(summary.endsWith('…'), 'the cut is visible');
  assert.ok(summary.startsWith('x'.repeat(100)));
});

test('summarizeToolResult: a result that is exactly the limit is not cut', () => {
  const exact = 'y'.repeat(200);
  assert.equal(summarizeToolResult(exact), exact);
});

test('the rows carry the fields the panel reads', () => {
  const goal = userGoalEntry(1, 'Find the price');
  assert.equal(goal.type, 'user_goal');
  assert.equal(goal.turn, 1);
  assert.equal(goal.prompt, 'Find the price');
  assert.equal(goal.isNewRun, true);
  assert.equal(typeof goal.timestamp, 'string');

  const response = agentResponseEntry(2, 'thinking', { action: 'click', element_id: 4 }, '{"raw":true}');
  assert.equal(response.type, 'agent_response');
  assert.equal(response.step, 2);
  assert.equal(response.thought, 'thinking');
  assert.deepEqual(response.action, { action: 'click', element_id: 4 });
  assert.equal(response.rawResponse, '{"raw":true}');

  const ok = executionResultEntry(2, true, 'Clicked element [4]') as any;
  assert.equal(ok.type, 'execution_result');
  assert.equal(ok.step, 2);
  assert.equal(ok.success, true);
  assert.equal(ok.message, 'Clicked element [4]');

  const failed = executionResultEntry(2, false, 'Error: no tab') as any;
  assert.equal(failed.success, false);
  assert.equal(failed.error, 'Error: no tab');
  assert.equal(failed.message, undefined, 'a failed result carries the error, not a message');

  const error = errorEntry('the model returned nothing');
  assert.equal(error.type, 'error');
  assert.equal(error.content, 'the model returned nothing');

  const finish = finishEntry('It costs 99 USD.');
  assert.equal(finish.type, 'finish');
  assert.equal(finish.answer, 'It costs 99 USD.');
});

test('finishEntry carries the outcome only when there is one, and finishOutcomeOf knows exactly three', () => {
  assert.equal('outcome' in (finishEntry('x') as any), false, 'a plain-text reply has no outcome');
  assert.equal((finishEntry('x', '', undefined, 'blocked') as any).outcome, 'blocked');
  assert.equal((finishEntry('x', 'ev', { columns: ['a'], rows: [['1']] }, 'partial') as any).outcome, 'partial');
  for (const ok of ['done', 'partial', 'blocked']) assert.equal(finishOutcomeOf(ok), ok);
  for (const bad of [undefined, null, '', 'Done', 'failed', 1, {}]) assert.equal(finishOutcomeOf(bad), undefined, String(bad));
});

test('mapToolToAction: a coordinate click carries the coordinates and no element id', () => {
  // The panel reads these to say "Clicked at (812, 344) in the picture" instead of
  // "Clicked element undefined".
  assert.deepEqual(mapToolToAction('click', { x: 812, y: 344 }), { action: 'click', x: 812, y: 344 });
  // An element click keeps its shape.
  assert.deepEqual(mapToolToAction('click', { element_id: 4 }), { action: 'click', element_id: 4 });
});

test('mapToolToAction: take_screenshot is an action row of its own', () => {
  assert.deepEqual(mapToolToAction('take_screenshot', {}), { action: 'take_screenshot' });
  assert.deepEqual(mapToolToAction('take_screenshot', { reason: 'look' }), { action: 'take_screenshot' });
});

test('the row of a step that took a picture carries the id and the size, never the bytes', () => {
  const row: any = screenshotResultEntry(3, true, 'Captured the visible page (1280x720, image/jpeg).', {
    imageId: 'shot-abc-1',
    imageWidth: 1280,
    imageHeight: 720
  });
  assert.equal(row.type, 'execution_result');
  assert.equal(row.step, 3);
  assert.equal(row.success, true);
  assert.equal(row.imageId, 'shot-abc-1');
  assert.equal(row.imageWidth, 1280);
  assert.equal(row.imageHeight, 720);
  assert.match(row.message, /Captured the visible page/);
  assert.doesNotMatch(JSON.stringify(row), /base64/);
});

test('a failed screenshot row is an error row, and has no picture', () => {
  const row: any = screenshotResultEntry(1, false, 'Error: the page could not be photographed.');
  assert.equal(row.success, false);
  assert.match(row.error, /could not be photographed/);
  assert.equal(row.imageId, undefined);
});

test('a screenshot row without a picture is the plain result row', () => {
  const row: any = screenshotResultEntry(2, false, 'Error: the page is zoomed.');
  const plain: any = executionResultEntry(2, false, 'Error: the page is zoomed.');
  assert.deepEqual(row, plain);
});

test('press_key and a type without an element id map to panel actions; a row label names the element', async () => {
  const { mapToolToAction, elementRowLabel } = await import('../../src/background/mcp/historyEntries.ts');
  assert.deepEqual(mapToolToAction('press_key', { key: 'Enter', modifiers: ['shift'] }), { action: 'press_key', key: 'Enter', modifiers: ['shift'] });
  assert.deepEqual(mapToolToAction('press_key', { key: 'select_all' }), { action: 'press_key', key: 'select_all' });
  assert.deepEqual(mapToolToAction('type', { text: 'x' }), { action: 'type', text: 'x' });
  assert.deepEqual(mapToolToAction('type', { element_id: 2, text: 'x', mode: 'append' }), { action: 'type', element_id: 2, text: 'x', mode: 'append' });
  assert.equal(elementRowLabel('[1] div "sudo apt install ollama" (label="Code cell editor")'), 'Code cell editor');
  assert.equal(elementRowLabel('[3] button[button] "In den Warenkorb"'), 'In den Warenkorb');
  assert.equal(elementRowLabel(''), '');
});
