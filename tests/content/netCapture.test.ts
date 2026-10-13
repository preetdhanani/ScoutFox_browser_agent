import test from 'node:test';
import assert from 'node:assert/strict';
import {
  installNetCapture,
  safeCloneBody,
  shouldCaptureBody,
  readCappedBody,
  MAX_BODY_BYTES,
  type NetRecordPayload,
  type WindowLike
} from '../../src/content/netCapture.ts';

function createMockWindow() {
  const records: NetRecordPayload[] = [];
  const win: WindowLike = {
    __scoutfox_net_recorder_active: false,
    postMessage: (msg: unknown) => {
      const data = msg as { source?: string; payload?: NetRecordPayload };
      if (data && data.source === 'scoutfox-net' && data.payload) {
        records.push(data.payload);
      }
    },
    [Symbol('records')]: records
  };
  return { win, records };
}

test('safeCloneBody handles strings, objects, numbers, and null/empty', () => {
  assert.equal(safeCloneBody(null), null);
  assert.equal(safeCloneBody(''), null);
  assert.equal(safeCloneBody(undefined), null);

  assert.equal(safeCloneBody('hello world'), 'hello world');
  assert.equal(safeCloneBody({ a: 1 }), '{"a":1}');
  assert.equal(safeCloneBody(12345), '12345');

  const longStr = 'a'.repeat(MAX_BODY_BYTES + 500);
  const cloned = safeCloneBody(longStr);
  assert.equal(cloned?.length, MAX_BODY_BYTES);
});

test('shouldCaptureBody correctly filters non-bufferable content types', () => {
  const testType = (contentType: string) =>
    shouldCaptureBody({
      headers: {
        get: (h: string) => (h.toLowerCase() === 'content-type' ? contentType : null)
      }
    });

  assert.equal(testType('application/json'), true);
  assert.equal(testType('text/html'), true);
  assert.equal(testType('text/plain'), true);

  assert.equal(testType('text/event-stream'), false);
  assert.equal(testType('text/event-stream; charset=utf-8'), false);
  assert.equal(testType('multipart/form-data; boundary=xyz'), false);
  assert.equal(testType('video/mp4'), false);
  assert.equal(testType('audio/mpeg'), false);
});

test('readCappedBody truncates at MAX_BODY_BYTES and cancels reader', async () => {
  let cancelled = false;
  const chunk = 'x'.repeat(1000);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < 10; i++) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
    },
    cancel() {
      cancelled = true;
    }
  });

  const res = new Response(stream);
  const body = await readCappedBody(res);

  assert.ok(body.length >= MAX_BODY_BYTES);
  assert.equal(body.length, 5000); // chunk boundary exceeded MAX_BODY_BYTES (4096)
  assert.equal(cancelled, true, 'reader must be cancelled once capped threshold is reached');
});

