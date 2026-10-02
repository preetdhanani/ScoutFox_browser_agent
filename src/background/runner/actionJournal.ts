// src/background/runner/actionJournal.ts
// Action journal persisted to chrome.storage.session to prevent double-dispatch
// across service worker restarts.
import type { ActionJournal, ExecResult } from './runtimeRegistry.ts';
import type { PageAction } from '../graph/workerState.ts';

export interface JournalEntry {
  key: string; // '<runId>:<step>'
  action: PageAction;
  bootId: string;
  dispatchedAt: number;
  result: ExecResult | null;
}

export interface StorageSessionArea {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export class SessionActionJournal implements ActionJournal {
  private threadId: string;
  private bootId: string;
  private area: StorageSessionArea;

  constructor(threadId: string, bootId: string, area?: StorageSessionArea) {
    this.threadId = threadId;
    this.bootId = bootId;
    this.area = area ?? (typeof chrome !== 'undefined' && chrome.storage?.session
      ? chrome.storage.session
      : {
          async get() { return {}; },
          async set() {},
          async remove() {},
        });
  }

  private storageKey(): string {
    return `sf:journal:${this.threadId}`;
  }

  private async readEntries(): Promise<JournalEntry[]> {
    try {
      const data = await this.area.get(this.storageKey());
      const raw = data[this.storageKey()];
      if (Array.isArray(raw)) {
        return raw as JournalEntry[];
      }
    } catch {
      // Ignore read error
    }
    return [];
  }

  private async writeEntries(entries: JournalEntry[]): Promise<void> {
    try {
      // Keep only last 2 entries
      const pruned = entries.slice(-2);
      await this.area.set({ [this.storageKey()]: pruned });
    } catch {
      // Ignore write error
    }
  }

  async get(key: string): Promise<{ dispatchedAt: number; bootId: string; result: ExecResult | null } | null> {
    const entries = await this.readEntries();
    const entry = entries.find((e) => e.key === key);
    if (!entry) return null;
    return {
      dispatchedAt: entry.dispatchedAt,
      bootId: entry.bootId,
      result: entry.result,
    };
  }

  async begin(key: string, action: PageAction): Promise<void> {
    const entries = await this.readEntries();
    const existingIndex = entries.findIndex((e) => e.key === key);
    const newEntry: JournalEntry = {
      key,
      action,
      bootId: this.bootId,
      dispatchedAt: Date.now(),
      result: null,
    };

    if (existingIndex >= 0) {
      entries[existingIndex] = newEntry;
    } else {
      entries.push(newEntry);
    }

    await this.writeEntries(entries);
  }

  async finish(key: string, result: ExecResult): Promise<void> {
    const entries = await this.readEntries();
    const entry = entries.find((e) => e.key === key);
    if (entry) {
      entry.result = result;
      await this.writeEntries(entries);
    }
  }

  async clearRun(runId: string): Promise<void> {
    const entries = await this.readEntries();
    const filtered = entries.filter((e) => !e.key.startsWith(`${runId}:`));
    await this.writeEntries(filtered);
  }
}
