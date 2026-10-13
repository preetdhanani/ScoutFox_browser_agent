import test from 'node:test';
import assert from 'node:assert/strict';
import { NetworkBuffers, formatNetworkLine } from '../../src/background/browser/network.ts';

test('NetworkBuffers: records and enforces capacity cap', () => {
  const buffers = new NetworkBuffers(5);
  for (let i = 1; i <= 7; i++) {
    buffers.record(101, { method: 'GET', url: `https://example.com/api/${i}`, ok: true, status: 200 });
  }

  const entries = buffers.get(101);
  assert.ok(entries);
  assert.equal(entries.length, 5);
  // Oldest entries 1 and 2 should have been shifted out
  assert.equal(entries[0].url, 'https://example.com/api/3');
  assert.equal(entries[4].url, 'https://example.com/api/7');
});

test('NetworkBuffers: ignores falsy tabId or request', () => {
  const buffers = new NetworkBuffers(10);
  buffers.record(0, { method: 'GET', url: 'https://example.com' });
  assert.equal(buffers.has(0), false);
  buffers.record(101, null as any);
  assert.equal(buffers.has(101), false);
});

test('NetworkBuffers: delete, has, set, and clear management', () => {
  const buffers = new NetworkBuffers(10);
  assert.equal(buffers.has(101), false);

  buffers.record(101, { method: 'GET', url: 'https://example.com' });
  assert.equal(buffers.has(101), true);

  buffers.set(102, [{ method: 'POST', url: 'https://example.com/submit' }]);
  assert.equal(buffers.has(102), true);

  buffers.delete(101);
  assert.equal(buffers.has(101), false);
  assert.equal(buffers.has(102), true);

  buffers.clear();
  assert.equal(buffers.has(102), false);
});

test('NetworkBuffers.read: returns empty fallback string when no matches', () => {
  const buffers = new NetworkBuffers(10);
  assert.equal(buffers.read(101), '(No network requests captured matching filter criteria)');

  buffers.record(101, { method: 'GET', url: 'https://example.com', ok: true, status: 200 });
  assert.equal(
    buffers.read(101, { status: 'error' }),
    '(No network requests captured matching filter criteria)'
  );
});

test('NetworkBuffers.read: status filtering (error vs success vs all)', () => {
  const buffers = new NetworkBuffers(10);
  buffers.record(101, { method: 'GET', url: 'https://example.com/ok', ok: true, status: 200, durationMs: 15 });
  buffers.record(101, { method: 'POST', url: 'https://example.com/err1', ok: false, status: 500, durationMs: 40 });
  buffers.record(101, { method: 'GET', url: 'https://example.com/err2', ok: false, status: 404, error: 'Not Found', durationMs: 25 });

  const errorText = buffers.read(101, { status: 'error' });
  assert.match(errorText, /example\.com\/err1/);
  assert.match(errorText, /example\.com\/err2/);
  assert.doesNotMatch(errorText, /example\.com\/ok/);

  const successText = buffers.read(101, { status: 'success' });
  assert.match(successText, /example\.com\/ok/);
  assert.doesNotMatch(successText, /example\.com\/err1/);
  assert.doesNotMatch(successText, /example\.com\/err2/);
});

test('NetworkBuffers.read: urlContains case-insensitive substring search', () => {
  const buffers = new NetworkBuffers(10);
  buffers.record(101, { method: 'GET', url: 'https://api.example.com/USERS/1', ok: true, status: 200 });
  buffers.record(101, { method: 'GET', url: 'https://api.example.com/products/2', ok: true, status: 200 });

  const res = buffers.read(101, { urlContains: 'users' });
  assert.match(res, /USERS\/1/);
  assert.doesNotMatch(res, /products/);
});

test('NetworkBuffers.read: since: last_action isolates system actions between model actions', () => {
  const buffers = new NetworkBuffers(20);

  // Model action 1
  buffers.record(101, { method: 'GET', url: 'https://example.com/step1' }, 'boot:1');
  // Model action 2
  buffers.record(101, { method: 'POST', url: 'https://example.com/step2' }, 'boot:2');
  // System action between model actions (e.g. reload or ladder navigation)
  buffers.record(101, { method: 'GET', url: 'https://example.com/sys-reload' }, 'sys:1');

  // Reading since: last_action should target the most recent model marker ('boot:2') and ignore 'sys:1'
  const res = buffers.read(101, { since: 'last_action' });
  assert.match(res, /example\.com\/step2/);
  assert.doesNotMatch(res, /example\.com\/step1/);
  assert.doesNotMatch(res, /example\.com\/sys-reload/);
});

