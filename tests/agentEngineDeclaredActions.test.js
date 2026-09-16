/**
 * Regression test: press_key, go_forward and wait were fully implemented in
 * content/actionExecutor.js and already validated by KNOWN_ACTIONS, but the system prompt never
 * told the model they existed - the model could not use tools that were already built.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

global.chrome = {
  storage: { local: { get: (keys, cb) => cb({}), set: (data, cb) => cb && cb() } },
  tabs: { get: (id, cb) => cb({ id, groupId: -1, url: 'https://example.com' }), query: async () => [] }
};

const { AgentEngine } = await import('../background/agentEngine.js');

test('the system prompt declares press_key, go_forward and wait', () => {
  const engine = new AgentEngine();
  const prompt = engine.buildSystemPrompt('You are ScoutFox.');

  assert.match(prompt, /"action":\s*"press_key"/);
  assert.match(prompt, /"action":\s*"go_forward"/);
  assert.match(prompt, /"action":\s*"wait"/);
});
