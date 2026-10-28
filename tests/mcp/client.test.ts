/**
 * The MCP client: the loop that asks the model what to do and does it.
 *
 * The client is where a run is won or lost. It holds the conversation with the model, it feeds
 * the tool results back, it keeps the plan checklist in step with what happened, and it decides
 * when the run is over. Every mistake here is quiet: the run ends with an answer about a page it
 * never changed, or it hangs forever, or it reports a step that did not happen.
 *
 * The client talks to the model over HTTP (callProviderWithTools), so the model is a fetch in
 * this file, not a port. The wire format is the provider's own (OpenAI-shaped tool_calls), so
 * the test exercises the real request the extension would send.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { PLAN_FIRST_TEXT, ScoutFoxMCPClient } from '../../src/background/mcp/client.ts';
import { REFLECTION_TEXT, REPEAT_HINT_PREFIX } from '../../src/background/mcp/progress.ts';
import type { RunRecorder } from '../../src/background/mcp/client.ts';
import { cdp } from '../../src/background/browser/cdp.ts';
import { fakeChrome } from '../helpers/fakeChrome.ts';
import { clearEffortCache } from '../../src/background/llm/effort.ts';
import { fakeDom, link } from '../helpers/fakeDom.ts';
import type { RunRuntime } from '../../src/background/runner/runtimeRegistry.ts';
import type { HistoryEntry, RunStatus } from '../../src/background/types.ts';

const PAGE_URL = 'https://shop.test/items';
const DETAIL_URL = 'https://shop.test/items/42';

/** One tool call as a provider answers it. */
function toolCall(name: string, args: Record<string, unknown> = {}, id = 'call_1'): Record<string, unknown> {
  return {
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }]
      },
      finish_reason: 'tool_calls'
    }]
  };
}

/** A plain text answer, as a provider answers a round with no tool call. */
function textReply(text: string): Record<string, unknown> {
  return { choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] };
}

/** A recorder that keeps what the panel would see. */
function makeRecorder(options: { autoApprovePlan?: boolean } = {}) {
  const history: HistoryEntry[] = [];
  const planSteps: Array<{ text: string; status: string }> = [];
  const statuses: Array<{ status: RunStatus; pauseReason?: string | null }> = [];
  const approvals: any[] = [];
  let pending: any = null;

  const recorder: RunRecorder = {
    history,
    planSteps,
    autoApprovePlan: options.autoApprovePlan ?? true,
    recordEntry: (entry) => { history.push(entry); },
    setRunStatus: (status, pauseReason) => { statuses.push({ status, pauseReason }); },
    setPlanSteps: (steps) => { planSteps.length = 0; planSteps.push(...steps); },
    setPendingApproval: (value) => { pending = value; approvals.push(value); },
    resolvePendingApproval: (status, pauseReason) => { statuses.push({ status, pauseReason }); pending = null; },
    endRun: (status, row) => { if (row) history.push(row); statuses.push({ status }); pending = null; return true; }
  };
  return { recorder, history, planSteps, statuses, approvals, pending: () => pending };
}

/** A runtime with the parts the client reads. */
function makeRuntime(activeTabId: number | null = 101): RunRuntime {
  const clock = { now: () => 0, sleep: async () => {} };
  return {
    threadId: '101',
    ownerTabId: 101,
    bootId: 'boot-1',
    control: {
      pauseRequested: false,
      stopRequested: false,
      stepSignal: () => new AbortController().signal,
      abortStep: () => {},
      isUserAbort: () => false,
      snapshot: () => ({ pauseRequested: false, stopRequested: false })
    },
    tabs: { activeTabId, ownerTabId: 101 },
    windowId: 1,
    scoutFoxGroupIds: new Map(),
    attachedTabIds: new Set(),
    resumedAfterRestart: false,
    settings: async () => ({ provider: 'openrouter', model: 'test-model', maxSteps: 20, actionDelayMs: 1 } as any),
    llm: { complete: async () => ({ text: '', provider: 'p', model: 'm', meta: {} }) },
    browser: {
      tabInfo: async (id: number) => {
        const tabs = (globalThis as any).chrome?.tabs;
        if (!tabs?.get) return null;
        const tab = await tabs.get(id).catch(() => null);
        if (!tab) return null;
        return { url: tab.url ?? '', title: tab.title ?? '', windowId: tab.windowId, groupId: tab.groupId ?? -1, status: tab.status ?? 'complete' };
      },
      waitForTabComplete: async () => {},
      waitDomQuiet: async () => {}
    } as any,
    journal: {} as any,
    net: { marker: () => 'm', read: () => '' },
    emit: { enterNode: () => {}, setPhase: () => {} },
    clock
  } as RunRuntime;
}

