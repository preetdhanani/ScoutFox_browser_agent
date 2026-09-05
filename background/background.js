/**
 * Background Service Worker for ScoutFox AI Agent
 * Routes extension messages, maintains one AgentEngine session PER BROWSER WINDOW, manages
 * port connections, dynamically tracks active tab switching when links or automation open new
 * tabs, and defends against the MV3 service-worker lifecycle silently dropping in-flight tasks.
 *
 * Session model: opening the extension in a window starts (or resumes) that window's OWN,
 * fully independent session - its own ScoutFox tab group, its own history, its own running
 * task, its own Stop/Pause. Two windows can automate different tabs at the same time without
 * ever seeing or touching each other's tabs. Every AgentEngine method already operates on
 * "this" instance's own state (history, status, tab group, etc.), so the only thing this file
 * adds is: which engine instance a given event or message belongs to, resolved from whichever
 * window it actually came from - never assumed to be a single global one.
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

/**
 * windowId -> { engine: AgentEngine, ports: Set<Port> }
 *
 * One entry is created the first time a window's panel connects or its toolbar icon is
 * clicked, and removed when that window closes (see chrome.windows.onRemoved below). A window
 * that never opened ScoutFox has no entry at all - tab/window events for it are no-ops.
 */
const sessions = new Map();

function getOrCreateSession(windowId) {
  let session = sessions.get(windowId);
  if (session) return session;

  const engine = new AgentEngine(windowId);
  session = { engine, ports: new Set(), lastBroadcastHadNoListeners: false };
  sessions.set(windowId, session);

  // Each window's engine broadcasts ONLY to that window's own connected panels - never to a
  // different window's, which is exactly the isolation this whole session model exists for.
  engine.setStateChangeCallback((state) => {
    broadcastToSession(session, 'STATE_UPDATE', state);
    syncKeepaliveAlarm();
  });

  Logger.info('Background', `[SESSION_CREATED] New session for window [${windowId}].`);
  return session;
}

