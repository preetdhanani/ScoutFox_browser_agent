// src/background/research/fetchText.ts
// fetch_url: read one web address from the service worker, outside the user's tab.
//
// The request carries no cookies or credentials (credentials: 'omit'), so it reads what an
// anonymous visitor reads and can never act as the user. It gives up after FETCH_TIMEOUT_MS and
// reads at most FETCH_MAX_BYTES (the body is streamed and the read stops there). Redirects are
// followed and the final address is reported. HTML is parsed like a browser parses it and becomes text (htmlText.ts); JSON, plain text
// and scripts (install.sh) pass through. A long text comes in parts, like read_page, and a query
// keeps only the lines that name one of its words.
//
// Pure apart from the fetch it is handed, so the tests stub the network.
import { pageTextPart } from '../../shared/textPaging.ts';
import { wrapUntrusted, sourceOf } from '../mcp/untrusted.ts';
import { readHtml } from './htmlText.ts';
import { checkWebUrl } from './urlPolicy.ts';

export const FETCH_TIMEOUT_MS = 15000;
export const FETCH_MAX_BYTES = 2 * 1024 * 1024;

export interface FetchDeps {
  /** The fetch to use. The service worker's global fetch by default; a test hands in a stub. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  /** The run's own signal: a Stop cancels the request. */
  signal?: AbortSignal;
}

/** One response, read with the caps. */
export interface Fetched {
  status: number;
  statusText: string;
  ok: boolean;
  /** The address the response came from, after redirects. */
  finalUrl: string;
  contentType: string;
  text: string;
  /** How many bytes were read (at most maxBytes). */
  bytes: number;
  /** True when the body was longer than maxBytes and the read stopped there. */
  truncated: boolean;
  /** True when the body is not text (NUL bytes, or a binary media type). */
  binary: boolean;
}

/** A failure the model reads as it is ("<url> did not answer within 15 s"). */
export class FetchFailure extends Error {}

const BINARY_TYPE = /^(image|audio|video|font)\/|^application\/(zip|gzip|x-gzip|x-tar|x-xz|zstd|x-zstd|x-bzip2|x-7z-compressed|pdf|octet-stream|vnd\.|x-msdownload|x-apple-diskimage|wasm|java-archive)/i;

function charsetOf(contentType: string): string {
  return /charset\s*=\s*"?([\w.:-]+)/i.exec(contentType)?.[1] || 'utf-8';
}

