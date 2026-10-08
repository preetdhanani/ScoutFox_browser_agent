/**
 * The side panel's view of the answer audit: the finish card by verdict, the "what could not be
 * verified" block, and the plan rows for a skipped step.
 *
 * The engine audits every final answer against the pages it really read and puts the result on the
 * finish history entry as `audit` (the contract is written above the audit helpers in
 * sidepanel/sidepanel.js). These tests pin what a person SEES for each verdict and, the part that
 * matters most for safety, that nothing a model or a web page controls can reach the page as markup.
 *
 * How it runs: sidepanel.js is a browser module. It touches `window` and `document` once at load
 * (to register listeners), so a small stub is enough to import it here and call its pure string
 * builders (renderTurns, renderFinishCard, ...). No DOM is built: the builders return HTML strings
 * and the assertions look at those strings. What Chromium paints from them (colours, spacing, the
 * focus ring, the dark theme) is NOT covered here. That needs a look in a real browser.
 *
 * Node runs the .ts imports of sidepanel.js by type stripping, so nothing here needs a build.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// The stub stays for the whole file: initTimelineInteraction and renderState read
// document.getElementById later. `activeTimeline` is what the id "timeline" answers with; the
// scroll tests swap in a fake that has a size.
const timelineListeners = [];
let activeTimeline = { addEventListener: (type, fn, capture) => timelineListeners.push({ type, fn, capture }) };
globalThis.window = { addEventListener() {} };
globalThis.document = {
  readyState: 'loading',
  addEventListener() {},
  getElementById(id) {
    return id === 'timeline' ? activeTimeline : null;
  }
};

const {
  buildTurns, renderTurns, renderFinishCard, renderAuditDetails, renderPlanRows,
  normalizeAudit, planCounts, initTimelineInteraction, openAuditDetails, closedAuditDetails,
  describeAction, firstSentence, withoutEngineNotes, partialSubtitle, renderState,
  finishLandingTop, finishCardKey, noteFinishCard
} = await import('../sidepanel/sidepanel.js');
const { BANNER_PARTIAL, BANNER_UNVERIFIED } = await import('../src/background/agent/answerAudit.ts');

const XSS = '<img src=x onerror=alert(1)>';
const XSS_ESCAPED = '&lt;img src=x onerror=alert(1)&gt;';

const goal = (prompt, extra = {}) => ({ type: 'user_goal', prompt, ...extra });
const finish = (answer, extra = {}) => ({ type: 'finish', answer, ...extra });
const navigate = (url) => ({ type: 'agent_response', action: { action: 'navigate', url }, thought: '' });
const executed = () => ({ type: 'execution_result', success: true });

const PAGE_A = { host: 'frame.work', url: 'https://frame.work/de/en/products/laptop16-amd-ai300/configuration/new' };
const PAGE_B = { host: 'frame.work', url: 'https://frame.work/de/en/marketplace/laptops' };

/** The incident as the engine would report it: only frame.work read, idealo.de and geizhals.de invented. */
const UNVERIFIED = {
  verdict: 'unverified',
  opened: [PAGE_A, PAGE_B],
  notOpened: ['idealo.de', 'geizhals.de'],
  notes: [
    { code: 'unsupported_detail', severity: 'soft', text: 'No page text mentions delivery time for frame.work.' },
    { code: 'number_not_in_evidence', severity: 'lie', text: 'The price 1,899 euro appears on no page that was read.' },
    { code: 'source_not_opened', severity: 'lie', text: 'idealo.de was never opened, but the answer gives a price for it.' }
  ],
  sendBacks: 2
};
const PARTIAL = {
  verdict: 'partial',
  opened: [PAGE_A],
  notOpened: ['geizhals.de'],
  notes: [{ code: 'source_unchecked', severity: 'gap', text: 'geizhals.de was never opened.' }],
  sendBacks: 0
};
const VERIFIED = { verdict: 'verified', opened: [PAGE_A, PAGE_B], notOpened: [], notes: [], sendBacks: 0 };

const cardFor = (audit, extra = {}) =>
  renderFinishCard({ turn: 1, answer: 'The answer.', audit, answerUnconfirmed: false, ...extra });

const classOfCard = (html) => html.match(/^<div class="([^"]*)"/)[1];
const textOf = (html) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

/** Every tag name in a piece of HTML. Used to prove that an injected tag never appears. */
function tagNames(html) {
  return new Set([...html.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1].toLowerCase()));
}
const OUR_TAGS = new Set([
  'div', 'span', 'svg', 'path', 'line', 'circle', 'polyline', 'polygon', 'rect', 'strong', 'em',
  'details', 'summary', 'ul', 'li', 'a', 'button', 'input'
]);
function assertOnlyOurTags(html) {
  for (const tag of tagNames(html)) assert.ok(OUR_TAGS.has(tag), `unexpected <${tag}> in: ${html.slice(0, 300)}`);
}

// ---------------------------------------------------------------------------------------------
// entries without audit render as before
// ---------------------------------------------------------------------------------------------

test('a finish entry without audit gives the plain Done card and nothing else', () => {
  const html = cardFor(null, { answer: 'All good **now**' });
  assert.match(
    html,
    /^<div class="finish-card"><div class="finish-title"><svg[^]*?<\/svg> Done<\/div><div class="finish-body">All good <strong>now<\/strong><\/div><\/div>$/
  );
  assert.ok(!html.includes('<details') && !html.includes('finish-sub'));
});

test('the old unconfirmed flag on its own still gives the old Unconfirmed card', () => {
  const html = cardFor(undefined, { answer: 'plain reply', answerUnconfirmed: true });
  assert.match(
    html,
    /^<div class="finish-card unconfirmed"><div class="finish-title"><svg[^]*?<\/svg> Unconfirmed answer<\/div><div class="finish-body">plain reply<\/div><\/div>$/
  );
});

test('an audit that is not an object is ignored, so an odd saved session keeps the old card', () => {
  for (const bad of ['verified', 5, true, [], [{ verdict: 'partial' }]]) {
    assert.equal(normalizeAudit(bad), null);
    assert.equal(classOfCard(cardFor(bad)), 'finish-card');
    assert.ok(textOf(cardFor(bad)).includes('Done'));
  }
});

test('a whole history without audit renders the old turn: collapsed group, Done card, no audit markup', () => {
  const history = [goal('find it'), navigate('https://www.frame.work/de'), executed(), finish('It costs 2,069 euro.')];
  const html = renderTurns(history, 'complete', [], '', '');
  assert.ok(html.includes('<div class="act-group">'), 'an answered turn is collapsed');
  assert.ok(html.includes('>1 action<'));
  assert.ok(html.includes('class="finish-card"'));
  for (const gone of ['<details', 'finish-sub', 'audit', 'not checked', 'did not finish']) {
    assert.ok(!html.includes(gone), `unexpected ${gone}`);
  }
  assert.equal(buildTurns(history)[0].audit, null);
});

