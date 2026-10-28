import test from 'node:test';
import assert from 'node:assert/strict';
import { checkWebUrl } from '../../src/background/research/urlPolicy.ts';

test('checkWebUrl accepts http and https addresses, parsed', () => {
  const ok = checkWebUrl(' https://ollama.com/install.sh ');
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && ok.url.hostname, 'ollama.com');
  assert.equal(checkWebUrl('http://127.0.0.1:8765/research/search').ok, true, 'local addresses are allowed (documented limit)');
});

test('checkWebUrl refuses every other scheme, read from the parsed URL', () => {
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hi', 'chrome://settings', 'ftp://x.org/a', 'blob:https://x.org/1', ' JAVASCRIPT:alert(1)']) {
    const r = checkWebUrl(bad);
    assert.equal(r.ok, false, bad);
    assert.match(!r.ok ? r.error : '', /only http and https/);
  }
});

test('checkWebUrl refuses an empty value, a relative path and an address with credentials', () => {
  assert.match((checkWebUrl('') as any).error, /empty/);
  assert.match((checkWebUrl(undefined) as any).error, /empty/);
  assert.match((checkWebUrl('/install.sh') as any).error, /not a full URL/);
  assert.match((checkWebUrl('https://user:pw@example.com/') as any).error, /user name or password/);
  assert.match((checkWebUrl('https://user@example.com/') as any).error, /user name or password/);
});
