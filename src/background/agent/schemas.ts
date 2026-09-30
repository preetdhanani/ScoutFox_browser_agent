/**
 * agent/schemas.ts
 *
 * Builds every JSON schema the agent uses from the action registry (shared/actions.json, read by
 * actions.ts), and validates a value against one:
 *   - buildActionSchema() gives the schema that is sent to Ollama as `format`, so its sampler can
 *     only produce a well-formed action (constrained decoding);
 *   - buildPlanSchema() gives the plan object;
 *   - validateAgainst() checks a value against a schema with @cfworker/json-schema, which
 *     interprets schemas and never uses eval or new Function (the worker's CSP forbids both).
 * A policy mode is a list of verbs (verbsFor in actions.ts), so its schema is
 * buildActionSchema(verbs). Cloud providers get no schema on the wire: they keep the legacy
 * prompt and free-text replies (see buildSystemPrompt in agentEngine.js).
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
import { Validator } from '@cfworker/json-schema';

import { ACTION_VERBS, REGISTRY, verbDef } from './actions.ts';
import type { JsonSchema, VerbDef } from './actions.ts';

// Wide on purpose (see above). It still stops a runaway string of digits.
export const ELEMENT_ID_MAX: number = REGISTRY.$defs.elementId.maximum;

// A full http(s) URL: every printable character except space, the quote and the backslash
// (which would break the JSON string), plus non-ASCII letters so that "zubehör" stays as it
// is. Without the pattern a small model sometimes writes a bare "www.idealo.de", which the
// page then opens as a path relative to the current site.
export const HTTP_URL_PATTERN: string = REGISTRY.$defs.httpUrl.pattern;

// Keys the content script can send (actionExecutor.js dispatches the key name as given).
export const PRESS_KEYS: string[] = verbDef('press_key').schema.properties.key.enum;

// browser_batch runs in the content script, which refuses more than 8 steps and every verb
// that leaves the page or ends the task.
export const BATCH_MAX_STEPS: number = REGISTRY.batch.maxSteps;
export const BATCH_STEP_VERBS: string[] = REGISTRY.batch.stepVerbs;

// How a browser_batch step is described to the grammar:
//   'oneOf' - each step is one of the step verbs' own branches, with their required fields;
//   'flat'  - one object with an action enum and every step field optional.
// oneOf, because the P0a eval (tests/evals/ollamaNodes.mjs) found Ollama 0.34.4 does enforce a
// oneOf nested inside array items: 24/24 valid on both models, and type steps kept their text
// even when the prompt pushed against it. With the flat object, gemma4:12b dropped the text of
// type steps in 6/6 such runs, and qwen3.5:9b put element_id on a wait step.
export type BatchStepStyle = 'oneOf' | 'flat';
export const BATCH_STEP_STYLE: BatchStepStyle = 'oneOf';

export const PLAN_MAX_STEPS = 6;

export interface ActionSchemaOptions {
  /** Allow an optional "reason" string in every branch (default true). */
  withReason?: boolean;
  /** How browser_batch steps are described (default BATCH_STEP_STYLE). */
  batchSteps?: BatchStepStyle;
}

interface BranchOptions {
  withReason: boolean;
  batchSteps: BatchStepStyle;
}

const DEFS_PREFIX = '#/$defs/';

/**
 * A copy of a registry schema fragment with its markers resolved: {"$ref": "#/$defs/name"} becomes
 * that entry of $defs, and {"$batchSteps": true} becomes the browser_batch steps array. The copy
 * means a caller that changes a built schema can never change the registry.
 */
function expand(node: any, options: BranchOptions): any {
  if (Array.isArray(node)) return node.map((item) => expand(item, options));
  if (node === null || typeof node !== 'object') return node;
  if ('$ref' in node) {
    const ref = String(node.$ref);
    const def = ref.startsWith(DEFS_PREFIX) ? REGISTRY.$defs[ref.slice(DEFS_PREFIX.length)] : undefined;
    if (!def) throw new Error(`Unknown registry definition "${ref}".`);
    return expand(def, options);
  }
  if ('$batchSteps' in node) return buildBatchStepsSchema(options.batchSteps);
  return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, expand(value, options)]));
}

