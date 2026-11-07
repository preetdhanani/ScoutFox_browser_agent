/**
 * The picture's journey through the MCP client: src/background/mcp/client.ts.
 *
 * The rule that shapes the whole design: a `role:'tool'` message can only carry TEXT on every
 * provider (OpenAI's own type says so, and Ollama's converter builds `images` only for a user
 * message). So a picture travels in ONE `role:'user'` message AFTER the complete tool block.
 *
 * Getting this shape wrong is quiet and expensive: an interleaved user message breaks the
 * tool-call pairing that OpenAI-compatible servers and Ollama's chat template validate, and the
 * run dies with an opaque 400 on a round where the model asked for two tools.
 *
 * What these tests hold on to:
 *   1. The picture is NOT in the tool message; it is in a user message that follows the block.
 *   2. With two tool calls in one round the order is assistant, tool, tool, user - never
 *      assistant, tool, user, tool.
 *   3. The history row carries the picture's id and size, and NOT the bytes.
 *   4. After three pictures, only the last two keep their bytes, and the tool block above the
 *      trimmed one is still contiguous.
 *   5. A provider that refuses a picture does not end the run: the round is retried once without
 *      the pictures, and the tool is no longer offered.
 *   6. A model known to be blind is not offered the screenshot tool at all.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  KEPT_PICTURES,
  TarkaMCPClient,
  TRIMMED_PICTURE_TEXT,
  UNSEEN_PICTURE_TEXT,
  carriesPicture,
  looksLikeImageRejection,
  pictureBlocks,
  stripPictures,
  trimPictures,
  type Message
} from '../../src/background/mcp/client.ts';
import type { RunRecorder } from '../../src/background/mcp/client.ts';
import { cdp } from '../../src/background/browser/cdp.ts';
import { fakeChrome } from '../helpers/fakeChrome.ts';
import { fakeDom, link } from '../helpers/fakeDom.ts';
import { clearVisionCache } from '../../src/background/llm/vision.ts';
import type { RunRuntime } from '../../src/background/runner/runtimeRegistry.ts';
import type { ScreenshotDeps } from '../../src/background/browser/screenshot.ts';
import type { HistoryEntry, RunStatus } from '../../src/background/types.ts';

const PAGE_URL = 'https://shop.test/items';

/** A JPEG header that says w by h, base64. */
function jpeg(w: number, h: number): string {
  return Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08,
    (h >> 8) & 0xff, h & 0xff,
    (w >> 8) & 0xff, w & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xff, 0xd9
  ]).toString('base64');
}

/** One tool call of a provider answer. */
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

/** Two tool calls in one round, which is the round the shape has to survive. */
function twoToolCalls(first: { name: string; args?: Record<string, unknown> }, second: { name: string; args?: Record<string, unknown> }): Record<string, unknown> {
  return {
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: first.name, arguments: JSON.stringify(first.args ?? {}) } },
          { id: 'c2', type: 'function', function: { name: second.name, arguments: JSON.stringify(second.args ?? {}) } }
        ]
      },
      finish_reason: 'tool_calls'
    }]
  };
}

function makeRecorder() {
  const history: HistoryEntry[] = [];
  const planSteps: Array<{ text: string; status: string }> = [];
  const statuses: Array<{ status: RunStatus; pauseReason?: string | null }> = [];
  const recorder: RunRecorder = {
    history,
    planSteps,
    autoApprovePlan: true,
    recordEntry: (entry) => { history.push(entry); },
    setRunStatus: (status, pauseReason) => { statuses.push({ status, pauseReason }); },
    setPlanSteps: (steps) => { planSteps.length = 0; planSteps.push(...steps); },
    setPendingApproval: () => {},
    resolvePendingApproval: (status, pauseReason) => { statuses.push({ status, pauseReason }); },
    endRun: (status, row) => { if (row) history.push(row); statuses.push({ status }); return true; }
  };
  return { recorder, history, statuses };
}

