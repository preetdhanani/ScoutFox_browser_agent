/**
 * Storage utility for ScoutFox Agentic Browser Extension
 * Manages settings, per-provider API configuration memory, multi-session history, and model caching.
 */
import { DEFAULT_NVIDIA_LLM_TIMEOUT_MS, endpointHostOf, endpointOriginOf } from '../background/llm/settings.ts';

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  llmTimeoutMs?: number;
  /** Per-model context window (tokens). Populated by fetching model info from the endpoint. */
  modelContextWindow?: Record<string, number>;
}

/** Keyed by provider id. A stored value can hold ids this build does not know, so the key is a plain string. */
export type ProviderConfigs = Record<string, ProviderConfig>;

/** Which wire dialect a user-added endpoint speaks. A property of the endpoint, not of the model behind it. */
export type ProviderProtocol = 'openai' | 'anthropic';

/**
 * A provider the user created at runtime. The descriptor holds the non-secret metadata; the key lives in
 * `providerConfigs[id].apiKey`, so the existing per-provider credential memory and the top-level sync of
 * saveSettings keep working unchanged.
 */
export interface CustomProvider {
  /** `^[a-z][a-z0-9-]{1,31}$`, unique, and never a built-in id. It is a storage key and a log label. */
  id: string;
  /** The label in the dropdown, the header pill and the timeline. Defaults to the endpoint host. */
  displayName: string;
  protocol: ProviderProtocol;
  /** Stored as typed; normalized on use (see llm/settings.ts), never rewritten behind the user's back. */
  baseUrl: string;
  /** The saved model list: fetched ids plus hand-added ones, in picker order. [] is a valid saved state. */
  models: string[];
  /** 'none' records that the endpoint takes no key, so no Authorization header is sent at all. */
  keyMode: 'apiKey' | 'none';
  /** Per-provider LLM timeout. When missing, the global llmTimeoutMs applies (timeoutMsOf precedence). */
  llmTimeoutMs?: number;
  createdAt: number;
  updatedAt: number;
}

export type CustomProviders = Record<string, CustomProvider>;

/** The shape of a provider id: lowercase, starts with a letter, then letters, digits and dashes, 2 to 32 chars in all. */
export const CUSTOM_PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

/** Custom ids build on these built-ins; a custom provider can never shadow one. Kept as a literal so the
 * constant works before DEFAULT_PROVIDER_CONFIGS is initialized; a test pins it to the actual key set. */
export const BUILTIN_PROVIDER_IDS: readonly string[] = ['openrouter', 'agent_router', 'gemini', 'ollama', 'openai', 'openai_compatible', 'anthropic', 'nvidia'];

/** How many user-added providers one settings object may hold. */
export const MAX_CUSTOM_PROVIDERS = 20;

/** Default context window (tokens) when the endpoint does not report one. */
export const DEFAULT_CONTEXT_WINDOW = 262144; // 256k tokens - safe for most modern models

export interface Settings {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  providerConfigs: ProviderConfigs;
  temperature: number;
  maxSteps: number;
  llmTimeoutMs: number;
  ollamaNumCtx: number;
  ollamaNumPredict: number;
  /** Per-provider per-model context window override. Keyed by "provider|model". */
  contextWindow?: Record<string, number>;
  actionDelayMs: number;
  autoScroll: boolean;
  theme: string;
  systemInstructions: string;
  /** The composer's starting effort: how hard the model thinks (background/llm/effort.ts). 'xhigh' from older builds reads as 'max'. */
  effortDefault?: 'auto' | 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Routine steps (not the first, not after a failed tool) get one effort level less. On unless stored false. */
  effortAdaptive?: boolean;
  /**
   * Default approval mode for a new task. true: the agent approves its plan and runs.
   * false: the plan is shown and the run waits for APPROVE_PLAN.
   */
  autoApprove?: boolean;
  modelTier?: 'auto' | 'small' | 'large';
  /**
   * Whether the agent captures images of pages it opens. Always on: every new page load gets a
   * screenshot for clarity. Kept as a stored flag only so the panel can read "is it on"; there is
   * no user toggle for it.
   */
  screenshots: boolean;
  /** User-added third-party providers, keyed by id. Absent in older settings, so reads default to {}. */
  customProviders?: CustomProviders;
  /**
   * Research outside the tab: the web_search and fetch_url tools. Absent in older settings;
   * getSettings fills each missing field from DEFAULT_RESEARCH (a deep merge, see normalizeResearch).
   */
  research: ResearchSettings;
}