/** The schema branch of one verb. */
function branchFor(def: VerbDef, options: BranchOptions): JsonSchema {
  const properties: Record<string, JsonSchema> = { action: { const: def.name } };
  for (const [field, schema] of Object.entries(def.schema.properties)) {
    properties[field] = expand(schema, options);
  }
  if (options.withReason) properties.reason = { type: 'string' };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['action', ...def.schema.required],
    properties
  };
}

/**
 * The `steps` array of browser_batch, built from the step verbs' own definitions so a step can
 * never drift from the top-level action it stands for.
 */
export function buildBatchStepsSchema(style: BatchStepStyle = BATCH_STEP_STYLE): JsonSchema {
  const defs = BATCH_STEP_VERBS.map(verbDef);
  let items: JsonSchema;
  if (style === 'oneOf') {
    items = { oneOf: defs.map((d) => branchFor(d, { withReason: false, batchSteps: style })) };
  } else if (style === 'flat') {
    const properties: Record<string, JsonSchema> = { action: { enum: [...BATCH_STEP_VERBS] } };
    for (const d of defs) {
      for (const [field, schema] of Object.entries(d.schema.properties)) {
        properties[field] = expand(schema, { withReason: false, batchSteps: style });
      }
    }
    items = { type: 'object', additionalProperties: false, required: ['action'], properties };
  } else {
    throw new Error(`Unknown browser_batch step style "${style}". Use "oneOf" or "flat".`);
  }
  return { type: 'array', minItems: 1, maxItems: BATCH_MAX_STEPS, items };
}

/**
 * The decoding schema for a set of verbs: a oneOf union with one branch per verb.
 *
 * @param verbs defaults to every verb in the registry
 */
export function buildActionSchema(verbs: string[] = ACTION_VERBS, options: ActionSchemaOptions = {}): JsonSchema {
  const withReason = options.withReason !== false;
  const batchSteps = options.batchSteps || BATCH_STEP_STYLE;
  if (!Array.isArray(verbs) || verbs.length === 0) throw new Error('buildActionSchema needs at least one verb.');
  return { oneOf: verbs.map((v) => branchFor(verbDef(v), { withReason, batchSteps })) };
}

/**
 * The plan schema for Ollama: {steps: [{source, goal}]}. The array has an upper bound because
 * a long plan is a worse plan; the engine also caps it in code, so it never relies on the
 * grammar alone.
 */
export function buildPlanSchema({ maxSteps = PLAN_MAX_STEPS }: { maxSteps?: number } = {}): JsonSchema {
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
          properties: { source: { type: 'string' }, goal: { type: 'string' } }
        }
      }
    }
  };
}

export interface ValidationResult {
  ok: boolean;
  /** One line per problem, "<where in the value>: <what is wrong>". Empty when ok. */
  errors: string[];
}

/**
 * Checks a value against a JSON schema. `oneOf` needs exactly one matching branch, so a value
 * that fits none of a union's branches reports the problems of every branch: to explain a bad
 * action to a model, validate it against the schema of the branch its "action" names.
 *
 * The value is checked as JSON, the way it would be on the wire: a property that is undefined
 * counts as absent (the validator itself throws on undefined), and a value that has no JSON form
 * at all (undefined, a function) is not ok.
 */
export function validateAgainst(schema: JsonSchema, value: unknown): ValidationResult {
  const json = JSON.stringify(value);
  if (json === undefined) return { ok: false, errors: [`#: ${typeof value} is not a JSON value.`] };
  const result = new Validator(schema, '2019-09', false).validate(JSON.parse(json));
  const errors = result.errors.map((e) => `${e.instanceLocation}: ${e.error}`);
  return { ok: result.valid, errors: [...new Set(errors)] };
}
