/**
 * fakeChrome - one composable fake of the chrome.* surface, for Node tests.
 *
 * Declare only what a test needs. Everything else THROWS when the code under test touches it, with
 * a message that says how to declare it, so a missing API can never give a false green. (Each
 * such throw is also kept in fc.violations, in case the code under test swallows exceptions.)
 *
 * Example:
 *   import { fakeChrome } from './helpers/fakeChrome.ts';
 *   import { createFakeStorage } from './helpers/fakeStorageSession.ts';
 *
 *   const store = createFakeStorage();               // shared: a restarted worker gets the same store
 *   const fc = fakeChrome({
 *     tabs: { list: [{ id: 101, url: 'https://example.com/', windowId: 1 }] },
 *     tabGroups: true,
 *     storage: store,
 *     runtime: true,
 *     dom: { 101: { GET_DOM_SNAPSHOT: { success: true, data: { title: 'T', elements: [] } } } },
 *     debugger: { commands: { 'Page.captureScreenshot': { data: 'AAAA' } } },
 *   });
 *   globalThis.chrome = fc.chrome;                    // or: const restore = fc.install();
 *   await import('../background/background.js');
 *   fc.tabs.add({ id: 300, openerTabId: 101 });       // the user opens a tab: state + tabs.onCreated
 *   await fc.runtime.send({ action: 'START_TASK' });  // a side panel sendMessage round trip
 *   fc.callsTo('tabs.group');                         // [{ api: 'tabs.group', args: [...] }]
 *   fc.chrome.tabs.captureVisibleTab;                 // throws: ... was not declared for this test - add it to
 *                                                     //   fakeChrome({ tabs: { methods: { captureVisibleTab: ... } } })
 *
 * Declaring a namespace gives its built-in behaviours (in-memory, with events, both call styles):
 *   tabs, tabGroups (+ tabs.group/ungroup), windows, storage (local + session + onChanged),
 *   runtime, sidePanel, scripting, debugger, alarms, declarativeNetRequest, action.
 *   `dom` is not a chrome.* API: it is the CONTENT-SCRIPT side, i.e. per-tab message handlers that
 *   answer chrome.tabs.sendMessage. There is no fake DOM here.
 *   chrome.runtime always exists with just id and lastError; the rest of runtime needs runtime: true.
 *   `sidePanel: false` means "this browser has no such API": chrome.sidePanel is undefined (no throw).
 *   `'sidePanel' in chrome` never throws: it says whether the namespace is declared.
 *
 * Timing: events and callbacks arrive a moment after the call that caused them, like Chrome.
 *   `await fc.settle()` before you assert on them. Actions you do through the handles (fc.tabs.add,
 *   fc.alarms.fire, fc.fire(...)) call the listeners at once.
 *
 * Worker restart: fc.kill() the old one (its queued work never runs, its ports disconnect), then
 *   make a NEW fakeChrome({ storage: sameStore, ... }). Storage data survives; listeners, the call
 *   log, tabs and alarms belong to each fake, so the test declares them again.
 *
 * Scripted results (scripting.executeScript, debugger commands, dom handlers, methods: {...}):
 *   a value      returned on every call (JSON-cloned for messages, CDP and script results)
 *   an Error     the call fails: rejected promise, or lastError inside the callback
 *   an array     one entry per call, in order. When it runs out, the call THROWS a clear error
 *   a function   called with the call's arguments; returns a value or an Error (or a promise of one)
 *   A function that throws is a bug in the test: the throw reaches the caller untouched.
 *
 * What is a Chrome failure and what is a test mistake:
 *   Failures Chrome itself would report (no tab with that id, quota exceeded, no receiving end, an
 *   Error you scripted) reject the promise or set chrome.runtime.lastError in the callback.
 *   Test mistakes (undeclared API, unscripted call, exhausted script, unknown option) throw
 *   synchronously.
 */

import { ChromeError, FakeEvent, FakeStorage, Host, asyncApi, jsonClone, snapshot, syncApi } from './fakeStorageSession.ts';
import type { Call, FakeStorageOptions } from './fakeStorageSession.ts';

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

/** A scripted result: a value, an Error, an array of those (one per call) or a function. */
export type Scripted = unknown;

export interface Tab {
  id: number;
  index: number;
  windowId: number;
  groupId: number;
  active: boolean;
  highlighted: boolean;
  pinned: boolean;
  incognito: boolean;
  discarded: boolean;
  autoDiscardable: boolean;
  audible: boolean;
  status: string;
  url: string;
  title: string;
  pendingUrl?: string;
  openerTabId?: number;
  [key: string]: unknown;
}
export type TabInit = Partial<Tab>;

export interface WindowState {
  id: number;
  focused: boolean;
  type: string;
  state: string;
  incognito: boolean;
  alwaysOnTop: boolean;
  left: number;
  top: number;
  width: number;
  height: number;
  [key: string]: unknown;
}
export type WindowInit = Partial<WindowState>;

export interface GroupState {
  id: number;
  windowId: number;
  title: string;
  color: string;
  collapsed: boolean;
}
export type GroupInit = Partial<GroupState>;

/** Options every namespace accepts. */
export interface Extras {
  /** Extra or replacement methods: { captureVisibleTab: 'data:image/png;base64,AAAA' } (a value, an Error, an array or a function). */
  methods?: Record<string, Scripted>;
  /** Extra events, e.g. ['onReplaced']. Fire them with fc.fire('tabs.onReplaced', ...). */
  events?: string[];
}
export interface TabsOptions extends Extras {
  /** Tabs that exist at the start: any Chrome Tab fields, the rest gets Chrome-like defaults. */
  list?: TabInit[];
  /** 'instant' (default): a navigation finishes by itself (status loading, then complete). 'manual': it stays loading until fc.tabs.completeLoad(id). */
  navigation?: 'instant' | 'manual';
}
export interface TabGroupsOptions extends Extras {
  list?: GroupInit[];
}
export interface WindowsOptions extends Extras {
  list?: WindowInit[];
}
export interface RuntimeOptions extends Extras {
  /** Extension id. Default: 32 letters, like a real one. */
  id?: string;
  manifest?: Record<string, unknown>;
  platform?: Record<string, unknown>;
  /** Answers to chrome.runtime.sendMessage calls made BY the code under test. Default: no receiving end. */
  sendMessage?: Scripted;
}
export interface SidePanelOptions extends Extras {
  /** Outcomes of chrome.sidePanel.open: an Error refuses, anything else lets it open. Default: it opens. */
  open?: Scripted;
}
export interface ScriptingOptions extends Extras {
  /** Results of chrome.scripting.executeScript. A plain value becomes [{ frameId: 0, result: value }]; an array entry is the full results array. */
  executeScript?: Scripted;
}
export interface DebuggerOptions extends Extras {
  /** Outcomes of chrome.debugger.attach: an Error refuses (e.g. new Error('Cannot attach to this target.')), anything else lets it attach. */
  attach?: Scripted;
  /** CDP results per method. A function gets (params, target). */
  commands?: Record<string, Scripted>;
  /** Fallback for CDP methods without an entry in commands. A function gets (method, params, target). */
  sendCommand?: Scripted;
}
export interface AlarmsOptions extends Extras {}
export interface DnrOptions extends Extras {
  dynamicRules?: Array<Record<string, unknown>>;
  sessionRules?: Array<Record<string, unknown>>;
}
export interface ActionOptions extends Extras {}

/** Per-tab content-script handlers: a function for every message, or a map from message.action to a scripted result. */
export type DomHandler = ((message: unknown, sender: unknown) => unknown) | Record<string, Scripted>;

export interface FakeChromeOptions {
  tabs?: TabsOptions | boolean;
  tabGroups?: TabGroupsOptions | boolean;
  windows?: WindowsOptions | boolean;
  storage?: FakeStorage | FakeStorageOptions | boolean;
  runtime?: RuntimeOptions | boolean;
  sidePanel?: SidePanelOptions | boolean;
  scripting?: ScriptingOptions | boolean;
  debugger?: DebuggerOptions | boolean;
  alarms?: AlarmsOptions | boolean;
  declarativeNetRequest?: DnrOptions | boolean;
  action?: ActionOptions | boolean;
  /** Content-script side: { [tabId]: handler }. Needs tabs. */
  dom?: Record<number, DomHandler> | boolean;
}

type Fn = (...args: any[]) => unknown;
type How = 'sync' | 'later';

// ---------------------------------------------------------------------------------------------
// Constants and small helpers
// ---------------------------------------------------------------------------------------------

const NEW_TAB_URL = 'chrome://newtab/';
const NO_RECEIVER = 'Could not establish connection. Receiving end does not exist.';
const PORT_CLOSED = 'The message port closed before a response was received.';
const GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
/** Keys that tools probe on any object (await, JSON.stringify, assert diffs, test frameworks). They never throw. */
const PROBES = new Set(['then', 'toJSON', 'inspect', 'asymmetricMatch', '$$typeof', 'nodeType', 'tagName', '_isMockFunction', '__esModule']);
const INSPECT = Symbol.for('nodejs.util.inspect.custom');
const NAMESPACES = ['tabs', 'tabGroups', 'windows', 'storage', 'runtime', 'sidePanel', 'scripting', 'debugger', 'alarms', 'declarativeNetRequest', 'action'];

