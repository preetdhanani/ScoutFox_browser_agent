/**
 * llm/index.ts - the LLM client and model surface.
 *
 *   generateCompletion(settings, messages, systemPrompt, { signal, json, schema }) -> string
 *   fetchAvailableModels(settings, forceRefresh)                                   -> string[]
 *
 * generateCompletion handles completion calls: one log line on dispatch, a deadline
 * (settings.llmTimeoutMs, 120 s by default) plus the task's abort signal, one log line when a call fails.
 * What is new is what happens under it. The provider call is a LangChain chat model built for that call
 * (factory.ts, ollama.ts, agentRouter.ts), and the deadline and the signal really cancel its request (deadline.ts).
 */
import { Logger } from '../../shared/logger.ts';
import { callAgentRouter } from './agentRouter.ts';
import { withDeadline } from './deadline.ts';
import { GEMINI_EMPTY_TEXT, ProviderError, assertApiKey, classifyProviderFailure, describeCustomFailure, describeFailure, retryAfterOf, wrapCustomFailure, wrapFailure } from './errors.ts';
import { createCustomProviderCall, createProviderCall, toLangChainMessages } from './factory.ts';
import type { ProviderCall } from './factory.ts';
import { callOllama } from './ollama.ts';
import { getApiKey, providerOf, timeoutMsOf, timeoutSourceOf } from './settings.ts';
import { isChatProvider } from './types.ts';
import type { ChatProvider, ChatTurn, CompletionOptions, LlmSettings } from './types.ts';

export { fetchAvailableModels, getFallbackModels } from './models.ts';
export { ProviderTimeoutError, isUserAbort, userAbortReason } from './deadline.ts';
export type { ChatTurn, CompletionOptions, LlmSettings } from './types.ts';

// Tool calling support
export interface ToolCall {
  id: string;
  function: { name: string; arguments: string };
}

export interface ProviderOptions {
  tools?: any[];
  toolChoice?: 'auto' | 'none';
}

export async function callProviderWithTools(
  providerId: string,
  settings: LlmSettings,
  messages: any[],
  systemPrompt: string,
  options: ProviderOptions = {}
): Promise<{ text?: string; tool_calls?: ToolCall[] }> {
  const formattedMessages = [
    { role: 'system', content: systemPrompt },
    ...messages.filter(m => m.role !== 'system')
  ];

  if (providerId === 'ollama') {
    return callOllamaWithTools(settings, formattedMessages, options.tools, options.toolChoice ?? 'auto');
  }

  if (['openai', 'openrouter', 'groq', 'nvidia', 'agent_router', 'anthropic'].includes(providerId)) {
    return callOpenAICompatibleWithTools(settings, formattedMessages, options.tools, options.toolChoice ?? 'auto', providerId);
  }

  // Fallback: simulate tool calling via prompt
  return callWithPromptEngineering(settings, formattedMessages, options.tools);
}

/**
 * One call to one provider, with no deadline of its own. The abort signal in `options` goes straight to
 * the request. Errors have today's texts (errors.ts), and a missing key fails before any model is built.
 * Ollama and AgentRouter have their own modules (ollama.ts, agentRouter.ts): each has fallbacks and error rules
 * that the plain chat-model call below does not.
 * A provider id saved under settings.customProviders is a user-added endpoint: it resolves to its descriptor
 * and is built by protocol (factory.ts), with its own error texts that name the provider, the protocol and the URL.
 */
export async function callProvider(provider: string, settings: LlmSettings, messages: ChatTurn[], systemPrompt: string, options: CompletionOptions = {}): Promise<string> {
  if (provider === 'ollama') return callOllama(settings, messages, systemPrompt, options);
  if (provider === 'agent_router') return callAgentRouter(settings, messages, systemPrompt, options);
  const custom = settings.customProviders?.[provider];
  const apiKey = getApiKey(settings, provider);
  let call: ProviderCall;
  let chatProvider: ChatProvider;
  if (custom) {
    // A custom endpoint has no curated defaults: an unusable URL or a missing model fails here, before any request.
    call = createCustomProviderCall(custom, settings, apiKey);
    chatProvider = custom.protocol;
  } else {
    if (!isChatProvider(provider)) throw new Error(`Unsupported LLM provider: ${provider}`);
    chatProvider = provider;
    assertApiKey(chatProvider, apiKey);
    call = createProviderCall(chatProvider, settings, apiKey);
  }

  const startTime = Date.now();
  try {
    const reply = await call.invoke(toLangChainMessages(messages, systemPrompt), { signal: options.signal ?? undefined, callbacks: options.callbacks });
    const text = reply.text;
    if (chatProvider === 'gemini' && !text && !custom) throw new Error(GEMINI_EMPTY_TEXT);
    Logger.info('ApiClients', `[NETWORK] 200 OK (${Date.now() - startTime}ms) - Output length: ${text.length} chars`);
    return text;
  } catch (error) {
    const context = { baseUrl: call.baseUrl, apiKey, rawBody: call.lastBody() };
    const inner = custom
      ? describeCustomFailure(error, { ...context, providerLabel: custom.displayName || provider, protocol: custom.protocol })
      : describeFailure(chatProvider, error, context);
    // A Pause, a Stop or the deadline is reported once, as [NETWORK_ABORTED] by generateCompletion, not as a failed request.
    if (!options.signal?.aborted) Logger.error(call.logTag, `[NETWORK] Failed request to ${call.logTarget}`, inner);
    // The classification comes from the error the SDK threw (its status, its retry-after header), the text
    // from the failure functions: the caller gets today's message plus the kind the retry wrapper needs.
    const failure = classifyProviderFailure(error);
    throw new ProviderError(custom
      ? wrapCustomFailure(inner, { ...context, providerLabel: custom.displayName || provider, protocol: custom.protocol })
      : wrapFailure(chatProvider, inner, context), { status: failure.status, kind: failure.kind, retryAfterMs: failure.retryAfterMs });
  }
}

