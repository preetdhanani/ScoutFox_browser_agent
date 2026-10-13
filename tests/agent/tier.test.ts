// BUG-43 regression: the large-model regex ran before the small-model rule and
// its word boundaries still matched the prefix of the mini variants
// (`gpt-4o\b` hits "gpt-4o-mini"), so gpt-4o-mini / gpt-4.1-mini were
// classified as tier "large" and the mini|flash|haiku rule was dead for them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveModelTier } from '../../src/background/agent/tier.ts';

test('mini variants of large model families classify as small (BUG-43)', async () => {
  const cases: Array<[string, string, string]> = [
    ['openai', 'gpt-4o-mini', 'small'],
    ['openai', 'gpt-4.1-mini', 'small'],
    ['openrouter', 'google/gemini-2.0-flash-lite', 'small'],
  ];
  for (const [provider, model, expected] of cases) {
    const tier = await resolveModelTier({ provider, model } as any);
    assert.equal(tier, expected, `${provider}/${model} must be ${expected}, got ${tier}`);
  }

  // The large tiers must still classify as large - including gemini, whose
  // NAME contains "mini" (the reason the small rule needs a lookbehind guard).
  for (const model of ['gpt-4o', 'gpt-4', 'claude-3-5-sonnet', 'gemini-1.5-pro', 'gemini-2.0-pro', 'meta-llama/llama-3.3-70b']) {
    const tier = await resolveModelTier({ provider: 'openrouter', model } as any);
    assert.equal(tier, 'large', `${model} must stay large, got ${tier}`);
  }
});
