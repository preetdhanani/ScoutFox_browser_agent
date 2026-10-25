/**
 * Background Service Worker for ScoutFox AI Agent
 * Routes extension messages, maintains one AgentRunner session PER TAB, manages port
 * connections, dynamically tracks active tab switching when links or automation open new
 * tabs, and defends against the MV3 service-worker lifecycle silently dropping in-flight tasks.
 *
 * Session model: opening the extension on a tab starts (or resumes) THAT TAB's own, fully
 * independent session - its own ScoutFox tab group, its own history, its own running task, its
 * own Stop/Pause. Two tabs side by side in the same window can automate different things at the
 * same time without ever seeing or touching each other. Every AgentRunner method operates on
 * "this" instance's own state (history, status, tab group, etc.), so the only thing this file
 * adds is: which runner instance a given event or message belongs to, resolved from whichever tab
 * it actually came from - never assumed to be a single global one.
 *
 * Per tab rather than per window because Chrome's side panel is itself per tab. Keying sessions
 * the same way means "which tabs should show the panel" has a direct answer - the ones with a
 * session - instead of needing a proxy such as the ScoutFox tab group, which would have to exist
 * before any work had been asked for.
 *
 * Two things stay window-shaped, because Chrome makes them so: a tab group cannot span windows,
 * so AgentRunner tracks its groups in a Map keyed by window; and a session can cover several
 * tabs (the ones a run opens for itself), so several tab ids may point at one session object.
 */

// Must stay the first import: it sets zod's jitless flag before any module that bundles zod runs (see the file).
import './boot/zodJitless.ts';
import { isGeminiStreamCut } from './boot/rejections.ts';
import { lastRuntimeError, isValidWebTab, isDisposableTab } from './browser/tabs.ts';
import { AgentRunner } from './runner/AgentRunner.ts';
import { callProvider, fetchAvailableModels, getFallbackModels } from './llm/index.ts';
import { resolveEffortSupport } from './llm/effort.ts';
import { BUILTIN_PROVIDER_IDS } from '../shared/storage.ts';
import { Logger } from '../shared/logger.ts';
import { BUILD_STAMP } from '../shared/build.ts';
import { cdp } from './browser/cdp.ts';

// Catch anything that would otherwise die silently in the service worker's global scope.
self.addEventListener('error', (event: Event) => {
  const errEvent = event as ErrorEvent;
  Logger.error('Background', '[UNCAUGHT_ERROR] Uncaught exception in service worker', errEvent.error || errEvent.message);
});
self.addEventListener('unhandledrejection', (event: Event) => {
  const rejEvent = event as PromiseRejectionEvent;
  if (isGeminiStreamCut(rejEvent.reason)) {
    // The Google SDK's second report of a cut stream (see the file). The call itself failed and was logged already.
    rejEvent.preventDefault();
    Logger.info('Background', '[GEMINI_STREAM_CUT] Ignored the Google SDK\'s unhandled rejection of a cut stream: the call itself already failed and was logged.');
    return;
  }
  Logger.error('Background', '[UNHANDLED_REJECTION] Unhandled promise rejection in service worker', rejEvent.reason);
});

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface BackgroundSession {
  engine: AgentRunner;
  ports: Set<chrome.runtime.Port>;
  lastBroadcastHadNoListeners: boolean;
  ownerTabId: number;
}

/**
 * tabId -> { engine: AgentRunner, ports: Set<Port>, ownerTabId: number }
 *
 * One entry is created the first time a TAB's panel connects or its toolbar icon is clicked,
 * and removed when that tab closes (see chrome.tabs.onRemoved below). A tab that never opened
 * ScoutFox has no entry at all - tab events for it are no-ops.
 *
 * Per TAB, not per window. Chrome's side panel is itself per-tab, so this matches the
 * granularity the platform already works at: two tabs side by side in the same window each get
 * their own runner, their own history, their own Stop button, and neither can see the other.
 * Open a task in one tab, open a second tab and start something completely different - they do
 * not interfere.
 *
 * Several tab ids can map to the SAME session object. That is how a run that spans tabs stays
 * one run: when the agent follows a target="_blank" link, the tab it lands on is registered
 * against the session that opened it, so the panel keeps showing the same task rather than
 * closing or starting over. ownerTabId records which tab the session was born in, so closing a
 * tab the run merely visited does not tear the whole session down.
 */
const sessions = new Map<number, BackgroundSession>();

/**
 * Register an extra tab against an existing session, so a run can span tabs without the panel
 * losing its place. Idempotent.
 */
function adoptTabIntoSession(session: BackgroundSession, tabId?: number | null): void {
  if (!tabId || sessions.get(tabId) === session) return;
  sessions.set(tabId, session);
  Logger.debug('Background', `[SESSION_EXTENDED] Session from tab [${session.ownerTabId}] now also covers tab [${tabId}].`);
}

/**
 * Where a task starts when the agent has no usable page to start from - either because it had
 * to open a tab, or because it reused an empty one. A search engine is the neutral choice: the
 * planner's first step is almost always "find X", and landing somewhere it can type beats
 * landing on a page it then has to navigate away from.
 */
const START_URL = 'https://www.google.com';