/**
 * A client over a fake page, with the model answered over the wire.
 *
 * `replies` is the script: one provider answer per model call, in order. A call past the end of
 * the script fails the run, which is what a real provider that stops answering would do.
 */
function withClient(t: any, options: { replies: Array<Record<string, unknown>>; autoApprovePlan?: boolean; settings?: Record<string, unknown> } = { replies: [] }) {
  const fc = fakeChrome({
    tabs: { list: [{ id: 101, url: PAGE_URL, title: 'Items', windowId: 1 }] },
    tabGroups: true,
    dom: true,
    storage: {
      local: {
        data: {
          agent_settings: { provider: 'openrouter', model: 'test-model', maxSteps: 20, actionDelayMs: 1, ...(options.settings || {}) }
        }
      }
    },
    debugger: { commands: { 'Emulation.setFocusEmulationEnabled': {}, 'Input.dispatchMouseEvent': {} } },
    scripting: { executeScript: [{ result: 800 }] }
  });
  const restore = fc.install();
  t.after(async () => {
    await cdp.detachAll();
    restore();
  });
  const site = fakeDom({
    pages: [
      { url: PAGE_URL, title: 'Items', text: ['Item 42 available for 99 USD'], elements: [link('Item 42 Details', DETAIL_URL)] },
      { url: DETAIL_URL, title: 'Item 42', text: ['Item 42 costs 99 USD'], elements: [link('Back', PAGE_URL)] }
    ]
  });
  site.attach(fc as any, 101);

  const requests: Array<{ url: string; body: any }> = [];
  const realFetch = globalThis.fetch;
  let index = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    const raw = typeof init?.body === 'string' ? init.body : '';
    let body: any = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
    requests.push({ url, body });
    const reply = options.replies[index++];
    if (!reply) {
      return new Response(JSON.stringify({ error: { message: 'the model stopped answering' } }), {
        status: 500,
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = realFetch; });

  const runtime = makeRuntime();
  const rec = makeRecorder({ autoApprovePlan: options.autoApprovePlan });
  const client = new ScoutFoxMCPClient(runtime, rec.recorder);
  return { fc, site, client, rec, requests, runtime };
}

/** The rows of one type. */
function rowsOfType(history: HistoryEntry[], type: string): any[] {
  return history.filter((row) => (row as any).type === type);
}

test('a run ends with the answer of the finish tool, and the panel shows it', async (t) => {
  const { client, rec } = withClient(t, {
    replies: [
      toolCall('get_page_elements', {}),
      toolCall('finish', { outcome: 'done', answer: 'It costs 99 USD.' })
    ]
  });
  await client.startTask('What does item 42 cost?');
  const finishes = rowsOfType(rec.history, 'finish');
  assert.equal(finishes.length, 1, 'the run ended once');
  assert.equal(finishes[0].answer, 'It costs 99 USD.');
  assert.ok(rowsOfType(rec.history, 'user_goal').length === 1, 'the task is in the timeline');
});

test('the tool results are fed back to the model, so the model can act on them', async (t) => {
  const { client, requests } = withClient(t, {
    replies: [
      toolCall('read_page', {}),
      toolCall('finish', { outcome: 'done', answer: 'done' })
    ]
  });
  await client.startTask('What does item 42 cost?');
  assert.equal(requests.length, 2, 'the model was asked twice');
  // The second request carries the result of the first tool call, so the model can use it.
  const second = requests[1].body;
  const toolMessages = (second.messages as any[]).filter((m) => m.role === 'tool');
  assert.equal(toolMessages.length, 1, 'the result of the tool went back to the model');
  assert.match(String(toolMessages[0].content), /Item 42 available for 99 USD/, 'the model saw what the page says');
});

test('a failed tool comes back to the model as an error, and the step is shown as failed', async (t) => {
  // The model decides what to do next from the text of the result. A step that did not happen,
  // reported as done, is how a run ends with an answer about a page it never changed.
  const { client, rec } = withClient(t, {
    replies: [
      toolCall('click', { element_id: 99 }),
      toolCall('finish', { outcome: 'done', answer: 'done' })
    ]
  });
  await client.startTask('Open the details');
  const results = rowsOfType(rec.history, 'execution_result');
  assert.equal(results.length, 2);
  assert.equal(results[0].success, false, 'the click that hit nothing is a failed step');
  assert.match(String(results[0].error), /Error/, 'and the panel is told why');
});

test('the effort is the model\'s reasoning level: full on the first round and after a failed tool, one less on routine rounds', async (t) => {
  clearEffortCache();
  const script = () => [
    toolCall('read_page', {}),
    toolCall('click', { element_id: 99 }),
    toolCall('read_page', {}),
    toolCall('finish', { outcome: 'done', answer: 'done' })
  ];
  const { client, requests } = withClient(t, { replies: script() });
  await client.startTask('Open the details', { effort: 'high' });
  const efforts = requests.map((request) => request.body?.reasoning?.effort);
  assert.deepEqual(efforts, ['high', 'medium', 'high', 'medium'], 'round 3 follows the failed click, so it thinks at the full level');
  assert.equal(requests.length, 4, 'the effort never changed the number of rounds');
});

test('with "same as the chosen effort" every round gets the chosen level, and Auto sends nothing', async (t) => {
  clearEffortCache();
  const { client, requests } = withClient(t, {
    replies: [toolCall('read_page', {}), toolCall('finish', { outcome: 'done', answer: 'done' })],
    settings: { effortAdaptive: false }
  });
  await client.startTask('Read it', { effort: 'low' });
  assert.deepEqual(requests.map((request) => request.body?.reasoning?.effort), ['low', 'low']);

  const auto = withClient(t, { replies: [toolCall('finish', { outcome: 'done', answer: 'done' })] });
  await auto.client.startTask('Read it');
  assert.equal('reasoning' in auto.requests[0].body, false, 'no effort chosen: no reasoning field');
});

test('the model is asked for the tools, so it can call them', async (t) => {
  const { client, requests } = withClient(t, { replies: [toolCall('finish', { outcome: 'done', answer: 'done' })] });
  await client.startTask('Say something');
  const body = requests[0].body;
  const names = (body.tools as any[]).map((tool) => tool.function.name);
  assert.ok(names.includes('finish'), 'the finish tool is offered');
  assert.ok(names.includes('get_page_elements'), 'the element list is offered');
  assert.equal(body.tool_choice, 'auto');
});

test('a plain text reply ends the run, and the text is the answer', async (t) => {
  // A model that ignores the tools and answers in prose still ends the run: the user gets an
  // answer instead of a run that spins forever.
  const { client, rec } = withClient(t, { replies: [textReply('The price is 99 USD.')] });
  await client.startTask('What does item 42 cost?');
  const finishes = rowsOfType(rec.history, 'finish');
  assert.equal(finishes.length, 1);
  assert.equal(finishes[0].answer, 'The price is 99 USD.');
});

test('a plain text reply that is a JSON object ends the run with the sentence inside it', async (t) => {
  // A model that forgets it is talking to a person answers with a JSON object. The run must
  // still end, and the answer the user reads must be the sentence, not the braces.
  const raw = JSON.stringify({
    subgoal_done: {
      summary: 'Item 42 costs 99 USD.',
      evidence: 'The price line on the page reads "Item 42 costs 99 USD".'
    }
  });
  const { client, rec } = withClient(t, { replies: [textReply(raw)] });
  await client.startTask('What does item 42 cost?');

  const finishes = rowsOfType(rec.history, 'finish');
  assert.equal(finishes.length, 1, 'the run ended');
  assert.equal(finishes[0].answer, 'Item 42 costs 99 USD.', 'the answer is the sentence');
  assert.doesNotMatch(finishes[0].answer, /subgoal_done/, 'and not the JSON');
  assert.equal(finishes[0].evidence, 'The price line on the page reads "Item 42 costs 99 USD".',
    'the evidence is kept apart from the answer');
});

test('a plain text reply in prose is stored exactly as it was written', async (t) => {
  const { client, rec } = withClient(t, { replies: [textReply('The price is 99 USD.')] });
  await client.startTask('What does item 42 cost?');
  const finishes = rowsOfType(rec.history, 'finish');
  assert.equal(finishes[0].answer, 'The price is 99 USD.');
  assert.equal(finishes[0].evidence, undefined, 'and there is no evidence');
});

test('a model that fails ends the run with an error, instead of spinning', async (t) => {
  const { client, rec } = withClient(t, { replies: [] });
  await client.startTask('What does item 42 cost?');
  const errors = rowsOfType(rec.history, 'error');
  assert.equal(errors.length, 1, 'the failure is in the timeline');
  assert.ok(rec.statuses.some((s) => s.status === 'error'), 'and the run is not running any more');
});

test('the plan becomes the checklist of the panel, and the steps are ticked off as they work', async (t) => {
  const { client, rec } = withClient(t, {
    replies: [
      toolCall('update_plan', { plan: ['Open the details', 'Read the price'] }),
      toolCall('get_page_elements', {}),
      toolCall('read_page', {}),
      toolCall('finish', { outcome: 'done', answer: 'done' })
    ]
  });
  await client.startTask('Find the price of item 42');
  assert.deepEqual(rec.planSteps.map((s) => s.text), ['Open the details', 'Read the price']);
  // Every step that worked is ticked off, in the order the work was done.
  assert.deepEqual(rec.planSteps.map((s) => s.status), ['completed', 'completed']);
});

test('a plan needs the user to approve it, and the run waits for the decision', async (t) => {
  const { client, rec } = withClient(t, {
    autoApprovePlan: false,
    replies: [
      toolCall('update_plan', { plan: ['Open the details'] }),
      toolCall('finish', { outcome: 'done', answer: 'done' })
    ]
  });
  const running = client.startTask('Find the price of item 42');
  // The run holds at the plan card until the user decides.
  for (let i = 0; i < 50 && rec.approvals.length === 0; i++) await new Promise((r) => setImmediate(r));
  assert.equal(rec.approvals.length, 1, 'the plan card went up');
  assert.deepEqual(rec.approvals[0].plan, ['Open the details']);
  assert.ok(rec.statuses.some((s) => s.status === 'paused'), 'the run waits at the card');

  client.handleApprovePlan(true);
  await running;
  assert.ok(rec.statuses.some((s) => s.status === 'running'), 'the run went on after the approval');
  assert.equal(rowsOfType(rec.history, 'finish').length, 1, 'and it finished');
});

test('a plan the user rejects ends the run, and no action is taken', async (t) => {
  const { client, rec, site } = withClient(t, {
    autoApprovePlan: false,
    replies: [
      toolCall('update_plan', { plan: ['Open the details'] }),
      toolCall('click', { element_id: 1 })
    ]
  });
  const running = client.startTask('Find the price of item 42');
  for (let i = 0; i < 50 && rec.approvals.length === 0; i++) await new Promise((r) => setImmediate(r));
  client.handleApprovePlan(false);
  await running;

  assert.equal(site.actions.length, 0, 'no action was taken after the rejection');
  const finishes = rowsOfType(rec.history, 'finish');
  assert.equal(finishes.length, 1);
  assert.match(String(finishes[0].answer), /cancel/i, 'the user is told the plan was cancelled');
});

test('a stop ends the run at once, and the plan card is released', async (t) => {
  const { client, rec } = withClient(t, {
    autoApprovePlan: false,
    replies: [toolCall('update_plan', { plan: ['Open the details'] })]
  });
  const running = client.startTask('Find the price of item 42');
  for (let i = 0; i < 50 && rec.approvals.length === 0; i++) await new Promise((r) => setImmediate(r));
  client.stop();
  await running;
  // A stop is the user's own decision, not a result of the run: the runner broadcasts the
  // stopped status, and the client leaves the timeline alone. What matters is that the plan
  // card does not hold the run any more.
  assert.equal(rec.pending(), null, 'the plan card was released');
  assert.ok(!rec.statuses.some((s) => s.status === 'running'), 'the run is not running any more');
});

test('two tool calls in one round are both executed, in order', async (t) => {
  const { client, rec } = withClient(t, {
    replies: [
      {
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'get_page_elements', arguments: '{}' } },
              { id: 'c2', type: 'function', function: { name: 'read_page', arguments: '{}' } }
            ]
          },
          finish_reason: 'tool_calls'
        }]
      },
      toolCall('finish', { outcome: 'done', answer: 'done' })
    ]
  });
  await client.startTask('Look at the page');
  const actions = rowsOfType(rec.history, 'agent_response').map((row) => row.action.action);
  // Both calls of the round ran, in the order the model asked for them. The finish of the next
  // round is after them, so it is not part of this pair.
  assert.deepEqual(actions.slice(0, 2), ['get_page_elements', 'read_page'], 'both calls of the round ran');
});

