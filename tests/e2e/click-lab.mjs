/**
 * Click lab: how precisely does a vision model point at a button on a screenshot, and on which scale?
 *
 * Vision models do not agree on what a click coordinate means (pixels of the picture, 0-1000 of it,
 * or a 0-1 fraction), and a model keeps its own scale whatever the prompt asks for. A wrong guess
 * puts every coordinate click hundreds of pixels off: the cookie banner never closes. This lab
 * measures a model before it is trusted with clicks:
 *
 *   - small pages with one known target each (a cookie bar, a centered consent modal, a small
 *     button in a shadow root, a 28 px close icon, one day in a dense row of dates), and real
 *     cookie banners on the open web (--real);
 *   - each page is captured like the extension does (the 1568-token image budget, JPEG 80);
 *   - the model gets the extension's click tool and the picture, and is asked to click the target;
 *   - its answer is read on each scale, and the report says which scale lands inside the target.
 *
 * The scale the extension uses for a model is src/background/llm/coordinates.ts (coordinateSpaceOf).
 * When this lab says a model points on another scale, that is the line to change.
 *
 *   node tests/e2e/click-lab.mjs                      # NVIDIA, the default model, small pages
 *   node tests/e2e/click-lab.mjs --real --repeat=2    # plus real cookie banners
 *   node tests/e2e/click-lab.mjs --model=<id> --base-url=https://integrate.api.nvidia.com/v1
 *
 * Needs NVIDIA_API_KEY in the environment or NVIDIA_API in the repo .env (or --key-env=NAME for
 * another OpenAI-compatible provider). The key is only sent to the base URL, never printed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { NVIDIA_DEFAULT_MODEL } from './lib/providers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.length ? v.join('=') : true];
}));

function dotenv() {
  try {
    return Object.fromEntries(fs.readFileSync(path.join(REPO, '.env'), 'utf8').split('\n')
      .map((l) => l.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/)).filter(Boolean)
      .map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')]));
  } catch (_) {
    return {};
  }
}
const ENV = dotenv();
const KEY = args['key-env'] ? (process.env[args['key-env']] || ENV[args['key-env']]) : (process.env.NVIDIA_API_KEY || ENV.NVIDIA_API);
const MODEL = args.model || NVIDIA_DEFAULT_MODEL;
const BASE_URL = String(args['base-url'] || 'https://integrate.api.nvidia.com/v1').replace(/\/+$/, '');
const REPEAT = Number(args.repeat || 2);
const VIEW = { width: 1920, height: 1200 };
const CHROMIUM = process.env.CHROMIUM_PATH || '/Applications/Chromium.app/Contents/MacOS/Chromium';

/** The extension's image budget (src/shared/imageBudget.ts): 1568 tokens of 28 px, width aligned to 28. */
function fitToBudget(w, h) {
  const tokens = (px) => Math.floor((px - 1) / 28) + 1;
  const fits = (a, b) => a <= 1568 && b <= 1568 && tokens(a) * tokens(b) <= 1568;
  if (fits(w, h)) return { width: w, height: h };
  let lo = 1, hi = Math.min(w, 1568), best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (fits(mid, Math.round((mid * h) / w))) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  let aligned = Math.floor(best / 28) * 28;
  while (!fits(aligned, Math.round((aligned * h) / w))) aligned -= 28;
  return { width: aligned, height: Math.round((aligned * h) / w) };
}

