/**
 * Regression tests for the three critical defects fixed in issues #5, #6 and #7.
 *
 * Each of these shipped for a while with a green suite, because nothing exercised the path:
 *   #5  net-recorder awaited the whole response body before handing the Response back, so
 *       every streaming fetch on every site the user visited was withheld until the stream
 *       ended. Covered here by a body that never closes.
 *   #6  Pause and Stop abort the in-flight LLM request. The LLM catch block treated that
 *       abort as a provider failure, forced status to 'idle' and recorded a fabricated
 *       connection error, which destroyed the run and made Resume impossible.
 *   #7  parseResponse only sanitised element_id when it was ALREADY a number, so a string
 *       from a prompt-injected model reached the side panel and was rendered as HTML.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

let storageBacking = {};

global.chrome = {
  runtime: { lastError: null },
  storage: {
    local: {
      get: (keys, cb) => cb({ ...storageBacking }),
      set: (data, cb) => { Object.assign(storageBacking, data); if (cb) cb(); }
    }
  },
  tabs: {
    get: (id, cb) => cb({ id, groupId: -1, url: 'https://example.com' }),
    query: async () => [{ id: 101, url: 'https://example.com' }],
    sendMessage: (tabId, msg, cb) => cb({ success: true }),
    onUpdated: { addListener: () => {}, removeListener: () => {}, hasListener: () => false }
  }
};

const { AgentEngine } = await import('../background/agentEngine.js');


/* ------------------------------------------------------------------ *
 * #7 - element_id must be coerced whatever type the model sends
 * ------------------------------------------------------------------ */

test('#7 parseResponse coerces a STRING element_id carrying markup to a safe number', () => {
  const engine = new AgentEngine();
  const injected = '<img src=x onerror=alert(1)>';
  const raw = JSON.stringify({ action: 'click', element_id: injected, reason: 'injected' });

  const result = engine.parseResponse(raw, 10);

  assert.equal(typeof result.action.element_id, 'number',
    'a string element_id must never survive parseResponse');
  assert.equal(result.action.element_id, 1);
  assert.ok(!String(result.action.element_id).includes('<'),
    'no markup may remain in element_id');
});

test('#7 parseResponse coerces a numeric STRING element_id to its number', () => {
  const engine = new AgentEngine();
  const raw = JSON.stringify({ action: 'click', element_id: '4', reason: 'string digit' });

  const result = engine.parseResponse(raw, 10);

  assert.equal(result.action.element_id, 4);
  assert.equal(typeof result.action.element_id, 'number');
});

test('#7 parseResponse rejects zero, negative and NaN element_id values', () => {
  const engine = new AgentEngine();
  for (const bad of [0, -3, 'abc', null, {}, []]) {
    const raw = JSON.stringify({ action: 'click', element_id: bad, reason: 'bad' });
    const result = engine.parseResponse(raw, 10);
    if (result.action && result.action.element_id !== undefined) {
      assert.ok(Number.isFinite(result.action.element_id) && result.action.element_id >= 1,
        `element_id ${JSON.stringify(bad)} produced ${result.action.element_id}`);
    }
  }
});

// Plain-number element_id clamping (as opposed to the string-coercion bug #7 is actually
// about) is already covered by tests/agentEngine.test.js's "Element ID Clamping Guardrail" -
// not duplicated here.


/* ------------------------------------------------------------------ *
 * #6 - a user abort is not a provider failure
 * ------------------------------------------------------------------ */

test('#6 isUserAbort recognises a DOMException-style AbortError', () => {
  const engine = new AgentEngine();
  const err = new Error('The user aborted a request.');
  err.name = 'AbortError';

  assert.equal(engine.isUserAbort(err), true);
});

test('#6 isUserAbort recognises the abort via the controller signal', () => {
  const engine = new AgentEngine();
  engine.status = 'running';
  engine.abortController = new AbortController();
  engine.abortController.abort();

  assert.equal(engine.isUserAbort(new Error('LLM request cancelled (task stopped or paused).')), true);
});

test('#6 isUserAbort recognises the abort via engine status alone', () => {
  const engine = new AgentEngine();
  engine.abortController = null;

  engine.status = 'paused';
  assert.equal(engine.isUserAbort(new Error('socket hang up')), true);

  engine.status = 'stopped';
  assert.equal(engine.isUserAbort(new Error('socket hang up')), true);
});

