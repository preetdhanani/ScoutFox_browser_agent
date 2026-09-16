/**
 * Content Script Entry Point for ScoutFox AI Agent
 * Listens for background agent execution messages, relays network recordings from MAIN world,
 * and executes actions or returns DOM snapshot state.
 */

(function init() {
  console.log('[ScoutFox Agent] Content script active.');

  // Guard against duplicate listener registration
  if (window.__scoutfox_listener_registered) {
    return;
  }
  window.__scoutfox_listener_registered = true;

  // Relay network requests from MAIN world net-recorder.js to Background Service Worker
  window.addEventListener('message', (event) => {
    if (event.source === window && event.data && event.data.source === 'scoutfox-net') {
      try {
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
          chrome.runtime.sendMessage({
            action: 'NET_REQUEST_RECORDED',
            payload: event.data.payload
          });
        }
      } catch (_) {
        // Service worker might be sleeping/restarting — ignore
      }
    }
  });

  // Forward anything that fails in this page context to the central log
  const reportContentError = (source, err) => {
    try {
      chrome.runtime.sendMessage({
        action: 'CLIENT_ERROR',
        payload: {
          source: `content:${source}`,
          message: (err && err.message) || String(err),
          stack: (err && err.stack) || null
        }
      });
    } catch (_) {
      // Extension context may already be invalidated (e.g. page navigating away) — ignore.
    }
  };
  window.addEventListener('error', (event) => reportContentError(window.location.href, event.error || event.message));
  window.addEventListener('unhandledrejection', (event) => reportContentError(window.location.href, event.reason));

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    const { action, payload } = request;

    if (action === 'GET_DOM_SNAPSHOT') {
      try {
        // manifest.json injects domCompressor.js -> actionExecutor.js -> content.js in that
        // fixed order, into this same window, so window.domCompressor is always already set
        // by the time this listener can even run - the null guard covers only the unusual
        // case of the engine somehow not having attached itself.
        if (!window.domCompressor) {
          return sendResponse({ success: false, error: 'DOMCompressor engine not initialized on page.' });
        }
        const snapshot = window.domCompressor.getSnapshot(payload || {});
        if (payload?.showBadges && window.actionExecutor) {
          window.actionExecutor.renderBadges(snapshot.elements);
        }
        sendResponse({ success: true, data: snapshot });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return true; // Keep message channel open for async response
    }

    if (action === 'EXECUTE_ACTION') {
      try {
        if (!window.actionExecutor) {
          return sendResponse({ success: false, error: 'ActionExecutor engine not initialized on page.' });
        }

        window.actionExecutor.execute(payload)
          .then((res) => sendResponse(res))
          .catch((err) => sendResponse({ success: false, error: err.message }));
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return true; // Keep message channel open for async execution
    }
  });
})();
