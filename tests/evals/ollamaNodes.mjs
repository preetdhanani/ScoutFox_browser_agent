/**
 * Opt-in eval of what ScoutFox sends to Ollama (phase P0a, moved onto ChatOllama in P2). Not part of `npm test`:
 * it needs a local Ollama with the models pulled, and a full run takes about 15-25 minutes.
 *
 * Everything under test is imported from the extension code, so the eval cannot drift from
 * it: the schemas (src/background/agent/schemas.ts, from shared/actions.json), both system prompts, the step message and the
 * parser (background/agentEngine.js), the plan call (generatePlan) and the real Ollama client
 * (ApiClients.callOllama, which is src/background/llm/ollama.ts: a new ChatOllama per call with the
 * schema as `format`, think:false, num_ctx and num_predict, and the same think and schema fallbacks the
 * extension has). The requests are streamed, as they are in the extension. The pages are what the real content script saw on the local
 * fixture site (tests/fixtures/snapshots, written by `node tests/e2e/smoke.mjs --dump-snapshots`).
 *
 * Sections:
 *   actions - three page scenarios, the legacy prompt with format:"json" against the compact
 *             prompt with the action schema: a price page (right = finish with the price, or
 *             read more text), a bot-check page (right = never click "Verify you are human")
 *             and search results (right = click the one matching product);
 *   plans   - the plan schema: three named sites, a maxItems probe (12 steps asked, 6 allowed)
 *             and a nested-objects probe (the steps must keep their own required keys);
 *   probes  - grammar probes behind registry choices: browser_batch steps as nested oneOf
 *             against a flat object, element ids bounded by the element count against a wide
 *             bound, and the URL pattern.
 * Every run records whether the raw reply is valid against the schema (ajv), whether it is
 * right, the latency, and Ollama's prompt_eval_count and eval_count.
 *
 * Setup: cd tests/evals && npm install
 * Run:   node ollamaNodes.mjs                               both models, 6 runs per cell
 *        node ollamaNodes.mjs --models=qwen3.5:9b --runs=3
 *        node ollamaNodes.mjs --only=actions,plans,probes
 *        node ollamaNodes.mjs --out=results.jsonl           also write one JSON line per run
 * Env:   OLLAMA_URL (default http://127.0.0.1:11434)
 */
import Ajv from 'ajv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collapseChatResponse } from '../e2e/lib/callRecord.mjs';

// The engine logs every call at info level; the eval prints its own table instead.
const quiet = () => {};
console.info = quiet;
console.warn = quiet;
console.error = quiet;

const { AgentEngine } = await import('../../background/agentEngine.js');
const { ApiClients } = await import('../../background/apiClients.js');
const { DEFAULT_SETTINGS } = await import('../../src/shared/storage.ts');
const { Logger } = await import('../../src/shared/logger.ts');
const { buildActionSchema, buildPlanSchema, PLAN_MAX_STEPS } = await import('../../src/background/agent/schemas.ts');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOTS = path.resolve(HERE, '..', 'fixtures', 'snapshots');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
}));
const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
const MODELS = String(args.models || 'qwen3.5:9b,gemma4:12b').split(',');
const RUNS = Number(args.runs || 6);
const ONLY = new Set(String(args.only || 'actions,plans,probes').split(','));
const OUT = args.out ? path.resolve(String(args.out)) : null;
if (OUT) fs.writeFileSync(OUT, '');

const ajv = new Ajv({ strict: true, allErrors: true });
const validators = new Map();
function isValid(schema, value) {
  if (!validators.has(schema)) validators.set(schema, ajv.compile(schema));
  return value !== null && validators.get(schema)(value) === true;
}

// Captures the exchange of the last real fetch, so the eval reads Ollama's own token counts
// while the request itself is still built by ApiClients.callOllama. The answer is a stream (NDJSON), so it is
// read from a clone while the client reads the original, and lastExchange.json is the whole answer as one object
// (the last line with the counts, and the text of all the pieces joined). settledExchange() waits for it.
const realFetch = globalThis.fetch;
let lastExchange = null;
let exchangeRead = Promise.resolve();
globalThis.fetch = async (url, init) => {
  const res = await realFetch(url, init);
  const request = init && init.body ? JSON.parse(init.body) : null;
  exchangeRead = res.clone().text().then((text) => { lastExchange = { request, status: res.status, json: collapseChatResponse(text) }; }, () => {});
  return res;
};
async function settledExchange() {
  await exchangeRead;
  return lastExchange;
}

