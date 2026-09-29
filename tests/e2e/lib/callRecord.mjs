/**
 * The record kept for every /api/chat call, shared by the Ollama proxy (real mode) and the
 * offline mock (--mock), so a report looks the same in both modes and the two cannot drift.
 */

export function describeFormat(format) {
  if (format === undefined) return 'none';
  if (typeof format === 'string') return format;
  if (Array.isArray(format.oneOf)) return `schema(oneOf x${format.oneOf.length})`;
  if (format.type === 'object') return `schema(object: ${Object.keys(format.properties || {}).join(',')})`;
  return 'schema(other)';
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
  return {
    n,
    status,
    ms,
    requestBytes,
    responseBytes,
    model: sent.model,
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
