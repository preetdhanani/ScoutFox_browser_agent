/**
 * ScoutFox Network Recorder (MAIN World Content Script)
 * Runs at document_start in MAIN world to intercept window.fetch and XMLHttpRequest.
 * Captures request/response metadata and bodies safely without consuming streams.
 */

(function() {
  if (window.__scoutfox_net_recorder_active) return;
  window.__scoutfox_net_recorder_active = true;

  const MAX_BODY_BYTES = 4096;

  function safeCloneBody(bodyText) {
    if (!bodyText) return null;
    let str = bodyText;
    if (typeof str !== 'string') {
      try { str = JSON.stringify(str); } catch (_) { str = String(str); }
    }
    return str.slice(0, MAX_BODY_BYTES);
  }

  function emitRequest(reqData) {
    try {
      window.postMessage({
        source: 'scoutfox-net',
        payload: reqData
      }, '*');
    } catch (_) {}
  }

  // Intercept fetch API
  if (typeof window.fetch === 'function') {
    const origFetch = window.fetch;
    window.fetch = async function(...args) {
      const startTime = Date.now();
      let url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url ? args[0].url : String(args[0]));
      let method = (args[1] && args[1].method) ? args[1].method.toUpperCase() : 'GET';
      let reqBody = args[1] && args[1].body ? safeCloneBody(args[1].body) : null;

      let status = 0;
      let ok = false;
      let respBody = null;
      let error = null;

      try {
        const response = await origFetch.apply(this, args);
        status = response.status;
        ok = response.ok;

        try {
          const clone = response.clone();
          const text = await clone.text();
          respBody = safeCloneBody(text);
        } catch (_) {}

        return response;
      } catch (err) {
        error = err.message || String(err);
        throw err;
      } finally {
        emitRequest({
          id: Math.random().toString(36).substring(2, 9),
          method,
          url,
          status,
          ok,
          durationMs: Date.now() - startTime,
          reqBody,
          respBody,
          startedAt: startTime,
          error
        });
      }
    };
  }

  // Intercept XMLHttpRequest API
  if (typeof window.XMLHttpRequest === 'function') {
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      this._sf_method = method ? method.toUpperCase() : 'GET';
      this._sf_url = typeof url === 'string' ? url : String(url);
      return origOpen.apply(this, [method, url, ...rest]);
    };

    XMLHttpRequest.prototype.send = function(body) {
      const startTime = Date.now();
      const method = this._sf_method || 'GET';
      const url = this._sf_url || '';
      const reqBody = safeCloneBody(body);

      this.addEventListener('loadend', () => {
        let respBody = null;
        try {
          if (this.responseText) respBody = safeCloneBody(this.responseText);
        } catch (_) {}

        emitRequest({
          id: Math.random().toString(36).substring(2, 9),
          method,
          url,
          status: this.status,
          ok: this.status >= 200 && this.status < 300,
          durationMs: Date.now() - startTime,
          reqBody,
          respBody,
          startedAt: startTime,
          error: this.status === 0 ? 'Network error / CORS blocked' : null
        });
      });

      return origSend.apply(this, [body]);
    };
  }
})();