function getOrCreateSession(tabId: number, windowId?: number): BackgroundSession {
  let session = sessions.get(tabId);
  if (session) return session;

  const engine = new AgentRunner(tabId, windowId);
  session = { engine, ports: new Set<chrome.runtime.Port>(), lastBroadcastHadNoListeners: false, ownerTabId: tabId };
  sessions.set(tabId, session);

  // Each tab's runner broadcasts ONLY to that tab's own connected panels - never to a
  // neighbouring tab's, which is exactly the isolation this whole session model exists for.
  engine.setStateChangeCallback((state) => {
    broadcastToSession(session!, 'STATE_UPDATE', state);
    syncKeepaliveAlarm();
  });

  // When this runner takes on another tab - the one inside a window it opened via the
  // "open_window" action - register that TAB against this SAME session object rather than
  // letting a second, disconnected one spring up the moment a panel appears there.
  engine.setTabAdoptedCallback((newTabId) => {
    adoptTabIntoSession(session!, newTabId);
  });

  Logger.debug('Background', `[SESSION_CREATED] New session for tab [${tabId}].`);
  return session;
}

/**
 * Tear a session down when the tab that owns it closes.
 *
 * A tab the run merely visited is only unmapped - the session itself lives on in its owner
 * tab, so closing a pop-up the agent opened does not kill the task that opened it. Closing the
 * OWNER tab ends the session outright: its panel is gone with the tab, there is nothing left to
 * automate, and keeping the runner and its persisted state around would only leak both.
 */
function endSessionForClosedTab(tabId: number): void {
  const session = sessions.get(tabId);
  // After a worker restart a tab may have a kept run in storage and no session in this worker.
  if (!session) {
    AgentRunner.dropStoredState(tabId);
    return;
  }
  sessions.delete(tabId);

  if (session.ownerTabId !== tabId) {
    // The run may have been working in this adopted tab (a target="_blank" page the agent
    // followed, a self-closing OAuth or payment pop-up). The tab is gone, but the session
    // lives on in its owner tab, so the run must not keep aiming at the dead id: later
    // sites and the next perceive would all fail against it. Fall back to the owner tab
    // when it still exists; if it is gone too, its own onRemoved ends the session.
    if (session.engine.activeTabId === tabId) {
      void returnRunToOwnerTab(session, tabId);
    }
    Logger.debug('Background', `[SESSION_TAB_CLOSED] Tab [${tabId}] closed, but its session lives on in its owner tab [${session.ownerTabId}].`);
    return;
  }

  // Drop every other tab still pointing at this session - the session is over, so those
  // mappings would otherwise keep a dead runner reachable.
  for (const [otherTabId, other] of Array.from(sessions.entries())) {
    if (other === session) sessions.delete(otherTabId);
  }

  if (session.engine.status === 'running' || session.engine.status === 'paused') {
    session.engine.stop();
  }
  AgentRunner.forgetSession(session.engine.sessionId);
  Logger.debug('Background', `[SESSION_CLOSED] Tab [${tabId}] closed. Its session and persisted state are gone.`);
  syncKeepaliveAlarm();
}

/** True when the tab still exists (chrome.tabs.get answers it), false when it is gone or unknowable. */
function tabStillExists(tabId: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof chrome === 'undefined' || !chrome.tabs?.get) return resolve(true);
    const maybePromise: any = chrome.tabs.get(tabId, (t: chrome.tabs.Tab | undefined) => {
      resolve(Boolean(t) && !lastRuntimeError());
    });
    if (maybePromise && typeof maybePromise.then === 'function') {
      maybePromise.then((t: chrome.tabs.Tab | undefined) => resolve(Boolean(t)), () => resolve(false));
    }
  });
}

/**
 * Move a run whose working tab just closed back onto its owner tab.
 *
 * The engine's activeTabId setter also updates the runtime the graph nodes read, so the next
 * perceive aims at the owner tab. The history notice itself is written by the worker when its
 * next perceive sees the switch (that is where the run's history lives), so here only the tab
 * state moves.
 */
async function returnRunToOwnerTab(session: BackgroundSession, closedTabId: number): Promise<void> {
  const ownerTabId = session.ownerTabId;
  if (!(await tabStillExists(ownerTabId))) return;
  session.engine.activeTabId = ownerTabId;
  Logger.info('Background', `[TAB_FALLBACK] The working tab [${closedTabId}] closed. The run continues on the owner tab [${ownerTabId}].`);
}

