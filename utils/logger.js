/**
 * Logger utility for ScoutFox Agentic Browser Extension
 * Outputs formatted console logs and broadcasts debug messages to Sidepanel UI safely.
 * Persists logs to storage to survive background service worker lifecycle restarts.
 */

const logsHistory = [];
let logBroadcastCallback = null;
let persistTimer = null;

function persistLogsToStorage() {
  if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local || typeof chrome.storage.local.set !== 'function') return;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      chrome.storage.local.set({ agent_logs_history: logsHistory.slice(-300) }, () => {
        if (chrome.runtime && chrome.runtime.lastError) void chrome.runtime.lastError;
      });
    } catch (_) {}
  }, 100);
}

// Auto-restore persisted logs on cold boot.
//
// This is async, and GET_AGENT_STATE used to answer with getLogsHistory() immediately -
// so a sidepanel resync landing before this restore finished got back an empty array, which
// the panel then trusted and used to overwrite whatever it had already shown. logsRestored
// lets any caller that needs the complete history wait for this to finish first, rather than
// racing it.
let resolveLogsRestored;
const logsRestored = new Promise((resolve) => { resolveLogsRestored = resolve; });

if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local && typeof chrome.storage.local.get === 'function') {
  try {
    chrome.storage.local.get(['agent_logs_history'], (res) => {
      if (chrome.runtime && chrome.runtime.lastError) void chrome.runtime.lastError;
      if (Array.isArray(res?.agent_logs_history) && res.agent_logs_history.length > 0) {
        const existingKeys = new Set(logsHistory.map(e => `${e.timestamp}_${e.message}`));
        const toAdd = res.agent_logs_history.filter(e => !existingKeys.has(`${e.timestamp}_${e.message}`));
        logsHistory.unshift(...toAdd);
        if (logsHistory.length > 300) logsHistory.splice(0, logsHistory.length - 300);
      }
      resolveLogsRestored();
    });
  } catch (_) {
    resolveLogsRestored();
  }
} else {
  resolveLogsRestored();
}

export const Logger = {
  setBroadcastCallback(cb) {
    logBroadcastCallback = cb;
  },

  getLogsHistory() {
    return logsHistory;
  },

  /**
   * Resolves once the cold-boot restore above has completed (or immediately, if
   * chrome.storage was unavailable). Callers that need the COMPLETE history - GET_AGENT_STATE
   * chief among them - must await this before reading getLogsHistory(), or they can return an
   * empty array while the restore is still in flight.
   */
  logsRestored() {
    return logsRestored;
  },

  clearLogs() {
    logsHistory.length = 0;
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local && typeof chrome.storage.local.remove === 'function') {
      chrome.storage.local.remove(['agent_logs_history'], () => {
        if (chrome.runtime && chrome.runtime.lastError) void chrome.runtime.lastError;
      });
    }
  },

  addLog(level, module, message, data = null, options = {}) {
    try {
      const timestamp = new Date().toLocaleTimeString();
      let dataStr = null;
      if (data) {
        if (typeof data === 'object') {
          try {
            dataStr = JSON.stringify(data, null, 2);
          } catch (e) {
            dataStr = String(data);
          }
        } else {
          dataStr = String(data);
        }
      }

      const entry = {
        timestamp,
        level,
        module,
        message: String(message || ''),
        data: dataStr
      };

      logsHistory.push(entry);
      if (logsHistory.length > 300) logsHistory.shift();

      persistLogsToStorage();

      if (logBroadcastCallback && !options.silent) {
        logBroadcastCallback(entry);
      }
    } catch (e) {
      // Prevent recursion
    }
  },

  log(module, message, data = null) {
    this.addLog('INFO', module, message, data);
    console.log(`[${module}]`, message, data || '');
  },

  info(module, message, data = null) {
    this.addLog('INFO', module, message, data);
    console.info(`[${module}]`, message, data || '');
  },

  warn(module, message, data = null) {
    this.addLog('WARN', module, message, data);
    console.warn(`[${module}]`, message, data || '');
  },

  error(module, message, error = null) {
    const errDetails = error?.message || error || '';
    this.addLog('ERROR', module, `${message} ${errDetails}`, error?.stack || null);
    console.error(`[${module}] ${message}`, error || '');
  },

  /**
   * Identical to warn(), except it never invokes the broadcast callback.
   * Use this for any log call made FROM WITHIN the broadcast callback's own call chain
   * (e.g. background.js's broadcastToSidepanel() diagnosing that it has zero listeners) —
   * routing that through the normal warn()/addLog() broadcast path calls the same
   * broadcast function again, recursively, since the caller's own de-duplication guard
   * cannot take effect until AFTER this call returns. Still persisted to logsHistory and
   * storage, so it still shows up once the panel reconnects — it just can't be pushed
   * live to a channel that, by definition, has nobody listening on it right now anyway.
   */
  warnSilent(module, message, data = null) {
    this.addLog('WARN', module, message, data, { silent: true });
    console.warn(`[${module}]`, message, data || '');
  }
};
