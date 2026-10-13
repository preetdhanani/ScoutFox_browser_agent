import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModelReply, parseBareActionJson } from '../../src/background/agent/parse.ts';
import { verbsFor, ACTION_VERBS } from '../../src/background/agent/actions.ts';
import { TOOL_CALL_MARKUP_ERROR } from '../../src/background/agent/toolCalls.ts';

test('parseBareActionJson parses clean JSON action objects and rejects invalid structures', () => {
  const parsed = parseBareActionJson('{"action": "scroll", "direction": "down"}');
  assert.deepEqual(parsed, { action: 'scroll', direction: 'down' });

  assert.equal(parseBareActionJson('{"action": 123}'), null);
  assert.equal(parseBareActionJson('[{"action": "scroll"}]'), null);
  assert.equal(parseBareActionJson('{"action": "scroll"} extra text'), null);
  assert.equal(parseBareActionJson('not json'), null);
  assert.equal(parseBareActionJson(''), null);
});

test('parseModelReply extracts page verbs and state verbs according to mode and tier', () => {
  const browseVerbs = verbsFor('browse', 'small');

  const clickReply = parseModelReply('{"action": "click", "element_id": 4}', {
    verbs: browseVerbs,
    refs: new Set([1, 2, 3, 4]),
  });
  assert.equal(clickReply.error, undefined);
  assert.deepEqual(clickReply.action, { action: 'click', element_id: 4 });

  const scrollReply = parseModelReply('{"action": "scroll", "direction": "down"}', {
    verbs: browseVerbs,
  });
  assert.equal(scrollReply.error, undefined);
  assert.deepEqual(scrollReply.action, { action: 'scroll', direction: 'down' });
});

test('parseModelReply strips thinking and reasoning tags while keeping thought and action', () => {
  const replyWithThink = `
<think>
I need to click the search button at element 3.
</think>
\`\`\`json
{"action": "click", "element_id": 3}
\`\`\`
  `;
  const result = parseModelReply(replyWithThink, {
    verbs: ACTION_VERBS,
    refs: new Set([1, 2, 3]),
  });
  assert.equal(result.error, undefined);
  assert.match(result.thought ?? '', /click the search button/);
  assert.deepEqual(result.action, { action: 'click', element_id: 3 });

  const replyWithReasoning = `
<reasoning>Comparing items</reasoning>
{"action": "scroll", "direction": "down"}
  `;
  const reasoningResult = parseModelReply(replyWithReasoning, { verbs: ACTION_VERBS });
  assert.equal(reasoningResult.error, undefined);
  assert.equal(reasoningResult.thought, 'Comparing items');
  assert.equal(reasoningResult.action?.action, 'scroll');
});

test('parseModelReply handles JSON in markdown code fences', () => {
  const fenced = 'Here is the action:\n```json\n{"action": "navigate", "url": "https://example.com"}\n```';
  const result = parseModelReply(fenced, { verbs: ACTION_VERBS });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.action, { action: 'navigate', url: 'https://example.com' });
});

test('parseModelReply rejects unconvertible tool-call markup and never wraps it as prose or finish', () => {
  const toolCallReply = '<tool_call>\n{"name": "web_search", "arguments": {"q": "shoes"}}\n</tool_call>';
  const result = parseModelReply(toolCallReply, { verbs: ACTION_VERBS });
  assert.equal(result.action, undefined);
  assert.equal(result.kind, 'tool_call_markup');
  assert.equal(result.error, TOOL_CALL_MARKUP_ERROR);

  const answerModeVerbs = verbsFor('answer', 'large');
  const clickInAnswerMode = '<tool_call>\n{"name": "click", "arguments": {"element_id": 2}}\n</tool_call>';
  const answerResult = parseModelReply(clickInAnswerMode, { verbs: answerModeVerbs });
  assert.equal(answerResult.action, undefined);
  assert.equal(answerResult.kind, 'tool_call_markup');
  assert.equal(answerResult.error, TOOL_CALL_MARKUP_ERROR);
});

test('parseModelReply detects unavailable actions for the current policy mode and tier', () => {
  const smallVerbs = verbsFor('browse', 'small');
  const result = parseModelReply('{"action": "execute_js", "code": "return 1;"}', { verbs: smallVerbs });
  assert.equal(result.action, undefined);
  assert.equal(result.kind, 'unavailable_action');
  assert.match(result.error ?? '', /Action "execute_js" is not available here/);

  const unknownResult = parseModelReply('{"action": "unsupported_verb"}', { verbs: smallVerbs });
  assert.equal(unknownResult.action, undefined);
  assert.equal(unknownResult.kind, 'unknown_action');
  assert.match(unknownResult.error ?? '', /Unknown action "unsupported_verb"/);
});

test('parseModelReply normalizes aliases to their canonical action verbs', () => {
  const aliasClick = parseModelReply('{"action": "click_element", "element_id": 5}', {
    verbs: ACTION_VERBS,
    refs: new Set([5]),
  });
  assert.equal(aliasClick.error, undefined);
  assert.equal(aliasClick.action?.action, 'click');
  assert.equal(aliasClick.action?.element_id, 5);

  const shorthandClick = parseModelReply('{"click": 7}', {
    verbs: ACTION_VERBS,
    refs: new Set([7]),
  });
  assert.equal(shorthandClick.error, undefined);
  assert.equal(shorthandClick.action?.action, 'click');
  assert.equal(shorthandClick.action?.element_id, 7);
});

