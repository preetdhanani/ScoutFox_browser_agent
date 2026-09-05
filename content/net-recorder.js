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

  // Content types whose body must never be teed off for capture. A streaming response does
  // not end, so cloning it holds a tee open for the life of the page and buffers without
  // bound while the reader waits for data that keeps arriving.
  const NON_BUFFERABLE_TYPE = /^(text\/event-stream|multipart\/|video\/|audio\/)/i;

  function shouldCaptureBody(response) {
    try {
      const type = (response.headers && response.headers.get('content-type')) || '';
      return !NON_BUFFERABLE_TYPE.test(type);
    } catch (_) {
      return false;
    }
  }

  // Read at most MAX_BODY_BYTES and then cancel. Bounds both memory and time, so a long or
  // endless body cannot hold the clone's tee open or grow the buffer indefinitely.
  async function readCappedBody(res) {
    if (!res.body || typeof res.body.getReader !== 'function') return await res.text();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let out = '';
    try {
      while (out.length < MAX_BODY_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        out += decoder.decode(value, { stream: true });
      }
    } finally {
      try { await reader.cancel(); } catch (_) {}
    }
    return out;
  }

  // Intercept fetch API
  if (typeof window.fetch === 'function') {
    const origFetch = window.fetch;
    window.fetch = async function(...args) {
      const startTime = Date.now();
      let url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url ? args[0].url : String(args[0]));
      let method = (args[1] && args[1].method) ? args[1].method.toUpperCase() : 'GET';
      let reqBody = args[1] && args[1].body ? safeCloneBody(args[1].body) : null;

      const record = (extra) => emitRequest(Object.assign({
        id: Math.random().toString(36).substring(2, 9),
        method,
        url,
        status: 0,
        ok: false,
        durationMs: Date.now() - startTime,
        reqBody,
        respBody: null,
        startedAt: startTime,
        error: null
      }, extra));

      let response;
      try {
        response = await origFetch.apply(this, args);
      } catch (err) {
        record({ error: err.message || String(err) });
        throw err;
      }

      const status = response.status;
      const ok = response.ok;
      // Measured here, not inside record(): body capture is now detached and finishes later,
      // so reading the clock at emit time would report the capture duration, not the request's.
      const durationMs = Date.now() - startTime;

      // Hand the Response back to the caller as soon as the headers land. Awaiting the body
      // here is what broke every streaming site the user visited: clone.text() does not
      // resolve until the stream ends, so an SSE or chunked response withheld the Response
      // object for the life of the stream. Capture happens off to the side instead, and its
      // result is emitted whenever it finishes.
      if (!shouldCaptureBody(response)) {
        record({ status, ok, durationMs });
        return response;
      }

      let clone = null;
      try { clone = response.clone(); } catch (_) {}

      if (!clone) {
        record({ status, ok, durationMs });
        return response;
      }

      readCappedBody(clone).then(
        (text) => record({ status, ok, durationMs, respBody: safeCloneBody(text) }),
        () => record({ status, ok, durationMs })
      );

      return response;
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
