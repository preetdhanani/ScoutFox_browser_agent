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
          // Logs intentionally omitted — the panel pulls them via GET_AGENT_STATE immediately
          // after connecting, so duplicating the ring here just doubles the payload.
          stateVersion: agentEngine.stateVersion,
          bootId: agentEngine.bootId
        }
      });
    } catch (err) {
      Logger.warn('Background', 'Failed sending initial state update on port connect', err);
    }
  }
});

/**
 * Fan a message out to every connected sidepanel.
 *
 * Re-entrancy is the hazard here: Logger broadcasts each new entry through this very function,
 * so ANY log call made from inside it calls it again. Two rules keep that finite:
 *   - remove a failing port from the set BEFORE logging about it, or the recursive call
 *     retries the same dead port and recurses without bound;
 *   - use Logger.warnSilent for diagnostics about the broadcast channel itself, so the entry
 *     is still recorded and persisted but is not pushed back through this function.
 * The isBroadcasting flag is a final backstop.
 */
let isBroadcasting = false;

function broadcastToSidepanel(type, payload) {
  if (isBroadcasting) return;

  if (activeSidepanelPorts.size === 0) {
    if (!lastBroadcastHadNoListeners) {
      lastBroadcastHadNoListeners = true; // set BEFORE logging
      Logger.warnSilent('Background', `[BROADCAST_DROPPED] No sidepanel connected — "${type}" updates are being generated but nothing can receive them until the panel reconnects.`);
    }
    return;
  }

  lastBroadcastHadNoListeners = false;
  isBroadcasting = true;
  try {
    // Snapshot the set: the loop below mutates it on failure.
    for (const port of Array.from(activeSidepanelPorts)) {
      try {
        port.postMessage({ type, payload });
      } catch (err) {
        activeSidepanelPorts.delete(port); // remove FIRST, then report
        Logger.warnSilent('Background', `[BROADCAST_ERROR] Dropped a dead sidepanel port while sending "${type}": ${err.message}. Active ports: ${activeSidepanelPorts.size}`);
      }
    }
  } finally {
    isBroadcasting = false;
  }
}

/**
 * Keeping the MV3 service worker alive while a task is running.
 *
 * Chrome terminates an extension service worker after ~30s of inactivity. An in-flight
 * `await` on an LLM call does NOT count as activity, so a slow model response is enough to
 * get the whole agent loop killed mid-step. Two independent mechanisms defend against that:
 *
 *   1. A ~20s interval invoking a trivial extension API. Each call resets the idle timer.
 *      This is the primary defence and is what actually keeps a running task alive.
 *   2. A chrome.alarms heartbeat. Alarms survive worker termination, so if the worker is
 *      killed anyway (memory pressure, or Chrome's hard cap on keepalive), the alarm
 *      re-wakes it and the restart becomes visible in the log instead of silent.
 *
 * Both are scoped strictly to an active task — nothing runs while the agent is idle.
 */
const KEEPALIVE_ALARM_NAME = 'scoutfox_keepalive';
const KEEPALIVE_INTERVAL_MS = 20000;
let keepaliveIntervalId = null;

function syncKeepaliveAlarm(agentStatus) {
  const shouldRun = agentStatus === 'running' || agentStatus === 'paused';

  if (shouldRun && keepaliveIntervalId === null) {
    keepaliveIntervalId = setInterval(() => {
      try {
        // Any extension API round-trip resets the service worker's idle timer.
        chrome.runtime.getPlatformInfo(() => { void chrome.runtime.lastError; });
      } catch (err) {
        Logger.warn('Background', '[KEEPALIVE] Idle-timer ping failed', err);
      }
    }, KEEPALIVE_INTERVAL_MS);
    Logger.info('Background', '[KEEPALIVE_ON] Task active — holding the service worker awake.');
  } else if (!shouldRun && keepaliveIntervalId !== null) {
    clearInterval(keepaliveIntervalId);
    keepaliveIntervalId = null;
    Logger.info('Background', '[KEEPALIVE_OFF] No task active — releasing the service worker.');
  }

  if (typeof chrome === 'undefined' || !chrome.alarms) return;
  try {
    if (shouldRun) {
      chrome.alarms.get(KEEPALIVE_ALARM_NAME, (alarm) => {
        if (chrome.runtime.lastError) {
          Logger.warn('Background', '[KEEPALIVE] Could not read keepalive alarm', chrome.runtime.lastError.message);
          return;
        }
        if (!alarm) chrome.alarms.create(KEEPALIVE_ALARM_NAME, { periodInMinutes: 0.5 });
      });
    } else {
      chrome.alarms.clear(KEEPALIVE_ALARM_NAME);
    }
  } catch (err) {
    Logger.warn('Background', '[KEEPALIVE] Could not sync keepalive alarm', err);
  }
}