const BTN = 'font:15px system-ui;border-radius:6px;cursor:pointer;';
/** Small pages, one target each, marked id="t". */
const PAGES = {
  'cookie-bar': {
    ask: 'the "Accept all" button',
    html: `<body style="margin:0;font:16px system-ui"><h1 style="margin:40px">News of the day</h1><p style="margin:40px">${'Lorem ipsum dolor sit amet. '.repeat(80)}</p>
    <div style="position:fixed;left:0;right:0;bottom:0;background:#222;color:#fff;padding:22px 40px;display:flex;align-items:center;gap:16px">
      <span style="flex:1">We use cookies to improve your experience.</span>
      <button style="${BTN}padding:10px 18px;background:#444;color:#fff;border:1px solid #888">Reject all</button>
      <button style="${BTN}padding:10px 18px;background:#444;color:#fff;border:1px solid #888">Settings</button>
      <button id="t" style="${BTN}padding:10px 18px;background:#2a7;color:#fff;border:0">Accept all</button></div></body>`
  },
  'consent-modal': {
    ask: 'the "Alle akzeptieren" button',
    html: `<body style="margin:0;font:16px system-ui;background:#eee"><p style="margin:40px">${'Seiteninhalt. '.repeat(200)}</p>
    <div style="position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center">
      <div style="background:#fff;width:520px;padding:28px;border-radius:12px">
        <h2>Datenschutz-Einstellungen</h2><p>Wir nutzen Cookies und ähnliche Technologien. ${'Mehr Text zur Einwilligung. '.repeat(6)}</p>
        <div style="display:flex;flex-direction:column;gap:10px;padding:12px;background:#f5f5f5">
          <button id="t" style="${BTN}padding:12px;background:#c00;color:#fff;border:0">Alle akzeptieren</button>
          <button style="${BTN}padding:12px;background:#fff;border:1px solid #c00;color:#c00">Nur erforderliche</button>
          <a href="#" style="font-size:13px;text-align:center">Einstellungen anpassen</a></div></div></div></body>`
  },
  'shadow-small-button': {
    ask: 'the "Accept" button',
    html: `<body style="margin:0;font:16px system-ui"><h1 style="margin:40px">Travel planner</h1><p style="margin:40px">${'Find trains and connections. '.repeat(60)}</p><div id="host"></div>
    <script>document.getElementById('host').attachShadow({mode:'open'}).innerHTML=\`<div style="position:fixed;right:24px;bottom:24px;width:360px;background:#fff;box-shadow:0 4px 20px #0005;padding:18px;font:14px system-ui;border-radius:8px">
    <b>Privacy</b><p>We and our partners use cookies.</p><div style="display:flex;gap:8px;justify-content:flex-end;padding:10px;background:#f2f2f2">
    <button style="font:13px system-ui;padding:6px 10px;border:1px solid #999;background:#fff">Deny</button>
    <button style="font:13px system-ui;padding:6px 10px;border:1px solid #999;background:#fff">More</button>
    <button id="t" style="font:13px system-ui;padding:6px 10px;border:0;background:#ec0016;color:#fff">Accept</button></div></div>\`;</script></body>`
  },
  'close-icon': {
    ask: 'the close (X) icon of the dialog',
    html: `<body style="margin:0;font:16px system-ui"><p style="margin:40px">${'Shop content. '.repeat(200)}</p>
    <div style="position:fixed;inset:0;background:rgba(0,0,0,.4)"><div style="position:absolute;left:600px;top:250px;width:640px;height:380px;background:#fff;border-radius:10px;padding:30px">
    <button id="t" aria-label="Close" style="position:absolute;right:12px;top:12px;width:28px;height:28px;border:0;background:none;font-size:20px;cursor:pointer">×</button>
    <h2>Subscribe to our newsletter</h2><p>Get 10% off your first order.</p><input placeholder="Email" style="width:300px;padding:8px"> <button style="padding:9px">Subscribe</button></div></div></body>`
  },
  'dense-dates': {
    ask: 'the "Thu 14" button',
    html: `<body style="margin:0;font:16px system-ui"><h2 style="margin:40px">Pick a date</h2><div style="margin:40px;display:flex;gap:4px">
    ${['Mon 11', 'Tue 12', 'Wed 13', 'Thu 14', 'Fri 15', 'Sat 16', 'Sun 17'].map((d) => `<button ${d === 'Thu 14' ? 'id="t"' : ''} style="width:64px;height:34px;font:12px system-ui;border:1px solid #aaa;background:#fff">${d}</button>`).join('')}</div>
    <p style="margin:40px">${'Calendar notes. '.repeat(100)}</p></body>`
  }
};

