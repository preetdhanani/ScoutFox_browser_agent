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

// Clean network request buffers when tab is closed & track ScoutFox tab group removal
if (typeof chrome !== 'undefined') {
  if (chrome.tabs && chrome.tabs.onRemoved) {
    chrome.tabs.onRemoved.addListener((tabId) => {
      if (agentEngine.networkBuffers.has(tabId)) {
        agentEngine.networkBuffers.delete(tabId);
      }
    });
  }

  if (chrome.tabGroups && chrome.tabGroups.onRemoved) {
    chrome.tabGroups.onRemoved.addListener((group) => {
      if (group && group.id === agentEngine.scoutFoxGroupId) {
        Logger.info('Background', `[TAB_SANDBOX] ScoutFox tab group [${group.id}] was closed by user.`);
        agentEngine.scoutFoxGroupId = null;
        agentEngine.persistState();
      }
    });
  }
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

/**
 * Scope the side panel to one tab at a time, not the whole browser.
 *
 * manifest.json declares side_panel.default_path, which registers the panel globally on
 * EVERY tab as Chrome's fallback. The per-tab enable/disable calls below (onConnect,
 * onCreated, onActivated) are not enough to override that on their own - this is a
 * documented Chrome limitation, not a logic bug: setOptions({tabId, enabled:false}) does not
 * reliably close a panel a global default_path is still offering everywhere else. The fix
 * Chrome's own team and extension samples describe is to explicitly disable the panel
 * EVERYWHERE at startup, so nothing is ever enabled except the specific tab(s) this code
 * turns on. https://github.com/GoogleChrome/chrome-extensions-samples/issues/987
 */
if (typeof chrome !== 'undefined' && chrome.sidePanel && chrome.sidePanel.setOptions) {
  chrome.sidePanel.setOptions({ enabled: false }, () => {
    try { if (chrome.runtime && chrome.runtime.lastError) void chrome.runtime.lastError; } catch (_) {}
  });
}

// openPanelOnActionClick:true and chrome.action.onClicked are mutually exclusive by Chrome's
// own design - the former means the panel auto-opens globally on click and onClicked NEVER
// fires. That auto-open used the global default_path with no tab scoping applied yet, which
// is exactly the "shows on every tab" symptom. false (Chrome's own default; set explicitly so
// the intent reads plainly) makes onClicked fire instead, and its handler below enables the
// panel for ONLY the clicked tab before opening it.
if (typeof chrome !== 'undefined' && chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
}

// Handle explicit extension action icon clicks to group current active tab immediately
if (typeof chrome !== 'undefined' && chrome.action && chrome.action.onClicked) {
  chrome.action.onClicked.addListener((tab) => {
    if (!(tab && tab.id)) return;

    // Enable + open the panel for the clicked tab UNCONDITIONALLY - isValidWebTab exists to
    // gate whether a tab can be SCRIPTED for automation (content-script injection), not
    // whether the panel UI can be shown at all. Gating this whole handler on it meant clicking
    // the icon while sitting on chrome://newtab - an entirely ordinary starting point for a
    // browser session - silently did nothing: setOptions and open() never even ran.
    if (chrome.sidePanel && chrome.sidePanel.setOptions) {
      chrome.sidePanel.setOptions({ tabId: tab.id, path: 'sidepanel/sidepanel.html', enabled: true }, () => {
        try { if (chrome.runtime && chrome.runtime.lastError) void chrome.runtime.lastError; } catch (_) {}
      });
    }

    // MUST be called synchronously in this same tick, with nothing awaited above it. Chrome
    // only honors sidePanel.open() as a genuine response to the click's user gesture for as
    // long as the call stack stays synchronous; crossing even one await (ensureScoutFoxGroup
    // below does real async work - tabs.group, storage) loses that gesture and open() then
    // fails silently, since it's a fire-and-forget .catch(). That silent failure is exactly
    // what broke "click the icon to open the extension" the moment ensureScoutFoxGroup was
    // awaited ahead of this line. setOptions() above is fire-and-forget too (callback style,
    // not awaited), so it does not cross that boundary either.
    if (chrome.sidePanel && chrome.sidePanel.open) {
      chrome.sidePanel.open({ tabId: tab.id }).catch((err) => {
        Logger.warn('Background', '[SIDEPANEL_OPEN_FAILED] chrome.sidePanel.open() was rejected', err);
      });
    }

    // Automation sandboxing (tab grouping) only makes sense on a page that can actually be
    // scripted, so THIS is where isValidWebTab belongs - gating the panel opening at all was
    // the bug. Grouping has no gesture requirement either way, so it is safe to run after.
    if (isValidWebTab(tab)) {
      agentEngine.ensureScoutFoxGroup(tab.id).catch((err) => {
        Logger.warn('Background', '[TAB_SANDBOX_ERROR] ensureScoutFoxGroup failed on icon click', err);
      });
    }
  });
}

let activeSidepanelPorts = new Set();
let lastBroadcastHadNoListeners = false;

chrome.runtime.onConnect.addListener((port) => {
  // '_fresh' marks a first connection from a newly opened panel; the bare names are
  // reconnects. 'strawberry_sidepanel' is deliberate backwards compatibility for a panel
  // still running from a pre-rename build, not a leftover; it can go once no such panel
  // can still be open, i.e. one release after this one.
  const SIDEPANEL_PORTS = ['scoutfox_sidepanel', 'scoutfox_sidepanel_fresh', 'strawberry_sidepanel'];
  if (SIDEPANEL_PORTS.includes(port.name)) {
    activeSidepanelPorts.add(port);
    lastBroadcastHadNoListeners = false;
    Logger.info('Background', `[PORT_CONNECT] Sidepanel UI connected. Active ports: ${activeSidepanelPorts.size}`);

    port.onDisconnect.addListener(() => {
      activeSidepanelPorts.delete(port);
      Logger.info('Background', `[PORT_DISCONNECT] Sidepanel UI disconnected. Active ports: ${activeSidepanelPorts.size}`);
    });

    // Start fresh only when the panel is genuinely being OPENED, never on a reconnect.
    //
    // onConnect fires for both. Chrome reclaims an idle MV3 worker after ~30s, and the panel
    // reconnects automatically with backoff, so a finished run reliably hit this path with
    // status 'idle' and had its results deleted while the user was still reading them. It
    // also defeated restoreState(), which maps a persisted running/paused back to a
    // non-running status after a cold boot, only for the next reconnect to wipe it.
    //
    // The panel tells us which it is via the port name; anything else is treated as a
    // reconnect, so the safe default is to keep the history.
    const isFreshOpen = port.name.endsWith('_fresh');
    // '_fresh' is only trustworthy when THIS is the sole connected panel. The tab-creation
    // handler below auto-enables the side panel for every tab it groups into ScoutFox, and
    // any of those becoming the active tab loads an entirely separate panel document with its
    // own honest hasConnectedBefore=false - its first connection is genuinely fresh from ITS
    // own point of view, with no way to know a sibling panel is already connected and showing
    // a result the user is still reading. Without this guard that sibling document's honest
    // first-open silently wiped the shared session out from under the panel actually in use.
    const isOnlyConnection = activeSidepanelPorts.size === 1;
    if (isFreshOpen && agentEngine.status === 'idle') {
      if (isOnlyConnection) {
        Logger.info('Background', '[SESSION_FRESH] Panel opened while idle. Starting a clean session.');
        agentEngine.clearHistory();
      } else {
        Logger.warn('Background', `[SESSION_FRESH_SUPPRESSED] A panel opened fresh while ${activeSidepanelPorts.size - 1} other panel(s) were already connected. Not clearing - another panel may still be showing this session.`);
      }
    }

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
          stateVersion: agentEngine.stateVersion,
          bootId: agentEngine.bootId,
          scoutFoxGroupId: agentEngine.scoutFoxGroupId
        }
      });
    } catch (err) {
      Logger.warn('Background', 'Failed sending initial state update on port connect', err);
    }

    // Auto-label opening tab into 'ScoutFox' tab group immediately on sidepanel open
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      const activeTab = tabs && tabs[0];
      if (activeTab && isValidWebTab(activeTab)) {
        agentEngine.ensureScoutFoxGroup(activeTab.id).then((groupId) => {
          if (groupId && typeof chrome !== 'undefined' && chrome.sidePanel && chrome.sidePanel.setOptions) {
            chrome.sidePanel.setOptions({ tabId: activeTab.id, path: 'sidepanel/sidepanel.html', enabled: true }, () => {
              try { if (chrome.runtime && chrome.runtime.lastError) void chrome.runtime.lastError; } catch (_) {}
            });
          }
        }).catch(() => {});
      }
    });
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

