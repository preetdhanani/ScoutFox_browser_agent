/**
 * agent/repairJson.ts
 *
 * Reads JSON out of model text, and repairs it when the model was cut off or sloppy:
 *   - parsePartialOrTruncatedJson() is the repair ladder: strict parse, raw newlines, unclosed
 *     strings and brackets, and a regex rescue for truncated execute_js, click and type payloads;
 *   - findTopLevelObjects() and balancedEnd() are the string-aware brace scanner that finds
 *     objects inside prose. They replace the non-greedy /\{[\s\S]*?\}/ regex that cut a nested
 *     browser_batch or filter object at its first closing brace.
 *
 * Pure functions with no engine state (the one import is the registry's alias lookup). Every loop
 * here is one pass over the text (the model output can be tens of thousands of characters, and a
 * degenerate reply repeats itself), so nothing backtracks over the whole input.
 */
import { resolveVerb } from './actions.ts';

const QUOTE = 34; // "
const BACKSLASH = 92; // \
const OPEN_BRACE = 123; // {
const CLOSE_BRACE = 125; // }
const OPEN_BRACKET = 91; // [
const CLOSE_BRACKET = 93; // ]

export interface ObjectSpan {
  /** Index of the opening brace. */
  start: number;
  /** Index after the closing brace, or the end of the text when the object is not closed. */
  end: number;
  /** False when the text ended before the closing brace (a truncated reply). */
  closed: boolean;
}

/**
 * Where the value that opens at `start` ends, string-aware: a brace or bracket inside a JSON string
 * does not count, and a backslash escapes the next character. Only the brackets of the value's own
 * kind are counted, so `open` and `close` are `{`/`}` or `[`/`]`.
 *
 * @param text  the text
 * @param start index of the opening character (must be `open`)
 * @returns the end (index after the closing character) and whether it was found. When the text ends
 *   first, `end` is the length of the text and `closed` is false.
 */
export function balancedEnd(text: string, start: number, open: '{' | '[', close: '}' | ']'): { end: number; closed: boolean } {
  const openCode = open.charCodeAt(0);
  const closeCode = close.charCodeAt(0);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === BACKSLASH) escaped = true;
      else if (ch === QUOTE) inString = false;
      continue;
    }
    if (ch === QUOTE) inString = true;
    else if (ch === openCode) depth++;
    else if (ch === closeCode) {
      depth--;
      if (depth === 0) return { end: i + 1, closed: true };
    }
  }
  return { end: text.length, closed: false };
}

const COLON = 58; // :

function isJsonSpace(ch: number): boolean {
  return ch === 32 || ch === 10 || ch === 13 || ch === 9;
}

/**
 * Whether the `{` at `start` can begin a JSON object: the first thing after it is a key and a colon
 * (`{"action":`), or a closing brace (`{}`). Text that stops before that can be told (a reply cut off
 * right after the brace, or inside the first key) also counts, because a truncated object must still
 * be found. A brace in the prose ("div.price { color...", `I see the text "{" on the page`,
 * "{go to ...", "{{") does not.
 *
 * Only the first key is read, and that is enough: a stray brace is followed by prose, and prose is
 * not a quoted key and a colon. The closing quote of that key comes no later than the opening quote
 * of the next `{"key"` (a quote right after a brace is never escaped), so the checks of one scan
 * together read the text about once.
 */
function canStartObject(text: string, start: number): boolean {
  const length = text.length;
  let i = start + 1;
  while (i < length && isJsonSpace(text.charCodeAt(i))) i++;
  if (i >= length) return true;
  const first = text.charCodeAt(i);
  if (first === CLOSE_BRACE) return true;
  if (first !== QUOTE) return false;
  for (i++; i < length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === BACKSLASH) i++;
    else if (ch === QUOTE) break;
  }
  if (i >= length) return true;
  i++;
  while (i < length && isJsonSpace(text.charCodeAt(i))) i++;
  return i >= length || text.charCodeAt(i) === COLON;
}

/**
 * Every top-level `{ ... }` object in the text, in order. Quotes outside an object are prose and
 * are not tracked ("He said "hi" and left {"action": ...}" finds the object), and an object that is
 * still open when the text ends is returned as the last span with closed:false so the repair ladder
 * can try it. Objects nested inside another object are part of that object, never listed alone.
 *
 * A brace that can not begin an object (see canStartObject) is skipped, and the scan goes on after
 * it. Without that, a stray brace in the prose swallowed the real object behind it: its quote
 * counting starts in the wrong place, so the object after it either never closed or closed at the
 * wrong brace, and the reply became a parse error, or fell through to a text intent.
 *
 * The scan does not start again inside an object that never closes, so it stays linear. (An object
 * that begins like JSON and never closes is a cut-off reply. What is inside it, such as the steps
 * of a browser_batch, belongs to it and is not an action of its own.)
 */
export function findTopLevelObjects(text: string): ObjectSpan[] {
  const spans: ObjectSpan[] = [];
  let from = 0;
  for (;;) {
    const start = text.indexOf('{', from);
    if (start < 0) break;
    if (!canStartObject(text, start)) {
      from = start + 1;
      continue;
    }
    const { end, closed } = balancedEnd(text, start, '{', '}');
    spans.push({ start, end, closed });
    if (!closed) break;
    from = end;
  }
  return spans;
}

