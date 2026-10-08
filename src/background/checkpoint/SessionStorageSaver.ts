import {
  BaseCheckpointSaver,
  WRITES_IDX_MAP,
  copyCheckpoint,
  getCheckpointId,
  type ChannelVersions,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointPendingWrite,
  type CheckpointTuple,
  type PendingWrite,
  type SerializerProtocol,
} from '@langchain/langgraph-checkpoint';
import type { RunnableConfig } from '@langchain/core/runnables';
import { Logger } from '../../shared/logger.ts';

/**
 * LangGraph checkpointer on chrome.storage.session, so a paused graph survives the MV3 service
 * worker being stopped. Chrome clears storage.session when the browser restarts, which is wanted:
 * Chrome reuses tab ids.
 *
 * Layout (a thread is String(ownerTabId), a namespace is '' for the orchestrator and LangGraph's
 * own subgraph namespace for a site worker; nsKey is 'root' for '' and encodeURIComponent(ns)
 * otherwise, so the ':' and '|' inside a namespace never clash with the key separator):
 *
 *   sf:lg:ix:<thread>                         {ns: {'<ns>': {ids: newest first, parents: {id: parentId}}}}
 *   sf:lg:cp:<thread>:<nsKey>:<id>            [checkpoint without channel_values, metadata, parentId | null]
 *   sf:lg:b:<thread>:<nsKey>:<channel>:<ver>  one channel value, written only for the channels in put()'s newVersions
 *   sf:lg:w:<thread>:<nsKey>:<id>             {'<taskId>,<idx>': [taskId, channel, blob]}
 *
 * LangGraph JS hands put() the full channel_values, so one blob per checkpoint would rewrite the
 * whole multi-turn history channel on every superstep. Channel values are separate blobs keyed by
 * channel version instead (like PostgresSaver's checkpoint_blobs), and getTuple() rebuilds
 * channel_values from the blobs that channel_versions names. Time-travel forks are not supported:
 * a fork that reuses a version number for a different value would replace the blob the older
 * branch points at. Nothing here forks.
 *
 * A blob is [type, text]: JSON as the JSON text, other bytes as base64 (storage.session cannot
 * hold a Uint8Array).
 */

export const KEEP_CHECKPOINTS = 3;
export const QUOTA_SOFT_LIMIT_BYTES = 8 * 1024 * 1024;
export const STORAGE_FULL_MESSAGE = 'Session storage is full - stop other ScoutFox tabs or clear this session.';

type Items = Record<string, unknown>;
type StoredBlob = [type: string, data: string];
type StoredCheckpoint = [checkpoint: StoredBlob, metadata: StoredBlob, parentId: string | null];
type StoredWrites = Record<string, [taskId: string, channel: string, value: StoredBlob]>;
interface NamespaceIndex {
  ids: string[];
  parents: Record<string, string>;
}
interface ThreadIndex {
  ns: Record<string, NamespaceIndex>;
}

/** The part of chrome.storage.StorageArea the saver uses (so tests can hand in the fake area). */
export interface SessionArea {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  /** Chrome 130 and newer. */
  getKeys?(): Promise<string[]>;
  getBytesInUse?(keys?: string | string[] | null): Promise<number>;
}

// ---------------------------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------------------------

/** encodeURIComponent never yields '%72oot' for any input, so the namespace "root" cannot clash with ''. */
function nsKey(ns: string): string {
  if (ns === '') return 'root';
  const encoded = encodeURIComponent(ns);
  return encoded === 'root' ? '%72oot' : encoded;
}

const ixKey = (thread: string): string => `sf:lg:ix:${thread}`;
const cpKey = (thread: string, ns: string, id: string): string => `sf:lg:cp:${thread}:${nsKey(ns)}:${id}`;
const wKey = (thread: string, ns: string, id: string): string => `sf:lg:w:${thread}:${nsKey(ns)}:${id}`;
const bKey = (thread: string, ns: string, channel: string, version: string | number): string =>
  `sf:lg:b:${thread}:${nsKey(ns)}:${channel}:${version}`;

