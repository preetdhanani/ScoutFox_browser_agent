/**
 * An offline stand-in for Ollama, for `smoke.mjs --mock` (CI runs this: no model, no Ollama).
 *
 * It speaks what the extension calls for provider "ollama", on the same port as the real-mode
 * proxy (11435):
 *   POST /api/chat     what the MCP tool loop sends (callOllamaWithTools): stream:false, a `tools`
 *                      array in the Ollama function format, and messages that carry assistant
 *                      tool_calls and tool results. The reply is one JSON object whose message
 *                      holds `tool_calls` (name + arguments object), as Ollama answers a
 *                      tool-calling request. A request without tools gets 501: nothing in the
 *                      extension calls /api/chat without tools any more.
 *   POST /api/show     the details of one model, as Ollama answers: details.parameter_size, capabilities
 *   GET  /api/tags     the model list (the side panel asks for it when it opens)
 *   GET  /api/version
 *   OPTIONS            CORS preflight
 * A request that is not valid JSON gets HTTP 400, as does one whose assistant tool_calls carry
 * `arguments` as a string: real Ollama answers that with 400 "Value looks like object, but can't
 * find closing '}' symbol" (0.40.6), and a mock that tolerated it would let a bug through that kills
 * every multi-step run against a real server. A scripted reply whose tool name is not in the
 * request's tools, or whose arguments do not fit the tool's parameters schema, is an HTTP 500
 * (a mock bug, and a protocol drift is loud, not papered over).
 *
 * The script is stateless: it reads only the conversation of the request, the way a real model
 * would. It walks the fixture tasks like the MCP client drives them:
 *   - a bot check in the page text (the user message's preview, or a read_page result):
 *     finish at once with the honest answer. It never clicks a bot check;
 *   - a planning goal: update_plan with two steps (two steps auto-approve, so the run goes on),
 *     then read_page, then finish with the facts;
 *   - a click goal: get_page_elements, then click the element whose label matches the goal
 *     ("In den Warenkorb" for a cart goal), then finish;
 *   - a facts goal (price, shipping, delivery) or a summarize goal: read_page, then finish
 *     with the lines copied from the page text;
 *   - anything it cannot find in the conversation (an empty page, an unknown goal, a click
 *     target that is not on the page): a finish whose answer starts with "MOCK-FAIL:" and says
 *     what is missing. The run then ends without the data, and no check accepts it.
 *
 * This is fixture-specific by design: it understands the layout of tests/fixtures/site and the
 * message shape of src/background/mcp/client.ts. When either changes, update parseTaskMessage()
 * or the script below; the self-test (mockOllama.selftest.mjs) walks the tasks and shows what broke.
 */
import http from 'node:http';
import { buildCallRecord, MOCK_FAIL_PREFIX, runStateOf, withoutRunState } from './callRecord.mjs';
import { REFLECTION_TEXT, REPEAT_HINT_PREFIX, STALL_TEXT, STALL_END_TEXT } from '../../src/background/mcp/progress.ts';
import { TEXT_ANSWER_TEXT } from '../../src/background/mcp/client.ts';
import { UNTRUSTED_PREFIX } from '../../src/background/mcp/untrusted.ts';
import { DOCS_PROSE, LESSON_FACT, MARKUP_SENTINEL } from '../e2e/lib/twoSources.mjs';

export const MOCK_VERSION = '0.0.0-mock';
export { MOCK_FAIL_PREFIX };
// What /api/show and /api/tags tell about every model of the mock: a 9B model that CAN see and
// think. The capabilities matter: a model whose capabilities do not list "vision" is not offered
// the screenshot tool, and one without "thinking" is sent no `think` field (llm/effort.ts), so a
// mock without them could exercise neither path. A model whose name has "nothink" in it cannot
// think, and answers `think: true` with the 400 real Ollama sends.
export const MOCK_PARAMETER_SIZE = '9B';
export const MOCK_CAPABILITIES = ['completion', 'tools', 'vision', 'thinking'];
const NO_THINKING = /nothink/i;
/** The reasoning text the mock returns when it was asked to think, so the log path is exercised. */
export const MOCK_THINKING_TEXT = 'mock: thinking about the next step';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '600'
};

// ---------------------------------------------------------------------------------------------
// Reading the conversation
// ---------------------------------------------------------------------------------------------

/**
 * The MCP client's first user message (buildSystemPrompt's companion):
 *   TASK: <task>
 *   CURRENT PAGE: <title>
 *   <url>
 *   Page preview:
 *   <the first 2000 characters of the page text>
 * Anything not found comes back empty.
 */
export function parseTaskMessage(text) {
  const source = String(text || '');
  const task = /^TASK: (.*)$/m.exec(source)?.[1] ?? '';
  const page = /^CURRENT PAGE: (.*)\n(\S*)$/m.exec(source);
  const preview = /\nPage preview:\n([\s\S]*)$/.exec(source)?.[1] ?? '';
  return { task, title: page ? page[1] : '', url: page ? page[2] : '', preview: preview.trim() };
}

/**
 * Whether a message's content is a shape Ollama accepts: a string, or - on a USER message only -
 * an array of text and image blocks. The tool loop sends a picture that way (one user message
 * after the whole tool block), converted to Ollama's `images` array by toOllamaMessage. A
 * `role:'tool'` message with an array is refused, because no provider accepts a picture there.
 */
export function isMessageContent(message) {
  const content = message?.content;
  // The Ollama shape: the text in content, the pictures in a sibling images array.
  if (typeof content === 'string') {
    if (message.images === undefined) return true;
    return message.role === 'user' && Array.isArray(message.images) && message.images.every((i) => typeof i === 'string');
  }
  if (!Array.isArray(content)) return false;
  if (message.role !== 'user') return false;
  return content.every((block) => block
    && (block.type === 'text' || block.type === 'image_url')
    && (block.type !== 'text' || typeof block.text === 'string')
    && (block.type !== 'image_url' || typeof block.image_url?.url === 'string'));
}

/**
 * The conversation of one request as data: the task, and what each tool call of the LLM brought
 * back, in order. The mock has no memory between calls, so this is everything it knows.
 */
/** The tool calls of an assistant turn whose arguments are a string instead of an object. */
export function stringToolArguments(messages) {
  const offenders = [];
  for (const m of messages || []) {
    if (m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
    for (const tc of m.tool_calls) if (typeof tc?.function?.arguments === 'string') offenders.push(tc.function.name || 'unnamed');
  }
  return offenders;
}

export function readConversation(messages, tools) {
  const nameOfCallId = new Map();
  const calls = [];
  const results = [];
  const pendingCalls = [];
  for (const m of messages || []) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        let args = {};
        try { args = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : (tc.function.arguments || {}); } catch { /* the validator reports it */ }
        const call = { id: tc.id, name: tc.function.name, args };
        calls.push(call);
        if (tc.id) nameOfCallId.set(tc.id, tc.function.name);
        else pendingCalls.push(call);
      }
    }
    if (m.role === 'tool' && typeof m.content === 'string') {
      // A result joins its call by id; an id-less call (some providers omit it) is matched in order.
      const call = nameOfCallId.has(m.tool_call_id) ? null : pendingCalls.shift();
      const name = call ? call.name : (nameOfCallId.get(m.tool_call_id) || '?');
      // The run state rides on the last message of the request: it is not part of the result.
      results.push({ name, content: withoutRunState(m.content) });
    }
  }
  // A picture the client sends back. It arrives in ONE user message after the tool block of the
  // round that produced it, in one of the two shapes a provider takes:
  //   - the OpenAI-shaped request the client builds: content is an array with an image_url block;
  //   - the Ollama-shaped payload the client actually sends: the text stays in content and the
  //     pictures are a SIBLING images array of bare base64 (toOllamaMessage).
  // Both are counted, so the mock sees the picture whichever way the loop sent it.
  const pictures = [];
  for (const m of messages || []) {
    if (m.role !== 'user') continue;
    if (Array.isArray(m.images)) pictures.push(...m.images.map(String));
    if (!Array.isArray(m.content)) continue;
    for (const block of m.content) {
      if (block && block.type === 'image_url') pictures.push(block.image_url?.url || '');
    }
  }
  // The notes the loop itself adds as user text after a tool block (the reflection, the step
  // limit): every plain user message after the first assistant turn that carries no picture.
  const firstAssistant = (messages || []).findIndex((m) => m.role === 'assistant');
  const notes = firstAssistant < 0 ? [] : (messages || []).slice(firstAssistant)
    .filter((m) => m.role === 'user' && typeof m.content === 'string' && !Array.isArray(m.images))
    .map((m) => withoutRunState(m.content));
  const system = (messages || []).find((m) => m.role === 'system');
  const lastResultOf = (name) => [...results].reverse().find((r) => r.name === name)?.content ?? null;
  const firstUser = (messages || []).find((m) => m.role === 'user');
  const task = parseTaskMessage(firstUser ? withoutRunState(firstUser.content) : '');
  const pageText = lastResultOf('read_page');
  const elementsText = lastResultOf('get_page_elements') ?? lastResultOf('find');
  return {
    task: task.task,
    preview: task.preview,
    // The tool names the request offered. A script that depends on a tool being there or absent
    // reads this, so "the setting is obeyed" is checked on the wire and not assumed.
    tools: tools instanceof Map ? [...tools.keys()] : [],
    calls,
    results,
    lastCall: calls[calls.length - 1] || null,
    pageText: pageText ?? '',
    elementsText: elementsText ?? '',
    pictureCount: pictures.length,
    lastPicture: pictures[pictures.length - 1] || '',
    screenshotResult: lastResultOf('take_screenshot'),
    screenshotTaken: results.some((r) => r.name === 'take_screenshot' && !/^Error:/.test(r.content)),
    notes,
    // The last two messages of the request: where a note the loop added sits.
    tail: (messages || []).slice(-2).map((m) => ({ role: m.role, content: typeof m.content === 'string' ? withoutRunState(m.content) : '' })),
    // The run state the client added to the last message ("[Run state] Goal: ..."), or null.
    runState: runStateOf(messages),
    // The system prompt says so when the user approves every plan by hand.
    manualApproval: /MANUAL APPROVAL IS ON/.test(String(system ? system.content : '')),
    // The system prompt asks for a short sample, not the whole file, when a file is handed over (ATTACHED_FILE_RULE).
    attachedFileRule: /do not paste the whole file into the answer/.test(String(system ? system.content : '')),
    planApproved: results.some((r) => r.content.startsWith('Plan approved')),
    planRejected: results.some((r) => r.content.startsWith('Plan rejected'))
  };
}

