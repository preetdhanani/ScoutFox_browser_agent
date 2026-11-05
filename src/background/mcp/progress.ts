// src/background/mcp/progress.ts
// Repeat detection for the tool loop. Pure: no chrome APIs, no clock, so it is unit-tested alone.
//
// The harness owns the facts of a step (the Observation line, "Same picture", "Same text"); this
// module reads those facts and tells the loop two things:
//   - a short per-tool hint for a step that repeats an earlier step that changed nothing;
//   - when the run has made no progress for a while, one reflection note for the next request.
// It never narrows the tools, never touches plan approval and never asks the user. The step
// limit of the run stays the hard stop.

/** The start of every repeat hint: the tamper and the mock anchor on it. */
export const REPEAT_HINT_PREFIX = 'Hint (repeated step):';

/**
 * Task progress, apart from page change. Reading element 41, 42, 43 brings new text every time, so
 * the page-change record above never trips on it; a real run read 74 elements in a row that way
 * and never finished. A step moves the task when it saves new data, finishes a plan step, changes
 * the page, opens a page, reads a part of a page it had not read, or reads the web somewhere new.
 * STALL_AT steps in a row that do none of that are a stall: the first gets a note (STALL_TEXT), a
 * second one in a row ends the run with a finish-only round (STALL_END_TEXT).
 */
export const STALL_AT = 8;

/** The note after the first stall. The mock anchors on its start. */
export const STALL_TEXT = `You have taken ${STALL_AT} steps without new data or a finished plan step. Say in reason what you are looking for and whether the tools can show it. Then save what you have with save_data, mark finished plan steps with update_plan, take a different approach, or finish with outcome partial and say what is missing.`;

/** The note of the finish-only round after a second stall. */
export const STALL_END_TEXT = `STALLED: ${STALL_AT * 2} steps in a row brought no new data and finished no plan step. Call finish now with what you have (save nothing more), with outcome partial, and say what is missing and why.`;

/** The answer of a stalled run whose model did not call finish in its last round. */
export const STALL_FALLBACK_TEXT = `The run stopped: it made no progress for ${STALL_AT * 2} steps in a row.`;

/** How a step stands toward the task, as the client knows it (save_data, update_plan) or the tracker reads it. */
export interface StepContext {
  /** True when the call was refused because manual approval waits for a plan. */
  planFirst?: boolean;
  /** The tab's URL when the step ran, for "a part of this page not read before". */
  url?: string;
  /** The client measured task progress itself: save_data added records, update_plan finished a step. */
  taskProgress?: boolean;
  /** A re-read of a result the context compaction shortened: it neither counts nor resets. */
  neutral?: boolean;
}

/** The note the next request gets after too many steps that changed nothing. */
export const REFLECTION_TEXT = 'Your last steps changed nothing on the page: say what failed, then choose a different approach (another tool, keyboard, research) or finish with what you know and the exact next steps for the user.';

/** How many recent steps the reflection looks at, and the least distance between two reflections. */
export const REFLECTION_WINDOW = 6;
/** How many of those steps must have changed nothing. */
export const REFLECTION_THRESHOLD = 4;
/** How many identical no-progress actions make a repeat (the second one gets the hint). A read is no progress only when it repeats an earlier one, so its first no-progress run gets the hint. */
export const REPEAT_AT = 2;
/** The grid a coordinate is rounded to, so a click 5 px next to the last one is the same click. */
export const COORDINATE_GRID = 24;

/**
 * The tools that only read: the page, or the web outside the tab (web_search, fetch_url). A read
 * is progress when it brings new content, and no progress when the same call brings the same thing again.
 */
const READ_TOOLS = new Set(['read_page', 'get_page_elements', 'find', 'take_screenshot', 'web_search', 'fetch_url']);

/** The tools that never count: planning and finishing are not steps on the page. */
const NOT_COUNTED = new Set(['update_plan', 'save_data', 'finish']);

// The facts the server writes (server.ts). Matched as text so this module needs nothing from it.
const QUIET_OBSERVATION = /(^|\n)Observation: nothing in view changed/;
const DID_NOT_MOVE = /^Did not move:/;
const SAME_NOTE = /^(Same picture as your last screenshot\.|Same text as your last read\.)/m;

/** An element id as the server reads it: a whole number from 1 up, anything else is no id. */
function normalizedElementId(raw: unknown): number | undefined {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\s*\d+\s*$/.test(raw) ? Number(raw) : NaN;
  return Number.isInteger(n) && n >= 1 ? n : undefined;
}

function normalizedValue(key: string, value: unknown): unknown {
  if ((key === 'x' || key === 'y') && Number.isFinite(Number(value)) && value !== null && value !== '') {
    return Math.round(Number(value) / COORDINATE_GRID);
  }
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'string' ? v.trim().toLowerCase() : v));
  return value;
}

