// src/background/llm/effort.ts
// How hard the model thinks: one effort level for the user, many request fields on the wire.
//
// The composer's effort (Auto, Off, Low, Medium, High, Max) is about the MODEL's reasoning only.
// The number of steps a run may take is a separate setting (Settings > maxSteps) and effort never
// touches it. Every provider spells reasoning differently, so this module answers two questions:
//
//   1. What can this provider + model take? (`effortSupportOf`, `resolveEffortSupport`)
//      In this order:
//        - a user-added custom endpoint takes nothing. Tarka does not guess parameters for a
//          server it does not know;
//        - a model that refused the fields at run time is not sent them again;
//        - what the endpoint itself reported wins over the built-in list: OpenRouter's
//          supported_parameters and reasoning.supported_efforts, Gemini's `thinking` flag,
//          Anthropic's capabilities, Ollama's capabilities and thinking.values, and the "expected
//          one of ..." list of a 400;
//        - the built-in list of provider + model families comes last;
//        - anything else takes nothing.
//   2. Which request fields is a level? (`effortPatch`, `ollamaThink`, `geminiThinkingConfig`)
//
// Values a dialect accepts differ per model (OpenAI: o3 has low..high, gpt-5 adds minimal,
// gpt-5.1 has none instead; Groq's gpt-oss has low..high and its Qwen has none..high). A level is
// therefore mapped onto the values the model accepts (`nativeValue`), and the panel offers only the
// levels that map to something different.
//
// Measured on NVIDIA NIM with nvidia/nemotron-3.5-super-vl-120b-a12b (2026-10-25): with no field the
// model thinks (536 reasoning tokens on a small sum); `reasoning_budget: 64` cut that to 63;
// `chat_template_kwargs.enable_thinking: false` cut it to 0; `reasoning_effort: "low"` and `"high"`
// made no measurable difference. So on Nemotron the budget is the dial. NIM answers 400
// "Unsupported parameter(s)" for a field it does not know and "unknown variant `x`, expected one of
// ..." for a value, which is what the run-time fallback in index.ts reads.

import { baseUrlOf, providerOf } from './settings.ts';
import { Logger } from '../../shared/logger.ts';
import type { LlmSettings } from './types.ts';

/** The level the user picks. 'auto' sends nothing (the model's own default); 'off' turns reasoning off where it can. */
export type EffortLevel = 'auto' | 'off' | 'low' | 'medium' | 'high' | 'max';

export const EFFORT_LEVELS: EffortLevel[] = ['auto', 'off', 'low', 'medium', 'high', 'max'];

/**
 * One request dialect for reasoning.
 *   openai              reasoning_effort: a value (OpenAI o-series and GPT-5; gpt-oss on NIM and Groq; Groq's Qwen)
 *   anthropic-budget    thinking: {type:'enabled', budget_tokens} (Claude 3.7 to 4.6)
 *   anthropic-adaptive  thinking: {type:'adaptive' | 'disabled'} + output_config.effort (Claude 4.7 and 5)
 *   gemini-budget       thinkingConfig.thinkingBudget (Gemini 2.5)
 *   gemini-level        thinkingConfig.thinkingLevel (Gemini 3 and later)
 *   ollama-bool         think: true | false
 *   ollama-level        think: a value from /api/show thinking.values (gpt-oss)
 *   nemotron            chat_template_kwargs.enable_thinking + reasoning_budget (NVIDIA NIM)
 *   openrouter          reasoning: {effort}
 *   none                nothing is sent
 */
export type EffortDialect =
  | 'openai' | 'anthropic-budget' | 'anthropic-adaptive' | 'gemini-budget' | 'gemini-level'
  | 'ollama-bool' | 'ollama-level' | 'nemotron' | 'openrouter' | 'none';

/** Where the answer came from: what the endpoint said, the built-in list, a refusal at run time, a custom endpoint, or nothing known. */
export type EffortSource = 'endpoint' | 'registry' | 'learned' | 'custom' | 'none';

export interface EffortSupport {
  dialect: EffortDialect;
  /** The levels the panel offers for this model, 'auto' always first. Only ['auto'] when the dialect is 'none'. */
  levels: EffortLevel[];
  /** The provider's own values the level is mapped onto, for the value dialects; absent for budget dialects. */
  values?: string[];
  source: EffortSource;
  /** One sentence for the panel's tooltip. */
  note: string;
}

