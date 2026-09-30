/**
 * isGeminiStreamCut recognises the one unhandled rejection that the Google SDK leaves behind when a streamed reply
 * is cut, and nothing else. The wiring in the worker is tested in tests/backgroundUnhandledRejection.test.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GoogleGenerativeAIAbortError, GoogleGenerativeAIError } from '@google/generative-ai';
import { isGeminiStreamCut } from '../../src/background/boot/rejections.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const url = (rel: string) => JSON.stringify(pathToFileURL(`${ROOT}${rel}`).href);

test('recognises the errors that the SDK throws from its stream reader, built from the SDK classes', () => {
  assert.equal(isGeminiStreamCut(new GoogleGenerativeAIError('Error reading from the stream')), true);
  assert.equal(isGeminiStreamCut(new GoogleGenerativeAIAbortError('Request aborted when reading from the stream')), true);
  assert.equal(isGeminiStreamCut(new GoogleGenerativeAIError('Failed to parse stream')), true, 'what a 200 that is not an event stream leaves behind');
});

test('does not recognise other errors of the SDK, look-alikes, or things that are not errors', () => {
  const others: unknown[] = [
    new GoogleGenerativeAIError('Error parsing JSON response: "{"'),
    new GoogleGenerativeAIError('Error reading from the stream, and then some'),
    new GoogleGenerativeAIError('error reading from the stream'),
    new Error('Error reading from the stream'),
    new Error('Request aborted when reading from the stream'),
    '[GoogleGenerativeAI Error]: Error reading from the stream',
    { message: '[GoogleGenerativeAI Error]: Error reading from the stream' },
    null,
    undefined,
    42
  ];
  for (const reason of others) assert.equal(isGeminiStreamCut(reason), false, String(reason));
});

// The real thing: Gemini through generateCompletion against a local server that sends the first piece of the stream and
// then stalls. The child process collects what the runtime reports as unhandled, and prints it with the call's outcome.
function unhandledAfter(how: 'pause' | 'cut'): { reasons: string[]; callError: string } {
  const script = `
    import { generateCompletion } from ${url('src/background/llm/index.ts')};
    import { redirectFetch, startSlowServer } from ${url('tests/helpers/slowServer.ts')};
    const reasons = [];
    process.on('unhandledRejection', (reason) => reasons.push(reason instanceof Error ? reason.message : String(reason)));
    const cleanup = [];
    const t = { after: (fn) => cleanup.push(fn) };
    const server = await startSlowServer(t, { stallAfterFirstChunk: true });
    redirectFetch(t, { 'https://generativelanguage.googleapis.com': server.base });
    const task = new AbortController();
    let callError = 'none';
    const call = generateCompletion({ provider: 'gemini', apiKey: 'AIza-test-123', model: 'gemini-1.5-flash', llmTimeoutMs: 30000 }, [{ role: 'user', content: 'hi' }], 'system', { signal: task.signal })
      .catch((error) => { callError = error.message; });
    while (!server.requests.length) await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (${JSON.stringify(how)} === 'pause') task.abort({ name: 'AbortError', scoutfox: 'user' });
    else cleanup.splice(0).forEach((fn) => fn()); // closes the socket: the connection drops halfway
    await call;
    // The SDK's stream fails a moment after the call has rejected: wait for it (up to 5 s), then a little longer for a second one.
    for (let waited = 0; !reasons.length && waited < 5000; waited += 20) await new Promise((resolve) => setTimeout(resolve, 20));
    await new Promise((resolve) => setTimeout(resolve, 150));
    console.log(JSON.stringify({ reasons, callError }));
    cleanup.forEach((fn) => fn());
    process.exit(0);
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', cwd: ROOT });
  assert.equal(run.status, 0, `the child process failed: ${run.stderr}`);
  return JSON.parse(run.stdout.trim().split('\n').pop() as string);
}

for (const how of ['pause', 'cut'] as const) {
  test(`the unhandled rejection that a Gemini stream leaves after a ${how} is recognised (the real SDK, in a child process)`, () => {
    const { reasons, callError } = unhandledAfter(how);
    assert.notEqual(callError, 'none', 'the call must reject');
    assert.ok(reasons.length >= 1, 'the SDK left no unhandled rejection, so this test proves nothing (did the SDK change?)');
    for (const reason of reasons) assert.equal(isGeminiStreamCut(new Error(reason)), true, `not recognised: ${reason}`);
  });
}

// A 200 that is not an event stream (a proxy's page, a JSON object): the SDK fails the call with "Failed to parse stream"
// and its second branch of the stream rejects with the same text, which nobody awaits.
function unhandledAfterBadBody(body: string, contentType: string): { reasons: string[]; callError: string } {
  const script = `
    import { generateCompletion } from ${url('src/background/llm/index.ts')};
    import { installFetch } from ${url('tests/helpers/llmWire.ts')};
    const reasons = [];
    process.on('unhandledRejection', (reason) => reasons.push(reason instanceof Error ? reason.message : String(reason)));
    installFetch({ after: () => {} }, async () => new Response(${JSON.stringify(body)}, { status: 200, headers: { 'content-type': ${JSON.stringify(contentType)} } }));
    let callError = 'none';
    await generateCompletion({ provider: 'gemini', apiKey: 'AIza-test-123', model: 'gemini-1.5-flash' }, [{ role: 'user', content: 'hi' }], 'system')
      .catch((error) => { callError = error.message; });
    for (let waited = 0; !reasons.length && waited < 5000; waited += 20) await new Promise((resolve) => setTimeout(resolve, 20));
    await new Promise((resolve) => setTimeout(resolve, 150));
    console.log(JSON.stringify({ reasons, callError }));
    process.exit(0);
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', cwd: ROOT });
  assert.equal(run.status, 0, `the child process failed: ${run.stderr}`);
  return JSON.parse(run.stdout.trim().split('\n').pop() as string);
}

for (const [name, body, contentType] of [['a JSON object', '{}', 'application/json'], ['a proxy page', '<html>Sign in</html>', 'text/html']]) {
  test(`the unhandled rejection that a Gemini 200 with ${name} leaves is recognised, and the call fails with the SDK's text (the real SDK, in a child process)`, () => {
    const { reasons, callError } = unhandledAfterBadBody(body, contentType);
    assert.equal(callError, 'Gemini API Error: [GoogleGenerativeAI Error]: Failed to parse stream');
    assert.ok(reasons.length >= 1, 'the SDK left no unhandled rejection, so this test proves nothing (did the SDK change?)');
    for (const reason of reasons) assert.equal(isGeminiStreamCut(new Error(reason)), true, `not recognised: ${reason}`);
  });
}