test('a tool call with broken arguments does not stop the run', async (t) => {
  // The model sends malformed JSON now and then. The run goes on: the tool complains and the
  // model gets another turn.
  const { client, rec } = withClient(t, {
    replies: [
      {
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'click', arguments: '{not json' } }]
          },
          finish_reason: 'tool_calls'
        }]
      },
      toolCall('finish', { outcome: 'done', answer: 'done' })
    ]
  });
  await client.startTask('Click something');
  assert.equal(rowsOfType(rec.history, 'finish').length, 1, 'the run reached the end');
});

test('the first call to the model carries the page it starts on', async (t) => {
  // The model has to know where it is, or its first tool call is a guess.
  const { client, requests } = withClient(t, { replies: [toolCall('finish', { outcome: 'done', answer: 'done' })] });
  await client.startTask('What does item 42 cost?');
  const user = (requests[0].body.messages as any[]).find((m) => m.role === 'user');
  assert.match(String(user?.content), /TASK: What does item 42 cost\?/);
  assert.match(String(user?.content), /https:\/\/shop\.test\/items/, 'the model is told the page it is on');
});

// ---------------------------------------------------------------------------------------------
// Pause and Resume, and the user's own instructions
// ---------------------------------------------------------------------------------------------

/** Waits until `count` requests went out. */
async function untilRequests(requests: unknown[], count: number) {
  for (let i = 0; i < 400 && requests.length < count; i++) await new Promise((r) => setTimeout(r, 2));
  assert.ok(requests.length >= count, `${count} request(s) went out`);
}

