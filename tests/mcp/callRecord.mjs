/**
 * The record kept for every model call, shared by the Ollama proxy and the key proxy of the smoke
 * run (tests/e2e/lib), so a report looks the same for every provider and the two cannot drift.
 */

/**
 * A /api/chat answer as one object, whichever way it came: a single JSON object (stream:false, or an error), or
 * NDJSON, which is what ChatOllama asks for. For NDJSON the result is the last line (done:true, the counts, done_reason)
 * with the pieces of every line's message.content joined into its message. An {"error": ...} line wins, because
 * that is what the extension reported. Anything that is not JSON gives {}.
 */
export function collapseChatResponse(text) {
  const objects = [];
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    try { objects.push(JSON.parse(line)); } catch { return {}; }
  }
  if (objects.length === 0) return {};
  const failed = objects.find((object) => object && object.error);
  if (failed) return failed;
  if (objects.length === 1) return objects[0];
  const join = (key) => objects.map((object) => (object.message && typeof object.message[key] === 'string' ? object.message[key] : '')).join('');
  const last = objects[objects.length - 1];
  return { ...last, message: { ...last.message, content: join('content'), ...(join('thinking') ? { thinking: join('thinking') } : {}) } };
}

/**
 * Which call of the engine a request is, read only from what the request itself carries.
 * The MCP tool loop is the only caller left: its request carries a `tools` array, and the
 * reply's tool_calls name the tools (the record's mode). Anything else is unknown, so a
 * protocol drift is named and not guessed.
 *
 * @param {{tools?: unknown[]}} sent the parsed request body
 * @returns {{node: 'mcp'|'unknown', mode: string}}
 */
export function classifyRequest(sent) {
  if (sent && Array.isArray(sent.tools) && sent.tools.length > 0) return { node: 'mcp', mode: 'tools' };
  return { node: 'unknown', mode: '' };
}

/** The reasoning fields a request carried, or null when it carried none. */
export function effortFieldsOf(sent) {
  const fields = {};
  for (const key of ['think', 'reasoning_effort', 'reasoning_budget', 'chat_template_kwargs', 'thinking', 'reasoning', 'output_config']) {
    if (sent && sent[key] !== undefined && sent[key] !== null) fields[key] = sent[key];
  }
  return Object.keys(fields).length ? fields : null;
}

/**
 * @param {object} p
 * @param {number} p.n            1-based number of the call in this run
 * @param {number} p.status       HTTP status the extension got
 * @param {number} p.ms           time spent on the call
 * @param {number} p.requestBytes size of the request body
 * @param {number} p.responseBytes size of the response body
 * @param {object} p.sent         the parsed request body ({} when it was not JSON)
 * @param {object} p.got          the parsed response body ({} when it was not JSON)
 */
export function buildCallRecord({ n, status, ms, requestBytes, responseBytes, sent, got }) {
  const system = (sent.messages || []).find((m) => m.role === 'system');
  const { node, mode } = classifyRequest(sent);
  return {
    n,
    status,
    ms,
    requestBytes,
    responseBytes,
    model: sent.model,
    node,
    mode,
    format: 'none',
    think: sent.think,
    // The reasoning fields of the request (llm/effort.ts), whatever the dialect: the harness checks
    // that the effort the panel shows is the effort that went out.
    effort: effortFieldsOf(sent),
    messages: (sent.messages || []).length,
    systemChars: system ? system.content.length : 0,
    systemHead: system ? system.content.slice(0, 60) : '',
    promptEvalCount: got.prompt_eval_count ?? null,
    evalCount: got.eval_count ?? null,
    doneReason: got.done_reason ?? null,
    content: typeof got.message?.content === 'string' ? got.message.content : (got.error || ''),
    // The tool results this call brought to the model for the first time: the tool messages after
    // the last assistant turn. What the model was told is evidence a history row cannot give (rows
    // are cut to one line), so a harness check reads it here.
    toolResults: newToolResults(sent.messages),
    // The notes the loop added after that tool block (the reflection, the step limit), in full.
    loopNotes: newLoopNotes(sent.messages),
    // The run state the request ended with (the goal, the plan, what was saved, the steps).
    runState: runStateOf(sent.messages),
    // The text of the first user message: the task, and above it the chain of the chat (the earlier
    // turns, or the summary of a Compact), which a follow-up check reads.
    firstUserText: firstUserTextOf(sent.messages)
  };
}

/** How much of the first user message a record keeps. */
const FIRST_USER_CHARS = 30_000;

/** The text of the first user message of a request ('' when it has none), the run state taken off. */
export function firstUserTextOf(messages) {
  const first = (Array.isArray(messages) ? messages : []).find((m) => m && m.role === 'user');
  if (!first) return '';
  const text = Array.isArray(first.content)
    ? first.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n')
    : String(first.content ?? '');
  return withoutRunState(text).slice(0, FIRST_USER_CHARS);
}

/**
 * The run state the client adds to the LAST message of every request (withRunState in
 * src/background/mcp/client.ts): "[Run state] Goal: ...", at the end of that message's text. It is
 * not part of the tool result or the note it rides on, so every reader here takes it off first.
 */
export const RUN_STATE_MARK = '[Run state]';
const RUN_STATE_TAIL = /\n*\[Run state\][\s\S]*$/;

/** A message text without the run state at its end. */
function withoutRunState(text) {
  return typeof text === 'string' ? text.replace(RUN_STATE_TAIL, '') : text;
}

/** The run state a request carries on its last message, or null. */
function runStateOf(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const last = list[list.length - 1];
  if (!last) return null;
  const text = Array.isArray(last.content)
    ? last.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n')
    : String(last.content ?? '');
  const at = text.indexOf(RUN_STATE_MARK);
  return at < 0 ? null : text.slice(at);
}

/**
 * The plain user messages after the last assistant message of a request, that come after a tool
 * result: the notes the loop itself adds after a tool block. A picture message is not one.
 */
export function newLoopNotes(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let i = list.length - 1;
  while (i >= 0 && list[i] && list[i].role !== 'assistant') i -= 1;
  const after = list.slice(i + 1);
  const firstTool = after.findIndex((m) => m && m.role === 'tool');
  // After a plain-text reply (no tool calls) the note follows the reply itself (TEXT_ANSWER_TEXT).
  const answeredInText = list[i] && !(Array.isArray(list[i].tool_calls) && list[i].tool_calls.length);
  if (firstTool < 0) {
    return answeredInText
      ? after.filter((m) => m && m.role === 'user' && typeof m.content === 'string' && !Array.isArray(m.images)).map((m) => withoutRunState(m.content))
      : [];
  }
  return after.slice(firstTool).filter((m) => m && m.role === 'user' && typeof m.content === 'string' && !Array.isArray(m.images)).map((m) => withoutRunState(m.content));
}

/** The contents of the tool messages after the last assistant message of a request. */
export function newToolResults(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let i = list.length - 1;
  while (i >= 0 && list[i] && list[i].role !== 'assistant') i -= 1;
  return list.slice(i + 1).filter((m) => m && m.role === 'tool' && typeof m.content === 'string').map((m) => withoutRunState(m.content));
}
