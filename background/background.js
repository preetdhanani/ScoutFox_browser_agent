/**
 * Background Service Worker for ScoutFox AI Agent
 * Routes extension messages, maintains one AgentEngine session PER TAB, manages port
 * connections, dynamically tracks active tab switching when links or automation open new
 * tabs, and defends against the MV3 service-worker lifecycle silently dropping in-flight tasks.
 *
 * Session model: opening the extension on a tab starts (or resumes) THAT TAB's own, fully
 * independent session - its own ScoutFox tab group, its own history, its own running task, its
 * own Stop/Pause. Two tabs side by side in the same window can automate different things at the
 * same time without ever seeing or touching each other. Every AgentEngine method already
 * operates on "this" instance's own state (history, status, tab group, etc.), so the only thing
 * this file adds is: which engine instance a given event or message belongs to, resolved from
 * whichever tab it actually came from - never assumed to be a single global one.
 *
 * Per tab rather than per window because Chrome's side panel is itself per tab. Keying sessions
 * the same way means "which tabs should show the panel" has a direct answer - the ones with a
 * session - instead of needing a proxy. An earlier revision used the ScoutFox tab group as that
 * proxy, which forced a group to exist before any work had been asked for, and left the panel
 * unprotected on any tab that did not have one yet.
 *
 * Two things stay window-shaped, because Chrome makes them so: a tab group cannot span windows,
 * so AgentEngine tracks its groups in a Map keyed by window; and a session can cover several
 * tabs (the ones a run opens for itself), so several tab ids may point at one session object.
 */

import { AgentEngine, describeRestrictedUrl, lastRuntimeError } from './agentEngine.js';
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
 * tabId -> { engine: AgentEngine, ports: Set<Port>, ownerTabId: number }
 *
 * One entry is created the first time a TAB's panel connects or its toolbar icon is clicked,
 * and removed when that tab closes (see chrome.tabs.onRemoved below). A tab that never opened
 * ScoutFox has no entry at all - tab events for it are no-ops.
 *
 * Per TAB, not per window. Chrome's side panel is itself per-tab, so this matches the
 * granularity the platform already works at: two tabs side by side in the same window each get
 * their own engine, their own history, their own Stop button, and neither can see the other.
 * Open a task in one tab, open a second tab and start something completely different - they do
 * not interfere.
 *
 * Several tab ids can map to the SAME session object. That is how a run that spans tabs stays
 * one run: when the agent follows a target="_blank" link, the tab it lands on is registered
 * against the session that opened it, so the panel keeps showing the same task rather than
 * closing or starting over. ownerTabId records which tab the session was born in, so closing a
 * tab the run merely visited does not tear the whole session down.
 */
const sessions = new Map();

/**
 * Register an extra tab against an existing session, so a run can span tabs without the panel
 * losing its place. Idempotent.
 */
function adoptTabIntoSession(session, tabId) {
  if (!tabId || sessions.get(tabId) === session) return;
  sessions.set(tabId, session);
  Logger.info('Background', `[SESSION_EXTENDED] Session from tab [${session.ownerTabId}] now also covers tab [${tabId}].`);
}

/**
 * Where a task starts when the agent has no usable page to start from - either because it had
 * to open a tab, or because it reused an empty one. A search engine is the neutral choice: the
 * planner's first step is almost always "find X", and landing somewhere it can type beats
 * landing on a page it then has to navigate away from.
 */
const START_URL = 'https://www.google.com';

function getOrCreateSession(tabId, windowId) {
  let session = sessions.get(tabId);
  if (session) return session;

  const engine = new AgentEngine(tabId, windowId);
  session = { engine, ports: new Set(), lastBroadcastHadNoListeners: false, ownerTabId: tabId };
  sessions.set(tabId, session);

  // Each tab's engine broadcasts ONLY to that tab's own connected panels - never to a
  // neighbouring tab's, which is exactly the isolation this whole session model exists for.
  engine.setStateChangeCallback((state) => {
    broadcastToSession(session, 'STATE_UPDATE', state);
    syncKeepaliveAlarm();
  });

  // When this engine takes on another tab - the one inside a window it opened via the
  // "open_window" action - register that TAB against this SAME session object rather than
  // letting a second, disconnected one spring up the moment a panel appears there.
  engine.setTabAdoptedCallback((newTabId) => {
    adoptTabIntoSession(session, newTabId);
  });

  Logger.info('Background', `[SESSION_CREATED] New session for tab [${tabId}].`);
  return session;
}