/** A stored or requested value as a level. The old 'xhigh' is 'max'; anything unknown is 'auto'. */
export function normalizeEffort(raw: unknown): EffortLevel {
  const value = String(raw ?? '').trim().toLowerCase();
  if (value === 'xhigh') return 'max';
  return (EFFORT_LEVELS as string[]).includes(value) ? (value as EffortLevel) : 'auto';
}

/** The levels that think, weakest first. */
const THINKING_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'max'];

/**
 * The supported level nearest to the one asked for: Off on a model that cannot stop thinking is
 * Low, Max where High is the top is High. What is sent is always a level the panel offers.
 */
export function nearestSupportedLevel(level: EffortLevel, levels: EffortLevel[]): EffortLevel {
  if (levels.includes(level)) return level;
  // A level that thinks never becomes Off: only Off itself, or a model with nothing else, may.
  const thinking = levels.filter((l) => l !== 'auto' && (level === 'off' || l !== 'off'));
  if (level === 'auto' || thinking.length === 0) return 'auto';
  const order: EffortLevel[] = ['off', 'low', 'medium', 'high', 'max'];
  const want = order.indexOf(level);
  return thinking.reduce((best, l) => (Math.abs(order.indexOf(l) - want) < Math.abs(order.indexOf(best) - want) ? l : best), thinking[0]);
}

/** One level weaker, never below Low: Auto and Off stay what they are. Used for routine steps. */
export function oneLevelLower(level: EffortLevel): EffortLevel {
  const at = THINKING_LEVELS.indexOf(level);
  return at > 0 ? THINKING_LEVELS[at - 1] : level;
}

// ---------------------------------------------------------------------------------------------
// Provider values
// ---------------------------------------------------------------------------------------------

/** Every effort value a provider uses, weakest first. 'none' and 'minimal' are the "off" end. */
const VALUE_LADDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const OFF_VALUES = ['none', 'minimal'];

function rank(value: string): number {
  return VALUE_LADDER.indexOf(value.toLowerCase());
}

/** The known values, weakest first, without duplicates or values the ladder does not know. */
function cleanValues(values: unknown[]): string[] {
  const known = values.map((v) => String(v).toLowerCase()).filter((v) => rank(v) >= 0);
  return [...new Set(known)].sort((a, b) => rank(a) - rank(b));
}

/**
 * The provider value of a level, from the values the model accepts. null when the level has no
 * value there (Off on a model that cannot stop thinking).
 *   off   -> 'none', else 'minimal'
 *   low, medium, high -> the same value, else the nearest one that thinks
 *   max   -> the strongest value
 */
export function nativeValue(level: EffortLevel, values: string[]): string | null {
  if (level === 'auto' || values.length === 0) return null;
  if (level === 'off') return OFF_VALUES.find((v) => values.includes(v)) ?? null;
  const thinking = values.filter((v) => !OFF_VALUES.includes(v));
  if (thinking.length === 0) return null;
  if (level === 'max') return thinking[thinking.length - 1];
  if (thinking.includes(level)) return level;
  const want = rank(level);
  return thinking.reduce((best, v) => (Math.abs(rank(v) - want) < Math.abs(rank(best) - want) ? v : best), thinking[0]);
}

/** The levels that map to different values, in order: what the panel offers. */
function levelsFromValues(values: string[]): EffortLevel[] {
  const levels: EffortLevel[] = ['auto'];
  const seen = new Set<string>();
  for (const level of EFFORT_LEVELS.slice(1)) {
    const value = nativeValue(level, values);
    if (value === null || seen.has(value)) continue;
    seen.add(value);
    levels.push(level);
  }
  return levels;
}

// ---------------------------------------------------------------------------------------------
// What the endpoint reported, and what it refused
// ---------------------------------------------------------------------------------------------

/** What discovery learned about one model. `values` are the provider's own effort values, when it lists them. */
export interface DiscoveredReasoning {
  reasoning: boolean;
  dialect?: EffortDialect;
  values?: string[];
}

