/**
 * agent/sanitize.ts
 *
 * Action Schema Normalizer & Element ID Validator, as pure functions: the engine hands in the verbs
 * this reply may use and the ids that are on the page, and gets the normalised action back.
 *
 *   - the {"click": N} and {"type": ...} shapes become {action, element_id};
 *   - an action name becomes its verb (the aliases are the `aliases` of shared/actions.json);
 *   - element_id is also read from element, id, elementId and ref;
 *   - an id that is not on the page is REJECTED, never clamped or coerced onto another element;
 *   - the same check runs on every step of a browser_batch.
 *
 * A problem is not thrown. It is left on the returned object as a flag (invalidAction,
 * unavailableAction, invalidElementId, invalidStepElementId) and parse.ts turns it into the parse
 * error the model gets to see.
 */
import { resolveVerb } from './actions.ts';

/**
 * The ids of the elements that are on the page right now. The old engine renumbers from 1 on every
 * snapshot, so it passes 1..elementCount (see refsFromCount). Later phases pass the ids of the page
 * snapshot, which are stable and not contiguous.
 */
export type PageRefs = ReadonlySet<number>;

/** 1..count, the ids of a page whose elements are numbered from 1 (the current snapshot). */
export function refsFromCount(count: number): PageRefs {
  const ids = new Set<number>();
  for (let id = 1; id <= count; id++) ids.add(id);
  return ids;
}

export type LogLevel = 'info' | 'warn';
/** Where a rejection is reported (the engine passes its Logger). Optional, so the functions stay pure. */
export type LogSink = (level: LogLevel, message: string) => void;

export interface SanitizeOptions {
  /** The verbs this reply may use (the policy mode's verbs). */
  verbs: readonly string[];
  /**
   * The ids on the page. Leave it out when the list is not known: an id then only has to be a whole
   * number of 1 or more (this is what a page with no counted elements gets).
   */
  refs?: PageRefs;
  log?: LogSink;
}

/** What a model replied, as an object. Only `action` is looked at by the parser, the rest is the verb's own fields. */
export type ActionObject = Record<string, unknown>;

/** An action after sanitising. A flag is set, and the action is not usable, when something was rejected. */
export type SanitizedAction = ActionObject & {
  /** The name is neither a verb nor an alias (also set, with the value undefined, when there is no action at all). */
  invalidAction?: unknown;
  /** A verb of the registry that the current mode does not offer. */
  unavailableAction?: string;
  /** JSON of the element_id of the action, when it is not on the page. */
  invalidElementId?: string;
  /** The element id of a browser_batch step, as the model wrote it, when it is not on the page. */
  invalidStepElementId?: unknown;
};

export type ElementIdCheck = { ok: true; id: number } | { ok: false };

/** The whole number an id is written as: a number without a fraction, or a string of digits. Anything else ("3.9", "12abc", "1e3", "[5]") is not an id. */
function wholeNumber(raw: unknown): number | undefined {
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\s*\d+\s*$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(value) ? value : undefined;
}

/**
 * The one element id check, for a single action and for every browser_batch step. The id is a whole
 * number of 1 or more that is on the page ("4" and 4 are the same id). Never clamped, and never read
 * loosely: "12abc" is not 12 and 3.9 is not 3, because an id that is not on the page is rejected, and
 * reading it as another real id would redirect a click onto a different element with no visible failure.
 */
export function checkElementId(raw: unknown, refs?: PageRefs): ElementIdCheck {
  const id = wholeNumber(raw);
  if (id === undefined || id < 1) return { ok: false };
  if (refs && !refs.has(id)) return { ok: false };
  return { ok: true, id };
}

/** The largest id of a page (for the "valid range" text), 0 when the list is not known or empty. */
export function maxRef(refs?: PageRefs): number {
  let max = 0;
  if (refs) for (const id of refs) if (id > max) max = id;
  return max;
}

// The fields the content script's browser_batch reads a step's target from (actionExecutor.js
// doBrowserBatch), in that order. `click` is the {"click": N} step shape.
const STEP_ID_FIELDS = ['element_id', 'index', 'elementId', 'element'] as const;

function isPlainObject(value: unknown): value is ActionObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Checks the element id of every step of a browser_batch. Returns the steps with each id replaced
 * by its parsed number, or the first id that is not on the page.
 */