// ---------------------------------------------------------------------------------------------
// verdict cards
// ---------------------------------------------------------------------------------------------

test('unverified: danger card, title, one-line subtitle, and the "what could not be verified" block', () => {
  const html = cardFor(UNVERIFIED);
  assert.equal(classOfCard(html), 'finish-card unverified has-sub');
  assert.ok(html.includes('</svg> Unverified answer</div>'));
  assert.ok(html.includes('<div class="finish-sub">Some parts of this answer could not be checked against the pages ScoutFox read.</div>'));
  // An unverified answer shows what is wrong with it without a click (it was collapsed before).
  assert.ok(html.includes('<details class="audit attention" data-audit-key="1" open>'));
  assert.ok(html.includes('<span>What could not be verified</span></summary>'));

  // The caveat comes before the answer, so it is seen before the answer is read.
  assert.ok(html.indexOf('<details') < html.indexOf('class="finish-body"'));

  // Notes: code-written text, the worst first (lies, then gaps, then soft), same order within a severity.
  const notes = [...html.matchAll(/<li class="audit-note" data-code="([^"]*)"><span class="audit-dot (\w+)"/g)];
  assert.deepEqual(notes.map((m) => [m[1], m[2]]), [
    ['number_not_in_evidence', 'lie'],
    ['source_not_opened', 'lie'],
    ['unsupported_detail', 'soft']
  ]);

  const text = textOf(html);
  assert.ok(text.includes('Not opened idealo.de, geizhals.de'));
  assert.ok(text.includes('Pages read frame.work'));
  assert.ok(html.includes(`href="${PAGE_A.url}"`) && html.includes(`href="${PAGE_B.url}"`));
  assert.ok(text.includes('Sent back to the model 2 times before the final answer.'));
});

test('partial: warning card with its own title and subtitle, same block', () => {
  const html = cardFor(PARTIAL);
  assert.equal(classOfCard(html), 'finish-card partial has-sub');
  assert.ok(html.includes('</svg> Partial answer</div>'));
  // The subtitle names the source that was not checked (PARTIAL.notOpened), not just "a source".
  assert.ok(html.includes('<div class="finish-sub">Not every source was checked: geizhals.de.</div>'));
  assert.ok(html.includes('<span>What could not be verified</span></summary>'));
  assert.ok(textOf(html).includes('geizhals.de was never opened.'));
  assert.ok(html.includes('class="audit-dot gap"'));
  assert.ok(!html.includes('Sent back'), 'no send-backs, no line about them');
  assert.ok(!html.includes('Done'));
});

test('verified: today\'s Done card plus one quiet "Checked against N pages" line that opens to the pages', () => {
  const html = cardFor(VERIFIED);
  assert.equal(classOfCard(html), 'finish-card');
  assert.ok(html.includes('</svg> Done</div>'));
  assert.ok(!html.includes('finish-sub'));
  assert.ok(html.includes('<details class="audit verified" data-audit-key="1">'));
  assert.ok(html.includes('<span>Checked against 2 pages</span></summary>'));
  // A receipt sits below the answer.
  assert.ok(html.indexOf('class="finish-body"') < html.indexOf('<details'));
  const text = textOf(html);
  assert.ok(text.includes('Pages read frame.work'));
  assert.ok(html.includes(`href="${PAGE_A.url}"`) && html.includes(`href="${PAGE_B.url}"`));
});

test('verified: soft notes are listed under Notes, and they do not change the card', () => {
  const soft = { code: 'unsupported_detail', severity: 'soft', text: 'Free shipping is not stated on any page of frame.work.' };
  const html = cardFor({ ...VERIFIED, notes: [soft] });
  assert.equal(classOfCard(html), 'finish-card');
  const text = textOf(html);
  assert.ok(text.includes('Notes Free shipping is not stated on any page of frame.work.'));
  assert.ok(html.includes('class="audit-dot soft"'));
});

test('verified: the line says "1 page" for one page and drops the toggle when there is nothing to list', () => {
  assert.ok(cardFor({ ...VERIFIED, opened: [PAGE_A] }).includes('<span>Checked against 1 page</span>'));

  const none = cardFor({ ...VERIFIED, opened: [] });
  assert.ok(none.includes('Checked against 0 pages'));
  assert.ok(!none.includes('<details') && !none.includes('<summary'));
});

test('the unconfirmed flag stays visible next to a verdict and turns the card red', () => {
  const unverified = cardFor(UNVERIFIED, { answerUnconfirmed: true });
  assert.equal(classOfCard(unverified), 'finish-card unverified unconfirmed has-sub');
  assert.ok(unverified.includes('</svg> Unverified answer</div>'));
  assert.ok(unverified.includes('The model replied in plain text instead of finishing the task.'));

  // Partial keeps its own title, but the card class list ends with unconfirmed, so the CSS shows danger.
  const partial = cardFor(PARTIAL, { answerUnconfirmed: true });
  assert.equal(classOfCard(partial), 'finish-card partial unconfirmed has-sub');
  assert.ok(partial.includes('</svg> Partial answer</div>'));
  assert.ok(partial.includes('Not every source was checked: geizhals.de.'));
  assert.ok(partial.includes('The model replied in plain text instead of finishing the task.'));

  // The content was checked, but the model never said it was done: title stays Unconfirmed.
  const verified = cardFor(VERIFIED, { answerUnconfirmed: true });
  assert.equal(classOfCard(verified), 'finish-card unconfirmed has-sub');
  assert.ok(verified.includes('</svg> Unconfirmed answer</div>'));
  assert.ok(verified.includes('Checked against 2 pages'));
  assert.ok(!verified.includes('Done'));
});

test('a verdict this build does not know is shown as unverified, never as a green Done', () => {
  const html = cardFor({ ...VERIFIED, verdict: 'rejected-by-a-newer-engine' });
  assert.equal(classOfCard(html), 'finish-card unverified has-sub');
  assert.ok(html.includes('Unverified answer'));
  assert.equal(classOfCard(cardFor({})), 'finish-card unverified has-sub', 'an empty audit object is not a pass either');
});

test('an unverified or partial answer is still an answer: the turn is not "did not finish"', () => {
  for (const audit of [UNVERIFIED, PARTIAL, VERIFIED]) {
    const html = renderTurns([goal('g'), navigate('https://frame.work/'), executed(), finish('The answer.', { audit })], 'complete', [], '', '');
    assert.ok(!html.includes('did not finish'), audit.verdict);
    assert.ok(html.includes('<div class="act-group">'), 'collapsed, like any answered turn');
  }
  const noAnswer = renderTurns([goal('g'), navigate('https://frame.work/'), executed()], 'stopped', [], '', '');
  assert.ok(noAnswer.includes('· did not finish'));
  assert.ok(noAnswer.includes('act-group open'));
});

// ---------------------------------------------------------------------------------------------
// escaping: model- and web-controlled text never becomes markup
// ---------------------------------------------------------------------------------------------

