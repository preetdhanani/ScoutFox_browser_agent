/**
 * The per-provider payload mapping for a picture: src/background/llm/index.ts.
 *
 * The two providers want the same picture in two different shapes:
 *   - OpenAI-compatible: `content: [{type:'text'}, {type:'image_url', image_url:{url:'data:...'}}]`,
 *     which the payload builder already forwards verbatim once the message is built right.
 *   - Ollama: the text stays in `content` and the pictures become a SIBLING `images` array of
 *     bare base64 (no data: prefix) on the same `role:'user'` message.
 *
 * Getting the Ollama shape wrong is silent: Ollama ignores an unknown field and answers about a
 * picture it never saw, so the model confidently describes a page it did not look at.
 *
 * What these tests hold on to:
 *   1. The OpenAI payload carries the image_url block unchanged.
 *   2. The Ollama payload carries the same bytes as `images: ['<base64>']` on the same message.
 *   3. The data: prefix is stripped for Ollama and kept for OpenAI.
 *   4. A tool message never carries an image.
 *   5. A plain text message is unchanged for both.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { stripDataUrl, toOllamaMessage, toOllamaMessages } from '../../src/background/llm/index.ts';

const DATA_URL = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';

test('the data: prefix is stripped to the bare base64 Ollama wants', () => {
  assert.equal(stripDataUrl(DATA_URL), '/9j/4AAQSkZJRg==');
  assert.equal(stripDataUrl('image/png;base64'), 'image/png;base64', 'a string without the prefix is not touched');
  assert.equal(stripDataUrl(''), '');
});

test('an Ollama user message carries the pictures beside the text, not in it', () => {
  const message = {
    role: 'user',
    content: [
      { type: 'text', text: 'Here is the picture of the page (1280x720).' },
      { type: 'image_url', image_url: { url: DATA_URL } }
    ]
  };
  const converted = toOllamaMessage(message);

  assert.equal(converted.role, 'user');
  assert.equal(converted.content, 'Here is the picture of the page (1280x720).', 'the text is the content');
  assert.deepEqual(converted.images, ['/9j/4AAQSkZJRg=='], 'the picture is a sibling array, base64 only');
});

test('two pictures become two entries in the one images array', () => {
  const converted = toOllamaMessage({
    role: 'user',
    content: [
      { type: 'text', text: 'first' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAA' } },
      { type: 'text', text: 'second' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,BBB' } }
    ]
  });
  assert.deepEqual(converted.images, ['AAA', 'BBB']);
  assert.equal(converted.content, 'first\n\nsecond');
});

test('a text-only message is returned exactly as it was', () => {
  const plain = { role: 'user', content: 'just text' };
  assert.equal(toOllamaMessage(plain), plain, 'the same object, untouched');
  const assistant = { role: 'assistant', content: '', tool_calls: [] };
  assert.equal(toOllamaMessage(assistant), assistant);
});

test('a message with a content array but no picture gets no images field', () => {
  const converted = toOllamaMessage({ role: 'user', content: [{ type: 'text', text: 'hi' }] });
  assert.equal(converted.content, 'hi');
  assert.equal('images' in converted, false, 'an empty images array is not sent');
});

test('a tool message is left alone: it can never carry a picture', () => {
  const toolMessage = { role: 'tool', tool_call_id: 'c1', content: 'Captured the visible page.' };
  assert.equal(toOllamaMessage(toolMessage), toolMessage);
});

test('the whole history is converted in one pass, tool arguments included', () => {
  const converted = toOllamaMessages([
    { role: 'system', content: 'rules' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'take_screenshot', arguments: '{"reason":"look"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'Captured the page.' },
    { role: 'user', content: [{ type: 'text', text: 'picture' }, { type: 'image_url', image_url: { url: DATA_URL } }] }
  ]);

  assert.equal(converted[0].content, 'rules');
  // Ollama wants the tool arguments as an OBJECT, and answers 400 for a string.
  assert.deepEqual(converted[1].tool_calls[0].function.arguments, { reason: 'look' });
  assert.equal(converted[2].content, 'Captured the page.');
  assert.deepEqual(converted[3].images, ['/9j/4AAQSkZJRg==']);
});
