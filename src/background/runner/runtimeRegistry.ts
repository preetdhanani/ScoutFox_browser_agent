// src/background/runner/runtimeRegistry.ts
// Non-serializable per-thread dependencies. Nodes of both graphs look them up by thread_id, so
// nothing with functions, keys or signals is ever placed in config.configurable, a checkpoint or a
// trace. The worker's config carries the same thread_id (only checkpoint_ns differs).
import { isGraphInterrupt, type LangGraphRunnableConfig } from '@langchain/langgraph/web';
import type { Settings } from '../../shared/storage.ts';
import type { ControlSnapshot, Effect, HistoryEntry, NodeName, PolicyMode, TrailEntry } from '../graph/state.ts';
import type { NetFilter, OneShot, PageAction, PageSig } from '../graph/workerState.ts';

export interface RunControl {
  pauseRequested: boolean;
  stopRequested: boolean;
  stepSignal(): AbortSignal;                            // fresh AbortController per LLM call or wait; already
                                                        // aborted (reason tagged user) if pause or stop is set
  abortStep(reason: 'user_pause' | 'user_stop'): void;  // signal.reason = { scoutfox: 'user', reason }
  isUserAbort(err: unknown, signal: AbortSignal): boolean; // checks the reason tag, never error text
  snapshot(): ControlSnapshot;
}

export interface LlmPort {
  complete(req: {
    node: 'plan' | 'policy' | 'reflect';
    mode?: PolicyMode | 'initial' | 'revise';
    role: 'policy' | 'planner' | 'reflect';             // picks settings.model, planModel or reflectModel
    system: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    schema: object | null;
    signal: AbortSignal;
    callbacks?: unknown;
  }): Promise<{
    text: string;
    provider: string;
    model: string;
    usage?: { tokensIn: number; tokensOut: number };
    meta: Record<string, unknown>;
  }>;
}

export interface ExecResult {
  success: boolean;
  message?: string;
  error?: string;
  label?: string;
  submitted?: boolean;
  resultData?: unknown;
  via: 'cdp' | 'synthetic' | 'background';
  effect: Effect;
  urlAfter?: string;
  oneShot?: OneShot;
}

export interface BrowserPort {
  tabInfo(tabId: number): Promise<{ url: string; title: string; windowId: number; groupId: number; status: string } | null>;
  snapshot(tabId: number, opts: { showBadges: boolean; maxElements: number }): Promise<unknown>; // scope wall + restricted gate + auto-inject inside
  pageSig(tabId: number, opts: { words: string[] }): Promise<{ sig: Omit<PageSig, 'pageType'>;
    priceHits: number; found: string[] } | null>;       // GET_PAGE_SIG: a light read for verify
  execute(tabId: number, action: PageAction, opts: { docId: string; mode: 'cdp' | 'synthetic' }): Promise<ExecResult>;
  navigate(tabId: number, url: string): Promise<void>;
  reload(tabId: number): Promise<void>;
  goBack(tabId: number): Promise<void>;
  waitForTabComplete(tabId: number, ms: number): Promise<void>;
  waitDomQuiet(tabId: number, quietMs: number, maxMs: number): Promise<void>;
  cdp: {
    ensureAttached(tabId: number): Promise<{ mode: 'cdp' | 'synthetic'; reason: string | null }>;
    detachAll(): Promise<void>;
  };
  clearBadges(tabId: number): Promise<void>;
  isTabInScope(tabId: number): Promise<boolean>;
}

export interface ActionJournal {
  get(key: string): Promise<{ dispatchedAt: number; bootId: string; result: ExecResult | null } | null>;
  begin(key: string, action: PageAction): Promise<void>;   // written BEFORE dispatch
  finish(key: string, result: ExecResult): Promise<void>;
  clearRun(runId: string): Promise<void>;
}