/**
 * The identity of a step: the tool plus its arguments, normalized. The reason is left out (the
 * model words it differently every time), coordinates are rounded to a 24 px grid, and an
 * element_id the model wrote for "no element" ("None", "", 0) is the same as none.
 */
export function stepKey(tool: string, args: Record<string, any> | null | undefined): string {
  const source = args && typeof args === 'object' ? args : {};
  const parts: string[] = [];
  for (const key of Object.keys(source).sort()) {
    if (key === 'reason') continue;
    if (key === 'element_id') {
      const id = normalizedElementId(source[key]);
      if (id !== undefined) parts.push(`element_id=${id}`);
      continue;
    }
    const value = normalizedValue(key, source[key]);
    if (value === undefined || value === null || value === '') continue;
    parts.push(`${key}=${JSON.stringify(value)}`);
  }
  return `${tool}(${parts.join(',')})`;
}

/** What one step did, as the tracker judges it. 'pending' is a wait whose effect the next read decides. */
type Verdict = 'progress' | 'none' | 'pending';

/** Whether an action's result says the page did not change. */
export function actionChangedNothing(tool: string, result: string): boolean {
  const text = String(result || '');
  if (tool === 'scroll' && DID_NOT_MOVE.test(text)) return true;
  return QUIET_OBSERVATION.test(text);
}

/** The per-tool hint for a repeated step that changed nothing. */
export function repeatHint(tool: string, times: number): string {
  const head = `${REPEAT_HINT_PREFIX} you ran this same ${tool} ${times} times and it changed nothing.`;
  switch (tool) {
    case 'click':
      return `${head} Do not click it again. If it is a code editor or text area: click inside it once, then press_key select_all, then type without element_id. Otherwise check the target with find or read_page, or use the keyboard (press_key).`;
    case 'scroll':
      return `${head} The page or panel did not move. Pass the element_id of the panel you want to move, or its x and y from a screenshot, or click inside the panel and press_key PageDown.`;
    case 'read_page':
    case 'get_page_elements':
    case 'find':
      return `${head} You got the same text again. Read another part with read_page {part}, read one element with element_id, or search the page with find.`;
    case 'web_search':
      return `${head} Search with other words, or read one of the results with fetch_url.`;
    case 'fetch_url':
      return `${head} You got the same text again. Read another part with part, look for lines with query, or fetch another address.`;
    case 'take_screenshot':
      return `${head} The picture did not change. Act on the page or read it instead of taking another screenshot.`;
    case 'type':
      return `${head} Click into the field first and type without element_id, or press_key select_all before you type.`;
    case 'wait':
      return `${head} Waiting did not change the page. Act on it, or finish with what you know.`;
    default:
      return `${head} Do not repeat it: choose another tool or another approach.`;
  }
}

/** What the loop does after a step: a hint for this step's result, and whether to reflect. */
export interface ProgressNote {
  hint: string | null;
  reflect: boolean;
  /** 0: no stall; 1: the first stall (send STALL_TEXT); 2: the second in a row (finish-only round). */
  stall: 0 | 1 | 2;
  /** Why, for the log. */
  noProgressInWindow: number;
  repeats: number;
}

interface StepEntry {
  tool: string;
  key: string;
  result: string;
  verdict: Verdict;
}

/**
 * The run-wide record of steps. One per task: update_plan and finish are not steps on the page,
 * and a PLAN_FIRST refusal never ran, so none of them enter the record (and none resets it).
 */
export class ProgressTracker {
  private steps: StepEntry[] = [];
  /** How many no-progress steps each key had. */
  private noProgressByKey = new Map<string, number>();
  /** The step count at the last reflection, or -Infinity before the first. */
  private lastReflectionAt = Number.NEGATIVE_INFINITY;
  /** Steps in a row that did not move the task. */
  private sinceProgress = 0;
  /** Stalls in a row without task progress between them. */
  private stalls = 0;
  /** The page parts read so far (url + part), and the web places read (query or url + part). */
  private readPlaces = new Set<string>();

  reset(): void {
    this.steps = [];
    this.noProgressByKey.clear();
    this.lastReflectionAt = Number.NEGATIVE_INFINITY;
    this.sinceProgress = 0;
    this.stalls = 0;
    this.readPlaces.clear();
  }

  /** Steps in a row that did not move the task (the run state shows it). */
  get stepsSinceProgress(): number {
    return this.sinceProgress;
  }