test('Pause then Resume while the model is answering leaves exactly one loop running', async (t) => {
  // The first model call hangs until it is aborted; every later call answers at once.
  const { client, requests, rec } = withClient(t, { replies: [] });
  const realFetch = globalThis.fetch;
  let n = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, body: JSON.parse(String(init?.body || 'null')) });
    n += 1;
    if (n === 1) {
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true }));
    }
    const reply = n === 2 ? toolCall('read_page', {}) : toolCall('finish', { outcome: 'done', answer: 'once' });
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = realFetch; });

  const running = client.startTask('Read the page');
  await untilRequests(requests, 1);
  client.stop();      // Pause: the hanging request is cancelled
  client.resume();    // Resume at once: a new loop
  await running;
  for (let i = 0; i < 400 && rowsOfType(rec.history, 'finish').length === 0; i++) await new Promise((r) => setTimeout(r, 2));

  assert.equal(rowsOfType(rec.history, 'finish').length, 1, 'the run finished once');
  assert.equal(requests.length, 3, 'the cancelled call, then one loop of two calls; no second loop asked the model');
  assert.ok(!rec.statuses.some((s) => s.status === 'error'), 'the cancelled request is not an error of the run');
});

test('a Pause between two tool calls still answers both, so Resume sends a valid history', async (t) => {
  const { client, requests, rec } = withClient(t, {
    replies: [
      {
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'read_page', arguments: '{}' } },
              { id: 'c2', type: 'function', function: { name: 'get_page_elements', arguments: '{}' } }
            ]
          },
          finish_reason: 'tool_calls'
        }]
      },
      toolCall('finish', { outcome: 'done', answer: 'resumed fine' })
    ]
  });
  // Pause as soon as the first tool's result row is recorded.
  const recordEntry = rec.recorder.recordEntry;
  let paused = false;
  (rec.recorder as any).recordEntry = (entry: HistoryEntry) => {
    recordEntry(entry);
    if (!paused && (entry as any).type === 'execution_result') { paused = true; client.stop(); }
  };
  await client.startTask('Look at the page');
  assert.equal(requests.length, 1, 'the loop stopped after the paused round');

  client.resume();
  for (let i = 0; i < 400 && rowsOfType(rec.history, 'finish').length === 0; i++) await new Promise((r) => setTimeout(r, 2));
  const messages = requests[1].body.messages as any[];
  const replies = messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
  assert.deepEqual(replies, ['c1', 'c2'], 'every tool call of the paused round has a reply');
  assert.match(String(messages.find((m) => m.tool_call_id === 'c2').content), /Not run: the run was paused/);
  assert.equal(rowsOfType(rec.history, 'finish')[0].answer, 'resumed fine');
});