// Track active tab switching when links open new tabs & auto-group into ScoutFox Sandbox
if (typeof chrome !== 'undefined' && chrome.tabs) {
  chrome.tabs.onCreated.addListener((tab) => {
    if (agentEngine.scoutFoxGroupId && typeof chrome.tabs.group === 'function') {
      chrome.tabs.group({ tabIds: tab.id, groupId: agentEngine.scoutFoxGroupId }, () => {
        try { if (chrome.runtime && chrome.runtime.lastError) void chrome.runtime.lastError; } catch (_) {}
        Logger.info('Background', `[TAB_SANDBOX] Auto-grouped newly created Tab ID [${tab.id}] into 'ScoutFox' tab group [${agentEngine.scoutFoxGroupId}]`);
        if (typeof chrome.sidePanel !== 'undefined' && chrome.sidePanel.setOptions) {
          chrome.sidePanel.setOptions({ tabId: tab.id, path: 'sidepanel/sidepanel.html', enabled: true }, () => {
            try { if (chrome.runtime && chrome.runtime.lastError) void chrome.runtime.lastError; } catch (_) {}
          });
        }
      });
    }

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

  // Scope side panel visibility: hide side panel when user switches to a tab outside the ScoutFox tab group
  if (chrome.tabs.onActivated) {
    chrome.tabs.onActivated.addListener(async (activeInfo) => {
      if (!agentEngine.scoutFoxGroupId || typeof chrome.sidePanel === 'undefined' || !chrome.sidePanel.setOptions) return;
      const tabId = activeInfo.tabId;

      try {
        const tab = await new Promise((resolve) => {
          chrome.tabs.get(tabId, (t) => {
            try { if (chrome.runtime && chrome.runtime.lastError) void chrome.runtime.lastError; } catch (_) {}
            resolve(t);
          });
        });

        if (tab) {
          const isInScoutFoxGroup = tab.groupId === agentEngine.scoutFoxGroupId;
          if (isInScoutFoxGroup) {
            chrome.sidePanel.setOptions({ tabId, path: 'sidepanel/sidepanel.html', enabled: true }, () => {
              try { if (chrome.runtime && chrome.runtime.lastError) void chrome.runtime.lastError; } catch (_) {}
            });
          } else {
            chrome.sidePanel.setOptions({ tabId, enabled: false }, () => {
              try { if (chrome.runtime && chrome.runtime.lastError) void chrome.runtime.lastError; } catch (_) {}
            });
          }
        }
      } catch (_) {}
    });
  }

  // Handle dynamic group changes (e.g. user dragging tab into/out of ScoutFox group)
  if (chrome.tabs.onUpdated) {
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (!agentEngine.scoutFoxGroupId || typeof chrome.sidePanel === 'undefined' || !chrome.sidePanel.setOptions) return;
      if (changeInfo.groupId !== undefined) {
        const isInScoutFoxGroup = changeInfo.groupId === agentEngine.scoutFoxGroupId;
        if (isInScoutFoxGroup) {
          chrome.sidePanel.setOptions({ tabId, path: 'sidepanel/sidepanel.html', enabled: true }, () => {
            try { if (chrome.runtime && chrome.runtime.lastError) void chrome.runtime.lastError; } catch (_) {}
          });
        } else {
          chrome.sidePanel.setOptions({ tabId, enabled: false }, () => {
            try { if (chrome.runtime && chrome.runtime.lastError) void chrome.runtime.lastError; } catch (_) {}
          });
        }
      }
    });
  }
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
    // Logger's own cold-boot restore is itself async. Answering with getLogsHistory()
    // immediately used to race it: a resync landing before the restore finished got back an
    // empty array, which the panel trusted and used to overwrite logs it had already shown.
    // Waiting here makes the answer always complete, so nothing downstream has to guess.
    Logger.logsRestored().then(() => {
      sendResponse({
        status: agentEngine.status,
        stepCount: agentEngine.stepCount,
        task: agentEngine.currentTask,
        history: agentEngine.history,
        planSteps: agentEngine.planSteps,
        currentPhase: agentEngine.currentPhase,
        logs: Logger.getLogsHistory(),
        stateVersion: agentEngine.stateVersion,
        bootId: agentEngine.bootId,
        scoutFoxGroupId: agentEngine.scoutFoxGroupId
      });
    });
    return true;
  }

  if (action === 'START_TASK') {
    // Claim synchronously, before any await, so a double-clicked send button cannot open two
    // concurrent runs. onMessage handlers are serialized, so this is the one point where the
    // second request is guaranteed to see the first.
    const claim = agentEngine.claimForTask();
    if (!claim.success) {
      sendResponse(claim);
      return true;
    }

    getActiveTab()
      .then((tab) => {
        if (!tab) {
          agentEngine.releaseTaskClaim();
          throw new Error('No automatable tab found. ScoutFox cannot script Chrome\'s internal pages (chrome://…) — open a normal website such as https://google.com and try again.');
        }
        agentEngine.startTask(payload.prompt, tab.id).catch((err) => {
          Logger.error('Background', '[START_TASK_ERROR] Uncaught exception starting task', err);
        });
        sendResponse({ success: true, tabId: tab.id, tabUrl: tab.url, tabTitle: tab.title });
      })
      .catch((err) => {
        agentEngine.releaseTaskClaim();
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

  if (action === 'CLEAR_LOGS') {
    // Logger keeps its own in-memory logsHistory independent of what the panel displays.
    // Without telling it too, the next log call's persistLogsToStorage() would rewrite
    // everything the panel just cleared straight back into storage.
    Logger.clearLogs();
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
 * Prioritizes tabs inside the active 'ScoutFox' Tab Group sandbox when active.
 */
async function getActiveTab() {
  // 1. ALWAYS prioritize the user's currently focused active tab in the window!
  const focused = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0] || 
                  (await chrome.tabs.query({ active: true, currentWindow: true }))[0] || null;

  if (focused && isValidWebTab(focused)) {
    return focused;
  }

  // 2. If focused tab is in ScoutFox group and valid:
  if (agentEngine.scoutFoxGroupId && typeof chrome.tabs.query === 'function') {
    try {
      const groupTabs = await chrome.tabs.query({ groupId: agentEngine.scoutFoxGroupId });
      const validInGroup = groupTabs.find(isValidWebTab);
      if (validInGroup) return validInGroup;
    } catch (_) {}
  }

  if (focused) {
    Logger.warn('Background', `[TAB_NOT_AUTOMATABLE] The focused tab (${focused.url || 'unknown URL'}) cannot be automated — browsers block extensions from scripting internal pages. Looking for another tab.`);
  }

  const validTab =
    (await chrome.tabs.query({ active: true })).find(isValidWebTab) ||
    (await chrome.tabs.query({ currentWindow: true })).find(isValidWebTab) ||
    null;

  if (validTab) {
    Logger.warn('Background', `[TAB_SUBSTITUTED] Running against tab [${validTab.id}] (${validTab.url}) instead, because the focused tab cannot be scripted. Switch to the page you want automated if this is not it.`);
    return validTab;
  }

  // AUTO-CREATE FRESH WEB TAB FALLBACK ONLY IF sitting on chrome:// internal page:
  Logger.info('Background', '[AUTO_CREATE_TAB] No scriptable web tab found. Auto-opening a fresh tab to https://www.google.com...');
  const newTab = await new Promise((resolve) => {
    if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.create) {
      chrome.tabs.create({ url: 'https://www.google.com', active: true }, (t) => {
        resolve(t);
      });
    } else {
      resolve({ id: 999, url: 'https://www.google.com' });
    }
  });

  if (agentEngine && agentEngine.waitForTabComplete) {
    await agentEngine.waitForTabComplete(newTab.id, 4000);
  }

  return newTab;
}

function isValidWebTab(tab) {
  if (!tab || !tab.url) return false;
  const url = tab.url;
  return !url.startsWith('chrome://') && 
         !url.startsWith('chrome-extension://') && 
         !url.startsWith('edge://') && 
         !url.startsWith('about:');
}
