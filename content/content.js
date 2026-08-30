/**
 * Content Script Entry Point for ScoutFox AI Agent
 * Listens for background agent execution messages and returns DOM state or executes actions.
 */

(function init() {
  console.log('[ScoutFox Agent] Content script active.');

  // Guard against duplicate listener registration
  if (window.__scoutfox_listener_registered) {
    return;
  }
  window.__scoutfox_listener_registered = true;

  // Forward anything that fails in this page context to the central log, so a failure
  // here (outside the try/catch'd message handlers below) is never fully invisible.
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
      (async () => {
        try {
          if (!window.actionExecutor) {
            return sendResponse({ success: false, error: 'ActionExecutor engine not initialized on page.' });
          }
          const res = await window.actionExecutor.execute(payload);
          sendResponse(res);
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    if (action === 'SHOW_BADGES') {
      if (window.domCompressor && window.actionExecutor) {
        const snapshot = window.domCompressor.getSnapshot(payload || {});
        window.actionExecutor.renderBadges(snapshot.elements);
      }
      sendResponse({ success: true });
      return true;
    }

    if (action === 'HIDE_BADGES') {
      if (window.actionExecutor) {
        window.actionExecutor.removeBadges();
      }
      sendResponse({ success: true });
      return true;
    }
  });
})();