/** The tools of the request as a Map (name -> {description, parameters}), or null when it carries none. */
function toolMapOf(request) {
  if (!Array.isArray(request.tools) || request.tools.length === 0) return null;
  const map = new Map();
  for (const t of request.tools) {
    if (t && t.function && typeof t.function.name === 'string') map.set(t.function.name, t.function);
  }
  return map;
}

// ---------------------------------------------------------------------------------------------
// The tool-argument validator (the subset of JSON Schema the tools of SCOUTFOX_TOOLS use)
// ---------------------------------------------------------------------------------------------

/**
 * Checks one tool's arguments against the `parameters` schema the request carried, as Ollama's
 * grammar would force. Supports what SCOUTFOX_TOOLS uses: type object, properties of type
 * string / number / boolean / string-array, enum, minimum, maximum, required, additionalProperties.
 */
export function validateToolArgs(parameters, args, where = '') {
  const errors = [];
  if (!parameters || typeof parameters !== 'object' || parameters.type !== 'object') return errors;
  const props = parameters.properties || {};
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  if (where && (!args || typeof args !== 'object' || Array.isArray(args))) return [`"${where}" must be an object`];
  for (const key of Object.keys(a)) {
    const name = where ? `${where}.${key}` : key;
    if (!(key in props)) {
      if (parameters.additionalProperties === false) errors.push(`unknown argument "${name}"`);
      continue;
    }
    errors.push(...valueErrors(props[key] || {}, a[key], name));
  }
  for (const key of parameters.required || []) {
    if (!(key in a)) errors.push(`missing required argument "${where ? `${where}.${key}` : key}"`);
  }
  return errors;
}

/**
 * The errors of one value against its schema: the scalar types, enum, minimum and maximum, arrays
 * with their items (strings, integers, enums, or objects checked like arguments), and objects.
 */
