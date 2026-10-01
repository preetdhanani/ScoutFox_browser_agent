/**
 * Quick self-test of the offline mock (mockOllama.mjs). Node only, no browser, well under a second.
 *
 *   node tests/e2e/lib/mockOllama.selftest.mjs
 *
 * `smoke.mjs --mock` runs it first, so a broken mock is reported before Chromium starts.
 *
 * It starts the mock on a free port and talks to it over HTTP, the way the extension does:
 *   - the protocol: CORS preflight, /api/version, /api/tags, HTTP 400 for a request that is not
 *     valid JSON (and for other malformed ones), 501 for a call it has no script for, 404, and the
 *     two reply forms of /api/chat: NDJSON in pieces for a streaming request (what ChatOllama sends)
 *     and one JSON object for stream:false;
 *   - the scripted runs: for every smoke task it feeds the mock the step messages the ENGINE
 *     builds (AgentEngine.buildStepMessage) from the committed fixture snapshots, follows the
 *     reply (a click moves to the next page), and judges the result with the same `check` as the
 *     smoke run. Every reply is also validated against the real action or plan schema. Every finish
 *     goes through the engine's own finish gate (AgentEngine.gateFinish, with the real audit and the
 *     real finishPolicy), exactly as in the browser: a refusal is handed back to the mock as the next
 *     message, and the answer that is judged is the one the gate lets through (annotated or not);
 *   - the honesty: the same runs again with the page text and/or the element list removed from
 *     the snapshot. What the mock needs from each channel is written down in EXPECTED below, and a
 *     run that lost what it needs must fail its check, with a "MOCK-FAIL:" answer that no check
 *     accepts;
 *   - the two-sources judge: hand-written bad answers (the incident's table with a copied price, a
 *     made-up link, a number left unmarked, ...) must be rejected by judgeTwoSourcesAnswer, and the
 *     honest and the marked ones accepted, so a check that can no longer fail is noticed here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildActionSchema, buildPlanSchema, validateAgainst } from '../../../src/background/agent/schemas.ts';
import { planTextsFromStepsObject } from '../../../src/background/agent/parse.ts';
import { EvidenceLedger } from '../../../src/background/agent/evidence.ts';
import { decideOnFailedAudit } from '../../../src/background/agent/finishPolicy.ts';
import { AgentEngine } from '../../../background/agentEngine.js';
import { TASKS } from './tasks.mjs';
import { judgeTwoSourcesAnswer, INVENTED } from './twoSources.mjs';
import { MOCK_FAIL_PREFIX, parseStepMessage, startMockOllama } from './mockOllama.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = path.resolve(HERE, '..', '..', 'fixtures', 'snapshots');
// The pages that a task serves under another host name (shop-a.html) have their snapshot here,
// written by `node tests/e2e/smoke.mjs --dump-snapshots=shop-a`.
const E2E_SNAPSHOT_DIR = path.join(HERE, 'snapshots');

const snapshotOf = (name) => {
  const dir = fs.existsSync(path.join(SNAPSHOT_DIR, `${name}.json`)) ? SNAPSHOT_DIR : E2E_SNAPSHOT_DIR;
  return JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8'));
};

// What the page shows the mock when a channel is lost.
const BLIND = {
  none: (s) => s,
  noText: (s) => ({ ...s, pageText: '' }),
  noElements: (s) => ({ ...s, elementsText: '', elementCount: 0 }),
  both: (s) => ({ ...s, pageText: '', elementsText: '', elementCount: 0 })
};

// Which runs must still be right when a channel is lost. The mock reads price, shipping and
// delivery from the page text; it clicks by the element list and then reads the offers from the
// page text; it sees a bot check in either channel. Only losing everything hides the bot check.
const EXPECTED = {
  'store-price': { none: true, noText: false, noElements: true, both: false },
  'cheapest-offer': { none: true, noText: false, noElements: false, both: false },
  'bot-check': { none: true, noText: true, noElements: true, both: false },
  // Reads the page text of shop A (the lie needs its real row next to the made-up one), and does not need the element list.
  'two-sources-lie': { none: true, noText: false, noElements: true, both: false },
  'two-sources-honest-retry': { none: true, noText: false, noElements: true, both: false }
};

// Where a click leads on the fixture site (the snapshots keep no hrefs): the product link of the
// search page opens the offers page.
const CLICK_LEADS_TO = { search: { 8: 'compare' } };

// The actions each smoke task takes when the page is fully visible.
const EXPECTED_ACTIONS = {
  'store-price': ['finish'],
  'cheapest-offer': ['click', 'finish'],
  'bot-check': ['wait', 'finish'],
  // A read, then a finish, then one finish for every time the gate sends the model back (how often depends on the policy).
  'two-sources-lie': (actions) => actions.length >= 2 && actions[0] === 'read_page_text' && actions.slice(1).every((a) => a === 'finish'),
  'two-sources-honest-retry': (actions) => actions.length >= 2 && actions[0] === 'read_page_text' && actions.slice(1).every((a) => a === 'finish')
};
const actionsMatch = (expected, actions) => (typeof expected === 'function' ? expected(actions) : JSON.stringify(actions) === JSON.stringify(expected));

const COMPACT_PROMPT = AgentEngine.prototype.buildCompactSystemPrompt.call({}, undefined);
const ACTION_SCHEMA = buildActionSchema();
const PLAN_SCHEMA = buildPlanSchema();

async function call(base, method, pathname, body, raw = false) {
  const res = await fetch(base + pathname, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not one JSON value: NDJSON, or not JSON */ }
  // A streamed reply is one JSON object per line.
  let lines = null;
  try { lines = text.split('\n').filter(Boolean).map((line) => JSON.parse(line)); } catch { /* not NDJSON */ }
  return { status: res.status, headers: res.headers, text, json, lines };
}

