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

export function describeFormat(format) {
  if (format === undefined) return 'none';
  if (typeof format === 'string') return format;
  if (Array.isArray(format.oneOf)) return `schema(oneOf x${format.oneOf.length})`;
  if (format.type === 'object') return `schema(object: ${Object.keys(format.properties || {}).join(',')})`;
  return 'schema(other)';
}

/** The `action` constants of a policy schema (a oneOf with one branch per verb), in branch order. */
export function actionsOfFormat(format) {
  if (!format || typeof format !== 'object' || !Array.isArray(format.oneOf)) return [];
  return format.oneOf.map((branch) => branch && branch.properties && branch.properties.action && branch.properties.action.const).filter((name) => typeof name === 'string');
}

/**
 * Which call of the LangGraph engine a request is, read only from what the request itself carries.
 *   plan     the orchestrator's plan call: a schema with task_kind and sites ('initial'), or with drop, add and
 *            order ('revise', which the engine does not send yet)
 *   policy   the worker's step call, one schema per policy mode (src/background/agent/schemas.ts buildPolicySchema):
 *            'browse' has the click verb, 'answer' has finish, 'extract' has continue_browsing, and 'harvest' is
 *            the record_finding schema without either of those
 *   reflect  the orchestrator's reflect call and the worker's mid-site reflect: no schema, told apart by the
 *            first words of their own system prompt, which starts a line after the user's system instructions
 *            (settings.systemInstructions, prepended by AgentRunner to every call)
 * Anything else is { node: 'unknown' }, which includes the calls of the old engine (its schema has click AND
 * finish), so a protocol drift is named and not guessed.
 *
 * @param {{format?: unknown, messages?: {role: string, content: string}[]}} sent the parsed request body
 * @returns {{node: 'plan'|'policy'|'reflect'|'unknown', mode: string}}
 */
export function classifyRequest(sent) {
  const format = sent && sent.format;
  const system = ((sent && Array.isArray(sent.messages) ? sent.messages : []).find((m) => m && m.role === 'system') || {}).content || '';
  if (format && typeof format === 'object') {
    const props = format.properties || {};
    if (props.task_kind && props.sites) return { node: 'plan', mode: 'initial' };
    if (props.drop && props.add && props.order) return { node: 'plan', mode: 'revise' };
    if (props.decision && props.changes) return { node: 'reflect', mode: 'initial' };
    const verbs = new Set(actionsOfFormat(format));
    if (verbs.size > 0) {
      if (verbs.has('click') && verbs.has('finish')) return { node: 'unknown', mode: '' };
      if (verbs.has('click')) return { node: 'policy', mode: 'browse' };
      if (verbs.has('finish')) return { node: 'policy', mode: 'answer' };
      if (verbs.has('continue_browsing')) return { node: 'policy', mode: 'extract' };
      if (verbs.has('record_finding')) return { node: 'policy', mode: 'harvest' };
    }
    return { node: 'unknown', mode: '' };
  }
  if (format === undefined) {
    if (/^You are the reflection supervisor of an autonomous browser agent\./m.test(system)) return { node: 'reflect', mode: 'initial' };
    if (/^You are an autonomous web agent strategy supervisor\./m.test(system)) return { node: 'reflect', mode: 'mid_site' };
  }
  return { node: 'unknown', mode: '' };
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
    format: describeFormat(sent.format),
    think: sent.think,
    messages: (sent.messages || []).length,
    systemChars: system ? system.content.length : 0,
    systemHead: system ? system.content.slice(0, 60) : '',
    promptEvalCount: got.prompt_eval_count ?? null,
    evalCount: got.eval_count ?? null,
    doneReason: got.done_reason ?? null,
    content: typeof got.message?.content === 'string' ? got.message.content : (got.error || '')
  };
}
