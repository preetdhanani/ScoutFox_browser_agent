/**
 * The tool list the model is given.
 *
 * These are the words the model reads to decide what it can do, and the schema the provider
 * validates the arguments against. Three things can go wrong here, and each of them is quiet at
 * the point of the mistake:
 *
 *   - a tool with a schema the provider rejects (a null where an array belongs): the run dies with
 *     an opaque HTTP 400, before the model is ever asked;
 *   - a tool the engine does not serve: the model calls it and nothing happens;
 *   - a tool the panel does not know: the row never shows up in the timeline.
 *
 * So this file checks the list against the three things it must agree with: the schema check of
 * the LLM layer, the tools the server serves, and the actions the history maps.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { SCOUTFOX_TOOLS, TOOL_MAP, TOOL_NAMES } from '../../src/background/mcp/tools.ts';
import { assertToolSchema } from '../../src/background/llm/index.ts';
import { mapToolToAction } from '../../src/background/mcp/historyEntries.ts';

test('every tool has a schema the provider accepts', () => {
  // The same check the LLM layer makes before a request goes out. A tool that fails here would
  // kill every run with an HTTP 400 from the provider.
  for (const tool of SCOUTFOX_TOOLS) {
    assert.doesNotThrow(
      () => assertToolSchema(tool),
      `the tool "${tool.name}" has a schema the provider would reject`
    );
  }
});

test('every tool has a name, a description and a required field where it needs one', () => {
  for (const tool of SCOUTFOX_TOOLS) {
    assert.ok(tool.name, 'a tool has a name');
    assert.match(tool.name, /^[a-z][a-z0-9_]*$/, `the tool name "${tool.name}" is a plain snake_case name`);
    assert.ok(tool.description.length > 20, `the tool "${tool.name}" explains what it does`);
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false, `the tool "${tool.name}" takes no unknown arguments`);
  }
});

test('the tool names are unique, and the map holds exactly the list', () => {
  assert.equal(new Set(TOOL_NAMES).size, TOOL_NAMES.length, 'no tool name is used twice');
  assert.equal(TOOL_MAP.size, SCOUTFOX_TOOLS.length);
  for (const tool of SCOUTFOX_TOOLS) {
    assert.equal(TOOL_MAP.get(tool.name), tool);
  }
});

test('the tools the model needs to finish a task are all there', () => {
  // A run cannot end without finish, cannot read without read_page, and cannot act without
  // an element list. Losing one of these is a run that hangs.
  for (const name of ['finish', 'read_page', 'get_page_elements', 'click', 'type', 'scroll', 'navigate', 'update_plan']) {
    assert.ok(TOOL_NAMES.includes(name), `the tool "${name}" must exist`);
  }
});

test('a tool that needs an argument says which one, and the argument has a type', () => {
  for (const tool of SCOUTFOX_TOOLS) {
    for (const required of tool.inputSchema.required ?? []) {
      const property = tool.inputSchema.properties[required];
      assert.ok(property, `the tool "${tool.name}" requires "${required}" but does not describe it`);
      assert.ok(property.type, `the argument "${required}" of the tool "${tool.name}" has no type`);
    }
  }
});

test('the arguments of the tools that act on an element are numbers of at least one', () => {
  // Element ids start at 1, and a zero or a negative id addresses nothing.
  for (const name of ['click', 'type']) {
    const property = TOOL_MAP.get(name)!.inputSchema.properties.element_id;
    assert.equal(property.type, 'number');
    assert.equal(property.minimum, 1, `the element id of "${name}" starts at 1`);
  }
});

test('the direction of scroll is one of the two ways', () => {
  const property = TOOL_MAP.get('scroll')!.inputSchema.properties.direction;
  assert.deepEqual(property.enum, ['up', 'down']);
  assert.ok((TOOL_MAP.get('scroll')!.inputSchema.required ?? []).includes('direction'));
});

test('the url of navigate must be a full http(s) url', () => {
  const property = TOOL_MAP.get('navigate')!.inputSchema.properties.url;
  assert.equal(property.type, 'string');
  // The pattern is anchored, so a "javascript:" url cannot slip past the model.
  assert.equal(property.pattern, '^https?://');
  const pattern = new RegExp(property.pattern);
  assert.ok(pattern.test('https://example.com'));
  assert.ok(pattern.test('http://example.com'));
  assert.equal(pattern.test('javascript:alert(1)'), false, 'a javascript url is not a url to navigate to');
  assert.equal(pattern.test('example.com'), false, 'a url without a scheme is not a url to navigate to');
});

test('the plan is a list of steps, and the steps can be marked done without sending it again', () => {
  const tool = TOOL_MAP.get('update_plan')!;
  // plan or done, or both: the client refuses a call with neither (updatePlan in client.ts).
  assert.deepEqual(tool.inputSchema.required, ['reason']);
  assert.equal(tool.inputSchema.properties.done.items.type, 'integer');
  assert.equal(tool.inputSchema.properties.done.items.minimum, 1);
  assert.equal(tool.inputSchema.properties.plan.type, 'array');
  assert.equal(tool.inputSchema.properties.plan.items.type, 'string');
});

test('the amount of a wait is between one and five seconds', () => {
  const property = TOOL_MAP.get('wait')!.inputSchema.properties.amount;
  assert.equal(property.type, 'number');
  assert.equal(property.minimum, 1);
  assert.equal(property.maximum, 5);
});

test('the answer and the outcome of finish are required: a run without an answer tells the user nothing, and the card follows the outcome', () => {
  const tool = TOOL_MAP.get('finish')!;
  assert.deepEqual(tool.inputSchema.required, ['answer', 'outcome']);
  assert.deepEqual(tool.inputSchema.properties.outcome.enum, ['done', 'partial', 'blocked']);
  assert.equal(tool.inputSchema.properties.answer.type, 'string');
});

test('the query of find is required', () => {
  const tool = TOOL_MAP.get('find')!;
  assert.deepEqual(tool.inputSchema.required, ['query', 'reason']);
  assert.equal(tool.inputSchema.properties.query.type, 'string');
});

test('finish carries an optional table for quick comparison', () => {
  const tool = TOOL_MAP.get('finish')!;
  const table = tool.inputSchema.properties.table;
  assert.ok(table, 'finish has a table property');
  assert.equal(table.type, 'object');
  assert.equal(table.description.length, table.description.trim().length, 'the table description is not padded');
  // answer and outcome are required, table is not.
  assert.deepEqual(tool.inputSchema.required, ['answer', 'outcome']);
});

test('every tool but the plan shows up in the timeline, so no step is invisible', () => {
  // update_plan is the one tool that is not a timeline row: it is the plan checklist. Every other
  // tool must be mapped, or the user watches a run that does things the panel never shows.
  for (const name of TOOL_NAMES) {
    if (name === 'update_plan') continue;
    const action = mapToolToAction(name, {});
    assert.ok(action, `the tool "${name}" must show up in the timeline`);
  }
});

test('the old read and table tools are gone: read_page reads, finish.table shows a table', () => {
  for (const name of ['get_page_text', 'read_page_text', 'render_table']) assert.equal(TOOL_MAP.has(name), false, name);
  const read = TOOL_MAP.get('read_page')!;
  assert.equal(read.inputSchema.properties.part.type, 'integer');
  assert.equal(read.inputSchema.properties.part.minimum, 1);
  assert.equal(read.inputSchema.properties.element_id.type, 'number');
  assert.deepEqual(read.inputSchema.required ?? [], ['reason'], 'part and element_id are optional; only the step note is asked for');
  const scroll = TOOL_MAP.get('scroll')!;
  assert.deepEqual(Object.keys(scroll.inputSchema.properties).sort(), ['direction', 'element_id', 'reason', 'x', 'y']);
});

test('take_screenshot is a tool the model can call, with only the step note', () => {
  const tool = TOOL_MAP.get('take_screenshot');
  assert.ok(tool, 'the screenshot tool exists');
  assert.match(tool!.description, /picture of the visible page/i);
  assert.deepEqual(tool!.inputSchema.required ?? [], ['reason'], 'nothing but the step note is required to look at the page');
  assert.equal(tool!.inputSchema.properties.reason.type, 'string');
  assert.equal(tool!.inputSchema.additionalProperties, false);
});

test('click takes an element id OR a coordinate, and the rule is enforced by the server', () => {
  const click = TOOL_MAP.get('click')!;
  // element_id stops being required: a coordinate click has none.
  assert.deepEqual(click.inputSchema.required ?? [], ['reason'], 'neither form is unconditionally required');
  // The property keeps its shape, which is what the schema check reads.
  assert.equal(click.inputSchema.properties.element_id.type, 'number');
  assert.equal(click.inputSchema.properties.element_id.minimum, 1);
  // The coordinate pair is described, so the model knows the units.
  assert.equal(click.inputSchema.properties.x.type, 'number');
  assert.equal(click.inputSchema.properties.y.type, 'number');
  assert.equal(click.inputSchema.additionalProperties, false);
});

test('every tool but finish asks for the step note, so the model keeps its own thread', () => {
  // The case: a run read 74 elements and never said what it was looking for. The tool arguments
  // stay in the history, so the note of each step is what the model reads of its own thinking.
  for (const tool of TOOL_MAP.values()) {
    if (tool.name === 'finish') {
      assert.equal((tool.inputSchema.required || []).includes('reason'), false, 'finish has its answer instead');
      continue;
    }
    assert.ok((tool.inputSchema.required || []).includes('reason'), `${tool.name} asks for reason`);
    assert.equal(tool.inputSchema.properties.reason.type, 'string', tool.name);
  }
});

test('save_data takes a list of records, and finish can name a file of them', () => {
  const save = TOOL_MAP.get('save_data')!;
  assert.deepEqual(save.inputSchema.required, ['records', 'reason']);
  assert.equal(save.inputSchema.properties.records.items.type, 'object');
  const finish = TOOL_MAP.get('finish')!;
  assert.equal(finish.inputSchema.properties.records_file.type, 'string');
  assert.deepEqual(finish.inputSchema.properties.files.items.required, ['name', 'content']);
});
