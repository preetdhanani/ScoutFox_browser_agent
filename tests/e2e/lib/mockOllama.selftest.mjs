/**
 * Quick self-test of the offline mock (mockOllama.mjs). Node only, no browser, well under a second.
 *
 *   node tests/e2e/lib/mockOllama.selftest.mjs
 *
 * `smoke.mjs --mock` runs it first, so a broken mock is reported before Chromium starts.
 *
 * It starts the mock on a free port and talks to it over HTTP, the way the extension does:
 *   - the protocol: CORS preflight, /api/version, /api/tags, /api/show (known and unknown model), HTTP 400 for a request
 *     that is not valid JSON (and for other malformed ones), 501 for a chat call it has no script for (and the message
 *     says which call), 404, and the two reply forms of /api/chat: NDJSON in pieces for a streaming request (what
 *     ChatOllama sends) and one JSON object for stream:false;
 *   - the prompts: it builds the messages of the LangGraph engine with the engine's own builders (src/background/agent/
 *     prompts.ts and reflectPrompt.ts, the schemas of schemas.ts) from the committed fixture snapshots, and the mock must
 *     read them back (parsePolicyMessage);
 *   - the scripted runs: for every smoke task it walks the worker the way src/background/graph/worker.ts does (the plan
 *     call, then per site a perceive, the page verdict and the blocked ladder, the policy call, the reply parsed by the
 *     real parseModelReply with the ids of the page, record_finding through the real createFinding and criteria, a click
 *     moving to the next page) and builds the final answer the way the orchestrator's compile node does (the truth table
 *     under "Task completed successfully."). The facts of that run go through the SAME checks as the smoke run
 *     (lib/tasks.mjs: check, expectOutcome, expectMock). Every reply is also validated against the real plan or policy
 *     schema;
 *   - the honesty: the same runs again with the page text and/or the element list removed from the snapshot. What the
 *     mock needs from each channel is written down in EXPECTED below, and a run that lost what it needs must fail its
 *     check, with a "MOCK-FAIL:" reply that no check accepts;
 *   - the pending tasks (the two-sources tasks need the answer audit gate of plan stage 4b): their plan, their
 *     replies per mode and per model name are checked here at the reply level, and nothing is judged by a gate;
 *   - the two-sources judge: hand-written bad answers (the incident's table with a copied price, a made-up link, a
 *     number left unmarked, ...) must be rejected by judgeTwoSourcesAnswer, and the honest and the marked ones accepted,
 *     so a check that can no longer fail is noticed here.
 *
 * What it does NOT do: it does not run the graph (that is what the smoke run in the browser is for). The worker walk
 * above is a copy of the parts of the engine that decide what the mock sees, so when the engine changes, this walk is
 * the part to update; the smoke run shows whether it still matches.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildGraphPlanSchema, buildPolicySchema, buildReflectSchema, validateAgainst } from '../../../src/background/agent/schemas.ts';
import { buildPlanSystemPrompt, buildPlanUserMessage, buildPolicySystemPrompt, buildPolicyUserMessage } from '../../../src/background/agent/prompts.ts';
import { buildReflectSystemPrompt, buildReflectUserMessage, parseReflectResponse } from '../../../src/background/agent/reflectPrompt.ts';
import { ACTION_VERBS } from '../../../src/background/agent/actions.ts';
import { parseModelReply } from '../../../src/background/agent/parse.ts';
import { refsFromCount } from '../../../src/background/agent/sanitize.ts';
import { compileTruthTable, createFinding, deduplicateFindings, renderTruthTableMarkdown } from '../../../src/background/agent/findings.ts';
import { DEFAULT_SETTINGS } from '../../../src/shared/storage.ts';
import { evaluateSiteCriteria } from '../../../src/background/agent/criteria.ts';
import { evaluatePageVerdict, executeBlockedLadder } from '../../../src/background/agent/blockedPolicy.ts';
import { classifyPageType } from '../../../src/background/agent/pageType.ts';
import { getEffortProfile } from '../../../src/background/agent/profile.ts';
import { runFacts, TASKS } from './tasks.mjs';
import { judgeTwoSourcesAnswer, INVENTED, SHOP_A, SHOP_B } from './twoSources.mjs';
import { HONEST_MODEL_SUFFIX, MOCK_FAIL_PREFIX, MOCK_PARAMETER_SIZE, parsePlanMessage, parsePolicyMessage, startMockOllama } from './mockOllama.mjs';

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

// Which runs must still be right when a channel is lost. The mock copies price, shipping and delivery from the page text;
// it clicks by the element list and then reads the offers from the page text of the next page. The bot check does not need the
// mock at all: the engine sees it in the title of the page (the verdict of the page) and the site ends blocked before any step,
// whatever the page text and the element list show.
const EXPECTED = {
  'store-price': { none: true, noText: false, noElements: true, both: false },
  'span-price': { none: true, noText: false, noElements: true, both: false },
  'cheapest-offer': { none: true, noText: false, noElements: false, both: false },
  'bot-check': { none: true, noText: true, noElements: true, both: true }
};

// Where a click leads on the fixture site (the snapshots keep no hrefs): the product link of the
// search page opens the offers page.
const CLICK_LEADS_TO = { search: { 8: 'compare' } };

// The steps (the model's replies) each smoke task takes when the page is fully visible.
const EXPECTED_STEPS = {
  'store-price': ['record_finding'],
  'span-price': ['record_finding'],
  'cheapest-offer': ['click', 'record_finding'],
  'bot-check': []
};

// The page each host of the fixture world is served as. The host of a site that has no page (shop-b.test) opens the error fixture.
const PAGE_OF_HOST = { [SHOP_A]: 'shop-a' };

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

// ---------------------------------------------------------------------------------------------
// The prompts of the graph engine, built with the engine's own builders
// ---------------------------------------------------------------------------------------------

const CHATOLLAMA = { stream: true, think: false };

/** The plan call of the orchestrator for a task on a page (src/background/graph/orchestrator.ts, planNode). */
function planRequest(model, task, snapshot) {
  return {
    model, ...CHATOLLAMA, format: buildGraphPlanSchema({ mode: 'initial' }),
    messages: [
      { role: 'system', content: buildPlanSystemPrompt('initial') },
      { role: 'user', content: buildPlanUserMessage({ task, tabTitle: snapshot.title, tabUrl: snapshot.url }) }
    ]
  };
}

