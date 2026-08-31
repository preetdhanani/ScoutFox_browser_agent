/**
 * Regression tests for the MV3 service-worker lifecycle.
 *
 * These cover the failure that made the extension appear to "go blank" after a few tasks:
 * AgentEngine's constructor kicks off an ASYNC restoreState(). When a START_TASK message is
 * what cold-boots the worker, startTask() begins mutating state while that storage read is
 * still in flight — and the late-landing read then overwrote history/planSteps/status with
 * the PREVIOUS session, killing the loop and leaving the previous run's checklist on screen.
 *
 * The mock below deliberately delays the storage read so the race is reproduced on every run
 * rather than being timing-dependent.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

let storageBacking = {};
let storageReadDelayMs = 0;

global.chrome = {
  runtime: { lastError: null },
  storage: {
    local: {
      get: (keys, cb) => {
        const snapshot = { ...storageBacking };
        if (storageReadDelayMs > 0) {
          setTimeout(() => cb(snapshot), storageReadDelayMs);
        } else {
          cb(snapshot);
        }
      },
      set: (data, cb) => {
        Object.assign(storageBacking, data);
        if (cb) cb();
      }
    }
  },
  tabs: {
    query: async () => [{ id: 101, url: 'https://example.com' }],
    sendMessage: (tabId, msg, cb) => cb({ success: true }),
    onUpdated: { addListener: () => {}, removeListener: () => {}, hasListener: () => false }
  }
};

const { AgentEngine } = await import('../background/agentEngine.js');

/** A session persisted by a previous run that was killed mid-task. */
const STALE_SESSION = {
  agent_session: {
    history: [{ type: 'user_goal', prompt: 'the OLD task' }],
    planSteps: [
      { id: 1, text: 'old step one', status: 'completed' },
      { id: 2, text: 'old step two', status: 'completed' }
    ],
    task: 'the OLD task',
    stepCount: 7,
    status: 'running',
    currentPlanIndex: 2,
    stateVersion: 42
  }
};

function resetStorage(seed = {}) {
  storageBacking = JSON.parse(JSON.stringify(seed));
}

test('restoreState does not clobber a task that starts during a cold boot', async () => {
  resetStorage(STALE_SESSION);
  storageReadDelayMs = 50; // storage read lands well after startTask() begins

  const engine = new AgentEngine();

  // Stub out everything past plan generation so we observe state, not a real agent run.
  engine.generatePlan = async () => {
    engine.planSteps = [{ id: 1, text: 'new step one', status: 'in_progress' }];
  };
  let loopRan = false;
  engine.runLoop = async () => { loopRan = true; };

  await engine.startTask('the NEW task', 101);

  // Let any late storage callback land before asserting.
  await new Promise(r => setTimeout(r, 120));

  assert.equal(engine.currentTask, 'the NEW task', 'the stale session must not overwrite the live task');
  assert.equal(engine.status, 'running', 'status must not be reset to idle by the late restore');
  assert.equal(engine.stepCount, 0, 'stepCount must not be restored from the stale session');
  assert.equal(engine.planSteps[0].text, 'new step one', 'the OLD checklist must not reappear');
  assert.ok(loopRan, 'the execution loop must actually start');
  // Sessions are multi-turn now, so a restored earlier turn is legitimately retained — the
  // requirement is that it stays an EARLIER turn and never displaces the live one.
  const goals = engine.history.filter(h => h.type === 'user_goal').map(h => h.prompt);
  assert.equal(goals[goals.length - 1], 'the NEW task', 'the new goal must be the active turn');
  assert.equal(engine.currentTurnHistory()[0].prompt, 'the NEW task',
    'the current turn must start at the new goal, not the restored one');
});

test('an interrupted running task is surfaced to the user, not silently dropped', async () => {
  resetStorage(STALE_SESSION);
  storageReadDelayMs = 0;

  const engine = new AgentEngine();
  await engine.restorePromise;

  assert.equal(engine.status, 'idle', 'a zombie running status must be forced back to idle');
  assert.ok(
    engine.history.some(h => h.type === 'error' && /interrupted/i.test(h.content || '')),
    'the user must see WHY the previous task stopped — silence is the bug being fixed'
  );
});

test('stateVersion stays monotonic across a service-worker restart', async () => {
  resetStorage(STALE_SESSION);
  storageReadDelayMs = 0;

  const engine = new AgentEngine();
  await engine.restorePromise;

  assert.ok(
    engine.stateVersion > 42,
    `restored stateVersion (${engine.stateVersion}) must exceed the persisted watermark, ` +
    'otherwise the sidepanel discards every update from the new worker as stale'
  );
});