export interface RunRuntime {
  threadId: string;                    // String(owner tabId)
  ownerTabId: number;
  bootId: string;
  control: RunControl;
  tabs: { activeTabId: number | null }; // the only truth: background.ts writes it on target=_blank adoption,
                                        // the runner getter/setter use it, stream mirroring never writes it
  windowId: number | 'default';
  scoutFoxGroupIds: Map<number, number>; // windowId -> groupId, whole map persisted in sf:meta
  attachedTabIds: Set<number>;         // debugger attachments, mirrored to sf:meta
  resumedAfterRestart: boolean;        // the first node wrapper after a restart adds a notice
  settings(): Promise<Settings>;       // Storage.getSettings() on every call; never copied into state
  llm: LlmPort;
  browser: BrowserPort;
  journal: ActionJournal;
  net: {                               // shared view of AgentRunner.networkBuffers (lives as long as the runner)
    marker(): string;                  // stamp for new entries: '<runId>:<stepCount>' while a model action runs,
                                       // 'sys:<systemActionCount>' while a system action runs
    read(tabId: number, filter: NetFilter, includeBody: boolean, limit: number): string; // 'since last_action' =
                                       // entries stamped with the last model action's marker
  };
  emit: {
    enterNode(n: NodeName, graph: 'orchestrator' | 'worker', phase?: string): void;
    setPhase(text: string): void;
  };
  clock: {
    now(): number;
    sleep(ms: number, signal?: AbortSignal): Promise<void>;
  };
}

const registry = new Map<string, RunRuntime>();

export const runtimeRegistry = {
  set(rt: RunRuntime): void {
    registry.set(rt.threadId, rt);
  },
  get(threadId: string): RunRuntime | undefined {
    return registry.get(threadId);
  },
  delete(threadId: string): void {
    registry.delete(threadId);
  },
  clear(): void {
    registry.clear();
  },
};

export function getRuntime(config: LangGraphRunnableConfig): RunRuntime {
  const id = String(config.configurable?.thread_id ?? '');
  const rt = registry.get(id);
  if (!rt) throw new Error(`No runtime registered for thread ${id}.`);
  return rt;
}

export function defineNode<S extends Record<string, any> = any, U extends Record<string, any> = Record<string, any>>(
  graph: 'orchestrator' | 'worker',
  name: NodeName,
  fn: (state: S, config: LangGraphRunnableConfig) => Promise<U> | U,
) {
  return async (state: S, config: LangGraphRunnableConfig): Promise<U> => {
    const runtime = getRuntime(config);
    runtime.emit.enterNode(name, graph);

    let rawUpdate: U;
    try {
      rawUpdate = await fn(state, config);
    } catch (err) {
      if (isGraphInterrupt(err)) {
        throw err;
      }
      throw err;
    }

    const ctl = runtime.control.snapshot();
    const trailEntry: TrailEntry = {
      node: name,
      step: state.stepCount ?? 0,
      at: runtime.clock.now(),
    };

    let update = { ...rawUpdate };

    // Handle restart notice on first node execution after worker resurrection
    if (runtime.resumedAfterRestart) {
      runtime.resumedAfterRestart = false;
      const restartNotice: HistoryEntry = {
        type: 'notice',
        kind: 'restart',
        level: 'info',
        content: 'Service worker restarted; resuming task execution.',
        step: state.stepCount ?? 0,
      };
      const existingHistory: HistoryEntry[] = Array.isArray(update.history)
        ? update.history
        : [];
      update = {
        ...update,
        history: [restartNotice, ...existingHistory],
      };
    }

    // LLM node cancellation check: if stop/pause requested during or right after LLM call
    if (name === 'policy' && (ctl.stopRequested || ctl.pauseRequested)) {
      const why = ctl.stopRequested ? 'stopped' : 'paused';
      const discardResult: HistoryEntry = {
        type: 'execution_result',
        step: state.stepCount ?? 0,
        success: false,
        message: `Action was discarded because the task was ${why}.`,
        via: 'state',
        effect: 'none',
      };
      update = {
        ...update,
        lastDecision: { kind: 'aborted', mode: (update as any).lastDecision?.mode ?? 'browse' },
        history: [...(Array.isArray(update.history) ? update.history : []), discardResult],
      };
    } else if ((name === 'plan' || name === 'reflect') && (ctl.stopRequested || ctl.pauseRequested)) {
      update = {
        ...update,
        lastDecision: { kind: 'aborted', node: name },
      };
    }

    return {
      ...update,
      ctl,
      nodeTrail: [trailEntry],
    };
  };
}