function checkBatchSteps(steps: unknown[], refs?: PageRefs): { steps: unknown[] } | { bad: unknown } {
  const checked: unknown[] = [];
  for (const step of steps) {
    if (!isPlainObject(step)) {
      checked.push(step);
      continue;
    }
    const field = STEP_ID_FIELDS.find((name) => step[name] !== undefined);
    const raw = field !== undefined
      ? step[field]
      : step.action === undefined && step.click !== undefined ? step.click : undefined;
    if (raw === undefined) {
      checked.push(step);
      continue;
    }
    const check = checkElementId(raw, refs);
    if (!check.ok) return { bad: raw };
    checked.push(field !== undefined ? { ...step, [field]: check.id } : step);
  }
  return { steps: checked };
}

/**
 * Normalises one action object. The input is not changed.
 *
 * A name that is neither a verb nor an alias stays as it is and is flagged invalidAction. A verb of
 * the registry that `options.verbs` does not offer is flagged unavailableAction. An element id (or a
 * browser_batch step id) that is not in `options.refs` is flagged too, and never replaced by another.
 */
export function sanitizeAction(actionObj: ActionObject, options: SanitizeOptions): SanitizedAction {
  const { verbs, refs, log } = options;
  const act: SanitizedAction = { ...actionObj };

  if (act.click !== undefined && !act.action) { act.action = 'click'; act.element_id = act.click; }
  if (act.type !== undefined && !act.action) { act.action = 'type'; }
  // The alias table (click_element -> click, done -> finish, ...) is the `aliases` of each verb in
  // shared/actions.json. A name that is neither a verb nor an alias stays as it is and is
  // rejected below.
  const verb = resolveVerb(act.action);
  if (verb !== undefined) act.action = verb;

  // After alias normalization, anything still not a real verb is a hallucination the executor
  // would only catch one layer later (actionExecutor.js's default `throw new Error('Unknown
  // action')`) after this action had already been pushed to history. invalidAction is read by
  // parse.ts (the caller), which turns it into a correctable parse error instead.
  if (verb === undefined) {
    log?.('warn', `[GUARDRAIL_REJECTED] Model requested an unrecognised action "${act.action}".`);
    act.invalidAction = act.action;
  } else if (!verbs.includes(verb)) {
    // A real verb that this mode does not offer, for example execute_js for a small model.
    log?.('warn', `[GUARDRAIL_REJECTED] Model requested the action "${verb}", which is not available here.`);
    act.unavailableAction = verb;
  }

  if (act.element_id === undefined) {
    if (act.element !== undefined) act.element_id = act.element;
    else if (act.id !== undefined) act.element_id = act.id;
    else if (act.elementId !== undefined) act.element_id = act.elementId;
    else if (act.ref !== undefined) act.element_id = act.ref;
  }

  // Parsed unconditionally, NOT only when the value already happens to be a number. Gating
  // on `typeof === 'number'` let a string element_id through untouched, and page content is
  // attacker-controlled input to the model, so a prompt-injected reply could put arbitrary
  // markup in this field.
  //
  // A non-numeric or off-page id is REJECTED, not clamped/coerced. Clamping to the last id or
  // coercing to 1 used to silently redirect the action onto a different, REAL element the model
  // never chose - a hallucinated click landed somewhere else on the page with no visible
  // failure. invalidElementId is read by parse.ts (the caller), which turns it into a correctable
  // parse error instead of returning this action at all.
  if (act.element_id !== undefined) {
    const check = checkElementId(act.element_id, refs);
    if (!check.ok) {
      const range = refs ? `1-${maxRef(refs)}` : 'a whole number of 1 or more';
      log?.('warn', `[GUARDRAIL_REJECTED] Model selected an invalid element_id (${JSON.stringify(act.element_id)}, valid range ${range}). Rejecting instead of guessing a different element.`);
      act.invalidElementId = JSON.stringify(act.element_id);
    } else {
      act.element_id = check.id;
    }
  }

  // Every step of a batch is checked the same way, before anything runs: the content script would
  // run the steps in order, so a bad id in step 3 would fail only after steps 1 and 2 had acted.
  if (act.action === 'browser_batch' && Array.isArray(act.steps)) {
    const checked = checkBatchSteps(act.steps, refs);
    if ('bad' in checked) {
      log?.('warn', `[GUARDRAIL_REJECTED] A browser_batch step selected an element id that is not on the page (${JSON.stringify(checked.bad)}). Rejecting the whole batch.`);
      act.invalidStepElementId = checked.bad;
    } else {
      act.steps = checked.steps;
    }
  }

  return act;
}