function invalid(api: string, detail = 'No matching signature.'): TypeError {
  return new TypeError(`Error in invocation of ${api}: ${detail}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Throws (like Chrome's schema check) when an options object has a key that is not allowed. */
function checkKeys(api: string, value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!isObject(value)) throw invalid(api, 'expected an object');
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw invalid(api, `Unexpected property: '${key}'.`);
  }
  return value;
}

function intArg(api: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw invalid(api);
  return value;
}

function idList(api: string, value: unknown): number[] {
  const list = Array.isArray(value) ? value : [value];
  if (list.length === 0) throw invalid(api, 'at least one id is required.');
  return list.map((id) => intArg(api, id));
}

function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 's');
}

/** chrome.tabs.query url match patterns: <all_urls> and scheme://host/path with * wildcards. */
function matchesPattern(pattern: string, url: string): boolean {
  if (pattern === '<all_urls>') return /^(https?|file|ftp|wss?):/i.test(url);
  const parts = /^(\*|[a-z-]+):\/\/([^/]*)(\/.*)$/i.exec(pattern);
  if (!parts) throw invalid('tabs.query', `Invalid url pattern '${pattern}'`);
  const [, scheme = '', host = '', path = ''] = parts;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const protocol = parsed.protocol.slice(0, -1);
  if (scheme === '*' ? protocol !== 'http' && protocol !== 'https' : scheme.toLowerCase() !== protocol) return false;
  const hostname = parsed.hostname.toLowerCase();
  const wanted = host.toLowerCase();
  if (wanted !== '*') {
    if (wanted.startsWith('*.')) {
      if (hostname !== wanted.slice(2) && !hostname.endsWith(wanted.slice(1))) return false;
    } else if (hostname !== wanted) return false;
  }
  return globToRegExp(path).test(parsed.pathname + parsed.search);
}

// ---------------------------------------------------------------------------------------------
// Scripted results
// ---------------------------------------------------------------------------------------------

/** Turn a Scripted into a function (see the header comment for the rules). */
function scripted(host: Host, label: string, script: Scripted): Fn {
  if (typeof script === 'function') return script as Fn;
  if (Array.isArray(script)) {
    const queue = [...script];
    let calls = 0;
    return (...args: unknown[]) => {
      calls++;
      if (queue.length === 0) {
        const size = script.length;
        throw host.violation(
          `fakeChrome: ${label} was called ${calls} times but only ${size} result${size === 1 ? ' was' : 's were'} scripted - add more entries to the array, or use a function`
        );
      }
      const entry = queue.shift();
      return typeof entry === 'function' ? (entry as Fn)(...args) : entry;
    };
  }
  return () => script;
}

/** Like scripted(), for options where an Error refuses and anything else means "go ahead". Handlers must be synchronous. */
function gate(host: Host, label: string, script: Scripted): Fn {
  const next = scripted(host, label, script);
  return (...args: unknown[]) => {
    const out = next(...args);
    if (out instanceof Promise) throw host.violation(`fakeChrome: ${label} outcomes must be synchronous (got a promise)`);
    return out instanceof Error ? out : undefined;
  };
}

/** A reply to a message (tabs.sendMessage or runtime.sendMessage): undefined means nobody answered. */
function reply(value: unknown): unknown {
  if (value instanceof Error) return value;
  if (value === undefined) return new ChromeError(PORT_CLOSED);
  return jsonClone(value);
}

function afterwards(value: unknown, fn: (v: unknown) => unknown): unknown {
  return value instanceof Promise ? value.then(fn) : fn(value);
}

// ---------------------------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------------------------

export class FakePort {
  name: string;
  /** Set on the end that onConnect listeners get. */
  sender: Record<string, unknown> | undefined;
  onMessage: FakeEvent<[unknown, FakePort]>;
  onDisconnect: FakeEvent<[FakePort]>;
  /** Test side: every message that has arrived at this end. */
  received: unknown[] = [];
  #host: Host;
  #peer: FakePort | undefined;
  #closed = false;

  constructor(host: Host, name: string, sender?: Record<string, unknown>) {
    this.name = name;
    this.sender = sender;
    this.#host = host;
    this.onMessage = new FakeEvent();
    this.onDisconnect = new FakeEvent();
  }

  /** Two connected ends: `client` (what runtime.connect returns) and `server` (what onConnect listeners get). */
  static pair(host: Host, name: string, sender?: Record<string, unknown>): { client: FakePort; server: FakePort } {
    const client = new FakePort(host, name);
    const server = new FakePort(host, name, sender);
    client.#peer = server;
    server.#peer = client;
    return { client, server };
  }

  postMessage(message: unknown): void {
    if (this.#closed) throw new Error('Attempting to use a disconnected port object');
    const copy = jsonClone(message);
    const peer = this.#peer as FakePort;
    this.#host.defer(() => {
      peer.received.push(copy);
      peer.onMessage.dispatch(copy, peer);
    });
  }

  disconnect(): void {
    if (this.#closed) return;
    const peer = this.#peer as FakePort;
    this.#closed = true;
    peer.#closed = true;
    this.#host.defer(() => peer.onDisconnect.dispatch(peer));
  }

  /** The owner of this end died: both ends close and the OTHER end hears onDisconnect right away. */
  sever(): void {
    if (this.#closed) return;
    const peer = this.#peer as FakePort;
    this.#closed = true;
    peer.#closed = true;
    peer.onDisconnect.dispatch(peer);
  }
}

// ---------------------------------------------------------------------------------------------
// The browser state behind tabs, tabGroups and windows
// ---------------------------------------------------------------------------------------------

interface Effects {
  fire(how: How, path: string, ...args: unknown[]): void;
  step(how: How, fn: () => void): void;
}

class World {
  readonly tabs: Tab[] = [];
  readonly windows = new Map<number, WindowState>();
  readonly groups = new Map<number, GroupState>();
  focusedWindowId: number | undefined;
  navigation: 'instant' | 'manual' = 'instant';
  #nextTabId = 1000;
  #nextWindowId = 1;
  #nextGroupId = 1;
  #fx: Effects;

  constructor(fx: Effects) {
    this.#fx = fx;
  }

  // ----- lookups

  tab(id: number): Tab | undefined {
    return this.tabs.find((t) => t.id === id);
  }

  mustTab(id: number): Tab {
    const tab = this.tab(id);
    if (!tab) throw new ChromeError(`No tab with id: ${id}.`);
    return tab;
  }

  windowTabs(windowId: number): Tab[] {
    return this.tabs.filter((t) => t.windowId === windowId);
  }

  /** Tabs in Chrome's order: window by window, by index. */
  orderedTabs(): Tab[] {
    return [...this.windows.keys()].flatMap((id) => this.windowTabs(id));
  }

  mustGroup(id: number): GroupState {
    const group = this.groups.get(id);
    if (!group) throw new ChromeError(`No group with id: ${id}.`);
    return group;
  }

  /** WINDOW_ID_CURRENT (-2) means the focused window. */
  resolveWindow(id: number): WindowState {
    const windowId = id === -2 ? this.focusedWindowId : id;
    const found = windowId === undefined ? undefined : this.windows.get(windowId);
    if (!found) throw new ChromeError(`No window with id: ${id}.`);
    return found;
  }

  activeTab(): Tab | undefined {
    return this.tabs.find((t) => t.active && t.windowId === this.focusedWindowId);
  }

  // ----- windows

  ensureWindow(id: number): WindowState {
    let found = this.windows.get(id);
    if (!found) {
      found = { id, focused: false, type: 'normal', state: 'normal', incognito: false, alwaysOnTop: false, left: 0, top: 0, width: 1280, height: 800 };
      this.windows.set(id, found);
      this.#nextWindowId = Math.max(this.#nextWindowId, id + 1);
      if (this.focusedWindowId === undefined) this.#setFocus(id);
    }
    return found;
  }

  #anyWindowId(): number {
    return this.focusedWindowId ?? this.ensureWindow(this.#nextWindowId).id;
  }

  #setFocus(id: number): void {
    for (const w of this.windows.values()) w.focused = w.id === id;
    this.focusedWindowId = id;
  }

  seedWindow(init: WindowInit): WindowState {
    const id = init.id ?? this.#nextWindowId;
    if (this.windows.has(id)) throw new Error(`fakeChrome: window id ${id} already exists`);
    const found = this.ensureWindow(id);
    const { focused, ...rest } = init;
    Object.assign(found, rest);
    if (focused) this.#setFocus(id);
    return found;
  }

  createWindow(data: Record<string, unknown>, how: How): WindowState {
    const id = this.#nextWindowId++;
    const found = this.ensureWindow(id);
    for (const key of ['left', 'top', 'width', 'height', 'incognito', 'type', 'state']) {
      if (data[key] !== undefined) found[key] = data[key];
    }
    this.#fx.fire(how, 'windows.onCreated', snapshot(found));
    if (typeof data.tabId === 'number') {
      this.moveToWindow(this.mustTab(data.tabId), id, how);
    } else {
      const urls = data.url === undefined ? [NEW_TAB_URL] : Array.isArray(data.url) ? data.url : [data.url];
      urls.forEach((url, i) => this.createTab({ windowId: id, url, active: i === 0 }, how));
    }
    if (data.focused !== false) this.focusWindow(id, how);
    return found;
  }

  focusWindow(id: number, how: How): void {
    const found = this.resolveWindow(id);
    if (this.focusedWindowId === found.id) return;
    this.#setFocus(found.id);
    this.#fx.fire(how, 'windows.onFocusChanged', found.id);
  }

  removeWindow(id: number, how: How): void {
    const found = this.resolveWindow(id);
    for (const tab of this.windowTabs(found.id)) this.removeTab(tab.id, how, true);
    this.windows.delete(found.id);
    for (const group of [...this.groups.values()]) if (group.windowId === found.id) this.#dropGroup(group.id, how);
    this.#fx.fire(how, 'windows.onRemoved', found.id);
    if (this.focusedWindowId === found.id) {
      const next = [...this.windows.keys()][0];
      this.focusedWindowId = undefined;
      if (next !== undefined) this.#setFocus(next);
      this.#fx.fire(how, 'windows.onFocusChanged', next ?? -1);
    }
  }

  // ----- tabs

  reindex(windowId: number): void {
    this.windowTabs(windowId).forEach((t, i) => {
      t.index = i;
    });
  }

  /** A tab that already exists at setup time or was added by the user: committed, no events. */
  seedTab(init: TabInit): Tab {
    const windowId = init.windowId ?? this.#anyWindowId();
    this.ensureWindow(windowId);
    const id = init.id ?? this.#nextTabId;
    if (this.tab(id)) throw new Error(`fakeChrome: tab id ${id} already exists`);
    this.#nextTabId = Math.max(this.#nextTabId, id + 1);
    const tab: Tab = {
      index: 0,
      groupId: -1,
      active: false,
      highlighted: false,
      pinned: false,
      incognito: false,
      discarded: false,
      autoDiscardable: true,
      audible: false,
      status: 'complete',
      url: '',
      title: '',
      ...init,
      id,
      windowId,
    };
    tab.highlighted = init.highlighted ?? tab.active;
    this.tabs.push(tab);
    this.reindex(windowId);
    if (tab.groupId !== -1 && !this.groups.has(tab.groupId)) {
      this.groups.set(tab.groupId, { id: tab.groupId, windowId, title: '', color: 'grey', collapsed: false });
      this.#nextGroupId = Math.max(this.#nextGroupId, tab.groupId + 1);
    }
    return tab;
  }

  /** A tab the user (or a page) opens while the code runs: it exists at once and tabs.onCreated fires. */
  addTab(init: TabInit, how: How): Tab {
    const wantActive = init.active === true;
    const tab = this.seedTab({ ...init, active: false });
    if (wantActive || this.windowTabs(tab.windowId).length === 1) this.#makeActive(tab);
    this.#fx.fire(how, 'tabs.onCreated', snapshot(tab));
    if (tab.active) this.#fx.fire(how, 'tabs.onActivated', { tabId: tab.id, windowId: tab.windowId });
    return tab;
  }

  /** After seeding: every window has exactly one active tab. */
  settleActive(): void {
    for (const id of this.windows.keys()) {
      const tabs = this.windowTabs(id);
      const active = tabs.filter((t) => t.active);
      if (active.length > 1) throw new Error(`fakeChrome: window ${id} has ${active.length} active tabs (${active.map((t) => t.id).join(', ')}); a window has exactly one`);
      const first = tabs[0];
      if (active.length === 0 && first) {
        first.active = true;
        first.highlighted = true;
      }
    }
  }

  /** chrome.tabs.create: the tab starts loading; the URL commits a moment later. */
  createTab(props: Record<string, unknown>, how: How): Tab {
    const window = typeof props.windowId === 'number' ? this.resolveWindow(props.windowId) : this.ensureWindow(this.#anyWindowId());
    const url = typeof props.url === 'string' ? props.url : NEW_TAB_URL;
    const wantActive = props.active !== false;
    const opener = typeof props.openerTabId === 'number' ? this.mustTab(props.openerTabId) : undefined;
    const tab = this.seedTab({
      windowId: window.id,
      url: '',
      pendingUrl: url,
      status: 'loading',
      pinned: props.pinned === true,
      ...(opener ? { openerTabId: opener.id } : {}),
    });
    if (typeof props.index === 'number') this.#moveInWindow(tab, props.index);
    const active = wantActive || this.windowTabs(window.id).length === 1;
    if (active) this.#makeActive(tab);
    this.#fx.fire(how, 'tabs.onCreated', snapshot(tab));
    if (active) this.#fx.fire(how, 'tabs.onActivated', { tabId: tab.id, windowId: window.id });
    this.#commit(tab, url, how);
    return tab;
  }

  #moveInWindow(tab: Tab, index: number): void {
    const others = this.windowTabs(tab.windowId).filter((t) => t !== tab);
    const before = others[Math.max(0, Math.min(index, others.length))];
    this.tabs.splice(this.tabs.indexOf(tab), 1);
    if (before) this.tabs.splice(this.tabs.indexOf(before), 0, tab);
    else this.tabs.push(tab);
    this.reindex(tab.windowId);
  }

  #makeActive(tab: Tab): void {
    for (const t of this.windowTabs(tab.windowId)) {
      t.active = t === tab;
      t.highlighted = t.active;
    }
  }

  activate(tab: Tab, how: How): void {
    if (tab.active) return;
    this.#makeActive(tab);
    this.#fx.fire(how, 'tabs.onActivated', { tabId: tab.id, windowId: tab.windowId });
  }

  /** Start a navigation: the URL commits and status goes loading (then complete, unless navigation is 'manual'). */
  navigate(tab: Tab, url: string, how: How): void {
    tab.pendingUrl = url;
    this.#commit(tab, url, how);
  }

  #commit(tab: Tab, url: string, how: How): void {
    this.#fx.step(how, () => {
      if (!this.tab(tab.id)) return;
      tab.url = url;
      delete tab.pendingUrl;
      tab.status = 'loading';
      this.#fx.fire(how, 'tabs.onUpdated', tab.id, { status: 'loading', url }, snapshot(tab));
      if (this.navigation === 'instant') this.completeLoad(tab, {}, how);
    });
  }

  completeLoad(tab: Tab, details: { title?: string }, how: How): void {
    this.#fx.step(how, () => {
      if (!this.tab(tab.id)) return;
      tab.status = 'complete';
      const changeInfo: Record<string, unknown> = { status: 'complete' };
      if (details.title !== undefined) {
        tab.title = details.title;
        changeInfo.title = details.title;
      }
      this.#fx.fire(how, 'tabs.onUpdated', tab.id, changeInfo, snapshot(tab));
    });
  }

  updateTab(tab: Tab, props: Record<string, unknown>, how: How): void {
    const changed: Record<string, unknown> = {};
    if (typeof props.url === 'string') this.navigate(tab, props.url, how);
    if (props.active === true) this.activate(tab, how);
    if (typeof props.highlighted === 'boolean' && !tab.active) tab.highlighted = props.highlighted;
    for (const key of ['pinned', 'autoDiscardable']) {
      if (typeof props[key] === 'boolean' && tab[key] !== props[key]) {
        tab[key] = props[key];
        changed[key] = props[key];
      }
    }
    if (typeof props.muted === 'boolean') {
      tab.mutedInfo = { muted: props.muted, reason: 'extension' };
      changed.mutedInfo = tab.mutedInfo;
    }
    if (typeof props.openerTabId === 'number') tab.openerTabId = props.openerTabId;
    if (Object.keys(changed).length > 0) this.#fx.fire(how, 'tabs.onUpdated', tab.id, changed, snapshot(tab));
  }

  removeTab(id: number, how: How, windowClosing = false): void {
    const tab = this.mustTab(id);
    this.tabs.splice(this.tabs.indexOf(tab), 1);
    this.reindex(tab.windowId);
    this.#fx.fire(how, 'tabs.onRemoved', id, { windowId: tab.windowId, isWindowClosing: windowClosing });
    if (tab.groupId !== -1) this.#dropGroupIfEmpty(tab.groupId, how);
    if (windowClosing) return;
    const rest = this.windowTabs(tab.windowId);
    const next = rest[Math.min(tab.index, rest.length - 1)];
    if (!next) this.removeWindow(tab.windowId, how);
    else if (tab.active) this.activate(next, how);
  }

  moveToWindow(tab: Tab, windowId: number, how: How): void {
    if (tab.windowId === windowId) return;
    const from = tab.windowId;
    const oldIndex = tab.index;
    const wasActive = tab.active;
    this.ensureWindow(windowId);
    tab.windowId = windowId;
    tab.active = false;
    tab.highlighted = false;
    this.tabs.splice(this.tabs.indexOf(tab), 1);
    this.tabs.push(tab);
    this.reindex(from);
    this.reindex(windowId);
    if (this.windowTabs(windowId).length === 1) this.#makeActive(tab);
    const rest = this.windowTabs(from);
    const next = rest[Math.min(oldIndex, rest.length - 1)];
    if (!next) this.removeWindow(from, how);
    else if (wasActive) this.activate(next, how);
  }

  // ----- groups

  seedGroup(init: GroupInit): GroupState {
    const id = init.id ?? this.#nextGroupId;
    if (this.groups.has(id)) throw new Error(`fakeChrome: tab group id ${id} already exists`);
    this.#nextGroupId = Math.max(this.#nextGroupId, id + 1);
    const windowId = init.windowId ?? this.#anyWindowId();
    this.ensureWindow(windowId);
    const group: GroupState = { title: '', color: 'grey', collapsed: false, ...init, id, windowId };
    this.groups.set(id, group);
    return group;
  }

  groupTabs(ids: number[], groupId: number | undefined, createWindowId: number | undefined, how: How): number {
    const tabs = ids.map((id) => this.mustTab(id));
    let group: GroupState;
    if (groupId !== undefined) {
      group = this.mustGroup(groupId);
    } else {
      // Like Chrome: a NEW group lands in createProperties.windowId, or else the current (focused)
      // window, and the tabs move there with it - even from another window.
      const windowId = createWindowId !== undefined ? this.resolveWindow(createWindowId).id : this.#anyWindowId();
      group = this.seedGroup({ windowId });
      this.#fx.fire(how, 'tabGroups.onCreated', snapshot(group));
    }
    const previous = new Set<number>();
    for (const tab of tabs) {
      if (tab.groupId === group.id) continue;
      if (tab.groupId !== -1) previous.add(tab.groupId);
      this.moveToWindow(tab, group.windowId, how);
      tab.groupId = group.id;
      this.#fx.fire(how, 'tabs.onUpdated', tab.id, { groupId: group.id }, snapshot(tab));
    }
    for (const gid of previous) this.#dropGroupIfEmpty(gid, how);
    return group.id;
  }

  ungroupTabs(ids: number[], how: How): void {
    const tabs = ids.map((id) => this.mustTab(id));
    const previous = new Set<number>();
    for (const tab of tabs) {
      if (tab.groupId === -1) continue;
      previous.add(tab.groupId);
      tab.groupId = -1;
      this.#fx.fire(how, 'tabs.onUpdated', tab.id, { groupId: -1 }, snapshot(tab));
    }
    for (const gid of previous) this.#dropGroupIfEmpty(gid, how);
  }

  updateGroup(id: number, props: Record<string, unknown>, how: How): GroupState {
    const group = this.mustGroup(id);
    if (props.color !== undefined && !GROUP_COLORS.includes(props.color as string)) {
      throw invalid('tabGroups.update', `color must be one of ${GROUP_COLORS.join(', ')}`);
    }
    Object.assign(group, props);
    this.#fx.fire(how, 'tabGroups.onUpdated', snapshot(group));
    return group;
  }

  /** The user removes a group: its tabs are ungrouped, the group is gone. */
  removeGroup(id: number, how: How): void {
    this.mustGroup(id);
    this.ungroupTabs(this.tabs.filter((t) => t.groupId === id).map((t) => t.id), how);
    this.#dropGroup(id, how);
  }

  #dropGroupIfEmpty(id: number, how: How): void {
    if (!this.tabs.some((t) => t.groupId === id)) this.#dropGroup(id, how);
  }

  #dropGroup(id: number, how: How): void {
    const group = this.groups.get(id);
    if (!group) return;
    this.groups.delete(id);
    this.#fx.fire(how, 'tabGroups.onRemoved', snapshot(group));
  }

  // ----- queries

  query(q: Record<string, unknown>): Tab[] {
    return this.orderedTabs().filter((tab) => this.#matches(tab, q));
  }

  #matches(tab: Tab, q: Record<string, unknown>): boolean {
    for (const [key, want] of Object.entries(q)) {
      if (want === undefined) continue;
      switch (key) {
        case 'active':
        case 'pinned':
        case 'highlighted':
        case 'discarded':
        case 'autoDiscardable':
        case 'audible':
        case 'status':
        case 'groupId':
        case 'index':
          if (tab[key] !== want) return false;
          break;
        case 'muted':
          if ((isObject(tab.mutedInfo) ? tab.mutedInfo.muted === true : false) !== want) return false;
          break;
        case 'windowId':
          if (tab.windowId !== (want === -2 ? this.focusedWindowId : want)) return false;
          break;
        case 'currentWindow':
        case 'lastFocusedWindow':
          if ((tab.windowId === this.focusedWindowId) !== want) return false;
          break;
        case 'windowType':
          if (this.windows.get(tab.windowId)?.type !== want) return false;
          break;
        case 'title':
          if (!globToRegExp(String(want)).test(tab.title)) return false;
          break;
        case 'url':
          if (!(Array.isArray(want) ? want : [want]).some((p) => matchesPattern(String(p), tab.url))) return false;
          break;
        default:
          throw invalid('tabs.query', `fakeChrome does not implement the '${key}' filter; extend tests/helpers/fakeChrome.ts or replace it with fakeChrome({ tabs: { methods: { query: ... } } })`);
      }
    }
    return true;
  }
}

// ---------------------------------------------------------------------------------------------
// Content-script side
// ---------------------------------------------------------------------------------------------

class DomRegistry {
  #host: Host;
  #handlers = new Map<number, DomHandler>();
  #invokers = new Map<string, Fn>();

  constructor(host: Host) {
    this.#host = host;
  }

  set(tabId: number, handler: DomHandler): void {
    this.remove(tabId);
    this.#handlers.set(tabId, handler);
  }

  on(tabId: number, action: string, script: Scripted): void {
    const current = this.#handlers.get(tabId);
    if (typeof current === 'function') throw new Error(`fakeChrome: dom handler for tab ${tabId} is a function; use fc.dom.set(${tabId}, {...}) to switch to per-action handlers`);
    this.#invokers.delete(`${tabId}:${action}`);
    this.#handlers.set(tabId, { ...(current ?? {}), [action]: script });
  }

  remove(tabId: number): void {
    this.#handlers.delete(tabId);
    for (const key of [...this.#invokers.keys()]) if (key.startsWith(`${tabId}:`)) this.#invokers.delete(key);
  }

  has(tabId: number): boolean {
    return this.#handlers.has(tabId);
  }

  /** The raw answer of the content script on tabId, or undefined when no content script is there. */
  answer(tabId: number, message: unknown, sender: unknown): { present: boolean; value?: unknown } {
    const handler = this.#handlers.get(tabId);
    if (handler === undefined) return { present: false };
    if (typeof handler === 'function') return { present: true, value: handler(message, sender) };
    const action = isObject(message) ? (typeof message.action === 'string' ? message.action : typeof message.type === 'string' ? message.type : undefined) : undefined;
    if (action === undefined || !Object.hasOwn(handler, action)) {
      const what = action === undefined ? 'a message without action/type' : `action '${action}'`;
      throw this.#host.violation(`fakeChrome: the dom handler for tab ${tabId} has no answer for ${what} - add it to fakeChrome({ dom: { ${tabId}: { ${action ?? 'ACTION'}: ... } } })`);
    }
    const key = `${tabId}:${action}`;
    let invoke = this.#invokers.get(key);
    if (!invoke) {
      invoke = scripted(this.#host, `the dom handler for '${action}' on tab ${tabId}`, handler[action]);
      this.#invokers.set(key, invoke);
    }
    return { present: true, value: invoke(message, sender) };
  }
}

// ---------------------------------------------------------------------------------------------
// Namespace builders
// ---------------------------------------------------------------------------------------------

interface Ctx {
  host: Host;
  world: World;
  events: Map<string, FakeEvent<any>>;
  event(path: string): FakeEvent<any>;
  runtimeId: string;
  dom: DomRegistry | undefined;
  /** Whether the test declared tabs: without it, APIs that take a tab id do not check that the tab exists. */
  hasTabs: boolean;
  /** The worker's end of every port; kill() severs them so the other side hears onDisconnect. */
  workerPorts: FakePort[];
}

interface Built {
  api: Record<string, unknown>;
  handle?: Record<string, unknown>;
}

/** Methods that return synchronously in Chrome (a scripted replacement must not become a promise). */
const SYNC_METHODS = new Set(['runtime.getURL', 'runtime.getManifest', 'runtime.connect']);

/** The options object of a namespace (`true` means all defaults). Unknown keys throw, so a typo cannot pass silently. */
function options<T extends object>(ns: string, value: T | boolean | undefined, known: string[]): T {
  const opts = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const allowed = [...known, 'methods', 'events'];
  for (const key of Object.keys(opts)) {
    if (!allowed.includes(key)) throw new Error(`fakeChrome: unknown option "${key}" in fakeChrome({ ${ns}: {...} }); known options: ${allowed.join(', ')}`);
  }
  return opts as T;
}

/** Add the test's extra methods and events, and let it replace built-in methods. */
function extend(ctx: Ctx, ns: string, api: Record<string, unknown>, opts: Extras): void {
  for (const [name, script] of Object.entries(opts.methods ?? {})) {
    const path = `${ns}.${name}`;
    const next = scripted(ctx.host, `chrome.${path}`, script);
    // Each call gets its own copy, so code under test cannot change what a later call returns.
    const fn = (...args: unknown[]) => afterwards(next(...args), (out) => (out instanceof Error ? out : snapshot(out)));
    api[name] = SYNC_METHODS.has(path) ? syncApi(ctx.host, path, fn) : asyncApi(ctx.host, path, fn);
  }
  for (const name of opts.events ?? []) api[name] = ctx.event(`${ns}.${name}`);
}

function buildTabs(ctx: Ctx, opts: TabsOptions): Built {
  const { host, world } = ctx;
  const call = (name: string, impl: Fn) => asyncApi(host, `tabs.${name}`, impl);
  const api: Record<string, unknown> = {
    TAB_ID_NONE: -1,
    TAB_INDEX_NONE: -1,
    onCreated: ctx.event('tabs.onCreated'),
    onUpdated: ctx.event('tabs.onUpdated'),
    onRemoved: ctx.event('tabs.onRemoved'),
    onActivated: ctx.event('tabs.onActivated'),
    get: call('get', (tabId: unknown) => snapshot(world.mustTab(intArg('tabs.get', tabId)))),
    query: call('query', (q: unknown = {}) => {
      if (!isObject(q)) throw invalid('tabs.query');
      return world.query(q).map((t) => snapshot(t));
    }),
    create: call('create', (props: unknown = {}) => {
      const p = checkKeys('tabs.create', props, ['url', 'active', 'pinned', 'index', 'windowId', 'openerTabId', 'selected']);
      return snapshot(world.createTab(p, 'later'));
    }),
    update: call('update', (first: unknown, second?: unknown) => {
      const bare = isObject(first);
      const tab = bare ? world.activeTab() : world.mustTab(intArg('tabs.update', first));
      if (!tab) throw new ChromeError('No active tab to update.');
      const props = checkKeys('tabs.update', bare ? first : second, ['url', 'active', 'highlighted', 'pinned', 'muted', 'openerTabId', 'autoDiscardable', 'selected']);
      world.updateTab(tab, props, 'later');
      return snapshot(tab);
    }),
    remove: call('remove', (ids: unknown) => {
      const list = idList('tabs.remove', ids);
      list.forEach((id) => world.mustTab(id));
      list.forEach((id) => world.removeTab(id, 'later'));
    }),
    reload: call('reload', (tabId?: unknown) => {
      const tab = typeof tabId === 'number' ? world.mustTab(tabId) : world.activeTab();
      if (!tab) throw new ChromeError('No active tab to reload.');
      world.navigate(tab, tab.url, 'later');
    }),
    group: call('group', (details: unknown) => {
      const o = checkKeys('tabs.group', details, ['tabIds', 'groupId', 'createProperties']);
      const create = o.createProperties === undefined ? {} : checkKeys('tabs.group', o.createProperties, ['windowId']);
      return world.groupTabs(
        idList('tabs.group', o.tabIds),
        o.groupId === undefined ? undefined : intArg('tabs.group', o.groupId),
        create.windowId === undefined ? undefined : intArg('tabs.group', create.windowId),
        'later'
      );
    }),
    ungroup: call('ungroup', (ids: unknown) => world.ungroupTabs(idList('tabs.ungroup', ids), 'later')),
  };
  if (ctx.dom) {
    const dom = ctx.dom;
    api.sendMessage = call('sendMessage', (tabId: unknown, message: unknown, sendOptions?: unknown) => {
      const id = intArg('tabs.sendMessage', tabId);
      if (sendOptions !== undefined) checkKeys('tabs.sendMessage', sendOptions, ['frameId', 'documentId']);
      world.mustTab(id);
      const answer = dom.answer(id, jsonClone(message), { id: ctx.runtimeId });
      if (!answer.present) throw new ChromeError(NO_RECEIVER);
      return afterwards(answer.value, reply);
    });
  }
  extend(ctx, 'tabs', api, opts);

  const handle = {
    /** Copies of every tab, in Chrome's order. */
    list: () => world.orderedTabs().map((t) => snapshot(t)),
    get: (id: number) => {
      const tab = world.tab(id);
      return tab ? snapshot(tab) : undefined;
    },
    /** The user (or a page) opens a tab: it exists at once and tabs.onCreated fires. active defaults to false. */
    add: (init: TabInit = {}) => snapshot(world.addTab(init, 'sync')),
    /** The user closes a tab: tabs.onRemoved fires, and a group or window that becomes empty goes too. */
    close: (id: number) => world.removeTab(id, 'sync'),
    /** The user navigates: the URL commits, tabs.onUpdated fires with loading and (unless navigation is manual) complete. */
    navigate: (id: number, url: string) => world.navigate(world.mustTab(id), url, 'sync'),
    /** Finish a load that navigation: 'manual' left loading. */
    completeLoad: (id: number, details: { title?: string } = {}) => world.completeLoad(world.mustTab(id), details, 'sync'),
    /** Change fields (title, audible, status...) and fire tabs.onUpdated with exactly those as changeInfo. */
    patch: (id: number, changes: Record<string, unknown>) => {
      const tab = world.mustTab(id);
      Object.assign(tab, changes);
      ctx.events.get('tabs.onUpdated')?.dispatch(id, jsonClone(changes), snapshot(tab));
    },
    /** The user switches to a tab. */
    activate: (id: number) => world.activate(world.mustTab(id), 'sync'),
  };
  return { api, handle };
}

function buildTabGroups(ctx: Ctx, opts: TabGroupsOptions): Built {
  const { host, world } = ctx;
  const call = (name: string, impl: Fn) => asyncApi(host, `tabGroups.${name}`, impl);
  const api: Record<string, unknown> = {
    TAB_GROUP_ID_NONE: -1,
    onCreated: ctx.event('tabGroups.onCreated'),
    onUpdated: ctx.event('tabGroups.onUpdated'),
    onRemoved: ctx.event('tabGroups.onRemoved'),
    get: call('get', (groupId: unknown) => snapshot(world.mustGroup(intArg('tabGroups.get', groupId)))),
    update: call('update', (groupId: unknown, props: unknown) =>
      snapshot(world.updateGroup(intArg('tabGroups.update', groupId), checkKeys('tabGroups.update', props, ['collapsed', 'color', 'title']), 'later'))
    ),
    query: call('query', (q: unknown = {}) => {
      const filter = checkKeys('tabGroups.query', q, ['collapsed', 'color', 'title', 'windowId']);
      return [...world.groups.values()]
        .filter((g) => {
          if (filter.collapsed !== undefined && g.collapsed !== filter.collapsed) return false;
          if (filter.color !== undefined && g.color !== filter.color) return false;
          if (filter.title !== undefined && !globToRegExp(String(filter.title)).test(g.title)) return false;
          if (filter.windowId !== undefined && g.windowId !== (filter.windowId === -2 ? world.focusedWindowId : filter.windowId)) return false;
          return true;
        })
        .map((g) => snapshot(g));
    }),
  };
  extend(ctx, 'tabGroups', api, opts);
  const handle = {
    list: () => [...world.groups.values()].map((g) => snapshot(g)),
    get: (id: number) => {
      const group = world.groups.get(id);
      return group ? snapshot(group) : undefined;
    },
    /** A group that exists (created by the user): tabGroups.onCreated fires. */
    add: (init: GroupInit = {}) => {
      const group = world.seedGroup(init);
      ctx.events.get('tabGroups.onCreated')?.dispatch(snapshot(group));
      return snapshot(group);
    },
    /** The user removes a group: its tabs are ungrouped (tabs.onUpdated) and tabGroups.onRemoved fires. */
    remove: (id: number) => world.removeGroup(id, 'sync'),
  };
  return { api, handle };
}

function buildWindows(ctx: Ctx, opts: WindowsOptions): Built {
  const { host, world } = ctx;
  const call = (name: string, impl: Fn) => asyncApi(host, `windows.${name}`, impl);
  const view = (w: WindowState, populate: unknown) => ({ ...snapshot(w), ...(populate === true ? { tabs: world.windowTabs(w.id).map((t) => snapshot(t)) } : {}) });
  const populateOf = (getInfo: unknown) => (getInfo === undefined ? undefined : checkKeys('windows.get', getInfo, ['populate', 'windowTypes']).populate);
  const api: Record<string, unknown> = {
    WINDOW_ID_NONE: -1,
    WINDOW_ID_CURRENT: -2,
    onCreated: ctx.event('windows.onCreated'),
    onRemoved: ctx.event('windows.onRemoved'),
    onFocusChanged: ctx.event('windows.onFocusChanged'),
    get: call('get', (windowId: unknown, getInfo?: unknown) => view(world.resolveWindow(intArg('windows.get', windowId)), populateOf(getInfo))),
    getCurrent: call('getCurrent', (getInfo?: unknown) => view(world.resolveWindow(-2), populateOf(getInfo))),
    getLastFocused: call('getLastFocused', (getInfo?: unknown) => view(world.resolveWindow(-2), populateOf(getInfo))),
    getAll: call('getAll', (getInfo?: unknown) => [...world.windows.values()].map((w) => view(w, populateOf(getInfo)))),
    create: call('create', (data: unknown = {}) => {
      const d = checkKeys('windows.create', data, ['url', 'tabId', 'left', 'top', 'width', 'height', 'focused', 'incognito', 'type', 'state', 'setSelfAsOpener']);
      return view(world.createWindow(d, 'later'), true);
    }),
    update: call('update', (windowId: unknown, info: unknown) => {
      const found = world.resolveWindow(intArg('windows.update', windowId));
      const u = checkKeys('windows.update', info, ['focused', 'left', 'top', 'width', 'height', 'state', 'drawAttention']);
      for (const key of ['left', 'top', 'width', 'height', 'state']) if (u[key] !== undefined) found[key] = u[key];
      if (u.focused === true) world.focusWindow(found.id, 'later');
      return view(found, false);
    }),
    remove: call('remove', (windowId: unknown) => world.removeWindow(intArg('windows.remove', windowId), 'later')),
  };
  extend(ctx, 'windows', api, opts);
  const handle = {
    list: () => [...world.windows.values()].map((w) => snapshot(w)),
    get: (id: number) => {
      const found = world.windows.get(id);
      return found ? snapshot(found) : undefined;
    },
    get focusedId() {
      return world.focusedWindowId;
    },
    /** A window that exists (opened by the user): windows.onCreated fires. */
    add: (init: WindowInit = {}) => {
      const found = world.seedWindow(init);
      ctx.events.get('windows.onCreated')?.dispatch(snapshot(found));
      return snapshot(found);
    },
    /** The user focuses a window: windows.onFocusChanged fires. */
    focus: (id: number) => world.focusWindow(id, 'sync'),
    /** The user closes a window and all its tabs. */
    close: (id: number) => world.removeWindow(id, 'sync'),
  };
  return { api, handle };
}

function buildRuntime(ctx: Ctx, opts: RuntimeOptions, declared: boolean): Built {
  const { host } = ctx;
  const api: Record<string, unknown> = { id: ctx.runtimeId };
  Object.defineProperty(api, 'lastError', { enumerable: false, configurable: true, get: () => host.errors.lastError });
  if (!declared) return { api };
  const outgoingPorts: FakePort[] = [];
  const sync = (name: string, impl: Fn) => syncApi(host, `runtime.${name}`, impl);
  const call = (name: string, impl: Fn) => asyncApi(host, `runtime.${name}`, impl);
  const outgoing = opts.sendMessage === undefined ? undefined : scripted(host, 'chrome.runtime.sendMessage', opts.sendMessage);
  Object.assign(api, {
    onMessage: ctx.event('runtime.onMessage'),
    onConnect: ctx.event('runtime.onConnect'),
    onInstalled: ctx.event('runtime.onInstalled'),
    onStartup: ctx.event('runtime.onStartup'),
    getURL: sync('getURL', (path: unknown) => `chrome-extension://${ctx.runtimeId}/${String(path).replace(/^\//, '')}`),
    getManifest: sync('getManifest', () => snapshot(opts.manifest ?? { manifest_version: 3, name: 'fake extension', version: '0.0.0' })),
    getPlatformInfo: call('getPlatformInfo', () => snapshot(opts.platform ?? { os: 'mac', arch: 'arm64', nacl_arch: 'arm64' })),
    sendMessage: call('sendMessage', (...args: unknown[]) => {
      if (typeof args[0] === 'string' && args.length >= 2) args.shift();
      if (!outgoing) throw new ChromeError(NO_RECEIVER);
      return afterwards(outgoing(jsonClone(args[0]), args[1]), reply);
    }),
    connect: sync('connect', (...args: unknown[]) => {
      if (typeof args[0] === 'string') args.shift();
      const info = args[0] === undefined ? {} : checkKeys('runtime.connect', args[0], ['name', 'includeTlsChannelId']);
      const { client, server } = FakePort.pair(host, typeof info.name === 'string' ? info.name : '');
      outgoingPorts.push(server);
      ctx.workerPorts.push(client);
      return client;
    }),
  });
  extend(ctx, 'runtime', api, opts);

  const handle = {
    /**
     * Another extension page (the side panel) calls chrome.runtime.sendMessage(message): the onMessage listeners run
     * with (message, sender, sendResponse). Resolves with the response. Rejects like Chrome when nobody answers.
     */
    send: (message: unknown, sender: Record<string, unknown> = { id: ctx.runtimeId }, timeoutMs = 5000): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const onMessage = ctx.events.get('runtime.onMessage') as FakeEvent<any>;
        let answered = false;
        const timer = setTimeout(
          () => reject(new Error(`fakeChrome: an onMessage listener returned true but never called sendResponse within ${timeoutMs} ms`)),
          timeoutMs
        );
        const sendResponse = (value?: unknown) => {
          if (answered) return;
          answered = true;
          clearTimeout(timer);
          resolve(jsonClone(value));
        };
        if (!onMessage.hasListeners()) {
          clearTimeout(timer);
          reject(new Error(NO_RECEIVER));
          return;
        }
        let results: unknown[];
        try {
          results = onMessage.dispatch(jsonClone(message), sender, sendResponse);
        } catch (error) {
          clearTimeout(timer);
          reject(error);
          return;
        }
        if (!answered && !results.includes(true)) {
          clearTimeout(timer);
          reject(new Error(PORT_CLOSED));
        }
      }),
    /** A page (the side panel) connects: onConnect listeners get the server end, you get the client end. */
    connect: (info: { name?: string } = {}, sender: Record<string, unknown> = { id: ctx.runtimeId }): FakePort => {
      const { client, server } = FakePort.pair(host, info.name ?? '', sender);
      ctx.workerPorts.push(server);
      (ctx.events.get('runtime.onConnect') as FakeEvent<any>).dispatch(server);
      return client;
    },
    /** The far ends of ports the code under test opened with chrome.runtime.connect. */
    outgoingPorts,
  };
  return { api, handle };
}