test('the user\'s system instructions from Settings reach the model', async (t) => {
  const { client, requests } = withClient(t, { replies: [toolCall('finish', { outcome: 'done', answer: 'done' })] });
  await (globalThis as any).chrome.storage.local.set({ agent_settings: { provider: 'openrouter', model: 'test-model', maxSteps: 20, actionDelayMs: 1, systemInstructions: 'Always answer in German.' } });
  await client.startTask('What is here?');
  const system = (requests[0].body.messages as any[]).find((m) => m.role === 'system');
  assert.match(String(system.content), /Always answer in German\./);
});

test('manual approval: a model that skips the plan is held until it asks for approval', async (t) => {
  const { client, rec, requests } = withClient(t, {
    autoApprovePlan: false,
    replies: [toolCall('read_page', {}), toolCall('update_plan', { plan: ['Read the page'] }), toolCall('finish', { outcome: 'done', answer: 'done' })]
  });
  const running = client.startTask('What is here?');
  for (let i = 0; i < 400 && rec.approvals.filter(Boolean).length === 0; i++) await new Promise((r) => setTimeout(r, 2));
  const firstResult = (requests[1].body.messages as any[]).find((m) => m.role === 'tool');
  assert.match(String(firstResult.content), /manual approval is on/i, 'the read before the plan was refused');
  assert.equal(rowsOfType(rec.history, 'agent_response').filter((r) => r.action.action === 'read_page').length, 1);
  assert.ok(rec.pending(), 'the plan card is up');
  client.handleApprovePlan(true);
  await running;
  assert.equal(rowsOfType(rec.history, 'finish')[0].answer, 'done');
});

