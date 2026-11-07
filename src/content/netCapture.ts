/**
 * Tarka Network Recorder Capture Logic
 * Intercepts window.fetch and XMLHttpRequest to record request/response metadata and bodies safely.
 * MAIN world compatible: strictly never references chrome.* APIs.
 */

export interface NetRecordPayload {
  id: string;
  method: string;
  url: string;
  status: number;
  ok: boolean;
  durationMs: number;
  reqBody: string | null;
  respBody: string | null;
  startedAt: number;
  error: string | null;
}

export interface WindowLike {
  __tarka_net_recorder_active?: boolean;
  postMessage(message: unknown, targetOrigin: string, transfer?: unknown[]): void;
  fetch?: typeof fetch;
  XMLHttpRequest?: typeof XMLHttpRequest;
  [key: string]: unknown;
}

export const MAX_BODY_BYTES = 4096;

export function safeCloneBody(bodyText: unknown): string | null {
  if (!bodyText) return null;
  let str: string;
  if (typeof bodyText !== 'string') {
    try {
      str = JSON.stringify(bodyText);
    } catch {
      str = String(bodyText);
    }
  } else {
    str = bodyText;
  }
  return str.slice(0, MAX_BODY_BYTES);
}

export const genId = (): string => Math.random().toString(36).substring(2, 9);

export function emitRequest(win: WindowLike, reqData: NetRecordPayload): void {
  try {
    win.postMessage(
      {
        source: 'tarka-net',
        payload: reqData
      },
      '*'
    );
  } catch {
    // Suppress postMessage dispatch errors in MAIN world
  }
}

// Content types whose body must never be teed off for capture. A streaming response does
// not end, so cloning it holds a tee open for the life of the page and buffers without
// bound while the reader waits for data that keeps arriving.
export const NON_BUFFERABLE_TYPE = /^(text\/event-stream|multipart\/|video\/|audio\/)/i;

export function shouldCaptureBody(response: { headers?: { get(name: string): string | null } }): boolean {
  try {
    const type = (response.headers && response.headers.get('content-type')) || '';
    return !NON_BUFFERABLE_TYPE.test(type);
  } catch {
    return false;
  }
}

// Read at most MAX_BODY_BYTES and then cancel. Bounds both memory and time, so a long or
// endless body cannot hold the clone's tee open or grow the buffer indefinitely.
export async function readCappedBody(res: Response): Promise<string> {
  if (!res.body || typeof res.body.getReader !== 'function') {
    return await res.text();
  }
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
    try {
      await reader.cancel();
    } catch {
      // Ignored
    }
  }
  return out;
}

interface SfXhrInstance extends XMLHttpRequest {
  _sf_method?: string;
  _sf_url?: string;
}

export function installNetCapture(win: WindowLike): void {
  if (win.__tarka_net_recorder_active) return;
  win.__tarka_net_recorder_active = true;

  // Intercept fetch API
  if (typeof win.fetch === 'function') {
    const origFetch = win.fetch;
    win.fetch = async function (this: unknown, ...args: Parameters<typeof fetch>): Promise<Response> {
      const startTime = Date.now();
      const firstArg = args[0] as unknown;
      const url = typeof firstArg === 'string'
        ? firstArg
        : (firstArg && typeof firstArg === 'object' && 'url' in firstArg
          ? String((firstArg as { url: unknown }).url)
          : String(firstArg));

      const init = args[1];
      // The method can come from the init OR from a Request first argument:
      // fetch(new Request(url, { method: 'POST' })) used to be recorded as
      // GET because only init was consulted (BUG-46).
      const rawMethod =
        (init && init.method) ||
        (firstArg && typeof firstArg === 'object' && 'method' in firstArg
          ? String((firstArg as { method?: unknown }).method)
          : '') ||
        'GET';
      const method = String(rawMethod).toUpperCase();
      const reqBody = (init && init.body) ? safeCloneBody(init.body) : null;

      const record = (extra: Partial<NetRecordPayload>) =>
        emitRequest(
          win,
          Object.assign(
            {
              id: genId(),
              method,
              url,
              status: 0,
              ok: false,
              durationMs: Date.now() - startTime,
              reqBody,
              respBody: null,
              startedAt: startTime,
              error: null
            },
            extra
          )
        );

      let response: Response;
      try {
        response = await origFetch.apply(this, args);
      } catch (err: unknown) {
        const errorMsg = (err instanceof Error) ? err.message : String(err);
        record({ error: errorMsg });
        throw err;
      }

      const status = response.status;
      const ok = response.ok;
      const durationMs = Date.now() - startTime;

      if (!shouldCaptureBody(response)) {
        record({ status, ok, durationMs });
        return response;
      }

      let clone: Response | null = null;
      try {
        clone = response.clone();
      } catch {
        // Clone failed (e.g. body already locked)
      }

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
  if (typeof win.XMLHttpRequest === 'function') {
    const origOpen = win.XMLHttpRequest.prototype.open;
    const origSend = win.XMLHttpRequest.prototype.send;

    win.XMLHttpRequest.prototype.open = function (
      this: SfXhrInstance,
      method: string,
      url: string | URL,
      ...rest: [boolean?, (string | null)?, (string | null)?]
    ) {
      this._sf_method = method ? method.toUpperCase() : 'GET';
      this._sf_url = typeof url === 'string' ? url : String(url);
      return (origOpen as (...a: unknown[]) => void).apply(this, [method, url, ...rest]);
    };

    win.XMLHttpRequest.prototype.send = function (
      this: SfXhrInstance,
      body?: Document | XMLHttpRequestBodyInit | null
    ) {
      const startTime = Date.now();
      const method = this._sf_method || 'GET';
      const url = this._sf_url || '';
      const reqBody = safeCloneBody(body);

      // Install the loadend listener ONCE per XHR instance. A reused XHR (one
      // object, several send() calls) used to accumulate a listener per send,
      // emitting one duplicate/stale record per earlier send (BUG-46). Each
      // send overwrites the per-send metadata the single listener reads.
      const self = this as SfXhrInstance & { _sf_loadend_installed?: boolean; _sf_send?: { startTime: number; method: string; url: string; reqBody: string | null } };
      if (!self._sf_loadend_installed) {
        self._sf_loadend_installed = true;
        this.addEventListener('loadend', () => {
          const send = self._sf_send;
          if (!send) return;
          let respBody: string | null = null;
          try {
            if (this.responseText) respBody = safeCloneBody(this.responseText);
          } catch {
            // Ignored if responseText cannot be accessed
          }

          emitRequest(win, {
            id: genId(),
            method: send.method,
            url: send.url,
            status: this.status,
            ok: this.status >= 200 && this.status < 300,
            durationMs: Date.now() - send.startTime,
            reqBody: send.reqBody,
            respBody,
            startedAt: send.startTime,
            error: this.status === 0 ? 'Network error / CORS blocked' : null
          });
        });
      }
      self._sf_send = { startTime, method, url, reqBody };

      return (origSend as (...a: unknown[]) => void).apply(this, [body]);
    };
  }
}