// Clean network request buffers when tab is closed & track ScoutFox tab group removal.
// Both search every session rather than assuming a single global engine owns the tab/group -
// with one engine per window, ownership has to be looked up, not assumed.
if (typeof chrome !== 'undefined') {
  if (chrome.tabs && chrome.tabs.onRemoved) {
    chrome.tabs.onRemoved.addListener((tabId) => {
      for (const session of sessions.values()) {
        if (session.engine.networkBuffers.has(tabId)) {
          session.engine.networkBuffers.delete(tabId);
        }
      }
    });
  }

  if (chrome.tabGroups && chrome.tabGroups.onRemoved) {
    chrome.tabGroups.onRemoved.addListener((group) => {
      if (!group) return;
      for (const [windowId, session] of sessions.entries()) {
        if (session.engine.scoutFoxGroupIds.get(windowId) === group.id) {
          Logger.info('Background', `[TAB_SANDBOX] ScoutFox tab group [${group.id}] was closed by user (window [${windowId}]).`);
          session.engine.scoutFoxGroupIds.delete(windowId);
          session.engine.persistState();
        }
      }
    });
  }

  // A closed window ends its session outright - there is nothing left to automate, and
  // keeping its engine/storage around would only leak memory and stale persisted state.
  if (chrome.windows && chrome.windows.onRemoved) {
    chrome.windows.onRemoved.addListener((windowId) => {
      const session = sessions.get(windowId);
      if (!session) return;
      sessions.delete(windowId);
      AgentEngine.forgetWindow(windowId);
      Logger.info('Background', `[SESSION_CLOSED] Window [${windowId}] closed. Session and its persisted state removed.`);
      syncKeepaliveAlarm();
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

// Logs stay a single, shared, cross-window stream - a deliberate scope decision, not an
// oversight. The user's request was about ACTION isolation (session, tab group, history), not
// about hiding one window's debug telemetry from another; splitting Logger per-window would be
// a second, separately-scoped rework of the whole persist/clear/restore log system.
Logger.setBroadcastCallback((logEntry) => {
  broadcastToAllSidepanels('LOG_ENTRY', logEntry);
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
    // Resolves (creating if needed) THIS window's own session - never a shared global one.
    if (isValidWebTab(tab)) {
      const session = getOrCreateSession(tab.windowId);
      session.engine.ensureScoutFoxGroup(tab.id).catch((err) => {
        Logger.warn('Background', '[TAB_SANDBOX_ERROR] ensureScoutFoxGroup failed on icon click', err);
      });
    }
  });
}

chrome.runtime.onConnect.addListener((port) => {
  // The port name's '_fresh'/plain distinction and 'strawberry_sidepanel' backwards
  // compatibility (a pre-rename panel still running an old build) both still parse, purely for
  // the PORT_CONNECT log line below - neither one decides whether to clear history anymore.
  // Per-window sessions replaced that need: reopening the panel on a window that already has a
  // session (running or finished) always reflects it, exactly like reopening a chat app shows
  // the conversation that was already there, rather than silently starting a new one every
  // time. A window's session is only ever genuinely empty the first time IT is ever opened -
  // and clearing an already-empty engine is a harmless no-op, so there is nothing left to
  // special-case here at all. Starting over on purpose is what CLEAR_HISTORY is for.
  const match = port.name.match(/^(scoutfox_sidepanel(?:_fresh)?)(?::(-?\d+))?$/);
  const isLegacy = port.name === 'strawberry_sidepanel';
  if (!match && !isLegacy) return;

  const windowId = isLegacy ? 'legacy' : (match[2] !== undefined ? Number(match[2]) : 'legacy');

  const session = getOrCreateSession(windowId);
  session.ports.add(port);
  session.lastBroadcastHadNoListeners = false;
  Logger.info('Background', `[PORT_CONNECT] Sidepanel UI connected to window [${windowId}]. Active ports for this window: ${session.ports.size}`);

  port.onDisconnect.addListener(() => {
    session.ports.delete(port);
    Logger.info('Background', `[PORT_DISCONNECT] Sidepanel UI disconnected from window [${windowId}]. Active ports for this window: ${session.ports.size}`);
  });

  // Session creation is lazy - one is built the instant its window's first port ever connects,
  // rather than a single engine constructed well before any real connection could land. That
  // removes the incidental time cushion the old single-session design had: restoreState() is
  // async, so without this await, a session with a genuine persisted run could send its FIRST
  // STATE_UPDATE from the constructor's still-empty defaults, moments before the real restored
  // history/status ever lands - the exact same class of race already fixed for
  // GET_AGENT_STATE/Logger.logsRestored() below, here for the port-connect path.
  (async () => {
    try {
      await session.engine.restorePromise;
    } catch (err) {
      Logger.warn('Background', '[PORT_CONNECT] Session restore failed; proceeding with a clean state', err);
    }

    try {
      port.postMessage({
        type: 'STATE_UPDATE',
        payload: {
          status: session.engine.status,
          stepCount: session.engine.stepCount,
          task: session.engine.currentTask,
          history: session.engine.history,
          planSteps: session.engine.planSteps,
          currentPhase: session.engine.currentPhase,
          stateVersion: session.engine.stateVersion,
          bootId: session.engine.bootId,
          scoutFoxGroupId: session.engine.scoutFoxGroupId
        }
      });
    } catch (err) {
      Logger.warn('Background', 'Failed sending initial state update on port connect', err);
    }
  })();

  // Auto-label opening tab into 'ScoutFox' tab group immediately on sidepanel open, scoped to
  // THIS window only - never the globally-focused window, which could be a different one.
  if (typeof windowId === 'number') {
    chrome.tabs.query({ active: true, windowId }, (tabs) => {
      const activeTab = tabs && tabs[0];
      if (activeTab && isValidWebTab(activeTab)) {
        session.engine.ensureScoutFoxGroup(activeTab.id).then((groupId) => {
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
 * Fan a message out to every panel connected to ONE window's session - state updates must
 * never cross into a different window's panel.
 *
 * Re-entrancy is the hazard here: Logger broadcasts each new entry through broadcastToAllSidepanels,
 * so ANY log call made from inside these functions calls one of them again. Two rules keep
 * that finite:
 *   - remove a failing port from its session's set BEFORE logging about it, or the recursive
 *     call retries the same dead port and recurses without bound;
 *   - use Logger.warnSilent for diagnostics about the broadcast channel itself, so the entry
 *     is still recorded and persisted but is not pushed back through the broadcast path.
 */
function broadcastToSession(session, type, payload) {
  if (session.ports.size === 0) {
    if (!session.lastBroadcastHadNoListeners) {
      session.lastBroadcastHadNoListeners = true; // set BEFORE logging
      Logger.warnSilent('Background', `[BROADCAST_DROPPED] No sidepanel connected for window [${session.engine.windowId}] - "${type}" updates are being generated but nothing can receive them until that window's panel reconnects.`);
    }
    return;
  }
  session.lastBroadcastHadNoListeners = false;
  for (const port of Array.from(session.ports)) {
    try {
      port.postMessage({ type, payload });
    } catch (err) {
      session.ports.delete(port); // remove FIRST, then report
      Logger.warnSilent('Background', `[BROADCAST_ERROR] Dropped a dead sidepanel port for window [${session.engine.windowId}] while sending "${type}": ${err.message}. Active ports for this window: ${session.ports.size}`);
    }
  }
}

let isBroadcastingToAll = false;

/** Fan a message out to EVERY connected panel across every window's session. Logs only. */
function broadcastToAllSidepanels(type, payload) {
  if (isBroadcastingToAll) return;
  isBroadcastingToAll = true;
  try {
    for (const session of sessions.values()) {
      broadcastToSession(session, type, payload);
    }
  } finally {
    isBroadcastingToAll = false;
  }
}

/**
 * Keeping the MV3 service worker alive while ANY window has a task running.
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
 * Both are scoped strictly to "some session has an active task" - nothing runs while every
 * window is idle, but ANY one running/paused window is enough to hold the worker awake for
 * all of them, since they share the one process.
 */
const KEEPALIVE_ALARM_NAME = 'scoutfox_keepalive';
const KEEPALIVE_INTERVAL_MS = 20000;
let keepaliveIntervalId = null;

function anySessionActive() {
  for (const session of sessions.values()) {
    if (session.engine.status === 'running' || session.engine.status === 'paused') return true;
  }
  return false;
}

function syncKeepaliveAlarm() {
  const shouldRun = anySessionActive();

  if (shouldRun && keepaliveIntervalId === null) {
    keepaliveIntervalId = setInterval(() => {
      try {
        // Any extension API round-trip resets the service worker's idle timer.
        chrome.runtime.getPlatformInfo(() => { void chrome.runtime.lastError; });
      } catch (err) {
        Logger.warn('Background', '[KEEPALIVE] Idle-timer ping failed', err);
      }
    }, KEEPALIVE_INTERVAL_MS);
    Logger.info('Background', '[KEEPALIVE_ON] A task is active somewhere - holding the service worker awake.');
  } else if (!shouldRun && keepaliveIntervalId !== null) {
    clearInterval(keepaliveIntervalId);
    keepaliveIntervalId = null;
    Logger.info('Background', '[KEEPALIVE_OFF] No task active in any window - releasing the service worker.');
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
      Logger.info('Background', `[KEEPALIVE] Heartbeat - ${sessions.size} session(s) tracked.`);
      // If the alarm fires while a task is supposedly running but the interval ping is gone,
      // the worker was terminated and restarted. Re-arm so the task is not left unprotected.
      if (anySessionActive() && keepaliveIntervalId === null) {
        syncKeepaliveAlarm();
      }
    }
  });
}

// Every service-worker boot is logged, so an unexplained mid-task restart is visible
// in the log pane instead of appearing as the UI mysteriously going quiet.
Logger.info('Background', `[WORKER_BOOT] Service worker started. MV3 restarts the worker frequently - this line marks a fresh incarnation.`);

// Track active tab switching when links open new tabs & auto-group into ScoutFox Sandbox.
// Every listener below resolves which window's session (if any) an event belongs to from the
// event's own windowId - never assumes a single global session - and no-ops for a window that
// has not opened ScoutFox at all.
if (typeof chrome !== 'undefined' && chrome.tabs) {
  chrome.tabs.onCreated.addListener((tab) => {
    const session = sessions.get(tab.windowId);
    if (!session) return; // this window has no ScoutFox session - nothing to auto-group into

    if (session.engine.scoutFoxGroupId && typeof chrome.tabs.group === 'function') {
      chrome.tabs.group({ tabIds: tab.id, groupId: session.engine.scoutFoxGroupId }, () => {
        try { if (chrome.runtime && chrome.runtime.lastError) void chrome.runtime.lastError; } catch (_) {}
        Logger.info('Background', `[TAB_SANDBOX] Auto-grouped newly created Tab ID [${tab.id}] into 'ScoutFox' tab group [${session.engine.scoutFoxGroupId}] (window [${tab.windowId}])`);
        if (typeof chrome.sidePanel !== 'undefined' && chrome.sidePanel.setOptions) {
          chrome.sidePanel.setOptions({ tabId: tab.id, path: 'sidepanel/sidepanel.html', enabled: true }, () => {
            try { if (chrome.runtime && chrome.runtime.lastError) void chrome.runtime.lastError; } catch (_) {}
          });
        }
      });
    }

    if (session.engine.status === 'running') {
      setTimeout(() => {
        chrome.tabs.get(tab.id, (createdTab) => {
          if (createdTab && isValidWebTab(createdTab)) {
            Logger.info('Background', `[NEW_TAB_DETECTED] Automation switching to newly opened Tab ID [${createdTab.id}] (window [${tab.windowId}])`);
            session.engine.activeTabId = createdTab.id;
          }
        });
      }, 500);
    }
  });

  // Scope side panel visibility: hide side panel when user switches to a tab outside the
  // ScoutFox tab group belonging to THAT SAME tab's window's own session.
  if (chrome.tabs.onActivated) {
    chrome.tabs.onActivated.addListener(async (activeInfo) => {
      const session = sessions.get(activeInfo.windowId);
      if (!session || !session.engine.scoutFoxGroupId || typeof chrome.sidePanel === 'undefined' || !chrome.sidePanel.setOptions) return;
      const tabId = activeInfo.tabId;

      try {
        const tab = await new Promise((resolve) => {
          chrome.tabs.get(tabId, (t) => {
            try { if (chrome.runtime && chrome.runtime.lastError) void chrome.runtime.lastError; } catch (_) {}
            resolve(t);
          });
        });

        if (tab) {
          const isInScoutFoxGroup = tab.groupId === session.engine.scoutFoxGroupId;
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
      const windowId = tab ? tab.windowId : undefined;
      const session = windowId !== undefined ? sessions.get(windowId) : undefined;
      if (!session || !session.engine.scoutFoxGroupId || typeof chrome.sidePanel === 'undefined' || !chrome.sidePanel.setOptions) return;
      if (changeInfo.groupId !== undefined) {
        const isInScoutFoxGroup = changeInfo.groupId === session.engine.scoutFoxGroupId;
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
    // Content scripts always carry a real sender.tab, including its windowId - no ambiguity
    // here the way there can be for a side-panel-originated message.
    let session = null;
    let tabId = sender.tab ? sender.tab.id : null;
    if (sender.tab) {
      session = sessions.get(sender.tab.windowId);
    } else {
      // Fall back to searching for whichever session currently has an active tab, for the
      // rare case a sender lacks tab info entirely.
      for (const s of sessions.values()) {
        if (s.engine.activeTabId) { session = s; tabId = s.engine.activeTabId; break; }
      }
    }
    if (session) session.engine.recordNetworkRequest(tabId, payload);
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

  if (action === 'CLEAR_LOGS') {
    // Handled here, BEFORE any session is resolved - Logger keeps its own in-memory
    // logsHistory independent of any window's engine, shared across every session by design
    // (see the comment above Logger.setBroadcastCallback). Resolving/creating a session this
    // action does not need would construct a brand-new AgentEngine as a side effect, whose own
    // async restoreState() logs a STATE_RESTORE entry moments later - landing in Logger's
    // history at an unpredictable time relative to the very clear this handler just performed.
    Logger.clearLogs();
    sendResponse({ success: true });
    return true;
  }

  // Every action below this point belongs to one window's session.
  const session = getOrCreateSession(request.windowId !== undefined ? request.windowId : 'legacy');
  const agentEngine = session.engine;

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

    getActiveTab(request.windowId)
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

  // Anything unrecognised used to fall off the end returning undefined, which closes the
  // message channel with no reply — the caller's callback then fires with res === undefined
  // and no lastError, indistinguishable from success.
  Logger.warn('Background', `[UNKNOWN_ACTION] Received an unrecognised message action: "${action}". Ignoring.`);
  sendResponse({ success: false, error: `Unknown action: ${action}` });
  return true;
}

/**
 * Pick the tab to automate, WITHIN the requesting panel's own window.
 * Prioritizes tabs inside that window's active 'ScoutFox' Tab Group sandbox when active.
 */
async function getActiveTab(windowId) {
  const session = windowId !== undefined ? sessions.get(windowId) : undefined;
  const scoutFoxGroupId = session ? session.engine.scoutFoxGroupId : null;

  // 1. ALWAYS prioritize the currently focused active tab WITHIN THIS WINDOW - never whichever
  // window happens to be globally OS-focused, which could belong to a different session.
  const focused = typeof windowId === 'number'
    ? (await chrome.tabs.query({ active: true, windowId }))[0] || null
    : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0] || null;

  if (focused && isValidWebTab(focused)) {
    return focused;
  }

  // 2. If focused tab is in this window's ScoutFox group and valid:
  if (scoutFoxGroupId && typeof chrome.tabs.query === 'function') {
    try {
      const groupTabs = await chrome.tabs.query({ groupId: scoutFoxGroupId });
      const validInGroup = groupTabs.find(isValidWebTab);
      if (validInGroup) return validInGroup;
    } catch (_) {}
  }

  if (focused) {
    Logger.warn('Background', `[TAB_NOT_AUTOMATABLE] The focused tab (${focused.url || 'unknown URL'}) cannot be automated — browsers block extensions from scripting internal pages. Looking for another tab.`);
  }

  const validTab = typeof windowId === 'number'
    ? (await chrome.tabs.query({ windowId })).find(isValidWebTab) || null
    : (await chrome.tabs.query({ active: true })).find(isValidWebTab) ||
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
      const createOpts = { url: 'https://www.google.com', active: true };
      if (typeof windowId === 'number') createOpts.windowId = windowId;
      chrome.tabs.create(createOpts, (t) => {
        resolve(t);
      });
    } else {
      resolve({ id: 999, url: 'https://www.google.com' });
    }
  });

  if (session && session.engine.waitForTabComplete) {
    await session.engine.waitForTabComplete(newTab.id, 4000);
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
