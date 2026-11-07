// src/background/runner/runSnapshot.ts
// The run as the side panel shows it, kept in chrome.storage.session across worker restarts.
//
// Chrome stops an idle MV3 service worker after about 30 seconds. Everything a runner holds in
// memory dies with it, and the next worker builds a fresh, empty runner for the tab: the panel then
// resyncs to that empty state and shows the start screen, as if the run never happened. This store
// keeps the panel-visible part of the run (task, status, history rows, plan) so the new worker can
// put it back before it answers the panel.
//
// storage.session survives worker restarts but not a browser restart; Recent tasks (the panel's
// storage.local list) is the long-term record. Its quota (10 MB) is shared by every tab, so one
// thread is held to RUN_SNAPSHOT_MAX_CHARS.
import type { StorageSessionArea } from './actionJournal.ts';
import type { HistoryEntry, RunStats, RunStatus } from '../types.ts';
import { Logger } from '../../shared/logger.ts';

export interface RunSnapshot {
  status: RunStatus;
  task: string;
  history: HistoryEntry[];
  planSteps: Array<{ text: string; status: string }>;
  stepCount: number;
  pauseReason: 'user' | 'llm_failure' | 'worker_restart' | null;
  stateVersion: number;
  /** The tokens of the last model call of the task, for the context meter (absent in older snapshots). */
  lastCall?: { promptTokens: number; outputTokens: number; estimated: boolean } | null;
  /** The task's counts (model calls, tokens in and out); absent in older snapshots. */
  runStats?: RunStats | null;
  /** The chat this thread is (the Recent tasks entry it saves to); absent in older snapshots. */
  chatId?: string;
  /** The title of that chat in Recent tasks: its first goal. */
  chatTitle?: string;
  /** The provider and model the chat's last run used, for its Recent tasks line. */
  runModel?: { provider: string; model: string } | null;
  /** The save_data records of the run that is going (they move onto its closing row when it ends). */
  records?: Array<Record<string, unknown>>;
  /** The page the run that is going was on last. */
  pageUrl?: string;
  savedAt: number;
}

/** The most one thread may take of the shared storage.session quota, in JSON characters. */
export const RUN_SNAPSHOT_MAX_CHARS = 800_000;

/** How long writes are gathered before one goes out. Terminal states are written at once. */
export const RUN_SNAPSHOT_DEBOUNCE_MS = 250;

/** The row a run gets when the worker died under it. */
export const INTERRUPTED_TEXT = 'Chrome restarted Tarka\'s background worker, so the run could not go on. The steps so far are kept; start the task again to continue.';

/** The row a saved chat gets when its run was cut off by a closed browser or panel (it was never saved as ended). */
export const CLOSED_TEXT = 'The run was cut off when the browser or panel closed. The steps so far are kept; resume the task to continue.';

/**
 * What a turn's closing row keeps of its run, so the chat can go on from it later: the save_data
 * records (on any closing row), and for a turn that ended unfinished its plan and its last page.
 */
export function withRunData(row: HistoryEntry, data: { records?: Array<Record<string, unknown>>; planSteps?: Array<{ text: string; status: string }>; pageUrl?: string }): HistoryEntry {
  if (row.type !== 'finish' && row.type !== 'partial_result') return row;
  const out: any = { ...row };
  if (data.records && data.records.length) out.records = data.records.slice();
  if (row.type === 'partial_result') {
    if (data.planSteps && data.planSteps.length) out.plan = data.planSteps.map((s) => ({ text: String(s.text), status: String(s.status) }));
    if (data.pageUrl) out.pageUrl = data.pageUrl;
  }
  return out;
}

/** The index of the last closing row (finish or partial_result), or -1. */
function lastClosingIndex(history: HistoryEntry[]): number {
  for (let i = history.length - 1; i >= 0; i--) {
    const t = history[i]?.type;
    if (t === 'finish' || t === 'partial_result') return i;
  }
  return -1;
}

/** The storage key of one thread's run. */
export function runSnapshotKey(threadId: string | number): string {
  return `sf:run:${threadId}`;
}

/** A history row without the parts that can be large: the raw tool call, long tables, and records (kept apart, see fitSnapshot). */
function slimRow(row: HistoryEntry, keepRecords = false): HistoryEntry {
  const out: any = { ...row };
  delete out.rawResponse;
  if (!keepRecords) delete out.records;
  if (out.table && Array.isArray(out.table.rows) && out.table.rows.length > 50) {
    out.table = { ...out.table, rows: out.table.rows.slice(0, 50) };
  }
  return out;
}

/**
 * The snapshot made to fit the per-thread budget: large fields first, then the oldest turns
 * (a turn starts at a user_goal row), never the last turn. The last chat_compacted row is kept
 * whatever is cut: its summary is what the chain of the next request starts from.
 */
