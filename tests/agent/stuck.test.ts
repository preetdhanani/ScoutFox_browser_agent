import test from 'node:test';
import assert from 'node:assert/strict';
import { detectStuck, getStuckEscalation } from '../../src/background/agent/stuck.ts';
import type { PageSig } from '../../src/background/graph/workerState.ts';

test('stuck: detects 3 identical action signatures in a row', () => {
  const actions = [
    { url: 'https://example.com', signature: 'click|12|' },
    { url: 'https://example.com', signature: 'click|12|' },
    { url: 'https://example.com', signature: 'click|12|' }
  ];

  const res = detectStuck(actions, []);
  assert.equal(res.isStuck, true);
  assert.equal(res.reason, 'repeated_action');
  assert.equal(res.signatureToBan, 'click|12|');
});

test('stuck: does not trigger when actions differ', () => {
  const actions = [
    { url: 'https://example.com', signature: 'click|12|' },
    { url: 'https://example.com', signature: 'scroll|down|' },
    { url: 'https://example.com', signature: 'click|12|' }
  ];

  const res = detectStuck(actions, []);
  assert.equal(res.isStuck, false);
});

test('stuck: detects unchanged DOM across 3 consecutive signatures', () => {
  const actions = [
    { url: 'https://example.com', signature: 'click|5|' },
    { url: 'https://example.com', signature: 'click|6|' },
    { url: 'https://example.com', signature: 'click|7|' }
  ];

  const sig: PageSig = {
    url: 'https://example.com',
    title: 'Example',
    elementCount: 20,
    interactiveHash: 'hash-abc',
    textHash: 'hash-text-123',
    scrollY: 0,
    pageType: 'listing'
  };

  const pageSigs = [sig, { ...sig }, { ...sig }];

  const res = detectStuck(actions, pageSigs);
  assert.equal(res.isStuck, true);
  assert.equal(res.reason, 'unchanged_page');
  assert.equal(res.signatureToBan, 'click|7|');
});

test('stuck: escalation rules return correct escalation step', () => {
  assert.equal(getStuckEscalation(1, 'medium'), 'warn_and_ban');
  assert.equal(getStuckEscalation(2, 'medium'), 'switch_strategy_or_partial');
  assert.equal(getStuckEscalation(3, 'medium'), 'end_stuck');
});
