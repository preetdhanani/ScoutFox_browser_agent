import test from 'node:test';
import assert from 'node:assert/strict';
import { detectStuck, getStuckEscalation, pageSignatureChanged, decayStuckLevel } from '../../src/background/agent/stuck.ts';
import { actionSignatureOf, nextReadPart } from '../../src/background/agent/actionSignature.ts';
import type { PageSig } from '../../src/background/graph/workerState.ts';

// The signatures below are the real ones the engine builds (actionSignature.ts): verb, element_id,
// url, then the argument that changes meaning for verbs without a target.

function sig(textHash: string, scrollY = 0, url = 'https://example.com'): PageSig {
  return {
    url,
    title: 'Example',
    elementCount: 20,
    interactiveHash: 'hash-abc',
    textHash,
    scrollY,
    pageType: 'listing'
  };
}

test('stuck: three identical clicks on an unchanged page set stuck', () => {
  const actions = [
    { url: 'https://example.com', signature: 'click|12|' },
    { url: 'https://example.com', signature: 'click|12|' },
    { url: 'https://example.com', signature: 'click|12|' }
  ];
  const pageSigs = [sig('hash-text-123'), sig('hash-text-123'), sig('hash-text-123')];

  const res = detectStuck(actions, pageSigs);
  assert.equal(res.isStuck, true);
  assert.equal(res.reason, 'repeated_action');
  assert.equal(res.signatureToBan, 'click|12|');
});

