// src/background/runner/AgentRunner.ts
// Drop-in replacement for AgentEngine that drives the LangGraph StateGraph engine.
// Implements full engine surface, single-flight drive, status derivation,
// tab sandboxing, and checkpointer persistence.
import {
  Command,
  isGraphInterrupt,
  type BaseCheckpointSaver,
  type StateSnapshot,
} from '@langchain/langgraph/web';
import { Storage, type Settings } from '../../shared/storage.ts';
import { Logger } from '../../shared/logger.ts';
import { buildOrchestratorGraph } from '../graph/orchestrator.ts';
import { SessionStorageSaver } from '../checkpoint/SessionStorageSaver.ts';
import { SessionActionJournal } from './actionJournal.ts';
import { SessionRunnerMeta } from './runnerMeta.ts';
import { runtimeRegistry, type BrowserPort, type ExecResult, type LlmPort, type RunControl, type RunRuntime } from './runtimeRegistry.ts';
import { generateCompletion } from '../llm/index.ts';
import { inputDispatcher } from '../browser/input.ts';
import { cdp } from '../browser/cdp.ts';
import type { EffortChoice, EffortProfile, HistoryEntry, Limits, PlanView, RunStats, RunStatus } from '../graph/state.ts';

function lastRuntimeError(): string | null {
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError) {
    return chrome.runtime.lastError.message ?? 'Unknown chrome error';
  }
  return null;
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
  public graphLocation: {
    phase: string;
    orchestratorNode?: string;
    workerNode?: string;
    siteDomain?: string;
  } = { phase: 'Starting' };
  public pendingQuestion: string | null = null;
  public pendingApproval: any | null = null;
  public pendingConfirm: any | null = null;
  public pauseReason: 'user' | 'llm_failure' | 'worker_restart' | null = null;
  public effort: EffortChoice | null = null;
  public effortProfile: EffortProfile | null = null;
  public runStats: RunStats | null = null;
  public findings: any[] = [];

  public scoutFoxGroupIds = new Map<number, number>();
  public networkBuffers = new Map<number, any[]>();
  public autoApprovePlan = true; // Auto-approves plan during P4

  private taskClaimed = false;
  private isLoopActive = false;
  private _activeTabId: number | null = null;
  private onStateChangeCb: ((state: Record<string, any>) => void) | null = null;
  private onTabAdoptedCb: ((tabId: number, windowId: number) => void) | null = null;

  private saver: SessionStorageSaver;
  private journal: SessionActionJournal;
  private meta: SessionRunnerMeta;
  private graph: ReturnType<typeof buildOrchestratorGraph>;
  private runtime: RunRuntime;
  private currentDrive: Promise<void> | null = null;
  private activeAbort: AbortController | null = null;
  private pauseTimer: ReturnType<typeof setTimeout> | null = null;
  private clearPromise: Promise<void> = Promise.resolve();

  constructor(ownerTabId: number, windowId: number | 'default' = 'default', saver?: BaseCheckpointSaver, customLlm?: LlmPort) {
    this.ownerTabId = ownerTabId;
    this.sessionId = ownerTabId;
    this.threadId = String(ownerTabId);
    this.windowId = windowId;
    this._activeTabId = ownerTabId;

    this.bootId = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `boot_${Date.now()}_${Math.floor(Math.random() * 1e9)}`;

    this.saver = (saver as SessionStorageSaver) ?? new SessionStorageSaver();
    this.journal = new SessionActionJournal(this.threadId, this.bootId);
    this.meta = new SessionRunnerMeta(this.threadId);
    this.graph = buildOrchestratorGraph(this.saver);

    this.runtime = this.createRuntime(customLlm);
    runtimeRegistry.set(this.runtime);

    this.restorePromise = this.restoreState();
  }

  setLlmPort(customLlm: LlmPort): void {
    this.runtime.llm = customLlm;
  }

  // -------------------------------------------------------------------------------------------
  // Getters & Setters
  // -------------------------------------------------------------------------------------------

  get activeTabId(): number | null {
    return this._activeTabId;
  }

  set activeTabId(tabId: number | null) {
    this._activeTabId = tabId;
    this.runtime.tabs.activeTabId = tabId;
  }

  get scoutFoxGroupId(): number | null {
    return this.groupIdForWindow(this.windowId);
  }

  set scoutFoxGroupId(groupId: number | null) {
    if (groupId === null || groupId === undefined) {
      if (typeof this.windowId === 'number') this.scoutFoxGroupIds.delete(this.windowId);
    } else {
      const win = typeof this.windowId === 'number' ? this.windowId : 0;
      this.scoutFoxGroupIds.set(win, groupId);
    }
  }

  groupIdForWindow(windowId: number | 'default'): number | null {
    if (typeof windowId === 'number') {
      return this.scoutFoxGroupIds.get(windowId) ?? null;
    }
    const first = this.scoutFoxGroupIds.values().next();
    return first.done ? null : first.value;
  }

  // -------------------------------------------------------------------------------------------
  // Runtime Initialization
  // -------------------------------------------------------------------------------------------

  private createRuntime(customLlm?: LlmPort): RunRuntime {
    let pauseReq = false;
    let stopReq = false;
    let activeStepAbort: AbortController | null = null;

    const control: RunControl = {
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
      abortStep: (reason) => {
        if (reason === 'user_pause') pauseReq = true;
        if (reason === 'user_stop') stopReq = true;
        if (activeStepAbort) {
          activeStepAbort.abort({ scoutfox: 'user', reason });
        }
      },
      isUserAbort: (err, signal) => {
        if (signal?.aborted) {
          const reason = signal.reason as any;
          if (reason && typeof reason === 'object' && reason.scoutfox === 'user') {
            return true;
          }
        }
        return false;
      },
      snapshot: () => ({ pauseRequested: pauseReq, stopRequested: stopReq }),
    };

    const llm: LlmPort = customLlm ?? {
      complete: async (req) => {
        const settings = await Storage.getSettings();
        let effectiveSettings = settings;
        if (req.role === 'planner' && settings.plannerModel) {
          effectiveSettings = { ...settings, model: settings.plannerModel };
        } else if (req.role === 'reflect' && settings.reflectModel) {
          effectiveSettings = { ...settings, model: settings.reflectModel };
        }
        const chatMessages = req.messages.map((m) => ({ role: m.role, content: m.content }));
        const text = await generateCompletion(effectiveSettings, chatMessages, req.system, {
          signal: req.signal,
          schema: req.schema ?? undefined,
          callbacks: req.callbacks as any,
        });
        return {
          text,
          provider: effectiveSettings.provider,
          model: effectiveSettings.model,
          meta: {},
        };
      },
    };

    const browser: BrowserPort = {
      tabInfo: async (tabId) => {
        if (typeof chrome === 'undefined' || !chrome.tabs?.get) return null;
        return new Promise((resolve) => {
          chrome.tabs.get(tabId, (tab) => {
            if (lastRuntimeError() || !tab) resolve(null);
            else resolve({ url: tab.url ?? '', title: tab.title ?? '', windowId: tab.windowId, groupId: tab.groupId, status: tab.status ?? 'complete' });
          });
        });
      },
      snapshot: async (tabId, opts) => {
        if (typeof chrome === 'undefined' || !chrome.tabs?.sendMessage) {
          return { url: '', title: '', elementsText: '', refs: [] };
        }
        return new Promise((resolve, reject) => {
          chrome.tabs.sendMessage(tabId, { action: 'GET_DOM_SNAPSHOT', maxElements: opts.maxElements, showBadges: opts.showBadges }, (resp) => {
            const err = lastRuntimeError();
            if (err) reject(new Error(err));
            else {
              const data = resp?.data ?? resp;
              resolve({
                ...data,
                docId: resp?.docId ?? data?.docId ?? 'doc-1',
              });
            }
          });
        });
      },
      pageSig: async (tabId, opts) => {
        try {
          const resp = await new Promise<any>((resolve, reject) => {
            chrome.tabs.sendMessage(tabId, { action: 'GET_PAGE_SIG', payload: opts }, (res) => {
              const err = lastRuntimeError();
              if (err) reject(new Error(err));
              else resolve(res);
            });
          });
          if (resp?.success && resp.data) {
            const d = resp.data;
            return {
              sig: {
                url: d.url,
                title: d.title,
                elementCount: d.elementCount,
                interactiveHash: d.interactiveHash,
                textHash: d.textHash,
                scrollY: d.scrollY,
              },
              priceHits: d.priceHits || 0,
              found: d.visibleWords || [],
            };
          }
        } catch (_) {}

        const info = await browser.tabInfo(tabId);
        if (!info) return null;
        return {
          sig: { url: info.url, title: info.title, elementCount: 0, interactiveHash: '', textHash: '', scrollY: 0 },
          priceHits: 0,
          found: [],
        };
      },
      execute: async (tabId, action, opts) => {
        try {
          const res = await inputDispatcher.dispatchAction(tabId, action as any, { docId: opts.docId });
          return {
            success: res.success,
            message: res.message,
            error: res.error,
            via: res.via ?? 'cdp',
            effect: 'dom_changed',
          };
        } catch (err: any) {
          return {
            success: false,
            error: err.message,
            via: 'synthetic',
            effect: 'none',
          };
        }
      },
      navigate: async (tabId, url) => {
        if (typeof chrome === 'undefined' || !chrome.tabs?.update) return;
        await chrome.tabs.update(tabId, { url });
      },
      reload: async (tabId) => {
        if (typeof chrome === 'undefined' || !chrome.tabs?.reload) return;
        await chrome.tabs.reload(tabId);
      },
      goBack: async (tabId) => {
        if (typeof chrome === 'undefined' || !chrome.tabs?.goBack) return;
        await chrome.tabs.goBack(tabId);
      },
      waitForTabComplete: async (tabId, timeoutMs) => {
        await this.waitForTabComplete(tabId, timeoutMs);
      },
      waitDomQuiet: async (tabId, quietMs, maxMs) => {
        if (typeof chrome === 'undefined' || !chrome.tabs?.sendMessage) return;
        await new Promise((resolve) => {
          chrome.tabs.sendMessage(tabId, { action: 'WAIT_DOM_QUIET', quietMs, maxMs }, () => {
            lastRuntimeError();
            resolve(undefined);
          });
        });
      },
      cdp: {
        ensureAttached: async (tabId) => {
          try {
            await cdp.attach(tabId);
            return { mode: 'cdp', reason: null };
          } catch (err: any) {
            return { mode: 'synthetic', reason: err.message };
          }
        },
        detachAll: async () => {
          await cdp.detachAll();
        },
      },
      clearBadges: async (tabId) => {
        if (typeof chrome === 'undefined' || !chrome.tabs?.sendMessage) return;
        chrome.tabs.sendMessage(tabId, { action: 'CLEAR_BADGES' }, () => {
          lastRuntimeError();
        });
      },
      isTabInScope: async (_tabId) => {
        return true;
      },
    };

    return {
      threadId: this.threadId,
      ownerTabId: this.ownerTabId,
      bootId: this.bootId,
      control,
      tabs: { activeTabId: this._activeTabId },
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
        read: () => '[]',
      },
      emit: {
        enterNode: (name) => {
          this.currentPhase = name;
          const orchestratorNodes = ['plan', 'alloc', 'sched', 'site', 'summary', 'reflect', 'compile', 'offer', 'finalize'];
          const workerNodes = ['open', 'perceive', 'meter', 'blocked', 'policy', 'risk', 'hold', 'execute', 'verify', 'recover', 'record'];
          if (orchestratorNodes.includes(name)) {
            this.graphLocation.orchestratorNode = name;
            this.graphLocation.phase = name;
            if (name !== 'site') {
              this.graphLocation.workerNode = undefined;
            }
          } else if (workerNodes.includes(name)) {
            this.graphLocation.workerNode = name;
            this.graphLocation.phase = `site:${name}`;
          }
          this.notifyStateChange();
        },
        setPhase: (text) => {
          this.currentPhase = text;
          this.graphLocation.phase = text;
          this.notifyStateChange();
        },
      },
      clock: {
        now: () => Date.now(),
        sleep: async (ms, signal) => {
          if (signal?.aborted) return;
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, ms);
            signal?.addEventListener('abort', () => {
              clearTimeout(timer);
              resolve();
            }, { once: true });
          });
        },
      },
    };
  }

  // -------------------------------------------------------------------------------------------
  // Lifecycle & Public API
  // -------------------------------------------------------------------------------------------

  claimForTask() {
    if (this.status === 'running' || this.status === 'paused' || this.isLoopActive || this.taskClaimed) {
      Logger.warn('AgentRunner', `[START_TASK_REJECTED] A task is already active or paused (status=${this.status}, claimed=${this.taskClaimed}).`);
      return { success: false, error: 'A task is already active or paused. Stop it before starting another.' };
    }
    this.taskClaimed = true;
    return { success: true };
  }

  releaseTaskClaim() {
    this.taskClaimed = false;
  }

  async startTask(userPrompt: string, tabId: number, requestedEffort?: string, autoApprove?: boolean) {
    if (!userPrompt || !userPrompt.trim()) {
      return { success: false, error: 'Cannot start empty prompt.' };
    }

    if (autoApprove !== undefined) {
      this.autoApprovePlan = autoApprove;
    }

    await this.restorePromise;
    await this.clearPromise;
    this.dirty = true;
    this.activeTabId = tabId;

    await this.ensureScoutFoxGroup(tabId);

    this.currentTask = userPrompt.trim();
    this.status = 'running';
    this.stepCount = 0;
    this.runtime.control.stopRequested = false;
    this.runtime.control.pauseRequested = false;

    try {
      const userSettings = await this.runtime.settings().catch(() => null);
      const defaultEffort = userSettings?.effortDefault ?? 'auto';
      const requested = (requestedEffort as any) ?? defaultEffort;

      const maxSteps = userSettings?.maxSteps ?? 250;
      const limits: Limits = {
        maxSteps,
        maxSystemActions: maxSteps,
        maxParseErrorsPerTurn: maxSteps,
        maxConsecutiveParseErrors: 3,
      };

      await this.drive({
        task: this.currentTask,
        effort: {
          requested,
          level: requested === 'auto' ? 'medium' : requested,
          suggestedBy: requestedEffort ? 'user' : 'default',
        },
        limits,
      });
      return { success: true };
    } finally {
      this.releaseTaskClaim();
    }
  }

  pause(): { success: boolean; error?: string } {
    if (this.status !== 'running') {
      return { success: false, error: `Cannot pause when status is "${this.status}".` };
    }
    this.dirty = true;
    this.status = 'paused';
    this.pauseReason = 'user';
    this.activeAbort?.abort({ scoutfox: 'user', reason: 'user_pause' });
    this.runtime.control.abortStep('user_pause');
    this.notifyStateChange();
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
    this.pendingQuestion = null;
    this.runtime.control.pauseRequested = false;
    this.notifyStateChange();

    void this.drive(new Command({ resume: { kind: 'resume' } }));
    return { success: true };
  }

  stop(): { success: boolean; error?: string } {
    if (this.status === 'idle' || this.status === 'stopped') {
      return { success: false, error: 'No task is running or paused.' };
    }
    const wasPaused = this.status === 'paused';
    this.clearPauseDetachTimer();
    this.dirty = true;
    this.status = 'stopped';
    this.activeAbort?.abort({ scoutfox: 'user', reason: 'user_stop' });
    this.runtime.control.abortStep('user_stop');
    this.notifyStateChange();

    if (wasPaused) {
      void this.drive(new Command({ resume: { kind: 'stop' } }));
    }
    return { success: true };
  }

  answerQuestion(answerText: string): { success: boolean; error?: string } {
    this.dirty = true;
    if (this.status !== 'paused' || !this.pendingQuestion) {
      return { success: false, error: 'There is no pending question to answer right now.' };
    }
    const answer = (answerText || '').trim();
    if (!answer) {
      return { success: false, error: 'The answer cannot be empty.' };
    }

    this.clearPauseDetachTimer();
    this.status = 'running';
    this.pendingQuestion = null;
    this.notifyStateChange();

    void this.drive(new Command({ resume: { kind: 'answer', text: answer } }));
    return { success: true };
  }

  async approvePlan(decision: any) {
    this.clearPauseDetachTimer();
    this.dirty = true;
    this.pendingApproval = null;
    this.status = 'running';
    this.notifyStateChange();

    await this.drive(new Command({ resume: { kind: 'approve', ...decision } }));
  }

  async confirmAction(decision: 'approve' | 'reject', remember?: 'site') {
    this.clearPauseDetachTimer();
    this.dirty = true;
    this.pendingConfirm = null;
    this.status = 'running';
    this.notifyStateChange();

    await this.drive(new Command({ resume: { kind: decision, remember } }));
  }

  clearHistory() {
    this.dirty = true;
    this.history = [];
    this.currentTask = '';
    this.planSteps = [];
    this.findings = [];
    this.status = 'idle';
    this.pendingApproval = null;
    this.pendingConfirm = null;
    this.graphLocation = { phase: 'Starting' };
    if (this.saver?.deleteThread) {
      this.clearPromise = this.saver.deleteThread(this.threadId)
        .then(() => {
          this.saver.revive(this.threadId);
        })
        .catch(() => {});
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
      pendingQuestion: this.pendingQuestion,
      pendingApproval: this.pendingApproval,
      pendingConfirm: this.pendingConfirm,
      stateVersion: this.stateVersion,
      bootId: this.bootId,
      scoutFoxGroupId: this.scoutFoxGroupId,
      effort: this.effort,
      effortProfile: this.effortProfile,
      runStats: this.runStats,
      findings: this.findings,
    };
  }

  getStatus(): RunStatus {
    return this.status;
  }

  getHistory(): HistoryEntry[] {
    return this.history;
  }

  async persistState() {
    await this.meta.writeImmediate({
      stateVersion: this.stateVersion,
      scoutFoxGroupIds: Array.from(this.scoutFoxGroupIds.entries()),
      aliases: [],
      attachedTabIds: Array.from(this.runtime.attachedTabIds),
      pauseDetach: null,
      lastBeatAt: Date.now(),
    });
  }

  // -------------------------------------------------------------------------------------------
  // Single-Flight Graph Drive
  // -------------------------------------------------------------------------------------------

  private async drive(input: any): Promise<void> {
    if (this.currentDrive) {
      await this.currentDrive;
    }

    const drivePromise = this.executeDriveLoop(input);
    this.currentDrive = drivePromise;
    try {
      await drivePromise;
    } finally {
      if (this.currentDrive === drivePromise) {
        this.currentDrive = null;
      }
    }
  }

  private async executeDriveLoop(initialInput: any): Promise<void> {
    let currentInput: any = initialInput;

    while (currentInput !== null && !this.runtime.control.stopRequested) {
      const inputToExecute = currentInput;
      currentInput = null;

      const autoResumeCommand = await this.executeDriveStep(inputToExecute);
      if (autoResumeCommand) {
        currentInput = autoResumeCommand;
      }
    }
  }

  private async executeDriveStep(input: any): Promise<Command | null> {
    this.isLoopActive = true;
    const runAbort = new AbortController();
    this.activeAbort = runAbort;

    const cfg = {
      configurable: { thread_id: this.threadId },
      durability: 'sync' as const,
      recursionLimit: 3540,
      streamMode: 'values' as const,
      subgraphs: true,
      signal: runAbort.signal,
    };

    try {
      const stream = await this.graph.stream(input, cfg);
      for await (const chunk of stream) {
        const [ns, values] = Array.isArray(chunk) ? chunk : [[], chunk];
        if (ns.length === 0) {
          // Root orchestrator values
          if (values.task !== undefined) this.currentTask = values.task;
          if (values.stepCount !== undefined) this.stepCount = values.stepCount;
          if (values.history !== undefined) this.history = values.history;
          if (values.findings !== undefined) this.findings = values.findings;
          if (values.effort !== undefined) this.effort = values.effort;
          if (values.effortProfile !== undefined) this.effortProfile = values.effortProfile;
          if (values.runStats !== undefined) this.runStats = values.runStats;
          const plan = values.planMeta ?? values.plan;
          if (plan?.sites) {
            this.planSteps = plan.sites.map((s: any) => ({
              id: s.id,
              text: `${s.name}: ${s.goal}`,
              status: values.sites?.[s.id]?.status === 'running' ? 'in_progress' : (values.sites?.[s.id]?.status ?? 'pending'),
            }));
          }
          if (values.siteIn?.site?.domain) {
            this.graphLocation.siteDomain = values.siteIn.site.domain;
          }
        } else {
          // Worker values
          if (values.siteRun?.spec?.domain) {
            this.graphLocation.siteDomain = values.siteRun.spec.domain;
          }
          if (values.history && Array.isArray(values.history)) {
            const seen = new Set(this.history.map((h) => `${h.type}_${(h as any).step}`));
            for (const entry of values.history) {
              const k = `${entry.type}_${(entry as any).step}`;
              if (!seen.has(k)) {
                seen.add(k);
                this.history.push(entry);
              }
            }
          }
        }
        this.notifyStateChange();
      }
    } catch (err: any) {
      if (isGraphInterrupt(err)) {
        // Normal interrupt
      } else if (this.runtime.control.isUserAbort(err, runAbort.signal)) {
        // Aborted cleanly by pause or stop
      } else {
        Logger.error('AgentRunner', `Graph execution failure: ${err.message}`);
        try {
          await this.graph.updateState(cfg, {
            history: [{ type: 'error', content: `Execution Error: ${err.message}` }],
            runStatus: 'idle',
            endReason: 'error',
          }, 'finalize');
        } catch {
          // Ignore
        }
        this.status = 'idle';
        this.notifyStateChange();
        return null;
      }
    } finally {
      this.isLoopActive = false;
      this.activeAbort = null;
    }

    const snapshot = await this.graph.getState(cfg, { subgraphs: true });
    const autoResume = await this.deriveStatus(snapshot);
    this.notifyStateChange();
    return autoResume;
  }

  private async deriveStatus(snapshot: StateSnapshot): Promise<Command | null> {
    if (this.runtime.control.stopRequested) {
      this.status = 'stopped';
      return null;
    }

    // Check for interrupts across orchestrator and worker
    const allTasks = snapshot.tasks ?? [];
    const interruptedTask = allTasks.find((t) => t.interrupts && t.interrupts.length > 0);

    if (interruptedTask) {
      const interrupt = interruptedTask.interrupts[0]?.value as any;
      this.status = 'paused';

      if (interrupt?.kind === 'approve_plan') {
        if (this.autoApprovePlan) {
          this.pendingApproval = null;
          return new Command({ resume: { kind: 'approve' } });
        }
        const rootValues = snapshot.values ?? {};
        this.pendingApproval = {
          kind: 'approve_plan',
          planMeta: interrupt.planMeta ?? rootValues.planMeta ?? rootValues.plan,
          budget: rootValues.budget,
          effortProfile: rootValues.effortProfile ?? this.effortProfile,
          budgetEstimate: interrupt.budgetEstimate,
        };
      } else if (interrupt?.kind === 'ask_user') {
        this.pendingQuestion = interrupt.question ?? 'The agent needs more information.';
      } else if (interrupt?.kind === 'confirm_action') {
        this.pendingConfirm = {
          kind: 'confirm_action',
          variant: interrupt.variant,
          actionSummary: interrupt.actionSummary,
          elementLabel: interrupt.elementLabel,
          pageUrl: interrupt.pageUrl,
          reason: interrupt.reason,
          targetDomain: interrupt.targetDomain,
        };
      } else if (interrupt?.kind === 'paused') {
        this.pauseReason = interrupt.reason ?? 'user';
      }

      this.startPauseDetachTimer();
      return null;
    }

    if (snapshot.next && snapshot.next.length > 0 && !this.runtime.control.stopRequested) {
      // Worker died mid-step without interrupt
      this.status = 'paused';
      this.pauseReason = this.runtime.control.pauseRequested ? 'user' : 'worker_restart';
      this.startPauseDetachTimer();
      return null;
    }

    this.status = snapshot.values?.runStatus ?? 'idle';
    return null;
  }

  // -------------------------------------------------------------------------------------------
  // Tab Sandboxing & Groups
  // -------------------------------------------------------------------------------------------

  async ensureScoutFoxGroup(tabId: number, explicitWindowId?: number): Promise<number | null> {
    if (!tabId || typeof chrome === 'undefined' || !chrome.tabs?.group) return null;

    try {
      const tab = await new Promise<chrome.tabs.Tab | null>((resolve) => {
        chrome.tabs.get(tabId, (t) => {
          lastRuntimeError();
          resolve(t ?? null);
        });
      });
      if (!tab) return null;

      const windowId = explicitWindowId ?? tab.windowId ?? this.windowId;
      const recordedGroupId = typeof windowId === 'number' ? this.scoutFoxGroupIds.get(windowId) : null;

      if (recordedGroupId && chrome.tabGroups?.get) {
        const activeGrp = await new Promise<chrome.tabGroups.TabGroup | null>((resolve) => {
          chrome.tabGroups.get(recordedGroupId, (g) => {
            lastRuntimeError();
            resolve(g ?? null);
          });
        });
        if (activeGrp && activeGrp.windowId === windowId) {
          if (tab.groupId === recordedGroupId) return recordedGroupId;
          await chrome.tabs.group({ tabIds: tabId, groupId: recordedGroupId });
          return recordedGroupId;
        }
      }

      const newGroupId = await chrome.tabs.group({ tabIds: tabId });
      if (typeof windowId === 'number') this.scoutFoxGroupIds.set(windowId, newGroupId);
      if (chrome.tabGroups?.update) {
        await chrome.tabGroups.update(newGroupId, { title: 'ScoutFox', color: 'orange' });
      }
      return newGroupId;
    } catch {
      return null;
    }
  }

  async waitForTabComplete(tabId: number, timeoutMs = 15000): Promise<void> {
    if (typeof chrome === 'undefined' || !chrome.tabs?.onUpdated) return;

    await new Promise<void>((resolve) => {
      let resolved = false;
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      }, timeoutMs);

      const listener = (tid: number, changeInfo: { status?: string }) => {
        if (tid === tabId && changeInfo.status === 'complete' && !resolved) {
          resolved = true;
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };

      chrome.tabs.onUpdated.addListener(listener);
    });
  }

  // -------------------------------------------------------------------------------------------
  // Pause Detach & Notifications
  // -------------------------------------------------------------------------------------------

  private startPauseDetachTimer(): void {
    this.clearPauseDetachTimer();
    this.pauseTimer = setTimeout(() => {
      void cdp.detachAll();
    }, 30 * 60 * 1000); // 30 minutes
  }

  private clearPauseDetachTimer(): void {
    if (this.pauseTimer) {
      clearTimeout(this.pauseTimer);
      this.pauseTimer = null;
    }
  }

  private notifyStateChange(): void {
    this.stateVersion++;
    if (this.onStateChangeCb) {
      try {
        this.onStateChangeCb(this.getState());
      } catch (err: any) {
        Logger.error('AgentRunner', `StateChange callback failed: ${err.message}`);
      }
    }
  }

  setStateChangeCallback(cb: (state: Record<string, any>) => void) {
    this.onStateChangeCb = cb;
  }

  setTabAdoptedCallback(cb: (tabId: number, windowId: number) => void) {
    this.onTabAdoptedCb = cb;
  }

  recordNetworkRequest(tabId: number, req: any) {
    if (!tabId || !req) return;
    if (!this.networkBuffers.has(tabId)) {
      this.networkBuffers.set(tabId, []);
    }
    const buf = this.networkBuffers.get(tabId)!;
    buf.push(req);
    if (buf.length > 100) buf.shift();
  }

  private async restoreState(): Promise<void> {
    try {
      const meta = await this.meta.read();
      if (!meta) return;

      if (this.dirty) return;

      this.stateVersion = meta.stateVersion;
      if (meta.scoutFoxGroupIds) {
        for (const [wId, gId] of meta.scoutFoxGroupIds) {
          this.scoutFoxGroupIds.set(wId, gId);
        }
      }

      const cfg = { configurable: { thread_id: this.threadId } };
      const snapshot = await this.graph.getState(cfg, { subgraphs: true });
      if (snapshot.values?.task) {
        this.currentTask = snapshot.values.task;
        this.history = snapshot.values.history ?? [];
        this.stepCount = snapshot.values.stepCount ?? 0;
        this.currentPhase = snapshot.values.phase ?? '';
        if (snapshot.values.findings) {
          this.findings = snapshot.values.findings;
        }
      }

      await this.deriveStatus(snapshot);
      if (this.status === 'paused') {
        this.runtime.resumedAfterRestart = true;
      }
    } catch {
      // Ignore restore error on cold boot
    }
  }

  dispose() {
    this.clearPauseDetachTimer();
    runtimeRegistry.delete(this.threadId);
  }

  static async forgetSession(tabId: number | string): Promise<void> {
    const threadId = String(tabId);
    const saver = new SessionStorageSaver();
    await saver.deleteThread(threadId).catch(() => {});
    if (typeof chrome !== 'undefined' && chrome.storage?.session?.remove) {
      await chrome.storage.session.remove([`runner_meta_${threadId}`, `action_journal_${threadId}`]).catch(() => {});
    }
  }
}
