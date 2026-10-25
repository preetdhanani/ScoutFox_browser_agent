/**
 * Recent tasks: which runs get saved, and how the list is drawn.
 *
 * What these tests hold on to:
 *   1. A panel opened while a run is already going (it never submitted the task itself) still
 *      saves that run to Recent tasks when it ends, through the same state path the port uses.
 *   2. The run is saved once: a second panel that ends up saving the same run reuses the entry
 *      instead of adding a duplicate, and a repeated broadcast does not write again.
 *   3. A run that ended while no panel was open is saved by the next panel that opens (resync).
 *   4. A session the user opened from the list is not overwritten by the live run of the tab.
 *   5. The list escapes every stored field it puts into markup (timestamp, model, id).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { install, settle } from './fakePanelDom.js';

const { getEl, storage } = install();

const { receiveState, initEventListeners, loadSettings, loadSelectedSession } = await import('../../sidepanel/sidepanel.js');

initEventListeners();
await loadSettings();

let version = 0;
function stateOf(status, prompt, { turn = 1, timestamp = '10:00:00', extraRows = 1 } = {}) {
  const history = [{ type: 'user_goal', turn, prompt, timestamp, isNewRun: true }];
  for (let i = 0; i < extraRows; i++) {
    history.push({ type: 'agent_response', step: i + 1, thought: '', action: { action: 'scroll', direction: 'down' }, rawResponse: '{}' });
  }
  if (status !== 'running') history.push({ type: 'finish', answer: `Answer for ${prompt}` });
  version += 1;
  return { status, task: prompt, history, planSteps: [], stepCount: extraRows, stateVersion: version, bootId: 'boot-sessions' };
}

function sessions() {
  return storage.data.saved_sessions || [];
}

test('a panel opened mid-run saves the run to Recent tasks when it ends', async () => {
  storage.data.saved_sessions = [];
  receiveState(stateOf('running', 'Reopened run'));
  await settle();
  assert.equal(sessions().length, 0, 'nothing is saved while the run is live');

  receiveState(stateOf('idle', 'Reopened run'));
  await settle(10);
  assert.equal(sessions().length, 1);
  assert.equal(sessions()[0].task, 'Reopened run');
  assert.ok(sessions()[0].id, 'the saved run has an id');

  // The same terminal state broadcast again writes nothing new.
  receiveState(stateOf('idle', 'Reopened run'));
  await settle(10);
  assert.equal(sessions().length, 1);
});

test('a run another panel already saved is updated, not duplicated', async () => {
  const run = stateOf('idle', 'Shared run', { turn: 1, timestamp: '11:11:11', extraRows: 2 });
  storage.data.saved_sessions = [{
    id: 'session_other_panel',
    task: 'Shared run',
    timestamp: 'earlier',
    model: 'm',
    provider: 'openai',
    history: run.history.slice(0, 2),
    planSteps: []
  }];
  // New chat clears this panel's id, as a reopened panel would have none for this run.
  await getEl('btnNewChat').dispatchEvent('click');
  receiveState(run);
  await settle(10);
  assert.equal(sessions().length, 1, 'no duplicate entry');
  assert.equal(sessions()[0].id, 'session_other_panel');
  assert.equal(sessions()[0].history.length, run.history.length, 'the entry holds the whole run now');
});

test('a run that ended while the panel was closed is saved on reopen', async () => {
  storage.data.saved_sessions = [];
  await getEl('btnNewChat').dispatchEvent('click');
  receiveState(stateOf('completed', 'Finished while closed', { timestamp: '12:00:00' }));
  await settle(10);
  assert.equal(sessions().length, 1);
  assert.equal(sessions()[0].task, 'Finished while closed');
});

test('a session opened from the list is not overwritten by the live run', async () => {
  const opened = stateOf('idle', 'Old saved run', { timestamp: '08:00:00' });
  storage.data.saved_sessions = [{ id: 'session_old', task: 'Old saved run', timestamp: 'x', model: 'm', provider: 'openai', history: opened.history, planSteps: [] }];

  // Open it from the list.
  await loadSelectedSession('session_old');
  await settle(10);

  // A later broadcast of the tab's own (different) run.
  receiveState(stateOf('idle', 'Tab live run', { timestamp: '13:00:00' }));
  await settle(10);
  const old = sessions().find((s) => s.id === 'session_old');
  assert.equal(old.task, 'Old saved run', 'the old entry keeps its own run');
  assert.ok(sessions().some((s) => s.task === 'Tab live run'), 'the live run gets its own entry');
});

test('the Recent tasks list escapes the stored timestamp, model and id', async () => {
  storage.data.saved_sessions = [{
    id: 'x" onmouseover="alert(1)',
    task: 'Task <b>1</b>',
    timestamp: '<img src=x onerror=alert(1)>',
    model: '<script>alert(2)</script>',
    provider: 'openai',
    history: [],
    planSteps: []
  }];
  getEl('historyDrawer').style.display = 'none';
  await getEl('btnToggleHistory').dispatchEvent('click');
  await settle(10);
  const html = getEl('historySessionsList').innerHTML;
  assert.equal(html.includes('<img'), false, 'timestamp is escaped');
  assert.equal(html.includes('<script>'), false, 'model is escaped');
  assert.equal(html.includes('" onmouseover="'), false, 'id is escaped in the data attributes');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
});
