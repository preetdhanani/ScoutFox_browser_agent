// src/background/runner/runtimeRegistry.ts
// Non-serializable per-thread dependencies. The MCP client and browser APIs look them up by
// thread_id. Nothing with functions, keys or signals is ever placed in a checkpoint or trace.
import type { Settings } from '../../shared/storage.ts';
import type {
  ControlSnapshot, Effect, HistoryEntry, NodeName, PolicyMode, TrailEntry,
  NetFilter, OneShot, PageAction, PageSig, GateContext, GateDecision,
} from '../types.ts';

export interface RunControl {
  pauseRequested: boolean;
  stopRequested: boolean;
  stepSignal(): AbortSignal;                            // fresh AbortController per LLM call or wait
  abortStep(reason: 'user_pause' | 'user_stop'): void;  // signal.reason = { scoutfox: 'user', reason }
  isUserAbort(err: unknown, signal?: AbortSignal): boolean; // checks the reason tag, never error text
  snapshot(): ControlSnapshot;
}

export interface LlmPort {
  complete(req: {
    node: string;
    mode?: string;
    role: string;
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
  result?: unknown;
  resultData?: unknown;
  via: 'cdp' | 'synthetic' | 'background';
  effect: Effect;
  urlAfter?: string;
  syntheticReason?: string;
  oneShot?: OneShot;
}

export interface BrowserPort {
  tabInfo(tabId: number): Promise<{ url: string; title: string; windowId: number; groupId: number; status: string } | null>;
  snapshot(tabId: number, opts: { showBadges: boolean; maxElements: number }): Promise<unknown>;
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
  begin(key: string, action: PageAction): Promise<void>;
  finish(key: string, result: ExecResult): Promise<void>;
  clearRun(runId: string): Promise<void>;
}

export interface RunRuntime {
  threadId: string;
  ownerTabId: number;
  bootId: string;
  control: RunControl;
  tabs: { activeTabId: number | null; ownerTabId: number };
  windowId: number | 'default';
  scoutFoxGroupIds: Map<number, number>;
  attachedTabIds: Set<number>;
  resumedAfterRestart: boolean;
  settings(): Promise<Settings>;
  llm: LlmPort;
  browser: BrowserPort;
  journal: ActionJournal;
  net: {
    marker(): string;
    read(tabId: number, filter: NetFilter, includeBody: boolean, limit: number): string;
  };
  emit: {
    enterNode(n: string, graph: string, phase?: string): void;
    setPhase(text: string): void;
  };
  clock: {
    now(): number;
    sleep(ms: number, signal?: AbortSignal): Promise<void>;
  };
  finishPolicy?: (ctx: GateContext) => GateDecision;
  typedTexts?: string[];
  navigatedFrom?: { site: string; before: string } | null;
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