test('NetworkBuffers.read: respects explicit lastMarker if provided', () => {
  const buffers = new NetworkBuffers(20);
  buffers.record(101, { method: 'GET', url: 'https://example.com/a' }, 'action:A');
  buffers.record(101, { method: 'GET', url: 'https://example.com/b' }, 'action:B');

  const res = buffers.read(101, { since: 'last_action' }, true, 10, 'action:A');
  assert.match(res, /example\.com\/a/);
  assert.doesNotMatch(res, /example\.com\/b/);
});

test('NetworkBuffers.read: limits results and caps at 50', () => {
  const buffers = new NetworkBuffers(100);
  for (let i = 1; i <= 60; i++) {
    buffers.record(101, { method: 'GET', url: `https://example.com/${i}`, ok: true, status: 200 });
  }

  // Limit 5 returns last 5
  const res5 = buffers.read(101, {}, true, 5);
  const lines5 = res5.split('\n\n');
  assert.equal(lines5.length, 5);
  assert.match(lines5[lines5.length - 1], /example\.com\/60/);

  // Limit 100 is capped at 50
  const resAll = buffers.read(101, {}, true, 100);
  const linesAll = resAll.split('\n\n');
  assert.equal(linesAll.length, 50);
});

test('formatNetworkLine: truncates long URL at 80 characters with ellipses', () => {
  const longUrl = 'https://example.com/very/long/path/that/exceeds/eighty/characters/in/total/length/to/test/truncation/properly';
  const formatted = formatNetworkLine({ method: 'GET', url: longUrl, status: 200, durationMs: 10 }, false);

  assert.ok(formatted.includes('...'));
  assert.match(formatted, /^\[GET\] https:\/\/example\.com\/very\/long\/path\/that\/exceeds\/eighty\/characters\/in\/total\/lengt\.\.\. → 200 \(10ms\)$/);
});

test('formatNetworkLine: redacts sensitive keys in request and response bodies', () => {
  const req = {
    method: 'POST',
    url: 'https://example.com/login',
    status: 200,
    durationMs: 80,
    reqBody: JSON.stringify({ username: 'prit', password: 'secretPassword123' }),
    respBody: JSON.stringify({ token: 'jwt-token-xyz', user: 'prit' })
  };

  const formatted = formatNetworkLine(req, true);
  assert.match(formatted, /"username":"prit"/);
  assert.match(formatted, /"password":"\[REDACTED\]"/);
  assert.doesNotMatch(formatted, /secretPassword123/);
  assert.match(formatted, /"token":"\[REDACTED\]"/);
  assert.doesNotMatch(formatted, /jwt-token-xyz/);
});

test('formatNetworkLine: truncates body exceeding 500 characters', () => {
  const largeBody = 'A'.repeat(600);
  const req = {
    method: 'POST',
    url: 'https://example.com/data',
    status: 200,
    durationMs: 50,
    reqBody: largeBody
  };

  const formatted = formatNetworkLine(req, true);
  assert.ok(formatted.includes('...'));
  const bodyLine = formatted.split('\n').find((l) => l.startsWith('  req:'));
  assert.ok(bodyLine);
  // '  req:  ' + 500 chars + '...' = 511 chars
  assert.ok(bodyLine.length <= 515);
});

test('formatNetworkLine: safely handles null, undefined, and circular bodies without throwing', () => {
  const circular: any = { a: 1 };
  circular.self = circular;

  const reqWithCircular = {
    method: 'POST',
    url: 'https://example.com/circular',
    reqBody: circular,
    respBody: null
  };
  const formattedCircular = formatNetworkLine(reqWithCircular, true);
  assert.match(formattedCircular, /example\.com\/circular/);

  const reqWithNull = {
    method: 'GET',
    url: 'https://example.com/null',
    reqBody: null,
    respBody: undefined
  };
  const formattedNull = formatNetworkLine(reqWithNull, true);
  assert.match(formattedNull, /example\.com\/null/);
});

test('NetworkBuffers.read: since last_action with only sys-stamped entries returns them (BUG-32)', () => {
  const buffers = new NetworkBuffers(20);
  // Only system-stamped and unmarked entries - no model-marker entry exists.
  buffers.record(101, { method: 'GET', url: 'https://example.com/sys-check', ok: false, status: 500, error: 'Server error' }, 'sys:1');
  buffers.record(101, { method: 'GET', url: 'https://example.com/unmarked', ok: false, status: 502, error: 'Bad gateway' });

  // Pre-fix this read answered "(No network requests captured matching filter
  // criteria)" because the dead actionMarkerIndex fallback filtered everything
  // out - the guardrail then told the model there were no network errors.
  const res = buffers.read(101, { status: 'error', since: 'last_action' });
  assert.match(res, /example\.com\/sys-check/);
  assert.match(res, /example\.com\/unmarked/);
  assert.doesNotMatch(res, /No network requests captured/);
});