function valueErrors(schema, value, name) {
  const errors = [];
  if (schema.enum && !schema.enum.includes(value)) errors.push(`"${name}" must be one of ${JSON.stringify(schema.enum)}`);
  if (schema.type === 'string' && typeof value !== 'string') errors.push(`"${name}" must be a string`);
  if (schema.type === 'boolean' && typeof value !== 'boolean') errors.push(`"${name}" must be a boolean`);
  if (schema.type === 'integer' && !Number.isInteger(value)) errors.push(`"${name}" must be an integer`);
  if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof value !== 'number' || Number.isNaN(value)) errors.push(`"${name}" must be a number`);
    else {
      if (schema.minimum !== undefined && value < schema.minimum) errors.push(`"${name}" must be >= ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) errors.push(`"${name}" must be <= ${schema.maximum}`);
    }
  }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) errors.push(`"${name}" must be an object`);
    else if (schema.properties) errors.push(...validateToolArgs(schema, value, name));
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) errors.push(`"${name}" must be an array`);
    else if (schema.items) value.forEach((item, i) => errors.push(...valueErrors(schema.items, item, `${name}[${i}]`)));
  }
  return errors;
}

/**
 * The rules a plain JSON Schema cannot state, checked on a tool's arguments.
 *
 * click takes an element id OR a coordinate pair. The schema cannot say that with `required`, so
 * the server enforces it (coordinateClickRefusal in server.ts) and the mock enforces it here: a
 * schema drift is then a loud HTTP 500 instead of a click that quietly goes nowhere.
 */
export function validateToolRules(name, args) {
  const errors = [];
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  if (name === 'click') {
    const hasId = a.element_id !== undefined && a.element_id !== null;
    const hasX = a.x !== undefined && a.x !== null;
    const hasY = a.y !== undefined && a.y !== null;
    if (!hasId && !(hasX && hasY)) errors.push('needs either an element_id, or both x and y');
    if (!hasId && (hasX !== hasY)) errors.push('a coordinate click needs both x and y, not one of them');
  }
  return errors;
}

// ---------------------------------------------------------------------------------------------
// The script: what the mock answers, read only from the conversation
// ---------------------------------------------------------------------------------------------

// A line of the page text, or a cell of a table row (the extractor writes the cells of a row as "a | b | c").
const pageLines = (pageText) => String(pageText || '').split('\n').flatMap((l) => l.split(' | ')).map((l) => l.replace(/^#+\s*/, '').trim()).filter(Boolean);
const trimEnd = (l) => l.replace(/[.\s]+$/, '');

// German amounts as the fixture shows them: "1.399,00 EUR", "9,90 EUR".
const MONEY = /(\d{1,3}(?:\.\d{3})+|\d+),(\d{2})\s*(?:EUR|€)/;

/**
 * The goal kinds the mock knows. The offline suite keeps two fixture tasks (a price question on
 * the store page, and the same question after the composer's model pick), so one kind is enough:
 * the facts a shop page states. Everything else is the real model's job, on the open web.
 */
export function kindOfGoal(goal) {
  // A run that only ends when the user clicks Stop (the user-stop task).
  if (/\bkeep waiting\b/i.test(String(goal || ''))) return 'wait';
  // The certifications page (credentials.html): a JSON file of the records (credentials-json), a
  // field the page never shows (stall-wander), a run that recovers after the stall note
  // (stall-recover), a hand-written JSON file that is broken first (bad-json), and a long run of
  // reads for the context compaction (long-read).
  if (/\bjson file of the certifications\b/i.test(String(goal || ''))) return 'records';
  if (/\bcredential expires\b/i.test(String(goal || ''))) return 'wander';
  if (/\bperson who signed\b/i.test(String(goal || ''))) return 'stubborn';
  if (/\bhow many certifications does this page list\b/i.test(String(goal || ''))) return 'textfirst';
  if (/\bwith the issuer of each\b/i.test(String(goal || ''))) return 'recover';
  if (/\bsmall json file\b/i.test(String(goal || ''))) return 'badjson';
  if (/\btwelve times\b/i.test(String(goal || ''))) return 'longread';
  // Open one link of several with the same label, far below the first screen (the far-link task).
  if (/\bopen the configure now link\b/i.test(String(goal || ''))) return 'open';
  // The same, on a page whose consent banner swallows clicks until it is answered (consent-link).
  if (/\bopen the configurator\b/i.test(String(goal || ''))) return 'consent';
  // Replace the code of a notebook-like editor and run it (the editor-replace task).
  if (/\bcode editor\b/i.test(String(goal || ''))) return 'editor';
  // Fix cell 14 of a JupyterLab-like notebook whose cells scroll in a panel (notebook-fix).
  if (/\bcell 14 of this notebook\b/i.test(String(goal || ''))) return 'notebook';
  // A lesson that lives in a cross-origin iframe of a shell that does not scroll (frame-lesson).
  if (/\breview code of this lesson\b/i.test(String(goal || ''))) return 'lesson';
  // Scroll a windowed list until a row far down is drawn (virtual-scroll).
  if (/\bscroll the order list\b/i.test(String(goal || ''))) return 'orders';
  // Press a button that is dead: the run must notice, reflect and end honestly (stuck-recovery).
  if (/\bdownload csv button\b/i.test(String(goal || ''))) return 'stuck';
  // Find a fact outside the tab: search the web, fetch a file, answer with it (research-then-answer).
  if (/\blantern cli install script\b/i.test(String(goal || ''))) return 'research';
  // Two facts, one of which the page does not have: answer what is there and finish "partial" (partial-answer).
  if (/\bbattery last\b/i.test(String(goal || ''))) return 'partial';
  if (/\b(price|cost|shipping|delivery|preis|versand|lieferung)\b/i.test(String(goal || ''))) return 'facts';
  return 'unknown';
}

// Every finish says how the run went (the finish tool's required outcome). A mock failure could not
// do the task, so it is "blocked"; the panel shows the MOCK-FAIL marker as Failed whatever it says.
const failFinish = (why) => ({ name: 'finish', arguments: { answer: `${MOCK_FAIL_PREFIX} ${why}`, outcome: 'blocked' } });
const finish = (answer, outcome = 'done') => ({ name: 'finish', arguments: { answer, outcome } });

/** The price, shipping and delivery lines of a shop page, as the page writes them. A missing line is null. */
export function shopFacts(pageText) {
  const lines = pageLines(pageText);
  const find = (re) => lines.find((l) => re.test(l));
  return {
    price: find(MONEY) ? trimEnd(find(MONEY)) : null,
    shipping: find(/versand|shipping/i) ? trimEnd(find(/versand|shipping/i)) : null,
    delivery: find(/lieferung|lieferzeit|delivery/i) ? trimEnd(find(/lieferung|lieferzeit|delivery/i)) : null
  };
}

/**
 * The next tool call of the scripted run. One call per round, like a small model behaves.
 * Returns { call, note } or { fail: why, note } - a fail becomes a MOCK-FAIL finish.
 */
export function scriptFor(convo) {
  const kind = kindOfGoal(convo.task);

  if (kind === 'wait') return { call: { name: 'wait', arguments: { amount: 1, reason: 'Waiting until the user stops the run' } }, note: 'wait: until stopped' };

  if (kind === 'open') {
    const last = convo.lastCall && convo.lastCall.name;
    if (!last) return { call: { name: 'find', arguments: { query: 'Laptop 16 Configure now' } }, note: 'open: find the link' };
    if (last === 'find') {
      const id = Number((convo.elementsText.match(/^\[(\d+)\]/m) || [])[1]);
      if (!id) return { fail: `find returned no element: ${convo.elementsText.slice(0, 120)}`, note: 'open: nothing found' };
      return { call: { name: 'click', arguments: { element_id: id, reason: 'Open the Laptop 16 configurator' } }, note: 'open: click the best match' };
    }
    if (last === 'click') return { call: { name: 'read_page', arguments: {} }, note: 'open: read the page it opened' };
    return { call: finish(`The page the link opened says: ${convo.pageText.replace(/\s+/g, ' ').slice(0, 300)}`), note: 'open: finish with what the page says' };
  }

  if (kind === 'consent') {
    const last = convo.lastCall && convo.lastCall.name;
    const result = convo.results.length ? convo.results[convo.results.length - 1].content : '';
    const clicks = convo.calls.filter((c) => c.name === 'click').length;
    if (!last) return { call: { name: 'find', arguments: { query: 'Configure now' } }, note: 'consent: find the link' };
    if (last === 'find') {
      const id = Number((result.match(/^\[(\d+)\]/m) || [])[1]);
      if (!id) return { fail: `find returned no element: ${result.slice(0, 120)}`, note: 'consent: nothing found' };
      return { call: { name: 'click', arguments: { element_id: id } }, note: 'consent: click the best match' };
    }
    if (last === 'click') {
      if (/NOW ON:/.test(result)) return { call: { name: 'read_page', arguments: {} }, note: 'consent: read the page it opened' };
      if (clicks === 1) {
        // The banner swallowed the click. The engine must say so, or the run believes it arrived.
        if (!/did not open its page/.test(result)) return { fail: `the blocked click did not say that the link did not open: ${result.slice(0, 160)}`, note: 'consent: silent blocked click' };
        return { call: { name: 'find', arguments: { query: 'Accept cookies' } }, note: 'consent: answer the banner' };
      }
      if (clicks === 2) return { call: { name: 'find', arguments: { query: 'Configure now' } }, note: 'consent: find the link again' };
      return { fail: `the link still did not open after the banner was answered: ${result.slice(0, 160)}`, note: 'consent: still blocked' };
    }
    return { call: finish(`The page the link opened says: ${convo.pageText.replace(/\s+/g, ' ').slice(0, 300)}`), note: 'consent: finish with what the page says' };
  }

  if (kind === 'editor') return editorScript(convo);
  if (kind === 'notebook') return notebookScript(convo);
  if (kind === 'orders') return ordersScript(convo);
  if (kind === 'stuck') return stuckScript(convo);
  if (kind === 'research') return researchScript(convo);
  if (kind === 'lesson') return lessonScript(convo);
  if (kind === 'records') return recordsScript(convo);
  if (kind === 'wander' || kind === 'recover') return wanderScript(convo, kind);
  if (kind === 'stubborn') return stubbornScript(convo);
  if (kind === 'textfirst') {
    // A model that marks its work done and then answers in text, not with finish (Nemotron, 2026-11-05).
    const count = credentialRecords(convo.pageText).length;
    if (convo.notes.includes(TEXT_ANSWER_TEXT)) return { call: finish(`The page lists ${count} certifications.`), note: 'textfirst: finish after the note' };
    if (!convo.lastCall) return { call: { name: 'read_page', arguments: {} }, note: 'textfirst: read the page' };
    return { text: `The page lists ${count} certifications.`, note: 'textfirst: answer in text' };
  }
  if (kind === 'badjson') return badJsonScript(convo);
  if (kind === 'longread') return longReadScript(convo);

  if (!convo.lastCall) {
    if (kind === 'unknown') return { fail: `I do not know this goal: "${convo.task.slice(0, 80)}".`, note: 'unknown goal' };
    return { call: { name: 'read_page', arguments: {} }, note: `${kind}: read the page` };
  }

  if (convo.lastCall.name === 'read_page') {
    if (!convo.pageText.trim()) {
      return { fail: 'the read_page result is empty. If the prompt layout changed, update parseTaskMessage() in tests/mcp/mockOllama.mjs.', note: 'no page text' };
    }
    const facts = shopFacts(convo.pageText);
    if (kind === 'partial') {
      if (!facts.price) return { fail: 'the page text has no price line.', note: 'partial: no price' };
      if (/\b(akku|battery)\b/i.test(convo.pageText)) return { fail: 'the page talks about the battery, so this is not a partial answer any more.', note: 'partial: battery on the page' };
      return {
        call: finish(`The price on the page is \`${facts.price}\`. The page does not say how long the battery lasts, so I could not answer that part.`, 'partial'),
        note: 'partial: the price, and the battery is not on the page'
      };
    }
    const lines = [facts.price, facts.shipping, facts.delivery].filter(Boolean);
    if (!lines.length) return { fail: 'the page text has no price, shipping or delivery line.', note: 'facts: nothing on the page' };
    return { call: finish(`Here is what the page says:\n${lines.join('\n')}`), note: 'facts: finish with the page facts' };
  }

  return { fail: 'the conversation is in a state the mock has no script for.', note: 'unknown state' };
}

/**
 * The research-then-answer walk: web_search, then fetch_url on the docs page (the first result),
 * then fetch_url on the result that is the install script, then finish with the archive name only
 * that script names. Every result must come in the untrusted envelope, and the walk needs the
 * research tools to be offered at all: without them (the no-research tamper) it is a MOCK-FAIL,
 * never a guess. The docs page is HTML with leak-prone attributes: its text must hold the prose
 * and never the attribute sentinel (MARKUP_SENTINEL), or markup leaked into what a model reads.
 */
