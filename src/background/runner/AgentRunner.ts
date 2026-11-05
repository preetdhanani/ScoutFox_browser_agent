// src/background/runner/AgentRunner.ts
// Runner that drives the ScoutFox MCP tool loop (replaces LangGraph).
// Single runner per tab. Client calls LLM with tools, server executes in browser.
import { Storage, type Settings } from '../../shared/storage.ts';
import { Logger } from '../../shared/logger.ts';
import { BUILD_STAMP } from '../../shared/build.ts';
import { SessionActionJournal } from './actionJournal.ts';
import { SessionRunnerMeta } from './runnerMeta.ts';
import { RunSnapshotStore, restoredRun, runSnapshotKey, type RunSnapshot } from './runSnapshot.ts';
import { runtimeRegistry, type RunRuntime } from './runtimeRegistry.ts';
import { generateCompletion } from '../llm/index.ts';
import { inputDispatcher } from '../browser/input.ts';
import { cdp } from '../browser/cdp.ts';
import { lastRuntimeError } from '../browser/tabs.ts';
import { TOP_FRAME } from '../browser/frames.ts';
import { NetworkBuffers } from '../browser/network.ts';
import { ensureScoutFoxGroup, isTabInScope, groupIdForWindow } from '../browser/groups.ts';
import { takeSnapshot } from '../browser/snapshot.ts';
import { ScoutFoxMCPClient, idleRequestTokens, type CallUsage } from '../mcp/client.ts';
import { STOPPED_TEXT, partialResultEntry } from '../mcp/historyEntries.ts';
import { CHAIN_WINDOW_SHARE, COMPACT_PROMPT, COMPACT_SYSTEM, chainTokens, chainTurns, compactionInput, hasEarlierTurn, lastSummary } from '../mcp/chatChain.ts';
import { normalizeEffort } from '../llm/effort.ts';
import { DEFAULT_CONTEXT_WINDOW, getEffectiveContextWindow, type ContextWindow, type ContextWindowSource } from '../llm/models.ts';
import { CHARS_PER_TOKEN } from '../../shared/tokens.ts';
import type { RunStatus, HistoryEntry, Limits, EffortChoice, EffortProfile, RunStats, Level } from '../types.ts';

/**
 * What the context meter of the panel shows (getState().context):
 *   used           tokens: during a run the prompt of the last model call; between runs an estimate
 *                  of what the next request starts with (system prompt, tool definitions, the chain);
 *                  0 for an empty chat
 *   window         the model's context window, and windowSource where that number comes from
 *   estimated      `used` is an estimate (between runs, or a provider that reported no usage)
 *   summarizedTurns  how many turns the last Compact summarized (0: never compacted)
 *   hasEarlierTurn whether a Compact has anything to summarize
 *   compacting     a Compact is in flight
 */
export interface ContextState {
  used: number;
  window: number;
  windowSource: ContextWindowSource;
  estimated: boolean;
  summarizedTurns: number;
  hasEarlierTurn: boolean;
  compacting: boolean;
}

/** The answer of compactChat. */
export interface CompactResult {
  success: boolean;
  error?: string;
  summary?: string;
}

export class AgentRunner {
  public threadId: string;
  public ownerTabId: number;
  public sessionId: number | string;
  public windowId: number | 'default';
  public bootId: string;
  public stateVersion = 0;
  public dirty = false;
  public restorePromise: Promise<void>;

  public status: RunStatus = 'idle';
  public stepCount = 0;
  public currentTask = '';
  public history: HistoryEntry[] = [];
  public planSteps: any[] = [];
  public currentPhase = '';
  public pendingQuestion: string | null = null;
  public pendingApproval: any | null = null;
  public pendingConfirm: any | null = null;
  public pendingChallengeHelp: any | null = null;
  public pendingContinueBudget: any | null = null;
  public pauseReason: 'user' | 'llm_failure' | 'worker_restart' | null = null;
  public budget: any | null = null;
  public effort: EffortChoice | null = null;
  public effortProfile: EffortProfile | null = null;
  public runStats: RunStats | null = null;
  public findings: any[] = [];

  /** The context window of the chosen model, resolved by refreshContext (never per call). */
  public contextWindow: ContextWindow = { tokens: DEFAULT_CONTEXT_WINDOW, source: 'default' };
  /** The tokens of the system prompt and the tool definitions, estimated: what every request starts with. */
  private contextBase = 0;
  /** The tokens of the last model call of the current task, or null before its first call. */
  private lastCall: CallUsage | null = null;
  /** True while a Compact is in flight (the panel's card says so and keeps the button off). */
  private compacting = false;
  /** Goes up on New chat: a Compact that started in the old chat must not land in the new one. */
  private chatGeneration = 0;
  /** Cancels the Compact a task start runs (auto-compact) when the user stops the task. */
  private compactAbort: AbortController | null = null;
  /** Orders the refreshes of the window: only the newest one is kept. */
  private contextRefreshes = 0;

