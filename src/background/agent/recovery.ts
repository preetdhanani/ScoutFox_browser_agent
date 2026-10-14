/**
 * agent/recovery.ts
 *
 * Retry wrapper for the one operation in this codebase that had no retry at all: a single LLM call.
 * It no longer retries blind. The provider boundary (llm/index.ts, agentRouter.ts, ollama.ts) throws a
 * ProviderError that carries the HTTP status, the failure kind and the retry-after hint of the answer, and
 * classifyProviderFailure (llm/errors.ts) fills the gaps for anything older. A permanent failure - a refused
 * key, a rejected request, a context overflow - fails at once with a pause message that names the cause; a
 * transient one (a 5xx, a throttle, a network drop) is retried with exponential backoff and jitter, and a
 * Pause or Stop wakes the wait at once instead of letting it run out.
 */

import { classifyProviderFailure, isRetryableProviderFailure } from '../llm/errors.ts';

/**
 * 5 attempts total (1 original + 4 retries). The backoff is exponential - 2 s, 4 s, 8 s, 16 s, plus up to
 * 25% jitter each - so a provider outage of a few seconds no longer burns the whole budget at once, and the
 * total wait stays bounded: about 30 s without jitter, capped at 60 s. A failed attempt has usually already
 * waited out llmTimeoutMs (120 s by default) before we get here, so this is the worst case, not the common one.
 */
export const LLM_MAX_ATTEMPTS = 5;
export const LLM_RETRY_BASE_DELAY_MS = 2000;
export const LLM_RETRY_MAX_DELAY_MS = 16000;
export const LLM_RETRY_TOTAL_CAP_MS = 60000;
export const LLM_RETRY_JITTER_RATIO = 0.25;

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  /** The ceiling of one backoff wait, jitter included. */
  maxDelayMs?: number;
  /** The ceiling of the backoff waits of one call, all attempts together. */
  totalCapMs?: number;
  /** Random share of each wait, as a fraction of the exponential step (0 turns jitter off). */
  jitterRatio?: number;
  /** The task's abort signal. A Pause or Stop during a backoff wait ends the wait at once. */
  signal?: AbortSignal;
  isAbort?: (err: unknown) => boolean;
  isRetryable?: (err: unknown) => boolean;
  shouldContinue?: () => boolean;
  onRetry?: (attemptNumber: number, err: unknown, delayMs: number) => void;
  sleep?: (ms: number) => Promise<void>;
}

/** Marks the error an exhausted or given-up retry loop throws with the number of attempts that were made. */
function markAttempts(err: unknown, attempts: number): unknown {
  if (err && typeof err === 'object') {
    try {
      Object.defineProperty(err, 'attemptCount', { value: attempts, enumerable: false, configurable: true, writable: true });
    } catch {
      // A frozen error keeps its message; the pause text falls back to the configured budget.
    }
  }
  return err;
}

/** How many attempts the retry loop that threw `err` made, when it was marked. */
export function attemptsOf(err: unknown): number | undefined {
  const n = (err as { attemptCount?: unknown } | null | undefined)?.attemptCount;
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 ? n : undefined;
}

/** The backoff wait before retry `attempt` (the attempt that just failed): exponential, jittered, double-capped. */
function backoffDelayMs(attempt: number, opts: { baseDelayMs: number; maxDelayMs: number; jitterRatio: number; remainingMs: number }): number {
  const step = Math.min(opts.baseDelayMs * 2 ** (attempt - 1), opts.maxDelayMs);
  const jitter = opts.jitterRatio > 0 ? step * opts.jitterRatio * Math.random() : 0;
  return Math.max(0, Math.min(Math.round(step + jitter), opts.maxDelayMs, opts.remainingMs));
}

/**
 * One backoff wait, abortable. Resolves false when the wait ran out, true when `signal` ended it early -
 * a Pause or Stop must not sit out a 16 s wait. With no signal this is the plain sleep.
 */
