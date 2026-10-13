/**
 * Tests for tests/helpers/fakeLlm.ts, the scripted stand-in for the model.
 *
 * The engine tests of the later phases replace the ApiClients.generateCompletion monkey-patches of
 * about 16 files with it, and the graph tests use its chat model. So this file pins down what they
 * rely on: replies come in order, every call is recorded, an abort ends a call the way fetch does
 * (and the engine's isUserAbort() recognises), and a call the script has no reply for is a loud
 * test mistake, never a silent default.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { fakeLlm } from './helpers/fakeLlm.ts';
import { callWithRetry } from '../src/background/agent/recovery.ts';
import type { LlmCall } from './helpers/fakeLlm.ts';

const SETTINGS = { provider: 'ollama', model: 'test-model', maxSteps: 5 };
const USER = [{ role: 'user', content: 'Goal: find the price' }];

/** What the engine's isUserAbort() looks at in an error. */
const looksLikeAbort = (err: unknown): boolean => {
  const e = err as { name?: string; message?: string };
  return e.name === 'AbortError' || /abort/i.test(e.message ?? '');
};

// ---------------------------------------------------------------------------------------------
// Replies and the call log
// ---------------------------------------------------------------------------------------------

test('replies come back in the order of the script, and every call is recorded', async () => {
  const fl = fakeLlm(['first', 'second']);
  const controller = new AbortController();
  const schema = { type: 'object' };

  const a = await fl.generateCompletion(SETTINGS, USER, 'You are a planner.', { signal: controller.signal, json: true, schema });
  const b = await fl.generateCompletion(SETTINGS, [...USER, { role: 'assistant', content: a }], 'You are an agent.');

  assert.equal(a, 'first');
  assert.equal(b, 'second');
  assert.equal(fl.calls.length, 2);
  const [one, two] = fl.calls as [LlmCall, LlmCall];
  assert.equal(one.index, 0);
  assert.equal(one.via, 'generateCompletion');
  assert.deepEqual(one.messages, USER);
  assert.equal(one.systemPrompt, 'You are a planner.');
  assert.deepEqual(one.schema, schema);
  assert.equal(one.json, true);
  assert.equal(one.signal, controller.signal, 'the signal is kept by reference, so a test can see it abort later');
  assert.deepEqual(one.settings, SETTINGS);
  assert.equal(one.outcome, 'text');
  assert.equal(one.reply, 'first');
  assert.equal(two.index, 1);
  assert.equal(two.schema, null);
  assert.equal(two.json, false);
  assert.equal(two.signal, null);
  assert.deepEqual(two.messages.at(-1), { role: 'assistant', content: 'first' });
  fl.assertClean();
  fl.assertDrained();
});

test('the record is a copy: changing the messages or settings afterwards does not change what was recorded', async () => {
  const fl = fakeLlm(['ok']);
  const messages = [{ role: 'user', content: 'before' }];
  const settings = { model: 'm1' };
  await fl.generateCompletion(settings, messages, 'sys');
  messages[0]!.content = 'after';
  messages.push({ role: 'user', content: 'extra' });
  settings.model = 'm2';

  assert.deepEqual(fl.calls[0]?.messages, [{ role: 'user', content: 'before' }]);
  assert.deepEqual(fl.calls[0]?.settings, { model: 'm1' });
});

test('remaining counts the unused replies, push adds to the end, resetCalls clears the log only', async () => {
  const fl = fakeLlm(['a']);
  assert.equal(fl.remaining, 1);
  fl.push('b', { text: 'c' });
  assert.equal(fl.remaining, 3);
  await fl.generateCompletion(SETTINGS, USER, '');
  assert.equal(fl.remaining, 2);
  fl.resetCalls();
  assert.equal(fl.calls.length, 0);
  assert.equal(fl.remaining, 2, 'the script is not touched by resetCalls');
  assert.equal(await fl.generateCompletion(SETTINGS, USER, ''), 'b');
  assert.equal(fl.calls[0]?.index, 0, 'the log starts again from 0');
});