if (typeof chrome !== 'undefined' && chrome.alarms) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === KEEPALIVE_ALARM_NAME) {
      Logger.info('Background', `[KEEPALIVE] Heartbeat — status=${agentEngine.status}, step ${agentEngine.stepCount}.`);
      // If the alarm fires while a task is supposedly running but the interval ping is gone,
      // the worker was terminated and restarted. Re-arm so the task is not left unprotected.
      if (agentEngine.status === 'running' && keepaliveIntervalId === null) {
        syncKeepaliveAlarm(agentEngine.status);
      }
    }
  });
}

// Every service-worker boot is logged, so an unexplained mid-task restart is visible
// in the log pane instead of appearing as the UI mysteriously going quiet.
Logger.info('Background', `[WORKER_BOOT] Service worker started (boot ${agentEngine.bootId.slice(0, 8)}). MV3 restarts the worker frequently — this line marks a fresh incarnation.`);

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
      stateVersion: agentEngine.stateVersion,
      bootId: agentEngine.bootId
    });
    return true;
  }

  if (action === 'START_TASK') {
    getActiveTab()
      .then((tab) => {
        if (!tab) {
          throw new Error('No automatable tab found. ScoutFox cannot script Chrome\'s internal pages (chrome://…) — open a normal website such as https://google.com and try again.');
        }
        agentEngine.startTask(payload.prompt, tab.id).catch((err) => {
          Logger.error('Background', '[START_TASK_ERROR] Uncaught exception starting task', err);
        });
        sendResponse({ success: true, tabId: tab.id, tabUrl: tab.url, tabTitle: tab.title });
      })
      .catch((err) => {
        Logger.error('Background', 'Failed to start task', err);
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  // These now report whether they actually did anything, instead of always answering success.
  // A Resume that finds nothing to resume (common after a worker restart) must say so.
  if (action === 'PAUSE_TASK') {
    sendResponse(agentEngine.pause());
    return true;
  }

  if (action === 'RESUME_TASK') {
    sendResponse(agentEngine.resume());
    return true;
  }

  if (action === 'STOP_TASK') {
    sendResponse(agentEngine.stop());
    return true;
  }

  if (action === 'CLEAR_HISTORY') {
    agentEngine.clearHistory();
    sendResponse({ success: true });
    return true;
  }

  // Anything unrecognised used to fall off the end returning undefined, which closes the
  // message channel with no reply — the caller's callback then fires with res === undefined
  // and no lastError, indistinguishable from success.
  Logger.warn('Background', `[UNKNOWN_ACTION] Received an unrecognised message action: "${action}". Ignoring.`);
  sendResponse({ success: false, error: `Unknown action: ${action}` });
  return true;
}

/**
 * Pick the tab to automate.
 *
 * The focused tab wins when it is automatable. When it is not — most often because the user
 * is sitting on chrome://extensions — we fall back to another tab in the window, but that
 * substitution is announced loudly. Silently driving a page the user is not looking at is
 * confusing enough that it reads as a bug.
 */
async function getActiveTab() {
  const focused = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0] || null;
  if (focused && isValidWebTab(focused)) return focused;

  if (focused) {
    Logger.warn('Background', `[TAB_NOT_AUTOMATABLE] The focused tab (${focused.url || 'unknown URL'}) cannot be automated — browsers block extensions from scripting internal pages. Looking for another tab.`);
  }

  const validTab =
    (await chrome.tabs.query({ active: true })).find(isValidWebTab) ||
    (await chrome.tabs.query({ currentWindow: true })).find(isValidWebTab) ||
    null;

  if (validTab) {
    Logger.warn('Background', `[TAB_SUBSTITUTED] Running against tab [${validTab.id}] (${validTab.url}) instead, because the focused tab cannot be scripted. Switch to the page you want automated if this is not it.`);
  }
  return validTab;
}

function isValidWebTab(tab) {
  if (!tab || !tab.url) return false;
  const url = tab.url.toLowerCase();

  if (url.includes('chromewebstore.google.com') || url.includes('chrome.google.com/webstore')) {
    return false;
  }

  return !url.startsWith('chrome://') && 
         !url.startsWith('chrome-extension://') && 
         !url.startsWith('chrome-search://') && 
         !url.startsWith('chrome-untrusted://') && 
         !url.startsWith('edge://') && 
         !url.startsWith('about:') && 
         !url.startsWith('view-source:') && 
         !url.startsWith('devtools:') && 
         !url.startsWith('data:');
}