function buildSidePanel(ctx: Ctx, opts: SidePanelOptions): Built {
  const { host } = ctx;
  const call = (name: string, impl: Fn) => asyncApi(host, `sidePanel.${name}`, impl);
  const optionsByTab = new Map<number | 'default', Record<string, unknown>>();
  const opened: Array<Record<string, unknown>> = [];
  let behavior: Record<string, unknown> = { openPanelOnActionClick: false };
  const openGate = opts.open === undefined ? undefined : gate(host, 'chrome.sidePanel.open', opts.open);
  const api: Record<string, unknown> = {
    setOptions: call('setOptions', (o: unknown) => {
      const p = checkKeys('sidePanel.setOptions', o, ['tabId', 'path', 'enabled']);
      const key = typeof p.tabId === 'number' ? p.tabId : 'default';
      const { tabId: _tabId, ...rest } = p;
      optionsByTab.set(key, { ...(optionsByTab.get(key) ?? {}), ...rest });
    }),
    getOptions: call('getOptions', (o: unknown = {}) => {
      const p = checkKeys('sidePanel.getOptions', o, ['tabId']);
      return snapshot({ enabled: true, ...(optionsByTab.get('default') ?? {}), ...(typeof p.tabId === 'number' ? (optionsByTab.get(p.tabId) ?? {}) : {}) });
    }),
    setPanelBehavior: call('setPanelBehavior', (b: unknown) => {
      behavior = { ...behavior, ...checkKeys('sidePanel.setPanelBehavior', b, ['openPanelOnActionClick']) };
    }),
    getPanelBehavior: call('getPanelBehavior', () => snapshot(behavior)),
    open: call('open', (o: unknown) => {
      const p = checkKeys('sidePanel.open', o, ['tabId', 'windowId']);
      if (p.tabId === undefined && p.windowId === undefined) throw new ChromeError('At least one of tabId or windowId must be provided.');
      const refused = openGate?.(p);
      if (refused) return refused;
      opened.push(snapshot(p));
      return undefined;
    }),
  };
  extend(ctx, 'sidePanel', api, opts);
  const handle = {
    /** What setOptions stored for a tab (or the default entry), merged like getOptions does. */
    optionsFor: (tabId?: number) => snapshot({ enabled: true, ...(optionsByTab.get('default') ?? {}), ...(tabId === undefined ? {} : (optionsByTab.get(tabId) ?? {})) }),
    get behavior() {
      return snapshot(behavior);
    },
    /** Every successful sidePanel.open({ tabId | windowId }). */
    opened,
  };
  return { api, handle };
}

