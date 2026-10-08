/** How the llm layer reads the settings it is handed (llm/settings.ts): the rules apiClients.js always had. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '../../src/shared/storage.ts';
import { DEFAULT_LLM_TIMEOUT_MS, DEFAULT_NVIDIA_LLM_TIMEOUT_MS, baseUrlOf, getApiKey, maxTokensOf, modelOf, normalizeNvidiaBaseUrl, providerOf, timeoutMsOf, withV1 } from '../../src/background/llm/settings.ts';
import type { LlmSettings } from '../../src/background/llm/types.ts';

test('the settings the extension stores are accepted as they are (this file is type-checked)', () => {
  const stored: LlmSettings = DEFAULT_SETTINGS;
  assert.equal(providerOf(stored), 'openrouter');
  assert.equal(timeoutMsOf(stored), DEFAULT_SETTINGS.llmTimeoutMs);
  assert.equal(getApiKey(stored, 'openai'), '');
});

test('the top-level key wins over the key saved for the provider, and the key is trimmed', () => {
  const saved = { openai: { apiKey: 'saved-key' } };
  assert.equal(getApiKey({ apiKey: 'top-key', providerConfigs: saved }, 'openai'), 'top-key');
  assert.equal(getApiKey({ apiKey: '', providerConfigs: saved }, 'openai'), 'saved-key', 'no top-level key: the saved one');
  assert.equal(getApiKey({ providerConfigs: saved }, 'openai'), 'saved-key');
  assert.equal(getApiKey({ apiKey: '  top-key \n', providerConfigs: saved }, 'openai'), 'top-key');
  assert.equal(getApiKey({ providerConfigs: { openai: { apiKey: ' saved-key ' } } }, 'openai'), 'saved-key');
  assert.equal(getApiKey({ providerConfigs: saved }, 'anthropic'), '', 'the key saved for another provider is not used');
  assert.equal(getApiKey({}, 'openai'), '');
  assert.equal(getApiKey({ apiKey: '   ' }, 'openai'), '', 'a blank key is no key');
  assert.equal(getApiKey({ apiKey: 'Bearer nvapi-12345' }, 'nvidia'), 'nvapi-12345', 'Bearer prefix is stripped');
  assert.equal(getApiKey({ apiKey: '"nvapi-12345"' }, 'nvidia'), 'nvapi-12345', 'surrounding quotes are stripped');
});

test('withV1 removes a trailing slash and makes the URL end in /v1', () => {
  assert.equal(withV1('https://api.openai.com'), 'https://api.openai.com/v1');
  assert.equal(withV1('https://api.openai.com/'), 'https://api.openai.com/v1');
  assert.equal(withV1('https://api.openai.com///'), 'https://api.openai.com/v1');
  assert.equal(withV1('https://api.openai.com/v1'), 'https://api.openai.com/v1');
  assert.equal(withV1('https://api.openai.com/v1/'), 'https://api.openai.com/v1');
  assert.equal(withV1('https://api.openai.com/v1///'), 'https://api.openai.com/v1');
  assert.equal(withV1('https://api.groq.com/openai/v1'), 'https://api.groq.com/openai/v1');
  assert.equal(withV1('  http://localhost:1234  '), 'http://localhost:1234/v1', 'trimmed');
  assert.equal(withV1('http://localhost:1234/custom'), 'http://localhost:1234/custom/v1');
});

test('the provider, base URL and model are read trimmed, and the provider defaults to gemini as it always did', () => {
  assert.equal(providerOf({}), 'gemini');
  assert.equal(providerOf({ provider: '' }), 'gemini');
  assert.equal(providerOf({ provider: 'ollama' }), 'ollama');
  assert.equal(baseUrlOf({ baseUrl: ' http://x.test ' }), 'http://x.test');
  assert.equal(baseUrlOf({}), '');
  assert.equal(modelOf({ model: ' gpt-4o ' }), 'gpt-4o');
  assert.equal(modelOf({ model: '   ' }), '', 'a blank model means the provider\'s default');
});

test('the timeout is llmTimeoutMs, 120 s when it is not a positive number, and never above what setTimeout can hold', () => {
  assert.equal(DEFAULT_LLM_TIMEOUT_MS, 120000);
  assert.equal(timeoutMsOf({}), 120000);
  assert.equal(timeoutMsOf({ llmTimeoutMs: 0 }), 120000);
  assert.equal(timeoutMsOf({ llmTimeoutMs: -5 }), 120000);
  assert.equal(timeoutMsOf({ llmTimeoutMs: 'soon' as unknown as number }), 120000);
  assert.equal(timeoutMsOf({ llmTimeoutMs: 45000 }), 45000);
  assert.equal(timeoutMsOf({ llmTimeoutMs: '30000' as unknown as number }), 30000, 'a number saved as text');
  // Above 2^31 - 1 ms a timer fires at once, which would make every call time out immediately.
  assert.equal(timeoutMsOf({ llmTimeoutMs: 1e12 }), 2 ** 31 - 1);
});

test('normalizeNvidiaBaseUrl maps build.nvidia.com, strips endpoints, and ends in /v1', () => {
  assert.equal(normalizeNvidiaBaseUrl(''), 'https://integrate.api.nvidia.com/v1');
  assert.equal(normalizeNvidiaBaseUrl(undefined), 'https://integrate.api.nvidia.com/v1');
  assert.equal(normalizeNvidiaBaseUrl('https://build.nvidia.com'), 'https://integrate.api.nvidia.com/v1');
  assert.equal(normalizeNvidiaBaseUrl('https://build.nvidia.com/'), 'https://integrate.api.nvidia.com/v1');
  assert.equal(normalizeNvidiaBaseUrl('https://integrate.api.nvidia.com/v1/chat/completions'), 'https://integrate.api.nvidia.com/v1');
  assert.equal(normalizeNvidiaBaseUrl('https://integrate.api.nvidia.com/v1/models'), 'https://integrate.api.nvidia.com/v1');
  assert.equal(normalizeNvidiaBaseUrl('https://integrate.api.nvidia.com/v1'), 'https://integrate.api.nvidia.com/v1');
  assert.equal(normalizeNvidiaBaseUrl('https://custom-nim.internal/api/'), 'https://custom-nim.internal/api/v1');
});

test('the timeout follows precedence: per-provider value wins, then global, then provider default', () => {
  // Non-NVIDIA, nothing set: 120000
  assert.equal(timeoutMsOf({}), 120000);
  assert.equal(timeoutMsOf({ provider: 'openai' }), 120000);
  assert.equal(timeoutMsOf({ provider: 'gemini' }), 120000);

  // NVIDIA, nothing set: 300000
  assert.equal(timeoutMsOf({ provider: 'nvidia' }), 300000);
  assert.equal(timeoutMsOf({ provider: 'nvidia', llmTimeoutMs: 0 }), 300000);

  // Per-provider value set: wins over global value
  assert.equal(timeoutMsOf({ provider: 'nvidia', llmTimeoutMs: 60000, providerConfigs: { nvidia: { llmTimeoutMs: 250000 } } }), 250000);
  assert.equal(timeoutMsOf({ provider: 'openai', llmTimeoutMs: 45000, providerConfigs: { openai: { llmTimeoutMs: 80000 } } }), 80000);

  // Global value only: used for non-NVIDIA
  assert.equal(timeoutMsOf({ provider: 'openai', llmTimeoutMs: 45000 }), 45000);

  // Global value only, NVIDIA: respected directly, including exactly 120000 (BUG-05)
  assert.equal(timeoutMsOf({ provider: 'nvidia', llmTimeoutMs: 120000 }), 120000);
  assert.equal(timeoutMsOf({ provider: 'nvidia', llmTimeoutMs: 60000 }), 60000);
  assert.equal(timeoutMsOf({ provider: 'nvidia', llmTimeoutMs: 450000 }), 450000);

  // Values above 2^31 - 1 are capped
  assert.equal(timeoutMsOf({ llmTimeoutMs: 1e12 }), 2 ** 31 - 1);
  assert.equal(timeoutMsOf({ provider: 'nvidia', providerConfigs: { nvidia: { llmTimeoutMs: 1e12 } } }), 2 ** 31 - 1);
});

test('max tokens is 8192 unless the settings hold a positive number (also as text), because LangChain\'s own default is 4096', () => {
  assert.equal(maxTokensOf({}), 8192);
  assert.equal(maxTokensOf({ maxTokens: 0 }), 8192);
  assert.equal(maxTokensOf({ maxTokens: -1 }), 8192);
  assert.equal(maxTokensOf({ maxTokens: 'lots' as unknown as number }), 8192);
  assert.equal(maxTokensOf({ maxTokens: 1024 }), 1024);
  assert.equal(maxTokensOf({ maxTokens: '2048' as unknown as number }), 2048, 'a number saved as text');
});