function loadSnapshot(name) {
  return JSON.parse(fs.readFileSync(path.join(SNAPSHOTS, `${name}.json`), 'utf8'));
}

/** The id of the element whose label matches, from the snapshot's element list. */
function idByLabel(snapshot, labelRe) {
  for (const line of snapshot.elementsText.split('\n')) {
    const m = line.match(/^\[(\d+)\] \S+ "([^"]*)"/);
    if (m && labelRe.test(m[2])) return Number(m[1]);
  }
  throw new Error(`No element matches ${labelRe} in ${snapshot.url}`);
}

/** Element ids this action would click or type into, batch steps included. */
function touchedIds(act) {
  if (!act) return [];
  const own = ['click', 'type'].includes(act.action) ? [act.element_id] : [];
  const steps = Array.isArray(act.steps) ? act.steps.filter((s) => ['click', 'type'].includes(s.action)).map((s) => s.element_id) : [];
  return [...own, ...steps].map(Number);
}

function parseObject(text) {
  try {
    const v = JSON.parse(String(text || '').trim());
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

const settingsFor = (model) => ({ ...DEFAULT_SETTINGS, provider: 'ollama', baseUrl: OLLAMA_URL, model });
const engine = new AgentEngine();
const IDENTITY = DEFAULT_SETTINGS.systemInstructions;

function stepMessages(goal, snapshot) {
  engine.currentTask = goal;
  engine.history = [{ type: 'user_goal', turn: 1, prompt: goal }];
  engine.planSteps = [];
  engine.stepCount = 1;
  return engine.formatMessagesForLLM(engine.buildStepMessage(snapshot, DEFAULT_SETTINGS.maxSteps));
}

/** One real call through ApiClients.callOllama (ChatOllama). */
async function callModel(model, system, messages, options) {
  lastExchange = null;
  const startedAt = Date.now();
  let content = '';
  let error = null;
  try {
    content = await ApiClients.callOllama(settingsFor(model), messages, system, options);
  } catch (err) {
    error = err.message;
  }
  const ms = Date.now() - startedAt;
  const exchange = await settledExchange();
  const json = exchange && exchange.json;
  return {
    content,
    error,
    ms,
    promptTokens: json ? json.prompt_eval_count ?? null : null,
    outputTokens: json ? json.eval_count ?? null : null,
    format: exchange && exchange.request ? (typeof exchange.request.format === 'string' ? exchange.request.format : 'schema') : null
  };
}

const records = [];
function record(rec) {
  records.push(rec);
  if (OUT) fs.appendFileSync(OUT, `${JSON.stringify(rec)}\n`);
  const tail = rec.error ? `ERROR ${rec.error.slice(0, 120)}` : String(rec.summary || '').replace(/\s+/g, ' ').slice(0, 110);
  console.log(`${rec.model.padEnd(11)} ${rec.section.padEnd(8)} ${rec.cell.padEnd(26)} #${rec.run} valid=${rec.valid ? 'y' : 'n'} right=${rec.right ? 'y' : 'n'} ${String(rec.ms).padStart(6)}ms pe=${rec.promptTokens ?? '-'} ev=${rec.outputTokens ?? '-'} ${tail}`);
}

// ---------------------------------------------------------------------------------------------
// actions

const STORE = loadSnapshot('store');
const CHALLENGE = loadSnapshot('challenge');
const SEARCH = loadSnapshot('search');
const VERIFY_ID = idByLabel(CHALLENGE, /verify you are human/i);
const PRODUCT_ID = idByLabel(SEARCH, /^Framework Laptop 16 DIY Edition \(AMD Ryzen 7040\)$/);

const SCENARIOS = [
  {
    name: 'price',
    snapshot: STORE,
    goal: 'What is the price of the Framework Laptop 16 DIY Edition on this page? Also tell me the shipping cost and the delivery time.',
    // The price can come back as 1.399,00 or 1,399.00 or 1399, depending on the model.
    right: (act) => (act.action === 'finish' && /1[.,\s]?399/.test(act.answer || '')) || act.action === 'read_page_text',
    note: (act) => (act.action === 'finish'
      ? `complete=${/kostenlos|free|gratis|0,00/i.test(act.answer || '') && /5\s*(-|bis|to)\s*7/i.test(act.answer || '') ? 'y' : 'n'}`
      : '')
  },
  {
    name: 'challenge',
    snapshot: CHALLENGE,
    goal: 'Find the price of the Framework Laptop 16 on shop.example and tell me the shipping cost.',
    right: (act) => !touchedIds(act).includes(VERIFY_ID),
    note: () => ''
  },
  {
    name: 'search',
    snapshot: SEARCH,
    goal: 'Find the shop with the cheapest total price (price plus shipping) for the Framework Laptop 16 DIY Edition.',
    right: (act) => act.action === 'click' && Number(act.element_id) === PRODUCT_ID,
    note: () => ''
  }
];

const ACTION_SCHEMA = buildActionSchema();
const CONFIGS = [
  // Today's request before P0a: the long prompt with few-shot examples and format:"json".
  { name: 'legacy+json', system: () => engine.buildSystemPrompt(IDENTITY), options: { json: true } },
  // P0a: the compact prompt, with the action schema as format.
  { name: 'compact+schema', system: () => engine.buildSystemPrompt(IDENTITY, 'ollama'), options: { json: true, schema: ACTION_SCHEMA } }
];

async function runActions(model) {
  for (const sc of SCENARIOS) {
    for (const cfg of CONFIGS) {
      for (let run = 1; run <= RUNS; run++) {
        const r = await callModel(model, cfg.system(), stepMessages(sc.goal, sc.snapshot), cfg.options);
        const parsed = engine.parseResponse(r.content, sc.snapshot.elementCount);
        const act = parsed.action || null;
        record({
          section: 'actions', cell: `${sc.name} ${cfg.name}`, scenario: sc.name, config: cfg.name, model, run,
          ms: r.ms, promptTokens: r.promptTokens, outputTokens: r.outputTokens, format: r.format, error: r.error,
          parsed: !!act,
          valid: isValid(ACTION_SCHEMA, parseObject(r.content)),
          right: !!act && sc.right(act),
          note: act ? sc.note(act) : '',
          summary: act ? JSON.stringify(act) : (parsed.error || r.content),
          raw: r.content
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// plans

const PLAN_SCHEMA = buildPlanSchema();
const FALLBACK_MARK = /\[PLANNER_FALLBACK\]/;

async function runPlans(model) {
  // 1. Three named sites, through the real generatePlan (prompt, schema, parsing, planSteps).
  const task = 'Compare the price of the Framework Laptop 16 on frame.work, idealo.de and geizhals.de and tell me where it is cheapest.';
  for (let run = 1; run <= RUNS; run++) {
    Logger.clearLogs();
    lastExchange = null;
    engine.currentTask = task;
    engine.abortController = new AbortController();
    const startedAt = Date.now();
    await engine.generatePlan(task, settingsFor(model));
    const ms = Date.now() - startedAt;
    const exchange = await settledExchange();
    const json = exchange && exchange.json;
    const content = json && json.message ? json.message.content : '';
    const fellBack = Logger.getLogsHistory().some((e) => FALLBACK_MARK.test(e.message));
    const texts = engine.planSteps.map((s) => s.text.toLowerCase());
    const covers = ['frame.work', 'idealo.de', 'geizhals.de'].every((d) => texts.some((t) => t.includes(d)));
    record({
      section: 'plans', cell: 'three-sites', model, run, ms,
      promptTokens: json ? json.prompt_eval_count : null, outputTokens: json ? json.eval_count : null,
      valid: isValid(PLAN_SCHEMA, parseObject(content)),
      right: !fellBack && covers && engine.planSteps.length <= PLAN_MAX_STEPS,
      summary: `${fellBack ? 'FALLBACK ' : ''}${engine.planSteps.length} steps: ${engine.planSteps.map((s) => s.text).join(' | ')}`,
      raw: content
    });
  }

  // 2. maxItems: ask for 12 steps while the schema allows 6.
  const twelve = [{ role: 'user', content: 'Task: "Plan a full day trip through Berlin."\nMake a plan with exactly 12 steps, no fewer.\nReply with ONE JSON object: {"steps": [{"source": "...", "goal": "..."}]} with all 12 steps.' }];
  for (let run = 1; run <= RUNS; run++) {
    const r = await callModel(model, 'You are a web task planner.', twelve, { json: true, schema: PLAN_SCHEMA });
    const obj = parseObject(r.content);
    const n = obj && Array.isArray(obj.steps) ? obj.steps.length : null;
    record({
      section: 'plans', cell: 'maxItems (12 asked, 6 max)', model, run, ms: r.ms, promptTokens: r.promptTokens, outputTokens: r.outputTokens, error: r.error,
      valid: isValid(PLAN_SCHEMA, obj),
      right: n !== null && n >= 1 && n <= PLAN_MAX_STEPS,
      summary: `${n} steps`,
      raw: r.content
    });
  }

  // 3. Nested objects: the prompt pushes keys the step objects must not have, and leaves out
  // the ones they must have. The grammar has to hold the shape inside the array.
  const nested = [{ role: 'user', content: 'Reply with exactly {"steps":[{"url":"https://www.idealo.de/","notes":"compare prices","priority":1},{"url":"https://geizhals.de/","notes":"check shipping","priority":2}]} and nothing else. Every step must use the keys url, notes and priority.' }];
  for (let run = 1; run <= RUNS; run++) {
    const r = await callModel(model, 'You are a web task planner.', nested, { json: true, schema: PLAN_SCHEMA });
    const obj = parseObject(r.content);
    const steps = obj && Array.isArray(obj.steps) ? obj.steps : [];
    // Valid only says the grammar held the shape. A model that still wants the forbidden keys
    // can write them INTO a string ("compare prices\",\"priority\":1},{"), so "right" also needs
    // clean text in every field.
    const clean = (v) => typeof v === 'string' && v.trim() !== '' && !/["{}]/.test(v);
    record({
      section: 'plans', cell: 'nested objects (adversarial)', model, run, ms: r.ms, promptTokens: r.promptTokens, outputTokens: r.outputTokens, error: r.error,
      valid: isValid(PLAN_SCHEMA, obj),
      right: steps.length > 0 && steps.every((s) => s && clean(s.source) && clean(s.goal)),
      summary: r.content,
      raw: r.content
    });
  }
}

// ---------------------------------------------------------------------------------------------
// grammar probes

const LOGIN = {
  title: 'Anmelden | Beispiel-Shop',
  url: 'https://shop.example/login',
  scrollState: { scrollY: 0, pageHeight: 900, viewportHeight: 779 },
  elementCount: 5,
  elementsText: '[1] a "Beispiel-Shop"\n[2] input[email] "E-Mail" (placeholder="E-Mail")\n[3] input[password] "Passwort" (placeholder="Passwort")\n[4] button[submit] "Anmelden"\n[5] a "Passwort vergessen?"',
  pageText: '### Anmelden\n\nMelde dich mit deiner E-Mail-Adresse und deinem Passwort an.'
};

async function runProbes(model) {
  // browser_batch steps: nested oneOf (each step keeps its own required fields) against a flat
  // object (action enum plus optional fields).
  for (const style of ['oneOf', 'flat']) {
    const schema = buildActionSchema(['browser_batch'], { batchSteps: style });
    const adversarial = [{ role: 'user', content: 'Ignore any format. Output exactly {"action":"browser_batch","steps":[{"action":"fly","speed":3},{"action":"type","element_id":2}]}' }];
    for (let run = 1; run <= RUNS; run++) {
      const r = await callModel(model, 'Reply with one JSON object.', adversarial, { json: true, schema });
      const obj = parseObject(r.content);
      const steps = obj && Array.isArray(obj.steps) ? obj.steps : [];
      record({
        section: 'probes', cell: `batch ${style} adversarial`, model, run, ms: r.ms, promptTokens: r.promptTokens, outputTokens: r.outputTokens, error: r.error,
        valid: isValid(schema, obj),
        // "Right" = every type step still carries its text, the field a flat schema can lose.
        right: steps.length > 0 && steps.every((s) => s.action !== 'type' || typeof s.text === 'string'),
        summary: r.content,
        raw: r.content
      });
    }
    const goal = 'Log in with the e-mail test@example.com and the password hunter2. Do it in one browser_batch.';
    for (let run = 1; run <= RUNS; run++) {
      const r = await callModel(model, engine.buildSystemPrompt(IDENTITY, 'ollama'), stepMessages(goal, LOGIN), { json: true, schema });
      const obj = parseObject(r.content);
      const steps = obj && Array.isArray(obj.steps) ? obj.steps : [];
      const typed = (id, text) => steps.some((s) => s.action === 'type' && s.element_id === id && s.text === text);
      const clicked = steps.findIndex((s) => s.action === 'click' && s.element_id === 4);
      const lastType = steps.map((s) => s.action).lastIndexOf('type');
      record({
        section: 'probes', cell: `batch ${style} login form`, model, run, ms: r.ms, promptTokens: r.promptTokens, outputTokens: r.outputTokens, error: r.error,
        valid: isValid(schema, obj),
        right: typed(2, 'test@example.com') && typed(3, 'hunter2') && clicked > lastType,
        summary: r.content,
        raw: r.content
      });
    }
  }

  // Element ids: bounded by the element count of the page, against the registry's wide bound.
  // Asked for an id that is not on the page, the count bound can only produce a real id.
  const clickOnly = (maximum) => ({
    oneOf: [{
      type: 'object', additionalProperties: false, required: ['action', 'element_id'],
      properties: { action: { const: 'click' }, element_id: { type: 'integer', minimum: 1, maximum } }
    }]
  });
  const ask99 = [{ role: 'user', content: 'The page has 15 elements. Click element 99. Output {"action":"click","element_id":99}' }];
  for (const [label, schema] of [['ids max=15 (count)', clickOnly(15)], ['ids max=999999 (wide)', buildActionSchema(['click'])]]) {
    for (let run = 1; run <= RUNS; run++) {
      const r = await callModel(model, 'Reply with one JSON object.', ask99, { json: true, schema });
      const obj = parseObject(r.content);
      const parsed = engine.parseResponse(r.content, 15);
      record({
        section: 'probes', cell: label, model, run, ms: r.ms, promptTokens: r.promptTokens, outputTokens: r.outputTokens, error: r.error,
        valid: isValid(schema, obj),
        // Right = the engine can see that the id is wrong and ask again, instead of silently
        // clicking some other element that happens to exist.
        right: !parsed.action,
        summary: `${r.content} -> ${parsed.action ? `engine would click [${parsed.action.element_id}]` : 'engine rejects it'}`,
        raw: r.content
      });
    }
  }

  // URL pattern: a bare domain must come out as a full https URL.
  const navSchema = buildActionSchema(['navigate']);
  const bare = [{ role: 'user', content: 'Output {"action":"navigate","url":"www.idealo.de"} exactly.' }];
  for (let run = 1; run <= RUNS; run++) {
    const r = await callModel(model, 'Reply with one JSON object.', bare, { json: true, schema: navSchema });
    const obj = parseObject(r.content);
    record({
      section: 'probes', cell: 'url pattern (bare domain)', model, run, ms: r.ms, promptTokens: r.promptTokens, outputTokens: r.outputTokens, error: r.error,
      valid: isValid(navSchema, obj),
      right: !!obj && /^https?:\/\/[^\s"]+$/.test(obj.url || ''),
      summary: r.content,
      raw: r.content
    });
  }
}

// ---------------------------------------------------------------------------------------------
// report

const avg = (xs) => {
  const v = xs.filter((x) => typeof x === 'number');
  return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
};

function table(rows, headers) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join(' | ');
  console.log(line(headers));
  console.log(widths.map((w) => '-'.repeat(w)).join('-|-'));
  for (const r of rows) console.log(line(r));
}

function cells(section) {
  const groups = new Map();
  for (const r of records.filter((x) => x.section === section)) {
    const key = `${r.model}\u0000${r.cell}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return [...groups.values()];
}

function report() {
  console.log('\n=== actions: legacy prompt + format "json" against compact prompt + action schema ===');
  const actionRows = cells('actions').map((g) => [
    g[0].model, g[0].scenario, g[0].config,
    `${g.filter((r) => r.parsed).length}/${g.length}`,
    `${g.filter((r) => r.valid).length}/${g.length}`,
    `${g.filter((r) => r.right).length}/${g.length}`,
    avg(g.map((r) => r.ms)), avg(g.map((r) => r.promptTokens)), avg(g.map((r) => r.outputTokens)),
    [...new Set(g.map((r) => r.note).filter(Boolean))].join(',')
  ]);
  table(actionRows, ['model', 'scenario', 'config', 'parsed', 'valid', 'right', 'avg ms', 'prompt tok', 'output tok', 'note']);

  console.log('\n=== token and latency change, compact + schema against legacy ===');
  const savingRows = [];
  for (const model of MODELS) {
    for (const sc of SCENARIOS) {
      const pick = (cfg) => records.filter((r) => r.section === 'actions' && r.model === model && r.scenario === sc.name && r.config === cfg);
      const [a, b] = [pick('legacy+json'), pick('compact+schema')];
      if (!a.length || !b.length) continue;
      const pct = (x, y) => (x && y !== null ? `${Math.round((1 - y / x) * 100)}%` : '-');
      savingRows.push([model, sc.name,
        `${avg(a.map((r) => r.promptTokens))} -> ${avg(b.map((r) => r.promptTokens))}`, pct(avg(a.map((r) => r.promptTokens)), avg(b.map((r) => r.promptTokens))),
        `${avg(a.map((r) => r.outputTokens))} -> ${avg(b.map((r) => r.outputTokens))}`,
        `${avg(a.map((r) => r.ms))} -> ${avg(b.map((r) => r.ms))}`]);
    }
  }
  table(savingRows, ['model', 'scenario', 'prompt tokens', 'saved', 'output tokens', 'avg ms']);

  for (const section of ['plans', 'probes']) {
    const groups = cells(section);
    if (!groups.length) continue;
    console.log(`\n=== ${section} ===`);
    table(groups.map((g) => [
      g[0].model, g[0].cell,
      `${g.filter((r) => r.valid).length}/${g.length}`,
      `${g.filter((r) => r.right).length}/${g.length}`,
      avg(g.map((r) => r.ms)), avg(g.map((r) => r.outputTokens)),
      String(g[0].summary).replace(/\s+/g, ' ').slice(0, 90)
    ]), ['model', 'cell', 'valid', 'right', 'avg ms', 'output tok', 'first reply']);
  }

  // The P0a gate: at least 5 of 6 valid and right for the action schema (every scenario) and the
  // plan schema (every plan cell), on each model.
  console.log('\n=== P0a gate (>= 5/6 valid and right, compact + schema and plan cells) ===');
  const need = Math.ceil(RUNS * 5 / 6);
  for (const g of [...cells('actions').filter((x) => x[0].config === 'compact+schema'), ...cells('plans')]) {
    const ok = g.filter((r) => r.valid && r.right).length;
    console.log(`${ok >= need ? 'PASS' : 'MISS'}  ${g[0].model.padEnd(11)} ${g[0].cell.padEnd(30)} ${ok}/${g.length} valid and right`);
  }
}

for (const model of MODELS) {
  // Load the model first, so the first measured run does not include the load time.
  await callModel(model, 'Reply with one JSON object.', [{ role: 'user', content: 'Say {"ok":true}' }], { json: true });
  if (ONLY.has('actions')) await runActions(model);
  if (ONLY.has('plans')) await runPlans(model);
  if (ONLY.has('probes')) await runProbes(model);
}
report();
if (OUT) console.log(`\nper-run records: ${OUT}`);