function decode(bytes: Uint8Array, contentType: string): string {
  try {
    return new TextDecoder(charsetOf(contentType)).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/** Reads a body up to maxBytes, streaming, and stops the download there. */
async function readCapped(response: Response, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    const all = new Uint8Array(await response.arrayBuffer());
    return all.length > maxBytes ? { bytes: all.slice(0, maxBytes), truncated: true } : { bytes: all, truncated: false };
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const room = maxBytes - total;
    if (value.length > room) {
      chunks.push(value.slice(0, room));
      total += room;
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    total += value.length;
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return { bytes, truncated };
}

/**
 * One GET with the caps: no credentials, redirects followed, a timeout, a byte limit. Throws a
 * FetchFailure with a sentence for the model when nothing usable came back.
 */
export async function fetchCapped(url: string, deps: FetchDeps = {}, accept = '*/*'): Promise<Fetched> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = deps.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxBytes = deps.maxBytes ?? FETCH_MAX_BYTES;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const onStop = () => controller.abort();
  if (deps.signal?.aborted) controller.abort();
  deps.signal?.addEventListener('abort', onStop, { once: true });
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      credentials: 'omit',
      redirect: 'follow',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      headers: { Accept: accept },
      signal: controller.signal
    });
    const contentType = response.headers.get('content-type') || '';
    const { bytes, truncated } = await readCapped(response, maxBytes);
    const sniff = bytes.subarray(0, Math.min(bytes.length, 4096));
    // A binary media type (an archive, a picture), or NUL bytes near the start. A vendor type that
    // is JSON or XML (application/vnd.github+json), and an octet-stream that is really a script, stay text.
    const binary = (BINARY_TYPE.test(contentType) && !/json|xml|text|octet-stream/i.test(contentType)) || sniff.includes(0);
    return {
      status: response.status,
      statusText: response.statusText || '',
      ok: response.ok,
      finalUrl: response.url || url,
      contentType,
      text: binary ? '' : decode(bytes, contentType),
      bytes: bytes.length,
      truncated,
      binary
    };
  } catch (err: any) {
    if (timedOut) throw new FetchFailure(`${url} did not answer within ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`}.`);
    if (deps.signal?.aborted) throw new FetchFailure('the fetch was stopped.');
    throw new FetchFailure(`${url} could not be fetched (${String(err?.message || err).slice(0, 160)}). Check the address, or search for the right one with web_search.`);
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener('abort', onStop);
  }
}

/** What kind of text a response holds, from its type and, without one, its first characters. */
export function kindOf(contentType: string, text: string): 'html' | 'json' | 'text' {
  const type = contentType.toLowerCase();
  if (/html|xhtml/.test(type)) return 'html';
  if (/json/.test(type)) return 'json';
  if (type) return 'text';
  const head = text.slice(0, 500).trimStart().toLowerCase();
  if (head.startsWith('<!doctype html') || head.startsWith('<html')) return 'html';
  if (head.startsWith('{') || head.startsWith('[')) return 'json';
  return 'text';
}

/** JSON pretty-printed (one space per level, so it pages well); the raw text when it does not parse. */
export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 1);
  } catch {
    return text;
  }
}

/** Plain text (a script, a README) kept as it is: only line endings and trailing spaces change. */
function plainText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

/** The words of a query worth matching: two letters or more, lower case, without duplicates. */
export function queryWords(query: string): string[] {
  return [...new Set(String(query || '').toLowerCase().split(/[^\p{L}\p{N}._/-]+/u).map((w) => w.replace(/^[._/-]+|[._/-]+$/g, '')).filter((w) => w.length >= 2))];
}

/** The lines of a text that contain one of the words, with their line numbers. */
export function matchingLines(text: string, words: string[]): { lines: string[]; total: number } {
  const all = text.split('\n');
  const lines: string[] = [];
  all.forEach((line, i) => {
    const lower = line.toLowerCase();
    if (line.trim() && words.some((w) => lower.includes(w))) lines.push(`L${i + 1}: ${line}`);
  });
  return { lines, total: all.filter((l) => l.trim()).length };
}

/** The last segment of an address's path ("install.sh"), or '' when the path ends in a slash. */
export function fileNameOf(url: string): string {
  try {
    const segment = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
    return decodeURIComponent(segment);
  } catch {
    return '';
  }
}

function sizeText(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The result of one fetch_url call: the text the model reads, and the name the timeline row shows. */
export interface FetchUrlOutcome {
  text: string;
  isError?: boolean;
  /** The document's title, or its file name: "Read install.sh (ollama.com)". */
  label?: string;
}

/**
 * fetch_url {url, part?, query?}. Never throws: every failure is an error result the model reads.
 */
export async function fetchUrl(args: { url?: unknown; part?: unknown; query?: unknown }, deps: FetchDeps = {}): Promise<FetchUrlOutcome> {
  const checked = checkWebUrl(args?.url);
  if (!checked.ok) return { text: `Error: fetch_url refused: ${checked.error}`, isError: true };
  const part = args?.part === undefined || args?.part === null ? 1 : Number(args.part);
  if (!Number.isInteger(part) || part < 1) return { text: `Error: part must be a whole number from 1 up, got ${JSON.stringify(args.part)}.`, isError: true };
  const query = typeof args?.query === 'string' ? args.query.trim() : '';
  const url = checked.url.href;

  let fetched: Fetched;
  try {
    fetched = await fetchCapped(url, deps, 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8');
  } catch (err: any) {
    return { text: `Error: ${err instanceof FetchFailure ? err.message : String(err?.message || err)}`, isError: true };
  }

  const finalUrl = fetched.finalUrl;
  const moved = finalUrl !== url ? `, redirected from ${url}` : '';
  const type = fetched.contentType.split(';')[0].trim() || 'no content type';
  const file = fileNameOf(finalUrl);
  if (!fetched.ok) {
    return {
      text: `Error: ${finalUrl} answered HTTP ${fetched.status}${fetched.statusText ? ` ${fetched.statusText}` : ''}${moved}. The address may be wrong or gone: do not guess another one, find it with web_search or on the site's own pages.`,
      isError: true,
      label: file || undefined
    };
  }
  if (fetched.binary) {
    return {
      text: `Fetched ${finalUrl} (HTTP ${fetched.status}, ${type}${moved}): it exists, but it is a binary file, not text, so it cannot be read. ${fetched.truncated ? `It is larger than ${sizeText(fetched.bytes)}; the download was stopped there.` : `Size: ${sizeText(fetched.bytes)}.`}`,
      label: file || undefined
    };
  }

  const kind = kindOf(fetched.contentType, fetched.text);
  const page = kind === 'html' ? readHtml(fetched.text) : null;
  const title = page?.title ?? '';
  let body = page ? page.text : kind === 'json' ? prettyJson(fetched.text) : plainText(fetched.text);
  const label = title || file || new URL(finalUrl).hostname;

  let matchNote = '';
  if (query) {
    const words = queryWords(query);
    const { lines, total } = matchingLines(body, words);
    if (!words.length) return { text: `Error: the query "${query}" has no word to look for. Leave it out to read the whole text in parts.`, isError: true, label };
    if (!lines.length) {
      return {
        text: `Fetched ${finalUrl} (HTTP ${fetched.status}, ${type}${moved}). No line of its ${total} lines matches any of: ${words.join(', ')}. Read it in parts without query, or try other words.`,
        label
      };
    }
    matchNote = `\n${lines.length} of ${total} lines match ${words.join(', ')} (only those lines are shown, with their line numbers).`;
    body = lines.join('\n');
  }

  const paged = pageTextPart(body, part, 'fetch_url');
  if (part > paged.count) {
    return { text: `Error: this text has only ${paged.count} part${paged.count === 1 ? '' : 's'}, so there is no part ${part}. Read part 1 to ${paged.count}.`, isError: true, label };
  }
  const cut = fetched.truncated ? ` The document is longer than ${sizeText(fetched.bytes)}; only that much was read.` : '';
  const head = `Fetched ${finalUrl} (HTTP ${fetched.status}, ${type}, ${sizeText(fetched.bytes)}${moved}).${cut}${title ? `\nTitle: ${title}` : ''}${matchNote}\nText (${paged.note}):`;
  return { text: `${head}\n${wrapUntrusted(sourceOf(finalUrl), paged.text || '(no text)')}`, label };
}