test('reasoning goes in front of the text as <think> tags, and text: "" is a real empty answer', async () => {
  const fl = fakeLlm([
    { text: '{"action":"finish"}', reasoning: 'The price is on the page.' },
    { reasoning: 'Still thinking' },
    { text: '' },
  ]);
  assert.equal(await fl.generateCompletion(SETTINGS, USER, ''), '<think>The price is on the page.</think>\n{"action":"finish"}');
  assert.equal(await fl.generateCompletion(SETTINGS, USER, ''), '<think>Still thinking</think>', 'a model that never left its thinking');
  assert.equal(await fl.generateCompletion(SETTINGS, USER, ''), '');
  fl.assertClean();
});

test('a delayed reply is pending until it arrives', async () => {
  const fl = fakeLlm([{ text: 'late', delayMs: 30 }]);
  let done = false;
  const call = fl.generateCompletion(SETTINGS, USER, '').then((text) => {
    done = true;
    return text;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(done, false);
  assert.equal(fl.calls[0]?.outcome, 'pending');
  assert.equal(await call, 'late');
  assert.equal(fl.calls[0]?.outcome, 'text');
});

test('an error reply rejects: a string becomes an Error, an Error is thrown as it is, and the outcome says so', async () => {
  const boom = new Error('socket hang up');
  const fl = fakeLlm([{ error: 'Provider [x] did not respond within 120s.' }, { error: boom, delayMs: 1 }]);

  await assert.rejects(fl.generateCompletion(SETTINGS, USER, ''), { name: 'Error', message: 'Provider [x] did not respond within 120s.' });
  await assert.rejects(
    fl.generateCompletion(SETTINGS, USER, ''),
    (err) => err === boom
  );
  assert.deepEqual(fl.calls.map((c) => c.outcome), ['error', 'error']);
  assert.equal(fl.calls[1]?.error, boom);
  fl.assertClean();
});

test('a function reply answers by what the model was shown', async () => {
  const fl = fakeLlm([
    (call) => (call.systemPrompt.includes('planner') ? '["a","b"]' : 'wrong'),
    async (call) => ({ text: `saw ${call.messages.length} message(s)`, delayMs: 1 }),
  ]);
  assert.equal(await fl.generateCompletion(SETTINGS, USER, 'You are a planner.'), '["a","b"]');
  assert.equal(await fl.generateCompletion(SETTINGS, [...USER, ...USER], 'x'), 'saw 2 message(s)');
});

test('a script that is one function answers every call, so it cannot run out', async () => {
  const fl = fakeLlm((call) => `call ${call.index}`);
  assert.equal(await fl.generateCompletion(SETTINGS, USER, ''), 'call 0');
  assert.equal(await fl.generateCompletion(SETTINGS, USER, ''), 'call 1');
  assert.equal(fl.remaining, 0);
  fl.assertDrained();
  assert.throws(() => fl.push('x'), /push\(\) needs a script that is a list of replies/);
});

// ---------------------------------------------------------------------------------------------
// Test mistakes
// ---------------------------------------------------------------------------------------------

test('a call the script has no reply for rejects with a clear message, and is kept as a violation', async () => {
  const fl = fakeLlm(['only one']);
  await fl.generateCompletion(SETTINGS, USER, '');

  await assert.rejects(
    fl.generateCompletion(SETTINGS, [{ role: 'user', content: 'an unexpected second question' }], ''),
    /call 2 \(generateCompletion, last message "an unexpected second question"\) has no scripted reply - the script has only 1 reply\(ies\)/
  );
  assert.equal(fl.violations.length, 1);
  assert.equal(fl.violations[0]?.name, 'FakeLlmError');
  assert.throws(() => fl.assertClean(), /1 test mistake\(s\) were thrown to the code under test:\n {2}- fakeLlm: call 2/);
  assert.equal(fl.calls[1]?.outcome, 'error', 'the call is still recorded');
});

test('the violation stays in the log even when the code under test swallows the error', async () => {
  const fl = fakeLlm([]);
  await fl.generateCompletion(SETTINGS, USER, '').catch(() => undefined);
  await fl.generateCompletion(SETTINGS, USER, '').catch(() => undefined);
  assert.equal(fl.violations.length, 2);
  assert.throws(() => fl.assertClean(), /2 test mistake\(s\)/);
});

test('a bad entry in a plain script throws at once, at the line that wrote it', () => {
  assert.throws(() => fakeLlm([{ text: 'x', delay: 5 } as never]), /reply 1 of the script has an unknown key "delay"; a reply object has text, reasoning, delayMs, error/);
  assert.throws(() => fakeLlm(['ok', { text: 'x', error: 'y' }]), /reply 2 of the script has both error and text\/reasoning/);
  assert.throws(() => fakeLlm([{}]), /reply 1 of the script has neither text nor error/);
  assert.throws(() => fakeLlm([{ text: 'x', delayMs: -1 }]), /delayMs must be a number of milliseconds, 0 or more \(got -1\)/);
  assert.throws(() => fakeLlm([{ text: 'x', delayMs: Infinity }]), /delayMs must be a number/);
  assert.throws(() => fakeLlm([{ error: 7 as never }]), /error must be a string or an Error/);
  assert.throws(() => fakeLlm([42 as never]), /reply 1 of the script is number, not a reply/);
  assert.throws(() => fakeLlm([null as never]), /is null, not a reply/);
  const fl = fakeLlm(['ok']);
  assert.throws(() => fl.push({ txt: 'typo' } as never), /reply 2 of the script has an unknown key "txt"/);
  assert.equal(fl.remaining, 1, 'a rejected push adds nothing');
});

test('a bad answer of a function is thrown to the caller and kept as a violation', async () => {
  const fl = fakeLlm([() => ({ txt: 'typo' }) as never]);
  await assert.rejects(fl.generateCompletion(SETTINGS, USER, ''), /the reply for call 1 has an unknown key "txt"/);
  assert.equal(fl.violations.length, 1);
});

test('an error thrown inside a function reply (a failed assert about the prompt) is kept as a violation, so a retry loop cannot hide it', async () => {
  const fl = fakeLlm([
    (call) => {
      assert.match(call.systemPrompt, /EXPECTED PLAN SECTION/);
      return 'first';
    },
    'second',
  ]);
  // The engine's own retry loop: the failed assert is swallowed and the next attempt takes the next reply.
  const got = await callWithRetry(() => fl.generateCompletion(SETTINGS, USER, 'a prompt without the section'), { baseDelayMs: 1 });

  assert.equal(got, 'second', 'the code under test moved on, as the engine does');
  assert.equal(fl.calls[0]?.outcome, 'error');
  assert.equal(fl.violations.length, 1, 'the failed assert must not be lost');
  assert.equal(fl.violations[0]?.name, 'AssertionError', 'kept as it was thrown, not wrapped');
  assert.throws(() => fl.assertClean(), /1 test mistake\(s\) were thrown to the code under test:\n {2}- The input did not match the regular expression/);
  fl.assertDrained();
});

test('an error thrown inside a function reply reaches the caller unchanged, on both surfaces, and an async function is the same', async () => {
  const boom = new TypeError('the function broke');
  const fl = fakeLlm([
    () => {
      throw boom;
    },
    async () => {
      throw boom;
    },
    () => {
      throw 'a thrown string';
    },
  ]);
  await assert.rejects(fl.generateCompletion(SETTINGS, USER, ''), (e) => e === boom);
  await assert.rejects(fl.chatModel().invoke('two'), (e) => e === boom);
  await assert.rejects(fl.generateCompletion(SETTINGS, USER, ''), (e) => e === 'a thrown string');
  assert.deepEqual(fl.violations.map((v) => v.message), ['the function broke', 'the function broke', 'a thrown string']);
  assert.ok(fl.violations.every((v) => v instanceof Error), 'a thrown non-Error is kept as an Error');
});

test('a function that fails because the call was aborted is an abort, not a test mistake', async () => {
  const controller = new AbortController();
  const fl = fakeLlm([
    (call) =>
      new Promise((_, reject) => {
        call.signal?.addEventListener('abort', () => reject(call.signal?.reason), { once: true });
      }),
  ]);
  const call = fl.generateCompletion(SETTINGS, USER, '', { signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  const err = await call.then(() => undefined, (e: unknown) => e);
  assert.ok(looksLikeAbort(err), `got ${String(err)}`);
  assert.equal(fl.calls[0]?.outcome, 'aborted');
  assert.equal(fl.violations.length, 0);
  fl.assertClean();
});

test('a scripted { error } is still a model failure and is not a test mistake', async () => {
  const fl = fakeLlm([{ error: 'model overloaded' }, () => ({ error: new Error('and again') }), 'fine']);
  const got = await callWithRetry(() => fl.generateCompletion(SETTINGS, USER, ''), { baseDelayMs: 1 });
  assert.equal(got, 'fine');
  assert.equal(fl.violations.length, 0);
  fl.assertClean();
});

test('assertDrained says how many replies were never used', async () => {
  const fl = fakeLlm(['a', 'b', 'c']);
  await fl.generateCompletion(SETTINGS, USER, '');
  assert.throws(() => fl.assertDrained(), /2 scripted reply\(ies\) were never used - the code under test made 1 call\(s\)/);
  await fl.generateCompletion(SETTINGS, USER, '');
  await fl.generateCompletion(SETTINGS, USER, '');
  fl.assertDrained();
});

// ---------------------------------------------------------------------------------------------
// Abort
// ---------------------------------------------------------------------------------------------

test('a call whose signal is already aborted fails with the abort error and uses no reply', async () => {
  const fl = fakeLlm(['kept for the next call']);
  const controller = new AbortController();
  controller.abort();

  const err = await fl.generateCompletion(SETTINGS, USER, '', { signal: controller.signal }).then(
    () => undefined,
    (e: unknown) => e
  );
  assert.equal(err, controller.signal.reason, 'like fetch, it rejects with signal.reason');
  assert.equal((err as Error).name, 'AbortError');
  assert.ok(looksLikeAbort(err), 'the engine treats it as the user\'s own Pause or Stop');
  assert.equal(fl.calls[0]?.outcome, 'aborted');
  assert.equal(fl.remaining, 1, 'a request that was never sent does not eat a reply');
  assert.equal(await fl.generateCompletion(SETTINGS, USER, ''), 'kept for the next call');
  fl.assertClean();
});

test('an abort while a delayed reply is waiting ends the call at once', async () => {
  const fl = fakeLlm([{ text: 'never seen', delayMs: 60_000 }]);
  const controller = new AbortController();
  const started = Date.now();
  const call = fl.generateCompletion(SETTINGS, USER, '', { signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fl.calls[0]?.outcome, 'pending');

  controller.abort();
  const err = await call.then(
    () => undefined,
    (e: unknown) => e
  );
  assert.ok(looksLikeAbort(err));
  assert.ok(Date.now() - started < 5_000, 'it did not wait for the 60 s delay');
  assert.equal(fl.calls[0]?.outcome, 'aborted');
  assert.equal(fl.remaining, 0, 'this request was sent, so its reply is used up');
});

test('an abort with a reason of its own rejects with that reason', async () => {
  const fl = fakeLlm([{ text: 'x', delayMs: 60_000 }]);
  const controller = new AbortController();
  const call = fl.generateCompletion(SETTINGS, USER, '', { signal: controller.signal });
  const reason = new Error('paused by user');
  controller.abort(reason);
  await assert.rejects(call, (err) => err === reason);
  assert.equal(fl.calls[0]?.outcome, 'aborted');
});

test('an error that is not the abort is not called an abort, even when the signal aborts later', async () => {
  const fl = fakeLlm([{ error: 'connection refused' }]);
  const controller = new AbortController();
  await assert.rejects(fl.generateCompletion(SETTINGS, USER, '', { signal: controller.signal }), /connection refused/);
  controller.abort();
  assert.equal(fl.calls[0]?.outcome, 'error');
});

// ---------------------------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------------------------

test('install puts generateCompletion on the target and returns the function that puts the old one back', async () => {
  const original = async () => 'the real one';
  const ApiClients = { generateCompletion: original };
  const fl = fakeLlm(['scripted']);

  const restore = fl.install(ApiClients);
  assert.notEqual(ApiClients.generateCompletion, original);
  assert.equal(await (ApiClients.generateCompletion as () => Promise<string>)(), 'scripted');
  assert.equal(fl.calls.length, 1, 'a call through the target is recorded');

  restore();
  assert.equal(ApiClients.generateCompletion, original);
});

// ---------------------------------------------------------------------------------------------
// The chat model
// ---------------------------------------------------------------------------------------------

test('the chat model invoke returns an AIMessage and records the call like generateCompletion does', async () => {
  const fl = fakeLlm([{ text: '{"action":"wait"}', reasoning: 'Bot check page.' }]);
  const model = fl.chatModel();
  const format = { type: 'object', properties: { action: { type: 'string' } } };

  const out = await model.invoke(
    [new SystemMessage('You control one tab.'), new HumanMessage('Goal: find the price'), new AIMessage('{"action":"scroll"}'), new HumanMessage('Result: scrolled')],
    { format }
  );

  assert.ok(AIMessage.isInstance(out));
  assert.equal(out.text, '{"action":"wait"}');
  assert.equal(out.additional_kwargs.reasoning_content, 'Bot check page.');
  const call = fl.calls[0];
  assert.equal(call?.via, 'chatModel');
  assert.equal(call?.systemPrompt, 'You control one tab.');
  assert.deepEqual(call?.messages, [
    { role: 'user', content: 'Goal: find the price' },
    { role: 'assistant', content: '{"action":"scroll"}' },
    { role: 'user', content: 'Result: scrolled' },
  ]);
  assert.deepEqual(call?.schema, format, 'ChatOllama\'s format call option is the schema');
  assert.equal(call?.outcome, 'text');
  assert.equal(call?.reply, '<think>Bot check page.</think>\n{"action":"wait"}');
  fl.assertClean();
});

test('the chat model takes a plain string as one user message, and shares the script and the log with generateCompletion', async () => {
  const fl = fakeLlm(['from the string surface', 'from the chat model']);
  await fl.generateCompletion(SETTINGS, USER, '');
  const out = await fl.chatModel().invoke('hello');

  assert.equal(out.text, 'from the chat model');
  assert.deepEqual(fl.calls.map((c) => [c.index, c.via]), [[0, 'generateCompletion'], [1, 'chatModel']]);
  assert.deepEqual(fl.calls[1]?.messages, [{ role: 'user', content: 'hello' }]);
  assert.equal(fl.calls[1]?.systemPrompt, '');
  assert.equal(fl.calls[1]?.schema, null);
});

test('the chat model rejects with a scripted error and with the abort reason', async () => {
  const fl = fakeLlm([{ error: 'model overloaded' }, { text: 'x', delayMs: 60_000 }]);
  const model = fl.chatModel();
  await assert.rejects(model.invoke('one'), /model overloaded/);

  const controller = new AbortController();
  const call = model.invoke('two', { signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  const err = await call.then(
    () => undefined,
    (e: unknown) => e
  );
  assert.ok(looksLikeAbort(err), `got ${String(err)}`);
  assert.deepEqual(fl.calls.map((c) => c.outcome), ['error', 'aborted']);
});

test('the chat model with no reply left rejects, and the mistake is kept', async () => {
  const fl = fakeLlm([]);
  await assert.rejects(fl.chatModel().invoke('anyone there?'), /call 1 \(chatModel, last message "anyone there\?"\) has no scripted reply/);
  assert.equal(fl.violations.length, 1);
});

// ---------------------------------------------------------------------------------------------
// port: the stand-in for the graph's LlmPort
// ---------------------------------------------------------------------------------------------

/** What the graph nodes send to LlmPort.complete, with the parts a test does not care about filled in. */
function ask(
  node: 'plan' | 'policy' | 'reflect',
  extra: { mode?: string; messages?: Array<{ role: 'user' | 'assistant'; content: string }>; schema?: object | null; signal?: AbortSignal; system?: string } = {}
) {
  return {
    node,
    mode: extra.mode as never,
    role: (node === 'plan' ? 'planner' : node) as 'policy' | 'planner' | 'reflect',
    system: extra.system ?? `system of ${node}`,
    messages: extra.messages ?? [{ role: 'user' as const, content: `message to ${node}` }],
    schema: extra.schema ?? null,
    signal: extra.signal ?? new AbortController().signal,
  };
}

test('port: complete returns text, provider, model and meta, and records node, mode, role, system, messages, schema and signal', async () => {
  const fl = fakeLlm(['the reply']);
  const port = fl.port({ provider: 'test-provider', model: 'test-model' });
  const controller = new AbortController();
  const schema = { type: 'object', required: ['action'] };
  const messages = [{ role: 'user' as const, content: 'Goal: find the price' }];

  const out = await port.complete(ask('policy', { mode: 'browse', messages, schema, signal: controller.signal, system: 'You control one tab.' }));

  assert.deepEqual(out, { text: 'the reply', provider: 'test-provider', model: 'test-model', meta: {} });
  const call = fl.calls[0] as LlmCall;
  assert.equal(call.via, 'port');
  assert.equal(call.node, 'policy');
  assert.equal(call.mode, 'browse');
  assert.equal(call.role, 'policy');
  assert.equal(call.system, 'You control one tab.');
  assert.equal(call.systemPrompt, 'You control one tab.');
  assert.deepEqual(call.messages, messages);
  assert.deepEqual(call.schema, schema);
  assert.equal(call.signal, controller.signal, 'the signal is kept by reference');
  assert.equal(call.outcome, 'text');
  assert.equal(call.reply, 'the reply');
  fl.assertClean();
  fl.assertDrained();
});

test('port: a queue per node and per node:mode answers first, and the plain script answers the rest', async () => {
  const fl = fakeLlm(['plain 1', 'plain 2']);
  const port = fl.port({ queues: { plan: ['the plan'], 'policy:browse': ['browse 1', 'browse 2'], policy: ['any policy'] } });
  const text = async (node: 'plan' | 'policy' | 'reflect', mode?: string) => (await port.complete(ask(node, { mode }))).text;

  assert.equal(await text('policy', 'browse'), 'browse 1', 'node:mode before node');
  assert.equal(await text('policy', 'extract'), 'any policy', 'another mode falls to the node queue');
  assert.equal(await text('plan', 'initial'), 'the plan');
  assert.equal(await text('policy', 'browse'), 'browse 2');
  assert.equal(await text('reflect'), 'plain 1', 'a node without a queue uses the plain script');
  assert.equal(await text('reflect', 'revise'), 'plain 2');
  assert.deepEqual(
    fl.calls.map((c) => [c.node, c.mode, c.reply]),
    [['policy', 'browse', 'browse 1'], ['policy', 'extract', 'any policy'], ['plan', 'initial', 'the plan'], ['policy', 'browse', 'browse 2'], ['reflect', undefined, 'plain 1'], ['reflect', 'revise', 'plain 2']]
  );
  assert.deepEqual(fl.callsOf('policy').map((c) => c.index), [0, 1, 3]);
  assert.deepEqual(fl.callsOf('policy', 'browse').map((c) => c.index), [0, 3]);
  fl.assertClean();
  fl.assertDrained();
});

test('port: a queue that is used up is final - the call is a loud test mistake and never takes the plain script', async () => {
  const fl = fakeLlm(['plain']);
  const port = fl.port({ queues: { plan: ['only plan'] } });

  await port.complete(ask('plan'));
  await assert.rejects(port.complete(ask('plan', { mode: 'revise' })), /call 2 \(port plan\/revise, last message "message to plan"\) has no scripted reply - the "plan" queue is empty/);
  assert.equal(fl.violations.length, 1, 'the mistake is kept, in case the code under test swallows the throw');
  assert.equal(fl.remaining, 1, 'the plain script was not touched');
  assert.throws(() => fl.assertClean(), /1 test mistake/);

  // A call that no queue matches and the plain script has no reply for is the same mistake, named by node.
  await port.complete(ask('policy'));
  await assert.rejects(port.complete(ask('policy', { mode: 'browse' })), /call 4 \(port policy\/browse, last message .*\) has no scripted reply - the script has only 1 reply/);
});

test('port: pushFor adds to a queue after the first calls, and a queue name that is not a node is refused', async () => {
  const fl = fakeLlm();
  const port = fl.port({ queues: { policy: ['one'] } });
  assert.equal((await port.complete(ask('policy'))).text, 'one');

  fl.pushFor('policy', 'two', { text: 'three', reasoning: 'thinking' });
  assert.equal(fl.remaining, 2);
  assert.equal((await port.complete(ask('policy'))).text, 'two');
  assert.equal((await port.complete(ask('policy'))).text, '<think>thinking</think>\nthree', 'reasoning comes in front as <think> tags, like generateCompletion');

  assert.throws(() => fl.pushFor('polcy' as never, 'x'), /"polcy" is not a port queue/);
  assert.throws(() => fl.pushFor('policy:' as never, 'x'), /"policy:" is not a port queue/);
  assert.throws(() => fl.port({ queues: { plan: [{ txt: 'typo' } as never] } }), /unknown key "txt"/);
  fl.assertDrained();
});

test('port: a reply function answers by what the graph asked, and a scripted error rejects the call', async () => {
  const fl = fakeLlm();
  const port = fl.port({
    queues: {
      policy: [
        (call) => `saw ${call.messages.length} message(s) in ${call.mode} mode`,
        { error: 'provider returned 500' },
        { error: new TypeError('network down') },
      ],
    },
  });

  assert.equal((await port.complete(ask('policy', { mode: 'harvest', messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }] }))).text, 'saw 3 message(s) in harvest mode');
  await assert.rejects(port.complete(ask('policy')), /provider returned 500/);
  await assert.rejects(port.complete(ask('policy')), (err) => err instanceof TypeError && err.message === 'network down');
  assert.deepEqual(fl.calls.map((c) => c.outcome), ['text', 'error', 'error']);
  fl.assertClean();
});

test('port: a delayed reply is cut short by an abort and rejects with signal.reason, like fetch', async () => {
  const fl = fakeLlm();
  const port = fl.port({ queues: { policy: [{ text: 'too late', delayMs: 60_000 }] } });
  const controller = new AbortController();
  // The reason the runner uses for Stop and Pause: an object tagged as the user's, not an Error.
  const reason = { scoutfox: 'user', reason: 'user_stop' };

  const started = Date.now();
  const call = port.complete(ask('policy', { signal: controller.signal }));
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(reason);
  await assert.rejects(call, (err) => err === reason);

  assert.ok(Date.now() - started < 5_000, 'it did not wait for the 60 s delay');
  assert.equal(fl.calls[0]?.outcome, 'aborted');
  assert.equal(fl.calls[0]?.signal, controller.signal);
  assert.equal(fl.remaining, 0, 'this request was sent, so its reply is used up');
});

test('port: a signal that is already aborted rejects with its reason and uses no reply', async () => {
  const fl = fakeLlm();
  const port = fl.port({ queues: { plan: ['unused'] } });
  const controller = new AbortController();
  controller.abort();

  const err = await port.complete(ask('plan', { signal: controller.signal })).then(
    () => undefined,
    (e: unknown) => e
  );
  assert.equal(err, controller.signal.reason, 'a plain controller.abort() gives a DOMException named AbortError');
  assert.ok(looksLikeAbort(err));
  assert.equal(fl.calls[0]?.outcome, 'aborted');
  assert.equal(fl.remaining, 1, 'the request was never sent, so the reply stays');
});

test('port: assertDrained counts the port queues and names the ones with replies left', async () => {
  const fl = fakeLlm();
  const port = fl.port({ queues: { plan: ['a plan'], policy: ['one', 'two'], reflect: [] } });
  await port.complete(ask('policy'));

  assert.equal(fl.remaining, 2);
  assert.throws(() => fl.assertDrained(), /2 scripted reply\(ies\) were never used.*left in the port queues: plan 1, policy 1/);
  await port.complete(ask('plan'));
  await port.complete(ask('policy'));
  fl.assertDrained();
});

test('port: it shares the call log and the plain script with the other two surfaces, and a function script answers every call', async () => {
  const fl = fakeLlm(['from generateCompletion', 'from the port']);
  await fl.generateCompletion(SETTINGS, USER, '');
  const out = await fl.port().complete(ask('reflect'));

  assert.equal(out.text, 'from the port');
  assert.deepEqual(fl.calls.map((c) => [c.index, c.via]), [[0, 'generateCompletion'], [1, 'port']]);

  const every = fakeLlm((call) => `${call.via}:${call.node ?? '-'}`);
  assert.equal((await every.port().complete(ask('policy'))).text, 'port:policy');
  assert.throws(() => every.port({ queues: { plan: ['x'] } }), /needs a script that is a list of replies/);
});
