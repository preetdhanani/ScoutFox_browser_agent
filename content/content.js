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
      // Extension context may already be invalidated (e.g. page navigating away) - ignore.
    }
  };
  window.addEventListener('error', (event) => reportContentError(window.location.href, event.error || event.message));
  window.addEventListener('unhandledrejection', (event) => reportContentError(window.location.href, event.reason));

  // Mutation tracking for DOM quiet and effect probes
  window.__scoutfox_mutations = 0;
  window.__scoutfox_last_mutation = Date.now();
  try {
    if (typeof MutationObserver !== 'undefined' && document.documentElement) {
      const observer = new MutationObserver(() => {
        window.__scoutfox_mutations = (window.__scoutfox_mutations || 0) + 1;
        window.__scoutfox_last_mutation = Date.now();
      });
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true
      });
    }
  } catch (_) {}

  function describeElement(el) {
    if (!el || el.nodeType !== 1) return 'unknown';
    let desc = el.tagName.toLowerCase();
    if (el.id) desc += `#${el.id}`;
    else if (el.className && typeof el.className === 'string') {
      const cls = el.className.trim().split(/\s+/).slice(0, 2).join('.');
      if (cls) desc += `.${cls}`;
    }
    const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 30);
    if (text) desc += ` "${text}"`;
    return desc;
  }

  function isAcceptedHit(target, hit) {
    if (!hit || !target) return false;
    if (hit === target) return true;
    if (typeof target.contains === 'function' && target.contains(hit)) return true;
    if (typeof hit.contains === 'function' && hit.contains(target)) return true;
    if (hit.shadowRoot && typeof hit.shadowRoot.contains === 'function' && hit.shadowRoot.contains(target)) return true;
    if (hit.tagName === 'IFRAME') return true;

    // Both target and hit are inside the same interactive container (e.g. button, anchor, input, label)
    const interactiveSel = 'a, button, [role="button"], [role="link"], label, select, input, textarea, summary';
    if (typeof target.closest === 'function' && typeof hit.closest === 'function') {
      const targetParent = target.closest(interactiveSel);
      const hitParent = hit.closest(interactiveSel);
      if (targetParent && hitParent && (targetParent === hitParent || targetParent.contains(hitParent) || hitParent.contains(targetParent))) {
        return true;
      }
    }

    // Ignore overlay element if it has pointer-events: none
    if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
      try {
        const style = window.getComputedStyle(hit);
        if (style && style.pointerEvents === 'none') {
          return true;
        }
      } catch (_) {}
    }

    return false;
  }

  function hashString(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 16777619) >>> 0;
    }
    return h.toString(16);
  }

  function getLightPageSignature(wordsToLookFor) {
    const pageText = window.domCompressor ? window.domCompressor.extractPageText() : (document.body ? document.body.innerText : '');
    const normText = (pageText || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
    const textHash = hashString(normText);

    const interactiveSel = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [tabindex]:not([tabindex="-1"])';
    const nodes = document.querySelectorAll(interactiveSel);
    const parts = [];
    let count = 0;

    for (let i = 0; i < nodes.length && count < 150; i++) {
      const el = nodes[i];
      if (el.offsetParent === null && el.offsetWidth === 0 && el.offsetHeight === 0) continue;
      count++;
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute('role') || tag;
      const label = (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || '').slice(0, 40).trim();
      parts.push(`${tag}:${role}:${label}`);
    }

    const interactiveHash = hashString(parts.join(';'));
    const priceRegex = /[€$£¥₹]\s?\d|\d\s?(?:[€$£¥₹]|EUR\b|USD\b|GBP\b)/gi;
    const priceMatches = (pageText || '').match(priceRegex);
    const priceHits = priceMatches ? priceMatches.length : 0;

    let visibleWords = [];
    if (Array.isArray(wordsToLookFor) && wordsToLookFor.length > 0) {
      const lower = (pageText || '').toLowerCase();
      visibleWords = wordsToLookFor.filter(w => typeof w === 'string' && lower.includes(w.toLowerCase()));
    }

    return {
      url: window.location.href,
      title: document.title,
      elementCount: count,
      interactiveHash,
      textHash,
      scrollY: Math.round(window.scrollY || 0),
      priceHits,
      visibleWords
    };
  }

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
        sendResponse({ success: true, data: snapshot, docId: window.domCompressor.docId });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return true; // Keep message channel open for async response
    }

    if (action === 'RESOLVE_ELEMENT_POINT') {
      try {
        if (!window.domCompressor) {
          return sendResponse({ success: false, error: 'DOMCompressor engine not initialized on page.' });
        }
        const resolved = window.domCompressor.resolveElementWithStatus
          ? window.domCompressor.resolveElementWithStatus(payload?.element_id, payload?.docId)
          : { success: !!window.domCompressor.getElement(payload?.element_id), element: window.domCompressor.getElement(payload?.element_id) };

        if (!resolved.success || !resolved.element) {
          return sendResponse({
            success: false,
            stale: resolved.stale || false,
            error: resolved.error || `Element [${payload?.element_id}] not found.`
          });
        }

        const el = resolved.element;
        if (typeof el.scrollIntoView === 'function') {
          try {
            el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
          } catch (_) {
            el.scrollIntoView();
          }
        }

        const proceed = () => {
          try {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) {
              return sendResponse({ success: false, error: `Element [${payload?.element_id}] has zero size.` });
            }
            const x = Math.round(rect.left + rect.width / 2);
            const y = Math.round(rect.top + rect.height / 2);

            let hit = null;
            if (typeof document.elementFromPoint === 'function') {
              hit = document.elementFromPoint(x, y);
            }

            if (hit && !isAcceptedHit(el, hit)) {
              const obscuredBy = describeElement(hit);
              return sendResponse({
                success: false,
                obscuredBy,
                error: `Element [${payload?.element_id}] is covered by <${obscuredBy}>.`
              });
            }

            const tag = el.tagName ? el.tagName.toLowerCase() : '';
            const role = typeof el.getAttribute === 'function' ? (el.getAttribute('role') || el.type || undefined) : undefined;
            const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);

            // Animate visual cursor to target and highlight element
            if (window.actionExecutor) {
              if (typeof window.actionExecutor.highlightElement === 'function') {
                window.actionExecutor.highlightElement(el);
              }
              if (typeof window.actionExecutor.animateCursor === 'function') {
                window.actionExecutor.animateCursor(x, y);
              }
            }

            sendResponse({ success: true, point: { x, y }, tag, role, text });
          } catch (e) {
            sendResponse({ success: false, error: e.message });
          }
        };

        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => requestAnimationFrame(proceed));
        } else {
          setTimeout(proceed, 10);
        }
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return true;
    }

    if (action === 'EFFECT_PROBE_BEGIN') {
      window.__scoutfox_probe_baseline = {
        url: window.location.href,
        mutCount: window.__scoutfox_mutations || 0,
        value: document.activeElement && 'value' in document.activeElement ? String(document.activeElement.value) : '',
        activeTag: document.activeElement && document.activeElement.tagName ? document.activeElement.tagName.toLowerCase() : '',
        activeId: document.activeElement ? (document.activeElement.id || '') : ''
      };
      sendResponse({ success: true, baseline: window.__scoutfox_probe_baseline });
      return true;
    }

    if (action === 'EFFECT_PROBE_END') {
      const base = window.__scoutfox_probe_baseline;
      let effect = 'none';
      if (!base || window.location.href !== base.url) {
        effect = 'url_changed';
      } else if (document.activeElement && 'value' in document.activeElement && String(document.activeElement.value) !== base.value) {
        effect = 'value_set';
      } else if ((window.__scoutfox_mutations || 0) > base.mutCount) {
        effect = 'dom_changed';
      } else {
        const curTag = document.activeElement && document.activeElement.tagName ? document.activeElement.tagName.toLowerCase() : '';
        const curId = document.activeElement ? (document.activeElement.id || '') : '';
        if (curTag !== base.activeTag || curId !== base.activeId) {
          effect = 'focus_changed';
        }
      }
      sendResponse({ success: true, effect });
      return true;
    }

    if (action === 'WAIT_DOM_QUIET') {
      const quietMs = (payload && payload.quietMs) || 100;
      const maxWaitMs = (payload && payload.maxWaitMs) || 500;
      const start = Date.now();

      const checkQuiet = () => {
        const now = Date.now();
        const elapsed = now - start;
        const lastMut = window.__scoutfox_last_mutation || start;
        if (now - lastMut >= quietMs || elapsed >= maxWaitMs) {
          return sendResponse({ success: true, quiet: true, elapsedMs: elapsed });
        }
        setTimeout(checkQuiet, 30);
      };
      setTimeout(checkQuiet, 30);
      return true;
    }

    if (action === 'SHOW_CLICK_ANIMATION') {
      try {
        const x = payload?.x ?? 0;
        const y = payload?.y ?? 0;
        if (window.actionExecutor && typeof window.actionExecutor.showClickEffect === 'function') {
          window.actionExecutor.showClickEffect(x, y);
        }
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return true;
    }

    if (action === 'CLEAR_BADGES') {
      try {
        if (window.actionExecutor && typeof window.actionExecutor.removeBadges === 'function') {
          window.actionExecutor.removeBadges();
        }
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return true;
    }

    if (action === 'GET_PAGE_SIG') {
      try {
        const sig = getLightPageSignature(payload?.words);
        sendResponse({ success: true, data: sig });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return true;
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
