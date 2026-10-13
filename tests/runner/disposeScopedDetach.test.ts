// BUG-33 regression: dispose() used to call the module-wide cdp.detachAll(),
// so closing one session's owner tab detached every OTHER session's debugger
// too - their in-flight trusted input failed and fell back to synthetic events.
// dispose() (and the runtime's own detach facade) must detach only the tabs
// THIS session attached.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeChrome } from '../helpers/fakeChrome.ts';
import { createFakeStorage } from '../helpers/fakeStorageSession.ts';
import { fakeDom } from '../helpers/fakeDom.ts';
import { AgentRunner } from '../../src/background/runner/AgentRunner.ts';
import { cdp } from '../../src/background/browser/cdp.ts';

const LIST_URL = 'https://shop.test/items';

function setupEnvironment() {
  const store = createFakeStorage({
    local: {
      data: {
        agent_settings: {
          provider: 'openrouter',
          baseUrl: 'https://openrouter.ai/api/v1',
          model: 'test-model',
          maxSteps: 5,
          actionDelayMs: 1,
        },
      },
    },
  });
  const site = fakeDom({
    pages: [{ url: LIST_URL, title: 'Items List', text: ['Item 42 available for 99 USD'] }],
  });
  const fc = fakeChrome({
    tabs: { list: [{ id: 101, windowId: 1, url: LIST_URL }, { id: 202, windowId: 1, url: LIST_URL }] },
    tabGroups: true,
    windows: true,
    storage: store,
    dom: true,
    scripting: { executeScript: () => [{ result: true }] },
    debugger: true,
  });
  site.attach(fc, 101);
  const restoreChrome = fc.install();
  return { store, fc, site, restoreChrome };
}

test('dispose() detaches only this session\'s tabs, not the other session\'s debugger (BUG-33)', async () => {
  const { restoreChrome } = setupEnvironment();
  try {
    const engineA = new AgentRunner(101, 1, undefined, undefined);
    await engineA.restorePromise;

    // Session A attached its own tab 101; session B (another runner on tab 202)
    // attached 202. Both live in the same module-level cdp.
    const runtimeA = (engineA as any).runtime;
    runtimeA.attachedTabIds.add(101);
    await cdp.attach(101);
    await cdp.attach(202);
    assert.equal(cdp.isAttached(101), true);
    assert.equal(cdp.isAttached(202), true);

    // The user closes tab 101: endSessionForClosedTab disposes session A.
    engineA.dispose();

    assert.equal(cdp.isAttached(101), false, 'the disposed session detaches its own tab');
    assert.equal(cdp.isAttached(202), true, 'the other session\'s debugger must stay attached');
  } finally {
    restoreChrome();
  }
});

test('the runtime cdp facade detaches only this session\'s tabs (BUG-33)', async () => {
  const { restoreChrome } = setupEnvironment();
  try {
    const engineA = new AgentRunner(101, 1, undefined, undefined);
    await engineA.restorePromise;
    const runtimeA = (engineA as any).runtime;
    runtimeA.attachedTabIds.add(101);
    await cdp.attach(101);
    await cdp.attach(202);

    // finalize calls the runtime's browser cdp facade (session-scoped), not the module-wide
    // detachAll.
    await runtimeA.browser.cdp.detachAll();

    assert.equal(cdp.isAttached(101), false, 'the session detaches its own tab');
    assert.equal(cdp.isAttached(202), true, 'the other session\'s debugger must stay attached');
    engineA.dispose();
  } finally {
    restoreChrome();
  }
});

// BUG-34: a Stop landing between START_TASK's claim and startTask must cancel
// the task instead of being silently eaten by the flag reset.
test('a stop landing during the task claim cancels the start (BUG-34)', async () => {
  const { restoreChrome } = setupEnvironment();
  try {
    const engine = new AgentRunner(101, 1, undefined, undefined);
    await engine.restorePromise;

    const claim = engine.claimForTask();
    assert.equal(claim.success, true);
    // The user hits Stop while the tab pick is in flight: status is still idle,
    // but the claim window makes the stop meaningful.
    const stopRes = engine.stop();
    assert.equal(stopRes.success, true, JSON.stringify(stopRes));

    const startRes = await engine.startTask('Should never run', 101);
    assert.equal(startRes.success, false, JSON.stringify(startRes));
    assert.equal(engine.status, 'stopped');
    assert.equal(engine.currentTask, '', 'the task text must not stick around as if it were running');

    // The claim is released: the next start works normally.
    const claim2 = engine.claimForTask();
    assert.equal(claim2.success, true);
    engine.releaseTaskClaim();
  } finally {
    restoreChrome();
  }
});