test('an injected tag in a note, a URL, a host or a not-opened name is shown as text', () => {
  const hostile = {
    verdict: 'unverified',
    opened: [
      { host: `evil${XSS}.test`, url: `https://evil.test/"><img src=x onerror=alert(1)>?q=1&a=2` },
      { host: 'plain.test', url: `javascript:alert(1)//${XSS}` }
    ],
    notOpened: [`${XSS}.de`],
    notes: [{ code: `x"${XSS}`, severity: 'lie', text: `${XSS} was never opened` }],
    sendBacks: 1
  };
  const html = cardFor(hostile, { answer: `Answer ${XSS}` });

  assert.ok(!html.includes('<img'), 'no raw <img anywhere');
  assertOnlyOurTags(html);
  assert.ok(html.includes(`${XSS_ESCAPED} was never opened`), 'the note text is escaped');
  assert.ok(html.includes(`Answer ${XSS_ESCAPED}`), 'the answer is escaped');
  assert.ok(html.includes(`evil${XSS_ESCAPED}.test`), 'the host is escaped');
  assert.ok(html.includes(`${XSS_ESCAPED}.de`), 'the not-opened name is escaped');

  // The hostile URL is http(s), so it is a link, but its value cannot leave the attribute.
  const hrefs = [...html.matchAll(/ href="([^"]*)"/g)].map((m) => m[1]);
  assert.equal(hrefs.length, 1);
  assert.ok(hrefs[0].startsWith('https://evil.test/&quot;&gt;&lt;img src=x onerror=alert(1)&gt;?q=1&amp;a=2'));
  assert.ok(!/[<>"]/.test(hrefs[0]));
  // The data-code attribute cannot be broken out of either.
  const codes = [...html.matchAll(/data-code="([^"]*)"/g)].map((m) => m[1]);
  assert.equal(codes.length, 1);
  assert.ok(!/[<>"]/.test(codes[0]));

  // The javascript: URL is text, not a link.
  assert.ok(html.includes('<span class="audit-url">javascript:alert(1)//'));
  assert.equal((html.match(/<a /g) || []).length, 1);
});

test('only http(s) URLs become links, and every link opens safely', () => {
  const urls = [
    'http://a.test/x', 'https://b.test/x', 'HTTPS://c.test/x',
    'javascript:alert(1)', 'data:text/html,hi', 'ftp://d.test/x', '//e.test/x', ' https://f.test/x',
    'view-source:https://g.test/', 'chrome://settings', 'file:///etc/passwd', 'h.test/relative'
  ];
  const html = renderAuditDetails(
    normalizeAudit({ verdict: 'verified', opened: urls.map((url, i) => ({ host: `h${i}`, url })), notOpened: [], notes: [] }),
    1,
    'verified'
  );
  const links = [...html.matchAll(/<a class="audit-url" href="([^"]*)" target="_blank" rel="noopener noreferrer">/g)].map((m) => m[1]);
  assert.deepEqual(links, ['http://a.test/x', 'https://b.test/x', 'HTTPS://c.test/x']);
  assert.equal((html.match(/<a /g) || []).length, 3, 'no link without target and rel');
  assert.equal((html.match(/<span class="audit-url">/g) || []).length, urls.length - 3);
});

test('a hostile plan step text is escaped in the plan rows', () => {
  const html = renderPlanRows([{ text: `${XSS} step`, status: 'skipped' }, { text: XSS, status: 'completed' }]);
  assert.ok(!html.includes('<img'));
  assertOnlyOurTags(html);
  assert.equal(html.split(XSS_ESCAPED).length - 1, 2);
});

// ---------------------------------------------------------------------------------------------
// plan rows and progress
// ---------------------------------------------------------------------------------------------

test('a skipped plan row has its own icon, a "not checked" suffix, and is not a completed row', () => {
  const html = renderPlanRows([
    { text: 'frame.work: read the price', status: 'completed' },
    { text: 'idealo.de: read the price', status: 'skipped' },
    { text: 'Compile the table', status: 'pending' }
  ]);
  const rows = html.match(/<div class="act-plan-row [^>]*>[^]*?<\/div>/g);
  assert.equal(rows.length, 3);
  assert.match(rows[0], /^<div class="act-plan-row completed">/);
  assert.match(rows[1], /^<div class="act-plan-row skipped">/);
  assert.ok(rows[1].includes('idealo.de: read the price<span class="plan-skip-note"> - not checked</span>'));
  assert.ok(!rows[1].includes('completed'));
  // The icon is not the check mark, and the done row has no suffix.
  const icon = (row) => row.match(/<span>(<svg[^]*?<\/svg>)<\/span>/)[1];
  assert.notEqual(icon(rows[1]), icon(rows[0]));
  assert.ok(!rows[0].includes('not checked') && !rows[2].includes('not checked'));
});

test('plan rows for the old statuses are unchanged, and an unknown status is pending, never raw markup', () => {
  const html = renderPlanRows([
    { text: 'a', status: 'completed' }, { text: 'b', status: 'in_progress' }, { text: 'c', status: 'pending' },
    { text: 'd', status: `"><img src=x onerror=alert(1)>` }, { text: 'e' }
  ]);
  assert.deepEqual(
    [...html.matchAll(/<div class="act-plan-row ([^"]*)">/g)].map((m) => m[1]),
    ['completed', 'in_progress', 'pending', 'pending', 'pending']
  );
  assert.ok(!html.includes('<img'));
});

test('progress counts only completed steps, never skipped ones', () => {
  const steps = [{ status: 'completed' }, { status: 'skipped' }, { status: 'in_progress' }, { status: 'pending' }];
  assert.deepEqual(planCounts(steps), { done: 1, skipped: 1, total: 4 });
  assert.deepEqual(planCounts(undefined), { done: 0, skipped: 0, total: 0 });

  const live = (plan) => renderTurns([goal('g'), navigate('https://frame.work/'), executed()], 'running', plan, '', '');
  assert.ok(live(steps.map((s, i) => ({ ...s, text: `s${i}` }))).includes('Working · step 2 of 4 · 1 action'));
  assert.ok(live([{ text: 'a', status: 'skipped' }, { text: 'b', status: 'skipped' }]).includes('Working · step 1 of 2 · 1 action'));
});

test('a finished last turn shows the plan only when a step was skipped; earlier turns never do', () => {
  const plan = [
    { text: 'frame.work: read the price', status: 'completed' },
    { text: 'idealo.de: read the price', status: 'skipped' }
  ];
  const one = [goal('g'), navigate('https://frame.work/'), executed(), finish('The answer.', { audit: PARTIAL })];

  const withSkip = renderTurns(one, 'complete', plan, '', '');
  assert.ok(withSkip.includes('<div class="act-plan">'));
  assert.ok(withSkip.includes('idealo.de: read the price<span class="plan-skip-note"> - not checked</span>'));
  // Still a collapsed group: the plan sits inside it.
  assert.ok(withSkip.includes('<div class="act-group">'));

  const noSkip = renderTurns(one, 'complete', plan.map((s) => ({ ...s, status: 'completed' })), '', '');
  assert.ok(!noSkip.includes('act-plan'), 'a finished turn without skipped steps hides the plan, as before');

  const two = [...one, goal('g2', { turn: 2 }), navigate('https://frame.work/'), executed(), finish('Second.', { audit: VERIFIED })];
  const html = renderTurns(two, 'complete', plan, '', '');
  assert.equal(html.split('<div class="act-plan">').length - 1, 1, 'only one turn shows the plan');
  const lastTurn = html.slice(html.lastIndexOf('<div class="turn">'));
  assert.ok(lastTurn.includes('<div class="act-plan">'), 'and it is the last one');
});

// ---------------------------------------------------------------------------------------------
// normalizeAudit
// ---------------------------------------------------------------------------------------------

test('normalizeAudit cleans the lists: types, duplicates, derived host, order, send-backs', () => {
  const audit = normalizeAudit({
    verdict: 'partial',
    opened: [
      { host: 'frame.work', url: 'https://frame.work/a' },
      { host: 'frame.work', url: 'https://frame.work/a' },
      { url: 'https://www.idealo.de/x' },
      null, 'text', {}, { host: 'only-host.test' }
    ],
    notOpened: ['a.de', 'a.de', '', 5, 'b.de'],
    notes: [
      { code: 'c1', severity: 'soft', text: 'third' },
      { severity: 'gap', text: 'second' },
      { code: 'c0', severity: 'lie', text: 'first' },
      { severity: 'weird', text: 'unknown severity is soft' },
      { severity: 'lie', text: '' }, null, { severity: 'lie' }
    ],
    sendBacks: 2.9
  });
  assert.deepEqual(audit.opened, [
    { host: 'frame.work', url: 'https://frame.work/a' },
    { host: 'idealo.de', url: 'https://www.idealo.de/x' },
    { host: 'only-host.test', url: '' }
  ]);
  assert.deepEqual(audit.notOpened, ['a.de', 'b.de']);
  assert.deepEqual(audit.notes.map((n) => n.text), ['first', 'second', 'third', 'unknown severity is soft']);
  assert.equal(audit.notes[3].severity, 'soft');
  assert.equal(audit.sendBacks, 2);
  assert.equal(normalizeAudit({ verdict: 'verified', sendBacks: -3 }).sendBacks, 0);
  assert.equal(normalizeAudit({ verdict: 'verified', sendBacks: 'many' }).sendBacks, 0);
});

test('a duplicated page is listed, and counted, once', () => {
  const html = cardFor({ ...VERIFIED, opened: [PAGE_A, PAGE_A, PAGE_B] });
  assert.ok(html.includes('Checked against 2 pages'));
  assert.equal(html.split('class="audit-page"').length - 1, 2);
});

// ---------------------------------------------------------------------------------------------
// the open state of the details survives a re-render
// ---------------------------------------------------------------------------------------------

test('a details block the user opened stays open across a re-render, and the toggle listener tracks it', () => {
  const details = (n) => cardFor(PARTIAL, { turn: n }).match(/<details[^>]*>/)[0];
  openAuditDetails.clear();
  assert.ok(!details(3).includes(' open'));

  timelineListeners.length = 0;
  initTimelineInteraction();
  const toggle = timelineListeners.find((l) => l.type === 'toggle');
  assert.ok(toggle, 'a toggle listener is registered');
  assert.equal(toggle.capture, true, 'toggle does not bubble, so it has to listen in the capture phase');

  const fake = (key, isOpen) => ({
    target: { open: isOpen, matches: (sel) => sel === 'details.audit', getAttribute: (name) => (name === 'data-audit-key' ? key : null) }
  });
  toggle.fn(fake('3', true));
  assert.ok(details(3).includes(' open'));
  assert.ok(!details(4).includes(' open'), 'another turn is not affected');
  toggle.fn(fake('3', false));
  assert.ok(!details(3).includes(' open'));

  // A toggle from some other <details> on the page is ignored.
  toggle.fn({ target: { open: true, matches: () => false, getAttribute: () => '9' } });
  assert.equal(openAuditDetails.size, 0);
});

// ---------------------------------------------------------------------------------------------
// the stylesheet: theme variables and the rules the markup relies on
// ---------------------------------------------------------------------------------------------

const CSS = fs.readFileSync(new URL('../sidepanel/sidepanel.css', import.meta.url), 'utf8');

/** The text of the first block that starts with this selector, up to its closing brace. */
function blockAt(selector) {
  const start = CSS.indexOf(selector);
  assert.notEqual(start, -1, `${selector} not found`);
  return CSS.slice(start, CSS.indexOf('}', start));
}

test('the warning colour exists in the light block and in both dark blocks', () => {
  for (const selector of [':root {', ':root:not([data-theme="light"]) {', ':root[data-theme="dark"] {']) {
    const block = blockAt(selector);
    assert.match(block, /--warning: #[0-9a-f]{6};/i, selector);
    assert.match(block, /--warning-soft: rgba\(/, selector);
  }
});

test('every colour variable the audit rules use is defined', () => {
  const defined = new Set([...CSS.matchAll(/(--[a-z-]+):/g)].map((m) => m[1]));
  const auditCss = CSS.slice(CSS.indexOf('.finish-card.partial'));
  for (const used of new Set([...auditCss.matchAll(/var\((--[a-z-]+)\)/g)].map((m) => m[1]))) {
    assert.ok(defined.has(used), `${used} is used but never defined`);
  }
});

test('the stylesheet has a rule for every class the audit markup uses', () => {
  const html = [
    cardFor(UNVERIFIED), cardFor(VERIFIED), cardFor({ ...VERIFIED, opened: [] }),
    cardFor(PARTIAL, { answerUnconfirmed: true }), renderPlanRows([{ text: 't', status: 'skipped' }])
  ].join('');
  const classes = new Set([...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean));
  // `soft` is the default look of a dot: it needs no rule of its own.
  for (const name of classes) {
    if (name === 'soft') continue;
    assert.ok(CSS.includes(`.${name}`), `.${name} has no rule`);
  }
  assert.ok(classes.has('audit-line') && classes.has('plan-skip-note') && classes.has('audit-url'));
});

test('only completed plan rows are struck through; the skipped row is muted, not struck', () => {
  const strikes = [...CSS.matchAll(/([^{}]+)\{[^}]*line-through[^}]*\}/g)].map((m) => m[1].trim());
  const planStrikes = strikes.filter((selector) => selector.includes('act-plan-row'));
  assert.ok(planStrikes.length >= 1);
  for (const selector of planStrikes) assert.ok(selector.includes('.completed'), selector);
  assert.ok(/\.act-plan-row\.skipped\s*\{[^}]*color:\s*var\(--text-muted\)/.test(CSS));
  assert.ok(!/\.act-plan-row\.skipped[^{]*\{[^}]*line-through/.test(CSS));
});

test('the partial and the unconfirmed rules are ordered so that the worse colour wins', () => {
  assert.ok(CSS.indexOf('.finish-card.partial {') < CSS.indexOf('.finish-card.unconfirmed,'));
  assert.match(blockAt('.finish-card.unconfirmed,'), /\.finish-card\.unverified \{ border-left-color: var\(--danger\);/);
});

// ---------------------------------------------------------------------------------------------
// The second review round
// ---------------------------------------------------------------------------------------------

const refusedResult = (error) => ({ type: 'execution_result', success: false, error, finishRefused: true });
const finishAction = (extra = {}) => ({ type: 'agent_response', action: { action: 'finish', answer: 'x', ...extra }, thought: '' });
const SEND_BACK = 'Your finish was refused because your answer says things that no page you read shows:\n1. idealo.de was never opened, but your answer gives data for it.\nWhat to do now:';

test('a finish the engine sent back is a readable warning row, not a bare "finish" with a red cross', () => {
  const html = renderTurns([goal('g'), finishAction(), refusedResult(SEND_BACK), navigate('https://idealo.de/'), executed()], 'running', [], '', '');
  const row = html.match(/<div class="act-row[^"]*"[^>]*>[^]*?<\/div>/)[0];
  assert.ok(row.includes('Finish not accepted'), row);
  assert.ok(row.includes('<span class="act-detail">Your finish was refused because your answer says things that no page you read shows</span>'), row);
  assert.match(row, /^<div class="act-row refused/);
  assert.ok(!row.includes('act-state bad') && !row.includes('bad'), 'no red cross and no red row');
  assert.ok(!/>finish</.test(row), 'not the bare verb');
  assert.ok(html.includes('Opened <em>idealo.de</em>'), 'the other rows are unchanged');
  assert.ok(!buildTurns([goal('g'), finishAction(), refusedResult(SEND_BACK)])[0].answer, 'a refused finish is not an answer');
});

test('the reason on a refused finish is escaped, and its first sentence only', () => {
  const html = renderTurns([goal('g'), finishAction(), refusedResult(`${XSS} was refused. Second sentence. Third.`)], 'running', [], '', '');
  assert.ok(!html.includes('<img'));
  assertOnlyOurTags(html);
  assert.ok(html.includes(`<span class="act-detail">${XSS_ESCAPED} was refused.</span>`), html);
  assert.ok(!html.includes('Second sentence'));
  assert.equal(firstSentence(SEND_BACK), 'Your finish was refused because your answer says things that no page you read shows');
  assert.equal(firstSentence(''), '');
  assert.equal(firstSentence(undefined), '');
  assert.equal(firstSentence('x'.repeat(500)).length, 140);
});

test('the other action rows are what they were, and a finish that ended the turn is a settled row, not a pulsing dot', () => {
  const live = renderTurns([goal('g'), finishAction()], 'running', [], '', '');
  assert.ok(live.includes('act-state live'), 'while the turn runs, an action without a result is live');
  const ended = renderTurns([goal('g'), finishAction(), { type: 'finish', answer: 'The answer.', audit: VERIFIED }], 'idle', [], '', '');
  assert.ok(!ended.includes('act-state live'), 'a finished turn has no live dot');
  assert.ok(ended.includes('Gave the final answer'));
  assert.equal(describeAction({ action: 'navigate', url: 'https://www.frame.work/de' }, null).text, 'Opened <em>frame.work</em>');
  assert.equal(describeAction({ action: 'finish' }, { success: true }).text, 'Gave the final answer');
});

test('a refused finish followed by the accepted one: one warning row and one settled row', () => {
  const history = [goal('g'), finishAction(), refusedResult(SEND_BACK), finishAction(), { type: 'finish', answer: 'Honest answer.', audit: PARTIAL }];
  const html = renderTurns(history, 'idle', [], '', '');
  assert.equal((html.match(/Finish not accepted/g) || []).length, 1);
  assert.equal((html.match(/Gave the final answer/g) || []).length, 1);
  assert.ok(!html.includes('act-state bad') && !html.includes('act-state live'));
});

test('an annotated answer is shown without the warning line and the notes section the engine wrote into it: the card already says it', () => {
  const stored = `${BANNER_UNVERIFIED}\n\nThe model's words.\n\n---\nVerification notes (written by ScoutFox, not by the model)\nVerdict: unverified.\nProblems found:\n- idealo.de was never opened`;
  const card = cardFor(UNVERIFIED, { answer: stored });
  const body = card.slice(card.indexOf('class="finish-body"'));
  assert.ok(body.includes("The model's words."));
  assert.ok(!body.includes('WARNING - UNVERIFIED ANSWER'), 'the warning line is not shown twice');
  assert.ok(!body.includes('Verification notes'), 'nor the section');
  assert.equal((textOf(card).match(/was never opened/g) || []).length, 1, 'each note once');
  const partial = cardFor(PARTIAL, { answer: `${BANNER_PARTIAL}\n\nPartial text.\n\n---\nVerification notes (written by ScoutFox, not by the model)\nVerdict: partial.` });
  assert.ok(!partial.includes('PARTIAL ANSWER:') && !partial.includes('Verification notes'));
  // With no audit the answer is shown as it is, whatever it contains.
  assert.ok(cardFor(null, { answer: stored }).includes('Verification notes'));
  assert.equal(withoutEngineNotes(stored), "The model's words.");
  assert.equal(withoutEngineNotes('plain'), 'plain');
  assert.equal(withoutEngineNotes(undefined), '');
});

test('the lines the panel cuts are the lines the engine writes', () => {
  assert.ok(withoutEngineNotes(`${BANNER_UNVERIFIED}\n\nx`) === 'x');
  assert.ok(withoutEngineNotes(`${BANNER_PARTIAL}\n\nx`) === 'x');
});

test('the notes of an unverified answer are open without a click, the notes of a partial answer are not, and a reader who closes them is obeyed', () => {
  openAuditDetails.clear();
  closedAuditDetails.clear();
  assert.ok(cardFor(UNVERIFIED).includes('data-audit-key="1" open>'));
  assert.ok(cardFor(PARTIAL).includes('data-audit-key="1">'));
  closedAuditDetails.add('1');
  assert.ok(!cardFor(UNVERIFIED).includes(' open>'));
  openAuditDetails.add('1');
  assert.ok(cardFor(PARTIAL).includes(' open>'), 'a reader who opened it keeps it open');
  openAuditDetails.clear();
  closedAuditDetails.clear();
});

test('the toggle of the notes is remembered both ways', () => {
  openAuditDetails.clear();
  closedAuditDetails.clear();
  const toggle = timelineListeners.find((l) => l.type === 'toggle');
  initTimelineInteraction();
  const listener = timelineListeners.filter((l) => l.type === 'toggle').at(-1) || toggle;
  assert.ok(listener, 'the timeline listens for toggles');
  const details = (open) => ({ matches: () => true, getAttribute: () => '7', open });
  listener.fn({ target: details(false) });
  assert.ok(closedAuditDetails.has('7') && !openAuditDetails.has('7'));
  listener.fn({ target: details(true) });
  assert.ok(openAuditDetails.has('7') && !closedAuditDetails.has('7'));
  openAuditDetails.clear();
  closedAuditDetails.clear();
});

test('the partial card is a plain card with an amber edge and icon, and the audit labels are readable', () => {
  // No tint: it is the same white card as Done and Unverified. The edge and the icon carry the amber.
  assert.ok(!/\.finish-card\.partial[^{]*\{[^}]*background/.test(CSS), 'no background on the partial card');
  assert.ok(!CSS.includes('linear-gradient(var(--warning-soft)'), 'the amber fill is gone');
  assert.match(CSS, /\.finish-card\.partial \{ border-left-color: var\(--warning\); \}/);
  assert.match(CSS, /\.finish-card\.partial \.finish-title svg \{ color: var\(--warning\); \}/);
  assert.match(CSS, /\.finish-card \{[^}]*border-left: 3px solid var\(--accent\);/, 'the 3px edge of every finish card');
  assert.match(CSS, /\.audit-label \{[^}]*color: var\(--text-muted\);/);
  assert.match(CSS, /\.act-row\.refused \{ color: var\(--warning\); \}/);
  assert.match(CSS, /\.act-detail \{/);
});

// ---------------------------------------------------------------------------------------------
// The third round: the subtitle of a partial answer, the landing of the scroll, the alignment
// of the rows, the contrast of every text, and the edge of the details box
// ---------------------------------------------------------------------------------------------

const sub = (notOpened, extra = {}) => cardFor({ ...PARTIAL, notOpened, ...extra }).match(/<div class="finish-sub">([^]*?)<\/div>/)[1];

test('the subtitle of a partial answer names the sources that were not checked, at most three, then "and N more"', () => {
  assert.equal(sub(['shop-b.test']), 'Not every source was checked: shop-b.test.');
  assert.equal(sub(['a.test', 'b.test']), 'Not every source was checked: a.test, b.test.');
  assert.equal(sub(['a.test', 'b.test', 'c.test']), 'Not every source was checked: a.test, b.test, c.test.');
  assert.equal(sub(['a.test', 'b.test', 'c.test', 'd.test']), 'Not every source was checked: a.test, b.test, c.test and 1 more.');
  assert.equal(sub(['a', 'b', 'c', 'd', 'e', 'f', 'g']), 'Not every source was checked: a, b, c and 4 more.');
  // A duplicate is one source: normalizeAudit drops it before the count.
  assert.equal(sub(['a.test', 'a.test', 'b.test']), 'Not every source was checked: a.test, b.test.');
  // Nothing to name: the old sentence, as it was.
  assert.equal(sub([]), 'Not every source was checked.');
  assert.equal(partialSubtitle([]), 'Not every source was checked.');
});

test('the names in the subtitle are escaped, and the subtitle of the other verdicts is unchanged', () => {
  const html = cardFor({ ...PARTIAL, notOpened: [`${XSS}.de`, 'b"c&d.test'] });
  assert.ok(!html.includes('<img'));
  assertOnlyOurTags(html);
  assert.equal(
    html.match(/<div class="finish-sub">([^]*?)<\/div>/)[1],
    `Not every source was checked: ${XSS_ESCAPED}.de, b&quot;c&amp;d.test.`
  );
  // The unverified card keeps its general sentence even though it has a not-opened list: that list is in the details.
  assert.ok(cardFor(UNVERIFIED).includes('<div class="finish-sub">Some parts of this answer could not be checked against the pages ScoutFox read.</div>'));
  assert.ok(!cardFor(VERIFIED).includes('finish-sub'));
});

// ---- the landing of the scroll ----

test('finishLandingTop: a card that does not fit lands on its top, a card that fits ends at the bottom', () => {
  // The panel shows 600px of a 3000px timeline, so the bottom position is 2400.
  const view = { viewHeight: 600, scrollHeight: 3000 };
  // A card 1800px tall starting at 1150: its top is far above the viewport at the bottom. Land 8px above it.
  assert.equal(finishLandingTop({ ...view, cardTop: 1150 }), 1142);
  // A card 300px tall starting at 2650 (plus the gap and padding below it): its top is on screen at the bottom.
  assert.equal(finishLandingTop({ ...view, cardTop: 2650 }), 3000);
  // The boundary: the card top, with its air, is exactly the top of the viewport at the bottom. Keep the bottom.
  assert.equal(finishLandingTop({ ...view, cardTop: 2408 }), 3000);
  assert.equal(finishLandingTop({ ...view, cardTop: 2407 }), 2399, 'one pixel less and the top would be cut off');
  // A card at the very top of a timeline that is barely taller than the panel: never a negative position.
  assert.equal(finishLandingTop({ viewHeight: 600, scrollHeight: 900, cardTop: 3 }), 0);
  // A timeline that fits the panel has nothing to scroll: bottom is top.
  assert.equal(finishLandingTop({ viewHeight: 600, scrollHeight: 500, cardTop: 100 }), 500);
  assert.equal(finishLandingTop({ viewHeight: 600, scrollHeight: 3000, cardTop: 1150, margin: 0 }), 1150);
});

/** A timeline with a size. The scroll position is clamped like a real one, and the finish card is where the test says. */
function sizedTimeline({ clientHeight = 600, scrollHeight = 3000, cardTop = 1150, hasCard = true } = {}) {
  let scrollTop = 0;
  const timeline = {
    clientHeight,
    scrollHeight,
    cardTop,
    hasCard,
    top: 60,
    writes: 0,
    innerHTML: '',
    get scrollTop() { return scrollTop; },
    set scrollTop(value) {
      timeline.writes += 1;
      scrollTop = Math.min(Math.max(0, value), Math.max(0, timeline.scrollHeight - timeline.clientHeight));
    },
    getBoundingClientRect: () => ({ top: timeline.top }),
    get lastElementChild() {
      return {
        querySelector: (selector) => (selector === '.finish-card' && timeline.hasCard
          ? { getBoundingClientRect: () => ({ top: timeline.top + timeline.cardTop - scrollTop }) }
          : null)
      };
    },
    addEventListener() {}
  };
  return timeline;
}

// Every case uses a different answer length: the panel remembers which finish card it has dealt with.
let answerLength = 10;
const finished = (status = 'complete') => {
  answerLength += 1;
  return { status, stepCount: 2, task: 't', planSteps: [], history: [goal('g'), navigate('https://frame.work/'), executed(), finish('x'.repeat(answerLength), { audit: UNVERIFIED })] };
};
const atBottom = (timeline) => { timeline.scrollTop = timeline.scrollHeight; timeline.writes = 0; };

test('renderState: a finish card taller than the panel is shown from its top', () => {
  const timeline = sizedTimeline({ cardTop: 1150 });
  activeTimeline = timeline;
  atBottom(timeline);
  renderState(finished());
  assert.ok(timeline.innerHTML.includes('Unverified answer'));
  assert.equal(timeline.scrollTop, 1142, 'the title of the card is the first line, 8px below the top edge');
});

test('renderState: a card that fits, and a live run, still end at the bottom', () => {
  const short = sizedTimeline({ cardTop: 2650 });
  activeTimeline = short;
  atBottom(short);
  renderState(finished());
  assert.equal(short.scrollTop, 2400, 'a short card ends at the bottom, as it always did');

  // A live run follows the bottom whatever is in the history, also when an earlier turn left a tall card.
  const live = sizedTimeline({ cardTop: 1150 });
  activeTimeline = live;
  atBottom(live);
  const history = finished().history;
  renderState({ status: 'running', stepCount: 3, task: 't', planSteps: [], history: [...history, goal('next', { turn: 2 }), navigate('https://frame.work/'), executed()] });
  assert.equal(live.scrollTop, 2400);

  // Paused is live too.
  const paused = sizedTimeline({ cardTop: 1150 });
  activeTimeline = paused;
  atBottom(paused);
  renderState({ ...finished('paused') });
  assert.equal(paused.scrollTop, 2400);

  // No finish card in the last turn (a stopped run): the bottom.
  const stopped = sizedTimeline({ cardTop: 1150, hasCard: false });
  activeTimeline = stopped;
  atBottom(stopped);
  renderState({ status: 'stopped', stepCount: 1, task: 't', planSteps: [], history: [goal('g'), navigate('https://frame.work/'), executed()] });
  assert.equal(stopped.scrollTop, 2400);
});

test('renderState: the landing happens once per card, so a reader who scrolled on is not thrown back', () => {
  const timeline = sizedTimeline({ cardTop: 1150 });
  activeTimeline = timeline;
  atBottom(timeline);
  const state = finished();
  renderState(state);
  assert.equal(timeline.scrollTop, 1142);

  // The same state arrives again (every broadcast renders the whole timeline). The reader is 1142px down: untouched.
  timeline.writes = 0;
  renderState(state);
  assert.equal(timeline.scrollTop, 1142);
  assert.equal(timeline.writes, 0, 'the position is not written at all');

  // The reader scrolls to the end of the long answer and another broadcast arrives: they stay at the end.
  atBottom(timeline);
  renderState(state);
  assert.equal(timeline.scrollTop, 2400, 'the bottom is where they were, and where they stay');

  // A new finish card (a new answer) lands on its top again.
  const next = finished();
  renderState(next);
  assert.equal(timeline.scrollTop, 1142);
});

test('renderState: a reader who was scrolled up when the answer came is left alone, now and later', () => {
  const timeline = sizedTimeline({ cardTop: 1150 });
  activeTimeline = timeline;
  timeline.scrollTop = 300;
  timeline.writes = 0;
  const state = finished();
  renderState(state);
  assert.equal(timeline.scrollTop, 300, 'not near the bottom: no scrolling at all');
  assert.equal(timeline.writes, 0);

  // They read down to the bottom and a later broadcast arrives: the card was already dealt with, so no jump to its top.
  atBottom(timeline);
  renderState(state);
  assert.equal(timeline.scrollTop, 2400);
});

test('finishCardKey and noteFinishCard: one key per finish entry, nothing while the run is live', () => {
  assert.equal(finishCardKey([]), null);
  assert.equal(finishCardKey(undefined), null);
  assert.equal(finishCardKey([goal('g')]), null);
  const a = [goal('g'), finish('abc')];
  const b = [goal('g'), finish('abcd')];
  assert.notEqual(finishCardKey(a), finishCardKey(b), 'another answer is another card');
  assert.notEqual(finishCardKey(a), finishCardKey([goal('g'), executed(), finish('abc')]), 'another place in the history too');
  assert.equal(finishCardKey(a), finishCardKey([goal('g'), finish('abc')]), 'the same entry gives the same key again');

  const history = [goal('g'), finish('a-unique-answer-for-this-test')];
  assert.equal(noteFinishCard('running', history), false);
  assert.equal(noteFinishCard('paused', history), false);
  assert.equal(noteFinishCard('idle', history), true, 'the first render of the card');
  assert.equal(noteFinishCard('idle', history), false, 'and not the second');
  assert.equal(noteFinishCard('idle', [goal('g')]), false);
});

// ---- the stylesheet: rows, edges and contrast ----

/** Every rule of the stylesheet as { selector -> [declaration text, ...] } in source order (nested @media rules included). */
function cssRulesBySelector() {
  const map = new Map();
  for (const [, selectors, body] of CSS.replace(/\/\*[^]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const selector of selectors.split(',').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean)) {
      if (!map.has(selector)) map.set(selector, []);
      map.get(selector).push(body);
    }
  }
  return map;
}
const RULES = cssRulesBySelector();
/** The value a selector ends up with for a property: the last declaration among its rules. */
function declared(selector, property) {
  const bodies = RULES.get(selector);
  assert.ok(bodies, `no rule for ${selector}`);
  let value = null;
  for (const body of bodies) {
    const match = body.match(new RegExp(`(?:^|[;\\s])${property}:\\s*([^;]+);?`));
    if (match) value = match[1].trim();
  }
  return value;
}

test('plan rows and action rows share one grid: same inset, same icon column, same gap, so icon and text start at the same x', () => {
  const inset = (selector) => {
    const padding = declared(selector, 'padding').split(/\s+/);
    return parseFloat(padding[1] ?? padding[0]);
  };
  const firstColumn = (selector) => parseFloat(declared(selector, 'grid-template-columns'));
  const textX = (selector) => inset(selector) + firstColumn(selector) + parseFloat(declared(selector, 'gap'));
  assert.equal(inset('.act-plan-row'), inset('.act-row'));
  assert.equal(firstColumn('.act-plan-row'), firstColumn('.act-row'));
  assert.equal(parseFloat(declared('.act-plan-row', 'gap')), parseFloat(declared('.act-row', 'gap')));
  assert.equal(textX('.act-plan-row'), textX('.act-row'));
  // Both lists sit in the same body, so the body's own padding is shared; the plan block adds none of its own.
  assert.match(declared('.act-plan', 'padding'), /^\d+px 0 \d+px$/);
  // The icons (8 to 12px) are centred on the axis of a 13px action icon that starts at the left of its column.
  assert.equal(declared('.act-plan-row > span:first-child', 'width'), '13px');
  assert.equal(declared('.act-plan-row > span:first-child', 'justify-content'), 'center');
  assert.equal(declared('.act-plan-row', 'align-items'), 'start', 'a wrapped step keeps its icon on the first line');
});

test('a row that can wrap keeps its icon on the first line: the refused finish and the fault', () => {
  assert.equal(declared('.act-row.refused', 'align-items'), 'start');
  assert.equal(declared('.act-row.fault', 'align-items'), 'start');
  // The icon is 14px high in a line of 1.45em: it drops by half the difference to sit on the middle of the first line.
  assert.equal(declared('.act-row.refused .act-ico', 'margin-top'), 'calc((1.45em - 14px) / 2)');
  assert.equal(declared('.act-row.fault .act-ico', 'margin-top'), 'calc((1.45em - 14px) / 2)');
  // The row's line height is the 1.45 the calc assumes, and the warning icon is 14px.
  assert.equal(declared('.act-row', 'line-height'), '1.45');
  assert.ok(fs.readFileSync(new URL('../sidepanel/sidepanel.js', import.meta.url), 'utf8').includes('warning: \'<svg width="14" height="14"'));
});

test('the details box has an edge of its own: a border against the card, defined in the light and both dark blocks', () => {
  assert.equal(declared('.audit-body', 'border'), '1px solid var(--border-strong)');
  for (const selector of [':root {', ':root:not([data-theme="light"]) {', ':root[data-theme="dark"] {']) {
    assert.match(blockAt(selector), /--border-strong: rgba\(/, selector);
  }
});

// Contrast. The tokens come from the stylesheet itself, so a change of a colour is checked too.
const tokensOf = (selector) => Object.fromEntries([...blockAt(selector).matchAll(/(--[a-z-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const THEMES = {
  light: tokensOf(':root {'),
  dark: tokensOf(':root[data-theme="dark"] {')
};

function parseColour(value) {
  const hex = value.match(/^#([0-9a-f]{6})$/i);
  if (hex) return { rgb: [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)), alpha: 1 };
  const rgba = value.match(/^rgba?\(([^)]+)\)$/);
  assert.ok(rgba, `cannot read the colour ${value}`);
  const parts = rgba[1].split(',').map((p) => parseFloat(p));
  return { rgb: parts.slice(0, 3), alpha: parts.length > 3 ? parts[3] : 1 };
}
const over = (top, bottom) => top.rgb.map((c, i) => c * top.alpha + bottom.rgb[i] * (1 - top.alpha));
function luminance(rgb) {
  const [r, g, b] = rgb.map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
const tokenColour = (theme, name) => parseColour(THEMES[theme][name]);

// [selector that sets the text colour, the variable it must use, the surface the text sits on]
const TEXT_ON_SURFACE = [
  ['.finish-title', '--text-main', '--card'],
  ['.finish-sub', '--text-muted', '--card'],
  ['.finish-body', '--text-main', '--card'],
  ['.audit-summary, .audit-line', '--text-muted', '--card'],
  ['.audit.attention .audit-summary', '--text-main', '--card'],
  ['.audit-body', '--text-muted', '--surface'],
  ['.audit-label', '--text-muted', '--surface'],
  ['.audit-note', '--text-main', '--surface'],
  ['.audit-host', '--text-main', '--surface'],
  ['.audit-url', '--text-muted', '--surface'],
  ['.audit-plain', '--text-main', '--surface'],
  ['.audit-meta', '--text-muted', '--surface'],
  ['.act-row', '--text-muted', '--card'],
  ['.act-detail', '--text-muted', '--card'],
  ['.act-row.refused', '--warning', '--card'],
  ['.plan-skip-note', '--warning', '--card'],
  ['.act-plan-row', '--text-muted', '--card'],
  ['.act-plan-row.in_progress', '--text-main', '--card'],
  ['.act-plan-row.skipped', '--text-muted', '--card'],
  ['.act-phase', '--text-muted', '--card'],
  ['.md-h', '--text-main', '--card'],
  ['.md-mark', '--text-muted', '--card'],
  ['.md-table thead th', '--text-main', '--surface'],
  ['.md-table td', '--text-main', '--card']
];

test('every text of the finish card and the action group reaches 4.5:1 on the surface it sits on, in both themes', () => {
  for (const [selector, variable, surface] of TEXT_ON_SURFACE) {
    const key = selector.includes(', ') ? selector.split(', ')[0] : selector;
    assert.equal(declared(key, 'color'), `var(${variable})`, `${selector} no longer uses ${variable}`);
    for (const theme of ['light', 'dark']) {
      const ratio = contrast(tokenColour(theme, variable).rgb, tokenColour(theme, surface).rgb);
      assert.ok(ratio >= 4.5, `${selector} (${variable} on ${surface}) is ${ratio.toFixed(2)}:1 in the ${theme} theme`);
    }
  }
  // The completed plan row is told by its line, not by fading it: no opacity on plan text.
  assert.ok(!/\.act-plan-row\.completed[^{]*\{[^}]*opacity/.test(CSS));
});

test('the subtitle of a partial answer was 4.07:1 on its amber tint in dark mode; on the plain card it is above 4.5:1 in both themes', () => {
  const tinted = over(parseColour(THEMES.dark['--warning-soft']), tokenColour('dark', '--card'));
  assert.ok(contrast(tokenColour('dark', '--text-muted').rgb, tinted) < 4.5, 'the old tint really was the problem');
  for (const theme of ['light', 'dark']) {
    assert.ok(contrast(tokenColour(theme, '--text-muted').rgb, tokenColour(theme, '--card').rgb) >= 4.5, theme);
  }
});

test('the edge of the details box and of a table is visible against the card in both themes', () => {
  for (const theme of ['light', 'dark']) {
    const card = tokenColour(theme, '--card');
    const edge = over(tokenColour(theme, '--border-strong'), card);
    assert.ok(contrast(edge, card.rgb) >= 1.4, `${theme}: the edge is ${contrast(edge, card.rgb).toFixed(2)}:1 against the card`);
    // Stronger than the hairline of the card itself, which is the UI's weakest edge.
    assert.ok(contrast(edge, card.rgb) > contrast(over(tokenColour(theme, '--border'), card), card.rgb));
  }
});

test('both dark blocks (the system preference and the manual switch) define the same colours', () => {
  const media = tokensOf(':root:not([data-theme="light"]) {');
  assert.deepEqual(media, THEMES.dark);
});

test('the comment at the plan rows tells the truth about where the skipped sites are named', () => {
  const source = fs.readFileSync(new URL('../sidepanel/sidepanel.js', import.meta.url), 'utf8');
  assert.ok(!source.includes('the collapsed group is where a reader looks'));
  assert.match(source, /sees\s+\/\/ it only after opening the group/);
  assert.match(source, /in the subtitle\s+\/\/ of a partial answer and in the "Not opened" list of its details/);
  // The plain dash rule covers what this round wrote: the scroll code, the subtitle and the markdown renderer.
  const between = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
  for (const [name, text] of [
    ['the scroll code', between('Where the panel lands when the newest finish card appears', 'Batched action rendering.')],
    ['the subtitle', between('How many unchecked sources the subtitle', 'function hostOfUrl')],
    ['the markdown renderer', between("The model's answer as HTML", '// Exported only so')]
  ]) {
    assert.ok(text.length > 100, `${name} was found`);
    assert.ok(!text.includes('\u2014'), `no em dash in ${name}`);
  }
  assert.ok(!CSS.includes('\u2014'), 'no em dash in the stylesheet');
});
