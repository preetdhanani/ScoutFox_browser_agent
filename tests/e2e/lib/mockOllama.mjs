/**
 * An offline stand-in for Ollama, for `smoke.mjs --mock` (CI runs this: no model, no Ollama).
 *
 * It speaks what the extension calls for provider "ollama", on the same port as the real-mode
 * proxy (11435):
 *   POST /api/chat     what ChatOllama asks for (stream absent or true): NDJSON, one JSON object per line,
 *                      the reply text in two pieces {model, created_at, message, done:false} and a last line
 *                      {model, created_at, message, done:true, done_reason, ...counts}, as Ollama streams.
 *                      With stream:false, one JSON object with all of it (the old client asked for that)
 *   GET  /api/tags     the model list (the side panel asks for it when it opens)
 *   GET  /api/version
 *   OPTIONS            CORS preflight
 * A request that is not valid JSON gets HTTP 400, and a call the script does not know gets 501,
 * so a bug shows up in the smoke run instead of being papered over.
 *
 * It is a tiny scripted agent, not a canned answer. Every reply is worked out from the request
 * alone (so it is stateless and deterministic):
 *   - The plan call is recognised by its `format` schema (an object with `steps`). The plan
 *     depends on what the task asks for.
 *   - An action call is recognised by the `oneOf` schema. The mock reads the LAST user message,
 *     which is the engine's step message: the page title, the page text between """ marks and
 *     the numbered element list. It answers ONLY from what it finds there, and from the goal.
 *   - Its earlier replies are read back from the assistant messages, which is how it knows it
 *     has already waited or clicked.
 * What it does, by what the prompt shows:
 *   - a bot check ("Verifying you are human", "Ray ID", ...) in the page text or the elements:
 *     wait once, then finish honestly that the site blocked it. It never clicks the box.
 *   - a goal that asks for the cheapest offer: with an offers table in the page text it adds
 *     price and shipping itself and names the cheapest shop; without one it clicks the link
 *     whose text best matches the product named in the goal.
 *   - a goal that asks for price, shipping or delivery: it copies those lines from the page text
 *     into the answer.
 *   - anything it cannot find in the prompt (empty page text, no elements, no offers, no price
 *     line, a goal it does not know): a finish whose answer starts with "MOCK-FAIL:" and says
 *     what is missing. That answer is wrong on purpose, so a content script or a perception step
 *     that no longer delivers the page makes the smoke fail.
 * Every reply is checked against the JSON schema the request itself carried (validateAgainst in
 * src/background/agent/schemas.ts, the validator the engine uses) before it is sent; a reply that
 * does not fit is an HTTP 500.
 *
 * This is fixture-specific by design: it understands the layout of tests/fixtures/site and the
 * step message of background/agentEngine.js (buildStepMessage). When either changes, update
 * parseStepMessage() or the skills below; the self-test (mockOllama.selftest.mjs) shows what broke.
 */
import http from 'node:http';
import { validateAgainst } from '../../../src/background/agent/schemas.ts';
import { buildCallRecord } from './callRecord.mjs';

export const MOCK_VERSION = '0.0.0-mock';
export const MOCK_FAIL_PREFIX = 'MOCK-FAIL:';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '600'
};

// ---------------------------------------------------------------------------------------------
// Reading the prompt
// ---------------------------------------------------------------------------------------------

/**
 * The engine's step message (buildStepMessage) as data. Anything not found comes back empty, and
 * the skills treat empty as "the page content did not reach the prompt".
 */
export function parseStepMessage(text) {
  const source = String(text || '');
  const title = /^Current Page Title: "(.*)"$/m.exec(source)?.[1] ?? '';
  const url = /^Current URL: (.*)$/m.exec(source)?.[1] ?? '';
  const pageBlock = /Webpage Visible Text Content[^\n]*\n"""\n([\s\S]*?)\n"""\n\nInteractive Elements on Page:\n/.exec(source)?.[1] ?? '';
  const elementsBlock = /Interactive Elements on Page:\n([\s\S]*?)\n\nChoose your next action based on the goal: /.exec(source)?.[1] ?? '';
  const goal = /^Choose your next action based on the goal: "(.*)"$/m.exec(source)?.[1] ?? '';
  // The engine writes these placeholders when the content script found nothing.
  const pageText = /^\(No visible text extracted\)$/.test(pageBlock.trim()) ? '' : pageBlock;
  const elements = /^\(No interactive elements detected\)$/.test(elementsBlock.trim()) ? [] : parseElements(elementsBlock);
  return { title, url, pageText, elements, goal };
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

/** The actions this mock sent earlier, read back from the assistant messages of the request. */
function priorActions(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    try {
      const parsed = JSON.parse(m.content);
      if (parsed && typeof parsed.action === 'string') out.push(parsed);
    } catch { /* not one of ours */ }
  }
  return out;
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

const pageLines = (pageText) => pageText.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).filter(Boolean);

