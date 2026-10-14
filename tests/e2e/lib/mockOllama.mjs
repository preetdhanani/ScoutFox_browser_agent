/**
 * An offline stand-in for Ollama, for `smoke.mjs --mock` (CI runs this: no model, no Ollama).
 *
 * It speaks what the extension calls for provider "ollama", on the same port as the real-mode
 * proxy (11435):
 *   POST /api/chat     what ChatOllama asks for (stream absent or true): NDJSON, one JSON object per line,
 *                      the reply text in two pieces {model, created_at, message, done:false} and a last line
 *                      {model, created_at, message, done:true, done_reason, ...counts}, as Ollama streams.
 *                      With stream:false, one JSON object with all of it (the old client asked for that)
 *   POST /api/show     the details of one model, as Ollama answers: details.parameter_size, capabilities,
 *                      model_info. The tier of a model (small or large) will be read from this (plan stage 2d)
 *   GET  /api/tags     the model list (the side panel asks for it when it opens)
 *   GET  /api/version
 *   OPTIONS            CORS preflight
 * A request that is not valid JSON gets HTTP 400, and a chat call the script does not know gets 501 with a
 * message that names the call (its node, its mode or its schema, and the start of its system prompt), so a
 * protocol drift is loud and not papered over.
 *
 * What it answers is what the LangGraph engine really sends (src/background/graph). Three calls exist:
 *   - plan     the orchestrator's plan call. Recognised by its schema (task_kind and sites). The user message is
 *              "Task: ...\nCurrent tab: <title> (<url>)" (buildPlanUserMessage). The reply is a plan with one
 *              site per named shop, or one site for the page the tab is on.
 *   - policy   the worker's step call, one per step. Recognised by its schema: browse (has click), extract,
 *              harvest and answer have one schema each (buildPolicySchema). The user message is the worker's
 *              prompt (buildPolicyUserMessage): the task, the current site and its goal, the columns that are
 *              needed, the current page (title, URL, text between """ marks) and the numbered element list. The
 *              call is stateless: the mock has only that message, so it answers from the page it shows.
 *   - reflect  the orchestrator's reflect call and the worker's mid-site reflect (no schema, told apart by the
 *              system prompt). The mock always says "continue".
 *
 * What the policy reply is, by what the prompt shows:
 *   - an empty page (no text and no elements): a MOCK-FAIL reply (see below), so a content script that no
 *     longer delivers the page makes the smoke fail;
 *   - a bot check ("Verifying you are human", "Ray ID", ...) in the page text or the elements: mark_blocked, with
 *     the honest reason. It never clicks the box;
 *   - a goal that asks for the cheapest offer: with an offers table in the page text it records the shop, price,
 *     shipping and the total it adds itself (record_finding); without one it clicks the link whose text best
 *     matches the product named in the goal;
 *   - a goal that asks for price, shipping or delivery: record_finding with those lines copied from the page text;
 *   - in answer mode (the schema has finish): the same facts as a finish answer;
 *   - a goal that names two shops (shop-a.test and shop-b.test): the small model of the incident that started the
 *     finish gate. On the page of the site it works on, it records the real row. On another page it copies what
 *     it sees as if it were the row of its own site ("mock-agent", the stubborn model), or says "not found" (the
 *     "mock-agent-honest" model; the request carries the model name and the mock stays stateless). In answer mode
 *     it finishes with a full row for EVERY named shop, although only one was ever opened (the price, shipping,
 *     delivery and link of the others are invented, twoSources.mjs), and when the prompt says "Your finish was
 *     refused" the stubborn model writes the same answer again and the honest one writes "not checked". These
 *     tasks are pending until the graph has the audit gate (plan stage 4b), so only the mock's self-test
 *     exercises this part today;
 *   - anything it cannot find in the prompt (no price line, a goal it does not know, ...): a reply that starts with
 *     "MOCK-FAIL:" and says what is missing. It is a finish answer in answer mode, else mark_not_found (or ask_user
 *     when the mode has neither), so the run ends without the data and no check accepts it.
 * Every reply is checked against the JSON schema the request itself carried (validateAgainst in
 * src/background/agent/schemas.ts, the validator the engine uses) before it is sent; a reply that does not fit
 * is an HTTP 500.
 *
 * This is fixture-specific by design: it understands the layout of tests/fixtures/site and the prompts of
 * src/background/agent/prompts.ts. When either changes, update parsePlanMessage() or parsePolicyMessage();
 * the self-test (mockOllama.selftest.mjs) builds the prompts with the real builders and shows what broke.
 */
import http from 'node:http';
import { validateAgainst } from '../../../src/background/agent/schemas.ts';
import { actionsOfFormat, buildCallRecord, classifyRequest, MOCK_FAIL_PREFIX } from './callRecord.mjs';
import { INVENTED, SHOP_B } from './twoSources.mjs';