test('#6 isUserAbort does NOT swallow a genuine provider failure', () => {
  const engine = new AgentEngine();
  engine.status = 'running';
  engine.abortController = new AbortController();   // never aborted

  assert.equal(engine.isUserAbort(new Error('Anthropic API error (401): invalid x-api-key')), false);
});

test('#6 isUserAbort does NOT misread the LLM timeout as a user abort', () => {
  const engine = new AgentEngine();
  engine.status = 'running';
  engine.abortController = new AbortController();

  // The exact message ApiClients.generateCompletion rejects with on deadline.
  const timeout = new Error('Provider [gemini] did not respond within 120s. The request was abandoned — check that the endpoint and model are reachable, or raise llmTimeoutMs in settings.');

  assert.equal(engine.isUserAbort(timeout), false,
    'a timeout must still be reported to the user as a real failure');
});

test('#6 pause() keeps status paused so the run stays resumable', () => {
  const engine = new AgentEngine();
  engine.status = 'running';
  engine.abortController = new AbortController();

  const res = engine.pause();

  assert.equal(res.success, true);
  assert.equal(engine.status, 'paused');
  assert.equal(engine.abortController.signal.aborted, true,
    'pause must abort the in-flight request');
  assert.equal(engine.isUserAbort(new Error('LLM request cancelled (task stopped or paused).')), true,
    'the resulting rejection must be classified as a user abort, not a connection error');
});


/* ------------------------------------------------------------------ *
 * #5 - net-recorder must not withhold a streaming Response
 * ------------------------------------------------------------------ */

/** Load net-recorder.js into a minimal window stand-in and return that window. */
async function loadNetRecorder() {
  const fs = await import('node:fs/promises');
  const src = await fs.readFile(new URL('../content/net-recorder.js', import.meta.url), 'utf8');
  const win = {
    __scoutfox_net_recorder_active: false,
    postMessage: (msg) => { win.__records.push(msg.payload); },
    __records: [],
    TextDecoder,
    XMLHttpRequest: undefined
  };
  win.fetch = async () => { throw new Error('replaced below'); };
  const fn = new Function('window', 'TextDecoder', `${src}\nreturn window;`);
  return { win, install: () => fn(win, TextDecoder) };
}

test('#5 a streaming response is returned before its body finishes', async () => {
  const { win, install } = await loadNetRecorder();

  let closeStream;
  const streamEnded = new Promise((r) => { closeStream = r; });

  // A body that stays open, exactly like SSE or a chunked feed.
  win.fetch = async () => new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: first\n\n'));
        streamEnded.then(() => controller.close());
      }
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  );

  install();

  const settled = await Promise.race([
    win.fetch('https://example.com/stream').then(() => 'returned'),
    new Promise((r) => setTimeout(() => r('blocked'), 300))
  ]);

  assert.equal(settled, 'returned',
    'fetch must resolve as soon as headers arrive, not when the stream ends');

  closeStream();
});

test('#5 the caller still receives a readable body it can consume itself', async () => {
  const { win, install } = await loadNetRecorder();

  win.fetch = async () => new Response('{"ok":true}', {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });

  install();

  const res = await win.fetch('https://example.com/data');
  const body = await res.json();

  assert.deepEqual(body, { ok: true },
    'cloning for capture must not consume the body the caller reads');
});

test('#5 a non-streaming response is still captured and recorded', async () => {
  const { win, install } = await loadNetRecorder();

  win.fetch = async () => new Response('hello world', {
    status: 201,
    headers: { 'content-type': 'text/plain' }
  });

  install();

  await win.fetch('https://example.com/thing', { method: 'POST', body: 'payload' });
  await new Promise((r) => setTimeout(r, 50));   // let the detached capture land

  const rec = win.__records.find((r) => r.url === 'https://example.com/thing');
  assert.ok(rec, 'a record must be emitted');
  assert.equal(rec.status, 201);
  assert.equal(rec.method, 'POST');
  assert.equal(rec.respBody, 'hello world');
});

test('#5 a failed request is still recorded and the error still propagates', async () => {
  const { win, install } = await loadNetRecorder();

  win.fetch = async () => { throw new Error('network down'); };

  install();

  await assert.rejects(() => win.fetch('https://example.com/bad'), /network down/);

  const rec = win.__records.find((r) => r.url === 'https://example.com/bad');
  assert.ok(rec, 'a failed request must still be recorded');
  assert.equal(rec.error, 'network down');
  assert.equal(rec.status, 0);
});
