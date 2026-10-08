/**
 * llm/models.ts - the model lists of the settings screen (FETCH_MODELS).
 *
 * LangChain has nothing for listing models, so this is the code of apiClients.js moved as it was:
 * a list is cached for an hour in `models_cache` under `<provider>_<baseUrl>_<last 6 chars of the key>`,
 * and a failure never throws, it gives the provider's fallback list instead.
 */
import { Storage } from '../../shared/storage.ts';
import { Logger } from '../../shared/logger.ts';
import { baseUrlOf, getApiKey, normalizeNvidiaBaseUrl, providerOf, withV1 } from './settings.ts';
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
  data?: Array<{ id: string }>;
  models?: Array<string | { id?: string; name: string; supportedGenerationMethods?: string[] }>;
}

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
      return ['qwen2.5:14b', 'llama3.1:8b', 'gemma2:9b'];
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
      return ['gemini-2.0-flash', 'gemini-1.5-flash', 'qwen2.5:14b', 'gpt-4o-mini'];
  }
}

/**
 * Dynamically fetch available models with storage caching support & live API queries
 */
export async function fetchAvailableModels(settings: LlmSettings, forceRefresh = false): Promise<string[]> {
  const provider = providerOf(settings);
  const apiKey = getApiKey(settings, provider);
  const apiKeyTag = apiKey ? apiKey.slice(-6) : 'none';
  const cacheKey = `${provider}_${baseUrlOf(settings) || 'default'}_${apiKeyTag}`;

  if (!forceRefresh) {
    const cached = await Storage.getCachedModels(cacheKey);
    if (cached && cached.length > 0) {
      Logger.info('ApiClients', `[MODEL_CACHE] Loaded ${cached.length} model(s) from local storage for provider [${provider}] (Instant load)`);
      return cached;
    }
  }

  Logger.info('ApiClients', `[MODEL_FETCH] Fetching fresh models via network for [${provider}]...`);
  const startTime = Date.now();

  try {
    let models: string[] = [];

    if (provider === 'openrouter') {
      const url = 'https://openrouter.ai/api/v1/models';
      const headers: Record<string, string> = {};
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

      const res = await fetch(url, { headers });
      const elapsed = Date.now() - startTime;
      if (!res.ok) throw new Error(`OpenRouter returned HTTP ${res.status}`);

      const data: ModelListPayload = await res.json();
      models = (data.data || []).map(m => m.id).sort();
      if (models.length === 0) {
        models = getFallbackModels('openrouter');
      }
      Logger.info('ApiClients', `[MODEL_FETCH] 200 OK (${elapsed}ms) - Retrieved ${models.length} model(s) from OpenRouter`);
    } else if (provider === 'ollama') {
      const baseUrl = (settings.baseUrl || 'http://localhost:11434').replace(/\/$/, '');
      const url = `${baseUrl}/api/tags`;
      const res = await fetch(url);
      const elapsed = Date.now() - startTime;
      if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status}`);

      const data: { models?: Array<{ name: string }> } = await res.json();
      models = (data.models || []).map(m => m.name);
      if (models.length === 0) models = getFallbackModels('ollama');
      Logger.info('ApiClients', `[MODEL_FETCH] 200 OK (${elapsed}ms) - Retrieved ${models.length} model(s) from Ollama`);
    } else if (provider === 'agent_router') {
      const baseUrl = withV1(settings.baseUrl || 'https://agentrouter.org/v1');
      const url = `${baseUrl}/models`;
      const headers = agentRouterHeaders(apiKey);

      const res = await fetch(url, { headers });
      const elapsed = Date.now() - startTime;
      if (res.ok) {
        const data: ModelListPayload = await res.json();
        // The old code trusted the payload here: an entry with neither id nor name would have been undefined.
        models = ((data.data || data.models || []) as Array<string | { id?: string; name?: string }>)
          .map(m => (typeof m === 'string' ? m : (m.id || m.name))).sort() as string[];
      }

      if (models.length === 0) {
        models = getFallbackModels('agent_router');
      }
      Logger.info('ApiClients', `[MODEL_FETCH] 200 OK (${elapsed}ms) - Retrieved ${models.length} model(s) from AgentRouter`);
    } else if (provider === 'openai' || provider === 'openai_compatible') {
      const url = `${withV1(settings.baseUrl || 'https://api.openai.com')}/models`;
      const headers: Record<string, string> = {};
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

      const res = await fetch(url, { headers });
      const elapsed = Date.now() - startTime;
      if (!res.ok) throw new Error(`API returned HTTP ${res.status}`);

      const data: ModelListPayload = await res.json();
      models = (data.data || []).map(m => m.id).sort();
      if (models.length === 0) models = getFallbackModels(provider);
      Logger.info('ApiClients', `[MODEL_FETCH] 200 OK (${elapsed}ms) - Retrieved ${models.length} model(s) from OpenAI/Compatible endpoint`);
    } else if (provider === 'gemini') {
      if (apiKey) {
        // The key goes in the x-goog-api-key header, as for the chat calls, and not in the URL, which ends up in DevTools and in logs.
        const url = 'https://generativelanguage.googleapis.com/v1beta/models';
        const res = await fetch(url, { headers: { 'x-goog-api-key': apiKey } });
        const elapsed = Date.now() - startTime;
        if (res.ok) {
          const data: ModelListPayload = await res.json();
          models = (data.models || [])
            .filter((m): m is { name: string; supportedGenerationMethods?: string[] } => typeof m !== 'string')
            .filter(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent'))
            .map(m => m.name.replace(/^models\//, ''))
            .sort();
          Logger.info('ApiClients', `[MODEL_FETCH] 200 OK (${elapsed}ms) - Retrieved ${models.length} live model(s) from Google Gemini API`);
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
      const nonChatPattern = /embed|rerank|guard|safety|clip/i;
      models = (data.data || [])
        .map(m => (typeof m?.id === 'string' ? m.id.trim() : ''))
        .filter(id => Boolean(id) && !nonChatPattern.test(id))
        .sort();
      if (models.length === 0) models = getFallbackModels('nvidia');
      Logger.info('ApiClients', `[MODEL_FETCH] 200 OK (${elapsed}ms) - Retrieved ${models.length} model(s) from NVIDIA NIM endpoint`);
    } else if (provider === 'anthropic') {
      models = getFallbackModels('anthropic');
    }

    if (models.length > 0) {
      await Storage.saveCachedModels(cacheKey, models);
    }

    return models;
  } catch (err) {
    Logger.warn('ApiClients', `[MODEL_FETCH_WARN] Network fetch failed for [${provider}]: ${(err as Error).message}. Using fallback defaults.`);
    return getFallbackModels(provider);
  }
}
