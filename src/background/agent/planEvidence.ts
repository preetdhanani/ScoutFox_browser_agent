/**
 * agent/planEvidence.ts
 *
 * The small pure pieces the engine needs to wire the answer audit (agent/answerAudit.ts) and the
 * evidence ledger (agent/evidence.ts) into its loop. The engine file is plain JavaScript that is hard
 * to test on its own, so every rule that can be a pure function lives here, with its own tests
 * (tests/agent/planEvidence.test.ts). The engine only calls these and does the side effects.
 *
 * WHY. A local model was asked for one price on three sites, opened one, and finished with a table for
 * all three. The engine then marked all four plan steps completed and showed a green "Done". Two of
 * those lies were the HARNESS'S own: a plan step said "done" for a site nobody had read, and every
 * finish was accepted with no check. This file holds the rules that stop both.
 *
 * 1. HONEST PLAN. A plan step that names a site (the planner writes "idealo.de: find the price", a cloud
 *    planner writes "Check Idealo") is never shown as completed before a page of that site was read. Steps that name no site keep the
 *    old rule (the engine advances them by action counts). When the run finishes, steps for sites that
 *    were never opened become 'skipped', not 'completed'.
 * 2. WHAT THE ENGINE READ. A text result is evidence only for what the page returned, not for what the
 *    model wrote into the code it ran (evidenceFromActionResult).
 * 3. A SMALL PERSISTED LEDGER. The ledger is stored with the session on every state change, so the
 *    stored copy is cut down (compactLedgerSnapshot) and keeps the newest page of every site.
 * 4. THE GATE'S DECISION. What the finish policy (agent/finishPolicy.ts) says is clamped here, so a
 *    policy that throws, answers nonsense, or asks for a send-back that cannot happen never lets an
 *    unchecked answer through (resolveGateDecision). A send-back that would only repeat itself is
 *    refused too: an answer that states nothing false and already says, for every site it did not
 *    open, that it was not checked, has done what the send-back asked (answerAcknowledgesEveryGap).
 * 5. NOTES IN THE ANSWER. A site the model already wrote "not checked" for (in so many words: "blocked",
 *    "could not open", "nicht geprueft"; a bare "not" is no acknowledgement) does not need a second note in
 *    the text of the answer (withoutAcknowledgedGaps). The verdict still says "partial".
 *
 * 6. THE LOG OF A CLAMP. What the engine writes when the policy's answer could not be followed (gateClampLog). One of the
 *    reasons is not a problem: an honest answer after a send-back is accepted as it is, and that is logged as INFO with its own
 *    tag. Every other reason is a WARN with the old tag.
 *
 * Pure: no chrome or DOM globals, no clock, no randomness, no network. Nothing here throws on any input.
 */
import { condenseText, cutAtWord, siteOf } from './evidence.ts';
import type { EvidenceKind, EvidenceLedger, LedgerSnapshot, StoredVisit } from './evidence.ts';
import { UNCHECKED_RE, brandLabelOf, mentionedSites, planHosts } from './answerAudit.ts';
import type { AnswerAudit } from './answerAudit.ts';
import type { GateContext, GateDecision } from './finishPolicy.ts';

// ---------------------------------------------------------------------------------------------
// 1. Honest plan
// ---------------------------------------------------------------------------------------------

export type PlanStatus = 'pending' | 'in_progress' | 'completed' | 'skipped';

/** What the plan functions need from the ledger: only "was a page of this site read". */
export type OpenedCheck = Pick<EvidenceLedger, 'hasOpened'>;

/**
 * The sites a plan step is about: the ones it names by domain, and the sites of the goal it calls by their brand
 * ("Check Idealo for the same configuration" is about idealo.de). A cloud planner writes the second kind, because it is
 * never asked for domains. `goalHosts` are the sites the goal sends the agent to (goalSources).
 */
export function stepSites(stepText: string, goalHosts: readonly string[] = []): string[] {
  const hosts = planHosts(stepText);
  if (typeof stepText !== 'string') return hosts;
  for (const host of goalHosts) {
    if (hosts.includes(host)) continue;
    const label = brandLabelOf(host, 4);
    if (label !== '' && new RegExp(`(?<![\\p{L}\\p{N}_])${label}(?![\\p{L}\\p{N}_])`, 'iu').test(stepText.length > 2000 ? stepText.slice(0, 2000) : stepText)) hosts.push(host);
  }
  return hosts;
}

/** The sites a plan step names that no page was read from. Empty for a step that names none, or whose sites were all opened. */
export function unopenedSitesOf(stepText: string, ledger: OpenedCheck, goalHosts: readonly string[] = []): string[] {
  return stepSites(stepText, goalHosts).filter((host) => !ledger.hasOpened(host));
}