  public scoutFoxGroupIds = new Map<number, number>();
  public networkBuffers = new NetworkBuffers(100);
  public autoApprovePlan = true;

  private taskClaimed = false;
  private stopDuringClaim = false;
  private pauseDuringClaim = false;
  private _activeTabId: number | null = null;
  private onStateChangeCb: ((state: Record<string, any>) => void) | null = null;

  private journal: SessionActionJournal;
  private meta: SessionRunnerMeta;
  /** The panel-visible run, kept across worker restarts (see runSnapshot.ts). */
  private snapshots: RunSnapshotStore;
  private runtime: RunRuntime;

  // MCP Client (replaces graph engine)
  private mcpClient: ScoutFoxMCPClient | null = null;

  constructor(ownerTabId: number, windowId: number | 'default' = 'default') {
    this.ownerTabId = ownerTabId;
    this.sessionId = ownerTabId;
    this.threadId = String(ownerTabId);
    this.windowId = windowId;
    this._activeTabId = ownerTabId;

    this.bootId = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `boot_${Date.now()}_${Math.floor(Math.random() * 1e9)}`;

    this.journal = new SessionActionJournal(this.threadId, this.bootId);
    this.meta = new SessionRunnerMeta(this.threadId);
    this.snapshots = new RunSnapshotStore(this.threadId);

    this.runtime = this.createRuntime();
    runtimeRegistry.set(this.runtime);

    this.restorePromise = this.restoreState();
    Logger.debug('AgentRunner', `[INIT] Session ${this.sessionId} created (build ${BUILD_STAMP})`);
  }

  get activeTabId(): number | null {
    return this._activeTabId;
  }

  /**
   * The picture a run took, by id, for the panel's thumbnail.
   *
   * The bytes live in the MCP server's per-session registry and never in a history row, so this
   * is the one way back to them. Null when the run is over or the picture was dropped: the panel
   * then says the picture is no longer kept, which is what is true.
   */
  getScreenshot(imageId: string): Promise<{ data: string; mediaType: string } | null> {
    return this.mcpClient ? this.mcpClient.getScreenshot(imageId) : Promise.resolve(null);
  }

  set activeTabId(tabId: number | null) {
    this._activeTabId = tabId;
    this.runtime.tabs.activeTabId = tabId;
  }

  get scoutFoxGroupId(): number | null {
    return groupIdForWindow(
      { windowId: this.windowId, groupIds: this.scoutFoxGroupIds, persist: () => this.persistState() },
      this.windowId
    );
  }

