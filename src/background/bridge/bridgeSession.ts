/**
 * Extension-side bridge session semantics: resolves which tab a bridge start_task targets,
 * diffs run history into task_event frames, and extracts the task_done payload from a
 * finished run.
 *
 * Bridge tasks never hijack the user's focused tab: without an explicit tabId a dedicated tab
 * is created in the session's Tarka tab group (AgentRunner.ensureTarkaGroup runs at startTask).
 */

import { bridgeEntry, encodeFrame, historyDelta, type BridgeFrame } from './protocol.ts';
import { Logger } from '../../shared/logger.ts';

export interface BridgeRunnerView {
  status: string;
  chatId: string;
  history: unknown[];
  activeTabId?: number | null;
  getState(): Record<string, unknown>;
  stop(): unknown;
}

export interface BridgeSessionEntry {
  ownerTabId: number;
  engine: BridgeRunnerView;
}

export interface BridgeDeps {
  /** All live sessions (the background's sessions map values). */
  getSessions(): Iterable<BridgeSessionEntry>;
  /** Create (or get) the session for a tab and start the task on it. Returns the start reply. */
  startTaskOnSession(tabId: number | null, payload: { prompt: string; effort?: string | null; autoApprove: boolean }): Promise<{ ok: boolean; data?: unknown; error?: string }>;
  stopSession(session: BridgeSessionEntry): { ok: boolean; data?: unknown; error?: string };
  isValidWebTab(tab: { url?: string; id?: number }): boolean;
  createTab(url: string): Promise<{ id?: number } | null>;
}

/** One frame per new history entry keeps a single huge entry from batching with others. */
const MAX_FRAME_CHARS = 1_000_000;

export class BridgeSessionManager {
  private deps: BridgeDeps;
  private sender: ((type: string, payload: Record<string, unknown>, id?: string | number | null) => void) | null = null;
  /** runId (chatId) -> last history length already sent. */
  private lastSeq = new Map<string, number>();
  /** runIds the bridge started (source tagging for the stop-on-disconnect rule). */
  private bridgeRuns = new Set<string>();
  private trackedRunId: string | null = null;
  /** The chatId the tracked run's events use on the wire (set by the start reply). */
  private wireRunId: string | null = null;

  constructor(deps: BridgeDeps) {
    this.deps = deps;
  }

  /** Bind the sender to the live socket (called by wsClient on open; tests pass a fake). */
  setSender(send: (type: string, payload: Record<string, unknown>, id?: string | number | null) => void): void {
    this.sender = send;
  }

  setSocket(socket: { send(text: string): void } | null): void {
    // Convenience for tests: a raw socket-shaped sender.
    this.sender = socket ? (type, payload, id) => socket.send(encodeFrame(type, payload, id ?? null)) : null;
  }

  private send(type: string, payload: Record<string, unknown>, id: string | number | null = null): void {
    if (!this.sender) return;
    try {
      const text = encodeFrame(type, payload, id);
      if (text.length > MAX_FRAME_CHARS) {
        Logger.warn('Bridge', `[BRIDGE_FRAME_TOO_LARGE] A ${type} frame of ${text.length} chars was dropped (cap ${MAX_FRAME_CHARS}).`);
        return;
      }
      this.sender(type, payload, id);
    } catch (err) {
      Logger.warn('Bridge', '[BRIDGE_SEND_FAILED] Could not send a bridge frame', err);
    }
  }

  /** hello: proto version, build stamp, current session list. */
  sendHello(build: string): void {
    this.send('hello', {
      proto: 1,
      build,
      sessions: [...this.deps.getSessions()].map((s) => ({
        tabId: s.ownerTabId,
        chatId: s.engine.chatId,
        status: s.engine.status,
        url: '',
        title: '',
      })),
    });
  }

  /**
   * A frame from the bridge that is not a request (history_reset). The wsClient answers
   * requests itself and forwards everything else here; task_event and task_done are produced
   * here, not consumed.
   */
  onFrame(frame: { type: string; payload: Record<string, unknown> }): void {
    if (frame.type === 'history_reset') this.onHistoryReset(frame.payload as any);
  }

  /** A history shrink (clearHistory, loadChat): the seq basis is gone, start over. */
  private onHistoryReset(payload: { runId?: string }): void {
    if (payload?.runId) this.lastSeq.delete(payload.runId);
  }

