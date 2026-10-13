/**
 * routerRig - the background router (the service worker's message and port handling) loaded in Node
 * over fakeChrome, with a fake model injected through runtimeRegistry.
 *
 * About 16 router tests (backgroundFreshOnOpen, backgroundTabAdoption, sessionIsolation ...) each
 * build a hand-written `global.chrome` of 60 to 190 lines, capture the listeners by hand and import
 * the router once per file. This rig replaces that: fakeChrome is the chrome (it has the real call
 * shapes, so a test cannot pass on a lazy mock), `connect()` opens a side panel port, `send()` is a
 * side panel sendMessage round trip, `clickIcon()` is the toolbar click, and the model is injected,
 * so a test can drive a real task through the router without the network.
 *
 * Example:
 *   import { routerRig } from './helpers/routerRig.ts';
 *   import { act, shopPages, shopPlan } from './helpers/graphHarness.ts';
 *
 *   const rig = await routerRig({ tabs: [{ id: 100, url: 'https://shop.test/items' }], pages: shopPages(),
 *     llm: { plan: [shopPlan()], policy: [act.finish('done')] } });
 *   t.after(rig.cleanup);
 *   const panel = rig.connect(100);                       // the side panel of tab 100 connects
 *   await rig.startTask(100, 'Find the price');           // START_TASK through the router, autoApprove true
 *   await rig.waitForStatus(100, 'idle');                 // the run is over
 *   panel.lastState().history;                            // what the panel was shown
 *
 * THE ROUTER PATH. ROUTER_MODULE below is the ONE place that names the router file. Stage 5c moves it
 * to src/background/background.ts: change that line and every test that uses this rig follows.
 *
 * One router per rig. Each rig imports the router again with a cache-busting query, so it gets its own
 * `sessions` map and registers its listeners on ITS fakeChrome (the listeners of an earlier rig are on
 * a killed chrome and never run). What is shared by all rigs in a process, because the router imports
 * them as singletons, is Logger, Storage and runtimeRegistry. The rig therefore leaves no run behind
 * (cleanup stops every session it knows, which also stops the router's keepalive interval and the
 * pause timer of the runner) and puts runtimeRegistry back as it found it.
 *
 * The model. The router creates its AgentRunner itself, the first time a panel connects, the icon is
 * clicked or a message names a tab, so a test cannot hand it a port. The rig wraps runtimeRegistry.set
 * for the time of the test: every runtime a runner registers gets the rig's LlmPort as `llm` (the
 * port of rig.llm, or one given with useLlm(tabId, port) for one tab). The wrap and the runtime are
 * the same objects production uses, so nothing in src/ is touched.
 *
 * What the rig cannot see: the router keeps its sessions (and so the AgentRunner objects) in a module
 * variable. A test reads a run through the router like the panel does: panel.lastState() (the pushed
 * STATE_UPDATE), state(tabId) (GET_AGENT_STATE), or the fake chrome (fc.callsTo, fc.tabs).
 */

import { existsSync } from 'node:fs';
import { fakeChrome } from './fakeChrome.ts';
import type { FakeChrome, FakeChromeOptions, FakePort, TabInit } from './fakeChrome.ts';
import { createFakeStorage } from './fakeStorageSession.ts';
import type { FakeStorage } from './fakeStorageSession.ts';
import { fakeDom } from './fakeDom.ts';
import type { FakeDom, PageSpec } from './fakeDom.ts';
import { fakeLlm } from './fakeLlm.ts';
import type { FakeLlm, ReplyEntry } from './fakeLlm.ts';
import { runtimeRegistry } from '../../src/background/runner/runtimeRegistry.ts';
import type { LlmPort, RunRuntime } from '../../src/background/runner/runtimeRegistry.ts';

/** The router module, relative to the repository root. */
export const ROUTER_MODULE = 'src/background/background.ts';

const ROUTER_URL = new URL(`../../${ROUTER_MODULE}`, import.meta.url);

let loads = 0;

export interface RouterRigOptions {
  /** The tabs that exist at the start. Default: one tab, id 100, https://example.com/a, window 1. */
  tabs?: TabInit[];
  /** Merged over the stored agent_settings. Default: a test model on openrouter. */
  settings?: Record<string, unknown>;
  /** Share a store between rigs (a restarted worker), or seed it. Default: a new one. */
  store?: FakeStorage;
  /** Pages for a fake content script on every initial tab (fakeDom). Without them no tab answers content script messages. */
  pages?: PageSpec[];
  /** The model of every session: a fakeLlm, or the ordered queues of one (plan, policy, reflect). Default: a new empty fakeLlm. */
  llm?: FakeLlm | { plan?: ReplyEntry[]; policy?: ReplyEntry[]; reflect?: ReplyEntry[] };
  /** More chrome.* namespaces, merged over the defaults (tabs, tabGroups, storage, runtime, sidePanel, alarms, declarativeNetRequest, action, dom). */
  chrome?: Partial<FakeChromeOptions>;
}