// Clean network request buffers when tab is closed & track ScoutFox tab group removal.
// Both search every session rather than assuming a single global runner owns the tab/group -
// with one runner per tab, ownership has to be looked up, not assumed.
if (typeof chrome !== 'undefined') {
  if (chrome.tabs && chrome.tabs.onRemoved) {
    chrome.tabs.onRemoved.addListener((tabId: number) => {
      void cdp.detach(tabId);
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
    chrome.tabGroups.onRemoved.addListener((group: chrome.tabGroups.TabGroup) => {
      if (!group) return;
      // The group map is keyed by WINDOW even though sessions are keyed by tab - a Chrome tab
      // group cannot span windows, so that part stays window-shaped. Several tab ids can point
      // at the same session object, so this deduplicates before touching any runner.
      for (const session of new Set(sessions.values())) {
        for (const [windowId, groupId] of Array.from(session.engine.scoutFoxGroupIds.entries())) {
          if (groupId !== group.id) continue;
          Logger.debug('Background', `[TAB_SANDBOX] ScoutFox tab group [${group.id}] was closed by user (window [${windowId}]).`);
          session.engine.scoutFoxGroupIds.delete(windowId);
          void session.engine.persistState();
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
            type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
            requestHeaders: [
              { header: 'user-agent', operation: 'set' as chrome.declarativeNetRequest.HeaderOperation, value: 'claude-cli/2.1.158 (external, sdk-cli)' },
              { header: 'x-app', operation: 'set' as chrome.declarativeNetRequest.HeaderOperation, value: 'cli' }
            ]
          },
          condition: {
            urlFilter: '*://agentrouter.org/*',
            resourceTypes: ['xmlhttprequest' as chrome.declarativeNetRequest.ResourceType]
          }
        }
      ]
    });
    Logger.debug('Background', '[DNR] Active declarativeNetRequest rule set for AgentRouter (agentrouter.org)');
  } catch (err) {
    Logger.warn('Background', '[DNR_WARN] Could not initialize declarativeNetRequest rules', err);
  }
}

// Logs stay a single, shared, cross-window stream - a deliberate scope decision, not an
// oversight. The user's request was about ACTION isolation (session, tab group, history), not
// about hiding one window's debug telemetry from another; splitting Logger per-window would be
// a second, separately-scoped rework of the whole persist/clear/restore log system.
Logger.setBroadcastCallback((logEntry: unknown) => {
  broadcastToAllSidepanels('LOG_ENTRY', logEntry);
});

/**
 * Scope the side panel to one tab at a time, not the whole browser.
 *
 * The panel's page is set per tab (see setPanelVisibility and the action.onClicked handler), and
 * the manifest deliberately has NO side_panel.default_path. Declaring one registers the panel as
 * Chrome's fallback on EVERY tab of the browser, which is the "ScoutFox shows up everywhere"
 * symptom a user reported. The workaround that used to sit here disabled the panel globally at
 * startup; it fixed that symptom but made the panel impossible to open programmatically: with a
 * global setOptions({enabled:false}) on record, sidePanel.open() either rejects with "No active
 * side panel for tabId" or resolves without Chrome ever creating the panel document (verified on
 * Chromium 152, with and without a per-tab enable).
 *
 * Without a global default path there is nothing left to override, so no boot-time disable is
 * needed and open() works. What keeps tabs independent is unchanged: onActivated shows the panel
 * only on a tab that has a session and hides it everywhere else.
 */

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
  chrome.action.onClicked.addListener((tab: chrome.tabs.Tab) => {
    if (!(tab && tab.id)) return;

    // Enable + open the panel for the clicked tab UNCONDITIONALLY - isValidWebTab exists to
    // gate whether a tab can be SCRIPTED for automation (content-script injection), not
    // whether the panel UI can be shown at all. Gating this whole handler on it meant clicking
    // the icon while sitting on chrome://newtab - an entirely ordinary starting point for a
    // browser session - silently did nothing: setOptions and open() never even ran.
    setPanelVisibility(tab.id, true);

    // MUST be called synchronously in this same tick, with nothing awaited above it. Chrome
    // only honors sidePanel.open() as a genuine response to the click's user gesture for as
    // long as the call stack stays synchronous; crossing even one await loses that gesture and
    // open() then fails silently, since it's a fire-and-forget .catch(). setOptions() above is
    // fire-and-forget too (callback style, not awaited), so it does not cross that boundary
    // either.
    if (chrome.sidePanel && chrome.sidePanel.open) {
      chrome.sidePanel.open({ tabId: tab.id }).catch((err: unknown) => {
        Logger.warn('Background', '[SIDEPANEL_OPEN_FAILED] chrome.sidePanel.open() was rejected', err);
      });
    }

    // Clicking the toolbar icon opens the panel on the run the tab has, finished or not, also one
    // a restarted worker put back from storage: a reopened panel never loses what it showed. Each
    // task starts its own conversation with the model, so an old run is never fed to the next
    // one; "New chat" is how the user clears it. The session is built here so its restore starts.
    getOrCreateSession(tab.id, tab.windowId);

    // NO tab group is created here, deliberately.
    //
    // Opening the panel is not the same as starting work. Grouping on click reorganised the
    // user's tab strip - moving the tab, painting it orange, boxing it - just for looking at
    // the extension, before it had been asked to do anything at all. The group is a sandbox
    // marker for automation, so it belongs to a task: startTask() and getActiveTab() create it
    // when a run actually begins. Panel visibility does not need a group either: it is keyed
    // on "does this tab have a session" (see onActivated).
  });
}

