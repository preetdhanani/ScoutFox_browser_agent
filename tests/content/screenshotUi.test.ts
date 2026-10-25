/**
 * Hiding the agent UI for a screenshot: ActionExecutor.hideAgentUi / showAgentUi, and the
 * HIDE_AGENT_UI / SHOW_AGENT_UI / DESCRIBE_POINT content-script actions.
 *
 * What these tests hold on to:
 *   1. Hide makes the overlays invisible; it does not REMOVE them. removeBadges and
 *      removeCursorOverlay delete the elements and nothing brings them back, so a screenshot that
 *      used them would leave the page without its overlays for the rest of the run.
 *   2. The visibility each overlay had is remembered and put back exactly.
 *   3. Hiding also draws the privacy covers, and showing removes them.
 *   4. content.js answers the three actions, and a point on a sensitive field comes back as a
 *      refusal rather than a description.
 *   5. HIDE_AGENT_UI says success only when the covers are up: no executor, or a mask walk that
 *      threw, is a failure, and the capture refuses on it (fail closed).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { ActionExecutor } from '../../src/content/actionExecutor.ts';

/** A fake document holding the two overlay containers and nothing else. */
function fakeDoc() {
  const nodes = new Map<string, any>();
  const body = { tagName: 'BODY', children: [] as any[], appendChild(node: any) { this.children.push(node); } };
  const doc: any = {
    body,
    documentElement: body,
    createElement(tag: string) {
      const node: any = {
        tagName: tag.toUpperCase(),
        id: '',
        className: '',
        style: {},
        children: [] as any[],
        appendChild(child: any) { node.children.push(child); },
        setAttribute(name: string, value: string) { node[name] = value; },
        getAttribute(name: string) { return node[name] ?? null; },
        remove() { nodes.delete(node.id); },
        ownerDocument: doc
      };
      return node;
    },
    getElementById(id: string) { return nodes.get(id) ?? null; },
    querySelectorAll() { return []; },
    elementFromPoint() { return null; }
  };
  for (const id of ['scoutfox-badge-container', 'scoutfox-cursor-container']) {
    const node: any = { id, style: { visibility: 'visible' }, remove() { nodes.delete(id); } };
    nodes.set(id, node);
    body.appendChild(node);
  }
  return { doc, nodes };
}

test('hiding makes the overlays invisible without removing them from the page', () => {
  const { doc, nodes } = fakeDoc();
  const executor = new ActionExecutor(doc);

  executor.hideAgentUi();

  for (const id of ['scoutfox-badge-container', 'scoutfox-cursor-container']) {
    const node = nodes.get(id);
    assert.ok(node, `${id} must still be in the page: a screenshot must not delete it`);
    assert.equal(node.style.visibility, 'hidden');
  }
});

test('showing puts back the visibility each overlay had', () => {
  const { doc, nodes } = fakeDoc();
  nodes.get('scoutfox-cursor-container').style.visibility = 'collapse';
  const executor = new ActionExecutor(doc);

  executor.hideAgentUi();
  assert.equal(nodes.get('scoutfox-cursor-container').style.visibility, 'hidden');

  executor.showAgentUi();
  assert.equal(nodes.get('scoutfox-badge-container').style.visibility, 'visible');
  assert.equal(nodes.get('scoutfox-cursor-container').style.visibility, 'collapse', 'not a blanket "visible"');
});

test('showing when nothing was hidden changes nothing', () => {
  const { doc, nodes } = fakeDoc();
  const executor = new ActionExecutor(doc);
  assert.doesNotThrow(() => executor.showAgentUi());
  assert.equal(nodes.get('scoutfox-badge-container').style.visibility, 'visible');
});

test('a page without the overlays is not an error', () => {
  const doc: any = {
    body: { appendChild() {} },
    documentElement: {},
    createElement: () => ({ style: {}, appendChild() {}, setAttribute() {}, getAttribute: () => null }),
    getElementById: () => null,
    querySelectorAll: () => [],
    elementFromPoint: () => null
  };
  const executor = new ActionExecutor(doc);
  assert.doesNotThrow(() => executor.hideAgentUi());
  assert.doesNotThrow(() => executor.showAgentUi());
});