/**
 * Tear a session down when the tab that owns it closes.
 *
 * A tab the run merely visited is only unmapped - the session itself lives on in its owner
 * tab, so closing a pop-up the agent opened does not kill the task that opened it. Closing the
 * OWNER tab ends the session outright: its panel is gone with the tab, there is nothing left to
 * automate, and keeping the engine and its persisted state around would only leak both.
 */
function endSessionForClosedTab(tabId) {
  const session = sessions.get(tabId);
  if (!session) return;
  sessions.delete(tabId);

  if (session.ownerTabId !== tabId) {
    Logger.info('Background', `[SESSION_TAB_CLOSED] Tab [${tabId}] closed, but its session lives on in its owner tab [${session.ownerTabId}].`);
    return;
  }

  // Drop every other tab still pointing at this session - the session is over, so those
  // mappings would otherwise keep a dead engine reachable.
  for (const [otherTabId, other] of Array.from(sessions.entries())) {
    if (other === session) sessions.delete(otherTabId);
  }

  if (session.engine.status === 'running' || session.engine.status === 'paused') {
    session.engine.stop();
  }
  AgentEngine.forgetSession(session.engine.sessionId);
  Logger.info('Background', `[SESSION_CLOSED] Tab [${tabId}] closed. Its session and persisted state are gone.`);
  syncKeepaliveAlarm();
}

// Clear a brand-new browser run's slate before anything can read it.
//
// Sessions persist across a service-worker restart on purpose - MV3 recycles the worker
// aggressively and a long task must survive that. They must NOT persist across a browser
// restart: they are keyed by tab id, and Chrome hands out the same low tab ids again on every
// launch, so yesterday's session would be adopted by whatever tab happens to open first today.
// onStartup runs once per browser launch, before any tab can connect.
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(() => {
    AgentEngine.forgetAllSessions();
    Logger.info('Background', '[BROWSER_STARTUP] New browser run - cleared persisted sessions so no tab inherits a previous run\'s history.');
  });
}

