/**
 * Quick self-test of the offline mock (mockOllama.mjs). Node only, no browser, well under a second.
 *
 *   node tests/e2e/lib/mockOllama.selftest.mjs
 *
 * `smoke.mjs --mock` runs it first, so a broken mock is reported before Chromium starts.
 *
 * It starts the mock on a free port and talks to it over HTTP, the way the extension does:
 *   - the protocol: CORS preflight, /api/version, /api/tags, HTTP 400 for a request that is not
 *     valid JSON (and for other malformed ones), 501 for a call it has no script for, 404;
 *   - the scripted runs: for every smoke task it feeds the mock the step messages the ENGINE
 *     builds (AgentEngine.buildStepMessage) from the committed fixture snapshots, follows the
 *     reply (a click moves to the next page), and judges the result with the same `check` as the
 *     smoke run. Every reply is also validated against the real action or plan schema;
 *   - the honesty: the same runs again with the page text and/or the element list removed from
 *     the snapshot. What the mock needs from each channel is written down in EXPECTED below, and a
 *     run that lost what it needs must fail its check, with a "MOCK-FAIL:" answer that no check
 *     accepts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validate } from '../../helpers/miniJsonSchema.js';
import { buildActionSchema, buildPlanSchema } from '../../../background/actionSchema.js';
import { AgentEngine } from '../../../background/agentEngine.js';
import { TASKS } from './tasks.mjs';
import { MOCK_FAIL_PREFIX, parseStepMessage, startMockOllama } from './mockOllama.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = path.resolve(HERE, '..', '..', 'fixtures', 'snapshots');

const snapshotOf = (name) => JSON.parse(fs.readFileSync(path.join(SNAPSHOT_DIR, `${name}.json`), 'utf8'));

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
  'bot-check': { none: true, noText: true, noElements: true, both: false }
};

// Where a click leads on the fixture site (the snapshots keep no hrefs): the product link of the
// search page opens the offers page.
const CLICK_LEADS_TO = { search: { 8: 'compare' } };

// The actions each smoke task takes when the page is fully visible.
const EXPECTED_ACTIONS = {
  'store-price': ['finish'],
  'cheapest-offer': ['click', 'finish'],
  'bot-check': ['wait', 'finish']
};

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
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, headers: res.headers, text, json };
}

/** One task on the fixture snapshots, the way the engine would run it. */
async function simulate(base, taskName, blind) {
  const task = TASKS[taskName];
  let page = task.page.replace(/\.html$/, '');
  const messages = [{ role: 'user', content: `Goal: ${task.prompt}` }];
  const steps = [];
  const problems = [];
  for (let step = 1; step <= 6; step++) {
    const snapshot = BLIND[blind](snapshotOf(page));
    const stepMessage = AgentEngine.prototype.buildStepMessage.call(
      { planSteps: [{ text: 'a step', status: 'in_progress' }], stepCount: step, currentTask: task.prompt }, snapshot, 10
    );
    const res = await call(base, 'POST', '/api/chat', {
      model: 'mock-agent',
      stream: false,
      think: false,
      format: ACTION_SCHEMA,
      messages: [{ role: 'system', content: COMPACT_PROMPT }, ...messages, { role: 'user', content: stepMessage }]
    });
    if (res.status !== 200) return { answer: null, steps, problems: [`HTTP ${res.status}: ${res.text.slice(0, 200)}`] };
    const content = res.json.message.content;
    const action = JSON.parse(content);
    problems.push(...validate(ACTION_SCHEMA, action).map((p) => `step ${step}: ${p}`));
    steps.push({ step, action });
    if (action.action === 'finish') return { answer: action.answer, steps, problems };
    messages.push({ role: 'assistant', content }, { role: 'user', content: 'Action Executed Successfully: ok' });
    if (action.action === 'click') {
      const next = CLICK_LEADS_TO[page] && CLICK_LEADS_TO[page][action.element_id];
      if (!next) { problems.push(`step ${step}: [${action.element_id}] leads nowhere on ${page}`); break; }
      page = next;
    }
  }
  return { answer: null, steps, problems };
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
      ['no stream:false', { model: 'm', messages: [{ role: 'user', content: 'x' }] }, false]
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

    // --- the reply shape and the recorded calls ----------------------------------------------
    const shaped = await call(base, 'POST', '/api/chat', {
      model: 'mock-agent', stream: false, think: false, format: ACTION_SCHEMA,
      messages: [{ role: 'system', content: COMPACT_PROMPT }, { role: 'user', content: stepMessage }]
    });
    const body = shaped.json || {};
    check('/api/chat reply has the fields the extension reads', shaped.status === 200 && body.model === 'mock-agent'
      && typeof body.created_at === 'string' && body.message?.role === 'assistant' && typeof body.message?.content === 'string'
      && body.done === true && body.done_reason === 'stop' && body.prompt_eval_count > 0 && body.eval_count > 0, shaped.text.slice(0, 200));
    const last = mock.calls[mock.calls.length - 1];
    check('calls[] keeps the fields the report uses', last && last.n === mock.calls.length && last.status === 200
      && last.format === 'schema(oneOf x15)' && last.think === false && last.messages === 2 && last.systemChars === COMPACT_PROMPT.length
      && last.promptEvalCount === body.prompt_eval_count && last.evalCount === body.eval_count && last.doneReason === 'stop'
      && last.content === body.message.content && last.requestBytes > 0 && last.responseBytes > 0 && typeof last.ms === 'number', JSON.stringify(last));

    // --- the plan -----------------------------------------------------------------------------
    for (const [name, task] of Object.entries(TASKS)) {
      const res = await call(base, 'POST', '/api/chat', {
        model: 'mock-agent', stream: false, think: false, format: PLAN_SCHEMA,
        messages: [{ role: 'system', content: 'You are a web task planner.' }, { role: 'user', content: `Task: "${task.prompt}"\nMake a short plan for this web browsing task.` }]
      });
      let plan = null;
      try { plan = JSON.parse(res.json.message.content); } catch { /* checked below */ }
      const problems = plan ? validate(PLAN_SCHEMA, plan) : ['not JSON'];
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
        const right = run.answer !== null && !!task.check({ answer: run.answer, steps: run.steps });
        const detail = `answer ${JSON.stringify(run.answer)}, actions ${run.steps.map((s) => s.action.action).join(' > ')}${run.problems.length ? `, problems: ${run.problems.join('; ')}` : ''}`;
        check(`${name} with ${blind === 'none' ? 'the whole page' : `the page minus ${blind}`}: ${EXPECTED[name][blind] ? 'right' : 'wrong on purpose'}`,
          right === EXPECTED[name][blind] && run.problems.length === 0, detail);
        if (blind === 'none') {
          check(`${name}: takes the actions ${EXPECTED_ACTIONS[name].join(', ')}`,
            JSON.stringify(run.steps.map((s) => s.action.action)) === JSON.stringify(EXPECTED_ACTIONS[name]), detail);
        }
        if (run.answer && run.answer.startsWith(MOCK_FAIL_PREFIX)) failAnswers.push(run.answer);
      }
    }
    check('the bot check is never clicked or typed into, whatever the page shows', (await Promise.all(Object.keys(BLIND).map((b) => simulate(base, 'bot-check', b))))
      .every((run) => !run.steps.some((s) => ['click', 'type'].includes(s.action.action))), 'an action on the challenge page');
    check('MOCK-FAIL answers were produced, and no smoke check accepts any of them', failAnswers.length > 0
      && failAnswers.every((answer) => Object.values(TASKS).every((task) => !task.check({ answer, steps: [] }))), failAnswers.join(' | '));
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