// BUG-38: the history mirror's type_step dedupe key collapsed distinct rows -
// two stepless user_answer entries in one site shared `user_answer_undefined`.
test('history mirror keeps two stepless user_answer rows from one site (BUG-38)', async () => {
  const { restoreChrome } = setupEnvironment();
  try {
    const engine = new AgentRunner(101, 1, undefined, undefined);
    await engine.restorePromise;

    const first = { type: 'user_answer', answer: 'Yes, continue with the first option.', step: undefined };
    const second = { type: 'user_answer', answer: 'No, use the cheaper plan instead.', step: undefined };
    // Worker value chunks re-deliver the full site history each time.
    (engine as any).absorbStreamValues(['site:s1:worker'], { history: [first] });
    (engine as any).absorbStreamValues(['site:s1:worker'], { history: [first, second] });

    const rows = engine.history.filter((h: any) => h.type === 'user_answer');
    assert.equal(rows.length, 2, `both rows must appear, got ${JSON.stringify(engine.history)}`);

    // A third re-delivery of the same chunk must not duplicate anything.
    (engine as any).absorbStreamValues(['site:s1:worker'], { history: [first, second] });
    assert.equal(engine.history.filter((h: any) => h.type === 'user_answer').length, 2, 're-delivered rows stay deduped');

    // Two same-type entries at the same step also stay distinct (a banned-action
    // error and an LLM-failure error both logged at step 3).
    const banned = { type: 'error', step: 3, text: 'banned action' };
    const llmErr = { type: 'error', step: 3, text: 'model returned no action' };
    (engine as any).absorbStreamValues(['site:s1:worker'], { history: [first, second, banned, llmErr] });
    const errs = engine.history.filter((h: any) => h.type === 'error' && h.step === 3);
    assert.equal(errs.length, 2, `both same-step errors must appear, got ${JSON.stringify(errs)}`);
  } finally {
    restoreChrome();
  }
});

// BUG-39: a run-opened tab whose ScoutFox grouping fails must stay perceivable.
// The old scope wall threw terminal out_of_scope on every snapshot of the tab
// the agent itself had just opened.
test('a run-opened tab stays in scope when its grouping fails (BUG-39)', async () => {
  const { restoreChrome, fc, site } = setupEnvironment();
  try {
    const engine = new AgentRunner(101, 1, undefined, undefined);
    await engine.restorePromise;

    // Simulate chrome.tabs.group failing: ensureGroup returns null.
    (engine as any).ensureScoutFoxGroup = async () => null;
    engine.setTabAdoptedCallback((newTabId) => {
      site.attach(fc, newTabId);
    });

    const res = await engine.openNewWindow('https://shop.test/items');
    assert.equal(res.success, true, JSON.stringify(res));
    const newTabId = (res as any).tabId as number;
    assert.equal(typeof newTabId, 'number');

    const scope = await (engine as any).runtime.browser.isTabInScope(newTabId);
    assert.equal(scope, true, 'the adopted tab must stay in scope without a group');

    // The wall still applies to tabs the session never adopted.
    const foreign = await (engine as any).runtime.browser.isTabInScope(202);
    assert.equal(foreign, false, 'a foreign tab stays out of scope');
  } finally {
    restoreChrome();
  }
});

// BUG-40: every STATE_UPDATE broadcast used to clone the full evidence ledger
// (up to 60 entries / 150k chars) over the port, once per stream chunk.
test('STATE_UPDATE payloads do not carry the evidence snapshot (BUG-40)', async () => {
  const { restoreChrome } = setupEnvironment();
  try {
    const engine = new AgentRunner(101, 1, undefined, undefined);
    await engine.restorePromise;

    let payload: any = null;
    engine.setStateChangeCallback((s) => {
      payload = s;
    });

    // Give the ledger real bulk: 60 entries of page text.
    (engine as any).evidenceSnapshot = {
      v: 1,
      entries: Array.from({ length: 60 }, (_, i) => ({
        kind: 'page',
        url: `https://shop.test/page-${i}`,
        text: 'x'.repeat(2000),
        ts: i,
      })),
      visits: [],
    };

    (engine as any).notifyStateChange();

    assert.ok(payload, 'the state callback fired');
    assert.equal('evidence' in payload, false, 'STATE_UPDATE must not clone the ledger');
    // Ledger consumers read it directly off the runner.
    assert.equal((engine as any).evidenceSnapshot.entries.length, 60);
  } finally {
    restoreChrome();
  }
});

