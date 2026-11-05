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
import { RESEARCH_TOOL_NAMES, SCOUTFOX_TOOLS } from '../../src/background/mcp/tools.ts';
import { sourceOf, wrapUntrusted } from '../../src/background/mcp/untrusted.ts';
import { webSearch } from '../../src/background/research/search.ts';
import { fetchUrl } from '../../src/background/research/fetchText.ts';
import { RESEARCH_HOST } from '../e2e/lib/twoSources.mjs';
import vm from 'node:vm';
import { fieldReadBack, linkNotOpenedNote, observationLine, scrollResultText, SAME_TEXT_NOTE } from '../../src/background/mcp/server.ts';
import { formatFindMessage, rankFindCandidates } from '../../src/content/domCompressor.ts';
import { pageTextPart } from '../../src/content/pageText.ts';
import { resolveKey } from '../../src/background/browser/input.ts';
import {
  agentResponseEntry,
  executionResultEntry,
  finishEntry,
  finishOutcomeOf,
  mapToolToAction,
  screenshotResultEntry,
  userGoalEntry
} from '../../src/background/mcp/historyEntries.ts';
import { extractReadableAnswer } from '../../src/shared/answerText.ts';
import { ProgressTracker, REFLECTION_TEXT, STALL_END_TEXT, STALL_TEXT, stepKey } from '../../src/background/mcp/progress.ts';
import { ATTACHED_FILE_RULE, buildFinishFiles, compactToolResults, formatRunState, saveRecords, TEXT_ANSWER_TEXT, withRunState } from '../../src/background/mcp/client.ts';
import { runFacts, TASKS, endedByHarness, onlyWaits } from './tasks.mjs';
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

