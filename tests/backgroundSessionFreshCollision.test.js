/**
 * Regression test for a real production bug: a completed run's results were wiped roughly
 * 15-30s after finishing, with no user action.
 *
 * Root cause, traced from the actual service-worker log: chrome.tabs.onCreated auto-enables
 * the side panel for every tab it auto-groups into the ScoutFox tab group (background.js's
 * TAB_SANDBOX handler). When the agent's own navigation opened a second tab and that tab
 * became active, Chrome loaded a genuinely separate side-panel DOCUMENT for it - its own JS
 * realm, with its own honest hasConnectedBefore=false. That document's first connection named
 * itself '_fresh', which onConnect's SESSION_FRESH check (added earlier this session) trusted
 * at face value and cleared the shared AgentEngine history - wiping the result the FIRST,
 * still-open panel was showing.
 *
 * The observed log sequence this reproduces exactly:
 *   PORT_CONNECT  Active ports: 1     <- the real panel reconnecting after a worker restart
 *   PORT_CONNECT  Active ports: 2     <- a second, different panel connecting for the first time
 *   SESSION_FRESH ...clearHistory()   <- the second one wipes the first one's visible result
 *
 * Fix: '_fresh' only clears when it is the SOLE connected panel. A second panel connecting
 * fresh while another is already up suppresses the clear instead.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const REAL_HISTORY = [
  { step: 1, type: 'agent_response', thought: 'looking', action: { action: 'navigate', url: 'https://example.com' } },
  { step: 1, type: 'finish', answer: 'The answer the user is currently reading.' }
];

function makeBackgroundChromeMock() {
  // Seeded as if a run just completed and persisted itself - the exact state
  // agentEngine.persistState()/restoreState() produce for a finished task.
  const storage = {
    agent_session: {
      history: REAL_HISTORY,
      planSteps: [],
      task: 'a task the user just ran',
      stepCount: 2,
      status: 'idle',
      currentPlanIndex: 0,
      activeTabId: 42,
      stateVersion: 1,
      scoutFoxGroupId: 5001
    }
  };
  const noop = () => {};
  const listener = () => ({ addListener: noop });
  return {
    runtime: {
      lastError: null,
      onConnect: { addListener: (fn) => { global.__connectListener = fn; } },
      onMessage: { addListener: noop }
    },
    storage: {
      local: {
        get: (keys, cb) => {
          const result = {};
          (Array.isArray(keys) ? keys : [keys]).forEach((k) => { result[k] = storage[k]; });
          cb(result);
        },
        set: (data, cb) => { Object.assign(storage, data); if (cb) cb(); },
        remove: (keys, cb) => { if (cb) cb(); }
      }
    },
    tabs: { onRemoved: listener(), onActivated: listener(), onCreated: listener(), onUpdated: listener(), query: (q, cb) => cb([]) },
    tabGroups: { onRemoved: listener() },
    alarms: { create: noop, clear: noop, get: (name, cb) => cb(null), onAlarm: listener() },
    action: { onClicked: listener() },
    declarativeNetRequest: { updateSessionRules: () => Promise.resolve() },
    sidePanel: { setPanelBehavior: () => Promise.resolve(), setOptions: (opts, cb) => cb && cb(), open: noop }
  };
}

/** A fake port: records every postMessage payload, lets the test disconnect it. */
function makeFakePort(name) {
  const disconnectListeners = [];
  return {
    name,
    received: [],
    postMessage(msg) { this.received.push(msg); },
    onDisconnect: { addListener: (fn) => disconnectListeners.push(fn) },
    _disconnect() { disconnectListeners.forEach((fn) => fn()); }
  };
}

/**
 * The port also receives LOG_ENTRY broadcasts interleaved with STATE_UPDATE messages (every
 * Logger call broadcasts to every connected port) - most visibly the very diagnostic logging
 * this fix itself adds (SESSION_FRESH / SESSION_FRESH_SUPPRESSED). The last message overall is
 * not reliably a STATE_UPDATE, so pick the last one that actually is.
 */
function lastStateUpdate(port) {
  return [...port.received].reverse().find((m) => m.type === 'STATE_UPDATE');
}

global.self = { addEventListener: () => {} };
global.chrome = makeBackgroundChromeMock();

await import('../background/background.js');

// AgentEngine's constructor kicks off an async restoreState() read of agent_session. Give it
// a tick to land before either port connects, matching the real STATE_RESTORE-before-
// PORT_CONNECT ordering seen in the actual log.
await new Promise((r) => setTimeout(r, 20));

test('a second panel connecting fresh does not wipe a session the first panel is still showing', async () => {
  // Port 1: the real panel reconnecting after a worker restart - matches the log exactly,
  // where this connection was NOT named '_fresh' and correctly did not clear anything.
  const port1 = makeFakePort('scoutfox_sidepanel');
  global.__connectListener(port1);

  const baseline = lastStateUpdate(port1);
  assert.ok(baseline, 'port1 must receive an initial STATE_UPDATE on connect');
  assert.deepEqual(baseline.payload.history, REAL_HISTORY,
    'the restored session must still hold the real history before the second panel connects');

  // Port 2: a second, genuinely new panel document - e.g. one Chrome loaded for a tab the
  // agent's own navigation auto-grouped and that later became active. From ITS own point of
  // view this really is a first-ever connection, hence '_fresh'.
  const port2 = makeFakePort('scoutfox_sidepanel_fresh');
  global.__connectListener(port2);

  // The bug: this second connection called agentEngine.clearHistory(), and the NEXT broadcast
  // to port1 would carry an empty history - silently wiping the result out from under the
  // panel the user was actually looking at. Prove it didn't, by checking the latest state
  // port1 was told about: no post-port2-connect STATE_UPDATE may show an empty/different history.
  const afterPort2 = lastStateUpdate(port1);
  assert.deepEqual(afterPort2.payload.history, REAL_HISTORY,
    'a second panel opening fresh while the first is still connected must not clear the shared session');

  port1._disconnect();
  port2._disconnect();
});

test('a genuinely solitary fresh open still starts a clean session (unchanged intended behavior)', async () => {
  // Re-seed a fresh non-empty session and reconnect with the same single-port sequence a real
  // standalone "reopen the extension" flow produces, to confirm the historical "chats start
  // fresh on every new opening" behavior is untouched by this fix for the normal, single-panel
  // case - only the multi-panel collision is now guarded.
  const port = makeFakePort('scoutfox_sidepanel_fresh');
  global.__connectListener(port);

  const msg = lastStateUpdate(port);
  assert.deepEqual(msg.payload.history, [],
    'a solitary fresh-open connection must still clear history exactly as before this fix');

  port._disconnect();
});
