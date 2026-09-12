/**
 * Regression test: redactSensitiveData() already strips password/token/cookie/apikey/etc.
 * fields out of network request bodies (readNetworkRequests) - but execute_js can return the
 * exact same shape of data (the model can ask it to read a form, a config object, page
 * cookies) and never went through the same redaction before landing in history and the next
 * LLM prompt.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

global.chrome = {
  storage: { local: { get: (keys, cb) => cb({}), set: (data, cb) => cb && cb() } },
  tabs: { get: (id, cb) => cb({ id, groupId: -1, url: 'https://example.com' }), query: async () => [] },
  scripting: { executeScript: async () => [{ result: undefined }] } // overridden per test
};

const { AgentEngine } = await import('../background/agentEngine.js');

function stubExecuteScript(result) {
  global.chrome.scripting.executeScript = async () => [{ result }];
}

test('execute_js redacts sensitive keys in an object result, same as network bodies', async () => {
  const engine = new AgentEngine();
  stubExecuteScript({ username: 'prit', password: 'hunter2', apiKey: 'sk-live-123' });

  const res = await engine.executeJs(101, 'return {username: "prit", password: "hunter2", apiKey: "sk-live-123"}');

  assert.equal(res.ok, true);
  assert.match(res.result, /"username":"prit"/);
  assert.doesNotMatch(res.result, /hunter2/, 'password value must not survive into history/LLM context');
  assert.doesNotMatch(res.result, /sk-live-123/, 'apiKey value must not survive either');
  assert.match(res.result, /\[REDACTED\]/);
});

test('execute_js leaves an ordinary, non-sensitive object result untouched', async () => {
  const engine = new AgentEngine();
  stubExecuteScript({ title: 'Product Page', price: 42 });

  const res = await engine.executeJs(101, 'return {title: "Product Page", price: 42}');

  assert.match(res.result, /"title":"Product Page"/);
  assert.match(res.result, /"price":42/);
});

test('execute_js returning a bare string or number is passed through unchanged', async () => {
  const engine = new AgentEngine();
  stubExecuteScript(42);
  const numRes = await engine.executeJs(101, 'return 42');
  assert.equal(numRes.result, 42);

  stubExecuteScript('hello world');
  const strRes = await engine.executeJs(101, 'return "hello world"');
  assert.equal(strRes.result, 'hello world');
});
