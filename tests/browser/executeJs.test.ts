import test from 'node:test';
import assert from 'node:assert/strict';
import { executeJs, EXECUTE_JS_TIMEOUT_MS, EXECUTE_JS_RESULT_CAP } from '../../src/background/browser/executeJs.ts';

test('executeJs returns successful execution result and redacts sensitive data', async () => {
  const originalChrome = (globalThis as any).chrome;
  try {
    (globalThis as any).chrome = {
      scripting: {
        executeScript: async (options: any) => {
          assert.equal(options.world, 'MAIN');
          assert.equal(options.target.tabId, 101);
          return [{ result: { __scoutfoxOk: true, value: { username: 'alice', password: 'secretPassword123' } } }];
        }
      }
    };

    const res = await executeJs(101, 'return { username: "alice", password: "secretPassword123" }');
    assert.equal(res.ok, true);
    assert.equal(res.success, true);
    assert.match(res.result, /"username":"alice"/);
    assert.match(res.result, /\[REDACTED\]/);
    assert.doesNotMatch(res.result, /secretPassword123/);
  } finally {
    (globalThis as any).chrome = originalChrome;
  }
});

test('executeJs preserves primitive types and handles null/undefined', async () => {
  const originalChrome = (globalThis as any).chrome;
  try {
    let mockValue: any = 42;
    (globalThis as any).chrome = {
      scripting: {
        executeScript: async () => [{ result: { __scoutfoxOk: true, value: mockValue } }]
      }
    };

    let res = await executeJs(101, 'return 42');
    assert.equal(res.result, 42);

    mockValue = 'plain text';
    res = await executeJs(101, 'return "plain text"');
    assert.equal(res.result, 'plain text');

    mockValue = null;
    res = await executeJs(101, 'return null');
    assert.equal(res.result, 'null');

    mockValue = undefined;
    res = await executeJs(101, 'return undefined');
    assert.equal(res.result, 'undefined');
  } finally {
    (globalThis as any).chrome = originalChrome;
  }
});

test('executeJs serializes Element nodes properly', async () => {
  const originalChrome = (globalThis as any).chrome;
  try {
    const fakeElement = {
      nodeType: 1,
      tagName: 'DIV',
      id: 'main-container',
      className: 'box primary',
      textContent: 'Some text content here'
    };
    (globalThis as any).chrome = {
      scripting: {
        executeScript: async () => [{ result: { __scoutfoxOk: true, value: fakeElement } }]
      }
    };

    const res = await executeJs(101, 'return document.querySelector("div")');
    assert.equal(res.ok, true);
    const parsed = JSON.parse(res.result);
    assert.equal(parsed.tag, 'div');
    assert.equal(parsed.id, 'main-container');
    assert.equal(parsed.className, '[REDACTED]', 'className contains ssn substring so it is redacted by SENSITIVE_KEYS');
    assert.equal(parsed.textContent, 'Some text content here');
  } finally {
    (globalThis as any).chrome = originalChrome;
  }
});

test('executeJs truncates results exceeding 2000 characters', async () => {
  const originalChrome = (globalThis as any).chrome;
  try {
    const longString = 'a'.repeat(2500);
    (globalThis as any).chrome = {
      scripting: {
        executeScript: async () => [{ result: { __scoutfoxOk: true, value: longString } }]
      }
    };

    const res = await executeJs(101, 'return "a".repeat(2500)');
    assert.equal(res.ok, true);
    assert.equal(res.truncated, true);
    assert.ok(res.result.length > 2000);
    assert.match(res.result, /…\[500 more chars\]/);
  } finally {
    (globalThis as any).chrome = originalChrome;
  }
});

test('executeJs reports actionable error on CSP EVAL_BLOCKED', async () => {
  const originalChrome = (globalThis as any).chrome;
  try {
    (globalThis as any).chrome = {
      scripting: {
        executeScript: async () => [
          { result: { __scoutfoxOk: false, error: "EVAL_BLOCKED: call to Function() violates CSP" } }
        ]
      }
    };

    const res = await executeJs(101, 'return document.title');
    assert.equal(res.ok, false);
    assert.equal(res.success, false);
    assert.match(res.error ?? '', /Content-Security-Policy/);
    assert.match(res.error ?? '', /read_page_text|click\/type/);
  } finally {
    (globalThis as any).chrome = originalChrome;
  }
});

test('executeJs reports model runtime errors', async () => {
  const originalChrome = (globalThis as any).chrome;
  try {
    (globalThis as any).chrome = {
      scripting: {
        executeScript: async () => [
          { result: { __scoutfoxOk: false, error: 'RUNTIME_ERROR: TypeError: foo is not a function' } }
        ]
      }
    };

    const res = await executeJs(101, 'foo()');
    assert.equal(res.ok, false);
    assert.equal(res.success, false);
    assert.match(res.error ?? '', /Your code threw: TypeError: foo is not a function/);
  } finally {
    (globalThis as any).chrome = originalChrome;
  }
});