/** Where web_search looks. DuckDuckGo's HTML page needs no key; SearXNG is a server the user names. */
export type ResearchBackend = 'duckduckgo' | 'searxng';

export interface ResearchSettings {
  /** Whether the model is offered web_search and fetch_url. */
  enabled: boolean;
  backend: ResearchBackend;
  /** The base URL of a SearXNG instance with the JSON format on (https://searx.example). Used when backend is searxng. */
  searxngUrl: string;
}

export const DEFAULT_RESEARCH: ResearchSettings = { enabled: true, backend: 'duckduckgo', searxngUrl: '' };

/**
 * A stored research object (or nothing, from an older build) as a whole ResearchSettings: every
 * field that is missing or of the wrong kind takes its default, every valid one is kept.
 */
export function normalizeResearch(raw: unknown): ResearchSettings {
  const r = raw && typeof raw === 'object' ? (raw as Partial<ResearchSettings>) : {};
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : DEFAULT_RESEARCH.enabled,
    backend: r.backend === 'searxng' || r.backend === 'duckduckgo' ? r.backend : DEFAULT_RESEARCH.backend,
    searxngUrl: typeof r.searxngUrl === 'string' ? r.searxngUrl.trim() : DEFAULT_RESEARCH.searxngUrl
  };
}

/** Whether the agent captures images of pages it opens. Always on: every new page load gets a screenshot for clarity. */
export const screenshotsAlwaysOn = true;

/** A session as the side panel saves it into the history drawer. */
export interface SavedSession {
  id: string;
  task?: string;
  timestamp?: string;
  model?: string;
  history?: unknown[];
  planSteps?: unknown[];
}

interface ModelsCacheEntry {
  timestamp: number;
  models: string[];
}

type ModelsCache = Record<string, ModelsCacheEntry>;

export const DEFAULT_PROVIDER_CONFIGS: ProviderConfigs = {
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', apiKey: '', model: 'anthropic/claude-3.5-sonnet' },
  agent_router: { baseUrl: 'https://agentrouter.org/v1', apiKey: '', model: 'claude-3-5-sonnet' },
  gemini: { baseUrl: '', apiKey: '', model: 'gemini-1.5-flash' },
  ollama: { baseUrl: 'http://localhost:11434', apiKey: '', model: 'qwen3.8:27b-mlx' },
  openai: { baseUrl: 'https://api.openai.com', apiKey: '', model: 'gpt-4o-mini' },
  openai_compatible: { baseUrl: 'https://api.groq.com/openai/v1', apiKey: '', model: 'llama-3.3-70b-versatile' },
  anthropic: { baseUrl: 'https://api.anthropic.com', apiKey: '', model: 'claude-3-5-sonnet-20241022' },
  nvidia: { baseUrl: 'https://integrate.api.nvidia.com/v1', apiKey: '', model: 'meta/llama-3.3-70b-instruct', llmTimeoutMs: DEFAULT_NVIDIA_LLM_TIMEOUT_MS }
};