/** Real cookie banners. The target is found by its text, on top at its center, in any frame or shadow root. */
const ACCEPT = /^(allow all( cookies)?|accept all( cookies)?|accept( all)? (cookies|and continue)|i agree|yes, i agree|i accept|accept|agree|alle akzeptieren|akzeptieren|zustimmen|alle zulassen|alle cookies (akzeptieren|zulassen)|akzeptieren und weiter|einverstanden|zustimmen und weiter)$/i;
const REAL = {
  'bahn.de': 'https://www.bahn.de/',
  'stackoverflow.com': 'https://stackoverflow.com/questions',
  'bbc.com': 'https://www.bbc.com/',
  'booking.com': 'https://www.booking.com/',
  'reddit.com': 'https://www.reddit.com/'
};

/** Visible buttons and links whose text matches (or the element with id="t"), that are on top at their center. */
const FIND_TARGET = `(source, flags, byId) => {
  const re = new RegExp(source, flags);
  const out = [];
  const visit = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) visit(el.shadowRoot);
      if (byId ? el.id !== 't' : (!/^(BUTTON|A)$/.test(el.tagName) && el.getAttribute('role') !== 'button')) continue;
      const text = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ');
      if (!byId && !re.test(text)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      let top = document.elementFromPoint(cx, cy);
      for (let d = 0; top && top.shadowRoot && d < 20; d++) { const inner = top.shadowRoot.elementFromPoint(cx, cy); if (!inner || inner === top) break; top = inner; }
      let onTop = false;
      for (let n = top; n; n = n.parentNode || n.host) if (n === el) { onTop = true; break; }
      if (onTop) out.push({ text: text.slice(0, 40), x: r.left, y: r.top, w: r.width, h: r.height });
    }
  };
  visit(document);
  return out;
}`;

async function findTarget(page, re, byId) {
  for (const frame of page.frames()) {
    let offset = { x: 0, y: 0 };
    if (frame !== page.mainFrame()) {
      const box = await (await frame.frameElement().catch(() => null))?.boundingBox().catch(() => null);
      if (!box) continue;
      offset = { x: box.x, y: box.y };
    }
    const hits = await frame.evaluate(`(${FIND_TARGET})(${JSON.stringify(re.source)}, ${JSON.stringify(re.flags)}, ${byId})`).catch(() => []);
    const hit = hits.map((h) => ({ ...h, x: h.x + offset.x, y: h.y + offset.y }))
      .find((h) => h.x >= 0 && h.y >= 0 && h.x < VIEW.width && h.y < VIEW.height);
    if (hit) return hit;
  }
  return null;
}

/** The extension's click tool, coordinates only (an element id needs an element list, which the lab does not give). */
const CLICK_TOOL = {
  type: 'function',
  function: {
    name: 'click',
    description: 'Click at a point of the last take_screenshot picture. Aim at the center of the target.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Horizontal position of the target on the picture' },
        y: { type: 'number', description: 'Vertical position of the target on the picture' },
        reason: { type: 'string' }
      },
      required: ['x', 'y']
    }
  }
};