// The research fixture as the service worker reaches it in a browser run: the fixture server's
// files under RESEARCH_HOST (tests/e2e/lib/fixtureServer.mjs serves them the same way: a path
// without a file is its .json, and __ORIGIN__ in a .json is the origin asked). web_search and
// fetch_url below are the extension's own functions, handed this stand-in for fetch.
const SITE_DIR = path.resolve(HERE, '..', 'fixtures', 'site');
const RESEARCH_ORIGIN = `http://${RESEARCH_HOST}:8765`;
const RESEARCH_TYPES = { '.json': 'application/json; charset=utf-8', '.html': 'text/html; charset=utf-8', '.sh': 'text/x-sh; charset=utf-8' };
async function fixtureFetch(input) {
  const url = new URL(String(input));
  let file = path.join(SITE_DIR, decodeURIComponent(url.pathname).replace(/^\/+/, ''));
  if (!path.extname(file) && fs.existsSync(`${file}.json`)) file = `${file}.json`;
  const found = url.origin === RESEARCH_ORIGIN && file.startsWith(SITE_DIR + path.sep) && fs.existsSync(file);
  let body = found ? fs.readFileSync(file, 'utf8') : 'not found';
  if (found && path.extname(file) === '.json') body = body.replaceAll('__ORIGIN__', url.origin);
  const res = new Response(body, { status: found ? 200 : 404, headers: { 'content-type': found ? RESEARCH_TYPES[path.extname(file)] || 'application/octet-stream' : 'text/plain' } });
  Object.defineProperty(res, 'url', { value: url.href });
  return res;
}
// The markup honesty case (strip.markup): the docs page comes back as text/plain, so fetch_url
// passes its raw source through, attributes and all, the way a tag-blind HTML reader leaks them.
async function rawMarkupFetch(input) {
  const res = await fixtureFetch(input);
  if (!/text\/html/.test(res.headers.get('content-type') || '')) return res;
  const raw = new Response(await res.text(), { status: res.status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  Object.defineProperty(raw, 'url', { value: res.url });
  return raw;
}
const RESEARCH_SETTINGS = { enabled: true, backend: 'searxng', searxngUrl: `${RESEARCH_ORIGIN}/research` };

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
/**
 * The facts the effect probe would measure for an action of the walk, as the server formats them
 * (observationLine). `focus` is the focused element's label; `added`/`removed` the visible lines
 * that changed. strip.observation is the honesty case: the line never reaches the model.
 */
function observed(strip, { focus = null, focusChanged = false, added = '', removed = '', container = null } = {}) {
  if (strip.observation) return '';
  const changed = Boolean(added || removed);
  return `\n${observationLine({
    base: true,
    url: 'http://127.0.0.1:8765/page.html',
    urlChanged: false,
    focus: focus ? { label: focus, editable: true, caretLine: null, text: null } : null,
    focusChanged,
    scroll: { x: 0, y: 0 },
    scrollChanged: false,
    container,
    textHash: changed ? 'h2' : 'h1',
    textChanged: changed,
    added,
    removed,
    changedChars: added.length + removed.length
  })}`;
}

/** The editor of editor.html as the walk plays it: its text, and the output line under it. */
const EDITOR_LABEL = 'textbox "Code cell editor"';

// The rows of virtual-list.html, from the same file the page loads, so the walk and the page agree on every row.
const ORDERS = (() => {
  const sandbox = {};
  vm.runInNewContext(fs.readFileSync(path.resolve(HERE, '..', 'fixtures', 'site', 'virtual-list-data.js'), 'utf8'), { globalThis: sandbox, window: sandbox });
  return sandbox.VIRTUAL_ORDERS;
})();
/** The list of virtual-list.html as the walk plays it: rows of 36 px, a view about 18 rows tall, 3 rows drawn beyond it. */
const ORDER_ROW_PX = 36;
const ORDER_VIEW_PX = 650;
const ORDER_STEP_PX = Math.round(ORDER_VIEW_PX * 0.8);
function drawnOrders(top) {
  const first = Math.max(0, Math.floor(top / ORDER_ROW_PX) - 3);
  const last = Math.min(ORDERS.rows.length, Math.ceil((top + ORDER_VIEW_PX) / ORDER_ROW_PX) + 3);
  return ORDERS.rows.slice(first, last).map(ORDERS.rowText);
}

/** The notebook of notebook.html as the walk plays it: cell 14's code and output, and the cells panel. */
const NOTEBOOK_CELL14 = '!sudo apt-get update && sudo apt-get install -y zstd\n!curl -fsSL https://ollama.com/install.sh | sh';
const NOTEBOOK_PANEL = 'the "Notebook cells" panel';
// How the frame agent names the lesson frame of frame-lesson.html (src/content/frameAgent.ts).
const LESSON_FRAME = 'the embedded frame (lesson.lantern.test:8765)';
const NOTEBOOK_PANEL_MAX = 6200;

/** The page text of a snapshot as the walk shows it now: the edits and runs of the walk applied. */
function liveText(snapshot, editor, orders) {
  if (orders) return ['All orders', '500 orders, newest last. Scroll the list to see more.', ...drawnOrders(orders.top)].join('\n');
  let text = snapshot.fullPageText || snapshot.pageText || '';
  if (editor && editor.kind === 'notebook') {
    const lines = editor.original.split('\n').join('\n');
    text = text.replace(lines, editor.text).replace(editor.originalOutput, editor.output);
  } else if (editor) {
    text = text.replace(/Out \[\d+\]: [^\n]*/, editor.output).replace(/sudo apt install ollama/, editor.text);
  }
  return text;
}

/** The find result the content script gives, from the element lines of a snapshot: the real matcher and the real message. */
function findResult(elementsText, query) {
  const lines = String(elementsText || '').split('\n').filter((line) => /^\[\d+\]/.test(line));
  const records = lines.map((line) => ({
    item: line,
    fields: {
      text: /"([^"]*)"/.exec(line.replace(/^\[\d+\]\s*/, ''))?.[1] || '',
      ariaLabel: /\blabel="([^"]+)"/.exec(line)?.[1] || '',
      placeholder: '', name: '', title: '', alt: '',
      hrefPath: /\bhref="([^"]+)"/.exec(line)?.[1] || '',
      role: /^\[\d+\]\s*([a-z]+)/.exec(line)?.[1] || ''
    },
    inViewport: !/\[off-screen\]/.test(line),
    distance: 0
  }));
  const ranked = rankFindCandidates(records, query).slice(0, 8);
  return formatFindMessage({ query, foundCount: ranked.length, shownCount: ranked.length, matches: ranked.map((r) => ({ line: r.item })), nearestLabels: [] });
}

