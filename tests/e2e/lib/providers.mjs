/**
 * The real OpenAI-compatible model servers the smoke run can drive (`--provider=<name>`), one
 * profile each. Ollama is not here: it speaks its own API and has its own proxy (ollamaProxy.mjs).
 *
 * A profile says where the server is, which environment variables hold its key, which model a
 * run uses by default, and how the extension is pointed at it:
 *   - `builtin`: one of the extension's own providers (NVIDIA NIM is "nvidia").
 *   - `custom`: a user-added endpoint, the "Custom model API" dialog of the side panel. The run
 *     adds it through that dialog, the way a user does (see addCustomProvider in smoke.mjs).
 *
 * Every request goes through keyProxy.mjs: the extension only ever holds PLACEHOLDER_KEY, and the
 * proxy adds the real key on the way out.
 */
import { PLACEHOLDER_KEY } from './keyProxy.mjs';

/** The default model of the NVIDIA profile: NVIDIA's vision-language Nemotron 3.5 Super. */
export const NVIDIA_DEFAULT_MODEL = 'nvidia/nemotron-3.5-super-vl-120b-a12b';

/** The provider of `npm run test:e2e` when no --provider is given. */
export const DEFAULT_PROVIDER = 'lisa';

/** NIM answers a tool round in seconds; 120 s (not the 300 s default) bounds a call stuck in a queue. */
const REAL_LLM_TIMEOUT_MS = 120000;

const PROFILES = {
  lisa: {
    label: 'LISA',
    // The base URL as a user types it into the dialog. The OpenAI paths hang off it: /api/models, /api/chat/completions.
    urlEnv: 'LISA_URL',
    defaultUrl: 'https://chat-1.ki-awz.iisys.de/api',
    keyEnv: ['LISA_API_KEY', 'LISA_API'],
    defaultModel: 'lisa-pro',
    custom: { id: 'lisa', displayName: 'LISA', protocol: 'openai' }
  },
  nvidia: {
    label: 'NVIDIA NIM',
    urlEnv: 'NVIDIA_URL',
    defaultUrl: 'https://integrate.api.nvidia.com/v1',
    keyEnv: ['NVIDIA_API_KEY', 'NVIDIA_API'],
    defaultModel: NVIDIA_DEFAULT_MODEL,
    builtin: 'nvidia'
  }
};

/** The names --provider takes for a real OpenAI-compatible server. */
export const REAL_PROVIDER_NAMES = Object.keys(PROFILES);

/** A key as people paste it: trimmed, without quotes and without a "Bearer " prefix. */
export function cleanKey(raw) {
  return String(raw || '').trim().replace(/^["']|["']$/g, '').replace(/^Bearer\s+/i, '').trim();
}

/**
 * The profile `name` resolved against `env`: the server's origin and mount path, its key and the
 * name of the variables the key may live in (for the error message). Throws on an unknown name.
 * NVIDIA_URL used to be the bare origin; a value without a path still gets NIM's /v1.
 */
export function resolveProvider(name, env = process.env) {
  const profile = PROFILES[name];
  if (!profile) throw new Error(`Unknown provider "${name}". Known: ${REAL_PROVIDER_NAMES.join(', ')}`);
  const typed = String(env[profile.urlEnv] || profile.defaultUrl).trim();
  let url;
  try {
    url = new URL(typed);
  } catch {
    throw new Error(`${profile.urlEnv} is not a full URL: ${JSON.stringify(typed)}`);
  }
  let mount = url.pathname.replace(/\/+$/, '');
  if (!mount && name === 'nvidia') mount = '/v1';
  const keyName = profile.keyEnv.find((k) => cleanKey(env[k]));
  return {
    name,
    label: profile.label,
    origin: url.origin,
    mount,
    apiKey: keyName ? cleanKey(env[keyName]) : '',
    keyEnv: profile.keyEnv,
    urlEnv: profile.urlEnv,
    defaultModel: profile.defaultModel,
    builtin: profile.builtin || null,
    custom: profile.custom || null,
    llmTimeoutMs: REAL_LLM_TIMEOUT_MS
  };
}

/** The base URL the extension is given: the proxy, with the server's own mount path. */
export function proxiedBaseUrl(provider, proxyUrl) {
  return `${proxyUrl.replace(/\/+$/, '')}${provider.mount}`;
}

/**
 * The provider part of the settings the run saves. A built-in provider gets its connection in
 * providerConfigs; a custom one also needs its descriptor, which the dialog created (`customProviders`,
 * read back from storage), so a later save of the settings never drops it.
 */
export function providerSettings(provider, proxyUrl, model, customProviders = {}) {
  const baseUrl = proxiedBaseUrl(provider, proxyUrl);
  const id = provider.builtin || provider.custom.id;
  const config = { baseUrl, apiKey: PLACEHOLDER_KEY, model, ...(provider.builtin ? { llmTimeoutMs: provider.llmTimeoutMs } : {}) };
  return {
    provider: id,
    baseUrl,
    apiKey: PLACEHOLDER_KEY,
    providerConfigs: { [id]: config },
    ...(provider.custom ? { customProviders } : {})
  };
}
