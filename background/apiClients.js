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
  if (typeof data.message === 'string') return data.message;
  if (typeof data.output === 'string') return data.output;

  // 4. Gemini format: data.candidates[0].content.parts[0].text
  if (Array.isArray(data.candidates) && data.candidates[0]?.content?.parts?.[0]?.text) {
    return data.candidates[0].content.parts[0].text;
  }

  return '';
}

export const ApiClients = {
  /**
   * Main completion method dispatching to selected provider
   */
  async generateCompletion(settings, messages, systemPrompt) {
    const provider = settings.provider || 'gemini';

    Logger.info('ApiClients', `[NETWORK] Dispatching completion request to provider [${provider}] with model [${settings.model}]`);

    switch (provider) {
      case 'openrouter':
        return this.callOpenRouter(settings, messages, systemPrompt);
      case 'agent_router':
        return this.callAgentRouter(settings, messages, systemPrompt);
      case 'ollama':
        return this.callOllama(settings, messages, systemPrompt);
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
   */
  async callOllama(settings, messages, systemPrompt) {
    const baseUrl = (settings.baseUrl || 'http://localhost:11434').replace(/\/$/, '');
    const url = `${baseUrl}/api/chat`;
    const startTime = Date.now();

    const formattedMessages = [
      { role: 'system', content: systemPrompt },
      ...messages.map(m => ({ role: m.role, content: m.content }))
    ];

    const body = {
      model: settings.model || 'qwen2.5:14b',
      messages: formattedMessages,
      stream: false,
      options: { temperature: settings.temperature ?? 0.1 }
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
        if (response.status === 404) {
          throw new Error(`Model "${settings.model}" not found in Ollama. Please run "ollama pull ${settings.model}" in terminal.`);
        }
        throw new Error(`Ollama API error (${response.status}): ${errText}`);
      }

      const data = await response.json();
      const content = extractTextFromLLMResponse(data);
      Logger.info('ApiClients', `[NETWORK] 200 OK (${elapsed}ms) - Output length: ${content.length} chars`);
      return content;
    } catch (err) {
      Logger.error('OllamaClient', `[NETWORK] Failed connection to Ollama at ${url}`, err.message);
      if (err.message.includes('not found in Ollama')) throw err;
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
