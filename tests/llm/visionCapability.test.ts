/**
 * The vision capability probe: src/background/llm/vision.ts.
 *
 * The screenshot tool is only worth offering to a model that can take a picture. Ollama is the
 * one provider that says so: POST /api/show answers `capabilities: ["completion","tools","vision"]`
 * and a text-only model does not list "vision".
 *
 * The probe has to fail in the SAFE direction: a probe that fails is 'unknown', never 'no'.
 * Turning the feature off because a request timed out would be silent, and the user would never
 * learn that the picture path was available.
 *
 * What these tests hold on to:
 *   1. A model that lists vision is 'yes'; one that does not is 'no'.
 *   2. The probe is cached: a second call is not a second request.
 *   3. A failed probe is 'unknown', not 'no'.
 *   4. A provider that does not report capabilities is 'unknown'.
 *   5. There is no manual override: screenshots are always on, and a stored 'off' or 'vision' from
 *      an older build is ignored.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { clearVisionCache, visionSupport, visionCacheKey } from '../../src/background/llm/vision.ts';

/** Answers fetch with a scripted /api/show body, and counts the calls. */
function withShow(response: { status?: number; body?: unknown } | 'throw', t: any) {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (response === 'throw') throw new Error('network is down');
    return new Response(JSON.stringify(response.body ?? {}), {
      status: response.status ?? 200,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  return () => calls;
}

const ollama = (screenshots?: string) => ({
  provider: 'ollama',
  baseUrl: 'http://localhost:11434',
  model: 'qwen3.8:27b-mlx',
  ...(screenshots ? { screenshots } : {})
}) as any;

test('an Ollama model that lists vision can see', async (t) => {
  clearVisionCache();
  withShow({ body: { model_info: {}, capabilities: ['completion', 'tools', 'vision'] } }, t);
  assert.equal(await visionSupport(ollama()), 'yes');
});

test('an Ollama model whose capabilities do not list vision cannot see', async (t) => {
  clearVisionCache();
  withShow({ body: { model_info: {}, capabilities: ['completion', 'tools'] } }, t);
  // This is the shipped default model: it reports exactly these two capabilities.
  assert.equal(await visionSupport(ollama()), 'no');
});

test('the probe is cached, so the context lookup does not make a request per call', async (t) => {
  clearVisionCache();
  const calls = withShow({ body: { capabilities: ['vision'] } }, t);
  assert.equal(await visionSupport(ollama()), 'yes');
  assert.equal(await visionSupport(ollama()), 'yes');
  assert.equal(await visionSupport(ollama()), 'yes');
  assert.equal(calls(), 1, 'one request, three answers');
});

test('a different model is a different cache entry', async (t) => {
  clearVisionCache();
  const calls = withShow({ body: { capabilities: ['vision'] } }, t);
  await visionSupport(ollama());
  await visionSupport({ ...ollama(), model: 'gemma3:4b' });
  assert.equal(calls(), 2);
});

test('a failed probe is unknown, not a silent no', async (t) => {
  clearVisionCache();
  withShow('throw', t);
  // Turning the feature off because one request failed would never be noticed.
  assert.equal(await visionSupport(ollama()), 'unknown');
});

test('an HTTP error on the probe is unknown', async (t) => {
  clearVisionCache();
  withShow({ status: 500, body: { error: 'boom' } }, t);
  assert.equal(await visionSupport(ollama()), 'unknown');
});

test('an Ollama that does not report capabilities is unknown, not no', async (t) => {
  clearVisionCache();
  withShow({ body: { model_info: { 'general.context_length': 8192 } } }, t);
  assert.equal(await visionSupport(ollama()), 'unknown', 'an old Ollama is not evidence the model is blind');
});

test('a cloud provider is unknown: the tool is offered and the provider decides', async () => {
  clearVisionCache();
  const support = await visionSupport({ provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'x' } as any);
  assert.equal(support, 'unknown');
});

// Screenshots are always on, so 'off' and 'vision' stored by an older build are not overrides
// any more: only the probe decides.
test('a stored "vision" value from an older build does not make a blind model see', async (t) => {
  clearVisionCache();
  withShow({ body: { capabilities: ['completion', 'tools'] } }, t);
  assert.equal(await visionSupport(ollama('vision')), 'no');
});

test('a stored "off" value from an older build does not switch a seeing model off', async (t) => {
  clearVisionCache();
  withShow({ body: { capabilities: ['vision'] } }, t);
  assert.equal(await visionSupport(ollama('off')), 'yes');
});

test('the cache key names the provider, the endpoint and the model', () => {
  assert.equal(visionCacheKey(ollama()), 'ollama|http://localhost:11434|qwen3.8:27b-mlx');
  // Two endpoints running the same model name are two different models.
  assert.notEqual(visionCacheKey(ollama()), visionCacheKey({ ...ollama(), baseUrl: 'http://localhost:11435' }));
});
