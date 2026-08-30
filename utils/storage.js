/**
 * Storage utility for Agentic Browser Extension
 * Manages settings, multi-session history, and provider model caching.
 */

export const DEFAULT_SETTINGS = {
  provider: 'gemini',
  baseUrl: 'http://localhost:11434',
  apiKey: '',
  model: 'gemini-1.5-flash',
  temperature: 0.1,
  maxSteps: 25,
  actionDelayMs: 1000,
  showElementBadges: true,
  autoScroll: true,
  systemInstructions: 'You are Strawberry, an autonomous web browsing AI agent. Your goal is to help the user complete tasks on the web efficiently and accurately.'
};

export const Storage = {
  /**
   * Load user settings
   */
  async getSettings() {
    return new Promise((resolve) => {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(['agent_settings'], (result) => {
          resolve({ ...DEFAULT_SETTINGS, ...(result.agent_settings || {}) });
        });
      } else {
        const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('agent_settings') : null;
        resolve(saved ? { ...DEFAULT_SETTINGS, ...JSON.parse(saved) } : DEFAULT_SETTINGS);
      }
    });
  },

  /**
   * Save user settings
   */
  async saveSettings(newSettings) {
    const current = await this.getSettings();
    const updated = { ...current, ...newSettings };
    
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
