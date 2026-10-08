/**
 * API Clients for ScoutFox Agentic Browser
 *
 * A thin shim over src/background/llm (LangChain chat models built per call). The exported ApiClients object
 * keeps the members the engine, the background script and the tests use, and delegates every one of them:
 *   - openrouter, openai, openai_compatible (Groq, keyless local servers), anthropic, gemini: llm/factory.ts
 *   - ollama: llm/ollama.ts (ChatOllama with the action or plan schema as `format`)
 *   - agent_router: llm/agentRouter.ts (ChatAnthropic first, ChatOpenAICompletions as the fallback)
 *   - the deadline, the abort signal and the log lines of a call: llm/index.ts
 *   - model lists and their cache: llm/models.ts
 */

import { generateCompletion, callProvider, fetchAvailableModels, getFallbackModels } from '../src/background/llm/index.ts';

export const ApiClients = {
  /**
   * Main completion method dispatching to selected provider
   */
  generateCompletion(settings, messages, systemPrompt, options = {}) {
    return generateCompletion(settings, messages, systemPrompt, options);
  },

  /**
   * Dynamically fetch available models with storage caching support & live API queries
   */
  fetchAvailableModels(settings, forceRefresh = false) {
    return fetchAvailableModels(settings, forceRefresh);
  },

  getFallbackModels(provider) {
    return getFallbackModels(provider);
  },

  /**
   * OpenRouter API Client
   */
  callOpenRouter(settings, messages, systemPrompt, options = {}) {
    return callProvider('openrouter', settings, messages, systemPrompt, options);
  },

  /**
   * OpenAI & OpenAI-compatible Client
   */
  callOpenAI(settings, messages, systemPrompt, options = {}) {
    const provider = settings.provider === 'openai_compatible' ? 'openai_compatible' : 'openai';
    return callProvider(provider, settings, messages, systemPrompt, options);
  },

  /**
   * Anthropic Claude API Client
   */
  callAnthropic(settings, messages, systemPrompt, options = {}) {
    return callProvider('anthropic', settings, messages, systemPrompt, options);
  },

  /**
   * Google Gemini API Client
   */
  callGemini(settings, messages, systemPrompt, options = {}) {
    return callProvider('gemini', settings, messages, systemPrompt, options);
  },

  /**
   * Dedicated AgentRouter Client (https://agentrouter.org)
   * Emulates Claude CLI wire image headers: the Messages endpoint first, the Chat Completions endpoint as the fallback.
   */
  callAgentRouter(settings, messages, systemPrompt, options = {}) {
    return callProvider('agent_router', settings, messages, systemPrompt, options);
  },

  /**
   * NVIDIA NIM Client (build.nvidia.com)
   */
  callNvidia(settings, messages, systemPrompt, options = {}) {
    return callProvider('nvidia', settings, messages, systemPrompt, options);
  },

  /**
   * Ollama API Client
   * Sends think:false, an explicit context window and, when the caller gives one, its schema as `format`.
   */
  callOllama(settings, messages, systemPrompt, options = {}) {
    return callProvider('ollama', settings, messages, systemPrompt, options);
  }
};
