/**
 * fakeStorageSession - a Map-backed fake of chrome.storage.session and chrome.storage.local.
 *
 * What it models, like the real areas:
 *   - Values are stored as JSON text. A value that does not survive JSON (undefined, Date, Map,
 *     Uint8Array...) comes back changed, so a test cannot pass by relying on it.
 *   - Bytes are counted per item as UTF-8 bytes of JSON.stringify(value) plus the key's UTF-8
 *     bytes (for ASCII keys that is just key.length). Both areas default to a 10 MB quota.
 *   - A set() that would go over the quota fails as a whole and writes NOTHING.
 *   - Both call styles: a promise when there is no callback, or a callback with
 *     chrome.runtime.lastError set while it runs.
 *   - onChanged fires with { key: { oldValue?, newValue? } } (only for keys that really changed).
 *
 * The store is separate from the "connection" a worker sees. Data lives in the store and
 * survives; listeners live in the connection and do not. So a service-worker restart in a test
 * is: connect() again on the SAME store (and kill() the old connection).
 *
 * Example:
 *   import { createFakeStorage } from './helpers/fakeStorageSession.ts';
 *
 *   const store = createFakeStorage({ session: { quotaBytes: 100 } }); // small quota for a test
 *   const worker1 = store.connect();
 *   await worker1.session.set({ a: { n: 1 } });        // 'a' (1 byte) + '{"n":1}' (7 bytes) = 8
 *   store.session.bytesInUse();                        // 8
 *   await worker1.session.set({ big: 'x'.repeat(200) }).catch((e) => e.message);
 *   // 'Session storage quota bytes exceeded. Values were not stored.' and 'big' is not stored
 *   worker1.kill();                                    // the worker dies: its listeners are gone
 *   const worker2 = store.connect();                   // the new worker still sees { a: { n: 1 } }
 *   (await worker2.session.get('a')).a;                // { n: 1 }
 *
 * fakeChrome.ts builds on this file (it reuses Host, FakeEvent, asyncApi and friends), and takes
 * a store directly: fakeChrome({ storage: store }).
 */

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

export const DEFAULT_QUOTA_BYTES = 10_485_760;
export const SESSION_QUOTA_MESSAGE = 'Session storage quota bytes exceeded. Values were not stored.';
export const LOCAL_QUOTA_MESSAGE = 'QUOTA_BYTES quota exceeded';

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

export type AreaName = 'session' | 'local';
export type AccessLevel = 'TRUSTED_CONTEXTS' | 'TRUSTED_AND_UNTRUSTED_CONTEXTS';
export type Items = Record<string, unknown>;
export interface StorageChange {
  oldValue?: unknown;
  newValue?: unknown;
}
export type StorageChanges = Record<string, StorageChange>;
export type Keys = string | string[] | Items | null | undefined;

export interface AreaOptions {
  /** Quota in bytes. Default 10 MB (10485760), like Chrome. Can be changed later: store.session.quotaBytes = n. */
  quotaBytes?: number;
  /** Milliseconds before results and change events are delivered. Default 0 (the next microtask). */
  delayMs?: number;
  /** Initial contents. JSON round-tripped and quota-checked like set(), but fires no events. */
  data?: Items;
}
export interface FakeStorageOptions {
  session?: AreaOptions;
  local?: AreaOptions;
}

/** One recorded API call. Trailing callbacks are not part of args. */
export interface Call {
  api: string;
  args: unknown[];
}

export interface StorageAreaLike {
  get(keys?: Keys): Promise<Items>;
  get(keys: Keys, callback: (items: Items) => void): void;
  set(items: Items): Promise<void>;
  set(items: Items, callback: () => void): void;
  remove(keys: string | string[]): Promise<void>;
  remove(keys: string | string[], callback: () => void): void;
  clear(): Promise<void>;
  clear(callback: () => void): void;
  getBytesInUse(keys?: string | string[] | null): Promise<number>;
  getBytesInUse(keys: string | string[] | null | undefined, callback: (bytes: number) => void): void;
  getKeys(): Promise<string[]>;
  getKeys(callback: (keys: string[]) => void): void;
  setAccessLevel(options: { accessLevel: AccessLevel }): Promise<void>;
  setAccessLevel(options: { accessLevel: AccessLevel }, callback: () => void): void;
  readonly QUOTA_BYTES: number;
  readonly onChanged: FakeEvent<[StorageChanges]>;
}

