/**
 * The extension's WebSocket client for the local MCP bridge.
 *
 * The bridge (a Node process the user runs) listens on 127.0.0.1; the extension dials it as a
 * client, because an MV3 service worker cannot listen. While connected, the bridge's pings keep
 * the worker's idle timer reset; while disconnected, a 1-minute chrome.alarms timer re-joins the
 * bridge after a suspension (alarms survive suspension; throttling only slows the re-join).
 *
 * Security: the stored URL must be ws://127.0.0.1:<port> - never a web origin, never localhost
 * (which can resolve to ::1 and miss a 127.0.0.1-only listener). The token rides the URL's
 * query; the bridge checks it on the upgrade request.
 */

import { encodeFrame, parseFrame, PROTOCOL_VERSION, type BridgeFrame } from './protocol.ts';
import { Logger } from '../../shared/logger.ts';
import { BUILD_STAMP } from '../../shared/build.ts';

const BRIDGE_ALARM = 'tarka_bridge';
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const PING_INTERVAL_MS = 20_000;

export interface BridgeSettings {
  enabled: boolean;
  url: string;
  token: string;
}

export interface BridgeTarget {
  tabId: number;
  chatId: string;
  status: string;
  url: string;
  title: string;
}

/** What the bridge layer needs from the host to do its job (background.ts provides it). */
export interface BridgeHost {
  getSettings(): Promise<{ bridge?: BridgeSettings }>;
  /** Sessions summary for hello, and the handlers the bridge's requests land on. */
  listSessions(): BridgeTarget[];
  onStartTask(payload: { runId: string; prompt: string; effort?: string | null; tabId?: number | null; startUrl?: string | null }): Promise<{ ok: boolean; data?: unknown; error?: string }>;
  onStopTask(payload: { runId: string }): Promise<{ ok: boolean; data?: unknown; error?: string }>;
  onGetState(payload: { runId: string }): Promise<{ ok: boolean; data?: unknown; error?: string }>;
  /** A bridge-started run must be stopped when the bridge disappears (unattended automation). */
  stopBridgeRuns(): void;
  /** Every frame from the bridge (hello acks, task events) that the session layer consumes. */
  onBridgeFrame(frame: BridgeFrame): void;
  /** The socket opened: the session layer can bind its sender to it. */
  onBridgeConnected(send: (type: string, payload: Record<string, unknown>, id?: string | number | null) => void): void;
}

export class BridgeClient {
  private host: BridgeHost;
  private socket: WebSocket | null = null;
  private enabled = false;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private attempts = 0;
  private connecting = false;

  constructor(host: BridgeHost) {
    this.host = host;
  }

  /** Apply the current settings: connect, disconnect, or update the alarm. Safe to call often. */
  async sync(): Promise<void> {
    const settings = await this.host.getSettings();
    const bridge = settings.bridge ?? { enabled: false, url: 'ws://127.0.0.1:7877', token: '' };
    if (bridge.enabled === this.enabled && this.enabled) {
      // Already on: nothing to redo (a URL change takes effect on the next reconnect).
      return;
    }
    if (bridge.enabled && !this.enabled) {
      this.enabled = true;
      this.scheduleAlarm(true);
      this.connectNow();
    } else if (!bridge.enabled && this.enabled) {
      this.enabled = false;
      this.scheduleAlarm(false);
      this.closeSocket();
    }
  }

  /** The chrome.alarms handler: reconnect if enabled and not connected. */
  ensureConnected(): void {
    if (this.enabled && !this.isConnected() && !this.connecting) this.connectNow();
  }

  /** Full teardown (the extension process dies with the worker; tests use this to exit cleanly). */
  dispose(): void {
    this.enabled = false;
    this.closeSocket();
    this.scheduleAlarm(false);
  }

