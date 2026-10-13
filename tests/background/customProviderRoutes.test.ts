/**
 * The FETCH_MODELS and TEST_PROVIDER routes for a user-added endpoint (featere/custom-endpoint):
 * the descriptor rides in the message payload, the endpoint's own error texts come back to the
 * panel, and a gone or unusable descriptor answers with an error instead of guessing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { routerRig } from '../helpers/routerRig.ts';
import { jsonResponse, spyFetch, textReply } from '../helpers/llmWire.ts';

const DESCRIPTOR = {
  id: 'acme-gateway',
  displayName: 'Acme Gateway',
  protocol: 'openai',
  baseUrl: 'https://gateway.example/v1',
  models: ['saved-model'],
  keyMode: 'apiKey',
  createdAt: 1,
  updatedAt: 1
};

const PAYLOAD = {
  provider: 'acme-gateway',
  baseUrl: 'https://gateway.example/v1',
  apiKey: 'sk-route-1',
  model: 'saved-model',
  customProviders: { 'acme-gateway': DESCRIPTOR }
};

test('FETCH_MODELS: the panel asks about a draft endpoint and gets its model list', async (t) => {
  const rig = await routerRig();
  t.after(rig.cleanup);

  const sent = spyFetch(t, () => jsonResponse({ data: [{ id: 'gateway-a' }, { id: 'text-embedder-x' }, { id: 'gateway-b' }] }));
  const res = await rig.send({ action: 'FETCH_MODELS', payload: { ...PAYLOAD, forceRefresh: true } });

  assert.equal(res?.success, true);
  assert.deepEqual(res?.models, ['gateway-a', 'gateway-b']);
  assert.equal(res?.filteredCount, 1, 'the count of hidden non-chat ids rides to the panel (D1.3)');
  assert.equal(sent[0].url, 'https://gateway.example/v1/models', 'the endpoint of the descriptor was asked, not a built-in URL');
  assert.equal(sent[0].headers.authorization, 'Bearer sk-route-1');
});

test('FETCH_MODELS: a descriptor missing from the payload is an error that names it, with no invented list', async (t) => {
  const rig = await routerRig();
  t.after(rig.cleanup);

  const res = await rig.send({ action: 'FETCH_MODELS', payload: { provider: 'unknown-endpoint', forceRefresh: true } });
  assert.equal(res?.success, false);
  assert.match(res?.error || '', /unknown-endpoint/);
  assert.deepEqual(res?.models, []);
});

test('FETCH_MODELS: a 404 carries its status, so the panel can say "no model list" and stand on the saved ids', async (t) => {
  const rig = await routerRig();
  t.after(rig.cleanup);

  spyFetch(t, () => jsonResponse({ error: 'no such route' }, 404));
  const res = await rig.send({ action: 'FETCH_MODELS', payload: { ...PAYLOAD, forceRefresh: true } });
  assert.equal(res?.success, false);
  assert.equal(res?.status, 404);
  assert.deepEqual(res?.models, ['saved-model'], 'the fallback is the saved list of this endpoint');
  assert.match(res?.error || '', /no model list/);
});

test('TEST_PROVIDER: one minimal chat call through the real path, with its measured latency', async (t) => {
  const rig = await routerRig();
  t.after(rig.cleanup);

  const sent = spyFetch(t, (request) => textReply(request.url, 'ok'));
  const res = await rig.send({ action: 'TEST_PROVIDER', payload: PAYLOAD });

  assert.equal(res?.success, true);
  assert.match(res?.reply || '', /ok/i);
  assert.equal(typeof res?.latencyMs, 'number');
  assert.equal(sent[0].url, 'https://gateway.example/v1/chat/completions', 'the probe goes to the chat URL the run would use');
  assert.equal(sent[0].body.model, 'saved-model');
});

test('TEST_PROVIDER: a dead endpoint answers success:false with the endpoint-named error', async (t) => {
  const rig = await routerRig();
  t.after(rig.cleanup);

  spyFetch(t, () => { throw new Error('getaddrinfo ENOTFOUND gateway.invalid'); });
  const res = await rig.send({ action: 'TEST_PROVIDER', payload: PAYLOAD });
  assert.equal(res?.success, false);
  assert.match(res?.error || '', /gateway\.example|ENOTFOUND|unreachable/i, 'the panel can show what failed, for the endpoint the user just typed');
  assert.ok(typeof res?.latencyMs === 'number');
});