/**
 * Offer rows in the page text of an offers table: shop, price, shipping (an amount or a "free
 * shipping" word), total. The total the page lists is ignored; the mock adds price and shipping.
 */
export function parseOffers(pageText) {
  const lines = pageLines(pageText);
  const offers = [];
  for (let i = 1; i + 2 < lines.length; i++) {
    const price = centsOfLine(lines[i]);
    if (price === null || centsOfLine(lines[i - 1]) !== null) continue;
    const shipping = FREE_SHIPPING.test(lines[i + 1]) ? 0 : centsOfLine(lines[i + 1]);
    if (shipping === null || centsOfLine(lines[i + 2]) === null) continue;
    offers.push({ shop: lines[i - 1], priceCents: price, shippingCents: shipping, totalCents: price + shipping });
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

function kindOfGoal(goal) {
  if (/\b(cheapest|lowest|least expensive|best price)\b/i.test(goal)) return 'cheapest';
  if (/\b(price|cost|shipping|delivery|preis|versand|lieferung)\b/i.test(goal)) return 'facts';
  return 'unknown';
}

const finish = (answer, reason) => ({ action: 'finish', answer, reason });
const fail = (why) => finish(`${MOCK_FAIL_PREFIX} ${why}`, 'The prompt did not contain what this task needs.');

const BLOCKED_ANSWER = 'The site blocked me with a bot check (a "Verify you are human" box from Cloudflare) instead of showing the shop page. I did not click the box, so I cannot read the price or the shipping cost from this page.';

function answerFacts(goal, page) {
  const lines = pageLines(page.pageText);
  const find = (re) => lines.find((l) => re.test(l));
  const trim = (l) => l.replace(/[.\s]+$/, '');
  // "shipping cost" and "delivery cost" ask for the shipping, not for the price.
  const withoutShippingCost = goal.replace(/\b(?:shipping|delivery|versand)\s+(?:cost|costs|price|fee|fees)\b/gi, ' ');
  const wants = {
    price: /\b(price|cost|preis)\b/i.test(withoutShippingCost),
    shipping: /\b(shipping|versand)\b|\bdelivery\s+(?:cost|costs|price|fee|fees)\b/i.test(goal),
    delivery: /\b(delivery|lieferung|lieferzeit)\b/i.test(withoutShippingCost)
  };
  const found = {
    price: find(MONEY),
    shipping: find(/versand|shipping/i),
    delivery: find(/lieferung|lieferzeit|delivery/i)
  };
  const missing = Object.keys(wants).filter((k) => wants[k] && !found[k]);
  if (missing.length) return fail(`the page text in the prompt has no line for: ${missing.join(', ')}.`);
  const parts = Object.keys(wants).filter((k) => wants[k]).map((k) => `${k} "${trim(found[k])}"`);
  return finish(`The page text says: ${parts.join('; ')}.`, 'The page text shows what the goal asks for.');
}

function cheapestOffer(goal, page, prior) {
  const offers = parseOffers(page.pageText);
  if (offers.length >= 2) {
    const sorted = [...offers].sort((a, b) => a.totalCents - b.totalCents);
    const [best, ...others] = sorted;
    const sum = (o) => `${formatEuro(o.priceCents)} + ${o.shippingCents ? `${formatEuro(o.shippingCents)} shipping` : 'free shipping'} = ${formatEuro(o.totalCents)}`;
    return finish(
      `The cheapest total is at ${best.shop}: ${sum(best)}. The other offers cost more: ${others.map((o) => `${o.shop} ${sum(o)}`).join('; ')}.`,
      'I added price and shipping for every offer in the table.'
    );
  }
  const link = findProductLink(goal, page.elements);
  if (!link) return fail('the prompt has no offers table and no link that matches the product in the goal.');
  if (prior.some((a) => a.action === 'click' && Number(a.element_id) === link.id)) {
    return fail(`I already clicked [${link.id}] and the prompt still shows no offers table.`);
  }
  return { action: 'click', element_id: link.id, reason: `Link [${link.id}] "${link.label}" is the product named in the goal; its page should list the offers.` };
}

// ---------------------------------------------------------------------------------------------
// Deciding a reply
// ---------------------------------------------------------------------------------------------

function isPlanSchema(format) {
  return !!format && typeof format === 'object' && format.type === 'object' && !!format.properties && !!format.properties.steps;
}

function isActionSchema(format) {
  return !!format && typeof format === 'object' && Array.isArray(format.oneOf);
}

function planFor(prompt) {
  const task = /^Task: "(.*)"$/m.exec(prompt)?.[1] ?? '';
  const kind = kindOfGoal(task);
  const goals = kind === 'cheapest'
    ? ['Open the offers page of the product', 'Add price and shipping for every offer', 'Name the shop with the lowest total']
    : kind === 'facts'
      ? ['Read the price, shipping and delivery on the page', 'Answer with the values from the page']
      : ['Read the current page', 'Answer from what the page shows'];
  return { steps: goals.map((goal) => ({ source: 'current page', goal })) };
}

/**
 * The scripted reply to one request.
 *
 * @param {{messages: {role: string, content: string}[], format?: unknown}} request
 * @returns {{kind: 'plan'|'action', reply: object, note: string} | {error: {status: number, message: string}}}
 */
export function decide(request) {
  const messages = request.messages;
  if (isPlanSchema(request.format)) {
    return { kind: 'plan', reply: planFor(lastUserMessage(messages)), note: 'plan' };
  }
  if (!isActionSchema(request.format)) {
    return { error: { status: 501, message: 'mock: no script for a call without a plan or action schema. Extend tests/e2e/lib/mockOllama.mjs.' } };
  }

  const page = parseStepMessage(lastUserMessage(messages));
  const goal = page.goal || /^Goal: (.*)$/m.exec(messages.map((m) => m.content).join('\n'))?.[1] || '';
  const prior = priorActions(messages);

  let reply;
  let note;
  if (!page.pageText.trim() && page.elements.length === 0) {
    reply = fail('the prompt has no page text and no interactive elements. If the prompt layout changed, update parseStepMessage() in tests/e2e/lib/mockOllama.mjs.');
    note = 'no page content in the prompt';
  } else if (looksLikeChallenge(page)) {
    if (prior.some((a) => a.action === 'wait')) {
      reply = finish(BLOCKED_ANSWER, 'The bot check is still there after waiting.');
      note = 'bot check still there: finish honestly';
    } else {
      reply = { action: 'wait', amount: 1, reason: 'A bot check is showing. I will not click it. I wait once and look again.' };
      note = 'bot check: wait once';
    }
  } else {
    const kind = kindOfGoal(goal);
    if (kind === 'cheapest') {
      reply = cheapestOffer(goal, page, prior);
      note = reply.action === 'click' ? `cheapest offer: click [${reply.element_id}]` : 'cheapest offer: answer from the offers table';
    } else if (kind === 'facts') {
      reply = answerFacts(goal, page);
      note = 'price, shipping, delivery: answer from the page text';
    } else {
      reply = fail(`I do not know this goal: "${goal.slice(0, 80)}".`);
      note = 'unknown goal';
    }
  }
  if (reply.answer && reply.answer.startsWith(MOCK_FAIL_PREFIX)) note = `${note} (MOCK-FAIL)`;
  return { kind: 'action', reply, note };
}

// ---------------------------------------------------------------------------------------------
// The HTTP server
// ---------------------------------------------------------------------------------------------

function tagOf(name) {
  return {
    name,
    model: name,
    modified_at: '2026-01-01T00:00:00Z',
    size: 1,
    digest: '0'.repeat(64),
    details: { parent_model: '', format: 'gguf', family: 'mock', families: ['mock'], parameter_size: 'mock', quantization_level: 'none' }
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
 * @param {string[]} [options.models] names listed by /api/tags
 * @param {(call: object) => void} [options.onCall]
 */
export function startMockOllama({ host = '127.0.0.1', port = 11435, models = ['mock-agent'], onCall = () => {} } = {}) {
  const calls = [];

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
      const decision = decide(sent);
      if (decision.error) {
        reject(decision.error.status, decision.error.message);
      } else {
        // The reply has to fit the schema the request carried, as Ollama's grammar would force.
        const { ok, errors } = validateAgainst(sent.format, decision.reply);
        if (!ok) {
          reject(500, `mock bug: the scripted reply does not fit the request's schema: ${errors.slice(0, 5).join('; ')}`);
        } else {
          note = decision.note;
          const content = JSON.stringify(decision.reply);
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
    calls.push(call);
    onCall(call);
    send(res, status, responseText, { 'Content-Type': streaming ? 'application/x-ndjson' : 'application/json; charset=utf-8' });
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