  isConnected(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  private connectNow(): void {
    if (!this.enabled || this.isConnected() || this.connecting) return;
    this.connecting = true;
    void this.dial();
  }

  private async dial(): Promise<void> {
    const settings = await this.host.getSettings();
    const bridge = settings.bridge ?? { enabled: false, url: '', token: '' };
    const url = validatedUrl(bridge.url);
    if (!url || !this.enabled) {
      this.connecting = false;
      if (!url) Logger.warn('Bridge', `[BRIDGE_URL_REJECTED] Not a local bridge URL: "${bridge.url}". Use ws://127.0.0.1:<port>.`);
      return;
    }
    const full = bridge.token ? `${url}?token=${encodeURIComponent(bridge.token)}` : url;
    try {
      const socket = new WebSocket(full);
      this.socket = socket;
      socket.onopen = () => {
        this.connecting = false;
        this.attempts = 0;
        this.send('hello', {
          proto: PROTOCOL_VERSION,
          build: BUILD_STAMP,
          sessions: this.host.listSessions(),
        });
        // The session layer binds its sender to this socket (task_event, task_done).
        this.host.onBridgeConnected((type, payload, id) => this.send(type, payload, id ?? null));
        this.startPing();
        Logger.debug('Bridge', '[BRIDGE_CONNECTED] Connected to the local bridge.');
      };
      socket.onmessage = (event) => {
        const frame = parseFrame(event.data);
        if (frame) void this.handleFrame(frame);
      };
      socket.onclose = () => {
        this.onSocketGone();
      };
      socket.onerror = () => {
        // onclose follows; nothing to do here beyond keeping the log quiet.
      };
    } catch (err) {
      this.connecting = false;
      this.socket = null;
      Logger.warn('Bridge', '[BRIDGE_CONNECT_FAILED] Could not open the bridge socket', err);
      this.scheduleReconnect();
    }
  }

  private onSocketGone(): void {
    const wasConnected = this.isConnected();
    this.socket = null;
    this.stopPing();
    this.connecting = false;
    if (wasConnected) {
      // The bridge is gone mid-run: bridge-sourced runs must not keep clicking unattended.
      this.host.stopBridgeRuns();
      Logger.debug('Bridge', '[BRIDGE_DISCONNECTED] Bridge socket closed.');
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.enabled || this.connectTimer !== null) return;
    const backoff = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.min(this.attempts, 5));
    this.attempts += 1;
    const jitter = Math.floor(Math.random() * 300);
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      this.connectNow();
    }, backoff + jitter);
    // A service worker ignores this (no unref there), but in Node tests the timer must not
    // hold the event loop open after the test file is done.
    if (typeof (this.connectTimer as any)?.unref === 'function') (this.connectTimer as any).unref();
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      // Traffic resets the MV3 idle timer; the bridge answers with its own ping frame.
      this.send('ping', {});
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private closeSocket(): void {
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    this.stopPing();
    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      try {
        socket.onclose = null;
        socket.onerror = null;
        socket.onmessage = null;
        socket.close();
      } catch {
        // Already closing.
      }
    }
  }

  private send(type: string, payload: Record<string, unknown>, id: string | number | null = null): void {
    if (!this.isConnected() || !this.socket) return;
    try {
      this.socket.send(encodeFrame(type, payload, id));
    } catch (err) {
      Logger.warn('Bridge', '[BRIDGE_SEND_FAILED] Could not send a bridge frame', err);
    }
  }

  private async handleFrame(frame: BridgeFrame): Promise<void> {
    switch (frame.type) {
      case 'start_task':
        this.reply(frame, await this.safe(() => this.host.onStartTask(frame.payload as any)));
        break;
      case 'stop_task':
        this.reply(frame, await this.safe(() => this.host.onStopTask(frame.payload as any)));
        break;
      case 'get_state':
        this.reply(frame, await this.safe(() => this.host.onGetState(frame.payload as any)));
        break;
      case 'ping':
        // The bridge's ping doubles as the keepalive; answer so it knows we are alive.
        this.send('result', { ok: true, data: { pong: true } }, frame.id);
        break;
      default:
        // hello acks, task_event, task_done, history_reset: the session layer owns them.
        this.host.onBridgeFrame(frame);
        break;
    }
  }

  private async safe(fn: () => Promise<{ ok: boolean; data?: unknown; error?: string }>): Promise<{ ok: boolean; data?: unknown; error?: string }> {
    try {
      return await fn();
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private reply(request: BridgeFrame, result: { ok: boolean; data?: unknown; error?: string }): void {
    if (request.id === null) return;
    this.send('result', result, request.id);
  }

  private scheduleAlarm(on: boolean): void {
    if (typeof chrome === 'undefined' || !chrome.alarms) return;
    try {
      if (on) {
        chrome.alarms.get(BRIDGE_ALARM, (alarm) => {
          if (chrome.runtime.lastError) return;
          if (!alarm) chrome.alarms.create(BRIDGE_ALARM, { periodInMinutes: 1 });
        });
      } else {
        chrome.alarms.clear(BRIDGE_ALARM);
      }
    } catch (err) {
      Logger.warn('Bridge', '[BRIDGE_ALARM_FAILED] Could not sync the bridge alarm', err);
    }
  }
}

/** Only ws://127.0.0.1:<port> (optionally with a path) is accepted. */
export function validatedUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'ws:') return null;
  if (parsed.hostname !== '127.0.0.1') return null;
  if (!parsed.port || Number.isNaN(Number(parsed.port))) return null;
  return `${parsed.protocol}//${parsed.hostname}:${parsed.port}${parsed.pathname}`;
}
