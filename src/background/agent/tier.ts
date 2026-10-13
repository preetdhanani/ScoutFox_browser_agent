// src/background/agent/tier.ts
// Model tier classification and capability detection.

import type { Settings } from '../../shared/storage.ts';
import type { Tier } from './actions.ts';
import { Logger } from '../../shared/logger.ts';

/**
 * Detects the model tier for an Ollama model by querying the /api/show endpoint.
 * Models of 14B or less are classified as 'small'.
 * Models exceeding 14B parameters are classified as 'large'.
 */
export async function detectOllamaTier(baseUrl: string, model: string): Promise<Tier> {
  if (!model) return 'small';

  // Fast path heuristic based on model name tags (e.g. "qwen2.5:72b", "llama3.3:70b")
  const nameMatch = /[:\-_](\d+(?:\.\d+)?)[bB]\b/.exec(model);
  if (nameMatch) {
    const bCount = parseFloat(nameMatch[1]);
    if (bCount > 14) return 'large';
  }

  try {
    const url = `${(baseUrl || 'http://localhost:11434').replace(/\/+$/, '')}/api/show`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    });

    if (!resp.ok) return 'small';

    const data = await resp.json();

    // Check parameter_size string in details (e.g. "70B", "9B", "14B")
    const paramSizeStr = data.details?.parameter_size ?? '';
    const sizeMatch = /^(\d+(?:\.\d+)?)\s*([BMK])?$/i.exec(String(paramSizeStr).trim());
    if (sizeMatch) {
      const num = parseFloat(sizeMatch[1]);
      const unit = (sizeMatch[2] || 'B').toUpperCase();
      if (unit === 'B') {
        return num > 14 ? 'large' : 'small';
      }
    }

    // Check general.parameter_count in model_info
    const paramCount = data.model_info?.['general.parameter_count'];
    if (typeof paramCount === 'number') {
      return paramCount > 14_000_000_000 ? 'large' : 'small';
    }

    return 'small';
  } catch (err: any) {
    Logger.warn('Tier', `Failed to query Ollama /api/show for model "${model}": ${err.message}`);
    return 'small';
  }
}

/**
 * Resolves the active model tier based on settings and heuristics.
 */
export async function resolveModelTier(settings: Partial<Settings>): Promise<Tier> {
  const configured = String(settings.modelTier || 'auto').toLowerCase().trim();
  if (configured === 'small') return 'small';
  if (configured === 'large') return 'large';

  const provider = String(settings.provider || '').toLowerCase().trim();
  const model = String(settings.model || '').toLowerCase().trim();

  if (provider === 'ollama') {
    return await detectOllamaTier(settings.baseUrl || 'http://localhost:11434', settings.model || '');
  }

  // Cloud model detection heuristics.
  // The small-model rule runs FIRST (the large rules' word boundaries still
  // matched the prefix of the mini variants, `gpt-4o\b` hits "gpt-4o-mini",
  // BUG-43) - but `mini` must not match inside the NAME "gemini", so it needs
  // a lookbehind guard; plain reordering alone reclassified gemini-1.5-pro.
  if (/(?<![a-z])mini|flash|haiku|8b|7b|14b|3b|1b/i.test(model)) {
    return 'small';
  }

  if (
    /70b|405b|claude-3[.-]5-sonnet|claude-3-opus|gpt-4o\b|gpt-4\b|gemini-1\.5-pro|gemini-2\.0-pro/i.test(
      model
    )
  ) {
    return 'large';
  }

  if (provider === 'anthropic' || provider === 'openai') {
    return 'large';
  }

  return 'small';
}
