/**
 * The old AgentEngine driven through fakeChrome, fakeDom and fakeLlm, with nothing stubbed on the
 * engine itself.
 *
 * Every other engine test replaces getTabDOMWithAutoInject, generatePlan and persistState, and
 * hands the engine a snapshot of its own shape (`elements: '[1] <button> Go'`, no elementsText).
 * This one leaves the engine whole: startTask() makes the tab group, plans, reads the page with
 * chrome.tabs.sendMessage (answered by the fake content script from a page description), asks the
 * model (answered from a script), clicks (the fake content script opens the next page) and
 * finishes. It is the proof that the three helpers are enough for the engine tests of the later
 * phases, and it checks what the model was actually shown at each step, which no stub can.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeChrome } from './helpers/fakeChrome.ts';
import { createFakeStorage } from './helpers/fakeStorageSession.ts';
import { fakeDom, link } from './helpers/fakeDom.ts';
import type { PageSpec } from './helpers/fakeDom.ts';
import { fakeLlm } from './helpers/fakeLlm.ts';

// The old engine is plain JavaScript with no declarations, and P1 leaves it alone. A variable
// specifier keeps tsc from looking for them, so the test says which members of the engine it uses.
interface LegacyEngine {
  status: string;
  stepCount: number;
  activeTabId: number | null;
  history: Array<Record<string, any>>;
  planSteps: Array<{ text: string; status: string }>;
  restorePromise: Promise<void>;
  startTask(prompt: string, tabId: number): Promise<void>;
  stop(): { success: boolean };
}
const ENGINE_MODULE = '../background/agentEngine.js';
const CLIENTS_MODULE = '../background/apiClients.js';

const LIST = 'https://shop.test/laptops';
const PRODUCT = 'https://shop.test/laptops/16';
const GOAL = 'What does the Framework Laptop 16 cost?';

const PAGES: PageSpec[] = [
  {
    url: LIST,
    title: 'Laptops - Shop',
    text: [{ heading: 'Laptops' }, 'Framework Laptop 13 ab 1.049,00 EUR', 'Framework Laptop 16 ab 1.379,00 EUR'],
    elements: [link('Home'), link('Framework Laptop 16 DIY Edition', PRODUCT), link('Framework Laptop 13 DIY Edition')],
  },
  {
    url: PRODUCT,
    title: 'Framework Laptop 16 DIY Edition - Shop',
    text: [{ heading: 'Framework Laptop 16 DIY Edition' }, 'ab 1.399,00 EUR', 'inkl. MwSt.'],
    elements: [link('Zurueck zu den Laptops', LIST)],
  },
];

/** A browser with one tab on the laptops page, the extension's settings in storage, and the engine loaded on top. */
async function setup(script: Parameters<typeof fakeLlm>[0]) {
  const site = fakeDom({ pages: PAGES });
  const fc = fakeChrome({
    tabs: { list: [{ id: 101, windowId: 1, url: LIST }] },
    tabGroups: true,
    storage: createFakeStorage({
      local: {
        // actionDelayMs 0 would mean "the default" (1 s), so 1.
        data: { agent_settings: { provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'test-model', maxSteps: 5, actionDelayMs: 1 } },
      },
    }),
    dom: true,
  });
  site.attach(fc, 101);
  const restoreChrome = fc.install();
  const llm = fakeLlm(script);
  const { ApiClients } = await import(CLIENTS_MODULE);
  const restoreLlm = llm.install(ApiClients);
  const { AgentEngine } = (await import(ENGINE_MODULE)) as { AgentEngine: new () => LegacyEngine };
  const engine = new AgentEngine();
  await engine.restorePromise;
  return {
    site,
    fc,
    llm,
    engine,
    cleanUp: () => {
      restoreLlm();
      restoreChrome();
    },
  };
}