async function askModel(picture, image, target) {
  const messages = [
    { role: 'system', content: 'You are Tarka, a browser agent. You act on the page with tools. Answer with exactly one tool call.' },
    { role: 'user', content: `Click ${target} on this page.` },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'take_screenshot', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: `Captured the visible page (${image.width}x${image.height}, image/jpeg).` },
    { role: 'user', content: [{ type: 'text', text: 'The screenshot:' }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${picture}` } }] }
  ];
  const body = JSON.stringify({ model: MODEL, messages, tools: [CLICK_TOOL], tool_choice: 'auto', temperature: 0, max_tokens: 600 });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        signal: AbortSignal.timeout(90000),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
        body
      });
      if (res.status >= 500 || res.status === 429) { await new Promise((r) => setTimeout(r, 3000 * (attempt + 1))); continue; }
      const json = await res.json();
      const call = json.choices?.[0]?.message?.tool_calls?.[0];
      return JSON.parse(call?.function?.arguments || '{}');
    } catch (_) { /* a timeout or a bad reply: try again */ }
  }
  return {};
}

/** Where an answer lands on each scale, in picture pixels. */
function readings(x, y, image) {
  const out = { pixels: { x, y }, 'per-mille': { x: (x * image.width) / 1000, y: (y * image.height) / 1000 } };
  if (x >= 0 && x <= 1 && y >= 0 && y <= 1) out.fraction = { x: x * image.width, y: y * image.height };
  return out;
}

async function main() {
  if (!KEY) {
    console.error('click-lab: no API key (NVIDIA_API_KEY, NVIDIA_API in .env, or --key-env=NAME).');
    process.exit(2);
  }
  const image = fitToBudget(VIEW.width, VIEW.height);
  const scale = image.width / VIEW.width;
  const browser = await puppeteer.launch({ executablePath: CHROMIUM, headless: true, args: ['--lang=de-DE'], defaultViewport: { ...VIEW, deviceScaleFactor: 1 } });
  const cases = [...Object.entries(PAGES).map(([name, p]) => ({ name, ...p })), ...(args.real ? Object.entries(REAL).map(([name, url]) => ({ name, url })) : [])];
  const tally = { pixels: 0, 'per-mille': 0, fraction: 0 };
  let asked = 0;
  console.log(`click lab: ${MODEL}, viewport ${VIEW.width}x${VIEW.height}, picture ${image.width}x${image.height}\n`);
  for (const c of cases) {
    const page = await browser.newPage();
    try {
      if (c.html) await page.setContent(c.html, { waitUntil: 'load' });
      else { await page.goto(c.url, { waitUntil: 'domcontentloaded', timeout: 30000 }); await new Promise((r) => setTimeout(r, 4500)); }
    } catch (err) {
      console.log(`${c.name}: could not load (${err.message})`);
      await page.close();
      continue;
    }
    const target = await findTarget(page, ACCEPT, !!c.html);
    if (!target) { console.log(`${c.name}: no target on the page (no banner shown?), skipped`); await page.close(); continue; }
    const box = { x: target.x * scale, y: target.y * scale, w: target.w * scale, h: target.h * scale };
    const picture = await page.screenshot({ type: 'jpeg', quality: 80, encoding: 'base64', clip: { x: 0, y: 0, ...VIEW, scale } });
    for (let i = 0; i < REPEAT; i++) {
      const answer = await askModel(picture, image, c.ask || 'the button that accepts the cookies');
      const x = Number(answer.x), y = Number(answer.y);
      asked += 1;
      if (!Number.isFinite(x) || !Number.isFinite(y)) { console.log(`${c.name}: no coordinate in the answer`); continue; }
      const hits = Object.entries(readings(x, y, image))
        .filter(([, p]) => p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h)
        .map(([name]) => name);
      for (const h of hits) tally[h] += 1;
      console.log(`${c.name.padEnd(20)} "${target.text}" at [${Math.round(box.x)}, ${Math.round(box.y)}, ${Math.round(box.w)}x${Math.round(box.h)}]  answer (${x}, ${y})  hits as: ${hits.join(', ') || 'nothing'}`);
    }
    await page.close();
  }
  await browser.close();
  console.log(`\n${asked} answers. Inside the target when read as: pixels ${tally.pixels}, 0-1000 ${tally['per-mille']}, 0-1 fraction ${tally.fraction}.`);
  console.log('The scale the extension uses for a model: src/background/llm/coordinates.ts (coordinateSpaceOf).');
}

main().catch((err) => { console.error(err); process.exit(1); });
