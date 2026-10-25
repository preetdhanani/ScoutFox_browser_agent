/**
 * The record kept for every /api/chat call, shared by the Ollama proxy (real mode) and the
 * offline mock (--mock), so a report looks the same in both modes and the two cannot drift.
 */

/**
 * What a reply of the offline mock starts with when the prompt did not contain what its task needs (an empty page, no price line,
 * a goal it does not know). It lives here so the smoke harness can look for it without loading the mock.
 */
export const MOCK_FAIL_PREFIX = 'MOCK-FAIL:';

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
    content: typeof got.message?.content === 'string' ? got.message.content : (got.error || '')
  };
}