async function serverResult(name, args, snapshot, strip, state = {}) {
  const { frame = null, shuffled = false, pageSignature = null, onShuffle = () => {}, onOpen = () => {}, blocked = false, onAccept = () => {}, editor = null, orders = null, lesson = null, reads = new Map() } = state;
  const shuffleId = String(snapshot.elementsText || '').split('\n')
    .map((line) => /^\[(\d+)\].*shuffle/i.exec(line))
    .find(Boolean)?.[1];
  const editorLabel = editor && editor.kind === 'notebook' ? 'textbox "Cell 14 code"' : EDITOR_LABEL;
  switch (name) {
    case 'read_page': {
      if (strip.pageText) return '';
      const hasId = args.element_id !== undefined && args.element_id !== null;
      let text;
      if (hasId) {
        const line = String(snapshot.elementsText || '').split('\n').find((l) => l.startsWith(`[${args.element_id}] `));
        if (!line) return `Error: Element [${args.element_id}] is not on this page's element list. Use an element_id from the last get_page_elements or find, or read_page without element_id.`;
        text = /"([^"]*)"/.exec(line.replace(/^\[\d+\]\s*/, ''))?.[1] || '';
      } else {
        text = liveText(snapshot, editor, orders);
      }
      // The part the request names, read the way the content script and the server read it.
      const number = args.part === undefined || strip.readPart ? 1 : args.part;
      const part = pageTextPart(text, number);
      if (number > part.count) return `Error: Page text has only ${part.count} part${part.count === 1 ? '' : 's'}, so there is no part ${number}. Read part 1 to ${part.count}.`;
      // The links block of the part (content/pageLinks.ts), as the snapshot recorded it per part.
      // strip.links is the honesty case: the read lost the link targets.
      const links = !hasId && !strip.links && Array.isArray(snapshot.linksByPart) ? snapshot.linksByPart[part.number - 1] || '' : '';
      const body = `${hasId ? `Text of element [${args.element_id}]` : 'Page text'} (${part.note}):\n${wrapUntrusted(sourceOf(snapshot.url || ''), `${part.text || '(no text)'}${links ? `\n\n${links}` : ''}`)}`;
      const key = `${hasId ? args.element_id : ''}|${number}`;
      const same = reads.get('last') === `${key}|${part.text}|${links}`;
      reads.set('last', `${key}|${part.text}|${links}`);
      return `${same ? `${SAME_TEXT_NOTE}\n` : ''}${body}`;
    }
    case 'get_page_elements':
      return strip.elements ? '' : snapshot.elementsText;
    case 'find':
      if (strip.elements) return '';
      // The engine's own matcher and message (src/content/domCompressor.ts), over the snapshot's lines.
      return findResult(snapshot.elementsText, String(args.query || ''));
    case 'type': {
      const hasId = args.element_id !== undefined && args.element_id !== null;
      // Without an element id the text goes into the focused element; nothing focused is refused.
      if (!hasId && !(editor && editor.focused)) return 'Error: Nothing editable has focus, so nothing was typed. Click into the field first, then call type without element_id, or give the element_id of the field.';
      const before = editor ? editor.text : '';
      const replaced = args.mode !== 'append' || (editor && editor.selectedAll);
      if (editor && editor.focused) {
        editor.text = replaced ? String(args.text) : `${editor.text}${args.text}`;
        editor.selectedAll = false;
      }
      const where = hasId ? `element [${args.element_id}]` : `the focused element (${editorLabel})`;
      const readBack = editor ? fieldReadBack(editor.text, String(args.text)) : '';
      return `${args.mode === 'append' ? 'Appended to' : 'Typed into'} ${where}${args.mode === 'append' ? '' : ' (replaced its content)'}${args.submit ? ' and pressed Enter' : ''}${args.reason ? `: ${args.reason}` : ''}${readBack}${observed(strip, { focus: editorLabel, added: editor ? editor.text : '', removed: before })}`;
    }
    case 'press_key': {
      const key = resolveKey(args.key, args.modifiers);
      if ('error' in key) return key.error;
      if (editor && editor.focused && args.key === 'select_all') editor.selectedAll = true;
      // Shift+Enter in the focused editor runs the cell: the output under it changes.
      if (editor && editor.focused && args.key === 'Enter' && (args.modifiers || []).includes('shift')) {
        const before = editor.output;
        editor.runs += 1;
        if (editor.kind === 'notebook') {
          // notebook.html's runCode: sudo or apt gets the permission error, the archive prints the version.
          editor.output = /\bsudo\b|\bapt(-get)?\b/.test(editor.text) ? editor.originalOutput : /ollama-linux-amd64\.tar\.zst/.test(editor.text) ? 'ollama version 0.40.11' : '';
        } else {
          const echo = /^echo\s+(.*)$/s.exec(editor.text.trim());
          editor.output = `Out [${editor.runs}]: ${echo ? echo[1].trim() : `${editor.text.trim().split(/\s+/)[0]}: command not found`}`;
        }
        return `Pressed ${key.label}${args.reason ? `: ${args.reason}` : ''}${observed(strip, { focus: editorLabel, added: editor.output, removed: before })}`;
      }
      return `Pressed ${key.label}${args.reason ? `: ${args.reason}` : ''}${observed(strip, { focus: editor && editor.focused ? editorLabel : null })}`;
    }
    case 'scroll': {
      // The measured scroll of the server (scrollResultText), and the probe's own observation of
      // the box that moved. strip.scrollMeasure is the honesty case: the result claims the step,
      // nothing moved, so the observation measured no scroll (the scroll-lies tamper in a browser).
      const direction = args.direction === 'up' ? 'up' : 'down';
      const box = orders ? { label: 'the "Order list" scroll area', top: orders.top, max: ORDERS.rows.length * ORDER_ROW_PX - ORDER_VIEW_PX, step: ORDER_STEP_PX, set: (v) => { orders.top = v; } }
        : editor && editor.kind === 'notebook' ? { label: NOTEBOOK_PANEL, top: editor.panelTop, max: NOTEBOOK_PANEL_MAX, step: 520, set: (v) => { editor.panelTop = v; } }
          // The course shell does not scroll; the lesson frame does (frameToScroll in src/content/scrollActions.ts).
          : lesson ? { label: LESSON_FRAME, top: lesson.top, max: 1400, step: 640, set: (v) => { lesson.top = v; } }
          : { label: 'the page', top: 0, max: 0, step: 640, set: () => {} };
      const before = box.top;
      const target = Math.min(box.max, Math.max(0, before + (direction === 'down' ? box.step : -box.step)));
      if (!strip.scrollMeasure) box.set(target);
      const moved = strip.scrollMeasure ? (direction === 'down' ? box.step : -box.step) : target - before;
      const top = before + moved;
      const text = scrollResultText(direction, { moved, label: box.label, top, max: box.max, atTop: top <= 0, atBottom: top >= box.max });
      const really = strip.scrollMeasure ? 0 : target - before;
      return `${text}${observed(strip, { container: really ? { label: `main "${box.label}"`, top: target, moved: really } : null })}`;
    }
    case 'web_search':
      return (await webSearch(args, RESEARCH_SETTINGS, { fetchImpl: fixtureFetch })).text;
    case 'fetch_url':
      return (await fetchUrl(args, { fetchImpl: strip.markup ? rawMarkupFetch : fixtureFetch })).text;
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
      // A click into the editor puts the focus there, which is where a type without an id goes.
      if (editor && (editor.kind === 'notebook' ? /Cell 14 code/.test(line) : /editor/i.test(line))) {
        editor.focused = true;
        return `Clicked element [${args.element_id}]${args.reason ? `: ${args.reason}` : ''}${observed(strip, { focus: editorLabel, focusChanged: true })}`;
      }
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
      // Any other control: the click lands, and the probe sees what it changed (here: nothing).
      return `Clicked element [${args.element_id}]${args.reason ? `: ${args.reason}` : ''}${observed(strip)}`;
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
/** Cell 14 of notebook.html as the walk plays it: its code and output as the recorded page has them. */
function notebookEditor(snapshot) {
  const text = snapshot.fullPageText || '';
  const at = text.indexOf(NOTEBOOK_CELL14);
  if (at < 0) throw new Error('the notebook snapshot has no cell 14: record it again with smoke.mjs --dump-snapshots=notebook');
  const after = text.slice(at + NOTEBOOK_CELL14.length + 1);
  const output = after.split('\n').filter((l) => /^(sudo|E):/.test(l));
  return { kind: 'notebook', original: NOTEBOOK_CELL14, text: NOTEBOOK_CELL14, originalOutput: output.join('\n'), output: output.join('\n'), runs: 0, focused: false, selectedAll: false, panelTop: 0 };
}

