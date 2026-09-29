/**
 * Action schema registry for ScoutFox.
 *
 * One definition per action verb the engine can dispatch (KNOWN_ACTIONS in agentEngine.js - a
 * test keeps the two lists equal). Everything the model is told or constrained to comes from
 * here, so the prompt and the schema cannot drift apart:
 *   - buildActionSchema() gives the JSON schema that is sent to Ollama as `format`, so its
 *     sampler can only produce a well-formed action (constrained decoding);
 *   - buildActionPromptLines() gives the one-line-per-action list of the compact Ollama prompt.
 * A later node can offer fewer actions with buildActionSchema(subset) and
 * buildActionPromptLines(subset). Cloud providers use neither: they keep the legacy prompt and
 * free-text replies (see buildSystemPrompt in agentEngine.js).
 *
 * The rules below were measured against qwen3.5:9b and gemma4:12b on Ollama 0.34.4
 * (docs/spikes/ollama-constrained and tests/evals/ollamaNodes.mjs):
 *   - One oneOf branch per verb, with a const "action", its own required fields and
 *     additionalProperties:false. A flat "action enum plus optional fields" schema made the
 *     models drop fields they needed (navigate lost its url in 12 of 12 runs).
 *   - Element ids are integers with a wide bound. Never an enum, and never bounded by the
 *     current element count: the grammar then quietly turns a wrong id into a real one (asked
 *     for 99 with maximum 15, both models wrote 9). With the wide bound the wrong id gets
 *     through, and the engine rejects it with an error the model can correct.
 *   - No maxLength, because the grammar cuts the text in the middle of a word.
 *   - URL patterns use only explicit character ranges. Ollama reads "." as any character,
 *     including the closing quote, so the string ran on and swallowed the rest of the reply;
 *     it also ignores negated classes like [^"].
 *   - No "thought" field: a required one cost 55-70 output tokens per step and did not make
 *     the actions better. "reason" is allowed in every branch but never required.
 * Ollama does not show the schema to the model, so the prompt still has to list the actions.
 */

// Wide on purpose (see above). It still stops a runaway string of digits.
export const ELEMENT_ID_MAX = 999999;

// A full http(s) URL: every printable character except space, the quote and the backslash
// (which would break the JSON string), plus non-ASCII letters so that "zubehör" stays as it
// is. Without the pattern a small model sometimes writes a bare "www.idealo.de", which the
// page then opens as a path relative to the current site.
export const HTTP_URL_PATTERN = '^https?://[!#-\\[\\]-~¡-퟿]+$';

// Keys the content script can send (actionExecutor.js dispatches the key name as given).
export const PRESS_KEYS = [
  'Enter', 'Escape', 'Tab', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight',
  'PageDown', 'PageUp', 'Home', 'End', 'Backspace', 'Delete'
];

// browser_batch runs in the content script, which refuses more than 8 steps and every verb
// that leaves the page or ends the task.
export const BATCH_MAX_STEPS = 8;
export const BATCH_STEP_VERBS = ['click', 'type', 'scroll', 'press_key', 'wait'];

// How a browser_batch step is described to the grammar:
//   'oneOf' - each step is one of the step verbs' own branches, with their required fields;
//   'flat'  - one object with an action enum and every step field optional.
// oneOf, because the P0a eval (tests/evals/ollamaNodes.mjs) found Ollama 0.34.4 does enforce a
// oneOf nested inside array items: 24/24 valid on both models, and type steps kept their text
// even when the prompt pushed against it. With the flat object, gemma4:12b dropped the text of
// type steps in 6/6 such runs, and qwen3.5:9b put element_id on a wait step.
export const BATCH_STEP_STYLE = 'oneOf';

export const PLAN_MAX_STEPS = 6;

const ELEMENT_ID = { type: 'integer', minimum: 1, maximum: ELEMENT_ID_MAX };
const HTTP_URL = { type: 'string', pattern: HTTP_URL_PATTERN };
const TEXT = { type: 'string' };
const BOOLEAN = { type: 'boolean' };

/**
 * name        - the verb, exactly as the engine dispatches it
 * required    - fields the model must always send (the models fill required fields well and
 *               drop optional ones, so a field the executor needs is required)
 * properties  - JSON schema of every field except "action" and "reason"
 * description - the one line the compact prompt shows after the field list
 */