// Clean network request buffers when tab is closed & track ScoutFox tab group removal.
// Both search every session rather than assuming a single global engine owns the tab/group -
// with one engine per tab, ownership has to be looked up, not assumed.
if (typeof chrome !== 'undefined') {
  if (chrome.tabs && chrome.tabs.onRemoved) {
    chrome.tabs.onRemoved.addListener((tabId) => {
      for (const session of sessions.values()) {
        if (session.engine.networkBuffers.has(tabId)) {
          session.engine.networkBuffers.delete(tabId);
        }
      }
      // A closed tab takes its session with it (see endSessionForClosedTab). Chrome fires this
      // for every tab of a closing window too, so a closed window needs no handler of its own.
      endSessionForClosedTab(tabId);
    });
  }

  if (chrome.tabGroups && chrome.tabGroups.onRemoved) {
    chrome.tabGroups.onRemoved.addListener((group) => {
      if (!group) return;
      // The group map is keyed by WINDOW even though sessions are keyed by tab - a Chrome tab
      // group cannot span windows, so that part stays window-shaped. Several tab ids can point
      // at the same session object, so this deduplicates before touching any engine.
      const seen = new Set();
      for (const session of sessions.values()) {
        if (seen.has(session)) continue;
        seen.add(session);
        for (const [windowId, groupId] of Array.from(session.engine.scoutFoxGroupIds.entries())) {
          if (groupId !== group.id) continue;
          Logger.info('Background', `[TAB_SANDBOX] ScoutFox tab group [${group.id}] was closed by user (window [${windowId}]).`);
          session.engine.scoutFoxGroupIds.delete(windowId);
          session.engine.persistState();
        }
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
    lastRuntimeError();
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

// Handle explicit extension action icon clicks: attach a session to the clicked TAB and show
// the panel there. Deliberately does NOT create a tab group - see the comment at the end of
// this handler.
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
        lastRuntimeError();
      });
    }

    // MUST be called synchronously in this same tick, with nothing awaited above it. Chrome
    // only honors sidePanel.open() as a genuine response to the click's user gesture for as
    // long as the call stack stays synchronous; crossing even one await loses that gesture and
    // open() then fails silently, since it's a fire-and-forget .catch(). setOptions() above is
    // fire-and-forget too (callback style, not awaited), so it does not cross that boundary
    // either.
    if (chrome.sidePanel && chrome.sidePanel.open) {
      chrome.sidePanel.open({ tabId: tab.id }).catch((err) => {
        Logger.warn('Background', '[SIDEPANEL_OPEN_FAILED] chrome.sidePanel.open() was rejected', err);
      });
    }

    // Clicking the toolbar icon is a deliberate, explicit "open ScoutFox" gesture - unlike the
    // internal port reconnects (service worker restarts, a second tab's own panel document
    // connecting) that must NOT clear an in-progress or just-finished run, and still resume
    // exactly as before. An idle/finished session, though, should never resurrect a stale
    // conversation into the next task's LLM prompt (previousTurnsSummary() would recap it)
    // just because the panel was reopened - so start fresh here instead. Waits for any
    // in-flight restoreState() first (restorePromise resolves immediately if it already has),
    // so a just-constructed engine's own restore cannot clobber this clear by loading the old
    // history right back a moment later; the status re-check inside also protects against a
    // task that starts between the click and this running.
    //
    // The !dirty condition is what stops this from eating a run the user is still reading.
    // "Stale" was always meant to mean a conversation restored from storage that the user has
    // already moved on from - not one that finished thirty seconds ago. Those two were
    // indistinguishable while the only test was on status, and both read as 'idle'. So clicking
    // the icon to get the panel back after a finished run destroyed that run's result, which is
    // precisely the recovery gesture the panel-vanishing bug above forced people into.
    //
    // dirty separates them exactly: the constructor sets it false, restoreState never sets it,
    // and every method that mutates this worker's own engine (startTask, clearHistory, pause,
    // resume, stop, answerQuestion) sets it true. So !dirty means "everything on screen came
    // out of storage and nothing has happened in this worker's lifetime" - genuinely stale -
    // while dirty means a real run happened right here and its result is the user's to keep.
    const session = getOrCreateSession(tab.id, tab.windowId);
    session.engine.restorePromise.then(() => {
      const engine = session.engine;
      if (engine.status === 'running' || engine.status === 'paused') return;
      if (engine.dirty) {
        Logger.info('Background', `[SESSION_KEPT] Icon clicked on an idle session that ran in this worker - keeping its history so a finished run is not wiped by the click that reopens the panel (tab [${tab.id}]).`);
        return;
      }
      engine.clearHistory();
    });

    // NO tab group is created here, deliberately.
    //
    // Opening the panel is not the same as starting work. Grouping on click reorganised the
    // user's tab strip - moving the tab, painting it orange, boxing it - just for looking at
    // the extension, before it had been asked to do anything at all. The group is a sandbox
    // marker for automation, so it belongs to a task: startTask() and getActiveTab() create it
    // when a run actually begins.
    //
    // An earlier revision DID group here, because side-panel visibility used to be keyed off
    // the group: no group meant onActivated could not tell which tabs should show the panel,
    // so the panel died on the first tab switch. Sessions being per-tab removes that need
    // entirely - "does this tab have a session" is a direct answer to the same question, and a
    // better one, since it does not depend on a group the user can drag tabs into and out of.
  });
}