test('installNetCapture wraps fetch and emits metadata and body on completion', async () => {
  const { win, records } = createMockWindow();
  win.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    return new Response('{"success":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };

  installNetCapture(win);

  const res = await win.fetch!('https://example.com/api', {
    method: 'POST',
    body: JSON.stringify({ query: 'search' })
  });
  const data = await res.json();
  assert.deepEqual(data, { success: true });

  await new Promise((r) => setTimeout(r, 20));

  assert.equal(records.length, 1);
  const rec = records[0];
  assert.equal(rec.url, 'https://example.com/api');
  assert.equal(rec.method, 'POST');
  assert.equal(rec.status, 200);
  assert.equal(rec.ok, true);
  assert.equal(rec.reqBody, '{"query":"search"}');
  assert.equal(rec.respBody, '{"success":true}');
  assert.equal(rec.error, null);
  assert.ok(rec.durationMs >= 0);
  assert.ok(rec.startedAt > 0);
  assert.ok(rec.id.length > 0);
});

test('installNetCapture fetch handles URL object and Request object first argument', async () => {
  const { win, records } = createMockWindow();
  win.fetch = async () => new Response('ok', { status: 200 });

  installNetCapture(win);

  await win.fetch!(new URL('https://example.com/from-url'));
  await win.fetch!({ url: 'https://example.com/from-obj' } as unknown as Request);
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(records.length, 2);
  assert.equal(records[0].url, 'https://example.com/from-url');
  assert.equal(records[1].url, 'https://example.com/from-obj');
});

test('installNetCapture fetch records failed requests with status 0 and rethrows error', async () => {
  const { win, records } = createMockWindow();
  win.fetch = async () => {
    throw new Error('connection refused');
  };

  installNetCapture(win);

  await assert.rejects(
    () => win.fetch!('https://example.com/fail'),
    /connection refused/
  );

  assert.equal(records.length, 1);
  const rec = records[0];
  assert.equal(rec.url, 'https://example.com/fail');
  assert.equal(rec.status, 0);
  assert.equal(rec.ok, false);
  assert.equal(rec.error, 'connection refused');
  assert.equal(rec.respBody, null);
});

test('installNetCapture wraps XMLHttpRequest and records loadend', () => {
  const { win, records } = createMockWindow();

  class MockXHR {
    _sf_method?: string;
    _sf_url?: string;
    status = 200;
    responseText = 'xhr response text';
    listeners: Record<string, Array<() => void>> = {};

    addEventListener(event: string, fn: () => void) {
      if (!this.listeners[event]) this.listeners[event] = [];
      this.listeners[event].push(fn);
    }
    open(method: string, url: string) {
      // original stub
    }
    send(body?: unknown) {
      // Trigger loadend asynchronously or synchronously for test
      const loadendHandlers = this.listeners['loadend'] || [];
      for (const h of loadendHandlers) h();
    }
  }

  win.XMLHttpRequest = MockXHR as unknown as typeof XMLHttpRequest;

  installNetCapture(win);

  const xhr = new win.XMLHttpRequest!();
  xhr.open('POST', 'https://example.com/xhr');
  xhr.send(JSON.stringify({ xhrReq: true }));

  assert.equal(records.length, 1);
  const rec = records[0];
  assert.equal(rec.url, 'https://example.com/xhr');
  assert.equal(rec.method, 'POST');
  assert.equal(rec.status, 200);
  assert.equal(rec.ok, true);
  assert.equal(rec.reqBody, '{"xhrReq":true}');
  assert.equal(rec.respBody, 'xhr response text');
  assert.equal(rec.error, null);
});

test('installNetCapture XHR records network error when status is 0', () => {
  const { win, records } = createMockWindow();

  class MockXHR {
    status = 0;
    responseText = '';
    listeners: Record<string, Array<() => void>> = {};

    addEventListener(event: string, fn: () => void) {
      if (!this.listeners[event]) this.listeners[event] = [];
      this.listeners[event].push(fn);
    }
    open(method: string, url: string) {}
    send(body?: unknown) {
      for (const h of this.listeners['loadend'] || []) h();
    }
  }

  win.XMLHttpRequest = MockXHR as unknown as typeof XMLHttpRequest;

  installNetCapture(win);

  const xhr = new win.XMLHttpRequest!();
  xhr.open('GET', 'https://example.com/cors-blocked');
  xhr.send();

  assert.equal(records.length, 1);
  const rec = records[0];
  assert.equal(rec.status, 0);
  assert.equal(rec.ok, false);
  assert.equal(rec.error, 'Network error / CORS blocked');
});

test('installNetCapture is idempotent and guards against double registration', () => {
  const { win } = createMockWindow();
  let fetchCallCount = 0;
  const originalFetch = async () => {
    fetchCallCount++;
    return new Response('ok');
  };
  win.fetch = originalFetch;

  installNetCapture(win);
  const wrappedFetch = win.fetch;

  installNetCapture(win);
  assert.equal(win.fetch, wrappedFetch, 'fetch must not be re-wrapped on second installation');
});

// BUG-46: a Request-object fetch was recorded with the init's method only, so
// fetch(new Request(url, { method: 'POST' })) was recorded as GET.
test('installNetCapture fetch reads the method from a Request first argument (BUG-46)', async () => {
  const { win, records } = createMockWindow();
  win.fetch = async () => new Response('ok', { status: 200 });

  installNetCapture(win);

  await win.fetch!(new Request('https://example.com/req-post', { method: 'POST' }) as unknown as Request);
  await win.fetch!(new Request('https://example.com/req-get') as unknown as Request);
  await win.fetch!('https://example.com/plain', { method: 'PUT' });
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(records.length, 3);
  assert.equal(records[0].method, 'POST', `Request-object method must win, got ${records[0].method}`);
  assert.equal(records[1].method, 'GET', 'a Request without a method defaults to GET');
  assert.equal(records[2].method, 'PUT', 'the init method still applies to string urls');
});

// BUG-46: a reused XHR accumulated one loadend listener per send, emitting a
// duplicate/stale record per earlier send.
test('installNetCapture XHR reuse emits exactly one record per send with fresh metadata (BUG-46)', () => {
  const { win, records } = createMockWindow();

  class MockXHR {
    _sf_method?: string;
    _sf_url?: string;
    status = 200;
    responseText = 'xhr response text';
    listeners: Record<string, Array<() => void>> = {};

    addEventListener(event: string, fn: () => void) {
      if (!this.listeners[event]) this.listeners[event] = [];
      this.listeners[event].push(fn);
    }
    open(method: string, url: string) {}
    send(body?: unknown) {
      for (const h of this.listeners['loadend'] || []) h();
    }
  }

  win.XMLHttpRequest = MockXHR as unknown as typeof XMLHttpRequest;

  installNetCapture(win);

  const xhr = new win.XMLHttpRequest!();
  xhr.open('POST', 'https://example.com/first');
  xhr.send('first body');
  // Reuse the SAME instance for a different request.
  xhr.open('GET', 'https://example.com/second');
  xhr.send();

  assert.equal(records.length, 2, `one record per send, got ${records.length}: ${JSON.stringify(records.map((r) => r.url))}`);
  assert.equal(records[0].url, 'https://example.com/first');
  assert.equal(records[0].method, 'POST');
  assert.equal(records[0].reqBody, 'first body');
  assert.equal(records[1].url, 'https://example.com/second');
  assert.equal(records[1].method, 'GET', 'the reused XHR must record its own metadata, not the first send\'s');
  assert.equal(records[1].reqBody, null);
});