function buildScripting(ctx: Ctx, opts: ScriptingOptions): Built {
  const { host, world } = ctx;
  const results =
    opts.executeScript === undefined
      ? () => {
          throw host.violation(
            'fakeChrome: chrome.scripting.executeScript was called but no results are scripted - ' +
              'add fakeChrome({ scripting: { executeScript: [...] } }) (a value, an Error, an array of these, or a function)'
          );
        }
      : scripted(host, 'chrome.scripting.executeScript', opts.executeScript);
  const api: Record<string, unknown> = {
    executeScript: asyncApi(host, 'scripting.executeScript', (injection: unknown) => {
      const inj = checkKeys('scripting.executeScript', injection, ['target', 'func', 'args', 'files', 'world', 'injectImmediately']);
      const target = checkKeys('scripting.executeScript', inj.target, ['tabId', 'frameIds', 'documentIds', 'allFrames']);
      const tabId = intArg('scripting.executeScript', target.tabId);
      if (ctx.hasTabs) world.mustTab(tabId);
      return afterwards(results(inj), (out) => {
        if (out instanceof Error) return out;
        return Array.isArray(out) ? jsonClone(out) : [{ frameId: 0, documentId: 'FAKEDOCUMENT00000000000000000000', result: jsonClone(out) }];
      });
    }),
  };
  extend(ctx, 'scripting', api, opts);
  return { api };
}

