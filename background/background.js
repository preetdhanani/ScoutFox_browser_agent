/**
 * Background Service Worker for ScoutFox AI Agent
 * Routes extension messages, maintains agent engine instance, manages port connections,
 * and dynamically tracks active tab switching when links or automation open new tabs.
 */

import { AgentEngine } from './agentEngine.js';
import { ApiClients } from './apiClients.js';
import { Logger } from '../utils/logger.js';

const agentEngine = new AgentEngine();

agentEngine.setStateChangeCallback((state) => {
  broadcastToSidepanel('STATE_UPDATE', state);
});

Logger.setBroadcastCallback((logEntry) => {
  broadcastToSidepanel('LOG_ENTRY', logEntry);
});

let activeSidepanelPorts = new Set();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'scoutfox_sidepanel' || port.name === 'strawberry_sidepanel') {
    activeSidepanelPorts.add(port);
    Logger.info('Background', 'ScoutFox Sidepanel UI connected.');

    port.onDisconnect.addListener(() => {
      activeSidepanelPorts.delete(port);
      Logger.info('Background', 'ScoutFox Sidepanel UI disconnected.');
    });

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
  }
});

function broadcastToSidepanel(type, payload) {
  for (const port of activeSidepanelPorts) {
    try {
      port.postMessage({ type, payload });
    } catch (e) {
      activeSidepanelPorts.delete(port);
    }
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
  const { action, payload } = request;

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
        agentEngine.startTask(payload.prompt, tab.id);
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
