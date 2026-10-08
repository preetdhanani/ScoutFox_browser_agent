/**
 * agent/parse.ts
 *
 * Turns a model reply into an action, or into the parse error the model is shown so it can correct
 * itself. Universal Multi-Stage Guardrail Action Parser, as a pure function: the engine passes in
 * the verbs this reply may use and the ids that are on the page, and holds no state here.
 *
 * The stages, in order (docs/langgraph-design.md, Parser):
 *   0. empty output is an error; a reply that is exactly one JSON object with a string "action" is
 *      taken whole (what Ollama's schema forces), and the stages below are skipped for it;
 *   1. <think>, <thought> and <reasoning> content becomes the thought and is removed;
 *   2. tool-call markup (DSML, <tool_call>, <function_calls>, OpenAI tool_calls and the other formats
 *      of toolCalls.ts) is converted to an action or is the tool-call parse error. Once the markup
 *      regex matches, stages 3 to 5 never run, so malformed markup can not end up as prose. Text
 *      that only sits inside the strings of a complete action object is that action's content and
 *      does not count as markup;
 *   3. JSON: the first fenced block, else the first top-level object with an "action" key, else the
 *      last one with an alias key, found by the string-aware scanner and repaired by the ladder of
 *      repairJson.ts. A tool call written as bare JSON ({"name": ..., "arguments": ...}) is converted
 *      or is the tool-call parse error, like markup;
 *   4. plain-text intents (click, type, navigate, scroll, read), only for verbs this reply may use;
 *   5. prose becomes an unconfirmed `finish`, only when `finish` is one of the verbs;
 *   6. sanitize (sanitize.ts): aliases, the verb check, element ids, browser_batch step ids.
 *
 * Not yet here: the schema validation against the registry, the banned-signature check, and the
 * `ref_12` id form (they arrive with the stable element ids and the policy modes).
 *
 * The design says the LAST object with an action wins. The old engine took the FIRST object with an
 * "action" key (its regex) and only when there was none scanned backwards for the alias shapes, and
 * that order is kept: a reply that lists steps, or an action followed by an example of another one
 * ("...I would send {"action": "finish", ...}"), must run the first action, and a finish the model
 * did not mean ends the run for good. Both reviewers' repros are tests of this file.
 */
import { PLAN_MAX_STEPS } from './schemas.ts';
import { balancedEnd, findTopLevelObjects, parsePartialOrTruncatedJson, rescueTruncatedJson } from './repairJson.ts';
import { maxRef, sanitizeAction } from './sanitize.ts';
import type { ActionObject, LogSink, PageRefs } from './sanitize.ts';
import { convertBareToolCall, convertToolCallMarkup, endsInsideMarkupToken, hasToolCallMarkup, isToolCallShape, TOOL_CALL_MARKUP_ERROR } from './toolCalls.ts';

export interface ParseOptions {
  /** The verbs this reply may use. `finish` in the list also allows a prose reply to end the run (as an unconfirmed answer). */
  verbs: readonly string[];
  /** The ids on the page. Left out when the list is not known (see SanitizeOptions). */
  refs?: PageRefs;
  /** Where a guardrail reports a rejection or a prose auto-wrap (the engine passes its Logger). */
  log?: LogSink;
  /**
   * Word a rejected element_id of a single action the way the old engine always did ("Selected
   * element_id N does not exist on this page (valid range: 1-N)..."), and not with the design text
   * that browser_batch steps use. Only the old engine sets it, and it goes away with the old engine.
   */
  legacyElementIdError?: boolean;
}

export type ParseErrorKind =
  | 'empty'
  | 'tool_call_markup'
  | 'malformed'
  | 'not_an_action'
  | 'unknown_action'
  | 'unavailable_action'
  | 'bad_element_id'
  | 'bad_step_element_id';

export interface ParsedReply {
  thought: string;
  action: ActionObject;
  /** The model's own `expected_outcome`, whatever it wrote. The old engine's verifyStep reads it. */
  expectedOutcome: unknown;
  error?: undefined;
  kind?: undefined;
  raw?: undefined;
}

