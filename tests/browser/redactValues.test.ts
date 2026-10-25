import test from 'node:test';
import assert from 'node:assert/strict';
import { redactSensitiveData, redactObject, redactUrl } from '../../src/background/browser/redact.ts';
import { formatNetworkLine, NetworkBuffers } from '../../src/background/browser/network.ts';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sFlKxyz';

test('a JSON string still gets value-level redaction (JWT and key=value inside values)', () => {
  const out = redactSensitiveData(JSON.stringify({ access: JWT, body: 'password=hunter2&user=bob' }));
  assert.doesNotMatch(out, /eyJhbGciOi/);
  assert.doesNotMatch(out, /hunter2/);
  const parsed = JSON.parse(out);
  assert.match(parsed.body, /user=bob/, 'neighbouring pairs survive');
});

test('an object gets value-level redaction on every string leaf, nested and in arrays', () => {
  const out = redactSensitiveData({
    headers: 'Authorization: Bearer abc123',
    nested: { log: ['ok', `Bearer ${JWT}`], note: 'plain text' }
  }) as any;
  assert.doesNotMatch(JSON.stringify(out), /abc123|eyJhbGciOi/);
  assert.equal(out.nested.log[0], 'ok');
  assert.equal(out.nested.note, 'plain text');
});

test('redactObject also redacts string leaves without mutating the input', () => {
  const input = { msg: 'cookie=sid123; theme=dark' };
  const out = redactObject(input);
  assert.doesNotMatch(out.msg, /sid123/);
  assert.match(out.msg, /theme=dark/);
  assert.equal(input.msg, 'cookie=sid123; theme=dark');
});

test('a JSON string literal holding a bearer token is redacted', () => {
  const out = redactSensitiveData(JSON.stringify(`Bearer ${JWT}`));
  assert.doesNotMatch(out, /eyJhbGciOi/);
});

test('redactUrl redacts sensitive query and fragment params and keeps the rest', () => {
  assert.equal(
    redactUrl('https://x.com/a?access_token=sk_live_abc123&page=2'),
    'https://x.com/a?access_token=[REDACTED]&page=2'
  );
  assert.equal(redactUrl('https://x.com/cb#id_token=abc&state=s1'), 'https://x.com/cb#id_token=[REDACTED]&state=s1');
  assert.equal(redactUrl('https://x.com/a?api-key=k1&sig=zz&code=c0de'), 'https://x.com/a?api-key=[REDACTED]&sig=[REDACTED]&code=[REDACTED]');
  assert.equal(redactUrl('https://x.com/search?q=laptop&keyword=card+game'), 'https://x.com/search?q=laptop&keyword=card+game');
  assert.equal(redactUrl('https://x.com/plain'), 'https://x.com/plain');
});

test('formatNetworkLine never prints a secret from the URL query', () => {
  const line = formatNetworkLine({ method: 'GET', url: 'https://x.com/a?access_token=sk_live_abc123', status: 200 });
  assert.doesNotMatch(line, /sk_live_abc123/);
  assert.match(line, /access_token=\[REDACTED\]/);
  const buffers = new NetworkBuffers();
  buffers.record(7, { method: 'POST', url: 'https://x.com/login?token=t0ps3cret', status: 200, ok: true, respBody: { access: JWT } });
  const text = buffers.read(7);
  assert.doesNotMatch(text, /t0ps3cret|eyJhbGciOi/);
});