function makeRuntime(): RunRuntime {
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
    tabs: { activeTabId: 101, ownerTabId: 101 },
    windowId: 1,
    tarkaGroupIds: new Map(),
    attachedTabIds: new Set(),
    resumedAfterRestart: false,
    settings: async () => ({ provider: 'openrouter', model: 'test-model' } as any),
    llm: { complete: async () => ({ text: '', provider: 'p', model: 'm', meta: {} }) },
    browser: {
      tabInfo: async (id: number) => {
        const tab = await (globalThis as any).chrome.tabs.get(id).catch(() => null);
        if (!tab) return null;
        return { url: tab.url ?? '', title: tab.title ?? '', windowId: 1, groupId: -1, status: 'complete' };
      },
      isTabInScope: async () => true,
      waitForTabComplete: async () => {},
      waitDomQuiet: async () => {}
    } as any,
    journal: {} as any,
    net: { marker: () => 'm', read: () => '' },
    emit: { enterNode: () => {}, setPhase: () => {} },
    clock: { now: () => 0, sleep: async () => {} }
  } as RunRuntime;
}

/** A capture path that answers with a picture of the given size, and nothing from Chrome. */
function fakeCapture(width = 1280, height = 720): (tabId: number) => ScreenshotDeps {
  return () => ({
    isTabInScope: async () => true,
    sendCommand: async () => ({ data: jpeg(width, height) }),
    page: {
      tabUrl: async () => PAGE_URL,
      probe: async () => ({ width, height, devicePixelRatio: 1, scrollX: 0, scrollY: 0, scale: 1 }),
      signature: async () => ({ interactiveHash: 'a', textHash: 'b' }),
      hideUi: async () => true,
      showUi: async () => {}
    }
  });
}