test('each engine instance gets a distinct bootId', async () => {
  resetStorage();
  storageReadDelayMs = 0;

  const a = new AgentEngine();
  const b = new AgentEngine();
  await Promise.all([a.restorePromise, b.restorePromise]);

  assert.ok(a.bootId && b.bootId, 'bootId must always be present');
  assert.notEqual(a.bootId, b.bootId, 'the sidepanel relies on bootId to detect a worker restart');
});

test('state broadcasts carry both bootId and stateVersion', async () => {
  resetStorage();
  storageReadDelayMs = 0;

  const engine = new AgentEngine();
  await engine.restorePromise;

  let received = null;
  engine.setStateChangeCallback((state) => { received = state; });
  engine.notifyStateChange();

  assert.ok(received, 'the state-change callback must fire');
  assert.equal(received.bootId, engine.bootId);
  assert.equal(typeof received.stateVersion, 'number');
});

test('clearHistory during a pending restore is not undone by the late snapshot', async () => {
  resetStorage(STALE_SESSION);
  storageReadDelayMs = 50;

  const engine = new AgentEngine();
  // The user hits "New Session" while the cold-boot storage read is still in flight.
  engine.clearHistory();

  await new Promise(r => setTimeout(r, 120));

  assert.equal(engine.currentTask, null, 'the cleared session must stay cleared');
  assert.deepEqual(engine.history, [], 'the old history must not be restored over the clear');
  assert.deepEqual(engine.planSteps, [], 'the old checklist must not reappear');
});

test('pause and resume report failure instead of falsely claiming success', async () => {
  resetStorage();
  storageReadDelayMs = 0;

  const engine = new AgentEngine();
  await engine.restorePromise;

  const pauseRes = engine.pause(); // status is 'idle', nothing to pause
  assert.equal(pauseRes.success, false, 'pausing an idle agent must not report success');
  assert.match(pauseRes.error, /not running/i);

  const resumeRes = engine.resume(); // nothing was paused
  assert.equal(resumeRes.success, false, 'resuming with nothing paused must not report success');
  assert.match(resumeRes.error, /re-run/i, 'the error must tell the user what to do');
});

test('stop() aborts the in-flight request rather than only flipping a flag', async () => {
  resetStorage();
  storageReadDelayMs = 0;

  const engine = new AgentEngine();
  await engine.restorePromise;

  engine.abortController = new AbortController();
  const signal = engine.abortController.signal;
  assert.equal(signal.aborted, false);

  const res = engine.stop();
  assert.equal(res.success, true);
  assert.equal(signal.aborted, true, 'a Stop must cancel the pending LLM call, not wait it out');
  assert.equal(engine.status, 'stopped');
});

test('state broadcasts no longer carry the whole log ring', async () => {
  resetStorage();
  storageReadDelayMs = 0;

  const engine = new AgentEngine();
  await engine.restorePromise;

  let received = null;
  engine.setStateChangeCallback((state) => { received = state; });
  engine.notifyStateChange();

  assert.equal(
    received.logs, undefined,
    'setPhase fires this ~7x per step — shipping the 300-entry ring here cost hundreds of KB per step'
  );
});

/**
 * Reproduces the production failure from the log: the user sat on chrome://extensions after
 * reloading the extension, getActiveTab() correctly picked a different, automatable tab, and
 * getTabDOMWithAutoInject then injected into the FOCUSED tab instead of the target — failing
 * with "Cannot access a chrome:// URL" and naming the wrong page in the error.
 */
test('DOM read targets the tab it was given, not whichever tab is focused', async () => {
  resetStorage();
  storageReadDelayMs = 0;

  const TARGET = 555;   // the automatable tab the task is bound to
  const FOCUSED = 999;  // chrome://extensions, where the user happens to be looking

  const injectedInto = [];
  const tabsById = {
    [TARGET]: { id: TARGET, url: 'https://example.com/products' },
    [FOCUSED]: { id: FOCUSED, url: 'chrome://extensions/' }
  };

  // The content script is NOT yet present on the target tab, so the first read fails and the
  // injection path — the one that had the bug — is actually exercised.
  let scriptsPresent = false;

  global.chrome.tabs.get = async (id) => tabsById[id];
  global.chrome.tabs.query = async () => [tabsById[FOCUSED]]; // focus is on chrome://extensions
  global.chrome.tabs.sendMessage = (id, msg, cb) => {
    if (id === TARGET && scriptsPresent) {
      cb({ success: true, data: { url: tabsById[TARGET].url, elementCount: 3 } });
    } else {
      cb(undefined); // rejects via sendTabMessage
    }
  };
  global.chrome.scripting = {
    executeScript: async ({ target }) => {
      injectedInto.push(target.tabId);
      // Chrome refuses to script its own pages — mirror that, which is what produced the
      // original "Cannot access a chrome:// URL" failure.
      if (tabsById[target.tabId] && /^chrome:\/\//.test(tabsById[target.tabId].url)) {
        throw new Error('Cannot access a chrome:// URL');
      }
      if (target.tabId === TARGET) scriptsPresent = true;
      return [];
    }
  };

  const engine = new AgentEngine();
  await engine.restorePromise;

  const snap = await engine.getTabDOMWithAutoInject(TARGET, false);

  assert.equal(snap.url, 'https://example.com/products', 'the snapshot must come from the target tab');
  assert.ok(
    !injectedInto.includes(FOCUSED),
    `must never inject into the focused chrome:// tab (injected into: ${JSON.stringify(injectedInto)})`
  );
});

