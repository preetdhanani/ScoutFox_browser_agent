/**
 * API Clients for ScoutFox Agentic Browser
 * Universal adapter supporting OpenRouter, Agent Router (agentrouter.org), Ollama, Google Gemini, OpenAI-compatible APIs, Anthropic Claude.
 * Includes local storage caching, wire image header emulation, and universal response payload text extraction.
 */

import { Storage } from '../utils/storage.js';
import { Logger } from '../utils/logger.js';

/**
 * Universal text extractor for LLM API response payloads
 * Handles OpenAI choices array, Anthropic content parts, completion text fields, delta strings, and raw response objects.
 */
function extractTextFromLLMResponse(data) {
  if (!data) return '';
  if (typeof data === 'string') return data;

  // 1. Anthropic / Claude Messages format: data.content = [{ type: 'text', text: '...' }]
  if (Array.isArray(data.content)) {
    const textPart = data.content.find(p => p && (p.text || p.type === 'text'));
    if (textPart && textPart.text) return textPart.text;
  }
  if (typeof data.content === 'string') return data.content;

  // 2. OpenAI Choices format: data.choices[0].message.content or data.choices[0].text
  if (Array.isArray(data.choices) && data.choices.length > 0) {
    const choice = data.choices[0];
    if (choice) {
      if (choice.message) {
        if (typeof choice.message.content === 'string') return choice.message.content;
        if (Array.isArray(choice.message.content)) {
          const part = choice.message.content.find(p => p && p.text);
          if (part && part.text) return part.text;
        }
      }
      if (typeof choice.text === 'string') return choice.text;
      if (choice.delta && typeof choice.delta.content === 'string') return choice.delta.content;
    }
  }

  // 3. Direct text fields: data.response, data.text, data.message, data.output
  if (typeof data.response === 'string') return data.response;
  if (typeof data.text === 'string') return data.text;
  // 3b. Ollama /api/chat format: data.message = { role, content, thinking }
  // This must be tested BEFORE the `typeof data.message === 'string'` check below, which
  // never matches because Ollama sends an object. Without this branch every single Ollama
  // response fell through all the way to `return ''`, so the model generated a perfectly
  // good answer for 30 seconds and the agent saw an empty string and burned a step.
  // Thinking models (qwen3, gemma3, deepseek-r1) split their output: reasoning goes to
  // `thinking` and the real answer to `content`. If generation is cut short by num_predict
  // the model can still be mid-reasoning, leaving `content` empty — fall back to `thinking`
  // so the JSON the model was building is still recoverable by the parser.
  if (data.message && typeof data.message === 'object') {
    if (typeof data.message.content === 'string' && data.message.content.trim()) {
      return data.message.content;
    }
    if (typeof data.message.thinking === 'string' && data.message.thinking.trim()) {
      return data.message.thinking;
    }
  }
  if (typeof data.message === 'string') return data.message;
  if (typeof data.output === 'string') return data.output;

  // 4. Gemini format: data.candidates[0].content.parts[0].text
  if (Array.isArray(data.candidates) && data.candidates[0]?.content?.parts?.[0]?.text) {
    return data.candidates[0].content.parts[0].text;
  }

  return '';
}

// Models that rejected the `think` field once. Cached so the fallback retry is paid at most
// once per model per service-worker lifetime.
const OLLAMA_THINK_UNSUPPORTED = new Set();