export const DEFAULT_SETTINGS: Settings = {
  provider: 'ollama',
  baseUrl: 'http://localhost:11434',
  apiKey: '',
  model: 'qwen3.8:27b-mlx',
  providerConfigs: DEFAULT_PROVIDER_CONFIGS,
  customProviders: {},
  temperature: 0.1,
  maxSteps: 250,
  // Hard ceiling on a single LLM call. A provider that accepts the connection and never
  // answers would otherwise park the agent loop indefinitely, with the keepalive actively
  // preventing Chrome from reclaiming the worker.
  llmTimeoutMs: 120000,
  // Ollama-only. Ollama caps context at 4096 tokens by default no matter how large a window
  // the model actually supports, and truncates overflow from the FRONT - silently discarding
  // the system prompt and the user's goal. 8192 comfortably fits a page snapshot plus history.
  ollamaNumCtx: 8192,
  // Ceiling on a single local generation, so a model that starts rambling cannot stall a step.
  // Exposed in Settings; 8192 is generous enough that a real answer is unlikely to hit it,
  // while still bounding a model that never stops.
  ollamaNumPredict: 8192,
  actionDelayMs: 1000,
  autoScroll: true,
  theme: 'system',
  systemInstructions: 'You are ScoutFox, an autonomous web browsing AI agent. Your goal is to help the user complete tasks on the web efficiently and accurately.',
  effortDefault: 'medium',
  effortAdaptive: true,
  autoApprove: true,
  modelTier: 'auto',
  screenshots: true,
  research: { ...DEFAULT_RESEARCH },
};

/**
 * Drops stored custom-provider entries this build cannot use: a missing or unusable id, an id that
 * shadows a built-in, or a protocol outside the two known ones. Everything else is kept as stored,
 * because a newer build may have written fields this build does not know.
 */
export function sanitizeCustomProviders(raw: unknown): CustomProviders {
  const source = (raw && typeof raw === 'object') ? (raw as Record<string, unknown>) : {};
  const out: CustomProviders = {};
  for (const [key, value] of Object.entries(source)) {
    const entry = (value && typeof value === 'object') ? (value as Partial<CustomProvider>) : null;
    if (!entry) continue;
    const id = typeof entry.id === 'string' && entry.id ? entry.id : key;
    if (!CUSTOM_PROVIDER_ID_PATTERN.test(id)) continue;
    if ((BUILTIN_PROVIDER_IDS as readonly string[]).includes(id)) continue;
    if (entry.protocol !== 'openai' && entry.protocol !== 'anthropic') continue;
    out[id] = {
      id,
      displayName: typeof entry.displayName === 'string' && entry.displayName.trim() ? entry.displayName.trim() : id,
      protocol: entry.protocol,
      baseUrl: typeof entry.baseUrl === 'string' ? entry.baseUrl : '',
      models: Array.isArray(entry.models) ? entry.models.filter((m): m is string => typeof m === 'string') : [],
      keyMode: entry.keyMode === 'none' ? 'none' : 'apiKey',
      ...(typeof entry.llmTimeoutMs === 'number' && entry.llmTimeoutMs > 0 ? { llmTimeoutMs: entry.llmTimeoutMs } : {}),
      createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : 0,
      updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : 0
    };
  }
  return out;
}

/**
 * The stored provider id, healed when it names nothing this build knows: a built-in, or a custom
 * provider that survived sanitization. A hand-edited storage file can otherwise leave the whole
 * run path throwing "Unsupported LLM provider" at Start Task.
 */
function resolveStoredProvider(raw: unknown, customProviders: CustomProviders): string {
  const provider = typeof raw === 'string' && raw ? raw : DEFAULT_SETTINGS.provider;
  if ((BUILTIN_PROVIDER_IDS as readonly string[]).includes(provider)) return provider;
  if (customProviders[provider]) return provider;
  return DEFAULT_SETTINGS.provider;
}

/** The fields the Add/Edit dialog sends. `protocol` stays a string here so the validator can word its own error. */
export interface CustomProviderInput {
  id: string;
  displayName?: string;
  protocol: string;
  baseUrl: string;
  models?: string[];
  /** The credential for this endpoint. Given, it wins; absent, the stored one stays. Never stored in the descriptor. */
  apiKey?: string;
  keyMode?: string;
  llmTimeoutMs?: number;
}

export type SaveCustomProviderResult =
  | { ok: true; settings: Settings; provider: CustomProvider; keyCleared: boolean }
  | { ok: false; error: string };