test('at the step limit the model gets one round with only finish, and the run ends', async (t) => {
  const { client, rec, requests } = withClient(t, {
    replies: [toolCall('read_page', {}), toolCall('read_page', {}), toolCall('finish', { outcome: 'done', answer: 'what I found' })]
  });
  await (globalThis as any).chrome.storage.local.set({ agent_settings: { provider: 'openrouter', model: 'test-model', maxSteps: 2, actionDelayMs: 1 } });
  await client.startTask('Read forever');
  assert.equal(requests.length, 3);
  const last = requests[2].body;
  assert.deepEqual((last.tools as any[]).map((tool) => tool.function.name), ['finish'], 'only finish is offered at the limit');
  assert.match(String((last.messages as any[]).at(-1).content), /STEP LIMIT/);
  assert.equal(rowsOfType(rec.history, 'finish')[0].answer, 'what I found');
});

test('a passing provider error (a 500) is retried, and the run goes on', async (t) => {
  const { client, rec, requests, runtime } = withClient(t, { replies: [] });
  (runtime as any).clock = { now: () => 0, sleep: async () => {} };
  const realFetch = globalThis.fetch;
  let n = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), body: JSON.parse(String(init?.body || 'null')) });
    n += 1;
    if (n === 1) return new Response('{"message":"Failed to generate completions"}', { status: 500 });
    return new Response(JSON.stringify(toolCall('finish', { outcome: 'done', answer: 'after a retry' })), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  await client.startTask('Anything');
  assert.equal(rowsOfType(rec.history, 'finish')[0]?.answer, 'after a retry');
  assert.ok(!rec.statuses.some((s) => s.status === 'error'));
});

test('a burst of 500s and then a 429 is waited out with longer pauses, and the run goes on', async (t) => {
  const { PROVIDER_RETRY_DELAYS_MS } = await import('../../src/background/mcp/client.ts');
  const { client, rec, requests, runtime } = withClient(t, { replies: [] });
  const waits: number[] = [];
  (runtime as any).clock = { now: () => 0, sleep: async (ms: number) => { waits.push(ms); } };
  const realFetch = globalThis.fetch;
  const failures = [500, 500, 429];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), body: JSON.parse(String(init?.body || 'null')) });
    const status = failures.shift();
    if (status) return new Response('{"title":"Too Many Requests"}', { status });
    return new Response(JSON.stringify(toolCall('finish', { outcome: 'done', answer: 'after the rate limit' })), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  await client.startTask('Anything');
  assert.equal(rowsOfType(rec.history, 'finish')[0]?.answer, 'after the rate limit');
  assert.deepEqual(waits.filter((ms) => PROVIDER_RETRY_DELAYS_MS.includes(ms)), PROVIDER_RETRY_DELAYS_MS.slice(0, 3));
  assert.ok(PROVIDER_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0) >= 30000, 'the retries span long enough for a rate limit');
});

test('a refused request (a 400) is not retried', async (t) => {
  const { client, rec, requests } = withClient(t, { replies: [] });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), body: null });
    return new Response('{"error":"bad request"}', { status: 400 });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  await client.startTask('Anything');
  assert.equal(requests.length, 1);
  assert.ok(rec.statuses.some((s) => s.status === 'error'));
});

test('a model call that times out is tried once more, and a second timeout ends the run', async (t) => {
  const { client, rec, requests } = withClient(t, { replies: [] });
  await (globalThis as any).chrome.storage.local.set({ agent_settings: { provider: 'openrouter', model: 'test-model', maxSteps: 20, actionDelayMs: 1, llmTimeoutMs: 20 } });
  const realFetch = globalThis.fetch;
  let n = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), body: null });
    n += 1;
    if (n === 1) return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true }));
    return new Response(JSON.stringify(toolCall('finish', { outcome: 'done', answer: 'second try' })), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  await client.startTask('Anything');
  assert.equal(rowsOfType(rec.history, 'finish')[0]?.answer, 'second try');
  assert.equal(n, 2);
});

test('a run logs each model call and each step, with a sentence and the details as JSON', async (t) => {
  const { Logger } = await import('../../src/shared/logger.ts');
  Logger.clearLogs();
  const { client } = withClient(t, {
    replies: [toolCall('get_page_elements', { reason: 'to see the buttons' }), toolCall('finish', { outcome: 'done', answer: 'It costs 99 USD.' })]
  });
  await client.startTask('What does item 42 cost?');
  const logs = Logger.getLogsHistory();
  const llm = logs.filter((l) => l.kind === 'llm');
  const steps = logs.filter((l) => l.kind === 'tool');
  assert.equal(llm.length, 4, 'two entries per model call: when it starts and what came back');
  // The start line comes before the request, so a call that never comes back is still in the log.
  assert.match(llm[0].message, /^Model call 1 started \(test-model\)$/);
  assert.equal(JSON.parse(llm[0].data!).round, 1);
  assert.match(llm[1].message, /^Model call 1 \(test-model\): chose get_page_elements$/);
  assert.match(llm[2].message, /^Model call 2 started \(test-model\)$/);
  const call = JSON.parse(llm[1].data!);
  assert.equal(call.response.tool_calls[0].name, 'get_page_elements');
  assert.ok(call.request.messages.length >= 2, 'what was sent is in the details');
  assert.match(steps[0].message, /^Listing the elements on the page it can act on - to see the buttons$/);
  assert.equal(JSON.parse(steps[0].data!).tool, 'get_page_elements');
  assert.ok(logs.some((l) => l.kind === 'agent' && /^Finished after 2 steps: It costs 99 USD\.$/.test(l.message)));
});