export interface ParseFailure {
  thought: string;
  /** The text the model sees on its next turn. */
  error: string;
  kind: ParseErrorKind;
  /** The reply that could not be used (not set for empty output). */
  raw?: string;
  action?: undefined;
  expectedOutcome?: undefined;
}

export type ParseResult = ParsedReply | ParseFailure;

const NOT_AN_ACTION_ERROR = 'Your reply was not an action. Reply with a single JSON object {"action": ...}.';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The reply is exactly one JSON object with a string "action" - what Ollama returns when the
 * action schema is sent as `format`. Parsed whole, so nested objects (browser_batch steps, a
 * read_network_requests filter) survive. Anything else returns null and goes through the later stages.
 */
export function parseBareActionJson(text: string): ActionObject | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  try {
    const obj = JSON.parse(trimmed);
    return isPlainObject(obj) && typeof obj.action === 'string' ? obj : null;
  } catch (_) {
    return null;
  }
}

/**
 * Splits <think>, <thought> and <reasoning> blocks off a reply: the first block is the thought, and
 * every block is removed from the text. A block needs an opening and a closing tag (the name of the
 * closing tag may differ), and an opening tag with no closing one stays in the text. One pass, so a
 * reply with thousands of opening tags stays fast.
 *
 * A closing tag with no opening tag before it ends reasoning that the model started without writing
 * the opening tag (some chat templates put it in the prompt): everything before it is the thought.
 * That is not done for a closing tag inside a complete JSON object, where it is part of a string.
 */
function stripThinking(text: string): { thought: string; clean: string } {
  const opens = [...text.matchAll(/<(?:think|thought|reasoning)>/gi)];
  const closes = [...text.matchAll(/<\/(?:think|thought|reasoning)>/gi)];
  let thought = '';
  let clean = '';
  let cursor = 0;
  let ci = 0;
  let firstBlock = true;
  const orphan = closes[0];
  if (orphan && (opens.length === 0 || orphan.index < opens[0].index) && !insideObject(text, orphan.index)) {
    thought = text.slice(0, orphan.index).trim();
    firstBlock = false;
    cursor = orphan.index + orphan[0].length;
    ci = 1;
  }
  for (const open of opens) {
    if (open.index < cursor) continue; // inside the block just removed
    const contentStart = open.index + open[0].length;
    while (ci < closes.length && closes[ci].index < contentStart) ci++;
    const close = closes[ci];
    if (!close) break;
    if (firstBlock) thought = text.slice(contentStart, close.index).trim();
    firstBlock = false;
    clean += text.slice(cursor, open.index);
    cursor = close.index + close[0].length;
  }
  clean += text.slice(cursor);
  return { thought, clean: clean.trim() };
}

/** True when `index` is inside a complete top-level `{...}` object of the text. */
function insideObject(text: string, index: number): boolean {
  return findTopLevelObjects(text).some((span) => span.closed && index > span.start && index < span.end);
}

/** The text of the first ``` fenced block (an optional "json" label is skipped), or null. */
function firstFencedBlock(text: string): string | null {
  const open = text.indexOf('```');
  if (open < 0) return null;
  let from = open + 3;
  if (text.slice(from, from + 4).toLowerCase() === 'json') from += 4;
  const close = text.indexOf('```', from);
  if (close < 0) return null;
  return text.slice(from, close).trim();
}

// The keys a small model uses instead of an "action" key: {"click": 3}, {"finish": "..."}.
const ALIAS_KEYS = ['click', 'type', 'finish', 'execute_js', 'browser_batch', 'read_network_requests'];

/** An object with an "action" key. */
function isExplicitAction(value: unknown): value is ActionObject {
  return isPlainObject(value) && value.action !== undefined;
}

/**
 * A JSON value that counts as an action when it is found in text: an object with an "action" key,
 * or an alias-key shape. A tool call in the OpenAI shape ({"type": "function", "function": {...}})
 * has a `type` key too, and is not the {"type": ...} shape.
 */
function isActionCandidate(value: unknown): value is ActionObject {
  return isExplicitAction(value) || (isPlainObject(value) && ALIAS_KEYS.some((key) => value[key]) && !isToolCallShape(value));
}