chrome.runtime.onConnect.addListener((port) => {
  // The port name's '_fresh'/plain distinction still parses, purely for the PORT_CONNECT log
  // line below - it no longer decides whether to clear history. Per-tab sessions replaced that
  // need: reopening the panel on a tab that already has a session (running or finished) always
  // reflects it, exactly like reopening a chat app shows the conversation that was already
  // there, rather than silently starting a new one every time. A tab's session is only ever
  // genuinely empty the first time THAT TAB is ever opened - and clearing an already-empty
  // engine is a harmless no-op, so there is nothing left to special-case here at all. Starting
  // over on purpose is what CLEAR_HISTORY is for.
  //
  // The id in the port name is the panel's own TAB, which it resolves for itself before
  // connecting (see sidepanel.js) - the background worker cannot work it out, because a side
  // panel port arrives with no sender.tab.
  const match = port.name.match(/^(scoutfox_sidepanel(?:_fresh)?)(?::(-?\d+))?$/);
  if (!match) return;

  const tabId = match[2] !== undefined ? Number(match[2]) : 'legacy';

  const session = getOrCreateSession(tabId, undefined);
  session.ports.add(port);
  session.lastBroadcastHadNoListeners = false;
  Logger.info('Background', `[PORT_CONNECT] Sidepanel UI connected to tab [${tabId}]. Active ports for this tab: ${session.ports.size}`);

  port.onDisconnect.addListener(() => {
    session.ports.delete(port);
    Logger.info('Background', `[PORT_DISCONNECT] Sidepanel UI disconnected from tab [${tabId}]. Active ports for this tab: ${session.ports.size}`);
  });

  // Keep the engine's idea of which window it is in current. A session is identified by its
  // tab, but tab groups are per-window, so the engine still needs to know where its tab lives -
  // and a tab can be dragged to another window after the session was created.
  if (typeof tabId === 'number' && chrome.tabs && chrome.tabs.get) {
    chrome.tabs.get(tabId, (t) => {
      lastRuntimeError();
      if (t && t.windowId !== undefined) session.engine.windowId = t.windowId;
    });
  }

  // Session creation is lazy - one is built the instant its tab's first port ever connects,
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
          // Without this a panel that reconnects while the agent is waiting on ask_user shows a
          // paused run with no question and no answer box - a dead end the user cannot clear.
          pendingQuestion: session.engine.pendingQuestion,
          stateVersion: session.engine.stateVersion,
          bootId: session.engine.bootId,
          scoutFoxGroupId: session.engine.scoutFoxGroupId
        }
      });
    } catch (err) {
      Logger.warn('Background', 'Failed sending initial state update on port connect', err);
    }
  })();

  // The panel must stay visible on its own tab for as long as the session exists - a panel that
  // connected is a panel the user is looking at. No grouping happens here: that belongs to
  // starting a task, not to opening the panel (see the icon-click handler above).
  if (typeof tabId === 'number' && chrome.sidePanel && chrome.sidePanel.setOptions) {
    chrome.sidePanel.setOptions({ tabId, path: 'sidepanel/sidepanel.html', enabled: true }, () => {
      lastRuntimeError();
    });
  }
});

/**
 * Fan a message out to every panel connected to ONE tab's session - state updates must
 * never cross into a different tab's panel.
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
      Logger.warnSilent('Background', `[BROADCAST_DROPPED] No sidepanel connected for tab [${session.engine.sessionId}] - "${type}" updates are being generated but nothing can receive them until that tab's panel reconnects.`);
    }
    return;
  }
  session.lastBroadcastHadNoListeners = false;
  for (const port of Array.from(session.ports)) {
    try {
      port.postMessage({ type, payload });
    } catch (err) {
      session.ports.delete(port); // remove FIRST, then report
      Logger.warnSilent('Background', `[BROADCAST_ERROR] Dropped a dead sidepanel port for tab [${session.engine.sessionId}] while sending "${type}": ${err.message}. Active ports for this tab: ${session.ports.size}`);
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
// Every listener below resolves which TAB's session (if any) an event belongs to - never
// assumes a single global session - and no-ops for a tab that has not opened ScoutFox at all.
/**
 * Take a tab the USER opened back out of the ScoutFox group, if Chrome put it there.
 *
 * Chrome natively adds a new tab to whatever group its opener tab belongs to - ctrl+click a
 * link inside a grouped tab and the result joins that group, with no extension involvement at
 * all. So the ScoutFox group grows on its own as soon as the user starts browsing from the
 * agent's tab, which is the opposite of what the group is for: it is meant to show, at a
 * glance, exactly which tabs the agent is allowed to touch.
 *
 * Two deliberate limits on how far this reaches:
 *
 *   - it only ever releases a tab from OUR group. A tab that lands in a group the user built
 *     themselves is none of ScoutFox's business, and pulling it out would be the extension
 *     reorganising their tab strip for them;
 *   - it only runs at CREATION time, from onCreated. Chrome's auto-grouping is what this
 *     undoes. If the user later drags one of their own tabs into the ScoutFox group on purpose,
 *     that is a decision they made and it stands - fighting them over it would be obnoxious.
 *
 * Chrome creates an auto-grouped tab directly into the group, so the event's own groupId is
 * already accurate here and there is nothing to wait for.
 */
