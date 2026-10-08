/**
 * llm/deadline.ts - the hard deadline and the abort of one model call.
 *
 * A provider that accepts the connection and then never answers used to park the agent loop for good,
 * and the keepalive kept the service worker awake with it. Every call therefore gets a deadline, and
 * the task's own signal (Pause and Stop) ends it too. The old code only stopped WAITING (the fetch
 * kept running). Here both reasons abort a signal that the chat model hands to fetch, so the request
 * is really cancelled and the socket closes.
 *
 * Who caused the abort is told by the signals, never by an error text:
 *   - the deadline fired and the task's signal did not: ProviderTimeoutError, whatever the SDK threw
 *     (the openai and Anthropic SDKs throw their own APIUserAbortError, "Request was aborted.")
 *   - the task's signal was aborted with a reason tagged { scoutfox: 'user' }: the fixed "cancelled" text
 *   - the task's signal was aborted for any other reason: that reason, unchanged
 */

/** The text of a Pause or Stop that ended a call. The engine does not read it (it reads its own flags). */
export const CANCELLED_MESSAGE = 'LLM request cancelled (task stopped or paused).';
export const CANCELLED_BEFORE_DISPATCH_MESSAGE = 'LLM request cancelled before dispatch (task stopped or paused).';

/**
 * The deadline passed. The text has no "abort" in it on purpose: the old engine reads /abort/i in an
 * error text as "the user pressed Stop", and a timeout is a real failure that must be reported.
 */
export class ProviderTimeoutError extends Error {
  readonly provider: string;
  readonly timeoutMs: number;

  constructor(provider: string, timeoutMs: number) {
    super(`Provider [${provider}] did not respond within ${Math.round(timeoutMs / 1000)}s. The request was abandoned - check that the provider is reachable, or raise llmTimeoutMs in settings.`);
    this.name = 'ProviderTimeoutError';
    this.provider = provider;
    this.timeoutMs = timeoutMs;
  }
}

/** The abort reason of a Pause or Stop. It is an AbortError, so code that checks the name still works, and it carries the tag. */
export type UserAbortReason = DOMException & { scoutfox: 'user'; reason: string };

/** What to pass to controller.abort() when the user pauses or stops the task. `why` is free text for logs. */
export function userAbortReason(why: string): UserAbortReason {
  return Object.assign(new DOMException(`The task was ${why}.`, 'AbortError'), { scoutfox: 'user' as const, reason: why });
}

/** True when the signal was aborted by the user (Pause or Stop), judged by the tag on its reason. */
export function isUserAbort(signal: AbortSignal | null | undefined): boolean {
  if (!signal?.aborted) return false;
  return (signal.reason as { scoutfox?: unknown } | null | undefined)?.scoutfox === 'user';
}

/** The error to throw for an aborted task signal: the fixed text for a user abort, otherwise the reason itself. */
function stepAbortError(signal: AbortSignal, beforeDispatch: boolean): Error {
  if (isUserAbort(signal)) return new Error(beforeDispatch ? CANCELLED_BEFORE_DISPATCH_MESSAGE : CANCELLED_MESSAGE);
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error(String(reason));
}

export interface DeadlineOptions {
  provider: string;
  timeoutMs: number;
  /** The task's signal for this call (the step signal). */
  signal?: AbortSignal | null;
}

/**
 * Runs one model call under the deadline. `run` gets the signal to give to the chat model: it aborts
 * when the deadline passes or the task's signal aborts, whichever comes first.
 *
 * The result of a rejection is decided here, from the signals (see the top of the file), whatever the client threw.
 * The call is also raced against that signal, so control comes back at once even when a client is slow to notice
 * its abort, or ignores it. Its timer and its one listener are removed on every path.
 */
export async function withDeadline<T>({ provider, timeoutMs, signal }: DeadlineOptions, run: (callSignal: AbortSignal) => Promise<T>): Promise<T> {
  const stepSignal = signal ?? undefined;
  if (stepSignal?.aborted) throw stepAbortError(stepSignal, true);

  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new ProviderTimeoutError(provider, timeoutMs)), timeoutMs);
  const callSignal = stepSignal ? AbortSignal.any([stepSignal, deadline.signal]) : deadline.signal;

  /** What a rejection means, judged by who aborted. Null when nobody did: the error is the provider's own. */
  const abortError = (): Error | null => {
    if (stepSignal?.aborted) return stepAbortError(stepSignal, false);
    if (deadline.signal.aborted) return deadline.signal.reason as ProviderTimeoutError;
    return null;
  };

  // Rejects the moment the call signal aborts, with whatever the reason is: what it means is decided below, in one place.
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    onAbort = () => reject(callSignal.reason);
    callSignal.addEventListener('abort', onAbort, { once: true });
  });

  try {
    return await Promise.race([run(callSignal), stopped]);
  } catch (error) {
    throw abortError() ?? error;
  } finally {
    clearTimeout(timer);
    if (onAbort) callSignal.removeEventListener('abort', onAbort);
  }
}