/**
 * The action JSON in a reply: the first fenced block when it holds one, else the first top-level
 * object of the text that has an "action" key, else the last one that has an alias key (see the
 * header for why it is not the last action). Objects are found by the string-aware scanner, so a
 * nested browser_batch or filter object stays whole, and each is repaired by the ladder.
 *
 * An object that never closed (the reply ends inside it) is not repaired by closing it, as a reply
 * that stopped after `"element_id": 1` may have meant 12, and a cut-off URL opens a different page.
 * The one payload that is taken from such an object is a truncated execute_js (see rescueTruncatedJson).
 */
function findJsonAction(text: string): ActionObject | null {
  const fenced = firstFencedBlock(text);
  if (fenced) {
    const parsed = parsePartialOrTruncatedJson(fenced);
    if (isActionCandidate(parsed)) return parsed;
  }
  let lastAlias: ActionObject | null = null;
  for (const { start, end, closed } of findTopLevelObjects(text)) {
    const source = text.slice(start, end);
    let parsed: unknown;
    if (closed) {
      parsed = parsePartialOrTruncatedJson(source);
    } else {
      const rescued = rescueTruncatedJson(source);
      parsed = rescued?.action === 'execute_js' && rescued.code ? rescued : null;
    }
    if (isExplicitAction(parsed)) return parsed;
    if (isActionCandidate(parsed)) lastAlias = parsed;
  }
  return lastAlias;
}

/** True when the words appear in this order inside one line (what `read.*page.*text` says, without its backtracking). */
function inOrder(line: string, words: readonly string[]): boolean {
  let at = 0;
  for (const word of words) {
    const found = line.indexOf(word, at);
    if (found < 0) return false;
    at = found + word.length;
  }
  return true;
}

const PAGE_TEXT_INTENTS = [['read', 'page', 'text'], ['extract', 'text'], ['get', 'page', 'content']] as const;

function wantsPageText(text: string): boolean {
  // "." does not cross a line break, so each line is checked alone.
  return text.toLowerCase().split(/[\n\r\u2028\u2029]/).some((line) => PAGE_TEXT_INTENTS.some((words) => inOrder(line, words)));
}

/** REGEX Intent Extractor for Dumber / Smaller LLMs outputting plain text, only for verbs this reply may use. */
function intentAction(text: string, verbs: readonly string[]): ActionObject | null {
  if (verbs.includes('click')) {
    const clickMatch = text.match(/(?:action:?\s*)?(?:click|press|tap)\s+(?:on\s+)?(?:element\s+)?\[?(\d+)\]?/i);
    if (clickMatch) return { action: 'click', element_id: parseInt(clickMatch[1], 10), reason: 'Extracted via text intent' };
  }
  if (verbs.includes('type')) {
    const typeMatch = text.match(/(?:action:?\s*)?(?:type|enter|write|input)\s+["']([^"']+)["']\s+(?:in|into|on)\s+(?:element\s+)?\[?(\d+)\]?/i);
    if (typeMatch) return { action: 'type', text: typeMatch[1], element_id: parseInt(typeMatch[2], 10), submit: true, reason: 'Extracted via text intent' };
  }
  if (verbs.includes('navigate')) {
    const navMatch = text.match(/(?:action:?\s*)?(?:navigate|go\s+to|open)\s+(https?:\/\/[^\s]+)/i);
    if (navMatch) return { action: 'navigate', url: navMatch[1], reason: 'Extracted via text intent' };
  }
  if (verbs.includes('scroll')) {
    const scrollMatch = text.match(/(?:action:?\s*)?(?:scroll)\s+(down|up)/i);
    if (scrollMatch) return { action: 'scroll', direction: scrollMatch[1].toLowerCase(), amount: 500, reason: 'Extracted via text intent' };
  }
  if (verbs.includes('read_page_text') && wantsPageText(text)) return { action: 'read_page_text', reason: 'Extracted via text intent' };
  return null;
}

function fail(thought: string, kind: ParseErrorKind, error: string, raw?: string): ParseFailure {
  return raw === undefined ? { thought, error, kind } : { thought, error, kind, raw };
}