function releaseUserTabFromGroup(tab, groupIdForThisWindow) {
  if (!groupIdForThisWindow || typeof chrome === 'undefined' || !chrome.tabs || !chrome.tabs.ungroup) return;
  if (tab.groupId !== groupIdForThisWindow) return;
  chrome.tabs.ungroup(tab.id, () => {
    lastRuntimeError();
    Logger.info('Background', `[TAB_RELEASED] Chrome auto-added the user's new Tab ID [${tab.id}] to the 'ScoutFox' group [${groupIdForThisWindow}] because it was opened from a grouped tab. Removed it again - the group only ever holds tabs the agent itself opened (window [${tab.windowId}]).`);
  });
}

if (typeof chrome !== 'undefined' && chrome.tabs) {
  chrome.tabs.onCreated.addListener((tab) => {
    // Which session, if any, does this new tab belong to? Only the session whose agent is
    // running and whose own tab opened it - resolved from the OPENER, because the new tab has
    // no session of its own yet. A tab opened from a tab with no session is nobody's business.
    const session = tab.openerTabId !== undefined ? sessions.get(tab.openerTabId) : undefined;
    if (!session) return; // no session opened this tab - nothing to adopt it into

    // The group is keyed by WINDOW even though sessions are keyed by tab: grouping into a
    // DIFFERENT window's group fails outright, since a Chrome tab group cannot span windows.
    const groupIdForThisWindow = session.engine.groupIdForWindow(tab.windowId);

    // Only adopt tabs THIS session's own automation actually caused.
    //
    // Chrome sets openerTabId on a tab opened BY another tab - a target="_blank" link the
    // agent clicked, or window.open from a page it is driving - so a tab whose opener is the
    // very tab the agent is working in is one of ours. A tab the USER opened is not: Cmd+T
    // carries no opener at all, and a link they clicked in some other tab carries that tab.
    //
    // This listener used to adopt EVERY new tab in the window, which the user reported from
    // both ends: a tab they opened next to the group silently became part of the automation
    // sandbox, and - worse, below - a tab they opened mid-run stole the running agent's
    // target 500ms later, pointing it at a page they had opened for themselves. Their own
    // tabs stay their own; the agent only ever follows tabs it opened itself.
    //
    // The opener check alone is not enough, for two reasons:
    //   - the agent only opens tabs WHILE IT IS RUNNING. An opener match against an idle
    //     session is the user ctrl+clicking a link in the agent's own tab for their own
    //     reasons, which is their tab, not ours;
    //   - Chrome itself auto-adds a tab to the group its opener belongs to. That happens
    //     inside the browser before this listener ever runs, so "leave it alone" is not the
    //     same as "it stays out" - a user's ctrl+click from a grouped tab lands IN the group
    //     no matter what this code does or does not do.
    // So a tab that is not ours is not merely skipped, it is actively ungrouped below.
    const openedByThisSession = tab.openerTabId !== undefined
      && tab.openerTabId === session.engine.activeTabId
      && session.engine.status === 'running';
    if (!openedByThisSession) {
      if (groupIdForThisWindow) {
        Logger.info('Background', `[TAB_LEFT_ALONE] Tab [${tab.id}] was opened by the user, not by automation - keeping it outside the 'ScoutFox' group (window [${tab.windowId}]).`);
        releaseUserTabFromGroup(tab, groupIdForThisWindow);
      }
      return;
    }

    // The run is moving into this tab, so the tab joins the run's session. Without this the
    // panel would close the instant the agent followed a target="_blank" link: the new tab
    // would have no session, so the listeners below would find nothing to show there.
    adoptTabIntoSession(session, tab.id);

    if (groupIdForThisWindow && typeof chrome.tabs.group === 'function') {
      chrome.tabs.group({ tabIds: tab.id, groupId: groupIdForThisWindow }, () => {
        lastRuntimeError();
        Logger.info('Background', `[TAB_SANDBOX] Auto-grouped newly created Tab ID [${tab.id}] into 'ScoutFox' tab group [${groupIdForThisWindow}] (window [${tab.windowId}])`);
      });
    }

    if (typeof chrome.sidePanel !== 'undefined' && chrome.sidePanel.setOptions) {
      chrome.sidePanel.setOptions({ tabId: tab.id, path: 'sidepanel/sidepanel.html', enabled: true }, () => {
        lastRuntimeError();
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

  // Scope side panel visibility to the tabs that actually have a session.
  //
  // This used to ask "is this tab in the ScoutFox group", which needed the group to exist
  // before the panel could be kept alive - and on a brand-new tab it does not, so the panel
  // died on the first switch of every session. "Does this tab have a session" answers the same
  // question directly, is true from the instant the icon is clicked, and does not depend on a
  // tab group the user can drag tabs into and out of.
  if (chrome.tabs.onActivated) {
    chrome.tabs.onActivated.addListener((activeInfo) => {
      if (typeof chrome.sidePanel === 'undefined' || !chrome.sidePanel.setOptions) return;
      setPanelVisibility(activeInfo.tabId, sessions.has(activeInfo.tabId));
    });
  }
}

/**
 * Enable or disable the side panel for one tab.
 *
 * Disabling is what HIDES the panel when the user switches to a tab that has no session, and
 * is the only mechanism there is for that - the manifest's side_panel.default_path otherwise
 * offers the panel on every tab in the browser (hence the global disable at boot).
 */
function setPanelVisibility(tabId, shouldShow) {
  if (!tabId || typeof chrome === 'undefined' || !chrome.sidePanel || !chrome.sidePanel.setOptions) return;
  const opts = shouldShow
    ? { tabId, path: 'sidepanel/sidepanel.html', enabled: true }
    : { tabId, enabled: false };
  chrome.sidePanel.setOptions(opts, () => {
    lastRuntimeError();
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
    // Content scripts always carry a real sender.tab, so the tab - and therefore the session it
    // belongs to - is unambiguous here, the way it cannot be for a side-panel-originated
    // message (a side-panel port reaches this worker with no sender.tab at all, which is why
    // the panel has to resolve and send its own tabId).
    let session = null;
    let tabId = sender.tab ? sender.tab.id : null;
    if (sender.tab) {
      session = sessions.get(sender.tab.id);
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
  const session = getOrCreateSession(request.tabId !== undefined ? request.tabId : 'legacy', undefined);
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
        // Same reason as the onConnect path above: a resync landing while the agent is waiting
        // on ask_user must carry the question, or the panel renders a paused run it cannot answer.
        pendingQuestion: agentEngine.pendingQuestion,
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

    getActiveTab(session, request.tabId)
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

  if (action === 'ANSWER_QUESTION') {
    sendResponse(agentEngine.answerQuestion(payload && payload.answer));
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

/** Bring a tab to the front of its window, so automation is never invisible to the user. */
function activateTab(tabId) {
  return new Promise((resolve) => {
    if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.tabs.update) return resolve();
    chrome.tabs.update(tabId, { active: true }, () => {
      lastRuntimeError();
      resolve();
    });
  });
}

/**
 * All the tabs currently mapped to one session, newest mapping last.
 */
function sessionTabIds(session) {
  const ids = [];
  for (const [tabId, s] of sessions.entries()) {
    if (s === session && typeof tabId === 'number') ids.push(tabId);
  }
  return ids;
}

/**
 * Pick the tab to automate for THIS session.
 *
 * With one session per tab this stopped being a search. The session owns a tab, the panel is
 * attached to that tab, and that is the tab the user is watching - so the only real questions
 * left are whether it can be scripted and, if not, what to do about it. The old version queried
 * the window for whatever happened to be focused, which is how a task could end up running
 * against a tab belonging to someone else's session entirely.
 *
 * requestingTabId is the tab whose panel sent START_TASK. It only matters if this has to open a
 * new tab: that panel is the one holding the user's Enter/click gesture, so it is the one asked
 * to follow the run there (see the PANEL_HANDOFF broadcast below).
 */
async function getActiveTab(session, requestingTabId) {
  if (!session) return null;

  // Wait for the persisted session to land before reading anything off the engine.
  //
  // MV3 kills the service worker constantly, and a START_TASK is usually what wakes it back up,
  // so on that path the constructor's restoreState() is still in flight right here. Reading the
  // group map before it resolves answers null for a session that does in fact have a group,
  // which sends this function down the "nothing to automate" path and opens yet another tab -
  // repeating the whole sequence on every worker restart.
  if (session.engine.restorePromise) {
    try {
      await session.engine.restorePromise;
    } catch (err) {
      Logger.warn('Background', '[TAB_PICK] Session restore failed; picking a tab from a clean state', err);
    }
  }

  // Among the tabs this session covers, prefer the one that is actually in front of the user.
  // For a first task that is simply the tab they opened the panel on; for a follow-up after the
  // agent moved into a tab it opened, it is that tab - which is where they are still looking.
  const candidates = await Promise.all(sessionTabIds(session).map((id) => new Promise((resolve) => {
    if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.tabs.get) return resolve(null);
    chrome.tabs.get(id, (t) => { lastRuntimeError(); resolve(t || null); });
  })));
  const live = candidates.filter(Boolean);
  const focused = live.find((t) => t.active) || live.find((t) => t.id === session.ownerTabId) || live[0] || null;

  if (focused && isValidWebTab(focused)) {
    return focused;
  }

  // The session's tab cannot be scripted, but if it is a THROWAWAY page - a new-tab page, a
  // blank tab - then it holds nothing the user would miss, and the right move is to navigate it
  // where it stands rather than open a second tab beside it.
  //
  // This is the fix for the bug as the user actually experienced it: a brand-new window opens on
  // chrome://newtab, which isValidWebTab rejects, so every single first task in a new window
  // fell through and spawned a tab. From the user's seat that reads as "I asked it to do
  // something and it wandered off into a new tab", when they were sitting on an empty page that
  // was theirs to reuse.
  //
  // Reusing it also protects the side panel. The panel is scoped per tab id, so creating and
  // activating a different tab moves the active tab out from under the open panel and Chrome
  // closes it; only sidePanel.open() can bring one back, and that needs a user gesture this
  // code path does not have. Navigating in place never changes the active tab id, so there is
  // nothing for Chrome to close.
  if (focused && isDisposableTab(focused) && typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.update) {
    Logger.info('Background', `[TAB_REUSED] The session's tab [${focused.id}] (${focused.url}) is an empty page, so this task runs in it rather than opening another tab beside it.`);
    if (session.engine.ensureScoutFoxGroup) {
      try {
        await session.engine.ensureScoutFoxGroup(focused.id, focused.windowId);
      } catch (err) {
        Logger.warn('Background', '[TAB_SANDBOX_ERROR] Could not group the reused tab', err);
      }
    }
    setPanelVisibility(focused.id, true);
    await new Promise((resolve) => {
      chrome.tabs.update(focused.id, { url: START_URL }, () => {
        lastRuntimeError();
        resolve();
      });
    });
    if (session.engine.waitForTabComplete) {
      await session.engine.waitForTabComplete(focused.id, 4000);
    }
    return { ...focused, url: START_URL };
  }

  // Otherwise the session is sitting on a page that genuinely cannot be automated and is not
  // ours to navigate away from - chrome://settings, a PDF, the Web Store. Open a fresh tab
  // immediately to the RIGHT of it and run there.
  //
  // Moving to another tab is what closes the side panel, and no ordering on this side can stop
  // it. A tab-scoped panel opened on one tab is open for THAT tab only: setOptions on the new tab
  // grants permission to show a panel there, but only sidePanel.open() actually shows one, and
  // open() needs a user gesture this worker never has. The panel page does have one - the
  // Enter/click that sent START_TASK, which stays live for about five seconds - so once the new
  // tab is ready, the panel is asked to reopen itself there (PANEL_HANDOFF).
  if (focused) {
    Logger.warn('Background', `[TAB_NOT_AUTOMATABLE] The session's tab (${focused.url || 'unknown URL'}) cannot be automated - browsers block extensions from scripting internal pages. Opening a fresh tab next to it instead.`);
  }
  Logger.info('Background', `[AUTO_CREATE_TAB] Opening a fresh tab to ${START_URL} for this task.`);
  const newTab = await new Promise((resolve) => {
    if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.create) {
      const createOpts = { url: START_URL, active: false };
      if (focused && typeof focused.windowId === 'number') createOpts.windowId = focused.windowId;
      // Right beside the tab it was launched from, rather than appended to the far end of the
      // strip where the user has to go hunting for it.
      if (focused && typeof focused.index === 'number') createOpts.index = focused.index + 1;
      chrome.tabs.create(createOpts, (t) => {
        lastRuntimeError();
        resolve(t);
      });
    } else {
      resolve({ id: 999, url: START_URL });
    }
  });

  // The run is moving into this tab, so the tab belongs to this session from here on - that is
  // what lets the panel keep showing this run once the tab comes to the front.
  adoptTabIntoSession(session, newTab.id);

  // Group it and enable the panel on it BEFORE it is activated. The enable must land first or
  // the handoff's open() is rejected with "No active side panel for tabId", and onActivated
  // must find the tab already in this session or it disables the panel again on arrival.
  // ensureScoutFoxGroup is idempotent, so startTask calling it again right after is a no-op.
  if (session.engine.ensureScoutFoxGroup) {
    try {
      await session.engine.ensureScoutFoxGroup(newTab.id, newTab.windowId);
    } catch (err) {
      Logger.warn('Background', '[TAB_SANDBOX_ERROR] Could not group the freshly opened tab', err);
    }
  }
  setPanelVisibility(newTab.id, true);

  // The run must be visible - driving a background tab is what made a finished run look like
  // nothing had happened - so the tab comes to the front even if the handoff below fails.
  await activateTab(newTab.id);

  // Sent before waiting for the page to load, not after: the panel's gesture is only good for
  // about five seconds, and a slow page load alone can use most of that.
  broadcastToSession(session, 'PANEL_HANDOFF', { tabId: newTab.id, fromTabId: requestingTabId });

  if (session.engine.waitForTabComplete) {
    await session.engine.waitForTabComplete(newTab.id, 4000);
  }

  // A tab straight out of tabs.create has only pendingUrl, so without the fallback the panel
  // reports the run as starting on an "unknown URL".
  return { ...newTab, url: newTab.url || newTab.pendingUrl || START_URL, active: true };
}

/**
 * Is this tab one the agent can actually script?
 *
 * Delegates to describeRestrictedUrl() (agentEngine.js), which already covers the Chrome Web
 * Store and file:/view-source:/devtools:/data: pages that this check used to miss - it only
 * ever recognised chrome://, chrome-extension://, edge:// and about:. A tab sitting on the Web
 * Store or a file:// page slipped through as "valid", and the script injection that followed
 * failed immediately anyway; this just makes the earlier check agree with the one that
 * actually has to inject into the page. Two separate lists for "can this tab be scripted" were
 * always going to drift apart - this makes describeRestrictedUrl the single source of truth.
 */
function isValidWebTab(tab) {
  if (!tab || !tab.url) return false;
  return describeRestrictedUrl(tab.url) === null;
}

/**
 * Is this tab a THROWAWAY page the agent may navigate in place, rather than opening a tab beside?
 *
 * Only ever consulted for tabs isValidWebTab has already rejected, so the question is never
 * "may the agent script this" - it is "does this tab hold anything the user would miss".
 *
 * Getting this wrong is not symmetric:
 *   - too NARROW and the original bug comes back for whatever case is left out - a second tab
 *     appears and the side panel closes with it;
 *   - too WIDE and the agent navigates away from a page the user was actually using, which is
 *     the worse failure, because it is not recoverable by clicking anything.
 *
 * Note that a new-tab page is not spelled one way. Chrome reports it as chrome://newtab/ or
 * chrome://new-tab-page/ depending on version and whether an extension has overridden it, a
 * freshly scripted or restored tab can be about:blank, and Edge uses its own edge:// prefix.
 */
function isDisposableTab(tab) {
  // TODO(human): decide which URLs count as "empty enough to reuse" and return true for those.
  //
  // `tab.url` may also be undefined or '' on a tab that has not committed a navigation yet.
  // Decide deliberately whether that counts as disposable - it is the most ambiguous case here,
  // and it is reachable in practice on a slow cold start.
  return false;
}