/** Every key that belongs to one thread, without touching another thread's (thread ids never contain ':'). */
function threadKeyMatcher(thread: string): (key: string) => boolean {
  const exact = new Set([ixKey(thread), `sf:meta:${thread}`, `sf:journal:${thread}`]);
  const prefixes = [`sf:lg:cp:${thread}:`, `sf:lg:b:${thread}:`, `sf:lg:w:${thread}:`];
  return (key) => exact.has(key) || prefixes.some((prefix) => key.startsWith(prefix));
}

function assertThread(thread: unknown): asserts thread is string {
  if (typeof thread !== 'string' || thread === '' || thread.includes(':') || thread === '__proto__') {
    throw new Error(`SessionStorageSaver: thread_id must be a non-empty string without ':' (got ${JSON.stringify(thread)})`);
  }
}

/** Names that end up as plain object keys in the stored index. */
function assertSafeName(what: string, name: string): void {
  if (name === '__proto__') throw new Error(`SessionStorageSaver: ${what} "__proto__" is reserved`);
}

const nsOf = (config: RunnableConfig): string => {
  const ns = (config.configurable?.checkpoint_ns as string | undefined) ?? '';
  assertSafeName('checkpoint_ns', ns);
  return ns;
};

// ---------------------------------------------------------------------------------------------
// Blobs
// ---------------------------------------------------------------------------------------------

const textDecoder = new TextDecoder();
const B64_PREFIX = 'b64:';

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function encodeBlob([type, data]: [string, Uint8Array | string]): StoredBlob {
  if (typeof data === 'string') return [type, data];
  if (type === 'json') return [type, textDecoder.decode(data)];
  return [`${B64_PREFIX}${type}`, toBase64(data)];
}

function decodeBlob([type, data]: StoredBlob): [string, Uint8Array | string] {
  if (type.startsWith(B64_PREFIX)) return [type.slice(B64_PREFIX.length), fromBase64(data)];
  return [type, data];
}

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

/** Newest first. Checkpoint ids are time-ordered uuids, so plain string order is time order. */
const newestFirst = (a: string, b: string): number => (a < b ? 1 : a > b ? -1 : 0);

function isQuotaError(error: unknown): boolean {
  return error instanceof Error && /quota/i.test(error.message);
}

function ownEntry(index: ThreadIndex, ns: string): NamespaceIndex | undefined {
  return Object.hasOwn(index.ns, ns) ? index.ns[ns] : undefined;
}

interface PreparedCheckpoint {
  id: string;
  parentId: string | null;
  channelVersions: ChannelVersions;
  /** The cp key and the blobs for the channels that changed. */
  items: Items;
}

export class SessionStorageSaver extends BaseCheckpointSaver {
  private readonly area: SessionArea;
  private readonly queues = new Map<string, Promise<void>>();
  private readonly tombstones = new Set<string>();
  private overSoftLimit = false;
  private cleanupFailed = false;

  constructor(area?: SessionArea, serde?: SerializerProtocol) {
    super(serde);
    this.area = area ?? (chrome.storage.session as SessionArea);
  }

  // -------------------------------------------------------------------------------------------
  // Locking and small reads
  // -------------------------------------------------------------------------------------------

  /**
   * One promise chain per thread wraps every read-modify-write, and getTuple and list go through
   * it too, so a read waits for the writes in flight. It is entered synchronously when a public
   * method is called (before its first await), so calls run in call order. The chain never
   * rejects, so one failed call does not poison the next.
   */
  private withLock<T>(thread: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(thread) ?? Promise.resolve();
    const run = previous.then(task);
    const tail = run.then(
      () => undefined,
      () => undefined
    );
    this.queues.set(thread, tail);
    void tail.then(() => {
      if (this.queues.get(thread) === tail) this.queues.delete(thread);
    });
    return run;
  }

  private async readIndex(thread: string): Promise<ThreadIndex> {
    const key = ixKey(thread);
    const stored = (await this.area.get(key))[key] as ThreadIndex | undefined;
    return stored && typeof stored.ns === 'object' && stored.ns !== null ? stored : { ns: {} };
  }

  /** All keys in the area. Chrome 130 and newer has getKeys(); older Chrome has to read everything. */
  private async allKeys(): Promise<string[]> {
    if (typeof this.area.getKeys === 'function') return this.area.getKeys();
    return Object.keys(await this.area.get(null));
  }

