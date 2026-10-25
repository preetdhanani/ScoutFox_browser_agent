/**
 * Quick self-test of the offline mock (mockOllama.mjs). Node only, no browser, well under a second.
 *
 *   node tests/e2e/lib/mockOllama.selftest.mjs
 *
 * `smoke.mjs --mock` runs it first, so a broken mock is reported before Chromium starts.
 *
 * It starts the mock on a free port and talks to it over HTTP, the way the extension does:
 *   - the protocol: CORS preflight, /api/version, /api/tags, /api/show (known and unknown model), HTTP 400 for a request
 *     that is not valid JSON (and for other malformed ones, including an assistant tool call echoed with `arguments` as
 *     a string, which real Ollama refuses with the same 400 text the mock copies), 501 for a chat call without a tools
 *     array (the mock speaks
 *     the MCP tool-calling protocol and nothing else calls /api/chat any more), 404 for an unknown model and an unknown
 *     route, and the reply forms: one JSON object for stream:false (what callOllamaWithTools sends) and NDJSON for a
 *     streaming request;
 *   - the tool calls: every reply's tool_calls must name a tool the request offered, and the arguments must fit the
 *     tool's parameters schema (validateToolArgs); a mock bug there is an HTTP 500, and the validator itself is checked
 *     on the cases that matter (unknown argument, missing required argument, enum, number bounds, array of strings);
 *   - the scripted runs: for every smoke task it walks the MCP loop the way src/background/mcp/client.ts drives it
 *     (the first user message with the page preview, then tool calls, the tool results built the way
 *     src/background/mcp/server.ts builds them, the history rows built with the real builders of
 *     src/background/mcp/historyEntries.ts) from the committed fixture snapshots, and the facts of that walk go through
 *     the SAME checks as the smoke run (lib/tasks.mjs: check, expectOutcome, expectMock). The tally the worker counter
 *     would produce is simulated (one EXECUTE_ACTION per click), so the acted-on-page expectations hold here too;
 *   - the honesty: the same walks again with the page text and/or the element list removed from what the tool results
 *     deliver. A run that lost what it needs must fail its check, with a "MOCK-FAIL:" reply that no check accepts.
 *
 * What it does NOT do: it does not run the browser (that is what the smoke run is for). The walk above is a copy of the
 * parts of the client and the server that decide what the mock sees, so when either changes, this walk is the part to
 * update; the smoke run shows whether it still matches.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCOUTFOX_TOOLS } from '../../src/background/mcp/tools.ts';
import { linkNotOpenedNote, rankElementLines } from '../../src/background/mcp/server.ts';
import {
  agentResponseEntry,
  executionResultEntry,
  finishEntry,
  mapToolToAction,
  screenshotResultEntry,
  userGoalEntry
} from '../../src/background/mcp/historyEntries.ts';
import { extractReadableAnswer } from '../../src/shared/answerText.ts';
import { runFacts, TASKS } from './tasks.mjs';
import { MOCK_THINKING_TEXT,
  MOCK_FAIL_PREFIX,
  MOCK_PARAMETER_SIZE,
  MOCK_VERSION,
  decide,
  parseTaskMessage,
  readConversation,
  startMockOllama,
  toNdjson,
  validateToolArgs
} from './mockOllama.mjs';
import { collapseChatResponse } from './callRecord.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = path.resolve(HERE, '..', 'fixtures', 'snapshots');

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });

// The tools of the request, in the Ollama function format callOllamaWithTools sends.
const ollamaTools = SCOUTFOX_TOOLS.map((t) => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.inputSchema }
}));

// The snapshot files are named after the page without its .html ending (store.html -> store.json).
const snapshotOf = (name) => JSON.parse(fs.readFileSync(path.join(SNAPSHOT_DIR, `${String(name).replace(/\.html$/, '')}.json`), 'utf8'));

// The size the scripted capture reports, and a real 1x1 PNG as its bytes. The self-test checks
// the SHAPE of the picture path (a picture in a user message, after the tool block), never the
// pixels, so one pixel is enough and stays fast.
const MOCK_SHOT_WIDTH = 1568;
const MOCK_SHOT_HEIGHT = 892;
// The viewport the shot is taken in. The picture is the viewport, so the ratio between the two is
// what a coordinate click goes through, exactly like the real server does.
const MOCK_VIEWPORT_WIDTH = 2000;
const MOCK_VIEWPORT_HEIGHT = 1100;
const MOCK_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * The picture message as the OLLAMA request really carries it: the text in content and the
 * pictures in a sibling `images` array of bare base64 (toOllamaMessage in llm/index.ts).
 *
 * This is the shape the real run uses, and the one the mock has to understand. A walk that sent
 * the OpenAI-shaped content array instead would exercise a path the extension never takes
 * against Ollama, and the first real run would fail where the self-test was green.
 */
