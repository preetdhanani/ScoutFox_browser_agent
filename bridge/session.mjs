/**
 * Bridge session state: tracks the single active run, correlates MCP request ids to runs,
 * forwards step events as MCP progress notifications, and resolves tarka_run_task on
 * task_done, timeout, cancellation or extension disconnect.
 */

import { bridgeEntry } from './protocol.mjs';

export class BridgeSession {
  constructor({ sendToExtension, notify, log, isConnected = null, portNotOwned = false }) {
    this.sendToExtension = sendToExtension;
    this.notify = notify;
    this.log = log;
    /** Live extension-socket state, read from the owner (never stale); null in unit tests. */
    this.isConnected = isConnected;
    /** Set when another bridge process owns the WebSocket port: runTask fails fast. */
    this.portNotOwned = portNotOwned;
    this.activeRun = null; // { runId, mcpRequestId, progressToken, timer, disconnected }
    this.pendingRequests = new Map(); // corrId -> { resolve, reject, timer }
    this.nextId = 1;
    /** Latest known state of the tracked run (from task_event frames). */
    this.lastState = null;
    /** Recent projected history entries of the tracked run. */
    this.history = [];
  }

  corrId() {
    return `b${this.nextId++}`;
  }

  /** Send a request to the extension and wait for the matching result frame. */
  request(type, payload, timeoutMs = 30_000) {
    const id = this.corrId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Tarka did not answer the ${type} request in time.`));
      }, timeoutMs);
      this.pendingRequests.set(id, { resolve, reject, timer });
      this.sendToExtension(type, payload, id);
    });
  }

  /** Handle a frame from the extension. Returns true if consumed. */
  onFrame(frame) {
    switch (frame.type) {
      case 'result': {
        const pending = this.pendingRequests.get(frame.id);
        if (!pending) return false;
        this.pendingRequests.delete(frame.id);
        clearTimeout(pending.timer);
        if (frame.payload.ok) {
          if (this.activeRun && frame.payload.data?.chatId) {
            // The run's events on the wire are keyed by the runner's chatId; remember the mapping.
            this.activeRun.wireRunId = frame.payload.data.chatId;
            this.log(`start reply: ${JSON.stringify(frame.payload.data)}`);
          }
          pending.resolve(frame.payload.data);
        } else {
          pending.reject(new Error(String(frame.payload.error ?? 'unknown error')));
        }
        return true;
      }
      case 'hello':
        this.onHello(frame.payload);
        return true;
      case 'task_event':
        this.onTaskEvent(frame.payload);
        return true;
      case 'task_done':
        this.onTaskDone(frame.payload);
        return true;
      case 'history_reset':
        this.history = [];
        return true;
      default:
        return false;
    }
  }

  onHello(payload) {
    this.sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
    // A run we were waiting for may have died with a worker restart (restoredRun marks it
    // stopped/interrupted): finish the pending tarka_run_task as interrupted.
    if (this.activeRun) {
      const wireId = this.activeRun.wireRunId ?? this.activeRun.runId;
      const match = this.sessions.find((s) => s.chatId === wireId);
      if (match && match.status !== 'running' && match.status !== 'paused') {
        this.finishRun({
          runId: this.activeRun.runId,
          status: match.status,
          answer: '',
          outcome: 'blocked',
          note: 'The run was interrupted (the browser service worker restarted).',
        });
      }
    }
  }

  onTaskEvent(payload) {
    if (this.activeRun && payload.runId === (this.activeRun.wireRunId ?? this.activeRun.runId)) {
      // The extension sends one entry per frame (payload.entry); a bridge test may batch them
      // (payload.entries). Both are accepted.
      const entries = payload.entries ?? (payload.entry ? [payload.entry] : []);
      for (const entry of entries) {
        this.history.push(bridgeEntry(entry));
        const e = entry ?? {};
        if (e.type === 'agent_response') {
          const step = e.step ?? '';
          const thought = String(e.thought ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
          const action = e.action?.action ? String(e.action.action) : '';
          const message = `Step ${step}: ${thought}${action ? ` (${action})` : ''}`;
          this.notify({
            progressToken: this.activeRun.progressToken,
            progress: typeof step === 'number' ? step : this.history.length,
            total: this.activeRun.totalSteps,
            message,
          });
        }
      }
      if (payload.state) this.lastState = payload.state;
    }
  }

  onTaskDone(payload) {
    if (this.activeRun && payload.runId === (this.activeRun.wireRunId ?? this.activeRun.runId)) {
      this.finishRun(payload);
    }
    this.lastDone = payload;
  }

  finishRun(result) {
    const run = this.activeRun;
    this.activeRun = null;
    if (run?.timer) clearTimeout(run.timer);
    if (run?.resolve) run.resolve(result);
  }

  /** Start a task; resolves with the task_done payload. */
  runTask({ task, effort, timeoutMs, tabId, startUrl, progressToken, totalSteps }) {
    if (this.portNotOwned) {
      throw new Error('This bridge process does not own the WebSocket port, so the Tarka extension ' +
        'cannot reach it: another bridge process (started by another harness) already holds the port. ' +
        'Stop the other bridge (or quit that harness) and restart this one, then call tarka_run_task again.');
    }
    if (this.activeRun) {
      throw new Error(`A task is already active in Tarka (chatId: ${this.activeRun.runId}). Stop it first with tarka_stop_task.`);
    }
    const runId = `run_${Date.now()}_${Math.floor(Math.random() * 1e6).toString(36)}`;
    this.history = [];
    this.lastState = null;
    const run = {
      runId,
      progressToken: progressToken ?? null,
      totalSteps: totalSteps ?? null,
      timer: null,
      resolve: null,
    };
    const promise = new Promise((resolve, reject) => {
      run.resolve = resolve;
      run.reject = reject;
    });
    this.activeRun = run;
    run.timer = setTimeout(() => {
      if (this.activeRun === run) {
        this.log(`timeout after ${timeoutMs} ms - stopping the run`);
        this.sendToExtension('stop_task', { runId }, this.corrId());
        // task_done will arrive and resolve the promise; if the extension is gone, resolve now.
        const graceTimer = setTimeout(() => {
          if (this.activeRun === run) {
            this.finishRun({ runId, status: 'stopped', outcome: 'partial', answer: '', note: 'Timeout: the run was stopped.' });
          }
        }, 2000);
        if (typeof graceTimer.unref === 'function') graceTimer.unref();
      }
    }, timeoutMs);
    if (typeof run.timer.unref === 'function') run.timer.unref();
    // The start reply (the tab and chatId the run runs in) comes back as a result frame for
    // this id; remember it so task_event/task_done frames (keyed by the runner's chatId) find
    // the pending call.
    run.startCorrId = this.corrId();
    this.pendingRequests.set(run.startCorrId, {
      resolve: (data) => {
        if (data?.chatId) {
          run.wireRunId = data.chatId;
          this.log(`start reply: ${JSON.stringify(data)}`);
        }
      },
      reject: () => {},
      timer: null,
    });
    this.sendToExtension('start_task', { runId, prompt: task, effort: effort ?? null, autoApprove: true, tabId: tabId ?? null, startUrl: startUrl ?? null }, run.startCorrId);
    return promise;
  }

  /** MCP cancellation: stop the active run. */
  cancelActive() {
    if (this.activeRun) {
      this.sendToExtension('stop_task', { runId: this.activeRun.runId }, this.corrId());
      return true;
    }
    return false;
  }

  stopActive() {
    if (this.activeRun) {
      this.sendToExtension('stop_task', { runId: this.activeRun.runId }, this.corrId());
      return { stopped: this.activeRun.runId };
    }
    return { stopped: null };
  }

  /** The extension connection dropped: fail pending calls, finish bridge runs as interrupted. */
  onDisconnect() {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Tarka disconnected from the bridge.'));
      this.pendingRequests.delete(id);
    }
    if (this.activeRun) {
      const run = this.activeRun;
      this.finishRun({
        runId: run.runId,
        status: 'stopped',
        outcome: 'blocked',
        answer: '',
        note: 'Tarka disconnected; the run was stopped.',
      });
    }
  }

  statusPayload() {
    const s = this.lastState ?? {};
    const connected = this.isConnected ? this.isConnected() : null;
    const payload = {
      connected,
      status: s.status ?? 'unknown',
      stepCount: s.stepCount ?? 0,
      task: s.task ?? '',
      currentPhase: s.currentPhase ?? null,
      chatId: this.activeRun?.runId ?? null,
      runStats: s.runStats ?? null,
      lastOutcome: this.lastDone?.outcome ?? null,
    };
    if (this.portNotOwned) {
      payload.reason = 'This bridge does not own the WebSocket port; another bridge process holds it. Restart this harness after stopping the other bridge.';
    }
    return payload;
  }

  historyPayload(limit = 50) {
    return this.history.slice(-limit);
  }
}
