// src/background/browser/network.ts
// Ring buffer and formatting for captured network requests per tab.
import { redactSensitiveData } from './redact.ts';

export interface NetworkRequestEntry {
  method?: string;
  url?: string;
  status?: number;
  ok?: boolean;
  durationMs?: number;
  error?: string;
  reqBody?: unknown;
  respBody?: unknown;
  actionMarker?: string;
  actionMarkerIndex?: number;
  [key: string]: unknown;
}

export interface NetFilter {
  status?: 'error' | 'success' | 'all';
  since?: 'last_action';
  urlContains?: string;
}

function formatBody(body: unknown): string {
  if (body === undefined || body === null) return '';
  try {
    const redacted = redactSensitiveData(body);
    const text = typeof redacted === 'string' ? redacted : (JSON.stringify(redacted) ?? '');
    return text.length > 500 ? text.slice(0, 500) + '...' : text;
  } catch (_) {
    return String(body).slice(0, 500);
  }
}

export function formatNetworkLine(req: NetworkRequestEntry, includeBody: boolean = true): string {
  const url = req.url || '';
  const relativeUrl = url.length > 80 ? url.slice(0, 80) + '...' : url;
  let line = `[${req.method || 'GET'}] ${relativeUrl} → ${req.status || 'ERR'} (${req.durationMs ?? 0}ms)`;
  if (req.error) {
    line += ` [Error: ${req.error}]`;
  }

  if (includeBody) {
    if (req.reqBody) {
      line += `\n  req:  ${formatBody(req.reqBody)}`;
    }
    if (req.respBody) {
      line += `\n  resp: ${formatBody(req.respBody)}`;
    }
  }

  return line;
}

export class NetworkBuffers {
  private buffers = new Map<number, NetworkRequestEntry[]>();
  private cap: number;

  constructor(cap: number = 100) {
    this.cap = cap;
  }

  record(tabId: number, req: NetworkRequestEntry, marker?: string): void {
    if (!tabId || !req) return;
    if (!this.buffers.has(tabId)) {
      this.buffers.set(tabId, []);
    }
    const buf = this.buffers.get(tabId)!;
    if (marker !== undefined) {
      req.actionMarker = marker;
    }
    buf.push(req);
    while (buf.length > this.cap) {
      buf.shift();
    }
  }

  read(
    tabId: number,
    filter: NetFilter = {},
    includeBody: boolean = true,
    limit: number = 10,
    lastMarker?: string
  ): string {
    const buf = this.buffers.get(tabId) || [];
    let requests = [...buf];

    if (filter.status === 'error') {
      requests = requests.filter((r) => !r.ok || (typeof r.status === 'number' && r.status >= 400) || Boolean(r.error));
    } else if (filter.status === 'success') {
      requests = requests.filter((r) => r.ok && (typeof r.status === 'number' ? r.status < 400 : true));
    }

    if (filter.since === 'last_action') {
      if (lastMarker !== undefined) {
        requests = requests.filter((r) => r.actionMarker === lastMarker);
      } else {
        const modelMarkers = requests
          .map((r) => r.actionMarker)
          .filter((m) => m && !m.startsWith('sys:'));
        const targetMarker = modelMarkers.pop();
        if (targetMarker) {
          requests = requests.filter((r) => r.actionMarker === targetMarker);
        }
        // No model-marker entry in the buffer (only system-stamped or unmarked
        // entries): there is no action to be "since", so everything the other
        // filters matched is reported. The old fallback filtered on
        // actionMarkerIndex, which nothing writes anymore (BUG-32), so the
        // guardrail was told "no network errors" while the buffer held them.
      }
    }

    if (filter.urlContains) {
      const term = filter.urlContains.toLowerCase();
      requests = requests.filter((r) => (r.url || '').toLowerCase().includes(term));
    }

    const finalSlice = requests.slice(-Math.min(limit, 50));

    if (finalSlice.length === 0) {
      return '(No network requests captured matching filter criteria)';
    }

    return finalSlice.map((r) => formatNetworkLine(r, includeBody)).join('\n\n');
  }

  delete(tabId: number): void {
    this.buffers.delete(tabId);
  }

  has(tabId: number): boolean {
    return this.buffers.has(tabId);
  }

  get(tabId: number): NetworkRequestEntry[] | undefined {
    return this.buffers.get(tabId);
  }

  set(tabId: number, buf: NetworkRequestEntry[]): void {
    this.buffers.set(tabId, buf);
  }

  clear(): void {
    this.buffers.clear();
  }
}