test('executeJs handles frame removed during execution as navigation triggered', async () => {
  const originalChrome = (globalThis as any).chrome;
  try {
    (globalThis as any).chrome = {
      scripting: {
        executeScript: async () => {
          throw new Error('Frame with ID 123 was removed');
        }
      }
    };

    const res = await executeJs(101, 'window.location.href = "https://example.com"');
    assert.equal(res.ok, true);
    assert.equal(res.success, true);
    assert.equal(res.result, 'navigation triggered');
  } finally {
    (globalThis as any).chrome = originalChrome;
  }
});

test('executeJs produces error when executeScript returns no wrapped result', async () => {
  const originalChrome = (globalThis as any).chrome;
  try {
    (globalThis as any).chrome = {
      scripting: {
        executeScript: async () => [{ result: null }]
      }
    };

    const res = await executeJs(101, 'return 1');
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /produced no result/);
  } finally {
    (globalThis as any).chrome = originalChrome;
  }
});

test('executeJs respects timeout and abort options', async () => {
  const originalChrome = (globalThis as any).chrome;
  try {
    (globalThis as any).chrome = {
      scripting: {
        executeScript: () => new Promise(() => {}) // never resolves
      }
    };

    const timedOut = await executeJs(101, 'while(true){}', { timeoutMs: 50 });
    assert.equal(timedOut.ok, false);
    assert.match(timedOut.error ?? '', /timed out/);

    const controller = new AbortController();
    controller.abort(new Error('User cancelled'));
    const aborted = await executeJs(101, 'return 1', { signal: controller.signal });
    assert.equal(aborted.ok, false);
    assert.match(aborted.error ?? '', /User cancelled/);
  } finally {
    (globalThis as any).chrome = originalChrome;
  }
});

test('executeJs leaves ordinary non-sensitive object untouched', async () => {
  const originalChrome = (globalThis as any).chrome;
  try {
    (globalThis as any).chrome = {
      scripting: {
        executeScript: async () => [{ result: { __scoutfoxOk: true, value: { title: 'Product Page', price: 42 } } }]
      }
    };

    const res = await executeJs(101, 'return {title: "Product Page", price: 42}');
    assert.equal(res.ok, true);
    assert.match(res.result, /"title":"Product Page"/);
    assert.match(res.result, /"price":42/);
  } finally {
    (globalThis as any).chrome = originalChrome;
  }
});

test('executeJs redacts nested objects containing sensitive keys like apiKey or token', async () => {
  const originalChrome = (globalThis as any).chrome;
  try {
    (globalThis as any).chrome = {
      scripting: {
        executeScript: async () => [{
          result: {
            __scoutfoxOk: true,
            value: { account: { user: 'prit', token: 'jwt.token.value', apiKey: 'nvapi-secret' } }
          }
        }]
      }
    };

    const res = await executeJs(101, 'return getAccount()');
    assert.equal(res.ok, true);
    assert.match(res.result, /"user":"prit"/);
    assert.doesNotMatch(res.result, /jwt\.token\.value/);
    assert.doesNotMatch(res.result, /nvapi-secret/);
    assert.match(res.result, /\[REDACTED\]/);
  } finally {
    (globalThis as any).chrome = originalChrome;
  }
});

test('executeJs redacts sensitive entries in arrays', async () => {
  const originalChrome = (globalThis as any).chrome;
  try {
    (globalThis as any).chrome = {
      scripting: {
        executeScript: async () => [{
          result: {
            __scoutfoxOk: true,
            value: [{ name: 'item1', password: 'pass1' }, { name: 'item2', apiKey: 'key2' }]
          }
        }]
      }
    };

    const res = await executeJs(101, 'return getList()');
    assert.equal(res.ok, true);
    assert.doesNotMatch(res.result, /pass1/);
    assert.doesNotMatch(res.result, /key2/);
  } finally {
    (globalThis as any).chrome = originalChrome;
  }
});

test('executeJs preserves boolean primitives true and false directly', async () => {
  const originalChrome = (globalThis as any).chrome;
  try {
    let mockVal = true;
    (globalThis as any).chrome = {
      scripting: {
        executeScript: async () => [{ result: { __scoutfoxOk: true, value: mockVal } }]
      }
    };

    let res = await executeJs(101, 'return true');
    assert.equal(res.ok, true);
    assert.equal(res.result, true);

    mockVal = false;
    res = await executeJs(101, 'return false');
    assert.equal(res.ok, true);
    assert.equal(res.result, false);
  } finally {
    (globalThis as any).chrome = originalChrome;
  }
});

test('executeJs handles empty injection array from executeScript', async () => {
  const originalChrome = (globalThis as any).chrome;
  try {
    (globalThis as any).chrome = {
      scripting: {
        executeScript: async () => []
      }
    };

    const res = await executeJs(101, 'return 1');
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /produced no result/);
  } finally {
    (globalThis as any).chrome = originalChrome;
  }
});

test('executeJs bubbles generic chrome scripting errors as actionable failure', async () => {
  const originalChrome = (globalThis as any).chrome;
  try {
    (globalThis as any).chrome = {
      scripting: {
        executeScript: async () => {
          throw new Error('Tab was closed');
        }
      }
    };

    const res = await executeJs(101, 'return 1');
    assert.equal(res.ok, false);
    assert.equal(res.success, false);
    assert.match(res.error ?? '', /Tab was closed/);
  } finally {
    (globalThis as any).chrome = originalChrome;
  }
});

