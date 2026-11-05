/**
 * llm/models.ts - the model lists of the settings screen (FETCH_MODELS).
 *
 * LangChain has nothing for listing models, so this module provides model discovery and listing:
 * a list is cached for an hour in `models_cache` under `<provider>_<baseUrl>_<last 6 chars of the key>`,
 * and a failure never throws, it gives the provider's fallback list instead.
 */
import { Storage } from '../../shared/storage.ts';
import { Logger } from '../../shared/logger.ts';
import { baseUrlOf, customModelsUrl, endpointOriginOf, getApiKey, normalizeNvidiaBaseUrl, providerOf, withV1 } from './settings.ts';
import { scrubKey } from './errors.ts';
import { rememberAnthropicList, rememberGeminiList, rememberOpenRouterList } from './effort.ts';
import { watchFetch } from './factory.ts';
import { contextLengthOf } from '../../shared/tokens.ts';
import type { CustomProvider } from '../../shared/storage.ts';
import type { LlmSettings } from './types.ts';

/** Wire-image headers AgentRouter expects on every request (Content-Type added by POST callers). */
export function agentRouterHeaders(apiKey: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${apiKey}`,
    'x-api-key': apiKey,
    'User-Agent': 'claude-cli/2.1.158 (external, sdk-cli)',
    'x-app': 'cli',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'claude-code-20250219,interleaved-thinking-2025-05-14',
    'anthropic-dangerous-direct-browser-access': 'true'
  };
}

/** The parts of a model-list answer that this file reads: OpenAI-style `data`, and `models` for Gemini and AgentRouter. */
interface ModelListPayload {
  data?: Array<{ id: string; [field: string]: unknown }>;
  models?: Array<string | { id?: string; name: string; supportedGenerationMethods?: string[] }>;
}

/** Model ids that cannot answer a chat call, filtered out of every fetched list (embedders, rerankers, guards). */
const NON_CHAT_MODEL_PATTERN = /embed|rerank|guard|safety|clip/i;

/**
 * The fallback lists of the built-in providers, used when a fetch fails or answers nothing. A provider
 * this file does not know (a user-added custom endpoint) gets an EMPTY list: guessing Gemini or Ollama
 * ids for a gateway ScoutFox has never seen would fill its picker with models it cannot serve. The
 * caller that knows the custom descriptor hands back its saved list instead.
 */
export function getFallbackModels(provider: string): string[] {
  switch (provider) {
    case 'openrouter':
      return [
        'anthropic/claude-3.5-sonnet',
        'meta-llama/llama-3.3-70b-instruct',
        'google/gemini-2.0-flash-001',
        'deepseek/deepseek-r1',
        'deepseek/deepseek-chat',
        'openai/gpt-4o-mini'
      ];
    case 'agent_router':
      return [
        'claude-3-5-sonnet',
        'gpt-4o',
        'deepseek-r1',
        'llama-3.3-70b',
        'claude-3-haiku'
      ];
    case 'ollama':
      return ['qwen3.8:27b-mlx', 'qwen2.5:14b', 'llama3.1:8b', 'gemma2:9b'];
    case 'gemini':
      return [
        'gemini-2.0-flash',
        'gemini-2.0-flash-lite',
        'gemini-1.5-flash',
        'gemini-1.5-pro',
        'gemini-2.0-pro-exp-02-05',
        'gemini-1.5-flash-8b'
      ];
    case 'anthropic':
      return ['claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022'];
    case 'openai':
    case 'openai_compatible':
      return ['gpt-4o', 'gpt-4o-mini', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];
    case 'nvidia':
      return [
        'meta/llama-3.3-70b-instruct',
        'deepseek-ai/deepseek-r1',
        'nvidia/llama-3.1-nemotron-70b-instruct',
        'meta/llama-3.1-405b-instruct',
        'mistralai/mixtral-8x22b-instruct',
        'qwen/qwen2.5-72b-instruct',
        'nvidia/nemotron-4-340b-instruct'
      ];
    default:
      // A custom (or unknown) provider has no curated list to guess with: the honest fallback is none.
      return [];
  }
}

/**
 * The model-list request and parse of one user-added endpoint, per its protocol. A failed response
 * carries its body with the key scrubbed out, and a redirect that leaves the endpoint's origin is
 * refused exactly as the chat call refuses one (a relay must not be able to walk the model-list
 * request elsewhere either).
 */
/** The models one user-added endpoint lists, with the count of ids that were filtered out for not
 * being chat models (embedders, rerankers, guards) - the panel shows that count beside the list. */
interface CustomModelList {
  models: string[];
  filteredCount: number;
  /** The context window of each listed model that names one (see contextLengthOf). */
  windows: Record<string, number>;
}

/**
 * The context windows a `/models` list names, by model id. Only entries that name one are kept;
 * the ids themselves stay in models_cache as they are.
 */
export function contextWindowsOf(entries: unknown): Record<string, number> {
  const windows: Record<string, number> = {};
  for (const entry of Array.isArray(entries) ? entries : []) {
    const id = typeof (entry as any)?.id === 'string' ? (entry as any).id.trim() : '';
    const n = contextLengthOf(entry);
    if (id && n) windows[id] = n;
  }
  return windows;
}

/** Keeps the windows a model list named, for getEffectiveContextWindow. A list that names none writes nothing. */
async function rememberContextWindows(provider: string, entries: unknown): Promise<void> {
  const windows = contextWindowsOf(entries);
  if (Object.keys(windows).length === 0) return;
  try {
    await Storage.saveCachedContextWindows(provider, windows);
  } catch {
    // A window that is not kept falls back to the default; the model list itself is unaffected.
  }
}

async function fetchCustomProviderModels(custom: CustomProvider, apiKey: string, providerId: string, startTime: number): Promise<CustomModelList> {
  const url = customModelsUrl(custom.protocol, custom.baseUrl || '');
  const headers: Record<string, string> = {};
  if (custom.protocol === 'anthropic') {
    if (apiKey) headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
  } else if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  // The model list travels through the same watcher as a chat call: the key is scrubbed out of an
  // error body, and a redirect that leaves the endpoint's origin is refused exactly as the chat
  // call refuses one (a relay must not be able to walk the model-list request elsewhere either).
  const watch = watchFetch({ apiKey, refuseForeignRedirects: endpointOriginOf(custom.baseUrl) || undefined });
  const res = await watch.fetch(url, { headers });
  const elapsed = Date.now() - startTime;
  if (!res.ok) {
    // 404 and 405 mean "this server has no model list", which is a shape of endpoint, not a
    // failure: the dialog treats it as its own answer and the user adds ids by hand. The status
    // rides on the error, so the FETCH_MODELS route can hand it to the panel.
    if (res.status === 404 || res.status === 405) {
      const noList = new Error(`This endpoint has no model list (HTTP ${res.status}). Add the model ids by hand; chat calls still work.`) as Error & { status: number };
      noList.status = res.status;
      throw noList;
    }
    let detail = '';
    try {
      detail = scrubKey(await res.text(), apiKey).trim().slice(0, 200);
    } catch {
      // The body did not arrive; the status is all there is.
    }
    const httpError = new Error(`API returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`) as Error & { status?: number };
    httpError.status = res.status;
    throw httpError;
  }

  let data: ModelListPayload;
  try {
    data = await res.json();
  } catch {
    throw new Error(`${custom.displayName || providerId} answered, but not with JSON. Is the URL the model-list endpoint of an OpenAI- or Anthropic-compatible server?`);
  }
  const raw = (data.data || [])
    .map(m => (typeof m?.id === 'string' ? m.id.trim() : ''))
    .filter(id => Boolean(id));
  const kept = raw.filter(id => !NON_CHAT_MODEL_PATTERN.test(id));
  const filteredCount = raw.length - kept.length;
  const unique = [...new Set(kept)].sort();
  Logger.debug('ApiClients', `[MODEL_FETCH] 200 OK (${elapsed}ms) - Retrieved ${unique.length} model(s) from ${custom.displayName || providerId}${filteredCount > 0 ? ` (${filteredCount} non-chat id(s) hidden)` : ''}`);
  return { models: unique, filteredCount, windows: contextWindowsOf(data.data) };
}

/**
 * Dynamically fetch available models with storage caching support & live API queries.
 * `meta`, when given, is filled in for a user-added endpoint: `filteredCount` is how many ids the
 * endpoint listed that cannot answer a chat call and were therefore hidden from the list.
 */
export async function fetchAvailableModels(settings: LlmSettings, forceRefresh = false, meta?: { filteredCount?: number }): Promise<string[]> {
  const provider = providerOf(settings);
  const apiKey = getApiKey(settings, provider);
  const apiKeyTag = apiKey ? apiKey.slice(-6) : 'none';
  const cacheKey = `${provider}_${baseUrlOf(settings) || 'default'}_${apiKeyTag}`;
  // A user-added endpoint resolves to its descriptor here: it decides the dialect, the URL and the
  // saved list that stands in when the endpoint cannot be asked.
  const custom = settings.customProviders?.[provider];

  if (!forceRefresh) {
    const cached = await Storage.getCachedModels(cacheKey);
    if (cached && cached.length > 0) {
      Logger.debug('ApiClients', `[MODEL_CACHE] Loaded ${cached.length} model(s) from local storage for provider [${provider}] (Instant load)`);
      return cached;
    }
  }

  Logger.debug('ApiClients', `[MODEL_FETCH] Fetching fresh models via network for [${provider}]...`);
  const startTime = Date.now();

  try {
    let models: string[] = [];

    if (custom) {
      const listed = await fetchCustomProviderModels(custom, apiKey, provider, startTime);
      if (meta) meta.filteredCount = listed.filteredCount;
      models = listed.models;
      if (Object.keys(listed.windows).length) await Storage.saveCachedContextWindows(provider, listed.windows).catch(() => {});
      if (models.length === 0) {
        // An endpoint that lists nothing (some gateways block GET /models) falls back to the list
        // the user saved, which may itself be empty: the picker then shows the honest empty state.
        models = [...custom.models];
      }
      Logger.debug('ApiClients', `[MODEL_FETCH] ${models.length} model(s) available for [${custom.displayName || provider}]`);
    } else if (provider === 'openrouter') {
      const url = 'https://openrouter.ai/api/v1/models';
      const headers: Record<string, string> = {};
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

      const res = await fetch(url, { headers });
      const elapsed = Date.now() - startTime;
      if (!res.ok) throw new Error(`OpenRouter returned HTTP ${res.status}`);

      const data: ModelListPayload = await res.json();
      models = (data.data || []).map(m => m.id).sort();
      // The same list says which models can reason and with which efforts (llm/effort.ts).
      rememberOpenRouterList(settings, data.data || []);
      await rememberContextWindows(provider, data.data);
      if (models.length === 0) {
        models = getFallbackModels('openrouter');
      }
      Logger.debug('ApiClients', `[MODEL_FETCH] 200 OK (${elapsed}ms) - Retrieved ${models.length} model(s) from OpenRouter`);
    } else if (provider === 'ollama') {
      const baseUrl = (settings.baseUrl || 'http://localhost:11434').replace(/\/$/, '');
      const url = `${baseUrl}/api/tags`;
      const res = await fetch(url);
      const elapsed = Date.now() - startTime;
      if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status}`);

      const data: { models?: Array<{ name: string }> } = await res.json();
      models = (data.models || []).map(m => m.name);
      if (models.length === 0) models = getFallbackModels('ollama');
      Logger.debug('ApiClients', `[MODEL_FETCH] 200 OK (${elapsed}ms) - Retrieved ${models.length} model(s) from Ollama`);
    } else if (provider === 'agent_router') {
      const baseUrl = withV1(settings.baseUrl || 'https://agentrouter.org/v1');
      const url = `${baseUrl}/models`;
      const headers = agentRouterHeaders(apiKey);

      const res = await fetch(url, { headers });
      const elapsed = Date.now() - startTime;
      if (res.ok) {
        const data: ModelListPayload = await res.json();
        await rememberContextWindows(provider, data.data);
        // The old code trusted the payload here: an entry with neither id nor name would have been undefined.
        models = ((data.data || data.models || []) as Array<string | { id?: string; name?: string }>)
          .map(m => (typeof m === 'string' ? m : (m.id || m.name))).sort() as string[];
      }

      if (models.length === 0) {
        models = getFallbackModels('agent_router');
      }
      Logger.debug('ApiClients', `[MODEL_FETCH] 200 OK (${elapsed}ms) - Retrieved ${models.length} model(s) from AgentRouter`);
    } else if (provider === 'openai' || provider === 'openai_compatible') {
      const url = `${withV1(settings.baseUrl || 'https://api.openai.com')}/models`;
      const headers: Record<string, string> = {};
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

      const res = await fetch(url, { headers });
      const elapsed = Date.now() - startTime;
      if (!res.ok) throw new Error(`API returned HTTP ${res.status}`);

      const data: ModelListPayload = await res.json();
      await rememberContextWindows(provider, data.data);
      models = (data.data || []).map(m => m.id).sort();
      if (models.length === 0) models = getFallbackModels(provider);
      Logger.debug('ApiClients', `[MODEL_FETCH] 200 OK (${elapsed}ms) - Retrieved ${models.length} model(s) from OpenAI/Compatible endpoint`);
    } else if (provider === 'gemini') {
      if (apiKey) {
        // The key goes in the x-goog-api-key header, as for the chat calls, and not in the URL, which ends up in DevTools and in logs.
        const url = 'https://generativelanguage.googleapis.com/v1beta/models';
        const res = await fetch(url, { headers: { 'x-goog-api-key': apiKey } });
        const elapsed = Date.now() - startTime;
        if (res.ok) {
          const data: ModelListPayload = await res.json();
          // Each entry says whether the model thinks (`thinking`), for llm/effort.ts.
          rememberGeminiList(settings, (data.models || []) as any[]);
          models = (data.models || [])
            .filter((m): m is { name: string; supportedGenerationMethods?: string[] } => typeof m !== 'string')
            .filter(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent'))
            .map(m => m.name.replace(/^models\//, ''))
            .sort();
          Logger.debug('ApiClients', `[MODEL_FETCH] 200 OK (${elapsed}ms) - Retrieved ${models.length} live model(s) from Google Gemini API`);
        } else {
          Logger.warn('ApiClients', `[MODEL_FETCH_WARN] Google Gemini API returned HTTP ${res.status}. Falling back to default list.`);
        }
      }

      if (models.length === 0) {
        models = getFallbackModels('gemini');
      }
    } else if (provider === 'nvidia') {
      const baseUrl = normalizeNvidiaBaseUrl(baseUrlOf(settings));
      const url = `${baseUrl}/models`;
      const headers: Record<string, string> = {};
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }

      const res = await fetch(url, { headers });
      const elapsed = Date.now() - startTime;
      if (!res.ok) {
        let errDetail = '';
        try {
          const errJson = await res.json();
          errDetail = errJson?.error?.message || errJson?.detail || '';
        } catch {
          try { errDetail = (await res.text()).slice(0, 200); } catch {}
        }
        throw new Error(`API returned HTTP ${res.status}${errDetail ? `: ${errDetail}` : ''}`);
      }

      const data: ModelListPayload = await res.json();
      await rememberContextWindows(provider, data.data);
      models = (data.data || [])
        .map(m => (typeof m?.id === 'string' ? m.id.trim() : ''))
        .filter(id => Boolean(id) && !NON_CHAT_MODEL_PATTERN.test(id))
        .sort();
      if (models.length === 0) models = getFallbackModels('nvidia');
      Logger.debug('ApiClients', `[MODEL_FETCH] 200 OK (${elapsed}ms) - Retrieved ${models.length} model(s) from NVIDIA NIM endpoint`);
    } else if (provider === 'anthropic') {
      // Anthropic's model list carries each model's capabilities (thinking types, effort values),
      // which llm/effort.ts reads. Without a key, or when the list fails, the curated ids stand.
      if (apiKey) {
        const res = await fetch('https://api.anthropic.com/v1/models?limit=100', {
          headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }
        });
        if (res.ok) {
          const data: ModelListPayload = await res.json();
          rememberAnthropicList(settings, data.data || []);
          models = (data.data || []).map(m => m.id).filter(Boolean).sort();
          Logger.debug('ApiClients', `[MODEL_FETCH] 200 OK (${Date.now() - startTime}ms) - Retrieved ${models.length} model(s) from Anthropic`);
        } else {
          Logger.warn('ApiClients', `[MODEL_FETCH_WARN] Anthropic /v1/models returned HTTP ${res.status}. Falling back to default list.`);
        }
      }
      if (models.length === 0) models = getFallbackModels('anthropic');
    }

    if (models.length > 0) {
      await Storage.saveCachedModels(cacheKey, models);
    }

    return models;
  } catch (err) {
    // "This endpoint has no model list" (404/405) is a shape of endpoint, not a failed fetch: the
    // panel needs the distinction to say "add ids by hand" instead of "could not fetch". Let it
    // escape so the FETCH_MODELS route answers with the status and the saved list as fallback.
    const status = (err as { status?: number })?.status;
    if (status === 404 || status === 405) throw err;
    Logger.warn('ApiClients', `[MODEL_FETCH_WARN] Network fetch failed for [${provider}]: ${(err as Error).message}. Using fallback defaults.`);
    // A custom endpoint falls back to the list its user saved, which may be empty; a built-in to its curated list.
    return custom ? [...custom.models] : getFallbackModels(provider);
  }
}