test('a failed model attempt that is retried is a warning in the log, not an error', async (t) => {
  const { Logger } = await import('../../src/shared/logger.ts');
  Logger.clearLogs();
  const { client, requests } = withClient(t, { replies: [] });
  const realFetch = globalThis.fetch;
  let n = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), body: null });
    n += 1;
    if (n === 1) return new Response('{"message":"Failed to generate completions"}', { status: 500 });
    return new Response(JSON.stringify(toolCall('finish', { outcome: 'done', answer: 'ok' })), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  await client.startTask('Anything');
  const failed = Logger.getLogsHistory().filter((l) => l.kind === 'llm' && /failed/.test(l.message));
  assert.equal(failed.length, 1);
  assert.equal(failed[0].level, 'WARN');
  assert.ok(!Logger.getLogsHistory().some((l) => l.level === 'ERROR'), 'the run did not fail, so nothing is an error');
});

// ---- the repeat guard (progress.ts) in the live loop ----------------------------------------------

/** The messages of one request, and where the reflection notes sit in it. */
function reflectionsOf(request: { body: any }): number[] {
  return (request.body.messages as any[]).flatMap((m, i) => (m.role === 'user' && m.content === REFLECTION_TEXT ? [i] : []));
}

test('repeat guard: a repeated read gets the hint in its result, and stuck steps add one reflection after the tool block', async (t) => {
  const { Logger } = await import('../../src/shared/logger.ts');
  Logger.clearLogs();
  const { client, requests, rec } = withClient(t, {
    replies: [...Array.from({ length: 5 }, (_, i) => toolCall('read_page', { reason: `look ${i}` }, `call_${i}`)), toolCall('finish', { outcome: 'done', answer: 'The page did not change.' })]
  });
  await client.startTask('Watch this page');
  assert.equal(requests.length, 6);
  const lastTool = (i: number) => String([...(requests[i].body.messages as any[])].reverse().find((m) => m.role === 'tool').content);
  assert.doesNotMatch(lastTool(1), new RegExp(REPEAT_HINT_PREFIX.replace(/[()]/g, '\\$&')), 'the first read is not a repeat');
  assert.match(lastTool(2), /Same text as your last read/);
  assert.ok(lastTool(2).includes(REPEAT_HINT_PREFIX), 'the second identical read carries the hint');
  assert.match(lastTool(2), /read_page \{part\}/);
  // Reads 2-5 changed nothing: 4 of the last 6 steps, so the 6th request carries the reflection.
  for (let i = 0; i < 5; i++) assert.deepEqual(reflectionsOf(requests[i]), [], `request ${i + 1} has no reflection`);
  const messages = requests[5].body.messages as any[];
  const at = reflectionsOf(requests[5]);
  assert.equal(at.length, 1, 'one reflection');
  assert.equal(at[0], messages.length - 1, 'it is the last message');
  assert.equal(messages[at[0] - 1].role, 'tool', 'right after the tool block');
  assert.equal(messages[at[0] - 2].role, 'assistant', 'and the tool block answers the assistant call before it');
  assert.equal(messages[at[0] - 2].tool_calls[0].id, messages[at[0] - 1].tool_call_id);
  assert.equal(rowsOfType(rec.history, 'finish')[0].answer, 'The page did not change.');
  const logs = Logger.getLogsHistory().filter((l) => l.kind === 'agent');
  assert.ok(logs.some((l) => /^Repeat hint after /.test(l.message)), 'the hint is in the log');
  assert.equal(logs.filter((l) => /^Asked the model to reflect/.test(l.message)).length, 1, 'the reflection is in the log once');
});

test('repeat guard: still stuck, the reflection comes at most once per 6 steps', async (t) => {
  const { client, requests } = withClient(t, {
    replies: [...Array.from({ length: 10 }, (_, i) => toolCall('read_page', {}, `call_${i}`)), toolCall('finish', { outcome: 'done', answer: 'done' })]
  });
  await client.startTask('Watch this page');
  assert.equal(requests.length, 11);
  assert.equal(reflectionsOf(requests[10]).length, 1, 'ten stuck steps, one reflection (the next is due at step 11)');
});

