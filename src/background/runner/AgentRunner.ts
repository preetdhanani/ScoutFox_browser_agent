// src/background/runner/AgentRunner.ts
// Runner that drives the ScoutFox MCP tool loop (replaces LangGraph).
// Single runner per tab. Client calls LLM with tools, server executes in browser.
import { Storage, type Settings } from '../../shared/storage.ts';
import { Logger } from '../../shared/logger.ts';
import { BUILD_STAMP } from '../../shared/build.ts';
import { SessionActionJournal } from './actionJournal.ts';
import { SessionRunnerMeta } from './runnerMeta.ts';
import { runtimeRegistry, type RunRuntime } from './runtimeRegistry.ts';
import { generateCompletion } from '../llm/index.ts';
import { inputDispatcher } from '../browser/input.ts';
import { cdp } from '../browser/cdp.ts';
import { lastRuntimeError } from '../browser/tabs.ts';
import { NetworkBuffers } from '../browser/network.ts';
import { ensureScoutFoxGroup, isTabInScope, groupIdForWindow } from '../browser/groups.ts';
import { openNewWindow } from '../browser/windows.ts';
import { takeSnapshot } from '../browser/snapshot.ts';
import { executeAction } from '../browser/execute.ts';
import { ScoutFoxMCPClient } from '../mcp/client.js';
import type { RunStatus, HistoryEntry, Limits, EffortChoice, EffortProfile, RunStats } from '../types.ts';

