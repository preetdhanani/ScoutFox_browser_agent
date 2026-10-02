/**
 * Storage utility for ScoutFox Agentic Browser Extension
 * Manages settings, per-provider API configuration memory, multi-session history, and model caching.
 */

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** Keyed by provider id. A stored value can hold ids this build does not know, so the key is a plain string. */
export type ProviderConfigs = Record<string, ProviderConfig>;

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
  actionDelayMs: number;
  showElementBadges: boolean;
  autoScroll: boolean;
  theme: string;
  systemInstructions: string;
  engine?: 'legacy' | 'graph';
}

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
  ollama: { baseUrl: 'http://localhost:11434', apiKey: '', model: 'qwen2.5:14b' },
  openai: { baseUrl: 'https://api.openai.com', apiKey: '', model: 'gpt-4o-mini' },
  openai_compatible: { baseUrl: 'https://api.groq.com/openai/v1', apiKey: '', model: 'llama-3.3-70b-versatile' },
  anthropic: { baseUrl: 'https://api.anthropic.com', apiKey: '', model: 'claude-3-5-sonnet-20241022' }
};

export const DEFAULT_SETTINGS: Settings = {
  provider: 'openrouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: '',
  model: 'anthropic/claude-3.5-sonnet',
  providerConfigs: DEFAULT_PROVIDER_CONFIGS,
  temperature: 0.1,
  maxSteps: 25,
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
  showElementBadges: true,
  autoScroll: true,
  theme: 'system',
  systemInstructions: 'You are ScoutFox, an autonomous web browsing AI agent. Your goal is to help the user complete tasks on the web efficiently and accurately.',
  engine: 'legacy'
};

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
        const mergedConfigs: ProviderConfigs = { ...DEFAULT_PROVIDER_CONFIGS, ...(loaded.providerConfigs || {}) };
        const provider = loaded.provider || DEFAULT_SETTINGS.provider;
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

        resolve({
          ...DEFAULT_SETTINGS,
          ...loaded,
          provider,
          apiKey,
          baseUrl,
          model,
          providerConfigs: mergedConfigs
        });
      });
    });
  },

  /**
   * Save user settings and update active provider configuration
   */
  async saveSettings(newSettings: Partial<Settings>): Promise<Settings> {
    const current = await this.getSettings();
    const activeProvider = newSettings.provider || current.provider;

    const updatedProviderConfigs: ProviderConfigs = {
      ...(current.providerConfigs || DEFAULT_PROVIDER_CONFIGS),
      ...(newSettings.providerConfigs || {})
    };

    // Store settings under the active provider key
    if (newSettings.apiKey !== undefined || newSettings.baseUrl !== undefined || newSettings.model !== undefined) {
      updatedProviderConfigs[activeProvider] = {
        baseUrl: newSettings.baseUrl !== undefined ? newSettings.baseUrl : (updatedProviderConfigs[activeProvider]?.baseUrl || ''),
        apiKey: newSettings.apiKey !== undefined ? newSettings.apiKey : (updatedProviderConfigs[activeProvider]?.apiKey || ''),
        model: newSettings.model !== undefined ? newSettings.model : (updatedProviderConfigs[activeProvider]?.model || '')
      };
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
      providerConfigs: updatedProviderConfigs
    };

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