export const MOCK_VERSION = '0.0.0-mock';
export { MOCK_FAIL_PREFIX };
// The model name that makes the two-sources skill give in (honest) instead of staying stubborn.
export const HONEST_MODEL_SUFFIX = '-honest';
// What /api/show and /api/tags tell about every model of the mock: a 9B model with no vision, like the real one of the README run.
export const MOCK_PARAMETER_SIZE = '9B';
export const MOCK_CAPABILITIES = ['completion', 'tools'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '600'
};

// ---------------------------------------------------------------------------------------------
// Reading the prompts
// ---------------------------------------------------------------------------------------------

/**
 * The plan call's user message (buildPlanUserMessage): "Task: <task>", then "Current tab: <title> (<url>)" when the
 * tab is known. Anything not found comes back empty.
 */
export function parsePlanMessage(text) {
  const source = String(text || '');
  const task = /^Task: (.*)$/m.exec(source)?.[1] ?? '';
  const tab = /^Current tab: (.*) \((\S*)\)$/m.exec(source);
  return { task, tabTitle: tab ? tab[1] : '', tabUrl: tab ? tab[2] : '' };
}

/**
 * The worker's policy message (buildPolicyUserMessage) as data. Anything not found comes back empty, and the skills
 * treat empty as "the page content did not reach the prompt".
 *
 *   TASK: <task>
 *   CURRENT SITE (<i> of <n>, <domain>, <role>): <goal>
 *   NEEDED: <col>, <col>
 *   FINDINGS: ... / ALREADY TRIED AND FAILED ON THIS SITE: ... / PAGE CHANGE: ...
 *   CURRENT PAGE: "<title>" - <url> (<page type>)
 *   PAGE TEXT:
 *   """
 *   <text>
 *   """
 *   ELEMENTS:
 *   [1] a "Label"
 *   CORRECTION: <text>
 *   Reply with the JSON for the next action.
 */
export function parsePolicyMessage(text) {
  const source = String(text || '');
  const task = /^TASK: (.*)$/m.exec(source)?.[1] ?? '';
  const siteLine = /^CURRENT SITE \((\d+) of (\d+), (.*?), (reference|compare|other)\): (.*)$/m.exec(source);
  const needed = (/^NEEDED: (.*)$/m.exec(source)?.[1] ?? '').split(',').map((c) => c.trim()).filter(Boolean);
  const pageLine = /^CURRENT PAGE: "(.*)" - (\S*) \(([^)]*)\)$/m.exec(source);
  const pageBlock = /\nPAGE TEXT:\n"""\n([\s\S]*?)\n"""\n\nELEMENTS:\n/.exec(source)?.[1] ?? '';
  const elementsBlock = /\n\nELEMENTS:\n([\s\S]*?)(?:\n\nCORRECTION: [\s\S]*?)?\n\nReply with the JSON for the next action\.$/.exec(source)?.[1] ?? '';
  const correction = /\n\nCORRECTION: ([\s\S]*?)\n\nReply with the JSON for the next action\.$/.exec(source)?.[1] ?? '';
  return {
    task,
    site: siteLine
      ? { index: Number(siteLine[1]), total: Number(siteLine[2]), domain: siteLine[3], role: siteLine[4], goal: siteLine[5] }
      : { index: 0, total: 0, domain: '', role: '', goal: '' },
    needed,
    title: pageLine ? pageLine[1] : '',
    url: pageLine ? pageLine[2] : '',
    pageType: pageLine ? pageLine[3] : '',
    pageText: pageBlock.trim() === '' ? '' : pageBlock,
    elements: parseElements(elementsBlock),
    correction,
    text: source
  };
}

/** `[8] a "Label"`, `[5] input[search] "Suche" (placeholder=...)`, `[13] a "Daten" [off-screen]`. */
export function parseElements(elementsText) {
  const out = [];
  for (const line of String(elementsText || '').split('\n')) {
    const m = /^\[(\d+)\]\s+([a-z0-9-]+)(?:\[([^\]]*)\])?\s+"(.*?)"(?=$|\s\(|\s\[off-screen\]$)/.exec(line);
    if (m) out.push({ id: Number(m[1]), tag: m[2], type: m[3] || '', label: m[4] });
  }
  return out;
}

function lastUserMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') return messages[i].content;
  return '';
}

// ---------------------------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------------------------

// A bot check, in the page text or in the element labels. The page title alone does not count:
// the mock has to see the challenge in the content it was given.
const CHALLENGE = /verify(?:ing)? (?:that )?you are (?:a )?human|are you a robot|captcha|ray id|review the security of your connection|checking your browser/i;

function looksLikeChallenge(page) {
  return CHALLENGE.test(page.pageText) || page.elements.some((e) => CHALLENGE.test(e.label));
}

// German amounts as the fixture shows them: "1.399,00 EUR", "9,90 EUR".
const MONEY = /(\d{1,3}(?:\.\d{3})+|\d+),(\d{2})\s*(?:EUR|€)/;
const MONEY_LINE = new RegExp(`^\\s*${MONEY.source}\\s*$`);
const FREE_SHIPPING = /^(?:versandkostenfrei|kostenloser versand|kostenlos|gratis|free shipping)$/i;