test('parseModelReply wraps direct prose as an unconfirmed finish action', () => {
  const prose = 'The product costs $49.99 with free shipping.';
  const result = parseModelReply(prose, { verbs: ACTION_VERBS });
  assert.equal(result.error, undefined);
  assert.equal(result.action?.action, 'finish');
  assert.equal(result.action?.answer, prose);
  assert.equal(result.action?.autoWrapped, true);
});

test('parseBareActionJson returns null for markdown fences or extra text', () => {
  const fenced = '```json\n{"action": "click", "element_id": 2}\n```';
  assert.equal(parseBareActionJson(fenced), null);

  const extra = '{"action": "scroll"} and more';
  assert.equal(parseBareActionJson(extra), null);
});

test('parseBareActionJson returns null when thought tag precedes JSON', () => {
  const withThought = '<thought>Need to scroll</thought>\n{"action": "scroll", "direction": "down"}';
  assert.equal(parseBareActionJson(withThought), null);
});

test('parseBareActionJson rejects JSON when action value is not a string', () => {
  assert.equal(parseBareActionJson('{"action": null}'), null);
  assert.equal(parseBareActionJson('{"action": true}'), null);
  assert.equal(parseBareActionJson('{"action": {}}'), null);
});

test('parseModelReply normalizes done alias to finish', () => {
  const reply = parseModelReply('{"action": "done", "answer": "All tasks completed"}', {
    verbs: ACTION_VERBS,
  });
  assert.equal(reply.error, undefined);
  assert.equal(reply.action?.action, 'finish');
  assert.equal(reply.action?.answer, 'All tasks completed');
});

test('parseModelReply normalizes type_text and input aliases to type', () => {
  const alias1 = parseModelReply('{"action": "type_text", "element_id": 1, "text": "laptop"}', {
    verbs: ACTION_VERBS,
    refs: new Set([1]),
  });
  assert.equal(alias1.action?.action, 'type');
  assert.equal(alias1.action?.text, 'laptop');

  const alias2 = parseModelReply('{"action": "input", "element_id": 1, "text": "shoes"}', {
    verbs: ACTION_VERBS,
    refs: new Set([1]),
  });
  assert.equal(alias2.action?.action, 'type');
  assert.equal(alias2.action?.text, 'shoes');
});

test('parseModelReply normalizes scroll_page alias to scroll', () => {
  const aliasScroll = parseModelReply('{"action": "scroll_page", "direction": "down"}', {
    verbs: ACTION_VERBS,
  });
  assert.equal(aliasScroll.action?.action, 'scroll');
  assert.equal(aliasScroll.action?.direction, 'down');
});

test('parseModelReply normalizes wait seconds to amount', () => {
  const reply = parseModelReply('{"action": "wait", "seconds": 5}', {
    verbs: ACTION_VERBS,
  });
  assert.equal(reply.error, undefined);
  assert.equal(reply.action?.action, 'wait');
  assert.equal(reply.action?.amount, 5);
});

test('parseModelReply handles browser_batch with multiple valid action steps', () => {
  const batchJson = JSON.stringify({
    action: 'browser_batch',
    steps: [
      { action: 'click', element_id: 1 },
      { action: 'type', element_id: 2, text: 'hello' },
    ],
  });
  const result = parseModelReply(batchJson, {
    verbs: ACTION_VERBS,
    refs: new Set([1, 2]),
  });
  assert.equal(result.error, undefined);
  assert.equal(result.action?.action, 'browser_batch');
  assert.equal(Array.isArray(result.action?.steps), true);
});

test('parseModelReply converts valid tool_call XML markup into standard action', () => {
  const raw = '<tool_call>\n{"name": "click", "arguments": {"element_id": 1}}\n</tool_call>';
  const result = parseModelReply(raw, { verbs: ACTION_VERBS, refs: new Set([1]) });
  assert.equal(result.error, undefined);
  assert.equal(result.action?.action, 'click');
  assert.equal(result.action?.element_id, 1);
});

test('parseModelReply converts function_call markup with valid arguments', () => {
  const raw = '<function_call>\n{"name": "navigate", "arguments": {"url": "https://example.com"}}\n</function_call>';
  const result = parseModelReply(raw, { verbs: ACTION_VERBS });
  assert.equal(result.error, undefined);
  assert.equal(result.action?.action, 'navigate');
  assert.equal(result.action?.url, 'https://example.com');
});

test('parseModelReply rejects tool_call markup when function name is not a known action', () => {
  const raw = '<tool_call>\n{"name": "unknown_tool", "arguments": {}}\n</tool_call>';
  const result = parseModelReply(raw, { verbs: ACTION_VERBS });
  assert.equal(result.action, undefined);
  assert.equal(result.kind, 'tool_call_markup');
  assert.equal(result.error, TOOL_CALL_MARKUP_ERROR);
});

test('parseModelReply extracts JSON embedded between commentary paragraphs', () => {
  const raw = 'Based on the page, I will scroll down to see more.\n\n{"action": "scroll", "direction": "down"}\n\nHope this helps!';
  const result = parseModelReply(raw, { verbs: ACTION_VERBS });
  assert.equal(result.error, undefined);
  assert.equal(result.action?.action, 'scroll');
  assert.equal(result.action?.direction, 'down');
});