if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onConnect) {
  chrome.runtime.onConnect.addListener((port: chrome.runtime.Port) => {
    // The port name's '_fresh'/plain distinction still parses, purely for the PORT_CONNECT log
    // line below - it no longer decides whether to clear history. Per-tab sessions replaced that
    // need: reopening the panel on a tab that already has a session (running or finished) always
    // reflects it, exactly like reopening a chat app shows the conversation that was already
    // there, rather than silently starting a new one every time. A tab's session is only ever
    // genuinely empty the first time THAT TAB is ever opened - and clearing an already-empty
    // runner is a harmless no-op, so there is nothing left to special-case here at all. Starting
    // over on purpose is what CLEAR_HISTORY is for.
    //
    // The id in the port name is the panel's own TAB, which it resolves for itself before
    // connecting (see sidepanel.js) - the background worker cannot work it out, because a side
    // panel port arrives with no sender.tab.
    const match = port.name.match(/^(scoutfox_sidepanel(?:_fresh)?)(?::(-?\d+))?$/);
    if (!match) return;
    if (match[2] === undefined) {
      // A panel that could not resolve its own tab id connects with a bare
      // name. Without a tab there is no session to scope the port to, so the
      // port is ignored - the panel re-resolves its tab before every reconnect
      // and then connects with the suffixed name (BUG-21).
      Logger.warn('Background', '[PORT_CONNECT] Sidepanel UI connected without a tab id in the port name; ignoring the port until the panel resolves its tab.');
      return;
    }

    const tabId = Number(match[2]);

    const session = getOrCreateSession(tabId);
    session.ports.add(port);
    session.lastBroadcastHadNoListeners = false;
    Logger.debug('Background', `[PORT_CONNECT] Sidepanel UI connected to tab [${tabId}]. Active ports for this tab: ${session.ports.size}`);

    port.onDisconnect.addListener(() => {
      session.ports.delete(port);
      Logger.debug('Background', `[PORT_DISCONNECT] Sidepanel UI disconnected from tab [${tabId}]. Active ports for this tab: ${session.ports.size}`);
    });

    // Keep the runner's idea of which window it is in current. A session is identified by its
    // tab, but tab groups are per-window, so the runner still needs to know where its tab lives -
    // and a tab can be dragged to another window after the session was created.
    if (chrome.tabs && chrome.tabs.get) {
      chrome.tabs.get(tabId, (t: chrome.tabs.Tab) => {
        lastRuntimeError();
        if (t && t.windowId !== undefined) session.engine.windowId = t.windowId;
      });
    }

    // Session creation is lazy - one is built the instant its tab's first port ever connects,
    // rather than a single runner constructed well before any real connection could land. That
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
        port.postMessage({ type: 'STATE_UPDATE', payload: session.engine.getState() });
      } catch (err) {
        Logger.warn('Background', 'Failed sending initial state update on port connect', err);
      }
    })();

    // The panel must stay visible on its own tab for as long as the session exists - a panel that
    // connected is a panel the user is looking at. No grouping happens here: that belongs to
    // starting a task, not to opening the panel (see the icon-click handler above).
    setPanelVisibility(tabId, true);
  });
}

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
export function broadcastToSession(session: BackgroundSession, type: string, payload: unknown): void {
  if (session.ports.size === 0) {
    if (!session.lastBroadcastHadNoListeners) {
      session.lastBroadcastHadNoListeners = true; // set BEFORE logging
      Logger.debugSilent('Background', `[BROADCAST_DROPPED] No sidepanel connected for tab [${session.engine.sessionId}] - "${type}" updates are being generated but nothing can receive them until that tab's panel reconnects.`);
    }
    return;
  }
  session.lastBroadcastHadNoListeners = false;
  for (const port of Array.from(session.ports)) {
    try {
      port.postMessage({ type, payload });
    } catch (err) {
      session.ports.delete(port); // remove FIRST, then report
      const errMsg = errorText(err);
      Logger.debugSilent('Background', `[BROADCAST_ERROR] Dropped a dead sidepanel port for tab [${session.engine.sessionId}] while sending "${type}": ${errMsg}. Active ports for this tab: ${session.ports.size}`);
    }
  }
}

let isBroadcastingToAll = false;