/** True when any step of the plan names a site. A plan with none is handled exactly as before the audit existed. */
export function planNamesSites(stepTexts: readonly string[], goalHosts: readonly string[] = []): boolean {
  return stepTexts.some((text) => stepSites(text, goalHosts).length > 0);
}

/**
 * The status of every step while the run goes on. `progressIndex` is the engine's old action-count
 * position: steps before it would be completed. A step that names a site is completed only when a page
 * of that site was read too. The in_progress marker goes to the first step that is not completed, so
 * the model is pointed at the work that is really left. With no site named in the plan this gives
 * exactly what the engine always gave: steps before the index completed, that one in progress, the
 * rest pending.
 */
export function honestPlanStatuses(stepTexts: readonly string[], progressIndex: number, ledger: OpenedCheck, goalHosts: readonly string[] = []): PlanStatus[] {
  const done = stepTexts.map((text, i) => i < progressIndex && unopenedSitesOf(text, ledger, goalHosts).length === 0);
  const first = done.indexOf(false);
  return done.map((isDone, i): PlanStatus => (isDone ? 'completed' : i === first ? 'in_progress' : 'pending'));
}

/**
 * The status of every step when the run ends. A step that names a site nobody read is 'skipped': the
 * plan must not claim work that did not happen. Every other step is completed.
 */
export function finishedPlanStatuses(stepTexts: readonly string[], ledger: OpenedCheck, goalHosts: readonly string[] = []): PlanStatus[] {
  return stepTexts.map((text): PlanStatus => (unopenedSitesOf(text, ledger, goalHosts).length === 0 ? 'completed' : 'skipped'));
}

// ---------------------------------------------------------------------------------------------
// 2. What the engine read
// ---------------------------------------------------------------------------------------------

/** The text of one action result that goes into the ledger. */
export interface RecordedText {
  kind: Exclude<EvidenceKind, 'page'>;
  text: string;
}

const NETWORK_PREFIX = 'Recent Network Activity:\n';
const PAGE_TEXT_WRAPPER = /^Extracted text snippet \(\d+ chars\):\n"""\n([\s\S]*?)\n?"""\s*$/;

