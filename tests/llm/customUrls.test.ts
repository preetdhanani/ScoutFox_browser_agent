/**
 * customUrls.test.ts - the protocol-aware base URL rules of a user-added endpoint.
 *
 * The rules live in llm/settings.ts and are shared by the sender and the form's live preview, so
 * the preview can never disagree with what is sent (the A4 acceptance of featere/custom-endpoint).
 * The table below is the contract: every row is a URL a user could plausibly paste, with the chat
 * and model-list URLs the client must produce for both protocols.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  endpointHostOf,
  endpointOriginOf,
  customChatUrl,
  customModelsUrl,
  normalizeCustomAnthropicBase,
  normalizeCustomOpenaiBase
} from '../../src/background/llm/settings.ts';

/** url | openai chat | openai models | anthropic chat | anthropic models */
const TABLE: Array<[string, string, string, string, string]> = [
  // A bare host gets the conventional /v1 (OpenAI) and /v1/messages (Anthropic SDK).
  ['https://gateway.example', 'https://gateway.example/v1/chat/completions', 'https://gateway.example/v1/models', 'https://gateway.example/v1/messages', 'https://gateway.example/v1/models'],
  // An explicit /v1 is used as it stands, for both protocols.
  ['https://gateway.example/v1', 'https://gateway.example/v1/chat/completions', 'https://gateway.example/v1/models', 'https://gateway.example/v1/messages', 'https://gateway.example/v1/models'],
  // A relay mounted away from the root is respected as typed: no /v1 is invented into its path.
  ['https://relay.example/api/openai', 'https://relay.example/api/openai/chat/completions', 'https://relay.example/api/openai/models', 'https://relay.example/api/openai/v1/messages', 'https://relay.example/api/openai/v1/models'],
  // Users paste the full endpoint; the known trailing paths are stripped.
  ['https://gateway.example/v1/chat/completions', 'https://gateway.example/v1/chat/completions', 'https://gateway.example/v1/models', 'https://gateway.example/v1/messages', 'https://gateway.example/v1/models'],
  ['https://gateway.example/v1/models', 'https://gateway.example/v1/chat/completions', 'https://gateway.example/v1/models', 'https://gateway.example/v1/messages', 'https://gateway.example/v1/models'],
  ['https://gateway.example/v1/messages', 'https://gateway.example/v1/chat/completions', 'https://gateway.example/v1/models', 'https://gateway.example/v1/messages', 'https://gateway.example/v1/models'],
  // Trailing slashes never reach the request.
  ['https://gateway.example/v1/', 'https://gateway.example/v1/chat/completions', 'https://gateway.example/v1/models', 'https://gateway.example/v1/messages', 'https://gateway.example/v1/models'],
  ['https://gateway.example//', 'https://gateway.example/v1/chat/completions', 'https://gateway.example/v1/models', 'https://gateway.example/v1/messages', 'https://gateway.example/v1/models'],
  // A non-v1 version segment is kept (a server that serves /v2).
  ['https://gateway.example/v2', 'https://gateway.example/v2/chat/completions', 'https://gateway.example/v2/models', 'https://gateway.example/v2/v1/messages', 'https://gateway.example/v2/v1/models'],
  // A port survives everywhere.
  ['http://localhost:8000', 'http://localhost:8000/v1/chat/completions', 'http://localhost:8000/v1/models', 'http://localhost:8000/v1/messages', 'http://localhost:8000/v1/models'],
  // The Anthropic base keeps a custom mount and loses the /v1 the SDK would double.
  ['https://relay.example/api/claude/v1', 'https://relay.example/api/claude/v1/chat/completions', 'https://relay.example/api/claude/v1/models', 'https://relay.example/api/claude/v1/messages', 'https://relay.example/api/claude/v1/models'],
  ['https://relay.example/v1/messages', 'https://relay.example/v1/chat/completions', 'https://relay.example/v1/models', 'https://relay.example/v1/messages', 'https://relay.example/v1/models']
];

test('the preview table: chat and model-list URLs per protocol, for both dialects', () => {
  for (const [input, openaiChat, openaiModels, anthropicChat, anthropicModels] of TABLE) {
    assert.equal(customChatUrl('openai', input), openaiChat, `openai chat of ${input}`);
    assert.equal(customModelsUrl('openai', input), openaiModels, `openai models of ${input}`);
    assert.equal(customChatUrl('anthropic', input), anthropicChat, `anthropic chat of ${input}`);
    assert.equal(customModelsUrl('anthropic', input), anthropicModels, `anthropic models of ${input}`);
  }
});

test('the preview helpers are the same functions the sender uses, so the preview cannot drift', () => {
  // normalizeCustomOpenaiBase is what the factory hands to ChatOpenAICompletions as baseURL;
  // customChatUrl must be exactly that base plus the path the SDK appends.
  const base = normalizeCustomOpenaiBase('https://relay.example/api/openai');
  assert.equal(customChatUrl('openai', 'https://relay.example/api/openai'), `${base}/chat/completions`);
  const anthropicBase = normalizeCustomAnthropicBase('https://gateway.example/v1');
  assert.equal(customChatUrl('anthropic', 'https://gateway.example/v1'), `${anthropicBase}/v1/messages`);
});

test('endpointOriginOf: the scheme, host and port, or null when the URL does not parse', () => {
  assert.equal(endpointOriginOf('https://gateway.example/v1'), 'https://gateway.example');
  assert.equal(endpointOriginOf('http://localhost:8000/v1'), 'http://localhost:8000');
  assert.equal(endpointOriginOf('https://gateway.example'), 'https://gateway.example');
  assert.equal(endpointOriginOf('not a url'), null);
  assert.equal(endpointOriginOf(''), null);
  assert.equal(endpointOriginOf(undefined), null);
  assert.equal(endpointOriginOf(null), null);
});

test('endpointHostOf: the display-name default, without scheme, with a non-default port', () => {
  assert.equal(endpointHostOf('https://gateway.example/v1'), 'gateway.example');
  assert.equal(endpointHostOf('http://192.168.1.40:8000/v1'), '192.168.1.40:8000');
  assert.equal(endpointHostOf('https://gateway.example:443'), 'gateway.example');
  assert.equal(endpointHostOf('nonsense'), '');
  assert.equal(endpointHostOf(''), '');
});

test('an https endpoint on the default port is not confused with a private http host', () => {
  // describePrivateHttpHost is a sidepanel concern; the storage-layer rule it backs is that only
  // http origins carry the warning. The helpers it builds on keep the two apart.
  assert.equal(endpointOriginOf('https://gateway.example'), endpointOriginOf('https://gateway.example/other/path'));
});
