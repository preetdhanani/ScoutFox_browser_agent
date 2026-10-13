import test from 'node:test';
import assert from 'node:assert/strict';
import { graphRig, act } from '../helpers/graphHarness.ts';
import { Logger } from '../../src/shared/logger.ts';
import { parseModelReply } from '../../src/background/agent/parse.ts';

test('logger: emits required diagnostic tags matched by side panel LOG_FILTER_KEYWORDS', async () => {
  const loggedTags = new Set<string>();
  const origInfo = Logger.info;
  const origWarn = Logger.warn;

  const intercept = (tag: string, msg: string) => {
    const match = msg.match(/\[([A-Z_]+)\]/);
    if (match) loggedTags.add(`[${match[1]}]`);
  };

  Logger.info = (tag: string, msg: string) => {
    intercept(tag, msg);
    origInfo.call(Logger, tag, msg);
  };
  Logger.warn = (tag: string, msg: string) => {
    intercept(tag, msg);
    origWarn.call(Logger, tag, msg);
  };

  const rig = await graphRig({
    policy: [
      act.scroll('down', 100),
      act.finish('Found product details.'),
    ],
  });

  try {
    await rig.start('Inspect product');
    assert.equal(rig.status(), 'idle');

    // Expected tags emitted during standard run
    assert.ok(loggedTags.has('[NEW_SESSION_RUN]'), 'should emit [NEW_SESSION_RUN]');
    assert.ok(loggedTags.has('[DOM_SNAPSHOT_INPUT]'), 'should emit [DOM_SNAPSHOT_INPUT]');
    assert.ok(loggedTags.has('[LLM_RAW_OUTPUT]'), 'should emit [LLM_RAW_OUTPUT]');
    assert.ok(loggedTags.has('[ACTION_DISPATCH]'), 'should emit [ACTION_DISPATCH]');
    assert.ok(loggedTags.has('[ACTION_RESULT]'), 'should emit [ACTION_RESULT]');
  } finally {
    Logger.info = origInfo;
    Logger.warn = origWarn;
    rig.cleanup();
  }
});

test('logger: parseModelReply log sink emits [GUARDRAIL_REJECTED] on unrecognized or unavailable action', () => {
  const logs: string[] = [];
  const logSink = (level: 'info' | 'warn', msg: string) => {
    logs.push(msg);
  };

  // 1. Unrecognized action
  parseModelReply('{"action": "fake_unknown_action"}', {
    verbs: ['click', 'type'],
    log: logSink,
  });
  assert.ok(logs.some((l) => l.includes('[GUARDRAIL_REJECTED]')));
  assert.ok(logs.some((l) => l.includes('unrecognised action')));

  // 2. Unavailable action for small tier (e.g. execute_js)
  logs.length = 0;
  parseModelReply('{"action": "execute_js", "code": "console.log(1)"}', {
    verbs: ['click', 'type', 'scroll'],
    log: logSink,
  });
  assert.ok(logs.some((l) => l.includes('[GUARDRAIL_REJECTED]')));
  assert.ok(logs.some((l) => l.includes('not available here')));
});