// BUG-41: throttled meta writes dropped every payload but the first, so storage
// kept a stale stateVersion/group map until the next write.
test('scheduleWrite inside the throttle window keeps the LATEST meta (BUG-41)', async () => {
  const { createFakeStorage } = await import('../helpers/fakeStorageSession.ts');
  const { SessionRunnerMeta } = await import('../../src/background/runner/runnerMeta.ts');
  const store = createFakeStorage({});
  const fc = fakeChrome({ storage: store });
  const restore = fc.install();
  try {
    const meta = new SessionRunnerMeta('tab-41');

    (meta as any).lastWrittenAt = Date.now(); // pretend a write just happened
    meta.scheduleWrite({ stateVersion: 1, scoutFoxGroupIds: [], aliases: [], attachedTabIds: [], pauseDetach: null, lastBeatAt: 1 });
    meta.scheduleWrite({ stateVersion: 2, scoutFoxGroupIds: [], aliases: [], attachedTabIds: [], pauseDetach: null, lastBeatAt: 2 });
    meta.scheduleWrite({ stateVersion: 3, scoutFoxGroupIds: [[1, 77]], aliases: [], attachedTabIds: [101], pauseDetach: null, lastBeatAt: 3 });

    await new Promise((r) => setTimeout(r, 300));
    const stored = await meta.read();
    assert.ok(stored, 'the throttled write fired');
    assert.equal(stored!.stateVersion, 3, `storage holds the latest payload, got ${stored!.stateVersion}`);
    assert.deepEqual(stored!.scoutFoxGroupIds, [[1, 77]]);
  } finally {
    restore();
  }
});

// BUG-42: the pause idle-detach armed only the active tab, leaving debuggers
// attached (with Chrome's "debugging" bar) on the session's adopted tabs.
test('the pause idle-detach timer arms every attached tab (BUG-42)', async () => {
  const { restoreChrome } = setupEnvironment();
  try {
    const engine = new AgentRunner(101, 1, undefined, undefined);
    await engine.restorePromise;
    const runtimeA = (engine as any).runtime;
    runtimeA.attachedTabIds.add(101);
    runtimeA.attachedTabIds.add(202);
    await cdp.attach(101);
    await cdp.attach(202);

    (engine as any).startPauseDetachTimer();

    assert.ok((cdp as any).attachedTabs.get(101)?.pauseTimer, 'the active tab has a pause timer');
    assert.ok((cdp as any).attachedTabs.get(202)?.pauseTimer, 'the adopted tab has a pause timer too');
    engine.dispose();
  } finally {
    restoreChrome();
  }
});

// BUG-44: a rejoin whose chrome.tabs.group call failed was logged as success
// with the stale group id; the next snapshot then died with out_of_scope.
test('a failed group rejoin falls through to creating a fresh group (BUG-44)', async () => {
  const { restoreChrome, fc } = setupEnvironment();
  try {
    // The first tabs.group call CREATES the group; the second (the rejoin) fails.
    let groupCalls = 0;
    (globalThis as any).__scoutfox_group_script = () => {
      groupCalls += 1;
      return groupCalls === 1 ? true : new Error('No group with id: 77.');
    };
    const engine = new AgentRunner(101, 1, undefined, undefined);
    await engine.restorePromise;

    // The runner builds its own chrome-backed calls; rewire tabs.group through
    // the fake's call record so the SECOND invocation reports a failure.
    const tabsApi = (globalThis as any).chrome.tabs;
    const realGroup = tabsApi.group.bind(tabsApi);
    let rejoinFailed = false;
    tabsApi.group = (details: any, cb?: any) => {
      groupCalls += 1;
      if (details.groupId !== undefined && String(details.tabIds).includes('101')) {
        rejoinFailed = true;
        // Callback style with lastError, like Chrome reports a dead group: the
        // fake exposes lastError as a getter, so scope the poisoned getter to
        // exactly this callback.
        queueMicrotask(() => {
          const runtimeApi = (globalThis as any).chrome.runtime;
          const desc = Object.getOwnPropertyDescriptor(runtimeApi, 'lastError');
          Object.defineProperty(runtimeApi, 'lastError', { configurable: true, get: () => ({ message: 'No group with id: 77.' }) });
          try {
            cb && cb(undefined);
          } finally {
            if (desc) Object.defineProperty(runtimeApi, 'lastError', desc);
          }
        });
        return;
      }
      return realGroup(details, cb);
    };

    const firstGroup = await engine.ensureScoutFoxGroup(101, 1);
    assert.ok(firstGroup, 'the initial group was created');

    // Keep the group alive with a second member, then pull tab 101 out of it:
    // the next ensure must REJOIN 101 into the still-valid group.
    await new Promise<void>((resolve) =>
      (globalThis as any).chrome.tabs.group({ tabIds: [202], groupId: firstGroup }, () => resolve())
    );
    await new Promise<void>((resolve) => (globalThis as any).chrome.tabs.ungroup([101], () => resolve()));

    const rejoined = await engine.ensureScoutFoxGroup(101, 1);
    assert.ok(rejoined, 'a fresh group is created after the failed rejoin');
    assert.equal(rejoinFailed, true, 'the test actually exercised the failed rejoin');
    assert.notEqual(rejoined, firstGroup, 'the stale group id is not returned');

    // The tab is grouped again: the scope wall lets snapshots through.
    const scope = await (engine as any).runtime.browser.isTabInScope(101);
    assert.equal(scope, true, 'the tab is perceivable again after the fresh group');
    engine.dispose();
  } finally {
    restoreChrome();
  }
});