test('a restricted URL fails with the real reason, not "refresh and try again"', async () => {
  resetStorage();
  storageReadDelayMs = 0;

  global.chrome.tabs.get = async () => ({ id: 42, url: 'chrome://extensions/' });
  global.chrome.scripting = { executeScript: async () => { throw new Error('should never be reached'); } };

  const engine = new AgentEngine();
  await engine.restorePromise;

  await assert.rejects(
    () => engine.getTabDOMWithAutoInject(42, false),
    (err) => {
      assert.match(err.message, /chrome:\/\/extensions/, 'must name the page it could not read');
      assert.match(err.message, /blocks all extensions/i, 'must explain that this is a browser restriction');
      assert.doesNotMatch(err.message, /refresh|reload/i, 'must not suggest a reload — that can never work here');
      return true;
    }
  );
});

test('a closed target tab is reported as closed', async () => {
  resetStorage();
  storageReadDelayMs = 0;

  global.chrome.tabs.get = async () => { throw new Error('No tab with id: 777.'); };

  const engine = new AgentEngine();
  await engine.restorePromise;

  await assert.rejects(
    () => engine.getTabDOMWithAutoInject(777, false),
    /no longer exists/i
  );
});

test('a follow-up task keeps the previous turn instead of wiping the session', async () => {
  resetStorage();
  storageReadDelayMs = 0;

  const engine = new AgentEngine();
  engine.generatePlan = async () => { engine.planSteps = [{ id: 1, text: 'p', status: 'in_progress' }]; };
  engine.runLoop = async () => {};
  await engine.restorePromise;

  await engine.startTask('find the cheapest iPhone', 101);
  engine.history.push({ type: 'finish', answer: 'It is 933 EUR in white.' });

  await engine.startTask('now add it to the cart', 101);

  const goals = engine.history.filter(h => h.type === 'user_goal').map(h => h.prompt);
  assert.deepEqual(goals, ['find the cheapest iPhone', 'now add it to the cart'],
    'both turns must survive \u2014 otherwise "it" has no referent');
  assert.equal(engine.turnIndex, 2);
  assert.equal(engine.stepCount, 0, 'step count resets per turn');

  // The follow-up must actually be told what happened earlier.
  const messages = engine.formatMessagesForLLM('current page state');
  const recap = messages.find(m => /Earlier in this session/.test(m.content));
  assert.ok(recap, 'the prompt must carry a recap of completed turns');
  assert.match(recap.content, /cheapest iPhone/);
  assert.match(recap.content, /933 EUR/);
});

test('currentTurnHistory isolates the active turn from earlier ones', async () => {
  resetStorage();
  storageReadDelayMs = 0;

  const engine = new AgentEngine();
  await engine.restorePromise;

  engine.history = [
    { type: 'user_goal', turn: 1, prompt: 'first' },
    { step: 1, type: 'agent_response', action: { action: 'click' }, rawResponse: 'a' },
    { type: 'finish', answer: 'done one' },
    { type: 'user_goal', turn: 2, prompt: 'second' },
    { step: 1, type: 'agent_response', action: { action: 'scroll' }, rawResponse: 'b' }
  ];

  const cur = engine.currentTurnHistory();
  assert.equal(cur.length, 2);
  assert.equal(cur[0].prompt, 'second');
  assert.equal(engine.previousTurnsSummary().length, 1, 'only the completed turn is recapped');
});

test('New Session clears every turn', async () => {
  resetStorage();
  storageReadDelayMs = 0;

  const engine = new AgentEngine();
  engine.generatePlan = async () => {};
  engine.runLoop = async () => {};
  await engine.restorePromise;

  await engine.startTask('one', 101);
  await engine.startTask('two', 101);
  engine.clearHistory();

  assert.deepEqual(engine.history, []);
  assert.equal(engine.turnIndex, 0);
  assert.equal(engine.previousTurnsSummary().length, 0);
});

test('a clean cold boot with no persisted session leaves the engine empty', async () => {
  resetStorage();
  storageReadDelayMs = 0;

  const engine = new AgentEngine();
  await engine.restorePromise;

  assert.equal(engine.status, 'idle');
  assert.equal(engine.currentTask, null);
  assert.deepEqual(engine.history, []);
  assert.deepEqual(engine.planSteps, []);
});