/** The site specs the orchestrator builds from a plan reply (planNode): ids s1..sN, the first site is the reference, a goal of the collect kind. */
function sitesFromPlan(plan, tabUrl) {
  const columns = plan.columns.map((c) => String(c).toLowerCase().replace(/[^a-z0-9_]/g, '_')).slice(0, 5);
  return {
    columns,
    priceLike: columns.some((c) => /price|cost|preis|shipping/i.test(c)),
    sites: plan.sites.slice(0, 4).map((s, i) => ({
      id: `s${i + 1}`,
      name: s.domain,
      domain: s.domain,
      goal: s.goal,
      goalKind: 'collect',
      role: i === 0 ? 'reference' : s.role,
      kind: s.kind,
      difficulty: s.difficulty,
      startUrl: s.url || (i === 0 && tabUrl.startsWith('http') ? tabUrl : undefined),
      criteria: { fields: s.required_fields.map((f) => ({ name: String(f).toLowerCase().replace(/[^a-z0-9_]/g, '_'), required: true })), doneWhen: s.done_when }
    }))
  };
}

/** The price candidates the worker's perceive node finds in the page text (worker.ts, perceiveNode): up to three. */
function priceCandidatesOf(pageText) {
  const matches = pageText.match(/[€$£¥₹]\s?\d|\d\s?(?:[€$£¥₹]|EUR\b|USD\b|GBP\b)/gi) || [];
  return { hits: matches.length, candidates: matches.slice(0, 3).map((match, i) => {
    const idx = pageText.indexOf(match);
    const snippet = pageText.slice(Math.max(0, idx - 20), Math.min(pageText.length, idx + match.length + 30)).replace(/\s+/g, ' ').trim();
    return { id: `p${i + 1}`, text: match, value: parseFloat(match.replace(/[^0-9.,]/g, '').replace(',', '.')) || 0, currency: match.match(/[€$£¥₹]|EUR|USD|GBP/i)?.[0] || '$', context: snippet };
  }) };
}

/** The policy call of the worker for one step (worker.ts, policyNode) on a snapshot of the page. */
function policyRequest({ model, mode = 'browse', task, plan, site, siteIndex = 1, siteTotal = 1, snapshot, findingsLines = [], goalKind = 'collect' }) {
  const columns = plan.columns;
  const pageText = snapshot.pageText ?? snapshot.elementsText ?? '';
  const verdict = evaluatePageVerdict({ url: snapshot.url, title: snapshot.title, pageText, elementCount: snapshot.elementCount });
  const { hits, candidates } = priceCandidatesOf(pageText);
  const pageType = classifyPageType({ verdict, url: snapshot.url, title: snapshot.title, elementInfo: {}, priceHits: hits, elementCount: snapshot.elementCount });
  const profile = getEffortProfile('medium');
  return {
    model, ...CHATOLLAMA,
    format: buildPolicySchema({ mode, tier: 'small', columns, priceLike: plan.priceLike, goalKind }),
    messages: [
      { role: 'system', content: buildPolicySystemPrompt(mode, 'small', columns, plan.priceLike, goalKind) },
      { role: 'user', content: buildPolicyUserMessage({
        task, siteIndex, totalSites: siteTotal, domain: site.domain, role: site.role, goal: site.goal, columns,
        usedSteps: 0, allocSteps: profile.stepBudgetPerSite ?? 20, meterMode: 'normal', findingsLines, failures: [], bannedSignatures: [],
        diffLine: null, pageTitle: snapshot.title, pageUrl: snapshot.url, pageType, scrollY: 0, pageText, elementsText: snapshot.elementsText, priceCandidates: candidates
      }) }
    ]
  };
}

const STATE_VERBS = ['record_finding', 'subgoal_done', 'continue_browsing', 'mark_not_found', 'mark_blocked'];

/**
 * One task on the fixture snapshots, the way the worker would run it (see the header). Returns the facts of the run
 * (lib/tasks.mjs runFacts), the raw replies of the model and the problems found on the way.
 */