const moneyToCents = (m) => Number(m[1].replace(/\./g, '')) * 100 + Number(m[2]);
const centsOfLine = (line) => {
  const m = MONEY_LINE.exec(line || '');
  return m ? moneyToCents(m) : null;
};
function formatEuro(cents) {
  const euros = String(Math.floor(cents / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${euros},${String(cents % 100).padStart(2, '0')} EUR`;
}

// A line of the page text, or a cell of a table row (the extractor writes the cells of a row as "a | b | c").
const pageLines = (pageText) => pageText.split('\n').flatMap((l) => l.split(' | ')).map((l) => l.replace(/^#+\s*/, '').trim()).filter(Boolean);
const trimEnd = (l) => l.replace(/[.\s]+$/, '');

/**
 * Offer rows in the page text of an offers table: shop, price, shipping (an amount or a "free
 * shipping" word), total. The total the page lists is ignored; the mock adds price and shipping.
 * The *Text members are the lines as the page writes them.
 */
export function parseOffers(pageText) {
  const lines = pageLines(pageText);
  const offers = [];
  for (let i = 1; i + 2 < lines.length; i++) {
    const price = centsOfLine(lines[i]);
    if (price === null || centsOfLine(lines[i - 1]) !== null) continue;
    const shipping = FREE_SHIPPING.test(lines[i + 1]) ? 0 : centsOfLine(lines[i + 1]);
    if (shipping === null || centsOfLine(lines[i + 2]) === null) continue;
    offers.push({ shop: lines[i - 1], priceCents: price, shippingCents: shipping, totalCents: price + shipping, priceText: lines[i], shippingText: lines[i + 1] });
  }
  return offers;
}

const words = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);

function longestCommonRun(a, b) {
  let best = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      let k = 0;
      while (i + k < a.length && j + k < b.length && a[i + k] === b[j + k]) k++;
      if (k > best) best = k;
    }
  }
  return best;
}

/**
 * The link whose text shares the longest run of words with the goal: for "...for the Framework
 * Laptop 16 DIY Edition" that is the link with that exact product name, and not the Laptop 13,
 * the graphics module or the charger, which only share the first words. At least 3 words.
 */
export function findProductLink(goal, elements) {
  const goalWords = words(goal);
  let best = null;
  for (const e of elements) {
    if (e.tag !== 'a') continue;
    const run = longestCommonRun(goalWords, words(e.label));
    if (run >= 3 && (!best || run > best.run)) best = { id: e.id, label: e.label, run };
  }
  return best;
}

// The shops of the fixture world a goal can name: "shop-a.test", "shop-b.test".
const SHOP_NAME = /\b[a-z0-9][a-z0-9-]*\.test\b/gi;
export const namedShops = (goal) => [...new Set(String(goal || '').match(SHOP_NAME)?.map((h) => h.toLowerCase()) ?? [])];

export function kindOfGoal(goal) {
  if (namedShops(goal).length >= 2) return 'sources';
  if (/\b(cheapest|lowest|least expensive|best price)\b/i.test(goal)) return 'cheapest';
  // Before the facts kind: a disclosure goal names the shipping disclosure, and "shipping" alone
  // would read as a price-and-shipping goal whose facts the closed disclosure does not show yet.
  if (/\bdisclosure\b/i.test(goal)) return 'disclosure';
  if (/\b(price|cost|shipping|delivery|preis|versand|lieferung)\b/i.test(goal)) return 'facts';
  return 'unknown';
}

function hostnameOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

const finish = (answer, reason) => ({ action: 'finish', answer, reason });

/**
 * The reply of a mock that could not find what it needs in the prompt. It carries the MOCK-FAIL prefix, in a verb the mode
 * allows: the answer of a finish, or the reason of mark_not_found, or (the last resort, every mode has it) a question.
 */
function mockFail(verbs, why) {
  const text = `${MOCK_FAIL_PREFIX} ${why}`;
  if (verbs.has('finish')) return finish(text, 'The prompt did not contain what this task needs.');
  if (verbs.has('mark_not_found')) return { action: 'mark_not_found', reason: text };
  return { action: 'ask_user', question: text, reason: 'The prompt did not contain what this task needs.' };
}

// ---- the facts of a page -----------------------------------------------------------------------

/** The price, shipping and delivery lines of a shop page, as the page writes them (the trailing full stop cut off). A missing line is null. */
function shopFacts(pageText) {
  const lines = pageLines(pageText);
  const find = (re) => lines.find((l) => re.test(l));
  const price = find(MONEY);
  const shipping = find(/versand|shipping/i);
  const delivery = find(/lieferung|lieferzeit|delivery/i);
  return { price: price ? trimEnd(price) : null, shipping: shipping ? trimEnd(shipping) : null, delivery: delivery ? trimEnd(delivery) : null };
}

/** The columns of the record_finding branch of a policy schema, in schema order. */
function recordFindingColumns(format) {
  const branch = (format?.oneOf || []).find((b) => b?.properties?.action?.const === 'record_finding');
  return branch ? Object.keys(branch.properties).filter((key) => key !== 'action') : [];
}

const COLUMN_KINDS = [
  ['shop', /^(shop|store|seller|merchant|retailer|site)$/],
  ['total', /^(total|total_price|gesamt|gesamtpreis)$/],
  ['price', /^(price|preis|cost|kosten)$/],
  ['shipping', /^(shipping|versand|shipping_cost|versandkosten)$/],
  ['delivery', /^(delivery|lieferung|lieferzeit|delivery_time)$/]
];
const kindOfColumn = (name) => COLUMN_KINDS.find(([, re]) => re.test(String(name).toLowerCase()))?.[0] ?? null;

/**
 * record_finding for `columns`: every column the mock knows gets the value `facts` has for it, copied as the page
 * writes it; a column it does not know gets "not shown", which the engine does not record. Missing facts are
 * reported, never made up.
 */
function recordFinding(columns, facts) {
  const values = {};
  const missing = [];
  for (const column of columns) {
    const kind = kindOfColumn(column);
    if (kind === null) { values[column] = 'not shown'; continue; }
    if (facts[kind]) values[column] = facts[kind];
    else missing.push(column);
  }
  return { values, missing };
}

function recordFindingReply(columns, facts, what) {
  const { values, missing } = recordFinding(columns, facts);
  if (missing.length) return { missing };
  return { reply: { action: 'record_finding', ...values }, note: `record_finding ${Object.keys(values).join(', ')}: ${what}` };
}

// ---- cheapest offer ----------------------------------------------------------------------------

function cheapestOfOffers(offers) {
  const sorted = [...offers].sort((a, b) => a.totalCents - b.totalCents);
  return { best: sorted[0], others: sorted.slice(1) };
}

const sumText = (o) => `${formatEuro(o.priceCents)} + ${o.shippingCents ? `${formatEuro(o.shippingCents)} shipping` : 'free shipping'} = ${formatEuro(o.totalCents)}`;

/** The finish answer of the cheapest-offer goal (answer mode), from an offers table. */
function cheapestAnswer(offers) {
  const { best, others } = cheapestOfOffers(offers);
  return finish(
    `The cheapest total is at ${best.shop}: ${sumText(best)}. The other offers cost more: ${others.map((o) => `${o.shop} ${sumText(o)}`).join('; ')}.`,
    'I added price and shipping for every offer in the table.'
  );
}

/** The finish answer of a price, shipping and delivery goal (answer mode), copied from the page text. */
function factsAnswer(goal, pageText) {
  const found = shopFacts(pageText);
  // "shipping cost" and "delivery cost" ask for the shipping, not for the price.
  const withoutShippingCost = goal.replace(/\b(?:shipping|delivery|versand)\s+(?:cost|costs|price|fee|fees)\b/gi, ' ');
  const wants = {
    price: /\b(price|cost|preis)\b/i.test(withoutShippingCost),
    shipping: /\b(shipping|versand)\b|\bdelivery\s+(?:cost|costs|price|fee|fees)\b/i.test(goal),
    delivery: /\b(delivery|lieferung|lieferzeit)\b/i.test(withoutShippingCost)
  };
  const missing = Object.keys(wants).filter((k) => wants[k] && !found[k]);
  if (missing.length) return { missing };
  const parts = Object.keys(wants).filter((k) => wants[k]).map((k) => `${k} "${found[k]}"`);
  return { reply: finish(`The page text says: ${parts.join('; ')}.`, 'The page text shows what the goal asks for.') };
}

// ---------------------------------------------------------------------------------------------
// Two sources: the small model of the incident
// ---------------------------------------------------------------------------------------------

// What the engine writes when the finish gate refuses a finish (formatSendBack in answerAudit.ts, and the
// fallback text of that function): the refusal reaches the next prompt of the policy.
const FINISH_REFUSED = /Your finish was refused/;

const factsOf = (host, row, link) => [`### ${host}`, `- **Price**: ${row.price}`, `- **Shipping**: ${row.shipping}`, `- **Delivery**: ${row.delivery}`, `- **URL**: ${link}`].join('\n');
const tableRow = (host, row) => `| ${host} | ${row.price} | ${row.shipping} | ${row.delivery} |`;

/** A full row for every named shop. Only `here` was read: the row of any other shop is made up. */
function answerWithInventedRow(here, hereUrl, row, others) {
  const invented = { price: INVENTED.price, shipping: INVENTED.shipping, delivery: INVENTED.delivery };
  return [
    '## Prices found', '',
    factsOf(here, row, hereUrl),
    ...others.flatMap((host) => ['', factsOf(host, invented, INVENTED.url)]),
    '',
    '| Source | Price | Shipping | Delivery |', '|--------|-------|----------|----------|',
    tableRow(here, row),
    ...others.map((host) => tableRow(host, invented))
  ].join('\n');
}

/** The real row of the shop that was read, and "not checked" for the others, with no numbers. */
function answerNotChecked(here, hereUrl, row, others) {
  return [
    '## Prices found', '',
    factsOf(here, row, hereUrl),
    ...others.flatMap((host) => ['', `### ${host}`, `Not checked. I did not open ${host}, so I have no price, shipping or delivery for it.`])
  ].join('\n');
}

/**
 * The goal names several shops. In a step on a page (browse, extract, harvest) the model records what the page
 * shows: the real row when the page is the site it works on, and, on any other page, a copy of what it sees as
 * if it were the row of its own site (the stubborn model) or "not found" (the honest one). In answer mode it
 * finishes at once with a row for every shop in the goal. When the prompt says the engine refused that finish,
 * the model name decides (see the header). Returns { reply, note } or { missing }.
 */
function twoSources(page, verbs, columns, model) {
  const shops = namedShops(page.task);
  const here = hostnameOf(page.url);
  const siteDomain = page.site.domain.toLowerCase().replace(/^www\./, '');
  const facts = shopFacts(page.pageText);

  if (verbs.has('finish')) {
    if (!shops.includes(here)) return { reply: mockFail(verbs, `the tab is on "${here || page.url || 'no URL in the prompt'}", which is not one of the shops the goal names (${shops.join(', ')}).`), note: 'two sources: not on a named shop' };
    if (!facts.price || !facts.shipping || !facts.delivery) return { missing: ['price', 'shipping', 'delivery'].filter((k) => !facts[k]) };
    const others = shops.filter((h) => h !== here);
    if (others.some((h) => h !== SHOP_B)) return { reply: mockFail(verbs, `the mock has no invented row for ${others.filter((h) => h !== SHOP_B).join(', ')}.`), note: 'two sources: unknown shop' };
    const row = { price: facts.price.match(MONEY)?.[0] ?? facts.price, shipping: facts.shipping.match(MONEY)?.[0] ?? facts.shipping, delivery: facts.delivery };
    const refused = FINISH_REFUSED.test(page.text);
    if (refused && model.endsWith(HONEST_MODEL_SUFFIX)) {
      return { reply: finish(answerNotChecked(here, page.url, row, others), 'The engine said I never opened the other shop, so I say that.'), note: `refused: gives in, "not checked" for ${others.join(', ')}` };
    }
    return {
      reply: finish(answerWithInventedRow(here, page.url, row, others), 'I have the price of every shop, so I can answer.'),
      note: refused ? `refused: repeats the same answer (invented row for ${others.join(', ')})` : `finish at once: invented row for ${others.join(', ')}, never opened`
    };
  }

  if (here === siteDomain || here.endsWith(`.${siteDomain}`)) {
    return recordFindingReply(columns, facts, `the real row of ${siteDomain}, read on its own page`);
  }
  if (model.endsWith(HONEST_MODEL_SUFFIX) || !facts.price) {
    return { reply: { action: 'mark_not_found', reason: `The tab is on ${here || 'another page'}, not on ${siteDomain}, so I have nothing to record for ${siteDomain}.` }, note: `two sources: the page is not ${siteDomain}, not found` };
  }
  return recordFindingReply(columns, facts, `copied from ${here || 'the page'} for ${siteDomain} (the stubborn model)`);
}

// ---------------------------------------------------------------------------------------------
// Deciding a reply
// ---------------------------------------------------------------------------------------------

const NO_CHECK = { type: 'none', value: '' };
const REQUIRE_ALL = 'all_required';

function planSite({ domain, url = '', goal, role, kind, fields }) {
  return { domain, url, goal, role, kind, difficulty: 1, required_fields: fields, done_when: REQUIRE_ALL, check: NO_CHECK };
}

/** The plan reply: one research site for the page the tab is on, or one per shop the goal names. */
function planFor(message) {
  const { task, tabUrl } = parsePlanMessage(message);
  const tabHost = hostnameOf(tabUrl);
  const kind = kindOfGoal(task);
  const base = { task_kind: 'research', search_query: 'Framework Laptop 16', compare: { reference_domain: '', field: '', threshold_pct: 0 } };
  if (kind === 'sources') {
    const columns = ['price', 'shipping', 'delivery'];
    return { ...base, columns, sites: namedShops(task).map((host, i) => planSite({
      domain: host,
      // The first shop is the page the tab is on. The others have to be opened.
      url: host === tabHost ? '' : `https://www.${host}/`,
      goal: 'Find the price, shipping and delivery of the Framework Laptop 16 DIY Edition',
      role: i === 0 ? 'reference' : 'compare',
      kind: 'store',
      fields: columns
    })) };
  }
  if (kind === 'cheapest') {
    const columns = ['shop', 'price', 'shipping', 'total'];
    return { ...base, columns, sites: [planSite({ domain: tabHost, goal: 'Open the offers page of the product and note the offer with the lowest total of price and shipping', role: 'reference', kind: 'listing', fields: columns })] };
  }
  if (kind === 'disclosure') {
    const columns = ['value'];
    return { ...base, columns, sites: [planSite({ domain: tabHost, goal: 'Open the shipping and returns disclosure and read the return window', role: 'reference', kind: 'page', fields: columns })] };
  }
  const columns = kind === 'facts' ? ['price', 'shipping', 'delivery'] : ['value'];
  return { ...base, columns, sites: [planSite({
    domain: tabHost,
    goal: kind === 'facts' ? 'Read the price, shipping cost and delivery time of the product on this page' : 'Read the current page',
    role: 'reference',
    kind: kind === 'facts' ? 'store' : 'page',
    fields: columns
  })] };
}

/**
 * The policy reply for one step. Returns { reply, note }. `format` is the schema of the request: the verbs the mode offers
 * and the columns of its record_finding branch are read from it, so the reply fits the mode by construction.
 */
function policyFor(request) {
  const verbs = new Set(actionsOfFormat(request.format));
  const page = parsePolicyMessage(lastUserMessage(request.messages));
  const columns = recordFindingColumns(request.format);
  const model = String(request.model || '');
  const kind = kindOfGoal(page.task);

  const failed = (why, note) => ({ reply: mockFail(verbs, why), note: `${note} (MOCK-FAIL)` });
  const withMissing = (got, what) => (got.missing
    ? failed(`the prompt has no ${got.missing.join(', ')} for ${what}.`, 'nothing to copy from the page text')
    : got);

  if (!page.pageText.trim() && page.elements.length === 0) {
    return failed('the prompt has no page text and no interactive elements. If the prompt layout changed, update parsePolicyMessage() in tests/e2e/lib/mockOllama.mjs.', 'no page content in the prompt');
  }
  if (looksLikeChallenge(page)) {
    const reason = 'The page is a bot check ("Verify you are human"). I do not click it, so I cannot read this site.';
    const verb = verbs.has('mark_blocked') ? 'mark_blocked' : 'mark_not_found';
    return { reply: { action: verb, reason }, note: `bot check: ${verb}, never clicked` };
  }

  if (kind === 'sources') return withMissing(twoSources(page, verbs, columns, model), 'the two-sources goal');

  if (kind === 'disclosure') {
    // The return window sits inside the disclosure: while it is closed the page text does not have
    // it, so the mock clicks the summary element open; once the fact is in the page text it hands
    // it over in whatever verb the mode offers.
    const fact = pageLines(page.pageText).find((l) => /returns are accepted within/i.test(l));
    if (!fact) {
      const summary = page.elements.find((e) => /shipping and returns/i.test(e.label));
      if (!summary || !verbs.has('click')) {
        return failed('the prompt has no "Shipping and returns" element to click and no return window in the page text.', 'disclosure: nothing to open');
      }
      return { reply: { action: 'click', element_id: summary.id, reason: `Element [${summary.id}] "${summary.label}" opens the disclosure the goal asks about.` }, note: 'disclosure: click the summary open' };
    }
    if (verbs.has('record_finding')) return { reply: { action: 'record_finding', value: fact }, note: 'disclosure: record the return window' };
    if (verbs.has('finish')) return { reply: finish(`The page says: ${fact}`, 'The return window was inside the opened disclosure.'), note: 'disclosure: finish with the return window' };
    return failed('this mode has neither record_finding nor finish, so the return window cannot be handed over.', 'disclosure: no verb for the fact');
  }

  if (kind === 'cheapest') {
    const offers = parseOffers(page.pageText);
    if (offers.length >= 2) {
      if (verbs.has('finish')) return { reply: cheapestAnswer(offers), note: 'cheapest offer: answer from the offers table' };
      const { best } = cheapestOfOffers(offers);
      return withMissing(recordFindingReply(columns, {
        shop: best.shop, price: best.priceText, shipping: best.shippingText, total: formatEuro(best.totalCents)
      }, `the cheapest offer, ${best.shop}`), 'the cheapest offer');
    }
    const link = verbs.has('click') ? findProductLink(page.task, page.elements) : null;
    if (!link) return failed('the prompt has no offers table and no link that matches the product in the goal.', 'cheapest offer: nothing to do');
    return { reply: { action: 'click', element_id: link.id, reason: `Link [${link.id}] "${link.label}" is the product named in the goal; its page should list the offers.` }, note: `cheapest offer: click [${link.id}]` };
  }

  if (kind === 'facts') {
    if (verbs.has('finish')) return withMissing(factsAnswer(page.task, page.pageText), 'the goal');
    return withMissing(recordFindingReply(columns, shopFacts(page.pageText), 'copied from the page text'), 'the goal');
  }
  return failed(`I do not know this goal: "${page.task.slice(0, 80)}".`, 'unknown goal');
}

const REFLECT_REPLY = { decision: 'continue', reason: 'The plan is fine as it is.', changes: '' };

/**
 * A short description of a chat call that has no script, for the 501 message: what it is and what it starts with.
 */
function describeUnknownCall(request) {
  const system = (request.messages.find((m) => m.role === 'system') || {}).content || '';
  const format = request.format === undefined ? 'no format' : typeof request.format === 'string' ? `format "${request.format}"` : `a schema with ${Array.isArray(request.format.oneOf) ? `oneOf of ${actionsOfFormat(request.format).join('/') || '?'}` : `properties ${Object.keys(request.format.properties || {}).join(',') || '?'}`}`;
  return `${format}, ${request.messages.length} message(s), system prompt "${system.slice(0, 70).replace(/\s+/g, ' ')}"`;
}

/**
 * The scripted reply to one request.
 *
 * @param {{model?: string, messages: {role: string, content: string}[], format?: unknown}} request
 * @returns {{node: string, mode: string, reply: object|string, note: string} | {error: {status: number, message: string}}}
 */
export function decide(request) {
  const { node, mode } = classifyRequest(request);
  if (node === 'plan' && mode === 'initial') {
    return { node, mode, reply: planFor(lastUserMessage(request.messages)), note: 'plan' };
  }
  if (node === 'policy') {
    const { reply, note } = policyFor(request);
    return { node, mode, reply, note };
  }
  if (node === 'reflect' && mode === 'initial') {
    return { node, mode, reply: REFLECT_REPLY, note: 'reflect: continue' };
  }
  if (node === 'reflect' && mode === 'mid_site') {
    return { node, mode, reply: 'The approach is working. Keep going with the same plan.', note: 'mid-site reflect: keep going' };
  }
  const what = node === 'plan' ? 'a plan call with the revise schema (the engine does not send it yet)' : 'a call that the graph engine does not send';
  return { error: { status: 501, message: `mock: no script for ${what}: ${describeUnknownCall(request)}. The mock speaks the LangGraph protocol (plan, policy per mode, reflect). If the engine changed, extend tests/e2e/lib/mockOllama.mjs.` } };
}

// ---------------------------------------------------------------------------------------------
// The HTTP server
// ---------------------------------------------------------------------------------------------

function tagOf(name) {
  const isLarge = /70b|large/i.test(name);
  const paramSize = isLarge ? '70B' : MOCK_PARAMETER_SIZE;
  return {
    name,
    model: name,
    modified_at: '2026-01-01T00:00:00Z',
    size: 1,
    digest: '0'.repeat(64),
    details: { parent_model: '', format: 'gguf', family: 'mock', families: ['mock'], parameter_size: paramSize, quantization_level: 'Q4_K_M' }
  };
}

/** What POST /api/show answers for a model: the tag details plus model_info and the capabilities. */
function showOf(name) {
  const isLarge = /70b|large/i.test(name);
  const paramCount = isLarge ? 70_000_000_000 : 9_000_000_000;
  return {
    license: 'mock',
    modelfile: `# Modelfile generated by "ollama show"\nFROM ${name}`,
    parameters: 'num_ctx 8192',
    template: '{{ .Prompt }}',
    details: tagOf(name).details,
    model_info: { 'general.architecture': 'mock', 'general.parameter_count': paramCount, 'mock.context_length': 32768 },
    capabilities: [...MOCK_CAPABILITIES],
    modified_at: '2026-01-01T00:00:00Z'
  };
}

/**
 * The streamed form of a reply: the text in two pieces, then a last line with everything else. A client that
 * joins the pieces (ChatOllama does) sees the same text as one that reads the single object.
 */
export function toNdjson(reply) {
  const { message, ...rest } = reply;
  const cut = Math.ceil(message.content.length / 2);
  const piece = (content) => JSON.stringify({ model: reply.model, created_at: reply.created_at, message: { role: message.role, content }, done: false });
  return `${[piece(message.content.slice(0, cut)), piece(message.content.slice(cut)), JSON.stringify({ ...rest, message: { role: message.role, content: '' } })].join('\n')}\n`;
}

/**
 * Same return shape as startOllamaProxy: { server, calls, url }.
 *
 * @param {object} [options]
 * @param {string} [options.host]
 * @param {number} [options.port]   0 picks a free port (the self-test does that)
 * @param {string[]} [options.models] names listed by /api/tags and known to /api/show
 * @param {(call: object) => void} [options.onCall]
 */
export function startMockOllama({ host = '127.0.0.1', port = 11435, models = ['mock-agent'], onCall = () => {} } = {}) {
  const calls = [];
  // The same request again and again is a run that loops (no state change reaches the model). The count is only
  // kept for the record of the call and for the harness to see it: the reply itself never depends on it.
  let lastRequest = '';
  let repeat = 0;

  const send = (res, status, body, headers = {}) => {
    const isText = typeof body === 'string';
    res.writeHead(status, {
      'Content-Type': isText ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
      ...CORS,
      ...headers
    });
    res.end(body === undefined ? undefined : isText ? body : JSON.stringify(body));
  };

  const chat = (res, raw, startedAt) => {
    let sent = {};
    let status = 200;
    let body;
    const reject = (code, message) => { status = code; body = { error: message }; };

    try {
      sent = JSON.parse(raw.toString('utf8'));
    } catch (err) {
      reject(400, `invalid JSON in the request body: ${err.message}`);
    }
    if (!body) {
      if (!sent || typeof sent !== 'object' || Array.isArray(sent)) {
        reject(400, 'the request body must be a JSON object');
      } else if (typeof sent.model !== 'string' || !sent.model) {
        reject(400, 'model is required');
      } else if (!Array.isArray(sent.messages) || sent.messages.length === 0
        || sent.messages.some((m) => !m || typeof m.role !== 'string' || typeof m.content !== 'string')) {
        reject(400, 'messages must be a non-empty array of {role, content} with string content');
      }
    }

    let note = '';
    if (!body) {
      const key = JSON.stringify([sent.model, sent.messages]);
      repeat = key === lastRequest ? repeat + 1 : 0;
      lastRequest = key;

      const decision = decide(sent);
      if (decision.error) {
        reject(decision.error.status, decision.error.message);
      } else {
        // The reply has to fit the schema the request carried, as Ollama's grammar would force. A request with no schema
        // (the reflect calls) takes any text.
        const { ok, errors } = sent.format && typeof sent.format === 'object' ? validateAgainst(sent.format, decision.reply) : { ok: true, errors: [] };
        if (!ok) {
          reject(500, `mock bug: the scripted reply does not fit the request's schema: ${errors.slice(0, 5).join('; ')}`);
        } else {
          note = decision.note;
          const content = typeof decision.reply === 'string' ? decision.reply : JSON.stringify(decision.reply);
          const promptChars = sent.messages.reduce((sum, m) => sum + m.content.length, 0);
          const promptTokens = Math.max(1, Math.ceil(promptChars / 4));
          const outputTokens = Math.max(1, Math.ceil(content.length / 4));
          body = {
            model: sent.model,
            created_at: new Date().toISOString(),
            message: { role: 'assistant', content },
            done: true,
            done_reason: 'stop',
            total_duration: 1_000_000,
            load_duration: 100_000,
            prompt_eval_count: promptTokens,
            prompt_eval_duration: 400_000,
            eval_count: outputTokens,
            eval_duration: 500_000
          };
        }
      }
    }

    // Ollama streams unless the request says stream:false. An error is one JSON object either way.
    const streaming = status === 200 && sent.stream !== false;
    const responseText = streaming ? toNdjson(body) : JSON.stringify(body);
    const call = buildCallRecord({
      n: calls.length + 1,
      status,
      ms: Date.now() - startedAt,
      requestBytes: raw.length,
      responseBytes: Buffer.byteLength(responseText),
      sent: sent && typeof sent === 'object' ? sent : {},
      got: body
    });
    if (note) call.note = note;
    call.repeat = repeat;
    calls.push(call);
    onCall(call);
    send(res, status, responseText, { 'Content-Type': streaming ? 'application/x-ndjson' : 'application/json; charset=utf-8' });
  };

  /** POST /api/show: {model} (or {name}, the old field) -> the details of a model the mock lists. */
  const show = (res, raw) => {
    let asked;
    try {
      asked = JSON.parse(raw.toString('utf8'));
    } catch (err) {
      return send(res, 400, { error: `invalid JSON in the request body: ${err.message}` });
    }
    const name = asked && typeof asked === 'object' ? asked.model || asked.name : undefined;
    if (typeof name !== 'string' || !name) return send(res, 400, { error: 'model is required' });
    if (!models.includes(name)) return send(res, 404, { error: `model '${name}' not found` });
    return send(res, 200, showOf(name));
  };

  const server = http.createServer(async (req, res) => {
    try {
      const startedAt = Date.now();
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks);
      const pathname = new URL(req.url, 'http://mock').pathname.replace(/\/+$/, '') || '/';

      if (req.method === 'OPTIONS') return send(res, 204, undefined);
      if (req.method === 'GET' && pathname === '/') return send(res, 200, 'Ollama is running (mock)');
      if (req.method === 'GET' && pathname === '/api/version') return send(res, 200, { version: MOCK_VERSION });
      if (req.method === 'GET' && pathname === '/api/tags') return send(res, 200, { models: models.map(tagOf) });
      if (req.method === 'POST' && pathname === '/api/show') return show(res, raw);
      if (req.method === 'POST' && pathname === '/api/chat') return chat(res, raw, startedAt);
      return send(res, 404, { error: `mock: no route for ${req.method} ${pathname}` });
    } catch (err) {
      // A bug in the mock must show up as a failed call, not take the whole run down with it.
      if (!res.headersSent) send(res, 500, { error: `mock bug: ${err && err.stack ? err.stack : err}` });
      else res.end();
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve({ server, calls, url: `http://${host}:${server.address().port}` }));
  });
}
