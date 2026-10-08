/**
 * agent/toolCalls.ts
 *
 * Tool-call markup: what a model writes when it answers in its own tool-calling syntax instead of
 * the JSON action the prompt asks for. This agent does not use tool calls, but the models do it
 * anyway:
 *   - DeepSeek DSML:  <｜DSML｜function_calls><｜DSML｜invoke name="click"><｜DSML｜parameter name="element_id" string="false">5</｜DSML｜parameter>...
 *   - Anthropic:      <function_calls><invoke name="click"><parameter name="element_id">5</parameter></invoke></function_calls>
 *   - Qwen and Hermes: <tool_call>{"name": "click", "arguments": {"element_id": 5}}</tool_call>
 *   - OpenAI:         {"tool_calls": [{"type": "function", "function": {"name": "click", "arguments": "{\"element_id\": 5}"}}]}
 *   - Others that carry a JSON call after a token or a key: Llama <|python_tag|>{"name": ..., "parameters": ...},
 *     Mistral [TOOL_CALLS] [{"name": ..., "arguments": ...}], Granite <|tool_call|>[...], the old
 *     OpenAI "function_call": {...}, and a bare {"name": ..., "arguments": ...} object with no token.
 *   - Llama and Qwen3-Coder <function=click>{"element_id": 5}</function> (or <parameter=element_id>5</parameter> children).
 *   - Gemma ```tool_code fences are only detected (the call is python), so they give the parse error.
 *
 * Such a reply used to fall through the parser to the prose stage and became an "Unconfirmed
 * answer" finish, which ended a real run by accident (DeepSeek through AgentRouter). parse.ts now
 * detects the markup first, and the result is either the converted action or the parse error below,
 * never prose. So this file is strict on purpose: a call is converted only when it is complete and
 * the name is a verb the current mode offers. Everything else (a truncated tag, a JSON fragment,
 * a parameter that was cut off, an unknown tool name) gives no call.
 *
 * Pure functions. Every scan is one pass (opening and closing tags are listed once and paired with
 * a moving pointer), so a reply full of unclosed tags cannot make it slow.
 */
import { REGISTRY, resolveVerb } from './actions.ts';
import { balancedEnd, findTopLevelObjects } from './repairJson.ts';
import type { ActionObject } from './sanitize.ts';

/**
 * A reply that contains any of these is tool-call markup: a DSML tag (fullwidth or plain bar), a
 * function_calls or tool_call tag, an Anthropic invoke tag, a DeepSeek tool-calls-begin token, a
 * Llama <|python_tag|> or Granite <|tool_call|> token, a <function=name> tag, Mistral's [TOOL_CALLS],
 * Gemma's tool_code fence, or an OpenAI "tool_calls" or "function_call" key. This is the regex of the
 * design plus these additions: DeepSeek's own tool-calls token has the fullwidth bar (the design has a
 * plain | there), so both are accepted as they are for DSML, a closing DSML tag counts like a closing
 * function_calls or tool_call tag, and the formats after DSML are the ones other model families write.
 */
export const TOOL_CALL_MARKUP = /<\/?[｜|]DSML[｜|]|<\/?function_calls>|<\/?tool_call>|<invoke\s+name=|<[｜|]tool[▁_]calls?[▁_]begin[｜|]>|<[｜|](?:python_tag|tool_call)[｜|]>|<function=|\[TOOL_CALLS\]|```tool_code\b|"(?:tool_calls|function_call)"\s*:/i;

/** The parse error for a reply that used tool-call markup and could not be turned into an allowed action. */
export const TOOL_CALL_MARKUP_ERROR = 'Your reply used tool-call markup. This agent does not use tool calls. Reply with a single JSON object {"action": ...}.';

// The tokens above that a reply can be cut in the middle of. The regex only sees a whole token, so a
// reply that ends inside the first tag ("<tool_ca", "<｜DSML") would look like plain prose.
const MARKUP_TOKENS = [
  '<｜dsml｜', '<|dsml|', '</｜dsml｜', '</|dsml|', '<function_calls>', '</function_calls>', '<tool_call>', '</tool_call>',
  '<invoke name=', '<｜tool▁calls▁begin｜>', '<|tool_calls_begin|>', '"tool_calls":',
  '<｜python_tag｜>', '<|python_tag|>', '<｜tool_call｜>', '<|tool_call|>', '<function=', '[tool_calls]', '```tool_code', '"function_call":'
];