/** Main completion method dispatching to the selected provider. */
export async function generateCompletion(
  settings: LlmSettings,
  messages: ChatTurn[],
  systemPrompt: string,
  options: CompletionOptions = {}
): Promise<string> {
  const provider = providerOf(settings);
  const timeoutMs = timeoutMsOf(settings);

  Logger.info('ApiClients', `[NETWORK] Dispatching completion request to provider [${provider}] with model [${settings.model}] (timeout ${Math.round(timeoutMs / 1000)}s)`);

  const startedAt = Date.now();
  try {
    return await withDeadline({ provider, timeoutMs, signal: options.signal, source: timeoutSourceOf(settings) }, (callSignal) =>
      callProvider(provider, settings, messages, systemPrompt, { ...options, signal: callSignal }));
  } catch (error) {
    Logger.warn('ApiClients', `[NETWORK_ABORTED] Completion via [${provider}] ended after ${Date.now() - startedAt}ms: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

// ============================================================================
// Tool Calling Support
// ============================================================================

async function callOllamaWithTools(
  settings: LlmSettings,
  messages: any[],
  tools: any[] | undefined,
  toolChoice: 'auto' | 'none'
): Promise<{ text?: string; tool_calls?: ToolCall[] }> {
  const baseUrl = settings.baseUrl || 'http://localhost:11434';
  const url = `${baseUrl}/api/chat`;
  
  const ollamaTools = (tools || []).map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema
    }
  })) || [];

  const payload = {
    model: settings.model,
    messages,
    tools: ollamaTools,
    tool_choice: toolChoice === 'none' ? 'none' : 'auto',
    stream: false,
    options: { temperature: 0.1, num_ctx: 8192 }
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(settings.llmTimeoutMs || 120000)
  });

  if (!response.ok) {
    throw new Error(`Ollama error: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  const message = data.message || {};
  
  if (message.tool_calls && message.tool_calls.length > 0) {
    return {
      tool_calls: message.tool_calls.map((tc: any, i: number) => ({
        id: tc.id || `call_${i}`,
        function: {
          name: tc.function.name,
          arguments: JSON.stringify(tc.function.arguments)
        }
      }))
    };
  }

  return { text: message.content || '' };
}

async function callOpenAICompatibleWithTools(
  settings: LlmSettings,
  messages: any[],
  tools: any[] | undefined,
  toolChoice: 'auto' | 'none',
  providerId: string
): Promise<{ text?: string; tool_calls?: ToolCall[] }> {
  const baseUrl = getDefaultBaseUrl(settings, providerId);
  const url = `${baseUrl}/chat/completions`;
  
  const openaiTools = (tools || []).map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema
    }
  })) || [];

  const payload = {
    model: settings.model,
    messages,
    tools: openaiTools,
    tool_choice: toolChoice === 'none' ? 'none' : 'auto',
    temperature: 0.1,
    max_tokens: 8192
  };

  const apiKey = getApiKey(settings, providerId);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(settings.llmTimeoutMs || 120000)
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  const choice = data.choices?.[0];
  const message = choice?.message || {};

  if (message.tool_calls && message.tool_calls.length > 0) {
    return {
      tool_calls: message.tool_calls.map((tc: any) => ({
        id: tc.id,
        function: {
          name: tc.function.name,
          arguments: typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments)
        }
      }))
    };
  }

  return { text: message.content || '' };
}

function getDefaultBaseUrl(settings: LlmSettings, provider: string): string {
  const custom = settings.customProviders?.[provider];
  if (custom?.baseUrl) return custom.baseUrl.replace(/\/+$/, '');
  
  const defaults: Record<string, string> = {
    openai: 'https://api.openai.com/v1',
    openrouter: 'https://openrouter.ai/api/v1',
    groq: 'https://api.groq.com/openai/v1',
    nvidia: 'https://integrate.api.nvidia.com/v1',
    agent_router: 'https://agentrouter.org/v1',
    anthropic: 'https://api.anthropic.com/v1'
  };
  return defaults[provider] || defaults.openai;
}

async function callWithPromptEngineering(
  settings: LlmSettings,
  messages: any[],
  tools: any[] | undefined
): Promise<{ text?: string; tool_calls?: ToolCall[] }> {
  const toolDescriptions = (tools || []).map(t => 
    `${t.name}: ${t.description}\nArgs: ${JSON.stringify(t.inputSchema)}`
  ).join('\n\n') || '';

  const enhancedMessages = [
    ...messages,
    { 
      role: 'user', 
      content: `Available tools:\n${toolDescriptions}\n\nReply with a tool call in this format:\n\`\`\`json\n{"name": "tool_name", "arguments": {...}}\n\`\`\`` 
    }
  ];

  const text = await callProvider(settings.provider ?? 'ollama', settings, enhancedMessages, '', {});
  
  const toolCall = parseToolCallFromText(text);
  if (toolCall) {
    return { tool_calls: [{ id: `call_${Date.now()}`, function: toolCall }] };
  }
  
  return { text };
}

function parseToolCallFromText(text: string): { name: string; arguments: any } | null {
  const jsonMatch = text.match(/```json\s*(\{[\s\S]*?\})\s*```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      if (parsed.name && parsed.arguments) return parsed;
    } catch {}
  }
  return null;
}
