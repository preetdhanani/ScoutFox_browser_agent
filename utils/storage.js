/**
 * Storage utility for ScoutFox Agentic Browser Extension
 * Manages settings, per-provider API configuration memory, multi-session history, and model caching.
 */

export const DEFAULT_PROVIDER_CONFIGS = {
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', apiKey: '', model: 'anthropic/claude-3.5-sonnet' },
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
   * Load user settings with merged providerConfigs
   */
  async getSettings() {
    return new Promise((resolve) => {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(['agent_settings'], (result) => {
          const loaded = result.agent_settings || {};
          const mergedConfigs = { ...DEFAULT_PROVIDER_CONFIGS, ...(loaded.providerConfigs || {}) };
          resolve({ ...DEFAULT_SETTINGS, ...loaded, providerConfigs: mergedConfigs });
        });
      } else {
        const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('agent_settings') : null;
        if (saved) {
          const loaded = JSON.parse(saved);
          const mergedConfigs = { ...DEFAULT_PROVIDER_CONFIGS, ...(loaded.providerConfigs || {}) };
          resolve({ ...DEFAULT_SETTINGS, ...loaded, providerConfigs: mergedConfigs });
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

    // If apiKey, baseUrl, or model are provided, store them under the active provider key
    if (newSettings.apiKey !== undefined || newSettings.baseUrl !== undefined || newSettings.model !== undefined) {
      updatedProviderConfigs[activeProvider] = {
        baseUrl: newSettings.baseUrl !== undefined ? newSettings.baseUrl : (updatedProviderConfigs[activeProvider]?.baseUrl || ''),
        apiKey: newSettings.apiKey !== undefined ? newSettings.apiKey : (updatedProviderConfigs[activeProvider]?.apiKey || ''),
        model: newSettings.model !== undefined ? newSettings.model : (updatedProviderConfigs[activeProvider]?.model || '')
      };
    }

    const updated = {
      ...current,
      ...newSettings,
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
        chrome.storage.local.get(['agent_models_cache'], (res) => {
          const cache = res.agent_models_cache || {};
          resolve(cache[cacheKey] || null);
        });
      } else {
        const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('agent_models_cache') : null;
        const cache = saved ? JSON.parse(saved) : {};
        resolve(cache[cacheKey] || null);
      }
    });
  },

  /**
   * Save cached models for a provider key
   */
  async saveCachedModels(cacheKey, modelsList) {
    return new Promise((resolve) => {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(['agent_models_cache'], (res) => {
          const cache = res.agent_models_cache || {};
          cache[cacheKey] = modelsList;
          chrome.storage.local.set({ agent_models_cache: cache }, () => resolve(cache));
        });
      } else {
        let cache = {};
        if (typeof localStorage !== 'undefined') {
          const saved = localStorage.getItem('agent_models_cache');
          if (saved) cache = JSON.parse(saved);
          cache[cacheKey] = modelsList;
          localStorage.setItem('agent_models_cache', JSON.stringify(cache));
        }
        resolve(cache);
      }
    });
  },

  /**
   * Fetch all saved session records
   */
  async getSessions() {
    return new Promise((resolve) => {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(['agent_sessions_list'], (res) => {
          resolve(res.agent_sessions_list || []);
        });
      } else {
        const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('agent_sessions_list') : null;
        resolve(saved ? JSON.parse(saved) : []);
      }
    });
  },

  /**
   * Save or update a session record
   */
  async saveSession(sessionObj) {
    const sessions = await this.getSessions();
    const existingIdx = sessions.findIndex(s => s.id === sessionObj.id);

    if (existingIdx >= 0) {
      sessions[existingIdx] = { ...sessions[existingIdx], ...sessionObj };
    } else {
      sessions.unshift(sessionObj);
    }

    if (sessions.length > 50) sessions.pop();

    return new Promise((resolve) => {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ agent_sessions_list: sessions }, () => resolve(sessions));
      } else {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem('agent_sessions_list', JSON.stringify(sessions));
        }
        resolve(sessions);
      }
    });
  },

  /**
   * Delete a session record
   */
  async deleteSession(sessionId) {
    let sessions = await this.getSessions();
    sessions = sessions.filter(s => s.id !== sessionId);

    return new Promise((resolve) => {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ agent_sessions_list: sessions }, () => resolve(sessions));
      } else {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem('agent_sessions_list', JSON.stringify(sessions));
        }
        resolve(sessions);
      }
    });
  }
};