function buildDebugger(ctx: Ctx, opts: DebuggerOptions): Built {
  const { host } = ctx;
  const call = (name: string, impl: Fn) => asyncApi(host, `debugger.${name}`, impl);
  const attached = new Map<number, string>();
  const attachGate = opts.attach === undefined ? undefined : gate(host, 'chrome.debugger.attach', opts.attach);
  const commands = new Map<string, Fn>();
  for (const [method, script] of Object.entries(opts.commands ?? {})) commands.set(method, scripted(host, `chrome.debugger.sendCommand('${method}')`, script));
  const fallback = opts.sendCommand === undefined ? undefined : scripted(host, 'chrome.debugger.sendCommand', opts.sendCommand);
  const tabOf = (api: string, target: unknown): number => {
    const t = checkKeys(`debugger.${api}`, target, ['tabId', 'extensionId', 'targetId']);
    if (typeof t.tabId !== 'number') throw invalid(`debugger.${api}`, 'fakeChrome only supports a { tabId } debuggee');
    return t.tabId;
  };
  const notAttached = (tabId: number) => new ChromeError(`Debugger is not attached to the tab with id: ${tabId}.`);
  const api: Record<string, unknown> = {
    onEvent: ctx.event('debugger.onEvent'),
    onDetach: ctx.event('debugger.onDetach'),
    attach: call('attach', (target: unknown, requiredVersion: unknown) => {
      const tabId = tabOf('attach', target);
      if (typeof requiredVersion !== 'string') throw invalid('debugger.attach');
      const refused = attachGate?.(target, requiredVersion);
      if (refused) return refused;
      if (attached.has(tabId)) throw new ChromeError(`Another debugger is already attached to the tab with id: ${tabId}.`);
      attached.set(tabId, requiredVersion);
      return undefined;
    }),
    detach: call('detach', (target: unknown) => {
      const tabId = tabOf('detach', target);
      if (!attached.delete(tabId)) throw notAttached(tabId);
    }),
    getTargets: call('getTargets', () => {
      const targets = [];
      for (const [tabId] of attached.entries()) {
        targets.push({ tabId, attached: true, type: 'page' });
      }
      return afterwards(targets, (res) => jsonClone(res));
    }),
    sendCommand: call('sendCommand', (target: unknown, method: unknown, params?: unknown) => {
      const tabId = tabOf('sendCommand', target);
      if (typeof method !== 'string') throw invalid('debugger.sendCommand');
      if (!attached.has(tabId)) throw notAttached(tabId);
      const command = commands.get(method);
      if (!command && !fallback) {
        throw host.violation(
          `fakeChrome: chrome.debugger.sendCommand('${method}') has no scripted result - add it to fakeChrome({ debugger: { commands: { '${method}': ... } } })`
        );
      }
      const out = command ? command(params, target) : (fallback as Fn)(method, params, target);
      return afterwards(out, (result) => (result instanceof Error ? result : result === undefined ? {} : jsonClone(result)));
    }),
  };
  extend(ctx, 'debugger', api, opts);
  const handle = {
    /** Tab ids that currently have the debugger attached. */
    get attached() {
      return [...attached.keys()];
    },
    /** The browser ends the session (DevTools opened, the tab closed, the user pressed Cancel): debugger.onDetach fires. */
    detach: (tabId: number, reason = 'target_closed') => {
      if (!attached.delete(tabId)) throw new Error(`fakeChrome: the debugger is not attached to tab ${tabId}`);
      (ctx.events.get('debugger.onDetach') as FakeEvent<any>).dispatch({ tabId }, reason);
    },
    /** A CDP event from the page: debugger.onEvent fires. */
    event: (tabId: number, method: string, params: unknown = {}) => {
      if (!attached.has(tabId)) throw new Error(`fakeChrome: the debugger is not attached to tab ${tabId}`);
      (ctx.events.get('debugger.onEvent') as FakeEvent<any>).dispatch({ tabId }, method, jsonClone(params));
    },
  };
  return { api, handle };
}

