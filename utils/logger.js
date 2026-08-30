/**
 * Logger utility for ScoutFox Agentic Browser Extension
 * Outputs formatted console logs and broadcasts debug messages to Sidepanel UI safely.
 * Persists logs to storage to survive background service worker lifecycle restarts.
 */

const logsHistory = [];
let logBroadcastCallback = null;

// Restore logs from storage on startup
if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
  chrome.storage.local.get(['agent_logs_history'], (res) => {
    if (res && Array.isArray(res.agent_logs_history)) {
      logsHistory.push(...res.agent_logs_history.slice(-300));
    }
  });
}

function persistLogsToStorage() {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ agent_logs_history: logsHistory.slice(-300) });
    }
  } catch (e) {
    // Ignore storage write errors during shutdown
  }
}

export const Logger = {
  setBroadcastCallback(cb) {
    logBroadcastCallback = cb;
  },

  getLogsHistory() {
    return logsHistory;
  },

  clearLogs() {
    logsHistory.length = 0;
    persistLogsToStorage();
  },

  addLog(level, module, message, data = null) {
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

      if (logBroadcastCallback) {
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
  }
};