// Make sessions accessible globally for MCP client
(globalThis as any).__scoutfoxSessions = (globalThis as any).__scoutfoxSessions || new Map();

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
  public graphLocation = { phase: 'Starting' };
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

  public scoutFoxGroupIds = new Map<number, number>();
  public networkBuffers = new NetworkBuffers(100);
  public autoApprovePlan = true;
  public autoConfirmAction = false;

  private taskClaimed = false;
  private adoptedTabIds = new Set<number>();
  private stopDuringClaim = false;
  private pauseDuringClaim = false;
  private isLoopActive = false;
  private _activeTabId: number | null = null;
  private onStateChangeCb: ((state: Record<string, any>) => void) | null = null;
  private onTabAdoptedCb: ((tabId: number, windowId: number) => void) | null = null;

  private saver: { deleteThread: (threadId: string) => Promise<void>; revive: (threadId: string) => void };
  private journal: SessionActionJournal;
  private meta: SessionRunnerMeta;
  private runtime: RunRuntime;
  private currentDrive: Promise<void> | null = null;
  private activeAbort: AbortController | null = null;
  private pauseTimer: ReturnType<typeof setTimeout> | null = null;
  private clearPromise: Promise<void> = Promise.resolve();

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

    this.saver = {
      deleteThread: async () => { /* no-op: LangGraph checkpoints removed */ },
      revive: () => { /* no-op: LangGraph checkpoints removed */ },
    };
    this.journal = new SessionActionJournal(this.threadId, this.bootId);
    this.meta = new SessionRunnerMeta(this.threadId);

    this.runtime = this.createRuntime();
    runtimeRegistry.set(this.runtime);

    // Register session globally for MCP client
    (globalThis as any).__scoutfoxSessions.set(this.sessionId, {
      engine: this,
      ports: new Set(),
      ownerTabId: this.ownerTabId
    });

    this.restorePromise = this.restoreState();
    Logger.info('AgentRunner', `[INIT] Session ${this.sessionId} created (build ${BUILD_STAMP})`);
  }

  get activeTabId(): number | null {
    return this._activeTabId;
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

  set scoutFoxGroupId(groupId: number | null) {
    if (groupId === null) {
      if (typeof this.windowId === 'number') this.scoutFoxGroupIds.delete(this.windowId);
    } else {
      const win = typeof this.windowId === 'number' ? this.windowId : 0;
      this.scoutFoxGroupIds.set(win, groupId);
    }
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
        let effectiveSettings = settings;
        if (req.role === 'planner' && settings.plannerModel) {
          effectiveSettings = { ...settings, model: settings.plannerModel };
        } else if (req.role === 'reflect' && settings.reflectModel) {
          effectiveSettings = { ...settings, model: settings.reflectModel };
        }
        const chatMessages = req.messages.map((m: any) => ({ role: m.role, content: m.content }));
        let systemPrompt = req.system;
        if (effectiveSettings.systemInstructions?.trim()) {
          systemPrompt = `${effectiveSettings.systemInstructions.trim()}\n\n${systemPrompt}`;
        }
        const text = await generateCompletion(effectiveSettings, chatMessages, systemPrompt, {
          signal: req.signal,
          schema: req.schema,
          callbacks: req.callbacks
        });
        return { text, provider: effectiveSettings.provider, model: effectiveSettings.model, meta: {} };
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
      execute: async (tabId: number, action: any, opts: any) => {
        return await this.executeActionOnTab(tabId, action, opts);
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
          chrome.tabs.sendMessage(tabId, { action: 'WAIT_DOM_QUIET', payload: { quietMs, maxWaitMs: maxMs } }, () => {
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
          chrome.tabs.sendMessage(tabId, { action: 'CLEAR_BADGES' }, () => {
            lastRuntimeError();
            resolve();
          });
        });
      },
      isTabInScope: async (tabId: number) => {
        if (tabId === this.ownerTabId && this.scoutFoxGroupIds.size === 0) return true;
        if (this.adoptedTabIds.has(tabId)) return true;
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
  // Public API — SIMPLIFIED
  // -----------------------------------------------------------------------

  claimForTask() {
    if (this.status === 'running' || this.status === 'paused' || this.isLoopActive || this.taskClaimed) {
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

    await this.restorePromise;
    await this.clearPromise;
    this.dirty = true;
    this.activeTabId = tabId;
    this.currentTask = userPrompt.trim();
    Logger.info('AgentRunner', `[START_TASK] ${this.currentTask} on tab [${tabId}]`);

    await this.ensureScoutFoxGroup(tabId);

    const stopLanded = this.stopDuringClaim;
    const pauseLanded = this.pauseDuringClaim;
    this.stopDuringClaim = false;
    this.pauseDuringClaim = false;
    if (stopLanded) {
      this.releaseTaskClaim();
      this.status = 'stopped';
      this.currentTask = '';
      this.notifyStateChange({ stopped: true });
      return { success: false, error: 'Task stopped before it started.' };
    }

    this.status = 'running';
    this.pauseReason = null;
    this.stepCount = 0;
    this.runtime.control.stopRequested = false;
    this.runtime.control.pauseRequested = pauseLanded === true;

    try {
      const settings = await this.runtime.settings();
      const maxSteps = settings?.maxSteps ?? 250;

      // Initialize and start MCP client (replaces graph)
      this.mcpClient = new ScoutFoxMCPClient(this.runtime, this.sessionId as number);
      await this.mcpClient.startTask(userPrompt);
      
      return { success: true };
    } finally {
      this.releaseTaskClaim();
    }
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
    this.activeAbort?.abort({ scoutfox: 'user', reason: 'user_pause' });
    this.runtime.control.abortStep('user_pause');
    this.mcpClient?.stop();
    this.notifyStateChange({ paused: true });
    this.startPauseDetachTimer();
    return { success: true };
  }

  resume(): { success: boolean; error?: string } {
    if (this.status !== 'paused') {
      return { success: false, error: `Cannot resume when status is "${this.status}".` };
    }
    this.clearPauseDetachTimer();
    this.dirty = true;
    this.status = 'running';
    this.pauseReason = null;
    this.runtime.control.pauseRequested = false;
    this.notifyStateChange({ resumed: true });
    // MCP client handles resume via its own loop
    return { success: true };
  }

  stop(): { success: boolean; error?: string } {
    if (this.status === 'idle' || this.status === 'stopped') {
      if (this.taskClaimed) {
        this.stopDuringClaim = true;
        this.notifyStateChange({ stopped: true });
        return { success: true };
      }
      return { success: false, error: 'No task is running or paused.' };
    }
    const wasPaused = this.status === 'paused';
    this.clearPauseDetachTimer();
    this.dirty = true;
    this.status = 'stopped';
    this.pauseReason = null;
    this.activeAbort?.abort({ scoutfox: 'user', reason: 'user_stop' });
    this.runtime.control.abortStep('user_stop');
    this.mcpClient?.stop();
    this.notifyStateChange({ stopped: true });

    const targetTabId = this._activeTabId ?? this.ownerTabId;
    if (targetTabId && this.runtime.browser?.clearBadges) {
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

  clearHistory() {
    this.dirty = true;
    this.history = [];
    this.currentTask = '';
    this.planSteps = [];
    this.findings = [];
    this.status = 'idle';
    this.pauseReason = null;
    this.stepCount = 0;
    this.stateVersion = 0;
    this.runtime.typedTexts = [];
    this.runtime.navigatedFrom = null;
    void this.meta.clear();
    if (this.saver?.deleteThread) {
      this.clearPromise = this.saver.deleteThread(this.threadId).then(() => this.saver.revive(this.threadId)).catch(() => {});
    }
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
      graphLocation: this.graphLocation,
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
      findings: this.findings
    };
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
  // Tab Sandboxing (unchanged)
  // -----------------------------------------------------------------------

  async ensureScoutFoxGroup(tabId: number, explicitWindowId?: number) {
    return await ensureScoutFoxGroup(
      { windowId: this.windowId, groupIds: this.scoutFoxGroupIds, persist: () => this.persistState() },
      tabId,
      explicitWindowId
    );
  }

  async openNewWindow(url?: string) {
    return await openNewWindow(
      {
        adoptTab: (newTabId, winId) => {
          this.adoptedTabIds.add(newTabId);
          this.onTabAdoptedCb?.(newTabId, winId);
        },
        ensureGroup: async (newTabId, winId) => this.ensureScoutFoxGroup(newTabId, winId),
        setActiveTab: (newTabId) => {
          this.activeTabId = newTabId;
          this.notifyStateChange();
        }
      },
      url
    );
  }

  async executeActionOnTab(tabId: number, action: any, opts: any = {}): Promise<any> {
    const settings = await Storage.getSettings().catch(() => null);
    return await executeAction(tabId, action, {
      runRuntime: this.runtime,
      openNewWindow: (url) => this.openNewWindow(url),
      docId: opts?.docId,
      signal: this.runtime.control.stepSignal(),
      waitDomQuiet: (tId, qMs, mMs) => this.runtime.browser.waitDomQuiet(tId, qMs, mMs),
      actionDelayMs: settings?.actionDelayMs,
      allowExecuteJs: settings?.allowExecuteJs === true
    });
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

  setTabAdoptedCallback(cb: (tabId: number, windowId: number) => void) {
    this.onTabAdoptedCb = cb;
  }

  // Static: forget a session when its owner tab closes
  static forgetSession(sessionId: number | string): void {
    runtimeRegistry.delete(String(sessionId));
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
    // Network requests are buffered in networkBuffers; this is a no-op in the simplified loop
    // because the MCP client doesn't use network recording directly.
  }

  private notifyStateChange(extra?: Record<string, any>) {
    this.stateVersion++;
    if (this.onStateChangeCb) {
      this.onStateChangeCb({ ...this.getState(), ...extra });
    }
  }

  private startPauseDetachTimer() { /* no-op in simplified version */ }
  private clearPauseDetachTimer() { /* no-op in simplified version */ }
  dispose() { /* no-op in simplified version */ }

  private async restoreState(): Promise<void> {
    try {
      const saved = await this.meta.read();
      if (saved) {
        this.status = 'idle';
      }
    } catch {
      // Ignore restore errors
    }
  }
}