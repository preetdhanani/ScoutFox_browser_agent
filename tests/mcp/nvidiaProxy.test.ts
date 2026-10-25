/**
 * The NVIDIA proxy of the smoke run (tests/e2e/lib/nvidiaProxy.mjs): the real key is added on the
 * way out and never needed by the extension, and each chat call is recorded like the other modes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// @ts-ignore - a plain .mjs module of the harness
import { NVIDIA_PLACEHOLDER_KEY, asCallRecordReply, startNvidiaProxy } from '../e2e/lib/nvidiaProxy.mjs';

/** A stand-in for NIM that remembers the Authorization header it got. */
async function fakeNim(t: any) {
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

test('the proxy replaces the placeholder key with the real one, and records the call', async (t) => {
  const nim = await fakeNim(t);
  const proxy = await startNvidiaProxy({ port: 0, target: nim.url, apiKey: 'nvapi-real-secret' });
  t.after(() => proxy.server.close());

  const res = await fetch(`${proxy.url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${NVIDIA_PLACEHOLDER_KEY}` },
    body: JSON.stringify({ model: 'nvidia/nemotron-3.5-super-vl-120b-a12b', messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' }], tools: [{ type: 'function', function: { name: 'finish' } }] })
  });
  assert.equal(res.status, 200);
  assert.equal(nim.seen[0].auth, 'Bearer nvapi-real-secret', 'NIM got the real key');
  assert.equal(proxy.calls.length, 1);
  assert.equal(proxy.calls[0].node, 'mcp');
  assert.equal(proxy.calls[0].promptEvalCount, 120);
  assert.equal(proxy.calls[0].evalCount, 8);
  assert.match(proxy.calls[0].content, /finish\(\{"answer":"ok"\}\)/);
});

test('the proxy refuses to start without a key', () => {
  assert.throws(() => startNvidiaProxy({ port: 0, apiKey: '' }), /needs the NVIDIA API key/);
});

test('an error body is recorded as the error text', () => {
  assert.deepEqual(asCallRecordReply({ error: { message: 'bad model' } }), { error: 'bad model' });
});