  private async threadsWithCheckpoints(): Promise<string[]> {
    const prefix = ixKey('');
    return (await this.allKeys()).filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
  }

  private async loadBlob(blob: StoredBlob): Promise<any> {
    const [type, data] = decodeBlob(blob);
    return this.serde.loadsTyped(type, data);
  }

  // -------------------------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------------------------

  private async buildTuple(thread: string, ns: string, id: string, stored: StoredCheckpoint, writes: StoredWrites): Promise<CheckpointTuple> {
    const [checkpointBlob, metadataBlob, parentId] = stored;
    const checkpoint = (await this.loadBlob(checkpointBlob)) as Omit<Checkpoint, 'channel_values'>;
    const versions = checkpoint.channel_versions ?? {};
    const blobKeys = Object.entries(versions).map(([channel, version]) => [channel, bKey(thread, ns, channel, version)] as const);
    const blobs = blobKeys.length > 0 ? await this.area.get(blobKeys.map(([, key]) => key)) : {};
    const channelValues: Record<string, unknown> = {};
    await Promise.all(
      blobKeys.map(async ([channel, key]) => {
        if (Object.hasOwn(blobs, key)) channelValues[channel] = await this.loadBlob(blobs[key] as StoredBlob);
      })
    );
    const pendingWrites = await Promise.all(
      Object.values(writes).map(async ([taskId, channel, value]) => [taskId, channel, await this.loadBlob(value)] as CheckpointPendingWrite)
    );
    const tuple: CheckpointTuple = {
      config: { configurable: { thread_id: thread, checkpoint_ns: ns, checkpoint_id: id } },
      checkpoint: { ...checkpoint, channel_values: channelValues },
      metadata: await this.loadBlob(metadataBlob),
      pendingWrites,
    };
    if (parentId != null) tuple.parentConfig = { configurable: { thread_id: thread, checkpoint_ns: ns, checkpoint_id: parentId } };
    return tuple;
  }

  /** Runs inside the thread's lock. No id means the newest checkpoint of the namespace. */
  private async loadTuple(thread: string, ns: string, wanted?: string): Promise<CheckpointTuple | undefined> {
    let id = wanted;
    if (!id) {
      id = ownEntry(await this.readIndex(thread), ns)?.ids[0];
      if (!id) return undefined;
    }
    const checkpointKey = cpKey(thread, ns, id);
    const writesKey = wKey(thread, ns, id);
    const got = await this.area.get([checkpointKey, writesKey]);
    const stored = got[checkpointKey] as StoredCheckpoint | undefined;
    if (!stored) return undefined;
    return this.buildTuple(thread, ns, id, stored, (got[writesKey] as StoredWrites | undefined) ?? {});
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const thread = config.configurable?.thread_id as unknown;
    if (thread === undefined) return undefined;
    assertThread(thread);
    const ns = nsOf(config);
    const wanted = getCheckpointId(config) || undefined;
    return this.withLock(thread, () => this.loadTuple(thread, ns, wanted));
  }