/** Discovery results, keyed by provider|baseUrl|model. */
const discovered = new Map<string, DiscoveredReasoning>();

/** provider|baseUrl|model keys whose provider refused the effort fields at run time. */
const refused = new Set<string>();

/** The cache key of one model. The same shape as the vision probe's. */
export function effortKey(settings: LlmSettings, model = settings.model || ''): string {
  return `${providerOf(settings)}|${baseUrlOf(settings) || 'default'}|${String(model).trim()}`;
}

/** Records what an endpoint reported for one model, and keeps it across worker restarts. */
export function rememberDiscovered(settings: LlmSettings, model: string, found: DiscoveredReasoning): void {
  discovered.set(effortKey(settings, model), { ...found, ...(found.values ? { values: cleanValues(found.values) } : {}) });
  scheduleSave();
}

// What discovery learned is kept in chrome.storage.local under this key, so a model list fetched
// once (it is cached for an hour and not fetched again) still tells a restarted worker what its
// models take. Only discovery is kept; a run-time refusal is cheap to learn again.
const STORAGE_KEY = 'effort_capabilities';
let loaded: Promise<void> | null = null;
let saveQueued = false;

function storageArea(): chrome.storage.LocalStorageArea | null {
  return typeof chrome !== 'undefined' && chrome.storage?.local ? chrome.storage.local : null;
}

/** Loads the kept discovery once per worker life. What was learned in this life wins over what was kept. */
export function loadDiscovered(): Promise<void> {
  if (loaded) return loaded;
  const area = storageArea();
  loaded = !area ? Promise.resolve() : new Promise<void>((resolve) => {
    try {
      area.get([STORAGE_KEY], (res: Record<string, any>) => {
        const kept = res?.[STORAGE_KEY];
        if (kept && typeof kept === 'object') {
          for (const [key, value] of Object.entries(kept)) {
            if (!discovered.has(key) && value && typeof (value as DiscoveredReasoning).reasoning === 'boolean') discovered.set(key, value as DiscoveredReasoning);
          }
        }
        resolve();
      });
    } catch {
      resolve();
    }
  });
  return loaded;
}

function scheduleSave(): void {
  const area = storageArea();
  if (!area || saveQueued) return;
  saveQueued = true;
  // One write per burst: a model list records hundreds of models in one loop.
  // The kept entries are loaded first: writing the map before that would overwrite what other
  // providers' models learned in an earlier worker life.
  void loadDiscovered().then(() => {
    saveQueued = false;
    try {
      area.set({ [STORAGE_KEY]: Object.fromEntries(discovered) });
    } catch {
      // Storage is a convenience here; the in-memory answer still holds.
    }
  });
}

/** Records that the provider refused the effort fields for this model: they are not sent to it again in this worker's life. */
export function rememberRefused(settings: LlmSettings): void {
  const key = effortKey(settings);
  if (refused.has(key)) return;
  refused.add(key);
  Logger.info('ApiClients', `[EFFORT] ${key} refused the reasoning fields; they are not sent to this model again.`);
}

/**
 * Learns the accepted values from a 400 that lists them ("unknown variant `zzz`, expected one of
 * `none`, `low`, ..."). True when it learned something new, so the round can be sent again with a
 * value the model accepts.
 */