function buildAlarms(ctx: Ctx, opts: AlarmsOptions): Built {
  const { host } = ctx;
  const call = (name: string, impl: Fn) => asyncApi(host, `alarms.${name}`, impl);
  const alarms = new Map<string, { name: string; scheduledTime: number; periodInMinutes?: number }>();
  const api: Record<string, unknown> = {
    onAlarm: ctx.event('alarms.onAlarm'),
    create: call('create', (...args: unknown[]) => {
      const name = typeof args[0] === 'string' ? args[0] : '';
      const info = checkKeys('alarms.create', typeof args[0] === 'string' ? args[1] : args[0], ['when', 'delayInMinutes', 'periodInMinutes']);
      if (info.when !== undefined && info.delayInMinutes !== undefined) throw new ChromeError('Cannot set both when and delayInMinutes.');
      if (info.when === undefined && info.delayInMinutes === undefined && info.periodInMinutes === undefined) {
        throw new ChromeError('Must set at least one of when, delayInMinutes, or periodInMinutes.');
      }
      const first = typeof info.when === 'number' ? info.when : Date.now() + 60_000 * Number(info.delayInMinutes ?? info.periodInMinutes);
      alarms.set(name, { name, scheduledTime: first, ...(info.periodInMinutes === undefined ? {} : { periodInMinutes: Number(info.periodInMinutes) }) });
    }),
    get: call('get', (name: unknown = '') => {
      const found = alarms.get(String(name));
      return found ? snapshot(found) : undefined;
    }),
    getAll: call('getAll', () => [...alarms.values()].map((a) => snapshot(a))),
    clear: call('clear', (name: unknown = '') => alarms.delete(String(name))),
    clearAll: call('clearAll', () => {
      const had = alarms.size > 0;
      alarms.clear();
      return had;
    }),
  };
  extend(ctx, 'alarms', api, opts);
  const handle = {
    list: () => [...alarms.values()].map((a) => snapshot(a)),
    /** The alarm goes off: alarms.onAlarm fires. A one-shot alarm is removed first; a repeating one moves to its next time. */
    fire: (name = '') => {
      const found = alarms.get(name);
      if (!found) throw new Error(`fakeChrome: there is no alarm named ${JSON.stringify(name)} to fire (alarms: ${[...alarms.keys()].map((k) => JSON.stringify(k)).join(', ') || 'none'})`);
      const fired = snapshot(found);
      if (found.periodInMinutes === undefined) alarms.delete(name);
      else found.scheduledTime += 60_000 * found.periodInMinutes;
      (ctx.events.get('alarms.onAlarm') as FakeEvent<any>).dispatch(fired);
    },
  };
  return { api, handle };
}