  /**
   * Handle start_task from the bridge. Without an explicit tabId a dedicated tab is created
   * (never the user's focused tab); with one, that tab's session is used.
   */
  async handleStartTask(payload: { runId: string; prompt: string; effort?: string | null; tabId?: number | null; startUrl?: string | null }): Promise<{ ok: boolean; data?: unknown; error?: string }> {
    const prompt = String(payload?.prompt ?? '').trim();
    if (!prompt) return { ok: false, error: 'Empty task.' };
    this.trackedRunId = payload.runId;
    // The run is keyed by the runner's chatId on the wire (task_event/task_done carry it); the
    // bridge's own runId only correlates the MCP call. Both are accepted by the session.
    this.wireRunId = null;
    try {
      let tabId = typeof payload.tabId === 'number' ? payload.tabId : null;
      if (tabId === null) {
        const startUrl = typeof payload.startUrl === 'string' && /^https?:\/\//.test(payload.startUrl)
          ? payload.startUrl
          : 'https://www.google.com';
        const tab = await this.deps.createTab(startUrl);
        tabId = typeof tab?.id === 'number' ? tab.id : null;
        if (tabId === null) return { ok: false, error: 'Could not open a tab for the task.' };
      }
      const result = await this.deps.startTaskOnSession(tabId, { prompt, effort: payload.effort ?? null, autoApprove: true });
      if (result.ok) {
        this.bridgeRuns.add(payload.runId);
        // The run's events on the wire are keyed by the runner's chatId (the data field of the
        // start reply), not by the bridge's runId; remember the mapping.
        const data = result.data as { chatId?: string } | undefined;
        this.wireRunId = typeof data?.chatId === 'string' ? data.chatId : payload.runId;
      }
      return result;
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  handleStopTask(payload: { runId: string }): { ok: boolean; data?: unknown; error?: string } {
    const runId = payload?.runId ?? this.trackedRunId;
    for (const session of this.deps.getSessions()) {
      if (!runId || session.engine.chatId === runId) {
        return this.deps.stopSession(session);
      }
    }
    return { ok: false, error: 'No matching run found.' };
  }

  handleGetState(payload: { runId: string }): { ok: boolean; data?: unknown; error?: string } {
    const runId = payload?.runId ?? this.trackedRunId;
    for (const session of this.deps.getSessions()) {
      if (session.engine.chatId === runId) {
        const state = session.engine.getState();
        return { ok: true, data: { ...state, history: undefined, entries: state.history } };
      }
    }
    return { ok: false, error: 'No matching run found.' };
  }

  /**
   * Called on every runner state change. Sends only new history entries as task_event frames;
   * a shrink (clearHistory, loadChat, snapshot trim) triggers history_reset.
   */
  onStateChange(session: BridgeSessionEntry): void {
    if (!this.sender) return;
    const engine = session.engine;
    const runId = engine.chatId;
    const history = engine.history ?? [];
    const last = this.lastSeq.get(runId) ?? 0;
    const delta = historyDelta(history, last);
    if (delta.reset) {
      this.lastSeq.set(runId, history.length);
      this.send('history_reset', { runId, summary: '' });
      return;
    }
    if (delta.entries && delta.entries.length) {
      this.lastSeq.set(runId, history.length);
      const state = {
        status: engine.status,
        stepCount: (engine.getState() as any).stepCount,
        currentPhase: (engine.getState() as any).currentPhase,
        runStats: (engine.getState() as any).runStats,
      };
      for (const entry of delta.entries) {
        this.send('task_event', { runId, tabId: session.ownerTabId, seq: this.lastSeq.get(runId), entry: bridgeEntry(entry), state });
      }
      this.maybeTaskDone(engine, runId);
    }
  }

  /** When the tracked run leaves running/paused, emit task_done from its final entry. */
  private maybeTaskDone(engine: BridgeRunnerView, runId: string): void {
    if (this.wireRunId !== runId) return;
    if (engine.status === 'running' || engine.status === 'paused') return;
    const history = engine.history ?? [];
    const finalEntry = [...history].reverse().find((e: any) => e.type === 'finish' || e.type === 'partial_result') as any;
    const state = engine.getState() as any;
    // The records of the run: on the closing row (withRunData).
    const records = finalEntry?.records && finalEntry.records.length ? finalEntry.records : null;
    this.send('task_done', {
      runId,
      status: engine.status,
      answer: finalEntry?.answer ?? '',
      outcome: finalEntry?.outcome ?? (engine.status === 'idle' ? 'done' : 'blocked'),
      table: finalEntry?.table ?? null,
      records,
      runStats: state.runStats ?? null,
      findings: state.findings ?? [],
    });
    this.bridgeRuns.delete(this.trackedRunId ?? runId);
  }

  /** The bridge socket dropped: stop bridge-started runs so nothing clicks unattended. */
  stopBridgeRuns(): void {
    for (const session of this.deps.getSessions()) {
      if (this.bridgeRuns.has(session.engine.chatId) && (session.engine.status === 'running' || session.engine.status === 'paused')) {
        this.deps.stopSession(session);
      }
    }
    this.bridgeRuns.clear();
  }
}
