// src/background/llm/vision.ts
// Can this model see a picture?
//
// The screenshot tool is only worth offering to a model that can take an image. Sending a picture
// to a text-only model either wastes a round trip (the model ignores it) or ends the run (the
// provider rejects it), so the client asks before it offers.
//
// What the providers actually tell us, stated plainly because the answer is different for each:
//   - Ollama knows. POST /api/show answers `capabilities: ["completion", "tools", "vision"]`, and a
//     text-only model does not list "vision". This is the one provider whose answer is trusted.
//   - No cloud OpenAI-compatible provider agrees on a capability endpoint, so none are trusted:
//     for those the tool IS offered and the provider decides. A refusal is caught by the client's
//     fallback (it retries once without the pictures and stops offering the tool), so one bad
//     guess does not end the run.
//
// A model that is KNOWN to be blind does not get the tool, and the panel says why. A model whose
// capability is unknown DOES get it, because refusing every cloud model by default would disable
// the feature for everyone who has a model that can see.
//
// The probe is cached in memory per provider|baseUrl|model. The cache matters: the context-window
// lookup runs on every LLM call, so an uncached capability probe would be a request per call.

import { baseUrlOf, providerOf } from './settings.ts';
import { Logger } from '../../shared/logger.ts';
import type { LlmSettings } from './types.ts';

/** What the client needs to decide whether the tool is offered. */
export type VisionSupport = 'yes' | 'no' | 'unknown';

/** The probe results, keyed by provider|baseUrl|model. In memory, per worker lifetime. */
const visionCache = new Map<string, VisionSupport>();

/** The cache key of one model. */
export function visionCacheKey(settings: LlmSettings, model = settings.model || ''): string {
  return `${providerOf(settings)}|${baseUrlOf(settings) || 'default'}|${model}`;
}

/** Clears the probe cache. Tests use it; nothing in the extension does. */
export function clearVisionCache(): void {
  visionCache.clear();
}

/**
 * The vision support of the model the settings name. Screenshots are always on, so there is no
 * manual override: only what the provider reports decides.
 */
export async function visionSupport(settings: LlmSettings): Promise<VisionSupport> {
  const provider = providerOf(settings);
  // Only Ollama reports this. A cloud model is offered the tool and the provider decides; see
  // the fallback in the client, which handles a refusal without ending the run.
  if (provider !== 'ollama') return 'unknown';

  const model = settings.model || '';
  if (!model) return 'unknown';
  const key = visionCacheKey(settings, model);
  const cached = visionCache.get(key);
  if (cached) return cached;

  const support = await probeOllamaVision(settings, model);
  visionCache.set(key, support);
  return support;
}

/** Reads `capabilities` from Ollama's /api/show. A failed probe is 'unknown', never 'no'. */
async function probeOllamaVision(settings: LlmSettings, model: string): Promise<VisionSupport> {
  const baseUrl = (baseUrlOf(settings) || 'http://localhost:11434').replace(/\/$/, '');
  try {
    const res = await fetch(`${baseUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model })
    });
    if (!res.ok) {
      Logger.warn('ApiClients', `[VISION] Ollama /api/show for ${model} returned HTTP ${res.status}`);
      return 'unknown';
    }
    const data: any = await res.json();
    if (!Array.isArray(data?.capabilities)) {
      // An old Ollama does not report capabilities at all. That is not a statement that the model
      // cannot see, so the tool stays offered.
      return 'unknown';
    }
    const support: VisionSupport = data.capabilities.includes('vision') ? 'yes' : 'no';
    Logger.debug('ApiClients', `[VISION] ${model}: ${support} (capabilities: ${data.capabilities.join(', ')})`);
    return support;
  } catch (err: any) {
    Logger.warn('ApiClients', `[VISION] Could not probe ${model}: ${err?.message || String(err)}`);
    return 'unknown';
  }
}