function buildDnr(ctx: Ctx, opts: DnrOptions): Built {
  const { host } = ctx;
  const sets = { dynamic: new Map<number, Record<string, unknown>>(), session: new Map<number, Record<string, unknown>>() };
  for (const [kind, rules] of [['dynamic', opts.dynamicRules], ['session', opts.sessionRules]] as const) {
    for (const rule of rules ?? []) sets[kind].set(Number(rule.id), jsonClone(rule));
  }
  const rulesOf = (kind: 'dynamic' | 'session') => [...sets[kind].values()].sort((a, b) => Number(a.id) - Number(b.id));
  const update = (kind: 'dynamic' | 'session') => (details: unknown) => {
    const name = `declarativeNetRequest.update${kind === 'dynamic' ? 'Dynamic' : 'Session'}Rules`;
    const o = checkKeys(name, details, ['addRules', 'removeRuleIds']);
    const next = new Map(sets[kind]);
    for (const id of (o.removeRuleIds as unknown[] | undefined) ?? []) next.delete(intArg(name, id));
    for (const rule of (o.addRules as Array<Record<string, unknown>> | undefined) ?? []) {
      const id = rule.id;
      if (typeof id !== 'number' || !Number.isInteger(id) || id < 1) throw new ChromeError(`Rule with id ${String(id)} must have an integer id of at least 1.`);
      if (next.has(id)) throw new ChromeError(`Rule with id ${id} does not have a unique ID.`);
      next.set(id, jsonClone(rule));
    }
    sets[kind] = next;
  };
  const get = (kind: 'dynamic' | 'session') => (filter: unknown = {}) => {
    const ids = checkKeys('declarativeNetRequest.getRules', filter, ['ruleIds']).ruleIds as number[] | undefined;
    return rulesOf(kind).filter((r) => !ids || ids.includes(Number(r.id))).map((r) => jsonClone(r));
  };
  const call = (name: string, impl: Fn) => asyncApi(host, `declarativeNetRequest.${name}`, impl);
  const api: Record<string, unknown> = {
    updateDynamicRules: call('updateDynamicRules', update('dynamic')),
    getDynamicRules: call('getDynamicRules', get('dynamic')),
    updateSessionRules: call('updateSessionRules', update('session')),
    getSessionRules: call('getSessionRules', get('session')),
  };
  extend(ctx, 'declarativeNetRequest', api, opts);
  const handle = {
    dynamicRules: () => rulesOf('dynamic').map((r) => jsonClone(r)),
    sessionRules: () => rulesOf('session').map((r) => jsonClone(r)),
  };
  return { api, handle };
}

function buildAction(ctx: Ctx, opts: ActionOptions): Built {
  const { host, world } = ctx;
  const call = (name: string, impl: Fn) => asyncApi(host, `action.${name}`, impl);
  const texts = new Map<number | 'default', string>();
  const colors = new Map<number | 'default', unknown>();
  const titles = new Map<number | 'default', string>();
  const slot = (api: string, details: unknown, keys: string[]) => {
    const d = checkKeys(`action.${api}`, details, ['tabId', ...keys]);
    return { d, key: (typeof d.tabId === 'number' ? d.tabId : 'default') as number | 'default' };
  };
  const api: Record<string, unknown> = {
    onClicked: ctx.event('action.onClicked'),
    setBadgeText: call('setBadgeText', (details: unknown) => {
      const { d, key } = slot('setBadgeText', details, ['text']);
      texts.set(key, String(d.text ?? ''));
    }),
    getBadgeText: call('getBadgeText', (details: unknown = {}) => {
      const { key } = slot('getBadgeText', details, []);
      return texts.get(key) ?? texts.get('default') ?? '';
    }),
    setBadgeBackgroundColor: call('setBadgeBackgroundColor', (details: unknown) => {
      const { d, key } = slot('setBadgeBackgroundColor', details, ['color']);
      colors.set(key, jsonClone(d.color));
    }),
    setTitle: call('setTitle', (details: unknown) => {
      const { d, key } = slot('setTitle', details, ['title']);
      titles.set(key, String(d.title ?? ''));
    }),
  };
  extend(ctx, 'action', api, opts);
  const handle = {
    /** What setBadgeText stored for a tab (or the default entry). */
    badgeText: (tabId?: number) => (tabId === undefined ? texts.get('default') : (texts.get(tabId) ?? texts.get('default'))) ?? '',
    badgeColor: (tabId?: number) => (tabId === undefined ? colors.get('default') : (colors.get(tabId) ?? colors.get('default'))),
    title: (tabId?: number) => (tabId === undefined ? titles.get('default') : (titles.get(tabId) ?? titles.get('default'))),
    /** The user clicks the toolbar icon: action.onClicked fires with the tab (default: the active tab). */
    click: (tab?: TabInit) => {
      const clicked = tab ?? world.activeTab();
      if (!clicked) throw new Error('fakeChrome: fc.action.click() needs a tab, and there is no active tab (declare tabs, or pass one)');
      (ctx.events.get('action.onClicked') as FakeEvent<any>).dispatch(snapshot(clicked));
    },
  };
  return { api, handle };
}

// ---------------------------------------------------------------------------------------------
// The strict proxy
// ---------------------------------------------------------------------------------------------

function hintFor(ns: string, key: string): string {
  if (ns === 'tabs' && key === 'sendMessage') return 'add the content-script side with fakeChrome({ dom: { <tabId>: { <ACTION>: <reply> } } })';
  if (/^on[A-Z]/.test(key)) return `add it to fakeChrome({ ${ns}: { events: ['${key}'] } })`;
  return `add it to fakeChrome({ ${ns}: { methods: { ${key}: <result, Error, array or function> } } })`;
}

/** Reading anything that is not there throws, except symbols and the keys tools probe (then, toJSON...). */
function strict<T extends object>(host: Host, target: T, path: string, hint: (key: string) => string, absent?: Set<string>): T {
  const shown = Object.keys(target).join(', ');
  Object.defineProperty(target, INSPECT, { enumerable: false, value: () => `FakeChrome ${path} { ${shown} }` });
  return new Proxy(target, {
    get(t, key, receiver) {
      if (typeof key === 'symbol' || key in t) return Reflect.get(t, key, receiver);
      if (PROBES.has(key) || absent?.has(key)) return undefined;
      throw host.violation(`fakeChrome: ${path}.${key} was not declared for this test - ${hint(key)}`);
    },
  });
}

// ---------------------------------------------------------------------------------------------
// fakeChrome()
// ---------------------------------------------------------------------------------------------

export interface FakeChrome {
  /** The fake chrome object. Install it: globalThis.chrome = fc.chrome (or fc.install()). */
  readonly chrome: Record<string, any>;
  /** Every chrome.* call the code made, in order: { api: 'tabs.group', args: [...] } (callbacks are not in args). Includes addListener/removeListener. */
  readonly calls: Call[];
  /** The calls to one API, e.g. callsTo('tabs.group'). */
  callsTo(api: string): Call[];
  /** Forget the calls so far (the same array object, emptied). */
  resetCalls(): void;
  /** Test mistakes the fake threw (undeclared API, exhausted script...), even if the code under test swallowed the throw. */
  readonly violations: Error[];
  /** Throws if the fake ever threw a test mistake. */
  assertClean(): void;
  /** lastError messages that a callback never looked at (Chrome logs "Unchecked runtime.lastError" for them). */
  readonly uncheckedLastErrors: string[];
  /** Call the listeners of an event now: fire('tabs.onCreated', tab). Returns what they returned. */
  fire(event: string, ...args: unknown[]): unknown[];
  /** Resolves once every callback and event the fake queued has run. */
  settle(): Promise<void>;
  /** Set globalThis.chrome. Returns a function that puts back what was there. */
  install(): () => void;
  /**
   * The worker died. Its listeners are dropped, what it had queued (callbacks, promise results,
   * events) never runs, its ports disconnect (the other end hears onDisconnect), and any further
   * chrome.* call on it throws. Data in a shared store stays. Model a restart with a new
   * fakeChrome over the same store.
   */
  kill(): void;
  readonly tabs: TabsHandle;
  readonly tabGroups: TabGroupsHandle;
  readonly windows: WindowsHandle;
  readonly storage: FakeStorage;
  readonly runtime: RuntimeHandle;
  readonly sidePanel: SidePanelHandle;
  readonly debugger: DebuggerHandle;
  readonly alarms: AlarmsHandle;
  readonly declarativeNetRequest: DnrHandle;
  readonly action: ActionHandle;
  readonly dom: DomHandle;
}