function ollamaPictureMessage() {
  return {
    role: 'user',
    content: `Here is the picture of the page (${MOCK_SHOT_WIDTH}x${MOCK_SHOT_HEIGHT}). Coordinates you read off it are pixels in this picture.`,
    images: [MOCK_PNG]
  };
}

/**
 * The tool results the way src/background/mcp/server.ts builds them, from a committed snapshot.
 * `strip` removes what a scenario takes away from the content script (the honesty walks).
 *
 * A click on an element that is not on the page fails, and the failure comes back as an error:
 * that is what the server does now (a failed action is an error, not a success), and the walk
 * has to see the same thing the extension would.
 */
function serverResult(name, args, snapshot, strip, state = {}) {
  const { frame = null, shuffled = false, pageSignature = null, onPageClick = () => {}, onShuffle = () => {}, onOpen = () => {}, blocked = false, onAccept = () => {} } = state;
  const shuffleId = String(snapshot.elementsText || '').split('\n')
    .map((line) => /^\[(\d+)\].*shuffle/i.exec(line))
    .find(Boolean)?.[1];
  switch (name) {
    case 'get_page_text':
    case 'read_page_text':
      return strip.pageText ? '' : snapshot.pageText;
    case 'get_page_elements':
      return strip.elements ? '' : snapshot.elementsText;
    case 'find': {
      if (strip.elements) return '';
      // The engine's own ranking (server.ts), so the walk finds what the extension finds.
      const matches = rankElementLines(snapshot.elementsText, String(args.query || '')).map((l) => `${l} | matches "${args.query}"`);
      return matches.length ? matches.join('\n') : `No elements found matching "${args.query}". Try get_page_elements to see all.`;
    }
    case 'type':
      return `Typed into element [${args.element_id}]${args.reason ? `: ${args.reason}` : ''}`;
    case 'scroll':
      return `Scrolled ${args.direction}${args.reason ? `: ${args.reason}` : ''}`;
    case 'navigate':
      return `Navigated to ${args.url}${args.reason ? `: ${args.reason}` : ''}`;
    case 'wait':
      return `Waited ${args.amount}s${args.reason ? `: ${args.reason}` : ''}`;
    case 'go_back':
      return 'Went back in history';
    case 'go_forward':
      return 'Went forward in history';
    case 'take_screenshot':
      // The server's text block, and no bytes: the picture travels separately (pictureBlocks
      // below), in a user message after the tool block, the way the client sends it.
      // strip.wrongShotSize is the control: the tool result names a picture the frame does not
      // have, so the coordinate the model reads off it cannot line up.
      return `Captured the visible page (${strip.wrongShotSize || `${MOCK_SHOT_WIDTH}x${MOCK_SHOT_HEIGHT}`}, image/jpeg). Coordinates you read off this picture are pixels in this picture.`;
    case 'click': {
      // A coordinate click: the walk applies the same frame math the server does (the picture is
      // the frame, mapped by the ratio to the viewport), and the page's own marker decides
      // whether it landed. A click at a wrong point leaves the marker unset, exactly like the
      // real fixture.
      if (args.x !== undefined || args.y !== undefined) {
        if (!frame) return 'Error: no screenshot has been taken for this tab yet. Take one before clicking by coordinates.';
        if (pageSignature !== null && frame.sig !== pageSignature) {
          return 'Error: the page has changed since that screenshot, so the picture no longer shows what is there now. Take a new screenshot.';
        }
        if (args.x < 0 || args.y < 0 || args.x >= frame.width || args.y >= frame.height) {
          return `Error: coordinate (${args.x}, ${args.y}) is outside the picture (${frame.width}x${frame.height}).`;
        }
        const viewport = { width: MOCK_VIEWPORT_WIDTH, height: MOCK_VIEWPORT_HEIGHT };
        const point = {
          x: Math.round((args.x * viewport.width) / frame.width),
          y: Math.round((args.y * viewport.height) / frame.height)
        };
        // No fixture task clicks by coordinates any more; the click lands, on nothing in particular.
        return `Clicked at (${args.x}, ${args.y}) in the picture (${point.x}, ${point.y} in the viewport).`;
      }
      const line = String(snapshot.elementsText || '').split('\n').find((l) => l.startsWith(`[${args.element_id}] `));
      if (!line) return `Error: Element [${args.element_id}] no longer resolvable in DOM.`;
      if (shuffleId !== undefined && Number(shuffleId) === Number(args.element_id)) onShuffle();
      // A page whose consent banner swallows clicks (blocksClicks): a link click stays put and says so
      // with the server's own note, until the banner's Accept button is clicked.
      if (blocked && /accept/i.test(line)) onAccept();
      const opens = /\(href="\/([\w-]+)\.html/.exec(line);
      if (opens && blocked) return `Clicked element [${args.element_id}]${args.reason ? `: ${args.reason}` : ''}${linkNotOpenedNote(line)}`;
      // A link to another recorded fixture page opens it, like the real click does.
      if (opens && fs.existsSync(path.join(SNAPSHOT_DIR, `${opens[1]}.json`))) {
        onOpen(opens[1]);
        return `Clicked element [${args.element_id}]${args.reason ? `: ${args.reason}` : ''}\nNOW ON: ${snapshotOf(opens[1]).title}`;
      }
      return `Clicked element [${args.element_id}]${args.reason ? `: ${args.reason}` : ''}`;
    }
    case 'update_plan':
      return 'Plan approved. Execute the plan step by step.';
    case 'finish':
      return `TASK_COMPLETE: ${args.answer}`;
    default:
      return `Unknown tool: ${name}`;
  }
}

/**
 * One walk of the MCP loop, the way the client drives it, against the live mock over HTTP.
 * Returns { facts, calls, problems } - the facts the same way the smoke run builds them.
 */
export async function walkTask(mock, taskName, { strip = {}, maxRounds = 12 } = {}) {
  const task = TASKS[taskName];
  let snapshot = snapshotOf(task.page);
  const firstCall = mock.calls.length;
  const history = [userGoalEntry(1, task.prompt)];
  const planSteps = [];
  const tally = { messages: {}, cdp: {} };

  const userMessage = `TASK: ${task.prompt}\n\nCURRENT PAGE: ${snapshot.title}\n${snapshot.url}\n\nPage preview:\n${String(snapshot.pageText || '').slice(0, 2000)}`;
  const messages = [
    { role: 'system', content: `You are ScoutFox, an AI browser agent controlling a Chrome tab.` },
    { role: 'user', content: userMessage }
  ];

  let step = 0;
  let planCursor = 0;
  let outcome = null;
  const sent = [];
  const debugRounds = [];
  // The state of the page the walk talks to: whether it was clicked, whether it was shuffled,
  // and the frame the last picture left behind.
  const state = { clicked: false, shuffled: false, frame: null, pageSignature: 'page-1' };
  for (let round = 0; round < maxRounds; round++) {
    const body = { model: 'mock-agent', messages, tools: ollamaTools, tool_choice: 'auto', stream: false };
    sent.push(JSON.parse(JSON.stringify(messages)));
    const res = await fetch(`${mock.url}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (res.status !== 200) {
      debugRounds.push({ round: round + 1, status: res.status, error: data.error, lastMessages: messages.slice(-3) });
      check(`${taskName}: round ${round + 1} got HTTP ${res.status}`, false, data.error || '');
      return { facts: runFacts({ history, planSteps, calls: mock.calls.slice(firstCall), tally }), problems: [], sent, debugRounds };
    }
    const toolCalls = data.message?.tool_calls || [];
    if (!toolCalls.length) {
      // A plain-text reply completes the run, like the client handles it. The client pulls the
      // readable part out of a JSON answer, so the walk does the same: a walk that kept the raw
      // JSON would check a different thing than the engine does.
      const text = data.message?.content || '';
      const readable = extractReadableAnswer(text);
      history.push(finishEntry(readable.text, readable.evidence));
      outcome = 'finish';
      break;
    }
    // The client (callOllamaWithTools) normalizes the ids: a tool call without one gets call_<i>.
    const normalized = toolCalls.map((tc, i) => ({ id: tc.id || `call_${i}`, function: tc.function }));
    messages.push({ role: 'assistant', content: '', tool_calls: normalized });
    // The loop collects the pictures of the round and pushes ONE user message after the WHOLE
    // tool block, which is what the client does (runLoop in client.ts).
    const pictures = [];
    for (const tc of normalized) {
      const name = tc.function.name;
      const args = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments;
      step += 1;
      const action = mapToolToAction(name, args);
      if (action) history.push(agentResponseEntry(step, String(args.reason || ''), action, JSON.stringify(tc)));
      if (name === 'update_plan') {
        planSteps.push(...(args.plan || []).map((text) => ({ text, status: 'pending' })));
      }
      if (name === 'click') tally.messages.EXECUTE_ACTION = (tally.messages.EXECUTE_ACTION || 0) + 1;
      const content = serverResult(name, args, snapshot, strip, {
        frame: state.frame,
        shuffled: state.shuffled,
        pageSignature: state.pageSignature,
        // The page marks itself only when the click actually landed on the target, which is what
        // the real fixture does: the reference point is the page's own coordinate, not the point
        // the mock aimed at.
        onPageClick: () => { state.clicked = true; },
        onShuffle: () => { state.shuffled = true; },
        onOpen: (page) => { snapshot = snapshotOf(page); },
        blocked: !!task.blocksClicks && !state.accepted,
        onAccept: () => { state.accepted = true; }
      });
      // The frame remembers the page signature it was taken with. A shuffle changes the page's
      // text, so a frame taken before it no longer matches: the real server refuses a click on
      // such a frame (checkFrame compares the signature), and so does this walk.
      if (name === 'take_screenshot') {
        state.frame = { width: MOCK_SHOT_WIDTH, height: MOCK_SHOT_HEIGHT, sig: state.pageSignature };
      }
      // A click on Shuffle changes the page: the board moves and a line of text changes, which is
      // exactly what the frame's staleness check is for.
      if (name === 'click' && state.shuffled && state.pageSignature === 'page-1') {
        // The page changed: its signature moves on, and the frame taken before it no longer
        // describes the page. The snapshot's text changes too, like the fixture's does.
        state.pageSignature = 'page-2';
        // Only the text changes: the element list is the same page, and dropping it here would
        // make the walk lose a list a real page still has.
        snapshot = { ...snapshot, pageText: `${snapshot.pageText || ''}\nThe board was shuffled.` };
      }
      // The server marks a failed action as an error, and the client shows the step as failed.
      const failed = content.startsWith('Error:');
      // A step that took a picture records it the way the client does: the row carries the id
      // and the size, never the bytes.
      if (name === 'take_screenshot') {
        history.push(screenshotResultEntry(step, !failed, content.length > 200 ? `${content.slice(0, 199)}…` : content,
          failed ? undefined : { imageId: `shot-walk-${step}`, imageWidth: MOCK_SHOT_WIDTH, imageHeight: MOCK_SHOT_HEIGHT }));
      } else {
        history.push(executionResultEntry(step, !failed, content.length > 200 ? `${content.slice(0, 199)}…` : content));
      }
      // The client's advancePlanChecklist: the plan step this tool worked on becomes completed.
      // A step that failed does not tick anything off.
      if (name !== 'update_plan' && !failed && planSteps.length) {
        const at = Math.min(planCursor, planSteps.length - 1);
        if (planSteps[at] && planSteps[at].status !== 'completed') {
          planSteps[at] = { ...planSteps[at], status: 'completed' };
          planCursor = Math.min(planCursor + 1, planSteps.length);
        }
      }
      messages.push({ role: 'tool', tool_call_id: tc.id, content });
      // The honesty case (strip.picture) is the real failure mode: the capture SUCCEEDED and its
      // text is in the tool result, but the picture never reached the model. So the picture is
      // not pushed, and the mock has to refuse to describe a page it was not shown.
      if (name === 'take_screenshot' && !failed && !strip.picture) pictures.push(ollamaPictureMessage());
      if (content.startsWith('TASK_COMPLETE:')) {
        history.push(finishEntry(content.slice('TASK_COMPLETE:'.length).trim()));
        outcome = 'finish';
        break;
      }
    }
    if (pictures.length) messages.push(...pictures);
    if (outcome) break;
  }

  const facts = runFacts({
    history,
    planSteps,
    calls: mock.calls.slice(firstCall),
    tally,
    pageClicked: task.expectPageClick ? state.clicked : null
  });
  const problems = [];
  if (!outcome) problems.push(`the walk did not finish within ${maxRounds} rounds`);
  else if (outcome !== (task.expectOutcome || 'finish')) problems.push(`the walk ended with ${outcome}, expected ${task.expectOutcome || 'finish'}`);
  else if (!task.check(facts)) problems.push(`the answer is wrong: ${JSON.stringify(facts.answer)}`);
  problems.push(...task.expectMock(facts));
  const mockFail = [facts.answer, ...facts.errors].find((t) => typeof t === 'string' && t.includes(MOCK_FAIL_PREFIX));
  if (mockFail) problems.push(`the mock could not find what it needs: ${mockFail.slice(mockFail.indexOf(MOCK_FAIL_PREFIX))}`);
  return { facts, problems, sent, debugRounds };
}

// ---------------------------------------------------------------------------------------------
// The protocol
// ---------------------------------------------------------------------------------------------

async function protocolChecks(mock) {
  const preflight = await fetch(`${mock.url}/api/chat`, { method: 'OPTIONS' });
  check('CORS preflight answers 204', preflight.status === 204);
  check('CORS preflight allows the Content-Type header', (preflight.headers.get('access-control-allow-headers') || '').includes('Content-Type'));

  const version = await (await fetch(`${mock.url}/api/version`)).json();
  check('/api/version answers the mock version', version.version === MOCK_VERSION);

  const tags = await (await fetch(`${mock.url}/api/tags`)).json();
  check('/api/tags lists the models', Array.isArray(tags.models) && tags.models.some((m) => m.name === 'mock-agent'));
  check('/api/tags details carry the parameter size', tags.models[0].details.parameter_size === MOCK_PARAMETER_SIZE);

  const show = await (await fetch(`${mock.url}/api/show`, { method: 'POST', body: JSON.stringify({ model: 'mock-agent' }) })).json();
  check('/api/show answers the capabilities', Array.isArray(show.capabilities) && show.capabilities.includes('tools'));
  const showUnknown = await fetch(`${mock.url}/api/show`, { method: 'POST', body: JSON.stringify({ model: 'nope' }) });
  check('/api/show answers 404 for an unknown model', showUnknown.status === 404);

  const badJson = await fetch(`${mock.url}/api/chat`, { method: 'POST', body: 'not json' });
  check('/api/chat answers 400 for a body that is not JSON', badJson.status === 400);
  const noModel = await fetch(`${mock.url}/api/chat`, { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }) });
  check('/api/chat answers 400 without a model', noModel.status === 400);
  const badMessages = await fetch(`${mock.url}/api/chat`, { method: 'POST', body: JSON.stringify({ model: 'mock-agent', messages: [{ role: 'user' }] }) });
  check('/api/chat answers 400 for a message without content', badMessages.status === 400);

  // A tool call the model made comes back in the next request's history. Real Ollama refuses that
  // history when the arguments are a string instead of an object ("Value looks like object, but
  // can't find closing '}' symbol", 0.40.6), which kills a multi-step run. The mock refuses it too,
  // so the offline suite cannot pass a request a real Ollama would turn down.
  const echo = (args) => ({
    model: 'mock-agent',
    tools: [{ type: 'function', function: { name: 'read_page_text', parameters: { type: 'object', properties: {} } } }],
    messages: [
      { role: 'user', content: 'What is the price on the page?' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_page_text', arguments: args } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'Tool result: ok' }
    ]
  });
  const stringArgs = await fetch(`${mock.url}/api/chat`, { method: 'POST', body: JSON.stringify(echo('{"selector":"main"}')) });
  const stringArgsBody = await stringArgs.json().catch(() => ({}));
  check('a tool call echoed with string arguments answers 400', stringArgs.status === 400, `got ${stringArgs.status}`);
  check('the 400 is the message real Ollama sends', /can't find closing/.test(stringArgsBody.error || ''), stringArgsBody.error || '');
  const objectArgs = await fetch(`${mock.url}/api/chat`, { method: 'POST', body: JSON.stringify(echo({ selector: 'main' })) });
  check('the same tool call with an arguments object is not refused', objectArgs.status !== 400, `got 400`);

  const noTools = await fetch(`${mock.url}/api/chat`, {
    method: 'POST',
    body: JSON.stringify({ model: 'mock-agent', messages: [{ role: 'user', content: 'hello' }] })
  });
  const noToolsBody = await noTools.json();
  check('a chat call without tools answers 501', noTools.status === 501);
  check('the 501 names the MCP protocol', /MCP tool-calling protocol/.test(noToolsBody.error || ''));

  const unknownRoute = await fetch(`${mock.url}/api/nope`, { method: 'POST', body: '{}' });
  check('an unknown route answers 404', unknownRoute.status === 404);

  // The reply form callOllamaWithTools reads: one JSON object (stream:false) whose message carries tool_calls
  // with an arguments OBJECT (the client stringifies it).
  const single = await (await fetch(`${mock.url}/api/chat`, {
    method: 'POST',
    body: JSON.stringify({ model: 'mock-agent', messages: [{ role: 'user', content: 'TASK: What does the page cost?\n\nPage preview:\nnothing' }], tools: ollamaTools, stream: false })
  })).json();
  check('a stream:false reply is one object with done:true', single.done === true && single.done_reason === 'stop');
  check('the reply message carries tool_calls', Array.isArray(single.message.tool_calls) && single.message.tool_calls.length > 0);
  check('the tool arguments are an object, not a string', single.message.tool_calls[0].function.arguments && typeof single.message.tool_calls[0].function.arguments === 'object');

  // The effort (llm/effort.ts): /api/show says the model thinks, think:true is answered with a
  // thinking text, and a model without the capability refuses think:true as real Ollama does.
  check('/api/show lists the thinking capability and its values', show.capabilities.includes('thinking') && JSON.stringify(show.thinking?.values) === '[true,false]');
  const thinkTask = { messages: [{ role: 'user', content: 'TASK: What does the page cost?\n\nPage preview:\nnothing' }], tools: ollamaTools, stream: false };
  const thought = await (await fetch(`${mock.url}/api/chat`, { method: 'POST', body: JSON.stringify({ model: 'mock-agent', think: true, ...thinkTask }) })).json();
  check('think:true is answered with a thinking text', thought.message?.thinking === MOCK_THINKING_TEXT);
  const quiet = await (await fetch(`${mock.url}/api/chat`, { method: 'POST', body: JSON.stringify({ model: 'mock-agent', think: false, ...thinkTask }) })).json();
  check('think:false is answered without one', quiet.message && quiet.message.thinking === undefined);
  const noThink = await fetch(`${mock.url}/api/chat`, { method: 'POST', body: JSON.stringify({ model: 'mock-nothink', think: true, ...thinkTask }) });
  check('a model without thinking answers think:true with 400 and the Ollama text', noThink.status === 400 && /does not support thinking/.test((await noThink.json()).error || ''));
  const badThink = await fetch(`${mock.url}/api/chat`, { method: 'POST', body: JSON.stringify({ model: 'mock-agent', think: 'loud', ...thinkTask }) });
  check('an invalid think value answers 400', badThink.status === 400);
  check('the call record keeps the effort fields that were sent', mock.calls.some((call) => call.effort && call.effort.think === true));

  // A streaming request still gets NDJSON that collapses to the same reply.
  const streamed = await (await fetch(`${mock.url}/api/chat`, {
    method: 'POST',
    body: JSON.stringify({ model: 'mock-agent', messages: [{ role: 'user', content: 'TASK: What does the page cost?\n\nPage preview:\ntext' }], tools: ollamaTools, stream: true })
  })).text();
  const collapsed = collapseChatResponse(streamed);
  check('a streaming reply is NDJSON that collapses to tool_calls', Array.isArray(collapsed.message?.tool_calls) && collapsed.message.tool_calls.length > 0);
  check('the NDJSON has the done line with counts', collapsed.done === true && typeof collapsed.eval_count === 'number');

  // A script that names a tool the request did not offer is a loud 500, not a silent drift.
  const drift = decide({
    model: 'mock-agent',
    messages: [{ role: 'user', content: 'TASK: What does the page cost?\n\nPage preview:\nnothing' }],
    tools: [{ type: 'function', function: { name: 'finish', description: '', parameters: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] } } }]
  });
  check('a request whose tools cannot serve the goal answers 500', !!drift.error && drift.error.status === 500, drift.error ? drift.error.message : 'no error');

  // The task message parser: the shape client.ts writes.
  const parsed = parseTaskMessage('TASK: Read the page\n\nCURRENT PAGE: Example\nhttp://x.test/\n\nPage preview:\nHello\nWorld');
  check('parseTaskMessage reads the task', parsed.task === 'Read the page');
  check('parseTaskMessage reads the title and the url', parsed.title === 'Example' && parsed.url === 'http://x.test/');
  check('parseTaskMessage reads the preview', parsed.preview === 'Hello\nWorld');

  const convo = readConversation([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'TASK: T\n\nPage preview:\nP' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'a', function: { name: 'get_page_text', arguments: {} } }] },
    { role: 'tool', tool_call_id: 'a', content: 'PAGE TEXT' }
  ]);
  check('readConversation joins a tool result to its call by id', convo.results.length === 1 && convo.results[0].name === 'get_page_text' && convo.results[0].content === 'PAGE TEXT');
  check('readConversation knows the last call', convo.lastCall && convo.lastCall.name === 'get_page_text');
}

// ---------------------------------------------------------------------------------------------
// The validator
// ---------------------------------------------------------------------------------------------

function validatorChecks() {
  const schema = {
    type: 'object',
    properties: {
      element_id: { type: 'number', minimum: 1 },
      text: { type: 'string' },
      submit: { type: 'boolean', default: false },
      direction: { type: 'string', enum: ['up', 'down'] },
      plan: { type: 'array', items: { type: 'string' } }
    },
    required: ['element_id'],
    additionalProperties: false
  };
  check('valid arguments pass', validateToolArgs(schema, { element_id: 3, text: 'x', direction: 'down', plan: ['a'] }).length === 0);
  check('an unknown argument is rejected', validateToolArgs(schema, { element_id: 1, extra: 1 }).some((e) => /unknown argument "extra"/.test(e)));
  check('a missing required argument is rejected', validateToolArgs(schema, {}).some((e) => /missing required argument "element_id"/.test(e)));
  check('a wrong type is rejected', validateToolArgs(schema, { element_id: '3' }).some((e) => /"element_id" must be a number/.test(e)));
  check('an enum violation is rejected', validateToolArgs(schema, { element_id: 1, direction: 'sideways' }).some((e) => /"direction" must be one of/.test(e)));
  check('a number below the minimum is rejected', validateToolArgs(schema, { element_id: 0 }).some((e) => /"element_id" must be >= 1/.test(e)));
  check('a non-string array item is rejected', validateToolArgs(schema, { element_id: 1, plan: ['a', 2] }).some((e) => /"plan" must be an array of strings/.test(e)));
}

// ---------------------------------------------------------------------------------------------
// The scripted walks, judged by the same checks as the smoke run
// ---------------------------------------------------------------------------------------------

async function walkChecks(mock) {
  for (const name of Object.keys(TASKS)) {
    // Real-site tasks need live sites and a real model: the scripted walk cannot fetch bahn.de
    // or framework.com, so they are excluded here and run only against a real model.
    if (TASKS[name].web) continue;
    // A run that waits for the user's Stop has no end to walk to: a few rounds must be only waits.
    if (TASKS[name].stopAfterSteps) {
      const { facts } = await walkTask(mock, name, { maxRounds: 3 });
      const problems = TASKS[name].expectMock(facts);
      check(`walk ${name}: the run only waits until it is stopped`, problems.length === 0, problems.join(' | '));
      continue;
    }
    const { problems } = await walkTask(mock, name);
    check(`walk ${name}: the run is right`, problems.length === 0, problems.join(' | '));
  }
}

/** The honesty walks: what the mock needs from each channel, and a run that lost it must fail with MOCK-FAIL. */
async function honestyChecks(mock) {
  const cases = [
    { task: 'store-price', strip: { pageText: true }, needs: 'the page text' }
  ];
  for (const { task, strip, needs } of cases) {
    const { facts, problems } = await walkTask(mock, task, { strip });
    const failed = problems.length > 0 && facts.answer && facts.answer.includes(MOCK_FAIL_PREFIX);
    check(`honesty ${task} without ${needs}: the run fails with MOCK-FAIL`, failed, problems.join(' | ') || 'the walk unexpectedly passed');
  }
}

// ---------------------------------------------------------------------------------------------

export async function runMockSelfTest() {
  const mock = await startMockOllama({ port: 0, models: ['mock-agent', 'mock-nothink'] });
  try {
    await protocolChecks(mock);
    validatorChecks();
    await walkChecks(mock);
    await honestyChecks(mock);
  } finally {
    await new Promise((resolve) => mock.server.close(resolve));
  }
  return results;
}

// Run directly: node tests/e2e/lib/mockOllama.selftest.mjs
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = await runMockSelfTest();
  const failed = out.filter((r) => !r.ok);
  for (const r of out) console.log(`${r.ok ? 'ok' : 'FAIL'} - ${r.name}${r.ok ? '' : `: ${r.detail}`}`);
  if (failed.length) {
    console.error(`\nself-test failed: ${failed.length} of ${out.length} checks`);
    process.exitCode = 1;
  } else {
    console.log(`\nself-test passed: ${out.length} checks`);
  }
}