/**
 * Closes what a truncated reply left open, counting only outside strings. A string that is still
 * open gets its closing quote (a dangling backslash is dropped first, or it would escape that
 * quote), then every open object and array is closed in the order it was opened.
 *
 * The old repair counted quotes with /(?<!\\)"/ and braces with a plain match, so a brace inside a
 * string ("code": "if (x) { ...") added a closing brace nobody had opened, and an escaped
 * backslash before a quote (\\") was read as an escaped quote.
 */
function closeOpenStructures(text: string): string {
  const stack: number[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === BACKSLASH) escaped = true;
      else if (ch === QUOTE) inString = false;
      continue;
    }
    if (ch === QUOTE) inString = true;
    else if (ch === OPEN_BRACE || ch === OPEN_BRACKET) stack.push(ch);
    else if (ch === CLOSE_BRACE || ch === CLOSE_BRACKET) {
      const top = stack[stack.length - 1];
      if ((ch === CLOSE_BRACE && top === OPEN_BRACE) || (ch === CLOSE_BRACKET && top === OPEN_BRACKET)) stack.pop();
    }
  }
  let repaired = text;
  if (inString) {
    if (escaped) repaired = repaired.slice(0, -1);
    repaired += '"';
  }
  for (let i = stack.length - 1; i >= 0; i--) repaired += stack[i] === OPEN_BRACE ? '}' : ']';
  return repaired;
}

/**
 * The end of `"code": "<...` in a truncated execute_js payload: a closing quote, then an optional
 * bracket and brace, then nothing. Written as a backward walk (the regex /"\s*\}?\s*\]?\s*$/ it
 * replaces backtracks badly on a long run of whitespace).
 */
function stripCodeTail(code: string): string {
  let end = code.length;
  const skipSpace = () => { while (end > 0 && /\s/.test(code[end - 1])) end--; };
  skipSpace();
  if (code[end - 1] === ']') { end--; skipSpace(); }
  if (code[end - 1] === '}') { end--; skipSpace(); }
  if (code[end - 1] !== '"') return code;
  return code.slice(0, end - 1);
}

/**
 * Step 4 of the ladder on its own: a regex rescue for the payloads of a reply that was cut off.
 *   - execute_js: the code after "code": " up to where the text ends (a closing quote, bracket and
 *     brace at the very end are dropped), marked with world MAIN and a reason that says it was recovered;
 *   - click and type: the element id and the text, read as far as they are there.
 * Returns null for anything else. parse.ts uses this alone for an object that never closed (see
 * findJsonAction): of these only execute_js is safe to take, because a cut-off id or URL would point
 * at a different element or page.
 */
export function rescueTruncatedJson(trimmed: string): any {
  try {
    const actionMatch = trimmed.match(/"action"\s*:\s*"([^"]+)"/i);
    if (actionMatch) {
      // The verb the name stands for, through the registry's alias table (eval_js, run_js and
      // javascript are execute_js; click_element and press are click; type_text and input are type).
      const actName = resolveVerb(actionMatch[1]) ?? actionMatch[1];

      if (actName === 'execute_js') {
        const codeMatch = trimmed.match(/"code"\s*:\s*"([\s\S]*)/i);
        if (codeMatch) {
          let codeStr = stripCodeTail(codeMatch[1]).trim();
          codeStr = codeStr.replace(/\\"/g, '"').replace(/\\n/g, '\n');
          return {
            action: 'execute_js',
            code: codeStr,
            world: 'MAIN',
            reason: 'Recovered from truncated model output'
          };
        }
      }

      if (actName === 'click' || actName === 'type') {
        const idMatch = trimmed.match(/"element_id"\s*:\s*(\d+)/i) || trimmed.match(/"click"\s*:\s*(\d+)/i);
        const textMatch = trimmed.match(/"text"\s*:\s*"([^"]+)"/i);
        return {
          action: actName,
          element_id: idMatch ? parseInt(idMatch[1], 10) : undefined,
          text: textMatch ? textMatch[1] : undefined,
          reason: 'Recovered from truncated model output'
        };
      }
    }
  } catch (_) {}

  return null;
}

/**
 * Robust Truncated & Partial JSON Repair Engine
 * Salvages unclosed strings, missing braces, or raw unescaped newlines in JSON action payloads.
 *
 * The ladder, each step only when the one before failed:
 *   1. a standard parse;
 *   2. raw newlines escaped;
 *   3. unclosed strings, arrays and objects closed (string-aware, see closeOpenStructures);
 *   4. a regex rescue for a truncated execute_js, click or type payload.
 * Returns null when nothing can be salvaged. The parsed value can be anything JSON holds, so a
 * caller that needs an object checks for one.
 */
export function parsePartialOrTruncatedJson(str: unknown): any {
  if (!str || typeof str !== 'string') return null;
  const trimmed = str.trim();

  // 1. Standard JSON parse
  try {
    return JSON.parse(trimmed);
  } catch (_) {}

  // 2. Fix unescaped control characters & raw newlines inside JSON string values
  try {
    const escapedNewlines = trimmed.replace(/[\r\n]+/g, '\\n');
    return JSON.parse(escapedNewlines);
  } catch (_) {}

  // 3. Balance unclosed string quotes and closing braces/brackets
  try {
    return JSON.parse(closeOpenStructures(trimmed.replace(/[\r\n]+/g, '\\n')));
  } catch (_) {}

  // 4. Regex extraction fallback for truncated execute_js / browser_batch payloads
  return rescueTruncatedJson(trimmed);
}
