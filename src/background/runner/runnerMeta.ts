// src/background/runner/runnerMeta.ts
// Runner metadata stored in chrome.storage.session across worker cold boots.
import type { StorageSessionArea } from './actionJournal.ts';

export interface RunnerMeta {
  stateVersion: number;
  scoutFoxGroupIds: [windowId: number, groupId: number][];
  aliases: number[];
  attachedTabIds: number[];
  pauseDetach: { tabIds: number[]; at: number } | null;
  lastBeatAt: number;
}

export class SessionRunnerMeta {
  private threadId: string;
  private area: StorageSessionArea;
  private pendingWrite: NodeJS.Timeout | null = null;
  private lastWrittenAt = 0;

  constructor(threadId: string, area?: StorageSessionArea) {
    this.threadId = threadId;
    this.area = area ?? (typeof chrome !== 'undefined' && chrome.storage?.session
      ? chrome.storage.session
      : {
          async get() { return {}; },
          async set() {},
          async remove() {},
        });
  }

  private storageKey(): string {
    return `sf:meta:${this.threadId}`;
  }

  async read(): Promise<RunnerMeta | null> {
    try {
      const data = await this.area.get(this.storageKey());
      const raw = data[this.storageKey()];
      if (raw && typeof raw === 'object') {
        return raw as RunnerMeta;
      }
    } catch {
      // Ignore read error
    }
    return null;
  }

  async writeImmediate(meta: RunnerMeta): Promise<void> {
    if (this.pendingWrite) {
      clearTimeout(this.pendingWrite);
      this.pendingWrite = null;
    }
    this.lastWrittenAt = Date.now();
    try {
      await this.area.set({ [this.storageKey()]: meta });
    } catch {
      // Ignore write error
    }
  }

  scheduleWrite(meta: RunnerMeta): void {
    const now = Date.now();
    const elapsed = now - this.lastWrittenAt;
    if (elapsed >= 250) {
      void this.writeImmediate(meta);
      return;
    }

    if (!this.pendingWrite) {
      this.pendingWrite = setTimeout(() => {
        this.pendingWrite = null;
        void this.writeImmediate(meta);
      }, 250 - elapsed);
    }
  }

  async clear(): Promise<void> {
    if (this.pendingWrite) {
      clearTimeout(this.pendingWrite);
      this.pendingWrite = null;
    }
    try {
      await this.area.remove(this.storageKey());
    } catch {
      // Ignore write error
    }
  }
}
