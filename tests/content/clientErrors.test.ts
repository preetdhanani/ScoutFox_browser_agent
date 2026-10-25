/**
 * content/content.js forwards errors to the extension's log. The window's error events carry the
 * page's own errors too, and a website's broken script is not a ScoutFox error: only errors from
 * the extension's own files are forwarded.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const CONTENT_SRC = fs.readFileSync(new URL('../../content/content.js', import.meta.url), 'utf8');

/** Boots content.js on a fake window and returns its error listeners and what it sent. */
function boot() {
  const sent: any[] = [];
  const listeners: Record<string, (event: any) => void> = {};
  const chrome = { runtime: { onMessage: { addListener: () => {} }, sendMessage: (message: any) => { sent.push(message); } } };
  const doc: any = { title: 'T', body: { innerText: '' }, querySelectorAll: () => [] };
  const win: any = {
    location: { href: 'https://site.test/' },
    addEventListener: (type: string, fn: any) => { listeners[type] = fn; },
    scrollY: 0,
    scrollX: 0
  };
  new Function('window', 'document', 'chrome', 'requestAnimationFrame', 'MutationObserver', CONTENT_SRC)(win, doc, chrome, undefined, undefined);
  const errors = () => sent.filter((m) => m.action === 'CLIENT_ERROR');
  return { listeners, errors };
}

test('a website\'s own script error is not forwarded as an extension error', () => {
  const { listeners, errors } = boot();
  listeners.error({ message: 'ResizeObserver loop completed with undelivered notifications.', filename: '' });
  listeners.error({ message: 'x is not defined', filename: 'https://site.test/app.js', error: Object.assign(new Error('x is not defined'), { stack: 'at https://site.test/app.js:1:1' }) });
  listeners.unhandledrejection({ reason: Object.assign(new Error('fetch failed'), { stack: 'at https://site.test/app.js:2:2' }) });
  assert.equal(errors().length, 0);
});

test('an error from the extension\'s own content script is forwarded', () => {
  const { listeners, errors } = boot();
  const own = Object.assign(new Error('boom'), { stack: 'Error: boom\n at chrome-extension://abc/content/content.js:10:5' });
  listeners.error({ message: 'boom', filename: 'chrome-extension://abc/content/content.js', error: own });
  listeners.unhandledrejection({ reason: own });
  assert.equal(errors().length, 2);
  assert.match(errors()[0].payload.message, /boom/);
});
