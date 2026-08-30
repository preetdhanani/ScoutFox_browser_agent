/**
 * API Clients for Strawberry Agentic Browser
 * Universal adapter supporting Ollama, OpenAI-compatible APIs, Anthropic Claude, and Google Gemini.
 * Includes local storage caching to prevent redundant model fetch requests.
 */

import { Storage } from '../utils/storage.js';
import { Logger } from '../utils/logger.js';

export const ApiClients = {
  /**
   * Main completion method dispatching to selected provider
   */
  async generateCompletion(settings, messages, systemPrompt) {
    const provider = settings.provider || 'gemini';

    Logger.info('ApiClients', `[NETWORK] Dispatching completion request to provider [${provider}] with model [${settings.model}]`);

    switch (provider) {
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
   * Dynamically fetch available models with storage caching support
   */
  async fetchAvailableModels(settings, forceRefresh = false) {
    const provider = settings.provider || 'gemini';
    const apiKeyTag = settings.apiKey ? settings.apiKey.slice(-6) : 'none';
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

      if (provider === 'ollama') {
        const baseUrl = (settings.baseUrl || 'http://localhost:11434').replace(/\/$/, '');
        const url = `${baseUrl}/api/tags`;
        const res = await fetch(url);
        const elapsed = Date.now() - startTime;
        if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status}`);

        const data = await res.json();
        models = (data.models || []).map(m => m.name);
        if (models.length === 0) models = ['qwen2.5:14b', 'llama3.1:8b', 'gemma2:9b'];
        Logger.info('ApiClients', `[MODEL_FETCH] 200 OK (${elapsed}ms) - Retrieved ${models.length} model(s) from Ollama`);
      } else if (provider === 'gemini') {
        if (!settings.apiKey) {
          models = ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-2.0-flash-exp', 'gemini-1.5-flash-8b'];
        } else {
          const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${settings.apiKey}`;
          const res = await fetch(url);
          const elapsed = Date.now() - startTime;
          if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Gemini API error (${res.status}): ${errText}`);
          }
          const data = await res.json();
          models = (data.models || [])
            .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
            .map(m => m.name.replace(/^models\//, ''))
            .filter(name => name.startsWith('gemini'));

          if (models.length === 0) models = ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-2.0-flash-exp'];
          Logger.info('ApiClients', `[MODEL_FETCH] 200 OK (${elapsed}ms) - Retrieved ${models.length} Gemini model(s)`);
        }
      } else if (provider === 'openai' || provider === 'openai_compatible') {
        const baseUrl = (settings.baseUrl || 'https://api.openai.com').replace(/\/$/, '');
        const url = `${baseUrl}/v1/models`;
        const headers = {};
        if (settings.apiKey) headers['Authorization'] = `Bearer ${settings.apiKey}`;

        const res = await fetch(url, { headers });
        const elapsed = Date.now() - startTime;
        if (!res.ok) throw new Error(`API returned HTTP ${res.status}`);

        const data = await res.json();
        models = (data.data || []).map(m => m.id).sort();
        if (models.length === 0) models = ['gpt-4o-mini', 'gpt-4o', 'llama-3.1-70b-versatile'];
        Logger.info('ApiClients', `[MODEL_FETCH] 200 OK (${elapsed}ms) - Retrieved ${models.length} model(s)`);
      } else if (provider === 'anthropic') {
        models = ['claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022', 'claude-3-opus-20240229'];
      }

      if (models && models.length > 0) {
        await Storage.saveCachedModels(cacheKey, models);
      }

      return models;
    } catch (err) {
      Logger.warn('ApiClients', `Could not fetch dynamic models for [${provider}]`, err.message);
      if (provider === 'ollama') return ['qwen2.5:14b', 'llama3.1:8b', 'gemma2:9b'];
      if (provider === 'gemini') return ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-2.0-flash-exp'];
      return ['gemini-1.5-flash', 'qwen2.5:14b', 'gpt-4o-mini'];
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
      const content = data.message?.content || '';
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
    const apiKey = settings.apiKey || '';
    const startTime = Date.now();

    if (!apiKey) {
      throw new Error('Google Gemini API Key is missing. Please enter your Gemini API Key in the Settings tab.');
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
      const answer = data.candidates?.[0]?.content?.parts?.[0]?.text;
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
    const baseUrl = (settings.baseUrl || 'https://api.openai.com').replace(/\/$/, '');
    const url = `${baseUrl}/v1/chat/completions`;
    const startTime = Date.now();

    const formattedMessages = [
      { role: 'system', content: systemPrompt },
      ...messages.map(m => ({ role: m.role, content: m.content }))
    ];

    const headers = { 'Content-Type': 'application/json' };
    if (settings.apiKey) headers['Authorization'] = `Bearer ${settings.apiKey}`;

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
      const content = data.choices?.[0]?.message?.content || '';
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
    const startTime = Date.now();

    const formattedMessages = messages.map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content
    }));

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': settings.apiKey || '',
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
      const content = data.content?.[0]?.text || '';
      Logger.info('ApiClients', `[NETWORK] 200 OK (${elapsed}ms) - Output length: ${content.length} chars`);
      return content;
    } catch (err) {
      Logger.error('AnthropicClient', `[NETWORK] Failed request to Anthropic`, err.message);
      throw new Error(`Anthropic API connection error: ${err.message}`);
    }
  }
};