export function learnValuesFromError(settings: LlmSettings, dialect: EffortDialect, text: string, sentValue: string): boolean {
  // Only a list that answers the value Tarka sent is about effort: an "expected one of" of
  // another field (tool_choice, a role) must not become the model's effort values.
  const variant = /unknown variant [`'"]([^`'"]+)[`'"]/i.exec(text || '')?.[1];
  if (!variant || variant.toLowerCase() !== String(sentValue).toLowerCase()) return false;
  const listed = /expected one of ([^\n"}]+)/i.exec(text || '');
  if (!listed) return false;
  const values = cleanValues([...listed[1].matchAll(/[`'"]([a-z_]+)[`'"]/gi)].map((m) => m[1]));
  if (values.length < 2) return false;
  const key = effortKey(settings);
  const before = discovered.get(key)?.values?.join(',');
  if (before === values.join(',')) return false;
  discovered.set(key, { reasoning: true, dialect, values });
  scheduleSave();
  Logger.info('ApiClients', `[EFFORT] ${key} accepts ${values.join(', ')}; using those from now on.`);
  return true;
}

/** Clears what was learned. Tests use it. */
export function clearEffortCache(): void {
  loaded = null;
  discovered.clear();
  refused.clear();
  ollamaAsked.clear();
}

// ---------------------------------------------------------------------------------------------
// The built-in list
// ---------------------------------------------------------------------------------------------

const GROQ_HOST = /(^|\.)groq\.com$/i;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** Claude 4.7 and every Claude 5 or later model: adaptive thinking with an effort. */
const CLAUDE_ADAPTIVE = /claude-(?:opus|sonnet|haiku|fable|mythos)-(?:4-[7-9]|[5-9])|claude-(?:fable|mythos)/;
/** Claude 3.7 Sonnet to 4.6: thinking with a token budget. */
const CLAUDE_BUDGET = /claude-3-7|claude-(?:opus|sonnet|haiku)-4/;

/** The dialect the built-in list gives a provider + model, or null when it knows nothing about it. */
export function registryDialect(provider: string, model: string, baseUrl = ''): EffortDialect | null {
  const m = model.toLowerCase();
  switch (provider) {
    case 'openai':
      // o1, o3, o4-mini, gpt-5 and later reason; gpt-4o and gpt-4.1 do not.
      return /(^|\/)(o\d|gpt-5|gpt-[6-9])/.test(m) ? 'openai' : null;
    case 'anthropic':
      if (CLAUDE_ADAPTIVE.test(m)) return 'anthropic-adaptive';
      return CLAUDE_BUDGET.test(m) ? 'anthropic-budget' : null;
    case 'gemini':
      if (/gemini-(?:[3-9])/.test(m)) return 'gemini-level';
      if (/gemini-2\.5/.test(m)) return 'gemini-budget';
      return null;
    case 'nvidia':
      if (/gpt-oss/.test(m)) return 'openai';
      if (/nemotron/.test(m)) return 'nemotron';
      return null;
    case 'openrouter':
      // OpenRouter maps one `reasoning` object onto every model; its model list says which can.
      return 'openrouter';
    case 'openai_compatible':
      // The built-in "OpenAI compatible" provider points at Groq by default. Any other host is a
      // server Tarka does not know, which is treated like a custom endpoint: nothing is sent.
      if (!GROQ_HOST.test(hostOf(baseUrl))) return null;
      return /gpt-oss|qwen/.test(m) ? 'openai' : null;
    case 'ollama':
      return /gpt-oss/.test(m) ? 'ollama-level' : null;
    default:
      return null;
  }
}

/** The values a value dialect accepts when the endpoint did not list them, from the model family. */
export function registryValues(provider: string, dialect: EffortDialect, model: string): string[] | undefined {
  const m = model.toLowerCase();
  switch (dialect) {
    case 'openai':
      if (/gpt-oss/.test(m)) return ['low', 'medium', 'high'];
      if (/qwen/.test(m)) return ['none', 'low', 'medium', 'high'];
      if (/(^|\/)o\d/.test(m)) return ['low', 'medium', 'high'];
      if (/gpt-5(?:-mini|-nano)?(?:-\d{4}|$)/.test(m)) return ['minimal', 'low', 'medium', 'high'];
      if (/gpt-5\.1/.test(m)) return ['none', 'low', 'medium', 'high'];
      // gpt-5.2 and later: none to xhigh. A model that refuses one learns its list from the 400.
      return ['none', 'low', 'medium', 'high', 'xhigh'];
    case 'anthropic-adaptive':
      return ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
    case 'openrouter':
      return ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
    case 'ollama-level':
      return ['low', 'medium', 'high'];
    case 'gemini-level':
      return ['low', 'medium', 'high'];
    default:
      return undefined;
  }
}

/** The value dialects map a level onto a list; the others take every level. */
function isValueDialect(dialect: EffortDialect): boolean {
  return dialect === 'openai' || dialect === 'anthropic-adaptive' || dialect === 'openrouter' || dialect === 'ollama-level' || dialect === 'gemini-level';
}

// ---------------------------------------------------------------------------------------------
// Support for the panel and the call
// ---------------------------------------------------------------------------------------------

const NOTE_REASONS = 'This model can reason. Effort sets how much it thinks before each step.';

function supportOf(dialect: EffortDialect, source: EffortSource, note: string, values: string[] | undefined, model: string): EffortSupport {
  if (dialect === 'none') return { dialect, levels: ['auto'], source, note };
  if (isValueDialect(dialect) && values?.length) {
    // Anthropic's "off" is thinking:{type:'disabled'}, not an effort value; it is always there.
    const withOff = dialect === 'anthropic-adaptive' && !values.includes('none') ? ['none', ...values] : values;
    return { dialect, levels: levelsFromValues(withOff), values: withOff, source, note };
  }
  // Ollama's boolean think has two states: Off, and Medium for "on". Offering Low to Max would
  // offer four levels that send the same request.
  if (dialect === 'ollama-bool') return { dialect, levels: ['auto', 'off', 'medium'], source, note: 'This model can only switch its thinking on (Medium) or off.' };
  // Gemini 2.5 Pro cannot stop thinking (its budget starts at 128).
  if (dialect === 'gemini-budget' && /2\.5-pro/i.test(model)) return { dialect, levels: ['auto', 'low', 'medium', 'high', 'max'], source, note };
  return { dialect, levels: [...EFFORT_LEVELS], source, note };
}

/**
 * What the configured model takes, from what is known right now (no network). The tool loop calls
 * `resolveEffortSupport`, which first asks Ollama when nothing is known yet.
 */
export function effortSupportOf(settings: LlmSettings): EffortSupport {
  const provider = providerOf(settings);
  const model = String(settings.model || '').trim();
  if (settings.customProviders?.[provider]) {
    return supportOf('none', 'custom', 'Effort is not sent to custom endpoints.', undefined, model);
  }
  if (!model) return supportOf('none', 'none', 'Pick a model first.', undefined, model);
  const key = effortKey(settings, model);
  if (refused.has(key)) {
    return supportOf('none', 'learned', 'This model refused the reasoning setting, so nothing is sent.', undefined, model);
  }
  const found = discovered.get(key);
  if (found && !found.reasoning) {
    return supportOf('none', 'endpoint', 'The provider reports that this model does not reason.', undefined, model);
  }
  const listed = registryDialect(provider, model, baseUrlOf(settings) || settings.providerConfigs?.[provider]?.baseUrl || '');
  if (found?.reasoning) {
    const dialect = found.dialect || listed || defaultDialectOf(provider);
    if (dialect !== 'none') {
      return supportOf(dialect, 'endpoint', NOTE_REASONS, found.values?.length ? found.values : registryValues(provider, dialect, model), model);
    }
  }
  if (listed) return supportOf(listed, 'registry', NOTE_REASONS, registryValues(provider, listed, model), model);
  return supportOf('none', 'none', 'This model has no reasoning setting that Tarka knows.', undefined, model);
}

/** The dialect of a provider whose endpoint said "reasons" but whose model the list does not name. */
function defaultDialectOf(provider: string): EffortDialect {
  switch (provider) {
    case 'ollama': return 'ollama-bool';
    case 'openrouter': return 'openrouter';
    case 'gemini': return 'gemini-budget';
    case 'anthropic': return 'anthropic-budget';
    default: return 'none';
  }
}

/** When each Ollama model was last asked without an answer: a failed question is asked again after a while, not on every call. */
const ollamaAsked = new Map<string, number>();
const OLLAMA_ASK_AGAIN_MS = 5 * 60 * 1000;
/** /api/show answers in milliseconds on a working server; a host that never answers must not hold the run. */
const OLLAMA_SHOW_TIMEOUT_MS = 5000;

/**
 * What the configured model takes, asking the endpoint first when it can tell and nothing is known
 * yet. Only Ollama is asked here (one /api/show per model); OpenRouter, Gemini and Anthropic report
 * it in the model list, which FETCH_MODELS downloads. A failed question changes nothing.
 */
export async function resolveEffortSupport(settings: LlmSettings, signal?: AbortSignal): Promise<EffortSupport> {
  await loadDiscovered();
  const provider = providerOf(settings);
  const model = String(settings.model || '').trim();
  if (provider === 'ollama' && model && !settings.customProviders?.[provider]) {
    const key = effortKey(settings, model);
    const askedAt = ollamaAsked.get(key);
    if (!discovered.has(key) && (askedAt === undefined || Date.now() - askedAt > OLLAMA_ASK_AGAIN_MS)) {
      ollamaAsked.set(key, Date.now());
      const found = await probeOllamaThinking(settings, model, signal);
      if (found) rememberDiscovered(settings, model, found);
    }
  }
  return effortSupportOf(settings);
}

/**
 * What Ollama's /api/show says: `capabilities` lists "thinking" for a model that can, and newer
 * servers add `thinking.values` (["low","medium","high"] for gpt-oss, [true,false] for a model
 * that only switches, [false] for one that cannot). null when the server says neither.
 */
export function readOllamaShow(data: any, model: string): DiscoveredReasoning | null {
  const values: unknown[] | undefined = Array.isArray(data?.thinking?.values) ? data.thinking.values : undefined;
  if (values) {
    const levels = values.filter((v) => typeof v === 'string') as string[];
    if (levels.length) return { reasoning: true, dialect: 'ollama-level', values: levels };
    return values.includes(true) ? { reasoning: true, dialect: 'ollama-bool' } : { reasoning: false };
  }
  if (!Array.isArray(data?.capabilities)) return null;
  if (!data.capabilities.includes('thinking')) return { reasoning: false };
  return { reasoning: true, dialect: /gpt-oss/i.test(model) ? 'ollama-level' : 'ollama-bool' };
}

async function probeOllamaThinking(settings: LlmSettings, model: string, signal?: AbortSignal): Promise<DiscoveredReasoning | null> {
  const baseUrl = (baseUrlOf(settings) || 'http://localhost:11434').replace(/\/+$/, '');
  const timeout = AbortSignal.timeout(OLLAMA_SHOW_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
      // The run's Pause and Stop cancel the question too.
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    });
    if (!res.ok) return null;
    return readOllamaShow(await res.json(), model);
  } catch {
    return null;
  }
}

/** Reads OpenRouter's /models entries: `supported_parameters` lists "reasoning", and `reasoning.supported_efforts` the values. */
export function rememberOpenRouterList(settings: LlmSettings, entries: any[]): void {
  for (const entry of entries || []) {
    if (typeof entry?.id !== 'string' || !Array.isArray(entry.supported_parameters)) continue;
    const reasoning = entry.supported_parameters.includes('reasoning');
    const efforts = Array.isArray(entry.reasoning?.supported_efforts) ? entry.reasoning.supported_efforts : undefined;
    rememberDiscovered(settings, entry.id, { reasoning, dialect: 'openrouter', ...(efforts?.length ? { values: efforts } : {}) });
  }
}

/** Reads Gemini's /v1beta/models entries: `thinking: true` marks a model that can. */
export function rememberGeminiList(settings: LlmSettings, entries: any[]): void {
  for (const entry of entries || []) {
    if (typeof entry?.name !== 'string' || typeof entry.thinking !== 'boolean') continue;
    const id = entry.name.replace(/^models\//, '');
    const dialect: EffortDialect = /gemini-(?:[3-9])/i.test(id) ? 'gemini-level' : 'gemini-budget';
    rememberDiscovered(settings, id, { reasoning: entry.thinking, dialect });
  }
}

/**
 * Reads Anthropic's /v1/models entries: `capabilities.thinking.supported`, the thinking types
 * (adaptive or enabled), and `capabilities.effort.<value>.supported`.
 */
export function rememberAnthropicList(settings: LlmSettings, entries: any[]): void {
  for (const entry of entries || []) {
    const caps = entry?.capabilities;
    if (typeof entry?.id !== 'string' || !caps?.thinking || typeof caps.thinking.supported !== 'boolean') continue;
    if (!caps.thinking.supported) {
      rememberDiscovered(settings, entry.id, { reasoning: false });
      continue;
    }
    const adaptive = caps.thinking.types?.adaptive?.supported === true;
    const efforts = Object.entries(caps.effort || {}).filter(([, v]: [string, any]) => v?.supported === true).map(([k]) => k);
    rememberDiscovered(settings, entry.id, adaptive
      ? { reasoning: true, dialect: 'anthropic-adaptive', ...(efforts.length ? { values: efforts } : {}) }
      : { reasoning: true, dialect: 'anthropic-budget' });
  }
}

// ---------------------------------------------------------------------------------------------
// The request fields
// ---------------------------------------------------------------------------------------------

/** Thinking-token budgets of the budget dialects (Anthropic before 4.7, Gemini 2.5, Nemotron). */
export const EFFORT_BUDGET: Record<'low' | 'medium' | 'high' | 'max', number> = {
  low: 1024,
  medium: 4096,
  high: 12000,
  max: 24000
};

/** Room for the answer and the tool call, on top of a thinking budget. */
const ANSWER_ROOM = 8192;

/**
 * The highest token limit a level asks for. Claude Opus 4 and 4.1 refuse a max_tokens above
 * 32000, and a budget must stay below max_tokens, so Max is budget 24000 inside a 32000 limit.
 */
const MAX_TOKENS_CAP = 32000;

function roomFor(budget: number): number {
  return Math.min(budget + ANSWER_ROOM, MAX_TOKENS_CAP);
}

/** What a level changes in an OpenAI-shaped chat/completions body. */
export interface EffortPatch {
  /** Fields to set (deep fields are whole objects, e.g. chat_template_kwargs). */
  set: Record<string, unknown>;
  /** Fields to take out of the base body (e.g. temperature, which reasoning models refuse). */
  remove: string[];
  /** When set, the token limit is raised to at least this. */
  minMaxTokens?: number;
  /** The token field the body must use instead of max_tokens. */
  maxTokensField?: 'max_completion_tokens';
}

const NO_PATCH: EffortPatch = { set: {}, remove: [] };

/** The fields every patch may set, for the run-time fallback that strips them after a refusal. */
export const EFFORT_FIELDS = ['reasoning_effort', 'reasoning_budget', 'chat_template_kwargs', 'thinking', 'output_config', 'reasoning'];

function budgetOf(level: EffortLevel): number {
  return level === 'off' || level === 'auto' ? 0 : EFFORT_BUDGET[level];
}

/**
 * The OpenAI-shaped request fields of one level in one dialect. 'auto', 'none' and a level the
 * model has no value for change nothing. `values` are the model's accepted values (value dialects).
 */
export function effortPatch(dialect: EffortDialect, level: EffortLevel, values: string[] = []): EffortPatch {
  if (level === 'auto' || dialect === 'none') return NO_PATCH;
  const thinking = level !== 'off';
  const budget = budgetOf(level);
  switch (dialect) {
    case 'openai': {
      const value = nativeValue(level, values);
      if (!value) return NO_PATCH;
      // OpenAI's reasoning models refuse a temperature and take max_completion_tokens; gpt-oss and
      // Groq's Qwen take both, so only the OpenAI provider gets the switch (index.ts decides).
      return { set: { reasoning_effort: value }, remove: [] };
    }
    case 'anthropic-budget':
      // Extended thinking does not take a temperature, and max_tokens must be above the budget.
      return thinking
        ? { set: { thinking: { type: 'enabled', budget_tokens: budget } }, remove: ['temperature'], minMaxTokens: roomFor(budget) }
        : NO_PATCH;
    case 'anthropic-adaptive': {
      // Claude 4.7 and later refuse a temperature below 1 and a budget; they think adaptively, and
      // output_config.effort says how much.
      if (!thinking) return { set: { thinking: { type: 'disabled' } }, remove: ['temperature'] };
      const value = nativeValue(level, values.filter((v) => v !== 'none'));
      return { set: { thinking: { type: 'adaptive' }, ...(value ? { output_config: { effort: value } } : {}) }, remove: ['temperature'], minMaxTokens: roomFor(budget) };
    }
    case 'nemotron':
      return thinking
        ? { set: { chat_template_kwargs: { enable_thinking: true }, reasoning_budget: budget }, remove: [], minMaxTokens: roomFor(budget) }
        : { set: { chat_template_kwargs: { enable_thinking: false } }, remove: [] };
    case 'openrouter': {
      const value = nativeValue(level, values);
      if (!value) return NO_PATCH;
      return { set: { reasoning: { effort: value } }, remove: [], ...(thinking ? { minMaxTokens: roomFor(budget) } : {}) };
    }
    default:
      return NO_PATCH;
  }
}

/** OpenAI's own reasoning models: no temperature, and max_completion_tokens instead of max_tokens. */
export function openaiReasoningBody(patch: EffortPatch): EffortPatch {
  if (!('reasoning_effort' in patch.set)) return patch;
  return { ...patch, remove: [...patch.remove, 'temperature'], maxTokensField: 'max_completion_tokens' };
}

/** Ollama's `think` field for one level, or undefined when nothing is sent. */
export function ollamaThink(dialect: EffortDialect, level: EffortLevel, values: string[] = []): boolean | string | undefined {
  if (level === 'auto') return undefined;
  if (dialect === 'ollama-bool') return level !== 'off';
  if (dialect === 'ollama-level') {
    // gpt-oss cannot turn its reasoning off; Off is not offered and is sent as its lowest value.
    const value = nativeValue(level === 'off' ? 'low' : level, values.length ? values : ['low', 'medium', 'high']);
    return value ?? undefined;
  }
  return undefined;
}

/** Gemini's thinkingConfig for one level, or undefined when nothing is sent. */
export function geminiThinkingConfig(dialect: EffortDialect, level: EffortLevel, values: string[] = []): { thinkingBudget?: number; thinkingLevel?: 'LOW' | 'MEDIUM' | 'HIGH' } | undefined {
  if (level === 'auto') return undefined;
  if (dialect === 'gemini-budget') {
    // 0 turns thinking off where the model allows it (Flash); Pro's lowest budget is 128.
    return { thinkingBudget: level === 'off' ? 0 : budgetOf(level) };
  }
  if (dialect === 'gemini-level') {
    const value = nativeValue(level === 'off' ? 'low' : level, values.length ? values : ['low', 'medium', 'high']);
    return value ? { thinkingLevel: value.toUpperCase() as 'LOW' | 'MEDIUM' | 'HIGH' } : undefined;
  }
  return undefined;
}

/**
 * The body with one level applied. `base` is the body without any reasoning field; the result is a
 * new object, so a retry without effort can start from `base` again.
 */
export function applyEffortPatch(base: Record<string, unknown>, patch: EffortPatch): Record<string, unknown> {
  if (!Object.keys(patch.set).length && !patch.remove.length && !patch.maxTokensField && !patch.minMaxTokens) return base;
  const body: Record<string, unknown> = { ...base };
  for (const field of patch.remove) delete body[field];
  const current = Number(body.max_tokens) || 0;
  const wanted = Math.max(current, patch.minMaxTokens || 0);
  if (patch.maxTokensField) {
    delete body.max_tokens;
    if (wanted) body[patch.maxTokensField] = wanted;
  } else if (wanted) {
    body.max_tokens = wanted;
  }
  return { ...body, ...patch.set };
}

/**
 * Whether an error answer refused what Tarka added for the effort: a 400 or 422 whose text
 * names one of the fields that were sent (`reasoning` only as a whole word, so an error about
 * reasoning_details is not one), or the value of one ("unknown variant `xhigh`"), or the token
 * limit when the effort raised it. Anything else is the round's own error.
 */
export function refusedEffortField(status: number | undefined, text: string, sent: Record<string, unknown>, raisedTokens = false): boolean {
  if (status !== 400 && status !== 422) return false;
  const body = text || '';
  for (const field of Object.keys(sent)) {
    if (new RegExp(`(?<![a-z_])${field}(?![a-z_])`, 'i').test(body)) return true;
  }
  if (/\bthink\b|does not support thinking/i.test(body) && 'think' in sent) return true;
  const variant = /unknown variant [`'"]([^`'"]+)[`'"]/i.exec(body)?.[1];
  if (variant && JSON.stringify(sent).toLowerCase().includes(`"${variant.toLowerCase()}"`)) return true;
  return raisedTokens && /max_tokens|max_completion_tokens|max_output_tokens/i.test(body);
}
