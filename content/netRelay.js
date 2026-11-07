// content/netRelay.js
// Per-frame relay for network records. The MAIN-world net-recorder.js runs in
// EVERY frame (all_frames), but it posts its `tarka-net` messages on its own
// frame's window - a child frame's postMessage never reaches the top frame's
// listener. content/content.js (which owns the top-frame relay) is only
// injected into the top frame, so iframe fetch/XHR traffic was silently
// dropped before it reached NET_REQUEST_RECORDED (BUG-45). This isolated-world
// relay is injected into all frames and forwards each frame's own recorder
// messages to the background service worker.
(function () {
  if (window.__tarka_net_relay_registered) {
    return;
  }
  window.__tarka_net_relay_registered = true;

  window.addEventListener('message', (event) => {
    // Same-frame source only: a frame relays its OWN recorder's messages, never
    // anything posted from another frame or an embedding page.
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== 'tarka-net') return;
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({
          action: 'NET_REQUEST_RECORDED',
          payload: data.payload
        });
      }
    } catch (_) {
      // Service worker might be sleeping/restarting - ignore
    }
  });
})();
