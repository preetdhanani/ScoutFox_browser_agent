/**
 * agent/recovery.ts
 *
 * Retry wrapper for the one operation in this codebase that had no retry at all: a single LLM
 * call (ApiClients.generateCompletion). Providers wrap every failure - timeout, DNS, a 500 -
 * into a bare Error with no status code (nothing anywhere reads response.headers or preserves
 * err.name), so there is no reliable way to tell "worth retrying" from "will never work" by
 * message text alone. Retrying a handful of times regardless of message content is still the
 * right call: a genuinely fatal error (bad API key, unknown model) fails the same way every
 * attempt and costs the user a few seconds; a transient one (the agent_router timeout that
 * prompted this) gets a real second chance instead of killing the whole task.
 */

// 3 attempts total (1 original + 2 retries). A failed attempt has usually already waited out
// llmTimeoutMs (120s by default) before we get here, so the backoff is deliberately short -
// 300ms then 600ms - rather than making an already-slow failure slower. Bounds the worst case
// to roughly 3x a single call's latency plus under a second, and every attempt after the first
// is skippable the moment the user pauses or stops.
export const LLM_MAX_ATTEMPTS = 3;
export const LLM_RETRY_BASE_DELAY_MS = 300;

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  isAbort?: (err: unknown) => boolean;
  shouldContinue?: () => boolean;
  onRetry?: (attemptNumber: number, err: unknown, delayMs: number) => void;
}

/**
 * Calls `attempt(attemptNumber)` up to `maxAttempts` times, backing off between failures.
 *
 * - `isAbort(err)` marks an error as the user's own Pause/Stop rather than a provider failure -
 *   never retried, rethrown immediately.
 * - `shouldContinue()` is re-checked before every attempt and before every backoff sleep, so a
 *   Pause/Stop that lands while a retry is pending is respected instead of retried into.
 * - `onRetry(attemptNumber, err, delayMs)` runs before each backoff sleep, for logging only.
 *
 * Throws the last error once attempts are exhausted, aborted, or `shouldContinue()` says stop.
 */
export async function callWithRetry<T>(attempt: (attemptNumber: number) => T | Promise<T>, {
  maxAttempts = LLM_MAX_ATTEMPTS,
  baseDelayMs = LLM_RETRY_BASE_DELAY_MS,
  isAbort = () => false,
  shouldContinue = () => true,
  onRetry = () => {}
}: RetryOptions = {}): Promise<T> {
  let lastErr: unknown;
  for (let i = 1; i <= maxAttempts; i++) {
    if (!shouldContinue()) {
      throw lastErr || new Error('Stopped before retrying.');
    }
    try {
      return await attempt(i);
    } catch (err) {
      lastErr = err;
      if (isAbort(err) || i === maxAttempts) throw err;
      const delayMs = baseDelayMs * i;
      onRetry(i, err, delayMs);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr;
}