/** A side panel that is connected to the router. */
export interface Panel {
  readonly tabId: number;
  readonly port: FakePort;
  /** Everything the router pushed to this panel, in order. */
  readonly received: unknown[];
  /** The payload of the last STATE_UPDATE (the last message overall is not always one: LOG_ENTRY is pushed too). */
  lastState(): Record<string, any> | undefined;
  /** The payloads of all STATE_UPDATEs. */
  states(): Array<Record<string, any>>;
  disconnect(): void;
}

export interface RouterRig {
  readonly fc: FakeChrome;
  readonly store: FakeStorage;
  readonly llm: FakeLlm;
  /** The fake content script of the tabs, when `pages` was given. */
  readonly site: FakeDom | undefined;
  /** The router module as imported (everything it exports; the router exports nothing today). */
  readonly module: Record<string, unknown>;

  /** A side panel sendMessage round trip: the response of the router. */
  send(message: Record<string, unknown>, sender?: Record<string, unknown>): Promise<any>;
  /** The side panel of a tab connects (port name scoutfox_sidepanel[_fresh]:<tabId>) and the router's first push is awaited. */
  connect(tabId: number, options?: { fresh?: boolean }): Promise<Panel>;
  /** The toolbar icon is clicked on a tab (default: the first tab). */
  clickIcon(tab?: TabInit): Promise<void>;
  /** START_TASK through the router, and wait until the run has begun. autoApprove defaults to true here; the router also defaults it to true now, so the plan approves itself (pass autoApprove:false in the payload to hold at the plan). */
  startTask(tabId: number, prompt: string, payload?: Record<string, unknown>): Promise<any>;
  /** GET_AGENT_STATE for a tab: the state the router reports. */
  state(tabId: number): Promise<Record<string, any>>;
  /** Poll GET_AGENT_STATE (no timer: one event loop turn between polls) until the status is one of `status`. Returns that state. Call it after startTask(), which returns once the run has begun; a status read straight after START_TASK can still be the old idle. */
  waitForStatus(tabId: number, status: string | string[], options?: { maxPolls?: number }): Promise<Record<string, any>>;
  /** Use this model for the runner of one tab (also for a runner that already exists). */
  useLlm(tabId: number, port: LlmPort): void;
  /** The runtime the runner of a tab registered, when it exists. */
  runtime(tabId: number): RunRuntime | undefined;
  /** What the router registered with self.addEventListener (error, unhandledrejection), and a way to fire one. */
  readonly selfListeners: Map<string, Array<(event: any) => void>>;
  dispatchSelf(type: string, event: Record<string, unknown>): void;
  /** Wait until the fake chrome has nothing queued, and a few event loop turns for the router's own promises. */
  settle(): Promise<void>;
  /** Throws when fakeChrome, the fake page or the fake model met a test mistake. */
  assertClean(): void;
  /** Stops every run the router has, puts the globals and runtimeRegistry back. Use t.after(rig.cleanup). */
  cleanup(): Promise<void>;
}

