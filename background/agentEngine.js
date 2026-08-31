/**
 * AgentEngine for ScoutFox AI Agent
 * Orchestrates dynamic task-tailored plan generation, real action-driven checklist progress tracking,
 * tab completion waiting, viewport-aware page text body extraction, network request ring-buffer recording,
 * execute_js, read_network_requests, browser_batch orchestration, Few-Shot System Prompting,
 * and Universal Model Guardrails.
 */

import { ApiClients } from './apiClients.js';
import { Storage } from '../utils/storage.js';
import { Logger } from '../utils/logger.js';

/**
 * Safely read chrome.runtime.lastError. It MUST be read inside every chrome.* callback or
 * Chrome emits an "unchecked runtime.lastError" warning, but chrome.runtime itself is absent
 * in test and non-extension contexts — so a bare read would throw and swallow the callback.
 */
function lastRuntimeError() {
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError) {
      return chrome.runtime.lastError;
    }
  } catch (_) { /* context invalidated */ }
  return null;
}

/**
 * Explain why a URL cannot be automated, or return null if it can be.
 *
 * Chrome forbids extensions from injecting scripts into its own internal pages and the Web
 * Store, and no permission unlocks it — it is a hard browser restriction, not a bug and not
 * something a page reload fixes. Saying so plainly is the only useful response.
 */
function describeRestrictedUrl(url) {
  if (!url) {
    return 'That tab has not finished loading a page yet. Wait for it to load, then start the task again.';
  }
  if (/^chrome:\/\//i.test(url) || /^edge:\/\//i.test(url) || /^about:/i.test(url) || /^brave:\/\//i.test(url)) {
    return `ScoutFox cannot read ${url} — Chrome blocks all extensions from accessing its own internal pages, so no extension can automate this screen. Switch to a normal website tab (anything starting with http:// or https://) and start the task again.`;
  }
  if (/^chrome-extension:\/\//i.test(url) || /^moz-extension:\/\//i.test(url)) {
    return `ScoutFox cannot read ${url} — browsers block extensions from scripting other extensions' pages. Switch to a normal website tab and start the task again.`;
  }
  if (/^https:\/\/chromewebstore\.google\.com/i.test(url) || /^https:\/\/chrome\.google\.com\/webstore/i.test(url)) {
    return 'ScoutFox cannot read the Chrome Web Store — Chrome blocks extensions from scripting it. Switch to another site and start the task again.';
  }
  if (/^(file|view-source|devtools|data):/i.test(url)) {
    return `ScoutFox cannot read ${url.split(':')[0]}: pages. Switch to a normal website tab and start the task again.`;
  }
  return null;
}

export class AgentEngine {
  constructor() {
    this.status = 'idle'; // 'idle' | 'running' | 'paused' | 'stopped'
    this.currentTask = null;
    this.history = [];
    this.planSteps = [];
    this.stepCount = 0;
    this.activeTabId = null;
    this.currentPhase = '';
    this.isLoopActive = false;
    this.onStateChangeCallback = null;
    this.stateVersion = 0;
    this.recentActionSignatures = [];
    this.currentPlanIndex = 0;
    this.networkBuffers = new Map(); // tabId -> Array of Network Requests (capped at 100)
    this.scoutFoxGroupId = null; // Sandboxed Chrome Tab Group ID

    // Identifies THIS service-worker incarnation. MV3 terminates the worker aggressively
    // (idle timeout, memory pressure, Chrome's hard cap on port-based keepalive), and every
    // restart builds a brand-new AgentEngine with stateVersion back at 0. Without a boot id
    // the sidepanel cannot distinguish "an older, out-of-order message" from "the backend
    // restarted and its counter rewound", so it would silently discard every update forever.
    this.bootId = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `boot_${Date.now()}_${Math.floor(Math.random() * 1e9)}`;

    // Set by EVERY entry point that mutates engine state. restoreState() consults it after its
    // async storage read resolves: if anything has touched the engine in the meantime, the
    // snapshot on disk is already stale and applying it would silently undo the user's action.
    // startTask awaits restorePromise so it is ordered correctly, but clearHistory/pause/
    // resume/stop are synchronous message handlers that cannot — this flag covers them.
    this.dirty = false;

    // restoreState() is async. Anything that mutates engine state MUST await this first,
    // otherwise a late-landing storage read overwrites a task that has already started.
    this.restorePromise = this.restoreState();
  }

  async restoreState() {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
        Logger.info('AgentEngine', '[STATE_RESTORE] chrome.storage unavailable — starting from a clean engine state.');
        return;
      }

      const stored = await new Promise((resolve) => {
        chrome.storage.local.get(['agent_session'], (res) => {
          const err = lastRuntimeError();
          if (err) {
            Logger.warn('AgentEngine', '[STATE_RESTORE_FAILED] Could not read persisted session', err.message);
            resolve(null);
            return;
          }
          resolve(res && res.agent_session ? res.agent_session : null);
        });
      });

      // GUARD: a START_TASK message can cold-boot this worker and begin mutating state while
      // the storage read above is still in flight. Restoring here would wipe the live task's
      // history/plan and reset status to 'idle', leaving the loop dead and the panel showing
      // the PREVIOUS run's checklist. Callers await restorePromise, but keep this as a hard stop.
      if (this.isLoopActive || this.status === 'running' || this.dirty) {
        Logger.warn('AgentEngine', '[STATE_RESTORE_SKIPPED] The engine was modified while the persisted session was being read. Discarding the stale snapshot rather than clobbering live state.');
        return;
      }

      if (!stored) {
        Logger.info('AgentEngine', `[STATE_RESTORE] No persisted session found. Fresh engine (boot ${this.bootId.slice(0, 8)}).`);
        return;
      }

      this.history = stored.history || [];
      this.planSteps = stored.planSteps || [];
      this.currentTask = stored.task || null;
      this.stepCount = stored.stepCount || 0;
      this.currentPlanIndex = stored.currentPlanIndex || 0;
      this.activeTabId = stored.activeTabId || null;

      // Keep the version counter monotonic across worker restarts so the sidepanel's
      // out-of-order guard still holds even within a single boot.
      this.stateVersion = (stored.stateVersion || 0) + 1;

      if (stored.status === 'running' || stored.status === 'paused') {
        // The loop that owned this status died with the previous worker. Never silently
        // pretend it finished — surface it in the timeline AND the logs.
        this.status = 'idle';
        this.currentPhase = '';
        this.history.push({
          type: 'error',
          content: `Previous task was interrupted — Chrome shut down the extension's background worker mid-run (this happens after ~30s idle or when the browser reclaims memory). Progress up to step ${this.stepCount} is preserved above. Re-run the task to continue.`
        });
        Logger.warn('AgentEngine', `[STATE_RESTORE_INTERRUPTED] Recovered a session that was still marked "${stored.status}" at step ${this.stepCount}. The execution loop did not survive the worker restart; status forced to idle and the interruption surfaced to the user.`);
      } else {
        this.status = stored.status || 'idle';
        Logger.info('AgentEngine', `[STATE_RESTORE] Restored session "${this.currentTask || 'none'}" (status=${this.status}, step=${this.stepCount}, ${this.history.length} history entries, boot ${this.bootId.slice(0, 8)}).`);
      }