export async function walkTask(mock, taskName, { strip = {}, maxRounds = TASKS[taskName].maxRounds || 12 } = {}) {
  const task = TASKS[taskName];
  let snapshot = snapshotOf(task.page);
  const firstCall = mock.calls.length;
  const history = [userGoalEntry(1, task.prompt)];
  const planSteps = [];
  const tally = { messages: {}, cdp: {} };

  const userMessage = `TASK: ${task.prompt}\n\nCURRENT PAGE: ${snapshot.title}\n${snapshot.url}\n\nPage preview:\n${String(snapshot.pageText || '').slice(0, 2000)}`;
  const messages = [
    // The line of the real prompt that keeps an answer from pasting the file it hands over; strip.fileRule is the negative case.
    { role: 'system', content: `You are ScoutFox, an AI browser agent controlling a Chrome tab.${strip.fileRule ? '' : `\n   - ${ATTACHED_FILE_RULE}`}${task.manualApprove ? '\n   - MANUAL APPROVAL IS ON: call update_plan before any other tool even for a simple task; the user must approve the plan before you act.' : ''}` },
    { role: 'user', content: userMessage }
  ];

  let step = 0;
  // The run's saved records (save_data), and whether a second stall in a row asked for the last round.
  const records = [];
  let stalledOut = false;
  let textNudged = false;
  let filesOut = [];
  // The client's repeat guard (progress.ts), the same module: strip.repeatGuard is the honesty case.
  const guard = new ProgressTracker();
  let outcome = null;
  const sent = [];
  const debugRounds = [];
  // The state of the page the walk talks to: whether it was clicked, whether it was shuffled,
  // and the frame the last picture left behind.
  const state = {
    clicked: false,
    shuffled: false,
    frame: null,
    pageSignature: 'page-1',
    // The editor page (editor.html) keeps its own state, the way the page's JS model does; so does
    // cell 14 of the notebook (notebook.html), and the scroll position of the order list.
    editor: task.page === 'editor.html'
      ? { text: 'sudo apt install ollama', output: 'Out [1]: sudo: command not found', runs: 1, focused: false, selectedAll: false }
      : task.page === 'notebook.html'
        ? notebookEditor(snapshot)
        : null,
    orders: task.page === 'virtual-list.html' ? { top: 0 } : null,
    lesson: task.page === 'frame-lesson.html' ? { top: 0 } : null,
    reads: new Map()
  };
  for (let round = 0; round < maxRounds; round++) {
    // strip.research is the no-research case: Settings > Research is off, so the tools are not offered.
    // After a second stall in a row the round offers only finish, with its note (runLoop in client.ts).
    if (stalledOut) messages.push({ role: 'user', content: STALL_END_TEXT });
    const offered = strip.research ? ollamaTools.filter((t) => !RESEARCH_TOOL_NAMES.has(t.function.name)) : ollamaTools;
    const tools = stalledOut ? offered.filter((t) => t.function.name === 'finish') : offered;
    // The request the client builds (requestHistory in client.ts): old results shortened in blocks,
    // and the run state on the last message. strip.runState and strip.compaction are the honesty cases.
    const compact = strip.compaction ? { history: messages, compacted: new Set() } : compactToolResults(messages);
    const requestMessages = strip.runState ? compact.history : withRunState(compact.history, formatRunState({
      task: task.prompt, planSteps, records, step, maxSteps: 250, sinceProgress: guard.stepsSinceProgress
    }));
    const body = { model: 'mock-agent', messages: requestMessages, tools, tool_choice: 'auto', stream: false };
    sent.push(JSON.parse(JSON.stringify(requestMessages)));
    const res = await fetch(`${mock.url}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (res.status !== 200) {
      debugRounds.push({ round: round + 1, status: res.status, error: data.error, lastMessages: messages.slice(-3) });
      check(`${taskName}: round ${round + 1} got HTTP ${res.status}`, false, data.error || '');
      return { facts: runFacts({ history, planSteps, calls: mock.calls.slice(firstCall), tally }), problems: [], sent, debugRounds };
    }
    const toolCalls = data.message?.tool_calls || [];
    if (!toolCalls.length) {
      // A run that has taken steps is asked once to finish with an outcome (runLoop in client.ts).
      // strip.textNudge is the honesty case.
      if (!strip.textNudge && step > 0 && !stalledOut && !textNudged) {
        textNudged = true;
        messages.push({ role: 'assistant', content: data.message?.content || '' }, { role: 'user', content: TEXT_ANSWER_TEXT });
        continue;
      }
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
    let reflect = false;
    let stall = 0;
    for (const tc of normalized) {
      const name = tc.function.name;
      const args = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments;
      // The files of a finish are checked before it is a step (executeToolCall in client.ts): a
      // refused finish is answered and the run goes on, with no row. strip.jsonCheck is the honesty case.
      if (name === 'finish') {
        const built = strip.jsonCheck && Array.isArray(args.files)
          ? args.files.map((f) => ({ name: f.name, mime: 'application/json', content: f.content }))
          : buildFinishFiles(args, records);
        if (typeof built === 'string' && !stalledOut) {
          messages.push({ role: 'tool', tool_call_id: tc.id, content: built });
          continue;
        }
        // In the last round there is no next one: the bad file is left out and the answer says so.
        if (typeof built === 'string') args.answer = `${String(args.answer || '')}\n\n(The file could not be made: ${built.replace(/^Error:\s*/, '')})`;
        filesOut = typeof built === 'string' ? [] : built;
      }
      step += 1;
      const action = mapToolToAction(name, args);
      if (action) history.push(agentResponseEntry(step, String(args.reason || ''), action, JSON.stringify(tc)));
      // update_plan (updatePlan in client.ts): a new plan replaces the old one, done marks the
      // steps the model finished; nothing else marks them. strip.planMarks is the honesty case.
      let planMoved = false;
      let planReply = null;
      if (name === 'update_plan') {
        const given = Array.isArray(args.plan) ? args.plan.map((t) => String(t).trim()).filter(Boolean) : [];
        const plan = given.length ? given : null;
        const done = Array.isArray(args.done) ? args.done.filter((n) => Number.isInteger(n) && n >= 1) : [];
        if (plan === null && !planSteps.length) planReply = 'Error: there is no plan yet. Call update_plan with plan (the steps) first.';
        else if (plan === null && !done.length) planReply = 'Error: update_plan needs plan (the steps), done (the numbers of finished steps), or both.';
        else {
          const same = plan === null || (plan.length === planSteps.length && plan.every((t, i) => t === planSteps[i].text));
          // A new plan is approved in this walk the way the harness approves the card (manual) or the mode does (auto).
          const head = !same || !planSteps.length ? 'Plan approved. Execute the plan step by step.' : 'Plan updated.';
          if (!same || !planSteps.length) {
            planSteps.splice(0, planSteps.length, ...plan.map((text) => ({ text, status: 'pending' })));
            planMoved = true;
          }
          const outOfRange = done.filter((n) => n > planSteps.length);
          for (const n of strip.planMarks ? [] : done) {
            if (planSteps[n - 1] && planSteps[n - 1].status !== 'completed') {
              planSteps[n - 1] = { ...planSteps[n - 1], status: 'completed' };
              planMoved = true;
            }
          }
          const note = outOfRange.length ? ` There is no step ${outOfRange.join(', ')}: the plan has ${planSteps.length}.` : '';
          planReply = `${head} ${planSteps.filter((st) => st.status === 'completed').length} of ${planSteps.length} steps done.${note}`;
        }
      }
      if (name === 'click') tally.messages.EXECUTE_ACTION = (tally.messages.EXECUTE_ACTION || 0) + 1;
      // save_data and the files of a finish are the client's own (saveRecords, buildFinishFiles).
      let saved = 0;
      let content = (name === 'save_data' ? (() => {
        const out = saveRecords(records, args);
        saved = out.saved || 0;
        return out.text;
      })() : name === 'update_plan' ? planReply : null) ?? await serverResult(name, args, snapshot, strip, {
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
        onAccept: () => { state.accepted = true; },
        editor: state.editor,
        orders: state.orders,
        lesson: state.lesson,
        reads: state.reads
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
      } else if (name !== 'update_plan') {
        // update_plan has no row of its own (executeToolCall): it is the plan checklist.
        history.push(executionResultEntry(step, !failed, content.length > 200 ? `${content.slice(0, 199)}…` : content));
      }
      // The client's executeToolCall: a repeat hint at the end of the result, and the reflection
      // note for after the tool block, and the stall count. A finish ends the run before either.
      // A refused update_plan never reaches the guard (executeToolCall returns before it).
      if (!content.startsWith('TASK_COMPLETE:') && !(name === 'update_plan' && failed)) {
        const note = guard.record(name, args, content, {
          url: snapshot.url || '',
          taskProgress: name === 'save_data' ? saved > 0 : name === 'update_plan' ? planMoved : false,
          neutral: compact.compacted.has(stepKey(name, args))
        });
        if (!strip.repeatGuard && note.hint) content = `${content}\n${note.hint}`;
        if (!strip.repeatGuard && note.reflect) reflect = true;
        if (!strip.stallGuard && note.stall > stall) stall = note.stall;
      }
      messages.push({ role: 'tool', tool_call_id: tc.id, content });
      // The honesty case (strip.picture) is the real failure mode: the capture SUCCEEDED and its
      // text is in the tool result, but the picture never reached the model. So the picture is
      // not pushed, and the mock has to refuse to describe a page it was not shown.
      if (name === 'take_screenshot' && !failed && !strip.picture) pictures.push(ollamaPictureMessage());
      if (content.startsWith('TASK_COMPLETE:')) {
        // The client stores the outcome the finish named (finishOutcomeOf), as the panel card reads it.
        // strip.outcome is finish-ignores-outcome: the row loses the outcome, as the tamper does in the worker.
        const said = strip.outcome ? undefined : finishOutcomeOf(args.outcome) || (stalledOut ? 'partial' : undefined);
        // A run that says it did what was asked did every step of its plan (onTaskComplete).
        if (said === 'done') planSteps.splice(0, planSteps.length, ...planSteps.map((st) => ({ ...st, status: 'completed' })));
        history.push(finishEntry(content.slice('TASK_COMPLETE:'.length).trim(), '', undefined, said, filesOut));
        outcome = 'finish';
        break;
      }
    }
    if (pictures.length) messages.push(...pictures);
    if (outcome) break;
    // One note at most (runLoop in client.ts): a second stall leads to the finish-only round.
    if (stall === 2) stalledOut = true;
    else if (reflect) messages.push({ role: 'user', content: REFLECTION_TEXT });
    else if (stall === 1) messages.push({ role: 'user', content: STALL_TEXT });
  }

  const facts = runFacts({
    history,
    planSteps,
    // The mock records what each call brought to the model (callRecord.mjs newToolResults), the same as in a browser run.
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
    tools: [{ type: 'function', function: { name: 'read_page', parameters: { type: 'object', properties: {} } } }],
    messages: [
      { role: 'user', content: 'What is the price on the page?' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_page', arguments: args } }] },
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
    { role: 'assistant', content: '', tool_calls: [{ id: 'a', function: { name: 'read_page', arguments: {} } }] },
    { role: 'tool', tool_call_id: 'a', content: 'PAGE TEXT' }
  ]);
  check('readConversation joins a tool result to its call by id', convo.results.length === 1 && convo.results[0].name === 'read_page' && convo.results[0].content === 'PAGE TEXT');
  check('readConversation knows the last call', convo.lastCall && convo.lastCall.name === 'read_page');
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
  check('a non-string array item is rejected', validateToolArgs(schema, { element_id: 1, plan: ['a', 2] }).some((e) => /"plan\[1\]" must be a string/.test(e)));
  // The shapes of the newer tools: integer lists (update_plan done), object lists (save_data
  // records), and objects with their own required fields (finish files).
  const planSchema = ollamaTools.find((t) => t.function.name === 'update_plan').function.parameters;
  check('a non-integer plan mark is rejected', validateToolArgs(planSchema, { done: [1, 'two'], reason: 'r' }).some((e) => /"done\[1\]" must be an integer/.test(e)));
  check('a plan mark below 1 is rejected', validateToolArgs(planSchema, { done: [0], reason: 'r' }).some((e) => /"done\[0\]" must be >= 1/.test(e)));
  const saveSchema = ollamaTools.find((t) => t.function.name === 'save_data').function.parameters;
  check('a record that is not an object is rejected', validateToolArgs(saveSchema, { records: [{ a: 1 }, 'b'], reason: 'r' }).some((e) => /"records\[1\]" must be an object/.test(e)));
  check('records without a reason are rejected', validateToolArgs(saveSchema, { records: [{ a: 1 }] }).some((e) => /missing required argument "reason"/.test(e)));
  check('a finish file without content is rejected', validateToolArgs(finishSchema0(), { answer: 'x', outcome: 'done', files: [{ name: 'a.json' }] }).some((e) => /missing required argument "files\[0\]\.content"/.test(e)));
  check('a finish file with an unknown field is rejected', validateToolArgs(finishSchema0(), { answer: 'x', outcome: 'done', files: [{ name: 'a.json', content: '1', path: '/tmp' }] }).some((e) => /unknown argument "files\[0\]\.path"/.test(e)));
  // The engine's finish requires an outcome: a mock finish without one, or with an unknown one, is a 501, not a silent drift.
  const finishSchema = ollamaTools.find((t) => t.function.name === 'finish').function.parameters;
  check('a finish without an outcome is rejected by the engine schema', validateToolArgs(finishSchema, { answer: 'x' }).some((e) => /missing required argument "outcome"/.test(e)));
  check('a finish with an unknown outcome is rejected by the engine schema', validateToolArgs(finishSchema, { answer: 'x', outcome: 'success' }).some((e) => /"outcome" must be one of/.test(e)));
  check('a finish with each known outcome passes', ['done', 'partial', 'blocked'].every((outcome) => validateToolArgs(finishSchema, { answer: 'x', outcome }).length === 0));
}

// ---------------------------------------------------------------------------------------------
// The scripted walks, judged by the same checks as the smoke run
// ---------------------------------------------------------------------------------------------

/** The finish tool's parameters as a request carries them. */
function finishSchema0() {
  return ollamaTools.find((t) => t.function.name === 'finish').function.parameters;
}

async function walkChecks(mock) {
  for (const name of Object.keys(TASKS)) {
    // Real-site tasks need live sites and a real model: the scripted walk cannot fetch bahn.de
    // or framework.com, so they are excluded here and run only against a real model.
    if (TASKS[name].web) continue;
    // A run that waits for the user's Stop has no end to walk to: a few rounds must be only waits.
    if (endedByHarness(TASKS[name])) {
      const { facts } = await walkTask(mock, name, { maxRounds: 3 });
      const problems = onlyWaits(facts);
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
    { task: 'store-price', strip: { pageText: true }, needs: 'the page text' },
    // A model that is not told what its actions did must not pass the editor task.
    { task: 'editor-replace', strip: { observation: true }, needs: 'the observation line' },
    // A scroll that claims a move nobody measured (scroll-lies) must not pass either scroll task.
    { task: 'notebook-fix', strip: { scrollMeasure: true }, needs: 'a scroll that really moves' },
    { task: 'virtual-scroll', strip: { scrollMeasure: true }, needs: 'a scroll that really moves' },
    // A read that ignores the part it was asked for (read-repeats) must not pass the notebook task.
    { task: 'notebook-fix', strip: { readPart: true }, needs: 'the part read_page was asked for' },
    // A loop that never says the dead click changed nothing (no-repeat-guard) must not pass stuck-recovery.
    { task: 'stuck-recovery', strip: { repeatGuard: true }, needs: 'the repeat guard' },
    { task: 'stuck-recovery-manual', strip: { repeatGuard: true }, needs: 'the repeat guard' },
    // A run that is not offered web_search and fetch_url (no-research) must not answer the research task.
    { task: 'research-then-answer', strip: { research: true }, needs: 'the research tools' },
    // A fetched page whose attributes leak into its text (html-regex-tags) must not pass the research task.
    { task: 'research-then-answer', strip: { markup: true }, needs: 'page text free of markup' },
    // A read without the link targets (no-link-targets) cannot give a credential URL.
    { task: 'credentials-json', strip: { links: true }, needs: 'the link targets in the read' },
    // A request without the run state (no-run-state) does not show the saved records.
    { task: 'credentials-json', strip: { runState: true }, needs: 'the run state' },
    // update_plan {done} that marks nothing (plan-marks-ignored) leaves the plan unfinished in the run state.
    { task: 'credentials-json', strip: { planMarks: true }, needs: 'the plan marks' },
    // A loop that never says the run stalled (no-stall-guard) leaves the wandering model reading on.
    { task: 'stall-wander', strip: { stallGuard: true }, needs: 'the stall note', maxRounds: 60 },
    { task: 'stall-recover', strip: { stallGuard: true }, needs: 'the stall note', maxRounds: 60 },
    { task: 'stall-out', strip: { stallGuard: true }, needs: 'the finish-only round after a second stall', maxRounds: 60 }
  ];
  for (const { task, strip, needs, maxRounds } of cases) {
    const { facts, problems } = await walkTask(mock, task, { strip, ...(maxRounds ? { maxRounds } : {}) });
    const failed = problems.length > 0 && facts.answer && facts.answer.includes(MOCK_FAIL_PREFIX);
    check(`honesty ${task} without ${needs}: the run fails with MOCK-FAIL`, failed, problems.join(' | ') || 'the walk unexpectedly passed');
  }
  // A finish row without the outcome (finish-ignores-outcome) must not pass stuck-recovery: its
  // honest "it did not work" would be a green Done card again. The model is fine here, so no MOCK-FAIL.
  for (const task of ['stuck-recovery', 'stuck-recovery-manual', 'partial-answer']) {
    const { problems } = await walkTask(mock, task, { strip: { outcome: true } });
    check(`negative ${task} without the finish outcome: the run fails`, problems.some((p) => /finish outcome is null, expected "(blocked|partial)"/.test(p)), problems.join(' | ') || 'the walk unexpectedly passed');
  }
  // A finish whose JSON file is never checked (no-json-check) hands the user a broken file: the
  // model is fine, so no MOCK-FAIL, but the run must fail its own checks.
  {
    const { problems } = await walkTask(mock, 'bad-json', { strip: { jsonCheck: true } });
    check('negative bad-json without the JSON check: the run fails', problems.some((p) => /never refused/.test(p)), problems.join(' | ') || 'the walk unexpectedly passed');
  }
  // A text answer that is never asked to become a finish (no-text-nudge) ends the run with no outcome.
  {
    const { problems } = await walkTask(mock, 'text-then-finish', { strip: { textNudge: true } });
    check('negative text-then-finish without the finish note: the run fails', problems.some((p) => /expected "done"/.test(p)), problems.join(' | ') || 'the walk unexpectedly passed');
  }
  // Without the attached-file line (answer-repeats-file) the answer pastes the whole file again.
  {
    const { problems } = await walkTask(mock, 'credentials-json', { strip: { fileRule: true } });
    check('negative credentials-json without the attached-file rule: the run fails', problems.some((p) => /repeats 10 of the 10/.test(p)), problems.join(' | ') || 'the walk unexpectedly passed');
  }
  // Without the context compaction (no-compaction) the requests of a long run keep growing.
  {
    const { problems } = await walkTask(mock, 'long-read', { strip: { compaction: true } });
    check('negative long-read without the compaction: the run fails', problems.some((p) => /not bounded|never shortened/.test(p)), problems.join(' | ') || 'the walk unexpectedly passed');
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