export interface StorageConnection {
  readonly local: StorageAreaLike;
  readonly session: StorageAreaLike;
  /** chrome.storage.onChanged: (changes, areaName). */
  readonly onChanged: FakeEvent<[StorageChanges, AreaName]>;
  readonly host: Host;
  /** What chrome.runtime.lastError shows right now (only set while a callback runs). */
  readonly lastError: { message: string } | undefined;
  /** The worker died: its listeners are dropped, it gets no more change events, and what it had queued never runs. Data stays in the store. */
  kill(): void;
}

// ---------------------------------------------------------------------------------------------
// Small shared primitives (also used by fakeChrome.ts)
// ---------------------------------------------------------------------------------------------

/** A Chrome-style runtime failure: delivered through lastError or a rejected promise. */
export class ChromeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChromeError';
  }
}

/** Deep copy of plain data. Functions and class instances (Map, ports...) are kept by reference. */
export function snapshot<T>(value: T, seen: WeakMap<object, unknown> = new WeakMap()): T {
  if (value === null || typeof value !== 'object') return value;
  const known = seen.get(value);
  if (known !== undefined) return known as T;
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) copy.push(snapshot(item, seen));
    return copy as T;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const key of Object.keys(value)) copy[key] = snapshot((value as Record<string, unknown>)[key], seen);
  return copy as T;
}

/** What crossing a JSON boundary does to a value (undefined stays undefined). */
export function jsonClone<T>(value: T): T {
  const text = JSON.stringify(value);
  return text === undefined ? (undefined as T) : (JSON.parse(text) as T);
}

/** Bytes one storage item counts for: UTF-8 bytes of its JSON text plus the key's UTF-8 bytes. */
export function storageBytes(key: string, value: unknown): number {
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError(`storageBytes: ${JSON.stringify(key)} has a value JSON cannot store`);
  return Buffer.byteLength(key, 'utf8') + Buffer.byteLength(json, 'utf8');
}

/**
 * Where chrome.runtime.lastError lives. It is set only while an API callback runs, and an error
 * that the callback never read is remembered in `unchecked` (Chrome logs "Unchecked
 * runtime.lastError" for those).
 */
export class ErrorSlot {
  #current: { message: string } | undefined;
  #read = false;
  readonly unchecked: string[] = [];