export function fitSnapshot(snapshot: RunSnapshot, maxChars = RUN_SNAPSHOT_MAX_CHARS): RunSnapshot {
  // Only the last closing row keeps its records: they are what a resume of that turn goes on from,
  // and the turns before it handed theirs over in their files. That holds a chat to one run's cap.
  const closing = lastClosingIndex(snapshot.history);
  let history = snapshot.history.map((row, i) => slimRow(row, i === closing));
  let compacted: HistoryEntry | null = null;
  for (let i = history.length - 1; i >= 0 && !compacted; i--) if (history[i].type === 'chat_compacted') compacted = history[i];
  /** The rows from `at` on, with the last compacted row in front when the cut took it. */
  const keepFrom = (at: number) => {
    const rest = history.slice(at);
    return compacted && !rest.includes(compacted) ? [compacted, ...rest] : rest;
  };
  let fitted = { ...snapshot, history };
  while (JSON.stringify(fitted).length > maxChars) {
    const goals = history.map((row, i) => (row.type === 'user_goal' ? i : -1)).filter((i) => i >= 0);
    // The cut starts at the second turn; rows before the first turn (the kept compacted row) do not count as one.
    const secondGoal = goals.length >= 2 ? goals[1] : -1;
    if (secondGoal <= 0) {
      // One turn too large on its own: keep its newest rows.
      const next = keepFrom(Math.ceil(history.length / 4));
      if (next.length >= history.length) break;
      history = next;
      if (history.length <= 1) break;
    } else {
      history = keepFrom(secondGoal);
    }
    fitted = { ...snapshot, history };
  }
  return fitted;
}

/**
 * The run as a new worker should show it. A run that was running or paused cannot go on: the
 * model's conversation died with the old worker. It is stopped, with a final row that says why
 * (the panel's "Interrupted" card), and nothing waits on a prompt nobody can serve. A finished
 * run comes back as it was.
 */
export function restoredRun(snapshot: RunSnapshot): RunSnapshot {
  if (snapshot.status !== 'running' && snapshot.status !== 'paused') return snapshot;
  const finalRow = withRunData({ type: 'partial_result', answer: INTERRUPTED_TEXT, table: null, reason: 'interrupted' },
    { records: snapshot.records, planSteps: snapshot.planSteps, pageUrl: snapshot.pageUrl });
  return {
    ...snapshot,
    status: 'stopped',
    pauseReason: null,
    history: [...snapshot.history, finalRow],
    records: [],
    // The added row is a new state: the panel's watermark must see a higher version.
    stateVersion: snapshot.stateVersion + 1
  };
}

/** Whether a state is worth keeping: an empty, idle runner is just removed. */
function isEmpty(snapshot: RunSnapshot): boolean {
  return snapshot.history.length === 0 && !snapshot.task && snapshot.status !== 'running' && snapshot.status !== 'paused';
}

export class RunSnapshotStore {
  private key: string;
  private area: StorageSessionArea | null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: RunSnapshot | null = null;

  constructor(threadId: string | number, area?: StorageSessionArea) {
    this.key = runSnapshotKey(threadId);
    this.area = area ?? (typeof chrome !== 'undefined' && chrome.storage?.session ? chrome.storage.session : null);
  }

  /** Keeps the latest state; it goes out after the debounce, or at once when `now` is set. */
  save(snapshot: RunSnapshot, now = false): void {
    this.pending = snapshot;
    if (now) {
      void this.flush();
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => { void this.flush(); }, RUN_SNAPSHOT_DEBOUNCE_MS);
  }

  /** Drops a pending write without making it: the thread moved to another key. */
  discard(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = null;
  }

  /** Writes the latest pending state, if any. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const snapshot = this.pending;
    this.pending = null;
    if (!snapshot || !this.area) return;
    try {
      if (isEmpty(snapshot)) {
        await this.area.remove(this.key);
        return;
      }
      await this.area.set({ [this.key]: fitSnapshot(snapshot) });
    } catch (err) {
      // The quota is shared by every tab: a write that does not fit is retried at half the budget.
      try {
        await this.area.set({ [this.key]: fitSnapshot(snapshot, RUN_SNAPSHOT_MAX_CHARS / 2) });
      } catch {
        Logger.warn('AgentRunner', `[RUN_SNAPSHOT] Could not keep the run for a worker restart: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  async read(): Promise<RunSnapshot | null> {
    if (!this.area) return null;
    try {
      const data = await this.area.get(this.key);
      const raw = data?.[this.key] as Partial<RunSnapshot> | undefined;
      return raw && typeof raw === 'object' && Array.isArray(raw.history) ? raw as RunSnapshot : null;
    } catch {
      return null;
    }
  }

  /** Drops the pending write and the stored run (New chat, the tab closed). */
  async clear(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
    if (!this.area) return;
    await this.area.remove(this.key).catch(() => {});
  }
}
