// src/background/browser/batch.ts
// Batch execution of deterministic browser primitives.

export interface BatchStepResult {
  step: number;
  action: string;
  ok: boolean;
  message?: string;
  error?: string;
}

export interface BatchResult {
  success: boolean;
  completed: number;
  total: number;
  results: BatchStepResult[];
  abortedAt: number | null;
  terminatedBy: string | null;
  message?: string;
  error?: string;
}

export interface BatchDeps {
  dispatch: (tabId: number, stepAction: any, opts: { docId?: string; signal?: AbortSignal }) => Promise<any>;
  currentUrl: (tabId: number) => Promise<string>;
  waitDomQuiet?: (tabId: number, quietMs: number, maxMs: number) => Promise<void>;
  control?: {
    stopRequested?: boolean;
    pauseRequested?: boolean;
    stepSignal?: () => AbortSignal;
    isUserAbort?: (err: any, sig?: AbortSignal) => boolean;
  };
  docId?: string;
  clock?: { sleep(ms: number, sig?: AbortSignal): Promise<void> };
}

const FORBIDDEN_BATCH_VERBS = new Set([
  'navigate',
  'go_back',
  'go_forward',
  'ask_user',
  'finish',
  'browser_batch',
  'open_window',
  'execute_js',
  'read_page_text',
  'read_network_requests',
]);

/**
 * Runs a deterministic sequence of browser actions on a tab.
 */
export async function runBatch(
  tabId: number,
  action: { steps: any[]; stopOnError?: boolean },
  deps: BatchDeps
): Promise<BatchResult> {
  if (!action || !Array.isArray(action.steps) || action.steps.length === 0) {
    return {
      success: false,
      completed: 0,
      total: 0,
      results: [],
      abortedAt: null,
      terminatedBy: null,
      error: 'browser_batch requires a non-empty "steps" array',
    };
  }

  if (action.steps.length > 8) {
    return {
      success: false,
      completed: 0,
      total: action.steps.length,
      results: [],
      abortedAt: null,
      terminatedBy: null,
      error: 'browser_batch exceeds maximum allowed 8 steps limit',
    };
  }

  const stopOnError = action.stopOnError !== false;
  const results: BatchStepResult[] = [];
  let completed = 0;
  let abortedAt: number | null = null;
  let terminatedBy: string | null = null;

  const initialUrl = await deps.currentUrl(tabId).catch(() => '');

  for (let i = 0; i < action.steps.length; i++) {
    // Check stop and pause flags per step
    if (deps.control?.stopRequested) {
      terminatedBy = 'stop';
      abortedAt = i;
      break;
    }
    if (deps.control?.pauseRequested) {
      terminatedBy = 'pause';
      abortedAt = i;
      break;
    }

    const rawStep = action.steps[i];
    const step = typeof rawStep === 'object' && rawStep !== null ? { ...rawStep } : { action: '' };

    // Resolve action name and target element id aliases
    const actName =
      step.action ||
      (step.click !== undefined ? 'click' : step.type !== undefined ? 'type' : step.scroll !== undefined ? 'scroll' : '');

    let targetId = step.element_id ?? step.index ?? step.elementId ?? step.element;
    if (targetId === undefined && step.click !== undefined) {
      if (typeof step.click === 'number') {
        targetId = step.click;
      } else if (typeof step.click === 'string' && /^\d+$/.test(step.click.trim())) {
        targetId = parseInt(step.click.trim(), 10);
      }
    }

    if (!actName || FORBIDDEN_BATCH_VERBS.has(actName)) {
      const err = `Action "${actName || 'unknown'}" is forbidden inside browser_batch`;
      results.push({ step: i, action: actName || 'unknown', ok: false, error: err });
      abortedAt = i;
      if (stopOnError) break;
      continue;
    }

    try {
      const stepPayload = {
        ...step,
        action: actName,
        ...(targetId !== undefined ? { element_id: targetId } : {}),
      };

      const stepRes = await deps.dispatch(tabId, stepPayload, {
        docId: deps.docId,
        signal: deps.control?.stepSignal?.(),
      });

      if (stepRes && stepRes.success !== false) {
        results.push({ step: i, action: actName, ok: true, message: stepRes.message });
        completed++;
      } else {
        const errMsg = stepRes?.error || 'Step failed';
        results.push({ step: i, action: actName, ok: false, error: errMsg });
        abortedAt = i;
        if (stopOnError) break;
      }
    } catch (stepErr: any) {
      results.push({ step: i, action: actName, ok: false, error: stepErr.message || 'Step error' });
      abortedAt = i;
      if (stopOnError) break;
    }

    // Check if the page started navigating
    const currentUrl = await deps.currentUrl(tabId).catch(() => initialUrl);
    if (currentUrl && initialUrl && currentUrl !== initialUrl) {
      terminatedBy = 'navigation';
      break;
    }

    // Auto-wait between batch steps
    if (deps.waitDomQuiet) {
      await deps.waitDomQuiet(tabId, 300, 1500).catch(() => {});
    }
  }

  const ok = results.length > 0 && results.every((r) => r.ok);
  const summary = `${completed}/${action.steps.length} step(s) completed${terminatedBy ? ` (stopped by ${terminatedBy})` : ''}`;

  return {
    success: ok,
    completed,
    total: action.steps.length,
    results,
    abortedAt,
    terminatedBy,
    message: ok ? summary : undefined,
    error: ok ? undefined : `${summary}. First failure: ${(results.find((r) => !r.ok) || {}).error || 'unknown'}`,
  };
}
