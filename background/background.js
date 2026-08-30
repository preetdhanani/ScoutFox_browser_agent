/**
 * Background Service Worker for ScoutFox AI Agent
 * Routes extension messages, maintains agent engine instance, manages port connections,
 * dynamically tracks active tab switching when links or automation open new tabs, and
 * defends against the MV3 service-worker lifecycle silently dropping in-flight tasks.
 *
 * KNOWN MV3 FAILURE MODE this file guards against:
 * The service worker can be terminated by Chrome (idle timeout, memory pressure) at ANY
 * point, including mid-task. When that happens, ALL in-memory state (agentEngine,
 * activeSidepanelPorts) is wiped and a brand-new instance of this whole module runs on
 * the next event. Any sidepanel that connected to the OLD instance is left holding a
 * dead `chrome.runtime.Port` — broadcastToSidepanel() would previously loop over zero
 * ports and silently do nothing, so the task kept running (real browser actions still
 * happening) while the UI (chat + logs) froze with no error, no warning, nothing.
 * Fix: (1) a keepalive alarm that greatly reduces how often the SW idles out mid-task,
 * (2) every dropped/empty broadcast is now logged so it is never silent, and
 * (3) the sidepanel side (see sidepanel.js) detects port disconnection and reconnects +
 * resyncs full state, so even if the SW does restart, the UI recovers automatically.
 */

import { AgentEngine } from './agentEngine.js';
import { ApiClients } from './apiClients.js';
import { Logger } from '../utils/logger.js';

// Catch anything that would otherwise die silently in the service worker's global scope.
self.addEventListener('error', (event) => {
  Logger.error('Background', '[UNCAUGHT_ERROR] Uncaught exception in service worker', event.error || event.message);
});
self.addEventListener('unhandledrejection', (event) => {
  Logger.error('Background', '[UNHANDLED_REJECTION] Unhandled promise rejection in service worker', event.reason);
});

const agentEngine = new AgentEngine();

agentEngine.setStateChangeCallback((state) => {
  broadcastToSidepanel('STATE_UPDATE', state);
});

Logger.setBroadcastCallback((logEntry) => {
  broadcastToSidepanel('LOG_ENTRY', logEntry);
});

let activeSidepanelPorts = new Set();
let lastBroadcastHadNoListeners = false;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'scoutfox_sidepanel' || port.name === 'strawberry_sidepanel') {
    activeSidepanelPorts.add(port);
    lastBroadcastHadNoListeners = false;
    Logger.info('Background', `[PORT_CONNECT] Sidepanel UI connected. Active ports: ${activeSidepanelPorts.size}`);

    port.onDisconnect.addListener(() => {
      activeSidepanelPorts.delete(port);
      Logger.info('Background', `[PORT_DISCONNECT] Sidepanel UI disconnected. Active ports: ${activeSidepanelPorts.size}`);
    });

    try {
      port.postMessage({
        type: 'STATE_UPDATE',
        payload: {
          status: agentEngine.status,
          stepCount: agentEngine.stepCount,
          task: agentEngine.currentTask,
          history: agentEngine.history,
          planSteps: agentEngine.planSteps,
          currentPhase: agentEngine.currentPhase,
          logs: Logger.getLogsHistory()
        }
      });
    } catch (err) {
      Logger.error('Background', '[PORT_CONNECT] Failed to push initial state to newly connected port', err);
    }
  }
});

function broadcastToSidepanel(type, payload) {
  if (activeSidepanelPorts.size === 0) {
    // This is the exact silent-freeze scenario: the agent loop keeps running and doing
    // real browser work, but there is nobody left to receive the update. Log it loudly
    // (once per gap, not per message, to avoid flooding) so it always shows up in the
    // persisted log history even though the UI that would normally display it is gone.
    if (!lastBroadcastHadNoListeners) {
      Logger.warn('Background', `[BROADCAST_DROPPED] No sidepanel connected — "${type}" updates are being generated but nothing can receive them until the panel reconnects.`);
      lastBroadcastHadNoListeners = true;
    }
    return;
  }

  for (const port of activeSidepanelPorts) {
    try {
      port.postMessage({ type, payload });
    } catch (e) {
      Logger.warn('Background', '[BROADCAST_ERROR] Dropping dead port that failed to receive a message', e.message);
      activeSidepanelPorts.delete(port);
    }
  }
}

/**
 * Service-worker keepalive: Chrome can suspend an MV3 service worker after ~30s with no
 * extension-API activity, which is easy to hit during the plain `setTimeout` delay between
 * agent loop steps. A recurring alarm counts as activity and greatly reduces how often the
 * worker is killed mid-task. This does not GUARANTEE the worker survives (Chrome can still
 * kill it under memory pressure), which is why the sidepanel reconnect logic exists as the
 * correctness backstop regardless of whether this mitigation helps in a given run.
 */