      this.notifyStateChange();
    } catch (e) {
      Logger.error('AgentEngine', '[STATE_RESTORE_ERROR] Unexpected failure restoring persisted session', e);
    }
  }

  async persistState() {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({
          agent_session: {
            history: this.history,
            planSteps: this.planSteps,
            task: this.currentTask,
            stepCount: this.stepCount,
            status: this.status,
            currentPlanIndex: this.currentPlanIndex,
            activeTabId: this.activeTabId,
            stateVersion: this.stateVersion
          }
        }, () => {
          const err = lastRuntimeError();
          if (err) {
            Logger.warn('AgentEngine', '[STATE_PERSIST_FAILED] Could not write session to storage', err.message);
          }
        });
      }
    } catch (e) {
      Logger.warn('AgentEngine', '[STATE_PERSIST_ERROR] Could not persist state', e);
    }
  }

  clearHistory() {
    this.dirty = true;
    this.turnIndex = 0;
    this.history = [];
    this.planSteps = [];
    this.stepCount = 0;
    this.currentPlanIndex = 0;
    this.currentTask = null;
    this.notifyStateChange();
    Logger.info('AgentEngine', '[CLEAR_HISTORY] Task history and plan cleared.');
  }

  /**
   * Cap total history. Sessions are multi-turn now and would otherwise grow without bound,
   * and the whole array is serialised to chrome.storage on every state change.
   */
  trimHistory(max = 400) {
    if (this.history.length > max) {
      this.history.splice(0, this.history.length - max);
    }
  }

  /** Entries belonging to the current turn: everything from the most recent user_goal on. */
  currentTurnHistory() {
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].type === 'user_goal') return this.history.slice(i);
    }
    return this.history;
  }

  /**
   * Compact recap of earlier COMPLETED turns, so a follow-up has context without replaying
   * every step of every previous task into the prompt.
   */
  previousTurnsSummary(limit = 4) {
    const lines = [];
    let goal = null;
    for (const item of this.history) {
      if (item.type === 'user_goal') {
        goal = item.prompt;
      } else if (item.type === 'finish' && goal) {
        const answer = String(item.answer || '').replace(/\s+/g, ' ').slice(0, 280);
        lines.push(`- Asked: "${goal}"\n  Result: ${answer}`);
        goal = null;
      }
    }
    return lines.slice(-limit);
  }

  setStateChangeCallback(cb) {
    this.onStateChangeCallback = cb;
  }

  notifyStateChange(extraData = {}) {
    this.stateVersion++;
    this.persistState();
    if (this.onStateChangeCallback) {
      try {
        this.onStateChangeCallback({
          status: this.status,
          stepCount: this.stepCount,
          task: this.currentTask,
          history: this.history,
          planSteps: this.planSteps,
          currentPhase: this.currentPhase,
          // Deliberately NOT sending Logger.getLogsHistory() here. setPhase() calls this
          // ~7 times per loop iteration, and shipping the whole 300-entry ring (which holds
          // full [LLM_RAW_OUTPUT] bodies) meant several hundred KB structure-cloned across
          // the port per step. Logs already stream incrementally via LOG_ENTRY; the panel
          // only needs the bulk array on an explicit GET_AGENT_STATE resync.
          stateVersion: this.stateVersion,
          bootId: this.bootId,
          scoutFoxGroupId: this.scoutFoxGroupId,
          ...extraData
        });
      } catch (err) {
        console.error('[AgentEngine] notifyStateChange callback threw', err);
      }
    }
  }

  /**
   * Ensures target tab and all agent automation tabs are sandboxed into a 'ScoutFox' Chrome Tab Group
   */
  async ensureScoutFoxGroup(tabId) {
    if (!tabId || typeof chrome === 'undefined' || !chrome.tabs || !chrome.tabs.group) return null;

    try {
      const tab = await new Promise((resolve) => {
        chrome.tabs.get(tabId, (t) => {
          lastRuntimeError();
          resolve(t);
        });
      });

      if (!tab) return null;

      let groupId = tab.groupId;
      const TAB_GROUP_ID_NONE = typeof chrome.tabGroups !== 'undefined' && chrome.tabGroups.TAB_GROUP_ID_NONE !== undefined
        ? chrome.tabGroups.TAB_GROUP_ID_NONE
        : -1;

      let needsGroup = false;

      if (groupId && groupId !== TAB_GROUP_ID_NONE) {
        if (chrome.tabGroups && chrome.tabGroups.get) {
          const grp = await new Promise((resolve) => {
            chrome.tabGroups.get(groupId, (g) => {
              lastRuntimeError();
              resolve(g);
            });
          });
          if (!grp || grp.title !== 'ScoutFox') {
            needsGroup = true;
          }
        }
      } else {
        needsGroup = true;
      }

      if (needsGroup) {
        groupId = await new Promise((resolve) => {
          chrome.tabs.group({ tabIds: tabId }, (newId) => {
            lastRuntimeError();
            resolve(newId);
          });
        });

        if (groupId && chrome.tabGroups && chrome.tabGroups.update) {
          await new Promise((resolve) => {
            chrome.tabGroups.update(groupId, { title: 'ScoutFox', color: 'orange' }, () => {
              lastRuntimeError();
              resolve();
            });
          });
        }
      }

      this.scoutFoxGroupId = groupId;
      Logger.info('AgentEngine', `[TAB_SANDBOX] Active task sandboxed inside 'ScoutFox' tab group (GroupID: ${groupId})`);
      return groupId;
    } catch (err) {
      Logger.warn('AgentEngine', '[TAB_SANDBOX_WARN] Could not sandbox tab into ScoutFox group', err.message);
      return null;
    }
  }

  setPhase(phaseText) {
    this.currentPhase = phaseText;
    this.notifyStateChange();
  }

  /**
   * Record network request into tab ring buffer (capacity 100)
   */
  recordNetworkRequest(tabId, req) {
    if (!tabId || !req) return;
    if (!this.networkBuffers.has(tabId)) {
      this.networkBuffers.set(tabId, []);
    }
    const buf = this.networkBuffers.get(tabId);
    req.actionMarkerIndex = this.stepCount;
    buf.push(req);
    
    if (buf.length > 100) {
      buf.shift();
    }
  }

  /**
   * Read recent network activity with filtering & sensitive key redaction
   */
  readNetworkRequests(tabId, filter = {}, includeBody = true, limit = 10) {
    const buf = this.networkBuffers.get(tabId) || [];
    let requests = [...buf];

    if (filter.status === 'error') {
      requests = requests.filter(r => !r.ok || r.status >= 400 || r.error);
    } else if (filter.status === 'success') {
      requests = requests.filter(r => r.ok && r.status < 400);
    }

    if (filter.since === 'last_action') {
      const lastStep = Math.max(1, this.stepCount - 1);
      requests = requests.filter(r => r.actionMarkerIndex >= lastStep);
    }

    if (filter.urlContains) {
      const term = filter.urlContains.toLowerCase();
      requests = requests.filter(r => r.url.toLowerCase().includes(term));
    }

    const finalSlice = requests.slice(-Math.min(limit, 50));

    if (finalSlice.length === 0) {
      return '(No network requests captured matching filter criteria)';
    }

    const textLines = finalSlice.map(req => {
      const relativeUrl = req.url.length > 80 ? req.url.slice(0, 80) + '...' : req.url;
      let line = `[${req.method}] ${relativeUrl} → ${req.status || 'ERR'} (${req.durationMs}ms)`;
      if (req.error) line += ` [Error: ${req.error}]`;

      if (includeBody) {
        if (req.reqBody) {
          const redactedReq = this.redactSensitiveData(req.reqBody);
          line += `\n  req:  ${redactedReq.length > 500 ? redactedReq.slice(0, 500) + '...' : redactedReq}`;
        }
        if (req.respBody) {
          const redactedResp = this.redactSensitiveData(req.respBody);
          line += `\n  resp: ${redactedResp.length > 500 ? redactedResp.slice(0, 500) + '...' : redactedResp}`;
        }
      }
      return line;
    });

    return textLines.join('\n\n');
  }

  redactSensitiveData(data) {
    if (!data) return data;
    const sensitiveKeys = ['password', 'token', 'authorization', 'cookie', 'secret', 'apikey', 'ssn', 'card', 'cvv'];
    
    if (typeof data === 'string') {
      try {
        const parsed = JSON.parse(data);
        const redacted = this.redactObject(parsed, sensitiveKeys);
        return JSON.stringify(redacted);
      } catch (_) {
        let str = data;
        sensitiveKeys.forEach(key => {
          const regex = new RegExp(`("${key}"\\s*:\\s*")([^"]+)(")`, 'gi');
          str = str.replace(regex, '$1[REDACTED]$3');
        });
        return str;
      }
    }
    if (typeof data === 'object') {
      return this.redactObject(data, sensitiveKeys);
    }
    return data;
  }

  redactObject(obj, sensitiveKeys) {
    if (!obj || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(item => this.redactObject(item, sensitiveKeys));
    
    const copy = {};
    for (const [k, v] of Object.entries(obj)) {
      const isSensitive = sensitiveKeys.some(s => k.toLowerCase().includes(s));
      if (isSensitive) {
        copy[k] = '[REDACTED]';
      } else if (v && typeof v === 'object') {
        copy[k] = this.redactObject(v, sensitiveKeys);
      } else {
        copy[k] = v;
      }
    }
    return copy;
  }

  /**
   * Tool 1: execute_js in MAIN or ISOLATED world with 5s timeout, CSP fallback, and truncation
   */
  async executeJs(tabId, code, world = 'MAIN') {
    const timeoutMs = 5000;
    const startTime = Date.now();

    const executeWork = async (targetWorld) => {
      const [inj] = await chrome.scripting.executeScript({
        target: { tabId },
        world: targetWorld,
        func: (src) => {
          // eslint-disable-next-line no-new-func
          const fn = new Function(`return (async () => { ${src} })()`);
          return fn();
        },
        args: [code]
      });
      return inj ? inj.result : undefined;
    };

    const serializeResult = (val) => {
      if (val === undefined) return 'undefined';
      if (val === null) return 'null';
      if (typeof val === 'number' || typeof val === 'boolean' || typeof val === 'string') {
        return val;
      }
      try {
        const json = JSON.stringify(val, (key, value) => {
          if (value && value.nodeType === 1) { // Element node
            return {
              tag: value.tagName ? value.tagName.toLowerCase() : '',
              id: value.id || '',
              className: value.className || '',
              textContent: (value.textContent || '').slice(0, 200)
            };
          }
          return value;
        });
        return json || String(val);
      } catch (_) {
        return String(val);
      }
    };

    try {
      const resultPromise = (async () => {
        let rawVal;
        let usedWorld = world;
        try {
          rawVal = await executeWork(world);
        } catch (err) {
          if (world === 'MAIN' && (err.message.includes('EvalError') || err.message.includes('CSP') || err.message.includes('unsafe-eval'))) {
            usedWorld = 'ISOLATED';
            rawVal = await executeWork('ISOLATED');
          } else if (err.message.includes('Frame with ID') && err.message.includes('removed')) {
            return { ok: true, result: 'navigation triggered', durationMs: Date.now() - startTime };
          } else {
            throw err;
          }
        }

        let serialized = serializeResult(rawVal);
        let truncated = false;
        if (typeof serialized === 'string' && serialized.length > 2000) {
          const origLen = serialized.length;
          serialized = serialized.slice(0, 2000) + `…[${origLen - 2000} more chars]`;
          truncated = true;
        }

        return {
          ok: true,
          result: serialized,
          world: usedWorld,
          truncated,
          durationMs: Date.now() - startTime
        };
      })();

      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('execute_js timed out after 5000ms')), timeoutMs);
      });

      const res = await Promise.race([resultPromise, timeoutPromise]);
      return { success: res.ok, message: res.ok ? `Result: ${res.result}` : res.error, ...res };
    } catch (err) {
      return {
        success: false,
        ok: false,
        error: err.message,
        durationMs: Date.now() - startTime
      };
    }
  }

  async startTask(userPrompt, tabId) {
    if (!userPrompt || !userPrompt.trim()) {
      Logger.warn('AgentEngine', '[START_TASK_REJECTED] Ignoring empty task prompt.');
      return;
    }

    // A START_TASK message is what cold-boots this worker in the common case, so the
    // constructor's persisted-session read is almost always still in flight right now.
    // Let it land and be applied FIRST, then overwrite it deliberately below. Skipping this
    // await is what caused tasks to silently die with the previous run's checklist on screen.
    try {
      await this.restorePromise;
    } catch (err) {
      Logger.warn('AgentEngine', '[START_TASK] Session restore failed; continuing with a clean state', err);
    }

    Logger.info('AgentEngine', `[START_TASK] Starting task on tab [${tabId}]: "${userPrompt.trim()}"`);

    this.dirty = true;
    this.status = 'running';
    this.currentTask = userPrompt.trim();

    // History is NOT cleared here. Each task appends a new turn to the same session, so a
    // follow-up like "now add it to the cart" still knows what "it" refers to. Only the
    // New Session button (clearHistory) starts over.
    this.turnIndex = (this.turnIndex || 0) + 1;
    this.recentActionSignatures = [];
    this.stepCount = 0;
    this.currentPlanIndex = 0;
    this.planSteps = [];
    this.activeTabId = tabId;
    this.isLoopActive = true;
    this.abortController = new AbortController();

    // Sandbox automation inside 'ScoutFox' Chrome Tab Group
    await this.ensureScoutFoxGroup(tabId);

    this.history.push({
      type: 'user_goal',
      turn: this.turnIndex,
      prompt: userPrompt.trim(),
      timestamp: new Date().toLocaleTimeString()
    });
    this.trimHistory();

    const settings = await Storage.getSettings();

    this.setPhase('📋 Generating dynamic execution plan checklist...');
    await this.generatePlan(userPrompt, settings);

    this.notifyStateChange();
    await this.runLoop();
  }

  async generatePlan(userPrompt, settings) {
    const isSummarizeTask = /summarize|summary|readme|overview|describe|explain|read/i.test(userPrompt);

    const planPrompt = `Task: "${userPrompt}"
Generate a concise, efficient execution plan tailored specifically for this web browsing task.
Output ONLY a raw JSON array of short sub-goal action strings.

${isSummarizeTask ? `For reading/summarization tasks, keep the plan short (2 steps max) so the agent finishes immediately without scrolling loops:
["Analyze visible documentation text on page", "Synthesize concise summary"]` : `Example for multi-step task:
["Identify target form or section", "Execute required browser actions", "Verify result and complete task"]`}`;

    try {
      const resp = await ApiClients.generateCompletion(settings, [{ role: 'user', content: planPrompt }], 'You are a web task planner.');
      
      let planArray = [];
      const match = resp.match(/\[[\s\S]*\]/);
      if (match) {
        planArray = JSON.parse(match[0]);
      }

      if (Array.isArray(planArray) && planArray.length > 0) {
        this.planSteps = planArray.map((text, idx) => ({
          id: idx + 1,
          text: String(text).replace(/^Step \d+:?/i, '').trim(),
          status: idx === 0 ? 'in_progress' : 'pending'
        }));
        Logger.info('AgentEngine', `[PLANNER_DYNAMIC] Generated dynamic plan checklist with ${this.planSteps.length} sub-goals`, this.planSteps);
      } else {
        throw new Error('Could not parse plan array');
      }
    } catch (err) {
      Logger.warn('AgentEngine', '[PLANNER_FALLBACK] Using dynamic fallback checklist for task', err.message);
      this.planSteps = isSummarizeTask ? [
        { id: 1, text: 'Analyze visible documentation text on page', status: 'in_progress' },
        { id: 2, text: 'Synthesize concise summary', status: 'pending' }
      ] : [
        { id: 1, text: `Analyze page state for "${this.currentTask}"`, status: 'in_progress' },
        { id: 2, text: 'Execute targeted web actions & navigate', status: 'pending' },
        { id: 3, text: 'Extract relevant information & synthesize answer', status: 'pending' }
      ];
    }
  }

  updatePlanProgress(lastActionObj = null, isFinished = false) {
    if (!this.planSteps || this.planSteps.length === 0) return;

    if (isFinished) {
      this.planSteps.forEach(step => step.status = 'completed');
      this.currentPlanIndex = this.planSteps.length;
      this.notifyStateChange();
      return;
    }

    if (lastActionObj) {
      const totalSteps = this.planSteps.length;
      if (this.currentPlanIndex < totalSteps - 1) {
        if (lastActionObj.action === 'navigate' || lastActionObj.action === 'type' || lastActionObj.action === 'browser_batch' || (lastActionObj.action === 'click' && this.stepCount > 1)) {
          const advanceCount = (lastActionObj.action === 'browser_batch' && lastActionObj.completed) ? Math.min(2, lastActionObj.completed) : 1;
          this.currentPlanIndex = Math.min(totalSteps - 1, this.currentPlanIndex + advanceCount);
        }
      }
    }

    this.planSteps.forEach((step, idx) => {
      if (idx < this.currentPlanIndex) {
        step.status = 'completed';
      } else if (idx === this.currentPlanIndex) {
        step.status = 'in_progress';
      } else {
        step.status = 'pending';
      }
    });

    this.notifyStateChange();
  }

  /**
   * Cancel whatever the loop is currently blocked on. Without this, pause/stop only flip a
   * flag that is read once per iteration — so a Stop pressed during a 60s LLM call would let
   * the loop wake up afterwards and still drive a real click into the user's page.
   */
  abortInFlight(reason) {
    if (this.abortController && !this.abortController.signal.aborted) {
      try {
        this.abortController.abort();
        Logger.info('AgentEngine', `[ABORT_IN_FLIGHT] Cancelled the in-flight request (${reason}).`);
      } catch (err) {
        Logger.warn('AgentEngine', '[ABORT_FAILED] Could not abort the in-flight request', err);
      }
    }
  }

  pause() {
    this.dirty = true;
    if (this.status !== 'running') {
      Logger.warn('AgentEngine', `[PAUSE_IGNORED] Pause requested while status is "${this.status}" — nothing to pause.`);
      return { success: false, error: `Cannot pause: the agent is ${this.status}, not running.` };
    }
    this.status = 'paused';
    this.abortInFlight('paused by user');
    this.setPhase('Task paused by user');
    Logger.info('AgentEngine', '[PAUSED] Task paused by user.');
    return { success: true };
  }

  resume() {
    this.dirty = true;
    if (this.status !== 'paused') {
      // restoreState deliberately converts a persisted 'paused' back to 'idle' after a worker
      // restart, so Resume can legitimately find nothing to resume. Say so instead of
      // answering success and doing nothing.
      Logger.warn('AgentEngine', `[RESUME_IGNORED] Resume requested while status is "${this.status}". The paused task did not survive; re-run it to continue.`);
      return { success: false, error: `Cannot resume: the agent is ${this.status}. The paused task did not survive a background restart — please re-run it.` };
    }
    this.status = 'running';
    this.abortController = new AbortController();
    this.setPhase('Resuming task...');
    Logger.info('AgentEngine', '[RESUMED] Task resumed by user.');
    this.runLoop().catch((err) => {
      Logger.error('AgentEngine', '[RESUME_ERROR] Uncaught exception resuming loop', err);
    });
    return { success: true };
  }

  stop() {
    this.dirty = true;
    this.status = 'stopped';
    this.isLoopActive = false;
    this.currentPhase = '';
    this.abortInFlight('stopped by user');
    Logger.info('AgentEngine', '[STOPPED] Task stopped by user.');
    this.notifyStateChange({ message: 'Task stopped.' });
    return { success: true };
  }

  async runLoop() {
    try {
      await this.runLoopBody();
    } catch (err) {
      Logger.error('AgentEngine', '[LOOP_ERROR] Unhandled exception in execution loop', err);
      this.history.push({
        type: 'error',
        content: `Execution Error: ${err.message}`
      });
      this.notifyStateChange({ error: err.message });
    } finally {
      this.isLoopActive = false;
      if (this.status === 'running') {
        Logger.warn('AgentEngine', '[LOOP_SAFETY_NET] Loop exited while still marked running — forcing status to idle.');
        this.status = 'idle';
        this.currentPhase = '';
        this.notifyStateChange();
      }
    }
  }

  async runLoopBody() {
    const settings = await Storage.getSettings();
    const maxSteps = settings.maxSteps || 25;
    this.isLoopActive = true;

    while (this.status === 'running' && this.stepCount < maxSteps) {
      this.stepCount++;
      Logger.info('AgentEngine', `---------------- STEP ${this.stepCount}/${maxSteps} ----------------`);

      // 1. DOM Extraction Input
      this.setPhase(`🌐 Step ${this.stepCount}/${maxSteps}: Reading webpage elements & text body...`);

      let domSnapshot;
      try {
        domSnapshot = await this.getTabDOMWithAutoInject(this.activeTabId, settings.showElementBadges);
        Logger.info('AgentEngine', `[DOM_SNAPSHOT_INPUT] Title: "${domSnapshot.title}" | URL: ${domSnapshot.url} | Elements: ${domSnapshot.elementCount} | PageTextLen: ${domSnapshot.pageText ? domSnapshot.pageText.length : 0}`);
      } catch (err) {
        Logger.error('AgentEngine', '[DOM_ERROR] Failed to read page state', err);
        this.history.push({
          step: this.stepCount,
          type: 'error',
          content: `${err.message}`
        });
        this.status = 'idle';
        this.isLoopActive = false;
        this.currentPhase = '';
        this.notifyStateChange({ error: err.message });
        break;
      }

      const systemPrompt = this.buildSystemPrompt(settings.systemInstructions);
      let userMessage = this.buildStepMessage(domSnapshot);

      // Universal Guardrail: Anti-Stuck Loop Detection & Auto-Inject Network Errors
      if (this.recentActionSignatures.length >= 2) {
        const last1 = this.recentActionSignatures[this.recentActionSignatures.length - 1];
        const last2 = this.recentActionSignatures[this.recentActionSignatures.length - 2];
        if (last1 === last2 && !last1.includes('finish') && !last1.includes('scroll')) {
          userMessage += `\n\n[ANTI-STUCK GUARDRAIL WARNING]: You executed the exact same action ("${last1}") twice in a row. If the page did not update, DO NOT repeat it again. Choose a different element, type a new query, or scroll down.`;
          
          const netErrors = this.readNetworkRequests(this.activeTabId, { status: 'error', since: 'last_action' }, true, 5);
          if (netErrors && !netErrors.includes('(No network requests')) {
            userMessage += `\n\n[RECENT FAILED NETWORK REQUESTS]:\n${netErrors}`;
            Logger.info('AgentEngine', '[GUARDRAIL_NET_AUTO_INJECT] Auto-injected recent network request errors into user prompt.');
          }
        }
      }

      this.history.push({
        step: this.stepCount,
        type: 'step_start',
        url: domSnapshot.url,
        pageTitle: domSnapshot.title,
        elementCount: domSnapshot.elementCount
      });

      this.notifyStateChange();

      // 2. LLM Call Input & Output
      const providerName = settings.provider === 'ollama' ? `Ollama (${settings.model})` : settings.model;
      this.setPhase(`🧠 Step ${this.stepCount}/${maxSteps}: Thinking via [${providerName}]...`);

      let responseText = '';
      try {
        const messages = this.formatMessagesForLLM(userMessage);
        responseText = await ApiClients.generateCompletion(settings, messages, systemPrompt, {
          signal: this.abortController ? this.abortController.signal : null
        });
        Logger.info('AgentEngine', `[LLM_RAW_OUTPUT]\n${responseText}`);
      } catch (err) {
        Logger.error('AgentEngine', '[LLM_API_ERROR] Connection failure', err);
        this.history.push({
          step: this.stepCount,
          type: 'error',
          content: `LLM Connection Error (${settings.provider}): ${err.message}`
        });
        this.status = 'idle';
        this.isLoopActive = false;
        this.currentPhase = '';
        this.notifyStateChange({ error: err.message });
        return;
      }

      // 3. Action Parsing with Universal Guardrails
      this.setPhase(`🔍 Step ${this.stepCount}/${maxSteps}: Parsing action...`);
      const actionResult = this.parseResponse(responseText, domSnapshot.elementCount);

      this.history.push({
        step: this.stepCount,
        type: 'agent_response',
        thought: actionResult.thought || '',
        action: actionResult.action || null,
        rawResponse: responseText
      });

      if (actionResult.error) {
        Logger.warn('AgentEngine', `[PARSE_ERROR] Step ${this.stepCount} parsing failed`, actionResult.error);
        this.history.push({
          step: this.stepCount,
          type: 'execution_result',
          success: false,
          error: actionResult.error
        });
        this.notifyStateChange();
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }

      const actionObj = actionResult.action;
      
      const signature = `${actionObj.action}_${actionObj.element_id || ''}_${actionObj.text || ''}_${actionObj.url || ''}`;
      this.recentActionSignatures.push(signature);
      if (this.recentActionSignatures.length > 5) this.recentActionSignatures.shift();

      Logger.info('AgentEngine', `[ACTION_DISPATCH] Executing [${actionObj.action}]`, actionObj);

      if (actionObj.action === 'finish') {
        this.status = 'idle';
        this.isLoopActive = false;
        this.currentPhase = '';
        this.updatePlanProgress(null, true);
        this.history.push({
          type: 'finish',
          answer: actionObj.answer || 'Task completed successfully.'
        });
        Logger.info('AgentEngine', '[TASK_FINISHED] Task completed successfully.');
        this.notifyStateChange();
        break;
      }

      if (actionObj.action === 'ask_user') {
        this.status = 'paused';
        this.setPhase('Waiting for user input');
        Logger.info('AgentEngine', '[ASK_USER] Waiting for user input.');
        this.notifyStateChange({ question: actionObj.question });
        break;
      }

      // 4. Action Execution on Web Page
      // Last checkpoint before we touch the user's page. The status is only tested once per
      // iteration, at the top of the while loop — but Pause/Stop can land at any moment during
      // the seconds spent in the LLM call above. Without this re-check, a Stop pressed mid-think
      // flips the UI to "Stopped" and then still fires a real click into the page.
      if (this.status !== 'running') {
        Logger.warn('AgentEngine', `[ABORTED_MIDSTEP] Status changed to "${this.status}" during step ${this.stepCount}. Discarding the pending [${actionObj.action}] instead of executing it.`);
        this.history.push({
          step: this.stepCount,
          type: 'execution_result',
          success: false,
          error: `Action [${actionObj.action}] was discarded because the task was ${this.status}.`
        });
        this.notifyStateChange();
        break;
      }

      this.setPhase(`⚡ Step ${this.stepCount}/${maxSteps}: Executing ${formatActionSummary(actionObj)}...`);

      try {
        const execResult = await this.executeActionOnTab(this.activeTabId, actionObj);
        Logger.info('AgentEngine', `[ACTION_RESULT] ${execResult.success ? 'Success' : 'Failed'}: ${execResult.message || execResult.error}`);

        this.history.push({
          step: this.stepCount,
          type: 'execution_result',
          success: execResult.success !== false,
          message: execResult.message,
          error: execResult.error,
          label: execResult.label || null,
          submitted: execResult.submitted || false,
          resultData: execResult.result || execResult.results || null
        });
        this.trimHistory();

        if (execResult.success !== false) {
          this.updatePlanProgress(actionObj, false);
        }

        if (actionObj.action === 'click' || actionObj.action === 'navigate' || (actionObj.action === 'type' && actionObj.submit)) {
          await this.waitForTabComplete(this.activeTabId, 4000);
        }

        const delay = settings.actionDelayMs || 1000;
        await new Promise(r => setTimeout(r, delay));
      } catch (execErr) {
        Logger.error('AgentEngine', '[ACTION_EXECUTION_ERROR] Action execution failed', execErr);
        this.history.push({
          step: this.stepCount,
          type: 'execution_result',
          success: false,
          error: execErr.message
        });
      }

      this.notifyStateChange();
    }

    if (this.stepCount >= maxSteps && this.status === 'running') {
      this.status = 'idle';
      this.isLoopActive = false;
      this.currentPhase = '';
      this.history.push({
        type: 'finish',
        answer: `Reached maximum allowed steps (${maxSteps}) without completing task.`
      });
      this.notifyStateChange();
    }
  }

  /**
   * Helper to wait for browser tab loading to complete following navigation/clicks
   */
  waitForTabComplete(tabId, timeoutMs = 4000) {
    return new Promise((resolve) => {
      let resolved = false;

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.onUpdated && chrome.tabs.onUpdated.hasListener(listener)) {
            chrome.tabs.onUpdated.removeListener(listener);
          }
          resolve();
        }
      }, timeoutMs);

      const listener = (updatedTabId, changeInfo) => {
        if (updatedTabId === tabId && changeInfo.status === 'complete') {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.onUpdated) {
              chrome.tabs.onUpdated.removeListener(listener);
            }
            resolve();
          }
        }
      };

      if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.onUpdated) {
        chrome.tabs.onUpdated.addListener(listener);
      } else {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  /**
   * Read the DOM of the tab we are actually driving, injecting the content scripts if the
   * page does not have them yet (a fresh tab, or one whose scripts were invalidated by an
   * extension reload).
   *
   * This used to resolve the tab with chrome.tabs.query({active:true}) and then inject into
   * THAT tab rather than the tabId it was handed. So the moment the user's focus sat on a
   * different tab — very commonly chrome://extensions right after reloading the extension —
   * it injected into the wrong page and reported the wrong page's URL in the failure.
   */
  async getTabDOMWithAutoInject(tabId, showBadges = true) {
    if (!tabId) throw new Error('No target tab was selected for this task.');

    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (err) {
      throw new Error(`The target tab [${tabId}] no longer exists (it was probably closed). Open the page you want automated and start the task again.`);
    }

    const restriction = describeRestrictedUrl(tab.url);
    if (restriction) {
      // Fail with the truth. The old message said "refresh the page and try again", which for
      // a chrome:// page is advice that can never work and loops the user indefinitely.
      throw new Error(restriction);
    }

    try {
      return await this.sendTabMessage(tabId, { action: 'GET_DOM_SNAPSHOT', payload: { showBadges } });
    } catch (err) {
      Logger.info('AgentEngine', `[INJECT] Content script not active on tab [${tabId}] (${tab.url}). Injecting script dependencies...`);
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: [
            'content/domCompressor.js',
            'content/actionExecutor.js',
            'content/content.js'
          ]
        });

        // The network recorder lives in the MAIN world and so needs its own call. Omitting it
        // here meant a recovered tab never recorded traffic, and read_network_requests then
        // answered "no requests captured" — indistinguishable from "no requests were made".
        try {
          await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            world: 'MAIN',
            files: ['content/net-recorder.js']
          });
        } catch (netErr) {
          Logger.warn('AgentEngine', `[INJECT_PARTIAL] Page scripts loaded, but the network recorder could not be injected into tab [${tabId}]. read_network_requests will be empty for this page.`, netErr);
        }

        await new Promise(r => setTimeout(r, 400));
        return await this.sendTabMessage(tabId, { action: 'GET_DOM_SNAPSHOT', payload: { showBadges } });
      } catch (injectErr) {
        Logger.error('AgentEngine', `[INJECT_FAILED] Could not inject page scripts into tab [${tabId}] (${tab.url})`, injectErr);
        throw new Error(`Could not read the page at ${tab.url} — ${injectErr.message}. Reload that tab (Cmd+R) and start the task again.`);
      }
    }
  }

  sendTabMessage(tabId, msg) {
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, msg, (response) => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }
        if (response && response.success) {
          resolve(response.data);
        } else {
          reject(new Error(response?.error || 'Failed to communicate with page script'));
        }
      });
    });
  }

  async executeActionOnTab(tabId, actionPayload) {
    if (actionPayload.action === 'execute_js') {
      return this.executeJs(tabId, actionPayload.code, actionPayload.world || 'MAIN');
    }

    if (actionPayload.action === 'read_network_requests') {
      const netFormatted = this.readNetworkRequests(tabId, actionPayload.filter, actionPayload.includeBody !== false, actionPayload.limit || 10);
      return { success: true, message: `Recent Network Activity:\n${netFormatted}` };
    }

    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, { action: 'EXECUTE_ACTION', payload: actionPayload }, (response) => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }
        resolve(response || { success: true });
      });
    });
  }

  formatMessagesForLLM(latestUserMsg) {
    const messages = [];

    const priorTurns = this.previousTurnsSummary();
    if (priorTurns.length > 0) {
      messages.push({
        role: 'user',
        content: `Earlier in this session you already completed these tasks:\n${priorTurns.join('\n')}\n\nThose are finished. Use them for context \u2014 words like "it" or "that" in the new goal usually refer to them. Your current goal follows.`
      });
    }

    messages.push({
      role: 'user',
      content: `Goal: ${this.currentTask}`
    });

    // Only the CURRENT turn's steps. Earlier turns are represented by the recap above.
    const recentHistory = this.currentTurnHistory().slice(-8);
    recentHistory.forEach(item => {
      if (item.type === 'agent_response') {
        messages.push({ role: 'assistant', content: item.rawResponse });
      } else if (item.type === 'execution_result') {
        messages.push({
          role: 'user',
          content: item.success
            ? `Action Executed Successfully: ${item.message}`
            : `Action Failed: ${item.error}. Choose a different element or action.`
        });
      }
    });

    messages.push({ role: 'user', content: latestUserMsg });

    return messages;
  }

  buildSystemPrompt(customInstructions) {
    return `${customInstructions || 'You are ScoutFox, an autonomous web browsing AI agent.'}

You are provided with a user goal, visible webpage text content, and a compressed list of interactive web page elements labeled with numerical IDs like [1], [2], [3].

Your objective is to choose the single best action to complete the user's goal in as few steps as possible.

### General Guidelines for High Efficiency:
1. **Summarization / Reading / Overview Tasks**:
   - Inspect the "Webpage Visible Text Content". If the visible text already provides the project name, description, key features, and architecture, DO NOT waste steps scrolling or navigating in search of minor missing sentences!
   - Synthesize a comprehensive final summary immediately using:
     {"action": "finish", "answer": "<your_summary_here>", "reason": "Target documentation is visible"}
   - If you scroll once and the text snippet does not reveal new information, call "finish" immediately with what you have gathered.

2. **Form Filling / Multi-Step Primitives**:
   - Use "browser_batch" to fill multiple input fields and click submit in a SINGLE round trip instead of issuing individual "type" actions.

3. **Silent Action Failures / Error Debugging**:
   - If an action succeeds but the page state remains unchanged, use "read_network_requests" to inspect API responses or "execute_js" to verify state instead of blindly retrying.

### Available Actions:
1. Click element:
   {"action": "click", "element_id": <number>, "reason": "<explanation>"}

2. Type into input/textarea:
   {"action": "type", "element_id": <number>, "text": "<text_to_type>", "submit": <true/false>, "reason": "<explanation>"}

3. Scroll page:
   {"action": "scroll", "direction": "down"|"up", "amount": 500, "reason": "<explanation>"}

4. Direct navigate to URL:
   {"action": "navigate", "url": "<https://...>", "reason": "<explanation>"}

5. Go back / forward:
   {"action": "go_back", "reason": "<explanation>"}

6. Execute JavaScript in page context:
   {"action": "execute_js", "code": "return document.querySelectorAll('.result').length", "world": "MAIN", "reason": "<explanation>"}

7. Read recent network activity (XHR/fetch status & bodies):
   {"action": "read_network_requests", "filter": {"status": "error"|"all", "since": "last_action"}, "includeBody": true, "limit": 10, "reason": "<explanation>"}

8. Execute batch of deterministic primitive steps in 1 round trip:
   {"action": "browser_batch", "steps": [{"action": "type", "element_id": 1, "text": "user@example.com"}, {"action": "type", "element_id": 2, "text": "pass123"}, {"action": "click", "element_id": 3}], "stopOnError": true, "reason": "<explanation>"}

9. Explicitly extract full readable page text body:
   {"action": "read_page_text", "reason": "<explanation>"}

10. Task finished (Output final summary answer):
   {"action": "finish", "answer": "<final_answer_text>", "reason": "<explanation>"}

11. Ask user for input/help:
   {"action": "ask_user", "question": "<question_text>", "reason": "<explanation>"}

### FEW-SHOT OUTPUT EXAMPLES (Always follow these exact output patterns):

--- Example 1: Typing into a Search Bar ---
<thought>
Element [1] is the search input field. I will type the search query into element [1] and submit the form.
</thought>
\`\`\`json
{
  "action": "type",
  "element_id": 1,
  "text": "open source browser agents",
  "submit": true,
  "reason": "Enter search query into search box"
}
\`\`\`

--- Example 2: Clicking a Button or Link ---
<thought>
Element [4] is the main repository link relevant to the user's task. I will click element [4].
</thought>
\`\`\`json
{
  "action": "click",
  "element_id": 4,
  "reason": "Click target repository link"
}
\`\`\`

--- Example 3: Filling Multi-Field Form in One Round Trip using browser_batch ---
<thought>
Filling out username and password fields and submitting form in a single batch sequence.
</thought>
\`\`\`json
{
  "action": "browser_batch",
  "steps": [
    { "action": "type", "element_id": 2, "text": "user@example.com" },
    { "action": "type", "element_id": 3, "text": "securePassword123" },
    { "action": "click", "element_id": 5 }
  ],
  "stopOnError": true,
  "reason": "Fill login form and click submit"
}
\`\`\`

--- Example 4: Executing Custom JS to Inspect Page State ---
<thought>
I need to check the number of virtualized table rows and verify form validity using execute_js.
</thought>
\`\`\`json
{
  "action": "execute_js",
  "code": "return document.querySelectorAll('.table-row').length",
  "world": "MAIN",
  "reason": "Count table rows in page"
}
\`\`\`

--- Example 5: Reading Recent Network Requests after Action ---
<thought>
The page did not change after clicking submit. I will check network requests to see if an API error occurred.
</thought>
\`\`\`json
{
  "action": "read_network_requests",
  "filter": { "status": "error", "since": "last_action" },
  "includeBody": true,
  "limit": 5,
  "reason": "Check recent API errors"
}
\`\`\`

--- Example 6: Completing Task & Summarizing Answer ---
<thought>
The visible documentation text provides the project title, key features, and architecture. I will synthesize the final summary and complete the task.
</thought>
\`\`\`json
{
  "action": "finish",
  "answer": "### Summary of ScoutFox Project:\n- Autonomous AI Browser Extension supporting OpenRouter, AgentRouter, Ollama, Gemini, OpenAI, Claude.\n- Built with Manifest V3 and Studio Mono design system.",
  "reason": "Extracted and summarized requested data"
}
\`\`\`

### Output Rules:
1. Always output your reasoning inside <thought>...</thought> (or <think>...</think>).
2. Always output your single action inside a valid \`\`\`json ... \`\`\` block matching the JSON structure in the examples above.
3. Only select element_id numbers that exist in the provided Interactive Elements list.`;
  }

  buildStepMessage(snapshot) {
    return `Current Page Title: "${snapshot.title}"
Current URL: ${snapshot.url}
Scroll Position: Y=${snapshot.scrollState.scrollY} / ${snapshot.scrollState.pageHeight}px

Webpage Visible Text Content (Use this to read content or summarize):
"""
${snapshot.pageText || '(No visible text extracted)'}
"""

Interactive Elements on Page:
${snapshot.elementsText || '(No interactive elements detected)'}

Choose your next action based on the goal: "${this.currentTask}"`;
  }

  /**
   * Universal Multi-Stage Guardrail Action Parser
   */
  parseResponse(text, maxElementCount = 999) {
    if (!text || typeof text !== 'string') {
      return { thought: '', error: 'Empty output from model.' };
    }

    let thought = '';
    
    // 1. Extract <think> or <thought> or <reasoning>
    const thinkMatch = text.match(/<(?:think|thought|reasoning)>([\s\S]*?)<\/(?:think|thought|reasoning)>/i);
    if (thinkMatch) {
      thought = thinkMatch[1].trim();
    }

    let cleanText = text.replace(/<(?:think|thought|reasoning)>[\s\S]*?<\/(?:think|thought|reasoning)>/gi, '').trim();

    let actionObj = null;

    // 2. Extract JSON from ```json ... ``` or ``` ... ```
    const codeBlockMatch = cleanText.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (codeBlockMatch) {
      try {
        actionObj = JSON.parse(codeBlockMatch[1].trim());
      } catch (_) { /* continue to fallback extractors */ }
    }

    // 3. Extract JSON object containing "action" key
    if (!actionObj) {
      const braceMatch = cleanText.match(/\{[\s\S]*?"action"\s*:[\s\S]*?\}/i);
      if (braceMatch) {
        try {
          actionObj = JSON.parse(braceMatch[0].trim());
        } catch (_) { /* continue */ }
      }
    }

    // 4. Reverse SCAN all { ... } blocks in text for valid action JSON
    if (!actionObj) {
      const matches = cleanText.match(/\{[\s\S]*?\}/g) || [];
      for (let i = matches.length - 1; i >= 0; i--) {
        try {
          const parsed = JSON.parse(matches[i]);
          if (parsed && (parsed.action || parsed.click || parsed.type || parsed.finish || parsed.execute_js || parsed.browser_batch || parsed.read_network_requests)) {
            actionObj = parsed;
            break;
          }
        } catch (_) { /* ignore */ }
      }
    }

    // 5. REGEX Intent Extractor for Dumber / Smaller LLMs outputting plain text
    if (!actionObj) {
      const clickMatch = cleanText.match(/(?:action:?\s*)?(?:click|press|tap)\s+(?:on\s+)?(?:element\s+)?\[?(\d+)\]?/i);
      if (clickMatch) {
        actionObj = { action: 'click', element_id: parseInt(clickMatch[1], 10), reason: 'Extracted via text intent' };
      }

      if (!actionObj) {
        const typeMatch = cleanText.match(/(?:action:?\s*)?(?:type|enter|write|input)\s+["']([^"']+)["']\s+(?:in|into|on)\s+(?:element\s+)?\[?(\d+)\]?/i);
        if (typeMatch) {
          actionObj = { action: 'type', text: typeMatch[1], element_id: parseInt(typeMatch[2], 10), submit: true, reason: 'Extracted via text intent' };
        }
      }

      if (!actionObj) {
        const navMatch = cleanText.match(/(?:action:?\s*)?(?:navigate|go\s+to|open)\s+(https?:\/\/[^\s]+)/i);
        if (navMatch) {
          actionObj = { action: 'navigate', url: navMatch[1], reason: 'Extracted via text intent' };
        }
      }

      if (!actionObj) {
        const scrollMatch = cleanText.match(/(?:action:?\s*)?(?:scroll)\s+(down|up)/i);
        if (scrollMatch) {
          actionObj = { action: 'scroll', direction: scrollMatch[1].toLowerCase(), amount: 500, reason: 'Extracted via text intent' };
        }
      }

      if (!actionObj && /read.*page.*text|extract.*text|get.*page.*content/i.test(cleanText)) {
        actionObj = { action: 'read_page_text', reason: 'Extracted via text intent' };
      }
    }

    // 6. Freeform Text Auto-Wrapping Guardrail
    if (!actionObj && cleanText.length > 5) {
      Logger.info('AgentEngine', '[UNIVERSAL_GUARDRAIL] Model provided direct text response. Auto-wrapping into finish action.');
      actionObj = {
        action: 'finish',
        answer: cleanText,
        reason: 'Direct text output from model'
      };
    }

    if (!actionObj) {
      return { thought, error: 'No valid action or response text found in model output.', raw: text };
    }

    // 7. Action Schema & Element ID Sanitizer
    actionObj = this.sanitizeActionSchema(actionObj, maxElementCount);

    return { thought, action: actionObj };
  }

  /**
   * Action Schema Normalizer & Element ID Bounds Validator
   */
  sanitizeActionSchema(actionObj, maxElementCount = 999) {
    const act = { ...actionObj };
    
    if (act.click !== undefined && !act.action) { act.action = 'click'; act.element_id = act.click; }
    if (act.type !== undefined && !act.action) { act.action = 'type'; }
    if (act.action === 'click_element' || act.action === 'press') act.action = 'click';
    if (act.action === 'type_text' || act.action === 'input') act.action = 'type';
    if (act.action === 'done' || act.action === 'complete' || act.action === 'finished') act.action = 'finish';
    if (act.action === 'scroll_page') act.action = 'scroll';
    if (act.action === 'extract_text' || act.action === 'read_text' || act.action === 'extract_page_text') act.action = 'read_page_text';
    if (act.action === 'eval_js' || act.action === 'run_js' || act.action === 'javascript') act.action = 'execute_js';
    if (act.action === 'read_network' || act.action === 'network_requests' || act.action === 'get_network') act.action = 'read_network_requests';
    if (act.action === 'batch' || act.action === 'batch_actions') act.action = 'browser_batch';

    if (act.element_id === undefined) {
      if (act.element !== undefined) act.element_id = act.element;
      else if (act.id !== undefined) act.element_id = act.id;
      else if (act.elementId !== undefined) act.element_id = act.elementId;
    }

    if (act.element_id !== undefined && typeof act.element_id === 'number') {
      act.element_id = parseInt(act.element_id, 10) || 1;
      if (maxElementCount > 0 && act.element_id > maxElementCount) {
        Logger.warn('AgentEngine', `[GUARDRAIL_BOUNDS] Model selected hallucinated element_id [${act.element_id}]. Clamping to valid range [1..${maxElementCount}]`);
        act.element_id = Math.min(act.element_id, maxElementCount);
      }
    }

    return act;
  }
}

function formatActionSummary(act) {
  if (act.action === 'click') return `Click [${act.element_id}]`;
  if (act.action === 'type') return `Type "${act.text || ''}" in [${act.element_id}]`;
  if (act.action === 'scroll') return `Scroll ${act.direction || 'down'}`;
  if (act.action === 'navigate') return `Navigate to ${act.url || ''}`;
  if (act.action === 'read_page_text') return `Extract text body`;
  if (act.action === 'execute_js') return `Execute JS`;
  if (act.action === 'read_network_requests') return `Read network requests`;
  if (act.action === 'browser_batch') return `Batch (${act.steps ? act.steps.length : 0} steps)`;
  return act.action;
}
