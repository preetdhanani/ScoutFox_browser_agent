/**
 * executeJs.ts: Injects and executes arbitrary JavaScript in a tab's MAIN world via chrome.scripting.
 */

import { redactSensitiveData } from './redact.ts';

export const EXECUTE_JS_TIMEOUT_MS = 5000;
export const EXECUTE_JS_RESULT_CAP = 2000;

export interface ExecuteJsOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ExecuteJsResult {
  success: boolean;
  ok: boolean;
  message?: string;
  error?: string;
  result?: any;
  world?: 'MAIN';
  truncated?: boolean;
  durationMs: number;
}

/**
 * Execute JavaScript in the page's MAIN world context with timeout and truncation.
 */
export async function executeJs(
  tabId: number,
  code: string,
  opts?: ExecuteJsOptions
): Promise<ExecuteJsResult> {
  const timeoutMs = opts?.timeoutMs ?? EXECUTE_JS_TIMEOUT_MS;
  const startTime = Date.now();

  if (opts?.signal?.aborted) {
    return {
      success: false,
      ok: false,
      error: opts.signal.reason ? String(opts.signal.reason) : 'Aborted',
      durationMs: 0
    };
  }

  const executeWork = async (): Promise<{ value: any }> => {
    const [inj] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (src) => {
        try {
          // eslint-disable-next-line no-new-func
          const fn = new Function(`return (async () => { ${src} })()`);
          return Promise.resolve(fn())
            .then((value) => ({ __scoutfoxOk: true, value }))
            .catch((err) => ({ __scoutfoxOk: false, error: `RUNTIME_ERROR: ${err && err.message ? err.message : String(err)}` }));
        } catch (err: any) {
          // new Function() itself threw - almost always the page's CSP refusing 'unsafe-eval'.
          return { __scoutfoxOk: false, error: `EVAL_BLOCKED: ${err && err.message ? err.message : String(err)}` };
        }
      },
      args: [code]
    });

    const wrapped = inj ? (inj.result as any) : undefined;
    if (wrapped && typeof wrapped === 'object' && '__scoutfoxOk' in wrapped) {
      if (wrapped.__scoutfoxOk) return { value: wrapped.value };
      const blocked = String(wrapped.error || '').startsWith('EVAL_BLOCKED');
      const message = blocked
        ? "execute_js is unavailable on this page: its Content-Security-Policy blocks dynamic script execution ('unsafe-eval' not allowed). Use read_page_text, or click/type on individual elements, instead."
        : `Your code threw: ${String(wrapped.error || '').replace(/^RUNTIME_ERROR: /, '')}`;
      throw new Error(message);
    }
    // The wrapper itself never ran - e.g. the frame was gone before injection completed.
    throw new Error('execute_js produced no result - the page may have navigated away or blocked script injection entirely.');
  };

  const serializeResult = (val: any): any => {
    if (val === undefined) return 'undefined';
    if (val === null) return 'null';
    if (typeof val === 'number' || typeof val === 'boolean' || typeof val === 'string') {
      return val;
    }
    try {
      const json = JSON.stringify(val, (_key, value) => {
        if (value && value.nodeType === 1) { // Element node
          return {
            tag: value.tagName ? value.tagName.toLowerCase() : '',
            id: value.id || '',
            className: value.className || '',
            textContent: (value.textContent || '').slice(0, 200)
          };
        }
        return value;
      });
      return json || String(val);
    } catch (_) {
      return String(val);
    }
  };

  try {
    const resultPromise = (async (): Promise<ExecuteJsResult> => {
      let rawVal: any;
      try {
        const outcome = await executeWork();
        rawVal = outcome.value;
      } catch (err: any) {
        if (err.message && err.message.includes('Frame with ID') && err.message.includes('removed')) {
          return {
            success: true,
            ok: true,
            message: 'Result: navigation triggered',
            result: 'navigation triggered',
            world: 'MAIN',
            durationMs: Date.now() - startTime
          };
        }
        throw err;
      }

      let serialized = redactSensitiveData(serializeResult(rawVal));
      let truncated = false;
      if (typeof serialized === 'string' && serialized.length > EXECUTE_JS_RESULT_CAP) {
        const origLen = serialized.length;
        serialized = serialized.slice(0, EXECUTE_JS_RESULT_CAP) + `…[${origLen - EXECUTE_JS_RESULT_CAP} more chars]`;
        truncated = true;
      }

      return {
        success: true,
        ok: true,
        message: `Result: ${serialized}`,
        result: serialized,
        world: 'MAIN',
        truncated,
        durationMs: Date.now() - startTime
      };
    })();

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error(`execute_js timed out after ${timeoutMs}ms`)), timeoutMs);
    });

    let abortCleanup: (() => void) | undefined;
    const abortPromise = opts?.signal
      ? new Promise<never>((_, reject) => {
          const onAbort = () => reject(new Error(opts.signal?.reason ? String(opts.signal.reason) : 'Aborted'));
          // The signal can abort while the script is being injected (before this listener
          // exists); an 'abort' event that already fired never fires again, so check first.
          if (opts.signal?.aborted) {
            onAbort();
            return;
          }
          opts.signal?.addEventListener('abort', onAbort);
          abortCleanup = () => opts.signal?.removeEventListener('abort', onAbort);
        })
      : null;

    try {
      const racePromises: Array<Promise<ExecuteJsResult>> = [resultPromise, timeoutPromise];
      if (abortPromise) racePromises.push(abortPromise);
      return await Promise.race(racePromises);
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      abortCleanup?.();
    }
  } catch (err: any) {
    return {
      success: false,
      ok: false,
      error: err.message,
      durationMs: Date.now() - startTime
    };
  }
}