  async *list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
    let limit = options?.limit;
    const filter = options?.filter;
    const beforeId = options?.before?.configurable?.checkpoint_id as string | undefined;
    const nsFilter = config.configurable?.checkpoint_ns as string | undefined;
    const idFilter = config.configurable?.checkpoint_id as string | undefined;
    const requested = config.configurable?.thread_id as unknown;
    let threads: string[];
    if (requested === undefined) threads = await this.threadsWithCheckpoints();
    else {
      assertThread(requested);
      threads = [requested];
    }
    for (const thread of threads) {
      const index = await this.withLock(thread, () => this.readIndex(thread));
      for (const [ns, entry] of Object.entries(index.ns)) {
        if (nsFilter !== undefined && ns !== nsFilter) continue;
        for (const id of entry.ids) {
          if (limit !== undefined && limit <= 0) return;
          if (idFilter && id !== idFilter) continue;
          if (beforeId && id >= beforeId) continue;
          // Each tuple is read under the lock, but never held across a yield. A checkpoint that was pruned meanwhile is skipped.
          const tuple = await this.withLock(thread, () => this.loadTuple(thread, ns, id));
          if (!tuple) continue;
          if (filter && !Object.entries(filter).every(([key, value]) => (tuple.metadata as Record<string, unknown> | undefined)?.[key] === value)) continue;
          if (limit !== undefined) limit -= 1;
          yield tuple;
        }
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------------------------

  private async prepare(
    thread: string,
    ns: string,
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    newVersions: ChannelVersions | undefined
  ): Promise<PreparedCheckpoint> {
    const { channel_values: values, ...rest } = copyCheckpoint(checkpoint);
    const [checkpointBlob, metadataBlob] = await Promise.all([this.serde.dumpsTyped(rest), this.serde.dumpsTyped(metadata)]);
    const parentId = (config.configurable?.checkpoint_id as string | undefined) ?? null;
    const items: Items = {
      [cpKey(thread, ns, checkpoint.id)]: [encodeBlob(checkpointBlob), encodeBlob(metadataBlob), parentId] satisfies StoredCheckpoint,
    };
    // A channel that is in newVersions but has no value (it was emptied) gets no blob, so a read leaves it out too.
    // Without newVersions every channel is written, which is safe and only costs space.
    const changed = Object.keys(newVersions ?? checkpoint.channel_versions ?? {});
    await Promise.all(
      changed.map(async (channel) => {
        const version = checkpoint.channel_versions?.[channel];
        if (version === undefined || !Object.hasOwn(values, channel)) return;
        items[bKey(thread, ns, channel, version)] = encodeBlob(await this.serde.dumpsTyped(values[channel]));
      })
    );
    return { id: checkpoint.id, parentId, channelVersions: { ...checkpoint.channel_versions }, items };
  }

  /**
   * Add a checkpoint to the index, keep the newest `keep` of its namespace and write it all with
   * one set (new keys and the index first) and one remove (what pruning dropped). A crash between
   * the two leaves garbage but never a dangling reference.
   */
  private async commit(thread: string, ns: string, prepared: PreparedCheckpoint, keep: number): Promise<void> {
    const index = await this.readIndex(thread);
    const entry = ownEntry(index, ns) ?? (index.ns[ns] = { ids: [], parents: {} });
    if (!entry.ids.includes(prepared.id)) entry.ids.push(prepared.id);
    entry.ids.sort(newestFirst);
    if (prepared.parentId !== null) entry.parents[prepared.id] = prepared.parentId;
    else delete entry.parents[prepared.id];
    const doomed = await this.planPrune(thread, ns, index, keep, { [prepared.id]: prepared.channelVersions });
    await this.area.set({ ...prepared.items, [ixKey(thread)]: index });
    if (doomed.length > 0) await this.area.remove(doomed);
  }

  /**
   * Cut one namespace of `index` (in place) down to its newest `keep` checkpoints, and return the
   * keys to remove: the older cp and w keys, and every blob version that none of the kept
   * checkpoints refers to. The pending writes of the kept checkpoints, the newest one included,
   * are never touched.
   */
  private async planPrune(thread: string, ns: string, index: ThreadIndex, keep: number, known: Record<string, ChannelVersions> = {}): Promise<string[]> {
    const entry = ownEntry(index, ns);
    if (!entry || entry.ids.length <= keep) return [];
    const kept = entry.ids.slice(0, keep);
    const dropped = entry.ids.slice(keep);
    const unknown = [...kept, ...dropped].filter((id) => !Object.hasOwn(known, id));
    const stored = unknown.length > 0 ? await this.area.get(unknown.map((id) => cpKey(thread, ns, id))) : {};
    const versions = new Map<string, ChannelVersions>();
    for (const id of [...kept, ...dropped]) {
      if (Object.hasOwn(known, id)) versions.set(id, known[id]);
      else {
        const found = stored[cpKey(thread, ns, id)] as StoredCheckpoint | undefined;
        if (found) versions.set(id, ((await this.loadBlob(found[0])) as Checkpoint).channel_versions ?? {});
      }
    }
    const stillUsed = new Set<string>();
    for (const id of kept) {
      for (const [channel, version] of Object.entries(versions.get(id) ?? {})) stillUsed.add(bKey(thread, ns, channel, version));
    }
    const doomed = new Set<string>();
    for (const id of dropped) {
      doomed.add(cpKey(thread, ns, id));
      doomed.add(wKey(thread, ns, id));
      for (const [channel, version] of Object.entries(versions.get(id) ?? {})) {
        const key = bKey(thread, ns, channel, version);
        if (!stillUsed.has(key)) doomed.add(key);
      }
    }
    entry.ids = kept;
    entry.parents = Object.fromEntries(Object.entries(entry.parents).filter(([id]) => kept.includes(id)));
    return [...doomed];
  }

  /** Every namespace of the thread down to its newest `keep` checkpoints. Runs inside the thread's lock. */
  private async pruneThread(thread: string, keep: number): Promise<void> {
    const index = await this.readIndex(thread);
    const doomed: string[] = [];
    for (const ns of Object.keys(index.ns)) doomed.push(...(await this.planPrune(thread, ns, index, keep)));
    if (doomed.length === 0) return;
    await this.area.set({ [ixKey(thread)]: index });
    await this.area.remove(doomed);
  }

  async put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata, newVersions?: ChannelVersions): Promise<RunnableConfig> {
    const thread = config.configurable?.thread_id as unknown;
    if (thread === undefined) throw new Error('SessionStorageSaver.put: missing configurable.thread_id');
    assertThread(thread);
    const ns = nsOf(config);
    assertSafeName('checkpoint id', checkpoint.id);
    let written = false;
    await this.withLock(thread, async () => {
      if (this.tombstones.has(thread)) return;
      const prepared = await this.prepare(thread, ns, config, checkpoint, metadata, newVersions);
      try {
        await this.commit(thread, ns, prepared, KEEP_CHECKPOINTS);
      } catch (error) {
        if (!isQuotaError(error)) throw error;
        // Full: cut every namespace of this thread to its newest checkpoint and try once more. The
        // old head stays until the new checkpoint is stored, so a second failure loses nothing.
        await this.pruneThread(thread, 1);
        try {
          await this.commit(thread, ns, prepared, 2);
        } catch (retryError) {
          throw isQuotaError(retryError) ? new Error(STORAGE_FULL_MESSAGE, { cause: retryError }) : retryError;
        }
        await this.pruneThread(thread, 1);
      }
      written = true;
    });
    if (written) await this.watchQuota(thread);
    return { configurable: { thread_id: thread, checkpoint_ns: ns, checkpoint_id: checkpoint.id } };
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const thread = config.configurable?.thread_id as unknown;
    if (thread === undefined) throw new Error('SessionStorageSaver.putWrites: missing configurable.thread_id');
    assertThread(thread);
    const id = config.configurable?.checkpoint_id as string | undefined;
    if (id === undefined) throw new Error('SessionStorageSaver.putWrites: missing configurable.checkpoint_id');
    assertSafeName('checkpoint id', id);
    const ns = nsOf(config);
    await this.withLock(thread, async () => {
      if (this.tombstones.has(thread)) return;
      const serialized = await Promise.all(
        writes.map(async ([channel, value], idx) => ({
          channel,
          idx: WRITES_IDX_MAP[channel] ?? idx,
          blob: encodeBlob(await this.serde.dumpsTyped(value)),
        }))
      );
      const key = wKey(thread, ns, id);
      const existing = ((await this.area.get(key))[key] as StoredWrites | undefined) ?? {};
      for (const { channel, idx, blob } of serialized) {
        const inner = `${taskId},${idx}`;
        // Same rule as MemorySaver: a regular write is written once, a special one (negative idx: error, interrupt, resume) is replaced.
        if (idx >= 0 && Object.hasOwn(existing, inner)) continue;
        existing[inner] = [taskId, channel, blob];
      }
      try {
        await this.area.set({ [key]: existing });
      } catch (error) {
        if (!isQuotaError(error)) throw error;
        await this.pruneThread(thread, 1);
        try {
          await this.area.set({ [key]: existing });
        } catch (retryError) {
          throw isQuotaError(retryError) ? new Error(STORAGE_FULL_MESSAGE, { cause: retryError }) : retryError;
        }
      }
    });
  }

  // -------------------------------------------------------------------------------------------
  // Deleting
  // -------------------------------------------------------------------------------------------

  /**
   * Remove every key of the thread, of every namespace, plus its sf:meta and sf:journal keys.
   * storage.session has no prefix query and get(null) would load every tab's checkpoints into the
   * worker, so the keys are listed with getKeys() and only the matching ones are removed. That
   * works with no runner in memory too.
   *
   * The thread is also tombstoned in memory: a later put or putWrites for it is ignored, so a
   * closing tab's run cannot leave orphan keys. revive() lifts that when the thread starts again.
   */
  async deleteThread(threadId: string): Promise<void> {
    assertThread(threadId);
    this.tombstones.add(threadId);
    await this.withLock(threadId, async () => {
      const matches = threadKeyMatcher(threadId);
      const doomed = (await this.allKeys()).filter(matches);
      if (doomed.length > 0) await this.area.remove(doomed);
    });
  }

  /** Accept writes for a deleted thread again (a new task on the same tab). */
  revive(threadId: string): void {
    this.tombstones.delete(threadId);
  }

  /**
   * Delete a finished worker namespace as a whole (its cp, b and w keys and its index entry), and
   * any namespace nested under it. The runner calls this once the orchestrator has a newer
   * checkpoint in which the site task is done and nothing pending refers to it. The root
   * namespace is deleted with deleteThread.
   */
  async deleteNamespace(threadId: string, ns: string): Promise<void> {
    assertThread(threadId);
    if (ns === '') throw new Error('SessionStorageSaver.deleteNamespace: the root namespace is deleted with deleteThread');
    await this.withLock(threadId, async () => {
      if (this.tombstones.has(threadId)) return;
      const index = await this.readIndex(threadId);
      const nested = Object.keys(index.ns).filter((name) => name.startsWith(`${ns}|`));
      const names = [ns, ...nested];
      const prefixes = names.flatMap((name) => ['cp', 'b', 'w'].map((kind) => `sf:lg:${kind}:${threadId}:${nsKey(name)}:`));
      if (names.some((name) => Object.hasOwn(index.ns, name))) {
        for (const name of names) delete index.ns[name];
        await this.area.set({ [ixKey(threadId)]: index });
      }
      const doomed = (await this.allKeys()).filter((key) => prefixes.some((prefix) => key.startsWith(prefix)));
      if (doomed.length > 0) await this.area.remove(doomed);
    });
  }

  // -------------------------------------------------------------------------------------------
  // Quota
  // -------------------------------------------------------------------------------------------

  /**
   * After a put: when storage.session is above 8 MB (of 10), log it and cut the idle threads to one
   * checkpoint per namespace. Idle means no call in flight here; the thread that just wrote is
   * left alone. It runs outside the writer's lock, so two writers can never wait for each other.
   * The log line comes once per crossing (a put happens about 4 times per model step, and the log
   * keeps only 300 entries); the cutting is repeated on every put while the storage stays above.
   *
   * This is best effort and never throws. The checkpoint is already stored when it runs, so a
   * cleanup that fails must not make put() reject: LangGraph would fail the run for a write that
   * worked. A thread that can not be cut does not stop the others, and the failure is logged once
   * until a cleanup works again.
   */
  private async watchQuota(current: string): Promise<void> {
    if (typeof this.area.getBytesInUse !== 'function') return;
    let used: number;
    try {
      used = await this.area.getBytesInUse(null);
    } catch {
      return;
    }
    if (used <= QUOTA_SOFT_LIMIT_BYTES) {
      this.overSoftLimit = false;
      this.cleanupFailed = false;
      return;
    }
    if (!this.overSoftLimit) {
      this.overSoftLimit = true;
      Logger.warn('Checkpoint', `[CHECKPOINT_QUOTA] storage.session holds ${used} bytes (limit 10 MB); cutting idle threads to 1 checkpoint per namespace.`);
    }
    let failure: unknown;
    try {
      for (const thread of await this.threadsWithCheckpoints()) {
        if (thread === current || this.queues.has(thread) || this.tombstones.has(thread)) continue;
        try {
          await this.withLock(thread, () => this.pruneThread(thread, 1));
        } catch (error) {
          failure ??= error;
        }
      }
    } catch (error) {
      failure ??= error;
    }
    if (failure === undefined) {
      this.cleanupFailed = false;
    } else if (!this.cleanupFailed) {
      this.cleanupFailed = true;
      Logger.warn('Checkpoint', `[CHECKPOINT_QUOTA] cutting idle threads failed (the checkpoint itself is stored): ${failure instanceof Error ? failure.message : String(failure)}`);
    }
  }
}