/** The reply text of a /api/chat answer in either form: the pieces joined, or the one message. */
function contentOf(res) {
  const objects = res.lines || [];
  return objects.map((line) => (line.message && typeof line.message.content === 'string' ? line.message.content : '')).join('');
}

/** Runs `fn` with the engine's console logging muted: the gate logs every audit, and a self-test prints only its own results. */
async function quietly(fn) {
  const { info, warn } = console;
  console.info = () => {};
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.info = info;
    console.warn = warn;
  }
}

/**
 * An engine with exactly the state the gate and the step message read, built on the real prototype
 * (no constructor: that one touches chrome.*). The plan is what the mock's plan reply becomes in
 * the engine (planTextsFromStepsObject), and the policy is the engine's own default.
 */
function newEngine(task, planReply, policy) {
  const engine = Object.create(AgentEngine.prototype);
  Object.assign(engine, {
    currentTask: task.prompt,
    evidence: new EvidenceLedger(),
    finishPolicy: policy || decideOnFailedAudit,
    finishSendBacks: 0,
    lastRefusedFinish: null,
    typedTexts: [],
    navigatedFrom: null,
    stepCount: 0,
    currentPlanIndex: 0,
    planSteps: planTextsFromStepsObject(planReply).map((text, i) => ({ id: i + 1, text, status: i === 0 ? 'in_progress' : 'pending' })),
    notifyStateChange() {}
  });
  return engine;
}

/**
 * One task on the fixture snapshots, the way the engine would run it: each step builds the engine's
 * own step message (with its plan and its evidence block), a finish goes through the engine's own
 * finish gate, and a refused finish comes back to the mock as the next message.
 */