/** The windows /api/show reported, by "<baseUrl>|<model>". A model's window does not change while it is installed. */
const shownWindows = new Map<string, number>();

/** Forgets the windows /api/show reported (tests, and a model pulled again under the same name). */
export function clearShownWindows(): void {
  shownWindows.clear();
}

/**
 * The context window an Ollama server reports for a model (/api/show, model_info), or null when it
 * reports none or cannot be asked. A reported window is remembered for the life of the worker, so
 * the per-call num_ctx does not cost a request every round.
 */
export async function fetchModelContextWindow(settings: LlmSettings, model: string): Promise<number | null> {
  const provider = providerOf(settings);
  const baseUrl = (baseUrlOf(settings) || 'http://localhost:11434').replace(/\/$/, '');
  if (provider !== 'ollama' || !model) return null;
  const memo = shownWindows.get(`${baseUrl}|${model}`);
  if (memo) return memo;

  try {
    const res = await fetch(`${baseUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model })
    });
    if (!res.ok) {
      Logger.warn('ApiClients', `[MODEL_CTX] Ollama /api/show for ${model} returned HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    // { model_info: { "general.architecture": "qwen35", "qwen35.context_length": 262144, ... } }
    const info = data?.model_info;
    if (!info || typeof info !== 'object') return null;
    const arch = typeof info['general.architecture'] === 'string' ? info['general.architecture'] : '';
    const keys = [arch ? `${arch}.context_length` : '', 'general.context_length', 'context_length', 'llama.context_length']
      .filter(Boolean)
      .concat(Object.keys(info).filter((k) => k.endsWith('.context_length')));
    for (const key of keys) {
      const val = Number(info[key]);
      if (Number.isFinite(val) && val > 0) {
        shownWindows.set(`${baseUrl}|${model}`, val);
        Logger.debug('ApiClients', `[MODEL_CTX] Context window of ${model}: ${val} tokens (${key})`);
        return val;
      }
    }
    return null;
  } catch (err) {
    Logger.warn('ApiClients', `[MODEL_CTX] Failed to fetch context window for ${model}: ${(err as Error).message}`);
    return null;
  }
}

/** Where a context window comes from: the user's value, the provider, the Ollama family table, or the default. */
export type ContextWindowSource = 'user' | 'provider' | 'estimate' | 'default';

export interface ContextWindow {
  tokens: number;
  source: ContextWindowSource;
}

/** The key of a model's window in settings.contextWindow. */
export function contextWindowKey(provider: string, model: string): string {
  return `${provider}|${model}`;
}

/** The typical window of an Ollama model family, or null when the name says nothing. */
function ollamaFamilyWindow(model: string): number | null {
  if (model.includes('qwen3') || model.includes('qwen2.5')) return 262144;
  if (model.includes('llama3.1') || model.includes('llama3.2')) return 131072;
  if (model.includes('llama3')) return 8192;
  if (model.includes('gemma2') || model.includes('gemma3')) return 8192;
  if (model.includes('mistral') || model.includes('mixtral')) return 32768;
  if (model.includes('phi3') || model.includes('phi4')) return 131072;
  if (model.includes('deepseek')) return 131072;
  if (model.includes('nemotron')) return 131072;
  return null;
}

/**
 * The context window of the chosen model, and where the number comes from, in this order:
 *   1. the user's value, settings.contextWindow["provider|model"] (user);
 *   2. the provider: Ollama's /api/show, or the window the model list named (models_ctx_cache;
 *      the list is fetched by the model picker, never per call) (provider);
 *   3. Ollama only: the family table (estimate);
 *   4. Ollama: num_ctx of Settings (ollamaNumCtx), every other provider: 256K (default).
 * Ollama's num_ctx is this same number, so what the meter shows is what Ollama is sent.
 */
export async function getEffectiveContextWindow(settings: LlmSettings): Promise<ContextWindow> {
  const provider = providerOf(settings);
  const model = settings.model || '';

  const user = Number(settings.contextWindow?.[contextWindowKey(provider, model)]);
  if (Number.isFinite(user) && user > 0) return { tokens: Math.round(user), source: 'user' };

  if (provider === 'ollama') {
    const shown = await fetchModelContextWindow(settings, model);
    if (shown && shown > 0) return { tokens: shown, source: 'provider' };
    const family = model ? ollamaFamilyWindow(model) : null;
    if (family) return { tokens: family, source: 'estimate' };
    const numCtx = Number(settings.ollamaNumCtx);
    return { tokens: numCtx > 0 ? numCtx : DEFAULT_CONTEXT_WINDOW, source: 'default' };
  }

  const listed = Number((await Storage.getCachedContextWindows(provider).catch(() => null))?.[model]);
  if (Number.isFinite(listed) && listed > 0) return { tokens: listed, source: 'provider' };
  return { tokens: DEFAULT_CONTEXT_WINDOW, source: 'default' };
}

/** Default context window (tokens) when nothing names one. */
export const DEFAULT_CONTEXT_WINDOW = 262144; // 256K