/** Text without white space and quotes, to see whether a result is only the code's own literal handed back. */
function squeeze(s: string): string {
  return s.replace(/[\s"'`\\]+/g, '');
}

/**
 * The text of a successful action result that counts as something the engine read, or null. Only
 * three actions read a page: read_page_text, execute_js and read_network_requests. The text is what
 * came back from the page, never what the model wrote, with one exception that is cut out here:
 * execute_js returns whatever the code computes, so code that just returns a literal ("return 'idealo.de
 * costs 2.189,00 EUR'") would launder a made-up number into the ledger. A result that is found inside the
 * code itself is not evidence.
 */
export function evidenceFromActionResult(
  action: { action?: unknown; code?: unknown } | null | undefined,
  result: { success?: unknown; message?: unknown; result?: unknown } | null | undefined
): RecordedText | null {
  try {
    if (!action || !result || result.success === false) return null;
    switch (action.action) {
      case 'read_page_text':
      case 'extract_page_text': {
        if (typeof result.message !== 'string') return null;
        const wrapped = PAGE_TEXT_WRAPPER.exec(result.message);
        const text = wrapped ? (wrapped[1] ?? '') : result.message;
        return text.trim() === '' ? null : { kind: 'text', text };
      }
      case 'execute_js': {
        const value = result.result;
        const text = typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
        if (text.trim() === '' || text === 'undefined' || text === 'null' || text === 'navigation triggered') return null;
        const code = typeof action.code === 'string' ? squeeze(action.code) : '';
        const echoed = squeeze(text);
        if (code !== '' && echoed !== '' && code.includes(echoed)) return null;
        return { kind: 'js', text };
      }
      case 'read_network_requests': {
        if (typeof result.message !== 'string') return null;
        const text = result.message.startsWith(NETWORK_PREFIX) ? result.message.slice(NETWORK_PREFIX.length) : result.message;
        return text.trim() === '' || text.startsWith('(No network requests') ? null : { kind: 'network', text };
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// 3. A small persisted ledger
// ---------------------------------------------------------------------------------------------

/** What is stored with the session: at most this many pages, this many characters in all, and this many per page. */
export const PERSIST_MAX_ENTRIES = 40;
export const PERSIST_MAX_CHARS = 60_000;
export const PERSIST_TEXT_CHARS = 3000;
/** The list of pages the tab stood on is stored apart from the page texts, and is cut far later (see below). */
export const PERSIST_MAX_VISITS = 100;
/** A stored visit keeps the start of the title only: the address is what "opened" and "visited" rest on. */
const PERSIST_VISIT_TITLE_CHARS = 40;
const PERSIST_LINKS = 20;

function storedChars(e: { url: string; title: string; text: string; links: readonly string[] }): number {
  let n = e.url.length + e.title.length + e.text.length;
  for (const l of e.links) n += l.length;
  return n;
}

/** The sites an entry stands for: the site of its URL and the ones it was reached through (a redirect). */
function sitesOfStored(e: { url: string; via?: readonly string[] }): string[] {
  const sites: string[] = [];
  const own = siteOf(e.url);
  if (own !== '') sites.push(own);
  for (const v of Array.isArray(e.via) ? e.via : []) if (typeof v === 'string' && v !== '' && !sites.includes(v)) sites.push(v);
  return sites;
}

/**
 * The ledger snapshot as it is stored with the session. The full ledger may hold 150,000 characters and
 * the session is written to chrome.storage on every state change, so the stored copy keeps the newest
 * pages only, each cut to a few thousand characters. When that is still too much, the OLDEST pages are
 * cut down to the lines around their numbers and links first (condenseText), so a price read early can still
 * be found, and only then does a whole page go. The newest page of every site is the last to go.
 *
 * Which sites and pages were read does NOT depend on any of this. The visit list (a short line per page,
 * at most PERSIST_MAX_VISITS of them, the newest page of every site always among them) is stored next to
 * the pages, so after the worker restarts every site that was read still counts as opened, however many
 * there were. The text of a page that was cut short can no longer ground a number that stood in the cut
 * part, which errs on the strict side: the answer gets sent back.
 */
export function compactLedgerSnapshot(snapshot: LedgerSnapshot): LedgerSnapshot {
  const entries = (Array.isArray(snapshot?.entries) ? snapshot.entries : []).map((e) => ({
    ...e,
    text: typeof e.text === 'string' && e.text.length > PERSIST_TEXT_CHARS ? e.text.slice(0, PERSIST_TEXT_CHARS) : e.text,
    links: Array.isArray(e.links) ? e.links.slice(0, PERSIST_LINKS) : []
  }));
  let chars = entries.reduce((sum, e) => sum + storedChars(e), 0);
  for (let i = 0; i < entries.length - 1 && chars > PERSIST_MAX_CHARS; i++) {
    const e = entries[i];
    if (!e || typeof e.text !== 'string') continue;
    const before = storedChars(e);
    const shorter = condenseText(e.text);
    if (shorter.length < e.text.length) {
      e.text = shorter;
      e.links = e.links.slice(0, PERSIST_LINKS);
      chars -= before - storedChars(e);
    }
  }
  while (entries.length > 1 && (entries.length > PERSIST_MAX_ENTRIES || chars > PERSIST_MAX_CHARS)) {
    // The newest entry of each site (by the site of its URL, as the ledger derives it) is protected.
    const newestOfSite = new Map<string, number>();
    entries.forEach((e, i) => {
      for (const site of sitesOfStored(e)) newestOfSite.set(site, i);
    });
    const protectedIdx = new Set(newestOfSite.values());
    let victim = -1;
    for (let i = 0; i < entries.length - 1; i++) {
      if (!protectedIdx.has(i)) {
        victim = i;
        break;
      }
    }
    if (victim < 0) victim = 0;
    const gone = entries.splice(victim, 1)[0];
    if (gone) chars -= storedChars(gone);
  }
  const out: LedgerSnapshot = { v: 1, entries };
  const visits = compactVisits(snapshot?.visits);
  if (visits.length > 0) out.visits = visits;
  return out;
}

/** The newest page of every site, then the newest of the rest, up to PERSIST_MAX_VISITS, in their original order. */
function compactVisits(visits: LedgerSnapshot['visits']): StoredVisit[] {
  const list = Array.isArray(visits) ? visits.filter((v): v is StoredVisit => v !== null && typeof v === 'object' && typeof v.url === 'string') : [];
  if (list.length === 0) return [];
  const keep = new Set<number>();
  const covered = new Set<string>();
  for (let i = list.length - 1; i >= 0; i--) {
    const v = list[i];
    if (!v) continue;
    const sites = sitesOfStored(v);
    if (sites.some((site) => !covered.has(site))) {
      keep.add(i);
      for (const site of sites) covered.add(site);
    }
  }
  for (let i = list.length - 1; i >= 0 && keep.size < PERSIST_MAX_VISITS; i--) keep.add(i);
  return list.filter((_v, i) => keep.has(i)).map((v) => ({ ...v, title: typeof v.title === 'string' ? v.title.slice(0, PERSIST_VISIT_TITLE_CHARS) : '' }));
}

// ---------------------------------------------------------------------------------------------
// 4. The gate's decision
// ---------------------------------------------------------------------------------------------

/** After this many send-backs in one turn the engine stops asking the model again. */
export const MAX_SEND_BACKS = 4;

const DECISIONS: ReadonlySet<string> = new Set(['send_back', 'annotate', 'replace']);

/** What the policy is told about a failed audit. Never negative, always whole numbers. */
export function gateContextOf(audit: AnswerAudit, sendBacks: number, stepsLeft: number): GateContext {
  const count = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
  return { lieCount: count(audit?.lies), gapCount: count(audit?.gaps), sendBacks: count(sendBacks), stepsLeft: count(stepsLeft) };
}

export interface ResolvedDecision {
  decision: GateDecision;
  /** Why the policy's answer was not used as it stood, or null when it was. The engine logs it. */
  clamped: string | null;
}

/**
 * Asks the policy and makes its answer safe. There is deliberately no way to accept a failed answer as
 * it is: a policy that throws, or answers anything but the three known words, gets 'annotate'. A
 * send-back is only possible when the model can really be asked again, so it becomes 'annotate' when
 * no step is left, after MAX_SEND_BACKS in one turn, and when the engine knows that asking again is
 * pointless (`noSendBack` says why: a plain-text reply that the engine wrapped into a finish cannot be
 * redone, and an answer that already says which sites were not checked would only be refused again).
 *
 * The reasons have an order, because the log tells them apart (gateClampLog). A run with no step left, or with all its
 * send-backs used, could not have sent the answer back whatever it said, so that reason wins over "the answer already says which
 * sites were not checked": an honest answer that is accepted as it is because a send-back would change nothing is a choice,
 * one that is accepted because the run ran out of steps is not. The engine can reach that case without saying so in
 * `noSendBack` (the last step of the run is a finish that is not flagged as final), so the order is kept here.
 */
export function resolveGateDecision(policy: unknown, ctx: GateContext, options: { noSendBack?: string } = {}): ResolvedDecision {
  let raw: unknown;
  try {
    if (typeof policy !== 'function') return { decision: 'annotate', clamped: 'the finish policy is not a function' };
    raw = (policy as (c: GateContext) => unknown)({ ...ctx });
  } catch (err) {
    return { decision: 'annotate', clamped: `the finish policy threw: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (typeof raw !== 'string' || !DECISIONS.has(raw)) return { decision: 'annotate', clamped: `the finish policy answered ${JSON.stringify(raw) ?? 'nothing'}` };
  if (raw !== 'send_back') return { decision: raw as GateDecision, clamped: null };
  if (options.noSendBack && options.noSendBack !== NO_SEND_BACK_ACKNOWLEDGED) return { decision: 'annotate', clamped: options.noSendBack };
  if (ctx.stepsLeft < 1) return { decision: 'annotate', clamped: 'no step is left to try again' };
  if (ctx.sendBacks >= MAX_SEND_BACKS) return { decision: 'annotate', clamped: `this turn was already sent back ${MAX_SEND_BACKS} times` };
  if (options.noSendBack) return { decision: 'annotate', clamped: options.noSendBack };
  return { decision: 'send_back', clamped: null };
}

/**
 * Why the engine tells resolveGateDecision that a send-back cannot help (its `noSendBack` option). They come back as
 * `clamped`, word for word, so gateClampLog can tell the one that is not a problem from the others.
 */
export const NO_SEND_BACK_OUT_OF_STEPS = 'the run is out of steps';
export const NO_SEND_BACK_PLAIN_TEXT = 'a plain-text reply cannot be sent back';
export const NO_SEND_BACK_ACKNOWLEDGED = 'the answer already says which sites were not checked, after a send-back';

export interface GateLogLine {
  level: 'info' | 'warn';
  /** Starts with the tag, which tests, docs and the people reading the log look for. */
  message: string;
}

/**
 * The log line for a decision that is not what the policy asked for, or null when the policy was followed.
 *
 * An honest answer that says, for every site it left out, that it was not checked, after the model was already sent back
 * once, is ACCEPTED as it is (verdict partial, no banner, the text untouched). Nothing went wrong there, so it is an INFO
 * line with its own tag, and it does not use the word "annotate", which reads like a warning was added to the answer. Every
 * other reason (no step left, the hard cap, a policy that threw or answered nonsense, a plain-text reply, the end of the run)
 * is a real clamp: a WARN with the old tag and the reason.
 */
export function gateClampLog(resolved: ResolvedDecision, about: { sendBacks: number; verdict: string }): GateLogLine | null {
  if (!resolved || resolved.clamped === null || resolved.clamped === undefined) return null;
  if (resolved.clamped === NO_SEND_BACK_ACKNOWLEDGED) {
    const n = Math.max(0, Math.floor(Number.isFinite(about?.sendBacks) ? about.sendBacks : 0));
    return {
      level: 'info',
      message: `[FINISH_ACCEPTED_PARTIAL] The answer already says which sites were not checked (after ${n} send-back${n === 1 ? '' : 's'}), so it is accepted as it is with verdict ${about?.verdict ?? 'partial'}.`
    };
  }
  return { level: 'warn', message: `[FINISH_POLICY_CLAMPED] The finish policy could not be followed as it stood (${resolved.clamped}). Using "${resolved.decision}".` };
}

/** What a finish history entry stores about its audit. Plain JSON, and small: the panel reads it, the session stores it. */
export interface FinishAuditRecord {
  verdict: AnswerAudit['verdict'];
  opened: Array<{ host: string; url: string }>;
  notOpened: string[];
  notes: Array<{ code: string; severity: 'lie' | 'gap' | 'soft'; text: string }>;
  sendBacks: number;
}

const RECORD_MAX_OPENED = 20;
const RECORD_MAX_NOT_OPENED = 20;
const RECORD_MAX_NOTES = 30;
const RECORD_NOTE_CHARS = 500;
const RECORD_URL_CHARS = 500;

export function auditRecordOf(audit: AnswerAudit, sendBacks: number): FinishAuditRecord {
  return {
    verdict: audit.verdict,
    opened: audit.opened.slice(0, RECORD_MAX_OPENED).map((o) => ({ host: o.host, url: o.url.slice(0, RECORD_URL_CHARS) })),
    notOpened: audit.notOpened.slice(0, RECORD_MAX_NOT_OPENED),
    notes: audit.notes.slice(0, RECORD_MAX_NOTES).map((n) => ({ code: n.code, severity: n.severity, text: cutAtWord(n.text, RECORD_NOTE_CHARS) })),
    sendBacks: Math.max(0, Math.floor(sendBacks))
  };
}

// ---------------------------------------------------------------------------------------------
// 5. Notes in the answer
// ---------------------------------------------------------------------------------------------

/**
 * The audit as the text of the answer should show it. When the answer states nothing false (no lie),
 * a site that the answer itself names on a line that says it was not looked at ("idealo.de: not checked", "I could not
 * open geizhals.de", "Idealo: blocked") needs no note: the model already said so, and a second section would only
 * repeat it. The line has to say that in so many words (UNCHECKED_RE): a bare "not" is not enough, or "idealo.de and
 * geizhals.de show the same price, so they do not differ by more than 5%" would count as an honest "not checked".
 * A site the answer never mentions, or mentions without saying so, keeps its note. When there is any lie nothing is
 * removed. The verdict is not changed here and the attached audit is never the filtered one: this is only about what
 * the code writes INTO the answer.
 */
export function withoutAcknowledgedGaps(answer: string, audit: AnswerAudit): AnswerAudit {
  try {
    if (audit.lies > 0 || audit.gaps === 0 || typeof answer !== 'string') return audit;
    const gapHosts = audit.notes.filter((n) => n.code === 'source_unchecked' && n.host !== undefined).map((n) => n.host as string);
    const acknowledged = new Set<string>();
    for (const line of answer.split('\n')) {
      const text = line.length > 4000 ? line.slice(0, 4000) : line;
      if (!UNCHECKED_RE.test(text)) continue;
      for (const host of mentionedSites(text, gapHosts)) acknowledged.add(host);
    }
    const notes = audit.notes.filter((n) => !(n.code === 'source_unchecked' && n.host !== undefined && acknowledged.has(n.host)));
    if (notes.length === audit.notes.length) return audit;
    return { ...audit, notes, gaps: notes.filter((n) => n.severity === 'gap').length };
  } catch {
    return audit;
  }
}

/**
 * True when the answer states nothing false (no lie) and, for every site it leaves unchecked, says so
 * itself. Such an answer has done what a send-back asks ("finish and write 'not checked' for that
 * site"), so sending it back again would only burn a step and push a small model towards inventing the
 * missing values. The engine uses this to refuse a repeated send-back, never to accept the first finish.
 */
export function answerAcknowledgesEveryGap(answer: string, audit: AnswerAudit): boolean {
  return audit.lies === 0 && audit.gaps > 0 && withoutAcknowledgedGaps(answer, audit).gaps === 0;
}
