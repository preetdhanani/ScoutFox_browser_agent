/**
 * agent/actions.ts
 *
 * The action registry as code. The data is shared/actions.json (one entry per verb the engine can
 * dispatch), read by this file with a JSON import and later by the Python runner. Everything the
 * model is told or constrained to comes from that one file, so the prompt lines, the decoding
 * schema, the alias table and the engine's KNOWN_ACTIONS cannot drift apart.
 *
 * This file only reads the registry: verb lookup, alias resolution, the verbs of a policy mode
 * and the prompt lines. schemas.ts builds the JSON schemas from it.
 */
import registryJson from '../../../shared/actions.json' with { type: 'json' };

export type Tier = 'small' | 'large';
export type PolicyMode = 'browse' | 'extract' | 'answer' | 'harvest';

/** A JSON schema fragment. The registry only needs plain data here, not a model of the draft. */
export type JsonSchema = Record<string, any>;

export interface VerbDef {
  name: string;
  /** 'page' verbs run on the page, 'state' verbs change the run. */
  category: 'page' | 'state';
  tiers: Tier[];
  modes: PolicyMode[];
  /** The exact line of the compact Ollama prompt, field list included. */
  prompt: string;
  /** Fields the model must always send, and every field with its schema (see schemas.ts). */
  schema: { required: string[]; properties: Record<string, JsonSchema> };
  aliases: string[];
}

export interface ActionRegistry {
  version: number;
  tiers: Tier[];
  modes: PolicyMode[];
  $defs: Record<string, JsonSchema>;
  batch: { maxSteps: number; stepVerbs: string[] };
  verbs: VerbDef[];
}

// A JSON import only has wide types (string, not 'page'), so the shape is asserted here and checked
// by tests/shared/actionsRegistry.test.ts.
export const REGISTRY = registryJson as unknown as ActionRegistry;

/** Every verb in the registry, in prompt order. */
export const ACTION_VERBS: string[] = REGISTRY.verbs.map((v) => v.name);

const BY_NAME = new Map(REGISTRY.verbs.map((v) => [v.name, v]));
const BY_ALIAS = new Map(REGISTRY.verbs.flatMap((v) => v.aliases.map((alias): [string, string] => [alias, v.name])));

/** The definition of one verb. Throws for a name that is not a verb (aliases are not resolved here). */
export function verbDef(verb: string): VerbDef {
  const def = BY_NAME.get(verb);
  if (!def) throw new Error(`Unknown action verb "${verb}". Known verbs: ${ACTION_VERBS.join(', ')}.`);
  return def;
}

/**
 * The verb a model's action name stands for: the name itself when it is a verb, the verb it is an
 * alias of, or undefined. Exact match only ("Click" and " click" are not resolved), and a name
 * that is not a string never resolves.
 */
export function resolveVerb(name: unknown): string | undefined {
  if (typeof name !== 'string') return undefined;
  return BY_NAME.has(name) ? name : BY_ALIAS.get(name);
}

/** The verbs a policy mode offers to a model tier, in registry order. */
export function verbsFor(mode: PolicyMode, tier: Tier): string[] {
  return REGISTRY.verbs.filter((v) => v.modes.includes(mode) && v.tiers.includes(tier)).map((v) => v.name);
}

/**
 * One prompt line per verb, for example "click {element_id} - click element [element_id]".
 *
 * @param verbs defaults to every verb in the registry
 */
export function buildActionPromptLines(verbs: string[] = ACTION_VERBS): string[] {
  return verbs.map((v) => verbDef(v).prompt);
}