export async function routerRig(options: RouterRigOptions = {}): Promise<RouterRig> {
  if (!existsSync(ROUTER_URL)) throw new Error(`routerRig: ROUTER_MODULE "${ROUTER_MODULE}" does not exist - fix the constant at the top of tests/helpers/routerRig.ts`);

  const store = options.store ?? createFakeStorage();
  const settingsKey = 'agent_settings';
  if ((await store.connect().local.get(settingsKey))[settingsKey] === undefined) {
    await store.connect().local.set({
      [settingsKey]: { provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'test-model', maxSteps: 20, actionDelayMs: 1, ...options.settings },
    });
  }

  const llm = options.llm && 'port' in options.llm ? options.llm : fakeLlm();
  const queues = options.llm && !('port' in options.llm) ? options.llm : {};
  const defaultPort: LlmPort = llm.port({ queues });
  const portByTab = new Map<number, LlmPort>();

  const initialTabs = options.tabs ?? [{ id: 100, url: 'https://example.com/a', windowId: 1, active: true }];
  const site = options.pages ? fakeDom({ pages: options.pages }) : undefined;
  const fc = fakeChrome({
    tabs: { list: initialTabs },
    tabGroups: true,
    storage: store,
    runtime: true,
    sidePanel: true,
    alarms: true,
    declarativeNetRequest: true,
    action: true,
    dom: true,
    ...options.chrome,
  });
  if (site) {
    for (const tab of initialTabs) if (typeof tab.id === 'number') site.attach(fc, tab.id);
    (fc.chrome.tabs?.onCreated as any)?.addListener?.((tab: any) => {
      if (typeof tab?.id === 'number') site.attach(fc, tab.id);
    });
  }
  const selfListeners = new Map<string, Array<(event: any) => void>>();
  const fakeSelf = {
    addEventListener: (type: string, listener: (event: any) => void) => {
      selfListeners.set(type, [...(selfListeners.get(type) ?? []), listener]);
    },
  };
  const globals = globalThis as Record<string, unknown>;
  const hadSelf = 'self' in globals;
  const previousSelf = globals['self'];
  globals['self'] = fakeSelf;
  const restoreChrome = fc.install();

  // The model: every runtime a runner registers gets the rig's port.
  const originalSet = runtimeRegistry.set;
  const knownTabs = new Set<number>(initialTabs.flatMap((tab) => (typeof tab.id === 'number' ? [tab.id] : [])));
  runtimeRegistry.set = (rt: RunRuntime) => {
    rt.llm = portByTab.get(rt.ownerTabId) ?? defaultPort;
    knownTabs.add(rt.ownerTabId);
    originalSet(rt);
  };

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    runtimeRegistry.set = originalSet;
    restoreChrome();
    if (hadSelf) globals['self'] = previousSelf;
    else delete globals['self'];
  };

  let module: Record<string, unknown>;
  try {
    module = (await import(`${ROUTER_URL.href}?routerRig=${++loads}`)) as Record<string, unknown>;
  } catch (error) {
    restore();
    throw error;
  }

  const turns = async (count: number) => {
    for (let i = 0; i < count; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  const settle = async () => {
    await fc.settle();
    await turns(3);
    await fc.settle();
  };

  const send: RouterRig['send'] = (message, sender) => fc.runtime.send(message, sender) as Promise<any>;
  const panels: Panel[] = [];

  const rig: RouterRig = {
    fc,
    store,
    llm,
    site,
    module,

    send,
    connect: async (tabId, connectOptions = {}) => {
      knownTabs.add(tabId);
      const port = fc.runtime.connect({ name: `${connectOptions.fresh ? 'scoutfox_sidepanel_fresh' : 'scoutfox_sidepanel'}:${tabId}` });
      const states = () => port.received.filter((m): m is { type: string; payload: Record<string, any> } => (m as { type?: string })?.type === 'STATE_UPDATE').map((m) => m.payload);
      const panel: Panel = {
        tabId,
        port,
        received: port.received,
        lastState: () => states().at(-1),
        states,
        disconnect: () => port.disconnect(),
      };
      panels.push(panel);
      // The router answers a connect with the state after its session has restored, so wait for that first push.
      for (let polls = 0; polls < 10_000 && states().length === 0; polls++) await turns(1);
      await settle();
      return panel;
    },
    clickIcon: async (tab) => {
      fc.action.click(tab);
      await settle();
    },
    startTask: async (tabId, prompt, payload = {}) => {
      knownTabs.add(tabId);
      const response = await send({ action: 'START_TASK', tabId, payload: { prompt, autoApprove: true, ...payload } });
      if (response?.success) {
        // The router answers before the run has begun (it does not await startTask), so the status is still the old
        // 'idle' for a few turns. The runner sets the task and 'running' in one synchronous block, so once the task
        // shows, any status read is a real one and waitForStatus() cannot return too early.
        for (let polls = 0; polls < 50_000; polls++) {
          if ((await rig.state(tabId))['task'] === prompt.trim()) break;
          await turns(1);
        }
      }
      await settle();
      return response;
    },
    state: async (tabId) => {
      knownTabs.add(tabId);
      return (await send({ action: 'GET_AGENT_STATE', tabId })) as Record<string, any>;
    },
    waitForStatus: async (tabId, status, waitOptions = {}) => {
      const wanted = Array.isArray(status) ? status : [status];
      const maxPolls = waitOptions.maxPolls ?? 50_000;
      for (let polls = 0; polls < maxPolls; polls++) {
        const state = await rig.state(tabId);
        if (wanted.includes(state['status'])) {
          await settle();
          return state;
        }
        await turns(1);
      }
      throw new Error(`routerRig: tab ${tabId} never reached status ${wanted.join(' or ')} (last: ${String((await rig.state(tabId))['status'])})`);
    },
    useLlm: (tabId, port) => {
      portByTab.set(tabId, port);
      const rt = runtimeRegistry.get(String(tabId));
      if (rt) rt.llm = port;
    },
    runtime: (tabId) => runtimeRegistry.get(String(tabId)),
    selfListeners,
    dispatchSelf: (type, event) => {
      for (const listener of selfListeners.get(type) ?? []) listener(event);
    },
    settle,
    assertClean: () => {
      fc.assertClean();
      site?.assertClean();
      llm.assertClean();
    },
    cleanup: async () => {
      // STOP_TASK for every tab that has a runner: a running or paused run is aborted, which also ends the router's keepalive interval and the runner's pause timer.
      for (const tabId of knownTabs) {
        if (!runtimeRegistry.get(String(tabId))) continue;
        try {
          await send({ action: 'STOP_TASK', tabId });
        } catch {
          // The listener is gone or the chrome was killed by the test: nothing left to stop.
        }
      }
      await settle();
      for (const panel of panels) {
        try {
          panel.disconnect();
        } catch {
          // Already closed.
        }
      }
      for (const tabId of knownTabs) runtimeRegistry.delete(String(tabId));
      restore();
      fc.kill();
    },
  };
  return rig;
}
