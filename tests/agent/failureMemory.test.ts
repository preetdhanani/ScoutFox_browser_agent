import test from 'node:test';
import assert from 'node:assert/strict';
import { recordFailure, isSignatureBanned, renderFailureMemory, signatureOfFailure } from '../../src/background/agent/failureMemory.ts';
import type { StepFailure } from '../../src/background/graph/state.ts';

test('failureMemory: records, deduplicates, and increments count', () => {
  const f1 = { verb: 'click', target: '[12]', signature: 'click|12|', kind: 'covered' as const, detail: 'Dialog in way' };
  const res1 = recordFailure([], f1, 1);
  assert.equal(res1.failures.length, 1);
  assert.equal(res1.failures[0].count, 1);
  assert.equal(res1.shouldBan, false);

  // Repeat failure
  const res2 = recordFailure(res1.failures, f1, 1);
  assert.equal(res2.failures.length, 1);
  assert.equal(res2.failures[0].count, 2);
  assert.equal(res2.shouldBan, true); // count 2 > retriesPerAction 1
});

test('failureMemory: caps at 6 entries, newest first', () => {
  let list: any[] = [];
  for (let i = 1; i <= 8; i++) {
    const res = recordFailure(list, {
      verb: 'click',
      target: `[${i}]`,
      signature: `click|${i}|`,
      kind: 'not_found',
      detail: `Element ${i} missing`
    }, 1);
    list = res.failures;
  }

  assert.equal(list.length, 6);
  assert.equal(signatureOfFailure(list[0]), 'click|8|');
  assert.equal(signatureOfFailure(list[5]), 'click|3|');
});

test('failureMemory: isSignatureBanned checks array inclusion', () => {
  assert.equal(isSignatureBanned(['click|12|', 'navigate||foo'], 'click|12|'), true);
  assert.equal(isSignatureBanned(['click|12|'], 'click|99|'), false);
});

test('failureMemory: renderFailureMemory outputs readable markdown lines', () => {
  const failures: StepFailure[] = [
    { step: 1, action: { verb: 'click', elementId: 88, label: '[88] "Accept"' }, url: 'https://foo.com', kind: 'covered', detail: 'Cookie dialog', count: 3 },
    { step: 2, action: { verb: 'navigate', url: 'https://foo.com' }, url: 'https://foo.com', kind: 'nav_error', detail: '404', count: 1 }
  ];
  const rendered = renderFailureMemory(failures, ['click|88|']);

  assert.ok(rendered.includes('- click [88] "Accept" -> covered: Cookie dialog (x3, blocked by ScoutFox)'));
  assert.ok(rendered.includes('- navigate https://foo.com -> nav_error: 404'));
});