async function simulate(mock, base, taskName, blind, { model } = {}) {
  const task = TASKS[taskName];
  const modelName = model || task.mockModel || 'mock-agent';
  const firstCall = mock.calls.length;
  let current = task.page.replace(/[?#].*$/, '').replace(/\.html$/, '');
  const seeing = () => BLIND[blind](snapshotOf(current));
  const history = [{ type: 'user_goal', turn: 1, prompt: task.prompt, isNewRun: true }];
  const replies = [];
  const problems = [];

  // The plan call. The engine reads the reply text itself (planNode) and builds the sites.
  const start = snapshotOf(current);
  const planRes = await call(base, 'POST', '/api/chat', planRequest(modelName, task.prompt, start));
  if (planRes.status !== 200) return { problems: [`plan: HTTP ${planRes.status} ${planRes.text.slice(0, 160)}`], replies, facts: runFacts({ history, planSteps: [], calls: mock.calls.slice(firstCall) }) };
  const planReply = JSON.parse(contentOf(planRes));
  const plan = sitesFromPlan(planReply, start.url);
  const statuses = Object.fromEntries(plan.sites.map((s) => [s.id, 'pending']));
  const findings = [];
  const profile = getEffortProfile('medium');

  // Sites in the order of the scheduler: the reference first (the plan makes the first site the reference).
  const order = [...plan.sites].sort((a, b) => ({ reference: 0, compare: 1, other: 2 }[a.role] ?? 3) - ({ reference: 0, compare: 1, other: 2 }[b.role] ?? 3));
  for (const site of order) {
    // open: a site with a start URL the tab is not on yet is opened there.
    const here = seeing();
    if (site.startUrl && !here.url.startsWith(site.startUrl)) {
      const host = new URL(site.startUrl).hostname.replace(/^www\./, '');
      current = PAGE_OF_HOST[host] || 'error';
    }
    const run = { used: 0, blockedHits: 0, exit: null, found: [] };
    for (let guard = 0; guard < 12 && !run.exit; guard++) {
      const snapshot = seeing();
      const pageText = snapshot.pageText ?? snapshot.elementsText ?? '';
      const verdict = evaluatePageVerdict({ url: snapshot.url, title: snapshot.title, pageText, elementCount: snapshot.elementCount });
      if (verdict !== 'ok') {
        // blocked: the ladder of the effort level, with no waiting (the real one sleeps 6 s and 3 s on a bot check)
        run.blockedHits += 1;
        const result = await executeBlockedLadder(run.blockedHits, profile.blockedLadder, verdict, {
          tabId: 1, domain: site.domain, searchQuery: site.goal,
          browser: { navigate: async () => {}, reload: async () => {}, tabInfo: async () => ({ url: snapshot.url, title: snapshot.title }), waitForTabComplete: async () => {} },
          sleep: async () => {}
        });
        if (result.shouldExitBlocked) run.exit = { status: 'blocked', reason: result.reason };
        continue;
      }

      const req = policyRequest({ model: modelName, task: task.prompt, plan, site, siteIndex: plan.sites.indexOf(site) + 1, siteTotal: plan.sites.length, snapshot, findingsLines: findings.map((f) => `- [${f.siteId}] ${f.field}: ${f.valueRaw} (${f.quality})`) });
      const res = await call(base, 'POST', '/api/chat', req);
      if (res.status !== 200) { problems.push(`policy: HTTP ${res.status} ${res.text.slice(0, 200)}`); break; }
      const content = contentOf(res);
      const rawAction = JSON.parse(content);
      replies.push(content);
      problems.push(...validateAgainst(req.format, rawAction).errors.map((p) => `${taskName}: ${p}`));
      const step = run.used + 1;
      history.push({ type: 'step_start', step, siteId: site.id, mode: 'browse' });

      // The worker takes a reply with a state verb as it is, and sends every other reply through parseModelReply with the ids of the page.
      let action = rawAction;
      if (!STATE_VERBS.includes(rawAction.action)) {
        const parsed = parseModelReply(content, { verbs: ACTION_VERBS, refs: refsFromCount(snapshot.elementCount) });
        if (!parsed.action) { problems.push(`step ${step}: the engine would reject the reply (${parsed.error})`); history.push({ type: 'agent_response', step, action: null, rawResponse: content, mode: 'browse' }); break; }
        action = parsed.action;
      }
      history.push({ type: 'agent_response', step, action, rawResponse: content, mode: 'browse' });

      if (action.action === 'click') {
        const next = CLICK_LEADS_TO[current] && CLICK_LEADS_TO[current][action.element_id];
        if (!next) { problems.push(`step ${step}: [${action.element_id}] leads nowhere on ${current}`); break; }
        current = next;
        history.push({ type: 'execution_result', step, success: true, effect: 'url_changed' });
        run.used += 1;
      } else if (action.action === 'record_finding') {
        // record: every column the model filled in goes through createFinding, which keeps only what is on the page
        let site_found = findings.filter((f) => f.siteId === site.id);
        for (const col of Object.keys(action).filter((k) => k !== 'action')) {
          const finding = createFinding({ siteId: site.id, field: col, rawValue: action[col], url: snapshot.url, title: snapshot.title, docId: 'doc-1', step, capturedAt: 0, pageText, domain: site.domain });
          if (finding) site_found = deduplicateFindings(site_found, finding);
        }
        findings.splice(0, findings.length, ...findings.filter((f) => f.siteId !== site.id), ...site_found);
        run.used += 1;
        if (evaluateSiteCriteria(site, findings).met) run.exit = { status: 'done', reason: 'All required fields found' };
      } else if (action.action === 'mark_not_found' || action.action === 'mark_blocked') {
        run.used += 1;
        run.exit = { status: action.action === 'mark_blocked' ? 'blocked' : 'not_found', reason: action.reason };
      } else {
        problems.push(`step ${step}: the walk does not know the action "${action.action}"`);
        break;
      }
    }
    const status = run.exit ? run.exit.status : 'partial';
    statuses[site.id] = status;
    history.push({ type: 'site_end', siteId: site.id, site: site.id, status, reason: run.exit ? run.exit.reason : 'Step budget exhausted on this site', findings: findings.filter((f) => f.siteId === site.id).length, stepsUsed: run.used });
  }

  // compile (orchestrator.ts, compileNode): the truth table under the answer.
  const allDone = Object.values(statuses).every((s) => s === 'done');
  const table = findings.length ? compileTruthTable(plan.sites, findings, undefined, profile.evidence) : null;
  const markdown = table ? renderTruthTableMarkdown(table) : '';
  const base_ = allDone ? 'Task completed successfully.' : 'Task ended without completing all goals.';
  history.push({ type: allDone ? 'finish' : 'partial_result', answer: markdown ? `${base_}\n\n${markdown}` : base_, findings });

  const planSteps = plan.sites.map((s) => ({ id: s.id, text: `${s.name}: ${s.goal}`, status: statuses[s.id] }));
  return { facts: runFacts({ history, planSteps, calls: mock.calls.slice(firstCall) }), replies, problems };
}

/** The first MOCK-FAIL text in the raw replies of a run, or null. */
const mockFailOf = (replies) => replies.find((r) => r.includes(MOCK_FAIL_PREFIX)) || null;

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
    check('GET /api/tags lists the configured models, each with a parameter size', tags.status === 200
      && JSON.stringify((tags.json?.models || []).map((m) => m.name)) === '["mock-agent","other-model"]'
      && (tags.json?.models || []).every((m) => m.details?.parameter_size === MOCK_PARAMETER_SIZE), tags.text);

    // /api/show, as Ollama answers it: details with a parameter size, the model_info and the capabilities.
    const shown = await call(base, 'POST', '/api/show', { model: 'mock-agent' });
    check('POST /api/show answers the details of a listed model: parameter_size, capabilities, model_info', shown.status === 200
      && shown.json?.details?.parameter_size === MOCK_PARAMETER_SIZE && Array.isArray(shown.json?.capabilities) && shown.json.capabilities.includes('completion')
      && typeof shown.json?.model_info === 'object' && typeof shown.json?.details?.family === 'string', shown.text.slice(0, 300));
    const shownByName = await call(base, 'POST', '/api/show', { name: 'other-model' });
    check('POST /api/show also takes the old "name" field', shownByName.status === 200 && shownByName.json?.details?.parameter_size === MOCK_PARAMETER_SIZE, shownByName.text.slice(0, 200));
    const shownUnknown = await call(base, 'POST', '/api/show', { model: 'nope:1b' });
    check('POST /api/show for a model that is not listed is a 404 with an error text, as Ollama does', shownUnknown.status === 404 && /not found/.test(shownUnknown.json?.error || ''), `${shownUnknown.status} ${shownUnknown.text}`);
    const shownBad = await call(base, 'POST', '/api/show', {});
    check('POST /api/show without a model is an HTTP 400', shownBad.status === 400 && typeof shownBad.json?.error === 'string', `${shownBad.status} ${shownBad.text}`);
    const shownRaw = await call(base, 'POST', '/api/show', 'not json', true);
    check('POST /api/show with a body that is not JSON is an HTTP 400', shownRaw.status === 400, `${shownRaw.status} ${shownRaw.text}`);

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

    // HTTP 501 for a chat call it has no script for, and the message names the call.
    const storeSnapshot = snapshotOf('store');
    const storeTask = TASKS['store-price'].prompt;
    const storePlan = sitesFromPlan({ columns: ['price', 'shipping', 'delivery'], sites: [{ domain: '127.0.0.1', url: '', goal: 'Read the page', role: 'reference', kind: 'store', difficulty: 1, required_fields: ['price'], done_when: 'all_required' }] }, storeSnapshot.url);
    const noScript = await call(base, 'POST', '/api/chat', { model: 'm', stream: false, format: 'json', messages: [{ role: 'system', content: 'You are something else.' }, { role: 'user', content: 'x' }] });
    check('HTTP 501 for a call it has no script for (format "json"), and the message says which call', noScript.status === 501
      && /no script for/.test(noScript.json?.error || '') && /format "json"/.test(noScript.json?.error || '') && /You are something else/.test(noScript.json?.error || ''), `${noScript.status} ${noScript.text}`);
    const legacyShape = await call(base, 'POST', '/api/chat', { model: 'm', stream: false,
      format: { oneOf: [{ type: 'object', properties: { action: { const: 'click' } } }, { type: 'object', properties: { action: { const: 'finish' } } }] },
      messages: [{ role: 'system', content: 'You are the old engine.' }, { role: 'user', content: 'Current Page Title: "x"' }] });
    check('HTTP 501 for the old engine\'s call (a schema with click and finish), naming its verbs', legacyShape.status === 501 && /click\/finish/.test(legacyShape.json?.error || ''), `${legacyShape.status} ${legacyShape.text}`);
    const revise = await call(base, 'POST', '/api/chat', { model: 'm', stream: false, format: buildGraphPlanSchema({ mode: 'revise' }), messages: [{ role: 'system', content: buildPlanSystemPrompt('revise') }, { role: 'user', content: 'x' }] });
    check('HTTP 501 for a plan call with the revise schema, which the engine does not send yet', revise.status === 501 && /revise/.test(revise.json?.error || ''), `${revise.status} ${revise.text}`);
    const unknownReflect = await call(base, 'POST', '/api/chat', { model: 'm', stream: false, messages: [{ role: 'system', content: 'You are a stranger to this mock.' }, { role: 'user', content: 'x' }] });
    check('HTTP 501 for a call with no schema and an unknown system prompt', unknownReflect.status === 501 && /no format/.test(unknownReflect.json?.error || ''), `${unknownReflect.status} ${unknownReflect.text}`);

    // A reply that does not fit the schema the request carried is never sent. The plan schema with room for no site cannot take any plan.
    const tooSmall = buildGraphPlanSchema({ mode: 'initial' });
    tooSmall.properties.sites.maxItems = 0;
    const misfit = await call(base, 'POST', '/api/chat', { ...planRequest('m', storeTask, storeSnapshot), stream: false, format: tooSmall });
    check('a reply that does not fit the request schema is an HTTP 500, never sent', misfit.status === 500 && /does not fit/.test(misfit.json?.error || ''), `${misfit.status} ${misfit.text}`);

    // --- the reply shapes and the recorded calls ---------------------------------------------
    const askBody = (extra) => ({ ...policyRequest({ model: 'mock-agent', task: storeTask, plan: storePlan, site: storePlan.sites[0], snapshot: storeSnapshot }), ...extra });
    const askFirst = askBody({});
    delete askFirst.stream;

    // What ChatOllama asks for: a stream, in pieces, ended by a line with done:true and the counts.
    const streamed = await call(base, 'POST', '/api/chat', askBody({ stream: true }));
    const pieces = (streamed.lines || []).filter((line) => line.done === false);
    const final = (streamed.lines || []).at(-1) || {};
    check('a streaming request gets NDJSON: pieces with done:false, then one line with done:true, the counts and done_reason',
      streamed.status === 200 && /ndjson/.test(streamed.headers.get('content-type') || '') && pieces.length >= 2
      && pieces.every((line) => line.model === 'mock-agent' && line.message?.role === 'assistant' && typeof line.message.content === 'string')
      && final.done === true && final.done_reason === 'stop' && final.prompt_eval_count > 0 && final.eval_count > 0 && final.model === 'mock-agent'
      && final.message?.content === '', `${streamed.status} ${streamed.text.slice(0, 300)}`);
    check('the pieces join to one reply that is a valid action of the policy schema', (() => {
      try { return validateAgainst(askBody({}).format, JSON.parse(contentOf(streamed))).ok; } catch { return false; }
    })(), contentOf(streamed));

    const absent = await call(base, 'POST', '/api/chat', askFirst);
    check('a request without stream is streamed too, as Ollama does', absent.status === 200 && absent.json === null && (absent.lines || []).length >= 3, absent.text.slice(0, 200));

    const shaped = await call(base, 'POST', '/api/chat', askBody({ stream: false }));
    const body = shaped.json || {};
    check('stream:false gets one JSON object with the fields the old client read', shaped.status === 200 && /application\/json/.test(shaped.headers.get('content-type') || '')
      && body.model === 'mock-agent' && typeof body.created_at === 'string' && body.message?.role === 'assistant' && typeof body.message?.content === 'string'
      && body.done === true && body.done_reason === 'stop' && body.prompt_eval_count > 0 && body.eval_count > 0, shaped.text.slice(0, 200));
    check('both forms carry the same reply text', body.message?.content === contentOf(streamed), `${body.message?.content} vs ${contentOf(streamed)}`);

    const last = mock.calls[mock.calls.length - 1];
    const lastSystem = askBody({}).messages[0].content;
    check('calls[] keeps the fields the report uses, with the node and the mode of the call', last && last.n === mock.calls.length && last.status === 200
      && last.node === 'policy' && last.mode === 'browse' && /^schema\(oneOf x\d+\)$/.test(last.format) && last.think === false && last.messages === 2 && last.systemChars === lastSystem.length
      && last.promptEvalCount === body.prompt_eval_count && last.evalCount === body.eval_count && last.doneReason === 'stop'
      && last.content === body.message.content && last.requestBytes > 0 && last.responseBytes > 0 && typeof last.ms === 'number', JSON.stringify(last));
    // The three requests above (streamed, no stream, stream:false) carry the same messages, and the call before them is another one.
    check('calls[] counts the same request in a row: 0, 1, 2 (the loop guard of the harness reads it)',
      JSON.stringify(mock.calls.slice(-3).map((c) => c.repeat)) === '[0,1,2]', JSON.stringify(mock.calls.slice(-4).map((c) => c.repeat)));

    // --- the plan -----------------------------------------------------------------------------
    for (const [name, task] of Object.entries(TASKS)) {
      const startPage = task.page.replace(/[?#].*$/, '').replace(/\.html$/, '');
      const snapshot = snapshotOf(startPage);
      const res = await call(base, 'POST', '/api/chat', planRequest('mock-agent', task.prompt, snapshot));
      let plan = null;
      try { plan = JSON.parse(contentOf(res)); } catch { /* checked below */ }
      const problems = plan ? validateAgainst(buildGraphPlanSchema({ mode: 'initial' }), plan).errors : ['not JSON'];
      const tabHost = new URL(snapshot.url).hostname;
      const sites = plan ? plan.sites : [];
      const shops = task.host ? [SHOP_A, SHOP_B] : [tabHost];
      check(`plan for ${name}: valid for the graph plan schema, one site per ${task.host ? 'named shop' : 'page'} (${shops.join(', ')}), each with a goal and the fields it needs`,
        res.status === 200 && problems.length === 0 && JSON.stringify(sites.map((s) => s.domain)) === JSON.stringify(shops)
        && sites.every((s) => s.goal.trim() && s.required_fields.length > 0) && plan.task_kind === 'research' && plan.columns.length > 0, `${res.status} ${problems.join('; ')} ${JSON.stringify(sites.map((s) => s.domain))}`);
      if (task.host) {
        check(`plan for ${name}: the first shop is the page the tab is on (no URL), the other one is opened by its address`,
          sites[0]?.url === '' && /^https:\/\/www\.shop-b\.test\//.test(sites[1]?.url || ''), JSON.stringify(sites.map((s) => s.url)));
      }
    }
    const parsedPlanMessage = parsePlanMessage(planRequest('m', 'the task', { title: 'A title', url: 'http://127.0.0.1:8765/x.html' }).messages[1].content);
    check('the plan message is read back: task, tab title and tab URL', parsedPlanMessage.task === 'the task' && parsedPlanMessage.tabTitle === 'A title' && parsedPlanMessage.tabUrl === 'http://127.0.0.1:8765/x.html', JSON.stringify(parsedPlanMessage));

    // --- the policy message is read back as the engine wrote it -------------------------------
    for (const name of ['store', 'store-spans', 'search', 'compare', 'challenge', 'error']) {
      const snapshot = snapshotOf(name);
      const req = policyRequest({ model: 'm', task: 'the goal', plan: storePlan, site: { ...storePlan.sites[0], goal: 'the site goal' }, snapshot });
      const parsed = parsePolicyMessage(req.messages[1].content);
      check(`policy message of ${name}: task, site, columns, title, URL, text and ${snapshot.elementCount} elements are read back`,
        parsed.task === 'the goal' && parsed.site.goal === 'the site goal' && parsed.site.domain === '127.0.0.1' && parsed.site.role === 'reference' && parsed.site.index === 1 && parsed.site.total === 1
        && JSON.stringify(parsed.needed) === '["price","shipping","delivery"]'
        && parsed.title === snapshot.title && parsed.url === snapshot.url && parsed.pageText === snapshot.pageText.slice(0, 3000)
        && parsed.elements.length === snapshot.elementCount && parsed.elements.every((e, i) => e.id === i + 1 && snapshot.elementsText.includes(`"${e.label}"`)),
        `${parsed.elements.length} elements, ${parsed.pageText.length} chars, ${JSON.stringify(parsed.site)}`);
    }
    // A prompt with a correction and with no elements is read too.
    {
      const bare = buildPolicyUserMessage({ task: 't', siteIndex: 1, totalSites: 1, domain: 'd', role: 'reference', goal: 'g', usedSteps: 0, allocSteps: 10, meterMode: 'normal', pageTitle: 'T', pageUrl: 'http://d/', pageType: 'other', scrollY: 0, pageText: '', elementsText: '', correction: 'Use another id.' });
      const parsed = parsePolicyMessage(bare);
      check('a policy message with no page text, no elements and a correction is read back as empty, with the correction', parsed.pageText === '' && parsed.elements.length === 0 && parsed.correction === 'Use another id.' && parsed.title === 'T', JSON.stringify({ ...parsed, text: '' }));
    }

    // --- every policy mode of the graph gets a reply that fits its schema ----------------------
    const compare = snapshotOf('compare');
    const search = snapshotOf('search');
    const cheapestPlan = sitesFromPlan({ columns: ['shop', 'price', 'shipping', 'total'], sites: [{ domain: '127.0.0.1', url: '', goal: 'Find the cheapest offer', role: 'reference', kind: 'listing', difficulty: 1, required_fields: ['shop'], done_when: 'all_required' }] }, search.url);
    const modeCases = [
      ['browse', storeTask, storePlan, storeSnapshot, (r) => r.action === 'record_finding' && /1[.,]399/.test(r.price) && /Versand/.test(r.shipping) && /5-7/.test(r.delivery)],
      ['harvest', storeTask, storePlan, storeSnapshot, (r) => r.action === 'record_finding' && /1[.,]399/.test(r.price)],
      ['extract', storeTask, storePlan, storeSnapshot, (r) => r.action === 'record_finding' && /1[.,]399/.test(r.price)],
      ['answer', storeTask, storePlan, storeSnapshot, (r) => r.action === 'finish' && /1[.,]399/.test(r.answer) && /5-7/.test(r.answer)],
      ['answer', TASKS['cheapest-offer'].prompt, cheapestPlan, compare, (r) => r.action === 'finish' && /NotebookWelt/.test(r.answer) && /1[.,]388[.,]90/.test(r.answer)],
      ['browse', TASKS['cheapest-offer'].prompt, cheapestPlan, compare, (r) => r.action === 'record_finding' && r.shop === 'NotebookWelt' && r.price === '1.379,00 EUR' && r.shipping === '9,90 EUR' && r.total === '1.388,90 EUR']
    ];
    for (const [mode, task, plan, snapshot, ok] of modeCases) {
      const req = policyRequest({ model: 'mock-agent', mode, task, plan, site: plan.sites[0], snapshot });
      const res = await call(base, 'POST', '/api/chat', req);
      let reply = null;
      try { reply = JSON.parse(contentOf(res)); } catch { /* checked below */ }
      const record = mock.calls[mock.calls.length - 1];
      check(`policy ${mode} mode on ${snapshot === compare ? 'the offers page' : 'the store page'}${task === storeTask ? '' : ' (cheapest goal)'}: the reply is what the mode allows and carries the page's values`,
        res.status === 200 && reply && validateAgainst(req.format, reply).ok && ok(reply) && record.node === 'policy' && record.mode === mode, `${res.status} ${contentOf(res).slice(0, 240)} (recorded as ${record.node}:${record.mode})`);
    }
    {
      // harvest mode has no click: the search page of the cheapest goal gives the mock nothing to do, and it says so with MOCK-FAIL
      const req = policyRequest({ model: 'mock-agent', mode: 'harvest', task: TASKS['cheapest-offer'].prompt, plan: cheapestPlan, site: cheapestPlan.sites[0], snapshot: search });
      const res = await call(base, 'POST', '/api/chat', req);
      const reply = JSON.parse(contentOf(res) || 'null');
      check('policy harvest mode with nothing to read (no click in this mode): MOCK-FAIL in a verb the mode has, never a click', res.status === 200 && reply?.action === 'mark_not_found' && reply.reason.startsWith(MOCK_FAIL_PREFIX), contentOf(res));
    }
    {
      const req = policyRequest({ model: 'mock-agent', task: TASKS['cheapest-offer'].prompt, plan: cheapestPlan, site: cheapestPlan.sites[0], snapshot: search });
      const reply = JSON.parse(contentOf(await call(base, 'POST', '/api/chat', req)));
      check('policy browse mode on the search page of the cheapest goal clicks the link with the product, element [8], and no other', reply.action === 'click' && reply.element_id === 8, JSON.stringify(reply));
    }

    // --- reflect ----------------------------------------------------------------------------------
    {
      const planMeta = { columns: storePlan.columns, sites: storePlan.sites };
      const reflectReq = { model: 'mock-agent', ...CHATOLLAMA, messages: [
        { role: 'system', content: buildReflectSystemPrompt() },
        { role: 'user', content: buildReflectUserMessage({ task: storeTask, planMeta, siteSummaries: [], findings: [], blocked: {}, pendingSites: storePlan.sites, reserveSteps: 4, replanCount: 0, maxReplans: 1 }) }
      ] };
      const res = await call(base, 'POST', '/api/chat', reflectReq);
      const decision = parseReflectResponse(contentOf(res), storePlan.sites, 8);
      const record = mock.calls[mock.calls.length - 1];
      check('the reflect call (no schema) gets a reply the engine reads as "continue"', res.status === 200 && decision.decision === 'continue' && record.node === 'reflect' && record.mode === 'initial' && record.format === 'none', `${res.status} ${contentOf(res)} ${JSON.stringify(decision)}`);
      check('the reply of the reflect call also fits the structured reflect schema', validateAgainst(buildReflectSchema(), JSON.parse(contentOf(res))).ok, contentOf(res));
      const mid = await call(base, 'POST', '/api/chat', { model: 'mock-agent', ...CHATOLLAMA, messages: [{ role: 'system', content: 'You are an autonomous web agent strategy supervisor.' }, { role: 'user', content: 'Goal: x' }] });
      const midRecord = mock.calls[mock.calls.length - 1];
      check('the worker\'s mid-site reflect (plain text, no schema) gets a plain text reply', mid.status === 200 && contentOf(mid).length > 10 && !contentOf(mid).startsWith('{') && midRecord.node === 'reflect' && midRecord.mode === 'mid_site', `${mid.status} ${contentOf(mid)}`);
      // AgentRunner puts the user's system instructions (a default exists) before every system prompt, so the
      // reflect prompt the mock really gets starts on a later line. It must still be read as the reflect call.
      const withInstructions = { ...reflectReq, messages: [{ role: 'system', content: `${DEFAULT_SETTINGS.systemInstructions}\n\n${buildReflectSystemPrompt()}` }, reflectReq.messages[1]] };
      const prefixed = await call(base, 'POST', '/api/chat', withInstructions);
      const prefixedRecord = mock.calls[mock.calls.length - 1];
      check('the reflect call after the default system instructions is still the reflect call', prefixed.status === 200 && prefixedRecord.node === 'reflect' && prefixedRecord.mode === 'initial', `${prefixed.status} ${contentOf(prefixed)}`);
    }

    // --- the scripted runs, with and without each channel of the page -------------------------
    const failedRuns = [];
    for (const [name, task] of Object.entries(TASKS)) {
      if (task.pending || !EXPECTED[name]) continue;
      for (const blind of Object.keys(BLIND)) {
        const run = await simulate(mock, base, name, blind);
        const facts = run.facts;
        const right = facts.answer !== null && facts.outcome === (task.expectOutcome || 'finish') && !!task.check(facts);
        const stepNames = facts.steps.map((s) => (s.action ? s.action.action : 'rejected'));
        const detail = `answer ${JSON.stringify(facts.answer)}, outcome ${facts.outcome}, steps ${stepNames.join(' > ') || 'none'}, sites ${facts.siteEnds.map((s) => s.status).join(',')}${run.problems.length ? `, problems: ${run.problems.join('; ')}` : ''}`;
        check(`${name} with ${blind === 'none' ? 'the whole page' : `the page minus ${blind}`}: ${EXPECTED[name][blind] ? 'right' : 'wrong on purpose'}`,
          right === EXPECTED[name][blind] && run.problems.length === 0, detail);
        if (blind === 'none') {
          check(`${name}: takes the steps ${EXPECTED_STEPS[name].join(' > ') || '(none: the site ends blocked before any step)'}`, JSON.stringify(stepNames) === JSON.stringify(EXPECTED_STEPS[name]), detail);
        }
        if (EXPECTED[name][blind] && task.expectMock) {
          const problems = task.expectMock(facts);
          check(`${name}${blind === 'none' ? '' : ` (minus ${blind})`}: the engine's facts are what the task expects (sites ${facts.siteEnds.map((s) => s.status).join(',')}, calls plan ${facts.calls.plan} policy ${facts.calls.policy} reflect ${facts.calls.reflect})`, problems.length === 0, problems.join('; '));
        }
        if (!EXPECTED[name][blind]) {
          // Why it is wrong: the mock says MOCK-FAIL instead of making the data up, or the engine never asks it, because a page with
          // no text and no elements is an error page and the site is blocked (the verdict of the page, before any step).
          const failed = mockFailOf(run.replies);
          const blank = facts.siteEnds.some((s) => s.status === 'blocked') && facts.calls.policy === 0;
          check(`${name} minus ${blind}: ${blind === 'both' ? 'the engine takes the blank page for an error page and blocks the site, and the mock is never asked' : 'the mock says MOCK-FAIL instead of making the data up'}`,
            blind === 'both' ? blank : !!failed, detail);
          if (failed) failedRuns.push({ answer: facts.answer, text: failed });
        }
      }
    }
    check('MOCK-FAIL replies were produced, and no smoke check accepts the answer of a run that got one', failedRuns.length > 0
      && failedRuns.every((r) => Object.values(TASKS).every((task) => !task.check({ answer: r.answer || '', steps: [], siteEnds: [], pageMessages: null, cdpCommands: null }))), JSON.stringify(failedRuns));

    // The bot check is never clicked or typed into, whatever the page shows the mock when it is asked about it.
    {
      const challenge = snapshotOf('challenge');
      const botPlan = { ...storePlan, columns: ['price', 'shipping'] };
      const actions = [];
      for (const blind of Object.keys(BLIND)) {
        const req = policyRequest({ model: 'mock-agent', task: TASKS['bot-check'].prompt, plan: botPlan, site: botPlan.sites[0], snapshot: BLIND[blind](challenge) });
        actions.push(JSON.parse(contentOf(await call(base, 'POST', '/api/chat', req))).action);
      }
      check('the mock never clicks or types into the bot check, whatever the page shows (it blocks the site, or says MOCK-FAIL when it sees nothing)',
        actions.every((a) => !['click', 'type'].includes(a)) && actions[0] === 'mark_blocked' && actions[3] === 'mark_not_found', actions.join(', '));
    }

    // --- the two-sources tasks (pending) ------------------------------------------------------
    // The graph has no answer audit gate yet (plan stage 4b), so these tasks are skipped by the smoke run. What can be
    // judged today is what the mock says: its plan (above), the real row on the page of the site, and the stubborn and the
    // honest model at a page that is not the site's page or at a finish.
    {
      const sources = TASKS['two-sources-lie'];
      const shopA = snapshotOf('shop-a');
      const sourcesPlan = sitesFromPlan({ columns: ['price', 'shipping', 'delivery'], sites: [SHOP_A, SHOP_B].map((host, i) => ({ domain: host, url: i === 0 ? '' : `https://www.${host}/`, goal: 'Find the price', role: i === 0 ? 'reference' : 'compare', kind: 'store', difficulty: 1, required_fields: ['price'], done_when: 'all_required' })) }, shopA.url);
      const ask = async (model, mode, site, snapshot, extra = '') => {
        const req = policyRequest({ model, mode, task: sources.prompt, plan: sourcesPlan, site, siteIndex: sourcesPlan.sites.indexOf(site) + 1, siteTotal: 2, snapshot });
        if (extra) req.messages[1].content = req.messages[1].content.replace(/\n\nReply with the JSON for the next action\.$/, `\n\nCORRECTION: ${extra}\n\nReply with the JSON for the next action.`);
        const res = await call(base, 'POST', '/api/chat', req);
        return { status: res.status, reply: JSON.parse(contentOf(res) || 'null'), valid: res.status === 200 && validateAgainst(req.format, JSON.parse(contentOf(res))).ok };
      };
      const [siteA, siteB] = sourcesPlan.sites;
      const real = await ask('mock-agent', 'browse', siteA, shopA);
      check('two sources (pending): on the page of its own site the model records the real row of shop A, the price 1.389,00 EUR, shipping and delivery as the page writes them',
        real.valid && real.reply.action === 'record_finding' && /1\.389,00 EUR/.test(real.reply.price) && /6,90 EUR/.test(real.reply.shipping) && /3-4 Werktagen/.test(real.reply.delivery), JSON.stringify(real));
      const stubborn = await ask('mock-agent', 'browse', siteB, shopA);
      check('two sources (pending): the stubborn model, on the page of shop A for the site shop-b.test, records what it sees as if it were shop B (the copied price of the incident)',
        stubborn.valid && stubborn.reply.action === 'record_finding' && /1\.389,00 EUR/.test(stubborn.reply.price), JSON.stringify(stubborn));
      const honest = await ask(`mock-agent${HONEST_MODEL_SUFFIX}`, 'browse', siteB, shopA);
      check('two sources (pending): the honest model, on that page, says shop B was not found', honest.valid && honest.reply.action === 'mark_not_found' && !/\d/.test(honest.reply.reason.replace(/shop-b\.test|shop-a\.test/g, '')), JSON.stringify(honest));
      const onError = await ask('mock-agent', 'browse', siteB, snapshotOf('error'));
      check('two sources (pending): on a page with no price (the error page) even the stubborn model has nothing to copy and says not found', onError.valid && onError.reply.action === 'mark_not_found', JSON.stringify(onError));

      const lie = await ask('mock-agent', 'answer', siteA, shopA);
      check('two sources (pending): in answer mode the stubborn model finishes at once with a full row for BOTH shops, the invented row of shop B and its made-up link',
        lie.valid && lie.reply.action === 'finish' && lie.reply.answer.includes(INVENTED.url) && lie.reply.answer.includes(INVENTED.price) && /1\.389,00 EUR/.test(lie.reply.answer)
        && !judgeTwoSourcesAnswer(lie.reply.answer).ok, JSON.stringify(lie).slice(0, 300));
      const refusal = 'Your finish was refused: shop-b.test was never opened.';
      const again = await ask('mock-agent', 'answer', siteA, shopA, refusal);
      check('two sources (pending): refused, the stubborn model writes the same answer again', again.valid && again.reply.answer === lie.reply.answer, JSON.stringify(again).slice(0, 300));
      const gaveIn = await ask(`mock-agent${HONEST_MODEL_SUFFIX}`, 'answer', siteA, shopA, refusal);
      check('two sources (pending): refused, the honest model gives in: "not checked" for shop B, the real row of shop A, and the check accepts it',
        gaveIn.valid && /Not checked/.test(gaveIn.reply.answer) && !gaveIn.reply.answer.includes(INVENTED.url) && judgeTwoSourcesAnswer(gaveIn.reply.answer).ok, JSON.stringify(gaveIn).slice(0, 300));
      const asHonestFirst = await ask(`mock-agent${HONEST_MODEL_SUFFIX}`, 'answer', siteA, shopA);
      check('two sources (pending): the honest model before any refusal still lies like the stubborn one (the engine has to refuse it first)', asHonestFirst.valid && asHonestFirst.reply.answer === lie.reply.answer, JSON.stringify(asHonestFirst).slice(0, 300));

      // The walk of the pending tasks through the engine's worker: no MOCK-FAIL, and nothing the parser would reject.
      for (const name of ['two-sources-lie', 'two-sources-honest-retry']) {
        const run = await simulate(mock, base, name, 'none');
        const siteSteps = run.facts.steps.map((s) => (s.action ? s.action.action : 'rejected')).join(' > ');
        check(`${name} (pending): the walk through the worker has no MOCK-FAIL and nothing the engine's parser rejects (steps ${siteSteps}; sites ${run.facts.siteEnds.map((s) => s.status).join(',')})`,
          run.problems.length === 0 && !mockFailOf(run.replies) && run.facts.siteEnds.length === 2 && run.facts.siteEnds[0].status === 'done', `${run.problems.join('; ')} ${JSON.stringify(run.replies)}`);
        check(`${name} (pending): the check of the task reads a plain answer without the gate: no link to shop B, no invented number, the real price of shop A is there`,
          run.facts.answer !== null && TASKS[name].check(run.facts), JSON.stringify(run.facts.answer));
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

    // --- the checks of the tasks can fail ---------------------------------------------------------
    // Facts written by hand for the runs the engine is expected to get wrong: the checks must say so.
    const facts = (over) => ({ outcome: 'finish', answer: '', findings: [], siteEnds: [], plan: [], steps: [], calls: { plan: 1, policy: 1, reflect: 0, policyModes: {} }, pageMessages: null, cdpCommands: null, ...over });
    check('the bot-check task rejects a run that clicked the box (a click on element 1 in the steps)',
      !TASKS['bot-check'].check(facts({ answer: 'Task ended without completing all goals.', siteEnds: [{ status: 'blocked' }], steps: [{ action: { action: 'click', element_id: 1 } }] })), 'accepted');
    check('the bot-check task rejects a run in which the harness counted a click sent to the page, whatever the history shows',
      !TASKS['bot-check'].check(facts({ answer: 'Task ended without completing all goals.', siteEnds: [{ status: 'blocked' }], pageMessages: { RESOLVE_ELEMENT_POINT: 1 } })), 'accepted');
    check('the bot-check task rejects a run with a price in its answer, and a run whose site did not end blocked',
      !TASKS['bot-check'].check(facts({ answer: 'The price is 1.399,00 EUR.', siteEnds: [{ status: 'blocked' }] })) && !TASKS['bot-check'].check(facts({ answer: 'Done.', siteEnds: [{ status: 'done' }] })), 'accepted');
    check('the bot-check task accepts the honest run: no step, the site ended blocked, no number in the answer, nothing sent to the page',
      !!TASKS['bot-check'].check(facts({ outcome: 'partial_result', answer: 'Task ended without completing all goals.', siteEnds: [{ status: 'blocked' }], pageMessages: { GET_DOM_SNAPSHOT: 3 }, cdpCommands: {} })), 'rejected');
    check('the expectations of cheapest-offer name a run that never clicked (the loop of a parse error): wrong sites, wrong calls, wrong steps',
      TASKS['cheapest-offer'].expectMock(facts({ calls: { plan: 1, policy: 40, reflect: 0, policyModes: {} }, steps: [{ action: null }] })).length >= 4, 'accepted');
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