// ---------------------------------------------------------------------------------------------
// content/content.js answers the actions
// ---------------------------------------------------------------------------------------------

const CONTENT_SRC = fs.readFileSync(new URL('../../content/content.js', import.meta.url), 'utf8');

/** Runs content.js against a fake window and returns a function that sends one message to it. */
function bootContent(executor: any): (request: any) => Promise<any> {
  let listener: any = null;
  const chrome = {
    runtime: {
      onMessage: { addListener: (fn: any) => { listener = fn; } },
      sendMessage: () => {}
    }
  };
  const doc: any = { title: 'T', body: { innerText: '' }, querySelectorAll: () => [] };
  const win: any = {
    location: { href: 'https://example.com/' },
    addEventListener: () => {},
    scrollY: 0,
    scrollX: 0,
    actionExecutor: executor
  };
  new Function('window', 'document', 'chrome', 'requestAnimationFrame', 'MutationObserver', CONTENT_SRC)(
    win, doc, chrome, undefined, undefined
  );
  assert.ok(listener, 'content.js registers a message listener');
  return (request: any) =>
    new Promise((resolve) => {
      const kept = listener(request, {}, resolve);
      assert.equal(kept, true, 'every action answers asynchronously and keeps the channel open');
    });
}

test('content.js answers HIDE_AGENT_UI and SHOW_AGENT_UI through the executor global', async () => {
  const calls: string[] = [];
  const send = bootContent({
    hideAgentUi: () => calls.push('hide'),
    showAgentUi: () => calls.push('show')
  });

  assert.deepEqual(await send({ action: 'HIDE_AGENT_UI' }), { success: true });
  assert.deepEqual(await send({ action: 'SHOW_AGENT_UI' }), { success: true });
  assert.deepEqual(calls, ['hide', 'show']);
});

test('a page where the executor did not load answers HIDE_AGENT_UI with a failure, so no unmasked capture is taken', async () => {
  // The privacy covers come from the executor. Without it nothing is covered, and saying
  // success would let a password field leave as pixels; the capture refuses on this answer.
  const send = bootContent(undefined);
  const hide = await send({ action: 'HIDE_AGENT_UI' });
  assert.equal(hide.success, false);
  assert.match(hide.error, /privacy covers/);
  assert.deepEqual(await send({ action: 'SHOW_AGENT_UI' }), { success: true });
});

test('a mask walk that throws answers HIDE_AGENT_UI with a failure', async () => {
  const send = bootContent({
    hideAgentUi: () => {
      throw new Error('mask walk failed');
    }
  });
  const hide = await send({ action: 'HIDE_AGENT_UI' });
  assert.equal(hide.success, false);
  assert.match(hide.error, /mask walk failed/);
});

test('content.js answers DESCRIBE_POINT with what is at the pixel', async () => {
  const send = bootContent({
    describePoint: () => ({ what: 'button#buy "Buy now"', interactive: true }),
    maskedFieldRefusal: () => 'Error: refused'
  });

  const resp = await send({ action: 'DESCRIBE_POINT', payload: { x: 10, y: 20 } });
  assert.equal(resp.success, true);
  assert.equal(resp.what, 'button#buy "Buy now"');
  assert.equal(resp.interactive, true);
});

test('content.js refuses a click on a sensitive field at the point', async () => {
  const send = bootContent({
    describePoint: () => ({ what: 'input#pw', interactive: true, fieldKind: 'password' }),
    maskedFieldRefusal: (kind: string) => `Error: that point is on a ${kind} field, so the click was refused.`
  });

  const resp = await send({ action: 'DESCRIBE_POINT', payload: { x: 10, y: 20 } });
  assert.equal(resp.success, false);
  assert.equal(resp.fieldKind, 'password');
  assert.match(resp.error, /password field, so the click was refused/);
});
