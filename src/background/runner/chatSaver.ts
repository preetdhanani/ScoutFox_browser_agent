// src/background/runner/chatSaver.ts
// The writer of a thread's chat into Recent tasks (storage.local, one key per chat).
//
// The runner is the single writer: every state change asks for a save. While a run goes the saves
// are throttled to one every CHAT_SAVE_THROTTLE_MS, so a run cut off by a closed browser is kept
// with its last steps; a state the run rests in (ended, paused, waiting) is written at once. The
// chat is built when the write goes out, so a throttled write always holds the newest state.
import { Storage, type SavedSession } from '../../shared/storage.ts';
import { Logger } from '../../shared/logger.ts';

/** At most one write of a running chat per this many milliseconds. */
export const CHAT_SAVE_THROTTLE_MS = 3000;

/** The most one saved chat's history may take, in JSON characters (its records come on top, capped by the run). */
export const CHAT_MAX_CHARS = 300_000;

export class ChatSaver {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: (() => SavedSession | null) | null = null;
  private write: (chat: SavedSession) => Promise<void>;

  constructor(write?: (chat: SavedSession) => Promise<void>) {
    this.write = write ?? ((chat) => Storage.saveChat(chat));
  }

  /**
   * Asks for a save of the chat `build` makes. `now` writes at once (a resting state); otherwise
   * the write goes out when the throttle window ends, built from the state of that moment.
   */
  save(build: () => SavedSession | null, now = false): void {
    this.pending = build;
    if (now) {
      void this.flush();
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => { void this.flush(); }, CHAT_SAVE_THROTTLE_MS);
  }

  /** Builds and writes the pending chat, if any. The chat is built before the first await. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const build = this.pending;
    this.pending = null;
    if (!build) return;
    const chat = build();
    if (!chat) return;
    try {
      await this.write(chat);
    } catch (err) {
      Logger.warn('AgentRunner', `[CHAT_SAVE] Could not save the chat to Recent tasks: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Drops a pending write without making it. */
  discard(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
  }
}