const DEFINITIONS = [
  {
    name: 'click',
    required: ['element_id'],
    properties: { element_id: ELEMENT_ID },
    description: 'click element [element_id]'
  },
  {
    name: 'type',
    required: ['element_id', 'text', 'submit'],
    properties: { element_id: ELEMENT_ID, text: TEXT, submit: BOOLEAN },
    description: 'replace the text in field [element_id]; submit true presses Enter after typing'
  },
  {
    name: 'scroll',
    required: ['direction'],
    properties: { direction: { enum: ['down', 'up'] } },
    description: '"down" or "up"'
  },
  {
    name: 'press_key',
    required: ['key'],
    properties: { key: { enum: PRESS_KEYS } },
    description: `press one key: ${PRESS_KEYS.join(', ')}`
  },
  {
    name: 'navigate',
    required: ['url'],
    properties: { url: HTTP_URL },
    description: 'open a full https:// URL in this tab'
  },
  {
    name: 'go_back',
    required: [],
    properties: {},
    description: 'go back in the browser history'
  },
  {
    name: 'go_forward',
    required: [],
    properties: {},
    description: 'go forward in the browser history'
  },
  {
    name: 'read_page_text',
    required: [],
    properties: {},
    description: 'read more text of this page'
  },
  {
    name: 'execute_js',
    required: ['code'],
    properties: { code: TEXT },
    description: 'run JavaScript in the page and get the value it returns'
  },
  {
    name: 'read_network_requests',
    // Every field has a default in the engine (all requests, bodies included, the last 10).
    required: [],
    properties: {
      filter: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { enum: ['error', 'success', 'all'] },
          since: { enum: ['last_action'] },
          urlContains: TEXT
        }
      },
      includeBody: BOOLEAN,
      limit: { type: 'integer', minimum: 1, maximum: 50 }
    },
    description: 'see the recent network requests of this page; every field is optional'
  },
  {
    name: 'browser_batch',
    required: ['steps'],
    // A function is resolved when the schema is built: the steps are made from the step
    // verbs' own definitions (see buildBatchStepsSchema).
    properties: { steps: (options) => buildBatchStepsSchema(options.batchSteps), stopOnError: BOOLEAN },
    description: `run up to ${BATCH_MAX_STEPS} steps on this page in one reply; each step is a ${BATCH_STEP_VERBS.slice(0, -1).join(', ')} or ${BATCH_STEP_VERBS[BATCH_STEP_VERBS.length - 1]} action with its own fields`
  },
  {
    name: 'wait',
    // actionExecutor.js reads the seconds from `amount`.
    required: ['amount'],
    properties: { amount: { type: 'integer', minimum: 1, maximum: 5 } },
    description: 'wait 1 to 5 seconds, only while the page is still loading'
  },
  {
    name: 'finish',
    required: ['answer'],
    properties: { answer: TEXT },
    description: 'the task is done; answer is the full answer for the user'
  },
  {
    name: 'ask_user',
    required: ['question'],
    properties: { question: TEXT },
    description: 'ask the user, only if you cannot go on without them'
  },
  {
    name: 'open_window',
    required: ['url'],
    properties: { url: HTTP_URL },
    description: 'open a new browser window (rare; use navigate for a new page)'
  }
];

const BY_NAME = new Map(DEFINITIONS.map((d) => [d.name, d]));

/** Every verb in the registry, in prompt order. */
export const ACTION_VERBS = DEFINITIONS.map((d) => d.name);

function definitionOf(verb) {
  const def = BY_NAME.get(verb);
  if (!def) throw new Error(`Unknown action verb "${verb}". Known verbs: ${ACTION_VERBS.join(', ')}.`);
  return def;
}

/** The schema branch of one verb. */
function branchFor(def, options) {
  const properties = { action: { const: def.name } };
  for (const [field, schema] of Object.entries(def.properties)) {
    properties[field] = typeof schema === 'function' ? schema(options) : schema;
  }
  if (options.withReason) properties.reason = TEXT;
  return {
    type: 'object',
    additionalProperties: false,
    required: ['action', ...def.required],
    properties
  };
}

/**
 * The `steps` array of browser_batch, built from the step verbs' own definitions so a step can
 * never drift from the top-level action it stands for.
 *
 * @param {'oneOf'|'flat'} [style]
 */
export function buildBatchStepsSchema(style = BATCH_STEP_STYLE) {
  const defs = BATCH_STEP_VERBS.map(definitionOf);
  let items;
  if (style === 'oneOf') {
    items = { oneOf: defs.map((d) => branchFor(d, { withReason: false })) };
  } else if (style === 'flat') {
    const properties = { action: { enum: [...BATCH_STEP_VERBS] } };
    for (const d of defs) Object.assign(properties, d.properties);
    items = { type: 'object', additionalProperties: false, required: ['action'], properties };
  } else {
    throw new Error(`Unknown browser_batch step style "${style}". Use "oneOf" or "flat".`);
  }
  return { type: 'array', minItems: 1, maxItems: BATCH_MAX_STEPS, items };
}

/**
 * The decoding schema for a set of verbs: a oneOf union with one branch per verb.
 *
 * @param {string[]} [verbs] defaults to every verb in the registry
 * @param {{withReason?: boolean, batchSteps?: 'oneOf'|'flat'}} [options]
 *   withReason - allow an optional "reason" string in every branch (default true)
 *   batchSteps - how browser_batch steps are described (default BATCH_STEP_STYLE)
 */
export function buildActionSchema(verbs = ACTION_VERBS, options = {}) {
  const withReason = options.withReason !== false;
  const batchSteps = options.batchSteps || BATCH_STEP_STYLE;
  if (!Array.isArray(verbs) || verbs.length === 0) throw new Error('buildActionSchema needs at least one verb.');
  return { oneOf: verbs.map((v) => branchFor(definitionOf(v), { withReason, batchSteps })) };
}

/**
 * One prompt line per verb, for example "click {element_id} - click element [element_id]".
 *
 * @param {string[]} [verbs] defaults to every verb in the registry
 */
export function buildActionPromptLines(verbs = ACTION_VERBS) {
  return verbs.map((v) => {
    const def = definitionOf(v);
    return `${def.name} {${Object.keys(def.properties).join(', ')}} - ${def.description}`;
  });
}

/**
 * The plan schema for Ollama: {steps: [{source, goal}]}. The array has an upper bound because
 * a long plan is a worse plan; the engine also caps it in code, so it never relies on the
 * grammar alone.
 */
export function buildPlanSchema({ maxSteps = PLAN_MAX_STEPS } = {}) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['steps'],
    properties: {
      steps: {
        type: 'array',
        minItems: 1,
        maxItems: maxSteps,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['source', 'goal'],
          properties: { source: TEXT, goal: TEXT }
        }
      }
    }
  };
}