  get lastError(): { message: string } | undefined {
    if (this.#current) this.#read = true;
    return this.#current;
  }

  run(message: string, fn: () => void): void {
    this.#current = { message };
    this.#read = false;
    try {
      fn();
    } finally {
      if (!this.#read) this.unchecked.push(message);
      this.#current = undefined;
    }
  }
}

/** The call log, delivery queue and error slot that one fake "extension context" shares. */
export class Host {
  readonly calls: Call[] = [];
  readonly violations: Error[] = [];
  readonly errors = new ErrorSlot();
  /**
   * An error thrown by a listener during a queued delivery. By default it is rethrown, so it
   * becomes an uncaught exception and fails the test loudly (Chrome reports it in the console).
   * A test that expects such an error sets this to collect it instead.
   */
  onError: ((error: unknown) => void) | undefined;
  #pending = 0;
  #dead = false;

  record(api: string, args: unknown[]): void {
    if (this.#dead) {
      throw this.violation(`fakeChrome: ${api} was called after kill() - that worker is dead. Install the new fake chrome (and load a fresh copy of the code under test) instead`);
    }
    this.calls.push({ api, args: snapshot(args) });
  }

  /**
   * The worker died. Everything it had queued (callbacks, promise results, events) never runs, so
   * old code cannot keep going, and any further API call on it is a test mistake. Data in a shared
   * store is not affected.
   */
  kill(): void {
    this.#dead = true;
  }

  get dead(): boolean {
    return this.#dead;
  }

  /** A mistake in how the test set the fake up (undeclared API, exhausted script). Recorded, then thrown by the caller. */
  violation(message: string): Error {
    const error = new Error(message);
    error.name = 'FakeChromeError';
    this.violations.push(error);
    return error;
  }

  /** Run fn later (next microtask, or after delayMs), like Chrome's asynchronous delivery. */
  defer(fn: () => void, delayMs = 0): void {
    this.#pending++;
    const run = () => {
      try {
        if (!this.#dead) fn();
      } catch (error) {
        if (!this.onError) throw error;
        this.onError(error);
      } finally {
        this.#pending--;
      }
    };
    if (delayMs > 0) setTimeout(run, delayMs);
    else queueMicrotask(run);
  }

  /** Count a promise as pending work until it settles. */
  track<T>(promise: Promise<T>): Promise<T> {
    this.#pending++;
    const done = () => {
      this.#pending--;
    };
    promise.then(done, done);
    return promise;
  }

  /**
   * Resolves once every delivery the fake has queued has run (listeners and callbacks included),
   * including deliveries that wait for a delayMs timer. Gives up after 10 seconds with an error.
   */
  async settle(): Promise<void> {
    const giveUpAt = Date.now() + 10_000;
    for (;;) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (this.#pending === 0) return;
      if (Date.now() > giveUpAt) throw new Error('Host.settle: fake deliveries are still pending after 10 seconds (a scripted handler that never answers?)');
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
  }
}

/** chrome.*.onXxx: addListener, removeListener, hasListener, hasListeners. dispatch() is for tests. */
export class FakeEvent<A extends unknown[] = unknown[]> {
  #listeners: Array<(...args: A) => unknown> = [];
  #path: string | undefined;
  #host: Host | undefined;

  constructor(path?: string, host?: Host) {
    this.#path = path;
    this.#host = host;
  }

  addListener(listener: (...args: A) => unknown): void {
    if (typeof listener !== 'function') throw new TypeError(`${this.#path ?? 'event'}.addListener: listener must be a function`);
    this.#host?.record(`${this.#path}.addListener`, [listener]);
    if (!this.#listeners.includes(listener)) this.#listeners.push(listener);
  }

  removeListener(listener: (...args: A) => unknown): void {
    this.#host?.record(`${this.#path}.removeListener`, [listener]);
    const at = this.#listeners.indexOf(listener);
    if (at >= 0) this.#listeners.splice(at, 1);
  }

  hasListener(listener: (...args: A) => unknown): boolean {
    return this.#listeners.includes(listener);
  }

  hasListeners(): boolean {
    return this.#listeners.length > 0;
  }

  /**
   * Test side: call every listener in order. All of them run even if one throws, and the first
   * error is rethrown afterwards. Returns what the listeners returned.
   */
  dispatch(...args: A): unknown[] {
    const results: unknown[] = [];
    let failure: { error: unknown } | undefined;
    for (const listener of [...this.#listeners]) {
      try {
        results.push(listener(...args));
      } catch (error) {
        failure ??= { error };
      }
    }
    if (failure) throw failure.error;
    return results;
  }

  /** Test side: drop every listener (the worker died). */
  clear(): void {
    this.#listeners = [];
  }
}

type Impl = (...args: any[]) => unknown;
type Settled = { ok: true; value: unknown } | { ok: false; error: ChromeError };

function toSettled(value: unknown): Settled {
  if (value instanceof ChromeError) return { ok: false, error: value };
  if (value instanceof Error) return { ok: false, error: new ChromeError(value.message) };
  return { ok: true, value };
}

function invoke(host: Host, callback: (...args: unknown[]) => void, settled: Settled): void {
  if (settled.ok) {
    if (settled.value === undefined) callback();
    else callback(settled.value);
  } else {
    host.errors.run(settled.error.message, () => callback());
  }
}

/**
 * Wrap an implementation as a Chrome API that takes an optional trailing callback.
 * The implementation runs right away, in call order. Its result is delivered later: as a promise
 * when there is no callback, or through the callback (the call itself then returns undefined, like
 * Chrome). A failure is a rejected promise, or lastError set while the callback runs. The
 * implementation makes a call fail by throwing a ChromeError or by returning any Error. Any other
 * throw (a bad argument, a test mistake) reaches the caller synchronously, untouched.
 */
export function asyncApi(host: Host, api: string, impl: Impl, delayMs: () => number = () => 0): (...args: unknown[]) => unknown {
  return (...args: unknown[]): unknown => {
    const callback = typeof args[args.length - 1] === 'function' ? (args.pop() as (...a: unknown[]) => void) : undefined;
    host.record(api, args);
    let outcome: Settled | Promise<Settled>;
    try {
      const raw = impl(...args);
      outcome =
        raw instanceof Promise
          ? raw.then(toSettled, (error: unknown) => {
              if (error instanceof ChromeError) return toSettled(error);
              throw error;
            })
          : toSettled(raw);
    } catch (error) {
      if (!(error instanceof ChromeError)) throw error;
      outcome = toSettled(error);
    }
    const delay = delayMs();
    const finish = (settled: Settled): Promise<unknown> | undefined => {
      if (callback) {
        host.defer(() => invoke(host, callback, settled), delay);
        return undefined;
      }
      return new Promise((resolve, reject) => {
        host.defer(() => (settled.ok ? resolve(settled.value) : reject(new Error(settled.error.message))), delay);
      });
    };
    if (outcome instanceof Promise) {
      const tracked = host.track(outcome);
      if (callback) {
        tracked.then(finish, (error: unknown) =>
          queueMicrotask(() => {
            throw error;
          })
        );
        return undefined;
      }
      return tracked.then(finish);
    }
    return finish(outcome);
  };
}

/** Wrap an implementation as a Chrome API that returns synchronously (runtime.getURL, runtime.connect...). */
export function syncApi(host: Host, api: string, impl: Impl): (...args: unknown[]) => unknown {
  return (...args: unknown[]): unknown => {
    host.record(api, args);
    try {
      const value = impl(...args);
      if (value instanceof Error) throw value;
      return value;
    } catch (error) {
      if (error instanceof ChromeError) throw new Error(error.message);
      throw error;
    }
  };
}

// ---------------------------------------------------------------------------------------------
// The shared store
// ---------------------------------------------------------------------------------------------

function invalidInvocation(api: string, detail: string): TypeError {
  return new TypeError(`Error in invocation of ${api}: ${detail}`);
}

function isPlainObject(value: unknown): value is Items {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface View {
  onChanged: FakeEvent<[StorageChanges]>;
  root: FakeEvent<[StorageChanges, AreaName]>;
}

/** One area's shared data and quota. What a test inspects; workers reach it through connect(). */
export class StoreArea {
  readonly name: AreaName;
  quotaBytes: number;
  delayMs: number;
  accessLevel: AccessLevel = 'TRUSTED_CONTEXTS';
  #items = new Map<string, { json: string; bytes: number }>();
  #bytes = 0;
  #views = new Set<View>();

  constructor(name: AreaName, options: AreaOptions = {}) {
    this.name = name;
    this.quotaBytes = options.quotaBytes ?? DEFAULT_QUOTA_BYTES;
    this.delayMs = options.delayMs ?? 0;
    if (options.data) this.seed(options.data);
  }

  get quotaMessage(): string {
    return this.name === 'session' ? SESSION_QUOTA_MESSAGE : LOCAL_QUOTA_MESSAGE;
  }

  /** Keys, sorted so a test cannot depend on insertion order. */
  keys(): string[] {
    return [...this.#items.keys()].sort();
  }

  has(key: string): boolean {
    return this.#items.has(key);
  }

  /** Everything, as parsed JSON copies. */
  data(): Items {
    return this.read(null);
  }

  /** Total bytes in use, or of the given keys that exist. */
  bytesInUse(keys?: string | string[] | null): number {
    if (keys === undefined || keys === null) return this.#bytes;
    let total = 0;
    for (const key of new Set(typeof keys === 'string' ? [keys] : keys)) total += this.#items.get(key)?.bytes ?? 0;
    return total;
  }

  /** Bytes per key, to see which key is eating the quota. */
  usage(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const key of this.keys()) out[key] = this.#items.get(key)?.bytes ?? 0;
    return out;
  }

  /** Test setup: write items without events. Throws (a plain Error) if they do not fit the quota. */
  seed(items: Items): void {
    try {
      this.write(items);
    } catch (error) {
      throw error instanceof ChromeError ? new Error(`${this.name}.seed: ${error.message}`) : error;
    }
  }

  /** Test side: forget everything without events (a browser restart clears storage.session). */
  wipe(): void {
    this.#items.clear();
    this.#bytes = 0;
  }

  read(keys: unknown): Items {
    const out: Items = {};
    const pick = (key: string) => {
      const item = this.#items.get(key);
      if (item) out[key] = JSON.parse(item.json);
    };
    if (keys === undefined || keys === null) {
      for (const key of this.keys()) pick(key);
    } else if (typeof keys === 'string') {
      pick(keys);
    } else if (Array.isArray(keys)) {
      for (const key of keys) {
        if (typeof key !== 'string') throw invalidInvocation(`storage.${this.name}.get`, 'keys must be strings');
        pick(key);
      }
    } else if (isPlainObject(keys)) {
      const defaults = this.#roundTrip(keys);
      for (const key of Object.keys(defaults)) {
        const item = this.#items.get(key);
        out[key] = item ? JSON.parse(item.json) : defaults[key];
      }
    } else {
      throw invalidInvocation(`storage.${this.name}.get`, 'keys must be a string, an array, an object or null');
    }
    return out;
  }

  /** All or nothing: a write that goes over the quota changes nothing. */
  write(items: Items): StorageChanges {
    const plain = this.#roundTrip(items);
    const staged = new Map<string, { json: string; bytes: number }>();
    let total = this.#bytes;
    for (const key of Object.keys(plain)) {
      const json = JSON.stringify(plain[key]);
      const item = { json, bytes: storageBytes(key, plain[key]) };
      total += item.bytes - (this.#items.get(key)?.bytes ?? 0);
      staged.set(key, item);
    }
    if (total > this.quotaBytes) throw new ChromeError(this.quotaMessage);
    const changes: StorageChanges = {};
    for (const [key, item] of staged) {
      const old = this.#items.get(key);
      this.#items.set(key, item);
      if (old?.json === item.json) continue;
      changes[key] = old ? { oldValue: JSON.parse(old.json), newValue: JSON.parse(item.json) } : { newValue: JSON.parse(item.json) };
    }
    this.#bytes = total;
    return changes;
  }

  delete(keys: string[]): StorageChanges {
    const changes: StorageChanges = {};
    for (const key of keys) {
      const old = this.#items.get(key);
      if (!old) continue;
      this.#items.delete(key);
      this.#bytes -= old.bytes;
      changes[key] = { oldValue: JSON.parse(old.json) };
    }
    return changes;
  }

  /** Fire onChanged in every live connection. A throwing listener does not stop the others; the first error is rethrown at the end. */
  dispatch(changes: StorageChanges): void {
    if (Object.keys(changes).length === 0) return;
    let failure: { error: unknown } | undefined;
    for (const view of [...this.#views]) {
      const fires = [() => view.onChanged.dispatch(jsonClone(changes)), () => view.root.dispatch(jsonClone(changes), this.name)];
      for (const fire of fires) {
        try {
          fire();
        } catch (error) {
          failure ??= { error };
        }
      }
    }
    if (failure) throw failure.error;
  }

  attach(view: View): void {
    this.#views.add(view);
  }

  detach(view: View): void {
    this.#views.delete(view);
  }

  #roundTrip(items: Items): Items {
    try {
      return jsonClone(items);
    } catch (error) {
      throw new ChromeError(error instanceof Error ? error.message : String(error));
    }
  }
}

function makeView(area: StoreArea, host: Host, root: FakeEvent<[StorageChanges, AreaName]>): { api: StorageAreaLike; view: View } {
  const name = `storage.${area.name}`;
  const onChanged = new FakeEvent<[StorageChanges]>(`${name}.onChanged`, host);
  const view: View = { onChanged, root };
  const call = (method: string, impl: Impl) => asyncApi(host, `${name}.${method}`, impl, () => area.delayMs);
  /** The change events go out just before the caller's callback, like Chrome. */
  const emit = (changes: StorageChanges) => {
    if (Object.keys(changes).length > 0) host.defer(() => area.dispatch(changes), area.delayMs);
  };
  const stringList = (method: string, keys: unknown): string[] => {
    if (typeof keys === 'string') return [keys];
    if (Array.isArray(keys) && keys.every((k) => typeof k === 'string')) return keys as string[];
    throw invalidInvocation(`${name}.${method}`, 'keys must be a string or an array of strings');
  };
  const api = {
    get: call('get', (keys?: unknown) => area.read(keys)),
    set: call('set', (items: unknown) => {
      if (!isPlainObject(items)) throw invalidInvocation(`${name}.set`, 'items must be an object');
      emit(area.write(items));
    }),
    remove: call('remove', (keys: unknown) => {
      emit(area.delete(stringList('remove', keys)));
    }),
    clear: call('clear', () => {
      emit(area.delete(area.keys()));
    }),
    getBytesInUse: call('getBytesInUse', (keys?: unknown) =>
      area.bytesInUse(keys === undefined || keys === null ? null : stringList('getBytesInUse', keys))
    ),
    getKeys: call('getKeys', () => area.keys()),
    setAccessLevel: call('setAccessLevel', (options: unknown) => {
      const level = isPlainObject(options) ? options.accessLevel : undefined;
      if (level !== 'TRUSTED_CONTEXTS' && level !== 'TRUSTED_AND_UNTRUSTED_CONTEXTS') {
        throw invalidInvocation(`${name}.setAccessLevel`, 'accessLevel must be TRUSTED_CONTEXTS or TRUSTED_AND_UNTRUSTED_CONTEXTS');
      }
      area.accessLevel = level;
    }),
    onChanged,
  };
  Object.defineProperty(api, 'QUOTA_BYTES', { enumerable: true, get: () => area.quotaBytes });
  return { api: api as unknown as StorageAreaLike, view };
}

/** The backing data of chrome.storage.session and chrome.storage.local, shared by any number of connections. */
export class FakeStorage {
  readonly session: StoreArea;
  readonly local: StoreArea;

  constructor(options: FakeStorageOptions = {}) {
    this.session = new StoreArea('session', options.session);
    this.local = new StoreArea('local', options.local);
  }

  /**
   * A worker's (or a page's) view of the store: chrome.storage-shaped, with its own listeners and
   * call log. A write through one connection fires onChanged in every live connection.
   */
  connect(host: Host = new Host()): StorageConnection {
    const onChanged = new FakeEvent<[StorageChanges, AreaName]>('storage.onChanged', host);
    const local = makeView(this.local, host, onChanged);
    const session = makeView(this.session, host, onChanged);
    this.local.attach(local.view);
    this.session.attach(session.view);
    return {
      local: local.api,
      session: session.api,
      onChanged,
      host,
      get lastError() {
        return host.errors.lastError;
      },
      kill: () => {
        this.local.detach(local.view);
        this.session.detach(session.view);
        local.view.onChanged.clear();
        session.view.onChanged.clear();
        onChanged.clear();
        host.kill();
      },
    };
  }

  /** Both areas as parsed JSON copies. */
  snapshot(): { session: Items; local: Items } {
    return { session: this.session.data(), local: this.local.data() };
  }

  /** Bytes in use per area. */
  bytesInUse(): { session: number; local: number } {
    return { session: this.session.bytesInUse(), local: this.local.bytesInUse() };
  }
}

export function createFakeStorage(options?: FakeStorageOptions): FakeStorage {
  return new FakeStorage(options);
}
