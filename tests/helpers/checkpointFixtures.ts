/**
 * Fixtures for the SessionStorageSaver tests: hand-made checkpoints (so a test controls exactly
 * which channels changed in a put), a fake area over a shared store, and a way to see what a
 * connection wrote.
 */
import type { RunnableConfig } from '@langchain/core/runnables';
import type { ChannelVersions, Checkpoint, CheckpointMetadata } from '@langchain/langgraph-checkpoint';
import { SessionStorageSaver } from '../../src/background/checkpoint/SessionStorageSaver.ts';
import { createFakeStorage, type FakeStorage, type FakeStorageOptions, type Host, type StorageConnection } from './fakeStorageSession.ts';

/** Ids sort like real uuid6 ids: a larger n is newer. */
export function checkpointId(n: number): string {
  return `00000000-0000-6000-8000-${String(n).padStart(12, '0')}`;
}

export function makeCheckpoint(n: number, values: Record<string, unknown>, versions: ChannelVersions): Checkpoint {
  return {
    v: 4,
    id: checkpointId(n),
    ts: `2026-09-29T10:00:${String(n % 60).padStart(2, '0')}.000Z`,
    channel_values: values,
    channel_versions: versions,
    versions_seen: { node: { ...versions } },
  };
}

/** A config that names a thread, a namespace and (optionally) a checkpoint. */
export function cfg(thread: string, ns = '', id?: string): RunnableConfig {
  return { configurable: { thread_id: thread, checkpoint_ns: ns, ...(id === undefined ? {} : { checkpoint_id: id }) } };
}

/** A config with only a thread: no namespace (so list() walks every namespace) and no checkpoint. */
export function threadCfg(thread: string): RunnableConfig {
  return { configurable: { thread_id: thread } };
}

/** The keys of one thread in the store: its index, checkpoints, blobs and writes, plus its sf:meta and sf:journal. */
export function keysOfThread(store: FakeStorage, thread: string): string[] {
  const own = new RegExp(`^(sf:lg:(cp|b|w):${thread}:|sf:lg:ix:${thread}$|sf:meta:${thread}$|sf:journal:${thread}$)`);
  return store.session.keys().filter((key) => own.test(key));
}

export const META: CheckpointMetadata = { source: 'loop', step: 0, parents: {} };

export interface Rig {
  store: FakeStorage;
  conn: StorageConnection;
  host: Host;
  saver: SessionStorageSaver;
}

/** A store, one worker connection over it and a saver on that connection. */
export function rig(options?: FakeStorageOptions): Rig {
  const store = createFakeStorage(options);
  const conn = store.connect();
  return { store, conn, host: conn.host, saver: new SessionStorageSaver(conn.session) };
}

/**
 * put() checkpoint n of a namespace the way the LangGraph loop does: the parent is n - 1 (none for
 * n = 1) and newVersions lists only the channels that changed.
 */
export async function putStep(
  saver: SessionStorageSaver,
  thread: string,
  ns: string,
  n: number,
  values: Record<string, unknown>,
  versions: ChannelVersions,
  changed: string[],
  metadata: CheckpointMetadata = { ...META, step: n }
): Promise<RunnableConfig> {
  const newVersions: ChannelVersions = {};
  for (const channel of changed) newVersions[channel] = versions[channel];
  return saver.put(cfg(thread, ns, n > 1 ? checkpointId(n - 1) : undefined), makeCheckpoint(n, values, versions), metadata, newVersions);
}

/** Every key that a storage.session.set call on this connection wrote, in call order. */
export function writtenKeys(host: Host): string[] {
  return host.calls.filter((call) => call.api === 'storage.session.set').flatMap((call) => Object.keys(call.args[0] as Record<string, unknown>));
}

/** True when some storage.session.get call asked for everything (get(null) or get()). */
export function readEverything(host: Host): boolean {
  return host.calls.some((call) => call.api === 'storage.session.get' && (call.args.length === 0 || call.args[0] === null || call.args[0] === undefined));
}