test('stuck: does not trigger when actions differ', () => {
  const actions = [
    { url: 'https://example.com', signature: 'click|12|' },
    { url: 'https://example.com', signature: 'scroll|||down' },
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

  const pageSigs = [sig('hash-text-123'), sig('hash-text-123'), sig('hash-text-123')];

  const res = detectStuck(actions, pageSigs);
  assert.equal(res.isStuck, true);
  assert.equal(res.reason, 'unchanged_page');
  assert.equal(res.signatureToBan, 'click|7|');
});

test('stuck: six scrolls over a page whose text hash changes never set stuck', () => {
  const actions = Array.from({ length: 6 }, () => ({ url: 'https://example.com', signature: 'scroll|||down' }));
  const pageSigs = Array.from({ length: 6 }, (_, i) => sig(`text-hash-${i}`, i * 400));

  const res = detectStuck(actions, pageSigs);
  assert.equal(res.isStuck, false);
});

test('stuck: three identical scrolls on an unchanged page still set stuck', () => {
  const actions = Array.from({ length: 3 }, () => ({ url: 'https://example.com', signature: 'scroll|||down' }));
  const pageSigs = [sig('hash-text-123'), sig('hash-text-123'), sig('hash-text-123')];

  const res = detectStuck(actions, pageSigs);
  assert.equal(res.isStuck, true);
  assert.equal(res.reason, 'repeated_action');
  assert.equal(res.signatureToBan, 'scroll|||down');
});

test('stuck: three typed queries with different text into one field do not set stuck', () => {
  const actions = [
    { url: 'https://example.com', signature: actionSignatureOf({ action: 'type', element_id: 5, text: 'laptop', submit: false }) },
    { url: 'https://example.com', signature: actionSignatureOf({ action: 'type', element_id: 5, text: 'backpack', submit: false }) },
    { url: 'https://example.com', signature: actionSignatureOf({ action: 'type', element_id: 5, text: 'tent', submit: false }) }
  ];
  const pageSigs = [
    sig('hash-text-123'),
    sig('hash-text-124'),
    sig('hash-text-125')
  ];

  const res = detectStuck(actions, pageSigs);
  assert.equal(res.isStuck, false);
});

test('stuck: paging reads with a new-part note do not trip the unchanged-page check', () => {
  const actions = Array.from({ length: 3 }, () => ({ url: 'https://example.com', signature: 'read_page_text|||part1' }));
  const pageSigs = [sig('hash-text-123'), sig('hash-text-123'), sig('hash-text-123')];

  const res = detectStuck(actions, pageSigs, { readNewText: true });
  assert.equal(res.isStuck, false);
});

test('stuck: a wrap-around re-read without new text on an unchanged page still trips the unchanged-page check', () => {
  const actions = [
    { url: 'https://example.com', signature: 'read_page_text|||part0' },
    { url: 'https://example.com', signature: 'read_page_text|||part1' },
    { url: 'https://example.com', signature: 'read_page_text|||part2' }
  ];
  const pageSigs = [sig('hash-text-123'), sig('hash-text-123'), sig('hash-text-123')];

  const res = detectStuck(actions, pageSigs);
  assert.equal(res.isStuck, true);
  assert.equal(res.reason, 'unchanged_page');
  assert.equal(res.signatureToBan, 'read_page_text|||part2');
});

test('stuck: stuckLevel decays by one after a page-changing action', () => {
  const before = sig('hash-text-123', 0);
  const after = sig('hash-text-999', 400);

  assert.equal(pageSignatureChanged(before, after), true);
  assert.equal(decayStuckLevel(2), 1);
  assert.equal(decayStuckLevel(1), 0);
  assert.equal(decayStuckLevel(0), 0);
  assert.equal(pageSignatureChanged(before, { ...before }), false);
});

test('stuck: escalation rules return correct escalation step', () => {
  assert.equal(getStuckEscalation(1, 'medium'), 'warn_and_ban');
  assert.equal(getStuckEscalation(2, 'medium'), 'switch_strategy_or_partial');
  assert.equal(getStuckEscalation(3, 'medium'), 'end_stuck');
});

test('signature: the engine format signs the arguments that change meaning', () => {
  assert.equal(actionSignatureOf({ action: 'click', element_id: 12 }), 'click|12|');
  assert.equal(actionSignatureOf({ action: 'navigate', url: 'https://x.test/' }), 'navigate||https://x.test/');
  assert.equal(actionSignatureOf({ action: 'scroll', direction: 'down' }), 'scroll|||down');
  assert.equal(actionSignatureOf({ action: 'scroll', direction: 'up' }), 'scroll|||up');
  assert.equal(actionSignatureOf({ action: 'press_key', key: 'Enter' }), 'press_key|||Enter');

  const typeLaptop = actionSignatureOf({ action: 'type', element_id: 5, text: 'laptop', submit: false });
  const typeBackpack = actionSignatureOf({ action: 'type', element_id: 5, text: 'backpack', submit: false });
  assert.notEqual(typeLaptop, typeBackpack);
  assert.equal(typeLaptop, actionSignatureOf({ action: 'type', element_id: 5, text: 'laptop', submit: false }));
  assert.match(typeLaptop, /^type\|5\|\|[0-9a-f]+$/);

  assert.match(actionSignatureOf({ action: 'execute_js', code: 'return 1;' }), /^execute_js\|\|\|[0-9a-f]+$/);

  const batch1 = actionSignatureOf({ action: 'browser_batch', steps: [{ action: 'click', element_id: 1 }] });
  const batch2 = actionSignatureOf({ action: 'browser_batch', steps: [{ action: 'click', element_id: 2 }] });
  assert.notEqual(batch1, batch2);
  assert.equal(batch1, actionSignatureOf({ action: 'browser_batch', steps: [{ action: 'click', element_id: 1 }] }));

  assert.equal(actionSignatureOf({ action: 'read_page_text' }, 0), 'read_page_text|||part0');
  assert.equal(actionSignatureOf({ action: 'read_page_text' }, 3), 'read_page_text|||part3');
  assert.equal(actionSignatureOf({ action: 'read_page_text' }), 'read_page_text||');
});

test('signature: the read part prediction follows the tracked part while the page is unchanged', () => {
  assert.equal(nextReadPart(null, null), 0);
  const siteRun = { readPartKey: 'https://example.com|hash-text-123', readPartNext: 2 } as any;
  assert.equal(nextReadPart(siteRun, { url: 'https://example.com', sig: { textHash: 'hash-text-123' } }), 2);
  assert.equal(nextReadPart(siteRun, { url: 'https://example.com', sig: { textHash: 'other' } }), 0);
  assert.equal(nextReadPart(siteRun, { url: 'https://other.test/', sig: { textHash: 'hash-text-123' } }), 0);
});
