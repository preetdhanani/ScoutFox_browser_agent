/**
 * Tarka DOM Quietness Settle Helper
 * Waits for DOM mutation quietness between sequential actions.
 */

/**
 * Helper to wait for DOM quietness between batch steps
 */
export function waitForDomQuiet(
  quietMs = 300,
  timeoutCeilingMs = 1500,
  doc: Document = typeof document !== 'undefined' ? document : (null as unknown as Document)
): Promise<void> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let ceilingTimer: ReturnType<typeof setTimeout> | null = null;
    let observer: MutationObserver | null = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (ceilingTimer) clearTimeout(ceilingTimer);
      if (observer) observer.disconnect();
    };

    ceilingTimer = setTimeout(() => {
      cleanup();
      resolve();
    }, timeoutCeilingMs);

    const resetTimer = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        cleanup();
        resolve();
      }, quietMs);
    };

    if (typeof MutationObserver !== 'undefined' && doc && doc.body) {
      observer = new MutationObserver(resetTimer);
      observer.observe(doc.body, { childList: true, subtree: true, attributes: true });
    }

    resetTimer();
  });
}
