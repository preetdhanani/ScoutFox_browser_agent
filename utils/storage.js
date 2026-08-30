/**
 * Storage utility for ScoutFox Agentic Browser Extension
 * Manages settings, per-provider API configuration memory, multi-session history, and model caching.
 */

export const DEFAULT_PROVIDER_CONFIGS = {
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', apiKey: '', model: 'anthropic/claude-3.5-sonnet' },
  agent_router: { baseUrl: 'https://agentrouter.org/v1', apiKey: '', model: 'claude-3-5-sonnet' },
  gemini: { baseUrl: '', apiKey: '', model: 'gemini-1.5-flash' },
  ollama: { baseUrl: 'http://localhost:11434', apiKey: '', model: 'qwen2.5:14b' },
  openai: { baseUrl: 'https://api.openai.com', apiKey: '', model: 'gpt-4o-mini' },
  openai_compatible: { baseUrl: 'https://api.groq.com/openai/v1', apiKey: '', model: 'llama-3.1-70b-versatile' },
  anthropic: { baseUrl: 'https://api.anthropic.com', apiKey: '', model: 'claude-3-5-sonnet-20241022' }
};

export const DEFAULT_SETTINGS = {
  provider: 'openrouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: '',
  model: 'anthropic/claude-3.5-sonnet',
  providerConfigs: DEFAULT_PROVIDER_CONFIGS,
  temperature: 0.1,
  maxSteps: 25,
  actionDelayMs: 1000,
  showElementBadges: true,
  autoScroll: true,
  theme: 'system',
  systemInstructions: 'You are ScoutFox, an autonomous web browsing AI agent. Your goal is to help the user complete tasks on the web efficiently and accurately.'
};

export const Storage = {
  /**
   * Load user settings with merged providerConfigs and active provider fallback sync
   */
  async getSettings() {
    return new Promise((resolve) => {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(['agent_settings'], (result) => {
          const loaded = result.agent_settings || {};
          const mergedConfigs = { ...DEFAULT_PROVIDER_CONFIGS, ...(loaded.providerConfigs || {}) };
          const provider = loaded.provider || DEFAULT_SETTINGS.provider;
          const activeCfg = mergedConfigs[provider] || {};

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
      } else {
        const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('agent_settings') : null;
        if (saved) {
          const loaded = JSON.parse(saved);
          const mergedConfigs = { ...DEFAULT_PROVIDER_CONFIGS, ...(loaded.providerConfigs || {}) };
          const provider = loaded.provider || DEFAULT_SETTINGS.provider;
          const activeCfg = mergedConfigs[provider] || {};

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
        } else {
          resolve(DEFAULT_SETTINGS);
        }
      }
    });
  },

  /**
   * Save user settings and update active provider configuration
   */
  async saveSettings(newSettings) {
    const current = await this.getSettings();
    const activeProvider = newSettings.provider || current.provider;

    const updatedProviderConfigs = {
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

    // Ensure active provider keys are synchronized top-level
    const activeCfg = updatedProviderConfigs[activeProvider] || {};
    const apiKey = newSettings.apiKey !== undefined ? newSettings.apiKey : activeCfg.apiKey;
    const baseUrl = newSettings.baseUrl !== undefined ? newSettings.baseUrl : activeCfg.baseUrl;
    const model = newSettings.model !== undefined ? newSettings.model : activeCfg.model;

    const updated = {
      ...current,
      ...newSettings,
      provider: activeProvider,
      apiKey,
      baseUrl,
      model,
      providerConfigs: updatedProviderConfigs
    };
    
    return new Promise((resolve) => {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ agent_settings: updated }, () => resolve(updated));
      } else {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem('agent_settings', JSON.stringify(updated));
        }
        resolve(updated);
      }
    });
  },

  /**
   * Get cached models for a provider key
   */
  async getCachedModels(cacheKey) {
    return new Promise((resolve) => {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(['models_cache'], (res) => {
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
  async saveCachedModels(cacheKey, models) {
    return new Promise((resolve) => {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(['models_cache'], (res) => {
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
  async getSessions() {
    return new Promise((resolve) => {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(['saved_sessions'], (res) => {
          resolve(res.saved_sessions || []);
        });
      } else {
        const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('saved_sessions') : null;
        resolve(saved ? JSON.parse(saved) : []);
      }
    });
  },

  /**
   * Save a completed session into history
   */
  async saveSession(sessionObj) {
    const sessions = await this.getSessions();
    const existingIndex = sessions.findIndex(s => s.id === sessionObj.id);

    if (existingIndex >= 0) {
      sessions[existingIndex] = sessionObj;
    } else {
      sessions.unshift(sessionObj);
    }

    const trimmed = sessions.slice(0, 50);

    return new Promise((resolve) => {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ saved_sessions: trimmed }, () => resolve(trimmed));
      } else {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem('saved_sessions', JSON.stringify(trimmed));
        }
        resolve(trimmed);
      }
    });
  },

  /**
   * Delete a saved session by ID
   */
  async deleteSession(sessionId) {
    const sessions = await this.getSessions();
    const updated = sessions.filter(s => s.id !== sessionId);

    return new Promise((resolve) => {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ saved_sessions: updated }, () => resolve(updated));
      } else {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem('saved_sessions', JSON.stringify(updated));
        }
        resolve(updated);
      }
    });
  }
};
