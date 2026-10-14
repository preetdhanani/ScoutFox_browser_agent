// src/background/runner/AgentRunner.ts
// Runner that drives the LangGraph StateGraph engine.
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
import { BUILD_STAMP } from '../../shared/build.ts';
import { buildOrchestratorGraph } from '../graph/orchestrator.ts';
import { SessionStorageSaver } from '../checkpoint/SessionStorageSaver.ts';
import { SessionActionJournal } from './actionJournal.ts';
import { SessionRunnerMeta } from './runnerMeta.ts';
import { runtimeRegistry, type BrowserPort, type ExecResult, type LlmPort, type RunControl, type RunRuntime } from './runtimeRegistry.ts';
import { generateCompletion } from '../llm/index.ts';
import { inputDispatcher } from '../browser/input.ts';
import { cdp } from '../browser/cdp.ts';
import { lastRuntimeError } from '../browser/tabs.ts';
import { NetworkBuffers } from '../browser/network.ts';
import { ensureScoutFoxGroup, isTabInScope, groupIdForWindow } from '../browser/groups.ts';
import { openNewWindow } from '../browser/windows.ts';
import { takeSnapshot } from '../browser/snapshot.ts';
import { executeAction } from '../browser/execute.ts';
import { EvidenceLedger } from '../agent/evidence.ts';
import type { LedgerSnapshot } from '../agent/evidence.ts';
import { decideOnFailedAudit } from '../agent/finishPolicy.ts';
import type { GateContext, GateDecision } from '../agent/finishPolicy.ts';
import { previousTurnsSummary } from '../agent/previousTurns.ts';
import { compactLedgerSnapshot, finishedPlanStatuses, noteTypedText, withoutTypedText } from '../agent/planEvidence.ts';
import { goalSources } from '../agent/answerAudit.ts';
import type { Effect, EffortChoice, EffortProfile, HistoryEntry, Limits, PlanView, RunStats, RunStatus } from '../graph/state.ts';

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
  public autoApprovePlan = true; // Auto-approves plan during P4
  public autoConfirmAction = false; // Auto-confirms action during headless/mock tests
  public finishPolicy: (ctx: GateContext) => GateDecision = decideOnFailedAudit;
  public evidenceSnapshot: LedgerSnapshot = { v: 1, entries: [], visits: [] };
  public lastRefusedFinish: any = null;
  public finishSendBacks = 0;

  get evidence(): EvidenceLedger {
    const ledger = EvidenceLedger.fromSnapshot(this.evidenceSnapshot);
    const origRecord = ledger.record.bind(ledger);
    const origClear = ledger.clear.bind(ledger);
    ledger.record = (input) => {
      const res = origRecord(input);
      this.evidenceSnapshot = ledger.toSnapshot();
      return res;
    };
    ledger.clear = () => {
      origClear();
      this.evidenceSnapshot = ledger.toSnapshot();
    };
    return ledger;
  }

  noteTypedText(action: unknown): void {
    if (!action || typeof action !== 'object') return;
    if (!this.runtime.typedTexts) this.runtime.typedTexts = [];
    noteTypedText(action as any, this.runtime.typedTexts);
  }

  withoutTypedText(text: string): string {
    return withoutTypedText(text, this.runtime?.typedTexts ?? []);
  }

  private taskClaimed = false;
  // Tabs this session adopted via open_window. A tab whose ScoutFox grouping
  // failed must still be automatable by the session that opened it - without
  // this set the scope wall threw terminal out_of_scope on every snapshot
  // (BUG-39).
  private adoptedTabIds = new Set<number>();
  // A Stop/Pause that lands while a START_TASK claim is held (the tab pick is
  // still in flight). stop()/pause() cannot act on a run that has not started,
  // so they record the intent here and startTask honours it after its awaits
  // instead of silently eating it (BUG-34).
  private stopDuringClaim = false;
  private pauseDuringClaim = false;
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
    return groupIdForWindow(
      {
        windowId: this.windowId,
        groupIds: this.scoutFoxGroupIds,
        persist: () => void this.persistState(),
      },
      windowId
    );
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
        let systemPrompt = req.system;
        if (effectiveSettings.systemInstructions?.trim()) {
          systemPrompt = `${effectiveSettings.systemInstructions.trim()}\n\n${systemPrompt}`;
        }
        const text = await generateCompletion(effectiveSettings, chatMessages, systemPrompt, {
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
        return await takeSnapshot(tabId, opts, {
          isTabInScope: (id) => browser.isTabInScope(id),
          clearBadges: (id) => browser.clearBadges(id),
          sleep: (ms) => this.runtime?.clock ? this.runtime.clock.sleep(ms) : new Promise((r) => setTimeout(r, ms)),
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
        return await this.executeActionOnTab(tabId, action, opts);
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
        await this.waitForTabComplete(tabId, timeoutMs, control.stepSignal());
      },
      waitDomQuiet: async (tabId, quietMs, maxMs) => {
        if (typeof chrome === 'undefined' || !chrome.tabs?.sendMessage) return;
        await new Promise((resolve) => {
          chrome.tabs.sendMessage(tabId, { action: 'WAIT_DOM_QUIET', payload: { quietMs, maxWaitMs: maxMs } }, () => {
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
          // Only THIS session's tabs: the module-level cdp tracks every
          // session, and detaching all of them would yank other running
          // sessions' debuggers mid-run (BUG-33).
          const ids = Array.from(runtime.attachedTabIds ?? []);
          await Promise.allSettled(ids.map((tabId) => cdp.detach(tabId)));
        },
      },
      clearBadges: async (tabId) => {
        if (typeof chrome === 'undefined' || !chrome.tabs?.sendMessage) return;
        return new Promise<void>((resolve) => {
          chrome.tabs.sendMessage(tabId, { action: 'CLEAR_BADGES' }, () => {
            lastRuntimeError();
            resolve();
          });
        });
      },
      isTabInScope: async (tabId) => {
        if (tabId === this.ownerTabId && this.scoutFoxGroupIds.size === 0) {
          return true;
        }
        // A tab this session opened itself stays in scope even when its ScoutFox
        // grouping failed (chrome.tabs.group returned null): the old wall threw
        // terminal out_of_scope on every snapshot of the agent's own tab (BUG-39).
        if (this.adoptedTabIds.has(tabId)) {
          return true;
        }
        return await isTabInScope(
          {
            windowId: this.windowId,
            groupIds: this.scoutFoxGroupIds,
            persist: () => void this.persistState(),
          },
          tabId
        );
      },
    };

    const runtime: RunRuntime = {
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
        marker: () => (runtime as any)?._systemActionMarker ?? (this as any)._systemActionMarker ?? `${this.bootId}:${this.stepCount}`,
        read: (tabId: number, filter: any, includeBody: boolean, limit: number) =>
          this.networkBuffers.read(tabId, filter, includeBody, limit),
      },
      emit: {
        enterNode: (name: string) => {
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
        setPhase: (text: string) => {
          this.currentPhase = text;
          this.graphLocation.phase = text;
          this.notifyStateChange();
        },
      },
      clock: {
        now: () => Date.now(),
        sleep: async (ms: number, signal?: AbortSignal) => {
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
      finishPolicy: (ctx) => this.finishPolicy(ctx),
      typedTexts: [],
      navigatedFrom: null,
    };

    return runtime;
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
    if (!userPrompt || !userPrompt.trim()) {
      this.releaseTaskClaim();
      return { success: false, error: 'Cannot start empty prompt.' };
    }

    if (autoApprove !== undefined) {
      this.autoApprovePlan = autoApprove;
    }

    await this.restorePromise;
    await this.clearPromise;
    this.dirty = true;
    this.activeTabId = tabId;
    this.currentTask = userPrompt.trim();
    Logger.info('AgentRunner', `[START_TASK] Starting task on tab [${tabId}].`);
    Logger.info('AgentRunner', `[NEW_SESSION_RUN] Starting task on tab [${tabId}] (build ${BUILD_STAMP}): ${this.currentTask}`);

    await this.ensureScoutFoxGroup(tabId);

    // BUG-34: a Stop/Pause may have landed while the claim was held and the tab
    // pick was in flight. Honour it here instead of resetting the flags and
    // running anyway.
    const stopLandedDuringClaim = this.stopDuringClaim;
    const pauseLandedDuringClaim = this.pauseDuringClaim;
    this.stopDuringClaim = false;
    this.pauseDuringClaim = false;
    if (stopLandedDuringClaim) {
      this.releaseTaskClaim();
      this.status = 'stopped';
      this.pauseReason = null;
      this.currentTask = '';
      Logger.info('AgentRunner', '[START_TASK_CANCELLED] A stop landed while the task was being claimed; the task was not started.');
      this.notifyStateChange({ stopped: true });
      return { success: false, error: 'The task was stopped before it started.' };
    }

    this.status = 'running';
    // A reason from an earlier pause must not outlive that pause (the panel prints it under the status).
    this.pauseReason = null;
    this.stepCount = 0;
    this.lastRefusedFinish = null;
    this.finishSendBacks = 0;
    // BUG-35: a new task must not inherit the previous run's hold cards.
    this.clearHoldMirrors();
    // BUG-26: typed strings from the previous task must not be stripped from the
    // new task's evidence texts (the sidepanel sends START_TASK without
    // CLEAR_HISTORY).
    if (this.runtime) {
      this.runtime.typedTexts = [];
      this.runtime.navigatedFrom = null;
    }
    this.runtime.control.stopRequested = false;
    // A pause that landed during the claim starts the run paused: the drive's
    // first hold check picks the flag up (BUG-34).
    this.runtime.control.pauseRequested = pauseLandedDuringClaim === true;

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
      // A task is being claimed right now: record the pause so the run starts
      // paused instead of ignoring the request (BUG-34).
      if (this.taskClaimed) {
        this.pauseDuringClaim = true;
        Logger.info('AgentRunner', '[PAUSED] Pause landed while a task was being claimed; the task will start paused.');
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
    Logger.info('AgentRunner', '[PAUSED] Agent runner paused.');
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
    this.pendingQuestion = null;
    this.runtime.control.pauseRequested = false;
    Logger.info('AgentRunner', '[RESUMED] Agent runner resumed.');
    this.notifyStateChange({ resumed: true });

    void this.drive(new Command({ resume: { kind: 'resume' } }));
    return { success: true };
  }

  stop(): { success: boolean; error?: string } {
    if (this.status === 'idle' || this.status === 'stopped') {
      // A task is being claimed right now (the tab pick is still in flight):
      // record the stop so startTask cancels instead of running anyway (BUG-34).
      if (this.taskClaimed) {
        this.stopDuringClaim = true;
        Logger.info('AgentRunner', '[STOPPED] Stop landed while a task was being claimed; the task will not start.');
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
    // BUG-35: the hold mirrors must not survive a stop - the panel would render a
    // question/approval card under a "stopped" status, and the stale card carried
    // into the next task on the same tab. stop() still resumes a hold's interrupt
    // below; this only clears the runner's own fields.
    this.clearHoldMirrors();
    this.activeAbort?.abort({ scoutfox: 'user', reason: 'user_stop' });
    this.runtime.control.abortStep('user_stop');
    Logger.info('AgentRunner', '[STOPPED] Agent runner stopped.');
    this.notifyStateChange({ stopped: true });

    const targetTabId = this._activeTabId ?? this.ownerTabId;
    if (targetTabId) {
      void this.runtime?.browser?.clearBadges?.(targetTabId);
    }

    if (wasPaused) {
      // The hold's interrupt is still sitting in the checkpointer, so it must be resumed -
      // the graph already knows what to do with kind:'stop' (hold nodes route it to
      // end/finalize). The drive would otherwise die on executeDriveLoop's stopRequested
      // guard, and the pending interrupt would survive in the checkpoint: the restarted
      // worker would then resurrect this stopped run as 'paused' with the old question.
      void this.drive(new Command({ resume: { kind: 'stop' } }), { allowWhileStopped: true });
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
    this.pauseReason = null;
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
    this.pauseReason = null;
    this.notifyStateChange();

    // Deny on a revision hold (the add-domain card) is not an approval: the hold node turns it
    // into a continue on the existing plan without the added domain.
    const resume = decision?.decision === 'deny'
      ? { kind: 'deny_add' }
      : { kind: 'approve', ...decision };
    await this.drive(new Command({ resume }));
  }

  async confirmAction(decision: 'approve' | 'reject', remember?: 'site') {
    this.clearPauseDetachTimer();
    this.dirty = true;
    this.pendingConfirm = null;
    this.status = 'running';
    this.pauseReason = null;
    this.notifyStateChange();

    await this.drive(new Command({ resume: { kind: decision, remember } }));
  }

  /**
   * Resumes the graph after a security challenge / bot protection hold.
   * Dispatches 'resolved' (if user solved captcha) or 'skip' (to skip site).
   */
  async resolveChallenge(action: 'resolved' | 'skip') {
    this.clearPauseDetachTimer();
    this.dirty = true;
    this.pendingChallengeHelp = null;
    this.status = 'running';
    this.pauseReason = null;
    this.notifyStateChange();

    await this.drive(new Command({ resume: { kind: action } }));
  }

  /**
   * Resumes the graph after a soft-cap budget continuation hold.
   * Dispatches 'continue' with optional additional steps or 'finish' to end site exploration.
   */
  async continueBudget(action: 'continue' | 'finish', additionalSteps?: number) {
    this.clearPauseDetachTimer();
    this.dirty = true;
    this.pendingContinueBudget = null;
    this.status = 'running';
    this.pauseReason = null;
    this.notifyStateChange();

    await this.drive(new Command({ resume: { kind: action, additionalSteps } }));
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
    this.pendingApproval = null;
    this.pendingQuestion = null;
    this.pendingConfirm = null;
    this.pendingChallengeHelp = null;
    this.pendingContinueBudget = null;
    this.graphLocation = { phase: 'Starting' };
    this.evidenceSnapshot = { v: 1, entries: [], visits: [] };
    this.lastRefusedFinish = null;
    this.finishSendBacks = 0;
    if (this.runtime) {
      this.runtime.typedTexts = [];
      this.runtime.navigatedFrom = null;
    }
    void this.meta.clear();
    if (this.saver?.deleteThread) {
      this.clearPromise = this.saver.deleteThread(this.threadId)
        .then(() => {
          this.saver.revive(this.threadId);
        })
        .catch(() => {});
    }
    this.notifyStateChange();
  }

  previousTurnsSummary(): string[] {
    return previousTurnsSummary(this.history);
  }

  /**
   * Clears every pending-hold mirror the panel renders cards from. Used by
   * stop(), startTask() and clearHistory() so a hold never outlives the run it
   * belonged to (BUG-35).
   */
  private clearHoldMirrors(): void {
    this.pendingQuestion = null;
    this.pendingApproval = null;
    this.pendingConfirm = null;
    this.pendingChallengeHelp = null;
    this.pendingContinueBudget = null;
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
      findings: this.findings,
      // No `evidence` here on purpose (BUG-40): notifyStateChange spreads this
      // object into every STATE_UPDATE broadcast, which used to clone up to
      // 60 entries / 150k chars of ledger text over the port per stream chunk.
      // Nothing on the panel side reads it; consumers use `engine.evidence`.
    };
  }

  getStatus(): RunStatus {
    return this.status;
  }

  getHistory(): HistoryEntry[] {
    return this.history;
  }

  async persistState() {
    this.evidenceSnapshot = compactLedgerSnapshot(this.evidenceSnapshot);
    await this.meta.writeImmediate({
      stateVersion: this.stateVersion,
      scoutFoxGroupIds: Array.from(this.scoutFoxGroupIds.entries()),
      aliases: [],
      attachedTabIds: Array.from(this.runtime.attachedTabIds),
      pauseDetach: null,
      lastBeatAt: Date.now(),
      evidence: this.evidenceSnapshot.entries.length > 0 ? this.evidenceSnapshot : undefined,
    });
  }

  // -------------------------------------------------------------------------------------------
  // Single-Flight Graph Drive
  // -------------------------------------------------------------------------------------------

  private async drive(input: any, opts?: { allowWhileStopped?: boolean }): Promise<void> {
    if (this.currentDrive) {
      await this.currentDrive;
    }

    const drivePromise = this.executeDriveLoop(input, opts);
    this.currentDrive = drivePromise;
    try {
      await drivePromise;
    } finally {
      if (this.currentDrive === drivePromise) {
        this.currentDrive = null;
      }
    }
  }

  private async executeDriveLoop(initialInput: any, opts?: { allowWhileStopped?: boolean }): Promise<void> {
    let currentInput: any = initialInput;

    // opts.allowWhileStopped is true only for stop()'s own finalize resume: the run is already
    // marked stopped by then, and every router routes on state.ctl (which runsStopped into
    // finalize), so the loop deliberately bypasses the stopRequested guard for that one drive.
    while (currentInput !== null && (!this.runtime.control.stopRequested || opts?.allowWhileStopped)) {
      const inputToExecute = currentInput;
      currentInput = null;

      const autoResumeCommand = await this.executeDriveStep(inputToExecute);
      if (autoResumeCommand) {
        currentInput = autoResumeCommand;
      }
    }
  }

  /**
   * Mirrors one stream chunk (values mode, optionally from a subgraph) into the
   * runner's own state mirrors. Shared by the drive loop and the stop-time
   * resume so a stopped run ends with the same mirrors a finished one has.
   */
  private absorbStreamValues(ns: string[], values: any): void {
    if (ns.length === 0) {
      // Root orchestrator values
      if (values.task !== undefined) this.currentTask = values.task;
      if (values.stepCount !== undefined) this.stepCount = values.stepCount;
      if (values.history !== undefined) this.history = [...values.history];
      if (values.findings !== undefined) this.findings = values.findings;
      if (values.effort !== undefined) this.effort = values.effort;
      if (values.effortProfile !== undefined) this.effortProfile = values.effortProfile;
      if (values.runStats !== undefined) this.runStats = values.runStats;
      if (values.budget !== undefined) this.budget = values.budget;
      if (values.evidence !== undefined) this.evidenceSnapshot = values.evidence;
      if (values.lastRefusedFinish !== undefined) this.lastRefusedFinish = values.lastRefusedFinish;
      if (values.finishSendBacks !== undefined) this.finishSendBacks = values.finishSendBacks;
      const plan = values.planMeta ?? values.plan;
      if (plan?.sites) {
        this.planSteps = plan.sites.map((s: any) => {
          const rawSt = values.sites?.[s.id]?.status;
          const mappedSt = rawSt === 'running' ? 'in_progress' : rawSt === 'done' ? 'completed' : (rawSt ?? 'pending');
          return {
            id: s.id,
            text: plan?.source === 'fallback'
              ? s.name
              : (s.domain && !s.name?.toLowerCase().includes(s.domain.toLowerCase())
                ? `${s.name} (${s.domain}): ${s.goal}`
                : `${s.name}: ${s.goal}`),
            status: mappedSt,
          };
        });
      }
      if (values.siteIn?.site?.domain) {
        this.graphLocation.siteDomain = values.siteIn.site.domain;
      }
    } else {
      // Worker values
      if (values.evidenceBase && typeof values.evidenceBase === 'object') {
        // The worker folded its full ledger (prior sites + this site's events);
        // the raw event stream alone is capped and loses the earliest pages
        // (BUG-23). Events in the same chunk ride on top; the ledger dedupes.
        this.evidenceSnapshot = values.evidenceBase as LedgerSnapshot;
      }
      if (values.evidenceEvents && Array.isArray(values.evidenceEvents)) {
        const ledger = EvidenceLedger.fromSnapshot(this.evidenceSnapshot);
        for (const ev of values.evidenceEvents) {
          ledger.record(ev);
        }
        this.evidenceSnapshot = ledger.toSnapshot();
      }
      if (values.siteRun?.spec?.domain) {
        this.graphLocation.siteDomain = values.siteRun.spec.domain;
      }
      if (values.siteRun?.used !== undefined) {
        const base = values.siteIn?.stepBase ?? 0;
        this.stepCount = base + values.siteRun.used;
      }
      if (values.siteRun?.lastRefusedFinish) {
        this.lastRefusedFinish = values.siteRun.lastRefusedFinish;
      }
      if (values.siteRun?.finishSendBacks !== undefined) {
        this.finishSendBacks = values.siteRun.finishSendBacks;
      }
      if (values.history && Array.isArray(values.history)) {
        // Worker chunks re-deliver the site's full history channel, so the
        // mirror must skip entries it already holds. The old `type_step` key
        // collapsed distinct rows: every entry without a step shared one key
        // (a second user_answer in the same site was invisible) and two
        // same-type entries at the same step vanished too (BUG-38). Compare by
        // JSON identity instead - only a re-delivery of the SAME row matches.
        const seen = new Set(this.history.map((h) => JSON.stringify(h)));
        for (const entry of values.history) {
          const k = JSON.stringify(entry);
          if (!seen.has(k)) {
            seen.add(k);
            this.history = [...this.history, entry];
          }
        }
      }
    }
    if (this.history.length > 400) {
      this.history = this.history.slice(-400);
    }
    this.notifyStateChange();
  }

  private async executeDriveStep(input: any): Promise<Command | null> {
    // Whatever starts a drive (a task, a Resume, an answer, an approval) has just set the status to 'running'. A drive that
    // was still winding down (a Pause and a quick Resume) can write 'paused' AFTER that, from its own end-of-stream
    // snapshot, and this drive never wrote 'running' again: the panel then showed Resume for a run that was going on. This
    // drive is what runs now, so say so - unless a new Pause landed in between (its flag is set), or the run is stopping.
    if (this.status === 'paused' && !this.runtime.control.pauseRequested && !this.runtime.control.stopRequested) {
      this.status = 'running';
      this.pauseReason = null;
      this.notifyStateChange();
    }
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
        this.absorbStreamValues(ns, values);
      }
    } catch (err: any) {
      if (isGraphInterrupt(err)) {
        // Normal interrupt
      } else if (this.runtime.control.isUserAbort(err, runAbort.signal)) {
        if (this.runtime.control.stopRequested) {
          // B6: a user Stop in the middle of a site still runs the graph to its
          // stopped end. On resume the interrupted node re-runs against the
          // already-aborted step signal, every router sees ctl.stopRequested,
          // the worker ends and compile's stopped branch writes the
          // partial_result + endReason 'stopped' before finalize closes the
          // checkpoint with no pending task (a leftover pending task is what a
          // worker restart resurrected as paused). The aborted runAbort signal
          // must not leak into the resume config - both updateState and stream
          // would throw "Aborted" with it.
          try {
            const stopStream = await this.graph.stream(null, { ...cfg, signal: undefined });
            for await (const chunk of stopStream) {
              const [ns, values] = Array.isArray(chunk) ? chunk : [[], chunk];
              this.absorbStreamValues(ns, values);
            }
          } catch (stopErr: any) {
            Logger.warn('AgentRunner', `Failed to run compile on user stop: ${stopErr.message}`);
          }
        }
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
        this.status = 'error';
        this.planSteps = this.planSteps.map((step) =>
          step.status === 'in_progress' ? { ...step, status: 'failed' } : step
        );
        try {
          const snap = await this.graph.getState(cfg);
          if (snap.values?.history) {
            this.history = [...snap.values.history];
          } else {
            this.history = [...this.history, { type: 'error', content: `Execution Error: ${err.message}` }];
          }
        } catch {
          this.history = [...this.history, { type: 'error', content: `Execution Error: ${err.message}` }];
        }
        this.notifyStateChange({ error: err.message });
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

  /**
   * Reads the status of the run from a checkpoint snapshot, and returns the command that keeps the run going when the
   * hold it stands at is one the runner answers by itself (an auto-approved plan, an auto-confirmed action).
   *
   * `status` must not read 'paused' for a hold that nobody will ever see and that the runner answers itself: the panel
   * shows a Resume button for 'paused' with no card behind it, which is what a user reported ("it stops after every task
   * and I have to press Resume"). So the auto-resume cases are decided BEFORE anything is written to `status`.
   *
   * Two cases are never answered by the runner:
   *   - a Pause that is pending (`pauseRequested`): answering the hold again and again would loop for ever (the hold node
   *     shows the plan hold for every orchestrator pause, and the scheduler routes a pending pause back to it), with the
   *     status 'running' and Resume refused. The run is paused, for the user's reason.
    *   - a worker restart (`restoring`): it must not start a graph drive from the constructor, and the command would be
    *     dropped anyway. A restored FIRST plan hold has no card in the product, so it is left paused with the reason
    *     'worker_restart', and the user's Resume continues it (the hold node reads a plain resume on a plan hold as the
    *     approval). A restored revision hold keeps its add-domain card, and a restored confirmation is never
    *     auto-approved: the user decides.
   */
  private async deriveStatus(snapshot: StateSnapshot, opts: { restoring?: boolean } = {}): Promise<Command | null> {
    if (this.runtime.control.stopRequested) {
      this.status = 'stopped';
      return null;
    }

    // Check for interrupts across orchestrator and worker
    const allTasks = snapshot.tasks ?? [];
    const interruptedTask = allTasks.find((t) => t.interrupts && t.interrupts.length > 0);

    if (interruptedTask) {
      const interrupt = interruptedTask.interrupts[0]?.value as any;

      // approve_plan is answered by the runner only for the FIRST plan (version 1, no planPrev):
      // a revision hold grows the plan's scope, and a domain the model added on its own must be
      // approved by the user, never by the runner (replan-domain-auto-approved).
      const approvalPlanMeta = interrupt?.kind === 'approve_plan'
        ? (interrupt.planMeta ?? snapshot.values?.planMeta ?? snapshot.values?.plan)
        : null;
      const isFirstPlan = !approvalPlanMeta
        || approvalPlanMeta.version === 1
        || snapshot.values?.planPrev == null;

      const pausePending = this.runtime.control.pauseRequested;
      const autoAnswered = !pausePending && (
        (interrupt?.kind === 'approve_plan' && this.autoApprovePlan && isFirstPlan) ||
        (interrupt?.kind === 'confirm_action' && this.autoConfirmAction && !opts.restoring)
      );
      if (autoAnswered) {
        if (interrupt.kind === 'approve_plan') this.pendingApproval = null;
        else this.pendingConfirm = null;
        if (!opts.restoring) {
          this.status = 'running';
          this.pauseReason = null;
          return new Command({ resume: { kind: 'approve' } });
        }
        this.status = 'paused';
        this.pauseReason = 'worker_restart';
        this.startPauseDetachTimer();
        return null;
      }

      this.status = 'paused';

      if (interrupt?.kind === 'approve_plan') {
        // The runner would have approved this plan itself: the only reason it is paused is the user's pending Pause.
        if (this.autoApprovePlan && pausePending) this.pauseReason = 'user';
        const rootValues = snapshot.values ?? {};
        const planMeta = interrupt.planMeta ?? rootValues.planMeta ?? rootValues.plan;
        const approvedDomains: string[] = rootValues.approvedDomains ?? [];
        // The domains the revision adds over the approved set: what the add-domain card asks about.
        const addedDomains = (planMeta?.sites ?? [])
          .map((s: any) => s?.domain)
          .filter((d: any) => d && d !== 'this_page' && !approvedDomains.includes(d));
        this.pendingApproval = {
          kind: 'approve_plan',
          planMeta,
          budget: rootValues.budget,
          effortProfile: rootValues.effortProfile ?? this.effortProfile,
          budgetEstimate: interrupt.budgetEstimate,
          addedDomains,
          replanReason: rootValues.replan?.lastReason ?? null,
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
          detail: interrupt.detail,
        };
      } else if (interrupt?.kind === 'challenge_help') {
        this.pendingChallengeHelp = {
          kind: 'challenge_help',
          domain: interrupt.domain,
          url: interrupt.url,
          reason: interrupt.reason,
        };
      } else if (interrupt?.kind === 'continue_budget') {
        this.pendingContinueBudget = {
          kind: 'continue_budget',
          domain: interrupt.domain,
          stepsUsed: interrupt.stepsUsed,
          reserveBudget: interrupt.reserveBudget,
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

    if (snapshot.values?.budget !== undefined) {
      this.budget = snapshot.values.budget;
    }
    this.status = snapshot.values?.runStatus ?? 'idle';
    this.pauseReason = null; // not paused any more, so no reason to show
    if (this.status === 'idle' && this.planSteps.length > 0) {
      const ledger = EvidenceLedger.fromSnapshot(this.evidenceSnapshot);
      const planTexts = this.planSteps.map((s) => s.text);
      const finished = finishedPlanStatuses(planTexts, ledger, goalSources(this.currentTask || ''));
      this.planSteps = this.planSteps.map((step, idx) => ({ ...step, status: finished[idx] ?? step.status }));
    }
    return null;
  }

  // -------------------------------------------------------------------------------------------
  // Tab Sandboxing & Groups
  // -------------------------------------------------------------------------------------------

  async ensureScoutFoxGroup(tabId: number, explicitWindowId?: number): Promise<number | null> {
    return await ensureScoutFoxGroup(
      {
        windowId: this.windowId,
        groupIds: this.scoutFoxGroupIds,
        persist: () => void this.persistState(),
      },
      tabId,
      explicitWindowId
    );
  }

  async openNewWindow(url?: string) {
    return await openNewWindow(
      {
        adoptTab: (newTabId, winId) => {
          // This session deliberately took the tab over: it stays in scope even
          // if its ScoutFox grouping below fails (BUG-39).
          this.adoptedTabIds.add(newTabId);
          this.onTabAdoptedCb?.(newTabId, winId);
        },
        ensureGroup: async (newTabId, winId) => {
          return await this.ensureScoutFoxGroup(newTabId, winId);
        },
        setActiveTab: (newTabId) => {
          this.activeTabId = newTabId;
          this.notifyStateChange();
        },
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
      allowExecuteJs: settings?.allowExecuteJs === true,
    });
  }

  async waitForTabComplete(tabId: number, timeoutMs = 15000, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    if (typeof chrome === 'undefined' || !chrome.tabs?.onUpdated) return;

    // The load may already have finished before this listener exists (the navigation
    // completed while the action was still dispatching, and fakeChrome fires the
    // "complete" event inside the navigation call). Check the status first, then
    // listen, so an already complete tab never waits out the whole timer. The check
    // yields to the event loop once and reads again, so a navigation that starts right
    // after the action (fakeDom opens the page on the next timer tick) is not misread
    // as already finished while the tab still shows the old page.
    const readComplete = (): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        try {
          if (!chrome.tabs?.get) {
            resolve(false);
            return;
          }
          const maybePromise: any = (chrome.tabs.get as any)(tabId, (tab: chrome.tabs.Tab | undefined) => {
            resolve(!!tab && tab.status === 'complete');
          });
          if (maybePromise && typeof maybePromise.then === 'function') {
            maybePromise.then(
              (tab: chrome.tabs.Tab | undefined) => resolve(!!tab && tab.status === 'complete'),
              () => resolve(false)
            );
          }
        } catch (_) {
          resolve(false);
        }
      });

    const yieldMacro = () => new Promise<void>((r) => setTimeout(r, 0));

    if (await readComplete()) {
      await yieldMacro();
      if (await readComplete()) {
        return;
      }
    }
    if (signal?.aborted) return;

    await new Promise<void>((resolve) => {
      let resolved = false;
      const cleanup = () => {
        if (!resolved) {
          resolved = true;
          chrome.tabs.onUpdated.removeListener(listener);
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }
      };

      const timer = setTimeout(() => cleanup(), timeoutMs);

      const onAbort = () => {
        clearTimeout(timer);
        cleanup();
      };
      signal?.addEventListener('abort', onAbort);

      const listener = (tid: number, changeInfo: { status?: string }) => {
        if (tid === tabId && changeInfo.status === 'complete' && !resolved) {
          clearTimeout(timer);
          cleanup();
        }
      };

      chrome.tabs.onUpdated.addListener(listener);
    });
  }

  // -------------------------------------------------------------------------------------------
  // Pause Detach & Notifications
  // -------------------------------------------------------------------------------------------

  private startPauseDetachTimer(tabId?: number): void {
    if (tabId !== undefined) {
      this.clearPauseDetachTimer(tabId);
      cdp.startPauseTimer(tabId);
      return;
    }
    // No explicit tab: arm EVERY tab this session still has a debugger on.
    // Arming only the active tab left the debuggers on adopted tabs
    // (open_window) attached for the whole pause, keeping Chrome's "debugging"
    // bar up on them (BUG-42).
    this.clearPauseDetachTimer();
    const tabIds = new Set<number>(Array.from(this.runtime?.attachedTabIds ?? []));
    const fallback = this._activeTabId ?? this.ownerTabId;
    if (fallback) tabIds.add(fallback);
    for (const id of tabIds) {
      cdp.startPauseTimer(id);
    }
  }

  private clearPauseDetachTimer(tabId?: number): void {
    const targetTabId = tabId ?? this._activeTabId ?? this.ownerTabId;
    if (targetTabId) {
      cdp.clearPauseTimer(targetTabId);
    }
  }

  dispose(): void {
    this.clearPauseDetachTimer();
    // Detach only THIS session's tabs: cdp.detachAll() detaches every tab any
    // session ever attached, yanking other running sessions' debuggers when
    // one tab is closed (BUG-33).
    const ids = Array.from(this.runtime?.attachedTabIds ?? []);
    void Promise.allSettled(ids.map((tabId) => cdp.detach(tabId)));
    runtimeRegistry.delete(this.threadId);
  }

  private notifyStateChange(extraData: Record<string, any> = {}): void {
    this.stateVersion++;
    this.meta.scheduleWrite({
      stateVersion: this.stateVersion,
      scoutFoxGroupIds: Array.from(this.scoutFoxGroupIds.entries()),
      aliases: [],
      attachedTabIds: Array.from(this.runtime.attachedTabIds),
      pauseDetach: null,
      lastBeatAt: Date.now(),
    });
    if (this.onStateChangeCb) {
      try {
        this.onStateChangeCb({ ...this.getState(), ...extraData });
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
    const marker = this.runtime?.net?.marker ? this.runtime.net.marker() : `${this.bootId}:${this.stepCount}`;
    this.networkBuffers.record(tabId, req, marker);
  }

  readNetworkRequests(tabId: number, filter: any = {}, includeBody = true, limit = 10): string {
    return this.networkBuffers.read(tabId, filter, includeBody, limit);
  }

  private async restoreState(): Promise<void> {
    try {
      const meta = await this.meta.read();
      if (this.dirty) return;

      if (meta) {
        this.stateVersion = (meta.stateVersion ?? 0) + 1;
        if (meta.scoutFoxGroupIds) {
          for (const [wId, gId] of meta.scoutFoxGroupIds) {
            this.scoutFoxGroupIds.set(wId, gId);
          }
        }
      } else {
        this.stateVersion = 1;
      }

      const cfg = { configurable: { thread_id: this.threadId } };
      const snapshot = await this.graph.getState(cfg, { subgraphs: true });
      if (snapshot.values?.task) {
        this.currentTask = snapshot.values.task;
        this.history = snapshot.values.history ? [...snapshot.values.history] : [];
        this.stepCount = snapshot.values.stepCount ?? 0;
        this.currentPhase = snapshot.values.phase ?? '';
        if (snapshot.values.findings) {
          this.findings = snapshot.values.findings;
        }
        if (snapshot.values.evidence) {
          this.evidenceSnapshot = snapshot.values.evidence;
        }
      }
      if (meta?.evidence && this.evidenceSnapshot.entries.length === 0) {
        this.evidenceSnapshot = meta.evidence;
      }

      await this.deriveStatus(snapshot, { restoring: true });
      if (this.status === 'paused') {
        this.runtime.resumedAfterRestart = true;
      }
    } catch {
      // Ignore restore error on cold boot
    }
  }

  static async forgetSession(tabId: number | string): Promise<void> {
    const threadId = String(tabId);
    const saver = new SessionStorageSaver();
    await saver.deleteThread(threadId).catch(() => {});
    const meta = new SessionRunnerMeta(threadId);
    await meta.clear().catch(() => {});
    if (typeof chrome !== 'undefined' && chrome.storage?.session?.remove) {
      await chrome.storage.session.remove([`sf:meta:${threadId}`, `action_journal_${threadId}`, `runner_meta_${threadId}`]).catch(() => {});
    }
  }
}