/** The id as the model wrote it: a number, or a string of digits as that number ("7" and 7 are both [7]), else its JSON. */
function idForMessage(raw: unknown): string {
  if (typeof raw === 'number') return String(raw);
  if (typeof raw === 'string' && /^\s*\d+\s*$/.test(raw)) return String(Number(raw));
  return JSON.stringify(raw);
}

/** The text the model sees for an element id that is not in the current element list. */
function elementListError(id: string): string {
  return `Element [${id}] is not in the current element list (it may be from an older view of the page). Use an id from the list.`;
}

/**
 * Parses one model reply. Never throws.
 *
 * @returns the action (already sanitised, ids checked) with the thought, or the error text the model
 *   sees on its next turn with a `kind` that says which rule rejected it.
 */
export function parseModelReply(text: unknown, options: ParseOptions): ParseResult {
  const { verbs, refs, log, legacyElementIdError } = options;

  // 0. Empty output
  if (!text || typeof text !== 'string') return fail('', 'empty', 'Empty output from model.');

  let thought = '';

  // 0. The whole reply is one JSON object with an "action" key - the shape Ollama's schema
  // forces. Stages 1-5 are skipped for it, and run for everything else.
  let actionObj = parseBareActionJson(text);

  if (!actionObj) {
    // 1. Extract <think> or <thought> or <reasoning>
    const stripped = stripThinking(text);
    thought = stripped.thought;
    const cleanText = stripped.clean;

    if (hasToolCallMarkup(cleanText)) {
      // 2. Tool-call markup. From here the reply is either the converted action or the tool-call
      // parse error: the JSON scan, the text intents and the prose stage below are never reached, so
      // malformed DSML, a truncated <tool_call> or a JSON fragment inside the markup can not end
      // the run as an "answer". The action is checked below like any other (its verb must be in
      // `verbs`, ids must be on the page).
      //
      // An explicit `finish` written as a tool call is a converted action like any other. The
      // engine has no policy modes yet and passes every verb, so it is allowed here. With the policy
      // modes `finish` is only in the verbs of the answer mode, and this same check rejects it in
      // every other mode.
      actionObj = convertToolCallMarkup(cleanText, verbs);
      if (!actionObj) return fail(thought, 'tool_call_markup', TOOL_CALL_MARKUP_ERROR, text);
    } else {
      // 3. JSON: a fenced block, else the first object with an action key, else the last alias shape
      actionObj = findJsonAction(cleanText);

      // A tool call written as bare JSON has no token for the markup regex, but it is not prose.
      if (!actionObj) {
        const bare = convertBareToolCall(cleanText, verbs);
        if (bare.found) {
          if (!bare.action) return fail(thought, 'tool_call_markup', TOOL_CALL_MARKUP_ERROR, text);
          actionObj = bare.action;
        }
      }

      // 4. REGEX Intent Extractor for Dumber / Smaller LLMs outputting plain text
      if (!actionObj) actionObj = intentAction(cleanText, verbs);

      // A tool call that was cut off inside its first tag ("<tool_ca") has no whole token for the
      // markup regex to match. Nothing usable was found, so it is still a tool-call error, not prose.
      if (!actionObj && endsInsideMarkupToken(cleanText)) return fail(thought, 'tool_call_markup', TOOL_CALL_MARKUP_ERROR, text);

      // 5. Freeform Text Auto-Wrapping Guardrail (PROTECTED AGAINST TRUNCATED JSON PAYLOADS)
      const looksLikeActionJson = /"action"\s*:|"execute_js"|"browser_batch"|```json/i.test(cleanText);

      // A reply that starts with an object that never closes is a JSON payload that was cut off
      // (for example a tool_calls message cut before its "tool_calls" key), not an answer.
      const cutOffObject = cleanText.startsWith('{') && !balancedEnd(cleanText, 0, '{', '}').closed;

      if (!actionObj && cleanText.length > 5 && !looksLikeActionJson && !cutOffObject) {
        // Only where the run may end on prose (the verbs include finish). In the modes that do not
        // offer finish, prose is a parse error.
        if (!verbs.includes('finish')) return fail(thought, 'not_an_action', NOT_AN_ACTION_ERROR, text);
        log?.('info', '[UNIVERSAL_GUARDRAIL] Model provided direct text response. Auto-wrapping into finish action.');
        actionObj = {
          action: 'finish',
          answer: cleanText,
          reason: 'Direct text output from model',
          // The model never actually emitted {"action":"finish"} - it just replied in prose and
          // this guardrail inferred an ending so the run has somewhere to go. buildFinishEntry
          // (agent/outcome.ts) turns this into an `unconfirmed` flag so it is shown as inferred,
          // not declared. See agent/outcome.ts for why that distinction matters.
          autoWrapped: true
        };
      }
    }
  }

  if (!actionObj) {
    return fail(thought, 'malformed', 'Model output contained a truncated or malformed action JSON. Retrying with simpler prompt.', text);
  }

  // 6. Action Schema & Element ID Sanitizer
  const act = sanitizeAction(actionObj, { verbs, refs, log });

  if ('invalidAction' in act) {
    if (act.invalidAction === undefined) {
      return fail(thought, 'not_an_action', `The reply has no "action". Valid actions are: ${verbs.join(', ')}.`);
    }
    return fail(thought, 'unknown_action', `Unknown action "${act.invalidAction}". Valid actions are: ${verbs.join(', ')}.`);
  }

  if (act.unavailableAction !== undefined) {
    return fail(thought, 'unavailable_action', `Action "${act.unavailableAction}" is not available here. Valid actions are: ${verbs.join(', ')}.`);
  }

  if (act.invalidElementId) {
    // A hallucinated or out-of-range element_id used to be silently clamped/coerced onto a
    // DIFFERENT, real element - the agent then confidently acted on the wrong thing instead
    // of visibly failing. Routing it through the same parse-error/retry path as malformed
    // JSON (consecutiveParseErrors, corrective feedback, the 3-strike circuit breaker) gives
    // the model a chance to look at the element list again instead of clicking blind.
    if (!legacyElementIdError) return fail(thought, 'bad_element_id', elementListError(idForMessage(act.element_id)));
    const range = refs ? `valid range: 1-${maxRef(refs)}` : 'valid ids start at 1';
    return fail(thought, 'bad_element_id', `Selected element_id ${act.invalidElementId} does not exist on this page (${range}). Re-check the numbered element list and choose a real one.`);
  }

  // 7. Every id of a browser_batch (checked in sanitize.ts with the same rule as the id above).
  if (act.invalidStepElementId !== undefined) {
    return fail(thought, 'bad_step_element_id', elementListError(idForMessage(act.invalidStepElementId)));
  }

  return { thought, action: act, expectedOutcome: act.expected_outcome || act.expectedOutcome || null };
}

/**
 * Plan checklist texts from the Ollama plan reply, {steps: [{source, goal}]}.
 *
 * The grammar should already cap the array, but a server that fell back to format:"json"
 * does not, so the cap is applied here too. Plain string steps are accepted for the same
 * reason. Returns [] when nothing usable is there, and the caller falls back.
 */
export function planTextsFromStepsObject(resp: unknown): string[] {
  const parsed = parsePartialOrTruncatedJson(resp);
  const steps: unknown[] = parsed && !Array.isArray(parsed) && Array.isArray(parsed.steps) ? parsed.steps : [];
  return steps
    .map((step) => {
      if (typeof step === 'string') return step.trim();
      if (!step || typeof step !== 'object') return '';
      const { goal: rawGoal, source: rawSource } = step as { goal?: unknown; source?: unknown };
      const goal = String(rawGoal || '').trim();
      const source = String(rawSource || '').trim();
      // The source is shown only when it adds something: "idealo.de: Find the price" helps,
      // "current page: Read the price" or a goal that already names the site does not.
      if (!goal || !source || /^(the )?(current|this) (page|tab|site)$/i.test(source) || goal.toLowerCase().includes(source.toLowerCase())) {
        return goal;
      }
      return `${source}: ${goal}`;
    })
    .filter(Boolean)
    .slice(0, PLAN_MAX_STEPS);
}
