/**
 * A user-added endpoint is a provider: the factory builds its client from the descriptor's
 * protocol and base URL, and the headers it sends are the ones its dialect dictates (featere/
 * custom-endpoint). Captured with a fetch spy through the real LangChain clients, exactly like
 * providers.test.ts does for the built-ins; the URL rules behind the paths are pinned in
 * customUrls.test.ts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateCompletion } from '../../src/background/llm/index.ts';
import type { LlmSettings } from '../../src/background/llm/types.ts';
import { spyFetch, textReply } from '../helpers/llmWire.ts';
import { customChatUrl } from '../../src/background/llm/settings.ts';
import type { CustomProvider } from '../../src/shared/storage.ts';

const TURNS = [
  { role: 'user', content: 'hello' },
  { role: 'assistant', content: 'prev' },
  { role: 'user', content: 'next' }
];

const DESCRIPTOR: CustomProvider = {
  id: 'acme-gateway',
  displayName: 'Acme Gateway',
  protocol: 'openai',
  baseUrl: 'https://gateway.example/v1',
  models: ['acme-large', 'acme-small'],
  keyMode: 'apiKey',
  createdAt: 1,
  updatedAt: 1
};

const openaiSettings = (over: Partial<LlmSettings> = {}): LlmSettings => ({
  provider: 'acme-gateway',
  baseUrl: 'https://gateway.example/v1',
  model: 'acme-large',
  customProviders: { 'acme-gateway': { ...DESCRIPTOR } },
  ...over
} as LlmSettings);

const anthropicDescriptor = { ...DESCRIPTOR, id: 'claude-relay', protocol: 'anthropic', baseUrl: 'https://relay.example' };
const anthropicSettings = (over: Partial<LlmSettings> = {}): LlmSettings => ({
  provider: 'claude-relay',
  baseUrl: 'https://relay.example',
  model: 'acme-large',
  customProviders: { 'claude-relay': anthropicDescriptor },
  ...over
} as LlmSettings);

test('openai dialect: the chat call goes to the descriptor URL with the model of the run', async (t) => {
  const sent = spyFetch(t);
  await generateCompletion(openaiSettings(), TURNS, 'SYS');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, customChatUrl('openai', 'https://gateway.example/v1'));
  assert.equal(sent[0].body.model, 'acme-large');
  assert.equal(sent[0].body.messages.length, 4, 'system plus three turns');
  assert.equal(sent[0].body.messages[0].content, 'SYS');
});

test('openai dialect: the key rides in the Authorization header, cleaned like any credential', async (t) => {
  const sent = spyFetch(t);
  await generateCompletion(openaiSettings({ apiKey: '  Bearer sk-live-1  ' }), TURNS, 'SYS');
  assert.equal(sent[0].headers.authorization, 'Bearer sk-live-1', 'the pasted Bearer prefix is not doubled, the quotes are gone');

  const keyless = spyFetch(t);
  await generateCompletion(openaiSettings({ apiKey: '' }), TURNS, 'SYS');
  assert.equal(keyless[0].headers.authorization, undefined, 'a keyless endpoint sends no Authorization header at all');
});

test('anthropic dialect: the chat call goes to /v1/messages with x-api-key, and no Authorization header', async (t) => {
  const sent = spyFetch(t);
  await generateCompletion(anthropicSettings({ apiKey: 'sk-relay-1' }), TURNS, 'SYS');
  assert.equal(sent[0].url, 'https://relay.example/v1/messages');
  assert.equal(sent[0].headers['x-api-key'], 'sk-relay-1');
  assert.equal(sent[0].headers.authorization, undefined, 'Anthropic does not use the Authorization header');
  assert.ok(sent[0].headers['anthropic-version'], 'the version header is sent, as for the built-in Anthropic');
  assert.equal(sent[0].body.model, 'acme-large');
});

test('anthropic dialect: a keyless relay sends no credential header at all', async (t) => {
  const sent = spyFetch(t);
  await generateCompletion(anthropicSettings({ apiKey: '' }), TURNS, 'SYS');
  assert.equal(sent[0].headers['x-api-key'], undefined);
  assert.equal(sent[0].headers.authorization, undefined);
});

test('the descriptor beats the top-level baseUrl: a provider keeps its own URL even when the form holds another', async (t) => {
  const sent = spyFetch(t);
  await generateCompletion(openaiSettings({ baseUrl: 'https://somewhere-else.example/v9' }), TURNS, 'SYS');
  assert.equal(sent[0].url, 'https://gateway.example/v1/chat/completions');
});

test('errors name the provider, the URL host, and carry the server text with the key scrubbed (B1, B3)', async (t) => {
  const auth = spyFetch(t, () => new Response(JSON.stringify({ error: { message: 'bad key sk-live-1' } }), { status: 401, headers: { 'content-type': 'application/json' } }));
  const err401 = await generateCompletion(openaiSettings({ apiKey: 'sk-live-1' }), TURNS, 'SYS').then(() => null, (e: Error) => e);
  assert.ok(err401, 'a 401 rejects the call');
  assert.match(err401!.message, /Acme Gateway/, 'the provider is named by its display name');
  assert.match(err401!.message, /401/, 'the HTTP status is in the error');
  assert.match(err401!.message, /gateway\.example/, 'the host is in the error, so the user knows which endpoint');
  assert.ok(!err401!.message.includes('sk-live-1'), 'the key is scrubbed out of what reaches the screen');
  assert.equal(auth.length, 1);

  const dns = spyFetch(t, () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND gateway.invalid'), { code: 'ENOTFOUND' }); });
  const errDns = await generateCompletion(openaiSettings(), TURNS, 'SYS').then(() => null, (e: Error) => e);
  assert.ok(errDns);
  assert.match(errDns!.message, /unreachable|refused|ENOTFOUND|network/i, 'a connection failure says the endpoint could not be reached, not "invalid API key"');
  assert.equal(dns.length, 1);
});

test('a timeout of the custom endpoint is a timeout, not an auth failure', async (t) => {
  // A short per-provider deadline; the fake endpoint honors the abort signal the way a real
  // connection does (it stops when the client hangs up), so nothing is left pending.
  const sent = spyFetch(t, (request) => new Promise<Response>((_resolve, reject) => {
    request.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')), { once: true });
  }));
  const err = await generateCompletion(openaiSettings({ llmTimeoutMs: 400 }), TURNS, 'SYS').then(() => null, (e: Error) => e);
  assert.ok(err, 'the call fails');
  assert.match(err!.message, /did not respond|timeout/i);
  assert.match(err!.message, /\(the global timeout setting\)/, 'the message says where the timeout came from (B3.3)');
  assert.ok(!err!.message.includes('401'), 'a timeout is not reported as an auth problem');
  assert.equal(sent.length >= 1, true);
});

test('an id nobody knows is unsupported, and a descriptor with an unusable URL fails with the fix named (B1)', async (t) => {
  // No descriptor and no built-in: the honest answer is that this provider does not exist here,
  // never a silent substitution of another provider's client.
  const ghost = await generateCompletion({ provider: 'ghost-endpoint', model: 'm' } as LlmSettings, TURNS, 'SYS').then(() => null, (e: Error) => e);
  assert.ok(ghost);
  assert.match(ghost!.message, /Unsupported LLM provider: ghost-endpoint/);

  // A saved descriptor whose URL stopped being usable: the failure names the provider and the fix.
  const broken = await generateCompletion(openaiSettings({ baseUrl: '' , customProviders: { 'acme-gateway': { ...DESCRIPTOR, baseUrl: '' } } }), TURNS, 'SYS').then(() => null, (e: Error) => e);
  assert.ok(broken);
  assert.match(broken!.message, /unusable base URL/);
  assert.match(broken!.message, /Acme Gateway/);
});

test('a custom endpoint with no model selected fails before any request (the start-button guard mirrors this)', async (t) => {
  const err = await generateCompletion(openaiSettings({ model: '' }), TURNS, 'SYS').then(() => null, (e: Error) => e);
  assert.ok(err);
  assert.match(err!.message, /No model is selected for Acme Gateway/);
  const sent = spyFetch(t);
  await generateCompletion(openaiSettings({ model: '' }), TURNS, 'SYS').catch(() => {});
  assert.equal(sent.length, 0, 'nothing was sent');
});

test('a descriptor with an unknown protocol is disabled with a pointer at Edit, never guessed into a client (A5.4)', async (t) => {
  const sent = spyFetch(t);
  const weird = openaiSettings({ customProviders: { 'acme-gateway': { ...DESCRIPTOR, protocol: 'grpc' as CustomProvider['protocol'] } } });
  const err = await generateCompletion(weird, TURNS, 'SYS').then(() => null, (e: Error) => e);
  assert.ok(err);
  assert.match(err!.message, /unknown API protocol \(grpc\)/);
  assert.match(err!.message, /Edit provider/);
  assert.equal(sent.length, 0, 'nothing was sent to the endpoint');
});

test('a redirect that stays on the endpoint origin is followed; one that leaves it is refused (C2)', async (t) => {
  // The spy answers the first request with a constructed 302; the watcher reads the Location
  // header and either follows it (second request, answered ok) or refuses it.
  let hops = 0;
  const followed = spyFetch(t, (request) => {
    hops++;
    if (hops === 1) return new Response(null, { status: 302, headers: { location: 'https://gateway.example/v1/chat/completions?hop=2' } });
    return textReply(request.url, 'redirected ok');
  });
  const out = await generateCompletion(openaiSettings(), TURNS, 'SYS');
  assert.equal(hops, 2, 'the same-origin hop was followed');
  assert.equal(out, 'redirected ok');

  hops = 0;
  const refused = spyFetch(t, () => {
    hops++;
    return new Response(null, { status: 302, headers: { location: 'https://evil.example/v1/chat/completions' } });
  });
  const err = await generateCompletion(openaiSettings(), TURNS, 'SYS').then(() => null, (e: Error) => e);
  assert.ok(err, 'the cross-origin hop was refused');
  assert.match(err!.message, /redirected to evil\.example, which is not gateway\.example/);
  assert.equal(hops, 1, 'the redirect was not followed');
  assert.equal(refused.length, 1, 'and no second request left');

  // The Anthropic dialect refuses the same way.
  let anthropicHops = 0;
  spyFetch(t, () => {
    anthropicHops++;
    return new Response(null, { status: 302, headers: { location: 'https://evil.example/v1/messages' } });
  });
  const anthropicErr = await generateCompletion(anthropicSettings(), TURNS, 'SYS').then(() => null, (e: Error) => e);
  assert.ok(anthropicErr);
  assert.match(anthropicErr!.message, /redirected to evil\.example, which is not relay\.example/);
  assert.equal(anthropicHops, 1);
});

test('a request to provider A carries no key stored under provider B (C4)', async (t) => {
  const second = { ...DESCRIPTOR, id: 'other-relay', baseUrl: 'https://other.example/v1' };
  const both: LlmSettings = {
    provider: 'acme-gateway',
    baseUrl: 'https://gateway.example/v1',
    model: 'acme-large',
    apiKey: 'sk-of-a',
    providerConfigs: { 'other-relay': { apiKey: 'sk-of-b' } },
    customProviders: { 'acme-gateway': { ...DESCRIPTOR }, 'other-relay': second }
  } as LlmSettings;
  const sent = spyFetch(t);
  await generateCompletion(both, TURNS, 'SYS');
  assert.equal(sent[0].headers.authorization, 'Bearer sk-of-a');
  assert.ok(!JSON.stringify(sent[0].headers).includes('sk-of-b'), 'the other provider\'s key appears nowhere');
});

test('the timeout message names the effective value and where it came from (B3.3)', async (t) => {
  spyFetch(t, (request) => new Promise<Response>((_resolve, reject) => {
    request.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')), { once: true });
  }));
  // The descriptor's own llmTimeoutMs wins over a much larger global value, and the message says so.
  const descriptorTimed = openaiSettings({
    llmTimeoutMs: 60000,
    customProviders: { 'acme-gateway': { ...DESCRIPTOR, llmTimeoutMs: 400 } }
  });
  const err = await generateCompletion(descriptorTimed, TURNS, 'SYS').then(() => null, (e: Error) => e);
  assert.ok(err, 'the per-provider deadline fired despite the larger global value');
  assert.match(err!.message, /within 0s \(the provider's own timeout setting\)/);
});
