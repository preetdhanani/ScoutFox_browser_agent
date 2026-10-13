// BUG-45 regression: the MAIN-world net-recorder runs in every frame, but its
// `scoutfox-net` messages dispatch on the recording frame's own window - a
// child frame's postMessage never reaches the top frame's listener in
// content/content.js (which is top-frame-only). The per-frame relay
// content/netRelay.js must exist, be wired into the manifest for all frames,
// and forward same-frame records to the background.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const RELAY_SRC = fs.readFileSync(new URL('../../content/netRelay.js', import.meta.url), 'utf8');

function runRelay() {
  const sent: any[] = [];
  const listeners: Array<(e: any) => void> = [];
  const window: any = {
    addEventListener: (_: string, fn: (e: any) => void) => listeners.push(fn),
  };
  const chrome: any = {
    runtime: {
      sendMessage: (msg: any) => {
        sent.push(msg);
      },
    },
  };
  new Function('window', 'chrome', RELAY_SRC)(window, chrome);
  return { sent, listeners, window };
}

test('netRelay forwards same-frame scoutfox-net records to the background (BUG-45)', () => {
  const { sent, listeners, window } = runRelay();
  assert.equal(listeners.length, 1, 'the relay registers one message listener');

  listeners[0]({ source: window, data: { source: 'scoutfox-net', payload: { url: 'https://api.test/x', method: 'GET' } } });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].action, 'NET_REQUEST_RECORDED');
  assert.deepEqual(sent[0].payload, { url: 'https://api.test/x', method: 'GET' });
});

test('netRelay ignores cross-frame sources and foreign messages (BUG-45)', () => {
  const { sent, listeners, window } = runRelay();

  // A message posted from a DIFFERENT frame (e.g. a child page relaying up):
  // the relay must not forward it.
  listeners[0]({ source: {}, data: { source: 'scoutfox-net', payload: { url: 'https://evil.test' } } });
  // Same frame but not a recorder message.
  listeners[0]({ source: window, data: { source: 'something-else' } });
  listeners[0]({ source: window, data: null });

  assert.equal(sent.length, 0, `nothing may be forwarded, got ${JSON.stringify(sent)}`);
});

test('the manifest injects the relay into all frames (BUG-45)', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../../public/manifest.json', import.meta.url), 'utf8'));
  const entry = (manifest.content_scripts as any[]).find(
    (e) => Array.isArray(e.js) && e.js.includes('content/netRelay.js')
  );
  assert.ok(entry, 'the manifest must ship content/netRelay.js');
  assert.equal(entry.all_frames, true, 'the relay must run in every frame');
  assert.notEqual(entry.world, 'MAIN', 'the relay runs isolated so it can call chrome.runtime');
  // And the MAIN recorder stays all-frames too: it is the relay's source.
  const recorder = (manifest.content_scripts as any[]).find(
    (e) => Array.isArray(e.js) && e.js.includes('content/net-recorder.js')
  );
  assert.ok(recorder?.all_frames, 'the recorder must stay all-frames');
});