if (typeof chrome !== 'undefined' && chrome.alarms) {
  try {
    chrome.alarms.create('scoutfox_keepalive', { periodInMinutes: 0.5 });
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === 'scoutfox_keepalive') {
        // Intentionally trivial — the point is just to give the service worker a reason
        // to be "active" on a tight cadence so Chrome doesn't idle it out mid-task.
        if (agentEngine.status === 'running') {
          Logger.info('Background', `[KEEPALIVE] Heartbeat (task running, step ${agentEngine.stepCount}).`);
        }
      }
    });
  } catch (err) {
    Logger.warn('Background', '[KEEPALIVE] Could not register keepalive alarm', err);
  }
}

// Dynamically track active tab switching (e.g. when automation or link opens a new tab)
if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.onActivated) {
  chrome.tabs.onActivated.addListener((activeInfo) => {
    if (agentEngine && agentEngine.status === 'running') {
      chrome.tabs.get(activeInfo.tabId, (tab) => {
        if (tab && isValidWebTab(tab)) {
          Logger.info('Background', `[TAB_AUTO_SWITCH] Switched active automation tracking to Tab ID [${tab.id}] (${tab.title || tab.url})`);
          agentEngine.activeTabId = tab.id;
        }
      });
    }
  });
}

// Dynamically track new tab creation
if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.onCreated) {
  chrome.tabs.onCreated.addListener((tab) => {
    if (agentEngine && agentEngine.status === 'running' && tab.id) {
      setTimeout(() => {
        chrome.tabs.get(tab.id, (createdTab) => {
          if (createdTab && isValidWebTab(createdTab)) {
            Logger.info('Background', `[NEW_TAB_DETECTED] Automation switching to newly opened Tab ID [${createdTab.id}]`);
            agentEngine.activeTabId = createdTab.id;
          }
        });
      }, 500);
    }
  });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  let handled;
  try {
    handled = routeMessage(request, sender, sendResponse);
  } catch (err) {
    Logger.error('Background', `[MESSAGE_ROUTER_ERROR] Uncaught exception handling action [${request?.action}]`, err);
    try { sendResponse({ success: false, error: `Internal error: ${err.message}` }); } catch (_) { /* channel already closed */ }
    return false;
  }
  return handled;
});

function routeMessage(request, sender, sendResponse) {
  const { action, payload } = request;

  if (action === 'CLIENT_ERROR') {
    // Sidepanel UI / content scripts forward their own uncaught errors here so that
    // NOTHING fails invisibly — everything ends up in the same central log history.
    Logger.error('ClientError', `[${payload?.source || 'unknown'}] ${payload?.message || 'Unspecified client error'}`, payload?.stack || null);
    sendResponse({ success: true });
    return true;
  }

  if (action === 'FETCH_MODELS') {
    const forceRefresh = !!payload?.forceRefresh;
    ApiClients.fetchAvailableModels(payload, forceRefresh)
      .then(models => sendResponse({ success: true, models }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (action === 'GET_AGENT_STATE') {
    sendResponse({
      status: agentEngine.status,
      stepCount: agentEngine.stepCount,
      task: agentEngine.currentTask,
      history: agentEngine.history,
      planSteps: agentEngine.planSteps,
      currentPhase: agentEngine.currentPhase,
      logs: Logger.getLogsHistory()
    });
    return true;
  }

  if (action === 'START_TASK') {
    getActiveTab()
      .then((tab) => {
        if (!tab) {
          throw new Error('No active web browser tab found. Please open a webpage like https://google.com first.');
        }
        // Fire-and-forget by design (the loop runs for the task's whole lifetime), but
        // a rejection here was previously a fully silent unhandled promise rejection —
        // it must still land in the log history even though nothing awaits this call.
        agentEngine.startTask(payload.prompt, tab.id).catch((err) => {
          Logger.error('Background', '[START_TASK_ERROR] Uncaught exception starting task', err);
        });
        sendResponse({ success: true, tabId: tab.id });
      })
      .catch((err) => {
        Logger.error('Background', 'Failed to start task', err);
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  if (action === 'PAUSE_TASK') {
    agentEngine.pause();
    sendResponse({ success: true });
    return true;
  }

  if (action === 'RESUME_TASK') {
    agentEngine.resume();
    sendResponse({ success: true });
    return true;
  }

  if (action === 'STOP_TASK') {
    agentEngine.stop();
    sendResponse({ success: true });
    return true;
  }

  if (action === 'CLEAR_HISTORY') {
    agentEngine.clearHistory();
    sendResponse({ success: true });
    return true;
  }
});

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tabs && tabs.length > 0) {
    const tab = tabs[0];
    if (isValidWebTab(tab)) return tab;
  }

  const allTabs = await chrome.tabs.query({ active: true });
  const validTab = allTabs.find(isValidWebTab);
  if (validTab) return validTab;

  const anyWebTabs = await chrome.tabs.query({ currentWindow: true });
  return anyWebTabs.find(isValidWebTab) || null;
}

function isValidWebTab(tab) {
  if (!tab || !tab.url) return false;
  const url = tab.url;
  return !url.startsWith('chrome://') && 
         !url.startsWith('chrome-extension://') && 
         !url.startsWith('edge://') && 
         !url.startsWith('about:');
}