function researchScript(convo) {
  const last = convo.lastCall && convo.lastCall.name;
  const result = convo.results.length ? convo.results[convo.results.length - 1].content : '';
  if (!convo.tools.includes('web_search') || !convo.tools.includes('fetch_url')) {
    return { fail: `web_search and fetch_url are not offered, so the fact cannot be checked (tools: ${convo.tools.join(', ')})`, note: 'research: no research tools' };
  }
  if (!last) return { call: { name: 'web_search', arguments: { query: 'Lantern CLI install script linux', reason: 'Find the official install script' } }, note: 'research: search the web' };
  if (/^Error:/.test(result)) return { fail: `the ${last} failed: ${result.slice(0, 200)}`, note: `research: ${last} failed` };
  if (!result.includes(UNTRUSTED_PREFIX)) return { fail: `the ${last} result is not in the untrusted envelope: ${result.slice(0, 160)}`, note: `research: ${last} not wrapped` };
  if (last === 'web_search') {
    const url = (/^\s+(https?:\/\/\S+\/docs\.html)\s*$/m.exec(result) || [])[1];
    if (!url) return { fail: `the search results list no docs page: ${result.slice(0, 240)}`, note: 'research: no docs page in the results' };
    return { call: { name: 'fetch_url', arguments: { url, reason: 'Read the install docs' } }, note: 'research: fetch the docs page' };
  }
  if (last === 'fetch_url' && /\/docs\.html$/.test(convo.lastCall.args.url || '')) {
    if (result.includes(MARKUP_SENTINEL)) {
      const at = result.indexOf(MARKUP_SENTINEL);
      return { fail: `markup leaked into the fetched page text (attribute sentinel ${MARKUP_SENTINEL}): ...${result.slice(Math.max(0, at - 160), at + 40)}`, note: 'research: markup leaked' };
    }
    if (!result.includes(DOCS_PROSE)) return { fail: `the fetched docs text lost its prose ("${DOCS_PROSE}"): ${result.slice(0, 400)}`, note: 'research: docs prose missing' };
    const search = convo.results.find((r) => /^Web search \(/.test(r.content));
    const url = search && (/^\s+(https?:\/\/\S+\/install\.sh)\s*$/m.exec(search.content) || [])[1];
    if (!url) return { fail: 'the search results list no install.sh', note: 'research: no script in the results' };
    return { call: { name: 'fetch_url', arguments: { url, reason: 'Read the install script itself' } }, note: 'research: fetch the script' };
  }
  if (last === 'fetch_url') {
    const archive = /lantern-linux-amd64-v[\d.]+\.tar\.zst/.exec(result);
    if (!archive || !/needs zstd/.test(result)) return { fail: `the fetched script does not name the archive and the zstd check: ${result.slice(0, 240)}`, note: 'research: no archive in the script' };
    const url = convo.lastCall.args.url;
    return {
      call: finish(`The official install script (${url}) downloads ${archive[0]} on Linux amd64. Yes, extracting it needs zstd: the script stops with "This installer needs zstd" when zstd is missing.`),
      note: 'research: finish with the archive name'
    };
  }
  return { fail: `the research run is in a state the mock has no script for (last call ${last}).`, note: 'research: unknown state' };
}

/** The code the editor-replace task asks for. */
export const EDITOR_CODE = 'echo scoutfox';

/**
 * The editor-replace walk: list the elements, click into the editor, select all with a real key,
 * type without an element id (into the focused editor), run it with Shift+Enter, read the output
 * line, finish with it. Each action's result must carry the engine's "Observation:" line and the
 * type must read the field back: a result without them is a MOCK-FAIL, since a model that is not
 * told what its action did is exactly what the observation is for.
 */
function editorScript(convo) {
  const last = convo.lastCall && convo.lastCall.name;
  const result = convo.results.length ? convo.results[convo.results.length - 1].content : '';
  const keys = convo.calls.filter((c) => c.name === 'press_key');
  const observed = (what) => {
    if (/^Error:/.test(result)) return { fail: `the ${what} failed: ${result.slice(0, 160)}`, note: `editor: ${what} failed` };
    return /\nObservation: /.test(result) ? null : { fail: `the ${what} result has no "Observation:" line: ${result.slice(0, 160)}`, note: `editor: ${what} not observed` };
  };
  if (!last) return { call: { name: 'get_page_elements', arguments: {} }, note: 'editor: list the elements' };
  if (last === 'get_page_elements') {
    const id = Number((/^\[(\d+)\][^\n]*editor/im.exec(convo.elementsText) || [])[1]);
    if (!id) return { fail: `the element list has no editor: ${convo.elementsText.slice(0, 160)}`, note: 'editor: no editor' };
    return { call: { name: 'click', arguments: { element_id: id, reason: 'Put the caret into the code editor' } }, note: 'editor: click into the editor' };
  }
  if (last === 'click') {
    return observed('click') || { call: { name: 'press_key', arguments: { key: 'select_all', reason: 'Select all the code' } }, note: 'editor: select all' };
  }
  if (last === 'press_key' && keys.length === 1) {
    return observed('select_all') || { call: { name: 'type', arguments: { text: EDITOR_CODE, reason: 'Replace the code' } }, note: 'editor: type into the focused editor' };
  }
  if (last === 'type') {
    const fail = observed('type');
    if (fail) return fail;
    if (!result.includes(`Field now starts with: "${EDITOR_CODE}"`)) return { fail: `the type result does not read back the new code: ${result.slice(0, 200)}`, note: 'editor: no read-back' };
    return { call: { name: 'press_key', arguments: { key: 'Enter', modifiers: ['shift'], reason: 'Run the cell' } }, note: 'editor: run with Shift+Enter' };
  }
  if (last === 'press_key' && keys.length === 2) {
    const fail = observed('Shift+Enter');
    if (fail) return fail;
    return { call: { name: 'read_page', arguments: {} }, note: 'editor: read the output line' };
  }
  if (last === 'read_page') {
    const outs = [...String(convo.pageText).matchAll(/Out \[(\d+)\]: ([^\n]*)/g)];
    const lastOut = outs[outs.length - 1];
    if (!lastOut) return { fail: `the page text has no output line: ${convo.pageText.slice(0, 160)}`, note: 'editor: no output' };
    return { call: finish(`The cell ran. Its output line is: ${lastOut[0].trim()}`), note: 'editor: finish with the output line' };
  }
  return { fail: `the editor run is in a state the mock has no script for (last call ${last}).`, note: 'editor: unknown state' };
}

/** The fix the notebook-fix walk types into cell 14: the archive, unpacked under ~/.local, no sudo. */
export const NOTEBOOK_FIX = '!mkdir -p ~/.local && curl -fsSL https://ollama.com/download/ollama-linux-amd64.tar.zst | tar --zstd -x -C ~/.local && ~/.local/bin/ollama --version';

/**
 * A scroll result must be true: when it says it moved, the observation the effect probe measured
 * on its own must have seen a scroll too. A scroll that claims a move nobody measured (the old
 * window.scrollBy on a page that does not scroll) is a MOCK-FAIL.
 */
function scrollProblem(result, what) {
  if (/^Error:/.test(result)) return { fail: `the ${what} failed: ${result.slice(0, 160)}`, note: `${what} failed` };
  if (/^Did not move/.test(result)) return { fail: `the ${what} did not move anything: ${result.slice(0, 160)}`, note: `${what}: did not move` };
  if (!/^Scrolled .+ (down|up) \d+px/.test(result)) return { fail: `the ${what} result does not say what moved and how far: ${result.slice(0, 160)}`, note: `${what}: no measurement` };
  const observation = /\nObservation: [^\n]*/.exec(result)?.[0] || '';
  if (!observation) return { fail: `the ${what} result has no "Observation:" line: ${result.slice(0, 160)}`, note: `${what}: not observed` };
  if (!/scrolled (down|up) \d+px|page scrolled to/.test(observation)) {
    return { fail: `the ${what} says it moved, but the observation measured no scroll: ${observation.slice(0, 200)}`, note: `${what}: claimed a move nobody measured` };
  }
  return null;
}

/**
 * The notebook-fix walk: scroll the cells panel, read the page in parts (part 2 holds cell 14 and
 * its permission error), list the elements, click into cell 14, select all with a real key, type
 * the fix without an element id, run it with Shift+Enter, read part 2 again for the output line,
 * finish with it. A part that is not the part asked for, a scroll nobody measured, or an action
 * without its observation is a MOCK-FAIL.
 */
function notebookScript(convo) {
  const last = convo.lastCall && convo.lastCall.name;
  const result = convo.results.length ? convo.results[convo.results.length - 1].content : '';
  const reads = convo.calls.filter((c) => c.name === 'read_page').length;
  const keys = convo.calls.filter((c) => c.name === 'press_key').length;
  const observed = (what) => {
    if (/^Error:/.test(result)) return { fail: `the ${what} failed: ${result.slice(0, 160)}`, note: `notebook: ${what} failed` };
    return /\nObservation: /.test(result) ? null : { fail: `the ${what} result has no "Observation:" line: ${result.slice(0, 160)}`, note: `notebook: ${what} not observed` };
  };
  if (!last) return { call: { name: 'scroll', arguments: { direction: 'down', reason: 'Look further down the notebook' } }, note: 'notebook: scroll the cells panel' };
  if (last === 'scroll') return scrollProblem(result, 'scroll of the notebook panel') || { call: { name: 'read_page', arguments: {} }, note: 'notebook: read part 1' };
  if (last === 'read_page' && reads === 1) {
    if (!/\(part 1 of [2-9]\d*,/.test(result)) return { fail: `the first read does not say it is part 1 of several: ${result.slice(0, 160)}`, note: 'notebook: no part 1' };
    return { call: { name: 'read_page', arguments: { part: 2 } }, note: 'notebook: read part 2' };
  }
  if (last === 'read_page' && reads === 2) {
    if (!/\(part 2 of \d+,/.test(result)) return { fail: `asked for part 2, got: ${result.slice(0, 160)}`, note: 'notebook: not part 2' };
    if (!/Permission denied/.test(result) || !/sudo apt-get/.test(result)) return { fail: `part 2 has no cell 14 with its permission error: ${result.slice(0, 200)}`, note: 'notebook: no error in part 2' };
    return { call: { name: 'get_page_elements', arguments: {} }, note: 'notebook: list the elements' };
  }
  if (last === 'get_page_elements') {
    const id = Number((/^\[(\d+)\][^\n]*Cell 14 code/m.exec(convo.elementsText) || [])[1]);
    if (!id) return { fail: `the element list has no cell 14 editor: ${convo.elementsText.slice(0, 200)}`, note: 'notebook: no cell 14' };
    return { call: { name: 'click', arguments: { element_id: id, reason: 'Put the caret into cell 14' } }, note: 'notebook: click into cell 14' };
  }
  if (last === 'click') return observed('click') || { call: { name: 'press_key', arguments: { key: 'select_all', reason: 'Select the whole cell' } }, note: 'notebook: select all' };
  if (last === 'press_key' && keys === 1) return observed('select_all') || { call: { name: 'type', arguments: { text: NOTEBOOK_FIX, reason: 'Replace the cell with the install that needs no sudo' } }, note: 'notebook: type the fix' };
  if (last === 'type') {
    const fail = observed('type');
    if (fail) return fail;
    if (!result.includes(`Field now starts with: "${NOTEBOOK_FIX.slice(0, 60)}`)) return { fail: `the type result does not read back the fix: ${result.slice(0, 200)}`, note: 'notebook: no read-back' };
    return { call: { name: 'press_key', arguments: { key: 'Enter', modifiers: ['shift'], reason: 'Run the cell' } }, note: 'notebook: run with Shift+Enter' };
  }
  if (last === 'press_key' && keys === 2) return observed('Shift+Enter') || { call: { name: 'read_page', arguments: { part: 2 } }, note: 'notebook: read the output' };
  if (last === 'read_page' && reads === 3) {
    const version = /ollama version [\d.]+/.exec(result);
    if (!version) return { fail: `the output of the fixed cell is not in part 2: ${result.slice(0, 200)}`, note: 'notebook: no output' };
    return { call: finish(`Cell 14 now installs Ollama under ~/.local without sudo. It printed: ${version[0]}`), note: 'notebook: finish with the version' };
  }
  return { fail: `the notebook run is in a state the mock has no script for (last call ${last}).`, note: 'notebook: unknown state' };
}

/** The most dead clicks the stuck walk makes before it gives up on the harness noticing. */
export const STUCK_MAX_CLICKS = 7;

/**
 * The stuck-recovery walk: a stubborn small model. It lists the elements, then clicks the dead
 * Download CSV button again and again, the way a real model repeated click(700,420) six times.
 * It only stops when the loop tells it to: the repeat hint first, then the reflection note. Then
 * it finishes honestly (the button did nothing, and what the user can do next). With manual
 * approval it plans first, as the system prompt asks. Without the guard it never hears it, gives
 * up after STUCK_MAX_CLICKS clicks, and the answer is a MOCK-FAIL.
 */
function stuckScript(convo) {
  const last = convo.lastCall && convo.lastCall.name;
  const result = convo.results.length ? convo.results[convo.results.length - 1].content : '';
  const clicks = convo.calls.filter((c) => c.name === 'click');
  if (convo.manualApproval && !convo.planApproved) {
    if (convo.planRejected) return { fail: 'the plan was rejected', note: 'stuck: plan rejected' };
    return { call: { name: 'update_plan', arguments: { plan: ['Click Download CSV', 'Check that the file came'] } }, note: 'stuck: plan first (manual approval)' };
  }
  if (!last || last === 'update_plan') return { call: { name: 'get_page_elements', arguments: {} }, note: 'stuck: list the elements' };
  if (/^Error:/.test(result)) return { fail: `the ${last} failed: ${result.slice(0, 160)}`, note: `stuck: ${last} failed` };
  const hinted = convo.results.some((r) => r.content.includes(REPEAT_HINT_PREFIX));
  const reflected = convo.notes.includes(REFLECTION_TEXT);
  if (reflected) {
    if (!hinted) return { fail: 'the reflection came, but no repeat hint before it', note: 'stuck: reflection without a hint' };
    // The note must sit after the whole tool block: the last message is the note, the one before it a tool result.
    const [before, note] = convo.tail;
    if (!note || note.role !== 'user' || note.content !== REFLECTION_TEXT || !before || before.role !== 'tool') {
      return { fail: `the reflection is not the user message right after the tool block (the request ends ${convo.tail.map((m) => m.role).join(', ')})`, note: 'stuck: reflection misplaced' };
    }
    return {
      call: finish(`The Download CSV button did not work: I clicked it ${clicks.length} times and nothing on the page changed (no download, no message). What failed: the button does not respond, so the export did not start. Next steps for you: reload the page and try Download CSV again; if it still does nothing, the export service may be down, so ask the site's support or copy the table from the page.`, 'blocked'),
      note: 'stuck: reflect and finish honestly (blocked)'
    };
  }
  if (clicks.length >= STUCK_MAX_CLICKS) {
    return { fail: `clicked the dead button ${clicks.length} times and the loop never said it changed nothing (hint ${hinted ? 'seen' : 'missing'}, reflection missing)`, note: 'stuck: no guard' };
  }
  const id = Number((/^\[(\d+)\][^\n]*Download CSV/im.exec(convo.elementsText) || [])[1]);
  if (!id) return { fail: `the element list has no Download CSV button: ${convo.elementsText.slice(0, 160)}`, note: 'stuck: no button' };
  if (last === 'click' && !/\nObservation: /.test(result)) return { fail: `the click result has no "Observation:" line: ${result.slice(0, 160)}`, note: 'stuck: click not observed' };
  return { call: { name: 'click', arguments: { element_id: id, reason: 'Download the report as CSV' } }, note: `stuck: click ${clicks.length + 1}${hinted ? ' (ignoring the hint)' : ''}` };
}

/**
 * The virtual-scroll walk: scroll the list, read what it draws now, again, until the row of
 * Zanzibar Spice Co. is drawn; then finish with that row. Every scroll must be one the probe
 * measured too (scrollProblem), or the walk is a MOCK-FAIL.
 */
function ordersScript(convo) {
  const last = convo.lastCall && convo.lastCall.name;
  const result = convo.results.length ? convo.results[convo.results.length - 1].content : '';
  const scrolls = convo.calls.filter((c) => c.name === 'scroll').length;
  const scroll = { call: { name: 'scroll', arguments: { direction: 'down', reason: 'Bring more orders into view' } }, note: 'orders: scroll the list' };
  if (!last) return scroll;
  if (last === 'scroll') return scrollProblem(result, `scroll ${scrolls} of the order list`) || { call: { name: 'read_page', arguments: {} }, note: 'orders: read the rows now drawn' };
  if (last === 'read_page') {
    const row = /Order \d+ - Zanzibar Spice Co\.[^\n]*/.exec(result);
    if (row) return { call: finish(`Found it: ${row[0].trim()}`), note: 'orders: finish with the row' };
    if (scrolls >= 12) return { fail: `the row is still not drawn after ${scrolls} scrolls: ${result.slice(0, 160)}`, note: 'orders: never found' };
    return scroll;
  }
  return { fail: `the orders run is in a state the mock has no script for (last call ${last}).`, note: 'orders: unknown state' };
}

/**
 * The frame-lesson walk: look at the page, read it, scroll it, finish with the code. The lesson is
 * a cross-origin iframe in a shell that does not scroll, so each step only works when the engine
 * reaches into the frame: the read must hold the code (only the frame has it), and the scroll must
 * move the frame (the shell cannot move).
 */
function lessonScript(convo) {
  const last = convo.lastCall && convo.lastCall.name;
  const result = convo.results.length ? convo.results[convo.results.length - 1].content : '';
  if (!last) return { call: { name: 'take_screenshot', arguments: { reason: 'See the lesson' } }, note: 'lesson: look at the page' };
  if (last === 'take_screenshot') {
    if (!convo.screenshotTaken) return { fail: `the screenshot failed: ${result.slice(0, 160)}`, note: 'lesson: no picture' };
    return { call: { name: 'read_page', arguments: {} }, note: 'lesson: read the page' };
  }
  if (last === 'read_page') {
    if (!result.includes(LESSON_FACT)) return { fail: `the page text has no lesson text (the embedded frame was not read): ${result.replace(/\s+/g, ' ').slice(0, 200)}`, note: 'lesson: frame not read' };
    return { call: { name: 'scroll', arguments: { direction: 'down', reason: 'Move to the end of the lesson' } }, note: 'lesson: scroll the lesson' };
  }
  if (last === 'scroll') {
    const problem = scrollProblem(result, 'lesson scroll');
    if (problem) return problem;
    const code = new RegExp(`${LESSON_FACT}`).exec(convo.pageText)?.[0] || LESSON_FACT;
    return { call: finish(`The review code of this lesson is ${code}.`), note: 'lesson: finish with the code' };
  }
  return { fail: `the lesson run is in a state the mock has no script for (last call ${last}).`, note: 'lesson: unknown state' };
}

/** The file the credentials-json run asks the engine to write from its saved records. */
export const RECORDS_FILE = 'certifications.json';
/** How many certifications credentials.html lists. */
export const CREDENTIAL_COUNT = 10;
/** How many reads the long-read run makes (each followed by a save_data): enough rounds for two compactions. */
export const LONG_READS = 13;

/**
 * The certifications of a read of credentials.html: the name and issue date from the text, the
 * credential URL from the links block under it ("- Show credential (<name>): <url>"). The page
 * text alone has no URL, so without the block there are no records.
 */
export function credentialRecords(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim());
  return [...String(text || '').matchAll(/^- Show credential \((.+?)\): (\S+)$/gm)].map(([, name, url]) => {
    const at = lines.indexOf(name);
    const issued = at < 0 ? '' : (lines.slice(at + 1, at + 4).find((l) => /^Issued /.test(l)) || '').replace(/^Issued /, '');
    const issuer = at < 0 ? '' : lines[at + 1] || '';
    return { name, issued, url, issuer };
  });
}

/**
 * The credentials-json walk: plan, read the page once, save the ten records, mark the plan steps,
 * finish with records_file. Each step checks the engine did its part: the read must list the link
 * targets (else no URL can be known), the run state must show the ten saved records and the plan
 * marks, and the finish must be accepted.
 */
function recordsScript(convo) {
  const last = convo.lastCall && convo.lastCall.name;
  const result = convo.results.length ? convo.results[convo.results.length - 1].content : '';
  const plan = ['Read the certifications', 'Save each certificate', 'Write the JSON file'];
  if (!last) return { call: { name: 'update_plan', arguments: { plan, reason: 'Three steps: read the list, save each item, write the file' } }, note: 'records: plan' };
  if (/^Error:/.test(result)) return { fail: `the ${last} failed: ${result.slice(0, 200)}`, note: `records: ${last} failed` };
  if (last === 'update_plan' && !convo.calls.some((c) => c.name === 'read_page')) {
    return { call: { name: 'read_page', arguments: { reason: 'The plan is set; read the certifications section' } }, note: 'records: read the page' };
  }
  if (last === 'read_page') {
    if (!/^Links in this part:$/m.test(result)) return { fail: 'the read has no "Links in this part:" block, so no credential URL can be seen', note: 'records: no link targets' };
    const records = credentialRecords(result).map(({ name, issued, url }) => ({ name, issued, url }));
    if (records.length !== CREDENTIAL_COUNT) return { fail: `the read lists ${records.length} credential links, expected ${CREDENTIAL_COUNT}`, note: 'records: links missing' };
    const undated = records.find((r) => !r.issued);
    if (undated) return { fail: `no issue date found for "${undated.name}"`, note: 'records: no date' };
    return { call: { name: 'save_data', arguments: { records, reason: `The read lists all ${records.length} certificates with their links; save them` } }, note: 'records: save the records' };
  }
  if (last === 'save_data') {
    if (!convo.runState) return { fail: 'the request carries no run state, so the saved records cannot be seen', note: 'records: no run state' };
    if (!new RegExp(`^Collected: ${CREDENTIAL_COUNT} records \\(fields: name, issued, url\\)$`, 'm').test(convo.runState)) {
      return { fail: `the run state does not show the ${CREDENTIAL_COUNT} saved records: ${convo.runState.replace(/\s+/g, ' ').slice(0, 240)}`, note: 'records: run state wrong' };
    }
    return { call: { name: 'update_plan', arguments: { done: [1, 2], reason: 'Read and saved all certificates' } }, note: 'records: mark steps done' };
  }
  if (last === 'update_plan') {
    if (!/^Plan: 1 \[done\] [^;]+; 2 \[done\] [^;]+; 3 \[ \] /m.test(convo.runState || '')) {
      return { fail: `the run state does not show plan steps 1 and 2 done: ${(convo.runState || '').replace(/\s+/g, ' ').slice(0, 240)}`, note: 'records: plan marks lost' };
    }
    // With the attached-file rule the answer shows two records as the pattern and a link; without
    // it the mock pastes every record, like the real run did, and the harness check sees the repeat.
    const records = credentialRecords(convo.results.find((r) => r.name === 'read_page')?.content || '').map(({ name, issued, url }) => ({ name, issued, url }));
    const sample = convo.attachedFileRule ? records.slice(0, 2) : records;
    const answer = [
      `I saved all ${CREDENTIAL_COUNT} certifications with their name, issue date and credential URL in ${RECORDS_FILE}.`,
      '',
      convo.attachedFileRule ? 'Each entry follows this pattern (the first two of the file):' : 'Here is the file:',
      '',
      '```json',
      JSON.stringify(sample, null, 2),
      '```',
      '',
      `The first credential opens at [its issuer's page](${records[0] ? records[0].url : 'https://example.test/'}).`
    ].join('\n');
    return {
      call: { name: 'finish', arguments: { answer, outcome: 'done', records_file: RECORDS_FILE } },
      note: 'records: finish with the file'
    };
  }
  return { fail: `the records run is in a state the mock has no script for (last call ${last}).`, note: 'records: unknown state' };
}

/**
 * The stall walks, a model like the real run that read 74 elements one by one. It lists the
 * elements, then reads them one at a time and never stops on its own. Only the loop's stall note
 * stops it. stall-wander (the expiry date is on no page) then finishes "partial"; stall-recover
 * changes course: it reads the page once, saves the certificates with their issuers, and is done.
 */
function wanderScript(convo, kind) {
  const last = convo.lastCall && convo.lastCall.name;
  const lastArgs = (convo.lastCall && convo.lastCall.args) || {};
  const result = convo.results.length ? convo.results[convo.results.length - 1].content : '';
  const reads = convo.calls.filter((c) => c.name === 'read_page' && c.args.element_id !== undefined).length;
  const stalled = convo.notes.includes(STALL_TEXT);
  if (convo.notes.includes(STALL_END_TEXT)) return { fail: 'the run stalled a second time before the mock changed course', note: `${kind}: stalled twice` };
  if (!last) return { call: { name: 'get_page_elements', arguments: {} }, note: `${kind}: list the elements` };
  if (stalled) {
    if (kind === 'wander') {
      return {
        call: finish(`The page does not show when any credential expires: it lists each certificate's name, issuer and issue date only. I read ${reads} elements one by one and none of them has an expiry date. Open each "Show credential" link to see whether the issuer shows one.`, 'partial'),
        note: 'wander: the stall note came, finish partial'
      };
    }
    if (last !== 'read_page' || lastArgs.element_id !== undefined) {
      if (last === 'save_data') return { call: finish(`I saved the ${CREDENTIAL_COUNT} certifications on this page with the issuer of each.`), note: 'recover: finish' };
      return { call: { name: 'read_page', arguments: { reason: 'Element by element finds nothing new; read the whole section once' } }, note: 'recover: read the page once' };
    }
    const records = credentialRecords(result).map(({ name, issuer }) => ({ name, issuer }));
    if (records.length !== CREDENTIAL_COUNT) return { fail: `the read lists ${records.length} certificates, expected ${CREDENTIAL_COUNT}`, note: 'recover: read incomplete' };
    return { call: { name: 'save_data', arguments: { records, reason: 'The whole read has every certificate and its issuer' } }, note: 'recover: save the records' };
  }
  if (/^\[earlier result, shortened\]/.test(convo.elementsText)) return { call: { name: 'get_page_elements', arguments: {} }, note: `${kind}: list the elements again` };
  const ids = [...String(convo.elementsText || '').matchAll(/^\[(\d+)\]/gm)].map((m) => Number(m[1]));
  const next = ids[reads];
  if (!next) return { fail: `read ${reads} elements one by one and the loop never said the run stalled`, note: `${kind}: no stall note` };
  return { call: { name: 'read_page', arguments: { element_id: next } }, note: `${kind}: read element ${next}` };
}

/**
 * The stall-out walk: a model that does not listen. It reads element after element and goes on
 * after the stall note, until the loop ends the run: the last round offers only finish, with the
 * STALL_END_TEXT note. Without that round it runs out of elements and fails.
 */
function stubbornScript(convo) {
  const last = convo.lastCall && convo.lastCall.name;
  const reads = convo.calls.filter((c) => c.name === 'read_page' && c.args.element_id !== undefined).length;
  if (convo.notes.includes(STALL_END_TEXT)) {
    if (convo.tools.length !== 1 || convo.tools[0] !== 'finish') return { fail: `the last round after the second stall offers ${convo.tools.join(', ')}, expected only finish`, note: 'stubborn: last round offers more' };
    if (!convo.notes.includes(STALL_TEXT)) return { fail: 'the run was ended for stalling without the first stall note before it', note: 'stubborn: no first note' };
    return { call: finish(`The page does not say who signed any certificate. I read ${reads} elements and none names a signer.`, 'partial'), note: 'stubborn: finish in the last round' };
  }
  if (!last) return { call: { name: 'get_page_elements', arguments: {} }, note: 'stubborn: list the elements' };
  // A long run shortens old results (the context compaction): the list is asked for again, as a model would.
  if (/^\[earlier result, shortened\]/.test(convo.elementsText)) return { call: { name: 'get_page_elements', arguments: {} }, note: 'stubborn: list the elements again' };
  const ids = [...String(convo.elementsText || '').matchAll(/^\[(\d+)\]/gm)].map((m) => Number(m[1]));
  const next = ids[reads];
  if (!next) return { fail: `read ${reads} elements one by one and the loop never ended the run`, note: 'stubborn: never ended' };
  return { call: { name: 'read_page', arguments: { element_id: next } }, note: `stubborn: read element ${next}${convo.notes.includes(STALL_TEXT) ? ' (ignoring the stall note)' : ''}` };
}

/**
 * The bad-json walk: a model that writes a small JSON file by hand and gets it wrong (a trailing
 * comma). The engine must refuse it with the reason, and the corrected file is what the user gets.
 */
function badJsonScript(convo) {
  const last = convo.lastCall && convo.lastCall.name;
  const result = convo.results.length ? convo.results[convo.results.length - 1].content : '';
  if (!last) return { call: { name: 'read_page', arguments: {} }, note: 'badjson: read the page' };
  const names = credentialRecords(convo.pageText).slice(0, 2).map((r) => r.name);
  if (names.length < 2) return { fail: 'the read has no two certificates to write', note: 'badjson: no names' };
  const file = (content) => ({ name: 'finish', arguments: { answer: `The file names the first two certifications on the page.`, outcome: 'done', files: [{ name: 'first-two.json', content }] } });
  if (last === 'read_page') return { call: file(`[${names.map((n) => `{"name": ${JSON.stringify(n)}}`).join(', ')},]`), note: 'badjson: finish with broken JSON' };
  if (last === 'finish') {
    if (!/is not valid JSON/.test(result)) return { fail: `the broken JSON file was not refused: ${result.slice(0, 160)}`, note: 'badjson: not refused' };
    return { call: file(JSON.stringify(names.map((name) => ({ name })), null, 2)), note: 'badjson: finish with valid JSON' };
  }
  return { fail: `the bad-json run is in a state the mock has no script for (last call ${last}).`, note: 'badjson: unknown state' };
}

/**
 * The long-read walk: read the page and save one check, LONG_READS times, then finish. Every read
 * brings the whole page back (about 2.5 KB with its links), so without the context compaction each
 * request is bigger than the one before.
 */
function longReadScript(convo) {
  const last = convo.lastCall && convo.lastCall.name;
  const saves = convo.calls.filter((c) => c.name === 'save_data').length;
  if (!last || last === 'save_data') {
    if (saves >= LONG_READS) return { call: finish(`I checked the certifications ${saves} times; the page listed ${CREDENTIAL_COUNT} each time.`), note: 'longread: finish' };
    return { call: { name: 'read_page', arguments: {} }, note: `longread: read ${saves + 1}` };
  }
  if (last === 'read_page') {
    const count = credentialRecords(convo.pageText).length;
    if (count !== CREDENTIAL_COUNT) return { fail: `read ${saves + 1} lists ${count} certificates, expected ${CREDENTIAL_COUNT}`, note: 'longread: read incomplete' };
    return { call: { name: 'save_data', arguments: { records: [{ check: saves + 1, certifications: count }] } }, note: `longread: save check ${saves + 1}` };
  }
  return { fail: `the long-read run is in a state the mock has no script for (last call ${last}).`, note: 'longread: unknown state' };
}

/**
 * The scripted reply to one request.
 *
 * @param {{model?: string, messages: {role: string, content: string}[], tools?: unknown[]}} request
 * @returns {{node: string, mode: string, reply: object, note: string} | {error: {status: number, message: string}}}
 */
export function decide(request) {
  const tools = toolMapOf(request);
  if (!tools) {
    return { error: { status: 501, message: 'mock: no script for a chat call without tools. The mock speaks the MCP tool-calling protocol (a tools array on the request, tool_calls in the reply). If the engine changed, extend tests/e2e/lib/mockOllama.mjs.' } };
  }
  const convo = readConversation(request.messages, tools);
  const script = scriptFor(convo);

  // A reply that is plain text and no tool call at all. A model does this when it forgets it
  // is talking to a person and answers with a JSON object, and the engine has to survive it.
  if (script.text !== undefined) {
    if (script.fail) {
      return {
        node: 'mcp',
        mode: 'text',
        reply: { content: `${MOCK_FAIL_PREFIX} ${script.fail}` },
        note: `${script.note} (MOCK-FAIL)`
      };
    }
    return { node: 'mcp', mode: 'text', reply: { content: script.text }, note: script.note };
  }

  const calls = script.fail ? [failFinish(script.fail)] : [script.call];
  for (const call of calls) {
    const def = tools.get(call.name);
    // Every tool but finish asks for the step note (REASON_TEXT in tools.ts). A script names it
    // when the words matter; otherwise the note of the script is the reason, as a model would say it.
    if (def && (def.parameters?.required || []).includes('reason') && !(call.arguments && 'reason' in call.arguments)) {
      call.arguments = { ...(call.arguments || {}), reason: `mock: ${script.note}` };
    }
    if (!def) {
      return { error: { status: 500, message: `mock bug: the scripted reply calls "${call.name}", which is not one of the tools the request offered (${[...tools.keys()].join(', ')}).` } };
    }
    const argErrors = [...validateToolArgs(def.parameters, call.arguments), ...validateToolRules(call.name, call.arguments)];
    if (argErrors.length) {
      return { error: { status: 500, message: `mock bug: the arguments for "${call.name}" do not fit its schema: ${argErrors.join('; ')}` } };
    }
  }
  return {
    node: 'mcp',
    mode: calls.map((c) => c.name).join('+'),
    reply: { tool_calls: calls.map((c) => ({ function: { name: c.name, arguments: c.arguments } })) },
    note: script.fail ? `${script.note} (MOCK-FAIL)` : script.note
  };
}

// ---------------------------------------------------------------------------------------------
// The HTTP server
// ---------------------------------------------------------------------------------------------

function tagOf(name) {
  const isLarge = /70b|large/i.test(name);
  const paramSize = isLarge ? '70B' : MOCK_PARAMETER_SIZE;
  return {
    name,
    model: name,
    modified_at: '2026-01-01T00:00:00Z',
    size: 1,
    digest: '0'.repeat(64),
    details: { parent_model: '', format: 'gguf', family: 'mock', families: ['mock'], parameter_size: paramSize, quantization_level: 'Q4_K_M' }
  };
}

/** What POST /api/show answers for a model: the tag details plus model_info and the capabilities. */
function showOf(name) {
  const isLarge = /70b|large/i.test(name);
  const paramCount = isLarge ? 70_000_000_000 : 9_000_000_000;
  return {
    license: 'mock',
    modelfile: `# Modelfile generated by "ollama show"\nFROM ${name}`,
    parameters: 'num_ctx 8192',
    template: '{{ .Prompt }}',
    details: tagOf(name).details,
    model_info: { 'general.architecture': 'mock', 'general.parameter_count': paramCount, 'mock.context_length': 32768 },
    capabilities: NO_THINKING.test(name) ? MOCK_CAPABILITIES.filter((c) => c !== 'thinking') : [...MOCK_CAPABILITIES],
    thinking: { values: NO_THINKING.test(name) ? [false] : [true, false] },
    modified_at: '2026-01-01T00:00:00Z'
  };
}

/**
 * The streamed form of a reply: the text in two pieces, then a last line with everything else. A client that
 * joins the pieces (ChatOllama does) sees the same text as one that reads the single object.
 */
export function toNdjson(reply) {
  const { message, ...rest } = reply;
  const cut = Math.ceil(message.content.length / 2);
  const piece = (content) => JSON.stringify({ model: reply.model, created_at: reply.created_at, message: { role: message.role, content }, done: false });
  // The last line carries the full message (tool_calls included), as Ollama's final chunk does.
  return `${[piece(message.content.slice(0, cut)), piece(message.content.slice(cut)), JSON.stringify({ ...rest, message: { ...message, content: '' } })].join('\n')}\n`;
}

/**
 * Same return shape as startOllamaProxy: { server, calls, url }.
 *
 * @param {object} [options]
 * @param {string} [options.host]
 * @param {number} [options.port]   0 picks a free port (the self-test does that)
 * @param {string[]} [options.models] names listed by /api/tags and known to /api/show
 * @param {(call: object) => void} [options.onCall]
 */
export function startMockOllama({ host = '127.0.0.1', port = 11435, models = ['mock-agent'], onCall = () => {} } = {}) {
  const calls = [];
  // The same request again and again is a run that loops (no state change reaches the model). The count is only
  // kept for the record of the call and for the harness to see it: the reply itself never depends on it.
  let lastRequest = '';
  let repeat = 0;

  const send = (res, status, body, headers = {}) => {
    const isText = typeof body === 'string';
    res.writeHead(status, {
      'Content-Type': isText ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
      ...CORS,
      ...headers
    });
    res.end(body === undefined ? undefined : isText ? body : JSON.stringify(body));
  };

  const chat = (res, raw, startedAt) => {
    let sent = {};
    let status = 200;
    let body;
    const reject = (code, message) => { status = code; body = { error: message }; };

    try {
      sent = JSON.parse(raw.toString('utf8'));
    } catch (err) {
      reject(400, `invalid JSON in the request body: ${err.message}`);
    }
    if (!body) {
      if (!sent || typeof sent !== 'object' || Array.isArray(sent)) {
        reject(400, 'the request body must be a JSON object');
      } else if (typeof sent.model !== 'string' || !sent.model) {
        reject(400, 'model is required');
      } else if (!Array.isArray(sent.messages) || sent.messages.length === 0
        || sent.messages.some((m) => !m || typeof m.role !== 'string' || !isMessageContent(m))) {
        reject(400, 'messages must be a non-empty array of {role, content}, where content is a string or (for a user message) an array of text and image blocks');
      } else if (sent.think !== undefined && sent.think !== null && typeof sent.think !== 'boolean' && !['low', 'medium', 'high', 'max'].includes(sent.think)) {
        reject(400, `invalid think value: ${JSON.stringify(sent.think)}`);
      } else if (sent.think && NO_THINKING.test(sent.model)) {
        // Real Ollama's answer to think:true for a model without the thinking capability.
        reject(400, `"${sent.model}" does not support thinking`);
      } else if (stringToolArguments(sent.messages).length) {
        // Real Ollama answers exactly this to a tool call whose arguments came back as a string
        // (0.40.6, verified with curl), which kills the run where the loop is multi-step. The mock
        // answers the same so the offline suite cannot pass a request real Ollama would refuse.
        reject(400, "Value looks like object, but can't find closing '}' symbol");
      }
    }

    let note = '';
    let mode = '';
    if (!body) {
      const key = JSON.stringify([sent.model, sent.messages]);
      repeat = key === lastRequest ? repeat + 1 : 0;
      lastRequest = key;

      const decision = decide(sent);
      if (decision.error) {
        reject(decision.error.status, decision.error.message);
      } else {
        note = decision.note;
        mode = decision.mode;
        const toolCalls = decision.reply.tool_calls || [];
        const textContent = typeof decision.reply.content === 'string' ? decision.reply.content : '';
        const promptChars = sent.messages.reduce((sum, m) => sum + m.content.length, 0);
        const promptTokens = Math.max(1, Math.ceil(promptChars / 4));
        const outputTokens = Math.max(1, Math.ceil(JSON.stringify(decision.reply).length / 4));
        body = {
          model: sent.model,
          created_at: new Date().toISOString(),
          message: { role: 'assistant', content: textContent, tool_calls: toolCalls, ...(sent.think ? { thinking: MOCK_THINKING_TEXT } : {}) },
          done: true,
          done_reason: 'stop',
          total_duration: 1_000_000,
          load_duration: 100_000,
          prompt_eval_count: promptTokens,
          prompt_eval_duration: 400_000,
          eval_count: outputTokens,
          eval_duration: 500_000
        };
      }
    }

    // Ollama streams unless the request says stream:false. An error is one JSON object either way.
    const streaming = status === 200 && sent.stream !== false;
    const responseText = streaming ? toNdjson(body) : JSON.stringify(body);
    const call = buildCallRecord({
      n: calls.length + 1,
      status,
      ms: Date.now() - startedAt,
      requestBytes: raw.length,
      responseBytes: Buffer.byteLength(responseText),
      sent: sent && typeof sent === 'object' ? sent : {},
      got: body
    });
    call.node = 'mcp';
    if (mode) call.mode = mode;
    if (Array.isArray(sent.tools) && sent.tools.length) call.format = `tools x${sent.tools.length}`;
    if (note) call.note = note;
    call.repeat = repeat;
    calls.push(call);
    onCall(call);
    send(res, status, responseText, { 'Content-Type': streaming ? 'application/x-ndjson' : 'application/json; charset=utf-8' });
  };

  /** POST /api/show: {model} (or {name}, the old field) -> the details of a model the mock lists. */
  const show = (res, raw) => {
    let asked;
    try {
      asked = JSON.parse(raw.toString('utf8'));
    } catch (err) {
      return send(res, 400, { error: `invalid JSON in the request body: ${err.message}` });
    }
    const name = asked && typeof asked === 'object' ? asked.model || asked.name : undefined;
    if (typeof name !== 'string' || !name) return send(res, 400, { error: 'model is required' });
    if (!models.includes(name)) return send(res, 404, { error: `model '${name}' not found` });
    return send(res, 200, showOf(name));
  };

  const server = http.createServer(async (req, res) => {
    try {
      const startedAt = Date.now();
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks);
      const pathname = new URL(req.url, 'http://mock').pathname.replace(/\/+$/, '') || '/';

      if (req.method === 'OPTIONS') return send(res, 204, undefined);
      if (req.method === 'GET' && pathname === '/') return send(res, 200, 'Ollama is running (mock)');
      if (req.method === 'GET' && pathname === '/api/version') return send(res, 200, { version: MOCK_VERSION });
      if (req.method === 'GET' && pathname === '/api/tags') return send(res, 200, { models: models.map(tagOf) });
      if (req.method === 'POST' && pathname === '/api/show') return show(res, raw);
      if (req.method === 'POST' && pathname === '/api/chat') return chat(res, raw, startedAt);
      return send(res, 404, { error: `mock: no route for ${req.method} ${pathname}` });
    } catch (err) {
      // A bug in the mock must show up as a failed call, not take the whole run down with it.
      if (!res.headersSent) send(res, 500, { error: `mock bug: ${err && err.stack ? err.stack : err}` });
      else res.end();
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve({ server, calls, url: `http://${host}:${server.address().port}` }));
  });
}