/**
 * True when the text ends inside one of the markup tokens. At least 4 characters of the token must
 * be there, so that the "</t" of a closing think tag is not taken for the start of </tool_call>.
 * parse.ts asks this only when nothing else in the reply was usable: the reply is then a cut-off
 * tool call, and it is a parse error, never an answer.
 */
export function endsInsideMarkupToken(text: string): boolean {
  const tail = text.slice(-24).toLowerCase();
  for (let length = 4; length <= tail.length; length++) {
    const suffix = tail.slice(-length);
    if (MARKUP_TOKENS.some((token) => token.length > length && token.startsWith(suffix))) return true;
  }
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The object a JSON action span holds, read strictly (a raw line break inside a string is the one repair, as in the ladder). */
function parseObjectSpan(source: string): Record<string, unknown> | null {
  for (const candidate of [source, source.replace(/[\r\n]+/g, '\\n')]) {
    try {
      const value: unknown = JSON.parse(candidate);
      return isPlainObject(value) ? value : null;
    } catch (_) {
      // try the next form
    }
  }
  return null;
}

/**
 * The text with the string values of every complete action object emptied. What an action says in a
 * string (an answer that explains tool calling, text typed into a field) is content. It is not markup
 * that the reply is written in, and it must not send a valid action to the tool-call error. Keys are
 * kept, and so is everything outside such objects, so the markup of a real tool call is still there.
 */
function withoutActionStrings(text: string): string {
  let out = '';
  let cursor = 0;
  for (const span of findTopLevelObjects(text)) {
    if (!span.closed) break;
    const obj = parseObjectSpan(text.slice(span.start, span.end));
    if (obj === null || typeof obj.action !== 'string') continue;
    out += text.slice(cursor, span.start) + JSON.stringify(obj, (_key, value) => (typeof value === 'string' ? '' : value));
    cursor = span.end;
  }
  return out + text.slice(cursor);
}

/**
 * True when the reply is written in tool-call markup (a whole token of TOOL_CALL_MARKUP). A token
 * that only appears inside the strings of a complete action object is that action's content, so
 * `{"action":"finish","answer":"wrap each call in <tool_call> tags"}` is an action, not markup.
 */
export function hasToolCallMarkup(text: string): boolean {
  return TOOL_CALL_MARKUP.test(text) && TOOL_CALL_MARKUP.test(withoutActionStrings(text));
}

interface ToolCall {
  /** Where the call starts in the text, so the first one written is the first one used. */
  pos: number;
  name: string;
  args: Record<string, unknown>;
}

// The tag prefix of DSML. Anthropic's tags have none.
const DSML = '(?:[｜|]DSML[｜|])?';
const INVOKE_OPEN = new RegExp(`<${DSML}invoke\\s+name\\s*=\\s*"([^"<>\\n]{1,100})"\\s*>`, 'gi');
const INVOKE_CLOSE = new RegExp(`</${DSML}invoke\\s*>`, 'gi');
const PARAM_OPEN = new RegExp(`<${DSML}parameter\\s+name\\s*=\\s*"([^"<>\\n]{1,100})"([^<>]{0,200})>`, 'gi');
const PARAM_CLOSE = new RegExp(`</${DSML}parameter\\s*>`, 'gi');
const PARAM_TAG = new RegExp(`</?${DSML}parameter\\b`, 'gi');

// A tool call is never long, so this only stops a reply full of "tool_calls" keys (or other JSON
// markers) from costing a scan of the whole text each.
const MAX_JSON_MARKERS = 16;

// Markers that are followed by the JSON of a call: an OpenAI key, a Llama, Granite or Mistral token.
const JSON_MARKERS = /"(?:tool_calls|function_call)"\s*:|<[｜|](?:python_tag|tool_call)[｜|]>|\[TOOL_CALLS\]/gi;

// <function=name>...</function>, with either a JSON object or <parameter=name>value</parameter> children.
const FUNCTION_OPEN = /<function=([^\s<>"'=]{1,100})>/gi;
const FUNCTION_CLOSE = /<\/function>/gi;
const EQ_PARAM_OPEN = /<parameter=([^\s<>"'=]{1,100})>/gi;
const EQ_PARAM_CLOSE = /<\/parameter>/gi;

/** The type the registry gives a field of a verb ('string', 'integer', 'boolean', 'array'...), if it has one. */
function fieldType(verb: string, field: string): string | undefined {
  let schema = REGISTRY.verbs.find((v) => v.name === verb)?.schema.properties[field];
  if (!schema) return undefined;
  if (typeof schema.$ref === 'string') schema = REGISTRY.$defs[schema.$ref.slice('#/$defs/'.length)] ?? schema;
  if ('$batchSteps' in schema) return 'array';
  if (typeof schema.type === 'string') return schema.type;
  if (Array.isArray(schema.enum)) return 'string';
  return undefined;
}

function parseJsonOr(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (_) {
    return text;
  }
}

/**
 * The value of an XML parameter, typed. DSML says it itself: string="true" is text exactly as
 * written and string="false" is a JSON literal. Anthropic's tags say nothing, so the registry decides
 * by the field (a typed "2024" stays text, an element_id "5" becomes 5), and a field the registry does
 * not know is a JSON literal when it reads as one.
 */
function paramValue(verb: string | undefined, field: string, raw: string, attributes: string): unknown {
  const stringAttribute = /\bstring\s*=\s*"(true|false)"/i.exec(attributes)?.[1].toLowerCase();
  if (stringAttribute === 'true') return raw;
  const text = raw.trim();
  if (stringAttribute === 'false') return parseJsonOr(text);
  const type = verb ? fieldType(verb, field) : undefined;
  if (type === 'string') return text;
  if (type === 'integer' || type === 'number') return text !== '' && Number.isFinite(Number(text)) ? Number(text) : text;
  if (type === 'boolean') return /^(true|false)$/i.test(text) ? text.toLowerCase() === 'true' : text;
  if (type === 'array' || type === 'object') return parseJsonOr(text);
  const parsed = parseJsonOr(text);
  return typeof parsed === 'string' ? text : parsed;
}

/**
 * The parameters inside one invoke, or null when the invoke is malformed: a parameter tag that is
 * not complete (opened and never closed, cut in the middle of its own tag, or opened again before
 * it closed) means the model was cut off, and a half-read call must not run.
 */
function xmlParams(body: string, verb: string | undefined): Record<string, unknown> | null {
  const opens = [...body.matchAll(PARAM_OPEN)];
  const closes = [...body.matchAll(PARAM_CLOSE)];
  if ([...body.matchAll(PARAM_TAG)].length !== opens.length + closes.length) return null;
  const args: Record<string, unknown> = {};
  let ci = 0;
  for (let oi = 0; oi < opens.length; oi++) {
    const open = opens[oi];
    const valueStart = open.index + open[0].length;
    while (ci < closes.length && closes[ci].index < valueStart) ci++;
    const close = closes[ci];
    if (!close) return null;
    const next = opens[oi + 1];
    if (next && next.index < close.index) return null;
    args[open[1]] = paramValue(verb, open[1], body.slice(valueStart, close.index), open[2]);
    ci++;
  }
  return args;
}

/** DSML and Anthropic calls: <invoke name="..."> with <parameter name="..."> children. */
function xmlCalls(text: string): ToolCall[] {
  const opens = [...text.matchAll(INVOKE_OPEN)];
  const closes = [...text.matchAll(INVOKE_CLOSE)];
  const calls: ToolCall[] = [];
  let ci = 0;
  for (let oi = 0; oi < opens.length; oi++) {
    const open = opens[oi];
    const bodyStart = open.index + open[0].length;
    while (ci < closes.length && closes[ci].index < bodyStart) ci++;
    const close = closes[ci];
    if (!close) break; // no closing tag after this one, so none after any later one either
    const next = opens[oi + 1];
    if (next && next.index < close.index) continue; // this invoke was never closed before the next began
    const name = open[1].trim();
    const args = xmlParams(text.slice(bodyStart, close.index), resolveVerb(name));
    if (args) calls.push({ pos: open.index, name, args });
  }
  return calls;
}

/**
 * The calls in a parsed JSON value: one call object, an array of them, or an OpenAI entry that
 * wraps the call in `function`. `arguments` is an object, or the JSON string OpenAI sends.
 */
function callsFromJson(value: unknown, pos: number): ToolCall[] {
  if (Array.isArray(value)) return value.flatMap((item) => callsFromJson(item, pos));
  if (!isPlainObject(value)) return [];
  const fn = isPlainObject(value.function) ? value.function : value;
  if (typeof fn.name !== 'string') return [];
  let args = fn.arguments ?? fn.parameters ?? fn.input ?? {};
  if (typeof args === 'string') {
    if (args.trim() === '') args = {};
    else {
      try {
        args = JSON.parse(args);
      } catch (_) {
        return [];
      }
    }
  }
  if (!isPlainObject(args)) return [];
  return [{ pos, name: fn.name.trim(), args }];
}

/** The text inside a ``` fence (with an optional "json" label) when the whole text is one fenced block, else the text itself. */
function unfence(text: string): string {
  if (text.length < 6 || !text.startsWith('```') || !text.endsWith('```')) return text;
  return text.slice(3, -3).replace(/^json/i, '').trim();
}

/** The JSON inside a tag: <tool_call>{"name": ..., "arguments": {...}}</tool_call>. Strict JSON only, so a cut-off call is not repaired into a different one. */
function taggedJsonCalls(text: string, tag: string): ToolCall[] {
  const opens = [...text.matchAll(new RegExp(`<${tag}>`, 'gi'))];
  const closes = [...text.matchAll(new RegExp(`</${tag}>`, 'gi'))];
  const calls: ToolCall[] = [];
  let ci = 0;
  for (let oi = 0; oi < opens.length; oi++) {
    const open = opens[oi];
    const bodyStart = open.index + open[0].length;
    while (ci < closes.length && closes[ci].index < bodyStart) ci++;
    const close = closes[ci];
    if (!close) break;
    const next = opens[oi + 1];
    if (next && next.index < close.index) continue;
    try {
      calls.push(...callsFromJson(JSON.parse(unfence(text.slice(bodyStart, close.index).trim())), open.index));
    } catch (_) {
      // Not JSON (a cut-off call, or XML for xmlCalls to read): no call from this tag.
    }
  }
  return calls;
}

/** The JSON value that starts right after `from` (blanks skipped), or undefined when there is none or it is not complete and valid. Strict, so a cut-off call is not repaired into another one. */
function jsonAfter(text: string, from: number): unknown {
  let at = from;
  while (at < text.length && /\s/.test(text[at])) at++;
  const open = text[at];
  if (open !== '{' && open !== '[') return undefined;
  const { end, closed } = balancedEnd(text, at, open, open === '{' ? '}' : ']');
  if (!closed) return undefined;
  try {
    return JSON.parse(text.slice(at, end));
  } catch (_) {
    return undefined;
  }
}

/** The calls whose JSON follows a marker: an OpenAI "tool_calls" or "function_call" key (a whole message, a choice, or the bare key), <|python_tag|>, <|tool_call|> and [TOOL_CALLS]. */
function markerCalls(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  let markers = 0;
  for (const marker of text.matchAll(JSON_MARKERS)) {
    if (++markers > MAX_JSON_MARKERS) break;
    const value = jsonAfter(text, marker.index + marker[0].length);
    if (value !== undefined) calls.push(...callsFromJson(value, marker.index));
  }
  return calls;
}

/** The value of a <parameter=name> child, typed like an Anthropic parameter (no attributes to say more). */
function eqParams(body: string, verb: string | undefined): Record<string, unknown> | null {
  const opens = [...body.matchAll(EQ_PARAM_OPEN)];
  const closes = [...body.matchAll(EQ_PARAM_CLOSE)];
  if (opens.length === 0 || opens.length !== closes.length) return null; // a body with no parameter is free text, not a call
  const args: Record<string, unknown> = {};
  for (let i = 0; i < opens.length; i++) {
    const valueStart = opens[i].index + opens[i][0].length;
    const close = closes[i];
    if (close.index < valueStart) return null;
    const next = opens[i + 1];
    if (next && next.index < close.index) return null;
    args[opens[i][1]] = paramValue(verb, opens[i][1], body.slice(valueStart, close.index), '');
  }
  return args;
}

/** Llama and Qwen3-Coder calls: <function=name>{JSON arguments}</function> or <function=name><parameter=key>value</parameter></function>. */
function functionTagCalls(text: string): ToolCall[] {
  const opens = [...text.matchAll(FUNCTION_OPEN)];
  const closes = [...text.matchAll(FUNCTION_CLOSE)];
  const calls: ToolCall[] = [];
  let ci = 0;
  for (let oi = 0; oi < opens.length; oi++) {
    const open = opens[oi];
    const bodyStart = open.index + open[0].length;
    while (ci < closes.length && closes[ci].index < bodyStart) ci++;
    const close = closes[ci];
    if (!close) break;
    const next = opens[oi + 1];
    if (next && next.index < close.index) continue;
    const name = open[1].trim();
    const body = text.slice(bodyStart, close.index).trim();
    let args: Record<string, unknown> | null;
    if (body === '') args = {};
    else if (body.startsWith('{')) {
      try {
        const value: unknown = JSON.parse(body);
        args = isPlainObject(value) ? value : null;
      } catch (_) {
        args = null;
      }
    } else args = eqParams(body, resolveVerb(name));
    if (args) calls.push({ pos: open.index, name, args });
  }
  return calls;
}

/** The action of the first call written, when its name is a verb `verbs` offers, else null. The verb comes from the tool name (through the alias table) and wins over an `action` key inside the parameters. */
function firstAllowedCall(calls: ToolCall[], verbs: readonly string[]): ActionObject | null {
  const first = [...calls].sort((a, b) => a.pos - b.pos)[0];
  if (!first) return null;
  const verb = resolveVerb(first.name);
  if (verb === undefined || !verbs.includes(verb)) return null;
  const { action: _ignored, ...params } = first.args;
  return { action: verb, ...params };
}

/**
 * Turns tool-call markup into {action: <verb>, ...parameters}, or null when it cannot be turned
 * into an action this mode allows. Only the first call is used (the agent runs one action per
 * step, and the model sees the page again afterwards). The verb comes from the tool name, through the
 * same alias table as a JSON action, and it wins over an `action` key inside the parameters.
 *
 * A name that is not a verb of `verbs` gives null, so the caller answers with the tool-call parse
 * error, and it never becomes text. That is also how a `finish` written as a tool call is decided:
 * it is a converted action like any other when `verbs` has finish.
 *
 * @param verbs the verbs the current mode offers
 */
export function convertToolCallMarkup(text: string, verbs: readonly string[]): ActionObject | null {
  return firstAllowedCall([
    ...xmlCalls(text),
    ...functionTagCalls(text),
    ...taggedJsonCalls(text, 'tool_call'),
    ...taggedJsonCalls(text, 'function_calls'),
    ...markerCalls(text)
  ], verbs);
}

/**
 * Whether a parsed JSON value is a tool call (or a list of them) written with no token around it:
 * {"name": "click", "arguments": {...}} (also `parameters` and `input`), or an OpenAI entry that
 * wraps the call in `function`. The arguments are an object, or for `arguments` the JSON string that
 * OpenAI sends, so a record such as {"name": "Framework", "input": "laptop"} in an answer is not a
 * call. An object with an `action` key is an action and never a call.
 */
export function isToolCallShape(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0 && value.every(isToolCallShape);
  if (!isPlainObject(value) || value.action !== undefined) return false;
  if (isPlainObject(value.function) && typeof value.function.name === 'string') return true;
  return typeof value.name === 'string'
    && (isPlainObject(value.arguments) || typeof value.arguments === 'string' || isPlainObject(value.parameters) || isPlainObject(value.input));
}

/**
 * A tool call written as bare JSON, for a reply in which no action object was found: the whole reply
 * (or its one fenced block) is a call or a list of calls, or a complete top-level object of the reply
 * is one. It has no token for TOOL_CALL_MARKUP to see, but it is not prose either, and it must not end
 * a run as an answer.
 *
 * @returns found: the reply has such a call. action: what it converts to, null when the name is not
 *   a verb `verbs` offers (the caller then answers with the tool-call parse error).
 */
export function convertBareToolCall(text: string, verbs: readonly string[]): { found: boolean; action: ActionObject | null } {
  const trimmed = unfence(text.trim());
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const whole = jsonAfter(trimmed, 0);
    if (whole !== undefined && isToolCallShape(whole)) return { found: true, action: firstAllowedCall(callsFromJson(whole, 0), verbs) };
  }
  for (const span of findTopLevelObjects(text)) {
    if (!span.closed) break;
    const obj = parseObjectSpan(text.slice(span.start, span.end));
    if (obj !== null && isToolCallShape(obj)) return { found: true, action: firstAllowedCall(callsFromJson(obj, span.start), verbs) };
  }
  return { found: false, action: null };
}
