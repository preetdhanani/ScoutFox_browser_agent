/**
 * The key proxy of the smoke run (tests/e2e/lib/keyProxy.mjs) and the real-server profiles behind
 * it (tests/e2e/lib/providers.mjs): the real key is added on the way out and never needed by the
 * extension, the request path is forwarded unchanged, and each chat call is recorded like the other modes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// @ts-ignore - a plain .mjs module of the harness
import { PLACEHOLDER_KEY, asCallRecordReply, startKeyProxy } from '../e2e/lib/keyProxy.mjs';
// @ts-ignore - a plain .mjs module of the harness
import { DEFAULT_PROVIDER, cleanKey, providerSettings, proxiedBaseUrl, resolveProvider } from '../e2e/lib/providers.mjs';

/** A stand-in for an OpenAI-compatible server that remembers the URL and Authorization header it got. */
async function fakeServer(t: any) {
  const seen: Array<{ url: string; auth: string }> = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url || '', auth: String(req.headers.authorization || '') });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ index: 0, message: { role: 'assistant', content: '', tool_calls: [{ id: 'c', type: 'function', function: { name: 'finish', arguments: '{"answer":"ok"}' } }] }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 120, completion_tokens: 8 }
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  t.after(() => server.close());
  return { seen, url: `http://127.0.0.1:${(server.address() as any).port}` };
}

async function chat(url: string) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${PLACEHOLDER_KEY}` },
    body: JSON.stringify({ model: 'm', messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' }], tools: [{ type: 'function', function: { name: 'finish' } }] })
  });
}

test('the proxy replaces the placeholder key with the real one, and records the call', async (t) => {
  const upstream = await fakeServer(t);
  const proxy = await startKeyProxy({ port: 0, target: upstream.url, apiKey: 'real-secret' });
  t.after(() => proxy.server.close());

  const res = await chat(`${proxy.url}/v1/chat/completions`);
  assert.equal(res.status, 200);
  assert.equal(upstream.seen[0].auth, 'Bearer real-secret', 'the server got the real key');
  assert.equal(proxy.calls.length, 1);
  assert.equal(proxy.calls[0].node, 'mcp');
  assert.equal(proxy.calls[0].promptEvalCount, 120);
  assert.equal(proxy.calls[0].evalCount, 8);
  assert.match(proxy.calls[0].content, /finish\(\{"answer":"ok"\}\)/);
});

test('a server mounted under /api keeps its path, and its chat calls are recorded', async (t) => {
  const upstream = await fakeServer(t);
  const proxy = await startKeyProxy({ port: 0, target: upstream.url, apiKey: 'real-secret' });
  t.after(() => proxy.server.close());

  await chat(`${proxy.url}/api/chat/completions`);
  await fetch(`${proxy.url}/api/models`);
  assert.deepEqual(upstream.seen.map((s) => s.url), ['/api/chat/completions', '/api/models']);
  assert.equal(proxy.calls.length, 1, 'only the chat call is a model call');
});

test('the proxy refuses to start without a key or a target', () => {
  assert.throws(() => startKeyProxy({ port: 0, target: 'http://x', apiKey: '', label: 'LISA' }), /needs the LISA API key/);
  assert.throws(() => startKeyProxy({ port: 0, apiKey: 'k' }), /needs the model server address/);
});

test('an error body is recorded as the error text', () => {
  assert.deepEqual(asCallRecordReply({ error: { message: 'bad model' } }), { error: 'bad model' });
});

test('LISA is the default provider: a custom OpenAI endpoint under /api, key from LISA_API', () => {
  assert.equal(DEFAULT_PROVIDER, 'lisa');
  const lisa = resolveProvider('lisa', { LISA_API: ' "lisa-secret" ' });
  assert.equal(lisa.origin, 'https://chat-1.ki-awz.iisys.de');
  assert.equal(lisa.mount, '/api');
  assert.equal(lisa.apiKey, 'lisa-secret', 'quotes and spaces of a .env value are removed');
  assert.equal(lisa.defaultModel, 'lisa-pro');
  assert.deepEqual(lisa.custom, { id: 'lisa', displayName: 'LISA', protocol: 'openai' });
  assert.equal(lisa.builtin, null);
  assert.equal(resolveProvider('lisa', { LISA_API_KEY: 'a', LISA_API: 'b' }).apiKey, 'a', 'the _KEY name wins');
  assert.equal(resolveProvider('lisa', {}).apiKey, '', 'no key is an empty key, for the preflight to name');
});

test('NVIDIA keeps its built-in provider, and a bare NVIDIA_URL origin still gets /v1', () => {
  const nim = resolveProvider('nvidia', { NVIDIA_API: 'nv', NVIDIA_URL: 'https://integrate.api.nvidia.com' });
  assert.equal(nim.builtin, 'nvidia');
  assert.equal(nim.mount, '/v1');
  assert.equal(resolveProvider('nvidia', {}).mount, '/v1');
});

test('an unknown provider or a malformed URL is a clear error', () => {
  assert.throws(() => resolveProvider('nope', {}), /Unknown provider "nope"/);
  assert.throws(() => resolveProvider('lisa', { LISA_URL: 'chat-1/api' }), /LISA_URL is not a full URL/);
});

test('the extension is pointed at the proxy with the server\'s path and only the placeholder key', () => {
  const lisa = resolveProvider('lisa', { LISA_API: 'secret' });
  assert.equal(proxiedBaseUrl(lisa, 'http://127.0.0.1:11435/'), 'http://127.0.0.1:11435/api');
  const descriptor = { id: 'lisa', protocol: 'openai' };
  const custom = providerSettings(lisa, 'http://127.0.0.1:11435', 'lisa-pro', { lisa: descriptor });
  assert.equal(custom.provider, 'lisa');
  assert.deepEqual(custom.customProviders, { lisa: descriptor }, 'the dialog\'s descriptor survives every settings save');
  assert.deepEqual(custom.providerConfigs.lisa, { baseUrl: 'http://127.0.0.1:11435/api', apiKey: PLACEHOLDER_KEY, model: 'lisa-pro' });
  assert.equal(JSON.stringify(custom).includes('secret'), false, 'the real key never reaches the extension');

  const nim = providerSettings(resolveProvider('nvidia', { NVIDIA_API: 'secret' }), 'http://127.0.0.1:11435', 'n');
  assert.equal(nim.provider, 'nvidia');
  assert.equal(nim.providerConfigs.nvidia.baseUrl, 'http://127.0.0.1:11435/v1');
  assert.equal(nim.providerConfigs.nvidia.llmTimeoutMs, 120000);
  assert.equal('customProviders' in nim, false);
});

test('cleanKey strips quotes and a Bearer prefix', () => {
  assert.equal(cleanKey("'Bearer abc' "), 'abc');
  assert.equal(cleanKey(undefined), '');
});