/** Fan a message out to EVERY connected panel across every window's session. Logs only. */
function broadcastToAllSidepanels(type: string, payload: unknown): void {
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
let keepaliveIntervalId: ReturnType<typeof setInterval> | null = null;

function anySessionActive(): boolean {
  for (const session of sessions.values()) {
    if (session.engine.status === 'running' || session.engine.status === 'paused') return true;
  }
  return false;
}

function syncKeepaliveAlarm(): void {
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
    if (typeof (keepaliveIntervalId as any)?.unref === 'function') {
      (keepaliveIntervalId as any).unref();
    }
    Logger.debug('Background', '[KEEPALIVE_ON] A task is active somewhere - holding the service worker awake.');
  } else if (!shouldRun && keepaliveIntervalId !== null) {
    clearInterval(keepaliveIntervalId);
    keepaliveIntervalId = null;
    Logger.debug('Background', '[KEEPALIVE_OFF] No task active in any window - releasing the service worker.');
  }

  if (typeof chrome === 'undefined' || !chrome.alarms) return;
  try {
    if (shouldRun) {
      chrome.alarms.get(KEEPALIVE_ALARM_NAME, (alarm: chrome.alarms.Alarm | undefined) => {
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

/**
 * Every tab a session may hold the debugger on: owner and adopted tabs (the session map's keys)
 * plus each runner's current working tab, which a run can reach before it is adopted. The
 * keepalive's leak sweep must never detach a tab a live run is working in.
 */
function tabsInUse(): Set<number> {
  const ids = new Set<number>(sessions.keys());
  for (const session of sessions.values()) {
    const active = session.engine.activeTabId;
    if (typeof active === 'number') ids.add(active);
  }
  return ids;
}

if (typeof chrome !== 'undefined' && chrome.alarms) {
  chrome.alarms.onAlarm.addListener((alarm: chrome.alarms.Alarm) => {
    if (alarm.name === KEEPALIVE_ALARM_NAME) {
      void cdp.reconcileLeakedTargets(tabsInUse());
      if (anySessionActive() && keepaliveIntervalId === null) {
        syncKeepaliveAlarm();
      }
    }
  });
}

// Every service-worker boot is logged, so an unexplained mid-task restart is visible
// in the log pane instead of appearing as the UI mysteriously going quiet.
Logger.debug('Background', `[WORKER_BOOT] Service worker started (build ${BUILD_STAMP}). MV3 restarts the worker frequently - this line marks a fresh incarnation.`);
void cdp.reconcileLeakedTargets(tabsInUse());

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
function releaseUserTabFromGroup(tab: chrome.tabs.Tab, groupIdForThisWindow?: number): void {
  if (!groupIdForThisWindow || typeof chrome === 'undefined' || !chrome.tabs || !chrome.tabs.ungroup || typeof tab.id !== 'number') return;
  if (tab.groupId !== groupIdForThisWindow) return;
  chrome.tabs.ungroup(tab.id, () => {
    lastRuntimeError();
    Logger.debug('Background', `[TAB_RELEASED] Chrome auto-added the user's new Tab ID [${tab.id}] to the 'ScoutFox' group [${groupIdForThisWindow}] because it was opened from a grouped tab. Removed it again - the group only ever holds tabs the agent itself opened (window [${tab.windowId}]).`);
  });
}

if (typeof chrome !== 'undefined' && chrome.tabs) {
  if (chrome.tabs.onCreated) {
    chrome.tabs.onCreated.addListener((tab: chrome.tabs.Tab) => {
      // Which session, if any, does this new tab belong to? Only the session whose agent is
      // running and whose own tab opened it - resolved from the OPENER, because the new tab has
      // no session of its own yet. A tab opened from a tab with no session is nobody's business.
      const session = tab.openerTabId !== undefined ? sessions.get(tab.openerTabId) : undefined;
      if (!session) return; // no session opened this tab - nothing to adopt it into

      // The tab must also live in the session's own window. The opener path exists for the
      // tabs a click in the working tab opens, and those land in the working tab's window; a
      // tab in some OTHER window (no ScoutFox session there) is nobody's business. A deliberate
      // second window comes through the open_window action, which adopts its tab itself.
      if (session.engine.windowId !== 'default' && tab.windowId !== session.engine.windowId) return;

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
          Logger.debug('Background', `[TAB_LEFT_ALONE] Tab [${tab.id}] was opened by the user, not by automation - keeping it outside the 'ScoutFox' group (window [${tab.windowId}]).`);
          releaseUserTabFromGroup(tab, groupIdForThisWindow);
        }
        return;
      }

      // The run is moving into this tab, so the tab joins the run's session. Without this the
      // panel would close the instant the agent followed a target="_blank" link: the new tab
      // would have no session, so the listeners below would find nothing to show there.
      if (typeof tab.id === 'number') {
        adoptTabIntoSession(session, tab.id);
      }

      if (groupIdForThisWindow && typeof chrome.tabs.group === 'function' && typeof tab.id === 'number') {
        chrome.tabs.group({ tabIds: tab.id, groupId: groupIdForThisWindow }, () => {
          lastRuntimeError();
          Logger.debug('Background', `[TAB_SANDBOX] Auto-grouped newly created Tab ID [${tab.id}] into 'ScoutFox' tab group [${groupIdForThisWindow}] (window [${tab.windowId}])`);
        });
      }

      if (typeof tab.id === 'number') setPanelVisibility(tab.id, true);

      if (session.engine.status === 'running' && typeof tab.id === 'number') {
        const newlyCreatedTabId = tab.id;
        setTimeout(() => {
          chrome.tabs.get(newlyCreatedTabId, (createdTab: chrome.tabs.Tab) => {
            // A tab that closed within the half second (a popup, a redirect helper) is just gone.
            if (lastRuntimeError()) return;
            if (createdTab && isValidWebTab(createdTab) && typeof createdTab.id === 'number') {
              Logger.debug('Background', `[NEW_TAB_DETECTED] Automation switching to newly opened Tab ID [${createdTab.id}] (window [${tab.windowId}])`);
              session.engine.activeTabId = createdTab.id;
            }
          });
        }, 500);
      }
    });
  }

  // Scope side panel visibility to the tabs that actually have a session. That is true from the
  // instant the icon is clicked, and does not depend on a tab group the user can drag tabs into
  // and out of.
  if (chrome.tabs.onActivated) {
    chrome.tabs.onActivated.addListener((activeInfo: chrome.tabs.OnActivatedInfo) => {
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
function setPanelVisibility(tabId: number, shouldShow: boolean): void {
  if (!tabId || typeof chrome === 'undefined' || !chrome.sidePanel || !chrome.sidePanel.setOptions) return;
  const opts = shouldShow
    ? { tabId, path: 'sidepanel/sidepanel.html', enabled: true }
    : { tabId, enabled: false };
  chrome.sidePanel.setOptions(opts, () => {
    lastRuntimeError();
  });
}

if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((request: any, sender: chrome.runtime.MessageSender, sendResponse: (response?: any) => void) => {
    let handled: boolean;
    try {
      handled = routeMessage(request, sender, sendResponse);
    } catch (err) {
      Logger.error('Background', `[MESSAGE_ROUTER_ERROR] Uncaught exception handling action [${request?.action}]`, err);
      try {
        const errMsg = errorText(err);
        sendResponse({ success: false, error: `Internal error: ${errMsg}` });
      } catch (_) {
        /* channel already closed */
      }
      return false;
    }
    return handled;
  });
}

function routeMessage(
  request: any,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: any) => void
): boolean {
  const { action, payload } = request || {};

  if (action === 'NET_REQUEST_RECORDED') {
    // Content scripts always carry a real sender.tab, so the tab - and therefore the session it
    // belongs to - is unambiguous here, the way it cannot be for a side-panel-originated
    // message (a side-panel port reaches this worker with no sender.tab at all, which is why
    // the panel has to resolve and send its own tabId).
    let tabId = sender.tab?.id;
    let session = tabId !== undefined ? sessions.get(tabId) : undefined;
    if (tabId === undefined) {
      // Fall back to whichever session has an active tab, for the rare sender with no tab info.
      session = Array.from(sessions.values()).find((s) => s.engine.activeTabId);
      tabId = session?.engine.activeTabId ?? undefined;
    }
    if (session && typeof tabId === 'number') session.engine.recordNetworkRequest(tabId, payload);
    sendResponse({ success: true });
    return true;
  }

  if (action === 'CLIENT_ERROR') {
    Logger.error('ClientError', `[${payload?.source || 'unknown'}] ${payload?.message || 'Unspecified client error'}`, payload?.stack || null);
    sendResponse({ success: true });
    return true;
  }

  if (action === 'FETCH_MODELS') {
    const providerId = payload?.provider;
    // Only a provider this build knows (a built-in) or one the caller describes (a user-added
    // endpoint) can be asked for its models. Anything else is state drift, and the honest answer
    // is an error that names it - never a silent empty list or another provider's ids.
    if (!providerId || (!BUILTIN_PROVIDER_IDS.includes(providerId) && !payload?.customProviders?.[providerId])) {
      sendResponse({ success: false, error: `Provider ${providerId ? `"${providerId}" ` : ''}is not configured for a model fetch. Open Settings and pick or add a provider.`, models: [] });
      return true;
    }
    const forceRefresh = !!payload?.forceRefresh;
    const fetchMeta: { filteredCount?: number } = {};
    fetchAvailableModels(payload, forceRefresh, fetchMeta)
      .then((models) => sendResponse({ success: true, models, filteredCount: fetchMeta.filteredCount }))
      .catch((err) => {
        // A user-added endpoint falls back to the list its user saved (possibly empty), never to
        // another provider's curated list; the built-ins keep theirs. The HTTP status, when the
        // failure carries one, lets the panel tell "no model list" (404/405) from a real failure.
        const savedCustom = payload?.customProviders?.[payload?.provider]?.models;
        const fallbacks = Array.isArray(savedCustom) ? savedCustom : getFallbackModels(providerId);
        sendResponse({ success: false, error: errorText(err), status: (err as { status?: number })?.status, models: fallbacks });
      });
    return true;
  }

  if (action === 'GET_BUILD') {
    // The panel compares this with its own stamp. Chrome loads a new panel page from disk on every
    // open, but keeps the old worker running until the extension is reloaded, so the two can differ.
    sendResponse({ success: true, build: BUILD_STAMP });
    return true;
  }

  if (action === 'GET_EFFORT_SUPPORT') {
    // Which effort levels the composer offers for the provider and model in the payload (a
    // settings snapshot, like FETCH_MODELS). For Ollama the first answer may ask /api/show.
    resolveEffortSupport(payload || {})
      .then((support) => sendResponse({ success: true, support }))
      .catch((err) => sendResponse({ success: false, error: errorText(err) }));
    return true;
  }

  if (action === 'TEST_PROVIDER') {
    // The connectivity probe of the Add/Edit dialog (the "Test" button): one minimal chat call
    // through the very same path a real task uses, so what it reports is what a run would meet.
    // The probe carries its own deadline; a provider that accepts and never answers cannot park it.
    const probeSignal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(20000) : undefined;
    const startedAt = Date.now();
    callProvider(
      payload?.provider,
      payload,
      [{ role: 'user', content: 'Reply with the single word: ok' }],
      'You are a connection test. Reply with the single word: ok.',
      { signal: probeSignal }
    )
      .then((reply) => sendResponse({ success: true, reply: reply.slice(0, 200), latencyMs: Date.now() - startedAt }))
      .catch((err) => sendResponse({ success: false, error: errorText(err), latencyMs: Date.now() - startedAt }));
    return true;
  }

  if (action === 'CLEAR_LOGS') {
    // Handled here, BEFORE any session is resolved - Logger keeps its own in-memory
    // logsHistory independent of any window's runner, shared across every session by design
    // (see the comment above Logger.setBroadcastCallback).
    Logger.clearLogs();
    sendResponse({ success: true });
    return true;
  }

  const TAB_ACTIONS = new Set([
    'GET_AGENT_STATE',
    'START_TASK',
    'PAUSE_TASK',
    'RESUME_TASK',
    'STOP_TASK',
    'ANSWER_QUESTION',
    'APPROVE_PLAN',
    'CONFIRM_ACTION',
    'RESOLVE_CHALLENGE',
    'CONTINUE_BUDGET',
    'CLEAR_HISTORY',
    'GET_SCREENSHOT'
  ]);

  if (TAB_ACTIONS.has(action)) {
    // A panel whose tab id is unknown sends tabId: null (sidepanel.js) - that
    // must resolve like an ABSENT tab id (sender tab or the only session), not
    // create a session keyed by null (BUG-21).
    const targetTabId: number = request.tabId != null
      ? request.tabId
      : (sender?.tab?.id !== undefined ? sender.tab.id : (sessions.size > 0 ? (sessions.keys().next().value ?? 0) : 0));

    const session = getOrCreateSession(targetTabId);
    const runner = session.engine;

    if (action === 'GET_AGENT_STATE') {
      // Logger's own cold-boot restore is itself async. Answering with getLogsHistory()
      // immediately used to race it: a resync landing before the restore finished got back an
      // empty array, which the panel trusted and used to overwrite logs it had already shown.
      // Waiting here makes the answer always complete, so nothing downstream has to guess.
      // The runner's own restore (the run kept across a worker restart) is waited for too: an
      // answer before it would be the empty state, and the panel would show the start screen.
      Promise.all([Logger.logsRestored(), runner.restorePromise.catch(() => {})]).then(() => {
        sendResponse({ ...runner.getState(), logs: Logger.getLogsHistory() });
      });
      return true;
    }

    if (action === 'START_TASK') {
      // Claim synchronously, before any await, so a double-clicked send button cannot open two
      // concurrent runs. onMessage handlers are serialized, so this is the one point where the
      // second request is guaranteed to see the first.
      const claim = runner.claimForTask();
      if (!claim.success) {
        sendResponse(claim);
        return true;
      }

      getActiveTab(session, targetTabId)
        .then((tab) => {
          if (!tab || typeof tab.id !== 'number') {
            runner.releaseTaskClaim();
            throw new Error('No automatable tab found. ScoutFox cannot script Chrome\'s internal pages (chrome://…) - open a normal website such as https://google.com and try again.');
          }
          // Plans are approved automatically: the plan card is no longer part of the product.
          // Only an explicit payload.autoApprove:false (tests, or a future opt-in tool) still holds.
          runner.startTask(payload.prompt, tab.id, payload.effort, payload.autoApprove ?? true).catch((err) => {
            Logger.error('Background', '[START_TASK_ERROR] Uncaught exception starting task', err);
          });
          sendResponse({ success: true, tabId: tab.id, tabUrl: tab.url, tabTitle: tab.title });
        })
        .catch((err) => {
          runner.releaseTaskClaim();
          Logger.error('Background', 'Failed to start task', err);
          sendResponse({ success: false, error: errorText(err) });
        });
      return true;
    }

    // These now report whether they actually did anything, instead of always answering success.
    // A Resume that finds nothing to resume (common after a worker restart) must say so.
    if (action === 'PAUSE_TASK') {
      sendResponse(runner.pause());
      return true;
    }

    if (action === 'RESUME_TASK') {
      sendResponse(runner.resume());
      return true;
    }

    if (action === 'STOP_TASK') {
      sendResponse(runner.stop());
      return true;
    }

    if (action === 'ANSWER_QUESTION') {
      sendResponse(runner.answerQuestion(payload && payload.answer));
      return true;
    }

    const replyWhenDone = (work: Promise<unknown>): true => {
      work.then(() => sendResponse({ success: true }), (err) => sendResponse({ success: false, error: errorText(err) }));
      return true;
    };

    if (action === 'APPROVE_PLAN') return replyWhenDone(runner.approvePlan(payload));
    if (action === 'CONFIRM_ACTION') return replyWhenDone(runner.confirmAction(payload?.decision, payload?.remember));
    if (action === 'RESOLVE_CHALLENGE') return replyWhenDone(runner.resolveChallenge(payload?.action));
    if (action === 'CONTINUE_BUDGET') return replyWhenDone(runner.continueBudget(payload?.action, payload?.additionalSteps));

    if (action === 'GET_SCREENSHOT') {
      // The picture's bytes stay in memory, in the session, and never in a history row. A
      // picture the registry no longer holds answers success:false, and the panel says so.
      runner.getScreenshot(String(payload?.imageId || '')).then((held) => {
        sendResponse(held ? { success: true, data: held.data, mediaType: held.mediaType } : { success: false, error: 'That picture is no longer kept.' });
      }, (err) => sendResponse({ success: false, error: errorText(err) }));
      return true;
    }

    if (action === 'CLEAR_HISTORY') {
      runner.clearHistory();
      sendResponse({ success: true });
      return true;
    }
  }

  // Anything unrecognised used to fall off the end returning undefined, which closes the
  // message channel with no reply - the caller's callback then fires with res === undefined
  // and no lastError, indistinguishable from success.
  Logger.warn('Background', `[UNKNOWN_ACTION] Received an unrecognised message action: "${action}". Ignoring.`);
  sendResponse({ success: false, error: `Unknown action: ${action}` });
  return true;
}

/** Bring a tab to the front of its window, so automation is never invisible to the user. */
function activateTab(tabId: number): Promise<void> {
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
function sessionTabIds(session: BackgroundSession): number[] {
  const ids: number[] = [];
  for (const [tabId, s] of sessions.entries()) {
    if (s === session && typeof tabId === 'number') ids.push(tabId);
  }
  return ids;
}

/**
 * Pick the tab to automate for THIS session.
 *
 * This is not a search. The session owns a tab, the panel is attached to that tab, and that is
 * the tab the user is watching - so the only questions are whether it can be scripted and, if
 * not, what to do about it. Never the window's focused tab: that may belong to another session.
 *
 * requestingTabId is the tab whose panel sent START_TASK. It only matters if this has to open a
 * new tab: that panel is the one holding the user's Enter/click gesture, so it is the one asked
 * to follow the run there (see the PANEL_HANDOFF broadcast below).
 */
async function getActiveTab(session: BackgroundSession, requestingTabId?: number): Promise<chrome.tabs.Tab | null> {
  if (!session) return null;

  // Wait for the persisted session to land before reading anything off the runner.
  //
  // MV3 kills the service worker constantly, and a START_TASK is usually what wakes it back up,
  // so on that path the constructor's restoreState() is still in flight right here. Reading the
  // group map before it resolves answers null for a session that does in fact have a group,
  // which sends this function down the "nothing to automate" path and opens yet another tab -
  // repeating the whole sequence on every worker restart.
  try {
    await session.engine.restorePromise;
  } catch (err) {
    Logger.warn('Background', '[TAB_PICK] Session restore failed; picking a tab from a clean state', err);
  }

  // Among the tabs this session covers, prefer the one that is actually in front of the user.
  // For a first task that is simply the tab they opened the panel on; for a follow-up after the
  // agent moved into a tab it opened, it is that tab - which is where they are still looking.
  const candidates = await Promise.all(sessionTabIds(session).map((id) => new Promise<chrome.tabs.Tab | null>((resolve) => {
    if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.tabs.get) return resolve(null);
    chrome.tabs.get(id, (t) => { lastRuntimeError(); resolve(t || null); });
  })));
  const live = candidates.filter((t): t is chrome.tabs.Tab => Boolean(t));
  const focused = live.find((t) => t.active) || live.find((t) => t.id === session.ownerTabId) || live[0] || null;

  if (focused && isValidWebTab(focused)) {
    return focused;
  }

  // The session's tab cannot be scripted, but if it is a THROWAWAY page - a new-tab page, a
  // blank tab - then it holds nothing the user would miss, and the right move is to navigate it
  // where it stands rather than open a second tab beside it. Every new window starts on
  // chrome://newtab, so this is the common first-task path, not an edge case.
  //
  // Reusing it also protects the side panel. The panel is scoped per tab id, so creating and
  // activating a different tab moves the active tab out from under the open panel and Chrome
  // closes it; only sidePanel.open() can bring one back, and that needs a user gesture this
  // code path does not have. Navigating in place never changes the active tab id, so there is
  // nothing for Chrome to close.
  if (focused && typeof focused.id === 'number' && isDisposableTab(focused) && typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.update) {
    const focusedTabId = focused.id;
    Logger.debug('Background', `[TAB_REUSED] The session's tab [${focusedTabId}] (${focused.url}) is an empty page, so this task runs in it rather than opening another tab beside it.`);
    try {
      await session.engine.ensureScoutFoxGroup(focusedTabId, focused.windowId);
    } catch (err) {
      Logger.warn('Background', '[TAB_SANDBOX_ERROR] Could not group the reused tab', err);
    }
    setPanelVisibility(focusedTabId, true);
    await new Promise<void>((resolve) => {
      chrome.tabs.update(focusedTabId, { url: START_URL }, () => {
        lastRuntimeError();
        resolve();
      });
    });
    await session.engine.waitForTabComplete(focusedTabId, 4000);
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
  const newTab = await new Promise<chrome.tabs.Tab>((resolve) => {
    if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.create) {
      const createOpts: chrome.tabs.CreateProperties = { url: START_URL, active: false };
      if (focused && typeof focused.windowId === 'number') createOpts.windowId = focused.windowId;
      // Right beside the tab it was launched from, rather than appended to the far end of the
      // strip where the user has to go hunting for it.
      if (focused && typeof focused.index === 'number') createOpts.index = focused.index + 1;
      chrome.tabs.create(createOpts, (t) => {
        lastRuntimeError();
        resolve(t);
      });
    } else {
      resolve({ id: 999, url: START_URL } as chrome.tabs.Tab);
    }
  });

  // The run is moving into this tab, so the tab belongs to this session from here on - that is
  // what lets the panel keep showing this run once the tab comes to the front.
  if (typeof newTab.id === 'number') {
    adoptTabIntoSession(session, newTab.id);
  }

  // Group it and enable the panel on it BEFORE it is activated. The enable must land first or
  // the handoff's open() is rejected with "No active side panel for tabId", and onActivated
  // must find the tab already in this session or it disables the panel again on arrival.
  // ensureScoutFoxGroup is idempotent, so startTask calling it again right after is a no-op.
  if (typeof newTab.id === 'number') {
    try {
      await session.engine.ensureScoutFoxGroup(newTab.id, newTab.windowId);
    } catch (err) {
      Logger.warn('Background', '[TAB_SANDBOX_ERROR] Could not group the freshly opened tab', err);
    }
    setPanelVisibility(newTab.id, true);
    // The run must be visible - driving a background tab is what made a finished run look like
    // nothing had happened - so the tab comes to the front even if the handoff below fails.
    await activateTab(newTab.id);
  }

  // Sent before waiting for the page to load, not after: the panel's gesture is only good for
  // about five seconds, and a slow page load alone can use most of that.
  broadcastToSession(session, 'PANEL_HANDOFF', { tabId: newTab.id, fromTabId: requestingTabId });

  if (typeof newTab.id === 'number') {
    await session.engine.waitForTabComplete(newTab.id, 4000);
  }

  // A tab straight out of tabs.create has only pendingUrl, so without the fallback the panel
  // reports the run as starting on an "unknown URL".
  return { ...newTab, url: newTab.url || newTab.pendingUrl || START_URL, active: true };
}
