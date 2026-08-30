/**
 * Background Service Worker for ScoutFox AI Agent
 * Routes extension messages, maintains agent engine instance, manages port connections,
 * dynamically tracks active tab switching when links or automation open new tabs, and
 * defends against the MV3 service-worker lifecycle silently dropping in-flight tasks.
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

// Clean network request buffers when tab is closed
if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    if (agentEngine.networkBuffers.has(tabId)) {
      agentEngine.networkBuffers.delete(tabId);
    }
  });
}

// Initialize declarativeNetRequest rules for AgentRouter network-layer header spoofing
if (typeof chrome !== 'undefined' && chrome.declarativeNetRequest) {
  try {
    chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [8888],
      addRules: [
        {
          id: 8888,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [
              { header: 'user-agent', operation: 'set', value: 'claude-cli/2.1.158 (external, sdk-cli)' },
              { header: 'x-app', operation: 'set', value: 'cli' }
            ]
          },
          condition: {
            urlFilter: '*://agentrouter.org/*',
            resourceTypes: ['xmlhttprequest']
          }
        }
      ]
    });
    Logger.info('Background', '[DNR] Active declarativeNetRequest rule set for AgentRouter (agentrouter.org)');
  } catch (err) {
    Logger.warn('Background', '[DNR_WARN] Could not initialize declarativeNetRequest rules', err);
  }
}

agentEngine.setStateChangeCallback((state) => {
  broadcastToSidepanel('STATE_UPDATE', state);
  syncKeepaliveAlarm(state.status);
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
          logs: Logger.getLogsHistory(),
          stateVersion: agentEngine.stateVersion
        }
      });
    } catch (err) {
      Logger.warn('Background', 'Failed sending initial state update on port connect', err);
    }
  }
});

function broadcastToSidepanel(type, payload) {
  if (activeSidepanelPorts.size === 0) {
    if (!lastBroadcastHadNoListeners) {
      lastBroadcastHadNoListeners = true;
      Logger.warn('Background', `[BROADCAST_DROPPED] No sidepanel connected — "${type}" updates are being generated but nothing can receive them until the panel reconnects.`);
    }
    return;
  }

  lastBroadcastHadNoListeners = false;
  activeSidepanelPorts.forEach((port) => {
    try {
      port.postMessage({ type, payload });
    } catch (err) {
      Logger.warn('Background', 'Error posting to sidepanel port', err);
      activeSidepanelPorts.delete(port);
    }
  });
}

function syncKeepaliveAlarm(agentStatus) {
  if (typeof chrome === 'undefined' || !chrome.alarms) return;
  if (agentStatus === 'running') {
    chrome.alarms.get('scoutfox_keepalive', (alarm) => {
      if (!alarm) {
        chrome.alarms.create('scoutfox_keepalive', { periodInMinutes: 0.5 });
      }
    });
  } else {
    chrome.alarms.clear('scoutfox_keepalive');
  }
}

if (typeof chrome !== 'undefined' && chrome.alarms) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'scoutfox_keepalive') {
      Logger.info('Background', `[KEEPALIVE] Heartbeat (task running, step ${agentEngine.stepCount}).`);
    }
  });
}

// Track active tab switching when links open new tabs
if (typeof chrome !== 'undefined' && chrome.tabs) {
  chrome.tabs.onCreated.addListener((tab) => {
    if (agentEngine.status === 'running') {
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

  if (action === 'NET_REQUEST_RECORDED') {
    const tabId = sender.tab ? sender.tab.id : agentEngine.activeTabId;
    agentEngine.recordNetworkRequest(tabId, payload);
    sendResponse({ success: true });
    return true;
  }

  if (action === 'CLIENT_ERROR') {
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
      logs: Logger.getLogsHistory(),
      stateVersion: agentEngine.stateVersion
    });
    return true;
  }

  if (action === 'START_TASK') {
    getActiveTab()
      .then((tab) => {
        if (!tab) {
          throw new Error('No active web browser tab found. Please open a webpage like https://google.com first.');
        }
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
}

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