/** A client over a fake page, with the model answered over the wire. Screenshots are scripted, not Chrome's. */
function withClient(
  t: any,
  options: {
    replies: Array<Record<string, unknown>>;
    provider?: string;
    capture?: (tabId: number) => ScreenshotDeps;
    capabilities?: string[];
    screenshots?: string;
  }
) {
  clearVisionCache();
  const fc = fakeChrome({
    tabs: { list: [{ id: 101, url: PAGE_URL, title: 'Items', windowId: 1 }] },
    tabGroups: true,
    dom: true,
    storage: {
      local: {
        data: {
          agent_settings: {
            provider: options.provider ?? 'openrouter',
            model: 'test-model',
            maxSteps: 20,
            actionDelayMs: 1,
            ...(options.screenshots ? { screenshots: options.screenshots } : {})
          }
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
    pages: [{ url: PAGE_URL, title: 'Items', text: ['Item 42 available for 99 USD'], elements: [link('Item 42 Details', PAGE_URL)] }]
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
    // Ollama's capability probe, so the vision check can answer for an Ollama model.
    if (url.endsWith('/api/show')) {
      return new Response(JSON.stringify({ model_info: {}, capabilities: options.capabilities ?? ['completion', 'tools'] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    const reply: any = options.replies[index++];
    if (!reply) {
      return new Response(JSON.stringify({ error: { message: 'the model stopped answering' } }), {
        status: 500,
        headers: { 'content-type': 'application/json' }
      });
    }
    // The marker a test uses for "the provider refused this request".
    if (reply.__httpError) {
      return new Response(JSON.stringify({ error: { message: reply.message } }), {
        status: reply.status ?? 400,
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = realFetch; });

  const runtime = makeRuntime();
  const rec = makeRecorder();
  const client = new TarkaMCPClient(runtime, rec.recorder);
  client.setScreenshotDeps(options.capture ?? fakeCapture());
  return { fc, site, client, rec, requests };
}

/** The messages of one request, as the provider received them. */
const messagesOf = (request: { body: any }): any[] => request.body?.messages ?? [];

// ---------------------------------------------------------------------------------------------
// The message shape
// ---------------------------------------------------------------------------------------------

test('the picture is in a user message after the tool block, never in the tool message', async (t) => {
  const { client, requests } = withClient(t, {
    replies: [toolCall('take_screenshot'), toolCall('finish', { outcome: 'done', answer: 'It is there.' })]
  });
  await client.startTask('Look at the page');

  // The second request is the one that carries the picture back to the model.
  const messages = messagesOf(requests[1]);
  const toolMessages = messages.filter((m) => m.role === 'tool');
  assert.equal(toolMessages.length, 1);
  assert.equal(typeof toolMessages[0].content, 'string', 'a tool message carries text only');
  assert.doesNotMatch(String(toolMessages[0].content), /base64,/, 'and no image data');

  // The opening picture of the page is in the first turn; the round's own picture follows its
  // tool block, so exactly one picture message comes after the tool result.
  const toolIndex = messages.indexOf(toolMessages[0]);
  const picture = messages.slice(toolIndex).filter(carriesPicture);
  assert.equal(picture.length, 1, 'exactly one message carries the picture of this round');
  assert.equal(picture[0].role, 'user', 'a picture travels in a user message');
  assert.ok(Array.isArray(picture[0].content));
  assert.ok(messages.indexOf(picture[0]) > toolIndex, 'the picture follows the tool result');
});

test('with two tool calls in one round the block stays contiguous: assistant, tool, tool, user', async (t) => {
  // This is the round that breaks an interleaved design. OpenAI-compatible servers validate that
  // the tool messages match the assistant's tool_calls array as one block.
  const { client, requests } = withClient(t, {
    replies: [
      twoToolCalls({ name: 'take_screenshot' }, { name: 'read_page' }),
      toolCall('finish', { outcome: 'done', answer: 'done' })
    ]
  });
  await client.startTask('Look, then read');

  const messages = messagesOf(requests[1]);
  const roles = messages.map((m) => m.role);
  const assistantAt = roles.lastIndexOf('assistant');
  assert.deepEqual(roles.slice(assistantAt), ['assistant', 'tool', 'tool', 'user'],
    'the two tool results are one block, and the picture follows it');
});

test('two pictures in one round travel in one user message, each with its own label', async (t) => {
  const { client, requests } = withClient(t, {
    replies: [
      twoToolCalls({ name: 'take_screenshot' }, { name: 'take_screenshot' }),
      toolCall('finish', { outcome: 'done', answer: 'done' })
    ]
  });
  await client.startTask('Look twice');

  const messages = messagesOf(requests[1]);
  const round = messages.slice(messages.map((m) => m.role).lastIndexOf('assistant'));
  const pictures = round.filter(carriesPicture);
  assert.equal(pictures.length, 1, 'one message, not one per tool call');
  const blocks = pictures[0].content as any[];
  assert.equal(blocks.filter((b) => b.type === 'image_url').length, 2);
  // The run state rides on the last message of the request as one more text block (withRunState).
  assert.equal(blocks.filter((b) => b.type === 'text' && !String(b.text).startsWith('[Run state]')).length, 2, 'each picture has a label');
});

test('the picture reaches the provider as an OpenAI image_url data URL', async (t) => {
  const { client, requests } = withClient(t, {
    replies: [toolCall('take_screenshot'), toolCall('finish', { outcome: 'done', answer: 'done' })]
  });
  await client.startTask('Look at the page');

  const picture = messagesOf(requests[1]).filter(carriesPicture)[0];
  const image = (picture.content as any[]).find((b) => b.type === 'image_url');
  assert.match(image.image_url.url, /^data:image\/jpeg;base64,/);
});

test('the history row carries the picture id and size, and never the bytes', async (t) => {
  const { client, rec } = withClient(t, {
    replies: [toolCall('take_screenshot'), toolCall('finish', { outcome: 'done', answer: 'done' })]
  });
  await client.startTask('Look at the page');

  const row = rec.history.find((r) => (r as any).type === 'execution_result' && (r as any).imageId) as any;
  assert.ok(row, 'the step that took the picture has a row with an id');
  assert.equal(typeof row.imageId, 'string');
  assert.equal(row.imageWidth, 1280);
  assert.equal(row.imageHeight, 720);
  assert.doesNotMatch(JSON.stringify(row), /base64,|"data"/, 'no bytes in a history row');
});

test('the panel row says the picture was taken, not the whole base64', async (t) => {
  const { client, rec } = withClient(t, {
    replies: [toolCall('take_screenshot'), toolCall('finish', { outcome: 'done', answer: 'done' })]
  });
  await client.startTask('Look at the page');
  const row = rec.history.find((r) => (r as any).type === 'execution_result' && (r as any).imageId) as any;
  assert.match(row.message, /Captured the visible page/);
  assert.ok(row.message.length < 300, 'the row is a summary');
});

// ---------------------------------------------------------------------------------------------
// Trimming
// ---------------------------------------------------------------------------------------------

test('pictureBlocks puts each picture in its own text block pair', () => {
  const blocks = pictureBlocks([
    { type: 'image', data: 'AAA', mediaType: 'image/jpeg', imageId: 'a', imageWidth: 800, imageHeight: 600 },
    { type: 'image', data: 'BBB', mediaType: 'image/png', imageId: 'b', imageWidth: 400, imageHeight: 300 }
  ]);
  assert.equal(blocks.length, 4);
  assert.equal(blocks[0].type, 'text');
  assert.match((blocks[0] as any).text, /800x600/);
  assert.equal(blocks[1].type, 'image_url');
  assert.equal((blocks[1] as any).image_url.url, 'data:image/jpeg;base64,AAA');
  assert.equal((blocks[3] as any).image_url.url, 'data:image/png;base64,BBB');
});

test('only the last two pictures keep their bytes, and the older one becomes text', () => {
  const history: Message[] = [];
  for (let i = 0; i < 3; i++) {
    history.push({ role: 'assistant', content: '', tool_calls: [{ id: `c${i}`, function: { name: 'take_screenshot', arguments: '{}' } }] });
    history.push({ role: 'tool', tool_call_id: `c${i}`, content: `shot ${i}` });
    history.push({
      role: 'user',
      content: [
        { type: 'text', text: `picture ${i}` },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,IMG${i}` } }
      ]
    });
  }

  const trimmed = trimPictures(history);
  const withPictures = trimmed.filter(carriesPicture);
  assert.equal(withPictures.length, KEPT_PICTURES, 'only the last two keep their bytes');
  assert.equal(KEPT_PICTURES, 2, 'two, so a before and an after can be compared');
  assert.equal(trimmed.length, history.length, 'no message is added or removed');

  // The trimmed message keeps its text and says the picture is gone.
  const first = trimmed[2];
  assert.equal(first.role, 'user', 'still a user message, so the tool block is untouched');
  assert.equal(typeof first.content, 'string');
  assert.match(String(first.content), /picture 0/);
  assert.match(String(first.content), new RegExp(TRIMMED_PICTURE_TEXT.replace(/[[\]]/g, '\\$&')));
});

test('the tool block above a trimmed picture is still contiguous', () => {
  const history: Message[] = [
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'take_screenshot', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'ok' },
    { role: 'user', content: [{ type: 'text', text: 'p' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,A' } }] },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c2', function: { name: 'take_screenshot', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c2', content: 'ok' },
    { role: 'user', content: [{ type: 'text', text: 'q' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,B' } }] },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c3', function: { name: 'take_screenshot', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c3', content: 'ok' },
    { role: 'user', content: [{ type: 'text', text: 'r' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,C' } }] }
  ];
  const trimmed = trimPictures(history);
  const roles = trimmed.map((m) => m.role);
  assert.deepEqual(roles, ['assistant', 'tool', 'user', 'assistant', 'tool', 'user', 'assistant', 'tool', 'user']);
  assert.equal(trimmed[0].tool_calls?.length, 1, 'the tool call that produced the trimmed picture is still there');
  assert.equal(trimmed[1].tool_call_id, 'c1');
});

test('the trim does not touch a history with two pictures or fewer', () => {
  const history: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,A' } }] }
  ];
  assert.equal(trimPictures(history), history, 'the same array is returned, untouched');
});

test('stripPictures removes every picture and says so in its place', () => {
  const history: Message[] = [
    { role: 'tool', tool_call_id: 'c1', content: 'ok' },
    { role: 'user', content: [{ type: 'text', text: 'Here is the picture' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,A' } }] }
  ];
  const stripped = stripPictures(history);
  assert.equal(stripped.filter(carriesPicture).length, 0, 'no picture is left');
  assert.match(String(stripped[1].content), new RegExp(UNSEEN_PICTURE_TEXT.replace(/[[\]]/g, '\\$&')));
  assert.match(String(stripped[1].content), /Here is the picture/, 'the label is kept');
  assert.equal(stripped[0].content, 'ok', 'the tool message is untouched');
});

test('only an image error is read as a refusal, not every provider failure', () => {
  assert.equal(looksLikeImageRejection('API error: 400 {"error":"this model does not support image input"}'), true);
  assert.equal(looksLikeImageRejection('API error: 422 unsupported image_url content'), true);
  // A timeout, a 500, or a 401 is not evidence about pictures, and retrying it as text would
  // hide a real failure.
  assert.equal(looksLikeImageRejection('API error: 500 internal server error'), false);
  assert.equal(looksLikeImageRejection('API error: 401 invalid api key'), false);
  assert.equal(looksLikeImageRejection('This operation was aborted'), false);
  assert.equal(looksLikeImageRejection(''), false);
});

// ---------------------------------------------------------------------------------------------
// The provider refuses the picture
// ---------------------------------------------------------------------------------------------

test('a provider that refuses the picture does not end the run: the round is retried without it', async (t) => {
  const { client, requests, rec } = withClient(t, {
    replies: [
      toolCall('take_screenshot'),
      // The provider rejects the request that carried the picture.
      { __httpError: true, status: 400, message: 'this model does not support image input' },
      toolCall('finish', { outcome: 'done', answer: 'The page is fine.' })
    ]
  });
  await client.startTask('Look at the page');

  const runs = rec.history.filter((r) => (r as any).type === 'finish');
  assert.equal(runs.length, 1, 'the run still finished');
  assert.match((runs[0] as any).answer, /The page is fine/);

  // The retry request has no picture in it.
  assert.ok(requests.length >= 3, 'the round was retried');
  const retry = requests[2];
  assert.equal(retry.body.messages.filter(carriesPicture).length, 0, 'the retry carries no picture');
});

test('after a refusal the screenshot tool is no longer offered', async (t) => {
  clearVisionCache();
  const { client, requests } = withClient(t, {
    replies: [
      toolCall('take_screenshot'),
      { __httpError: true, status: 400, message: 'this model does not support image input' },
      toolCall('finish', { outcome: 'done', answer: 'done' })
    ]
  });
  await client.startTask('Look at the page');
  const lastRequest = requests[requests.length - 1];
  const toolNames = (lastRequest.body.tools || []).map((tool: any) => tool.function?.name ?? tool.name);
  assert.equal(toolNames.includes('take_screenshot'), false, 'the model stops asking for pictures it cannot have');
});

test('a refused picture is answered honestly if the model asks again anyway', async (t) => {
  const { client, rec } = withClient(t, {
    replies: [
      toolCall('take_screenshot'),
      { __httpError: true, status: 400, message: 'this model does not support image input' },
      toolCall('take_screenshot'),
      toolCall('finish', { outcome: 'done', answer: 'done' })
    ]
  });
  await client.startTask('Look at the page');
  const rows = rec.history.filter((r) => (r as any).type === 'execution_result');
  const refusal = rows.find((r: any) => /cannot see pictures/.test(String(r.error || r.message)));
  assert.ok(refusal, 'the second call is refused in words the model can act on');
});

// ---------------------------------------------------------------------------------------------
// A model known to be blind
// ---------------------------------------------------------------------------------------------

test('an Ollama model whose capabilities do not list vision is never sent a picture', async (t) => {
  // Ollama says which models can see. A model it reports as text-only gets no opening picture and
  // no camera: a picture would be ignored or rejected, and every round would pay for it.
  clearVisionCache();
  const { client, requests } = withClient(t, {
    provider: 'ollama',
    replies: [toolCall('finish', { outcome: 'done', answer: 'done' })]
  });
  await client.startTask('Summarize the page');
  const first = requests.find((r) => r.url.endsWith('/api/chat'));
  assert.ok(first, 'the model was called');
  const toolNames = (first!.body.tools || []).map((tool: any) => tool.function?.name ?? tool.name);
  assert.equal(toolNames.includes('take_screenshot'), false, 'take_screenshot is not offered to a blind model');
  assert.equal(toolNames.includes('read_page'), true, 'and it keeps the tools it can use');
  assert.ok(!(first!.body.messages as any[]).some((m) => Array.isArray(m.images) && m.images.length > 0), 'and no picture was sent');
});

test('the first request carries a picture of the page, right after the task', async (t) => {
  // Screenshots are always on: the model sees the page before it acts, not only its text.
  clearVisionCache();
  const { client, requests } = withClient(t, {
    provider: 'ollama',
    capabilities: ['completion', 'tools', 'vision'],
    replies: [toolCall('finish', { outcome: 'done', answer: 'done' })]
  });
  await client.startTask('What is on the page?');
  const first = requests.find((r) => r.url.endsWith('/api/chat'));
  const messages = first!.body.messages as any[];
  const taskAt = messages.findIndex((m) => m.role === 'user' && /TASK:/.test(String(m.content)));
  assert.ok(taskAt >= 0, 'the task is there');
  assert.equal(messages[taskAt + 1]?.role, 'user', 'a user message follows the task');
  assert.ok(Array.isArray(messages[taskAt + 1]?.images) && messages[taskAt + 1].images.length === 1, 'and it carries the picture');
});

// ---------------------------------------------------------------------------------------------
// The screenshots setting, which is the user's switch and must not be decoration
// ---------------------------------------------------------------------------------------------

/** The system prompt of the first request, as one string. */
const systemPromptOf = (request: { body: any }): string =>
  messagesOf(request).filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n');

test('off: the camera is still offered - screenshots are mandatory now', async (t) => {
  // Screenshots are always on: no setting can turn them off. The model keeps the tool.
  const { client, requests } = withClient(t, {
    provider: 'ollama',
    capabilities: ['completion', 'tools', 'vision'],
    screenshots: 'off',
    replies: [toolCall('finish', { outcome: 'done', answer: 'done' })]
  });
  await client.startTask('Summarize the page');
  const first = requests.find((r) => r.url.endsWith('/api/chat'));
  assert.ok(first, 'the model was called');
  const toolNames = (first!.body.tools || []).map((tool: any) => tool.function?.name ?? tool.name);
  assert.equal(toolNames.includes('take_screenshot'), true, 'screenshots are always on even when a stored "off" lingered');
  assert.equal(toolNames.includes('read_page'), true, 'the rest of the tools stay');
});

test('always: the prompt carries no "look first" rule because every page load already gets a picture', async (t) => {
  const { client, requests } = withClient(t, {
    screenshots: 'always',
    replies: [toolCall('finish', { outcome: 'done', answer: 'done' })]
  });
  await client.startTask('Click the green button');
  const prompt = systemPromptOf(requests[0]);
  assert.doesNotMatch(prompt, /as your FIRST\s+action of every step/i, 'auto mode does not force a per-step picture');
  // The general SEEING rule is still there so the model knows it can ask for more pictures.
  assert.match(prompt, /SEEING THE PAGE/);
});

test('auto: the prompt carries no always rule, so a normal run is not forced to look', async (t) => {
  const { client, requests } = withClient(t, {
    replies: [toolCall('finish', { outcome: 'done', answer: 'done' })]
  });
  await client.startTask('Summarize the page');
  const prompt = systemPromptOf(requests[0]);
  assert.doesNotMatch(prompt, /as your FIRST\s+action of every step/i, 'auto does not force a picture');
  // The general rule is still there: auto means "when the text is not enough", not "never".
  assert.match(prompt, /SEEING THE PAGE/);
});
