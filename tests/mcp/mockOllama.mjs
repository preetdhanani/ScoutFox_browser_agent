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
 *   - a bot check in the page text (the user message's preview, or a get_page_text result):
 *     finish at once with the honest answer. It never clicks a bot check;
 *   - a planning goal: update_plan with two steps (two steps auto-approve, so the run goes on),
 *     then get_page_text, then finish with the facts;
 *   - a click goal: get_page_elements, then click the element whose label matches the goal
 *     ("In den Warenkorb" for a cart goal), then finish;
 *   - a facts goal (price, shipping, delivery) or a summarize goal: get_page_text, then finish
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
import { buildCallRecord, MOCK_FAIL_PREFIX } from './callRecord.mjs';

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
      results.push({ name, content: m.content });
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
  const lastResultOf = (name) => [...results].reverse().find((r) => r.name === name)?.content ?? null;
  const firstUser = (messages || []).find((m) => m.role === 'user');
  const task = parseTaskMessage(firstUser ? firstUser.content : '');
  const pageText = lastResultOf('get_page_text') ?? lastResultOf('read_page_text');
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
export function validateToolArgs(parameters, args) {
  const errors = [];
  if (!parameters || typeof parameters !== 'object' || parameters.type !== 'object') return errors;
  const props = parameters.properties || {};
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  for (const key of Object.keys(a)) {
    if (!(key in props)) {
      if (parameters.additionalProperties === false) errors.push(`unknown argument "${key}"`);
      continue;
    }
    const schema = props[key] || {};
    const value = a[key];
    if (schema.enum && !schema.enum.includes(value)) errors.push(`"${key}" must be one of ${JSON.stringify(schema.enum)}`);
    if (schema.type === 'string' && typeof value !== 'string') errors.push(`"${key}" must be a string`);
    if (schema.type === 'boolean' && typeof value !== 'boolean') errors.push(`"${key}" must be a boolean`);
    if (schema.type === 'number') {
      if (typeof value !== 'number' || Number.isNaN(value)) errors.push(`"${key}" must be a number`);
      else {
        if (schema.minimum !== undefined && value < schema.minimum) errors.push(`"${key}" must be >= ${schema.minimum}`);
        if (schema.maximum !== undefined && value > schema.maximum) errors.push(`"${key}" must be <= ${schema.maximum}`);
      }
    }
    if (schema.type === 'array') {
      if (!Array.isArray(value)) errors.push(`"${key}" must be an array`);
      else if (schema.items?.type === 'string' && value.some((v) => typeof v !== 'string')) errors.push(`"${key}" must be an array of strings`);
    }
  }
  for (const key of parameters.required || []) {
    if (!(key in a)) errors.push(`missing required argument "${key}"`);
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
  // Open one link of several with the same label, far below the first screen (the far-link task).
  if (/\bopen the configure now link\b/i.test(String(goal || ''))) return 'open';
  // The same, on a page whose consent banner swallows clicks until it is answered (consent-link).
  if (/\bopen the configurator\b/i.test(String(goal || ''))) return 'consent';
  if (/\b(price|cost|shipping|delivery|preis|versand|lieferung)\b/i.test(String(goal || ''))) return 'facts';
  return 'unknown';
}

const failFinish = (why) => ({ name: 'finish', arguments: { answer: `${MOCK_FAIL_PREFIX} ${why}` } });
const finish = (answer) => ({ name: 'finish', arguments: { answer } });

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
    if (last === 'click') return { call: { name: 'get_page_text', arguments: {} }, note: 'open: read the page it opened' };
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
      if (/NOW ON:/.test(result)) return { call: { name: 'get_page_text', arguments: {} }, note: 'consent: read the page it opened' };
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

  if (!convo.lastCall) {
    if (kind === 'unknown') return { fail: `I do not know this goal: "${convo.task.slice(0, 80)}".`, note: 'unknown goal' };
    return { call: { name: 'get_page_text', arguments: {} }, note: `${kind}: read the page` };
  }

  if (convo.lastCall.name === 'get_page_text') {
    if (!convo.pageText.trim()) {
      return { fail: 'the get_page_text result is empty. If the prompt layout changed, update parseTaskMessage() in tests/mcp/mockOllama.mjs.', note: 'no page text' };
    }
    const facts = shopFacts(convo.pageText);
    const lines = [facts.price, facts.shipping, facts.delivery].filter(Boolean);
    if (!lines.length) return { fail: 'the page text has no price, shipping or delivery line.', note: 'facts: nothing on the page' };
    return { call: finish(`Here is what the page says:\n${lines.join('\n')}`), note: 'facts: finish with the page facts' };
  }

  return { fail: 'the conversation is in a state the mock has no script for.', note: 'unknown state' };
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