  /**
   * Whether a step moved the task: the client's own measure (taskProgress), a page change, a page
   * opened, or a read of somewhere not read before. An error never does.
   */
  private movedTask(tool: string, args: Record<string, any>, text: string, verdict: Verdict, ctx: StepContext): boolean {
    if (ctx.taskProgress) return true;
    // A plan mark or a save moves the task only when the client says it did: a mark of a step
    // already done, the same plan again, or records already saved do not.
    if (NOT_COUNTED.has(tool)) return false;
    if (/^Error:/.test(text) || /^Refused:/.test(text)) return false;
    if (tool === 'navigate' || tool === 'go_back' || tool === 'go_forward') return true;
    if (!READ_TOOLS.has(tool)) return tool !== 'wait' && verdict === 'progress';
    const place = (key: string) => {
      if (this.readPlaces.has(key)) return false;
      this.readPlaces.add(key);
      return true;
    };
    if (tool === 'read_page' && normalizedElementId(args.element_id) === undefined) {
      return place(`page ${ctx.url || ''} part ${Number(args.part) || 1}`);
    }
    if (tool === 'web_search') return place(`search ${normalizedValue('query', args.query)}`);
    if (tool === 'fetch_url') return place(`fetch ${String(args.url || '')} part ${Number(args.part) || 1} ${normalizedValue('query', args.query) || ''}`);
    return false;
  }

  /** Counts one step toward a stall, and says which stall (if any) it completes. */
  private stallOf(tool: string, args: Record<string, any>, text: string, verdict: Verdict, ctx: StepContext): 0 | 1 | 2 {
    if (ctx.neutral) return 0;
    if (this.movedTask(tool, args, text, verdict, ctx)) {
      this.sinceProgress = 0;
      this.stalls = 0;
      return 0;
    }
    this.sinceProgress += 1;
    if (this.sinceProgress < STALL_AT) return 0;
    this.sinceProgress = 0;
    this.stalls += 1;
    return this.stalls >= 2 ? 2 : 1;
  }

  /** How many steps the record holds (for tests and the log). */
  get count(): number {
    return this.steps.length;
  }

  /**
   * Records one step that ran, and says what the loop should add.
   *
   * @param planFirst true when the call was refused because manual approval waits for a plan
   */
  record(tool: string, args: Record<string, any> | null | undefined, result: string, ctx: StepContext = {}): ProgressNote {
    const nothing: ProgressNote = { hint: null, reflect: false, stall: 0, noProgressInWindow: this.noProgressInWindow(), repeats: 0 };
    if (ctx.planFirst) return nothing;
    // update_plan and save_data are no steps on the page, but a finished plan step or new data is
    // task progress, and a mark that finishes nothing counts toward a stall like any other step.
    if (NOT_COUNTED.has(tool)) {
      if (tool === 'finish') return nothing;
      return { ...nothing, stall: this.stallOf(tool, args || {}, String(result || ''), 'none', ctx) };
    }
    const key = stepKey(tool, args);
    const text = String(result || '');
    const verdict = this.verdictOf(tool, key, text);
    const stall = this.stallOf(tool, args || {}, text, verdict, ctx);

    // A wait before this step: it counts only when this step is a read that brought nothing new.
    const previous = this.steps[this.steps.length - 1];
    if (previous && previous.verdict === 'pending') {
      const unchangedRead = READ_TOOLS.has(tool) && verdict === 'none';
      previous.verdict = unchangedRead ? 'none' : 'progress';
      if (unchangedRead) this.bump(previous.key);
    }

    this.steps.push({ tool, key, result: text, verdict });
    let repeats = 0;
    if (verdict === 'none') repeats = this.bump(key);

    const inWindow = this.noProgressInWindow();
    // A read that brought nothing new (or an error that came again) is already the repeat of an
    // earlier call, so it counts that call too; an action is a repeat on its second quiet run.
    const byIdentity = READ_TOOLS.has(tool) || /^Error:/.test(text);
    const times = byIdentity ? repeats + 1 : repeats;
    const hint = verdict === 'none' && times >= REPEAT_AT ? repeatHint(tool, times) : null;
    const reflect = inWindow >= REFLECTION_THRESHOLD && this.steps.length - this.lastReflectionAt >= REFLECTION_WINDOW;
    if (reflect) this.lastReflectionAt = this.steps.length;
    return { hint, reflect, stall, noProgressInWindow: inWindow, repeats };
  }

  private bump(key: string): number {
    const n = (this.noProgressByKey.get(key) || 0) + 1;
    this.noProgressByKey.set(key, n);
    return n;
  }

  private noProgressInWindow(): number {
    return this.steps.slice(-REFLECTION_WINDOW).filter((s) => s.verdict === 'none').length;
  }

  private verdictOf(tool: string, key: string, text: string): Verdict {
    if (tool === 'wait') return 'pending';
    if (READ_TOOLS.has(tool)) {
      if (SAME_NOTE.test(text)) return 'none';
      // A read the server does not mark (the element list, find): the same call bringing the same text.
      const earlier = [...this.steps].reverse().find((s) => s.key === key);
      return earlier && earlier.result === text ? 'none' : 'progress';
    }
    if (actionChangedNothing(tool, text)) return 'none';
    // The same call failing with the same error again changed nothing either. A first error is
    // not held against the run: the model reads it and usually changes course.
    if (/^Error:/.test(text)) {
      const earlier = [...this.steps].reverse().find((s) => s.key === key);
      if (earlier && earlier.result === text) return 'none';
    }
    return 'progress';
  }
}
