/**
 * Token counts as the context meter reads and writes them (src/shared/tokens.ts).
 *
 * What these tests hold on to:
 *   1. The Settings field takes "200000", "200K" or "1M", and nothing that is not a count.
 *   2. The panel writes a window the way its model card names it (262144 is "256K") and a used
 *      count in thousands with one decimal ("31.2K").
 *   3. An estimate counts the text of every message, 1,500 tokens per picture, and the tool schemas.
 *   4. A /models entry names its window in one of five fields, and each is read.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { IMAGE_TOKENS, contextLengthOf, estimatePromptTokens, estimateTextTokens, formatTokens, parseTokenCount } from '../../src/shared/tokens.ts';

test('the window field takes a plain count, K and M, and refuses anything else', () => {
  assert.equal(parseTokenCount('200000'), 200_000);
  assert.equal(parseTokenCount('200K'), 200_000);
  assert.equal(parseTokenCount('200k'), 200_000);
  assert.equal(parseTokenCount(' 1M '), 1_000_000);
  assert.equal(parseTokenCount('1.5M'), 1_500_000);
  assert.equal(parseTokenCount('131,072'), 131_072);
  for (const bad of ['', 'abc', '-5', '0', '12 tokens', '1G', '2KK', 'K']) {
    assert.equal(parseTokenCount(bad), null, `${JSON.stringify(bad)} is not a count`);
  }
});

test('a window reads as its model card names it, a used count in thousands with one decimal', () => {
  assert.equal(formatTokens(262144), '256K');
  assert.equal(formatTokens(131072), '128K');
  assert.equal(formatTokens(1048576), '1M');
  assert.equal(formatTokens(200000), '200K');
  assert.equal(formatTokens(1_000_000), '1M');
  assert.equal(formatTokens(31_200), '31.2K');
  assert.equal(formatTokens(31_249), '31.2K');
  assert.equal(formatTokens(950), '950');
  assert.equal(formatTokens(0), '0');
});

test('an estimate counts the text, each picture as 1,500 tokens, and the tool schemas', () => {
  const text = 'x'.repeat(4000);
  assert.equal(estimateTextTokens(text), 1000);
  const plain = estimatePromptTokens([{ role: 'system', content: text }]);
  assert.equal(plain, 1000);
  const withPicture = estimatePromptTokens([
    { role: 'system', content: text },
    { role: 'user', content: [{ type: 'text', text: 'abcd' }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${'A'.repeat(400_000)}` } }] }
  ]);
  assert.equal(withPicture, 1001 + IMAGE_TOKENS, 'the picture is 1,500 tokens, not its base64 length');
  const tools = [{ name: 'navigate', description: 'Go to a URL', inputSchema: { type: 'object', properties: { url: { type: 'string' } } } }];
  assert.equal(estimatePromptTokens([{ role: 'system', content: text }], tools), Math.ceil((4000 + JSON.stringify(tools).length) / 4), 'the tool schemas count');
  const call = [{ id: 'c1', function: { name: 'read_page', arguments: '{}' } }];
  assert.ok(estimatePromptTokens([{ role: 'assistant', content: '', tool_calls: call }]) > 0, 'a replayed tool call counts');
});

test('a /models entry names its window in context_length, max_model_len, context_window, max_context_length or top_provider', () => {
  assert.equal(contextLengthOf({ id: 'a', context_length: 128000 }), 128000);
  assert.equal(contextLengthOf({ id: 'b', max_model_len: 32768 }), 32768);
  assert.equal(contextLengthOf({ id: 'c', context_window: 131072 }), 131072);
  assert.equal(contextLengthOf({ id: 'd', max_context_length: 8192 }), 8192);
  assert.equal(contextLengthOf({ id: 'e', top_provider: { context_length: 200000 } }), 200000);
  assert.equal(contextLengthOf({ id: 'f' }), null);
  assert.equal(contextLengthOf({ id: 'g', context_length: 'lots' }), null);
  assert.equal(contextLengthOf(null), null);
});