/**
 * Validates one custom provider at the storage boundary and writes it with its credential.
 *
 * Rules checked here (the UI mirrors the messages, this is the gate):
 * - the id matches CUSTOM_PROVIDER_ID_PATTERN, is unique (the same id is an update), and never
 *   shadows a built-in;
 * - the protocol is one of the two known values;
 * - the base URL parses as http or https;
 * - a model id carries no newline or tab, which would corrupt the picker and the logs.
 *
 * The origin rule: when an EDIT changes the endpoint origin (scheme, host or port), the stored key
 * is cleared, so a live credential is never sent to a host the user did not choose. A path-only
 * change (/v1 to /api/v1) keeps the key. `keyCleared` says which happened, for the panel's note.
 */
export async function saveCustomProvider(input: CustomProviderInput): Promise<SaveCustomProviderResult> {
  const id = (input.id || '').trim();
  if (!CUSTOM_PROVIDER_ID_PATTERN.test(id)) {
    return { ok: false, error: 'Provider ID must be lowercase letters, digits and dashes, starting with a letter, up to 32 characters.' };
  }
  if ((BUILTIN_PROVIDER_IDS as readonly string[]).includes(id)) {
    return { ok: false, error: `"${id}" is a built-in provider and cannot be replaced. Choose another ID.` };
  }
  if (input.protocol !== 'openai' && input.protocol !== 'anthropic') {
    return { ok: false, error: 'API protocol must be OpenAI Chat Completions or Anthropic Messages.' };
  }
  const baseUrl = (input.baseUrl || '').trim();
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return { ok: false, error: 'Base URL must be a full URL, for example https://gateway.example/v1.' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: `Base URL must start with http:// or https:// (got ${parsed.protocol}).` };
  }

  const models: string[] = [];
  for (const raw of Array.isArray(input.models) ? input.models : []) {
    if (typeof raw !== 'string') continue;
    const model = raw.trim();
    if (!model) continue;
    if (/[\n\t\r]/.test(model)) {
      return { ok: false, error: `Model id "${model.slice(0, 40)}" contains a line break. Model ids are single-line.` };
    }
    if (!models.includes(model)) models.push(model);
  }

  const current = await Storage.getSettings();
  const existing = current.customProviders?.[id];
  const isNew = !existing;
  if (isNew && Object.keys(current.customProviders || {}).length >= MAX_CUSTOM_PROVIDERS) {
    return { ok: false, error: `At most ${MAX_CUSTOM_PROVIDERS} custom providers can be stored. Delete one to add another.` };
  }

  const now = Date.now();
  const provider: CustomProvider = {
    id,
    displayName: (input.displayName || '').trim() || endpointHostOf(baseUrl) || id,
    protocol: input.protocol,
    baseUrl,
    models,
    keyMode: input.keyMode === 'none' ? 'none' : 'apiKey',
    ...(typeof input.llmTimeoutMs === 'number' && input.llmTimeoutMs > 0 ? { llmTimeoutMs: input.llmTimeoutMs } : {}),
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };

  const customProviders: CustomProviders = { ...(current.customProviders || {}), [id]: provider };

  // The credential lives in providerConfigs[id], as for every provider. A key given in the input
  // wins (it gets the same cleanup getApiKey applies on read); a key not mentioned stays. The
  // origin rule clears it when the endpoint host changes, and keeps it for a path-only correction.
  const previousConfig = current.providerConfigs?.[id] || {};
  const inputKey = typeof input.apiKey === 'string'
    ? input.apiKey.trim().replace(/^Bearer\s+/i, '').replace(/^["']|["']$/g, '')
    : undefined;
  const originChanged = Boolean(existing) && endpointOriginOf(existing!.baseUrl) !== endpointOriginOf(baseUrl);
  const apiKey = originChanged ? '' : (inputKey !== undefined ? inputKey : (previousConfig.apiKey || ''));
  const providerConfigs: ProviderConfigs = {
    ...current.providerConfigs,
    [id]: {
      baseUrl,
      apiKey,
      model: previousConfig.model || '',
      ...(typeof input.llmTimeoutMs === 'number' && input.llmTimeoutMs > 0 ? { llmTimeoutMs: input.llmTimeoutMs } : {})
    }
  };

  const settings = await Storage.saveSettings({ customProviders, providerConfigs });
  return { ok: true, settings, provider, keyCleared: originChanged };
}

export const Storage = {
  /**
   * Load user settings with merged providerConfigs and active provider fallback sync
   */
  async getSettings(): Promise<Settings> {
    return new Promise((resolve) => {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
        resolve({ ...DEFAULT_SETTINGS });
        return;
      }
      chrome.storage.local.get<{ agent_settings?: Partial<Settings> }>(['agent_settings'], (result) => {
        const loaded = result.agent_settings || {};
        delete (loaded as any).engine;
        // One-time migration: if stored maxSteps is 25 (the old default), upgrade to 250 for long-horizon runs
        if (loaded.maxSteps === 25) {
          loaded.maxSteps = 250;
        }
        const mergedConfigs: ProviderConfigs = { ...DEFAULT_PROVIDER_CONFIGS, ...(loaded.providerConfigs || {}) };
        const customProviders = sanitizeCustomProviders(loaded.customProviders);
        const provider = resolveStoredProvider(loaded.provider, customProviders);
        // One-time migration: if stored provider is nvidia and has no per-provider llmTimeoutMs,
        // write the NVIDIA default timeout so existing settings get the new default.
        if (provider === 'nvidia' && !mergedConfigs.nvidia?.llmTimeoutMs) {
          if (!mergedConfigs.nvidia) {
            mergedConfigs.nvidia = { ...DEFAULT_PROVIDER_CONFIGS.nvidia };
          }
          mergedConfigs.nvidia.llmTimeoutMs = DEFAULT_NVIDIA_LLM_TIMEOUT_MS;
        }
        const activeCfg: Partial<ProviderConfig> = mergedConfigs[provider] || {};

        const apiKey = (loaded.apiKey !== undefined && loaded.apiKey !== '')
          ? loaded.apiKey
          : (activeCfg.apiKey || '');
        const baseUrl = (loaded.baseUrl !== undefined && loaded.baseUrl !== '')
          ? loaded.baseUrl
          : (activeCfg.baseUrl || '');
        const model = (loaded.model !== undefined && loaded.model !== '')
          ? loaded.model
          : (activeCfg.model || DEFAULT_SETTINGS.model);

        const settings: Settings = {
          ...DEFAULT_SETTINGS,
          ...loaded,
          provider,
          apiKey,
          baseUrl,
          model,
          providerConfigs: mergedConfigs,
          customProviders,
          // A nested object: the defaults fill what an older build never stored.
          research: normalizeResearch(loaded.research),
          contextWindow: loaded.contextWindow || {},
          // Screenshots are always on: every new page load gets an image for clarity.
          screenshots: true
        };
        delete (settings as any).engine;
        // Element badges have no setting any more (they are always off); an old stored flag is dropped.
        delete (settings as any).showElementBadges;
        // There is no execute_js tool any more; an old stored opt-in is dropped.
        delete (settings as any).allowExecuteJs;
        resolve(settings);
      });
    });
  },

  /**
   * Save user settings and update active provider configuration
   */
  async saveSettings(newSettings: Partial<Settings>): Promise<Settings> {
    delete (newSettings as any).engine;
    const current = await this.getSettings();
    const activeProvider = newSettings.provider || current.provider;

    const updatedProviderConfigs: ProviderConfigs = {
      ...(current.providerConfigs || DEFAULT_PROVIDER_CONFIGS),
      ...(newSettings.providerConfigs || {})
    };

    // Store settings under the active provider key
    if (newSettings.apiKey !== undefined || newSettings.baseUrl !== undefined || newSettings.model !== undefined) {
      const existingTimeout = updatedProviderConfigs[activeProvider]?.llmTimeoutMs;
      updatedProviderConfigs[activeProvider] = {
        baseUrl: newSettings.baseUrl !== undefined ? newSettings.baseUrl : (updatedProviderConfigs[activeProvider]?.baseUrl || ''),
        apiKey: newSettings.apiKey !== undefined ? newSettings.apiKey : (updatedProviderConfigs[activeProvider]?.apiKey || ''),
        model: newSettings.model !== undefined ? newSettings.model : (updatedProviderConfigs[activeProvider]?.model || '')
      };
      if (existingTimeout !== undefined) {
        updatedProviderConfigs[activeProvider].llmTimeoutMs = existingTimeout;
      }
    }

    // Only update per-provider timeout for nvidia; other providers use top-level llmTimeoutMs
    if (newSettings.llmTimeoutMs !== undefined && activeProvider === 'nvidia') {
      if (!updatedProviderConfigs.nvidia) {
        updatedProviderConfigs.nvidia = { ...DEFAULT_PROVIDER_CONFIGS.nvidia };
      }
      updatedProviderConfigs.nvidia.llmTimeoutMs = newSettings.llmTimeoutMs;
    }

    // Ensure active provider keys are synchronized top-level.
    // The cast is deliberate: a provider that has no config (or a stored config that lacks a field)
    // leaves the top-level value undefined, as it always did. chrome.storage drops undefined and
    // getSettings falls back to the default on the next read.
    const activeCfg = (updatedProviderConfigs[activeProvider] || {}) as ProviderConfig;
    const apiKey = newSettings.apiKey !== undefined ? newSettings.apiKey : activeCfg.apiKey;
    const baseUrl = newSettings.baseUrl !== undefined ? newSettings.baseUrl : activeCfg.baseUrl;
    const model = newSettings.model !== undefined ? newSettings.model : activeCfg.model;

    const updated: Settings = {
      ...current,
      ...newSettings,
      provider: activeProvider,
      apiKey,
      baseUrl,
      model,
      providerConfigs: updatedProviderConfigs,
      contextWindow: current.contextWindow,
      // A partial research object changes only the fields it names.
      research: normalizeResearch({ ...current.research, ...(newSettings.research || {}) })
    };
    delete (updated as any).engine;

    if (activeProvider === 'nvidia' && newSettings.llmTimeoutMs !== undefined) {
      // Retain top-level global timeout so NVIDIA's provider-specific timeout does not pollute global settings
      updated.llmTimeoutMs = current.llmTimeoutMs !== undefined ? current.llmTimeoutMs : DEFAULT_SETTINGS.llmTimeoutMs;
    }

    return new Promise((resolve) => {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
        resolve(updated);
        return;
      }
      chrome.storage.local.set({ agent_settings: updated }, () => resolve(updated));
    });
  },

  /**
   * Get cached models for a provider key
   */
  async getCachedModels(cacheKey: string): Promise<string[] | null> {
    return new Promise((resolve) => {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get<{ models_cache?: ModelsCache }>(['models_cache'], (res) => {
          const cache = res.models_cache || {};
          const entry = cache[cacheKey];
          if (entry && (Date.now() - entry.timestamp < 3600000)) { // 1 hour cache
            resolve(entry.models);
          } else {
            resolve(null);
          }
        });
      } else {
        resolve(null);
      }
    });
  },

  /**
   * Save cached models for a provider key
   */
  async saveCachedModels(cacheKey: string, models: string[]): Promise<void> {
    return new Promise((resolve) => {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get<{ models_cache?: ModelsCache }>(['models_cache'], (res) => {
          const cache = res.models_cache || {};
          cache[cacheKey] = {
            timestamp: Date.now(),
            models
          };
          chrome.storage.local.set({ models_cache: cache }, () => resolve());
        });
      } else {
        resolve();
      }
    });
  },

  /**
   * Drop every model-cache entry of one provider (its cache keys all start with "<id>_"). Used when
   * a custom provider is deleted, so no stale list of a gone endpoint is served on the next open.
   */
  async purgeCachedModelsForProvider(providerId: string): Promise<void> {
    return new Promise((resolve) => {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
        resolve();
        return;
      }
      chrome.storage.local.get<{ models_cache?: ModelsCache }>(['models_cache'], (res) => {
        const cache = res.models_cache || {};
        const prefix = `${providerId}_`;
        const kept: ModelsCache = {};
        let removed = false;
        for (const [key, entry] of Object.entries(cache)) {
          if (key.startsWith(prefix)) {
            removed = true;
            continue;
          }
          kept[key] = entry;
        }
        if (!removed) {
          resolve();
          return;
        }
        chrome.storage.local.set({ models_cache: kept }, () => resolve());
      });
    });
  },

  /**
   * Delete a user-added provider: the descriptor, its credentials, its model cache, and (when it
   * was the active provider) the active selection, which falls back to the built-in default.
   * History is left untouched, so a past run keeps its label. Null when the id is not custom.
   */
  async deleteCustomProvider(providerId: string): Promise<Settings | null> {
    const current = await this.getSettings();
    if (!current.customProviders || !current.customProviders[providerId]) return null;
    const customProviders: CustomProviders = { ...current.customProviders };
    delete customProviders[providerId];
    const providerConfigs: ProviderConfigs = { ...current.providerConfigs };
    delete providerConfigs[providerId];
    const wasActive = current.provider === providerId;
    // saveSettings cannot express a key deletion (its providerConfigs merge only adds or replaces
    // entries), so the removal is written directly, with the same top-level synchronization
    // saveSettings applies for the provider that is active afterwards.
    const provider = wasActive ? DEFAULT_SETTINGS.provider : current.provider;
    const activeCfg = providerConfigs[provider] || {};
    const updated: Settings = {
      ...current,
      provider,
      // undefined is dropped by chrome.storage, so the top-level values of the deleted provider
      // (if it was active) stop shadowing the defaults of the provider that takes over.
      apiKey: activeCfg.apiKey ?? undefined,
      baseUrl: activeCfg.baseUrl ?? undefined,
      model: activeCfg.model ?? undefined,
      customProviders,
      providerConfigs
    };
    await new Promise<void>((resolve) => {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
        resolve();
        return;
      }
      chrome.storage.local.set({ agent_settings: updated }, () => resolve());
    });
    await this.purgeCachedModelsForProvider(providerId);
    // Read back through the normal path, so the caller sees exactly what a reload would see.
    return this.getSettings();
  },

  /**
   * Get saved session history list
   */
  async getSessions(): Promise<SavedSession[]> {
    return new Promise((resolve) => {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
        resolve([]);
        return;
      }
      chrome.storage.local.get<{ saved_sessions?: SavedSession[] }>(['saved_sessions'], (res) => {
        resolve(res.saved_sessions || []);
      });
    });
  },

  /**
   * Save a completed session into history
   */
  async saveSession(sessionObj: SavedSession): Promise<SavedSession[]> {
    const sessions = await this.getSessions();
    const existingIndex = sessions.findIndex(s => s.id === sessionObj.id);

    if (existingIndex >= 0) {
      sessions[existingIndex] = sessionObj;
    } else {
      sessions.unshift(sessionObj);
    }

    const trimmed = sessions.slice(0, 50);

    return new Promise((resolve) => {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
        resolve(trimmed);
        return;
      }
      chrome.storage.local.set({ saved_sessions: trimmed }, () => resolve(trimmed));
    });
  },

  /**
   * Delete a saved session by ID
   */
  async deleteSession(sessionId: string): Promise<SavedSession[]> {
    const sessions = await this.getSessions();
    const updated = sessions.filter(s => s.id !== sessionId);

    return new Promise((resolve) => {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
        resolve(updated);
        return;
      }
      chrome.storage.local.set({ saved_sessions: updated }, () => resolve(updated));
    });
  }
};