test('repeat guard: PLAN_FIRST refusals never count, and the approval card is never skipped', async (t) => {
  const { client, rec, requests } = withClient(t, {
    autoApprovePlan: false,
    replies: [
      ...Array.from({ length: 6 }, (_, i) => toolCall('read_page', {}, `call_${i}`)),
      toolCall('update_plan', { plan: ['Read the page'] }, 'call_plan'),
      toolCall('finish', { outcome: 'done', answer: 'done' })
    ]
  });
  const running = client.startTask('What is here?');
  for (let i = 0; i < 400 && rec.approvals.filter(Boolean).length === 0; i++) await new Promise((r) => setTimeout(r, 2));
  assert.ok(rec.pending(), 'the plan card is up: six refusals did not get past it');
  client.handleApprovePlan(true);
  await running;
  for (const request of requests) assert.deepEqual(reflectionsOf(request), [], 'no reflection from refused calls');
  const toolTexts = (requests.at(-1)!.body.messages as any[]).filter((m) => m.role === 'tool').map((m) => String(m.content));
  assert.equal(toolTexts.filter((c) => c === PLAN_FIRST_TEXT).length, 6, 'every refusal is the plain refusal, with no hint');
});

test('the finish outcome is stored on the finish row, so the panel card can follow it', async (t) => {
  for (const outcome of ['done', 'partial', 'blocked']) {
    const { client, rec } = withClient(t, { replies: [toolCall('finish', { outcome, answer: `it went ${outcome}` })] });
    await client.startTask('Anything');
    const finish = rowsOfType(rec.history, 'finish')[0];
    assert.equal(finish.outcome, outcome);
    assert.equal(finish.answer, `it went ${outcome}`);
  }
});

test('the finish tool requires an outcome of done, partial or blocked', async () => {
  const { TOOL_MAP } = await import('../../src/background/mcp/tools.ts');
  const schema = TOOL_MAP.get('finish')!.inputSchema as any;
  assert.deepEqual(schema.required, ['answer', 'outcome']);
  assert.deepEqual(schema.properties.outcome.enum, ['done', 'partial', 'blocked']);
  assert.match(schema.properties.outcome.description, /"blocked": you could not do it/);
});

test('a finish without a valid outcome is refused once, without a step, and the next finish ends the run', async (t) => {
  const { FINISH_OUTCOME_TEXT } = await import('../../src/background/mcp/client.ts');
  const { client, rec, requests } = withClient(t, {
    replies: [toolCall('finish', { answer: 'all good' }), toolCall('finish', { answer: 'all good', outcome: 'maybe' }), toolCall('finish', { answer: 'all good', outcome: 'done' })]
  });
  await client.startTask('Anything');
  assert.equal(requests.length, 3, 'the model was asked again twice');
  const toolReplies = (requests[1].body.messages as any[]).filter((m) => m.role === 'tool');
  assert.equal(toolReplies.at(-1).content, FINISH_OUTCOME_TEXT, 'the model is told what outcome means');
  const finishes = rowsOfType(rec.history, 'finish');
  assert.equal(finishes.length, 1, 'only the valid finish ended the run');
  assert.equal(finishes[0].outcome, 'done');
  assert.equal(rowsOfType(rec.history, 'execution_result').length, 1, 'the refused finishes left no failed step rows');
  assert.equal(rowsOfType(rec.history, 'agent_response').length, 1, 'and no action rows');
});

test('at the step limit a finish without an outcome still ends the run, as partial', async (t) => {
  const { client, rec } = withClient(t, {
    replies: [toolCall('read_page', {}), toolCall('read_page', {}), toolCall('finish', { answer: 'what I found' })],
    settings: { maxSteps: 2 }
  });
  await client.startTask('Read forever');
  const finish = rowsOfType(rec.history, 'finish')[0];
  assert.equal(finish.answer, 'what I found');
  assert.equal(finish.outcome, 'partial');
});

test('a plain-text answer at the step limit ends the run as partial; a plain-text reply otherwise has no outcome', async (t) => {
  const limited = withClient(t, { replies: [toolCall('read_page', {}), textReply('I ran out of steps.')], settings: { maxSteps: 1 } });
  await limited.client.startTask('Read forever');
  assert.equal(rowsOfType(limited.rec.history, 'finish')[0].outcome, 'partial');
  const plain = withClient(t, { replies: [textReply('It costs 99 USD.')] });
  await plain.client.startTask('What does it cost?');
  assert.equal(rowsOfType(plain.rec.history, 'finish')[0].outcome, undefined);
});
