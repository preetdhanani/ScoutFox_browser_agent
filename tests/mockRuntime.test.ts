/**
 * Tests for tests/helpers/mockRuntime.ts, the shared RunRuntime of the graph tests.
 *
 * One test, on purpose: the six hand-rolled copies are not migrated yet, so this only has to show
 * that the shared one is a complete runtime, that the partial overrides keep the other defaults,
 * that registration cleans up after itself, and that the real orchestrator graph runs over it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Command } from '@langchain/langgraph/web';
import { buildOrchestratorGraph } from '../src/background/graph/orchestrator.ts';
import { runtimeRegistry } from '../src/background/runner/runtimeRegistry.ts';
import { SessionStorageSaver } from '../src/background/checkpoint/SessionStorageSaver.ts';
import { createFakeStorage } from './helpers/fakeStorageSession.ts';
import { MOCK_NOW, createMockRuntime, mockSnapshot, registerMockRuntime } from './helpers/mockRuntime.ts';

test('mockRuntime: a complete runtime, partial overrides, registration that cleans up, and a real graph run over it', async () => {
  // 1. Every member of RunRuntime is there, and the control flags are live (a spread would have frozen them).
  const rt = createMockRuntime('thread-mock-shape');
  assert.deepEqual(
    Object.keys(rt).sort(),
    ['attachedTabIds', 'bootId', 'browser', 'clock', 'control', 'emit', 'journal', 'llm', 'net', 'ownerTabId', 'resumedAfterRestart', 'scoutFoxGroupIds', 'settings', 'tabs', 'threadId', 'windowId']
  );
  assert.equal(runtimeRegistry.get('thread-mock-shape'), undefined, 'createMockRuntime registers nothing');
  assert.deepEqual(rt.control.snapshot(), { pauseRequested: false, stopRequested: false });
  assert.equal(rt.control.stepSignal().aborted, false);
  rt.control.abortStep('user_stop');
  const signal = rt.control.stepSignal();
  assert.equal(signal.aborted, true);
  assert.deepEqual(signal.reason, { scoutfox: 'user', reason: 'user_stop' });
  assert.equal(rt.control.isUserAbort(new Error('x'), signal), true);
  assert.equal(rt.control.isUserAbort(new Error('x'), new AbortController().signal), false);
  assert.equal(rt.clock.now(), MOCK_NOW);
  await rt.clock.sleep(60_000);

  // 2. A partial override of an object member keeps the other methods; a top-level member replaces the default.
  const navigated: string[] = [];
  const custom = createMockRuntime('thread-mock-merge', {
    ownerTabId: 205,
    windowId: 7,
    browser: { navigate: async (_tab, url) => void navigated.push(url) },
    control: { pauseRequested: true },
    clock: { now: () => 5 },
  });
  await custom.browser.navigate(205, 'https://shop.test/other');
  assert.deepEqual(navigated, ['https://shop.test/other']);
  assert.equal((await custom.browser.snapshot(205, { showBadges: false, maxElements: 10 }) as { title: string }).title, 'Shop Item Page', 'the snapshot default is still there');
  assert.equal((await custom.browser.execute(205, { action: 'click', element_id: 1 } as never, { docId: 'd', mode: 'synthetic' })).effect, 'dom_changed');
  assert.equal(custom.control.pauseRequested, true, 'a flag given in control is applied through the setter');
  assert.equal(custom.control.snapshot().pauseRequested, true);
  assert.equal(custom.ownerTabId, 205);
  assert.equal(custom.tabs.activeTabId, 205, 'the active tab follows the owner tab');
  assert.equal(custom.windowId, 7);
  assert.equal(custom.clock.now(), 5);
  assert.equal(typeof custom.clock.sleep, 'function', 'the clock keeps its other default');
  assert.equal(mockSnapshot({ title: 'Other' }).title, 'Other');
  await assert.rejects(createMockRuntime('thread-mock-reflect').llm.complete({ node: 'reflect', role: 'reflect', system: '', messages: [], schema: null, signal: new AbortController().signal }), /no reflect reply/);

  // 3. registerMockRuntime puts the runtime in the registry and takes it out when the test context says so.
  const hooks: Array<() => void | Promise<void>> = [];
  const registered = registerMockRuntime('thread-mock-registered', {}, { after: (fn) => void hooks.push(fn) });
  assert.equal(runtimeRegistry.get('thread-mock-registered'), registered);
  for (const hook of hooks.splice(0)) await hook();
  assert.equal(runtimeRegistry.get('thread-mock-registered'), undefined);

  // 4. The real orchestrator graph runs a whole task over the defaults: plan, approve, worker, finish.
  const threadId = 'thread-mock-run';
  registerMockRuntime(threadId, {}, { after: (fn) => void hooks.push(fn) });
  const graph = buildOrchestratorGraph(new SessionStorageSaver(createFakeStorage().connect().session as never));
  const cfg = { configurable: { thread_id: threadId }, streamMode: 'values' as const };
  for await (const _chunk of await graph.stream({ task: 'Find the price', effort: { requested: 'low', level: 'low', suggestedBy: 'user' } }, cfg)) {
    // runs up to the plan approval hold
  }
  let last: { history?: Array<{ type: string; answer?: string }> } | null = null;
  for await (const chunk of await graph.stream(new Command({ resume: { kind: 'approve' } }), cfg)) last = chunk;
  assert.equal(last?.history?.find((h) => h.type === 'finish')?.answer, 'Mock answer.');
  for (const hook of hooks.splice(0)) await hook();
  assert.equal(runtimeRegistry.get(threadId), undefined);
});