export const ApiClients = {
  /**
   * Main completion method dispatching to selected provider
   */
  async generateCompletion(settings, messages, systemPrompt, options = {}) {
    const provider = settings.provider || 'gemini';
    const timeoutMs = Number(settings.llmTimeoutMs) > 0 ? Number(settings.llmTimeoutMs) : 120000;
    const signal = options.signal || null;

    Logger.info('ApiClients', `[NETWORK] Dispatching completion request to provider [${provider}] with model [${settings.model}] (timeout ${Math.round(timeoutMs / 1000)}s)`);

    const startedAt = Date.now();
    const dispatch = () => {
      switch (provider) {
        case 'openrouter':
          return this.callOpenRouter(settings, messages, systemPrompt);
        case 'agent_router':
          return this.callAgentRouter(settings, messages, systemPrompt);
        case 'ollama':
          return this.callOllama(settings, messages, systemPrompt, options);
        case 'openai_compatible':
        case 'openai':
          return this.callOpenAI(settings, messages, systemPrompt);
        case 'anthropic':
          return this.callAnthropic(settings, messages, systemPrompt);
        case 'gemini':
          return this.callGemini(settings, messages, systemPrompt);
        default:
          throw new Error(`Unsupported LLM provider: ${provider}`);
      }
    };

    // A provider that accepts the connection and then never answers used to park the agent
    // loop forever — and because the keepalive holds the service worker awake during a task,
    // Chrome would never reclaim it either. That turns a recoverable stall into a permanent
    // hang with no error anywhere. Race the call against a deadline and the task's abort
    // signal so the loop always regains control and always reports why.
    let timer = null;
    let onAbort = null;

    try {
      return await Promise.race([
        dispatch(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`Provider [${provider}] did not respond within ${Math.round(timeoutMs / 1000)}s. The request was abandoned — check that the endpoint and model are reachable, or raise llmTimeoutMs in settings.`));
          }, timeoutMs);
        }),
        new Promise((_, reject) => {
          if (!signal) return;
          if (signal.aborted) {
            reject(new Error('LLM request cancelled before dispatch (task stopped or paused).'));
            return;
          }
          onAbort = () => reject(new Error('LLM request cancelled (task stopped or paused).'));
          signal.addEventListener('abort', onAbort, { once: true });
        })
      ]);
    } catch (err) {
      Logger.warn('ApiClients', `[NETWORK_ABORTED] Completion via [${provider}] ended after ${Date.now() - startedAt}ms: ${err.message}`);
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }
  },

  /**
   * Dynamically fetch available models with storage caching support & live API queries
   */
  async fetchAvailableModels(settings, forceRefresh = false) {
    const provider = settings.provider || 'gemini';
    const apiKey = (settings.apiKey || settings.providerConfigs?.[provider]?.apiKey || '').trim();
    const apiKeyTag = apiKey ? apiKey.slice(-6) : 'none';
    const cacheKey = `${provider}_${settings.baseUrl || 'default'}_${apiKeyTag}`;

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
      let models = [];

      if (provider === 'openrouter') {
        const url = 'https://openrouter.ai/api/v1/models';
        const headers = {};
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
        
        const res = await fetch(url, { headers });
        const elapsed = Date.now() - startTime;
        if (!res.ok) throw new Error(`OpenRouter returned HTTP ${res.status}`);

        const data = await res.json();
        models = (data.data || []).map(m => m.id).sort();
        if (models.length === 0) {
          models = this.getFallbackModels('openrouter');
        }
        Logger.info('ApiClients', `[MODEL_FETCH] 200 OK (${elapsed}ms) - Retrieved ${models.length} model(s) from OpenRouter`);
      } else if (provider === 'ollama') {
        const baseUrl = (settings.baseUrl || 'http://localhost:11434').replace(/\/$/, '');
        const url = `${baseUrl}/api/tags`;
        const res = await fetch(url);
        const elapsed = Date.now() - startTime;
        if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status}`);

        const data = await res.json();
        models = (data.models || []).map(m => m.name);
        if (models.length === 0) models = this.getFallbackModels('ollama');
        Logger.info('ApiClients', `[MODEL_FETCH] 200 OK (${elapsed}ms) - Retrieved ${models.length} model(s) from Ollama`);
      } else if (provider === 'agent_router') {
        const rawBaseUrl = (settings.baseUrl || 'https://agentrouter.org/v1').replace(/\/$/, '');
        const baseUrl = rawBaseUrl.endsWith('/v1') ? rawBaseUrl : `${rawBaseUrl}/v1`;
        const url = `${baseUrl}/models`;

        const headers = {
          'Authorization': `Bearer ${apiKey}`,
          'x-api-key': apiKey,
          'User-Agent': 'claude-cli/2.1.158 (external, sdk-cli)',
          'x-app': 'cli',
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'claude-code-20250219,interleaved-thinking-2025-05-14',
          'anthropic-dangerous-direct-browser-access': 'true'
        };

        const res = await fetch(url, { headers });
        const elapsed = Date.now() - startTime;
        if (res.ok) {
          const data = await res.json();
          models = (data.data || data.models || []).map(m => (typeof m === 'string' ? m : (m.id || m.name))).sort();
        }
        
        if (models.length === 0) {
          models = this.getFallbackModels('agent_router');
        }
        Logger.info('ApiClients', `[MODEL_FETCH] 200 OK (${elapsed}ms) - Retrieved ${models.length} model(s) from AgentRouter`);
      } else if (provider === 'openai' || provider === 'openai_compatible') {
        const baseUrl = (settings.baseUrl || 'https://api.openai.com').replace(/\/$/, '');
        const url = baseUrl.endsWith('/v1') ? `${baseUrl}/models` : `${baseUrl}/v1/models`;
        const headers = {};
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

        const res = await fetch(url, { headers });
        const elapsed = Date.now() - startTime;
        if (!res.ok) throw new Error(`API returned HTTP ${res.status}`);

        const data = await res.json();
        models = (data.data || []).map(m => m.id).sort();
        if (models.length === 0) models = this.getFallbackModels(provider);
        Logger.info('ApiClients', `[MODEL_FETCH] 200 OK (${elapsed}ms) - Retrieved ${models.length} model(s) from OpenAI/Compatible endpoint`);
      } else if (provider === 'gemini') {
        if (apiKey) {
          const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
          const res = await fetch(url);
          const elapsed = Date.now() - startTime;
          if (res.ok) {
            const data = await res.json();
            models = (data.models || [])
              .filter(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent'))
              .map(m => m.name.replace(/^models\//, ''))
              .sort();
            Logger.info('ApiClients', `[MODEL_FETCH] 200 OK (${elapsed}ms) - Retrieved ${models.length} live model(s) from Google Gemini API`);
          } else {
            Logger.warn('ApiClients', `[MODEL_FETCH_WARN] Google Gemini API returned HTTP ${res.status}. Falling back to default list.`);
          }
        }
        
        if (models.length === 0) {
          models = this.getFallbackModels('gemini');
        }
      } else if (provider === 'anthropic') {
        models = this.getFallbackModels('anthropic');
      }

      if (models.length > 0) {
        await Storage.saveCachedModels(cacheKey, models);
      }

      return models;
    } catch (err) {
      Logger.warn('ApiClients', `[MODEL_FETCH_WARN] Network fetch failed for [${provider}]: ${err.message}. Using fallback defaults.`);
      return this.getFallbackModels(provider);
    }
  },

  getFallbackModels(provider) {
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
        return ['gpt-4o', 'gpt-4o-mini', 'llama-3.1-70b-versatile'];
      default:
        return ['gemini-2.0-flash', 'gemini-1.5-flash', 'qwen2.5:14b', 'gpt-4o-mini'];
    }
  },

  /**
   * Dedicated AgentRouter Client (https://agentrouter.org)
   * Emulates Claude CLI wire image headers and extracts response text using universal payload extractor.
   */
  async callAgentRouter(settings, messages, systemPrompt) {
    const rawBaseUrl = (settings.baseUrl || 'https://agentrouter.org/v1').replace(/\/$/, '');
    const baseUrl = rawBaseUrl.endsWith('/v1') ? rawBaseUrl : `${rawBaseUrl}/v1`;
    const apiKey = (settings.apiKey || settings.providerConfigs?.agent_router?.apiKey || '').trim();
    const startTime = Date.now();

    if (!apiKey) {
      throw new Error('AgentRouter API Key is missing. Please enter your AgentRouter API Key in Settings and click Save Settings.');
    }

    const formattedMessages = messages.map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content
    }));

    const model = settings.model || 'claude-3-5-sonnet';

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'x-api-key': apiKey,
      'User-Agent': 'claude-cli/2.1.158 (external, sdk-cli)',
      'x-app': 'cli',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'claude-code-20250219,interleaved-thinking-2025-05-14',
      'anthropic-dangerous-direct-browser-access': 'true'
    };

    try {
      // Attempt 1: Anthropic Messages endpoint
      const messagesUrl = `${baseUrl}/messages`;
      const response = await fetch(messagesUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          system: systemPrompt,
          messages: formattedMessages,
          max_tokens: 1024,
          temperature: settings.temperature ?? 0.1
        })
      });

      const elapsed = Date.now() - startTime;

      if (response.ok) {
        const data = await response.json();
        const content = extractTextFromLLMResponse(data);
        if (content) {
          Logger.info('ApiClients', `[NETWORK] 200 OK (${elapsed}ms) - Retrieved output from AgentRouter (${model}), length: ${content.length} chars`);
          return content;
        }
        Logger.warn('ApiClients', `[PAYLOAD_WARN] Messages endpoint returned 200 OK but text content was empty. Payload: ${JSON.stringify(data)}`);
      } else {
        const errText = await response.text();
        if (response.status === 401 || errText.includes('unauthorized_client_error')) {
          throw new Error(`AgentRouter Authentication Error (401): ${errText}`);
        }
      }

      // Attempt 2: Chat Completions endpoint fallback
      const completionsUrl = `${baseUrl}/chat/completions`;
      const formattedOpenAI = [
        { role: 'system', content: systemPrompt },
        ...messages.map(m => ({ role: m.role, content: m.content }))
      ];

      const resp2 = await fetch(completionsUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages: formattedOpenAI,
          temperature: settings.temperature ?? 0.1
        })
      });

      if (!resp2.ok) {
        const errText2 = await resp2.text();
        throw new Error(`AgentRouter API Error (${resp2.status}): ${errText2}`);
      }

      const data2 = await resp2.json();
      const content2 = extractTextFromLLMResponse(data2);
      if (!content2) {
        throw new Error(`AgentRouter returned empty content. Response payload: ${JSON.stringify(data2)}`);
      }

      Logger.info('ApiClients', `[NETWORK] 200 OK (${Date.now() - startTime}ms) - Retrieved output via completions fallback, length: ${content2.length} chars`);
      return content2;
    } catch (err) {
      Logger.error('AgentRouterClient', `[NETWORK] Failed request to AgentRouter`, err.message);
      throw new Error(`AgentRouter API connection error: ${err.message}`);
    }
  },

  /**
   * OpenRouter API Client
   */
  async callOpenRouter(settings, messages, systemPrompt) {
    const url = 'https://openrouter.ai/api/v1/chat/completions';
    const apiKey = (settings.apiKey || settings.providerConfigs?.openrouter?.apiKey || '').trim();
    const startTime = Date.now();

    if (!apiKey) {
      throw new Error('OpenRouter API Key is missing. Please enter your OpenRouter API Key in Settings and click Save Settings.');
    }

    const formattedMessages = [
      { role: 'system', content: systemPrompt },
      ...messages.map(m => ({ role: m.role, content: m.content }))
    ];

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://github.com/preetdhanani/ScoutFox_browser_agent',
      'X-Title': 'ScoutFox AI Agent'
    };

    const body = {
      model: settings.model || 'anthropic/claude-3.5-sonnet',
      messages: formattedMessages,
      temperature: settings.temperature ?? 0.1
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
      });

      const elapsed = Date.now() - startTime;

      if (!response.ok) {
        const errText = await response.text();
        if (response.status === 401) {
          throw new Error(`OpenRouter API Authentication Error (401): Invalid or missing API key. Please check your key in Settings.`);
        }
        throw new Error(`OpenRouter API Error (${response.status}): ${errText}`);
      }

      const data = await response.json();
      const content = extractTextFromLLMResponse(data);
      Logger.info('ApiClients', `[NETWORK] 200 OK (${elapsed}ms) - Output length: ${content.length} chars`);
      return content;
    } catch (err) {
      Logger.error('OpenRouterClient', `[NETWORK] Failed request to OpenRouter`, err.message);
      throw new Error(`OpenRouter API connection error: ${err.message}`);
    }
  },

  /**
   * Ollama API Client
   *
   * Local models need considerably more scaffolding than hosted ones. Three settings here
   * are the difference between a 9B model driving the browser and it doing nothing at all:
   *
   *   think:false  — every current local agent model (qwen3.x, gemma3/4, deepseek-r1) ships
   *                  with reasoning ON. Ollama routes that reasoning into `message.thinking`
   *                  and leaves `message.content` empty until it finishes. A 9B model can
   *                  spend 30s+ deliberating over a 120-element page and still be mid-thought
   *                  when num_predict runs out, yielding an empty answer. We do our own
   *                  reasoning in the prompt, so native thinking buys nothing and costs the
   *                  entire step. Not every model accepts the flag, so a rejection is cached
   *                  and the call retried once without it.
   *   num_ctx      — Ollama defaults to a 4096-token context REGARDLESS of what the model
   *                  supports (qwen3.5:9b advertises 262144). A page snapshot plus history
   *                  overflows that easily, and llama.cpp truncates from the FRONT — which
   *                  silently deletes the system prompt and the goal, so the model no longer
   *                  knows it is a browser agent or what it was asked to do. Nothing is
   *                  logged when this happens; the output just turns to garbage.
   *   format:json  — constrains decoding to valid JSON at the sampler. This is far more
   *                  reliable than asking a small model to emit JSON and then repairing the
   *                  result, and it removes the prose-before-JSON failure mode entirely.
   */
  async callOllama(settings, messages, systemPrompt, options = {}) {
    const baseUrl = (settings.baseUrl || 'http://localhost:11434').replace(/\/$/, '');
    const url = `${baseUrl}/api/chat`;
    const model = settings.model || 'qwen2.5:14b';
    const startTime = Date.now();

    const formattedMessages = [
      { role: 'system', content: systemPrompt },
      ...messages.map(m => ({ role: m.role, content: m.content }))
    ];

    const numCtx = Number(settings.ollamaNumCtx) > 0 ? Number(settings.ollamaNumCtx) : 8192;
    const numPredict = Number(settings.ollamaNumPredict) > 0 ? Number(settings.ollamaNumPredict) : 1024;

    const buildBody = (withThink) => {
      const body = {
        model,
        messages: formattedMessages,
        stream: false,
        options: {
          temperature: settings.temperature ?? 0.1,
          num_ctx: numCtx,
          num_predict: numPredict
        }
      };
      if (withThink) body.think = false;
      if (options.json) body.format = 'json';
      return body;
    };

    const post = async (withThink) => fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildBody(withThink))
    });

    try {
      let sendThink = !OLLAMA_THINK_UNSUPPORTED.has(model);
      let response = await post(sendThink);

      // Older builds, and models with no reasoning mode, reject the `think` field outright.
      // Remember that for the rest of the session so only the first call pays for the retry.
      if (!response.ok && sendThink && (response.status === 400 || response.status === 422)) {
        const probe = await response.clone().text().catch(() => '');
        if (/think/i.test(probe)) {
          OLLAMA_THINK_UNSUPPORTED.add(model);
          Logger.info('ApiClients', `[OLLAMA_THINK] Model [${model}] does not accept "think" — retrying without it and skipping the flag from now on.`);
          sendThink = false;
          response = await post(false);
        }
      }

      const elapsed = Date.now() - startTime;

      if (!response.ok) {
        const errText = await response.text();
        if (response.status === 404) {
          throw new Error(`Model "${model}" not found in Ollama. Please run "ollama pull ${model}" in terminal.`);
        }
        throw new Error(`Ollama API error (${response.status}): ${errText}`);
      }

      const data = await response.json();
      const content = extractTextFromLLMResponse(data);

      // Truncation is the most common silent failure on a local model, and Ollama reports it
      // plainly in done_reason. Surfacing it turns "the agent behaved oddly" into a one-line
      // instruction to raise num_predict.
      if (data && data.done_reason === 'length') {
        Logger.warn('ApiClients', `[OLLAMA_TRUNCATED] Model [${model}] hit the ${numPredict}-token generation cap mid-answer. The reply is incomplete; raise ollamaNumPredict if this repeats.`);
      }
      if (data && data.prompt_eval_count > numCtx * 0.9) {
        Logger.warn('ApiClients', `[OLLAMA_CTX_PRESSURE] Prompt used ${data.prompt_eval_count} of ${numCtx} context tokens. Ollama truncates from the front, which drops the system prompt first — raise ollamaNumCtx.`);
      }
      if (!content && data && data.message && typeof data.message === 'object') {
        Logger.warn('ApiClients', `[OLLAMA_EMPTY] Model [${model}] returned no usable text (done_reason=${data.done_reason || 'unknown'}). Keys present on message: ${Object.keys(data.message).join(', ') || 'none'}.`);
      }

      Logger.info('ApiClients', `[NETWORK] 200 OK (${elapsed}ms) - Output length: ${content.length} chars`);
      return content;
    } catch (err) {
      Logger.error('OllamaClient', `[NETWORK] Failed connection to Ollama at ${url}`, err.message);
      if (err.message.includes('not found in Ollama') || err.message.startsWith('Ollama API error')) throw err;
      throw new Error(`Cannot connect to Ollama at ${url}. Ensure Ollama is running ('OLLAMA_ORIGINS="*" ollama serve'). Details: ${err.message}`);
    }
  },

  /**
   * Google Gemini API Client
   */
  async callGemini(settings, messages, systemPrompt) {
    const model = settings.model || 'gemini-1.5-flash';
    const apiKey = (settings.apiKey || settings.providerConfigs?.gemini?.apiKey || '').trim();
    const startTime = Date.now();

    if (!apiKey) {
      throw new Error('Google Gemini API Key is missing. Please enter your Gemini API Key in the Settings tab and click Save Settings.');
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const formattedContents = messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }));

    const body = {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: formattedContents,
      generationConfig: { temperature: settings.temperature ?? 0.1 }
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      const elapsed = Date.now() - startTime;

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Gemini API Error (${response.status}): ${errText}`);
      }

      const data = await response.json();
      const answer = extractTextFromLLMResponse(data);
      if (!answer) {
        throw new Error('Gemini API returned an empty text response.');
      }
      Logger.info('ApiClients', `[NETWORK] 200 OK (${elapsed}ms) - Output length: ${answer.length} chars`);
      return answer;
    } catch (err) {
      Logger.error('GeminiClient', `[NETWORK] Failed request to Gemini (${model})`, err.message);
      throw new Error(`Gemini API Error: ${err.message}`);
    }
  },

  /**
   * OpenAI & OpenAI-compatible Client
   */
  async callOpenAI(settings, messages, systemPrompt) {
    const provider = settings.provider || 'openai';
    let defaultBase = 'https://api.openai.com';
    if (provider === 'openai_compatible') defaultBase = 'https://api.groq.com/openai/v1';

    const baseUrl = (settings.baseUrl || defaultBase).replace(/\/$/, '');
    const apiKey = (settings.apiKey || settings.providerConfigs?.[provider]?.apiKey || '').trim();
    const url = baseUrl.endsWith('/v1') ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;
    const startTime = Date.now();

    const formattedMessages = [
      { role: 'system', content: systemPrompt },
      ...messages.map(m => ({ role: m.role, content: m.content }))
    ];

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const body = {
      model: settings.model || 'gpt-4o-mini',
      messages: formattedMessages,
      temperature: settings.temperature ?? 0.1
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
      });

      const elapsed = Date.now() - startTime;

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`API Error (${response.status}): ${errText}`);
      }

      const data = await response.json();
      const content = extractTextFromLLMResponse(data);
      Logger.info('ApiClients', `[NETWORK] 200 OK (${elapsed}ms) - Output length: ${content.length} chars`);
      return content;
    } catch (err) {
      Logger.error('OpenAIClient', `[NETWORK] Failed request to ${url}`, err.message);
      throw new Error(`API connection error (${baseUrl}): ${err.message}`);
    }
  },

  /**
   * Anthropic Claude API Client
   */
  async callAnthropic(settings, messages, systemPrompt) {
    const url = 'https://api.anthropic.com/v1/messages';
    const apiKey = (settings.apiKey || settings.providerConfigs?.anthropic?.apiKey || '').trim();
    const startTime = Date.now();

    if (!apiKey) {
      throw new Error('Anthropic Claude API Key is missing. Please enter your API Key in Settings.');
    }

    const formattedMessages = messages.map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content
    }));

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'dangerously-allow-browser': 'true'
        },
        body: JSON.stringify({
          model: settings.model || 'claude-3-5-sonnet-20241022',
          system: systemPrompt,
          messages: formattedMessages,
          max_tokens: 1024,
          temperature: settings.temperature ?? 0.1
        })
      });

      const elapsed = Date.now() - startTime;

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Anthropic API error (${response.status}): ${errText}`);
      }

      const data = await response.json();
      const content = extractTextFromLLMResponse(data);
      Logger.info('ApiClients', `[NETWORK] 200 OK (${elapsed}ms) - Output length: ${content.length} chars`);
      return content;
    } catch (err) {
      Logger.error('AnthropicClient', `[NETWORK] Failed request to Anthropic`, err.message);
      throw new Error(`Anthropic API Error: ${err.message}`);
    }
  }
};