  private createRuntime(): RunRuntime {
    let pauseReq = false;
    let stopReq = false;
    let activeStepAbort: AbortController | null = null;

    const control = {
      get pauseRequested() { return pauseReq; },
      set pauseRequested(v: boolean) { pauseReq = v; },
      get stopRequested() { return stopReq; },
      set stopRequested(v: boolean) { stopReq = v; },
      stepSignal: () => {
        activeStepAbort = new AbortController();
        if (pauseReq || stopReq) {
          activeStepAbort.abort({ scoutfox: 'user', reason: stopReq ? 'user_stop' : 'user_pause' });
        }
        return activeStepAbort.signal;
      },
      abortStep: (reason: string) => {
        if (reason === 'user_pause') pauseReq = true;
        if (reason === 'user_stop') stopReq = true;
        activeStepAbort?.abort({ scoutfox: 'user', reason });
      },
      isUserAbort: (err: any, signal: AbortSignal) => {
        if (signal?.aborted) {
          const reason = signal.reason as any;
          if (reason?.scoutfox === 'user') return true;
        }
        return false;
      },
      snapshot: () => ({ pauseRequested: pauseReq, stopRequested: stopReq })
    };

    const llm = {
      complete: async (req: any) => {
        const settings = await Storage.getSettings();
        const chatMessages = req.messages.map((m: any) => ({ role: m.role, content: m.content }));
        const extra = settings.systemInstructions?.trim();
        const systemPrompt = extra ? `${extra}\n\n${req.system}` : req.system;
        const text = await generateCompletion(settings, chatMessages, systemPrompt, {
          signal: req.signal,
          schema: req.schema,
          callbacks: req.callbacks
        });
        return { text, provider: settings.provider, model: settings.model, meta: {} };
      }
    };

    const browser = {
      tabInfo: async (tabId: number) => {
        if (typeof chrome === 'undefined' || !chrome.tabs?.get) return null;
        return new Promise<{ url: string; title: string; windowId: number; groupId: number; status: string } | null>((resolve) => {
          chrome.tabs.get(tabId, (tab) => {
            if (lastRuntimeError() || !tab) resolve(null);
            else resolve({ url: tab.url ?? '', title: tab.title ?? '', windowId: tab.windowId, groupId: tab.groupId, status: tab.status ?? 'complete' });
          });
        });
      },
      snapshot: async (tabId: number, opts: any) => {
        return await takeSnapshot(tabId, opts, {
          isTabInScope: async (id) => browser.isTabInScope(id),
          clearBadges: async (id) => browser.clearBadges(id),
          sleep: (ms) => this.runtime.clock.sleep(ms)
        });
      },
      navigate: async (tabId: number, url: string) => {
        if (typeof chrome === 'undefined' || !chrome.tabs?.update) return;
        await chrome.tabs.update(tabId, { url });
      },
      reload: async (tabId: number) => {
        if (typeof chrome === 'undefined' || !chrome.tabs?.reload) return;
        await chrome.tabs.reload(tabId);
      },
      goBack: async (tabId: number) => {
        if (typeof chrome === 'undefined' || !chrome.tabs?.goBack) return;
        await chrome.tabs.goBack(tabId);
      },
      waitForTabComplete: async (tabId: number, timeoutMs: number) => {
        await this.waitForTabComplete(tabId, timeoutMs, control.stepSignal());
      },
      waitDomQuiet: async (tabId: number, quietMs: number, maxMs: number) => {
        if (typeof chrome === 'undefined' || !chrome.tabs?.sendMessage) return;
        await new Promise((resolve) => {
          chrome.tabs.sendMessage(tabId, { action: 'WAIT_DOM_QUIET', payload: { quietMs, maxWaitMs: maxMs } }, TOP_FRAME, () => {
            lastRuntimeError();
            resolve(undefined);
          });
        });
      },
      cdp: {
        ensureAttached: async (tabId: number) => {
          try {
            await cdp.attach(tabId);
            return { mode: 'cdp' as const, reason: null };
          } catch (err: any) {
            return { mode: 'synthetic' as const, reason: err.message };
          }
        },
        detachAll: async () => {
          const ids = Array.from(this.runtime.attachedTabIds ?? []);
          await Promise.allSettled(ids.map((tabId) => cdp.detach(tabId)));
        }
      },
      clearBadges: async (tabId: number) => {
        if (typeof chrome === 'undefined' || !chrome.tabs?.sendMessage) return;
        return new Promise<void>((resolve) => {
          chrome.tabs.sendMessage(tabId, { action: 'CLEAR_BADGES' }, TOP_FRAME, () => {
            lastRuntimeError();
            resolve();
          });
        });
      },
      isTabInScope: async (tabId: number) => {
        if (tabId === this.ownerTabId && this.scoutFoxGroupIds.size === 0) return true;
        return await isTabInScope(
          { windowId: this.windowId, groupIds: this.scoutFoxGroupIds, persist: () => this.persistState() },
          tabId
        );
      }
    };

    const runtime: RunRuntime = {
      threadId: this.threadId,
      ownerTabId: this.ownerTabId,
      bootId: this.bootId,
      control,
      tabs: { activeTabId: this._activeTabId, ownerTabId: this.ownerTabId },
      windowId: this.windowId,
      scoutFoxGroupIds: this.scoutFoxGroupIds,
      attachedTabIds: new Set(),
      resumedAfterRestart: false,
      settings: () => Storage.getSettings(),
      llm,
      browser,
      journal: this.journal,
      net: {
        marker: () => `${this.bootId}:${this.stepCount}`,
        read: (tabId: number, filter: any, includeBody: boolean, limit: number) =>
          this.networkBuffers.read(tabId, filter, includeBody, limit)
      },
      emit: {
        enterNode: (name: string) => {
          this.currentPhase = name;
          this.notifyStateChange();
        },
        setPhase: (text: string) => {
          this.currentPhase = text;
          this.notifyStateChange();
        }
      },
      clock: {
        now: () => Date.now(),
        sleep: async (ms: number, signal?: AbortSignal) => {
          if (signal?.aborted) return;
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, ms);
            signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
          });
        }
      },
      typedTexts: [],
      navigatedFrom: null
    };

    return runtime;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * One row for the side panel's timeline, written by the MCP client. Pushes the entry, keeps
   * stepCount in step with the action rows, and broadcasts the state so the panel streams live.
   */
  recordEntry(entry: HistoryEntry): void {
    this.dirty = true;
    this.history.push(entry);
    this.stepCount = this.history.reduce((n, h) => (h.type === 'agent_response' ? n + 1 : n), 0);
    this.notifyStateChange();
  }

  /** The run's status as the panel sees it ('idle' and 'error' are terminal; 'paused' carries its reason). */
  setRunStatus(status: RunStatus, pauseReason: 'user' | 'llm_failure' | 'worker_restart' | null = null): void {
    this.dirty = true;
    this.status = status;
    this.pauseReason = status === 'paused' ? pauseReason : null;
    this.notifyStateChange();
    void this.detachIfDone();
  }

  /** The plan checklist of the current run (update_plan), replacing any previous one. */
  setPlanSteps(steps: Array<{ text: string; status: string }>): void {
    this.dirty = true;
    this.planSteps = steps;
    this.notifyStateChange();
  }

  /** The plan waiting for the user's approval in manual mode, or null once it is decided. */
  setPendingApproval(value: any): void {
    this.dirty = true;
    this.pendingApproval = value;
    this.notifyStateChange();
  }

  /**
   * Ends the manual-approve hold. The card and the status change in one broadcast: clearing the
   * card while still "paused" would flash a Resume button with nothing to resume.
   */
  resolvePendingApproval(status: RunStatus, pauseReason: 'user' | 'llm_failure' | 'worker_restart' | null = null): void {
    this.dirty = true;
    this.pendingApproval = null;
    this.status = status;
    this.pauseReason = status === 'paused' ? pauseReason : null;
    this.notifyStateChange();
    void this.detachIfDone();
  }

  claimForTask() {
    if (this.status === 'running' || this.status === 'paused' || this.taskClaimed) {
      return { success: false, error: 'A task is already active or paused.' };
    }
    this.taskClaimed = true;
    this.stopDuringClaim = false;
    this.pauseDuringClaim = false;
    return { success: true };
  }

  releaseTaskClaim() {
    this.taskClaimed = false;
    this.stopDuringClaim = false;
    this.pauseDuringClaim = false;
  }

  async startTask(userPrompt: string, tabId: number, requestedEffort?: string, autoApprove?: boolean) {
    if (!userPrompt?.trim()) {
      this.releaseTaskClaim();
      return { success: false, error: 'Cannot start empty prompt.' };
    }

    // Everything after the claim is inside the try, so a failure anywhere (restore, the tab
    // group) still releases it: a claim left behind locks the tab out of every later task.
    try {
      await this.restorePromise;
      this.dirty = true;
      this.activeTabId = tabId;
      this.currentTask = userPrompt.trim();
      Logger.event('agent', 'AgentRunner', `Started the task "${this.currentTask}" on tab [${tabId}]`, { task: this.currentTask, tabId, autoApprovePlan: autoApprove !== false });

      await this.ensureScoutFoxGroup(tabId);

      // The window of the model this task runs on, and the chain of the chat checked against it: a
      // chain over a quarter of the window is compacted first (the timeline shows the divider).
      // This happens while the task is still being claimed, so a Stop here lands as a Stop before
      // the start, and it cancels the summary call.
      await this.refreshContext();
      if (!this.stopDuringClaim) await this.autoCompactIfLong();

      const stopLanded = this.stopDuringClaim;
      const pauseLanded = this.pauseDuringClaim;
      this.stopDuringClaim = false;
      this.pauseDuringClaim = false;
      if (stopLanded) {
        this.status = 'stopped';
        this.currentTask = '';
        this.notifyStateChange({ stopped: true });
        return { success: false, error: 'Task stopped before it started.' };
      }

      // A Pause clicked while the task was still being claimed lands as a real pause: the turn
      // is set up, then the run waits in 'paused' for Resume. The step signal is never left
      // aborted, so the actions after Resume run normally.
      this.status = pauseLanded ? 'paused' : 'running';
      this.pauseReason = pauseLanded ? 'user' : null;
      this.stepCount = 0;
      // A new task starts with no plan hold and the approval mode the panel chose. A missing
      // field keeps the old default (autonomous), which is what every non-panel caller wants.
      this.autoApprovePlan = autoApprove !== false;
      this.pendingApproval = null;
      this.runtime.control.stopRequested = false;
      this.runtime.control.pauseRequested = false;

      // Initialize and start MCP client (replaces graph). The runner is handed over so the
      // client can record the history rows the side panel renders from, and so the run ends
      // in a terminal status instead of "running" forever.
      // The effort is the model's reasoning level (llm/effort.ts). A start without one (a caller
      // other than the composer) takes the default of Settings.
      const settings = await Storage.getSettings();
      const level = normalizeEffort(requestedEffort ?? settings.effortDefault);
      this.effort = { requested: level, level, suggestedBy: requestedEffort ? 'user' : 'default' };
      // The meter shows this task's own calls from its first one on; its token counts start at zero.
      this.lastCall = null;
      this.runStats = { level: level as Level, modelCalls: 0, stepsUsed: 0, tokensIn: 0, tokensOut: 0, sitesDone: 0, sitesPartial: 0, elapsedMs: 0 };
      this.mcpClient = new ScoutFoxMCPClient(this.runtime, this);
      await this.mcpClient.startTask(userPrompt, { startPaused: pauseLanded, effort: level });

      return { success: true };
    } finally {
      this.releaseTaskClaim();
    }
  }

  /**
   * Releases the debugger from every tab of the run once it has ended, so the "is debugging this
   * browser" bar goes away with the run. A paused run keeps it, so Resume does not pay the attach
   * again. Called on every status change; a running or paused status makes it a no-op.
   */
  private async detachIfDone(): Promise<void> {
    if (this.status === 'running' || this.status === 'paused') return;
    const ids = new Set<number>([this.ownerTabId]);
    if (typeof this._activeTabId === 'number') ids.add(this._activeTabId);
    // No isAttached filter: detach is idempotent and only ever touches this extension's own
    // session, and a tab whose attach is still settling must not be skipped.
    await Promise.allSettled(Array.from(ids).map((id) => cdp.detach(id)));
  }

  pause(): { success: boolean; error?: string } {
    if (this.status !== 'running') {
      if (this.taskClaimed) {
        this.pauseDuringClaim = true;
        this.notifyStateChange({ paused: true });
        return { success: true };
      }
      return { success: false, error: `Cannot pause when status is "${this.status}".` };
    }
    this.dirty = true;
    this.status = 'paused';
    this.pauseReason = 'user';
    this.runtime.control.abortStep('user_pause');
    this.mcpClient?.stop();
    this.notifyStateChange({ paused: true });
    return { success: true };
  }

  resume(): { success: boolean; error?: string } {
    if (this.status !== 'paused') {
      return { success: false, error: `Cannot resume when status is "${this.status}".` };
    }
    this.dirty = true;
    this.status = 'running';
    this.pauseReason = null;
    this.runtime.control.pauseRequested = false;
    this.notifyStateChange({ resumed: true });
    // The MCP client re-enters its loop from the message history it still holds.
    this.mcpClient?.resume();
    return { success: true };
  }

  stop(): { success: boolean; error?: string } {
    if (!this.endRun('stopped', partialResultEntry(STOPPED_TEXT, 'stopped'))) {
      if (this.taskClaimed) {
        this.stopDuringClaim = true;
        // A task start that is compacting the chat first: the summary call is cancelled too.
        this.compactAbort?.abort({ scoutfox: 'user', reason: 'user_stop' });
        this.notifyStateChange({ stopped: true });
        return { success: true };
      }
      return { success: false, error: 'No task is running or paused.' };
    }

    const targetTabId = this._activeTabId ?? this.ownerTabId;
    if (targetTabId) {
      this.runtime.browser.clearBadges(targetTabId);
    }
    return { success: true };
  }

  answerQuestion(answerText: string): { success: boolean; error?: string } {
    return { success: false, error: 'Not supported in MCP mode' };
  }

  async approvePlan(decision: any) {
    // Handle plan approval from side panel
    if (this.mcpClient) {
      this.mcpClient.handleApprovePlan(decision?.decision === 'approve');
    }
  }

  async confirmAction(decision: 'approve' | 'reject', remember?: 'site') {
    // Not used in MCP loop
  }

  async resolveChallenge(action: 'resolved' | 'skip') {
    // Not used in MCP loop
  }

  async continueBudget(action: 'continue' | 'finish', additionalSteps?: number) {
    // Not used in MCP loop
  }

  /**
   * The one way out of running or paused. Every ending goes through here: the user's Stop, the
   * client's finish or failure, a closed tab, New chat. It halts the loop first, so nothing writes
   * into the run after its end, then leaves a terminal status and the final row (none for New
   * chat, whose history is cleared) in one state broadcast: a run never ends as an idle thread
   * with no card. Returns false when no run is active; that later ending is dropped, since the
   * run already has its own.
   */
  endRun(status: 'idle' | 'stopped' | 'error', row: HistoryEntry | null): boolean {
    if (this.status !== 'running' && this.status !== 'paused') return false;
    this.runtime.control.abortStep('user_stop');
    this.mcpClient?.stop();
    this.dirty = true;
    if (row) this.history.push(row);
    this.status = status;
    this.pauseReason = null;
    this.pendingApproval = null;
    this.notifyStateChange(status === 'stopped' ? { stopped: true } : undefined);
    void this.detachIfDone();
    return true;
  }

  /**
   * Chrome swapped this session's tab for another one (chrome.tabs.onReplaced: a prerendered or
   * instant page took its place). The run follows the new id, and so do its storage keys: a
   * restarted worker builds the runner of a tab from that tab's id, so a run kept under the old id
   * would never be found again.
   */
  replaceTab(oldTabId: number, newTabId: number): void {
    if (this.ownerTabId === oldTabId) {
      this.ownerTabId = newTabId;
      this.runtime.ownerTabId = newTabId;
      this.runtime.tabs.ownerTabId = newTabId;
      this.rekeyThread(newTabId);
    }
    if (this._activeTabId === oldTabId) this.activeTabId = newTabId;
  }

  /**
   * Moves the thread to the owner tab's new id: the runtime registry entry, the run snapshot and
   * the runner meta are written under the new key at once, and the old keys are dropped.
   */
  private rekeyThread(newTabId: number): void {
    const previous = this.threadId;
    const next = String(newTabId);
    if (previous === next) return;
    runtimeRegistry.delete(previous);
    this.threadId = next;
    this.sessionId = newTabId;
    this.runtime.threadId = next;
    runtimeRegistry.set(this.runtime);
    // A debounced write of the old store must not land under the old key after it was dropped.
    this.snapshots.discard();
    this.journal = new SessionActionJournal(next, this.bootId);
    this.meta = new SessionRunnerMeta(next);
    this.snapshots = new RunSnapshotStore(next);
    this.snapshots.save(this.runSnapshot(), true);
    void this.persistState();
    AgentRunner.dropStoredState(previous);
  }

  clearHistory() {
    // New chat ends a live run first: its loop must not go on into the cleared thread.
    this.endRun('idle', null);
    this.mcpClient = null;
    this.dirty = true;
    // A Compact still in flight belongs to the chat that is gone: its summary is dropped.
    this.chatGeneration += 1;
    this.lastCall = null;
    this.runStats = null;
    this.history = [];
    this.currentTask = '';
    this.planSteps = [];
    this.pendingApproval = null;
    this.findings = [];
    this.status = 'idle';
    this.pauseReason = null;
    this.stepCount = 0;
    this.stateVersion = 0;
    this.runtime.typedTexts = [];
    this.runtime.navigatedFrom = null;
    void this.meta.clear();
    void this.snapshots.clear();
    this.notifyStateChange();
  }

  getState(): Record<string, any> {
    return {
      status: this.status,
      stepCount: this.stepCount,
      task: this.currentTask,
      history: this.history,
      planSteps: this.planSteps,
      currentPhase: this.currentPhase,
      pauseReason: this.pauseReason,
      budget: this.budget,
      pendingQuestion: this.pendingQuestion,
      pendingApproval: this.pendingApproval,
      pendingConfirm: this.pendingConfirm,
      pendingChallengeHelp: this.pendingChallengeHelp,
      pendingContinueBudget: this.pendingContinueBudget,
      stateVersion: this.stateVersion,
      bootId: this.bootId,
      scoutFoxGroupId: this.scoutFoxGroupId,
      effort: this.effort,
      effortProfile: this.effortProfile,
      runStats: this.runStats,
      findings: this.findings,
      context: this.contextState()
    };
  }

  /** The context meter's numbers (see ContextState). */
  contextState(): ContextState {
    const live = (this.status === 'running' || this.status === 'paused') && this.lastCall !== null;
    const empty = this.history.length === 0;
    return {
      used: live ? this.lastCall!.promptTokens : empty ? 0 : this.contextBase + chainTokens(this.history),
      window: this.contextWindow.tokens,
      windowSource: this.contextWindow.source,
      estimated: live ? this.lastCall!.estimated : !empty,
      summarizedTurns: lastSummary(this.history)?.summarizedTurns ?? 0,
      hasEarlierTurn: hasEarlierTurn(this.history),
      compacting: this.compacting
    };
  }

  /** The tokens of the model call that just returned (the MCP client's RunRecorder.noteUsage). */
  noteUsage(usage: CallUsage): void {
    this.lastCall = { ...usage };
    if (this.runStats) {
      this.runStats = {
        ...this.runStats,
        modelCalls: this.runStats.modelCalls + 1,
        stepsUsed: this.stepCount,
        tokensIn: (this.runStats.tokensIn ?? 0) + usage.promptTokens,
        tokensOut: (this.runStats.tokensOut ?? 0) + usage.outputTokens
      };
    }
    this.dirty = true;
    this.notifyStateChange();
  }

  /**
   * Resolves the window of the chosen model and the size of what a request starts with, and
   * broadcasts when either changed. Called when a task starts, when the panel asks for the state,
   * and when the settings or the model lists change (background.ts), never per model call.
   */
  async refreshContext(): Promise<void> {
    const mine = ++this.contextRefreshes;
    try {
      const settings = await Storage.getSettings();
      const window = await getEffectiveContextWindow(settings);
      const base = idleRequestTokens({
        instructions: (settings.systemInstructions || '').trim(),
        autoApprovePlan: settings.autoApprove !== false,
        research: settings.research?.enabled !== false
      });
      if (mine !== this.contextRefreshes) return;
      const changed = window.tokens !== this.contextWindow.tokens || window.source !== this.contextWindow.source || base !== this.contextBase;
      this.contextWindow = window;
      this.contextBase = base;
      if (changed) this.notifyStateChange();
    } catch (err) {
      Logger.warn('AgentRunner', `[CONTEXT] Could not resolve the context window: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * The one model call of a Compact: the fixed instruction and the chat as data, a plain answer.
   * A seam of its own, so a test can stand in for the model.
   */
  async summarizeChat(input: string, signal?: AbortSignal): Promise<string> {
    const settings = await Storage.getSettings();
    return generateCompletion(settings, [{ role: 'user', content: `${COMPACT_PROMPT}\n\n${input}` }], COMPACT_SYSTEM, { signal });
  }

  /**
   * Compact: one model call summarizes the chat (the earlier summary and the turns after it), and
   * the summary is kept in a chat_compacted row, which the chain of every later request starts
   * from. Refused while a task runs. A failed call, or a New chat while it was in flight, leaves
   * the chat as it was.
   */
  async compactChat(options: { auto?: boolean; signal?: AbortSignal } = {}): Promise<CompactResult> {
    await this.restorePromise;
    if (this.status === 'running' || this.status === 'paused') return { success: false, error: 'Stop the task before you compact the chat.' };
    if (this.compacting) return { success: false, error: 'The chat is already being compacted.' };
    const turns = chainTurns(this.history);
    if (turns.length === 0) return { success: false, error: 'There is no earlier turn to compact.' };

    const generation = this.chatGeneration;
    const summarizedTurns = (lastSummary(this.history)?.summarizedTurns ?? 0) + turns.length;
    // The input is held to half the window: the oldest turns are left out first.
    const maxChars = Math.max(8_000, Math.floor(this.contextWindow.tokens * CHARS_PER_TOKEN * 0.5));
    const input = compactionInput(this.history, maxChars);
    this.compacting = true;
    this.notifyStateChange();
    try {
      const summary = String(await this.summarizeChat(input, options.signal) || '').trim();
      if (generation !== this.chatGeneration) return { success: false, error: 'The chat was cleared while it was being compacted.' };
      if (options.signal?.aborted) return { success: false, error: 'The compaction was stopped.' };
      if (!summary) return { success: false, error: 'The model gave an empty summary, so the chat is unchanged.' };
      this.compacting = false;
      this.recordEntry({ type: 'chat_compacted', summary, summarizedTurns, ...(options.auto ? { auto: true } : {}), timestamp: new Date().toLocaleTimeString() });
      Logger.event('agent', 'AgentRunner', `Compacted the chat: ${summarizedTurns} turn${summarizedTurns === 1 ? '' : 's'} in a summary of ${summary.length} characters${options.auto ? ' (automatically, the chain was long)' : ''}`, { summarizedTurns, auto: !!options.auto, summary });
      return { success: true, summary };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      Logger.warn('AgentRunner', `[COMPACT] The chat could not be compacted: ${message}`);
      return { success: false, error: `The chat could not be compacted: ${message}` };
    } finally {
      if (this.compacting) {
        this.compacting = false;
        this.notifyStateChange();
      }
    }
  }

  /** Compacts the chat before a task when its chain takes more than CHAIN_WINDOW_SHARE of the window. */
  private async autoCompactIfLong(): Promise<void> {
    if (!hasEarlierTurn(this.history)) return;
    const tokens = chainTokens(this.history);
    if (tokens <= this.contextWindow.tokens * CHAIN_WINDOW_SHARE) return;
    Logger.info('AgentRunner', `[COMPACT] The chain of this chat is ${tokens} tokens, over ${Math.round(CHAIN_WINDOW_SHARE * 100)}% of the ${this.contextWindow.tokens}-token window: compacting it before the task.`);
    this.compactAbort = new AbortController();
    try {
      const result = await this.compactChat({ auto: true, signal: this.compactAbort.signal });
      if (!result.success && !this.compactAbort.signal.aborted) {
        Logger.warn('AgentRunner', `[COMPACT] The task starts with the whole chain: ${result.error}`);
      }
    } finally {
      this.compactAbort = null;
    }
  }

  async persistState() {
    await this.meta.writeImmediate({
      stateVersion: this.stateVersion,
      scoutFoxGroupIds: Array.from(this.scoutFoxGroupIds.entries()) as [number, number][],
      aliases: [],
      attachedTabIds: Array.from(this.runtime.attachedTabIds),
      pauseDetach: null,
      lastBeatAt: Date.now()
    });
  }

  // -----------------------------------------------------------------------
  // Tab Sandboxing
  // -----------------------------------------------------------------------

  async ensureScoutFoxGroup(tabId: number, explicitWindowId?: number) {
    return await ensureScoutFoxGroup(
      { windowId: this.windowId, groupIds: this.scoutFoxGroupIds, persist: () => this.persistState() },
      tabId,
      explicitWindowId
    );
  }

  async waitForTabComplete(tabId: number, timeoutMs = 15000, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    if (typeof chrome === 'undefined' || !chrome.tabs?.onUpdated) return;
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Tab load timeout')), timeoutMs);
        const listener = (updatedTabId: number, changeInfo: any) => {
          if (updatedTabId !== tabId) return;
          if (changeInfo.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            clearTimeout(timer);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
        signal?.addEventListener('abort', () => {
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timer);
          resolve();
        });
        // A load that completed before the listener was added fires no event any more: the tab's
        // own status says so, instead of a wait that can only time out.
        chrome.tabs.get?.(tabId, (tab) => {
          if (chrome.runtime?.lastError) return;
          if (tab?.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            clearTimeout(timer);
            resolve();
          }
        });
      });
    } catch {
      // Timeout or error - continue anyway
    }
  }

  // -----------------------------------------------------------------------
  // State Broadcast
  // -----------------------------------------------------------------------

  setStateChangeCallback(cb: (state: Record<string, any>) => void) {
    this.onStateChangeCb = cb;
  }

  // Static: forget a session when its owner tab closes
  static forgetSession(sessionId: number | string): void {
    runtimeRegistry.delete(String(sessionId));
    AgentRunner.dropStoredState(sessionId);
  }

  /**
   * Removes what a tab's session kept in storage.session (its run and its meta). Also called for a
   * tab whose session this worker never built: after a worker restart a closed tab may have state
   * in storage and no runner in memory.
   */
  static dropStoredState(threadId: number | string): void {
    if (typeof chrome === 'undefined' || !chrome.storage?.session?.remove) return;
    void chrome.storage.session.remove([runSnapshotKey(threadId), `sf:meta:${threadId}`]).catch(() => {});
  }

  // groupIdForWindow: returns the ScoutFox group id for a window
  groupIdForWindow(windowId: number): number | null {
    return groupIdForWindow(
      { windowId: this.windowId, groupIds: this.scoutFoxGroupIds, persist: () => this.persistState() },
      windowId
    );
  }

  // recordNetworkRequest: record a network request for a tab
  recordNetworkRequest(tabId: number, payload: any): void {
    // The content scripts' net recorder feeds this buffer.
    this.networkBuffers.record(tabId, payload, this.runtime.net.marker());
  }

  private notifyStateChange(extra?: Record<string, any>) {
    this.stateVersion++;
    // Every state the panel sees is kept for a worker restart. A state the run rests in (ended,
    // paused, waiting on the user) goes out at once: that is when the worker may be stopped next.
    const resting = this.status !== 'running' || this.pendingApproval !== null;
    this.snapshots.save(this.runSnapshot(), resting);
    if (this.onStateChangeCb) {
      this.onStateChangeCb({ ...this.getState(), ...extra });
    }
  }

  private runSnapshot(): RunSnapshot {
    return {
      status: this.status,
      task: this.currentTask,
      history: this.history,
      planSteps: this.planSteps,
      stepCount: this.stepCount,
      pauseReason: this.pauseReason,
      stateVersion: this.stateVersion,
      lastCall: this.lastCall,
      runStats: this.runStats,
      savedAt: Date.now()
    };
  }

  /**
   * The tab group map is what lets a restarted worker keep grouping and adopting this session's
   * tabs; persistState writes it, so it is read back here.
   */
  private restoreGroupMap(entries: Array<[number, number]>): void {
    for (const [windowId, groupId] of entries) {
      if (typeof windowId === 'number' && typeof groupId === 'number' && !this.scoutFoxGroupIds.has(windowId)) {
        this.scoutFoxGroupIds.set(windowId, groupId);
      }
    }
  }

  private async restoreState(): Promise<void> {
    // The run the panel showed before the worker restarted. Restored before restorePromise
    // resolves, which the port connect and GET_AGENT_STATE both wait for.
    try {
      const kept = await this.snapshots.read();
      if (kept) {
        const run = restoredRun(kept);
        this.status = run.status;
        this.currentTask = run.task || '';
        this.history = Array.isArray(run.history) ? run.history : [];
        this.planSteps = Array.isArray(run.planSteps) ? run.planSteps : [];
        this.stepCount = Number(run.stepCount) || 0;
        this.pauseReason = run.pauseReason ?? null;
        this.stateVersion = Math.max(this.stateVersion, Number(run.stateVersion) || 0);
        this.lastCall = run.lastCall && typeof run.lastCall.promptTokens === 'number' ? run.lastCall : null;
        this.runStats = run.runStats ?? null;
        if (run !== kept) {
          Logger.info('AgentRunner', `[RUN_RESTORED] The worker restarted during the run on tab [${this.ownerTabId}]; its steps are kept and the run is marked interrupted.`);
          this.snapshots.save(this.runSnapshot(), true);
        }
      }
    } catch {
      // A run that cannot be read back starts clean, like before.
    }
    try {
      const saved = await this.meta.read();
      // Only the tab group map comes back from the meta. The status is the restored run's own
      // (an interrupted run stays "stopped" with its final row), never reset here.
      if (saved) this.restoreGroupMap(saved.scoutFoxGroupIds || []);
    } catch {
      // Ignore restore errors
    }
  }
}