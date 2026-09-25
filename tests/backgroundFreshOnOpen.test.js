/**
 * Regression test for a real user complaint: reopening the side panel resumed the previous
 * session's history, and that stale conversation got summarized (previousTurnsSummary()) back
 * into the very next task's LLM prompt - burning tokens on a conversation the user had already
 * moved on from and didn't ask to continue.
 *
 * Fix: clicking the toolbar icon - a deliberate, explicit "open ScoutFox" gesture, unlike an
 * internal port reconnect - clears an idle/finished session's history before anything else.
 * A session that is ACTUALLY running or paused right now must be left completely alone: that
 * is the exact "wipe an in-progress run" bug backgroundSessionFreshCollision.test.js and
 * multiWindowSameSessionE2E.test.js already guard against on the reconnect path - this file
 * only asserts the click path does not reintroduce it from a different angle.
 *
 * Note on what "running" means here: a *persisted* status of 'running'/'paused' loaded fresh
 * from storage is always a dead worker-restart zombie - restoreState() itself already resets
 * it to 'idle' and appends an interruption notice (see the STATE_RESTORE_INTERRUPTED path in
 * agentEngine.js). A genuinely active run only ever exists in-memory, in an already-constructed
 * session. So this file drives a REAL task via ApiClients.generateCompletion stubbed to hang
 * mid-run (same technique multiWindowSameSessionE2E.test.js uses), rather than seeding storage.
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakePort, lastStateUpdate, sendMessage } from './helpers/fakePort.js';

const { ApiClients } = await import('../background/apiClients.js');

const STALE_HISTORY = [
  { type: 'user_goal', turn: 1, prompt: 'an old, unrelated finished task', timestamp: '1:00:00 PM' },
  { type: 'finish', answer: 'The old answer the user already read and moved on from.' }
];

function makeMock() {
  const tabs = new Map([[100, { id: 100, url: 'https://example.com/a', groupId: -1, windowId: 1 }]]);
  const storage = {
    // Keyed by TAB id now - sessions are per tab, so this is the persisted session belonging to
    // tab 100, the tab this file clicks the icon on.
    agent_sessions: {
      100: {
        history: STALE_HISTORY,
        planSteps: [],
        task: 'an old, unrelated finished task',
        stepCount: 2,
        status: 'idle',
        currentPlanIndex: 0,
        activeTabId: 100,
        stateVersion: 1,
        scoutFoxGroupId: 5001
      }
    }
  };
  const noop = () => {};
  const listeners = {};
  let groupCounter = 5000;

  return {
    __tabs: tabs,
    __listeners: listeners,
    chrome: {
      runtime: {
        lastError: null,
        onConnect: { addListener: (fn) => { listeners.onConnect = fn; } },
        onMessage: { addListener: (fn) => { listeners.onMessage = fn; } }
      },
      storage: {
        get session() { return this.local; }, // agent_sessions lives in storage.session; one backing store keeps seeds simple
        local: {
          get: (keys, cb) => {
            const result = {};
            (Array.isArray(keys) ? keys : [keys]).forEach((k) => { result[k] = storage[k]; });
            cb(result);
          },
          set: (data, cb) => { Object.assign(storage, data); if (cb) cb(); },
          remove: (k, cb) => cb && cb()
        }
      },
      tabs: {
        onRemoved: { addListener: noop },
        onActivated: { addListener: noop },
        onCreated: { addListener: noop },
        onUpdated: { addListener: noop },
        query: async () => [tabs.get(100)],
        // getTabDOMWithAutoInject() calls this with NO callback and awaits it as a promise;
        // isTabInScope() calls it WITH a callback. Support both, like agentEngine.js itself does.
        get: (id, cb) => {
          const tab = tabs.get(id);
          if (cb) { cb(tab); return; }
          return Promise.resolve(tab);
        },
        sendMessage: (tabId, msg, cb) => cb({
          success: true,
          data: {
            title: 'Test Page', url: 'https://example.com/a',
            scrollState: { scrollY: 0, pageHeight: 800, viewportHeight: 800 },
            elements: [], elementsText: '', elementCount: 0, pageText: ''
          }
        }),
        // Honours opts.groupId, like the real API: joining an EXISTING group must put the tab
        // in that group, not mint a new one. A double that always minted a new id made a tab
        // joining its own restored group land somewhere else, and the engine's own scope check
        // (isTabInScope, which compares tab.groupId against the recorded group) then refused to
        // touch the very tab it had just grouped.
        group: (opts, cb) => {
          const gid = opts.groupId || groupCounter++;
          const ids = Array.isArray(opts.tabIds) ? opts.tabIds : [opts.tabIds];
          ids.forEach((id) => { const t = tabs.get(id); if (t) t.groupId = gid; });
          cb(gid);
        },
        ungroup: (ids, cb) => cb && cb()
      },
      tabGroups: { onRemoved: { addListener: noop }, get: (id, cb) => cb({ id, title: 'ScoutFox' }), update: (id, opts, cb) => cb && cb() },
      alarms: { create: noop, clear: noop, get: (n, cb) => cb(null), onAlarm: { addListener: noop } },
      action: { onClicked: { addListener: (fn) => { listeners.onClicked = fn; } } },
      declarativeNetRequest: { updateSessionRules: () => Promise.resolve() },
      sidePanel: {
        setPanelBehavior: () => Promise.resolve(),
        setOptions: (opts, cb) => cb && cb(),
        open: () => Promise.resolve()
      }
    }
  };
}

global.self = { addEventListener: () => {} };
const mock = makeMock();
global.chrome = mock.chrome;

await import('../background/background.js');
await new Promise((r) => setTimeout(r, 20));

test('clicking the icon on an idle session with stale history starts fresh', async () => {
  const port = makeFakePort('scoutfox_sidepanel_fresh:100');
  mock.__listeners.onConnect(port);
  await new Promise((r) => setTimeout(r, 20));

  const baseline = lastStateUpdate(port);
  assert.deepEqual(baseline.payload.history, STALE_HISTORY,
    'sanity check: the stale session really is showing before the click');

  mock.__listeners.onClicked(mock.__tabs.get(100));
  await new Promise((r) => setTimeout(r, 30));

  const afterClick = lastStateUpdate(port);
  assert.notEqual(afterClick, baseline, 'clicking the icon must push a fresh STATE_UPDATE');
  assert.deepEqual(afterClick.payload.history, [],
    'an idle session\'s stale history must be cleared on the deliberate "open ScoutFox" click');
  assert.equal(afterClick.payload.task, null, 'the stale task must be cleared too');
});

// Stub the LLM so a real task can be driven all the way to a genuinely live 'running' status,
// then deliberately hang on the first step's action-decision call - pinning the run in
// 'running' for as long as this test needs it, exercising the real claimForTask/startTask
// code path rather than hand-setting status on an engine this file has no reference to.
const realGenerateCompletion = ApiClients.generateCompletion;
ApiClients.generateCompletion = async (settings, messages, systemPrompt) => {
  if (systemPrompt === 'You are a web task planner.') {
    return JSON.stringify(['Do the one thing']);
  }
  return new Promise(() => {}); // never resolves - the run stays 'running' indefinitely
};
after(async () => {
  ApiClients.generateCompletion = realGenerateCompletion;
  // The stub above never resolves, so the loop is permanently stuck awaiting it and the
  // KEEPALIVE_ON setInterval (started because status stayed 'running'/'paused' throughout)
  // would otherwise keep this file's process alive forever. STOP_TASK moves status off both,
  // which is all syncKeepaliveAlarm() checks - clearing the interval regardless of the
  // abandoned promise still technically pending underneath.
  await sendMessage(mock.__listeners, { action: 'STOP_TASK', tabId: 100 });
});

test('clicking the icon while a task is genuinely running leaves it completely untouched', async () => {
  const port = makeFakePort('scoutfox_sidepanel_fresh:100');
  mock.__listeners.onConnect(port);
  await new Promise((r) => setTimeout(r, 20));

  // Real START_TASK, through the real message router - not a hand-set status flag.
  await sendMessage(mock.__listeners, { action: 'START_TASK', tabId: 100, payload: { prompt: 'a brand new real task' } });
  await new Promise((r) => setTimeout(r, 40));

  const running = lastStateUpdate(port);
  assert.equal(running.payload.status, 'running', 'sanity check: the task must actually be running before the click');

  mock.__listeners.onClicked(mock.__tabs.get(100));
  await new Promise((r) => setTimeout(r, 30));

  const afterClick = lastStateUpdate(port);
  assert.equal(afterClick.payload.status, 'running',
    'a session that is genuinely running must never be cleared just because the icon was clicked again - ' +
    'that would wipe an in-progress run out from under the user, the exact bug class the reconnect-path tests guard against');
  assert.notEqual(afterClick.payload.task, null, 'the live task must survive the click');
});

test('clicking the icon while a task is paused leaves it completely untouched', async () => {
  const port = makeFakePort('scoutfox_sidepanel_fresh:100');
  mock.__listeners.onConnect(port);
  await new Promise((r) => setTimeout(r, 20));

  await sendMessage(mock.__listeners, { action: 'PAUSE_TASK', tabId: 100 });
  await new Promise((r) => setTimeout(r, 20));

  const paused = lastStateUpdate(port);
  assert.equal(paused.payload.status, 'paused', 'sanity check: the task must actually be paused before the click');

  mock.__listeners.onClicked(mock.__tabs.get(100));
  await new Promise((r) => setTimeout(r, 30));

  const afterClick = lastStateUpdate(port);
  assert.equal(afterClick.payload.status, 'paused',
    'a paused session must never be cleared just because the icon was clicked again');
  assert.notEqual(afterClick.payload.task, null, 'the paused task must survive the click');
});
