import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SENSITIVE_KEYS,
  redactObject,
  redactSensitiveData
} from '../../src/background/browser/redact.ts';

test('SENSITIVE_KEYS contains expected security and credential keywords', () => {
  const expected = ['password', 'token', 'authorization', 'cookie', 'secret', 'apikey', 'ssn', 'card', 'cvv'];
  for (const key of expected) {
    assert.ok(SENSITIVE_KEYS.includes(key), `expected ${key} in SENSITIVE_KEYS`);
  }
});

test('redactObject redacts sensitive keys without mutating original object', () => {
  const original = {
    username: 'alice',
    password: 'superSecretPassword123',
    apiKey: 'sk-12345',
    profile: {
      auth_token: 'xyz-token',
      bio: 'Regular bio',
      credit_card: '4111222233334444'
    },
    tags: ['admin', 'verified']
  };

  const copy = redactObject(original);

  assert.equal(copy.username, 'alice');
  assert.equal(copy.password, '[REDACTED]');
  assert.equal(copy.apiKey, '[REDACTED]');
  assert.equal(copy.profile.auth_token, '[REDACTED]');
  assert.equal(copy.profile.bio, 'Regular bio');
  assert.equal(copy.profile.credit_card, '[REDACTED]');
  assert.deepEqual(copy.tags, ['admin', 'verified']);

  // Immutability check
  assert.equal(original.password, 'superSecretPassword123');
  assert.equal(original.profile.auth_token, 'xyz-token');
});

test('redactObject handles arrays and non-object inputs', () => {
  assert.equal(redactObject(null as any), null);
  assert.equal(redactObject(undefined as any), undefined);
  assert.equal(redactObject(123 as any), 123);
  assert.equal(redactObject('hello' as any), 'hello');

  const arrayInput = [
    { password: 'secret1', id: 1 },
    { user: 'bob', token: 'secret2' }
  ];
  const redactedArray = redactObject(arrayInput);
  assert.deepEqual(redactedArray, [
    { password: '[REDACTED]', id: 1 },
    { user: 'bob', token: '[REDACTED]' }
  ]);
});

test('redactSensitiveData correctly redacts valid JSON strings', () => {
  const jsonStr = JSON.stringify({
    user: 'bob',
    password: 'secretPassword',
    details: {
      secret_code: '42'
    }
  });

  const redacted = redactSensitiveData(jsonStr);
  const parsed = JSON.parse(redacted);

  assert.equal(parsed.user, 'bob');
  assert.equal(parsed.password, '[REDACTED]');
  assert.equal(parsed.details.secret_code, '[REDACTED]');
});

test('redactSensitiveData redacts raw text via regex when not valid JSON', () => {
  const rawText = 'HTTP Header:\n"authorization": "Bearer token123"\n"password": "pass456"';
  const redacted = redactSensitiveData(rawText);

  assert.match(redacted, /"authorization":\s*"\[REDACTED\]"/);
  assert.match(redacted, /"password":\s*"\[REDACTED\]"/);
  assert.doesNotMatch(redacted, /token123/);
  assert.doesNotMatch(redacted, /pass456/);
});

test('redactSensitiveData passes through falsy inputs unchanged', () => {
  assert.equal(redactSensitiveData(''), '');
  assert.equal(redactSensitiveData(null), null);
  assert.equal(redactSensitiveData(undefined), undefined);
  assert.equal(redactSensitiveData(0), 0);
  assert.equal(redactSensitiveData(false), false);
});

test('redactSensitiveData redacts non-JSON secret strings (BUG-22)', () => {
  // Form-encoded POST body.
  const form = redactSensitiveData('username=a&password=hunter2&submit=1');
  assert.doesNotMatch(form, /hunter2/);
  assert.match(form, /password=\[REDACTED\]/);
  assert.match(form, /username=a/, 'neighbouring pairs survive');

  // Cookie string with semicolon separators.
  const cookie = redactSensitiveData('sid=abc; csrftoken=xyz; theme=dark');
  assert.doesNotMatch(cookie, /xyz/);
  assert.match(cookie, /csrftoken=\[REDACTED\]/);
  assert.match(cookie, /sid=abc/, 'non-sensitive keys survive');
  assert.match(cookie, /theme=dark/, 'later pairs survive');

  // Bearer / JWT header text: the authorization key redacts its whole value,
  // and a bare bearer token is caught by the dedicated pattern.
  const bearer = redactSensitiveData('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sFlK');
  assert.doesNotMatch(bearer, /eyJhbGciOi/);
  assert.match(bearer, /Authorization: \[REDACTED\]/);
  const bareBearer = redactSensitiveData('token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sFlK from the log');
  assert.doesNotMatch(bareBearer, /eyJhbGciOi/);

  // Single-quoted JSON (fails JSON.parse, must still redact).
  const single = redactSensitiveData("{'password':'topsecret','user':'bob'}");
  assert.doesNotMatch(single, /topsecret/);
  assert.match(single, /bob/);

  // api_key with underscore separator.
  const apiKey = redactSensitiveData('api_key=sk-1234567890abcdef&x=1');
  assert.doesNotMatch(apiKey, /sk-1234567890abcdef/);

  // Innocent text is untouched.
  const innocent = redactSensitiveData('The token count is 42 and the card layout is grid');
  assert.equal(innocent, 'The token count is 42 and the card layout is grid');
});