async function backoffSleep(ms: number, sleep: ((ms: number) => Promise<void>) | undefined, signal: AbortSignal | undefined): Promise<boolean> {
  const wait = (): Promise<void> => (sleep ? sleep(ms) : new Promise((resolve) => setTimeout(resolve, ms)));
  if (!signal) {
    await wait();
    return false;
  }
  if (signal.aborted) return true;
  let aborted = false;
  let onAbort: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    onAbort = () => {
      aborted = true;
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    await Promise.race([wait(), gate]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
  return aborted;
}

/**
 * Calls `attempt(attemptNumber)` up to `maxAttempts` times, classifying before it retries.
 *
 * - `isAbort(err)` marks an error as the user's own Pause/Stop rather than a provider failure -
 *   never retried, rethrown immediately.
 * - `isRetryable(err)` decides whether a failure is worth another attempt. The default classifies the
 *   error (llm/errors.ts): a throttle or a bad moment is retried, a refused key, a rejected request and a
 *   context overflow end the loop at once, and an unknown error is retried as the safe guess.
 * - `shouldContinue()` is re-checked before every attempt, so a Pause/Stop that lands while a retry is
 *   pending is respected instead of retried into.
 * - `signal` makes the backoff wait itself abortable: a Pause or Stop during a wait ends the wait and the
 *   loop at once, instead of after the wait.
 * - `onRetry(attemptNumber, err, delayMs)` runs before each backoff sleep, for logging and user-visible rows.
 * - `sleep(ms)` overrides the default timer with an injectable clock sleep.
 *
 * Throws the last error once attempts are exhausted, a failure is permanent, aborted, or `shouldContinue()`
 * says stop. The thrown error carries the number of attempts that were made (attemptsOf), so a pause text
 * can report the real budget instead of a hard-coded one.
 */
export async function callWithRetry<T>(attempt: (attemptNumber: number) => T | Promise<T>, {
  maxAttempts = LLM_MAX_ATTEMPTS,
  baseDelayMs = LLM_RETRY_BASE_DELAY_MS,
  maxDelayMs = LLM_RETRY_MAX_DELAY_MS,
  totalCapMs = LLM_RETRY_TOTAL_CAP_MS,
  jitterRatio = LLM_RETRY_JITTER_RATIO,
  signal,
  isAbort = () => false,
  isRetryable = isRetryableProviderFailure,
  shouldContinue = () => true,
  onRetry = () => {},
  sleep
}: RetryOptions = {}): Promise<T> {
  let lastErr: unknown;
  let spentMs = 0;
  for (let i = 1; i <= maxAttempts; i++) {
    if (!shouldContinue()) {
      throw markAttempts(lastErr || new Error('Stopped before retrying.'), i - 1);
    }
    try {
      return await attempt(i);
    } catch (err) {
      lastErr = err;
      if (isAbort(err) || i === maxAttempts || !isRetryable(err)) throw markAttempts(err, i);
      // A retry-after hint from the provider decides the wait when it sent one; the exponential step with
      // jitter decides otherwise. Both are capped by what is left of the call's total backoff budget.
      const hintedMs = classifyProviderFailure(err).retryAfterMs;
      const delayMs = hintedMs !== undefined && hintedMs > 0
        ? Math.max(0, Math.min(Math.round(hintedMs), totalCapMs - spentMs))
        : backoffDelayMs(i, { baseDelayMs, maxDelayMs, jitterRatio, remainingMs: totalCapMs - spentMs });
      if (delayMs <= 0) continue;
      spentMs += delayMs;
      onRetry(i, err, delayMs);
      if (await backoffSleep(delayMs, sleep, signal)) throw markAttempts(err, i);
    }
  }
  throw markAttempts(lastErr, maxAttempts);
}

/**
 * The pause text of an LLM failure, for the history row the worker and the orchestrator write when a call
 * is given up on. A permanent failure names its cause, so the user knows what to fix; an exhausted retry
 * budget reports the attempts that were actually made, not a hard-coded number.
 */
export function llmPauseText(provider: string, err: unknown, step: number): string {
  const message = err instanceof Error ? err.message : String(err);
  const sentence = message.endsWith('.') ? message : `${message}.`;
  const tail = `Task paused at step ${step} - click Resume to try again, or check your provider settings if this keeps happening.`;
  const kind = classifyProviderFailure(err).kind;
  if (kind === 'auth') {
    return `LLM Authentication Error (${provider}): ${sentence} The API key was refused, so the call was not retried - check your provider settings. ${tail}`;
  }
  if (kind === 'bad_request') {
    return `LLM Request Error (${provider}): ${sentence} The request was rejected by the provider, so it was not retried. ${tail}`;
  }
  if (kind === 'context') {
    return `LLM Context Overflow (${provider}): ${sentence} The conversation does not fit the model's context window, so it was not retried. ${tail}`;
  }
  const attempts = attemptsOf(err) ?? LLM_MAX_ATTEMPTS;
  return `LLM Connection Error (${provider}) after ${attempts} ${attempts === 1 ? 'attempt' : 'attempts'}: ${sentence} ${tail}`;
}