export interface TabsHandle {
  list(): Tab[];
  get(id: number): Tab | undefined;
  add(init?: TabInit): Tab;
  close(id: number): void;
  navigate(id: number, url: string): void;
  completeLoad(id: number, details?: { title?: string }): void;
  patch(id: number, changes: Record<string, unknown>): void;
  activate(id: number): void;
}
export interface TabGroupsHandle {
  list(): GroupState[];
  get(id: number): GroupState | undefined;
  add(init?: GroupInit): GroupState;
  remove(id: number): void;
}
export interface WindowsHandle {
  list(): WindowState[];
  get(id: number): WindowState | undefined;
  readonly focusedId: number | undefined;
  add(init?: WindowInit): WindowState;
  focus(id: number): void;
  close(id: number): void;
}
export interface RuntimeHandle {
  send(message: unknown, sender?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  connect(info?: { name?: string }, sender?: Record<string, unknown>): FakePort;
  readonly outgoingPorts: FakePort[];
}
export interface SidePanelHandle {
  optionsFor(tabId?: number): Record<string, unknown>;
  readonly behavior: Record<string, unknown>;
  readonly opened: Array<Record<string, unknown>>;
}
export interface DebuggerHandle {
  readonly attached: number[];
  detach(tabId: number, reason?: string): void;
  event(tabId: number, method: string, params?: unknown): void;
}
export interface AlarmsHandle {
  list(): Array<{ name: string; scheduledTime: number; periodInMinutes?: number }>;
  fire(name?: string): void;
}
export interface DnrHandle {
  dynamicRules(): Array<Record<string, unknown>>;
  sessionRules(): Array<Record<string, unknown>>;
}
export interface ActionHandle {
  badgeText(tabId?: number): string;
  badgeColor(tabId?: number): unknown;
  title(tabId?: number): string | undefined;
  click(tab?: TabInit): void;
}
export interface DomHandle {
  /** Content script on tabId answers with one function, or per message.action with scripted results. */
  set(tabId: number, handler: DomHandler): void;
  /** Add or replace the answer to one action on a tab. */
  on(tabId: number, action: string, script: Scripted): void;
  /** No content script on that tab any more (the page navigated): sendMessage fails with "Receiving end does not exist". */
  remove(tabId: number): void;
  has(tabId: number): boolean;
}

export function fakeChrome(input: FakeChromeOptions = {}): FakeChrome {
  const known = [...NAMESPACES, 'dom'];
  for (const key of Object.keys(input)) {
    if (!known.includes(key)) throw new Error(`fakeChrome: unknown namespace "${key}" in fakeChrome({...}); known: ${known.join(', ')}`);
  }
  const value = (name: string): unknown => (input as Record<string, unknown>)[name];
  const wants = (name: string): boolean => Boolean(value(name));
  if (wants('dom') && !wants('tabs')) throw new Error('fakeChrome: dom needs tabs declared too (chrome.tabs.sendMessage delivers to it) - add tabs: true');
  if (value('runtime') === false) throw new Error('fakeChrome: chrome.runtime always exists (it carries lastError), so runtime: false is not supported');

  const host = new Host();
  const events = new Map<string, FakeEvent<any>>();
  const fx: Effects = {
    fire(how, path, ...args) {
      const event = events.get(path);
      if (!event) return;
      if (how === 'sync') event.dispatch(...args);
      else
        host.defer(() => {
          event.dispatch(...args);
        });
    },
    step(how, fn) {
      if (how === 'sync') fn();
      else host.defer(fn);
    },
  };
  const world = new World(fx);
  const ctx: Ctx = {
    host,
    world,
    events,
    event(path) {
      const event = new FakeEvent<any>(path, host);
      events.set(path, event);
      return event;
    },
    runtimeId: 'abcdefghijklmnopabcdefghijklmnop',
    dom: undefined,
    hasTabs: wants('tabs'),
    workerPorts: [],
  };

  // The browser state at the start: windows, then groups, then tabs (so a tab can name a window and a group that exist).
  const runtimeOptions = options<RuntimeOptions>('runtime', input.runtime, ['id', 'manifest', 'platform', 'sendMessage']);
  const windowsOptions = options<WindowsOptions>('windows', input.windows, ['list']);
  const groupsOptions = options<TabGroupsOptions>('tabGroups', input.tabGroups, ['list']);
  const tabsOptions = options<TabsOptions>('tabs', input.tabs, ['list', 'navigation']);
  if (runtimeOptions.id !== undefined) ctx.runtimeId = runtimeOptions.id;
  for (const w of windowsOptions.list ?? []) world.seedWindow(w);
  for (const g of groupsOptions.list ?? []) world.seedGroup(g);
  for (const t of tabsOptions.list ?? []) world.seedTab(t);
  world.settleActive();
  if (tabsOptions.navigation !== undefined) world.navigation = tabsOptions.navigation;

  const root: Record<string, unknown> = {};
  const absent = new Set<string>();
  const handles: Record<string, unknown> = {};
  const mount = (name: string, built: Built, hint: (key: string) => string) => {
    if (built.handle) handles[name] = built.handle;
    root[name] = strict(host, built.api, `chrome.${name}`, hint);
  };
  const declare = (name: string, make: () => Built) => {
    if (value(name) === false) absent.add(name);
    else if (wants(name)) mount(name, make(), (key) => hintFor(name, key));
  };

  if (wants('dom')) {
    const dom = new DomRegistry(host);
    ctx.dom = dom;
    if (isObject(input.dom)) for (const [id, handler] of Object.entries(input.dom)) dom.set(Number(id), handler as DomHandler);
    handles.dom = {
      set: (tabId: number, handler: DomHandler) => dom.set(tabId, handler),
      on: (tabId: number, action: string, script: Scripted) => dom.on(tabId, action, script),
      remove: (tabId: number) => dom.remove(tabId),
      has: (tabId: number) => dom.has(tabId),
    };
  }

  // chrome.runtime always exists (lastError and id); the rest of it only when declared.
  mount('runtime', buildRuntime(ctx, runtimeOptions, wants('runtime')), (key) =>
    wants('runtime') ? hintFor('runtime', key) : 'chrome.runtime only has id and lastError here - declare the rest with fakeChrome({ runtime: true })'
  );
  declare('tabs', () => buildTabs(ctx, tabsOptions));
  declare('tabGroups', () => buildTabGroups(ctx, groupsOptions));
  declare('windows', () => buildWindows(ctx, windowsOptions));
  declare('sidePanel', () => buildSidePanel(ctx, options<SidePanelOptions>('sidePanel', input.sidePanel, ['open'])));
  declare('scripting', () => buildScripting(ctx, options<ScriptingOptions>('scripting', input.scripting, ['executeScript'])));
  declare('debugger', () => buildDebugger(ctx, options<DebuggerOptions>('debugger', input.debugger, ['attach', 'commands', 'sendCommand'])));
  declare('alarms', () => buildAlarms(ctx, options<AlarmsOptions>('alarms', input.alarms, [])));
  declare('declarativeNetRequest', () => buildDnr(ctx, options<DnrOptions>('declarativeNetRequest', input.declarativeNetRequest, ['dynamicRules', 'sessionRules'])));
  declare('action', () => buildAction(ctx, options<ActionOptions>('action', input.action, [])));

  // storage: local + session over a FakeStorage (the one given, or a private one), plus chrome.storage.onChanged.
  let store: FakeStorage | undefined;
  let connection: ReturnType<FakeStorage['connect']> | undefined;
  const storageInput = input.storage;
  if (storageInput === false) {
    absent.add('storage');
  } else if (storageInput) {
    const opened = storageInput instanceof FakeStorage ? storageInput : new FakeStorage(storageInput === true ? {} : storageInput);
    const connected = opened.connect(host);
    store = opened;
    connection = connected;
    const areaHint = () => 'fakeStorageSession implements get, set, remove, clear, getBytesInUse, getKeys, setAccessLevel, onChanged and QUOTA_BYTES';
    events.set('storage.onChanged', connected.onChanged);
    events.set('storage.local.onChanged', connected.local.onChanged);
    events.set('storage.session.onChanged', connected.session.onChanged);
    root.storage = strict(
      host,
      {
        local: strict(host, connected.local as unknown as object, 'chrome.storage.local', areaHint),
        session: strict(host, connected.session as unknown as object, 'chrome.storage.session', areaHint),
        onChanged: connected.onChanged,
      },
      'chrome.storage',
      (key) =>
        key === 'sync' || key === 'managed'
          ? `only local and session exist in fakeChrome (fakeStorageSession.ts has no ${key} area)`
          : 'fakeChrome implements storage.local, storage.session and storage.onChanged only'
    );
  }

  const chrome = strict(
    host,
    root,
    'chrome',
    (key) =>
      NAMESPACES.includes(key)
        ? `add it with fakeChrome({ ${key}: true })`
        : `fakeChrome has no chrome.${key} at all; add it to tests/helpers/fakeChrome.ts first`,
    absent
  );

  /** A handle exists only for a declared namespace; asking for another one says how to declare it. */
  const handleOf = (name: string): any => {
    const found = handles[name];
    if (found === undefined) throw new Error(`fakeChrome: fc.${name} is not available because ${name} was not declared - add ${name}: true to fakeChrome({...})`);
    return found;
  };

  const fc = {
    chrome,
    calls: host.calls,
    callsTo: (api: string) => host.calls.filter((c) => c.api === api),
    resetCalls: () => {
      host.calls.length = 0;
    },
    violations: host.violations,
    assertClean: () => {
      if (host.violations.length > 0) {
        throw new Error(`fakeChrome: ${host.violations.length} test mistake(s) were thrown to the code under test:\n${host.violations.map((v) => `  - ${v.message}`).join('\n')}`);
      }
    },
    get uncheckedLastErrors() {
      return host.errors.unchecked;
    },
    fire: (event: string, ...args: unknown[]) => {
      const target = events.get(event);
      if (!target) throw new Error(`fakeChrome: no event "${event}" is declared (declared events: ${[...events.keys()].sort().join(', ') || 'none'})`);
      return target.dispatch(...args);
    },
    settle: () => host.settle(),
    install: () => {
      const g = globalThis as Record<string, unknown>;
      const had = Object.hasOwn(g, 'chrome');
      const previous = g.chrome;
      g.chrome = chrome;
      return () => {
        if (had) g.chrome = previous;
        else delete g.chrome;
      };
    },
    kill: () => {
      if (host.dead) return;
      for (const port of ctx.workerPorts) port.sever(); // the other end hears onDisconnect, like a panel does when the worker stops
      connection?.kill();
      for (const event of events.values()) event.clear();
      host.kill();
    },
    get storage() {
      if (!store) throw new Error('fakeChrome: fc.storage is not available because storage was not declared - add storage: true (or a createFakeStorage() store) to fakeChrome({...})');
      return store;
    },
    get tabs() { return handleOf('tabs'); },
    get tabGroups() { return handleOf('tabGroups'); },
    get windows() { return handleOf('windows'); },
    get runtime() { return handleOf('runtime'); },
    get sidePanel() { return handleOf('sidePanel'); },
    get debugger() { return handleOf('debugger'); },
    get alarms() { return handleOf('alarms'); },
    get declarativeNetRequest() { return handleOf('declarativeNetRequest'); },
    get action() { return handleOf('action'); },
    get dom() { return handleOf('dom'); },
  };
  return fc as FakeChrome;
}