test('a two-step task: the model reads the list page, clicks the product, reads its page and finishes with the price', async (t) => {
  const { site, fc, llm, engine, cleanUp } = await setup([
    '["Open the Framework Laptop 16 page", "Read the price there"]',
    { reasoning: 'The list has the Laptop 16, so I open it.', text: JSON.stringify({ action: 'click', element_id: 2, reason: 'Open the product page' }) },
    JSON.stringify({ action: 'finish', answer: 'The Framework Laptop 16 DIY Edition costs 1.399,00 EUR.', reason: 'The price is on the page' }),
  ]);
  t.after(cleanUp);

  await engine.startTask(GOAL, 101);

  // The run: two steps, ended by the model's own finish.
  assert.equal(engine.status, 'idle');
  assert.equal(engine.stepCount, 2);
  const finish = engine.history.find((h) => h.type === 'finish');
  assert.equal(finish?.answer, 'The Framework Laptop 16 DIY Edition costs 1.399,00 EUR.');
  assert.deepEqual(engine.history.filter((h) => h.type === 'step_start').map((h) => [h.step, h.url, h.pageTitle, h.elementCount]), [
    [1, LIST, 'Laptops - Shop', 3],
    [2, PRODUCT, 'Framework Laptop 16 DIY Edition - Shop', 1],
  ]);
  assert.deepEqual(engine.planSteps.map((s) => s.status), ['completed', 'completed']);
  assert.equal(engine.history.find((h) => h.type === 'agent_response')?.thought, 'The list has the Laptop 16, so I open it.', 'the <think> tags of the reply became the thought');

  // The model was called three times: the plan, then one call per step.
  assert.equal(llm.calls.length, 3);
  const [plan, step1, step2] = llm.calls;
  assert.equal(plan?.systemPrompt, 'You are a web task planner.');
  assert.equal(plan?.json, true);
  assert.match(plan?.messages[0]?.content ?? '', /Task: "What does the Framework Laptop 16 cost\?"/);
  assert.equal(step1?.json, true);
  assert.equal(step1?.schema, null, 'a cloud provider gets no schema');
  assert.equal(step1?.settings && (step1.settings as { model: string }).model, 'test-model');

  // What the model saw at step 1: the real prompt, built from the snapshot of the list page.
  const seen1 = step1?.messages.at(-1)?.content ?? '';
  assert.match(seen1, /Current Page Title: "Laptops - Shop"/);
  assert.match(seen1, new RegExp(`Current URL: ${LIST}`));
  assert.match(seen1, /Scroll Position: Y=0 \/ 800px/);
  assert.match(seen1, /### Laptops\n\nFramework Laptop 13 ab 1\.049,00 EUR\nFramework Laptop 16 ab 1\.379,00 EUR/);
  assert.match(seen1, /Interactive Elements on Page:\n\[1\] a "Home"\n\[2\] a "Framework Laptop 16 DIY Edition"\n\[3\] a "Framework Laptop 13 DIY Edition"\n/);
  assert.match(seen1, /1\. \[>\] Open the Framework Laptop 16 page\n2\. \[ \] Read the price there/);

  // The click went through the content script, and the tab really moved.
  assert.deepEqual(site.actions.map((a) => [a.url, a.payload.action, a.payload.element_id, a.result.message]), [[LIST, 'click', 2, 'Clicked element [2] ("Framework Laptop 16 DIY Edition")']]);
  assert.equal(fc.tabs.get(101)?.url, PRODUCT);

  // What the model saw at step 2: its own reply, the result of the click, and the NEW page.
  const messages2 = step2?.messages ?? [];
  assert.equal(messages2[0]?.content, `Goal: ${GOAL}`);
  assert.equal(messages2[1]?.role, 'assistant');
  assert.match(messages2[1]?.content ?? '', /^<think>The list has the Laptop 16, so I open it\.<\/think>\n\{"action":"click"/);
  assert.equal(messages2[2]?.content, 'Action Executed Successfully: Clicked element [2] ("Framework Laptop 16 DIY Edition")');
  const seen2 = messages2.at(-1)?.content ?? '';
  assert.match(seen2, new RegExp(`Current URL: ${PRODUCT}`));
  assert.match(seen2, /### Framework Laptop 16 DIY Edition\n\nab 1\.399,00 EUR\ninkl\. MwSt\./);
  assert.match(seen2, /Interactive Elements on Page:\n\[1\] a "Zurueck zu den Laptops"\n/, 'the ids start from 1 again on the new page');
  assert.match(seen2, /Plan \(step 2\/5 overall\):\n1\. \[>\] Open the Framework Laptop 16 page\n2\. \[ \] Read the price there/, 'the plan and the step counter are in the prompt');

  // The group was made the way the real one is, and nothing was left undeclared or unscripted.
  assert.equal(fc.callsTo('tabs.group').length, 1);
  assert.equal(site.reads.length, 2, 'one page read per step');
  fc.assertClean();
  site.assertClean();
  llm.assertClean();
  llm.assertDrained();
});

test('Stop while the model is thinking ends the request with the abort error the engine recognises, and the run is stopped, not failed', async (t) => {
  const { site, fc, llm, engine, cleanUp } = await setup([
    '["Read the price"]',
    { text: JSON.stringify({ action: 'finish', answer: 'never seen' }), delayMs: 60_000 },
  ]);
  t.after(cleanUp);

  const run = engine.startTask(GOAL, 101);
  // Wait until the step call is in flight: the plan call is done and the second call waits for its reply.
  for (let i = 0; i < 2000 && llm.calls[1]?.outcome !== 'pending'; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(llm.calls[1]?.outcome, 'pending', 'the step call is waiting for the slow reply');

  engine.stop();
  await run;

  assert.equal(engine.status, 'stopped');
  assert.equal(llm.calls[1]?.outcome, 'aborted');
  assert.equal(llm.calls.length, 2, 'the abort was not retried as if it were a provider failure');
  assert.equal(engine.history.filter((h) => h.type === 'error').length, 0, 'no fabricated connection error');
  assert.equal(site.actions.length, 0, 'nothing was dispatched into the page');
  fc.assertClean();
  site.assertClean();
  llm.assertClean();
});
