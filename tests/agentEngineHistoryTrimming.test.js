/**
 * Regression test: trimHistory() (caps history at MAX_HISTORY=400, agentEngine.js) used to be
 * called from only 2 of the 6+ history-mutating code paths - the user_goal push in startTask
 * and the successful execution_result push. Every OTHER path (ask_user, an error entry, a
 * finish, a parse failure, ...) left history to grow past the cap until one of those two
 * specific pushes happened to occur again.
 *
 * Fixed by trimming centrally in notifyStateChange(), which every history-mutating path already
 * calls (directly, or via setPhase()) before it returns - so trimming now runs after literally
 * every push, not just two of them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

global.chrome = {
  storage: { local: { get: (keys, cb) => cb({}), set: (data, cb) => cb && cb() } },
  tabs: { get: (id, cb) => cb({ id, groupId: -1, url: 'https://example.com' }), query: async () => [] }
};

const { AgentEngine } = await import('../background/agentEngine.js');

test('a history push via ask_user (a path the old code never trimmed after) is still capped at MAX_HISTORY', async () => {
  const engine = new AgentEngine();
  await engine.restorePromise;
  engine.persistState = async () => {};

  // Seed right at the cap with placeholder entries that are neither user_goal nor
  // execution_result - the two paths the old code DID trim after - so this test genuinely
  // exercises a path that previously fell through uncapped.
  engine.history = Array.from({ length: 400 }, (_, i) => ({ type: 'step_start', step: i }));
  engine.status = 'running';

  // Mirrors what runLoopBody's ask_user branch actually does: push one more entry, then pause
  // and set the phase - notifyStateChange (via setPhase) is the only place this ever gets
  // trimmed on this path.
  engine.history.push({ type: 'agent_response', action: { action: 'ask_user', question: 'Which one?' } });
  engine.status = 'paused';
  engine.pendingQuestion = 'Which one?';
  engine.setPhase('Waiting for your answer...');

  assert.equal(engine.history.length, 400, 'must be trimmed back to the cap, not left at 401');
});

test('history genuinely exceeding the cap is trimmed from the front on the very next state change', async () => {
  const engine = new AgentEngine();
  await engine.restorePromise;
  engine.persistState = async () => {};

  engine.history = Array.from({ length: 410 }, (_, i) => ({ type: 'step_start', step: i }));
  engine.notifyStateChange();

  assert.equal(engine.history.length, 400);
  assert.equal(engine.history[0].step, 10, 'must drop the OLDEST entries, keeping the most recent 400');
});