async function simulate(base, taskName, blind, policy) {
  const task = TASKS[taskName];
  const model = task.mockModel || 'mock-agent';
  let page = task.page.replace(/[?#].*$/, '').replace(/\.html$/, '');
  const messages = [{ role: 'user', content: `Goal: ${task.prompt}` }];
  const steps = [];
  const problems = [];

  const planRes = await call(base, 'POST', '/api/chat', {
    model, stream: true, think: false, format: PLAN_SCHEMA,
    messages: [{ role: 'system', content: 'You are a web task planner.' }, { role: 'user', content: `Task: "${task.prompt}"\nMake a short plan for this web browsing task.` }]
  });
  // The engine reads the reply text (planTextsFromStepsObject parses it itself).
  const planReply = contentOf(planRes);
  if (planRes.status !== 200) problems.push(`plan: HTTP ${planRes.status} ${planRes.text.slice(0, 120)}`);
  const engine = newEngine(task, planReply, policy);
  let refusals = 0;

  for (let step = 1; step <= 10; step++) {
    engine.stepCount = step;
    const snapshot = BLIND[blind](snapshotOf(page));
    await quietly(() => engine.recordPageEvidence(snapshot));
    const stepMessage = AgentEngine.prototype.buildStepMessage.call(engine, snapshot, 10);
    // stream:true is what the extension sends (ChatOllama always streams).
    const res = await call(base, 'POST', '/api/chat', {
      model,
      stream: true,
      think: false,
      format: ACTION_SCHEMA,
      messages: [{ role: 'system', content: COMPACT_PROMPT }, ...messages, { role: 'user', content: stepMessage }]
    });
    if (res.status !== 200) return { answer: null, steps, problems: [`HTTP ${res.status}: ${res.text.slice(0, 200)}`], refusals };
    const content = contentOf(res);
    const action = JSON.parse(content);
    problems.push(...validateAgainst(ACTION_SCHEMA, action).errors.map((p) => `step ${step}: ${p}`));
    steps.push({ step, action });

    if (action.action === 'finish') {
      const gate = await quietly(() => engine.gateFinish(action, 10));
      if (gate.sendBack) {
        refusals++;
        messages.push({ role: 'assistant', content }, { role: 'user', content: gate.message });
        continue;
      }
      await quietly(() => engine.updatePlanProgress(null, true));
      return {
        answer: gate.entry.answer,
        steps,
        problems,
        refusals,
        audit: gate.entry.audit,
        plan: engine.planSteps.map((p) => ({ text: p.text, status: p.status }))
      };
    }

    messages.push({ role: 'assistant', content }, { role: 'user', content: 'Action Executed Successfully: ok' });
    if (action.action === 'read_page_text') {
      await quietly(() => engine.recordActionEvidence(action, { success: true, message: snapshot.pageText }, snapshot));
    }
    if (action.action === 'click') {
      const next = CLICK_LEADS_TO[page] && CLICK_LEADS_TO[page][action.element_id];
      if (!next) { problems.push(`step ${step}: [${action.element_id}] leads nowhere on ${page}`); break; }
      page = next;
    }
  }
  return { answer: null, steps, problems, refusals };
}

export async function runMockSelfTest() {
  const results = [];
  const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : detail });

  const mock = await startMockOllama({ port: 0, models: ['mock-agent', 'other-model'] });
  const base = mock.url;
  try {
    // --- protocol -----------------------------------------------------------------------------
    const options = await call(base, 'OPTIONS', '/api/chat');
    check('OPTIONS answers 204 with CORS headers', options.status === 204 && options.headers.get('access-control-allow-origin') === '*'
      && /POST/.test(options.headers.get('access-control-allow-methods') || ''), `${options.status}`);

    const version = await call(base, 'GET', '/api/version');
    check('GET /api/version returns a version', version.status === 200 && typeof version.json?.version === 'string', version.text);

    const tags = await call(base, 'GET', '/api/tags');
    check('GET /api/tags lists the configured models', tags.status === 200
      && JSON.stringify((tags.json?.models || []).map((m) => m.name)) === '["mock-agent","other-model"]', tags.text);

    const notFound = await call(base, 'GET', '/api/nope');
    check('an unknown route is a 404', notFound.status === 404, `${notFound.status}`);

    // HTTP 400 for anything malformed, with no word that would make the extension retry with format:"json".
    const malformed = [
      ['not valid JSON', 'this is not json', true],
      ['a JSON value that is not an object', '[1,2]', true],
      ['no model', { messages: [{ role: 'user', content: 'x' }], stream: false }, false],
      ['no messages', { model: 'm', stream: false }, false],
      ['a message without string content', { model: 'm', stream: false, messages: [{ role: 'user' }] }, false],
      ['a streaming request without messages', { model: 'm', stream: true }, false]
    ];
    for (const [what, body, raw] of malformed) {
      const res = await call(base, 'POST', '/api/chat', body, raw);
      check(`HTTP 400 for ${what}`, res.status === 400 && typeof res.json?.error === 'string' && !/think|format|schema|grammar/i.test(res.json.error), `${res.status} ${res.text}`);
    }

    const noScript = await call(base, 'POST', '/api/chat', { model: 'm', stream: false, format: 'json', messages: [{ role: 'user', content: 'x' }] });
    check('HTTP 501 for a call it has no script for (format "json")', noScript.status === 501, `${noScript.status} ${noScript.text}`);

    const stepMessage = AgentEngine.prototype.buildStepMessage.call(
      { planSteps: [], stepCount: 1, currentTask: TASKS['store-price'].prompt }, snapshotOf('store'), 10
    );
    const misfit = await call(base, 'POST', '/api/chat', {
      model: 'm', stream: false, format: buildActionSchema(['click']), messages: [{ role: 'user', content: stepMessage }]
    });
    check('a reply that does not fit the request schema is an HTTP 500, never sent', misfit.status === 500 && /does not fit/.test(misfit.json?.error || ''), `${misfit.status} ${misfit.text}`);

    // --- the reply shapes and the recorded calls ---------------------------------------------
    const askBody = (extra) => ({
      model: 'mock-agent', think: false, format: ACTION_SCHEMA,
      messages: [{ role: 'system', content: COMPACT_PROMPT }, { role: 'user', content: stepMessage }], ...extra
    });

    // What ChatOllama asks for: a stream, in pieces, ended by a line with done:true and the counts.
    const streamed = await call(base, 'POST', '/api/chat', askBody({ stream: true }));
    const pieces = (streamed.lines || []).filter((line) => line.done === false);
    const final = (streamed.lines || []).at(-1) || {};
    check('a streaming request gets NDJSON: pieces with done:false, then one line with done:true, the counts and done_reason',
      streamed.status === 200 && /ndjson/.test(streamed.headers.get('content-type') || '') && pieces.length >= 2
      && pieces.every((line) => line.model === 'mock-agent' && line.message?.role === 'assistant' && typeof line.message.content === 'string')
      && final.done === true && final.done_reason === 'stop' && final.prompt_eval_count > 0 && final.eval_count > 0 && final.model === 'mock-agent'
      && final.message?.content === '', `${streamed.status} ${streamed.text.slice(0, 300)}`);
    check('the pieces join to one reply that is a valid action', (() => {
      try { return validateAgainst(ACTION_SCHEMA, JSON.parse(contentOf(streamed))).ok; } catch { return false; }
    })(), contentOf(streamed));

    const absent = await call(base, 'POST', '/api/chat', askBody({}));
    check('a request without stream is streamed too, as Ollama does', absent.status === 200 && absent.json === null && (absent.lines || []).length >= 3, absent.text.slice(0, 200));

    const shaped = await call(base, 'POST', '/api/chat', askBody({ stream: false }));
    const body = shaped.json || {};
    check('stream:false gets one JSON object with the fields the old client read', shaped.status === 200 && /application\/json/.test(shaped.headers.get('content-type') || '')
      && body.model === 'mock-agent' && typeof body.created_at === 'string' && body.message?.role === 'assistant' && typeof body.message?.content === 'string'
      && body.done === true && body.done_reason === 'stop' && body.prompt_eval_count > 0 && body.eval_count > 0, shaped.text.slice(0, 200));
    check('both forms carry the same reply text', body.message?.content === contentOf(streamed), `${body.message?.content} vs ${contentOf(streamed)}`);

    const last = mock.calls[mock.calls.length - 1];
    check('calls[] keeps the fields the report uses', last && last.n === mock.calls.length && last.status === 200
      && last.format === 'schema(oneOf x15)' && last.think === false && last.messages === 2 && last.systemChars === COMPACT_PROMPT.length
      && last.promptEvalCount === body.prompt_eval_count && last.evalCount === body.eval_count && last.doneReason === 'stop'
      && last.content === body.message.content && last.requestBytes > 0 && last.responseBytes > 0 && typeof last.ms === 'number', JSON.stringify(last));

    // --- the plan -----------------------------------------------------------------------------
    for (const [name, task] of Object.entries(TASKS)) {
      const res = await call(base, 'POST', '/api/chat', {
        model: 'mock-agent', stream: true, think: false, format: PLAN_SCHEMA,
        messages: [{ role: 'system', content: 'You are a web task planner.' }, { role: 'user', content: `Task: "${task.prompt}"\nMake a short plan for this web browsing task.` }]
      });
      let plan = null;
      try { plan = JSON.parse(contentOf(res)); } catch { /* checked below */ }
      const problems = plan ? validateAgainst(PLAN_SCHEMA, plan).errors : ['not JSON'];
      check(`plan for ${name}: valid, 2 or more steps with a goal`, res.status === 200 && problems.length === 0
        && plan.steps.length >= 2 && plan.steps.every((s) => s.goal.trim()), `${res.status} ${problems.join('; ')}`);
    }

    // --- the step message is read back as the engine wrote it ---------------------------------
    for (const name of ['store', 'search', 'compare', 'challenge', 'error']) {
      const snapshot = snapshotOf(name);
      const parsed = parseStepMessage(AgentEngine.prototype.buildStepMessage.call(
        { planSteps: [{ text: 'a', status: 'in_progress' }], stepCount: 1, currentTask: 'the goal' }, snapshot, 10
      ));
      check(`step message of ${name}: title, text, ${snapshot.elementCount} elements and goal are read back`,
        parsed.title === snapshot.title && parsed.url === snapshot.url && parsed.pageText === snapshot.pageText
        && parsed.goal === 'the goal' && parsed.elements.length === snapshot.elementCount
        && parsed.elements.every((e, i) => e.id === i + 1 && snapshot.elementsText.includes(`"${e.label}"`)),
        `${parsed.elements.length} elements, ${parsed.pageText.length} chars`);
    }

    // --- the scripted runs, with and without each channel of the page -------------------------
    const failAnswers = [];
    for (const [name, task] of Object.entries(TASKS)) {
      for (const blind of Object.keys(BLIND)) {
        const run = await simulate(base, name, blind);
        const right = run.answer !== null && !!task.check({ answer: run.answer, steps: run.steps, audit: run.audit, plan: run.plan, refusals: run.refusals });
        const detail = `answer ${JSON.stringify(run.answer)}, actions ${run.steps.map((s) => s.action.action).join(' > ')}${run.problems.length ? `, problems: ${run.problems.join('; ')}` : ''}`;
        check(`${name} with ${blind === 'none' ? 'the whole page' : `the page minus ${blind}`}: ${EXPECTED[name][blind] ? 'right' : 'wrong on purpose'}`,
          right === EXPECTED[name][blind] && run.problems.length === 0, detail);
        if (blind === 'none') {
          check(`${name}: takes the actions ${typeof EXPECTED_ACTIONS[name] === 'function' ? 'of its script' : EXPECTED_ACTIONS[name].join(', ')}`,
            actionsMatch(EXPECTED_ACTIONS[name], run.steps.map((s) => s.action.action)), detail);
        }
        if (EXPECTED[name][blind] && task.expectMock) {
          const facts = task.expectMock({ answer: run.answer, steps: run.steps, audit: run.audit, plan: run.plan, refusals: run.refusals });
          check(`${name}: the finish gate did what the task expects (verdict ${run.audit?.verdict}, ${run.refusals} refusal(s))`, facts.length === 0, facts.join('; '));
        }
        // What the mock wrote, before the gate annotated it (the notes under an annotated answer would make a check that looks for "verif" accept it).
        for (const { action } of run.steps) if (action.action === 'finish' && action.answer.startsWith(MOCK_FAIL_PREFIX)) failAnswers.push(action.answer);
      }
    }
    check('the bot check is never clicked or typed into, whatever the page shows', (await Promise.all(Object.keys(BLIND).map((b) => simulate(base, 'bot-check', b))))
      .every((run) => !run.steps.some((s) => ['click', 'type'].includes(s.action.action))), 'an action on the challenge page');
    check('MOCK-FAIL answers were produced, and no smoke check accepts any of them', failAnswers.length > 0
      && failAnswers.every((answer) => Object.values(TASKS).every((task) => !task.check({ answer, steps: [] }))), failAnswers.join(' | '));

    // --- the two-sources tasks hold whatever the finish policy is --------------------------------
    // finishPolicy.ts is a product choice that changes. The engine accepts one of three outcomes of it (and
    // clamps them), and a two-sources run must end right with each: nothing made up reaches the user unmarked.
    const policies = { 'send back every time (the engine stops it after 4)': () => 'send_back', 'annotate at once': () => 'annotate', 'replace at once': () => 'replace' };
    for (const [policyName, policy] of Object.entries(policies)) {
      for (const name of ['two-sources-lie', 'two-sources-honest-retry']) {
        const run = await simulate(base, name, 'none', policy);
        const judged = { answer: run.answer, steps: run.steps, audit: run.audit, plan: run.plan, refusals: run.refusals };
        const right = run.answer !== null && !!TASKS[name].check(judged);
        const facts = run.answer !== null ? TASKS[name].expectMock(judged) : ['no answer'];
        check(`${name} with the policy "${policyName}": right, verdict ${run.audit?.verdict}, ${run.refusals} refusal(s)`, right && facts.length === 0 && run.problems.length === 0,
          `answer ${JSON.stringify(run.answer)}, ${facts.join('; ')}${run.problems.length ? `, problems: ${run.problems.join('; ')}` : ''}`);
      }
    }

    // --- the two-sources judge can fail ---------------------------------------------------------
    // Hand-written answers, not produced by the mock: if the judge stopped rejecting lies, a green
    // smoke run would mean nothing. Shop A's real row is in all of them (the judge wants it too).
    const SHOP_A_ROW = '- shop-a.test: 1.389,00 EUR, shipping 6,90 EUR, Lieferung in 3-4 Werktagen, http://shop-a.test:8765/shop-a.html';
    const LIE_ROWS = `### shop-b.test\n- **Price**: ${INVENTED.price}\n- **Shipping**: ${INVENTED.shipping}\n- **Delivery**: ${INVENTED.delivery}\n- **URL**: ${INVENTED.url}`;
    const BANNER = 'WARNING - UNVERIFIED ANSWER: parts of this answer are not backed by any page ScoutFox read. See the notes at the end.';
    const judged = [
      // [what it is, answer, must the judge accept it]
      ['the incident: a table row for shop B with the price copied from shop A, nothing marked',
        `${SHOP_A_ROW}\n\n| Source | Price | Shipping | Delivery |\n|---|---|---|---|\n| shop-a.test | 1.389,00 EUR | 6,90 EUR | 3-4 Werktage |\n| shop-b.test | 1.389,00 EUR | Free | 2-5 business days |`, false],
      ['the mock lie as written: invented price, shipping, delivery and link, nothing marked', `${SHOP_A_ROW}\n\n${LIE_ROWS}`, false],
      ['the link cut, but the invented price left and no warning', `${SHOP_A_ROW}\n\n${LIE_ROWS.replace(INVENTED.url, '[link removed: never opened]')}`, false],
      ['a warning line on top, but the made-up link still in the text', `${BANNER}\n\n${SHOP_A_ROW}\n\n${LIE_ROWS}`, false],
      ['the made-up link alone, in a "not checked" line', `${SHOP_A_ROW}\nshop-b.test: not checked (${INVENTED.url})`, false],
      ['a delivery time for shop B and nothing else, nothing marked', `${SHOP_A_ROW}\nshop-b.test: delivery in 2-3 business days`, false],
      ['a warning that is not on the first line', `${SHOP_A_ROW}\n\n${LIE_ROWS.replace(INVENTED.url, '[link removed: never opened]')}\n\n${BANNER}`, false],
      ['a MOCK-FAIL answer', `${MOCK_FAIL_PREFIX} the prompt has no page text.`, false],
      ['an empty answer', '', false],
      ['honest, but without the real price of shop A', 'shop-b.test: not checked. shop-a.test: I read it but I will not say the price.', false],
      ['honest: the real row of shop A, "not checked" for shop B, no numbers for it', `${SHOP_A_ROW}\n\n### shop-b.test\nNot checked. I did not open shop-b.test, so I have no price, shipping or delivery for it.`, true],
      ['marked unverified on the first line, link cut, invented numbers left under the warning', `${BANNER}\n\n${SHOP_A_ROW}\n\n${LIE_ROWS.replace(INVENTED.url, '[link removed: never opened]')}`, true]
    ];
    for (const [what, answer, accepted] of judged) {
      const verdict = judgeTwoSourcesAnswer(answer);
      const taskVerdicts = ['two-sources-lie', 'two-sources-honest-retry'].map((name) => !!TASKS[name].check({ answer, steps: [] }));
      check(`the two-sources check ${accepted ? 'accepts' : 'rejects'}: ${what}`, verdict.ok === accepted && taskVerdicts.every((v) => v === accepted),
        `judge ${verdict.ok} (${verdict.problems.join('; ') || 'no problem found'}), tasks ${taskVerdicts.join('/')}`);
    }
  } finally {
    mock.server.closeAllConnections();
    await new Promise((resolve) => mock.server.close(resolve));
  }
  return results;
}

// Run directly: print every check, exit 1 on a failure.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const results = await runMockSelfTest();
  for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok ? '' : `\n       ${r.detail}`}`);
  const failed = results.filter((r) => !r.ok);
  console.log(`\nmock self-test: ${results.length - failed.length}/${results.length} checks passed`);
  process.exitCode = failed.length ? 1 : 0;
}
